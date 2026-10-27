/* 本地 HTML 原型批注层（由 prototype-annotations-server 提供）。 */
(function () {
  if (window.__prototypeAnnotationLoaded) return;
  window.__prototypeAnnotationLoaded = true;
  var script = document.currentScript;
  var file = (script && (script.getAttribute('data-file') || script.getAttribute('data-annotation-file'))) || '';
  var apiBase = (script && script.getAttribute('data-api')) || 'http://127.0.0.1:5053';
  if (!file) {
    file = (location.pathname.split('/').pop() || '').split('?')[0];
  }
  if (!file || !/\.html$/.test(file)) return;
  var annotationMode = false;
  var currentTarget = null;
  var panel = null;
  var countEl = null;

  var style = document.createElement('style');
  style.textContent = `
    .pa-btn{position:fixed;left:16px;bottom:110px;z-index:2147483000;min-height:44px;border:0;border-radius:999px;padding:0 16px;background:#185abd;color:#fff;font:600 14px/44px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;box-shadow:0 4px 14px rgba(23,32,51,.22);cursor:pointer}
    .pa-btn[data-active="1"]{background:#b3261e}
    .pa-submit{position:fixed;left:16px;bottom:164px;z-index:2147483000;min-height:40px;border:1px solid #185abd;border-radius:999px;padding:0 14px;background:#fff;color:#185abd;font:600 13px/40px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;box-shadow:0 2px 8px rgba(23,32,51,.12);cursor:pointer}
    .pa-count{position:fixed;left:112px;bottom:120px;z-index:2147483000;min-width:20px;height:20px;border-radius:10px;background:#172033;color:#fff;font:600 11px/20px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:0 5px}
    body.pa-mode *{cursor:crosshair !important}
    .pa-hover{outline:3px solid #185abd !important;outline-offset:2px !important;cursor:crosshair !important}
    .pa-box{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483001;background:#fff;border-radius:16px;box-shadow:0 12px 36px rgba(23,32,51,.24);padding:14px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#172033;max-width:480px;margin:0 auto}
    .pa-box h3{margin:0 0 6px;font-size:16px}
    .pa-box p{margin:0 0 8px;color:#6b7280;font-size:12px;word-break:break-all}
    .pa-box textarea{width:100%;box-sizing:border-box;min-height:96px;border:1px solid #d8dde6;border-radius:12px;padding:10px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;resize:vertical}
    .pa-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
    .pa-actions button{min-height:40px;border:0;border-radius:999px;padding:0 16px;font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer}
    .pa-cancel{background:#eef1f5;color:#172033}
    .pa-save{background:#185abd;color:#fff}
    .pa-toast{position:fixed;left:50%;bottom:170px;transform:translateX(-50%);z-index:2147483002;background:rgba(23,32,51,.94);color:#fff;border-radius:999px;padding:9px 16px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}
    .pa-toast.show{opacity:1}
  `;
  document.head.appendChild(style);

  function toast(text) {
    var el = document.querySelector('.pa-toast');
    if (!el) { el = document.createElement('div'); el.className = 'pa-toast'; document.body.appendChild(el); }
    el.textContent = text; el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function selectorOf(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node !== document.body && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      var cls = Array.prototype.slice.call(node.classList || [])
        .filter(function (c) { return !/^pa-/.test(c); }).slice(0, 2);
      if (cls.length) part += '.' + cls.map(function (c) { return CSS.escape(c); }).join('.');
      var nth = 1;
      var sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) nth += 1; sib = sib.previousElementSibling; }
      part += ':nth-of-type(' + nth + ')';
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function closeBox() {
    if (panel) { panel.remove(); panel = null; }
    if (currentTarget) currentTarget.classList.remove('pa-hover');
  }

  function openBox(target) {
    closeBox();
    currentTarget = target;
    target.classList.add('pa-hover');
    panel = document.createElement('div');
    panel.className = 'pa-box';
    var text = (target.innerText || target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    panel.innerHTML = '<h3>对这个位置批注</h3><p></p><textarea placeholder="例如：这里预订数量不能改，预订几双就补几双"></textarea><div class="pa-actions"><button type="button" class="pa-cancel">取消</button><button type="button" class="pa-save">保存并提交</button></div>';
    panel.querySelector('p').textContent = selectorOf(target) + (text ? ' · ' + text : '');
    document.body.appendChild(panel);
    var textarea = panel.querySelector('textarea');
    textarea.focus();
    panel.querySelector('.pa-cancel').onclick = closeBox;
    panel.querySelector('.pa-save').onclick = function () {
      var comment = textarea.value.trim();
      if (!comment) { textarea.focus(); return; }
      var save = panel.querySelector('.pa-save');
      save.disabled = true;
      fetch(apiBase + '/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: file,
          selector: selectorOf(target),
          snippet: (target.outerHTML || '').slice(0, 3000),
          text: text,
          comment: comment,
          url: location.href,
        }),
      }).then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
        .then(function (r) {
          if (!r.res.ok || !r.body.ok) throw new Error(r.body && r.body.error || 'save_failed');
          return fetch(apiBase + '/annotations/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: file }),
          });
        })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (!body.ok) throw new Error(body.error || 'submit_failed');
          var submitted = (body && body.submitted) || [];
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'html-annotate:submitted', file: file, annotations: submitted }, '*');
          }
          toast('批注已提交：' + body.count + ' 条');
          closeBox();
          loadCount();
          setMode(false);
        })
        .catch(function (err) { save.disabled = false; toast('保存失败：' + err.message); });
    };
  }

  var lastHover = null;
  function annotationTarget(event) {
    var target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target.closest('.pa-btn,.pa-box,.pa-count,.pa-toast')) return null;
    if (target === document.documentElement || target === document.body) return null;
    return target;
  }
  function annotationClick(event) {
    var target = annotationTarget(event);
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    openBox(target);
  }
  function annotationMove(event) {
    var target = annotationTarget(event);
    if (lastHover && lastHover !== target) lastHover.classList.remove('pa-hover');
    lastHover = target;
    if (target) target.classList.add('pa-hover');
  }
  function setMode(on) {
    annotationMode = on;
    var btn = document.querySelector('.pa-btn');
    btn.dataset.active = on ? '1' : '0';
    btn.textContent = on ? '退出批注' : '批注';
    if (on) {
      document.body.classList.add('pa-mode');
      document.addEventListener('click', annotationClick, true);
      document.addEventListener('mousemove', annotationMove, true);
    } else {
      document.body.classList.remove('pa-mode');
      document.removeEventListener('click', annotationClick, true);
      document.removeEventListener('mousemove', annotationMove, true);
      if (lastHover) { lastHover.classList.remove('pa-hover'); lastHover = null; }
      closeBox();
    }
  }

  function loadCount() {
    fetch(apiBase + '/annotations?file=' + encodeURIComponent(file))
      .then(function (r) { return r.json(); })
      .then(function (body) {
        var n = body && body.ok && Array.isArray(body.annotations) ? body.annotations.length : 0;
        countEl.textContent = String(n);
      }).catch(function () {});
  }

  function mount() {
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pa-btn'; btn.textContent = '批注';
    btn.addEventListener('click', function (e) { e.stopPropagation(); setMode(!annotationMode); });
    document.body.appendChild(btn);
    var submit = document.createElement('button');
    submit.type = 'button'; submit.className = 'pa-submit'; submit.textContent = '提交批注';
    submit.addEventListener('click', function (e) {
      e.stopPropagation();
      submit.disabled = true;
      fetch(apiBase + '/annotations/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: file }),
      }).then(function (r) { return r.json(); }).then(function (body) {
        if (!body.ok) throw new Error(body.error || 'submit_failed');
        var submitted = (body && body.submitted) || [];
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'html-annotate:submitted', file: file, annotations: submitted }, '*');
        }
        toast(body.marked ? ('已提交 ' + body.marked + ' 条批注') : '没有新批注需要提交');
        loadCount();
      }).catch(function (err) { toast('提交失败：' + err.message); })
        .finally(function () { submit.disabled = false; });
    });
    document.body.appendChild(submit);
    countEl = document.createElement('span');
    countEl.className = 'pa-count'; countEl.textContent = '0';
    document.body.appendChild(countEl);
    loadCount();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
