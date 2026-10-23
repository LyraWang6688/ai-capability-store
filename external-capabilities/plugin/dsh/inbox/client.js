/**
 * Client half of the DSH inbox bundle.
 *
 * One composer button (📥 收件箱) and one overlay panel. The panel reads the
 * Feishu「任务收件箱」through the Host route, shows unread deliveries, and marks
 * a row read when the operator opens it. Polls every 30 minutes while the app
 * is open; opens itself once when there is something unread at startup.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-inbox',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const NS = '@lyra_wang/dsh-inbox';
    const ROOT = 'dsh-inbox';
    const POLL_MS = 2 * 60 * 1000;

    const store = { items: [], unread: 0, open: false, loading: false, error: '', fetchedAt: 0, autoOpened: false };
    const listeners = new Set();
    const emit = () => { for (const listener of listeners) listener(); };
    const patch = (next) => { Object.assign(store, next); emit(); };

    function useStore() {
      const [, setTick] = useState(0);
      useEffect(() => {
        const listener = () => setTick((value) => value + 1);
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, []);
      return store;
    }

    async function refresh() {
      patch({ loading: true, error: '' });
      try {
        const response = await fetch('/plugins/inbox/list', { method: 'GET' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status));
        const items = Array.isArray(payload.items) ? payload.items : [];
        patch({ items, unread: Number(payload.unread || 0), loading: false, fetchedAt: Date.now() });
        if (!store.autoOpened && store.unread > 0) patch({ open: true, autoOpened: true });
      } catch (error) {
        patch({ loading: false, error: error && error.message ? error.message : String(error) });
      }
    }

    async function markRead(recordIds) {
      const ids = (Array.isArray(recordIds) ? recordIds : [recordIds]).filter(Boolean);
      if (ids.length === 0) return;
      try {
        const response = await fetch('/plugins/inbox/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recordIds: ids }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status));
        const gone = new Set(ids);
        const items = store.items.filter((item) => !gone.has(item.recordId));
        patch({ items, unread: items.length, error: '' });
      } catch (error) {
        patch({ error: '标记已读失败：' + (error && error.message ? error.message : String(error)) });
      }
    }

    function pad(value) { return String(value).padStart(2, '0'); }
    function shortTime(ms) {
      if (!ms) return '';
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) return '';
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    const CSS = `
      .${ROOT}-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:8px;
        background:transparent;border:1px solid var(--dsw-alias-border-l1,#3a3a40);color:var(--dsw-alias-label-primary,#e6e6e9);
        font-size:12px;cursor:pointer}
      .${ROOT}-btn:hover{background:var(--dsw-alias-bg-layer-2,#26262b)}
      .${ROOT}-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#e5484d;color:#fff;
        font-size:10px;line-height:16px;text-align:center}
      .${ROOT}-mask{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
      .${ROOT}-panel{width:min(560px,92vw);max-height:70vh;display:flex;flex-direction:column;border-radius:14px;
        background:var(--dsw-alias-bg-layer-1,#1f1f23);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden}
      .${ROOT}-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2c31)}
      .${ROOT}-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f4)}
      .${ROOT}-count{font-size:12px;color:var(--dsw-alias-label-secondary,#9a9aa3)}
      .${ROOT}-grow{flex:1}
      .${ROOT}-link{background:none;border:none;color:#7aa2ff;font-size:12px;cursor:pointer;padding:2px 4px}
      .${ROOT}-close{background:none;border:none;color:var(--dsw-alias-label-secondary,#9a9aa3);font-size:18px;cursor:pointer;line-height:1}
      .${ROOT}-body{overflow:auto;padding:8px 10px 12px}
      .${ROOT}-item{display:flex;flex-direction:column;gap:4px;padding:10px 10px;border-radius:10px;cursor:pointer;
        border:1px solid transparent}
      .${ROOT}-item:hover{border-color:var(--dsw-alias-border-l1,#3a3a40);background:var(--dsw-alias-bg-layer-2,#26262b)}
      .${ROOT}-row{display:flex;align-items:center;gap:8px}
      .${ROOT}-task{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#ececf0)}
      .${ROOT}-time{font-size:11px;color:var(--dsw-alias-label-secondary,#8f8f98)}
      .${ROOT}-sum{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b6b6bf);white-space:pre-wrap}
      .${ROOT}-tag{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid currentColor}
      .${ROOT}-ok{color:#3fb950}.${ROOT}-fail{color:#e5484d}.${ROOT}-slow{color:#d29922}
      .${ROOT}-hint{padding:16px;text-align:center;color:var(--dsw-alias-label-secondary,#8f8f98);font-size:12px}
      .${ROOT}-err{color:#e5484d;font-size:12px;padding:8px 14px}
    `;

    function InboxButton() {
      const state = useStore();
      return h('button', {
        type: 'button',
        className: ROOT + '-btn',
        title: '任务收件箱（未读 ' + state.unread + '）',
        onClick: () => { patch({ open: !state.open }); if (!state.open) refresh(); },
      }, [
        h('span', { key: 'icon' }, '📥'),
        state.unread > 0 ? h('span', { key: 'badge', className: ROOT + '-badge' }, String(state.unread)) : null,
      ]);
    }

    function InboxPanel() {
      const state = useStore();
      if (!state.open) return null;
      const unreadItems = state.items.filter((item) => item.status !== '已读');
      return h('div', { className: ROOT + '-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) patch({ open: false }); } },
        h('div', { className: ROOT + '-panel' }, [
          h('div', { key: 'head', className: ROOT + '-head' }, [
            h('div', { key: 'title', className: ROOT + '-title' }, '📥 任务收件箱'),
            h('div', { key: 'count', className: ROOT + '-count' }, unreadItems.length + ' 条未读'),
            h('div', { key: 'grow', className: ROOT + '-grow' }),
            unreadItems.length > 0
              ? h('button', { key: 'all', type: 'button', className: ROOT + '-link', onClick: () => markRead(unreadItems.map((item) => item.recordId)) }, '全部已读')
              : null,
            h('button', { key: 'close', type: 'button', className: ROOT + '-close', onClick: () => patch({ open: false }) }, '×'),
          ]),
          state.error ? h('div', { key: 'err', className: ROOT + '-err' }, state.error) : null,
          h('div', { key: 'body', className: ROOT + '-body' },
            unreadItems.length === 0
              ? h('div', { className: ROOT + '-hint' }, state.loading ? '加载中…' : '没有未读任务 🎉')
              : unreadItems.map((item) => h('div', {
                key: item.recordId,
                className: ROOT + '-item',
                onClick: () => markRead(item.recordId),
              }, [
                h('div', { key: 'row', className: ROOT + '-row' }, [
                  h('span', { key: 'task', className: ROOT + '-task' }, item.taskName || '(未关联任务)'),
                  h('span', { key: 'tag', className: ROOT + '-tag ' + (item.result === '失败' ? ROOT + '-fail' : item.result === '超时' ? ROOT + '-slow' : ROOT + '-ok') }, item.result || '成功'),
                  h('span', { key: 'time', className: ROOT + '-time' }, shortTime(item.executedAt)),
                ]),
                item.summary ? h('div', { key: 'sum', className: ROOT + '-sum' }, item.summary) : null,
              ])),
          ),
        ]),
      );
    }

    function Wake() {
      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        // 窗口重新获得焦点时也刷新一次（切回 DSH 就能看到新任务）
        const onFocus = () => { void refresh(); };
        window.addEventListener('focus', onFocus);
        return () => {
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, []);
      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-inbox-button',
          order: 6,
        }, () => h(InboxButton)));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-inbox-panel',
          order: 940,
        }, () => h(React.Fragment, null, h('style', null, CSS), h(Wake), h(InboxPanel))));
      },
    };
  },
});
