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
    const RECENT_KEY = NS + ':recent';
    const RECENT_LIMIT = 3;
    const RECENT_KEEP = 8;

    function loadRecent() {
      try {
        const raw = window.localStorage.getItem(RECENT_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((item) => item && item.url).slice(0, RECENT_KEEP) : [];
      } catch {
        return [];
      }
    }

    function saveRecent(list) {
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_KEEP)));
      } catch {
        /* localStorage 不可用时静默降级：不影响插入 */
      }
    }

    const CSS = `
      .${ROOT}-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
        height:26px;padding:0 8px;border-radius:7px;color:var(--dsw-alias-label-secondary,#b9b9c0);
        font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
      .${ROOT}-btn:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-btn[data-open="true"]{background:var(--dsw-alias-bg-layer-2,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-panel{position:fixed;z-index:2147483000;width:640px;max-width:calc(100vw - 24px);max-height:460px;display:flex;flex-direction:column;
        background:var(--dsw-alias-bg-overlay,#2b2b2f);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.45);overflow:hidden;
        font:12px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-search{all:unset;box-sizing:border-box;margin:8px;padding:8px 10px;border-radius:8px;
        background:var(--dsw-alias-bg-layer-1,#1f1f23);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        color:var(--dsw-alias-label-primary,#e6e6e9);font:12px/1.4 -apple-system,"PingFang SC",sans-serif}
      .${ROOT}-list{overflow:auto;padding:0 6px 6px}
      .${ROOT}-cols{display:flex;flex:1;min-height:0;overflow:hidden}
      .${ROOT}-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0}
      .${ROOT}-col + .${ROOT}-col{border-left:1px solid var(--dsw-alias-border-l1,#3a3a40)}
      .${ROOT}-col-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:6px 10px 3px;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9aa2)}
      .${ROOT}-col-body{flex:1;min-height:0;overflow:auto;padding:0 6px 6px}
      .${ROOT}-col-empty{padding:8px 10px;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9aa2)}
      .${ROOT}-item{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:8px;cursor:pointer}
      .${ROOT}-item:hover,.${ROOT}-item[data-active="true"]{background:var(--dsw-alias-bg-layer-2,#3a3a41)}
      .${ROOT}-title{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .${ROOT}-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#9a9aa2);display:flex;gap:8px;align-items:center}
      .${ROOT}-desc{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .${ROOT}-section{padding:8px 10px 4px;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9aa2)}
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
      chat: '群聊',
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
      const [chats, setChats] = useState([]);
      const [failures, setFailures] = useState([]);
      const [recent, setRecent] = useState([]);
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
          setChats(payload.chats || []);
          setFailures(payload.failures || []);
          setActive(0);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setItems([]);
          setChats([]);
          setFailures([]);
        } finally {
          setLoading(false);
        }
      };

      const openPanel = () => {
        const rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
        if (rect) {
          const panelWidth = Math.min(642, window.innerWidth - 24);
          setAnchor({
            // Clamp to both edges: anchored at the button the panel can run off the
            // right side of a narrow window, which hides the whole chat column.
            left: Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12)),
            bottom: Math.max(12, window.innerHeight - rect.top + 8),
            // The panel is anchored above the button, so its ceiling is the space
            // above the button. Without this a 460px panel in a short window gets
            // clipped at the top, cutting off its own header and first rows.
            maxHeight: Math.max(220, Math.floor(rect.top - 16)),
          });
        }
        setOpen(true);
        setQuery('');
        setRecent(loadRecent());
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
        const next = [item].concat(loadRecent().filter((entry) => entry.url !== item.url)).slice(0, RECENT_KEEP);
        saveRecent(next);
        setRecent(next);
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

      const showRecent = open && query.trim() === '';
      const recentRows = showRecent ? recent.slice(0, RECENT_LIMIT) : [];
      const notRecent = (item) => !recentRows.some((entry) => entry.url === item.url);
      // Two columns, side by side: documents on the left, group chats on the
      // right. The search itself is parallel (host side), so neither column waits
      // for the other; keyboard order follows the visual left-to-right reading
      // order (recent → documents → chats), with ←/→ hopping between columns.
      const docRows = items.filter(notRecent);
      const chatRows = chats.filter(notRecent);
      const docOffset = recentRows.length;
      const chatOffset = recentRows.length + docRows.length;
      const visibleRows = recentRows.concat(docRows, chatRows);

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => Math.min(index + 1, Math.max(visibleRows.length - 1, 0)));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => Math.max(index - 1, 0));
          return;
        }
        if (event.key === 'ArrowRight' && chatRows.length > 0) {
          event.preventDefault();
          setActive(chatOffset);
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setActive(docRows.length > 0 ? docOffset : 0);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const item = visibleRows[active];
          if (item) choose(item);
        }
      };

      const renderItem = (item, index) => h('div', {
        key: 'item-' + item.url,
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
          item.type === 'chat'
            ? h('span', {
              key: 'desc',
              className: ROOT + '-desc',
              title: item.desc || '',
            }, item.desc || (item.external ? '外部群' : ''))
            : h('span', { key: 'time' }, shortTime(item.editedAt)),
        ]),
      ]);

      const column = (key, label, rows, offset, emptyText) => h('div', {
        key: 'col-' + key,
        className: ROOT + '-col',
      }, [
        h('div', { key: 'head', className: ROOT + '-col-head' }, [
          h('span', { key: 'label' }, label),
          rows.length > 0 ? h('span', { key: 'count' }, String(rows.length)) : null,
        ]),
        h('div', { key: 'body', className: ROOT + '-col-body' },
          rows.length > 0
            ? rows.map((item, index) => renderItem(item, offset + index))
            : h('div', { key: 'empty', className: ROOT + '-col-empty' }, emptyText)),
      ]);

      const failureText = failures.length > 0
        ? failures.map((failure) => (failure.kind === 'chats' ? '群聊' : '文档') + '搜索失败：' + failure.message).join('；')
        : '';

      const button = h('button', {
        key: 'btn',
        ref: btnRef,
        type: 'button',
        className: ROOT + '-btn',
        'data-open': open ? 'true' : 'false',
        title: '搜索并插入飞书文档或群聊链接',
        onClick: () => (open ? close() : openPanel()),
      }, h('span', null, '＋'), h('span', null, '引用'));

      const panel = open && anchor
        ? h('div', {
          key: 'panel',
          ref: panelRef,
          className: ROOT + '-panel',
          style: {
            left: anchor.left + 'px',
            bottom: anchor.bottom + 'px',
            maxHeight: anchor.maxHeight ? anchor.maxHeight + 'px' : undefined,
          },
          onKeyDown,
        }, [
          h('input', {
            key: 'q',
            ref: inputRef,
            className: ROOT + '-search',
            placeholder: '搜索飞书文档 / 群聊…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          error !== ''
            ? h('div', { key: 'err', className: ROOT + '-hint ' + ROOT + '-err' }, '搜索失败：' + error)
            : null,
          failureText !== ''
            ? h('div', { key: 'fail', className: ROOT + '-hint ' + ROOT + '-err' }, failureText)
            : null,
          loading
            ? h('div', { key: 'loading', className: ROOT + '-hint' }, '搜索中…')
            : null,
          recentRows.length > 0
            ? h('div', { key: 'recent', className: ROOT + '-list' }, [
              h('div', { key: 'label', className: ROOT + '-section' }, '最近使用'),
              ...recentRows.map((item, index) => renderItem(item, index)),
            ])
            : null,
          h('div', { key: 'cols', className: ROOT + '-cols' }, [
            column('docs', showRecent ? '最近编辑的文档' : '文档', docRows, docOffset,
              showRecent ? '输入关键词可搜文档' : '没有匹配的文档'),
            column('chats', '群聊', chatRows, chatOffset,
              showRecent ? '输入关键词可搜群聊' : '没有匹配的群聊'),
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
          id: 'feishu-ref',
          order: 2,
        }, (props) => h(FeishuRef, props)));
      },
    };
  },
});
