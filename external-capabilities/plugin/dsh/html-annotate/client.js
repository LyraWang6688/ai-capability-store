/**
 * Client half of dsh-html-annotate.
 *
 * 输入框左侧按钮 → 全屏批注面板 → 本地 HTML 预览（运行时注入批注脚本）。
 * 批注提交后，把结构化批注写进当前输入框并触发发送，让当前会话的 Agent 收到。
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-html-annotate',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROOT = 'dsh-html-annotate'
    const CSS = `      .${ROOT}-backdrop{position:fixed;inset:0;z-index:2147483000;background:transparent;pointer-events:none}
      .${ROOT}-panel{position:fixed;width:min(920px,62vw);height:min(780px,90vh);background:var(--dsw-alias-bg-layer-1,#1f1f23);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);border-radius:14px;overflow:hidden;
        box-shadow:0 18px 60px rgba(0,0,0,.45);display:flex;flex-direction:column;
        font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--dsw-alias-label-primary,#e6e6e9);pointer-events:auto;
        resize:both;min-width:360px;min-height:260px;max-width:98vw;max-height:96vh}
      .${ROOT}-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a40);cursor:move;user-select:none}
      .${ROOT}-title{font-weight:600;font-size:14px;flex:1;min-width:0}
      .${ROOT}-select{all:unset;box-sizing:border-box;height:30px;padding:0 8px;border-radius:7px;font-size:12px;
        background:var(--dsw-alias-bg-layer-2,#2f2f34);border:1px solid var(--dsw-alias-border-l1,#3a3a40);color:inherit;max-width:360px}
      .${ROOT}-close{all:unset;cursor:pointer;width:30px;height:30px;border-radius:7px;text-align:center;line-height:30px;font-size:18px;color:var(--dsw-alias-label-secondary,#9aa0aa)}
      .${ROOT}-close:hover{background:var(--dsw-alias-bg-layer-2,#2f2f34)}
      .${ROOT}-refresh{all:unset;cursor:pointer;height:28px;padding:0 10px;border-radius:999px;font-size:12px;color:var(--primary,#185abd);background:var(--primary-soft,#eef4ff)}
      .${ROOT}-min{all:unset;cursor:pointer;width:30px;height:30px;border-radius:7px;text-align:center;line-height:30px;font-size:16px;color:var(--dsw-alias-label-secondary,#9aa0aa)}
      .${ROOT}-min:hover{background:var(--dsw-alias-bg-layer-2,#2f2f34)}
      .${ROOT}-restore{position:fixed;right:22px;bottom:92px;z-index:2147483001;border:1px solid var(--dsw-alias-border-l1,#3a3a40);border-radius:999px;
        background:var(--dsw-alias-bg-layer-1,#1f1f23);color:var(--dsw-alias-label-primary,#e6e6e9);padding:9px 14px;
        font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer}
      .${ROOT}-urlrow{display:flex;gap:8px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a40)}
      .${ROOT}-urlinput{all:unset;box-sizing:border-box;flex:1;height:30px;padding:0 9px;border-radius:7px;font-size:12px;
        background:var(--dsw-alias-bg-layer-2,#2f2f34);border:1px solid var(--dsw-alias-border-l1,#3a3a40);color:inherit}
      .${ROOT}-frame{flex:1;width:100%;border:0;background:#fff}
      .${ROOT}-hint{padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l1,#3a3a40);font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0aa)}
    `

    let open = false
    let actions = null
    let sessionId = ''
    let previewSeed = ''
    const listeners = new Set()
    const emit = () => { for (const fn of listeners) fn() }
    const setOpen = (value) => { open = value; emit() }
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const snapshot = () => open

    function useOpen() {
      const [value, setValue] = React.useState(snapshot())
      React.useEffect(() => subscribe(() => setValue(snapshot())), [])
      return value
    }

    function InputButton(props) {
      React.useEffect(() => {
        const sid = String(props.sessionId || '')
        if (!sid) return
        fetch(`/plugins/html-annotate/config?sessionId=${encodeURIComponent(sid)}`)
          .then((r) => r.json())
          .then((body) => {
            if (!body || !body.previewUrl) return
            previewSeed = body.previewUrl
          }).catch(() => {})
      }, [props.sessionId])

      React.useEffect(() => {
        const sid = String(props.sessionId || '')
        if (!sid) return
        let seen = 0
        let cancelled = false
        const tick = async () => {
          if (cancelled || open) return
          try {
            const response = await fetch(`/plugins/html-annotate/pending?since=${seen}&sessionId=${encodeURIComponent(sid)}`)
            const body = await response.json()
            if (!body || !body.open || !body.at) return
            seen = body.at
            await fetch('/plugins/html-annotate/pending/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) }).catch(() => {})
            actions = props.inputActions || null
            sessionId = sid
            setOpen(true)
          } catch { /* ignore */ }
        }
        const timer = setInterval(tick, 1200)
        return () => { cancelled = true; clearInterval(timer) }
      }, [props.sessionId])
      return null
    }

    function Overlay() {
      const visible = useOpen()
      const [previewUrl, setPreviewUrl] = React.useState(previewSeed)
      const [previewToken, setPreviewToken] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [box, setBox] = React.useState(() => {
        const width = Math.min(920, Math.floor(window.innerWidth * 0.62))
        const height = Math.min(780, Math.floor(window.innerHeight * 0.9))
        return { left: Math.max(12, Math.floor((window.innerWidth - width) / 2)), top: Math.max(12, Math.floor((window.innerHeight - height) / 2)), width, height }
      })
      const panelRef = React.useRef(null)
      const [minimized, setMinimized] = React.useState(false)
      const [reloadNonce, setReloadNonce] = React.useState(0)
      const [reloadAvailable, setReloadAvailable] = React.useState(false)
      const dirtyRef = React.useRef(false)
      const versionRef = React.useRef('')
      const frameRef = React.useRef(null)

      React.useEffect(() => { if (visible) setMinimized(false) }, [visible])

      React.useEffect(() => {
        const node = panelRef.current
        if (!visible || !node || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          const rect = entries[0] && entries[0].contentRect
          if (!rect) return
          setBox((current) => (
            Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
              ? current
              : { ...current, width: Math.round(rect.width), height: Math.round(rect.height) }
          ))
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [visible])

      React.useEffect(() => {
        if (!visible) return
        const urlKey = `dsh-html-annotate:url:${sessionId}`
        if (previewSeed) setPreviewUrl(previewSeed)
        else { try { setPreviewUrl(localStorage.getItem(urlKey) || '') } catch { /* ignore */ } }
      }, [visible])

      React.useEffect(() => {
        if (!visible || !previewUrl) { setPreviewToken(''); return }
        let cancelled = false
        setPreviewToken('')
        setStatus('正在启动本地预览…')
        fetch('/plugins/html-annotate/preview/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: previewUrl, sessionId }),
        }).then((r) => r.json()).then((body) => {
          if (cancelled) return
          if (!body.ok) throw new Error(body.error || 'register_failed')
          setPreviewToken(body.token)
          setStatus('')
        }).catch((error) => { if (!cancelled) setStatus('预览启动失败：' + error.message) })
        return () => { cancelled = true }
      }, [visible, previewUrl])

      React.useEffect(() => {
        if (!visible) return
        const notifySession = (file, annotations) => {
          if (!annotations.length) return
          const lines = annotations.map((item, index) => `${index + 1}. ${item.selector}：${item.comment}`)
          const message = [`请按 HTML 批注修改源码：${file}`, ...lines, '', '批注 JSON 已写入 sidecar 文件。'].join('\n')
          if (actions && typeof actions.setDraft === 'function') actions.setDraft(message)
          if (actions && typeof actions.submit === 'function') actions.submit()
          setStatus(`已提交 ${annotations.length} 条批注，已发送到当前会话`)
        }
        const reply = (event, ok, message) => {
          try { event.source?.postMessage({ type: 'html-annotate:saved', ok, message }, '*') } catch { /* ignore */ }
        }
        const submitAndNotify = (event, data) => {
          fetch('/plugins/html-annotate/annotations/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: data.file, sessionId: data.sessionId || sessionId }),
          }).then((r) => r.json()).then((body) => {
            if (!body.ok) throw new Error(body.error || 'submit_failed')
            const submitted = Array.isArray(body.submitted) ? body.submitted : []
            notifySession(data.file, submitted)
            reply(event, true, `已提交 ${submitted.length || body.marked || 0} 条批注`)
          }).catch((error) => reply(event, false, error.message))
        }
        const onMessage = (event) => {
          const data = event.data
          if (!data) return
          if (data.type === 'html-annotate:dirty') { dirtyRef.current = Boolean(data.dirty); return }
          if (data.type === 'html-annotate:save') {
            const annotation = { ...(data.annotation || {}), file: data.file, sessionId: data.sessionId || sessionId }
            fetch('/plugins/html-annotate/annotations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(annotation),
            }).then((r) => r.json()).then((body) => {
              if (!body.ok) throw new Error(body.error || 'save_failed')
              return fetch('/plugins/html-annotate/annotations/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: data.file, sessionId: data.sessionId || sessionId }),
              })
            }).then((r) => r.json()).then((body) => {
              if (!body.ok) throw new Error(body.error || 'submit_failed')
              const submitted = Array.isArray(body.submitted) ? body.submitted : []
              notifySession(data.file, submitted)
              reply(event, true, `已提交 ${submitted.length || body.marked || 0} 条批注`)
            }).catch((error) => reply(event, false, error.message))
            return
          }
          if (data.type === 'html-annotate:submit') return submitAndNotify(event, data)
          if (data.type !== 'html-annotate:submitted') return
          const annotations = Array.isArray(data.annotations) ? data.annotations : []
          notifySession(data.file, annotations)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [visible])

      if (!visible) return null
      return h(React.Fragment, null,
        h('div', { className: `${ROOT}-backdrop`, style: minimized ? { display: 'none' } : undefined },
        h('div', { ref: panelRef, className: `${ROOT}-panel`, style: { left: box.left, top: box.top, width: box.width, height: box.height } },
          h('div', { className: `${ROOT}-head`, onMouseDown: (event) => {
            if (event.target.closest('button,input,select')) return
            const start = { x: event.clientX, y: event.clientY, left: box.left, top: box.top }
            const move = (ev) => setBox((current) => ({ ...current, left: Math.max(0, Math.min(window.innerWidth - 120, start.left + ev.clientX - start.x)), top: Math.max(0, Math.min(window.innerHeight - 60, start.top + ev.clientY - start.y)) }))
            const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
            window.addEventListener('mousemove', move)
            window.addEventListener('mouseup', up)
          } },
            h('div', { className: `${ROOT}-title` }, 'HTML 批注'),
            h('button', { type: 'button', className: `${ROOT}-refresh`, title: '放到右半屏', onClick: (event) => { event.stopPropagation(); const half = Math.floor(window.innerWidth / 2); setBox({ left: half, top: 8, width: Math.max(360, half - 12), height: window.innerHeight - 16 }) } }, '右半屏'),
            h('button', { type: 'button', className: `${ROOT}-refresh`, title: '刷新页面', onClick: () => { setReloadNonce((value) => value + 1); setStatus('已刷新页面') } }, '刷新'),
            h('button', { type: 'button', className: `${ROOT}-min`, title: '最小化，继续对话', onClick: () => setMinimized(true) }, '—'),
            h('button', { type: 'button', className: `${ROOT}-close`, onClick: () => setOpen(false) }, '×'),
          ),
          h('div', { className: `${ROOT}-urlrow` },
            h('input', {
              className: `${ROOT}-urlinput`,
              placeholder: '本地预览 URL，例如 http://127.0.0.1:5054/workbench',
              value: previewUrl,
              onChange: (event) => {
                const next = event.target.value
                setPreviewUrl(next)
                try { localStorage.setItem(`dsh-html-annotate:url:${sessionId}`, next) } catch { /* ignore */ }
              },
            }),
          ),
          previewToken ? h('iframe', {
            key: reloadNonce,
            ref: frameRef,
            className: `${ROOT}-frame`,
            title: 'HTML 批注预览',
            src: `/plugins/html-annotate/preview?pid=${encodeURIComponent(previewToken)}`,
          }) : h('div', { className: `${ROOT}-hint` }, previewUrl ? '正在启动本地预览…' : '请先填写本地预览 URL。'),
          h('div', { className: `${ROOT}-hint` }, status || (previewUrl ? `本地预览：${previewUrl}` : '填写本地预览 URL 后加载页面。')),
        ),
        ),
        minimized ? h('button', { type: 'button', className: `${ROOT}-restore`, onClick: () => setMinimized(false) }, '继续批注') : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.plugin = ROOT
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'html-annotate: style')

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: ROOT,
          order: 7,
        }, InputButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: ROOT,
          order: 950,
        }, Overlay))
      },
    }
  },
})
