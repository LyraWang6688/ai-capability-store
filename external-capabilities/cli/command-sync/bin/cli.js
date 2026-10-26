#!/usr/bin/env node
// npm bin shim for command-sync: `command-sync install` or `command-sync palette`.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const command = process.argv[2] || 'help';

function run(cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

if (command === 'install') {
  run('/bin/bash', [join(root, 'install.sh')]);
} else if (command === 'palette') {
  run('/usr/bin/python3', [join(root, 'palette.py')]);
} else if (command === 'doctor') {
  run(process.execPath, [join(here, 'doctor.js')]);
} else {
  console.log('用法:');
  console.log('  command-sync install   # 安装到 ~/.command-sync（Hammerspoon ⌥X 面板）');
  console.log('  command-sync doctor    # 自检：Python / Hammerspoon / 辅助功能 / 数据源');
  console.log('  command-sync palette   # 重新生成面板数据');
  process.exit(command === 'help' ? 0 : 2);
}
