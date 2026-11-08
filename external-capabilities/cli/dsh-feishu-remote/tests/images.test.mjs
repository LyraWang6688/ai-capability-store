import test from 'node:test';
import assert from 'node:assert/strict';


import {
  IMAGE_DIR,
  buildImagePrompt,
  extractImageKeys,
  pruneImages,
  relativeToWorkdir,
  unsupportedMessageLabel,
} from '../src/images.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMG_A = 'img_v3_02174_491bf662-27ee-4596-a42c-4b5e3e965d6g';
const IMG_B = 'img_v3_02174_deadbeef-0000-1111-2222-333344445555';

test('extractImageKeys reads the key out of the flattened Markdown', () => {
  assert.deepEqual(extractImageKeys(`![Image](${IMG_A})\n这个是做什么的`), [IMG_A]);
});

test('extractImageKeys returns every image of a post, without duplicates', () => {
  const text = `![Image](${IMG_A})\n![Image](${IMG_B})\n![Image](${IMG_A})\n对比一下`;
  assert.deepEqual(extractImageKeys(text), [IMG_A, IMG_B]);
});

test('extractImageKeys ignores ordinary Markdown links and plain text', () => {
  assert.deepEqual(extractImageKeys('看这个 https://example.com/a.png 和 [文档](https://x/y)'), []);
  assert.deepEqual(extractImageKeys(''), []);
  assert.deepEqual(extractImageKeys(undefined), []);
});

test('extractImageKeys finds the bare key of an `image`-type message', () => {
  const text = `[Image: ${IMG_A}]`;
  assert.deepEqual(extractImageKeys(text, 'image'), [IMG_A]);
  // Without the message type the bare-key fallback stays off: a text message
  // that merely mentions a key must not trigger a download.
  assert.deepEqual(extractImageKeys(text), []);
});

test('extractImageKeys still prefers Markdown keys when both shapes appear', () => {
  const text = `![Image](${IMG_A})\n[Image: ${IMG_B}]`;
  assert.deepEqual(extractImageKeys(text, 'post'), [IMG_A]);
});

test('extractImageKeys stops at the download cap', () => {
  const text = Array.from({ length: 10 }, (_, i) => `![Image](img_v3_cap_${i})`).join('\n');
  assert.equal(extractImageKeys(text).length, 6);
});

test('relativeToWorkdir turns an absolute saved path into a cwd-relative one', () => {
  assert.equal(relativeToWorkdir('/srv/dsh-jobs/work/.feishu-images/om_1-1.png', '/srv/dsh-jobs/work'), `${IMAGE_DIR}/om_1-1.png`);
  assert.equal(relativeToWorkdir('/tmp/a.png', '/srv/dsh-jobs/work'), '/tmp/a.png');
  assert.equal(relativeToWorkdir('', '/srv/dsh-jobs/work'), '');
  assert.equal(relativeToWorkdir('/srv/dsh-jobs/work', '/srv/dsh-jobs/work'), '/srv/dsh-jobs/work');
});

test('buildImagePrompt replaces the key with a read_image instruction and keeps the question', () => {
  const prompt = buildImagePrompt(`![Image](${IMG_A})\n这个是做什么的`, [
    { key: IMG_A, ok: true, path: `${IMAGE_DIR}/om_1-1.png` },
  ]);
  assert.match(prompt, /read_image/);
  assert.match(prompt, /\.feishu-images\/om_1-1\.png/);
  assert.match(prompt, /这个是做什么的/);
  assert.doesNotMatch(prompt, /img_v3_02174/);
});

test('buildImagePrompt strips the `[Image: key]` placeholder too', () => {
  const prompt = buildImagePrompt(`[Image: ${IMG_A}]\n这个是什么`, [
    { key: IMG_A, ok: true, path: `${IMAGE_DIR}/om_2-1.png` },
  ]);
  assert.match(prompt, /om_2-1\.png/);
  assert.match(prompt, /这个是什么/);
  assert.doesNotMatch(prompt, /\[Image:/);
});

test('buildImagePrompt keeps a failed download visible to the model', () => {
  const prompt = buildImagePrompt(`![Image](${IMG_A})\n这是什么`, [
    { key: IMG_A, ok: false, error: 'permission denied' },
  ]);
  assert.match(prompt, /下载失败/);
  assert.match(prompt, /permission denied/);
  assert.match(prompt, /这是什么/);
});

test('buildImagePrompt works when the message carried no text at all', () => {
  const prompt = buildImagePrompt(`![Image](${IMG_A})`, [
    { key: IMG_A, ok: true, path: `${IMAGE_DIR}/om_1-1.png` },
  ]);
  assert.match(prompt, /read_image/);
});

test('the listener module still imports cleanly with the image hook wired in', async () => {
  const mod = await import('../src/listener.mjs');
  assert.equal(typeof mod.startListener, 'function');
});

test('unsupportedMessageLabel explains the types the bridge cannot act on', () => {
  assert.equal(unsupportedMessageLabel('text'), null);
  assert.equal(unsupportedMessageLabel('post'), null);
  assert.equal(unsupportedMessageLabel('image'), null);
  assert.equal(unsupportedMessageLabel(''), null);
  assert.equal(unsupportedMessageLabel(undefined), null);
  assert.equal(unsupportedMessageLabel('file'), '文件');
  assert.equal(unsupportedMessageLabel('audio'), '语音');
  assert.equal(unsupportedMessageLabel('media'), '视频');
  assert.equal(unsupportedMessageLabel('sticker'), '表情');
  assert.equal(unsupportedMessageLabel('share_chat'), '群名片');
  assert.equal(unsupportedMessageLabel('interactive'), '卡片');
  assert.equal(unsupportedMessageLabel('brand_new_type'), '「brand_new_type」');
});

test('pruneImages deletes only images older than the retention window', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-img-'));
  const dir = join(workdir, IMAGE_DIR);
  mkdirSync(dir, { recursive: true });
  const oldFile = join(dir, 'old.png');
  const newFile = join(dir, 'new.png');
  writeFileSync(oldFile, 'x');
  writeFileSync(newFile, 'y');
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(oldFile, longAgo, longAgo);

  assert.equal(pruneImages({ workdir }, 7), 1);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(newFile), true);
  assert.equal(pruneImages({ workdir }, 7), 0);
  rmSync(workdir, { recursive: true, force: true });
});

test('pruneImages tolerates a missing directory and a disabled window', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-img-empty-'));
  assert.equal(pruneImages({ workdir }, 7), 0);
  assert.equal(pruneImages({ workdir }, 0), 0);
  assert.equal(pruneImages({ workdir }, -1), 0);
  rmSync(workdir, { recursive: true, force: true });
});
