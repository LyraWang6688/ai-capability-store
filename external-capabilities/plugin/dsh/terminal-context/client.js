/**
 * 界面侧 · 共享侧边栏终端（v0.5.1）
 *
 * 用户点「○ 共享终端」才开：开关是显式授权，关掉就彻底静默——不读屏、不推送、
 * Host 侧连缓存都清掉（心智模型对齐豆包那种「我点共享它才看」）。
 *
 * 开关本身同时承担两件事：渲染按钮 + 从 slot props 里拿到 sessionId
 * （Host 要靠它把屏幕对到正确的会话，才能叫醒正确的 Agent）。
 *
 * 三个硬约束沿用 v0.1 的教训：
 *   inject 只声明 slots   'slots' 是确定存在的客户端服务；不声明就拿不到（ctx.get 在受限
 *                         上下文里对这个服务返回 undefined，0.5.1 首次真机验证踩到）
 *   全部 try/catch         读失败只是"没数据"，不白屏
 *   只读                   不点击终端、不输入
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-terminal-context',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const MAX = 80
    const clean = (t) => (t || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '')

    const PREF_PREFIX = 'dsh-terminal-context:share:'
    const state = { sessionId: '' }

    /** 共享是按会话存的：A 会话打开共享，不会让 B 会话也处于共享状态。 */
    const isShared = (sessionId) => {
      if (!sessionId) return false
      try { return window.localStorage?.getItem(PREF_PREFIX + sessionId) === '1' } catch { return false }
    }
    const markShared = (sessionId, on) => {
      if (!sessionId) return
      try { window.localStorage?.setItem(PREF_PREFIX + sessionId, on ? '1' : '0') } catch { /* ignore */ }
    }

    const subscribers = new Set()
    const notify = () => { for (const fn of subscribers) { try { fn() } catch { /* ignore */ } } }

    const readTerminal = () => {
      const rows = document.querySelectorAll('.xterm-rows > div')
      if (!rows.length) return null
      const out = []
      for (const r of rows) out.push(clean(r.textContent))
      while (out.length && !out[0].trim()) out.shift()
      while (out.length && !out[out.length - 1].trim()) out.pop()
      return out.slice(-MAX)
    }

    // 扫可能的侧边栏容器，连结构和样本一起带回去，供后续锁定选择器。
    const scanPanels = () => {
      const hits = []
      const seen = new Set()
      const nodes = document.querySelectorAll('[class*="sidebar"],[class*="rightbar"],[class*="panel"],[class*="terminal"],[class*="browser"],[id*="sidebar"],[id*="panel"]')
      for (const el of nodes) {
        if (seen.has(el) || el === document.body) continue
        seen.add(el)
        const text = clean(el.innerText || '')
        if (text.length < 40) continue
        hits.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 80),
          chars: text.length,
          sample: text.slice(0, 120).replace(/\n+/g, ' ⏎ '),
        })
        if (hits.length >= 8) break
      }
      return hits
    }

    /** 当前可见会话 id：composer 的祖先节点带这个 data 属性（官方自己也是这么取的）。 */
    const domSessionId = () => {
      try {
        const el = document.querySelector('[data-conversation-session]')
        return el?.getAttribute?.('data-conversation-session') || ''
      } catch { return '' }
    }

    const currentSessionId = () => domSessionId() || state.sessionId

    const post = (payload) => {
      try {
        fetch('/plugins/terminal-context/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId(), ...payload }),
        }).catch(() => {})
      } catch { /* 静默 */ }
    }

    let lastKey = ''

    /** 面板没开时尝试展开右侧栏；layout 是已确认存在的客户端服务。 */
    const state2 = { probe: 'panel-closed' }

    let lastCtx = null
    const push = () => {
      try {
        const sid = currentSessionId()
        if (!sid || !isShared(sid)) return
        const lines = readTerminal()
        const panelOpen = lines !== null
        const panels = scanPanels()
        const key = JSON.stringify([currentSessionId(), panelOpen, lines && lines.slice(-5), panels.map((p) => p.cls + p.chars)])
        if (key === lastKey) return
        lastKey = key
        post({
          share: true,
          panelOpen,
          lines: lines || [],
          truncated: !!(lines && lines.length >= MAX),
          diag: panels.length ? { panels } : null,
          probe: state2.probe || undefined,
        })
      } catch { /* 静默 */ }
    }

    const setShare = (sessionId, next) => {
      markShared(sessionId, next)
      lastKey = ''
      if (next) push()
      else post({ share: false, sessionId, lines: [] })   // 关掉即清空该会话的 Host 缓存
      notify()
    }

    function ShareButton(props) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const fn = () => force((v) => v + 1)
        subscribers.add(fn)
        return () => subscribers.delete(fn)
      }, [])
      if (typeof props?.sessionId === 'string' && props.sessionId !== '') state.sessionId = props.sessionId
      const on = isShared(props?.sessionId ?? '')
      return h('button', {
        type: 'button',
        title: on
          ? '正在把侧边栏终端共享给 Agent（每步可见 + 异常时主动提醒）。点击停止。'
          : '把侧边栏终端共享给 Agent：它能看到当前屏幕，并在报错/等待输入时主动提醒。',
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); setShare(props?.sessionId ?? '', !on) },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          height: '24px', padding: '0 8px', marginRight: '4px',
          borderRadius: '6px', cursor: 'pointer',
          fontSize: '12px', lineHeight: 1,
          border: '1px solid ' + (on ? 'var(--dsw-alias-border-l2, #4a4a52)' : 'transparent'),
          background: on ? 'var(--dsw-alias-bg-layer-2, #2a2a30)' : 'transparent',
          color: on ? 'var(--dsw-alias-label-primary, #e6e6e9)' : 'var(--dsw-alias-label-secondary, #9a9aa2)',
        },
        'aria-pressed': on ? 'true' : 'false',
      }, [
        h('span', { key: 'dot', style: { fontSize: '10px', color: on ? '#43b581' : 'inherit' } }, on ? '●' : '○'),
        h('span', { key: 'label' }, '共享终端'),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        lastCtx = ctx
        try {
          ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
            name: 'conversation.input.left',
            id: 'terminal-context-share',
            order: 6,
          }, (props) => h(ShareButton, props)))
        } catch { /* 没有 slots 就只是没有开关，不会拖垮界面 */ }

        try {
          ctx.effect(() => {
            const first = setTimeout(() => {
              const sid = currentSessionId()
              if (sid && isShared(sid)) push()
              else if (sid) post({ share: false, sessionId: sid, lines: [] })
            }, 1200)
            const timer = setInterval(push, 2000)
            return () => { clearTimeout(first); clearInterval(timer) }
          })
        } catch { /* ignore */ }
      },
    }
  },
})
