#!/usr/bin/env node
/**
 * 信源可用性校验 —— 用真实 Chrome 打开，读页面里真的渲染出了什么。
 *
 * 为什么不能用 curl：
 *   curl 只看状态码，而状态码会骗人。实测到的两种骗法：
 *     200 可能是单页应用的空壳 —— 任何路径都返回 200，浏览器里却是 Page Not Found
 *     403 可能只是不让命令行进 —— developers.openai.com 对 curl 403，
 *         浏览器里完全正常（实测标题 "Plugin development for ChatGPT and Codex"）
 * 所以判据只能是：标题正常 + 正文够长 + 没有 not-found 字样。
 *
 * 零依赖：用 Node 内建的 WebSocket 直连 Chrome DevTools Protocol。
 *
 * 用法：
 *   node procedures/source-check/check.mjs                  # 检查 sources.yaml 里全部源
 *   node procedures/source-check/check.mjs <url> [url...]   # 只检查指定 URL
 *   node procedures/source-check/check.mjs --json           # 只输出 JSON
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 浏览器路径可配：本机是 Chrome.app，CI 里是 chromium。
// 这条很重要 —— 本地和 CI 的网络环境不同，源能不能打开必须在 CI 里判，
// 本机测出来的「403 / 连不上」只反映这台机器在中国大陆。
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MIN_TEXT = 200
const TIMEOUT = 25000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const json = argv.includes('--json')
  const urls = argv.filter((a) => /^https?:/.test(a))
  return { json, urls }
}

function loadSources() {
  const file = join(process.cwd(), 'procedures/platform-intel/sources.yaml')
  if (!existsSync(file)) return []
  const out = []
  let cur = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const id = line.match(/^  ([a-z0-9-]+):\s*$/)
    if (id) { cur = id[1]; continue }
    const url = line.match(/^    url:\s*"(http[^"]+)"/)
    if (url && cur) out.push({ id: cur, url: url[1] })
  }
  return out
}

async function launchChrome() {
  const dir = mkdtempSync(join(tmpdir(), 'source-check-'))
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // CI（容器/root）里 Chrome 起不来就是因为这两条：没有 setuid sandbox，
    // /dev/shm 太小。本机加这两条也无害。
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' })

  const portFile = join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (port) return { proc, dir, port }
    }
    await sleep(100)
  }
  throw new Error('Chrome 没起来（DevToolsActivePort 没出现）')
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }
  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = ++seq
      ws.send(JSON.stringify({ id, method, params, sessionId }))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) }
        }, TIMEOUT)
      })
    },
    close() { try { ws.close() } catch {} },
  }
}

async function checkOne(client, url) {
  const started = Date.now()
  let target
  try {
    target = await client.send('Target.createTarget', { url: 'about:blank' })
    const att = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const sid = att.sessionId
    await client.send('Page.enable', {}, sid)
    await client.send('Page.navigate', { url }, sid)
    // 等 load + 一点渲染时间（SPA 要跑完才看得出是不是 404）
    for (let i = 0; i < 40; i += 1) {
      await sleep(500)
      const { result } = await client.send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && document.title.length > 0',
        returnByValue: true,
      }, sid)
      if (result.value) break
    }
    await sleep(1200)
    const { result } = await client.send('Runtime.evaluate', {
      expression: `(() => ({
        title: document.title || '',
        contentType: document.contentType || '',
        xmlLen: (document.documentElement ? document.documentElement.textContent || '' : '').length,
        h1: (document.querySelector('h1') || {}).innerText || '',
        textLen: (document.body && document.body.innerText || '').length,
        head: ((document.body && document.body.innerText) || '').slice(0, 200).replace(/\\s+/g, ' '),
      }))()`,
      returnByValue: true,
    }, sid)
    const v = result.value || {}
    const blob = `${v.title} ${v.head}`.toLowerCase()
    let verdict = 'ok'
    // XML / JSON / 纯文本源没有 <title>，按正文长度判
    if (v.contentType && !/html/i.test(v.contentType)) {
      verdict = (v.xmlLen || 0) > 50 ? 'ok' : 'empty'
      v.title = v.title || `(非 HTML: ${v.contentType}, ${v.xmlLen} 字符)`
      return { url, verdict, ms: Date.now() - started, ...v }
    }
    if (!v.title) verdict = 'empty'
    else if ((v.textLen || 0) < MIN_TEXT) {
      await sleep(3000)
      const again = await client.send('Runtime.evaluate', {
        expression: '((document.body && document.body.innerText) || "").length',
        returnByValue: true,
      }, sid)
      v.textLen = Math.max(v.textLen || 0, again.result.value || 0)
    }
    if (!v.title) verdict = 'empty'
    else if (/page not found|404|not found|页面不存在/.test(blob)) verdict = 'notfound'
    // Cloudflare 之类的验证页：标题像正常页面（"Just a moment..."），正文几百字
    // 全在说"正在检查浏览器"。它长得像可用，但拿不到任何内容 —— 不单独判就会
    // 一直被当成 OK。claude.ai/directory 就是这种。
    else if (/just a moment|attention required|checking your browser|verify you are human|enable javascript and cookies/.test(blob)) verdict = 'challenge'
    else if ((v.textLen || 0) < MIN_TEXT) verdict = 'thin'
    return { url, verdict, ms: Date.now() - started, ...v }
  } catch (error) {
    return { url, verdict: 'unreachable', ms: Date.now() - started, error: String(error.message || error) }
  } finally {
    if (target) { try { await client.send('Target.closeTarget', { targetId: target.targetId }) } catch {} }
  }
}

const { json, urls } = parseArgs(process.argv.slice(2))
const targets = urls.length ? urls.map((url) => ({ id: url, url })) : loadSources()
if (!targets.length) { console.error('没有可检查的 URL'); process.exit(1) }

const { proc, dir, port } = await launchChrome()
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const client = cdp(version.webSocketDebuggerUrl)
await client.ready

const results = []
for (const t of targets) results.push({ id: t.id, ...(await checkOne(client, t.url)) })

client.close()
proc.kill()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

const bad = results.filter((r) => r.verdict !== 'ok')
if (json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const r of results) {
    const mark = r.verdict === 'ok' ? 'OK  ' : 'FAIL'
    console.log(`${mark} ${r.verdict.padEnd(11)} ${r.id.padEnd(28)} ${(r.title || '').slice(0, 52)}`)
  }
  console.log(`\n${results.length} 个源，${bad.length} 个有问题`)
}
process.exit(bad.length ? 1 : 0)
