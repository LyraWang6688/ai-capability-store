/**
 * Client half of the quick-commands plugin.
 *
 * One compact button in the composer tool row (conversation.input.left).
 * Clicking it grows a panel upward out of the composer: your saved snippets, a
 * search box, and a small editor. Clicking a row inserts the snippet through
 * inputActions (undoable text, never a send); the small send action sets the
 * draft and submits it.
 *
 * The list is global - every conversation shows the same one - and lives in the
 * host half's store.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-quick-commands',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'quickCommands'
    const STATE_URL = '/plugins/quick-commands/state'
    const ACTION_URL = '/plugins/quick-commands/action'
    const ROOT = 'dsh-quick-commands'

    const ZH = {
      'button.label': '常用',
      'button.title': '常用指令',
      'panel.title': '常用指令',
      'panel.new': '新建',
      'panel.search': '搜索标题或内容',
      'panel.empty': '还没有常用指令。点「新建」把常说的话存下来。',
      'panel.noMatch': '没有匹配的指令',
      'panel.loading': '读取中…',
      'action.send': '发送',
      'action.edit': '编辑',
      'action.remove': '删除',
      'action.save': '保存',
      'action.cancel': '取消',
      'editor.newTitle': '新建常用指令',
      'editor.editTitle': '编辑常用指令',
      'editor.titlePlaceholder': '标题，例如：周报模板',
      'editor.textPlaceholder': '内容。发送时会原样进入对话框。',
      'error.empty': '内容不能为空',
      'error.noComposer': '拿不到输入框，换个位置再试',
      'error.remove': '删除失败',
    }

    const EN = {
      'button.label': 'Snippets',
      'button.title': 'Quick commands',
      'panel.title': 'Quick commands',
      'panel.new': 'New',
      'panel.search': 'Search title or content',
      'panel.empty': 'No snippets yet. Press New to save something you type often.',
      'panel.noMatch': 'No matching snippets',
      'panel.loading': 'Loading…',
      'action.send': 'Send',
      'action.edit': 'Edit',
      'action.remove': 'Delete',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'editor.newTitle': 'New snippet',
      'editor.editTitle': 'Edit snippet',
      'editor.titlePlaceholder': 'Title, e.g. weekly report template',
      'editor.textPlaceholder': 'Content. Sent to the conversation as-is.',
      'error.empty': 'Content is required',
      'error.noComposer': 'The composer is not reachable here',
      'error.remove': 'Delete failed',
    }

    function fallbackCopy(key) {
      return ZH[key] !== undefined ? ZH[key] : key
    }

    function translator(props) {
      return typeof props.t === 'function' ? props.t : fallbackCopy
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

    async function fetchList() {
      const response = await fetch(STATE_URL, { headers: { accept: 'application/json' } })
      const payload = await readJson(response)
      if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status))
      return payload.list || { commands: [] }
    }

    async function postAction(body) {
      const response = await fetch(ACTION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await readJson(response)
      if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status))
      return payload.list || { commands: [] }
    }

    const CSS = [
      '.dsh-quick-commands-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:26px;',
      '  padding:0 8px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;font-size:12px;',
      '  color:var(--dsw-alias-label-secondary,#b9b9c0)}',
      '.dsh-quick-commands-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14);color:var(--dsw-alias-label-primary,#e8e8ea)}',
      '.dsh-quick-commands-panel{position:fixed;z-index:60;width:352px;max-height:420px;display:flex;flex-direction:column;',
      '  background:var(--dsw-alias-bg-layer-1,#1f1f22);border:0.5px solid var(--dsw-alias-border-l3,#ffffff1f);',
      '  border-radius:var(--dsw-radius-md,12px);box-shadow:0 12px 32px #00000059;overflow:hidden;',
      '  color:var(--dsw-alias-label-primary,#e8e8ea);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}',
      '.dsh-quick-commands-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l3,#ffffff14)}',
      '.dsh-quick-commands-title{flex:1;font-weight:600;font-size:13px}',
      '.dsh-quick-commands-ghost{all:unset;cursor:pointer;height:22px;padding:0 8px;border-radius:6px;font-size:12px;',
      '  color:var(--dsw-alias-label-secondary,#b9b9c0)}',
      '.dsh-quick-commands-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14);color:var(--dsw-alias-label-primary,#e8e8ea)}',
      '.dsh-quick-commands-search{box-sizing:border-box;width:100%;border:0;outline:0;background:transparent;color:inherit;',
      '  font:inherit;padding:8px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l3,#ffffff14)}',
      '.dsh-quick-commands-body{flex:1;min-height:0;overflow:auto;padding:4px 0}',
      '.dsh-quick-commands-hint{padding:18px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-quick-commands-row{padding:7px 10px;cursor:pointer;border-radius:8px;margin:0 4px}',
      '.dsh-quick-commands-row:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}',
      '.dsh-quick-commands-rowTitle{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-quick-commands-rowText{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9aa2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-quick-commands-rowActs{display:flex;gap:2px;margin-top:2px;opacity:0;transition:opacity .12s}',
      '.dsh-quick-commands-row:hover .dsh-quick-commands-rowActs{opacity:1}',
      '.dsh-quick-commands-act{all:unset;cursor:pointer;height:20px;padding:0 6px;border-radius:5px;font-size:11px;',
      '  color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-quick-commands-act:hover{background:#ffffff17;color:var(--dsw-alias-label-primary,#e8e8ea)}',
      '.dsh-quick-commands-act[data-tone="send"]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff)}',
      '.dsh-quick-commands-err{padding:6px 10px;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#f56c6c)}',
      '.dsh-quick-commands-editor{display:flex;flex-direction:column;gap:6px;padding:8px 10px}',
      '.dsh-quick-commands-input{box-sizing:border-box;width:100%;border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a);',
      '  border-radius:8px;background:transparent;color:inherit;font:inherit;padding:6px 8px;outline:0}',
      '.dsh-quick-commands-text{box-sizing:border-box;width:100%;min-height:96px;max-height:180px;resize:vertical;',
      '  border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a);border-radius:8px;background:transparent;color:inherit;font:inherit;padding:6px 8px;outline:0}',
      '.dsh-quick-commands-editorActs{display:flex;justify-content:flex-end;gap:6px}',
      '.dsh-quick-commands-primary{all:unset;cursor:pointer;height:24px;padding:0 10px;border-radius:8px;font-size:12px;',
      '  background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff);color:#fff}',
      '.dsh-quick-commands-primary[disabled]{opacity:.45;cursor:default}',
    ].join('\n')

    function StarGlyph(props) {
      const size = props && props.size ? props.size : 14
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', {
          key: 'p',
          d: 'M8 1.8l1.9 3.8 4.2.6-3 3 .7 4.2L8 11.4l-3.8 2 .7-4.2-3-3 4.2-.6z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
      ])
    }

    function QuickCommands(props) {
      const t = translator(props)
      const inputActions = props.inputActions
      const [open, setOpen] = useState(false)
      const [list, setList] = useState(null)
      const [query, setQuery] = useState('')
      const [editing, setEditing] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const btnRef = useRef(null)
      const panelRef = useRef(null)

      const load = useCallback(async () => {
        try {
          const next = await fetchList()
          setList(next)
          setError('')
        } catch (failure) {
          setError(messageOf(failure))
        }
      }, [])

      const place = useCallback(() => {
        const node = btnRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        const width = 352
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
        setAnchor({ left, bottom: window.innerHeight - rect.top + 8 })
      }, [])

      const toggle = useCallback(() => {
        setOpen((current) => {
          const next = !current
          if (next) {
            place()
            setEditing(null)
            setQuery('')
            load()
          }
          return next
        })
      }, [load, place])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const panel = panelRef.current
          const button = btnRef.current
          if (panel && panel.contains(event.target)) return
          if (button && button.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onResize = () => place()
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onResize)
        }
      }, [open, place])

      const insert = useCallback((command) => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') {
          setError(t('error.noComposer'))
          return
        }
        const canInsert = typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function'
        if (canInsert && inputActions.insertText(command.text, inputActions.captureInsertion())) {
          setOpen(false)
          return
        }
        inputActions.setDraft(command.text)
        setOpen(false)
      }, [inputActions, t])

      const send = useCallback((command) => {
        if (!inputActions || typeof inputActions.setDraft !== 'function' || typeof inputActions.submit !== 'function') {
          setError(t('error.noComposer'))
          return
        }
        inputActions.setDraft(command.text)
        inputActions.submit()
        setOpen(false)
      }, [inputActions, t])

      const save = useCallback(async () => {
        if (editing === null) return
        const text = editing.text.trim()
        if (text === '') {
          setError(t('error.empty'))
          return
        }
        setBusy(true)
        try {
          const body = editing.id
            ? { action: 'update', id: editing.id, title: editing.title, text }
            : { action: 'add', title: editing.title, text }
          const next = await postAction(body)
          setList(next)
          setEditing(null)
          setError('')
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }, [editing, t])

      const remove = useCallback(async (command) => {
        setBusy(true)
        try {
          const next = await postAction({ action: 'remove', id: command.id })
          setList(next)
          setError('')
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }, [])

      const commands = list && Array.isArray(list.commands) ? list.commands : []
      const needle = query.trim().toLowerCase()
      const visible = needle === ''
        ? commands
        : commands.filter((command) => (command.title + ' ' + command.text).toLowerCase().includes(needle))

      const panel = open && anchor
        ? h('div', {
          key: 'panel',
          ref: panelRef,
          className: ROOT + '-panel',
          style: { left: anchor.left + 'px', bottom: anchor.bottom + 'px' },
        }, [
          h('div', { key: 'head', className: ROOT + '-head' }, [
            h('span', { key: 'title', className: ROOT + '-title' }, t('panel.title')),
            h('button', {
              key: 'new', type: 'button', className: ROOT + '-ghost',
              onClick: () => setEditing({ id: '', title: '', text: '' }),
            }, t('panel.new')),
          ]),
          editing === null
            ? h('input', {
              key: 'search',
              className: ROOT + '-search',
              value: query,
              placeholder: t('panel.search'),
              onChange: (event) => setQuery(event.target.value),
            })
            : null,
          editing !== null
            ? h('div', { key: 'editor', className: ROOT + '-editor' }, [
              h('div', { key: 'et', className: ROOT + '-title', style: { fontSize: '12.5px' } }, editing.id ? t('editor.editTitle') : t('editor.newTitle')),
              h('input', {
                key: 'title',
                className: ROOT + '-input',
                value: editing.title,
                placeholder: t('editor.titlePlaceholder'),
                autoFocus: true,
                onChange: (event) => setEditing({ ...editing, title: event.target.value }),
              }),
              h('textarea', {
                key: 'text',
                className: ROOT + '-text',
                value: editing.text,
                placeholder: t('editor.textPlaceholder'),
                onChange: (event) => setEditing({ ...editing, text: event.target.value }),
              }),
              h('div', { key: 'acts', className: ROOT + '-editorActs' }, [
                h('button', { key: 'cancel', type: 'button', className: ROOT + '-ghost', onClick: () => setEditing(null) }, t('action.cancel')),
                h('button', {
                  key: 'save', type: 'button', className: ROOT + '-primary',
                  disabled: busy || editing.text.trim() === '',
                  onClick: () => { void save() },
                }, t('action.save')),
              ]),
            ])
            : h('div', { key: 'body', className: ROOT + '-body' },
              list === null
                ? [h('div', { key: 'loading', className: ROOT + '-hint' }, t('panel.loading'))]
                : visible.length === 0
                  ? [h('div', { key: 'empty', className: ROOT + '-hint' }, commands.length === 0 ? t('panel.empty') : t('panel.noMatch'))]
                  : visible.map((command) => h('div', {
                    key: command.id,
                    className: ROOT + '-row',
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => insert(command),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') insert(command)
                    },
                  }, [
                    h('div', { key: 'title', className: ROOT + '-rowTitle' }, command.title || command.text.slice(0, 40)),
                    h('div', { key: 'text', className: ROOT + '-rowText' }, command.text.replace(/\n/g, ' ').slice(0, 80)),
                    h('div', { key: 'acts', className: ROOT + '-rowActs' }, [
                      h('button', {
                        key: 'send', type: 'button', className: ROOT + '-act', 'data-tone': 'send',
                        onClick: (event) => { event.stopPropagation(); send(command) },
                      }, t('action.send')),
                      h('button', {
                        key: 'edit', type: 'button', className: ROOT + '-act',
                        onClick: (event) => { event.stopPropagation(); setEditing({ id: command.id, title: command.title, text: command.text }) },
                      }, t('action.edit')),
                      h('button', {
                        key: 'remove', type: 'button', className: ROOT + '-act',
                        onClick: (event) => { event.stopPropagation(); void remove(command) },
                      }, t('action.remove')),
                    ]),
                  ])),
            ),
          error !== '' ? h('div', { key: 'err', className: ROOT + '-err', role: 'alert' }, error) : null,
        ])
        : null

      return h(React.Fragment, null, [
        h('style', { key: 'css' }, CSS),
        h('button', {
          key: 'btn',
          ref: btnRef,
          type: 'button',
          className: ROOT + '-btn',
          title: t('button.title'),
          onClick: toggle,
        }, [h(StarGlyph, { key: 'icon' }), h('span', { key: 'label' }, t('button.label'))]),
        panel,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const tr = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'quick-commands: dictionaries')
        ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'quick-commands',
          order: 3,
        }, (props) => h(QuickCommands, props))), 'quick-commands: composer button')
      },
    }
  },
})
