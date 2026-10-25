/**
 * Client half of the selection toolbar bundle.
 *
 * Registers one `shell.overlay` entry: a frame-wide floating layer that shows
 * a small toolbar above the text the user has just selected in the
 * conversation, with copy / follow-up / annotate actions.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-selection-toolbar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = '@lyra_wang/dsh-selection-toolbar';
    const ROOT_CLASS = 'dsh-sel-toolbar';

    const CSS = `
      .${ROOT_CLASS}-bar{position:fixed;z-index:2147483000;pointer-events:auto;
        display:flex;gap:2px;align-items:center;
        background:var(--dsw-alias-bg-overlay,#2b2b2f);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);border-radius:10px;padding:4px;
        box-shadow:0 8px 24px rgba(0,0,0,.35);transform:translate(-50%,-100%);
        font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
      .${ROOT_CLASS}-bar button{all:unset;cursor:pointer;color:var(--dsw-alias-label-primary,#e6e6e9);
        padding:5px 9px;border-radius:7px;display:flex;gap:4px;align-items:center;white-space:nowrap}
      .${ROOT_CLASS}-bar button:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41)}
      .${ROOT_CLASS}-bar .ico{font-size:13px;line-height:1}
      .${ROOT_CLASS}-toast{position:fixed;left:50%;bottom:48px;transform:translateX(-50%);
        background:var(--dsw-alias-bg-overlay,#2b2b2f);color:var(--dsw-alias-label-primary,#fff);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);border-radius:8px;padding:7px 14px;
        font:12px/1.4 -apple-system,"PingFang SC",sans-serif;z-index:2147483001;
        box-shadow:0 6px 20px rgba(0,0,0,.3)}
      .${ROOT_CLASS}-note{position:fixed;z-index:2147483002;pointer-events:auto;
        display:flex;gap:6px;align-items:center;
        background:var(--dsw-alias-bg-overlay,#2b2b2f);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        border-radius:10px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);transform:translate(-50%,-100%)}
      .${ROOT_CLASS}-note input{all:unset;color:var(--dsw-alias-label-primary,#e6e6e9);
        background:var(--dsw-alias-bg-layer-1,#1f1f23);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        border-radius:7px;padding:6px 9px;width:260px;
        font:12px/1.4 -apple-system,"PingFang SC",sans-serif}
      .${ROOT_CLASS}-note button{all:unset;cursor:pointer;color:var(--dsw-alias-label-primary,#e6e6e9);
        padding:5px 9px;border-radius:7px;font-size:12px}
      .${ROOT_CLASS}-note button:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41)}
      .${ROOT_CLASS}-rw{position:fixed;z-index:2147483002;pointer-events:auto;width:420px;max-width:92vw;
        background:var(--dsw-alias-bg-overlay,#2b2b2f);border:1px solid var(--dsw-alias-border-l1,#3a3a40);
        border-radius:10px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);transform:translate(-50%,-100%);
        display:flex;flex-direction:column;gap:8px;
        font:12px/1.5 -apple-system,"PingFang SC",sans-serif;color:var(--dsw-alias-label-primary,#e6e6e9)}
      .${ROOT_CLASS}-rw-head{font-weight:600;font-size:12px;opacity:.9}
      .${ROOT_CLASS}-rw-chips{display:flex;gap:6px;flex-wrap:wrap}
      .${ROOT_CLASS}-rw-chips button{all:unset;cursor:pointer;padding:3px 8px;border-radius:999px;
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);font-size:11px}
      .${ROOT_CLASS}-rw-chips button:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41)}
      .${ROOT_CLASS}-rw input{all:unset;background:var(--dsw-alias-bg-layer-1,#1f1f23);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);border-radius:7px;padding:6px 9px;width:auto}
      .${ROOT_CLASS}-rw-result{max-height:180px;overflow:auto;background:var(--dsw-alias-bg-layer-1,#1f1f23);
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);border-radius:7px;padding:8px;
        white-space:pre-wrap;word-break:break-word;user-select:text}
      .${ROOT_CLASS}-rw-actions{display:flex;gap:6px;justify-content:flex-end}
      .${ROOT_CLASS}-rw-actions button{all:unset;cursor:pointer;padding:5px 10px;border-radius:7px;
        border:1px solid var(--dsw-alias-border-l1,#3a3a40);font-size:12px}
      .${ROOT_CLASS}-rw-actions button:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41)}
      .${ROOT_CLASS}-rw-actions button[disabled]{opacity:.5;cursor:default}`;

    /** Copy with a clipboard API attempt and a legacy selection fallback. */
    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        // fall through to the legacy path
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, area.value.length);
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (error) {
        return false;
      }
    }

    /** The resident composer is the lowest visible editable element. */
    const quoteStore = { current: null, listeners: new Set() };
    function setQuote(value) {
      quoteStore.current = value;
      for (const listener of quoteStore.listeners) listener();
    }
    function useQuote() {
      const [value, setValue] = React.useState(quoteStore.current);
      React.useEffect(() => {
        const listener = () => setValue(quoteStore.current);
        quoteStore.listeners.add(listener);
        return () => quoteStore.listeners.delete(listener);
      }, []);
      return value;
    }

    function findComposer() {
      const candidates = Array.from(
        document.querySelectorAll('[contenteditable="true"],[role="textbox"]'),
      ).filter((el) => el.offsetParent !== null && !el.closest('.' + ROOT_CLASS));
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return candidates[0];
    }

    function selectedTextInField(node) {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      return Boolean(
        el && el.closest('input,textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"]'),
      );
    }

    function SelectionToolbar(props) {
      const sessionId = props && props.sessionId;
      const { t } = props;
      const [selection, setSelection] = React.useState(null);
      const [toast, setToast] = React.useState('');
      const [noteOpen, setNoteOpen] = React.useState(false);
      const [noteValue, setNoteValue] = React.useState('');
      const [rewriteOpen, setRewriteOpen] = React.useState(false);
      const [rewriteValue, setRewriteValue] = React.useState('');
      const [rewriteResult, setRewriteResult] = React.useState('');
      const [rewriteBusy, setRewriteBusy] = React.useState(false);
      const toastTimer = React.useRef(null);
      const noteInput = React.useRef(null);
      const noteOpenRef = React.useRef(false);
      const openNote = React.useCallback(() => {
        noteOpenRef.current = true;
        setNoteValue('');
        setNoteOpen(true);
      }, []);
      const closeNote = React.useCallback(() => {
        noteOpenRef.current = false;
        setNoteOpen(false);
      }, []);
      const openRewrite = React.useCallback(() => {
        noteOpenRef.current = true;
        setRewriteValue('');
        setRewriteResult('');
        setRewriteBusy(false);
        setRewriteOpen(true);
      }, []);
      const closeRewrite = React.useCallback(() => {
        noteOpenRef.current = false;
        setRewriteOpen(false);
        setRewriteBusy(false);
      }, []);

      const say = React.useCallback((message) => {
        setToast(message);
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 2200);
      }, []);

      React.useEffect(() => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      }, []);

      React.useEffect(() => {
        const isOwnUi = (node) => Boolean(
          node && typeof node.closest === 'function'
          && node.closest('.' + ROOT_CLASS + '-bar,.' + ROOT_CLASS + '-note,.' + ROOT_CLASS + '-rw'),
        );
        const readSelection = () => {
          if (noteOpenRef.current) return;
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            setSelection(null);
            return;
          }
          const text = sel.toString().trim();
          if (text === '') {
            setSelection(null);
            return;
          }
          if (selectedTextInField(sel.anchorNode) || selectedTextInField(sel.focusNode)) {
            setSelection(null);
            return;
          }
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (!rect || (rect.width === 0 && rect.height === 0)) {
            setSelection(null);
            return;
          }
          setSelection({ text, left: rect.left, top: rect.top, width: rect.width });
        };
        const onMouseUp = (event) => {
          if (isOwnUi(event.target)) return;
          readSelection();
        };
        const onSelectionChange = () => {
          // Focusing the note editor collapses the document selection; keep the
          // captured text and the open editor instead of closing it.
          if (noteOpenRef.current) return;
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) setSelection(null);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setSelection(null);
            closeNote();
            closeRewrite();
          }
        };
        const onScroll = () => {
          if (noteOpenRef.current) return;
          setSelection(null);
        };
        const onMouseDown = (event) => {
          if (noteOpenRef.current && !isOwnUi(event.target)) {
            closeNote();
            closeRewrite();
          }
        };
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('keyup', readSelection);
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('mousedown', onMouseDown, true);
        window.addEventListener('scroll', onScroll, true);
        return () => {
          document.removeEventListener('mouseup', onMouseUp);
          document.removeEventListener('keyup', readSelection);
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('mousedown', onMouseDown, true);
          window.removeEventListener('scroll', onScroll, true);
        };
      }, [closeNote, closeRewrite]);

      React.useEffect(() => {
        if (noteOpen && noteInput.current) noteInput.current.focus();
      }, [noteOpen]);

      const quote = useQuote();
      // 发送前一刻把引用内容写入草稿：DSH 没有 submit 钩子，只能在回车/点发送时抢先插入。
      React.useEffect(() => {
        if (quote === null) return undefined;
        const flush = () => {
          const composer = findComposer();
          if (composer === null) return;
          const flat = quote.text.replace(/\s+/g, ' ').trim();
          if (flat === '') return;
          try {
            composer.focus();
            document.execCommand('insertText', false, '> ' + flat + '\n\n');
          } catch (error) { /* ignored */ }
          setQuote(null);
        };
        const isSubmitButton = (node) => {
          if (node === null || typeof node.closest !== 'function') return false;
          const button = node.closest('button');
          if (button === null) return false;
          const composer = findComposer();
          const form = composer === null ? null : composer.closest('form');
          if (form !== null && form.contains(button) && button.type === 'submit') return true;
          const label = String(button.getAttribute('aria-label') || '');
          return /发送|send/i.test(label);
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
          const composer = findComposer();
          if (composer === null) return;
          if (!composer.contains(event.target) && event.target !== composer) return;
          flush();
        };
        const onPointerDown = (event) => {
          if (isSubmitButton(event.target)) flush();
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('mousedown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('mousedown', onPointerDown, true);
        };
      }, [quote]);

      // 引用是「会话内」的临时状态：输入框被重建（切会话/换页面）就清掉。
      // shell.overlay 拿不到 sessionId，所以用输入框节点身份作为会话标志。
      React.useEffect(() => {
        const timer = setInterval(() => {
          const current = quoteStore.current;
          if (current === null) return;
          const bound = current.composer;
          if (bound === undefined || bound === null) return;
          if (typeof bound.isConnected !== 'boolean') return;
          if (!bound.isConnected) setQuote(null);        // 旧输入框已卸载 → 换会话了
        }, 500);
        return () => clearInterval(timer);
      }, []);
      if (selection === null && toast === '' && quote === null) return null;
      const center = selection === null
        ? 0
        : Math.min(Math.max(selection.left + selection.width / 2, 60), window.innerWidth - 60);
      const top = selection === null ? 0 : Math.max(selection.top - 8, 44);

      const actions = [
        {
          key: 'copy',
          icon: '⧉',
          label: t('copy'),
          run: async (text) => {
            const ok = await copyText(text);
            say(ok ? t('copied') : t('copyFailed'));
          },
        },
        {
          key: 'ask',
          icon: '↳',
          label: t('ask'),
          run: (text) => {
            const flat = String(text).replace(/\s+/g, ' ').trim();
            if (flat === '') return;
            setQuote({ text: flat, at: Date.now(), composer: findComposer() });
            // 追问后把光标移到输入框末尾，用户可以直接开始打字
            const composer = findComposer();
            if (composer !== null) {
              try {
                composer.focus();
                const range = document.createRange();
                range.selectNodeContents(composer);
                range.collapse(false);
                const selection = window.getSelection();
                if (selection !== null) {
                  selection.removeAllRanges();
                  selection.addRange(range);
                }
              } catch (error) { /* 聚焦失败不影响引用 */ }
            }
            say(t('inserted'));
          },
        },
        {
          key: 'repo',
          icon: '📦',
          label: t('repo'),
          run: (text) => {
            void collectRepo(text);
          },
        },
        {
          key: 'shortcut',
          icon: '⌨',
          label: t('shortcut'),
          run: (text) => {
            void saveShortcut(text);
          },
        },
        {
          key: 'collect',
          icon: '☆',
          label: t('collect'),
          run: (text) => {
            void saveCollect(text);
          },
        },
        {
          key: 'deliver',
          icon: '⇥',
          label: t('deliver'),
          run: (text) => {
            void deliverToInbox(text);
          },
        },
        {
          key: 'rewrite',
          icon: '⇄',
          label: t('rewrite'),
          run: () => {
            openRewrite();
          },
        },
      ];

      const saveNote = async () => {
        const value = noteValue.trim();
        if (value === '' || selection === null) {
          closeNote();
          return;
        }
        const entry = { text: selection.text, note: value, at: new Date().toISOString() };
        const key = 'dsh-selection-notes';
        let list = [];
        try {
          list = JSON.parse(window.localStorage.getItem(key) || '[]');
          if (!Array.isArray(list)) list = [];
        } catch (error) {
          list = [];
        }
        list.push(entry);
        try {
          window.localStorage.setItem(key, JSON.stringify(list));
        } catch (error) {
          // storage may be unavailable; still try the Feishu write
        }
        closeNote();
        say(t('savingFeishu'));
        try {
          const response = await fetch('/plugins/selection-toolbar/note', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(entry),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload && payload.ok === true) {
            say(t('savedFeishu'));
          } else {
            const reason = payload && payload.message ? String(payload.message) : 'HTTP ' + response.status;
            say(t('savedLocalOnly') + '：' + reason);
          }
        } catch (error) {
          const reason = error && error.message ? error.message : String(error);
          say(t('savedLocalOnly') + '：' + reason);
        }
      };

      // 选中一段描述（比如「⌘⇧. 显示/隐藏隐藏文件」），点一下存进快捷键表。
      // 不做按键捕获：全局热键会被 Hammerspoon 先抢走，而系统快捷键本来
      // 就是一句知识而不是一次按键 —— 对这两类来说，选中文字更直接。
      // 选中一个 owner/repo，点「收录」→ 写进飞书「GitHub 优质项目收录」表。
      // 不做判断：选中什么就收什么。类型由脚本按 topics/名字猜，并把依据一起返回。
      const collectRepo = async (text) => {
        const value = String(text || '').trim();
        if (value === '') return;
        say(t('repo'));
        try {
          const response = await fetch('/plugins/selection-toolbar/repo-collect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: value }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload && payload.ok === true) {
            say(payload.message || t('repoSaved'));
          } else if (payload && payload.code === 10) {
            say(t('repoExists') + '：' + String(payload.message || '').slice(0, 80));
          } else {
            const reason = payload && payload.message ? String(payload.message) : 'HTTP ' + response.status;
            say(t('repoFailed') + '：' + reason.slice(0, 120));
          }
        } catch (error) {
          say(t('repoFailed'));
        }
      };

      const saveShortcut = async (text) => {
        const value = String(text || '').trim();
        if (value === '') return;
        try {
          const response = await fetch('/plugins/selection-toolbar/shortcut', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: value }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload && payload.ok === true) {
            const total = typeof payload.total === 'number' ? payload.total : 0;
            say(total > 0 ? t('shortcutSaved') + ' (' + total + ')' : t('shortcutSaved'));
          } else {
            const reason = payload && payload.message ? String(payload.message) : 'HTTP ' + response.status;
            say(t('shortcutFailed') + '：' + reason);
          }
        } catch (error) {
          say(t('shortcutFailed'));
        }
      };

      const saveCollect = async (text) => {
        if (text === '') return;
        say(t('collecting'));
        try {
          const response = await fetch('/plugins/selection-toolbar/note', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, note: '', at: new Date().toISOString() }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload && payload.ok === true) {
            say(t('collected'));
          } else {
            const reason = payload && payload.message ? String(payload.message) : 'HTTP ' + response.status;
            say(t('collectFailed') + '：' + reason);
          }
        } catch (error) {
          say(t('collectFailed') + '：' + (error && error.message ? error.message : String(error)));
        }
      };

      const deliverToInbox = async (text) => {
        if (text === '') return;
        say(t('delivering'));
        try {
          const response = await fetch('/plugins/selection-toolbar/deliver', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload && payload.ok === true) {
            const id = payload.recordId ? ' #' + payload.recordId : '';
            const similar = payload.similar ? '' : '';
            say(t('delivered') + id + similar);
          } else {
            const reason = payload && payload.message ? String(payload.message) : 'HTTP ' + response.status;
            say(t('deliverFailed') + '：' + reason);
          }
        } catch (error) {
          say(t('deliverFailed') + '：' + (error && error.message ? error.message : String(error)));
        }
      };

      const runRewrite = async () => {
        if (selection === null) return;
        setRewriteBusy(true);
        setRewriteResult('');
        try {
          const response = await fetch('/plugins/selection-toolbar/rewrite', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: selection.text, instruction: rewriteValue.trim() }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload && payload.ok === true && typeof payload.text === 'string') {
            setRewriteResult(payload.text);
          } else {
            const reason = payload && payload.message ? String(payload.message) : 'HTTP ' + response.status;
            say(t('rewriteFailed') + '：' + reason);
          }
        } catch (error) {
          say(t('rewriteFailed') + '：' + (error && error.message ? error.message : String(error)));
        } finally {
          setRewriteBusy(false);
        }
      };

      const copyRewriteResult = async () => {
        const ok = await copyText(rewriteResult);
        say(ok ? t('copied') : t('copyFailed'));
      };

      const insertRewriteResult = () => {
        const composer = findComposer();
        if (composer !== null) {
          try {
            composer.focus();
            if (document.execCommand('insertText', false, rewriteResult)) {
              say(t('inserted'));
              return;
            }
          } catch (error) {
            // fall through to copy
          }
        }
        void copyText(rewriteResult).then((ok) => say(ok ? t('pasteHint') : t('copyFailed')));
      };

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('style', { key: 'quote-style' }, `.dsh-selection-quote{position:fixed;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#26262b);border:1px solid var(--dsw-alias-border-l1,#3a3a40);box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:12px;color:var(--dsw-alias-label-secondary,#b6b6bf);z-index:9000}
          .dsh-selection-quote-bar{width:3px;height:16px;border-radius:2px;background:#7aa2ff;flex:none}
          .dsh-selection-quote-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .dsh-selection-quote-close{background:none;border:none;color:inherit;font-size:14px;cursor:pointer;line-height:1;padding:0 2px}`),
        h(QuoteBar, { key: 'quote-bar' }),
        selection !== null && !noteOpen && !rewriteOpen
          ? h('div', {
            key: 'bar',
            className: ROOT_CLASS + '-bar',
            style: { left: center + 'px', top: top + 'px' },
            onMouseDown: (event) => event.preventDefault(),
          }, actions.map((action) => h('button', {
            key: action.key,
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              try {
                const result = action.run(selection.text);
                if (result && typeof result.catch === 'function') {
                  result.catch(() => say(t('failed')));
                }
              } catch (error) {
                say(t('failed'));
              }
            },
          }, h('span', { className: 'ico', key: 'i' }, action.icon), h('span', { key: 'l' }, action.label))))
          : null,
        noteOpen && selection !== null
          ? h('div', {
            key: 'note',
            className: ROOT_CLASS + '-note',
            style: { left: center + 'px', top: top + 'px' },
          }, [
            h('input', {
              key: 'input',
              ref: noteInput,
              type: 'text',
              placeholder: t('notePlaceholder'),
              value: noteValue,
              onChange: (event) => setNoteValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveNote();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeNote();
                }
              },
            }),
            h('button', { key: 'save', type: 'button', onClick: saveNote }, t('save')),
            h('button', {
              key: 'cancel',
              type: 'button',
              onClick: () => closeNote(),
            }, t('cancel')),
          ])
          : null,
        rewriteOpen && selection !== null
          ? h('div', {
            key: 'rewrite',
            className: ROOT_CLASS + '-rw',
            style: { left: center + 'px', top: top + 'px' },
          }, [
            h('div', { key: 'head', className: ROOT_CLASS + '-rw-head' }, t('rewriteTitle')),
            h('div', { key: 'chips', className: ROOT_CLASS + '-rw-chips' },
              [
                ['chipPolish', t('chipPolish')],
                ['chipShorter', t('chipShorter')],
                ['chipXhs', t('chipXhs')],
                ['chipWechat', t('chipWechat')],
              ].map(([key, label]) => h('button', {
                key,
                type: 'button',
                onClick: () => setRewriteValue(label),
              }, label))),
            h('input', {
              key: 'input',
              type: 'text',
              placeholder: t('rewritePlaceholder'),
              value: rewriteValue,
              onChange: (event) => setRewriteValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (!rewriteBusy) void runRewrite();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeRewrite();
                }
              },
            }),
            rewriteResult !== ''
              ? h('div', { key: 'result', className: ROOT_CLASS + '-rw-result' }, rewriteResult)
              : null,
            h('div', { key: 'actions', className: ROOT_CLASS + '-rw-actions' }, [
              h('button', {
                key: 'run',
                type: 'button',
                disabled: rewriteBusy,
                onClick: () => { if (!rewriteBusy) void runRewrite(); },
              }, rewriteBusy ? t('rewriteRunning') : t('rewriteRun')),
              rewriteResult !== ''
                ? h('button', { key: 'copy', type: 'button', onClick: copyRewriteResult }, t('copyResult'))
                : null,
              rewriteResult !== ''
                ? h('button', { key: 'insert', type: 'button', onClick: insertRewriteResult }, t('insertResult'))
                : null,
              h('button', { key: 'close', type: 'button', onClick: () => closeRewrite() }, t('close')),
            ]),
          ])
          : null,
        toast !== ''
          ? h('div', { key: 'toast', className: ROOT_CLASS + '-toast' }, toast)
          : null,
      );
    }

    function QuoteBar() {
      const quote = useQuote();
      const [pos, setPos] = React.useState(null);
      // 输入框会随输入行数变高，position:fixed 的坐标必须跟着重算，
      // 否则引用条会停在旧位置、压住正文。
      React.useEffect(() => {
        if (!quote) { setPos(null); return undefined; }
        let raf = 0;
        const measure = () => {
          const node = quote.composer && quote.composer.isConnected ? quote.composer : findComposer();
          if (node === null) { setPos(null); return; }
          const rect = node.getBoundingClientRect();
          setPos({
            left: Math.max(12, rect.left + 10),
            width: Math.max(200, rect.width - 20),
            bottom: Math.max(12, window.innerHeight - rect.top + 8),
          });
        };
        const schedule = () => {
          if (raf !== 0) return;
          raf = requestAnimationFrame(() => { raf = 0; measure(); });
        };
        measure();
        const node = quote.composer && quote.composer.isConnected ? quote.composer : findComposer();
        const observer = typeof ResizeObserver !== 'undefined' && node !== null
          ? new ResizeObserver(schedule) : null;
        if (observer !== null) observer.observe(node);
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        const timer = setInterval(measure, 400);
        return () => {
          if (raf !== 0) cancelAnimationFrame(raf);
          if (observer !== null) observer.disconnect();
          window.removeEventListener('resize', schedule);
          window.removeEventListener('scroll', schedule, true);
          clearInterval(timer);
        };
      }, [quote]);
      if (!quote) return null;
      const preview = quote.text.length > 90 ? quote.text.slice(0, 90) + '…' : quote.text;
      const style = {
        position: 'fixed',
        left: (pos === null ? 12 : pos.left) + 'px',
        width: (pos === null ? 360 : pos.width) + 'px',
        bottom: (pos === null ? 120 : pos.bottom) + 'px',
        zIndex: 9000,
        visibility: pos === null ? 'hidden' : 'visible',
      };
      return h('div', { className: 'dsh-selection-quote', style }, [
        h('span', { key: 'bar', className: 'dsh-selection-quote-bar' }),
        h('span', { key: 'text', className: 'dsh-selection-quote-text', title: quote.text }, preview),
        h('button', {
          key: 'close',
          type: 'button',
          className: 'dsh-selection-quote-close',
          onClick: () => {
            setQuote(null);
            const composer = findComposer();
            if (composer !== null) { composer.focus(); }
          },
        }, '×'),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const zh = {
          repo: '收录',
          repoSaved: '已收录',
          repoFailed: '收录失败',
          repoExists: '已经收录过了',
          shortcut: '快捷键',
          shortcutSaved: '已保存快捷键',
          shortcutFailed: '保存快捷键失败',
          copy: '复制',
          speak: '朗读',
          ask: '追问',
          annotate: '注释',
          collect: '收藏',
          deliver: '投递',
          collecting: '正在收藏…',
          collected: '已收藏到飞书文档',
          collectFailed: '收藏失败',
          delivering: '正在投递到投递箱…',
          delivered: '已投递',
          copied: '已复制',
          copyFailed: '复制失败（可手动 ⌘C）',
          speaking: '朗读中…',
          speakFailed: '朗读失败（可能缺中文语音包）',
          inserted: '已插入输入框',
          pasteHint: '已复制，⌘V 粘贴后提问',
          noteSaved: '已保存第 {n} 条注释（本地）',
          savingFeishu: '正在写入飞书文档…',
          savedFeishu: '已写入飞书文档',
          savedLocalOnly: '仅保存到本地（飞书写入失败）',
          notePlaceholder: '给这段文字加注释…',
          rewrite: '改写',
          rewriteTitle: '改写选中的文字',
          rewritePlaceholder: '改写要求（留空=润色）',
          rewriteRun: '改写',
          rewriteRunning: '改写中…',
          rewriteFailed: '改写失败',
          chipPolish: '润色',
          chipShorter: '更简洁',
          chipXhs: '小红书风',
          chipWechat: '公众号风',
          copyResult: '复制结果',
          insertResult: '插入输入框',
          close: '关闭',
          save: '保存',
          cancel: '取消',
          failed: '出错了，请重试',
        };
        const en = {
          repo: 'Collect repo',
          repoSaved: 'Repository collected',
          repoFailed: 'Collecting the repository failed',
          repoExists: 'Already collected',
          shortcut: 'Shortcut',
          shortcutSaved: 'Shortcut saved',
          shortcutFailed: 'Saving the shortcut failed',
          copy: 'Copy',
          speak: 'Read aloud',
          ask: 'Follow up',
          annotate: 'Annotate',
          collect: 'Collect',
          deliver: 'Deliver',
          collecting: 'Collecting…',
          collected: 'Collected to the Feishu doc',
          collectFailed: 'Collect failed',
          delivering: 'Delivering to the inbox…',
          delivered: 'Delivered',
          copied: 'Copied',
          copyFailed: 'Copy failed — press ⌘C instead',
          speaking: 'Reading aloud…',
          speakFailed: 'Read aloud failed (no Chinese voice?)',
          inserted: 'Inserted into the composer',
          pasteHint: 'Copied — paste with ⌘V to ask',
          noteSaved: 'Saved note #{n} (local)',
          savingFeishu: 'Writing to the Feishu document…',
          savedFeishu: 'Written to the Feishu document',
          savedLocalOnly: 'Saved locally only (Feishu write failed)',
          notePlaceholder: 'Add a note to this text…',
          rewrite: 'Rewrite',
          rewriteTitle: 'Rewrite the selected text',
          rewritePlaceholder: 'How should it change? (empty = polish)',
          rewriteRun: 'Rewrite',
          rewriteRunning: 'Rewriting…',
          rewriteFailed: 'Rewrite failed',
          chipPolish: 'Polish',
          chipShorter: 'Shorter',
          chipXhs: 'Xiaohongshu style',
          chipWechat: 'WeChat article style',
          copyResult: 'Copy result',
          insertResult: 'Insert into composer',
          close: 'Close',
          save: 'Save',
          cancel: 'Cancel',
          failed: 'Something went wrong — try again',
        };

        let translate;
        try {
          ctx.effect(() => {
            const disposeZh = ctx.locale.register(NS, 'zh', zh);
            const disposeEn = ctx.locale.register(NS, 'en', en);
            return () => {
              disposeZh();
              disposeEn();
            };
          });
          translate = ctx.locale.bind(NS);
        } catch (error) {
          const locale = (() => {
            try {
              const snapshot = ctx.locale.getLocale();
              return (snapshot && snapshot.id) || 'zh';
            } catch (inner) {
              return 'zh';
            }
          })();
          const dictionary = String(locale).toLowerCase().startsWith('zh') ? zh : en;
          translate = (key) => (dictionary[key] !== undefined ? dictionary[key] : key);
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'selection-toolbar',
          order: 900,
        }, () => h(SelectionToolbar, { t: translate })));
        },
    };
  },
});
