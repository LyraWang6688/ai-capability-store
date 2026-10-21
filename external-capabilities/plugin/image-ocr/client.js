/**
 * Client half of the image-ocr bundle.
 *
 * One compact button in `conversation.input.left` opens a small panel: paste a
 * screenshot into it (⌘V), the host OCRs the image locally and the recognized
 * text appears inside the panel. From there the text can be inserted into the
 * composer or copied.
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
      .${ROOT}-btn:hover,.${ROOT}-btn[data-open="true"]{background:var(--dsw-alias-bg-layer-2,#3a3a41);
        color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-panel{position:fixed;z-index:2147483000;width:460px;display:flex;flex-direction:column;gap:8px;
        background:var(--dsw-alias-bg-overlay,#2b2b2f);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.45);padding:10px;
        font:12px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-title{display:flex;justify-content:space-between;align-items:center;font-size:12px;
        color:var(--dsw-alias-label-secondary,#9a9aa2)}
      .${ROOT}-close{all:unset;cursor:pointer;color:var(--dsw-alias-label-secondary,#9a9aa2);padding:2px 6px;border-radius:6px}
      .${ROOT}-close:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-drop{min-height:96px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
        border:1px dashed var(--dsw-alias-border-l1,#4a4a52);border-radius:10px;padding:12px;cursor:text;
        color:var(--dsw-alias-label-secondary,#9a9aa2);text-align:center;outline:none}
      .${ROOT}-drop[data-over="true"]{border-color:#4c8dff;background:rgba(76,141,255,.08)}
      .${ROOT}-drop img{max-width:100%;max-height:120px;border-radius:6px}
      .${ROOT}-textarea{all:unset;box-sizing:border-box;width:100%;min-height:120px;max-height:260px;overflow:auto;
        padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1f1f23);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);color:var(--dsw-alias-label-primary,#e6e6e9);
        font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;user-select:text}
      .${ROOT}-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
      .${ROOT}-action{all:unset;cursor:pointer;padding:5px 10px;border-radius:7px;
        background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9);font-size:12px}
      .${ROOT}-action:hover{background:var(--dsw-alias-bg-layer-3,#46464f)}
      .${ROOT}-action[data-primary="true"]{background:#3b6fe0}
      .${ROOT}-action[disabled]{opacity:.5;cursor:not-allowed}
      .${ROOT}-hint{color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:11.5px}
      .${ROOT}-error{color:#ff8a8a;font-size:11.5px}
    `;

    function readImageFromDataTransfer(dataTransfer) {
      if (!dataTransfer) return null;
      const items = Array.from(dataTransfer.items || []);
      for (const item of items) {
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          return item.getAsFile();
        }
      }
      const files = Array.from(dataTransfer.files || []);
      return files.find((file) => file.type && file.type.startsWith('image/')) || null;
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
    }

    function ImageOcr(props) {
      const inputActions = props && props.inputActions;
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const [preview, setPreview] = useState('');
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [over, setOver] = useState(false);
      const btnRef = useRef(null);
      const panelRef = useRef(null);
      const dropRef = useRef(null);

      const openPanel = () => {
        const rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
        if (rect) setAnchor({ left: Math.max(12, rect.left), bottom: Math.max(12, window.innerHeight - rect.top + 8) });
        setOpen(true);
        setError('');
        setTimeout(() => dropRef.current && dropRef.current.focus(), 30);
      };
      const close = () => { setOpen(false); setPreview(''); setText(''); setError(''); };

      const ocr = async (imageOverride) => {
        setBusy(true);
        setError('');
        setText('');
        try {
          const payloadBody = {};
          if (imageOverride) payloadBody.image = imageOverride;
          const response = await fetch('/plugins/image-ocr/ocr', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payloadBody),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status));
          const value = String(payload.text || '');
          if (value.trim() === '') {
            setError('没有识别到文字（图片清晰度或语言可能不支持）');
          } else {
            setText(value);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      const handleFile = async (file) => {
        if (!file) return;
        if (!file.type || !file.type.startsWith('image/')) {
          setError('请粘贴图片（PNG / JPEG）');
          return;
        }
        try {
          const dataUrl = await fileToDataUrl(file);
          setPreview(dataUrl);
          await ocr(dataUrl);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      };

      const onPaste = (event) => {
        const file = readImageFromDataTransfer(event.clipboardData);
        if (!file) {
          setError('剪贴板里没有图片：先截图（⌃⌘⇧4），再在这里 ⌘V');
          return;
        }
        event.preventDefault();
        handleFile(file);
      };

      const onDrop = (event) => {
        event.preventDefault();
        setOver(false);
        const file = readImageFromDataTransfer(event.dataTransfer);
        if (file) handleFile(file);
      };

      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const inPanel = panelRef.current && panelRef.current.contains(event.target);
          const inButton = btnRef.current && btnRef.current.contains(event.target);
          if (!inPanel && !inButton) close();
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [open]);

      const insert = () => {
        if (text.trim() === '') return;
        if (inputActions && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
          const span = inputActions.captureInsertion();
          inputActions.insertText(text, span);
          close();
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(text);
          close();
        }
      };

      const copy = () => {
        if (text === '') return;
        if (navigator.clipboard) navigator.clipboard.writeText(text);
      };

      const button = h('button', {
        key: 'btn',
        ref: btnRef,
        type: 'button',
        className: ROOT + '-btn',
        'data-open': open ? 'true' : 'false',
        title: '粘贴截图并识别文字',
        onClick: () => (open ? close() : openPanel()),
      }, h('span', null, '＋'), h('span', null, '识图'));

      const panel = open && anchor
        ? h('div', {
          key: 'panel',
          ref: panelRef,
          className: ROOT + '-panel',
          style: { left: anchor.left + 'px', bottom: anchor.bottom + 'px' },
        }, [
          h('div', { key: 'title', className: ROOT + '-title' }, [
            h('span', { key: 'label' }, '粘贴截图识别文字'),
            h('button', { key: 'x', type: 'button', className: ROOT + '-close', onClick: close }, '✕'),
          ]),
          preview === ''
            ? h('div', {
              key: 'drop',
              ref: dropRef,
              className: ROOT + '-drop',
              tabIndex: 0,
              'data-over': over ? 'true' : 'false',
              onPaste,
              onDrop,
              onDragOver: (event) => { event.preventDefault(); setOver(true); },
              onDragLeave: () => setOver(false),
            }, [
              h('div', { key: 'a' }, '点这里，然后按 ⌘V 粘贴截图'),
              h('div', { key: 'b', className: ROOT + '-hint' }, '也可以把图片文件拖进来'),
            ])
            : h('div', {
              key: 'drop2',
              ref: dropRef,
              className: ROOT + '-drop',
              tabIndex: 0,
              onPaste,
              onDrop,
              onDragOver: (event) => { event.preventDefault(); setOver(true); },
              onDragLeave: () => setOver(false),
            }, [
              h('img', { key: 'img', src: preview, alt: '粘贴的截图' }),
              h('button', {
                key: 'again',
                type: 'button',
                className: ROOT + '-action',
                onClick: () => { setPreview(''); setText(''); setError(''); setTimeout(() => dropRef.current && dropRef.current.focus(), 20); },
              }, '换一张'),
            ]),
          busy ? h('div', { key: 'busy', className: ROOT + '-hint' }, '识别中…（第一次可能需要 30–60 秒编译引擎）') : null,
          error !== '' ? h('div', { key: 'err', className: ROOT + '-error' }, error) : null,
          text !== '' || busy
            ? h('div', { key: 'out', className: ROOT + '-textarea' }, text)
            : null,
          h('div', { key: 'row', className: ROOT + '-row' }, [
            h('button', {
              key: 'insert',
              type: 'button',
              className: ROOT + '-action',
              'data-primary': 'true',
              disabled: text.trim() === '',
              onClick: insert,
            }, '插入输入框'),
            h('button', { key: 'copy', type: 'button', className: ROOT + '-action', disabled: text === '', onClick: copy }, '复制'),
            h('button', {
              key: 'clip',
              type: 'button',
              className: ROOT + '-action',
              onClick: () => { setPreview(''); ocr(); },
            }, '直接读剪贴板'),
          ]),
        ])
        : null;

      return h(React.Fragment, null, h('style', { key: 'style' }, CSS), button, panel);
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
