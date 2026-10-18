/** Install the hotkey through Hammerspoon (signed app, stable Accessibility grant). */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HS_DIR = join(homedir(), '.hammerspoon');
const LUA_PATH = join(HS_DIR, 'ai-quote-clip.lua');
const INIT_PATH = join(HS_DIR, 'init.lua');
const INCLUDE_LINE = 'dofile(hs.configdir .. "/ai-quote-clip.lua")';
const HS_BIN_CANDIDATES = ['/opt/homebrew/bin/hs', '/usr/local/bin/hs'];
const HS_APP = '/Applications/Hammerspoon.app';

export function isMac() {
  return process.platform === 'darwin';
}

function findHsBin() {
  return HS_BIN_CANDIDATES.find((p) => existsSync(p)) || null;
}

function hsRunning() {
  const out = spawnSync('/usr/bin/pgrep', ['-f', 'Hammerspoon.app/Contents/MacOS/Hammerspoon'], { encoding: 'utf8' });
  return out.status === 0;
}

function reload() {
  const bin = findHsBin();
  if (!bin) return false;
  const out = spawnSync(bin, ['-c', 'hs.reload()'], { encoding: 'utf8' });
  return out.status === 0;
}

function ensureLoginItem() {
  const script = `tell application "System Events"
  if not (exists login item "Hammerspoon") then
    make login item at end with properties {path:"${HS_APP}", hidden:true}
  end if
end tell`;
  try { execFileSync('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' }); } catch { /* best effort */ }
}

export function hammerspoonStatus() {
  if (!isMac()) return { supported: false, installed: false };
  return {
    supported: true,
    appInstalled: existsSync(HS_APP),
    running: hsRunning(),
    configInstalled: existsSync(LUA_PATH),
    includeInInit: existsSync(INIT_PATH) && readFileSync(INIT_PATH, 'utf8').includes('ai-quote-clip.lua'),
  };
}

export function installHammerspoon({ nodePath, cliPath, key = 'z' }) {
  if (!isMac()) throw new Error('快捷键安装仅支持 macOS');
  if (!existsSync(HS_APP)) {
    throw new Error('未安装 Hammerspoon：先运行 brew install --cask hammerspoon（免费开源）');
  }
  mkdirSync(HS_DIR, { recursive: true });
  mkdirSync(join(homedir(), '.ai-quote-clip', 'logs'), { recursive: true });
  const template = readFileSync(join(PKG_ROOT, 'hotkey', 'hammerspoon', 'ai-quote-clip.lua.template'), 'utf8');
  const lua = template
    .replaceAll('__CLI__', cliPath)
    .replaceAll('__NODE__', nodePath)
    .replaceAll('__KEY__', String(key || 'z').toLowerCase());
  writeFileSync(LUA_PATH, lua);

  let init = existsSync(INIT_PATH) ? readFileSync(INIT_PATH, 'utf8') : '';
  if (!init.includes('ai-quote-clip.lua')) {
    init = init.length ? `${init.trimEnd()}\n\n-- ai-quote-clip hotkey\n${INCLUDE_LINE}\n` : `-- ai-quote-clip hotkey\n${INCLUDE_LINE}\n`;
    writeFileSync(INIT_PATH, init);
  }
  if (!hsRunning()) {
    try { execFileSync('/usr/bin/open', ['-a', HS_APP], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  ensureLoginItem();
  const reloaded = reload();
  return { lua: LUA_PATH, init: INIT_PATH, reloaded };
}

export function uninstallHammerspoon() {
  if (!isMac()) return { removed: false };
  const existed = existsSync(LUA_PATH);
  if (existed) rmSync(LUA_PATH, { force: true });
  if (existsSync(INIT_PATH)) {
    const next = readFileSync(INIT_PATH, 'utf8')
      .split('\n')
      .filter((line) => !line.includes('ai-quote-clip.lua'))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    writeFileSync(INIT_PATH, next);
  }
  reload();
  return { removed: existed };
}
