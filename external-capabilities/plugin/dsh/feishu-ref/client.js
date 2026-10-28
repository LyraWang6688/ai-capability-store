/**
 * Client half of the feishu-ref bundle.
 *
 * Registers one compact button in `conversation.input.left` (the composer tool
 * row). Clicking it grows a panel upward out of the composer — list on top,
 * search field pinned at the bottom (same shape as Doubao's "+" palette).
 *
 * Idle: only the operator's own recents. Typing: one list, grouped 文档 / 群聊.
 * Picking a row inserts `[title](url)` through `inputActions.insertText()` — an
 * ordinary undoable text edit, never a send.
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
    const RECENT_KEEP = 8;
    const RECENT_SHOW = 6;
    // Both groups must be visible without scrolling: 5 rows each + two section
    // labels + the search row lands just under PANEL_MAX_HEIGHT. With no chat
    // hits there is nothing to compete with, so documents get more room.
    const DOC_ROWS_WITH_CHATS = 5;
    const CHAT_ROWS = 5;
    const DOC_ROWS_ALONE = 8;
    const PANEL_MAX_WIDTH = 760;
    const PANEL_MIN_WIDTH = 360;
    const PANEL_MAX_HEIGHT = 420;
    const PANEL_MIN_HEIGHT = 168;

    /* ---------- recents (localStorage, never leaves this browser) ---------- */

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
        /* localStorage unavailable: inserting still works */
      }
    }

    /* --------------------------------- icons -------------------------------- */

    const ICON = {
      doc: ['M4.5 2.5h4l3 3v8h-7z', 'M8.5 2.5v3h3'],
      bitable: ['M2.5 3.5h11v9h-11z', 'M2.5 6.5h11', 'M6.5 6.5v6', 'M2.5 9.5h11'],
      sheet: ['M2.5 3.5h11v9h-11z', 'M2.5 6.5h11', 'M6 6.5v6'],
      wiki: ['M8 5.2C8 4 7 3.2 5.8 3.2H3v9.4h3c1 0 2 .6 2 1.6', 'M8 5.2c0-1.2 1-2 2.2-2H13v9.4h-3c-1 0-2 .6-2 1.6'],
      slides: ['M2.5 3.5h11v7h-11z', 'M6 12.5h4', 'M8 10.5v2'],
      chat: ['M13 8.2c0 2.1-2.2 3.8-5 3.8-.6 0-1.1-.1-1.6-.2L3.5 13l.8-2.2C3.5 10 3 9.2 3 8.2 3 6.1 5.2 4.5 8 4.5s5 1.6 5 3.7z'],
      doc2: ['M4.5 2.5h4l3 3v8h-7z', 'M8.5 2.5v3h3', 'M6 8h4', 'M6 10.5h4'],
    };

    function iconFor(type) {
      const key = type === 'bitable' || type === 'sheet' || type === 'wiki' || type === 'slides' || type === 'chat'
        ? type
        : (type === 'docx' || type === 'doc' ? 'doc' : 'doc2');
      return h('svg', {
        key: 'i',
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, ICON[key].map((d, index) => h('path', { key: index, d })));
    }

    const TYPE_LABEL = {
      bitable: '多维表格',
      docx: '文档',
      doc: '文档',
      wiki: '知识库',
      sheet: '表格',
      slides: '幻灯片',
      chat: '群聊',
    };

    /* --------------------------------- styles ------------------------------- */

    const CSS = `
      .${ROOT}-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
        height:26px;padding:0 8px;border-radius:7px;color:var(--dsw-alias-label-secondary,#b9b9c0);
        font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
      .${ROOT}-btn:hover{background:var(--dsw-alias-bg-layer-3,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-btn[data-open="true"]{background:var(--dsw-alias-bg-layer-3,#3a3a41);color:var(--dsw-alias-label-primary,#e6e6e9)}

      /* The panel is the composer grown upward: same surface token, same panel
         radius on top, square bottom, no bottom border — one continuous card. */
      .${ROOT}-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;overflow:hidden;
        background:var(--dsw-specific-input-major,#2c2c2e);
        border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-bottom-color:transparent;
        border-radius:var(--dsw-radius-panel,20px) var(--dsw-radius-panel,20px) 0 0;
        box-shadow:var(--dsw-elevation-soft,0 0 0 .5px #ffffff1f,0 4px 16px #00000026);
        font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        color:var(--dsw-alias-label-primary,#e6e6e9);animation:${ROOT}-in .12s ease-out}
      @keyframes ${ROOT}-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

      .${ROOT}-body{flex:1;min-height:0;overflow:auto;padding:0 8px 6px;overscroll-behavior:contain}
      .${ROOT}-section{position:sticky;top:0;z-index:1;padding:9px 8px 4px;font-size:11px;letter-spacing:.02em;
        color:var(--dsw-alias-label-tertiary,#9a9aa2);background:var(--dsw-specific-input-major,#2c2c2e)}
      .${ROOT}-row{display:flex;align-items:center;gap:9px;height:32px;padding:0 8px;border-radius:10px;cursor:pointer}
      .${ROOT}-row:hover,.${ROOT}-row[data-active="true"]{background:var(--dsw-alias-bg-layer-3,#3a3a41)}
      .${ROOT}-ico{flex:0 0 16px;display:flex;align-items:center;justify-content:center;
        color:var(--dsw-alias-label-tertiary,#9a9aa2)}
      .${ROOT}-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;
        color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-meta{flex:0 0 auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
      .${ROOT}-hint{padding:14px 10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}
      .${ROOT}-err{padding:6px 10px 8px;font-size:11.5px;color:#ff8a8a}

      /* Search lives at the bottom of the panel, like Doubao's "+" palette. */
      .${ROOT}-search{display:flex;align-items:center;gap:9px;height:42px;padding:0 14px;
        border-top:1px solid var(--dsw-alias-border-l1,#ffffff0f);
        color:var(--dsw-alias-label-tertiary,#8a8a92)}
      .${ROOT}-mag{flex:0 0 14px;display:flex;align-items:center;justify-content:center}
      .${ROOT}-input{all:unset;flex:1;min-width:0;font:13px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT}-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a92)}
      .${ROOT}-state{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
    `;

    /* ------------------------------- helpers -------------------------------- */

    function shortTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const diff = Date.now() - date.getTime();
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
      if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
      if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
      return date.toISOString().slice(0, 10);
    }

    function metaFor(item) {
      if (item.type === 'chat') return item.desc || (item.external ? '外部群' : '群聊');
      const label = TYPE_LABEL[item.type] || '文档';
      const time = shortTime(item.editedAt);
      return time ? label + ' · ' + time : label;
    }

    /** Nearest ancestor that looks like the composer card — used to align the
     *  panel with it instead of guessing a width. */
    function composerRect(btn) {
      if (!btn) return null;
      let el = btn.parentElement;
      for (let depth = 0; depth < 10 && el; depth += 1, el = el.parentElement) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 320 && rect.width <= window.innerWidth - 8 && rect.height >= 28) return rect;
      }
      return null;
    }

    /* ------------------------------- component ------------------------------ */

    function FeishuRef(props) {
      const inputActions = props && props.inputActions;
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [docs, setDocs] = useState([]);
      const [chats, setChats] = useState([]);
      const [failures, setFailures] = useState([]);
      const [recent, setRecent] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [note, setNote] = useState('');
      const [active, setActive] = useState(-1);
      const [anchor, setAnchor] = useState(null);
      const btnRef = useRef(null);
      const inputRef = useRef(null);
      const panelRef = useRef(null);
      const seqRef = useRef(0);

      const searching = query.trim() !== '';

      const runSearch = async (q) => {
        const seq = ++seqRef.current;
        setLoading(true);
        setError('');
        try {
          const response = await fetch('/plugins/feishu-ref/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q }),
          });
          const payload = await response.json().catch(() => ({}));
          if (seq !== seqRef.current) return; // a newer keystroke already won
          if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status));
          setDocs(payload.items || []);
          setChats(payload.chats || []);
          setActive(-1);
          setFailures(payload.failures || []);
        } catch (err) {
          if (seq !== seqRef.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setDocs([]);
          setChats([]);
          setFailures([]);
        } finally {
          if (seq === seqRef.current) setLoading(false);
        }
      };

      const openPanel = () => {
        const rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
        const composer = composerRect(btnRef.current);
        if (rect) {
          const width = Math.max(
            Math.min(PANEL_MIN_WIDTH, window.innerWidth - 24),
            Math.min(PANEL_MAX_WIDTH, composer ? composer.width : PANEL_MAX_WIDTH, window.innerWidth - 24),
          );
          const left = Math.max(12, Math.min(composer ? composer.left : rect.left, window.innerWidth - width - 12));
          const top = composer ? composer.top : rect.top;
          setAnchor({
            left,
            width,
            bottom: Math.max(12, window.innerHeight - top - 1),
            maxHeight: Math.min(PANEL_MAX_HEIGHT, Math.max(200, Math.floor(top - 24))),
            minHeight: Math.min(PANEL_MIN_HEIGHT, Math.max(120, Math.floor(top - 24))),
          });
        }
        setOpen(true);
        setQuery('');
        setDocs([]);
        setChats([]);
        setFailures([]);
        setError('');
        setNote('');
        setActive(-1);
        setRecent(loadRecent());
      };

      const close = () => {
        setOpen(false);
        setError('');
        setNote('');
      };

      // Close on outside click; keep focus in the search field while open.
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const inPanel = panelRef.current && panelRef.current.contains(event.target);
          const inButton = btnRef.current && btnRef.current.contains(event.target);
          if (!inPanel && !inButton) close();
        };
        document.addEventListener('mousedown', onDown, true);
        const timer = setTimeout(() => inputRef.current && inputRef.current.focus(), 20);
        return () => {
          clearTimeout(timer);
          document.removeEventListener('mousedown', onDown, true);
        };
      }, [open]);

      // Debounced search. Idle (empty query) never touches the host: the list is
      // purely local recents, so opening the panel costs zero lark-cli calls.
      useEffect(() => {
        if (!open || !searching) return undefined;
        const timer = setTimeout(() => runSearch(query.trim()), 220);
        return () => clearTimeout(timer);
      }, [query, open]);

      // Keep the keyboard-selected row inside the scroll viewport.
      useEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        if (!panel) return;
        const row = panel.querySelector('.' + ROOT + '-row[data-active="true"]');
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      }, [active, open, docs, chats]);

      const remember = (item) => {
        const next = [item].concat(loadRecent().filter((entry) => entry.url !== item.url)).slice(0, RECENT_KEEP);
        saveRecent(next);
        setRecent(next);
      };

      const choose = (item) => {
        const text = '[' + item.title + '](' + item.url + ') ';
        const canInsert = inputActions
          && typeof inputActions.captureInsertion === 'function'
          && typeof inputActions.insertText === 'function';
        if (canInsert) {
          try {
            const span = inputActions.captureInsertion();
            inputActions.insertText(text, span);
            remember(item);
            close();
            return;
          } catch {
            /* fall through to the clipboard */
          }
        }
        if (navigator.clipboard) navigator.clipboard.writeText(text);
        remember(item);
        setNote('已复制链接到剪贴板');
      };

      /* -------------------------- what the list holds ------------------------- */

      const recentRows = recent.slice(0, RECENT_SHOW);
      const docRows = searching
        ? docs.slice(0, chats.length > 0 ? DOC_ROWS_WITH_CHATS : DOC_ROWS_ALONE)
        : [];
      const chatRows = searching ? chats.slice(0, CHAT_ROWS) : [];
      const flat = searching ? docRows.concat(chatRows) : recentRows;
      const docOffset = 0;
      const chatOffset = docRows.length;

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setActive((index) => {
            const next = index + delta;
            if (next < -1) return -1;
            if (next > flat.length - 1) return Math.max(flat.length - 1, 0);
            return next;
          });
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const item = flat[active];
          if (item) choose(item);
        }
      };

      const row = (item, index) => h('div', {
        key: 'row-' + item.url + '-' + index,
        className: ROOT + '-row',
        'data-active': index === active ? 'true' : 'false',
        onMouseEnter: () => setActive(index),
        onMouseDown: (event) => {
          event.preventDefault();
          choose(item);
        },
      }, [
        h('span', { key: 'ico', className: ROOT + '-ico' }, iconFor(item.type)),
        h('span', { key: 't', className: ROOT + '-title', title: item.title }, item.title),
        h('span', { key: 'm', className: ROOT + '-meta', title: metaFor(item) }, metaFor(item)),
      ]);

      const section = (label, key) => h('div', { key: 'sec-' + key, className: ROOT + '-section' }, label);

      const bodyChildren = [];
      if (searching) {
        if (docRows.length) {
          bodyChildren.push(section('文档', 'docs'));
          docRows.forEach((item, index) => bodyChildren.push(row(item, docOffset + index)));
        }
        if (chatRows.length) {
          bodyChildren.push(section('群聊', 'chats'));
          chatRows.forEach((item, index) => bodyChildren.push(row(item, chatOffset + index)));
        }
        if (!docRows.length && !chatRows.length && !loading && !error) {
          bodyChildren.push(h('div', { key: 'none', className: ROOT + '-hint' }, '没有匹配的文档或群聊'));
        }
      } else if (recentRows.length) {
        bodyChildren.push(section('最近使用', 'recent'));
        recentRows.forEach((item, index) => bodyChildren.push(row(item, index)));
      } else {
        bodyChildren.push(h('div', { key: 'empty', className: ROOT + '-hint' },
          '还没有最近使用 —— 搜一篇文档或一个群，选中后就会出现在这里'));
      }

      if (error) bodyChildren.push(h('div', { key: 'err', className: ROOT + '-err' }, '搜索失败：' + error));
      failures.forEach((failure, index) => {
        bodyChildren.push(h('div', { key: 'fail-' + index, className: ROOT + '-err' },
          (failure.kind === 'chats' ? '群聊' : '文档') + '搜索失败：' + failure.message));
      });
      if (note) bodyChildren.push(h('div', { key: 'note', className: ROOT + '-hint' }, note));

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
            width: anchor.width + 'px',
            maxHeight: anchor.maxHeight + 'px',
            minHeight: anchor.minHeight + 'px',
          },
          onKeyDown,
        }, [
          h('div', { key: 'body', className: ROOT + '-body' }, bodyChildren),
          h('div', { key: 'search', className: ROOT + '-search' }, [
            h('span', { key: 'mag', className: ROOT + '-mag' }, h('svg', {
              width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
              stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
            }, [
              h('circle', { key: 'c', cx: 7, cy: 7, r: 4.2 }),
              h('path', { key: 'l', d: 'M10.2 10.2 13.5 13.5' }),
            ])),
            h('input', {
              key: 'in',
              ref: inputRef,
              className: ROOT + '-input',
              placeholder: '搜索文档 / 群聊…',
              value: query,
              onChange: (event) => {
                setQuery(event.target.value);
                setActive(-1);
                setNote('');
              },
            }),
            loading
              ? h('span', { key: 'st', className: ROOT + '-state' }, '搜索中…')
              : h('span', { key: 'st', className: ROOT + '-state' }, '↑↓ 选择 · ↵ 插入'),
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
