/**
 * Host half of dsh-html-annotate.
 *
 * 只读本地 HTML 原型，运行时注入批注脚本；批注写同目录 sidecar JSON。
 * 源码文件不被修改。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_FILE = path.join(HERE, 'annotation.js')
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'html-annotate.json')
const ROUTE = '/plugins/html-annotate'
const DEFAULT_ROOT = path.join(os.homedir(), 'Documents', 'workplace', 'feishu-retail-ops', 'docs', 'prototypes')

export const inject = ['webServer', 'subprocess', 'tools']

function json(res, status, payload) {
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
    return
  }
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

async function readBody(req) {
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  if (req && typeof req.text === 'function') return req.text()
  return ''
}

async function rootDir() {
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'))
    if (config && typeof config.root === 'string' && config.root.trim()) return path.resolve(config.root)
  } catch { /* 没有配置就用默认 */ }
  return path.resolve(process.env.HTML_ANNOTATE_ROOT || DEFAULT_ROOT)
}

function cwdFromSession(sessionId, sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')) {
  const norm = String(sessionId || '').replace(/^session-/, '').trim()
  if (!norm) return ''
  try {
    for (const group of readdirSync(sessionsRoot)) {
      const file = path.join(sessionsRoot, group, `session-${norm}`, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const head = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0]
      const record = JSON.parse(head)
      return typeof record.cwd === 'string' ? record.cwd : ''
    }
  } catch {
    return ''
  }
  return ''
}

async function workspaceOf(sessionId) {
  const cwd = cwdFromSession(sessionId)
  if (cwd) return { root: path.resolve(cwd), source: 'session', project: path.basename(cwd) }
  return { root: await rootDir(), source: 'config', project: path.basename(await rootDir()) }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.next', '.nuxt', '.cache', 'vendor'])

async function safePath(value, sessionId) {
  const workspace = await workspaceOf(sessionId)
  const raw = String(value || '').trim()
  if (!raw || !/\.html?$/i.test(raw)) throw new Error('bad_file')
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace.root, raw)
  if (!full.startsWith(workspace.root + path.sep)) throw new Error('outside_workspace')
  const rel = path.relative(workspace.root, full).split(path.sep).join('/')
  return { base: rel, full, root: workspace.root, workspace }
}

async function listFiles(sessionId) {
  const workspace = await workspaceOf(sessionId)
  const out = []
  const walk = async (dir, depth) => {
    if (depth > 8 || out.length >= 300) return
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (out.length >= 300) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        out.push(path.relative(workspace.root, full).split(path.sep).join('/'))
      }
    }
  }
  await walk(workspace.root, 0)
  out.sort()
  return { files: out, root: workspace.root, source: workspace.source, project: workspace.project }
}

function isLocalPreviewUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

function isUrlKey(value) {
  return /^https?:\/\//i.test(String(value || ''))
}

function urlAnnotationFile(url) {
  const hash = createHash('sha256').update(String(url)).digest('hex').slice(0, 32)
  return path.join(os.homedir(), '.dsh', 'html-annotate', 'annotations', `${hash}.json`)
}

async function annotationTarget(file, sessionId) {
  if (isUrlKey(file)) {
    if (!isLocalPreviewUrl(file)) throw new Error('bad_preview_url')
    return { base: String(file), target: urlAnnotationFile(file), url: true }
  }
  const { base, full } = await safePath(file, sessionId)
  return { base, target: `${full}.annotations.json`, url: false }
}

async function injectPreview(html, pageUrl, sessionId, dshOrigin) {
  const cleaned = html.replace(/<script[^>]+annotation\.js[^>]*><\/script>/gi, '')
  const baseHref = new URL('.', pageUrl).href
  const tag = `<script src="${dshOrigin}${ROUTE}/annotation.js" data-file="${pageUrl}" data-session="${sessionId}" data-api="${dshOrigin}${ROUTE}"></script>`
  let out = cleaned
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n<base href="${baseHref}">`)
  else out = `<base href="${baseHref}">\n${out}`
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${tag}\n</body>`)
  return `${out}\n${tag}`
}

async function readPreviewConfig(sessionId) {
  const candidates = []
  try {
    const workspace = await workspaceOf(sessionId)
    candidates.push(path.join(workspace.root, '.dsh', 'html-annotate.json'))
  } catch { /* ignore */ }
  candidates.push(path.join(os.homedir(), '.dsh', 'html-annotate.json'))
  for (const file of candidates) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'))
      const previewUrl = String(data.previewUrl || data.url || '')
      if (previewUrl && isLocalPreviewUrl(previewUrl)) {
        return {
          ok: true,
          previewUrl,
          autoOpen: data.autoOpen === true,
          previewCommand: data.previewCommand && typeof data.previewCommand === 'object' ? data.previewCommand : null,
          direct: data.direct === true,
          chrome: data.chrome === true,
          split: data.split !== false,
          source: file,
        }
      }
    } catch { /* next */ }
  }
  return { ok: true, previewUrl: '', autoOpen: false }
}

const previewProcesses = new Map()
const previewTokens = new Map()
const pendingBySession = new Map()
// Chrome 顶层批注页没有 DSH 父窗口；这些提交由 client 轮询后注入当前会话。
const pendingAnnotationsBySession = new Map()

async function pageReady(url, timeoutMs = 800) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function waitReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pageReady(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function pageVersion(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('preview_version_failed')
  const text = await response.text()
  return createHash('sha1').update(text).digest('hex')
}

async function ensurePreview(ctx, sessionId, pageUrl, config) {
  if (await pageReady(pageUrl)) return { started: false }
  const commandConfig = config && config.previewCommand
  if (!commandConfig || !Array.isArray(commandConfig.command) || commandConfig.command.length === 0) {
    throw new Error('preview_not_running')
  }
  const existing = previewProcesses.get(sessionId)
  if (existing && !existing.handle.done.settled) {
    if (await waitReady(pageUrl, Number(commandConfig.readyTimeoutMs) || 30000)) return { started: true, reused: true }
    throw new Error('preview_start_timeout')
  }
  const workspace = await workspaceOf(sessionId)
  const cwd = path.resolve(workspace.root, String(commandConfig.cwd || '.'))
  if (!cwd.startsWith(workspace.root + path.sep) && cwd !== workspace.root) throw new Error('preview_cwd_outside_workspace')
  const env = {}
  if (commandConfig.env && typeof commandConfig.env === 'object') {
    for (const [key, value] of Object.entries(commandConfig.env)) {
      if (typeof value === 'string' || typeof value === 'number') env[String(key)] = String(value)
    }
  }
  const argv = commandConfig.command.map((item) => String(item))
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    ...(Object.keys(env).length ? { env } : {}),
    stdio: { stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
    graceMs: 5000,
  })
  previewProcesses.set(sessionId, { handle, pageUrl, startedAt: Date.now() })
  handle.done.catch(() => {}).finally(() => previewProcesses.delete(sessionId))
  const timeoutMs = Math.max(1000, Number(commandConfig.readyTimeoutMs) || 30000)
  if (!(await waitReady(pageUrl, timeoutMs))) {
    try { handle.terminate() } catch { /* ignore */ }
    throw new Error('preview_start_timeout')
  }
  return { started: true }
}

function injectScript(html, file, sessionId) {
  // 去掉旧的本地 annotation 脚本，避免双注入（脚本自身有 guard，先加载的会赢）。
  const cleaned = html.replace(/<script[^>]+annotation\.js[^>]*><\/script>/gi, '')
  const tag = `<script src="${ROUTE}/annotation.js" data-file="${file}" data-session="${sessionId}" data-api="${ROUTE}"></script>`
  if (/<\/body>/i.test(cleaned)) return cleaned.replace(/<\/body>/i, `${tag}\n</body>`)
  return `${cleaned}\n${tag}`
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  return new Response(body, { status, headers: { 'content-type': type } })
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/health`,
    handler: async (_req, res) => json(res, 200, { ok: true }),
  }), 'html-annotate: health')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/files`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      return json(res, 200, { ok: true, ...(await listFiles(url.searchParams.get('sessionId'))) })
    },
  }), 'html-annotate: files')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/config`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        return json(res, 200, await readPreviewConfig(url.searchParams.get('sessionId')))
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: config')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/preview/register`,
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const pageUrl = String(body.url || '')
        const sessionId = String(body.sessionId || '')
        if (!isLocalPreviewUrl(pageUrl)) return json(res, 400, { ok: false, error: 'bad_preview_url' })
        const config = await readPreviewConfig(sessionId)
        await ensurePreview(ctx, sessionId, pageUrl, config)
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
        previewTokens.set(token, { pageUrl, sessionId, createdAt: Date.now() })
        if (previewTokens.size > 100) {
          const oldest = [...previewTokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
          if (oldest) previewTokens.delete(oldest[0])
        }
        return json(res, 200, { ok: true, token })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: preview register')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/preview`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const token = String(url.searchParams.get('pid') || '')
        const entry = previewTokens.get(token)
        if (!entry) return send(res, 400, 'html-annotate: preview not registered')
        const pageUrl = entry.pageUrl
        const sessionId = entry.sessionId
        const config = await readPreviewConfig(sessionId)
        await ensurePreview(ctx, sessionId, pageUrl, config)
        const navPath = String(url.searchParams.get('path') || '')
        let targetUrl = pageUrl
        if (navPath) {
          const target = new URL(navPath, pageUrl)
          if (target.origin !== new URL(pageUrl).origin) return send(res, 400, 'html-annotate: cross-origin preview navigation')
          if (target.protocol !== 'http:' && target.protocol !== 'https:') return send(res, 400, 'html-annotate: bad preview navigation')
          targetUrl = target.href
        }
        const response = await fetch(targetUrl)
        if (!response.ok) return send(res, 502, `html-annotate: preview ${response.status}`)
        const type = response.headers.get('content-type') || ''
        if (!/text\/html/i.test(type)) return send(res, 415, 'html-annotate: preview is not html')
        const html = await response.text()
        const dshOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `127.0.0.1:${process.env.PORT || ''}`}`
        return send(res, 200, await injectPreview(html, targetUrl, sessionId, dshOrigin), 'text/html; charset=utf-8')
      } catch (error) {
        return send(res, 500, `html-annotate: ${error.message}`)
      }
    },
  }), 'html-annotate: local preview')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/pending`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const since = Number(url.searchParams.get('since') || 0)
      const sessionId = String(url.searchParams.get('sessionId') || '')
      const at = sessionId ? (pendingBySession.get(sessionId) || 0) : 0
      return json(res, 200, { ok: true, open: at > since, at })
    },
  }), 'html-annotate: pending')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/pending/ack`,
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const sessionId = String(body.sessionId || '')
        if (sessionId) pendingBySession.delete(sessionId)
      } catch { /* ignore malformed ack */ }
      return json(res, 200, { ok: true })
    },
  }), 'html-annotate: pending ack')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/pending-annotations`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const sessionId = String(url.searchParams.get('sessionId') || '')
      return json(res, 200, { ok: true, annotations: sessionId ? (pendingAnnotationsBySession.get(sessionId) || []) : [] })
    },
  }), 'html-annotate: pending annotations')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/pending-annotations/ack`,
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const sessionId = String(body.sessionId || '')
        if (sessionId) pendingAnnotationsBySession.delete(sessionId)
      } catch { /* ignore malformed ack */ }
      return json(res, 200, { ok: true })
    },
  }), 'html-annotate: pending annotations ack')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/preview/version`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const entry = previewTokens.get(String(url.searchParams.get('pid') || ''))
        if (!entry) return json(res, 400, { ok: false, error: 'preview_not_registered' })
        return json(res, 200, { ok: true, version: await pageVersion(entry.pageUrl) })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: preview version')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/annotation.js`,
    handler: async (_req, res) => send(res, 200, await fs.readFile(SCRIPT_FILE, 'utf8'), 'application/javascript; charset=utf-8'),
  }), 'html-annotate: script')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/page`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId')
        const { base, full } = await safePath(url.searchParams.get('file'), sessionId)
        return send(res, 200, injectScript(await fs.readFile(full, 'utf8'), base, sessionId), 'text/html; charset=utf-8')
      } catch (error) {
        return send(res, 404, `html-annotate: ${error.message}`)
      }
    },
  }), 'html-annotate: page')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/annotations`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method === 'GET') {
          const key = url.searchParams.get('file')
          const { base, target } = await annotationTarget(key, url.searchParams.get('sessionId'))
          try {
            return json(res, 200, { ok: true, file: base, annotations: JSON.parse(await fs.readFile(target, 'utf8')) })
          } catch {
            return json(res, 200, { ok: true, file: base, annotations: [] })
          }
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { base, target } = await annotationTarget(body.file, body.sessionId)
          let annotations = []
          try { annotations = JSON.parse(await fs.readFile(target, 'utf8')) } catch { /* new */ }
          const record = {
            id: `anno_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
            file: base,
            selector: String(body.selector || '').slice(0, 2000),
            snippet: String(body.snippet || '').slice(0, 6000),
            text: String(body.text || '').slice(0, 300),
            comment: String(body.comment || '').slice(0, 4000),
            url: String(body.url || '').slice(0, 2000),
            createdAt: new Date().toISOString(),
          }
          annotations.push(record)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, `${JSON.stringify(annotations, null, 2)}\n`, 'utf8')
          return json(res, 200, { ok: true, file: base, count: annotations.length, annotation: record })
        }
        return json(res, 405, { ok: false, error: 'method_not_allowed' })
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: annotations')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/annotations/submit`,
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const { base, target } = await annotationTarget(body.file, body.sessionId)
        let annotations = []
        try { annotations = JSON.parse(await fs.readFile(target, 'utf8')) } catch { /* none */ }
        const now = new Date().toISOString()
        const submitted = []
        annotations = annotations.map((item) => {
          if (item.submittedAt) return item
          const markedItem = { ...item, submittedAt: now }
          submitted.push(markedItem)
          return markedItem
        })
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, `${JSON.stringify(annotations, null, 2)}\n`, 'utf8')
        if (body.source === 'chrome' && body.sessionId && submitted.length) {
          const queue = pendingAnnotationsBySession.get(String(body.sessionId)) || []
          queue.push(...submitted)
          pendingAnnotationsBySession.set(String(body.sessionId), queue.slice(-100))
        }
        return json(res, 200, { ok: true, file: base, count: annotations.length, marked: submitted.length, submitted })
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: submit')

  ctx.effect(() => ctx.tools.register({
    name: 'open_html_annotate',
    description: 'Open the HTML annotation panel for the current project preview. Call this when the user asks to view or annotate a local preview page.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional target DSH session id. Defaults to the current session from the tool context.' },
        url: { type: 'string', description: 'Optional local preview URL. Defaults to the project .dsh/html-annotate.json previewUrl.' },
        browser: { type: 'string', enum: ['chrome', 'panel'], description: 'chrome = launch Google Chrome and split windows; panel = legacy DSH panel.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sessionId = String((args && args.sessionId) || exec?.agent?.id || '').trim()
      if (!sessionId) throw new Error('open_html_annotate requires a session id (tool context had none)')
      const config = await readPreviewConfig(sessionId)
      const pageUrl = String((args && args.url) || config.previewUrl || '').trim()
      const useChrome = String((args && args.browser) || (config.chrome ? 'chrome' : 'panel')) === 'chrome'
      if (useChrome) {
        if (!isLocalPreviewUrl(pageUrl)) throw new Error('open_html_annotate: chrome mode needs a local preview URL')
        await ensurePreview(ctx, sessionId, pageUrl, config)
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
        previewTokens.set(token, { pageUrl, sessionId, createdAt: Date.now() })
        const origin = String(process.env.DSH_WEB_URL || 'http://127.0.0.1:64660').replace(/\/$/, '')
        const previewUrl = `${origin}${ROUTE}/preview?pid=${encodeURIComponent(token)}`
        try {
          ctx.subprocess.spawn({
            argv: ['open', '-na', 'Google Chrome', '--args', '--new-window', previewUrl],
            stdio: { stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
            graceMs: 5000,
          })
        } catch (error) {
          throw new Error('打开 Google Chrome 失败：' + error.message)
        }
        if (config.split !== false) {
          setTimeout(() => {
            try {
              ctx.subprocess.spawn({ argv: ['hs', '-c', '_G.splitDSHChrome()'], stdio: { stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000 })
            } catch { /* Hammerspoon optional */ }
          }, 1200)
        }
        return { ok: true, mode: 'chrome', message: '已在 Google Chrome 打开标注页，并请求左右分屏', previewUrl, sessionId }
      }
      pendingBySession.set(sessionId, Date.now())
      return { ok: true, mode: 'panel', message: 'HTML annotation panel requested', sessionId }
    },
  }), 'html-annotate: open tool')

  ctx.effect(() => () => {
    for (const entry of previewProcesses.values()) {
      try { entry.handle.terminate() } catch { /* ignore */ }
    }
    previewProcesses.clear()
    previewTokens.clear()
  }, 'html-annotate: preview processes')
}
