/**
 * Client half of the DSH memory panel.
 *
 * One composer button (🧠 记忆) and one overlay panel anchored to the right edge.
 * The panel shows the resolved workspace/project first — that is the whole point:
 * a wrong memory bucket becomes visible instead of silently swallowing queries.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-memory-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;

    const NS = '@lyra_wang/dsh-memory-panel';

    const store = {
      open: false, cwd: '', sessionId: '',
      scope: null, projects: [], query: '', hits: [], page: null,
      loading: false, error: '',
    };
    const listeners = new Set();
    const emit = () => { for (const l of listeners) l(); };
    const patch = (next) => { Object.assign(store, next); emit(); };

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
        throw new Error(payload.message || ('HTTP ' + response.status));
      }
      return payload;
    }

    async function loadProjects() {
      const payload = await callHost('/plugins/memory/projects');
      patch({ projects: Array.isArray(payload.projects) ? payload.projects : [] });
    }

    async function resolveScope(sessionId, cwd) {
      const query = sessionId
        ? '/plugins/memory/resolve?session=' + encodeURIComponent(sessionId)
        : '/plugins/memory/resolve?cwd=' + encodeURIComponent(cwd || '');
      const payload = await callHost(query);
      patch({
        scope: { workspace: payload.workspace, project: payload.project, derivedFrom: payload.derivedFrom },
        cwd: payload.cwd || cwd || '',
      });
      return payload;
    }

    async function mcp(tool, args) {
      const payload = await callHost('/plugins/memory/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, arguments: args }),
      });
      return payload.data;
    }

    async function runSearch() {
      const scope = store.scope;
      if (!scope) return;
      patch({ loading: true, error: '', page: null });
      try {
        const data = await mcp('memory_query', {
          query: store.query || '*',
          workspace: scope.workspace,
          project: scope.project,
          limit: 20,
        });
        const hits = Array.isArray(data?.hits) ? data.hits : [];
        const raw = Array.isArray(data?.raw_hits) ? data.raw_hits : [];
        patch({ hits: hits.map((x) => ({ ...x, _kind: 'page' })).concat(raw.map((x) => ({ ...x, _kind: 'raw' }))), loading: false });
      } catch (error) {
        patch({ loading: false, error: error?.message || String(error) });
      }
    }

    async function openPage(path) {
      const scope = store.scope;
      if (!scope || !path) return;
      patch({ loading: true, error: '' });
      try {
        const data = await mcp('memory_read_page', { path, workspace: scope.workspace, project: scope.project });
        patch({ page: data, loading: false });
      } catch (error) {
        patch({ loading: false, error: error?.message || String(error) });
      }
    }

    const css = `
      .dmp-btn { display:inline-flex; align-items:center; gap:4px; padding:4px 8px; border-radius:6px; cursor:pointer;
        border:1px solid var(--dsw-alias-border-l1,#3a3a40); background:var(--dsw-alias-bg-layer-2,#26262b);
        color:var(--dsw-alias-label-primary,#e6e6e9); font-size:12px; }
      .dmp-btn:hover { opacity:.85; }
      .dmp-panel { position:fixed; top:56px; right:0; bottom:0; width:400px; z-index:2147483000;
        display:flex; flex-direction:column; background:var(--dsw-alias-bg-layer-2,#26262b);
        border-left:1px solid var(--dsw-alias-border-l1,#3a3a40); color:var(--dsw-alias-label-primary,#e6e6e9);
        font-size:12px; box-shadow:-8px 0 24px rgba(0,0,0,.25); }
      .dmp-head { display:flex; align-items:center; justify-content:space-between; padding:8px 10px;
        border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a40); }
      .dmp-scope { padding:6px 10px; font-family:ui-monospace,monospace; font-size:11px; opacity:.85;
        border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a40); word-break:break-all; }
      .dmp-scope b { color:#7ee787; }
      .dmp-row { display:flex; gap:6px; padding:8px 10px; align-items:center; }
      .dmp-input { flex:1; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        background:var(--dsw-alias-bg-layer-1,#1e1e22); color:inherit; font-size:12px; }
      .dmp-list { flex:1; overflow:auto; border-top:1px solid var(--dsw-alias-border-l1,#3a3a40); }
      .dmp-item { padding:6px 10px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.05); }
      .dmp-item:hover { background:rgba(255,255,255,.06); }
      .dmp-item .t { font-family:ui-monospace,monospace; font-size:11px; opacity:.9; }
      .dmp-item .s { opacity:.6; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .dmp-tag { font-size:10px; opacity:.6; margin-right:6px; }
      .dmp-body { flex:1; overflow:auto; padding:10px; font-family:ui-monospace,monospace; font-size:11px;
        white-space:pre-wrap; word-break:break-word; }
      .dmp-err { padding:8px 10px; color:#ff7b72; }
      .dmp-close { cursor:pointer; padding:2px 6px; opacity:.7; }
      .dmp-close:hover { opacity:1; }
    `;

    function Style() {
      useEffect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-plugin', NS);
        el.textContent = css;
        document.head.appendChild(el);
        return () => el.remove();
      }, []);
      return null;
    }

    function Panel() {
      const s = useStore();
      if (!s.open) return null;
      const scope = s.scope;
      return h(React.Fragment, null,
        h(Style),
        h('div', { className: 'dmp-panel' },
          h('div', { className: 'dmp-head' },
            h('strong', null, '🧠 记忆'),
            h('span', { className: 'dmp-close', onClick: () => patch({ open: false }) }, '✕'),
          ),
          h('div', { className: 'dmp-scope' },
            scope
              ? `当前桶：${scope.workspace} / ${scope.project}  (${scope.derivedFrom})`
              : '正在解析当前项目…',
          ),
          h('div', { className: 'dmp-row' },
            h('input', {
              className: 'dmp-input',
              placeholder: '搜索记忆（留空 = 全部）',
              value: s.query,
              onChange: (e) => patch({ query: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter') runSearch(); },
            }),
            h('button', { className: 'dmp-btn', onClick: runSearch }, s.loading ? '…' : '搜索'),
          ),
          h('div', { className: 'dmp-row' },
            h('select', {
              className: 'dmp-input',
              value: scope ? scope.project : '',
              onChange: async (e) => {
                const name = e.target.value;
                patch({ scope: { workspace: 'default', project: name, derivedFrom: 'manual' }, hits: [], page: null });
              },
            }, (s.projects || []).map((p) =>
              h('option', { key: p.project_name, value: p.project_name },
                `${p.project_name}  ·  ${p.page_count} 页`))),
          ),
          s.error ? h('div', { className: 'dmp-err' }, s.error) : null,
          s.page
            ? h('div', { className: 'dmp-body' }, s.page.body || JSON.stringify(s.page, null, 2))
            : h('div', { className: 'dmp-list' },
                (s.hits || []).length === 0
                  ? h('div', { className: 'dmp-item' }, h('div', { className: 's' }, '没有结果。点「搜索」试试。'))
                  : s.hits.map((hit, index) =>
                      h('div', {
                        key: (hit.path || hit.id || index),
                        className: 'dmp-item',
                        onClick: () => (hit._kind === 'page' ? openPage(hit.path) : patch({ page: hit })),
                      },
                        h('div', { className: 't' },
                          h('span', { className: 'dmp-tag' }, hit._kind === 'page' ? '页' : '原始'),
                          hit.path || hit.title),
                        h('div', { className: 's' }, (hit.snippet || '').replace(/<[^>]+>/g, '').slice(0, 120)),
                      )),
              ),
        ),
      );
    }

    function Button(props) {
      const s = useStore();
      const sessionId = props && props.sessionId ? props.sessionId : '';
      const open = useCallback(async () => {
        const next = !s.open;
        patch({ open: next, sessionId });
        if (!next) return;
        try {
          const resolved = await resolveScope(sessionId);
          await loadProjects();
          if (resolved && resolved.project) await runSearch();
          else patch({ error: '解析不到当前项目目录，请在下方手动选一个桶' });
        } catch (error) {
          patch({ error: error?.message || String(error) });
        }
      }, [s.open, sessionId]);

      return h(React.Fragment, null,
        h(Style),
        h('button', { className: 'dmp-btn', title: '浏览 ai-memory 记忆', onClick: open }, '🧠 记忆'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'memory-panel-button',
          order: 6,
        }, (props) => h(Button, props)));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'memory-panel-overlay',
        }, () => h(Panel)));
      },
    };
  },
});
