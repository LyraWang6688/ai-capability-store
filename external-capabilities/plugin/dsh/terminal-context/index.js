/**
 * Host half of terminal-context.
 *
 * The browser half reads the sidebar terminal's rendered xterm rows (the only
 * reachable surface — `terminalController` spawns the PTY through
 * `subprocess.spawnTerminal` and keeps the handle private, so a Host plugin
 * cannot read it) and pushes the visible lines here, tagged with its session
 * and with the user's explicit share switch.
 *
 * Three pieces:
 *   1. Live context — while sharing is on, the current screen rides along with
 *      every model step (`systemPrompt.context`), so the next command is issued
 *      against the terminal the user is actually looking at.
 *   2. Signal reports — when the screen settles, classify what it shows and
 *      wake the agent for the signals that need a decision (error, waiting for
 *      input, interactive program), at most once per command. The `stuck`
 *      signal is deliberately NOT auto-reported: long output followed by idle
 *      looked identical to "stuck" in real use and produced false alarms.
 *   3. The read tool — `read_terminal_context`, for on-demand reads.
 *
 * Sharing is OFF until the user turns it on; off means no context, no reports,
 * and no retained screen. Nothing is written to disk: the terminal may contain
 * secrets, so the buffer dies with the process.
 */

const PUSH_PATH = '/plugins/terminal-context/push'
const MAX_LINES = 200
const MAX_PROMPT_LINES = 20
const TAIL_LINES = 8
const STALE_AFTER_MS = 45_000
const QUIESCE_MS = 1_200
const WAKE_COOLDOWN_MS = 20_000
const SUCCESS_COOLDOWN_MS = 8_000

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
const AWAIT_PATTERNS = [
  /\((y\/n|yes\/no)\)\s*[:?]?\s*$/i,
  /\[(y\/n|Y\/n|y\/N)\]\s*:?\s*$/,
  /(Password|Passphrase|password|passphrase)\s*:\s*$/,
  /(Are you sure|Continue\?|Proceed\?|Overwrite\?)/i,
  /Press any key/i,
  /(Enter|输入)[^:：]{0,12}[:：]\s*$/,
]
const INTERACTIVE_PATTERNS = [
  /^\s*~+\s*$/,
  /^(vim|nvim|vi|nano|emacs|less|more|man|top|htop|ssh|ftp|telnet|mysql|psql|redis-cli|python3?|irb|node)\b/,
]

export const inject = ['tools', 'webServer']

/**
 * sessionId → {
 *   share, lines, updatedAt, truncated, diag,
 *   lastWakeAt, lastCommandLine, lastSignal
 * }
 * `lastSignal` is `kind|commandLine|evidence` of the report already sent for
 * the command on screen, so one command can produce at most one report.
 */
const screens = new Map()
const quiesceTimers = new Map()

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

/**
 * Strict per-session lookup. Never falls back to another session's screen: a
 * user with two sessions open must not see one session's terminal inside the
 * other (0.5.1 真机踩到过——右栏在 A 会话，B 会话却收到了上报/上下文)。
 */
function screenOf(sessionId) {
  if (!sessionId) return undefined
  const own = screens.get(sessionId)
  return own !== undefined && own.share === true ? own : undefined
}

function ageSeconds(snapshot) {
  return Math.max(0, Math.round((Date.now() - snapshot.updatedAt) / 1000))
}

function visibleLines(snapshot, limit) {
  const lines = snapshot.lines.slice(-limit)
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

function lastNonEmpty(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] && lines[index].trim()) return index
  }
  return -1
}

/** Identity of the command currently on screen, used to dedupe reports. */
function commandLineOf(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || !line.trim()) continue
    if (PROMPT_END.test(line) && line.trim().length > 2) {
      return line.trim().replace(/\s+/g, ' ').slice(0, 160)
    }
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line && PROMPT_END.test(line) && line.trim().length > 2) {
      return line.trim().replace(/\s+/g, ' ').slice(0, 160)
    }
  }
  return ''
}

function detectError(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || !line.trim()) continue
    if (ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
      return { line: line.trim(), index }
    }
  }
  return undefined
}

/** What the screen shows right now, when it shows something actionable. */
function detectSignal(lines) {
  const end = lastNonEmpty(lines)
  if (end < 0) return undefined

  const hit = detectError(lines)
  if (hit !== undefined) return { kind: 'error', evidence: hit.line }
  const last = lines[end]
  if (AWAIT_PATTERNS.some((pattern) => pattern.test(last))) {
    return { kind: 'awaiting-input', evidence: last.trim() }
  }
  if (!PROMPT_END.test(last)) {
    const programLine = [...lines].reverse().find((line) => line && INTERACTIVE_PATTERNS.some((p) => p.test(line)))
    if (programLine !== undefined) return { kind: 'interactive', evidence: programLine.trim() }
  }
  if (PROMPT_END.test(last)) return { kind: 'success', evidence: 'prompt returned' }
  return undefined
}

/**
 * Prompt text for the current screen.
 *
 * Deliberately built from COARSE state only — the last prompt line and the
 * classified signal — never from the streaming lines themselves and never from
 * an age counter. DSH re-sends a runtime-context snapshot whenever its text
 * changes, and every snapshot becomes a durable chat node, so including the
 * output lines (or "3s old") made a busy terminal spam the transcript with
 * content the user does not need. Streaming output now changes nothing here;
 * the full screen stays available through the tool.
 */
function promptTextFor(sessionId) {
  const own = screens.get(sessionId)
  if (own !== undefined && own.share === true && own.panelOpen === false) {
    return [
      'DSH right-sidebar terminal: sharing is on, but NO terminal panel is open — there is no terminal state to read.',
      'Rules while this line is present:',
      '1. Do NOT give terminal commands that assume a working directory, a host, or a previous result. Do not invent them.',
      '2. STOP and ask the user to open the right sidebar terminal, then wait for them.',
      '3. Opening the terminal is the human\'s job — the plugin cannot open it. Once it is open, the screen will appear here automatically (within ~2s) and you can continue.',
    ].join('\n')
  }
  const snapshot = screenOf(sessionId)
  if (snapshot === undefined || !snapshot.updatedAt) return ''
  if (Date.now() - snapshot.updatedAt > STALE_AFTER_MS) return ''
  const lines = visibleLines(snapshot, MAX_LINES)
  if (lines.length === 0) return ''
  const completed = snapshot.completed
  // While a command is running derive everything from the LAST COMPLETED state:
  // re-reading the live lines here would make the text change on every push.
  const prompt = completed === undefined ? lastPromptLine(lines) : completed.prompt
  const parts = [
    'DSH right-sidebar terminal (shared by the user). Compact state only; call read_terminal_context for the full screen.',
    prompt === '' ? 'Last screen line: (no shell prompt visible)' : `Last prompt line: ${prompt}`,
  ]
  if (completed !== undefined) {
    parts.push(`Last completed command: ${completed.command === '' ? '(unknown)' : completed.command}`)
    if (completed.tail.length > 0) {
      parts.push(`Its output (last ${completed.tail.length} lines):`)
      parts.push(...completed.tail)
    }
    parts.push(`State: ${completed.state}`)
  } else {
    parts.push('State: a command is still running (no prompt returned yet)')
  }
  parts.push('Use the prompt line to infer the working directory and whether the shell is local or remote, and adapt the next command to it. The user types these commands; do not assume a command ran unless this output shows it.')
  return parts.join('\n')
}

/**
 * The last COMPLETED command on screen: the command line, its output tail, and
 * how the screen ended. Returns undefined while a command is still running
 * (the screen does not end with a prompt), which is what keeps the injected
 * text stable during streaming output.
 */
function deriveCompleted(lines) {
  const end = lastNonEmpty(lines)
  if (end < 0) return undefined
  if (!PROMPT_END.test(lines[end])) return undefined
  let commandIndex = -1
  for (let index = end - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line && /(?:[%$#❯➜»])\s+\S/.test(line)) { commandIndex = index; break }
  }
  const command = commandIndex >= 0 ? lines[commandIndex].trim().slice(0, 160) : ''
  const output = commandIndex >= 0 ? lines.slice(commandIndex + 1, end) : lines.slice(0, end)
  const tail = output.map((line) => line.trimEnd()).filter((line, index, list) => line !== '' || index < list.length - 1).slice(-TAIL_LINES)
  const signal = detectSignal(lines)
  return {
    command,
    prompt: lastPromptLine(lines),
    tail,
    state: signal === undefined ? 'success — prompt returned, no error on screen' : `${signal.kind} — ${signal.evidence}`,
  }
}

/** The most recent shell prompt line, used as a coarse cwd/host hint. */
function lastPromptLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || !line.trim()) continue
    if (PROMPT_END.test(line)) return line.trim().slice(0, 120)
  }
  return ''
}

const REPORTS = {
  error: {
    title: '疑似报错',
    detail: (_snapshot, signal) => `命中的疑似报错行：${signal.evidence}`,
    ask: [
      '请判断这条命令是否真的失败：',
      '- 确实失败：说明原因，给出修正后的命令，并且**只重发从失败点开始的剩余步骤**（已成功的步骤不要让用户重跑）。',
      '- 只是日志里出现 error 字样但命令正常结束：明确说「这条没问题，继续下一步」，不要改方案。',
    ],
  },
  'awaiting-input': {
    title: '终端停在等待输入',
    detail: (_snapshot, signal) => `停在：${signal.evidence}`,
    ask: [
      '终端正在等用户输入，命令还没执行完。',
      '请告诉用户这一步该输入什么；如果是一个可以直接回答的确认（y/N、选项序号、路径），把要粘贴的内容单独给出来。',
    ],
  },
  interactive: {
    title: '可能进入了交互式程序',
    detail: (_snapshot, signal) => `疑似程序：${signal.evidence}`,
    ask: [
      '终端当前不像普通 shell（可能在 vim / less / ssh / REPL 等交互式程序里）。',
      '不要按普通 shell 给命令。告诉用户如何退出，或如何在该程序里完成这一步。',
    ],
  },
  success: {
    title: '命令已完成',
    detail: () => '提示符已返回，且没有命中报错。',
    ask: [
      '用户不需要再复述结果——它就在下面。',
      '- 如果这是你给的多步计划里的一步：用一句话确认结果，然后给出下一步（不要重复已完成的步骤）。',
      '- 如果只是用户自己的零散命令（cd / ls / cat 之类）：一句话确认即可，不要改变原计划，也不要重复整段输出。',
    ],
  },
}

function reportText(snapshot, kind, signal) {
  const report = REPORTS[kind]
  const lines = visibleLines(snapshot, kind === 'success' ? 8 : MAX_PROMPT_LINES)
  return [
    `【终端自动上报 · 不是用户输入 · ${report.title}】用户没有手动粘贴任何内容，这是插件观察到终端状态后自动触发的。`,
    report.detail(snapshot, signal),
    `终端最后 ${lines.length} 行（${ageSeconds(snapshot)}s 前更新）：`,
    '',
    '```',
    ...lines,
    '```',
    '',
    ...report.ask,
  ].join('\n')
}

function enqueue(agent, text) {
  const message = {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  // Busy agent: inject instead of followup so the report lands in the next
  // admitted step instead of interrupting the running turn.
  if (agent.status === 'running') {
    agent.inject(message)
    return 'inject'
  }
  agent.followup(message)
  return 'followup'
}

export function apply(ctx) {
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined

  if (typeof systemPrompt?.context === 'function') {
    ctx.effect(() => systemPrompt.context({
      name: 'terminal-screen:current',
      order: 130,
      interpolate: false,
      text: (context) => promptTextFor(context?.agent?.id),
    }), 'terminal-context: prompt context')
  }

  /** One report per command: `kind|commandLine|evidence` is the dedupe key. */
  const report = (sessionId, kind, signal, cooldownMs = WAKE_COOLDOWN_MS) => {
    const snapshot = screens.get(sessionId)
    if (snapshot === undefined || snapshot.share !== true) return false
    const agent = agents?.get?.(sessionId)
    if (agent === undefined) return false
    const commandLine = commandLineOf(snapshot.lines)
    const key = `${kind}|${commandLine}|${signal?.evidence ?? ''}`
    if (key === snapshot.lastSignal) return false
    const isSuccess = kind === 'success'
    const last = isSuccess ? snapshot.lastSuccessAt : snapshot.lastActionAt
    if (Date.now() - (last ?? 0) < cooldownMs) return false
    try {
      const mode = enqueue(agent, reportText(snapshot, kind, signal))
      snapshot.lastSignal = key
      snapshot.lastCommandLine = commandLine
      if (isSuccess) snapshot.lastSuccessAt = Date.now()
      else snapshot.lastActionAt = Date.now()
      ctx.logger?.info?.(`terminal-context: ${kind} report (${mode}) for ${sessionId}`)
      return true
    } catch (error) {
      ctx.logger?.warn?.('terminal-context: report failed: ' + (error instanceof Error ? error.message : String(error)))
      return false
    }
  }

  const classify = (sessionId) => {
    const snapshot = screens.get(sessionId)
    if (snapshot === undefined || snapshot.share !== true) return
    const signal = detectSignal(snapshot.lines)
    if (signal === undefined) {
      snapshot.lastCommandLine = commandLineOf(snapshot.lines)
      snapshot.lastSignal = undefined
      return
    }
    if (signal.kind === 'success') {
      // Requirement: the human should never have to retype a successful result
      // either — the agent picks it up and continues. Deduped per command line
      // and throttled, so a burst of manual commands cannot machine-gun the chat.
      const completed = snapshot.completed
      // An idle bare prompt is not a result: nothing ran, nothing to confirm.
      if (completed === undefined || (completed.command === '' && completed.tail.length === 0)) {
        snapshot.lastSignal = `success|idle`
        return
      }
      report(sessionId, 'success', signal, SUCCESS_COOLDOWN_MS)
      return
    }
    report(sessionId, signal.kind, signal)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PUSH_PATH,
    handler: async (req, res) => {
      try {
        const body = JSON.parse(await readBody(req))
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const share = body.share === undefined ? true : Boolean(body.share)
        const lines = Array.isArray(body.lines) ? body.lines.slice(-MAX_LINES).map(String) : []
        const previous = screens.get(sessionId)
        if (!share) {
          // Switch off: drop the screen so nothing stale can be injected later.
          screens.set(sessionId, {
            diag: null, lines: [], share: false, panelOpen: false, updatedAt: Date.now(), truncated: false,
            lastWakeAt: 0, lastActionAt: 0, lastSuccessAt: 0, lastCommandLine: '', lastSignal: undefined,
          })
          const quiesce = quiesceTimers.get(sessionId)
          if (quiesce !== undefined) { clearTimeout(quiesce); quiesceTimers.delete(sessionId) }
          return send(res, 200, { ok: true, shared: false })
        }
        // First shared push: an error already on screen predates this watch, so
        // mark it as handled instead of reporting a stale traceback.
        const baseline = previous === undefined || previous.share !== true ? detectSignal(lines) : undefined
        const nextCompleted = deriveCompleted(lines)
        screens.set(sessionId, {
          diag: body.diag || null,
          lines,
          share: true,
          panelOpen: body.panelOpen === undefined ? true : Boolean(body.panelOpen),
          probe: typeof body.probe === 'string' ? body.probe : '',
          updatedAt: Date.now(),
          truncated: Boolean(body.truncated),
          lastWakeAt: previous?.lastWakeAt ?? 0,
          lastActionAt: previous?.lastActionAt ?? 0,
          lastSuccessAt: previous?.lastSuccessAt ?? 0,
          lastCommandLine: previous?.lastCommandLine ?? '',
          lastSignal: baseline === undefined ? previous?.lastSignal : `baseline|${baseline.kind}|${baseline.evidence}`,
          completed: nextCompleted === undefined ? previous?.completed : nextCompleted,
        })
        const previousQuiesce = quiesceTimers.get(sessionId)
        if (previousQuiesce !== undefined) clearTimeout(previousQuiesce)
        quiesceTimers.set(sessionId, setTimeout(() => {
          quiesceTimers.delete(sessionId)
          classify(sessionId)
        }, QUIESCE_MS))
        quiesceTimers.get(sessionId)?.unref?.()
        return send(res, 200, { ok: true, shared: true, lines: lines.length })
      } catch (error) {
        return send(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }), 'terminal-context: push route')

  ctx.effect(() => {
    const dispose = ctx.tools.register({
      name: 'read_terminal_context',
      description:
        'Return the last lines the user saw in their sidebar terminal, plus how fresh they are. Works only while the user shares that terminal. Call it before proposing a command when the user is working in a terminal, and after they say a command finished.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(_args, exec) {
        const sessionId = String(exec?.agent?.id ?? '')
        const own = screens.get(sessionId)
        const snapshot = screenOf(sessionId)
        if (snapshot === undefined || !snapshot.updatedAt) {
          return own !== undefined && own.share === false
            ? { available: false, sharing: false, reason: 'the user has sharing switched off' }
            : {
                available: false,
                reason: 'browser half has not pushed anything yet',
                hint: 'the terminal-context client module must be installed, the sidebar terminal opened, and sharing turned on',
              }
        }
        if (snapshot.share === true && snapshot.panelOpen === false) {
          return {
            available: false,
            sharing: true,
            panelOpen: false,
            probe: snapshot.probe ?? '',
            reason: 'sharing is on, but no terminal panel is open; ask the user to open the right sidebar terminal',
          }
        }
        const signal = detectSignal(snapshot.lines)
        return {
          available: true,
          sharing: true,
          panelOpen: snapshot.panelOpen !== false,
          ageSeconds: ageSeconds(snapshot),
          truncated: snapshot.truncated,
          detected: signal?.kind ?? null,
          diag: snapshot.diag,
          lines: snapshot.lines,
        }
      },
    })
    return () => dispose()
  }, 'terminal-context: read tool')
}
