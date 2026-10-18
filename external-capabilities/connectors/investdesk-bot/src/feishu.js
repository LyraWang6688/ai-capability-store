import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';

const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret });

/**
 * 构造 Card 2.0 卡片。
 *
 * 结构依据：lark-im skill 的 references/card/card-2.0-schema.md
 *   - schema 必须为 "2.0"，否则按 1.0 渲染（1.0 不支持 body/elements 结构）
 *   - header：plain_text 标题 + 副标题 + template
 *   - body.elements：markdown 组件承载正文（2.0 的 markdown 支持表格，≤5 行）
 *
 * 正文按空行切段，每段一个 markdown 元素，段间距交给 body.vertical_spacing，
 * 不逐段插 hr（官方样式规范 P2：避免「一路 hr 平铺」）。
 */
function buildCard(markdown, options = {}) {
  const paragraphs = markdown
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: { tag: 'plain_text', content: options.title ?? '📊 投资助手' },
      ...(options.subtitle
        ? { subtitle: { tag: 'plain_text', content: options.subtitle } }
        : {}),
      template: options.template ?? 'blue',
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'medium',
      elements: paragraphs.map((content) => ({ tag: 'markdown', content })),
    },
  };
}

/** 数据时点副标题：场内当日收盘、场外 T 日净值 */
function subtitleFor() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${date} · 数据来自飞书多维表格`;
}

/** 用 Card 2.0 卡片发送 Markdown */
export async function sendMarkdown(chatId, markdown, options = {}, attempt = 0) {
  const content = String(markdown).trim();
  const limit = 7000;
  const chunks = [];
  let rest = content;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit) > 0 ? rest.lastIndexOf('\n', limit) : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);

  for (const chunk of chunks) {
    const card = buildCard(chunk, { ...options, subtitle: options.subtitle ?? subtitleFor() });
    try {
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    } catch (error) {
      // 2.0 发送失败时降级为纯文本，保证用户至少能看到内容
      console.error('[card] 卡片发送失败，降级为文本:', error.message);
      if (attempt === 0) {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk.replace(/\*\*/g, '') }),
          },
        });
        continue;
      }
      throw error;
    }
  }
}

export { Lark, buildCard };
