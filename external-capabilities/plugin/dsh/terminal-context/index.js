/**
 * Host half of terminal-context (0.6.0).
 *
 * 0.5.x 持续把终端屏幕推进模型上下文，并在报错/完成时自动唤醒。用户选择换成
 * **手动快门**：界面侧只在用户点「发送终端」那一刻抓当前可见的最后几行发过来，
 * 这里把它作为一条 user 消息塞给该会话的 Agent（空闲唤醒、忙时落到下一个 step）。
 *
 * 所以这个插件现在没有定时器、没有自动上报、没有上下文注入：什么时候把终端交给
 * Agent，完全由用户点按钮决定。
 *
 * 不落盘：终端里可能有 token，缓存只在进程内存里，进程结束即消失。
 */

const SEND_PATH = '/plugins/terminal-context/send'
const MAX_LINES = 40
const MAX_PROMPT_HINT = 120

const PROMPT_END = /(?:[%$#❯➜»])\s*$/
const ERROR_PATTERNS = [
  /(^|\s)(error|Error|ERROR)\b/,
  /\b(npm|pnpm|yarn) ERR!/,
  /\b(failed|Failed|FAILED|failure|Failure)\b/,
  /Traceback \(most recent call last\)/,
  /\b(command not found|No such file or directory|Permission denied)\b/,
  /\b(EACCES|ENOENT|EPERM|ETIMEDOUT|ECONNREFUSED)\b/,
  /\b(fatal|panic|Exception|unhandled rejection)\b/i,
  /✗|⨯|✘/,
]

export const inject = ['tools', 'webServer']

/** sessionId → { lines, updatedAt }，只保留用户最近一次点「发送终端」发送的内容。 */
const lastSent = new Map()

function send(res, status, payload) {
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
    return
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function readBody(req) {
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    return (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      return Buffer.concat(chunks).toString('utf8')
    })()
  }
  if (req && typeof req.text === 'function') return req.text()
  return Promise.resolve('')
}

/** 最近一条提示符行，作为 cwd / 本地还是远端的粗线索。 */
function promptLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || !line.trim()) continue
    if (PROMPT_END.test(line)) return line.trim().slice(0, MAX_PROMPT_HINT)
  }
  return ''
}

/** 屏幕上是否有看起来像报错的行；只用于给消息加一句提示，不触发任何自动行为。 */
function errorLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line && line.trim() && ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.trim().slice(0, 200)
    }
  }
  return ''
}

function messageText(lines) {
  const prompt = promptLine(lines)
  const error = errorLine(lines)
  return [
    '【终端内容 · 用户手动发送】用户在 DSH 右侧边栏终端里点了「发送终端」，下面是那块屏幕当前可见的最后几行（不是用户打的字）。',
    prompt === '' ? '（没有识别到 shell 提示符）' : `最后提示符行：${prompt}`,
    error === '' ? '' : `屏幕上有一行看起来像报错：${error}`,
    '',
    '```',
    ...lines,
    '```',
    '',
    '请把这段当作终端当前状态来用：',
    '- 用户需要你基于它给出下一步指令（注意提示符里的目录，以及是本地还是远端）。',
    '- 如果最后一条命令失败了，说明原因，给出修正后的命令，并只重发**从失败点开始的剩余步骤**，不要让用户重跑已经成功的步骤。',
    '- 如果一切正常，用一句话确认结果，然后给下一步。',
    '- 不要重复粘贴这整段内容。',
  ].filter((part) => part !== '').join('\n')
}

function deliver(agent, text) {
  const message = {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  // Agent 忙碌时落到下一个 step，不打断当前回合；空闲时直接唤醒。
  if (agent.status === 'running') {
    agent.inject(message)
    return 'inject'
  }
  agent.followup(message)
  return 'followup'
}

export function apply(ctx) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SEND_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, message: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse(await readBody(req))
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const lines = Array.isArray(body.lines) ? body.lines.slice(-MAX_LINES).map(String) : []
        if (lines.length === 0) {
          send(res, 400, { ok: false, message: '没有可发送的终端内容（终端可能没打开）' })
          return
        }
        if (sessionId === '') {
          send(res, 400, { ok: false, message: '拿不到当前会话 id' })
          return
        }
        const agent = agents?.get?.(sessionId)
        if (agent === undefined) {
          send(res, 409, { ok: false, message: '当前会话的 Agent 不在线' })
          return
        }
        lastSent.set(sessionId, { lines, updatedAt: Date.now() })
        const mode = deliver(agent, messageText(lines))
        send(res, 200, { ok: true, mode, lines: lines.length })
      } catch (error) {
        send(res, 500, { ok: false, message: String((error && error.message) || error) })
      }
    },
  }), 'terminal-context: send route')

  ctx.effect(() => {
    const dispose = ctx.tools.register({
      name: 'read_terminal_context',
      description:
        'Return the terminal screen the user last sent with the 「发送终端」 button in the DSH right-sidebar terminal, plus its age. There is no live stream: if the user has not pressed that button in this session, nothing is available.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(_args, exec) {
        const sessionId = String(exec?.agent?.id ?? '')
        const snapshot = lastSent.get(sessionId)
        if (snapshot === undefined) {
          return {
            available: false,
            reason: 'the user has not sent the terminal screen in this session',
            hint: 'ask them to press 「发送终端」 beside the composer when they want you to see it',
          }
        }
        return {
          available: true,
          ageSeconds: Math.max(0, Math.round((Date.now() - snapshot.updatedAt) / 1000)),
          lines: snapshot.lines,
        }
      },
    })
    return () => dispose()
  }, 'terminal-context: read tool')
}
