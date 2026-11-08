/**
 * Image messages: download the bytes and tell the agent to look at them.
 *
 * lark-cli already flattens a message into Markdown text, so an image arrives
 * as `![Image](img_v3_...)` — an image key, not a file and not a URL. Without
 * this step the headless agent only ever sees that string and honestly answers
 * that it cannot see the picture.
 *
 * The fix is two moves, both here: fetch the resource with
 * `lark-cli im +messages-resources-download` (bot identity; the app needs the
 * `im:resource` scope), then rewrite the task so `read_image` gets a real path.
 * The agent's `read_image` tool commits the bytes to the attachment store, and
 * image-capable models (deepseek-flash) can then actually see it.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { run } from './feishu.mjs';

/** Markdown image placeholder that lark-cli emits for `post` messages. */
const IMAGE_MARKDOWN = /!\[[^\]]*\]\((img_[A-Za-z0-9_-]+)\)/g;

/**
 * Placeholders of every shape lark-cli renders:
 *   post  (text + image sent together)  ->  `![Image](img_v3_...)`
 *   image (a photo sent on its own)     ->  `[Image: img_v3_...]`
 * Both name the same resource, so both must be stripped before the prompt is
 * handed to the model.
 */
const IMAGE_PLACEHOLDER = /!\[[^\]]*\]\(img_[A-Za-z0-9_-]+\)|\[(?:Image|图片)[:：]\s*img_[A-Za-z0-9_-]+\]/g;

/** Where downloaded images live, relative to the bridge workdir (the dsh cwd). */
export const IMAGE_DIR = '.feishu-images';

/** The most images one message may carry before we stop downloading. */
const MAX_IMAGES = 6;

/**
 * Message types the bridge can actually act on. Everything else is rejected
 * with an explicit reply instead of being forwarded as meaningless text:
 * lark-cli pre-renders every type to human-readable text, so an audio/file
 * message would otherwise look like an ordinary task and the model would have
 * to guess why it has no content.
 */
export const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'post', 'image']);

const UNSUPPORTED_LABELS = {
  file: '文件',
  audio: '语音',
  media: '视频',
  sticker: '表情',
  share_chat: '群名片',
  share_user: '个人名片',
  interactive: '卡片',
  system: '系统',
};

/** Friendly Chinese label for an unsupported type; null when it is supported. */
export function unsupportedMessageLabel(messageType) {
  const type = String(messageType || '').trim();
  if (!type || SUPPORTED_MESSAGE_TYPES.has(type)) return null;
  return UNSUPPORTED_LABELS[type] || `「${type}」`;
}

/**
 * Delete downloaded images older than `maxAgeDays`. Returns how many files
 * were removed; a missing directory is normal, not an error.
 */
export function pruneImages(cfg, maxAgeDays = 7) {
  const days = Number(maxAgeDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const dir = join(cfg.workdir, IMAGE_DIR);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = statSync(path);
      if (info.isFile() && info.mtimeMs < cutoff) {
        unlinkSync(path);
        removed += 1;
      }
    } catch { /* a file removed by someone else is not an error */ }
  }
  return removed;
}

/**
 * Image keys referenced by a flattened message, in order, duplicates removed.
 *
 * `messageType` decides the fallback: an `image`-type message carries no
 * Markdown at all, only `[Image: img_v3_...]`, so a bare key scan is the only
 * way to find it.
 */
export function extractImageKeys(text, messageType = '') {
  const raw = String(text || '');
  const keys = [];
  const push = (key) => {
    if (key && !keys.includes(key) && keys.length < MAX_IMAGES) keys.push(key);
  };
  const re = new RegExp(IMAGE_MARKDOWN.source, 'g');
  let match;
  while ((match = re.exec(raw)) !== null) push(match[1]);
  if (keys.length === 0 && (messageType === 'image' || messageType === 'post')) {
    for (const key of raw.match(/img_v3_[A-Za-z0-9_-]+/g) || []) push(key);
  }
  return keys;
}

/** Turn a lark-cli `saved_path` into a path the agent resolves from its cwd. */
export function relativeToWorkdir(savedPath, workdir) {
  const path = String(savedPath || '').trim();
  if (!path) return '';
  const base = String(workdir || '').replace(/\/+$/, '');
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path;
}

/**
 * Rewrite the task so the agent reads the images first.
 *
 * The image Markdown is removed (it means nothing to the model), and each
 * downloaded path is stated explicitly. A failed download stays visible to the
 * model instead of being silently dropped, so it can tell the user the truth.
 */
export function buildImagePrompt(text, saved) {
  const stripped = String(text || '').replace(new RegExp(IMAGE_PLACEHOLDER.source, 'g'), '').replace(/[ \t]+\n/g, '\n').trim();
  const lines = (saved || []).map((item, index) => (
    item.ok
      ? `- 第 ${index + 1} 张：${item.path}（先用 read_image 工具查看）`
      : `- 第 ${index + 1} 张：下载失败（${item.error || '未知原因'}），请在回答里如实说明`
  ));
  const note = [
    '（用户随消息发来了图片。桥已把图片保存到本机，回答前先用 read_image 工具真的看图，不要猜内容。）',
    ...lines,
  ].join('\n');
  return stripped ? `${note}\n\n${stripped}` : note;
}

/**
 * Download every image of a message into `<workdir>/.feishu-images/`.
 * Returns `[{ key, ok, path | error }]` — one entry per key, never throws.
 */
export async function downloadMessageImages(cfg, messageId, keys) {
  try {
    mkdirSync(join(cfg.workdir, IMAGE_DIR), { recursive: true });
  } catch { /* the download below reports a real error if the dir is unusable */ }
  const saved = [];
  for (let index = 0; index < (keys || []).length; index += 1) {
    const key = keys[index];
    const output = `${IMAGE_DIR}/${messageId}-${index + 1}`;
    const result = await run(cfg, [
      'im', '+messages-resources-download',
      '--message-id', messageId,
      '--file-key', key,
      '--type', 'image',
      '--output', output,
      '--as', 'bot',
    ], { timeoutMs: 60000, cwd: cfg.workdir });

    let savedPath = '';
    let error = '';
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        savedPath = (parsed && parsed.data && parsed.data.saved_path) || '';
        if (!savedPath) error = 'no-saved-path';
      } catch {
        error = 'unparsable-output';
      }
    } else {
      error = (result.stderr || result.stdout || '').trim().slice(0, 300) || `exit ${result.code}`;
    }

    const path = relativeToWorkdir(savedPath, cfg.workdir);
    saved.push(path ? { key, ok: true, path } : { key, ok: false, error: error || 'download-failed' });
  }
  return saved;
}
