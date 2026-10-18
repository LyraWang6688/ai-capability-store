/**
 * Environment health checks. Each returns ok | warn | fail with a hint.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CONFIG_PATH, loadConfig } from './config.mjs';
import { authStatus, currentOpenId, eventDryRun } from './feishu.mjs';
import { serviceStatus } from './service.mjs';

function which(command) {
  if (command.includes('/')) return existsSync(command) ? command : null;
  const result = spawnSync('/usr/bin/which', [command], { encoding: 'utf8' });
  const path = (result.stdout || '').trim();
  return result.status === 0 && path !== '' ? path : null;
}

export async function runDoctor() {
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
    add('飞书授权', openId ? 'ok' : 'fail',
      openId ? `user open_id=${openId}` : '未登录或授权失效',
      openId ? '' : `lark-cli ${cfg.larkProfile ? `--profile ${cfg.larkProfile} ` : ''}auth login --domain im`);
    if (openId && Array.isArray(cfg.allowedOpenIds) && cfg.allowedOpenIds.length > 0 && !cfg.allowedOpenIds.includes(openId)) {
      add('白名单', 'warn', `当前账号不在 allowedOpenIds 中（${openId}）`, '把该 open_id 加入 config.json 的 allowedOpenIds');
    } else if (openId) {
      add('白名单', 'ok', `${(cfg.allowedOpenIds || []).length} 人`, '');
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
    add('执行后端', dshPath ? 'ok' : 'fail', dshPath || `未找到 ${cfg.dshCli}`,
      '安装 DSH（或在 config.json 把 dshCli/agentArgs 指向你自己的命令）');

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
