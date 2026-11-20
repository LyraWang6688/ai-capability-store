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
 * quote block, not a literal "> " prefix. An image is its own segment too, but
 * it is stored as a file on this machine and arrives at the model as a path it
 * can read with read_image: the composer's attachment pipeline only accepts
 * browser-owned draft ids, which a sidebar panel cannot mint.
 *
 * Storage: <DSH_HOME>/storages/pending-queue/<sessionId>.json
 * Assets:  <DSH_HOME>/storages/pending-queue/assets/<sessionId>/<id>.<ext>
 * DSH_HOME defaults to ~/.dsh.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

/** The routes this plugin owns on the browser HTTP carrier. */
const ROUTE_BASE = '/plugins/pending-queue'

/** One file per session; the id is validated before it reaches a path. */
const STORE_DIR = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'storages',
  'pending-queue',
)
const ASSET_DIR = join(STORE_DIR, 'assets')

/** Session ids are opaque but filesystem-safe in every shipped deployment. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

/** Bounded so one runaway session cannot grow the document without limit. */
const MAX_ITEMS = 200
const MAX_TEXT = 4000
const MAX_TOTAL = 12000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
/** Stored asset names are generated here, never taken from the browser. */
const ASSET_NAME = /^[a-z0-9-]+\.(?:png|jpe?g|webp|gif)$/

function nowIso() {
  return new Date().toISOString()
}

/** One segment's text: newlines survive, edges do not. */
function textOf(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT)
}

function assetDirFor(sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id')
  return join(ASSET_DIR, sessionId)
}

/**
 * A row is a list of segments: text, quote, or image. A quote travels as its
 * own segment so the composer can rebuild it as a real quote block; an image
 * travels as a path inside this plugin's asset directory.
 */
function segmentsOf(value, sessionId) {
  if (!Array.isArray(value)) throw new Error('segments must be an array')
  const dir = assetDirFor(sessionId)
  const segments = []
  let total = 0
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') throw new Error('invalid segment')
    if (raw.type === 'text' || raw.type === 'quote') {
      const text = textOf(raw.text)
      if (text === '') continue
      total += text.length
      if (total > MAX_TOTAL) throw new Error('this row is too long (max ' + MAX_TOTAL + ' characters)')
      segments.push({ type: raw.type, text })
      continue
    }
    if (raw.type === 'file') {
      const path = typeof raw.path === 'string' ? raw.path : ''
      if (!path.startsWith(dir + '/')) throw new Error('unknown asset: ' + path)
      const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : ''
      if (!ASSET_NAME.test(path.slice(path.lastIndexOf('/') + 1))) throw new Error('invalid asset name')
      segments.push({ type: 'file', path, name: name || path.slice(path.lastIndexOf('/') + 1) })
      continue
    }
    throw new Error('unknown segment type: ' + String(raw.type))
  }
  if (segments.length === 0) throw new Error('text is required')
  return segments
}

/** 'segments' is the shape the panel writes; a bare 'text' stays accepted. */
function segmentsFromBody(body, sessionId) {
  if (body !== null && typeof body === 'object' && Array.isArray(body.segments)) return segmentsOf(body.segments, sessionId)
  const text = textOf(body && body.text)
  if (text === '') throw new Error('text is required')
  return [{ type: 'text', text }]
}

/** The flattened form for readers that only want one string. */
function flattenSegments(segments) {
  return segments
    .map((segment) => {
      if (segment.type === 'quote') return segment.text.split('\n').map((line) => '> ' + line).join('\n')
      if (segment.type === 'file') return '[图片] ' + segment.path
      return segment.text
    })
    .join('\n\n')
}

function createDoc(sessionId) {
  return {
    version: 3,
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
    if (parsed !== null && typeof parsed === 'object' && parsed.version >= 1 && parsed.version <= 3 && Array.isArray(parsed.items)) {
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
  doc.version = 3
  doc.sessionId = sessionId
  doc.items = doc.items.filter((item) => item && typeof item.id === 'string')
  if (!Number.isInteger(doc.seq) || doc.seq < 1) doc.seq = doc.items.length + 1
  for (const item of doc.items) {
    if (!Array.isArray(item.segments)) {
      const text = typeof item.text === 'string' ? item.text : ''
      item.segments = text.trim() === '' ? [] : [{ type: 'text', text }]
    }
    item.segments = item.segments.filter((segment) => segment
      && (segment.type === 'text' || segment.type === 'quote' || segment.type === 'file')
      && (segment.type === 'file'
        ? typeof segment.path === 'string' && segment.path !== ''
        : typeof segment.text === 'string' && segment.text !== ''))
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

/** Delete asset files no row references any more. Best effort, never fatal. */
async function collectGarbage(doc) {
  const referenced = new Set()
  for (const item of doc.items) {
    for (const segment of item.segments) {
      if (segment.type === 'file') referenced.add(segment.path)
    }
  }
  const dir = assetDirFor(doc.sessionId)
  let names = []
  try {
    const { readdir } = await import('node:fs/promises')
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    if (!referenced.has(path)) {
      try {
        await unlink(path)
      } catch {
        /* a file another window still references stays */
      }
    }
  }
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
    const segments = segmentsFromBody(body, doc.sessionId)
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
    item.segments = segmentsFromBody(body, doc.sessionId)
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
      segments: item.segments.map((segment) => (segment.type === 'file'
        ? { type: 'file', path: segment.path, name: segment.name }
        : { type: segment.type, text: segment.text })),
      text: flattenSegments(item.segments),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      sentAt: typeof item.sentAt === 'string' ? item.sentAt : null,
    })),
  }
}

/* ------------------------------ image assets ------------------------------ */

/** Sniff the encoded type so a renamed text file cannot pose as an image. */
function imageExtension(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return '.gif'
  return ''
}

/** Store one pasted image; the name is generated here, not trusted. */
async function saveImage(sessionId, name, dataBase64) {
  if (typeof dataBase64 !== 'string' || dataBase64 === '') throw new Error('image data is required')
  const buffer = Buffer.from(dataBase64, 'base64')
  if (buffer.length === 0) throw new Error('empty image')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image is too large (max ' + Math.round(MAX_IMAGE_BYTES / 1024 / 1024) + ' MB)')
  const ext = imageExtension(buffer)
  if (ext === '') throw new Error('unsupported image type (png / jpeg / webp / gif)')
  const dir = assetDirFor(sessionId)
  await mkdir(dir, { recursive: true })
  const fileName = 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext
  const path = join(dir, fileName)
  await writeFile(path, buffer)
  return { path, name: typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 120) : fileName }
}

/* ------------------------------ browser API ------------------------------- */

function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.writeHead(status)
  res.end(JSON.stringify(payload))
}

function readJsonBody(req, limit = 32 * 1024 * 1024) {
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
      await collectGarbage(doc)
      sendJson(res, 200, { ok: true, queue: viewDoc(doc) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('pending-queue: action failed: ' + message)
      sendJson(res, 400, { ok: false, message })
    }
  }

  const uploadHandler = async (req, res) => {
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
      const file = await saveImage(sessionId, body && body.name, body && body.data)
      sendJson(res, 200, { ok: true, file })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('pending-queue: upload failed: ' + message)
      sendJson(res, 400, { ok: false, message })
    }
  }

  const assetHandler = async (req, res) => {
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
      const name = String(url.searchParams.get('name') || '')
      if (!ASSET_NAME.test(name)) throw new Error('invalid asset name')
      const bytes = await readFile(join(assetDirFor(sessionId), name))
      const type = IMAGE_TYPES[extname(name).toLowerCase()] || 'application/octet-stream'
      res.setHeader('content-type', type)
      res.setHeader('cache-control', 'private, max-age=60')
      res.writeHead(200)
      res.end(bytes)
    } catch {
      sendJson(res, 404, { ok: false, message: 'not found' })
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
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/upload', handler: uploadHandler }),
    'pending-queue: upload route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/asset', handler: assetHandler }),
    'pending-queue: asset route',
  )
}
