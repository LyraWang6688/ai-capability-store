import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';

const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret });

/**
 * 把 Markdown 表格压平成列表。
 * 飞书卡片的 markdown 元素不渲染表格，直接发出来是一串竖线。
 */
function flattenTables(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isRow = line.trim().startsWith('|') && line.trim().endsWith('|');
    if (!isRow) {
      out.push(line);
      i += 1;
      continue;
    }

    // 收集连续表格行
    const block = [];
    while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
      block.push(lines[i].trim());
      i += 1;
    }
    const cells = block
      .map((row) => row.slice(1, -1).split('|').map((cell) => cell.trim()))
      .filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));

    if (cells.length === 0) continue;
    const [header, ...rows] = cells;
    for (const row of rows) {
      const parts = row
        .map((cell, index) => {
          const label = header[index] ?? '';
          if (!cell || cell === '-') return null;
          // 第一列通常是代码/名称，直接展示；其余列带上表头
          return index === 0 ? cell : `${label} ${cell}`;
        })
        .filter(Boolean);
      out.push(`· ${parts.join('　')}`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 用卡片消息发送 Markdown（卡片会渲染加粗与列表） */
export async function sendMarkdown(chatId, markdown) {
  const content = flattenTables(markdown).trim();
  const limit = 2800;
  const chunks = [];
  let rest = content;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit) > 0 ? rest.lastIndexOf('\n', limit) : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);

  for (const chunk of chunks) {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: 'markdown', content: chunk }],
        }),
      },
    });
  }
}

export { Lark };
