/**
 * Client half of the screenshot bundle.
 *
 * One compact button in `conversation.input.left`: press it, the Host opens the
 * system capture UI (crosshair, Space toggles window picking), and the finished
 * PNG is pushed into the draft as an ordinary image attachment.
 *
 * Why a synthetic paste instead of a direct upload call: the composer owns the
 * draft-attachment registry (client-generated ids + upload progress), so the
 * only supported way for a plugin to add an image exactly like a user paste is
 * to hand the same `File` to that intake path. `ClipboardEvent` carries a
 * `DataTransfer`, so the composer's own paste handler does the rest.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-screenshot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const ROOT = 'dsh-screenshot';
    const CAPTURE_PATH = '/plugins/screenshot/capture';

    const CSS = `
      .${ROOT}-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
        height:26px;padding:0 8px;border-radius:7px;color:var(--dsw-alias-label-secondary,#b9b9c0);
        font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
      .${ROOT}-btn:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-btn[data-busy="true"]{opacity:.6;cursor:progress}
      .${ROOT}-toast{position:fixed;z-index:2147483000;left:50%;transform:translateX(-50%);bottom:86px;
        padding:8px 14px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#2b2b2f);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);box-shadow:0 10px 30px rgba(0,0,0,.4);
        font:12px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        color:var(--dsw-alias-label-primary,#e6e6e9);pointer-events:none;white-space:nowrap}
      .${ROOT}-toast[data-error="true"]{color:#ff8a8a}
    `;

    /** Walk up from the button until an ancestor contains the draft editor. */
    function findComposerScope(node) {
      let current = node;
      while (current && current !== document.body) {
        if (current.querySelector && current.querySelector('[contenteditable="true"], input[type="file"]')) {
          return current;
        }
        current = current.parentElement;
      }
      return document.body;
    }

    function findEditor(scope) {
      const active = document.activeElement;
      if (active && active.matches && active.matches('[contenteditable="true"]')) return active;
      return scope.querySelector('[contenteditable="true"]')
        || document.querySelector('[contenteditable="true"]');
    }

    function findFileInput(scope) {
      return scope.querySelector('input[type="file"]')
        || document.querySelector('input[type="file"]');
    }

    /**
     * Hand one image File to the composer the way a user paste would.
     * @returns which intake path accepted the file.
     */
    function deliverImage(scope, file) {
      const editor = findEditor(scope);
      if (editor) {
        editor.focus({ preventScroll: true });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const event = new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        });
        editor.dispatchEvent(event);
        return 'paste';
      }
      const input = findFileInput(scope);
      if (input) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        input.files = dataTransfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'input';
      }
      throw new Error('找不到输入框，无法放入截图');
    }

    function ScreenshotButton(props) {
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState(null);
      const btnRef = useRef(null);
      const toastTimer = useRef(0);

      const showToast = useCallback((text, isError) => {
        setToast({ text, isError: isError === true });
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), isError ? 5200 : 2200);
      }, []);

      useEffect(() => () => window.clearTimeout(toastTimer.current), []);

      const capture = useCallback(async () => {
        if (busy) return;
        const scope = findComposerScope(btnRef.current);
        setBusy(true);
        showToast('框选要截的区域（空格可切窗口，Esc 取消）');
        try {
          const response = await fetch(CAPTURE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'region' }),
          });
          if (response.status === 204) {
            showToast('已取消截图');
            return;
          }
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || ('HTTP ' + response.status));
          }
          const blob = await response.blob();
          if (blob.size === 0) throw new Error('截图内容为空');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = new File([blob], 'screenshot-' + stamp + '.png', { type: 'image/png' });
          const via = deliverImage(scope, file);
          showToast(via === 'paste' ? '截图已加入草稿' : '截图已加入草稿（文件选择通道）');
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error), true);
        } finally {
          setBusy(false);
        }
      }, [busy, showToast]);

      const button = h('button', {
        key: 'btn',
        ref: btnRef,
        type: 'button',
        className: ROOT + '-btn',
        'data-busy': busy ? 'true' : 'false',
        title: '截图并放入输入框（框选区域，空格切换窗口）',
        onClick: capture,
      }, h('span', null, '＋'), h('span', null, busy ? '截图中…' : '截图'));

      const toastNode = toast
        ? h('div', {
          key: 'toast',
          className: ROOT + '-toast',
          'data-error': toast.isError ? 'true' : 'false',
        }, toast.text)
        : null;

      return h(React.Fragment, null, h('style', { key: 'style' }, CSS), button, toastNode);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'screenshot',
          order: 4,
        }, (props) => h(ScreenshotButton, props)));
      },
    };
  },
});
