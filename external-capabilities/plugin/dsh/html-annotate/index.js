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

async function safeFile(name) {
  const base = path.basename(String(name || '').trim())
  if (!base || base !== String(name || '').trim() || !/^[A-Za-z0-9._-]+\.html$/.test(base)) throw new Error('bad_file')
  const root = await rootDir()
  const full = path.join(root, base)
  if (!full.startsWith(root + path.sep)) throw new Error('bad_file')
  return { base, full, root }
}

async function listFiles() {
  const root = await rootDir()
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && /\.html$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function injectScript(html, file) {
  // 去掉旧的本地 annotation 脚本，避免双注入（脚本自身有 guard，先加载的会赢）。
  const cleaned = html.replace(/<script[^>]+annotation\.js[^>]*><\/script>/gi, '')
  const tag = `<script src="${ROUTE}/annotation.js" data-file="${file}" data-api="${ROUTE}"></script>`
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
    handler: async (_req, res) => json(res, 200, { ok: true, files: await listFiles(), root: await rootDir() }),
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
        const { base, full } = await safeFile(url.searchParams.get('file'))
        return send(res, 200, injectScript(await fs.readFile(full, 'utf8'), base), 'text/html; charset=utf-8')
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
          const { base, full } = await safeFile(url.searchParams.get('file'))
          try {
            return json(res, 200, { ok: true, file: base, annotations: JSON.parse(await fs.readFile(`${full}.annotations.json`, 'utf8')) })
          } catch {
            return json(res, 200, { ok: true, file: base, annotations: [] })
          }
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { base, full } = await safeFile(body.file)
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
        const { base, full } = await safeFile(body.file)
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
