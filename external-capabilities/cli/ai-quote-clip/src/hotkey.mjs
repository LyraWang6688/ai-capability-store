/** Build, install and control the macOS hotkey helper (compiled locally with swiftc). */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR, HOTKEY_CONFIG_PATH, LOG_DIR, PLIST_LABEL, PLIST_PATH, ROOT, ensureDirs } from './config.mjs';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function isMac() {
  return process.platform === 'darwin';
}

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : 501;
}

function launchctl(args, allowFailure = true) {
  try {
    return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (!allowFailure) throw error;
    return '';
  }
}

export function hotkeyStatus() {
  if (!isMac()) return { supported: false, running: false, detail: '快捷键仅 macOS 支持' };
  if (!existsSync(PLIST_PATH)) return { supported: true, installed: false, running: false, detail: '未安装' };
  const output = launchctl(['print', `gui/${uid()}/${PLIST_LABEL}`]);
  if (!output) return { supported: true, installed: true, running: false, detail: '已安装但未运行' };
  const pid = /pid = (\d+)/.exec(output);
  return { supported: true, installed: true, running: Boolean(pid), detail: pid ? `running pid=${pid[1]}` : 'unknown' };
}

export function installHotkey({ nodePath, cliPath }) {
  if (!isMac()) throw new Error('快捷键安装仅支持 macOS');
  const swift = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  const compiler = swift.status === 0 ? '/usr/bin/xcrun' : null;
  if (!compiler) throw new Error('未找到 swiftc：请安装 Xcode Command Line Tools（xcode-select --install）');

  ensureDirs();
  mkdirSync(join(APP_DIR, 'Contents', 'MacOS'), { recursive: true });
  const source = readFileSync(join(PKG_ROOT, 'hotkey', 'AiQuoteClip.swift'), 'utf8');
  const sourcePath = join(ROOT, 'AiQuoteClip.swift');
  writeFileSync(sourcePath, source);
  const binary = join(APP_DIR, 'Contents', 'MacOS', 'AiQuoteClip');
  execFileSync(compiler, ['swiftc', '-O', sourcePath, '-o', binary, '-framework', 'Cocoa', '-framework', 'Carbon'], { stdio: 'inherit' });

  writeFileSync(join(APP_DIR, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AiQuoteClip</string>
  <key>CFBundleIdentifier</key><string>${PLIST_LABEL}</string>
  <key>CFBundleExecutable</key><string>AiQuoteClip</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>用于显示收录成功通知</string>
</dict>
</plist>
`);
  try { execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', APP_DIR], { stdio: 'ignore' }); } catch { /* signing is best-effort */ }

  writeFileSync(HOTKEY_CONFIG_PATH, JSON.stringify({ node: nodePath, cli: cliPath }, null, 2) + '\n');
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array><string>${join(APP_DIR, 'Contents', 'MacOS', 'AiQuoteClip')}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${join(LOG_DIR, 'hotkey.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, 'hotkey.err.log')}</string>
</dict>
</plist>
`);
  launchctl(['bootout', `gui/${uid()}/${PLIST_LABEL}`]);
  launchctl(['bootstrap', `gui/${uid()}`, PLIST_PATH], false);
  return { app: APP_DIR, plist: PLIST_PATH };
}

export function uninstallHotkey() {
  if (!isMac()) return { removed: false };
  launchctl(['bootout', `gui/${uid()}/${PLIST_LABEL}`]);
  let removed = false;
  if (existsSync(PLIST_PATH)) {
    try { unlinkSync(PLIST_PATH); removed = true; } catch { /* ignore */ }
  }
  return { removed, plist: PLIST_PATH };
}
