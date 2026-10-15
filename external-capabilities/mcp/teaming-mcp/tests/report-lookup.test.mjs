/**
 * reportPathFor —— 报告定位。
 *
 * 这里曾经有个**静默**错误：`meetingId` 为 undefined 时不报错，
 * 而是返回**另一场会的报告**。
 *
 * 成因是"退一步读 meetingRef"那段：`ref.id === meetingId` 在 meetingId 为
 * undefined 时退化成 `ref.id === undefined`，只要某份报告缺 `meetingRef`
 * （`ref = {}`）它就成立。
 *
 * 后果不是崩溃，而是**发错东西**：宿主漏传 `meeting_id` → 拿到别的报告 →
 * 把别人的会议卡片发给当前用户。这类错误没有报错可看，最难发现。
 *
 * 2026-10-15 实测复现：调 `teaming_report_card` 不带 `meeting_id`，
 * 返回了目录里另一份报告的链接。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let loadSeq = 0;

/** 在隔离的数据目录里加载 pipeline（每个用例一份新模块实例）*/
async function loadWithDataDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaming-test-'));
  const outDir = path.join(dir, '.out');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), JSON.stringify(content));
  }
  process.env.TEAMING_DATA_DIR = dir;
  // pipeline.mjs 在【模块加载时】就把 OUT_DIR 求值好了，而 ESM 会缓存模块。
  // 所以每个用例都要用一个唯一的 specifier 破缓存，否则后续用例仍然读第一个目录。
  const url = `${pathToFileURL(path.join(process.cwd(), 'src/pipeline.mjs')).href}?v=${++loadSeq}`;
  const mod = await import(url);
  return { mod, dir, outDir };
}

test('★ 不传 meeting_id 时返回 null，绝不"猜"一份报告', async () => {
  const { mod } = await loadWithDataDir({
    // 这份缺 meetingRef —— 正是曾经被误命中的那种
    '别的会-111.report.json': { teamState: { zone: 'Apathy' } },
  });
  for (const bad of [undefined, null, '', '   ']) {
    assert.equal(
      mod.reportPathFor(bad),
      null,
      `meeting_id = ${JSON.stringify(bad)} 时必须返回 null；`
        + '返回一份报告意味着宿主会拿到别的会议的内容',
    );
  }
});

test('★ 缺 meetingRef 的报告不会被任何 id 命中', async () => {
  const { mod } = await loadWithDataDir({
    '无引用-111.report.json': { teamState: {} },
  });
  assert.equal(mod.reportPathFor('随便一个 id'), null);
});

test('按文件名里的 id 能正常找到（约定路径不受影响）', async () => {
  const { mod } = await loadWithDataDir({
    '产品周会-7696788180137512177.report.json': { meetingRef: { id: '7696788180137512177' } },
  });
  const hit = mod.reportPathFor('7696788180137512177');
  assert.ok(hit, '合法 id 必须能找到');
  assert.match(hit, /产品周会-7696788180137512177/);
});

test('文件名是内容哈希时，靠 meetingRef 也能找到（供稿模式）', async () => {
  const { mod } = await loadWithDataDir({
    'MCP链路测试-hccea3715d512.report.json': {
      meetingRef: { id: 'hccea3715d512', feishuMeetingId: '7696788180137512177' },
    },
  });
  assert.ok(
    mod.reportPathFor('7696788180137512177'),
    '宿主手里是飞书 meeting_id，文件名里是内容哈希——必须靠 meetingRef 兜住',
  );
});

test('真正不存在的 id 返回 null', async () => {
  const { mod } = await loadWithDataDir({
    '有引用-222.report.json': { meetingRef: { id: '222' } },
  });
  assert.equal(mod.reportPathFor('不存在的-id'), null);
});
