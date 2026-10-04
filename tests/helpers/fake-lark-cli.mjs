#!/usr/bin/env node
/**
 * 假的 lark-cli —— 只用于测试。
 *
 * 它会**校验调用方传的参数**，参数不对就报错。
 * 这样才拦得住真实踩过的坑：`--minute-token` 写成单数、
 * 忘了传 `--transcript`、导出目录不在允许范围。
 *
 * 行为由环境变量 FAKE_LARK_MODE 控制：
 *   minute-ok      → 正常导出逐字稿
 *   minute-empty   → 导出空文件
 *   minute-short   → 只有两条发言（用于测"太短"门槛）
 *   minute-denied  → 返回权限错误
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_LARK_MODE || 'minute-ok';

function fail(message, { subtype = 'invalid_argument', code = 2 } = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { type: 'validation', subtype, message } })}\n`);
  process.exit(code);
}

if (args[0] === 'vc' && args[1] === '+search') {
  const rows = JSON.parse(process.env.FAKE_VC_SEARCH || '[]');
  const items = rows.map((r) => ({
    id: r.id,
    display_info: `${r.title}\n\n${r.time || ''} | 组织者：${r.organizer || '某人'}${r.recording ? `\n录制：${r.title}` : ''}${r.doc ? `\n云文档：智能纪要：${r.title}` : ''}`,
  }));
  process.stdout.write(`${JSON.stringify({ ok: true, identity: 'user', data: { items } })}\n`);
  process.exit(0);
}

if (args[0] === 'vc' && args[1] === '+detail') {
  const ids = (args[args.indexOf('--meeting-ids') + 1] || '').split(',').filter(Boolean);
  const table = JSON.parse(process.env.FAKE_VC_DETAIL || '{}');
  const meetings = ids.map((id) => {
    const d = table[id] || {};
    return {
      meeting_id: id,
      topic: d.topic || '未命名会议',
      start_time: d.startTime || '',
      note_id: d.noteId || '',
      minute_token: d.minuteToken || '',
      ...(d.minuteDenied ? { hint: 'no permission to access this meeting\'s minute' } : {}),
    };
  });
  process.stdout.write(`${JSON.stringify({ ok: true, identity: 'user', data: { meetings } })}\n`);
  process.exit(0);
}

if (args[0] === 'minutes' && args[1] === '+detail') {
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const tokens = get('--minute-tokens');

  // 回归守卫：必须是复数 flag
  if (args.includes('--minute-token')) fail('unknown flag "--minute-token" (did you mean --minute-tokens?)');
  if (!tokens) fail('missing --minute-tokens');
  // 回归守卫：不传 --transcript 就只会返回基本信息
  if (!args.includes('--transcript')) fail('--transcript is required to export the transcript');

  const outDir = get('--output-dir');
  if (!outDir) fail('missing --output-dir');
  // 回归守卫：lark-cli 只允许 cwd / /tmp / ~/files
  const allowed = outDir.startsWith('/tmp') || outDir.startsWith(process.cwd()) || outDir.includes('/files');
  if (!allowed) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { type: 'validation', subtype: 'invalid_argument', message: `"--output \\"${outDir}\\" is outside the built-in allowlist; allowed roots are the current working directory, /tmp, or ~/files` } })}\n`);
    process.exit(2);
  }

  if (mode === 'minute-denied') fail('no permission to access this minute', { subtype: 'permission_denied', code: 3 });

  const dir = path.join(outDir, `artifact-假会议-${tokens}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'transcript.txt');
  const longBody = '2026-09-22 11:29:33 CST|6min 51s\n\n'
    + '甲 00:00:53.530 \n嗯。\n\n'
    + '乙 00:00:55.150 \n哈喽。\n\n'
    + '甲 00:01:02.000 \n我们先过一下今天的议题。\n\n'
    + '乙 00:01:10.500 \n好，我这边有两个问题想说。\n\n'
    + '甲 00:01:18.200 \n你说。\n';
  const shortBody = '2026-09-22 11:29:33 CST|1min 00s\n\n甲 00:00:10.000 \n嗯。\n\n乙 00:00:12.000 \n嗯。\n';
  const body = mode === 'minute-empty' ? ''
    : mode === 'minute-short' ? shortBody
      : longBody;
  fs.writeFileSync(file, body);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    identity: 'user',
    data: { minutes: [{ minute_token: tokens, title: '假会议', artifacts: { transcript_file: file } }] },
  })}\n`);
  process.exit(0);
}

fail(`unexpected command: ${args.join(' ')}`);
