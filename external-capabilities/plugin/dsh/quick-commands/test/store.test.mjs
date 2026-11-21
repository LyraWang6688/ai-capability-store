import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const home = await mkdtemp(join(tmpdir(), 'quick-commands-'))
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
  const out = { status: 0, body: '' }
  return {
    out,
    setHeader() {},
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
    try { json = JSON.parse(res.out.body) } catch { json = null }
  }
  return { status: res.out.status, json }
}

const state = () => '/plugins/quick-commands/state'
const action = () => '/plugins/quick-commands/action'

test('routes are registered and the list starts empty', async () => {
  const stub = stubContext()
  apply(stub.ctx)
  routes = stub.routes
  assert.deepEqual([...routes.keys()].sort(), [action(), state()])
  const reply = await call(state(), 'GET', state())
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.json.list.commands, [])
})

test('adds a command, newest first, trimming the title', async () => {
  let reply = await call(action(), 'POST', action(), { action: 'add', title: '  周报模板  ', text: '每周五写周报：\n1. 本周完成\n2. 下周计划' })
  assert.equal(reply.status, 200)
  reply = await call(action(), 'POST', action(), { action: 'add', title: '', text: '第二条' })
  const commands = reply.json.list.commands
  assert.equal(commands.length, 2)
  assert.equal(commands[0].text, '第二条')
  assert.equal(commands[1].title, '周报模板')
  assert.equal(commands[1].text.split('\n').length, 3)
})

test('updates and removes a command', async () => {
  let reply = await call(state(), 'GET', state())
  const target = reply.json.list.commands[1]

  reply = await call(action(), 'POST', action(), { action: 'update', id: target.id, title: '周报（改）', text: '新的内容' })
  const updated = reply.json.list.commands.find((entry) => entry.id === target.id)
  assert.equal(updated.title, '周报（改）')
  assert.equal(updated.text, '新的内容')

  reply = await call(action(), 'POST', action(), { action: 'remove', id: target.id })
  assert.equal(reply.json.list.commands.some((entry) => entry.id === target.id), false)
})

test('rejects empty content and unknown ids', async () => {
  let reply = await call(action(), 'POST', action(), { action: 'add', title: 'x', text: '   ' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /text is required/)

  reply = await call(action(), 'POST', action(), { action: 'update', id: 'nope', text: 'x' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /unknown command/)

  reply = await call(action(), 'POST', action(), { action: 'remove', id: 'nope' })
  assert.equal(reply.status, 400)
})

test('cleanup', async () => {
  await rm(home, { recursive: true, force: true })
})
