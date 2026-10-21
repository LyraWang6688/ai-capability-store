/**
 * Client half of the image-ocr bundle.
 *
 * Registers one compact button in `conversation.input.left`: click it, the host
 * OCRs the clipboard image locally (macOS Vision) and the recognized text is
 * inserted into the draft through `inputActions.insertText()`.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-image-ocr',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const ROOT = 'dsh-image-ocr';

    const CSS = `
      .${ROOT}-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
        height:26px;padding:0 8px;border-radius:7px;color:var(--dsw-alias-label-secondary,#b9b9c0);
        font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
      .${ROOT}-btn:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-btn[data-busy="true"]{opacity:.55;cursor:progress}
      .${ROOT}-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483001;
        background:var(--dsw-alias-bg-overlay,#2b2b2f);color:var(--dsw-alias-label-primary,#fff);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);border-radius:8px;padding:7px 14px;
        font:12px/1.4 -apple-system,"PingFang SC",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3)}
      .${ROOT}-toast[data-error="true"]{color:#ff8a8a}
    `;

    function ImageOcr(props) {
      const inputActions = props && props.inputActions;
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState('');
      const [toastError, setToastError] = useState(false);
      const timerRef = useRef(null);

      const say = (text, isError = false) => {
        setToast(text);
        setToastError(isError);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setToast(''), 2600);
      };

      useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      }, []);

      const run = async () => {
        if (busy) return;
        setBusy(true);
        say('识别中…');
        try {
          const response = await fetch('/plugins/image-ocr/ocr', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'clipboard' }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.message || ('HTTP ' + response.status));
          }
          const text = String(payload.text || '').trim();
          if (text === '') {
            say('剪贴板里没有可识别的图片', true);
            return;
          }
          if (inputActions && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
            const span = inputActions.captureInsertion();
            inputActions.insertText(text, span);
            say('已识别 ' + (payload.lines || text.split('\n').length) + ' 行，已插入输入框');
          } else if (navigator.clipboard) {
            navigator.clipboard.writeText(text);
            say('已识别并复制到剪贴板');
          }
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), true);
        } finally {
          setBusy(false);
        }
      };

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('button', {
          key: 'btn',
          type: 'button',
          className: ROOT + '-btn',
          'data-busy': busy ? 'true' : 'false',
          title: '识别剪贴板里的图片文字，插入输入框',
          onClick: run,
        }, h('span', null, '＋'), h('span', null, '识图')),
        toast !== ''
          ? h('div', { key: 'toast', className: ROOT + '-toast', 'data-error': toastError ? 'true' : 'false' }, toast)
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'image-ocr',
          order: 3,
        }, (props) => h(ImageOcr, props)));
      },
    };
  },
});
