/**
 * Client half of the feishu-ref bundle.
 *
 * Registers one compact button in `conversation.input.left` (the composer tool
 * row). Clicking it opens a small popover: search your Feishu docs / bitables,
 * pick one, and the Markdown link is inserted into the draft through
 * `inputActions.insertText()` — an ordinary undoable text edit, never a send.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-feishu-ref',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = '@lyra_wang/dsh-feishu-ref';
    const ROOT = 'dsh-feishu-ref';

    const CSS = `
      .${ROOT}-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
        height:26px;padding:0 8px;border-radius:7px;color:var(--dsw-alias-label-secondary,#b9b9c0);
        font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
      .${ROOT}-btn:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-btn[data-open="true"]{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-panel{position:fixed;z-index:2147483000;width:420px;max-height:420px;display:flex;flex-direction:column;
        background:var(--dsw-alias-bg-overlay,#2b2b2f);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.45);overflow:hidden;
        font:12px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-search{all:unset;box-sizing:border-box;margin:8px;padding:8px 10px;border-radius:8px;
        background:var(--dsw-alias-bg-layer-1,#1f1f23);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        color:var(--dsw-alias-label-primary,#e6e6e9);font:12px/1.4 -apple-system,"PingFang SC",sans-serif}
      .${ROOT}-list{overflow:auto;padding:0 6px 6px}
      .${ROOT}-item{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:8px;cursor:pointer}
      .${ROOT}-item:hover,.${ROOT}-item[data-active="true"]{background:var(--dsw-alias-bg-layer-2,#3a3a41)}
      .${ROOT}-title{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .${ROOT}-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#9a9aa2);display:flex;gap:8px}
      .${ROOT}-hint{padding:10px 12px;color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:11.5px}
      .${ROOT}-err{color:#ff7a7a}
      .${ROOT}-badge{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1,#3a3a40)}
    `;

    const TYPE_LABEL = {
      bitable: '多维表格',
      docx: '文档',
      doc: '文档',
      wiki: '知识库',
      sheet: '表格',
      slides: '幻灯片',
    };

    function shortTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const now = Date.now();
      const diff = now - date.getTime();
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
      if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
      if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
      return date.toISOString().slice(0, 10);
    }

    function FeishuRef(props) {
      const inputActions = props && props.inputActions;
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [active, setActive] = useState(0);
      const [anchor, setAnchor] = useState(null);
      const btnRef = useRef(null);
      const inputRef = useRef(null);
      const panelRef = useRef(null);

      const search = async (q) => {
        setLoading(true);
        setError('');
        try {
          const response = await fetch('/plugins/feishu-ref/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.message || ('HTTP ' + response.status));
          }
          setItems(payload.items || []);
          setActive(0);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setItems([]);
        } finally {
          setLoading(false);
        }
      };

      const openPanel = () => {
        const rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
        if (rect) {
          setAnchor({
            left: Math.max(12, rect.left),
            bottom: Math.max(12, window.innerHeight - rect.top + 8),
          });
        }
        setOpen(true);
        setQuery('');
        search('');
      };

      const close = () => {
        setOpen(false);
        setError('');
      };

      useEffect(() => {
        if (!open) return undefined;
        const timer = setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
        const onDown = (event) => {
          const inPanel = panelRef.current && panelRef.current.contains(event.target);
          const inButton = btnRef.current && btnRef.current.contains(event.target);
          if (!inPanel && !inButton) close();
        };
        document.addEventListener('mousedown', onDown, true);
        return () => {
          clearTimeout(timer);
          document.removeEventListener('mousedown', onDown, true);
        };
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const timer = setTimeout(() => search(query), 250);
        return () => clearTimeout(timer);
      }, [query, open]);

      const choose = (item) => {
        const text = '[' + item.title + '](' + item.url + ') ';
        try {
          if (inputActions && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
            const span = inputActions.captureInsertion();
            inputActions.insertText(text, span);
          } else if (navigator.clipboard) {
            navigator.clipboard.writeText(text);
          }
        } catch (err) {
          if (navigator.clipboard) navigator.clipboard.writeText(text);
        }
        close();
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => Math.max(index - 1, 0));
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const item = items[active];
          if (item) choose(item);
        }
      };

      const button = h('button', {
        key: 'btn',
        ref: btnRef,
        type: 'button',
        className: ROOT + '-btn',
        'data-open': open ? 'true' : 'false',
        title: '搜索并插入飞书文档链接',
        onClick: () => (open ? close() : openPanel()),
      }, h('span', null, '＋'), h('span', null, '引用'));

      const panel = open && anchor
        ? h('div', {
          key: 'panel',
          ref: panelRef,
          className: ROOT + '-panel',
          style: { left: anchor.left + 'px', bottom: anchor.bottom + 'px' },
          onKeyDown,
        }, [
          h('input', {
            key: 'q',
            ref: inputRef,
            className: ROOT + '-search',
            placeholder: '搜索飞书文档 / 多维表格…（留空看最近编辑）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          error !== ''
            ? h('div', { key: 'err', className: ROOT + '-hint ' + ROOT + '-err' }, '搜索失败：' + error)
            : null,
          loading
            ? h('div', { key: 'loading', className: ROOT + '-hint' }, '搜索中…')
            : null,
          h('div', { key: 'list', className: ROOT + '-list' }, items.map((item, index) => h('div', {
            key: item.url,
            className: ROOT + '-item',
            'data-active': index === active ? 'true' : 'false',
            onMouseEnter: () => setActive(index),
            onMouseDown: (event) => {
              event.preventDefault();
              choose(item);
            },
          }, [
            h('div', { key: 't', className: ROOT + '-title' }, item.title),
            h('div', { key: 'm', className: ROOT + '-meta' }, [
              h('span', { key: 'type', className: ROOT + '-badge' }, TYPE_LABEL[item.type] || item.type || '文档'),
              h('span', { key: 'time' }, shortTime(item.editedAt)),
            ]),
          ]))),
          items.length === 0 && !loading && error === ''
            ? h('div', { key: 'empty', className: ROOT + '-hint' }, '没有找到文档，换个关键词试试')
            : null,
        ])
        : null;

      return h(React.Fragment, null, h('style', { key: 'style' }, CSS), button, panel);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'feishu-ref',
          order: 2,
        }, (props) => h(FeishuRef, props)));
      },
    };
  },
});
