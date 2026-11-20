/**
 * Client half of the pending-send queue.
 *
 * One tab type in the right sidebar. Rows live in this plugin's own host store
 * (/plugins/pending-queue/*), keyed by the session the tab belongs to, so two
 * conversations never share one queue.
 *
 * Pushing a row into the chat uses the composer's public input actions:
 * setDraft() puts the text in the input box exactly as if it had been typed,
 * and submit() sends it. While the agent is running, submit() queues the
 * message the same way a typed message is queued, so a push never interrupts
 * the current task.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-pending-queue',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const PKG = '@lyra_wang/dsh-pending-queue'
    /** The tab kind this plugin owns; unique in the tab registry. */
    const KIND = 'pending-queue'
    /** Locale namespace for every string this tab draws. */
    const NS = 'pendingQueue'
    /** The plugin's own browser routes, registered by the host half. */
    const STATE_URL = '/plugins/pending-queue/state'
    const ACTION_URL = '/plugins/pending-queue/action'
    const ROOT = 'dsh-pending-queue'

    /* --------------------------------- copy --------------------------------- */

    const ZH = {
      'tab.title': '待发送',
      'tab.description': '先攒着，等上一件事做完再推',
      'queue.title': '待发送队列',
      'queue.pending': '{n} 条待发',
      'queue.sent': '{n} 条已发',
      'queue.refresh': '刷新',
      'queue.clearSent': '清空已发送',
      'empty.title': '队列是空的',
      'empty.body': '把脑子里冒出来的想法先记在这里。等手上的活告一段落，再决定推哪一条。',
      'input.placeholder': '记一条想法…',
      'input.hint': 'Cmd/Ctrl + Enter 存下。发送时内容进输入框并直接提交；运行中的会话会把它排进队列。',
      'action.save': '存下',
      'action.send': '发送',
      'action.fill': '填入',
      'action.edit': '编辑',
      'action.remove': '删除',
      'action.up': '上移',
      'action.down': '下移',
      'action.restore': '取回',
      'action.cancel': '取消',
      'action.saveEdit': '保存',
      'status.sent': '已发送',
      'notice.filled': '已填入输入框',
      'notice.sent': '已推送',
      'error.network': '连不上插件接口',
      'error.noComposer': '这个位置还拿不到会话输入框，换到聊天页面再试',
      'error.empty': '先写点什么',
      'time.justNow': '刚刚',
    }

    const EN = {
      'tab.title': 'Pending',
      'tab.description': 'Hold ideas, push them when the last task is done',
      'queue.title': 'Pending queue',
      'queue.pending': '{n} to send',
      'queue.sent': '{n} sent',
      'queue.refresh': 'Refresh',
      'queue.clearSent': 'Clear sent',
      'empty.title': 'Nothing queued',
      'empty.body': 'Jot ideas down here as they arrive. When the current task is finished, decide which one to push.',
      'input.placeholder': 'Jot one idea…',
      'input.hint': 'Cmd/Ctrl + Enter saves. Sending puts the text in the composer and submits it; a running session queues it.',
      'action.save': 'Save',
      'action.send': 'Send',
      'action.fill': 'Fill',
      'action.edit': 'Edit',
      'action.remove': 'Delete',
      'action.up': 'Move up',
      'action.down': 'Move down',
      'action.restore': 'Restore',
      'action.cancel': 'Cancel',
      'action.saveEdit': 'Save',
      'status.sent': 'Sent',
      'notice.filled': 'Filled into the composer',
      'notice.sent': 'Pushed',
      'error.network': 'Cannot reach the plugin route',
      'error.noComposer': 'The composer is not reachable from here; open the chat view and retry',
      'error.empty': 'Write something first',
      'time.justNow': 'just now',
    }

    /* -------------------------------- helpers -------------------------------- */

    function fallbackCopy(key) {
      return ZH[key] !== undefined ? ZH[key] : key
    }

    function translator(props) {
      return typeof props.t === 'function' ? props.t : fallbackCopy
    }

    function count(t, key, n) {
      return t(key).replace('{n}', String(n))
    }

    let relativeFormatter
    function relativeTime(iso, t) {
      const at = Date.parse(iso || '')
      if (Number.isNaN(at)) return ''
      const diff = Date.now() - at
      if (diff < 60_000) return t('time.justNow')
      if (relativeFormatter === undefined) {
        try {
          relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
        } catch {
          relativeFormatter = null
        }
      }
      const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000]]
      for (const pair of units) {
        if (diff >= pair[1]) {
          const value = Math.floor(diff / pair[1])
          if (relativeFormatter !== null) {
            try {
              return relativeFormatter.format(-value, pair[0])
            } catch {
              /* fall through to a plain label */
            }
          }
          return String(value) + ' ' + pair[0]
        }
      }
      return t('time.justNow')
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function readJson(response) {
      try {
        return await response.json()
      } catch {
        return {}
      }
    }

    async function fetchQueue(sessionId) {
      const response = await fetch(STATE_URL + '?sessionId=' + encodeURIComponent(sessionId), {
        headers: { accept: 'application/json' },
      })
      const payload = await readJson(response)
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.message || ('HTTP ' + response.status))
      }
      return payload.queue || { items: [] }
    }

    async function postAction(sessionId, body) {
      const response = await fetch(ACTION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...body }),
      })
      const payload = await readJson(response)
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.message || ('HTTP ' + response.status))
      }
      return payload.queue || { items: [] }
    }

    /* -------------------------------- artwork -------------------------------- */

    /** One glyph for the guide card and the tab chip. */
    function QueueGlyph(props) {
      const size = props && props.size ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      }, [
        h('rect', { key: 'a', x: 1.6, y: 2.2, width: 9.6, height: 9.2, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { key: 'b', d: 'M4 5.4h4.8M4 8.4h3.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'c', d: 'M11.2 12.6l2.4-2.2-2.4-2.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ])
    }

    /* --------------------------------- styles -------------------------------- */

    const CSS = [
      '.dsh-pending-queue{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;',
      '  color:var(--dsw-alias-label-primary,#e8e8ea);',
      '  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}',
      '.dsh-pending-queue-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px 8px}',
      '.dsh-pending-queue-title{flex:none;font-size:14px;font-weight:600}',
      '.dsh-pending-queue-counts{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2);',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pending-queue-ghost{all:unset;cursor:pointer;flex:none;display:inline-flex;align-items:center;gap:4px;',
      '  height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm,8px);font-size:12px;',
      '  color:var(--dsw-alias-label-secondary,#b9b9c0)}',
      '.dsh-pending-queue-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14);color:var(--dsw-alias-label-primary,#e8e8ea)}',
      '.dsh-pending-queue-ghost[disabled]{opacity:.45;cursor:default}',
      '.dsh-pending-queue-compose{flex:none;margin:0 10px 10px;padding:8px 10px;border-radius:var(--dsw-radius-md,12px);',
      '  background:var(--dsw-alias-bg-layer-1,#1f1f22);border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a)}',
      '.dsh-pending-queue-compose:focus-within{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff)}',
      '.dsh-pending-queue-input{box-sizing:border-box;width:100%;min-height:52px;max-height:160px;resize:vertical;',
      '  border:0;outline:0;background:transparent;color:inherit;font:inherit;padding:0}',
      '.dsh-pending-queue-input::placeholder{color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-composeFoot{display:flex;align-items:center;gap:8px;margin-top:6px}',
      '.dsh-pending-queue-hint{flex:1;min-width:0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-primary{all:unset;cursor:pointer;flex:none;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);',
      '  font-size:12px;background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff);color:#fff}',
      '.dsh-pending-queue-primary[disabled]{opacity:.45;cursor:default}',
      '.dsh-pending-queue-body{flex:1;min-height:0;overflow:auto;padding:0 10px 16px;overscroll-behavior:contain}',
      '.dsh-pending-queue-hintBlock{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#9a9aa2);',
      '  font-size:12.5px;line-height:1.7}',
      '.dsh-pending-queue-hintTitle{display:block;font-size:13.5px;color:var(--dsw-alias-label-secondary,#b9b9c0);margin-bottom:6px}',
      '.dsh-pending-queue-err{margin:8px 12px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);',
      '  border:0.5px solid var(--dsw-alias-state-error-primary,#f56c6c);',
      '  color:var(--dsw-alias-state-error-primary,#f56c6c);font-size:12px}',
      '.dsh-pending-queue-card{position:relative;margin:0 0 10px;padding:10px 12px 8px;border-radius:var(--dsw-radius-md,12px);',
      '  background:var(--dsw-alias-bg-layer-1,#1f1f22);border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a)}',
      '.dsh-pending-queue-card[data-sent="true"]{opacity:.6}',
      '.dsh-pending-queue-text{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55;',
      '  display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}',
      '.dsh-pending-queue-meta{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;',
      '  color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-badge{flex:none;border:0.5px solid var(--dsw-alias-border-l3,#ffffff1f);border-radius:999px;',
      '  padding:0 6px;line-height:15px}',
      '.dsh-pending-queue-acts{display:flex;align-items:center;gap:2px;margin-top:4px;flex-wrap:wrap}',
      '.dsh-pending-queue-act{all:unset;cursor:pointer;height:24px;padding:0 7px;border-radius:var(--dsw-radius-sm,8px);',
      '  font-size:12px;color:var(--dsw-alias-label-secondary,#b9b9c0)}',
      '.dsh-pending-queue-act:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14);color:var(--dsw-alias-label-primary,#e8e8ea)}',
      '.dsh-pending-queue-act[disabled]{opacity:.4;cursor:default}',
      '.dsh-pending-queue-act[data-tone="send"]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff)}',
      '.dsh-pending-queue-edit{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;border-radius:var(--dsw-radius-sm,8px);',
      '  border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a);background:transparent;color:inherit;font:inherit;padding:6px 8px}',
      '.dsh-pending-queue-notice{flex:none;margin:0 12px 6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
    ].join('\n')

    /* -------------------------------- component ------------------------------- */

    function QueueBody(props) {
      const t = translator(props)
      const sessionId = props.sessionId
      const inputActions = props.inputActions

      const [queue, setQueue] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [draft, setDraft] = useState('')
      const [editing, setEditing] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const live = useRef(true)

      useEffect(() => {
        live.current = true
        return () => {
          live.current = false
        }
      }, [])

      const load = useCallback(async (quiet) => {
        if (!sessionId) {
          setLoading(false)
          return
        }
        if (!quiet) setLoading(true)
        try {
          const next = await fetchQueue(sessionId)
          if (!live.current) return
          setQueue(next)
          setError('')
        } catch (failure) {
          if (!live.current) return
          setError(messageOf(failure))
        } finally {
          if (live.current) setLoading(false)
        }
      }, [sessionId])

      useEffect(() => {
        load(false)
        const timer = setInterval(() => load(true), 10000)
        const refresh = () => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') load(true)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh)
        }
      }, [load])

      const act = useCallback(async (body) => {
        if (!sessionId) return undefined
        try {
          const next = await postAction(sessionId, body)
          if (live.current) {
            setQueue(next)
            setError('')
          }
          return next
        } catch (failure) {
          if (live.current) setError(messageOf(failure))
          return undefined
        }
      }, [sessionId])

      const flash = useCallback((text) => {
        setNotice(text)
        setTimeout(() => {
          if (live.current) setNotice((current) => (current === text ? '' : current))
        }, 2200)
      }, [])

      const saveDraft = useCallback(async () => {
        const text = draft.trim()
        if (text === '') {
          setError(t('error.empty'))
          return
        }
        setBusy('add')
        const next = await act({ action: 'add', text })
        if (live.current) {
          setBusy('')
          if (next) setDraft('')
        }
      }, [draft, act, t])

      /** Push one row into the composer, standing in for the user's own typing. */
      const push = useCallback(async (item, mode) => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') {
          setError(t('error.noComposer'))
          return
        }
        setBusy(item.id)
        setError('')
        try {
          inputActions.setDraft(item.text)
          if (mode === 'send') {
            if (typeof inputActions.submit !== 'function') {
              setError(t('error.noComposer'))
              return
            }
            inputActions.submit()
            flash(t('notice.sent'))
            await act({ action: 'markSent', id: item.id })
          } else {
            flash(t('notice.filled'))
          }
        } finally {
          if (live.current) setBusy('')
        }
      }, [inputActions, act, flash, t])

      const startEdit = useCallback((item) => {
        setEditing({ id: item.id, text: item.text })
      }, [])

      const saveEdit = useCallback(async () => {
        if (editing === null) return
        const text = editing.text.trim()
        if (text === '') {
          setError(t('error.empty'))
          return
        }
        setBusy(editing.id)
        const next = await act({ action: 'update', id: editing.id, text })
        if (live.current) {
          setBusy('')
          if (next) setEditing(null)
        }
      }, [editing, act, t])

      const items = queue && Array.isArray(queue.items) ? queue.items : []
      const pending = items.filter((item) => item.sentAt === null || item.sentAt === undefined).length
      const sent = items.length - pending

      const onComposeKey = useCallback((event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void saveDraft()
        }
      }, [saveDraft])

      const countLabel = [count(t, 'queue.pending', pending), sent > 0 ? count(t, 'queue.sent', sent) : ''].filter(Boolean).join(' · ')

      const children = [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'head', className: ROOT + '-head' }, [
          h('span', { key: 'title', className: ROOT + '-title' }, t('queue.title')),
          h('span', { key: 'counts', className: ROOT + '-counts' }, countLabel),
          sent > 0
            ? h('button', {
              key: 'clear',
              type: 'button',
              className: ROOT + '-ghost',
              onClick: () => { void act({ action: 'clearSent' }) },
            }, t('queue.clearSent'))
            : null,
          h('button', {
            key: 'refresh',
            type: 'button',
            className: ROOT + '-ghost',
            onClick: () => { void load(true) },
          }, t('queue.refresh')),
        ]),
        h('div', { key: 'compose', className: ROOT + '-compose' }, [
          h('textarea', {
            key: 'input',
            className: ROOT + '-input',
            value: draft,
            placeholder: t('input.placeholder'),
            rows: 2,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: onComposeKey,
          }),
          h('div', { key: 'foot', className: ROOT + '-composeFoot' }, [
            h('span', { key: 'hint', className: ROOT + '-hint' }, t('input.hint')),
            h('button', {
              key: 'save',
              type: 'button',
              className: ROOT + '-primary',
              disabled: busy === 'add' || draft.trim() === '',
              onClick: () => { void saveDraft() },
            }, t('action.save')),
          ]),
        ]),
        notice !== '' ? h('div', { key: 'notice', className: ROOT + '-notice', role: 'status' }, notice) : null,
        error !== '' ? h('div', { key: 'err', className: ROOT + '-err', role: 'alert' }, error) : null,
        h('div', { key: 'body', className: ROOT + '-body' },
          loading && items.length === 0
            ? [h('div', { key: 'loading', className: ROOT + '-hintBlock' }, '…')]
            : items.length === 0
              ? [h('div', { key: 'empty', className: ROOT + '-hintBlock' }, [
                h('span', { key: 'title', className: ROOT + '-hintTitle' }, t('empty.title')),
                h('span', { key: 'body' }, t('empty.body')),
              ])]
              : items.map((item, index) => renderRow(item, index))),
      ]

      function renderRow(item, index) {
        const isEditing = editing !== null && editing.id === item.id
        const isSent = item.sentAt !== null && item.sentAt !== undefined
        const isBusy = busy === item.id
        const actions = []
        if (!isEditing && !isSent) {
          actions.push(h('button', {
            key: 'send',
            type: 'button',
            className: ROOT + '-act',
            'data-tone': 'send',
            disabled: isBusy,
            onClick: () => { void push(item, 'send') },
          }, t('action.send')))
          actions.push(h('button', {
            key: 'fill',
            type: 'button',
            className: ROOT + '-act',
            disabled: isBusy,
            onClick: () => { void push(item, 'fill') },
          }, t('action.fill')))
          actions.push(h('button', {
            key: 'edit',
            type: 'button',
            className: ROOT + '-act',
            onClick: () => startEdit(item),
          }, t('action.edit')))
        }
        if (isSent) {
          actions.push(h('button', {
            key: 'restore',
            type: 'button',
            className: ROOT + '-act',
            onClick: () => { void act({ action: 'restore', id: item.id }) },
          }, t('action.restore')))
        }
        if (!isEditing) {
          actions.push(h('button', {
            key: 'up',
            type: 'button',
            className: ROOT + '-act',
            disabled: index === 0,
            'aria-label': t('action.up'),
            onClick: () => { void act({ action: 'move', id: item.id, direction: 'up' }) },
          }, '↑'))
          actions.push(h('button', {
            key: 'down',
            type: 'button',
            className: ROOT + '-act',
            disabled: index === items.length - 1,
            'aria-label': t('action.down'),
            onClick: () => { void act({ action: 'move', id: item.id, direction: 'down' }) },
          }, '↓'))
          actions.push(h('button', {
            key: 'remove',
            type: 'button',
            className: ROOT + '-act',
            onClick: () => { void act({ action: 'remove', id: item.id }) },
          }, t('action.remove')))
        }

        return h('div', {
          key: item.id,
          className: ROOT + '-card',
          'data-sent': isSent ? 'true' : 'false',
        }, [
          isEditing
            ? h('div', { key: 'editing' }, [
              h('textarea', {
                key: 'ta',
                className: ROOT + '-edit',
                value: editing.text,
                rows: 3,
                onChange: (event) => setEditing({ id: item.id, text: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void saveEdit()
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditing(null)
                  }
                },
              }),
              h('div', { key: 'acts', className: ROOT + '-acts' }, [
                h('button', {
                  key: 'save',
                  type: 'button',
                  className: ROOT + '-act',
                  'data-tone': 'send',
                  disabled: isBusy,
                  onClick: () => { void saveEdit() },
                }, t('action.saveEdit')),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: ROOT + '-act',
                  onClick: () => setEditing(null),
                }, t('action.cancel')),
              ]),
            ])
            : h('div', { key: 'text', className: ROOT + '-text' }, item.text),
          h('div', { key: 'meta', className: ROOT + '-meta' }, [
            h('span', { key: 'time' }, relativeTime(item.createdAt, t)),
            isSent ? h('span', { key: 'sent', className: ROOT + '-badge' }, t('status.sent')) : null,
          ]),
          h('div', { key: 'acts', className: ROOT + '-acts' }, actions),
        ])
      }

      return h('div', { className: ROOT }, children)
    }

    /** The tab chip: one glyph and the localized type name. */
    function QueueTitle(props) {
      const t = translator(props)
      return h(React.Fragment, null, [
        h('span', { key: 'icon', style: { display: 'inline-flex', marginInlineEnd: 6 } }, h(QueueGlyph, { size: 14 })),
        h('span', { key: 'label' }, t('tab.title')),
      ])
    }

    /* ---------------------------------- apply --------------------------------- */

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale'],
      apply(ctx) {
        const tr = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'pending-queue: dictionaries')

        const definition = {
          id: PKG,
          kind: KIND,
          priority: 'extension',
          title: () => tr('tab.title'),
          guide: [{
            id: 'queue',
            order: 45,
            title: () => tr('tab.title'),
            description: () => tr('tab.description'),
            icon: QueueGlyph,
          }],
        }

        ctx.effect(() => {
          const disposers = []

          disposers.push(ctx.sidebarRightTabs.register(definition))
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: PKG,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          }, QueueBody)))
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: PKG,
            locale: NS,
          }, QueueTitle)))

          return () => {
            for (let index = disposers.length - 1; index >= 0; index -= 1) {
              try {
                disposers[index]()
              } catch {
                /* one failed disposer must not keep the others registered */
              }
            }
          }
        }, 'pending-queue: tab')
      },
    }
  },
})