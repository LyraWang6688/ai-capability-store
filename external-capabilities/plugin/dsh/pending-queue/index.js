/**
 * Host half of the pending-send queue.
 *
 * The panel is a scratchpad for messages the user is not ready to send yet:
 * one JSON document per session under <DSH_HOME>/storages/pending-queue, read
 * and written through this plugin's own browser routes. Nothing here appends a
 * session event, and nothing here sends anything: pushing a row into the chat
 * happens in the client half through the composer's own input actions, so a
 * queued row behaves exactly like text the user typed themselves.
 *
 * A row is a list of segments, not one string. A quote is its own segment so
 * the client half can rebuild it with inputActions.insertQuote() — a real
 * quote block, not a literal "> " prefix.
 *
 * Storage: <DSH_HOME>/storages/pending-queue/<sessionId>.json.
 * DSH_HOME defaults to ~/.dsh.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The routes this plugin owns on the browser HTTP carrier. */
const ROUTE_BASE = '/plugins/pending-queue'

/** One file per session; the id is validated before it reaches a path. */
const STORE_DIR = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'storages',
  'pending-queue',
)

/** Session ids are opaque but filesystem-safe in every shipped deployment. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

/** Bounded so one runaway session cannot grow the document without limit. */
const MAX_ITEMS = 200
const MAX_TEXT = 4000
const MAX_TOTAL = 12000

function nowIso() {
  return new Date().toISOString()
}

/** One segment's text: newlines survive, edges do not. */
function textOf(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT)
}

/**
 * A row is a list of segments, not one string: a quote travels as its own
 * segment so the composer can rebuild it as a real quote block instead of a
 * literal "> " prefix.
 */
function segmentsOf(value) {
  if (!Array.isArray(value)) throw new Error('segments must be an array')
  const segments = []
  let total = 0
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') throw new Error('invalid segment')
    if (raw.type !== 'text' && raw.type !== 'quote') throw new Error('unknown segment type: ' + String(raw.type))
    const text = textOf(raw.text)
    if (text === '') continue
    total += text.length
    if (total > MAX_TOTAL) throw new Error('this row is too long (max ' + MAX_TOTAL + ' characters)')
    segments.push({ type: raw.type, text })
  }
  if (segments.length === 0) throw new Error('text is required')
  return segments
}

/** 'segments' is the shape the panel writes; a bare 'text' stays accepted. */
function segmentsFromBody(body) {
  if (body !== null && typeof body === 'object' && Array.isArray(body.segments)) return segmentsOf(body.segments)
  const text = textOf(body && body.text)
  if (text === '') throw new Error('text is required')
  return [{ type: 'text', text }]
}

/** The flattened form for readers that only want one string. */
function flattenSegments(segments) {
  return segments
    .map((segment) => (segment.type === 'quote'
      ? segment.text.split('\n').map((line) => '> ' + line).join('\n')
      : segment.text))
    .join('\n\n')
}

function createDoc(sessionId) {
  return {
    version: 2,
    sessionId,
    seq: 1,
    items: [],
    updatedAt: nowIso(),
  }
}

function fileFor(sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id')
  return join(STORE_DIR, sessionId + '.json')
}

/* ------------------------------- persistence ------------------------------ */

let queue = Promise.resolve()

/** Serialize read-modify-write cycles so two windows cannot lose one edit. */
function withLock(task) {
  const run = queue.then(() => task(), () => task())
  queue = run.then(() => undefined, () => undefined)
  return run
}

async function readDoc(sessionId) {
  try {
    const raw = await readFile(fileFor(sessionId), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && (parsed.version === 1 || parsed.version === 2) && Array.isArray(parsed.items)) {
      return normalizeDoc(parsed, sessionId)
    }
    return createDoc(sessionId)
  } catch (error) {
    // A missing or unreadable document is an empty queue, not a failure: the
    // tab must still open in a session that never had one.
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return createDoc(sessionId)
    throw error
  }
}

/** Fill fields an older document may lack, and lift v1 text rows to segments. */
function normalizeDoc(doc, sessionId) {
  doc.version = 2
  doc.sessionId = sessionId
  doc.items = doc.items.filter((item) => item && typeof item.id === 'string')
  if (!Number.isInteger(doc.seq) || doc.seq < 1) doc.seq = doc.items.length + 1
  for (const item of doc.items) {
    if (!Array.isArray(item.segments)) {
      const text = typeof item.text === 'string' ? item.text : ''
      item.segments = text.trim() === '' ? [] : [{ type: 'text', text }]
    }
    item.segments = item.segments.filter((segment) => segment
      && (segment.type === 'text' || segment.type === 'quote')
      && typeof segment.text === 'string'
      && segment.text !== '')
    delete item.text
    if (typeof item.createdAt !== 'string') item.createdAt = nowIso()
    if (typeof item.updatedAt !== 'string') item.updatedAt = item.createdAt
    if (typeof item.sentAt !== 'string') delete item.sentAt
  }
  doc.items = doc.items.filter((item) => item.segments.length > 0)
  return doc
}

async function writeDoc(doc) {
  await mkdir(STORE_DIR, { recursive: true })
  const target = fileFor(doc.sessionId)
  const temporary = target + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(temporary, target)
}

/** Read, apply one change, persist. */
function mutateDoc(sessionId, change) {
  return withLock(async () => {
    const doc = await readDoc(sessionId)
    change(doc)
    doc.updatedAt = nowIso()
    await writeDoc(doc)
    return doc
  })
}

/* -------------------------------- the model ------------------------------- */

function findItem(doc, id) {
  return doc.items.find((item) => item.id === id)
}

function requireItem(doc, id) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('itemId is required')
  const item = findItem(doc, id.trim())
  if (item === undefined) throw new Error('unknown item: ' + id.trim())
  return item
}

/** Apply one panel write; every action is validated before it mutates. */
function applyAction(doc, body) {
  const action = String((body && body.action) || '')
  if (action === 'add') {
    const segments = segmentsFromBody(body)
    if (doc.items.length >= MAX_ITEMS) {
      throw new Error('this queue already holds ' + MAX_ITEMS + ' rows; send or delete some first')
    }
    const at = nowIso()
    const id = 'q' + doc.seq
    doc.seq += 1
    doc.items.push({ id, segments, createdAt: at, updatedAt: at })
    return { id }
  }
  if (action === 'update') {
    const item = requireItem(doc, body.id)
    item.segments = segmentsFromBody(body)
    item.updatedAt = nowIso()
    return { id: item.id }
  }
  if (action === 'remove') {
    const item = requireItem(doc, body.id)
    doc.items = doc.items.filter((entry) => entry.id !== item.id)
    return { id: item.id }
  }
  if (action === 'move') {
    const item = requireItem(doc, body.id)
    const direction = body.direction === 'up' ? -1 : body.direction === 'down' ? 1 : 0
    if (direction === 0) throw new Error('direction must be up or down')
    const index = doc.items.indexOf(item)
    const target = index + direction
    if (target < 0 || target >= doc.items.length) return { id: item.id }
    doc.items.splice(index, 1)
    doc.items.splice(target, 0, item)
    return { id: item.id }
  }
  if (action === 'markSent' || action === 'restore') {
    const item = requireItem(doc, body.id)
    if (action === 'markSent') item.sentAt = nowIso()
    else delete item.sentAt
    item.updatedAt = nowIso()
    return { id: item.id }
  }
  if (action === 'clearSent') {
    doc.items = doc.items.filter((item) => typeof item.sentAt !== 'string')
    return {}
  }
  throw new Error('unknown action: ' + (action || '(none)'))
}

/** The compact shape both the browser and the tool result read. */
function viewDoc(doc) {
  return {
    updatedAt: doc.updatedAt,
    items: doc.items.map((item) => ({
      id: item.id,
      segments: item.segments.map((segment) => ({ type: segment.type, text: segment.text })),
      text: flattenSegments(item.segments),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      sentAt: typeof item.sentAt === 'string' ? item.sentAt : null,
    })),
  }
}

/* ------------------------------ browser API ------------------------------- */

function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.writeHead(status)
  res.end(JSON.stringify(payload))
}

function readJsonBody(req, limit = 64 * 1024) {
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

/** Reuse the host's own browser authentication for this plugin's routes. */
function connectionRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || typeof connection.requestRejection !== 'function') return undefined
  try {
    return connection.requestRejection({ headers: req.headers })
  } catch {
    return undefined
  }
}

function sessionIdOf(value) {
  const sessionId = typeof value === 'string' ? value.trim() : ''
  if (!SESSION_ID.test(sessionId)) throw new Error('missing or invalid sessionId')
  return sessionId
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
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
      const doc = await readDoc(sessionId)
      sendJson(res, 200, { ok: true, queue: viewDoc(doc) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('pending-queue: read failed: ' + message)
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
      const sessionId = sessionIdOf(body && body.sessionId)
      const doc = await mutateDoc(sessionId, (current) => applyAction(current, body))
      sendJson(res, 200, { ok: true, queue: viewDoc(doc) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('pending-queue: action failed: ' + message)
      sendJson(res, 400, { ok: false, message })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/state', handler: stateHandler }),
    'pending-queue: state route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/action', handler: actionHandler }),
    'pending-queue: action route',
  )
}
