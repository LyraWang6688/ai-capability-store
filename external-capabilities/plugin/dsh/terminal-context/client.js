/**
 * 界面侧 · 读侧边栏（v0.4.0）
 *
 * 原来只读终端的 .xterm-rows。但侧边栏不止终端 —— 还可能挂着浏览器面板，
 * 两者都是"你眼前的东西"，都该进 Agent 的上下文。
 *
 * 做法：先按已知结构读终端；再扫一遍可能的侧边栏容器，把它们的结构一起推回去。
 * 为什么要推结构：不同面板的 DOM 差别很大，与其猜选择器，不如让页面自己报告
 * "有哪些容器、各有多少字"，下一版照着写就一次到位。
 *
 * 三条硬约束（v0.1 事故的教训）：
 *   inject: []      不声明依赖 → 不可能 pending → 不会拖垮启动
 *   全部 try/catch  读失败只是"没数据"，不白屏
 *   只读            不点击、不输入
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-terminal-context',
  factory() {
    const MAX = 80
    const clean = (t) => (t || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '')

    const readTerminal = () => {
      const rows = document.querySelectorAll('.xterm-rows > div')
      if (!rows.length) return null
      const out = []
      for (const r of rows) out.push(clean(r.textContent))
      while (out.length && !out[0].trim()) out.shift()
      while (out.length && !out[out.length - 1].trim()) out.pop()
      return out.slice(-MAX)
    }

    // 扫可能的侧边栏容器。命中后连结构和样本一起带回去，供下一版锁定选择器。
    const scanPanels = () => {
      const hits = []
      const seen = new Set()
      const nodes = document.querySelectorAll('[class*="sidebar"],[class*="rightbar"],[class*="panel"],[class*="terminal"],[class*="browser"],[id*="sidebar"],[id*="panel"]')
      for (const el of nodes) {
        if (seen.has(el) || el === document.body) continue
        seen.add(el)
        const text = clean(el.innerText || '')
        if (text.length < 40) continue
        hits.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 80),
          chars: text.length,
          sample: text.slice(0, 120).replace(/\n+/g, ' ⏎ '),
        })
        if (hits.length >= 8) break
      }
      return hits
    }

    return {
      inject: [],
      apply(ctx) {
        let lastKey = ''
        const push = () => {
          try {
            const lines = readTerminal()
            const panels = scanPanels()
            const key = JSON.stringify([lines && lines.slice(-5), panels.map((p) => p.cls + p.chars)])
            if (key === lastKey) return
            lastKey = key
            fetch('/plugins/terminal-context/push', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                lines: lines || [],
                truncated: !!(lines && lines.length >= MAX),
                diag: panels.length ? { panels } : null,
              }),
            }).catch(() => {})
          } catch { /* 静默 */ }
        }
        try {
          ctx.effect(() => {
            const first = setTimeout(push, 1200)
            const timer = setInterval(push, 2000)
            return () => { clearTimeout(first); clearInterval(timer) }
          })
        } catch { /* ignore */ }
      },
    }
  },
})
