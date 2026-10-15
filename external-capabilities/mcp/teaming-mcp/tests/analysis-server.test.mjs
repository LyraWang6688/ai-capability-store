/**
 * 分析改走服务器（2026-10-15）。
 *
 * 这个文件守住一次架构变更：本包**不再 vendored 引擎**，改为调
 * `POST /api/host/v1/analyze`。换来的好处是引擎只有一份、物理上不可能漂移；
 * 代价是需要联网、逐字稿会上传。
 *
 * 所以这里要守住的几件事：
 *   ① 没有凭证时**说清下一步去哪拿**（而不是让人去配一个不存在的 API key）
 *   ② 请求确实带上了 includeAnalysis —— 本包要用分析结果渲染文档，
 *      服务器默认不返回全文，漏掉这个参数会拿到"没有分析结果"
 *   ③ 服务器返回的业务错误（如 not_abc_related）原样传出去，不被吞成通用失败
 *   ④ 401 要给出可执行的下一步（重新申请接入码）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 每个用例独立的 token 文件，避免读到开发机上的真实凭证 */
function withToken(content = 'tmh_testtoken') {
  const dir = mkdtempSync(join(tmpdir(), 'teaming-analysis-'));
  const file = join(dir, 'host-token');
  if (content) writeFileSync(file, content, { mode: 0o600 });
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 重新加载模块，带上指定的 token 文件与假的 fetch */
async function load({ tokenFile, fetchImpl }) {
  // ESM 相对 specifier 是相对【本模块】解析的；测试在 tests/ 下，
  // 所以要上跳一级。每次带唯一 query，避免 ESM 模块缓存复用上一个用例的
  // 环境变量与 fetch。
  const { pathToFileURL } = await import('node:url');
  const { dirname, join: pjoin } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = pjoin(dirname(fileURLToPath(import.meta.url)), '..');
  const url = `${pathToFileURL(pjoin(root, 'src', 'analysis.mjs')).href}?t=${Date.now()}-${Math.random()}`;
  const prevFile = process.env.TEAMING_TOKEN_FILE;
  const prevToken = process.env.TEAMING_HOST_TOKEN;
  const prevFetch = globalThis.fetch;

  process.env.TEAMING_TOKEN_FILE = tokenFile;
  delete process.env.TEAMING_HOST_TOKEN;
  globalThis.fetch = fetchImpl;

  const mod = await import(url);
  // ★ 不在这里恢复 fetch —— 测试是在 load() 返回【之后】才调 analyze()，
  // 提前恢复会让请求真的打出去（表现为耗时一秒多、结果不可控）。
  const restore = () => {
    if (prevFile === undefined) delete process.env.TEAMING_TOKEN_FILE;
    else process.env.TEAMING_TOKEN_FILE = prevFile;
    if (prevToken === undefined) delete process.env.TEAMING_HOST_TOKEN;
    else process.env.TEAMING_HOST_TOKEN = prevToken;
    globalThis.fetch = prevFetch;
  };
  return { mod, restore };
}

const LONG_ENOUGH = '张三 00:00:15 我们先过一下议程\n'.repeat(5);

function okResponse(analysisResult = { teamState: { zone: 'Learning' }, metadata: {} }) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      reused: false,
      reportUrl: 'https://meeting.bamamei.online/report/v2/pub-1',
      reportPublicId: 'pub-1',
      zone: 'Learning',
      analysisResult,
    }),
  };
}

test('没有凭证 → 说清下一步去哪拿接入码', async () => {
  const t = withToken(null);
  let restore = () => {};
  try {
    const loaded = await load({ tokenFile: t.file, fetchImpl: async () => { throw new Error('不该联网'); } });
    const mod = loaded.mod;
    restore = loaded.restore;
    const readiness = mod.analysisReadiness();
    assert.equal(readiness.ready, false);
    assert.match(readiness.problems.join('\n'), /接入码/);
    assert.match(readiness.problems.join('\n'), /share\/base\/form/, '要给出申请入口');
    assert.ok(
      !/DOUBAO_API_KEY|LLM_API_KEY/.test(readiness.problems.join('\n')),
      '不该再提"配模型 key"——那是旧架构的说法',
    );

    await assert.rejects(
      () => mod.analyze(LONG_ENOUGH),
      (e) => e.kind === 'not_ready',
    );
  } finally {
    restore();
    t.cleanup();
  }
});

test('★ 请求带 includeAnalysis 与 Bearer 凭证', async () => {
  const t = withToken('tmh_abc');
  let seen = null;
  let restore = () => {};
  try {
    const loaded = await load({
      tokenFile: t.file,
      fetchImpl: async (url, init) => {
        seen = { url, init, body: JSON.parse(init.body) };
        return okResponse();
      },
    });
    const mod = loaded.mod;
    restore = loaded.restore;

    await mod.analyze(LONG_ENOUGH, { feishuMeetingId: '7696', title: '第四期复盘' });

    assert.match(seen.url, /\/api\/host\/v1\/analyze$/);
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.Authorization, 'Bearer tmh_abc');
    // ★ 漏了它服务器就不返回全文，本包渲染文档会失败
    assert.equal(seen.body.includeAnalysis, true, '必须显式要求完整分析结果');
    assert.equal(seen.body.feishuMeetingId, '7696');
    assert.equal(seen.body.title, '第四期复盘');
  } finally {
    restore();
    t.cleanup();
  }
});

test('★ 服务器返回的分析结果被原样带出，并附上报告页信息', async () => {
  const t = withToken();
  let restore = () => {};
  try {
    const loaded = await load({ tokenFile: t.file, fetchImpl: async () => okResponse() });
    const mod = loaded.mod;
    restore = loaded.restore;
    const report = await mod.analyze(LONG_ENOUGH);
    assert.equal(report.teamState.zone, 'Learning', '分析内容应保留');
    assert.equal(report.server.reportUrl, 'https://meeting.bamamei.online/report/v2/pub-1');
    assert.equal(report.server.reused, false);
  } finally {
    restore();
    t.cleanup();
  }
});

test('★ 业务错误原样传出（not_abc_related 不被吞成"分析失败"）', async () => {
  const t = withToken();
  let restore = () => {};
  try {
    const loaded = await load({
      tokenFile: t.file,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          ok: false,
          error: { type: 'abc_gate', code: 'not_abc_related', message: '这场会与实战营无关。' },
        }),
      }),
    });
    const mod = loaded.mod;
    restore = loaded.restore;

    await assert.rejects(
      () => mod.analyze(LONG_ENOUGH),
      (e) => {
        assert.equal(e.kind, 'not_abc_related', 'kind 要用服务器给的 code');
        assert.match(e.message, /无关/);
        return true;
      },
    );
  } finally {
    restore();
    t.cleanup();
  }
});

test('401 → 给出可执行的下一步（重新申请接入码）', async () => {
  const t = withToken('tmh_expired');
  let restore = () => {};
  try {
    const loaded = await load({
      tokenFile: t.file,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '凭证无效。' } }),
      }),
    });
    const mod = loaded.mod;
    restore = loaded.restore;

    await assert.rejects(
      () => mod.analyze(LONG_ENOUGH),
      (e) => {
        assert.equal(e.kind, 'unauthorized');
        assert.match(e.message, /重新申请|过期/, '要告诉用户怎么办，而不是只报错');
        return true;
      },
    );
  } finally {
    restore();
    t.cleanup();
  }
});

test('连不上服务器 → network_failed，消息里带上地址', async () => {
  const t = withToken();
  let restore = () => {};
  try {
    const loaded = await load({
      tokenFile: t.file,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    const mod = loaded.mod;
    restore = loaded.restore;
    await assert.rejects(
      () => mod.analyze(LONG_ENOUGH),
      (e) => {
        assert.equal(e.kind, 'network_failed');
        assert.match(e.message, /meeting\.bamamei\.online/);
        return true;
      },
    );
  } finally {
    restore();
    t.cleanup();
  }
});

test('服务器返回非 JSON → bad_response', async () => {
  const t = withToken();
  let restore = () => {};
  try {
    const loaded = await load({
      tokenFile: t.file,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' }),
    });
    const mod = loaded.mod;
    restore = loaded.restore;
    await assert.rejects(
      () => mod.analyze(LONG_ENOUGH),
      (e) => e.kind === 'bad_response',
    );
  } finally {
    restore();
    t.cleanup();
  }
});

test('★ 逐字稿过短在本地就拦住，不浪费一次网络往返', async () => {
  const t = withToken();
  let called = false;
  let restore = () => {};
  try {
    const loaded = await load({
      tokenFile: t.file,
      fetchImpl: async () => { called = true; return okResponse(); },
    });
    const mod = loaded.mod;
    restore = loaded.restore;
    await assert.rejects(
      () => mod.analyze('太短了'),
      (e) => e.kind === 'transcript_too_short',
    );
    assert.equal(called, false, '过短的稿子不该发到服务器');
  } finally {
    restore();
    t.cleanup();
  }
});

test('服务器没回分析结果 → 明确报错，而不是给一个空报告', async () => {
  const t = withToken();
  let restore = () => {};
  try {
    const loaded = await load({
      tokenFile: t.file,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, reportUrl: 'https://x/1' }),   // 没有 analysisResult
      }),
    });
    const mod = loaded.mod;
    restore = loaded.restore;
    await assert.rejects(
      () => mod.analyze(LONG_ENOUGH),
      (e) => {
        assert.equal(e.kind, 'no_analysis_in_response');
        assert.match(e.message, /includeAnalysis/, '要说清是服务端不支持这个参数');
        return true;
      },
    );
  } finally {
    restore();
    t.cleanup();
  }
});

test('★ 本包不再自带引擎（没有本地引擎文件可加载）', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join: pjoin } = await import('node:path');
  const root = pjoin(dirname(fileURLToPath(import.meta.url)), '..');

  for (const p of ['src/engine-src', 'dist/engine', 'scripts/sync-engine.mjs']) {
    assert.ok(!existsSync(pjoin(root, p)), `${p} 不该存在——引擎只有服务器那一份`);
  }
});

test('体检里说明分析走服务器，也不再展示本机模型配置', async () => {
  const t = withToken();
  let restore = () => {};
  try {
    const loaded = await load({ tokenFile: t.file, fetchImpl: async () => okResponse() });
    const mod = loaded.mod;
    restore = loaded.restore;
    const summary = mod.providerSummary();
    assert.equal(summary.mode, 'server');
    assert.match(summary.apiBaseUrl, /^https:/);
    assert.equal(summary.hasToken, true);
    assert.ok(!('model' in summary), '本机不再有"分析模型"这个概念');
  } finally {
    restore();
    t.cleanup();
  }
});
