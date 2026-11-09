/**
 * Client half of the screenshot bundle.
 *
 * One compact button in `conversation.input.left`, plus one real DSH shortcut:
 * press ⌥S (macOS Desktop) anywhere in the DSH window and the Host opens the
 * system capture UI (crosshair, Space toggles window picking); the finished PNG
 * is pushed into the draft as an ordinary image attachment.
 *
 * The shortcut is a registered command, not a DOM keydown listener. The Client
 * plugin API exposes `ctx.shortcuts`, so the command appears in Settings →
 * 快捷键, the user can rebind it, it participates in conflict checks, and on
 * Desktop the native keyboard bridge dispatches it before local handlers —
 * which is also why Option+S never types "ß" into the composer.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-screenshot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const ROOT = 'dsh-screenshot';
    const CAPTURE_PATH = '/plugins/screenshot/capture';
    const SHORTCUT_ID = 'screenshot.capture';

    /** One capture at a time; the button and the shortcut share this flag. */
    let captureInFlight = false;
    /**
     * The mounted button owns the busy/toast surface. Off the conversation page
     * the shortcut still runs (the system crosshair is its own feedback), so
     * these stay no-ops until the button subscribes.
     */
    let surface = { busy: () => {}, toast: () => {} };

    const CSS = `
      .${ROOT}-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
        height:26px;padding:0 8px;border-radius:7px;color:var(--dsw-alias-label-secondary,#b9b9c0);
        font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
      .${ROOT}-btn:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-btn[data-busy="true"]{opacity:.6;cursor:progress}
      .${ROOT}-key{font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.55}
      .${ROOT}-toast{position:fixed;z-index:2147483000;left:50%;transform:translateX(-50%);bottom:86px;
        padding:8px 14px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#2b2b2f);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);box-shadow:0 10px 30px rgba(0,0,0,.4);
        font:12px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        color:var(--dsw-alias-label-primary,#e6e6e9);pointer-events:none;white-space:nowrap}
      .${ROOT}-toast[data-error="true"]{color:#ff8a8a}
    `;

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

    /** Ask the Host for one capture and deliver it into the draft. */
    async function capture() {
      if (captureInFlight) return;
      captureInFlight = true;
      surface.busy(true);
      surface.toast('框选要截的区域（空格可切窗口，Esc 取消）');
      try {
        const scope = document.body;
        const response = await fetch(CAPTURE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'region' }),
        });
        if (response.status === 204) {
          surface.toast('已取消截图');
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
        surface.toast(via === 'paste' ? '截图已加入草稿' : '截图已加入草稿（文件选择通道）');
      } catch (error) {
        surface.toast(error instanceof Error ? error.message : String(error), true);
      } finally {
        captureInFlight = false;
        surface.busy(false);
      }
    }

    function ScreenshotButton(props) {
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState(null);
      const [keys, setKeys] = useState([]);
      const toastTimer = useRef(0);

      const showToast = useCallback((text, isError) => {
        setToast({ text, isError: isError === true });
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), isError ? 5200 : 2200);
      }, []);

      // Off the conversation page this component is unmounted, so the shortcut
      // must not depend on it: subscribe its state, then fall back to no-ops.
      useEffect(() => {
        surface = { busy: setBusy, toast: showToast };
        return () => {
          surface = { busy: () => {}, toast: () => {} };
          window.clearTimeout(toastTimer.current);
        };
      }, [showToast]);

      // Show the binding that is actually active (the user may rebind it in
      // Settings → 快捷键); an unbound command shows no keycap.
      useEffect(() => {
        const catalog = props.shortcutService && props.shortcutService.catalog;
        if (!catalog || typeof catalog.getSnapshot !== 'function') return undefined;
        const read = () => {
          const row = catalog.getSnapshot().find((item) => item.id === SHORTCUT_ID);
          setKeys(row && Array.isArray(row.keys) ? row.keys : []);
        };
        read();
        const off = catalog.subscribe(read);
        return () => {
          if (typeof off === 'function') off();
        };
      }, [props.shortcutService]);

      const button = h('button', {
        key: 'btn',
        type: 'button',
        className: ROOT + '-btn',
        'data-busy': busy ? 'true' : 'false',
        title: '截图并放入输入框（默认 ⌥S，可在 设置 → 快捷键 修改；框选区域，空格切换窗口）',
        onClick: () => { void capture(); },
      }, h('span', null, '＋'), h('span', null, busy ? '截图中…' : '截图'),
      keys.length > 0 ? h('span', { className: ROOT + '-key' }, keys.join('')) : null);

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
      inject: ['slots', 'shortcuts'],
      apply(ctx) {
        // A registered command, not a DOM listener: conflict-checked, listed in
        // Settings → 快捷键, rebindable, and dispatched natively on Desktop.
        ctx.effect(() => ctx.shortcuts.register({
          id: SHORTCUT_ID,
          label: () => '截图并放入输入框',
          aliases: ['截图', 'screenshot', 'capture screen'],
          defaults: {
            'desktop:macos': { code: 'KeyS', modifiers: ['alt'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => (captureInFlight
            ? { status: 'blocked', reason: '已有一次截图正在进行' }
            : { status: 'handled', run: () => { void capture(); } }),
        }), 'screenshot: shortcut');

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'screenshot',
          order: 4,
        }, (props) => h(ScreenshotButton, { ...props, shortcutService: ctx.shortcuts })));
      },
    };
  },
});
