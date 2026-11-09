/**
 * Client half of the DSH session board.
 *
 * One composer button (📋 需求) that puts the board in the **right sidebar tab**
 * when the host exposes the right-bar services, and otherwise opens a self-drawn
 * dock on the right edge.
 *
 * Why the fallback: `ctx.sidebarRight` was unobtainable by third-party plugins in
 * earlier builds, so this file never *declares* `@deepseek-ai/dsh-client-ui-sidebar-right`
 * in `dsh.client.inject` — a bad package id in that list keeps the whole App from
 * booting. It asks for the services at runtime instead: present → real tab,
 * absent → overlay. Failing open beats failing the boot.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-session-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback, useRef } = React;

    const PKG = '@lyra_wang/dsh-session-board';
    const KIND = `${PKG}/requirements`;
    const POLL_MS = 4000;

    const store = {
      sessionId: '',
      board: null,
      expanded: {},
      bus: false,
      loading: false,
      error: '',
    };
    const listeners = new Set();
    const emit = () => {
      for (const l of listeners) l();
    };
    const patch = (next) => {
      Object.assign(store, next);
      emit();
    };

    function useStore() {
      const [, setTick] = useState(0);
      useEffect(() => {
        const l = () => setTick((v) => v + 1);
        listeners.add(l);
        return () => listeners.delete(l);
      }, []);
      return store;
    }

    async function callHost(path, init) {
      const response = await fetch(path, init);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.message || `HTTP ${response.status}`);
      }
      return payload;
    }

    async function fetchBoard(sessionId) {
      const payload = await callHost(
        `/plugins/session-board/board?session=${encodeURIComponent(sessionId)}`,
      );
      return payload.board;
    }

    async function load(sessionId) {
      if (!sessionId) return;
      try {
        const board = await fetchBoard(sessionId);
        patch({ board, error: '', loading: false, bus: false });
      } catch (error) {
        patch({ error: error?.message || String(error), loading: false, bus: false });
      }
    }

    async function send(sessionId, body) {
      patch({ bus: true });
      try {
        const payload = await callHost('/plugins/session-board/board', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, ...body }),
        });
        patch({ board: payload.board, error: '', bus: false });
      } catch (error) {
        patch({ error: error?.message || String(error), bus: false });
      }
    }

    const STATUS_TEXT = { active: '进行中', done: '已完成', blocked: '受阻', open: '未开始' };
    const TASK_TEXT = { running: '跑着', done: '完成', failed: '失败', pending: '待办' };
    const TASK_CLASS = { running: 'active', done: 'done', failed: 'blocked', pending: 'pending' };

    const css = `
      .dsb-btn { display:inline-flex; align-items:center; gap:4px; padding:4px 8px; border-radius:6px; cursor:pointer;
        border:1px solid var(--dsw-alias-border-l1,#3a3a40); background:var(--dsw-alias-bg-layer-2,#26262b);
        color:var(--dsw-alias-label-primary,#e6e6e9); font-size:12px; }
      .dsb-btn:hover { opacity:.85; }
      .dsb-body { display:flex; flex-direction:column; height:100%; min-height:0;
        color:var(--dsw-alias-label-primary,#e6e6e9); font-size:12px; }
      .dsb-head { display:flex; align-items:center; justify-content:space-between; padding:8px 10px;
        border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a40); gap:8px; }
      .dsb-meta { padding:5px 10px; font-size:11px; opacity:.7;
        border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a40); }
      .dsb-list { flex:1; overflow:auto; min-height:0; }
      .dsb-req { border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a40); }
      .dsb-req-top { display:flex; gap:6px; padding:8px 10px; align-items:flex-start; cursor:pointer; }
      .dsb-req-top:hover { background:rgba(255,255,255,.05); }
      .dsb-idx { font-family:ui-monospace,monospace; font-size:11px; opacity:.55; min-width:16px; }
      .dsb-title { flex:1; line-height:1.35; word-break:break-word; }
      .dsb-pill { font-size:10px; padding:1px 6px; border-radius:999px; white-space:nowrap;
        border:1px solid currentColor; opacity:.9; }
      .dsb-active { color:#79c0ff; }
      .dsb-done { color:#7ee787; }
      .dsb-blocked { color:#ff7b72; }
      .dsb-pending { color:#8b949e; }
      .dsb-src { font-size:9px; opacity:.5; border:1px solid currentColor; border-radius:3px; padding:0 3px; }
      .dsb-reason { padding:0 10px 6px 32px; font-size:11px; opacity:.75; color:#d2a8ff; line-height:1.4; }
      .dsb-sub { padding:0 10px 8px 26px; display:flex; flex-direction:column; gap:3px; }
      .dsb-task { display:flex; gap:6px; align-items:baseline; opacity:.85; }
      .dsb-msg { opacity:.6; font-size:11px; line-height:1.4; word-break:break-word; }
      .dsb-actions { display:flex; gap:6px; padding:0 10px 8px 26px; flex-wrap:wrap; }
      .dsb-mini { font-size:10px; padding:1px 6px; border-radius:4px; cursor:pointer;
        border:1px solid var(--dsw-alias-border-l1,#3a3a40); background:transparent; color:inherit; opacity:.7; }
      .dsb-mini:hover { opacity:1; }
      .dsb-child { padding:3px 10px; font-family:ui-monospace,monospace; font-size:10px; opacity:.55; }
      .dsb-err { padding:8px 10px; color:#ff7b72; line-height:1.4; }
      .dsb-empty { padding:14px 10px; opacity:.6; line-height:1.5; }
      .dsb-wait { opacity:.5; padding:10px; }
    `;

    function Style() {
      useEffect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-plugin', PKG);
        el.textContent = css;
        document.head.appendChild(el);
        return () => el.remove();
      }, []);
      return null;
    }

    function Pill({ status }) {
      return h('span', { className: `dsb-pill dsb-${status}` }, STATUS_TEXT[status] || status);
    }

    function Requirement({ row, last, sessionId }) {
      const s = useStore();
      const open = !!s.expanded[row.id];
      const toggle = () => patch({ expanded: { ...s.expanded, [row.id]: !open } });

      return h(
        'div',
        { className: 'dsb-req' },
        h(
          'div',
          { className: 'dsb-req-top', onClick: toggle },
          h('span', { className: 'dsb-idx' }, `${row.id}`),
          h('span', { className: 'dsb-title' }, row.title || '(空)'),
          h(Pill, { status: row.status }),
        ),
        row.reason ? h('div', { className: 'dsb-reason' }, `理由：${row.reason}`) : null,
        open
          ? h(
              'div',
              { className: 'dsb-sub' },
              row.tasks.length === 0
                ? h('div', { className: 'dsb-msg' }, '这条需求没有派出子任务')
                : row.tasks.map((task, index) =>
                    h(
                      'div',
                      { key: index, className: 'dsb-task' },
                      h(
                        'span',
                        { className: `dsb-pill dsb-${TASK_CLASS[task.status] || 'pending'}` },
                        TASK_TEXT[task.status] || task.status,
                      ),
                      h('span', null, task.label),
                      task.source === 'agent'
                        ? h('span', { className: 'dsb-src', title: '智能体上报' }, '上报')
                        : null,
                    ),
                  ),
              row.messages.map((message) =>
                h('div', { key: message.seq, className: 'dsb-msg' }, `· ${message.text}`),
              ),
            )
          : null,
        open
          ? h(
              'div',
              { className: 'dsb-actions' },
              h(
                'button',
                {
                  className: 'dsb-mini',
                  disabled: row.id === 1 || s.bus,
                  onClick: (event) => {
                    event.stopPropagation();
                    send(sessionId, { action: 'merge', index: row.id });
                  },
                },
                '并入上一条',
              ),
              row.id !== last
                ? h(
                    'button',
                    {
                      className: 'dsb-mini',
                      disabled: s.bus,
                      onClick: (event) => {
                        event.stopPropagation();
                        const from = row.messages.length
                          ? row.messages[row.messages.length - 1].seq
                          : 0;
                        send(sessionId, { action: 'split', index: row.id, fromSeq: from });
                      },
                    },
                    '最后一条另起',
                  )
                : null,
            )
          : null,
      );
    }

    /** The right-bar tab body: one requirement per row. */
    function Board({ sessionId }) {
      const s = useStore();
      const timer = useRef(0);
      const sid = sessionId || s.sessionId;

      useEffect(() => {
        if (!sid) return undefined;
        load(sid);
        timer.current = setInterval(() => {
          if (!store.bus) load(sid);
        }, POLL_MS);
        return () => clearInterval(timer.current);
      }, [sid]);

      const board = s.board && sid === s.sessionId ? s.board : null;
      const rows = (board && board.rows) || [];

      return h(
        'div',
        { className: 'dsb-body' },
        h(
          'div',
          { className: 'dsb-head' },
          h('strong', null, '📋 需求看板'),
          h(
            'span',
            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h(
              'button',
              { className: 'dsb-mini', onClick: () => load(sid), disabled: s.bus },
              s.bus ? '…' : '刷新',
            ),
            h(
              'button',
              {
                className: 'dsb-mini',
                title: '清掉本机保存的切分结果并重新判定',
                onClick: () => send(sid, { action: 'reset' }),
              },
              '重判',
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsb-meta' },
          board ? `${rows.length} 条需求 · ${board.messages} 条消息 · ${board.tasks} 个任务` : '读取中…',
        ),
        s.error ? h('div', { className: 'dsb-err' }, s.error) : null,
        h(
          'div',
          { className: 'dsb-list' },
          rows.length === 0
            ? h('div', { className: 'dsb-empty' }, '这个会话还没有你说过的话。')
            : rows.map((row) =>
                h(Requirement, {
                  key: row.id,
                  row,
                  last: rows[rows.length - 1].id,
                  sessionId: sid,
                }),
              ),
          board && board.children && board.children.length
            ? h(
                React.Fragment,
                null,
                h('div', { className: 'dsb-sub', style: { paddingTop: 6 } }, '子智能体会话：'),
                board.children.map((child) =>
                  h(
                    'div',
                    { key: child.id, className: 'dsb-child' },
                    `${child.live ? '● ' : '○ '}${child.id}${child.depth > 1 ? `  depth ${child.depth}` : ''}`,
                  ),
                ),
              )
            : null,
        ),
      );
    }

    return {
      // A Client plugin only receives the right-bar services when it declares them
      // here; the host then grants them before `apply` runs. `dsh.client.inject` in
      // package.json names the same package for bundling — both are required.
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const tabs = ctx.sidebarRightTabs;
        const right = ctx.sidebarRight;

        tabs.register({
          id: PKG,
          kind: KIND,
          priority: 'extension',
          title: () => '📋 需求·自动',
          guide: [
            {
              id: 'board',
              order: 40,
              title: () => '📋 需求看板（自动）',
              description: () => '这个会话提了哪些需求、进展如何',
            },
          ],
        });

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: PKG, inject: (sessionId) => ({ sessionId }) },
            (props) => h(Board, { ...props, sessionId: props.sessionId }),
          ),
        );
        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PKG }, () =>
            h('span', null, '📋 需求·自动'),
          ),
        );

        const Button = (props) => {
          const sessionId = props && props.sessionId ? String(props.sessionId) : '';
          const toggle = useCallback(() => {
            patch({ sessionId });
            right.openTab(KIND);
          }, [sessionId]);
          return h(
            React.Fragment,
            null,
            h(Style),
            h(
              'button',
              { className: 'dsb-btn', title: '这个会话提了哪些需求、进展如何', onClick: toggle },
              '📋 需求',
            ),
          );
        };

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'session-board-button', order: 7 },
            (props) => h(Button, props),
          ),
        );
      },
    };
  },
});
