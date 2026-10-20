#!/usr/bin/env node
'use strict';
// npm 包装层：把 shell 实现暴露成 `mac-cleanup` 命令。
//
// 为什么需要它（而不是让 npm 的 bin 直接指向 .sh）：
//   1. 契约要求 bin 是可运行的 JS，直接指 .sh 在非 POSIX 环境下不可启动；
//   2. 可以在这里给出明确的平台错误，而不是让 bash 报一个难懂的错；
//   3. 把参数与退出码原样透传，行为与直接跑脚本完全一致。
//
// 注意：本文件不解析任何业务逻辑 —— 真正的实现仍在 mac-cleanup.sh 与 lib/。

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'mac-cleanup.sh');

if (process.platform !== 'darwin') {
  console.error(
    `mac-cleanup 只支持 macOS（当前平台：${process.platform}）。\n` +
      '它依赖 Mole（mo）与 launchd，两者都是 macOS 专有。'
  );
  process.exit(1);
}

if (!fs.existsSync(script)) {
  console.error(`包不完整：找不到 ${script}`);
  console.error('请重新安装：npx @lyra_wang/mac-cleanup --help');
  process.exit(1);
}

const result = spawnSync('bash', [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

if (result.error) {
  console.error(`启动失败：${result.error.message}`);
  process.exit(1);
}
if (typeof result.status === 'number') {
  process.exit(result.status);
}
process.exit(result.signal ? 1 : 0);
