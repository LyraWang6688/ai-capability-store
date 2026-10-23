/**
 * Client half of the diagram-card bundle.
 *
 * Reads fenced code blocks marked ```dsh-diagram in the conversation and
 * replaces them with a structured card diagram. The JSON stays the source of
 * truth: the transcript keeps the block (hidden), this layer only *paints* it.
 *
 * No network, no host route, no credentials. Text is inserted with
 * textContent, never innerHTML — the only innerHTML use is the static icon
 * table below, which is a compile-time constant of this file.
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-diagram-card',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROOT = 'dshdg-root';
    const FENCE = 'dsh-diagram';
    const HASH_ATTR = 'data-dshdg-hash';
    const SCAN_DEBOUNCE_MS = 250;
    const SCAN_INTERVAL_MS = 2000;

    /* ---------------------------------------------------------------- icons */
    // 24x24 viewBox. {S} is substituted with the rendered pixel size.
    const ICONS = {
      user: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4C10.3431 4 9 5.34315 9 7C9 8.65685 10.3431 10 12 10C13.6569 10 15 8.65685 15 7C15 5.34315 13.6569 4 12 4ZM7 7C7 4.23858 9.23858 2 12 2C14.7614 2 17 4.23858 17 7C17 9.76142 14.7614 12 12 12C9.23858 12 7 9.76142 7 7ZM12.0001 15C8.3441 15 5.5 17.7501 5.5 20.9999C5.5 21.5522 5.05228 21.9999 4.5 21.9999C3.94772 21.9999 3.5 21.5522 3.5 20.9999C3.5 16.5178 7.37176 13 12.0001 13C16.6283 13 20.5 16.5179 20.5 20.9999C20.5 21.5522 20.0523 21.9999 19.5 21.9999C18.9477 21.9999 18.5 21.5522 18.5 20.9999C18.5 17.7502 15.656 15 12.0001 15Z"/></svg>',
      arrow: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.707 18.707a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 15.586V6a1 1 0 1 1 2 0v9.586l3.293-3.293a1 1 0 0 1 1.414 1.414l-5 5Z"/></svg>',
      brain: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M12 13h4"/><path d="M12 18h6a2 2 0 0 1 2 2v1"/><path d="M12 8h8"/><path d="M16 8V5a2 2 0 0 1 2-2"/><circle cx="16" cy="13" r=".5"/><circle cx="18" cy="3" r=".5"/><circle cx="20" cy="21" r=".5"/><circle cx="20" cy="8" r=".5"/></svg>',
      book: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 6.017c0-1.104-.907-2.037-2.049-2l-.594.025c-2.732.148-4.952.705-7.333 1.953l-.512.279-.087.054a1 1 0 0 0 .971 1.737l.092-.046.454-.246C15.195 6.59 17.26 6.106 20 6.016v11.837c-3.034.046-5.42.582-7.99 1.99l-.517.295-.086.056a1 1 0 0 0 1.009 1.715l.09-.047.455-.258c2.105-1.157 4.045-1.645 6.537-1.738l.543-.014a1.995 1.995 0 0 0 1.95-1.8l.009-.198V6.017Z"/><path d="M2 6.017c0-1.104.907-2.037 2.049-2l.594.025c2.732.148 4.952.705 7.333 1.953l.512.279.087.054a1 1 0 0 1-.971 1.737l-.092-.046-.454-.246C8.805 6.59 6.74 6.106 4 6.016v11.837c3.034.046 5.42.582 7.99 1.99l.517.295.086.056a1 1 0 0 1-1.009 1.715l-.09-.047-.455-.258c-2.105-1.157-4.045-1.644-6.537-1.738l-.543-.014a1.995 1.995 0 0 1-1.95-1.8L2 17.855V6.017Z"/><path d="M13 7.5v13h-2v-13h2Z"/></svg>',
      tools: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.3649 2.42847C14.9354 2.42848 15.4918 2.49476 16.026 2.62085C16.0986 2.63799 16.2317 2.66855 16.3483 2.70972C16.4646 2.75084 16.6519 2.83101 16.8239 3.00073L16.8961 3.07886L16.9762 3.18433C17.1496 3.44164 17.2233 3.76192 17.1774 4.07007C17.1325 4.3706 16.9819 4.57747 16.8981 4.68042C16.8202 4.776 16.7216 4.87254 16.6637 4.93042L14.5944 7.00073C13.9303 7.66499 13.9302 8.74184 14.5944 9.40601C15.2586 10.07 16.3354 10.07 16.9996 9.40601L19.07 7.33569C19.1279 7.2777 19.2244 7.17914 19.32 7.10132C19.423 7.01742 19.6298 6.86685 19.9303 6.82202L20.0631 6.8103C20.3286 6.80007 20.5947 6.8758 20.8151 7.02417L20.9215 7.10425L20.9996 7.17651C21.1693 7.34853 21.2496 7.53584 21.2907 7.6521C21.3319 7.76875 21.3614 7.90177 21.3786 7.97437C21.5047 8.5086 21.5719 9.06495 21.5719 9.6355C21.5718 13.6156 18.345 16.8424 14.3649 16.8425C13.6244 16.8425 12.9085 16.7297 12.234 16.5212L8.14906 20.6082C6.83567 21.9215 4.70566 21.9214 3.39222 20.6082C2.0788 19.2947 2.07883 17.1648 3.39222 15.8513L7.47816 11.7644C7.27001 11.0905 7.15786 10.3753 7.15785 9.6355C7.15785 5.65524 10.3846 2.42847 14.3649 2.42847ZM9.15785 9.6355C9.15786 10.2678 9.27042 10.8715 9.47523 11.4294C9.48886 11.4666 9.51448 11.5353 9.53383 11.5994C9.55507 11.6698 9.58778 11.795 9.58949 11.9509C9.59153 12.1427 9.55081 12.3285 9.4684 12.5017C9.35802 12.7336 9.16496 12.9078 9.15199 12.9207L4.80629 17.2654C4.27405 17.7977 4.27424 18.6607 4.80629 19.1931C5.33868 19.7255 6.2026 19.7255 6.735 19.1931L11.0797 14.8484C11.0926 14.8354 11.2668 14.6424 11.4987 14.532L11.6305 14.4773C11.7646 14.4312 11.9048 14.4094 12.0485 14.4109L12.1598 14.4167C12.2644 14.4278 12.3482 14.4506 12.401 14.4666C12.4649 14.4858 12.5328 14.5115 12.57 14.5251C13.128 14.73 13.7325 14.8425 14.3649 14.8425C17.2317 14.8424 19.5567 12.5253 19.5709 9.66187L18.4137 10.8201C16.9685 12.2651 14.6255 12.2651 13.1803 10.8201C11.735 9.37478 11.735 7.03098 13.1803 5.58569L14.3366 4.42847C11.4738 4.44362 9.15785 6.76919 9.15785 9.6355Z"/></svg>',
      loop: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.06956 10.8763C3.6233 6.43564 7.40965 3 12 3C14.2823 3 16.4028 3.85067 18.0118 5.25439V4C18.0118 3.44772 18.4595 3 19.0118 3C19.5641 3 20.0118 3.44772 20.0118 4V8C20.0118 8.55228 19.5641 9 19.0118 9H15C14.4477 9 14 8.55228 14 8C14 7.44772 14.4477 7 15 7H16.9571C15.6756 5.76379 13.9101 5 12 5C8.43107 5 5.48465 7.67174 5.05419 11.1237C4.98585 11.6718 4.48617 12.0607 3.93813 11.9923C3.39009 11.924 3.00122 11.4243 3.06956 10.8763ZM20.0618 12.0077C20.6099 12.076 20.9987 12.5757 20.9304 13.1237C20.3767 17.5644 16.5903 21 12 21C9.72321 21 7.6076 20.1535 5.99998 18.7559V20C5.99998 20.5523 5.55226 21 4.99998 21C4.44769 21 3.99998 20.5523 3.99998 20V16C3.99998 15.4477 4.44769 15 4.99998 15H8.99998C9.55226 15 9.99998 15.4477 9.99998 16C9.99998 16.5523 9.55226 17 8.99998 17H7.04283C8.32432 18.2362 10.0899 19 12 19C15.5689 19 18.5153 16.3283 18.9458 12.8763C19.0141 12.3282 19.5138 11.9393 20.0618 12.0077Z"/></svg>',
      shield: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.344 10.036a1 1 0 1 0-1.688-1.072l-2.474 3.896-.943-1.034a1 1 0 0 0-1.478 1.348l1.826 2a1 1 0 0 0 1.583-.138l3.174-5Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M13.203 1.935a3 3 0 0 0-2.405 0l-6 2.625A3 3 0 0 0 3 7.308V13a9 9 0 1 0 18 0V7.308a3 3 0 0 0-1.797-2.748l-6-2.625Zm-1.604 1.832a1 1 0 0 1 .802 0l6 2.625a1 1 0 0 1 .599.916V13a7 7 0 1 1-14 0V7.308a1 1 0 0 1 .6-.916l6-2.625Z"/></svg>',
      clipboard: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>',
      database: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.00633 5.5C6.02321 5.53319 6.07042 5.60366 6.19525 5.70906C6.42458 5.9027 6.81573 6.12215 7.38659 6.32603C8.5196 6.73067 10.1506 7 12 7C13.8494 7 15.4804 6.73067 16.6134 6.32603C17.1843 6.12215 17.5754 5.9027 17.8048 5.70906C17.9296 5.60366 17.9768 5.53319 17.9937 5.5C17.9768 5.46681 17.9296 5.39634 17.8048 5.29094C17.5754 5.0973 17.1843 4.87785 16.6134 4.67397C15.4804 4.26933 13.8494 4 12 4C10.1506 4 8.5196 4.26933 7.38659 4.67397C6.81573 4.87785 6.42458 5.0973 6.19525 5.29094C6.07042 5.39634 6.02321 5.46681 6.00633 5.5ZM18 7.91726C17.7726 8.02403 17.5333 8.12123 17.2861 8.20951C15.8856 8.70968 14.0166 9 12 9C9.98341 9 8.1144 8.70968 6.71392 8.20951C6.46674 8.12123 6.22738 8.02403 6 7.91726V11.986C6.00906 12.0096 6.04856 12.0852 6.19525 12.2091C6.42458 12.4027 6.81573 12.6221 7.38659 12.826C8.5196 13.2307 10.1506 13.5 12 13.5C13.8494 13.5 15.4804 13.2307 16.6134 12.826C17.1843 12.6221 17.5754 12.4027 17.8048 12.2091C17.9514 12.0852 17.9909 12.0096 18 11.986V7.91726ZM18 14.4173C17.7726 14.524 17.5333 14.6212 17.2861 14.7095C15.8856 15.2097 14.0166 15.5 12 15.5C9.98341 15.5 8.1144 15.2097 6.71392 14.7095C6.46674 14.6212 6.22738 14.524 6 14.4173V18.486C6.00906 18.5096 6.04856 18.5852 6.19525 18.7091C6.42458 18.9027 6.81573 19.1221 7.38659 19.326C8.5196 19.7307 10.1506 20 12 20C13.8494 20 15.4804 19.7307 16.6134 19.326C17.1843 19.1221 17.5754 18.9027 17.8048 18.7091C17.9514 18.5852 17.9909 18.5096 18 18.486V14.4173ZM4 5.5C4 4.74631 4.43048 4.16346 4.90494 3.76283C5.38405 3.35829 6.01803 3.03902 6.71392 2.79049C8.1144 2.29032 9.98341 2 12 2C14.0166 2 15.8856 2.29032 17.2861 2.79049C17.982 3.03902 18.616 3.35829 19.0951 3.76283C19.5695 4.16346 20 4.74631 20 5.5V18.5C20 19.2537 19.5695 19.8365 19.0951 20.2372C18.616 20.6417 17.982 20.961 17.2861 21.2095C15.8856 21.7097 14.0166 22 12 22C9.98341 22 8.1144 21.7097 6.71392 21.2095C6.01803 20.961 5.38405 20.6417 4.90494 20.2372C4.43048 19.8365 4 19.2537 4 18.5V5.5Z"/></svg>',
      check: '<svg width="{S}" height="{S}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>',
    };

    /* ------------------------------------------------------------------ css */
    const CSS = `
.dshdg-root{
  --ddg-panel:#0E0E0E; --ddg-card:#303030; --ddg-num:#212121;
  --ddg-line:rgba(255,255,255,.15); --ddg-divider:rgba(255,255,255,.08);
  --ddg-text:#EDEDED; --ddg-text2:#CDCDCD; --ddg-text3:#AFAFAF;
  --ddg-info:#2C67C5; --ddg-info-bg:rgba(30,115,190,.07); --ddg-info-line:rgba(30,115,190,.25);
  --ddg-info-line-strong:rgba(30,115,190,.45);
  --ddg-success:#40C977; --ddg-success-bg:rgba(22,163,74,.07); --ddg-success-line:rgba(22,163,74,.3);
  width:100%; max-width:720px; margin:8px auto; box-sizing:border-box;
  border:1px solid var(--ddg-line); border-radius:14px; padding:10px;
  display:flex; flex-direction:column; gap:8px;
  color:var(--ddg-text); background:transparent;
  font:400 15px/22px -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  text-align:left; user-select:text;
}
.dshdg-root.dshdg-light{
  --ddg-panel:#F6F6F7; --ddg-card:#ECECEE; --ddg-num:#E3E3E6;
  --ddg-line:rgba(0,0,0,.12); --ddg-divider:rgba(0,0,0,.08);
  --ddg-text:#111114; --ddg-text2:#4A4A52; --ddg-text3:#8A8A93;
  --ddg-info:#1F5AAE; --ddg-info-bg:rgba(30,115,190,.05); --ddg-info-line:rgba(30,115,190,.22);
  --ddg-info-line-strong:rgba(30,115,190,.35);
  --ddg-success:#1B8F4E; --ddg-success-bg:rgba(22,163,74,.06); --ddg-success-line:rgba(22,163,74,.28);
}
.dshdg-root *{box-sizing:border-box}
.dshdg-title{margin:0;font-size:14px;font-weight:500;line-height:18px;color:var(--ddg-text)}
.dshdg-arrow{display:flex;justify-content:center;align-items:center;height:12px;color:var(--ddg-text3)}
.dshdg-node{width:100%;background:var(--ddg-panel);border-radius:10px;padding:9px;
  display:flex;flex-direction:column;align-items:center;gap:2px}
.dshdg-node-title{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--ddg-text)}
.dshdg-node-sub{font-size:13px;line-height:16px;color:var(--ddg-text2)}
.dshdg-ico{display:flex;align-items:center;justify-content:center;color:var(--ddg-text2)}
.dshdg-node .dshdg-ico{color:var(--ddg-text2)}
.dshdg-node.dshdg-result .dshdg-ico{color:var(--ddg-success)}
.dshdg-group{width:100%;background:var(--ddg-info-bg);border:1px solid var(--ddg-info-line);
  border-radius:10px;padding:9px;display:flex;flex-direction:column;gap:8px}
.dshdg-group-head{display:flex;align-items:center;justify-content:center;gap:6px;
  font-size:15px;font-weight:600;line-height:22px;color:var(--ddg-text)}
.dshdg-group-head .dshdg-ico{color:var(--ddg-info)}
.dshdg-divider{height:1px;border:0;margin:0;background:var(--ddg-divider)}
.dshdg-label{margin:0;font-size:12px;font-weight:500;line-height:14px;text-align:center;color:var(--ddg-text)}
.dshdg-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dshdg-card{background:var(--ddg-card);border-radius:7px;padding:6px;
  display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center}
.dshdg-card-en{margin:0;font-size:12px;font-weight:500;line-height:14px;color:var(--ddg-text)}
.dshdg-card-cn{font-size:13px;line-height:16px;color:var(--ddg-text2)}
.dshdg-pill{align-self:center;background:var(--ddg-panel);border-radius:10px;
  padding:6px 14px;font-size:15px;font-weight:600;line-height:22px}
.dshdg-loop{width:100%;border:2px solid var(--ddg-info-line-strong);border-radius:14px;
  padding:10px;display:flex;flex-direction:column;gap:6px}
.dshdg-step{display:flex;flex-direction:column;gap:2px}
.dshdg-step-head{display:flex;align-items:center;gap:6px}
.dshdg-num{width:26px;height:26px;flex:none;border-radius:9999px;background:var(--ddg-num);
  display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:500;color:var(--ddg-text)}
.dshdg-step-title{margin:0;font-size:13px;font-weight:500;line-height:18px;color:var(--ddg-text)}
.dshdg-step-desc{margin:0;font-size:12px;line-height:14px;color:var(--ddg-text2)}
.dshdg-loopback{display:flex;align-items:center;justify-content:center;gap:6px;
  font-size:13px;font-weight:500;line-height:18px;color:var(--ddg-text)}
.dshdg-loopback .dshdg-ico{color:var(--ddg-info)}
.dshdg-done{align-self:center;background:var(--ddg-success-bg);border:1px solid var(--ddg-success-line);
  border-radius:10px;padding:6px 14px;font-size:15px;font-weight:500;line-height:22px;color:var(--ddg-success)}
@media (max-width:560px){.dshdg-grid{grid-template-columns:1fr}}
`;

    /* --------------------------------------------------------------- helpers */
    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function icon(name, size) {
      const template = ICONS[name];
      if (!template) return null;
      const span = el('span', 'dshdg-ico');
      span.innerHTML = template.replace(/\{S\}/g, String(size || 16)); // static table, not user input
      return span;
    }

    function arrow() {
      const box = el('div', 'dshdg-arrow');
      const node = icon('arrow', 16);
      if (node) box.appendChild(node);
      return box;
    }

    function isDarkTheme() {
      try {
        // DSH marks dark mode with `data-ds-dark-theme`; it is NOT `data-theme`.
        const root = document.documentElement;
        if (root.hasAttribute('data-ds-dark-theme')) return true;
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return true;
        if (root.getAttribute('data-theme') === 'light') return false;
        const luma = (value) => {
          const m = String(value || '').match(/\d+(\.\d+)?/g);
          if (!m || m.length < 3) return null;
          const [r, g, b] = m.map(Number);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        // Fallback 1: first opaque background on the page.
        for (const el of [document.body, root]) {
          if (!el) continue;
          const value = luma(getComputedStyle(el).backgroundColor);
          if (value !== null) return value < 140;
        }
        // Fallback 2: text colour is the other half of the same signal.
        // Light text on an unreadable background means a dark theme.
        for (const el of [document.body, root]) {
          if (!el) continue;
          const value = luma(getComputedStyle(el).color);
          if (value !== null) return value > 140;
        }
      } catch (_) { /* fall through */ }
      return true; // DSH ships dark by default
    }

    function hashText(text) {
      let hash = 5381;
      for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
      return String(hash >>> 0);
    }

    /* -------------------------------------------------------------- renderers */
    function nodeBox(box, result) {
      const wrap = el('div', 'dshdg-node' + (result ? ' dshdg-result' : ''));
      const ico = icon(box.icon || (result ? 'check' : 'user'), 18);
      if (ico) wrap.appendChild(ico);
      wrap.appendChild(el('p', 'dshdg-node-title', box.title || ''));
      if (box.sub) wrap.appendChild(el('span', 'dshdg-node-sub', box.sub));
      return wrap;
    }

    function renderLayered(spec) {
      if (spec.top) {
        root_append(spec.__root, nodeBox(spec.top, false));
        root_append(spec.__root, arrow());
      }
      if (spec.group) {
        const group = el('div', 'dshdg-group');
        const head = el('div', 'dshdg-group-head');
        const ico = icon(spec.group.icon || 'brain', 16);
        if (ico) head.appendChild(ico);
        head.appendChild(el('span', null, spec.group.title || ''));
        group.appendChild(head);
        group.appendChild(el('hr', 'dshdg-divider'));
        if (spec.group.label) group.appendChild(el('p', 'dshdg-label', spec.group.label));
        const cards = Array.isArray(spec.group.cards) ? spec.group.cards : [];
        if (cards.length) {
          const grid = el('div', 'dshdg-grid');
          for (const card of cards) {
            const cell = el('div', 'dshdg-card');
            const cardIcon = icon(card.icon || 'book', 16);
            if (cardIcon) cell.appendChild(cardIcon);
            cell.appendChild(el('p', 'dshdg-card-en', card.en || ''));
            if (card.cn) cell.appendChild(el('span', 'dshdg-card-cn', card.cn));
            grid.appendChild(cell);
          }
          group.appendChild(grid);
        }
        root_append(spec.__root, group);
        if (spec.bottom) root_append(spec.__root, arrow());
      }
      if (spec.bottom) root_append(spec.__root, nodeBox(spec.bottom, true));
    }

    function renderFlow(spec) {
      if (spec.start) {
        root_append(spec.__root, el('div', 'dshdg-pill', spec.start));
        root_append(spec.__root, arrow());
      }
      const steps = Array.isArray(spec.steps) ? spec.steps : [];
      if (steps.length) {
        const loopBox = el('div', 'dshdg-loop');
        steps.forEach((step, index) => {
          const block = el('div', 'dshdg-step');
          const head = el('div', 'dshdg-step-head');
          head.appendChild(el('span', 'dshdg-num', step.n !== undefined ? step.n : index + 1));
          head.appendChild(el('p', 'dshdg-step-title', step.title || ''));
          block.appendChild(head);
          if (step.desc) block.appendChild(el('p', 'dshdg-step-desc', step.desc));
          if (index < steps.length - 1) block.appendChild(arrow());
          loopBox.appendChild(block);
        });
        if (spec.loopback) {
          const back = el('div', 'dshdg-loopback');
          const ico = icon('loop', 16);
          if (ico) back.appendChild(ico);
          back.appendChild(el('span', null, spec.loopback));
          loopBox.appendChild(back);
        }
        root_append(spec.__root, loopBox);
        if (spec.end) root_append(spec.__root, arrow());
      }
      if (spec.end) root_append(spec.__root, el('div', 'dshdg-done', spec.end));
    }

    function root_append(root, child) {
      if (child) root.appendChild(child);
    }

    function render(spec) {
      if (!spec || typeof spec !== 'object') return null;
      const root = el('div', ROOT + (isDarkTheme() ? '' : ' dshdg-light'));
      if (spec.title) root.appendChild(el('p', 'dshdg-title', spec.title));
      const config = Object.assign({}, spec, { __root: root });
      if (spec.type === 'flow') renderFlow(config);
      else renderLayered(config);
      if (root.childElementCount <= (spec.title ? 1 : 0)) return null;
      return root;
    }

    /* ------------------------------------------------------------------ scan */
    function scan() {
      const blocks = document.querySelectorAll('pre');
      for (const pre of blocks) {
        const code = pre.querySelector('code') || pre;
        const classes = String((code && code.className) || '') + ' ' + String(pre.className || '');
        const text = String((code && code.textContent) || '').trim();
        if (!text.startsWith('{')) continue;
        if (!classes.includes(FENCE) && !text.includes('"type"')) continue;

        let spec;
        try {
          spec = JSON.parse(text);
        } catch (_) {
          continue; // still streaming, or not our payload — leave it visible
        }
        if (!spec || typeof spec.type !== 'string') continue;

        const hash = hashText(text);
        const sibling = pre.nextElementSibling;
        if (sibling && sibling.classList && sibling.classList.contains(ROOT)) {
          if (sibling.getAttribute(HASH_ATTR) === hash) {
            pre.style.display = 'none';
            continue;
          }
          sibling.remove();
        }

        let card = null;
        try {
          card = render(spec);
        } catch (_) {
          continue;
        }
        if (!card) continue;
        card.setAttribute(HASH_ATTR, hash);
        if (pre.parentNode) pre.parentNode.insertBefore(card, pre.nextSibling);
        pre.style.display = 'none';
      }
    }

    let scheduled = null;
    function schedule() {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        try { scan(); } catch (_) { /* never break the transcript */ }
      }, SCAN_DEBOUNCE_MS);
    }

    let booted = false;
    function Boot() {
      React.useEffect(() => {
        if (booted) return undefined;
        booted = true;
        const observer = new MutationObserver(schedule);
        try {
          observer.observe(document.body, { childList: true, subtree: true });
        } catch (_) { /* body may not be ready yet; interval still covers us */ }
        const interval = setInterval(() => {
          try { scan(); } catch (_) { /* ignore */ }
        }, SCAN_INTERVAL_MS);
        try { scan(); } catch (_) { /* ignore */ }
        return () => {
          observer.disconnect();
          clearInterval(interval);
          booted = false;
        };
      }, []);
      return null;
    }

    // Diagnostics handle. Rendering failures are silent by design (the block
    // simply stays visible), so an explicit handle is what makes the silent
    // case debuggable from the console: __dshdg.scan() forces a pass and
    // __dshdg.render(spec) renders one spec without touching the transcript.
    try {
      window.__dshdg = { render: render, scan: scan, hash: hashText, css: CSS, version: '0.1.1' };
    } catch (_) { /* non-browser context */ }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dshdg-boot',
          order: 960,
        }, () => h(React.Fragment, null, h('style', null, CSS), h(Boot))));
      },
    };
  },
});
