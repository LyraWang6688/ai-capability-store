/**
 * Client half of the selection toolbar bundle.
 *
 * Registers one `shell.overlay` entry: a frame-wide floating layer that shows
 * a small toolbar above the text the user has just selected in the
 * conversation, with copy / read-aloud / follow-up / annotate actions.
 */
window.__ModuleLoader__.load({
  id: '@local/selection-toolbar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = '@local/selection-toolbar';
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
      .${ROOT_CLASS}-note button:hover{background:var(--dsw-alias-bg-layer-2,#3a3a41)}`;

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
      const { t } = props;
      const [selection, setSelection] = React.useState(null);
      const [toast, setToast] = React.useState('');
      const [noteOpen, setNoteOpen] = React.useState(false);
      const [noteValue, setNoteValue] = React.useState('');
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
          && node.closest('.' + ROOT_CLASS + '-bar,.' + ROOT_CLASS + '-note'),
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
          }
        };
        const onScroll = () => {
          if (noteOpenRef.current) return;
          setSelection(null);
        };
        const onMouseDown = (event) => {
          if (noteOpenRef.current && !isOwnUi(event.target)) closeNote();
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
      }, [closeNote]);

      React.useEffect(() => {
        if (noteOpen && noteInput.current) noteInput.current.focus();
      }, [noteOpen]);

      if (selection === null && toast === '') return null;

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
            const composer = findComposer();
            if (composer !== null) {
              try {
                composer.focus();
                if (document.execCommand('insertText', false, text)) {
                  say(t('inserted'));
                  return;
                }
              } catch (error) {
                // fall through to copy
              }
            }
            void copyText(text).then((ok) => say(ok ? t('pasteHint') : t('copyFailed')));
          },
        },
        {
          key: 'note',
          icon: '✎',
          label: t('annotate'),
          run: () => {
            openNote();
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

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        selection !== null && !noteOpen
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
        toast !== ''
          ? h('div', { key: 'toast', className: ROOT_CLASS + '-toast' }, toast)
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const zh = {
          copy: '复制',
          speak: '朗读',
          ask: '追问',
          annotate: '注释',
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
          save: '保存',
          cancel: '取消',
          failed: '出错了，请重试',
        };
        const en = {
          copy: 'Copy',
          speak: 'Read aloud',
          ask: 'Follow up',
          annotate: 'Annotate',
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
