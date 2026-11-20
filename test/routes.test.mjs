import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  return { status: res.out.status, json: res.out.body === '' ? null : JSON.parse(res.out.body) }
}

const state = () => '/plugins/pending-queue/state'
const action = () => '/plugins/pending-queue/action'
const session = 'session-test'

test('routes are registered and the queue starts empty', async () => {
  const stub = stubContext()
  apply(stub.ctx)
  routes = stub.routes
  assert.deepEqual([...routes.keys()].sort(), [action(), state()])
  const reply = await call(state(), 'GET', state() + '?sessionId=' + session)
  assert.equal(reply.status, 200)
  assert.equal(reply.json.ok, true)
  assert.deepEqual(reply.json.queue.items, [])
})

test('adds a row and persists it to disk', async () => {
  const reply = await call(action(), 'POST', action(), { sessionId: session, action: 'add', text: '  第一条：\n等上一步做完再发  ' })
  assert.equal(reply.status, 200)
  const items = reply.json.queue.items
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'q1')
  assert.equal(items[0].text, '第一条：\n等上一步做完再发')
  assert.equal(items[0].sentAt, null)

  const raw = JSON.parse(await readFile(join(home, 'storages', 'pending-queue', session + '.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.items[0].text, '第一条：\n等上一步做完再发')
})

test('edit, move, mark sent and clear sent', async () => {
  await call(action(), 'POST', action(), { sessionId: session, action: 'add', text: '第二条' })
  await call(action(), 'POST', action(), { sessionId: session, action: 'add', text: '第三条' })

  let reply = await call(action(), 'POST', action(), { sessionId: session, action: 'update', id: 'q1', text: '第一条（改）' })
  assert.equal(reply.json.queue.items[0].text, '第一条（改）')

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'move', id: 'q3', direction: 'up' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1', 'q3', 'q2'])

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'move', id: 'q1', direction: 'up' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1', 'q3', 'q2'])

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'markSent', id: 'q3' })
  assert.equal(typeof reply.json.queue.items[1].sentAt, 'string')

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'clearSent' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1', 'q2'])

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'remove', id: 'q2' })
  assert.deepEqual(reply.json.queue.items.map((item) => item.id), ['q1'])
})

test('rejects empty text, unknown items and bad session ids', async () => {
  let reply = await call(action(), 'POST', action(), { sessionId: session, action: 'add', text: '   ' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /text is required/)

  reply = await call(action(), 'POST', action(), { sessionId: session, action: 'remove', id: 'nope' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /unknown item/)

  reply = await call(action(), 'POST', action(), { sessionId: '../etc', action: 'add', text: 'x' })
  assert.equal(reply.status, 400)

  reply = await call(state(), 'GET', state() + '?sessionId=' + encodeURIComponent('../etc'))
  assert.equal(reply.status, 400)
})

test('cleanup', async () => {
  await rm(home, { recursive: true, force: true })
})
