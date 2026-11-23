/**
 * Client half of the pending-send queue.
 *
 * One tab type in the right sidebar. Rows live in this plugin's own host store
 * (/plugins/pending-queue/*), keyed by the session the tab belongs to, so two
 * conversations never share one queue.
 *
 * A row is a list of segments. Pushing it into the chat replays those segments
 * through the composer's public input actions: setDraft() for the leading
 * text, insertText() for later text blocks, insertQuote() for quotes. A quote
 * stored here therefore comes back as the same atomic quote block the composer
 * itself inserts, and submit() sends it exactly like typed text (queued while
 * the agent is running).
 *
 * Images are the one exception: the composer's attachment pipeline only takes
 * browser-owned draft ids, which a sidebar panel cannot mint. So an image is
 * stored on this machine and pushed as "@<path>" plus a line asking the agent
 * to open it with read_image. The model still sees the picture; it just asks
 * for it instead of receiving it inline.
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
    const UPLOAD_URL = '/plugins/pending-queue/upload'
    const ASSET_URL = '/plugins/pending-queue/asset'
    const ROOT = 'dsh-pending-queue'
    /** Per-session scratch key: unsaved typing survives a tab switch or restart. */
    const DRAFT_KEY = 'dsh.pending-queue.draft.v1.'

    /**
     * The last non-empty chat selection, captured from the moment the plugin
     * loads. A tab mounts later than the selection it wants to quote, and the
     * click that opens the panel usually collapses the live selection, so the
     * value has to live outside the component.
     */
    let lastChatSelection = ''

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
      'input.placeholder': '记一条想法…（可粘贴或拖入图片）',
      'input.hint': 'Cmd/Ctrl + Enter 存下。发送时内容进输入框并直接提交；运行中的会话会把它排进队列。',
      'action.save': '存下',
      'action.send': '发送',
      'action.fill': '填入',
      'action.edit': '编辑',
      'action.remove': '删除',
      'action.complete': '完成',
      'action.shelve': '搁置',
      'action.unshelve': '取消搁置',
      'status.shelved': '已搁置',
      'queue.shelved': '{n} 条已搁置',
      'queue.clearShelved': '清空搁置',
      'group.shelved': '搁置',
      'action.uncomplete': '恢复',
      'status.done': '已完成',
      'queue.done': '{n} 条已完成',
      'queue.clearDone': '清空已完成',
      'group.pending': '待发',
      'group.done': '已完成',
      'group.sent': '已发送',
      'group.deleted': '已删除',
      'action.undelete': '恢复',
      'action.purge': '彻底删除',
      'queue.deleted': '{n} 条已删除',
      'queue.clearDeleted': '清空已删除',
      'action.up': '上移',
      'action.down': '下移',
      'action.restore': '取回',
      'action.cancel': '取消',
      'action.saveEdit': '保存',
      'action.quote': '引用选中',
      'action.image': '加图片',
      'action.feishu': '飞书引用',
      'feishu.placeholder': '搜索飞书文档 / 云盘 / 群 / 消息 / 联系人',
      'feishu.empty': '没有搜到结果',
      'feishu.loading': '搜索中…',
      'feishu.unavailable': '飞书引用不可用（需要安装 feishu-ref 插件）',
      'feishu.meta.docs': '文档',
      'feishu.meta.files': '云盘',
      'feishu.meta.chats': '群聊',
      'feishu.meta.messages': '消息',
      'feishu.meta.contacts': '联系人',
      'action.removeAttachment': '移除',
      'quote.hint': '先在聊天里选中一段文字，再点「引用选中」；推送时它会还原成真正的引用块。',
      'quote.empty': '先在聊天里选中一段文字',
      'image.hint': '图片存在本机，推送时会带上路径并请 agent 用 read_image 查看。',
      'image.push': '附图：@{path}\n（请用 read_image 查看这张图）',
      'status.sent': '已发送',
      'status.deleted': '已删除',
      'notice.filled': '已填入输入框',
      'notice.sent': '已推送',
      'error.network': '连不上插件接口',
      'error.noComposer': '这个位置还拿不到会话输入框，换到聊天页面再试',
      'error.push': '内容没能写进输入框（可能正在发送中）',
      'error.image': '只能粘贴 / 拖入图片（png、jpeg、webp、gif）',
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
      'input.placeholder': 'Jot one idea… (paste or drop an image)',
      'input.hint': 'Cmd/Ctrl + Enter saves. Sending puts the text in the composer and submits it; a running session queues it.',
      'action.save': 'Save',
      'action.send': 'Send',
      'action.fill': 'Fill',
      'action.edit': 'Edit',
      'action.remove': 'Delete',
      'action.complete': 'Done',
      'action.shelve': 'Shelve',
      'action.unshelve': 'Unshelve',
      'status.shelved': 'Shelved',
      'queue.shelved': '{n} shelved',
      'queue.clearShelved': 'Clear shelved',
      'group.shelved': 'Shelved',
      'action.uncomplete': 'Restore',
      'status.done': 'Done',
      'queue.done': '{n} done',
      'queue.clearDone': 'Clear done',
      'group.pending': 'To send',
      'group.done': 'Done',
      'group.sent': 'Sent',
      'group.deleted': 'Deleted',
      'action.undelete': 'Restore',
      'action.purge': 'Delete forever',
      'queue.deleted': '{n} deleted',
      'queue.clearDeleted': 'Clear deleted',
      'action.up': 'Move up',
      'action.down': 'Move down',
      'action.restore': 'Restore',
      'action.cancel': 'Cancel',
      'action.saveEdit': 'Save',
      'action.quote': 'Quote selection',
      'action.image': 'Add image',
      'action.feishu': 'Feishu ref',
      'feishu.placeholder': 'Search Feishu docs / drive / chats / messages / people',
      'feishu.empty': 'No results',
      'feishu.loading': 'Searching…',
      'feishu.unavailable': 'Feishu references need the feishu-ref plugin',
      'feishu.meta.docs': 'Docs',
      'feishu.meta.files': 'Drive',
      'feishu.meta.chats': 'Chats',
      'feishu.meta.messages': 'Messages',
      'feishu.meta.contacts': 'People',
      'action.removeAttachment': 'Remove',
      'quote.hint': 'Select text in the chat first, then press Quote selection; pushing rebuilds it as a real quote block.',
      'quote.empty': 'Select text in the chat first',
      'image.hint': 'Images stay on this machine; pushing sends the path and asks the agent to open it with read_image.',
      'image.push': 'Attached image: @{path}\n(open it with read_image)',
      'status.sent': 'Sent',
      'status.deleted': 'Deleted',
      'notice.filled': 'Filled into the composer',
      'notice.sent': 'Pushed',
      'error.network': 'Cannot reach the plugin route',
      'error.noComposer': 'The composer is not reachable from here; open the chat view and retry',
      'error.push': 'The text could not enter the composer (it may be sending)',
      'error.image': 'Paste or drop an image (png, jpeg, webp, gif)',
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
              /* fall through */
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

    function assetName(path) {
      const value = String(path || '')
      return value.slice(value.lastIndexOf('/') + 1)
    }

    function assetUrl(sessionId, path) {
      return ASSET_URL
        + '?sessionId=' + encodeURIComponent(sessionId || '')
        + '&name=' + encodeURIComponent(assetName(path))
    }

    function readFileBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          resolve(result.slice(result.indexOf(',') + 1))
        }
        reader.onerror = () => reject(reader.error || new Error('read failed'))
        reader.readAsDataURL(file)
      })
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

    /**
     * The exact text feishu-ref would insert into the composer, so a reference
     * taken here is identical to one taken from the composer's own panel.
     */
    function feishuText(item) {
      if (!item) return ''
      if (item.type === 'message') {
        const label = [item.chatName, item.sender].filter(Boolean).join(' · ') || '飞书消息'
        const link = item.url ? '[' + label + '](' + item.url + ')' : label
        return item.messageId ? link + '（message_id: ' + item.messageId + '） ' : link + ' '
      }
      if (item.type === 'contact') {
        const link = item.url ? '[' + item.title + '](' + item.url + ')' : item.title
        return item.openId ? link + '（open_id: ' + item.openId + '） ' : link + ' '
      }
      return '[' + item.title + '](' + item.url + ') '
    }

    /** Rows written by earlier versions carry a single 'text' field. */
    function segmentsOfItem(item) {
      if (item && Array.isArray(item.segments) && item.segments.length > 0) return item.segments
      if (item && typeof item.text === 'string' && item.text.trim() !== '') return [{ type: 'text', text: item.text }]
      return []
    }

    /* -------------------------------- artwork -------------------------------- */

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
      '.dsh-pending-queue-composeFoot{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap;justify-content:flex-end}',
      '.dsh-pending-queue-hint{flex:1 1 100%;min-width:0;font-size:11px;line-height:1.45;',
      '  color:var(--dsw-alias-label-tertiary,#9a9aa2);white-space:normal;word-break:break-word}',
      '.dsh-pending-queue-primary{all:unset;cursor:pointer;flex:none;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);',
      '  font-size:12px;background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff);color:#fff}',
      '.dsh-pending-queue-primary[disabled]{opacity:.45;cursor:default}',
      '.dsh-pending-queue-chips{display:flex;flex-direction:column;gap:4px;margin:6px 0 0}',
      '.dsh-pending-queue-chip{display:flex;align-items:flex-start;gap:6px;padding:4px 6px 4px 8px;border-radius:var(--dsw-radius-sm,8px);',
      '  background:var(--dsw-alias-bg-layer-2,#26262a);border-left:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff);',
      '  font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary,#b9b9c0)}',
      '.dsh-pending-queue-chipText{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;',
      '  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.dsh-pending-queue-thumbs{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}',
      '.dsh-pending-queue-thumb{position:relative;width:64px;height:64px;border-radius:var(--dsw-radius-sm,8px);overflow:hidden;',
      '  border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a);background:var(--dsw-alias-bg-layer-2,#26262a)}',
      '.dsh-pending-queue-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
      '.dsh-pending-queue-thumbX{all:unset;cursor:pointer;position:absolute;top:2px;right:2px;width:16px;height:16px;',
      '  border-radius:8px;background:#000000a6;color:#fff;font-size:11px;line-height:16px;text-align:center}',
      '.dsh-pending-queue-x{all:unset;cursor:pointer;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-x:hover{color:var(--dsw-alias-state-error-primary,#f56c6c)}',
      '.dsh-pending-queue-body{flex:1;min-height:0;overflow:auto;padding:0 10px 16px;overscroll-behavior:contain}',
      '.dsh-pending-queue-group{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;',
      '  padding:10px 4px 4px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-group:hover{color:var(--dsw-alias-label-secondary,#b9b9c0)}',
      '.dsh-pending-queue-groupChevron{width:10px;text-align:center;font-size:10px}',
      '.dsh-pending-queue-groupCount{flex:none;border:0.5px solid var(--dsw-alias-border-l3,#ffffff1f);border-radius:999px;',
      '  padding:0 6px;line-height:15px}',
      '.dsh-pending-queue-hintBlock{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#9a9aa2);',
      '  font-size:12.5px;line-height:1.7}',
      '.dsh-pending-queue-hintTitle{display:block;font-size:13.5px;color:var(--dsw-alias-label-secondary,#b9b9c0);margin-bottom:6px}',
      '.dsh-pending-queue-err{margin:8px 12px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);',
      '  border:0.5px solid var(--dsw-alias-state-error-primary,#f56c6c);',
      '  color:var(--dsw-alias-state-error-primary,#f56c6c);font-size:12px}',
      '.dsh-pending-queue-card{position:relative;margin:0 0 10px;padding:10px 12px 8px;border-radius:var(--dsw-radius-md,12px);',
      '  background:var(--dsw-alias-bg-layer-1,#1f1f22);border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a)}',
      '.dsh-pending-queue-card[data-sent="true"]{opacity:.6}',
      '.dsh-pending-queue-text{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55}',
      '.dsh-pending-queue-quote{margin:4px 0;padding:2px 0 2px 8px;border-left:2px solid var(--dsw-alias-border-l3,#ffffff2e);',
      '  white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#b9b9c0);font-size:12.5px}',
      '.dsh-pending-queue-image{margin:6px 0;display:flex;align-items:center;gap:8px}',
      '.dsh-pending-queue-image img{width:72px;height:72px;object-fit:cover;border-radius:var(--dsw-radius-sm,8px);',
      '  border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a)}',
      '.dsh-pending-queue-imageName{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9aa2);word-break:break-all}',
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
      '.dsh-pending-queue-edit{box-sizing:border-box;width:100%;min-height:52px;resize:vertical;border-radius:var(--dsw-radius-sm,8px);',
      '  border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a);background:transparent;color:inherit;font:inherit;padding:6px 8px;margin:2px 0}',
      '.dsh-pending-queue-notice{flex:none;margin:0 12px 6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-card[data-shelved="true"]{opacity:.8}',
      '.dsh-pending-queue-card[data-shelved="true"] .dsh-pending-queue-text{color:var(--dsw-alias-label-secondary,#b9b9c0)}',
      '.dsh-pending-queue-card[data-done="true"]{opacity:.6}',
      '.dsh-pending-queue-card[data-done="true"] .dsh-pending-queue-text{color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-card[data-done="true"] .dsh-pending-queue-image img{filter:grayscale(1)}',
      '.dsh-pending-queue-card[data-deleted="true"]{opacity:.55}',
      '.dsh-pending-queue-card[data-deleted="true"] .dsh-pending-queue-text{text-decoration:line-through}',
      '.dsh-pending-queue-card[data-deleted="true"] .dsh-pending-queue-quote{text-decoration:line-through}',
      '.dsh-pending-queue-card[data-deleted="true"] .dsh-pending-queue-image img{filter:grayscale(1)}',
      '.dsh-pending-queue-feishu{margin:8px 0 0;border:0.5px solid var(--dsw-alias-border-l3,#ffffff1a);border-radius:var(--dsw-radius-sm,8px);overflow:hidden}',
      '.dsh-pending-queue-feishuInput{box-sizing:border-box;width:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit;padding:8px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l3,#ffffff14)}',
      '.dsh-pending-queue-feishuBody{max-height:220px;overflow:auto}',
      '.dsh-pending-queue-feishuHint{padding:8px 10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-feishuGroup{padding:6px 10px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}',
      '.dsh-pending-queue-feishuRow{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;width:100%;padding:5px 10px;cursor:pointer}',
      '.dsh-pending-queue-feishuRow:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}',
      '.dsh-pending-queue-feishuTitle{font-size:12.5px;color:var(--dsw-alias-label-primary,#e8e8ea);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pending-queue-feishuMeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9aa2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
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
      const [quotes, setQuotes] = useState([])
      const [images, setImages] = useState([])
      const [feishu, setFeishu] = useState({ open: false, q: '', loading: false, error: '', result: null })
      /** Terminal groups start folded; the header toggles each one. */
      const [collapsed, setCollapsed] = useState({ pending: false, shelved: true, done: true, sent: true, deleted: true })
      const [editing, setEditing] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const live = useRef(true)
      const fileInput = useRef(null)
      /** 'compose' or 'edit': which list the file picker feeds. */
      const pickerTarget = useRef('compose')

      /** Restore the unsaved draft once per session. */
      useEffect(() => {
        if (!sessionId) return
        try {
          const raw = window.localStorage.getItem(DRAFT_KEY + sessionId)
          if (raw === null) return
          const parsed = JSON.parse(raw)
          if (typeof parsed.draft === 'string') setDraft(parsed.draft)
          if (Array.isArray(parsed.quotes)) setQuotes(parsed.quotes.filter((entry) => typeof entry === 'string'))
          if (Array.isArray(parsed.images)) setImages(parsed.images.filter((entry) => entry && typeof entry.path === 'string'))
        } catch {
          /* a broken scratch value is not worth an error banner */
        }
      }, [sessionId])

      /** Write the unsaved draft; called by the edits that change it. */
      const persist = useCallback((next) => {
        if (!sessionId) return
        try {
          const text = typeof next.draft === 'string' ? next.draft : ''
          const quotesNext = Array.isArray(next.quotes) ? next.quotes : []
          const imagesNext = Array.isArray(next.images) ? next.images : []
          if (text.trim() === '' && quotesNext.length === 0 && imagesNext.length === 0) {
            window.localStorage.removeItem(DRAFT_KEY + sessionId)
          } else {
            window.localStorage.setItem(DRAFT_KEY + sessionId, JSON.stringify({ draft: text, quotes: quotesNext, images: imagesNext }))
          }
        } catch {
          /* storage full or unavailable: the draft simply is not remembered */
        }
      }, [sessionId])

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

      /** Upload one image and return the stored file, without touching any list. */
      const uploadFile = useCallback(async (file) => {
        if (!sessionId) return undefined
        if (!file || !String(file.type || '').startsWith('image/')) {
          setError(t('error.image'))
          return undefined
        }
        setBusy('upload')
        try {
          const data = await readFileBase64(file)
          const response = await fetch(UPLOAD_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, name: file.name, data }),
          })
          const payload = await readJson(response)
          if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status))
          if (live.current) setError('')
          return payload.file
        } catch (failure) {
          if (live.current) setError(messageOf(failure))
          return undefined
        } finally {
          if (live.current) setBusy('')
        }
      }, [sessionId, t])

      /** Compose-area upload: adds the image to the pending list. */
      const uploadImage = useCallback(async (file) => {
        const stored = await uploadFile(file)
        if (!stored || !live.current) return
        const nextImages = [...images, stored]
        setImages(nextImages)
        persist({ draft, quotes, images: nextImages })
      }, [uploadFile, images, draft, quotes, persist])

      const saveDraft = useCallback(async () => {
        const text = draft.trim()
        const segments = []
        if (text !== '') segments.push({ type: 'text', text })
        for (const quote of quotes) segments.push({ type: 'quote', text: quote })
        for (const image of images) segments.push({ type: 'file', path: image.path, name: image.name })
        if (segments.length === 0) {
          setError(t('error.empty'))
          return
        }
        setBusy('add')
        const next = await act({ action: 'add', segments })
        if (live.current) {
          setBusy('')
          if (next) {
            setDraft('')
            setQuotes([])
            setImages([])
            persist({ draft: '', quotes: [], images: [] })
          }
        }
      }, [draft, quotes, images, act, t, persist])

      const addQuote = useCallback(() => {
        let live = ''
        try {
          live = String(window.getSelection() || '')
        } catch {
          live = ''
        }
        const text = (live.trim() !== '' ? live : lastChatSelection).trim()
        if (text === '') {
          setError(t('quote.empty'))
          return
        }
        const nextQuotes = [...quotes, text]
        setQuotes(nextQuotes)
        persist({ draft, quotes: nextQuotes, images })
        setError('')
      }, [t, persist, draft, quotes, images])

      /**
       * Replay one row through the composer: leading text replaces the draft,
       * later text blocks are inserted, quotes become real quote nodes, and an
       * image becomes a path line the agent can open with read_image.
       */
      const replay = useCallback((segments, mode) => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') {
          setError(t('error.noComposer'))
          return false
        }
        const rest = segments.map((segment) => ({ ...segment }))
        let head = ''
        if (rest.length > 0 && rest[0].type === 'text') head = rest.shift().text
        inputActions.setDraft(head)
        for (const segment of rest) {
          if (segment.type === 'text') {
            if (typeof inputActions.captureInsertion !== 'function' || typeof inputActions.insertText !== 'function') {
              setError(t('error.noComposer'))
              return false
            }
            if (!inputActions.insertText('\n\n' + segment.text, inputActions.captureInsertion())) {
              setError(t('error.push'))
              return false
            }
          } else if (segment.type === 'quote') {
            if (typeof inputActions.insertQuote !== 'function' || !inputActions.insertQuote(segment.text)) {
              setError(t('error.push'))
              return false
            }
          } else if (segment.type === 'file') {
            if (typeof inputActions.captureInsertion !== 'function' || typeof inputActions.insertText !== 'function') {
              setError(t('error.noComposer'))
              return false
            }
            const line = '\n\n' + t('image.push').replace('{path}', segment.path)
            if (!inputActions.insertText(line, inputActions.captureInsertion())) {
              setError(t('error.push'))
              return false
            }
          }
        }
        if (mode === 'send') {
          if (typeof inputActions.submit !== 'function') {
            setError(t('error.noComposer'))
            return false
          }
          inputActions.submit()
        }
        return true
      }, [inputActions, t])

      const push = useCallback(async (item, mode) => {
        const segments = segmentsOfItem(item)
        if (segments.length === 0) return
        setBusy(item.id)
        setError('')
        try {
          if (!replay(segments, mode)) return
          if (mode === 'send') {
            flash(t('notice.sent'))
            await act({ action: 'markSent', id: item.id })
          } else {
            flash(t('notice.filled'))
          }
        } finally {
          if (live.current) setBusy('')
        }
      }, [replay, act, flash, t])

      const startEdit = useCallback((item) => {
        setEditing({ id: item.id, segments: segmentsOfItem(item).map((segment) => ({ ...segment })) })
      }, [])

      const saveEdit = useCallback(async () => {
        if (editing === null) return
        const segments = editing.segments.filter((segment) => (segment.type === 'file'
          ? true
          : String(segment.text || '').trim() !== ''))
        if (segments.length === 0) {
          setError(t('error.empty'))
          return
        }
        setBusy(editing.id)
        const next = await act({ action: 'update', id: editing.id, segments })
        if (live.current) {
          setBusy('')
          if (next) setEditing(null)
        }
      }, [editing, act, t])

      const items = queue && Array.isArray(queue.items) ? queue.items : []
      const isDeletedRow = (item) => item.deletedAt !== null && item.deletedAt !== undefined
      const isSentRow = (item) => !isDeletedRow(item) && item.sentAt !== null && item.sentAt !== undefined
      const isDoneRow = (item) => !isDeletedRow(item) && !isSentRow(item) && item.doneAt !== null && item.doneAt !== undefined
      const isShelvedRow = (item) => !isDeletedRow(item) && !isSentRow(item) && !isDoneRow(item)
        && item.shelvedAt !== null && item.shelvedAt !== undefined
      const isPendingRow = (item) => !isDeletedRow(item) && !isSentRow(item) && !isDoneRow(item) && !isShelvedRow(item)
      const pending = items.filter(isPendingRow).length
      const shelved = items.filter(isShelvedRow).length
      const done = items.filter(isDoneRow).length
      const sent = items.filter(isSentRow).length
      const deleted = items.filter(isDeletedRow).length

      const onComposeKey = useCallback((event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void saveDraft()
        }
      }, [saveDraft])

      /** Pull the first image out of a clipboard or drop payload, either shape. */
      const imageFrom = useCallback((payload) => {
        if (!payload) return undefined
        const files = payload.files ? Array.from(payload.files) : []
        const direct = files.find((file) => String(file.type || '').startsWith('image/'))
        if (direct !== undefined) return direct
        if (!payload.items) return undefined
        for (const item of Array.from(payload.items)) {
          if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
            const file = item.getAsFile()
            if (file) return file
          }
        }
        return undefined
      }, [])

      /** Edit-mode upload: the image joins the row being edited, not the compose area. */
      const appendEditingImage = useCallback(async (file) => {
        const stored = await uploadFile(file)
        if (!stored || !live.current) return
        setEditing((current) => current === null ? current : ({
          id: current.id,
          segments: [...current.segments, { type: 'file', path: stored.path, name: stored.name }],
        }))
      }, [uploadFile])

      /** Edit-mode quote: the selection joins the row being edited. */
      const addEditingQuote = useCallback(() => {
        let live = ''
        try {
          live = String(window.getSelection() || '')
        } catch {
          live = ''
        }
        const text = (live.trim() !== '' ? live : lastChatSelection).trim()
        if (text === '') {
          setError(t('quote.empty'))
          return
        }
        setEditing((current) => current === null ? current : ({
          id: current.id,
          segments: [...current.segments, { type: 'quote', text }],
        }))
        setError('')
      }, [t])

      /** Debounced search against the feishu-ref plugin's own route. */
      useEffect(() => {
        if (!feishu.open) return undefined
        const query = feishu.q.trim()
        if (query === '') {
          setFeishu((current) => ({ ...current, result: null, error: '', loading: false }))
          return undefined
        }
        let cancelled = false
        const timer = setTimeout(async () => {
          setFeishu((current) => ({ ...current, loading: true, error: '' }))
          try {
            const response = await fetch('/plugins/feishu-ref/search', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ q: query }),
            })
            const payload = await readJson(response)
            if (!response.ok || payload.ok !== true) throw new Error(payload.message || ('HTTP ' + response.status))
            if (cancelled || !live.current) return
            setFeishu((current) => ({ ...current, loading: false, result: payload, error: '' }))
          } catch {
            if (cancelled || !live.current) return
            setFeishu((current) => ({ ...current, loading: false, result: null, error: t('feishu.unavailable') }))
          }
        }, 350)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [feishu.open, feishu.q, t])

      /** Append a Feishu reference as ordinary text, same string the composer inserts. */
      const pickFeishu = useCallback((item) => {
        const text = feishuText(item)
        if (text === '') return
        const next = draft.trim() === '' ? text : draft.replace(/\s+$/, '') + '\n' + text
        setDraft(next)
        persist({ draft: next, quotes, images })
        setFeishu({ open: false, q: '', loading: false, error: '', result: null })
      }, [draft, persist, quotes, images])

      const openPicker = useCallback((target) => {
        pickerTarget.current = target
        if (fileInput.current) fileInput.current.click()
      }, [])

      const onPaste = useCallback((event) => {
        const image = imageFrom(event.clipboardData)
        if (image === undefined) return
        event.preventDefault()
        event.stopPropagation()
        void uploadImage(image)
      }, [imageFrom, uploadImage])

      const onEditPaste = useCallback((event) => {
        const image = imageFrom(event.clipboardData)
        if (image === undefined) return
        event.preventDefault()
        event.stopPropagation()
        void appendEditingImage(image)
      }, [imageFrom, appendEditingImage])

      const onEditDrop = useCallback((event) => {
        const image = imageFrom(event.dataTransfer)
        if (image === undefined) return
        event.preventDefault()
        void appendEditingImage(image)
      }, [imageFrom, appendEditingImage])

      const onDrop = useCallback((event) => {
        const files = event.dataTransfer && event.dataTransfer.files
          ? Array.from(event.dataTransfer.files)
          : []
        const image = files.find((file) => String(file.type || '').startsWith('image/'))
        if (image === undefined) return
        event.preventDefault()
        void uploadImage(image)
      }, [uploadImage])

      const countLabel = [
        count(t, 'queue.pending', pending),
        shelved > 0 ? count(t, 'queue.shelved', shelved) : '',
        done > 0 ? count(t, 'queue.done', done) : '',
        sent > 0 ? count(t, 'queue.sent', sent) : '',
        deleted > 0 ? count(t, 'queue.deleted', deleted) : '',
      ].filter(Boolean).join(' · ')

      function renderSegments(segments, keyPrefix) {
        return segments.map((segment, index) => {
          if (segment.type === 'quote') {
            return h('div', { key: keyPrefix + '-q' + index, className: ROOT + '-quote' }, segment.text)
          }
          if (segment.type === 'file') {
            return h('div', { key: keyPrefix + '-f' + index, className: ROOT + '-image' }, [
              h('img', { key: 'img', src: assetUrl(sessionId, segment.path), alt: segment.name || '' }),
              h('span', { key: 'name', className: ROOT + '-imageName' }, segment.name || assetName(segment.path)),
            ])
          }
          return h('div', { key: keyPrefix + '-t' + index, className: ROOT + '-text' }, segment.text)
        })
      }

      const toggleGroup = useCallback((key) => {
        setCollapsed((current) => {
          const next = { ...current, [key]: !current[key] }
          try {
            window.localStorage.setItem('dsh.pending-queue.collapsed.v1', JSON.stringify(next))
          } catch {
            /* storage unavailable: the fold simply is not remembered */
          }
          return next
        })
      }, [])

      useEffect(() => {
        try {
          const raw = window.localStorage.getItem('dsh.pending-queue.collapsed.v1')
          if (raw === null) return
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') {
            setCollapsed((current) => ({ ...current, ...parsed }))
          }
        } catch {
          /* a broken value just means default folding */
        }
      }, [])

      /** Sections by state, in order: to send, done, sent, deleted. */
      function renderGroups() {
        const groups = [
          ['pending', items.filter(isPendingRow)],
          ['shelved', items.filter(isShelvedRow)],
          ['done', items.filter(isDoneRow)],
          ['sent', items.filter(isSentRow)],
          ['deleted', items.filter(isDeletedRow)],
        ].filter(([, list]) => list.length > 0)
        const nodes = []
        for (const [key, list] of groups) {
          const folded = collapsed[key] === true
          nodes.push(h('button', {
            key: 'g-' + key,
            type: 'button',
            className: ROOT + '-group',
            'aria-expanded': folded ? 'false' : 'true',
            onClick: () => toggleGroup(key),
          }, [
            h('span', { key: 'chevron', className: ROOT + '-groupChevron' }, folded ? '▸' : '▾'),
            h('span', { key: 'label', className: ROOT + '-groupLabel' }, t('group.' + key)),
            h('span', { key: 'count', className: ROOT + '-groupCount' }, String(list.length)),
          ]))
          if (folded) continue
          list.forEach((item, index) => {
            nodes.push(renderRow(item, index, list))
          })
        }
        return nodes
      }

      function renderFeishuResults() {
        const result = feishu.result
        if (!result) return h('div', { key: 'hint', className: ROOT + '-feishuHint' }, t('feishu.placeholder'))
        const groups = [
          ['docs', result.docs],
          ['files', result.files],
          ['chats', result.chats],
          ['messages', result.messages],
          ['contacts', result.contacts],
        ].filter(([, list]) => Array.isArray(list) && list.length > 0)
        if (groups.length === 0) return h('div', { key: 'empty', className: ROOT + '-feishuHint' }, t('feishu.empty'))
        const rows = []
        for (const [key, list] of groups) {
          rows.push(h('div', { key: 'g' + key, className: ROOT + '-feishuGroup' }, t('feishu.meta.' + key)))
          for (const item of list.slice(0, 4)) {
            const label = item.title || item.url || ''
            rows.push(h('button', {
              key: key + ':' + (item.url || label),
              type: 'button',
              className: ROOT + '-feishuRow',
              title: feishuText(item),
              onClick: () => pickFeishu(item),
            }, [
              h('span', { key: 't', className: ROOT + '-feishuTitle' }, label),
              item.url ? h('span', { key: 'u', className: ROOT + '-feishuMeta' }, String(item.url).slice(0, 56)) : null,
            ]))
          }
        }
        return rows
      }

      function renderRow(item, index, groupItems) {
        const isEditing = editing !== null && editing.id === item.id
        const isSent = isSentRow(item)
        const isDeleted = isDeletedRow(item)
        const isDone = isDoneRow(item)
        const isShelved = isShelvedRow(item)
        const isBusy = busy === item.id
        const segments = segmentsOfItem(item)
        const actions = []
        if (isDeleted) {
          actions.push(h('button', {
            key: 'undelete', type: 'button', className: ROOT + '-act',
            onClick: () => { void act({ action: 'undelete', id: item.id }) },
          }, t('action.undelete')))
          actions.push(h('button', {
            key: 'purge', type: 'button', className: ROOT + '-act',
            onClick: () => { void act({ action: 'purge', id: item.id }) },
          }, t('action.purge')))
        }
        if (isDone) {
          actions.push(h('button', {
            key: 'complete', type: 'button', className: ROOT + '-act', disabled: isBusy,
            onClick: () => { void act({ action: 'uncomplete', id: item.id }) },
          }, t('action.uncomplete')))
        }
        if (isShelved) {
          actions.push(h('button', {
            key: 'unshelve', type: 'button', className: ROOT + '-act', disabled: isBusy,
            onClick: () => { void act({ action: 'unshelve', id: item.id }) },
          }, t('action.unshelve')))
        }
        if (isPendingRow(item) && !isEditing) {
          actions.push(h('button', {
            key: 'done', type: 'button', className: ROOT + '-act', disabled: isBusy,
            onClick: () => { void act({ action: 'complete', id: item.id }) },
          }, '✓ ' + t('action.complete')))
          actions.push(h('button', {
            key: 'shelve', type: 'button', className: ROOT + '-act', disabled: isBusy,
            onClick: () => { void act({ action: 'shelve', id: item.id }) },
          }, t('action.shelve')))
        }
        if (!isDeleted && !isDone && !isShelved && !isEditing && !isSent) {
          actions.push(h('button', {
            key: 'send', type: 'button', className: ROOT + '-act', 'data-tone': 'send', disabled: isBusy,
            onClick: () => { void push(item, 'send') },
          }, t('action.send')))
          actions.push(h('button', {
            key: 'fill', type: 'button', className: ROOT + '-act', disabled: isBusy,
            onClick: () => { void push(item, 'fill') },
          }, t('action.fill')))
          actions.push(h('button', {
            key: 'edit', type: 'button', className: ROOT + '-act',
            onClick: () => startEdit(item),
          }, t('action.edit')))
        }
        if (isSent && !isDeleted) {
          actions.push(h('button', {
            key: 'restore', type: 'button', className: ROOT + '-act',
            onClick: () => { void act({ action: 'restore', id: item.id }) },
          }, t('action.restore')))
        }
        if (!isEditing && !isDeleted) {
          actions.push(h('button', {
            key: 'up', type: 'button', className: ROOT + '-act', disabled: index === 0, 'aria-label': t('action.up'),
            onClick: () => { void act({ action: 'move', id: item.id, direction: 'up' }) },
          }, '↑'))
          actions.push(h('button', {
            key: 'down', type: 'button', className: ROOT + '-act', disabled: index === groupItems.length - 1, 'aria-label': t('action.down'),
            onClick: () => { void act({ action: 'move', id: item.id, direction: 'down' }) },
          }, '↓'))
          actions.push(h('button', {
            key: 'remove', type: 'button', className: ROOT + '-act',
            onClick: () => { void act({ action: 'remove', id: item.id }) },
          }, t('action.remove')))
        }

        const body = isEditing
          ? h('div', { key: 'editing', onDrop: onEditDrop }, [
            ...editing.segments.map((segment, segmentIndex) => {
              if (segment.type === 'quote' || segment.type === 'file') {
                return h('div', { key: 'es' + segmentIndex, className: ROOT + '-chip' }, [
                  segment.type === 'file'
                    ? h('img', {
                      key: 'img',
                      src: assetUrl(sessionId, segment.path),
                      alt: segment.name || '',
                      style: { width: '40px', height: '40px', objectFit: 'cover', borderRadius: '6px' },
                    })
                    : null,
                  h('span', { key: 'txt', className: ROOT + '-chipText' }, segment.type === 'file'
                    ? (segment.name || assetName(segment.path))
                    : segment.text),
                  h('button', {
                    key: 'x', type: 'button', className: ROOT + '-x', 'aria-label': t('action.removeAttachment'),
                    onClick: () => setEditing((current) => current === null ? current : ({
                      id: current.id,
                      segments: current.segments.filter((_, i) => i !== segmentIndex),
                    })),
                  }, '×'),
                ])
              }
              return h('textarea', {
                key: 'et' + segmentIndex,
                className: ROOT + '-edit',
                value: segment.text,
                rows: 2,
                onPaste: onEditPaste,
                onChange: (event) => {
                  const value = event.target.value
                  setEditing((current) => current === null ? current : ({
                    id: current.id,
                    segments: current.segments.map((entry, i) => (i === segmentIndex ? { type: 'text', text: value } : entry)),
                  }))
                },
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
              })
            }),
            h('div', { key: 'acts', className: ROOT + '-acts' }, [
              h('button', {
                key: 'quote', type: 'button', className: ROOT + '-act',
                onClick: addEditingQuote,
              }, t('action.quote')),
              h('button', {
                key: 'image', type: 'button', className: ROOT + '-act',
                onClick: () => openPicker('edit'),
              }, t('action.image')),
              h('button', {
                key: 'save', type: 'button', className: ROOT + '-act', 'data-tone': 'send', disabled: isBusy,
                onClick: () => { void saveEdit() },
              }, t('action.saveEdit')),
              h('button', {
                key: 'cancel', type: 'button', className: ROOT + '-act',
                onClick: () => setEditing(null),
              }, t('action.cancel')),
            ]),
          ])
          : h('div', { key: 'content' }, renderSegments(segments, item.id))

        return h('div', {
          key: item.id,
          className: ROOT + '-card',
          'data-sent': isSent ? 'true' : 'false',
          'data-done': isDone ? 'true' : 'false',
          'data-shelved': isShelved ? 'true' : 'false',
          'data-deleted': isDeleted ? 'true' : 'false',
        }, [
          body,
          h('div', { key: 'meta', className: ROOT + '-meta' }, [
            h('span', { key: 'time' }, relativeTime(item.createdAt, t)),
            isSent ? h('span', { key: 'sent', className: ROOT + '-badge' }, t('status.sent')) : null,
            isDone ? h('span', { key: 'done', className: ROOT + '-badge' }, '✓ ' + t('status.done')) : null,
            isShelved ? h('span', { key: 'shelved', className: ROOT + '-badge' }, t('status.shelved')) : null,
            isDeleted ? h('span', { key: 'deleted', className: ROOT + '-badge' }, t('status.deleted')) : null,
          ]),
          h('div', { key: 'acts', className: ROOT + '-acts' }, actions),
        ])
      }

      return h('div', { className: ROOT }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'head', className: ROOT + '-head' }, [
          h('span', { key: 'title', className: ROOT + '-title' }, t('queue.title')),
          h('span', { key: 'counts', className: ROOT + '-counts' }, countLabel),
          sent > 0
            ? h('button', { key: 'clear', type: 'button', className: ROOT + '-ghost', onClick: () => { void act({ action: 'clearSent' }) } }, t('queue.clearSent'))
            : null,
          shelved > 0
            ? h('button', { key: 'clearShelved', type: 'button', className: ROOT + '-ghost', onClick: () => { void act({ action: 'clearShelved' }) } }, t('queue.clearShelved'))
            : null,
          done > 0
            ? h('button', { key: 'clearDone', type: 'button', className: ROOT + '-ghost', onClick: () => { void act({ action: 'clearDone' }) } }, t('queue.clearDone'))
            : null,
          deleted > 0
            ? h('button', { key: 'clearDeleted', type: 'button', className: ROOT + '-ghost', onClick: () => { void act({ action: 'clearDeleted' }) } }, t('queue.clearDeleted'))
            : null,
          h('button', { key: 'refresh', type: 'button', className: ROOT + '-ghost', onClick: () => { void load(true) } }, t('queue.refresh')),
        ]),
        h('div', {
          key: 'compose',
          className: ROOT + '-compose',
          onDrop,
          onPaste,
          onDragOver: (event) => {
            if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault()
          },
        }, [
          h('textarea', {
            key: 'input',
            className: ROOT + '-input',
            value: draft,
            placeholder: t('input.placeholder'),
            rows: 2,
            onChange: (event) => {
              const value = event.target.value
              setDraft(value)
              persist({ draft: value, quotes, images })
            },
            onKeyDown: onComposeKey,
            onPaste,
          }),
          quotes.length > 0
            ? h('div', { key: 'quotes', className: ROOT + '-chips' }, quotes.map((text, index) => h('div', {
              key: 'qc' + index,
              className: ROOT + '-chip',
            }, [
              h('span', { key: 'txt', className: ROOT + '-chipText' }, text),
              h('button', {
                key: 'x', type: 'button', className: ROOT + '-x', 'aria-label': t('action.removeAttachment'),
                onClick: () => {
                  const nextQuotes = quotes.filter((_, i) => i !== index)
                  setQuotes(nextQuotes)
                  persist({ draft, quotes: nextQuotes, images })
                },
              }, '×'),
            ])))
            : null,
          images.length > 0
            ? h('div', { key: 'images', className: ROOT + '-thumbs' }, images.map((image, index) => h('div', {
              key: 'im' + index,
              className: ROOT + '-thumb',
              title: image.name || assetName(image.path),
            }, [
              h('img', { key: 'img', src: assetUrl(sessionId, image.path), alt: image.name || '' }),
              h('button', {
                key: 'x', type: 'button', className: ROOT + '-thumbX', 'aria-label': t('action.removeAttachment'),
                onClick: () => {
                  const nextImages = images.filter((_, i) => i !== index)
                  setImages(nextImages)
                  persist({ draft, quotes, images: nextImages })
                },
              }, '×'),
            ])))
            : null,
          feishu.open
            ? h('div', { key: 'feishu', className: ROOT + '-feishu' }, [
              h('input', {
                key: 'q',
                className: ROOT + '-feishuInput',
                autoFocus: true,
                value: feishu.q,
                placeholder: t('feishu.placeholder'),
                onChange: (event) => setFeishu((current) => ({ ...current, q: event.target.value })),
                onKeyDown: (event) => {
                  if (event.key !== 'Escape') return
                  event.preventDefault()
                  setFeishu({ open: false, q: '', loading: false, error: '', result: null })
                },
              }),
              h('div', { key: 'body', className: ROOT + '-feishuBody' },
                feishu.loading
                  ? [h('div', { key: 'l', className: ROOT + '-feishuHint' }, t('feishu.loading'))]
                  : feishu.error !== ''
                    ? [h('div', { key: 'e', className: ROOT + '-feishuHint' }, feishu.error)]
                    : renderFeishuResults()),
            ])
            : null,
          h('div', { key: 'foot', className: ROOT + '-composeFoot' }, [
            h('span', { key: 'hint', className: ROOT + '-hint' }, images.length > 0
              ? t('image.hint')
              : quotes.length > 0 ? t('quote.hint') : t('input.hint')),
            h('input', {
              key: 'file',
              ref: fileInput,
              type: 'file',
              accept: 'image/*',
              style: { display: 'none' },
              onChange: (event) => {
                const picked = event.target.files && event.target.files[0]
                event.target.value = ''
                if (!picked) return
                if (pickerTarget.current === 'edit' && editing !== null) void appendEditingImage(picked)
                else void uploadImage(picked)
              },
            }),
            h('button', {
              key: 'feishu', type: 'button', className: ROOT + '-ghost',
              onClick: () => setFeishu((current) => ({
                open: !current.open, q: current.open ? '' : current.q, loading: false, error: '', result: null,
              })),
            }, t('action.feishu')),
            h('button', { key: 'image', type: 'button', className: ROOT + '-ghost', onClick: () => { if (fileInput.current) fileInput.current.click() } }, t('action.image')),
            h('button', { key: 'quote', type: 'button', className: ROOT + '-ghost', onClick: addQuote }, t('action.quote')),
            h('button', {
              key: 'save', type: 'button', className: ROOT + '-primary',
              disabled: busy === 'add' || busy === 'upload' || (draft.trim() === '' && quotes.length === 0 && images.length === 0),
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
              : renderGroups()),
      ])
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

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const onSelection = () => {
            try {
              const text = String(window.getSelection() || '')
              if (text.trim() !== '') lastChatSelection = text
            } catch {
              /* selection API unavailable */
            }
          }
          document.addEventListener('selectionchange', onSelection)
          return () => document.removeEventListener('selectionchange', onSelection)
        }, 'pending-queue: selection capture')

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
            key: PKG,            locale: NS,
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
