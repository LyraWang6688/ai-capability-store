/**
 * Client half of dsh-html-annotate.
 *
 * Chrome-only: the plugin no longer renders a DSH annotation panel.
 * This zero-UI slot exists only to poll Chrome annotation submissions and
 * inject them into the current conversation through inputActions.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-html-annotate',
  factory(require) {
    const React = require('react')

    function AnnotationBridge(props) {
      React.useEffect(() => {
        const sessionId = String(props.sessionId || '')
        const actions = props.inputActions
        if (!sessionId || !actions || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') return undefined
        let cancelled = false
        let busy = false
        const tick = async () => {
          if (cancelled || busy) return
          busy = true
          try {
            const response = await fetch(`/plugins/html-annotate/pending-annotations?sessionId=${encodeURIComponent(sessionId)}`)
            const body = await response.json()
            const annotations = Array.isArray(body.annotations) ? body.annotations : []
            if (!annotations.length) return
            const file = annotations[0].file || '原型页面'
            const lines = annotations.map((item, index) => `${index + 1}. ${item.selector}：${item.comment}`)
            actions.setDraft([`请按 HTML 批注修改源码：${file}`, ...lines, '', '批注 JSON 已写入 sidecar 文件。'].join('\n'))
            await new Promise((resolve) => setTimeout(resolve, 150))
            actions.submit()
            await fetch('/plugins/html-annotate/pending-annotations/ack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            }).catch(() => {})
          } catch { /* next tick retries */ } finally {
            busy = false
          }
        }
        const timer = setInterval(tick, 1000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [props.sessionId, props.inputActions])
      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-html-annotate',
          order: 7,
        }, AnnotationBridge))
      },
    }
  },
})
