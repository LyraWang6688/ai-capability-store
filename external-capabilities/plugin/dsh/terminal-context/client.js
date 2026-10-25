/**
 * 界面侧 · 读终端画面（v0.3.0）
 *
 * 走的是"看屏幕"这条路，不是接口：终端是 xterm 渲染的 DOM，和对话在同一个页面里，
 * 所以直接读渲染出来的行即可 —— 和"豆包看着 Word 的界面操作 Word"同一个思路。
 *
 * 为什么不用 terminalController：客户端 `ctx` 上只有 `fiber`，服务名找不到；
 * 而 DOM 这条路不依赖任何内部 API。
 *
 * 三条硬约束（上次事故的教训）：
 *   1. inject: []        —— 没有依赖，就不可能 pending，不可能拖垮启动
 *   2. 全部 try/catch    —— 一个异常不该让界面白屏
 *   3. 只读              —— 不改终端、不发输入
 */
window.__ModuleLoader__.load({
  id: '@lyra_wang/dsh-terminal-context',
  factory() {
    const MAX_LINES = 60
    const readScreen = () => {
      // xterm 把可见区渲染成 .xterm-rows 下的若干行
      const rows = document.querySelectorAll('.xterm-rows > div')
      if (!rows.length) {
        const screen = document.querySelector('.xterm-screen')
        if (!screen) return null
        const text = (screen.innerText || '').split('\n')
        return text.slice(-MAX_LINES)
      }
      const lines = []
      for (const row of rows) {
        const text = (row.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+$/, '')
        lines.push(text)
      }
      while (lines.length && !lines[0].trim()) lines.shift()
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
      return lines.slice(-MAX_LINES)
    }
    return {
      inject: [],
      apply(ctx) {
        let last = ''
        const push = () => {
          try {
            const lines = readScreen()
            if (lines === null) return
            const joined = lines.join('\n')
            if (joined === last) return
            last = joined
            fetch('/plugins/terminal-context/push', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ lines, truncated: lines.length >= MAX_LINES, diag: null }),
            }).catch(() => {})
          } catch { /* 静默：读屏失败不能影响界面 */ }
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
