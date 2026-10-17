import { config, ensureDataDir } from './config.js';
import { Lark, sendText } from './feishu.js';
import { chat } from './llm.js';
import { getHistory, appendHistory } from './session.js';
import { callTool as callIdeaTool } from 'investdesk-ideas/dist/mcp/tools.js';

ensureDataDir();

const seen = new Set();
function alreadyHandled(messageId) {
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  if (seen.size > 500) {
    const first = seen.values().next().value;
    seen.delete(first);
  }
  return false;
}

function extractText(message) {
  if (message.message_type !== 'text') return null;
  try {
    return JSON.parse(message.content ?? '{}').text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function handle(chatId, text, messageId) {
  try {
    const history = getHistory(chatId);
    const started = Date.now();
    const { text: answer } = await chat(history, text);
    await sendText(chatId, answer);
    console.log(`[done] ${Date.now() - started}ms reply=${answer.length}字`);
    callIdeaTool('save_idea', { question: text, answer, type: '问答' })
      .then((result) => {
        const text = result?.content?.[0]?.text ?? '未知结果';
        console.log(`[idea] ${result?.isError ? '写入失败: ' : ''}${text}`);
      })
      .catch((error) => console.error('[idea] 写入失败:', error.message));
    appendHistory(chatId, [
      { role: 'user', content: text },
      { role: 'assistant', content: answer },
    ]);
  } catch (error) {
    console.error('[bot] 处理失败:', error);
    await sendText(chatId, `出错了：${error.message}`).catch(() => {});
  }
}

const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const message = data.message;
    const chatId = message?.chat_id;
    const messageId = message?.message_id;
    if (!chatId || !messageId) return;
    if (alreadyHandled(messageId)) return;

    const text = extractText(message);
    console.log(`[recv] chat=${chatId.slice(0,12)}… text=${(text ?? '<非文本>').slice(0, 40)}`);
    if (!text) {
      sendText(chatId, '目前只支持文字消息。').catch(() => {});
      return;
    }
    // 立刻返回，异步处理（飞书要求 3 秒内响应，否则会重推）
    handle(chatId, text, messageId);
  },
});

const ws = new Lark.WSClient({ appId: config.appId, appSecret: config.appSecret });
ws.start({ eventDispatcher: dispatcher });

console.log(`[bot] 已启动 app=${config.appId} model=${config.model}`);
