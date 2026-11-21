/**
 * Host half of the quick-commands plugin.
 *
 * One global list of the operator's reusable snippets — prompts and commands
 * typed often enough that retyping them is waste. It is not session-scoped:
 * the same list shows up in every conversation, and it is stored as one JSON
 * document under <DSH_HOME>/storages/quick-commands/commands.json.
 *
 * Routes (same-origin, behind DSH connection auth):
 *   GET  /plugins/quick-commands/state            -> the whole list
 *   POST /plugins/quick-commands/action           -> add / update / remove
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROUTE_BASE = '/plugins/quick-commands'
const STORE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'quick-commands')
const STORE_FILE = join(STORE_DIR, 'commands.json')

const MAX_COMMANDS = 300
const MAX_TITLE = 80
const MAX_TEXT = 8000

function nowIso() {
  return new Date().toISOString()
}

function titleOf(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

function textOf(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT)
}

function createDoc() {
  return { version: 1, seq: 1, commands: [], updatedAt: nowIso() }
}

function normalizeDoc(doc) {
  doc.version = 1
  doc.commands = Array.isArray(doc.commands) ? doc.commands.filter((entry) => entry && typeof entry.id === 'string') : []
  if (!Number.isInteger(doc.seq) || doc.seq < 1) doc.seq = doc.commands.length + 1
  for (const entry of doc.commands) {
    if (typeof entry.title !== 'string') entry.title = ''
    if (typeof entry.text !== 'string') entry.text = ''
    if (typeof entry.createdAt !== 'string') entry.createdAt = nowIso()
    if (typeof entry.updatedAt !== 'string') entry.updatedAt = entry.createdAt
  }
  doc.commands = doc.commands.filter((entry) => entry.text !== '')
  return doc
}

/* ------------------------------- persistence ------------------------------ */

let queue = Promise.resolve()

function withLock(task) {
  const run = queue.then(() => task(), () => task())
  queue = run.then(() => undefined, () => undefined)
  return run
}

async function readDoc() {
  try {
    const raw = await readFile(STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.commands)) return normalizeDoc(parsed)
    return createDoc()
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return createDoc()
    throw error
  }
}

async function writeDoc(doc) {
  await mkdir(STORE_DIR, { recursive: true })
  const temporary = STORE_FILE + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(temporary, STORE_FILE)
}

function mutateDoc(change) {
  return withLock(async () => {
    const doc = await readDoc()
    change(doc)
    doc.updatedAt = nowIso()
    await writeDoc(doc)
    return doc
  })
}

/* --------------------------------- the model ------------------------------- */

function viewDoc(doc) {
  return {
    updatedAt: doc.updatedAt,
    commands: doc.commands.map((entry) => ({
      id: entry.id,
      title: entry.title,
      text: entry.text,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  }
}

function requireCommand(doc, id) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('commandId is required')
  const entry = doc.commands.find((candidate) => candidate.id === id.trim())
  if (entry === undefined) throw new Error('unknown command: ' + id.trim())
  return entry
}

function applyAction(doc, body) {
  const action = String((body && body.action) || '')
  if (action === 'add') {
    const text = textOf(body.text)
    if (text === '') throw new Error('text is required')
    if (doc.commands.length >= MAX_COMMANDS) throw new Error('this list already holds ' + MAX_COMMANDS + ' commands')
    const at = nowIso()
    const id = 'c' + doc.seq
    doc.seq += 1
    doc.commands.unshift({ id, title: titleOf(body.title), text, createdAt: at, updatedAt: at })
    return { id }
  }
  if (action === 'update') {
    const entry = requireCommand(doc, body.id)
    const text = textOf(body.text)
    if (text === '') throw new Error('text is required')
    entry.title = titleOf(body.title)
    entry.text = text
    entry.updatedAt = nowIso()
    return { id: entry.id }
  }
  if (action === 'remove') {
    const entry = requireCommand(doc, body.id)
    doc.commands = doc.commands.filter((candidate) => candidate.id !== entry.id)
    return { id: entry.id }
  }
  throw new Error('unknown action: ' + (action || '(none)'))
}

/* ------------------------------ browser API ------------------------------- */

function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.writeHead(status)
  res.end(JSON.stringify(payload))
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function connectionRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || typeof connection.requestRejection !== 'function') return undefined
  try {
    return connection.requestRejection({ headers: req.headers })
  } catch {
    return undefined
  }
}

/* --------------------------------- plugin --------------------------------- */

export const inject = ['webServer']

export function apply(ctx) {
  const stateHandler = async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, message: 'method not allowed' })
      return
    }
    const rejection = connectionRejection(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, message: 'not authorized' })
      return
    }
    try {
      const doc = await readDoc()
      sendJson(res, 200, { ok: true, list: viewDoc(doc) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('quick-commands: read failed: ' + message)
      sendJson(res, 400, { ok: false, message })
    }
  }

  const actionHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'method not allowed' })
      return
    }
    const rejection = connectionRejection(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, message: 'not authorized' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const doc = await mutateDoc((current) => applyAction(current, body))
      sendJson(res, 200, { ok: true, list: viewDoc(doc) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('quick-commands: action failed: ' + message)
      sendJson(res, 400, { ok: false, message })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/state', handler: stateHandler }), 'quick-commands: state route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/action', handler: actionHandler }), 'quick-commands: action route')
}
