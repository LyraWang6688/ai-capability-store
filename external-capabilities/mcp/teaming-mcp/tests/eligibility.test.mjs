/**
 * 会议「能不能分析」的判定测试 —— 用假 lark-cli，不联网。
 *
 * 锁住产品规则：**只认妙记的文字转录稿**。
 * 判定依据必须是「有妙记 token 且妙记可读」，不能用"有智能纪要"充数——
 * 那种会议分析不了，列表里必须如实标 false。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 必须在 import lark.mjs 之前设好
process.env.LARK_CLI = new URL('./helpers/fake-lark-cli.mjs', import.meta.url).pathname;
process.env.FAKE_LARK_MODE = 'minute-ok';
process.env.FAKE_VC_SEARCH = JSON.stringify([
  { id: 'm-ok', title: '有妙记的会', recording: true, time: '9月22日 11:36' },
  { id: 'm-doc', title: '只有智能纪要的会', doc: true, time: '9月22日 11:29' },
  { id: 'm-none', title: '没录制的会', time: '9月21日 10:00' },
  { id: 'm-denied', title: '妙记无权限的会', recording: true, time: '9月20日 09:00' },
]);
process.env.FAKE_VC_DETAIL = JSON.stringify({
  'm-ok': { topic: '有妙记的会', minuteToken: 'tok-ok', startTime: '2026-09-22 11:36' },
  'm-doc': { topic: '只有智能纪要的会', noteId: 'note-x', startTime: '2026-09-22 11:29' },
  'm-none': { topic: '没录制的会', startTime: '2026-09-21 10:00' },
  'm-denied': { topic: '妙记无权限的会', minuteToken: 'tok-denied', minuteDenied: true, startTime: '2026-09-20 09:00' },
});

const { listMeetingsWithEligibility } = await import('../src/pipeline.mjs');

test('有妙记且可读 → 可分析', async () => {
  const list = await listMeetingsWithEligibility({ days: 30 });
  const m = list.find((x) => x.meetingId === 'm-ok');
  assert.equal(m.analyzable, true);
  assert.equal(m.reason, null);
  assert.equal(m.hasMinute, true);
  assert.equal(m.minuteReadable, true);
});

test('只有智能纪要、没有妙记 → 不可分析（不能用 AI 纪要充数）', async () => {
  const list = await listMeetingsWithEligibility({ days: 30 });
  const m = list.find((x) => x.meetingId === 'm-doc');
  assert.equal(m.analyzable, false, '只有智能纪要的会不应被判为可分析');
  assert.equal(m.reason, 'no_minute');
  assert.equal(m.hasMinute, false);
});

test('没录制 → 不可分析，原因是 no_minute', async () => {
  const list = await listMeetingsWithEligibility({ days: 30 });
  const m = list.find((x) => x.meetingId === 'm-none');
  assert.equal(m.analyzable, false);
  assert.equal(m.reason, 'no_minute');
});

test('妙记无权限 → 不可分析，原因是 minute_permission_denied', async () => {
  const list = await listMeetingsWithEligibility({ days: 30 });
  const m = list.find((x) => x.meetingId === 'm-denied');
  assert.equal(m.analyzable, false);
  assert.equal(m.reason, 'minute_permission_denied');
  assert.equal(m.hasMinute, true, '有 token 但不可读，两者要分开报');
});

test('可分析场次统计正确（4 场里只有 1 场）', async () => {
  const list = await listMeetingsWithEligibility({ days: 30 });
  assert.equal(list.length, 4);
  assert.equal(list.filter((m) => m.analyzable).length, 1);
});

test('每条都带 title 与 startTime，供上层直接展示', async () => {
  const list = await listMeetingsWithEligibility({ days: 30 });
  for (const m of list) {
    assert.ok(m.title, `缺少 title: ${JSON.stringify(m)}`);
    assert.ok(m.startTime, `缺少 startTime: ${JSON.stringify(m)}`);
  }
});

test('verify=true 会真的去取稿（假 lark 会校验参数）', async () => {
  const list = await listMeetingsWithEligibility({ days: 30, verify: true });
  const m = list.find((x) => x.meetingId === 'm-ok');
  assert.equal(m.analyzable, true, 'verify 模式下取稿成功仍应可分析');
});

test('verify=true 时逐字稿太短的会被判不可分析', async () => {
  process.env.FAKE_LARK_MODE = 'minute-short';
  try {
    const list = await listMeetingsWithEligibility({ days: 30, verify: true });
    const m = list.find((x) => x.meetingId === 'm-ok');
    assert.equal(m.analyzable, false);
    assert.equal(m.reason, 'transcript_too_short');
  } finally {
    process.env.FAKE_LARK_MODE = 'minute-ok';
  }
});

test('verify=false（默认）不做额外取稿，只看妙记可读性', async () => {
  const list = await listMeetingsWithEligibility({ days: 30 });
  const m = list.find((x) => x.meetingId === 'm-ok');
  assert.equal(m.analyzable, true);
  assert.equal(m.reason, null);
});
