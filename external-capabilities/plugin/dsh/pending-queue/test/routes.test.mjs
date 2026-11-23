import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// The store directory is resolved at import time, so DSH_HOME must be set first.
const home = await mkdtemp(join(tmpdir(), 'pending-queue-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

function stubContext() {
  const routes = new Map()
  const ctx = {
    effect(fn) { return fn() },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    get() { return undefined },
    logger: { warn() {} },
  }
  return { ctx, routes }
}

function request(method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const stream = Readable.from(payload)
  stream.method = method
  stream.url = url
  stream.headers = {}
  return stream
}

function response() {
  const out = { status: 0, body: '', headers: {} }
  return {
    out,
    setHeader(key, value) { out.headers[key] = value },
    writeHead(status) { out.status = status },
    end(chunk) { out.body = chunk ?? '' },
  }
}

let routes
async function call(path, method, url, body) {
  const res = response()
  await routes.get(path)(request(method, url, body), res)
  let json = null
  if (res.out.body !== '') {
    try {
      json = JSON.parse(res.out.body)
    } catch {
      json = null
    }
  }
  return { status: res.out.status, json }
}

const state = () => '/plugins/pending-queue/state'
const action = () => '/plugins/pending-queue/action'
const session = 'session-test'
const file = join(home, 'storages', 'pending-queue', session + '.json')

test('routes are registered and the queue starts empty', async () => {
  const stub = stubContext()
  apply(stub.ctx)
  routes = stub.routes
  assert.deepEqual([...routes.keys()].sort(), [action(), '/plugins/pending-queue/asset', state(), '/plugins/pending-queue/upload']) 
  const reply = await call(state(), 'GET', state() + '?sessionId=' + session)
  assert.equal(reply.status, 200)
  assert.equal(reply.json.ok, true)
  assert.deepEqual(reply.json.queue.items, [])
})

test('adds a text row and persists it to disk', async () => {
  const reply = await call(action(), 'POST', action(), { sessionId: session, action: 'add', text: '  第一条：\n等上一步做完再发  ' })
  assert.equal(reply.status, 200)
  const items = reply.json.queue.items
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'q1')
  assert.deepEqual(items[0].segments, [{ type: 'text', text: '第一条：\n等上一步做完再发' }])
  assert.equal(items[0].text, '第一条：\n等上一步做完再发')
  assert.equal(items[0].sentAt, null)

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.version, 3)
  assert.equal(raw.items[0].segments[0].text, '第一条：\n等上一步做完再发')
})

test('stores quotes as their own segment', async () => {
  const reply = await call(action(), 'POST', action(), {
    sessionId: session,
    action: 'add',
    segments: [
      { type: 'text', text: '这两段说的是同一件事：' },
      { type: 'quote', text: '原文第一段\n原文第二段' },
      { type: 'text', text: '所以先合并。' },
    ],
  })
  assert.equal(reply.status, 200)
  const item = reply.json.queue.items[1]
  assert.deepEqual(item.segments.map((segment) => segment.type), ['text', 'quote', 'text'])
  assert.equal(item.segments[1].text, '原文第一段\n原文第二段')
  assert.equal(item.text, '这两段说的是同一件事：\n\n> 原文第一段\n> 原文第二段\n\n所以先合并。')
})

test('edit, move, mark sent and clear sent', async () => {
  await call(action(), 'POST', action(), { sessionId: session, action: 'add', text: '第三条' })

  let reply = await call(action(), 'POST', action(), {
    sessionId: session,
    action: 'update',
    id: 'q1',
    segments: [{ type: 'text', text: '第一条（改）' }, { type: 'quote', text: '引一句' }],
  })
  assert.equal(reply.json.queue.items[0].segments.length, 2)
  assert.equal(reply.json.queue.items[0].segments[1].type, 'quote')

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'move', id: 'q3', direction: 'up' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1', 'q3', 'q2'])

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'move', id: 'q1', direction: 'up' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1', 'q3', 'q2'])

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'markSent', id: 'q3' })
  assert.equal(typeof reply.json.queue.items.find((entry) => entry.id === 'q3').sentAt, 'string')

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'clearSent' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1', 'q2'])

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'remove', id: 'q2' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1', 'q2'])
  assert.equal(typeof reply.json.queue.items[1].deletedAt, 'string')

  // A deleted row keeps its place but refuses edits until restored.
  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'update', id: 'q2', text: 'x' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /deleted/)

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'undelete', id: 'q2' })
  assert.equal(reply.json.queue.items[1].deletedAt, null)

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'remove', id: 'q2' })
  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'clearDeleted' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1'])
})

test('sent and deleted rows move to the bottom, restore brings them back', async () => {
  const wide = 'order-session'
  const add = (text) => call(action(), 'POST', action(), { sessionId: wide, action: 'add', text })
  for (const text of ['A', 'B', 'C', 'D']) await add(text)
  const ids = []
  for (const item of (await call(state(), 'GET', state() + '?sessionId=' + wide)).json.queue.items) ids.push(item.id)

  let reply = await call(action(), 'POST', action(), { sessionId: wide, action: 'markSent', id: ids[1] })
  assert.deepEqual(reply.json.queue.items.map((item) => item.segments[0].text), ['A', 'C', 'D', 'B'])

  reply = await call(action(), 'POST', action(), { sessionId: wide, action: 'remove', id: ids[0] })
  assert.deepEqual(reply.json.queue.items.map((item) => item.segments[0].text), ['C', 'D', 'B', 'A'])

  reply = await call(action(), 'POST', action(), { sessionId: wide, action: 'undelete', id: ids[0] })
  assert.deepEqual(reply.json.queue.items.map((item) => item.segments[0].text), ['C', 'D', 'A', 'B'])
})

test('completed rows leave the queue, drop back on restore, and clear on demand', async () => {
  const board = 'done-session'
  for (const text of ['甲', '乙', '丙']) {
    await call(action(), 'POST', action(), { sessionId: board, action: 'add', text })
  }
  let reply = await call(state(), 'GET', state() + '?sessionId=' + board)
  const ids = reply.json.queue.items.map((item) => item.id)

  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'complete', id: ids[0] })
  assert.equal(typeof reply.json.queue.items.find((item) => item.id === ids[0]).doneAt, 'string')
  assert.deepEqual(reply.json.queue.items.map((item) => item.segments[0].text), ['乙', '丙', '甲'])

  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'uncomplete', id: ids[0] })
  assert.equal(reply.json.queue.items.find((item) => item.id === ids[0]).doneAt, null)
  assert.deepEqual(reply.json.queue.items.map((item) => item.segments[0].text), ['乙', '丙', '甲'])

  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'complete', id: ids[0] })
  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'clearDone' })
  assert.equal(reply.json.queue.items.length, 2)
})

test('a done row that is deleted comes back as done when restored', async () => {
  const board = 'done-delete-session'
  await call(action(), 'POST', action(), { sessionId: board, action: 'add', text: '甲' })
  let reply = await call(state(), 'GET', state() + '?sessionId=' + board)
  const id = reply.json.queue.items[0].id
  await call(action(), 'POST', action(), { sessionId: board, action: 'complete', id })
  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'remove', id })
  assert.equal(typeof reply.json.queue.items[0].deletedAt, 'string')
  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'undelete', id })
  assert.equal(reply.json.queue.items[0].deletedAt, null)
  assert.equal(typeof reply.json.queue.items[0].doneAt, 'string')
})

test('shelved rows leave the queue and come back on unshelve', async () => {
  const board = 'shelf-session'
  for (const text of ['甲', '乙', '丙']) {
    await call(action(), 'POST', action(), { sessionId: board, action: 'add', text })
  }
  let reply = await call(state(), 'GET', state() + '?sessionId=' + board)
  const ids = reply.json.queue.items.map((item) => item.id)

  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'shelve', id: ids[0] })
  assert.equal(typeof reply.json.queue.items.find((item) => item.id === ids[0]).shelvedAt, 'string')
  assert.deepEqual(reply.json.queue.items.map((item) => item.segments[0].text), ['乙', '丙', '甲'])

  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'unshelve', id: ids[0] })
  assert.equal(reply.json.queue.items.find((item) => item.id === ids[0]).shelvedAt, null)
  assert.deepEqual(reply.json.queue.items.map((item) => item.segments[0].text), ['乙', '丙', '甲'])

  // A shelved row that is deleted comes back as shelved.
  await call(action(), 'POST', action(), { sessionId: board, action: 'shelve', id: ids[0] })
  await call(action(), 'POST', action(), { sessionId: board, action: 'remove', id: ids[0] })
  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'undelete', id: ids[0] })
  assert.equal(typeof reply.json.queue.items.find((item) => item.id === ids[0]).shelvedAt, 'string')

  reply = await call(action(), 'POST', action(), { sessionId: board, action: 'clearShelved' })
  assert.equal(reply.json.queue.items.length, 2)
})

test('rejects empty text, bad segments, unknown items and bad session ids', async () => {
  let reply = await call(action(), 'POST', action(), { sessionId: session, action: 'add', text: '   ' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /text is required/)

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'add', segments: [{ type: 'image', text: 'x' }] })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /unknown segment type/)

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'add', segments: [{ type: 'text', text: '   ' }] })
  assert.equal(reply.status, 400)

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'remove', id: 'nope' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /unknown item/)

  reply = await call(action(), 'POST', action(), { sessionId: '../etc', action: 'add', text: 'x' })
  assert.equal(reply.status, 400)

  reply = await call(state(), 'GET', state() + '?sessionId=' + encodeURIComponent('../etc'))
  assert.equal(reply.status, 400)
})

test('lifts a 0.1.x text document to the segment shape', async () => {
  const legacy = 'legacy-session'
  const dir = join(home, 'storages', 'pending-queue')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, legacy + '.json'), JSON.stringify({
    version: 1,
    sessionId: legacy,
    seq: 2,
    items: [{ id: 'q1', text: '老版本的一行', createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z' }],
    updatedAt: '2026-11-20T00:00:00.000Z',
  }), 'utf8')

  const reply = await call(state(), 'GET', state() + '?sessionId=' + legacy)
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.json.queue.items[0].segments, [{ type: 'text', text: '老版本的一行' }])

  // The lift is lazy: the file is rewritten on the next write, not on read.
  await call(action(), 'POST', action(), { sessionId: legacy, action: 'add', text: '新一行' })
  const lifted = JSON.parse(await readFile(join(dir, legacy + '.json'), 'utf8'))
  assert.equal(lifted.version, 3)
  assert.deepEqual(lifted.items.map((item) => item.segments[0].text), ['老版本的一行', '新一行'])
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const upload = () => '/plugins/pending-queue/upload'
const asset = () => '/plugins/pending-queue/asset'

test('uploads an image, stores it as a file segment and collects it on delete', async () => {
  const up = await call(upload(), 'POST', upload(), { sessionId: session, name: 'shot.png', data: PNG })
  assert.equal(up.status, 200)
  const file = up.json.file
  assert.match(file.path, /\/assets\/session-test\/img-[a-z0-9-]+\.png$/)

  const reply = await call(action(), 'POST', action(), {
    sessionId: session,
    action: 'add',
    segments: [{ type: 'text', text: '看这张图' }, { type: 'file', path: file.path, name: file.name }],
  })
  assert.equal(reply.status, 200)
  const item = reply.json.queue.items.find((entry) => entry.segments[0].text === '看这张图')
  assert.ok(item)
  assert.deepEqual(item.segments.map((s) => s.type), ['text', 'file'])
  assert.equal(item.segments[1].name, 'shot.png')

  const name = file.path.split('/').pop()
  const served = await call(asset(), 'GET', asset() + '?sessionId=' + session + '&name=' + name)
  assert.equal(served.status, 200)

  // Soft delete keeps the file; purging is what lets the collector drop it.
  await call(action(), 'POST', action(), { sessionId: session, action: 'remove', id: item.id })
  const kept = await call(asset(), 'GET', asset() + '?sessionId=' + session + '&name=' + name)
  assert.equal(kept.status, 200)

  await call(action(), 'POST', action(), { sessionId: session, action: 'purge', id: item.id })
  const gone = await call(asset(), 'GET', asset() + '?sessionId=' + session + '&name=' + name)
  assert.equal(gone.status, 404)
})

test('rejects an image segment pointing outside the asset directory', async () => {
  const reply = await call(action(), 'POST', action(), {
    sessionId: session,
    action: 'add',
    segments: [{ type: 'file', path: '/etc/passwd', name: 'passwd' }],
  })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /unknown asset/)
})

test('rejects a non-image upload', async () => {
  const reply = await call(upload(), 'POST', upload(), { sessionId: session, name: 'x.txt', data: Buffer.from('hello').toString('base64') })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /unsupported image type/)
})

test('cleanup', async () => {
  await rm(home, { recursive: true, force: true })
})
