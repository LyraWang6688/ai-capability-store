/**
 * npm 包可发布性守卫。
 *
 * ## 为什么需要它
 *
 * 2026-10-14 首次 `npm publish` 时 npm 静默做了这件事：
 *
 *   npm warn publish "bin[teaming]" script name src/cli.mjs was invalid and removed
 *   npm warn publish "bin[teaming-mcp]" script name src/mcpServer.mjs was invalid and removed
 *
 * 原因是那两个文件**没有可执行位**（权限 -rw-------）。npm 不报错，只是把 bin
 * 条目悄悄丢掉——**装完之后 `teaming` 命令根本不存在**，而 `npm install -g`
 * 会显示成功。整个安装流程在用户那边断掉，本地却什么都看不出来。
 *
 * 这类"发布时才暴露、且不报错"的问题必须用测试挡住，不能靠人记得。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('package.json 声明了 bin（否则 npm install -g 不会生成命令）', () => {
  assert.ok(pkg.bin && Object.keys(pkg.bin).length > 0, 'bin 不能为空');
});

for (const [name, rel] of Object.entries(pkg.bin || {})) {
  test(`bin「${name}」指向的文件存在`, () => {
    assert.ok(existsSync(join(ROOT, rel)), `找不到 ${rel}`);
  });

  test(`★ bin「${name}」必须可执行（否则 npm 会静默丢弃这个条目）`, () => {
    const mode = statSync(join(ROOT, rel)).mode;
    assert.ok(mode & 0o111, `${rel} 没有可执行位——npm publish 时会静默移除 bin[${name}]，装完就没有这个命令`);
  });

  test(`bin「${name}」必须有 shebang（否则装了也执行不了）`, () => {
    const first = readFileSync(join(ROOT, rel), 'utf8').slice(0, 2);
    assert.equal(first, '#!', `${rel} 缺少 shebang`);
  });
}

test('files 白名单包含运行必需的目录', () => {
  const files = pkg.files || [];
  for (const need of ['src', 'dist/engine']) {
    assert.ok(files.includes(need), `files 里缺少 ${need}——用户装完跑不起来`);
  }
});

test('npm 的 repository 指向 Store 实现目录（不单独建仓库）', () => {
  const repo = pkg.repository;
  assert.ok(repo && repo.directory, 'repository 必须带 directory 字段，指向 Store 里的实现目录');
  assert.match(repo.url, /ai-capability-store/);
});
