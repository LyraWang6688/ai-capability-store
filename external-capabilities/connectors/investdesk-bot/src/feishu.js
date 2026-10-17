import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';

const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret });

/** 发送纯文本消息；超长自动分条 */
export async function sendText(chatId, text) {
  const limit = 4000;
  const chunks = [];
  let rest = text;
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
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      },
    });
  }
}

export { Lark };
