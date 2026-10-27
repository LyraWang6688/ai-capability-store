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
import { zstdDecompressSync } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_FILE = path.join(HERE, 'annotation.js')
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'html-annotate.json')
const ROUTE = '/plugins/html-annotate'
const DEFAULT_ROOT = path.join(os.homedir(), 'Documents', 'workplace', 'feishu-retail-ops', 'docs', 'prototypes')

export const inject = ['webServer']

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
          const { base, full } = await safePath(url.searchParams.get('file'), url.searchParams.get('sessionId'))
          try {
            return json(res, 200, { ok: true, file: base, annotations: JSON.parse(await fs.readFile(`${full}.annotations.json`, 'utf8')) })
          } catch {
            return json(res, 200, { ok: true, file: base, annotations: [] })
          }
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { base, full } = await safePath(body.file, body.sessionId)
          const target = `${full}.annotations.json`
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
        const { base, full } = await safePath(body.file, body.sessionId)
        const target = `${full}.annotations.json`
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
        await fs.writeFile(target, `${JSON.stringify(annotations, null, 2)}\n`, 'utf8')
        return json(res, 200, { ok: true, file: base, count: annotations.length, marked: submitted.length, submitted })
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: submit')
}
