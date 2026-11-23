/**
 * Host half of the pending-send queue.
 *
 * The queue belongs to a workspace, not to one session: every session opened
 * in the same working directory reads and writes the same document, so an idea
 * captured in one conversation is still there when the next one starts.
 *
 * One JSON document per workspace under <DSH_HOME>/storages/pending-queue,
 * images under <DSH_HOME>/storages/pending-queue/assets. Nothing here appends a
 * session event: pushing a row into the chat happens in the client half through
 * the composer's own input actions.
 *
 * Rows are segment lists (text / quote / image). Quotes are rebuilt with
 * insertQuote; images travel as a path plus a read_image hint, because the
 * composer's attachment pipeline only accepts browser-owned draft ids.
 *
 * Routes (same-origin, behind DSH connection auth):
 *   GET  /plugins/pending-queue/state?sessionId=...   -> the workspace queue
 *   POST /plugins/pending-queue/action                -> add / update / remove / ...
 *   POST /plugins/pending-queue/upload                -> store one pasted image
 *   GET  /plugins/pending-queue/asset?name=...        -> serve one stored image
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

/** The routes this plugin owns on the browser HTTP carrier. */
const ROUTE_BASE = '/plugins/pending-queue'

/** Queue documents and their images live side by side. */
const STORE_DIR = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'storages',
  'pending-queue',
)
const ASSET_DIR = join(STORE_DIR, 'assets')

/** Session ids and workspace keys are opaque but filesystem-safe. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/
const STORE_KEY = /^[A-Za-z0-9._-]{1,160}$/

/** Bounded so one runaway workspace cannot grow the document without limit. */
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

/**
 * The workspace a session belongs to: its cwd hashed into a stable, readable
 * key. A session without a cwd (an unsaved draft) falls back to its own id, so
 * the queue still works before a workspace is chosen.
 */
function workspaceOf(ctx, sessionId) {
  let cwd = ''
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const header = session && session.header
    if (header && typeof header.cwd === 'string') cwd = header.cwd
  } catch {
    cwd = ''
  }
  if (cwd === '') return { key: sessionId, cwd: '' }
  const readable = cwd.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-48)
  const digest = createHash('sha1').update(cwd).digest('hex').slice(0, 10)
  return { key: (readable === '' ? 'workspace' : readable) + '-' + digest, cwd }
}

function fileFor(key) {
  if (!STORE_KEY.test(key)) throw new Error('invalid queue key')
  return join(STORE_DIR, key + '.json')
}

function assetNameOf(path) {
  const value = String(path || '')
  return value.slice(value.lastIndexOf('/') + 1)
}

/**
 * A row is a list of segments: text, quote, or image. A quote travels as its
 * own segment so the composer can rebuild it as a real quote block; an image
 * travels as a path inside this plugin's asset directory.
 */
function segmentsOf(value) {
  if (!Array.isArray(value)) throw new Error('segments must be an array')
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
      if (!path.startsWith(ASSET_DIR + '/')) throw new Error('unknown asset: ' + path)
      const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : ''
      if (!ASSET_NAME.test(assetNameOf(path))) throw new Error('invalid asset name')
      segments.push({ type: 'file', path, name: name || assetNameOf(path) })
      continue
    }
    throw new Error('unknown segment type: ' + String(raw.type))
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
    .map((segment) => {
      if (segment.type === 'quote') return segment.text.split('\n').map((line) => '> ' + line).join('\n')
      if (segment.type === 'file') return '[图片] ' + segment.path
      return segment.text
    })
    .join('\n\n')
}

function createDoc(key) {
  return { version: 3, key, seq: 1, items: [], updatedAt: nowIso() }
}

/* ------------------------------- persistence ------------------------------ */

let queue = Promise.resolve()

/** Serialize read-modify-write cycles so two windows cannot lose one edit. */
function withLock(task) {
  const run = queue.then(() => task(), () => task())
  queue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * Read one workspace document. A legacy per-session document is lifted into the
 * workspace file the first time the workspace is opened, images included.
 */
async function readDoc(ctx, sessionId, key) {
  const readOne = async (path) => {
    const raw = await readFile(path, 'utf8')
    return normalizeDoc(JSON.parse(raw), key)
  }
  try {
    return await readOne(fileFor(key))
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) {
      if (error instanceof SyntaxError) return createDoc(key)
      throw error
    }
  }
  if (key !== sessionId && SESSION_ID.test(sessionId)) {
    try {
      const legacy = await readOne(fileFor(sessionId))
      const migrated = await liftAssets(legacy, sessionId)
      await writeDoc(migrated)
      await unlink(fileFor(sessionId)).catch(() => {})
      return migrated
    } catch {
      /* no legacy document: start empty */
    }
  }
  return createDoc(key)
}

/** Move per-session image folders into the flat asset directory. */
async function liftAssets(doc, sessionId) {
  const legacyDir = join(ASSET_DIR, sessionId)
  let names = []
  try {
    names = await readdir(legacyDir)
  } catch {
    return doc
  }
  await mkdir(ASSET_DIR, { recursive: true })
  for (const name of names) {
    if (!ASSET_NAME.test(name)) continue
    try {
      await rename(join(legacyDir, name), join(ASSET_DIR, name))
    } catch {
      /* a file another workspace already owns stays */
    }
  }
  const rewrite = (segment) => {
    if (segment.type !== 'file') return segment
    return { ...segment, path: join(ASSET_DIR, assetNameOf(segment.path)) }
  }
  doc.items = doc.items.map((item) => ({ ...item, segments: item.segments.map(rewrite) }))
  return doc
}

/** Fill fields an older document may lack, and lift v1 text rows to segments. */
function normalizeDoc(doc, key) {
  doc.version = 3
  doc.key = key
  delete doc.sessionId
  doc.items = Array.isArray(doc.items) ? doc.items.filter((item) => item && typeof item.id === 'string') : []
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
    if (typeof item.doneAt !== 'string') delete item.doneAt
    if (typeof item.scheduledAt !== 'string') delete item.scheduledAt
    if (typeof item.deletedAt !== 'string') delete item.deletedAt
  }
  doc.items = doc.items.filter((item) => item.segments.length > 0)
  sortItems(doc)
  return doc
}

/**
 * Rows group by state: still to send first, then scheduled, done, sent and
 * soft-deleted. The partition is stable, so relative order inside a group never
 * changes on its own - only the transitions move a row into its bucket.
 */
function bucketOf(item) {
  if (typeof item.deletedAt === 'string') return 4
  if (typeof item.sentAt === 'string') return 3
  if (typeof item.doneAt === 'string') return 2
  if (typeof item.scheduledAt === 'string') return 1
  return 0
}

function sortItems(doc) {
  doc.items = doc.items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (bucketOf(left.item) - bucketOf(right.item)) || (left.index - right.index))
    .map((entry) => entry.item)
}

async function writeDoc(doc) {
  await mkdir(STORE_DIR, { recursive: true })
  const target = fileFor(doc.key)
  const temporary = target + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(temporary, target)
}

/** Read, apply one change, persist. */
function mutateDoc(ctx, sessionId, key, change) {
  return withLock(async () => {
    const doc = await readDoc(ctx, sessionId, key)
    change(doc)
    sortItems(doc)
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
  let names = []
  try {
    names = await readdir(ASSET_DIR)
  } catch {
    return
  }
  for (const name of names) {
    if (!ASSET_NAME.test(name)) continue
    const path = join(ASSET_DIR, name)
    if (!referenced.has(path)) {
      try {
        await unlink(path)
      } catch {
        /* a file another workspace still references stays */
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
    if (typeof item.deletedAt === 'string') throw new Error('this row is deleted; restore it first')
    item.segments = segmentsFromBody(body)
    item.updatedAt = nowIso()
    return { id: item.id }
  }
  if (action === 'remove') {
    const item = requireItem(doc, body.id)
    if (typeof item.deletedAt !== 'string') item.deletedAt = nowIso()
    item.updatedAt = item.deletedAt
    return { id: item.id }
  }
  if (action === 'undelete') {
    const item = requireItem(doc, body.id)
    delete item.deletedAt
    item.updatedAt = nowIso()
    return { id: item.id }
  }
  if (action === 'purge') {
    const item = requireItem(doc, body.id)
    doc.items = doc.items.filter((entry) => entry.id !== item.id)
    return { id: item.id }
  }
  if (action === 'move') {
    const item = requireItem(doc, body.id)
    if (typeof item.deletedAt === 'string') throw new Error('this row is deleted; restore it first')
    const direction = body.direction === 'up' ? -1 : body.direction === 'down' ? 1 : 0
    if (direction === 0) throw new Error('direction must be up or down')
    const index = doc.items.indexOf(item)
    const target = index + direction
    if (target < 0 || target >= doc.items.length) return { id: item.id }
    doc.items.splice(index, 1)
    doc.items.splice(target, 0, item)
    return { id: item.id }
  }
  if (action === 'markSent') {
    const item = requireItem(doc, body.id)
    item.sentAt = nowIso()
    delete item.doneAt
    delete item.scheduledAt
    item.updatedAt = item.sentAt
    return { id: item.id }
  }
  if (action === 'restore') {
    const item = requireItem(doc, body.id)
    delete item.sentAt
    item.updatedAt = nowIso()
    return { id: item.id }
  }
  if (action === 'complete') {
    const item = requireItem(doc, body.id)
    if (typeof item.deletedAt === 'string') throw new Error('this row is deleted; restore it first')
    item.doneAt = nowIso()
    delete item.sentAt
    delete item.scheduledAt
    item.updatedAt = item.doneAt
    return { id: item.id }
  }
  if (action === 'uncomplete') {
    const item = requireItem(doc, body.id)
    delete item.doneAt
    item.updatedAt = nowIso()
    return { id: item.id }
  }
  if (action === 'schedule') {
    const item = requireItem(doc, body.id)
    if (typeof item.deletedAt === 'string') throw new Error('this row is deleted; restore it first')
    item.scheduledAt = nowIso()
    delete item.sentAt
    delete item.doneAt
    item.updatedAt = item.scheduledAt
    return { id: item.id }
  }
  if (action === 'unschedule') {
    const item = requireItem(doc, body.id)
    delete item.scheduledAt
    item.updatedAt = nowIso()
    return { id: item.id }
  }
  if (action === 'clearSent') {
    doc.items = doc.items.filter((item) => typeof item.sentAt !== 'string')
    return {}
  }
  if (action === 'clearDone') {
    doc.items = doc.items.filter((item) => typeof item.doneAt !== 'string')
    return {}
  }
  if (action === 'clearScheduled') {
    doc.items = doc.items.filter((item) => typeof item.scheduledAt !== 'string')
    return {}
  }
  if (action === 'clearDeleted') {
    doc.items = doc.items.filter((item) => typeof item.deletedAt !== 'string')
    return {}
  }
  throw new Error('unknown action: ' + (action || '(none)'))
}

/** The compact shape both the browser and the tool result read. */
function viewDoc(doc) {
  return {
    workspaceKey: doc.key,
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
      doneAt: typeof item.doneAt === 'string' ? item.doneAt : null,
      scheduledAt: typeof item.scheduledAt === 'string' ? item.scheduledAt : null,
      deletedAt: typeof item.deletedAt === 'string' ? item.deletedAt : null,
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
async function saveImage(name, dataBase64) {
  if (typeof dataBase64 !== 'string' || dataBase64 === '') throw new Error('image data is required')
  const buffer = Buffer.from(dataBase64, 'base64')
  if (buffer.length === 0) throw new Error('empty image')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image is too large (max ' + Math.round(MAX_IMAGE_BYTES / 1024 / 1024) + ' MB)')
  const ext = imageExtension(buffer)
  if (ext === '') throw new Error('unsupported image type (png / jpeg / webp / gif)')
  await mkdir(ASSET_DIR, { recursive: true })
  const fileName = 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext
  const path = join(ASSET_DIR, fileName)
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
      const workspace = workspaceOf(ctx, sessionId)
      const doc = await readDoc(ctx, sessionId, workspace.key)
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
      const workspace = workspaceOf(ctx, sessionId)
      const doc = await mutateDoc(ctx, sessionId, workspace.key, (current) => applyAction(current, body))
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
      sessionIdOf(body && body.sessionId)
      const file = await saveImage(body && body.name, body && body.data)
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
      const name = String(url.searchParams.get('name') || '')
      if (!ASSET_NAME.test(name)) throw new Error('invalid asset name')
      const bytes = await readFile(join(ASSET_DIR, name))
      const type = IMAGE_TYPES[extname(name).toLowerCase()] || 'application/octet-stream'
      res.setHeader('content-type', type)
      res.setHeader('cache-control', 'private, max-age=60')
      res.writeHead(200)
      res.end(bytes)
    } catch {
      sendJson(res, 404, { ok: false, message: 'not found' })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/state', handler: stateHandler }), 'pending-queue: state route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/action', handler: actionHandler }), 'pending-queue: action route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/upload', handler: uploadHandler }), 'pending-queue: upload route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/asset', handler: assetHandler }), 'pending-queue: asset route')
}
