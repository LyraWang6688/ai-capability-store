import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'sessions.json');
let store = {};

try {
  store = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  store = {};
}

let saving = false;

function save() {
  if (saving) return;
  saving = true;
  setTimeout(() => {
    saving = false;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(store), 'utf8');
    } catch (error) {
      console.error('[session] 保存失败:', error.message);
    }
  }, 500);
}

export function getHistory(chatId) {
  return store[chatId] ?? [];
}

export function appendHistory(chatId, messages) {
  const next = [...(store[chatId] ?? []), ...messages].slice(-config.maxHistory * 2);
  store[chatId] = next;
  save();
}
