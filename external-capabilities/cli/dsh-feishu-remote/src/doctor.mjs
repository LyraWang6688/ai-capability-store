/**
 * Environment health checks. Each returns ok | warn | fail with a hint.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CONFIG_PATH, loadConfig } from './config.mjs';
import { authStatus, botReady, currentOpenId, eventDryRun } from './feishu.mjs';
import { serviceStatus } from './service.mjs';

function which(command) {
  if (command.includes('/')) return existsSync(command) ? command : null;
  const result = spawnSync('/usr/bin/which', [command], { encoding: 'utf8' });
  const path = (result.stdout || '').trim();
  return result.status === 0 && path !== '' ? path : null;
}

/**
 * Judge the execution backend by what it actually produced, not by whether the
 * binary exists. A `dsh` running on Node <24 exits 0 with empty output because
 * `import.meta.main` is undefined — `which`-only checks call that healthy.
 */
export function evaluateBackendProbe({ code, stdout, stderr } = {}) {
  const out = String(stdout || '').trim();
  const err = String(stderr || '').trim();
  if (code === 0 && out !== '') {
    return { status: 'ok', detail: `有输出：${out.split('\n')[0].slice(0, 80)}`, hint: '' };
  }
  if (code === 0) {
    return {
      status: 'fail',
      detail: '退出码 0，但没有任何输出',
      hint: '最可能：dsh 跑在 Node <24 上（import.meta.main 不存在 → 静默退出 0）。把 config 的 extraEnv.PATH 指向运行 DSH 的 node 目录；再手工验证 `dsh --version` 有输出。',
    };
  }
  return {
    status: 'fail',
    detail: `执行失败（exit ${code === null || code === undefined ? 'spawn-error' : code}）${err.slice(0, 120)}`,
    hint: '检查 dshCli 路径、模型 Key 与 extraEnv',
  };
}

function probeBackend(cfg, { full }) {
  const args = full ? [...(cfg.agentArgs || ['headless']), '只回复两个字：在线'] : ['--version'];
  const env = { ...process.env, ...(cfg.extraEnv || {}) };
  const result = spawnSync(cfg.dshCli, args, {
    encoding: 'utf8',
    timeout: full ? 60000 : 10000,
    env,
    cwd: cfg.workdir,
  });
  const code = result.error ? null : result.status;
  return evaluateBackendProbe({
    code,
    stdout: result.stdout,
    stderr: result.stderr || (result.error ? String(result.error) : ''),
  });
}

export async function runDoctor({ full = false } = {}) {
  const checks = [];
  const add = (name, status, detail, hint) => checks.push({ name, status, detail, hint });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js 版本', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, major >= 20 ? '' : '需要 Node 20 或更高版本');

  const cfg = loadConfig();
  add('配置文件', cfg ? 'ok' : 'fail', cfg ? CONFIG_PATH : '未找到', cfg ? '' : '运行 dsh-feishu-remote init');

  const larkPath = which(cfg ? cfg.larkCli : 'lark-cli');
  if (!larkPath) {
    add('lark-cli', 'fail', '未找到', '安装：npm i -g @larksuite/cli，然后 lark-cli config init / auth login');
  } else {
    const version = spawnSync(larkPath, ['--version'], { encoding: 'utf8' });
    add('lark-cli', 'ok', (version.stdout || '').trim().split('\n')[0] || larkPath, '');
  }

  if (cfg && larkPath) {
    const status = await authStatus(cfg);
    const openId = currentOpenId(status);
    const bot = botReady(status);
    add('飞书机器人身份', bot ? 'ok' : 'fail',
      bot ? 'bot identity ready（收发消息只需要它）' : 'bot 身份不可用',
      bot ? '' : `lark-cli ${cfg.larkProfile ? `--profile ${cfg.larkProfile} ` : ''}profile add / auth login`);
    if (openId) {
      if (Array.isArray(cfg.allowedOpenIds) && cfg.allowedOpenIds.length > 0 && !cfg.allowedOpenIds.includes(openId)) {
        add('白名单', 'warn', `当前账号不在 allowedOpenIds 中（${openId}）`, '把该 open_id 加入 config.json 的 allowedOpenIds');
      } else {
        add('白名单', 'ok', `${(cfg.allowedOpenIds || []).length} 人`, '');
      }
    } else {
      add('白名单', 'warn', `仅 bot 身份：读不到用户 open_id，无法自动核对（配置里 ${(cfg.allowedOpenIds || []).length} 人）`,
        '确认 allowedOpenIds 里是你的 open_id；初始化时可用 init --open-id ou_xxx');
    }

    const dry = await eventDryRun(cfg);
    let parsed = null;
    try { parsed = JSON.parse(dry.stdout); } catch { /* not json */ }
    const preconditions = (parsed && parsed.data && parsed.data.decision && parsed.data.decision.preconditions) || [];
    const bad = preconditions.filter((item) => item.status !== 'ok');
    add('飞书事件订阅', dry.code === 0 && parsed && parsed.ok ? bad.length === 0 ? 'ok' : 'fail' : 'fail',
      bad.length === 0 ? 'im.message.receive_v1 就绪' : bad.map((item) => `${item.name}: ${item.status}`).join(', '),
      '开放平台 → 事件订阅 → 添加 im.message.receive_v1（长连接），并开启 im:message.p2p_msg:readonly 权限');

    const dshPath = which(cfg.dshCli);
    if (!dshPath) {
      add('执行后端', 'fail', `未找到 ${cfg.dshCli}`,
        '安装 DSH（或在 config.json 把 dshCli/agentArgs 指向你自己的命令）');
    } else {
      const probe = probeBackend(cfg, { full });
      add(full ? '执行后端（端到端）' : '执行后端可运行', probe.status,
        `${dshPath}；${probe.detail}`, probe.hint);
    }

    add('工作目录', existsSync(cfg.workdir) ? 'ok' : 'fail', cfg.workdir, '在 config.json 里把 workdir 改成存在的目录');

    const keyVar = cfg.apiKeyEnv || 'DEEPSEEK_API_KEY';
    let keyFound = Boolean(process.env[keyVar]);
    if (!keyFound && cfg.keychainService && process.platform === 'darwin') {
      const result = spawnSync('/usr/bin/security', ['find-generic-password', '-a', process.env.USER || '', '-s', cfg.keychainService, '-w'], { encoding: 'utf8' });
      keyFound = result.status === 0 && (result.stdout || '').trim() !== '';
    }
    add('模型 API Key', keyFound ? 'ok' : 'warn', keyFound ? `${keyVar} 已就绪` : `${keyVar} 未找到`,
      `security add-generic-password -a "$USER" -s ${cfg.keychainService || 'DEEPSEEK_API_KEY'} -w "<key>"`);
  }

  const svc = serviceStatus();
  add('后台服务', svc.running ? 'ok' : 'warn', svc.detail, svc.running ? '' : '安装：dsh-feishu-remote install-service');

  return checks;
}
