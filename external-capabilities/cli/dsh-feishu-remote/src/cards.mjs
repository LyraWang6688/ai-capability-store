/**
 * Reply cards (Feishu Card 2.0).
 *
 * Every message the bridge sends back is a card, so the chat reads as a
 * timeline of task results instead of loose text. Pure builders only — the
 * sending side lives in `feishu.mjs`.
 */

const PRESETS = {
  ack: {
    title: '任务执行中',
    template: 'blue',
    icon: { tag: 'standard_icon', token: 'time_outlined', color: 'blue' },
  },
  done: {
    title: '任务完成',
    template: 'green',
    icon: { tag: 'standard_icon', token: 'done_outlined', color: 'green' },
  },
  error: {
    title: '任务失败',
    template: 'red',
    icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'red' },
  },
  confirm: {
    title: '需要确认',
    template: 'orange',
    icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'orange' },
  },
  help: {
    title: '使用说明',
    template: 'blue',
    icon: { tag: 'standard_icon', token: 'info_outlined', color: 'blue' },
  },
  status: {
    title: '服务状态',
    template: 'blue',
    icon: { tag: 'standard_icon', token: 'info_outlined', color: 'blue' },
  },
};

export const REPLY_KINDS = Object.keys(PRESETS);

/**
 * Build a Card 2.0 reply.
 *
 * `kind` picks header colour + icon; `text` is the agent's answer (markdown);
 * `meta` is a grey one-liner (task id / duration / exit code).
 */
export function buildReplyCard({ kind = 'done', title, text, meta, maxChars = 3500 } = {}) {
  const preset = PRESETS[kind] || PRESETS.done;
  const limit = Math.max(1, Number(maxChars) || 3500);
  const content = String(text ?? '').trim().slice(0, limit) || '（无内容）';
  const elements = [
    { tag: 'markdown', content, margin: meta ? '0px 0px 8px 0px' : '0px' },
  ];
  if (meta) {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${String(meta).slice(0, 300)}</font>`,
      margin: '0px',
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: { tag: 'plain_text', content: String(title || preset.title).slice(0, 80) },
      template: preset.template,
      icon: preset.icon,
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements,
    },
  };
}
