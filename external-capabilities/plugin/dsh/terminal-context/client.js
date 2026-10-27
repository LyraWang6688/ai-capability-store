/**
 * 界面侧 · 发送终端（v0.6.0）
 *
 * 没有常驻监听、没有心跳、没有自动上报：用户点一下「发送终端」，才抓当前可见的
 * 最后 20 行发给 Host，Host 把它作为一条消息交给该会话的 Agent。
 * 也就是说：**什么时候把终端交给 AI，由人决定。**
 *
 * 三个硬约束沿用 v0.1 的教训：
 *   inject 只声明 slots   slots 是确定存在的客户端服务（0.5.1 踩过 ctx.get 拿不到的坑）
 *   全部 try/catch        读失败只是"这次没发出去"，不白屏
 *   只读                 不点击终端、不输入
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-terminal-context',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const SEND_LINES = 20

    const clean = (t) => (t || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '')

    const readTerminal = (limit) => {
      const rows = document.querySelectorAll('.xterm-rows > div')
      if (!rows.length) return null
      const out = []
      for (const r of rows) out.push(clean(r.textContent))
      while (out.length && !out[0].trim()) out.shift()
      while (out.length && !out[out.length - 1].trim()) out.pop()
      return out.slice(-limit)
    }

    const currentSessionId = () => {
      try {
        const el = document.querySelector('[data-conversation-session]')
        return el?.getAttribute?.('data-conversation-session') || ''
      } catch { return '' }
    }

    function SendButton(props) {
      const [hint, setHint] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const flash = (text) => {
        setHint(text)
        window.setTimeout(() => setHint(''), 1800)
      }

      const send = async () => {
        if (busy) return
        const lines = readTerminal(SEND_LINES)
        if (lines === null || lines.length === 0) {
          flash('终端没打开')
          return
        }
        const sessionId = currentSessionId() || (typeof props?.sessionId === 'string' ? props.sessionId : '')
        if (sessionId === '') {
          flash('拿不到会话 id')
          return
        }
        setBusy(true)
        try {
          const response = await fetch('/plugins/terminal-context/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, lines }),
          })
          const result = await response.json().catch(() => ({}))
          flash(result?.ok ? `已发送 ${lines.length} 行` : (result?.message || '发送失败'))
        } catch {
          flash('发送失败')
        } finally {
          setBusy(false)
        }
      }

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, [
        h('button', {
          key: 'btn',
          type: 'button',
          title: '把右侧边栏终端当前可见的最后 20 行发给 AI（什么时候发由你决定）',
          onClick: (event) => { event.preventDefault(); event.stopPropagation(); send() },
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            height: '24px', padding: '0 8px', marginRight: '4px',
            borderRadius: '6px', cursor: busy ? 'progress' : 'pointer',
            fontSize: '12px', lineHeight: 1,
            border: '1px solid transparent',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary, #9a9aa2)',
          },
        }, [
          h('span', { key: 'icon' }, '⇪'),
          h('span', { key: 'label' }, '发送终端'),
        ]),
        hint === '' ? null : h('span', {
          key: 'hint',
          style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #9a9aa2)' },
        }, hint),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
            name: 'conversation.input.left',
            id: 'terminal-context-send',
            order: 6,
          }, (props) => h(SendButton, props)))
        } catch { /* 没有 slots 就只是没有按钮，不会拖垮界面 */ }
      },
    }
  },
})
