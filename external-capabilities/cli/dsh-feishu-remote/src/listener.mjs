/**
 * The resident bridge: Feishu private chat -> local agent -> Feishu reply.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR, STATE_PATH, ensureDirs } from './config.mjs';
import { sendText, spawnConsumer } from './feishu.mjs';

function audit(level, stage, extra = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const record = { ts: new Date().toISOString(), level, stage, ...extra };
  try { appendFileSync(join(LOG_DIR, `audit-${day}.jsonl`), JSON.stringify(record) + '\n'); } catch { /* logging must not break work */ }
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { seen: [], pending: null };
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { seen: Array.isArray(raw.seen) ? raw.seen : [], pending: raw.pending ?? null };
  } catch {
    return { seen: [], pending: null };
  }
}

function saveState(state) {
  try { writeFileSync(STATE_PATH, JSON.stringify(state)); } catch (error) { audit('warn', 'state-save', { err: String(error) }); }
}

/** Pull the model key from the OS keychain when the environment lacks it. */
function ensureApiKey(cfg) {
  const keyVar = cfg.apiKeyEnv || 'DEEPSEEK_API_KEY';
  if (process.env[keyVar]) return true;
  const service = cfg.keychainService;
  if (!service || process.platform !== 'darwin') return false;
  const result = spawnSync('/usr/bin/security', ['find-generic-password', '-a', process.env.USER || '', '-s', service, '-w'], { encoding: 'utf8' });
  const value = (result.stdout || '').trim();
  if (result.status !== 0 || value === '') return false;
  process.env[keyVar] = value;
  return true;
}

function runAgent(cfg, text) {
  return new Promise((resolve) => {
    const args = [...(cfg.agentArgs || ['headless']), text];
    const child = spawn(cfg.dshCli, args, {
      cwd: cfg.workdir,
      env: { ...process.env, ...(cfg.extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
      finish('timeout');
    }, Math.max(30, cfg.timeoutSeconds || 300) * 1000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += String(error); finish('spawn-error'); });
    child.on('close', (code) => finish(code));
  });
}

function newTaskId() {
  return 'task_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(2, 14);
}

function isHighRisk(cfg, text) {
  const lower = text.toLowerCase();
  return (cfg.highRiskPatterns || []).some((pattern) => String(pattern).toLowerCase() !== '' && lower.includes(String(pattern).toLowerCase()));
}

const HELP = (cfg) => [
  '远程任务用法：',
  '· 直接发一句话 = 在这台电脑上执行（例如：看看桌面有哪些文件）',
  '· 含高风险词（删除/转账/清空等）= 先回确认，回复「确认」才执行',
  '· 发送「帮助」= 看这段说明；发送「状态」= 看服务信息',
  '· 执行目录：' + cfg.workdir,
].join('\n');

/** Start the resident loop. Returns a shutdown function. */
export function startListener(cfg) {
  ensureDirs();
  const state = loadState();
  const hasKey = ensureApiKey(cfg);
  audit('info', 'listener-start', { pid: process.pid, workdir: cfg.workdir, apiKey: hasKey ? 'present' : 'missing' });
  if (!hasKey) {
    audit('warn', 'listener-start', { note: `环境变量 ${cfg.apiKeyEnv} 缺失，执行可能失败` });
  }

  let queue = Promise.resolve();
  const enqueue = (work) => {
    queue = queue.then(work).catch((error) => audit('error', 'queue', { err: String(error) }));
    return queue;
  };

  async function execute(chatId, text, taskId) {
    const started = Date.now();
    audit('info', 'start', { taskId, chatId, text });
    const result = await runAgent(cfg, text);
    const ok = result.code === 0;
    const body = (result.stdout || '').trim();
    let reply;
    if (ok) reply = body || '（执行完成，没有输出）';
    else if (result.code === 'timeout') reply = `⏱ 超时（${cfg.timeoutSeconds}s）已中止。\n${(result.stderr || result.stdout || '').trim().slice(0, 1200)}`;
    else reply = `❌ 执行失败（exit ${result.code}）\n${(result.stderr || result.stdout || '').trim().slice(0, 1500)}`;
    await sendText(cfg, chatId, reply);
    audit(ok ? 'info' : 'error', 'done', { taskId, code: result.code, ms: Date.now() - started, chars: body.length });
  }

  async function onMessage(raw) {
    const event = raw && raw.event && typeof raw.event === 'object' ? raw.event : raw;
    if (!event || event.type !== 'im.message.receive_v1') return;
    if (event.sender_type && event.sender_type !== 'user') return;
    const chatTypes = cfg.allowedChatTypes || ['p2p'];
    if (!chatTypes.includes(event.chat_type)) return;
    if (!(cfg.allowedOpenIds || []).includes(event.sender_id)) {
      audit('warn', 'reject-sender', { sender: event.sender_id });
      return;
    }
    const messageId = event.message_id || event.id;
    if (!messageId || state.seen.includes(messageId)) return;
    state.seen.push(messageId);
    if (state.seen.length > 800) state.seen = state.seen.slice(-800);
    saveState(state);

    const chatId = event.chat_id;
    const text = String(event.content || '').trim();
    if (!chatId || !text) return;

    if (/^(\/help|帮助|help)$/i.test(text)) {
      audit('info', 'help', { chatId });
      await sendText(cfg, chatId, HELP(cfg));
      return;
    }
    if (/^(\/status|状态)$/i.test(text)) {
      audit('info', 'status-query', { chatId });
      await sendText(cfg, chatId, [
        '服务状态：运行中',
        '工作目录：' + cfg.workdir,
        '执行后端：' + cfg.dshCli + ' ' + (cfg.agentArgs || []).join(' '),
        '白名单人数：' + (cfg.allowedOpenIds || []).length,
      ].join('\n'));
      return;
    }

    if (state.pending) {
      if (/^(确认|确定|继续|yes|ok|y)$/i.test(text)) {
        const pending = state.pending;
        state.pending = null;
        saveState(state);
        audit('info', 'confirmed', { taskId: pending.taskId, text: pending.text });
        await sendText(cfg, chatId, '已确认，开始执行…');
        await execute(chatId, pending.text, pending.taskId);
        return;
      }
      if (/^(取消|放弃|no|cancel|n)$/i.test(text)) {
        state.pending = null;
        saveState(state);
        audit('info', 'cancelled', { chatId });
        await sendText(cfg, chatId, '已取消。');
        return;
      }
      state.pending = null;
      saveState(state);
    }

    if (isHighRisk(cfg, text)) {
      const taskId = newTaskId();
      state.pending = { text, chatId, taskId, at: Date.now() };
      saveState(state);
      audit('warn', 'confirm-required', { taskId, text });
      await sendText(cfg, chatId, `⚠️ 这条指令含高风险动作：\n${text}\n\n回复「确认」继续执行，回复「取消」放弃。`);
      return;
    }

    await sendText(cfg, chatId, '收到，开始执行…');
    await execute(chatId, text, newTaskId());
  }

  let consumer = null;
  let stopping = false;

  function startConsumer() {
    consumer = spawnConsumer(cfg);
    audit('info', 'consumer-start', { pid: consumer.pid });
    let buffer = '';
    consumer.stdout.setEncoding('utf8');
    consumer.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        enqueue(() => onMessage(event));
      }
    });
    consumer.stderr.setEncoding('utf8');
    consumer.stderr.on('data', (chunk) => {
      try { appendFileSync(join(LOG_DIR, 'consumer.log'), chunk); } catch { /* ignore */ }
    });
    consumer.on('error', (error) => {
      audit('error', 'consumer-error', { err: String(error) });
      if (!stopping) setTimeout(startConsumer, 5000);
    });
    consumer.on('close', (code) => {
      audit('warn', 'consumer-exit', { code });
      if (!stopping) setTimeout(startConsumer, 5000);
    });
  }

  startConsumer();

  return function shutdown() {
    stopping = true;
    try { consumer && consumer.kill(); } catch { /* ignore */ }
    audit('info', 'listener-stop', { pid: process.pid });
  };
}
