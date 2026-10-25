/**
 * Host half of terminal-context.
 *
 * The browser half subscribes to `terminalController.attach` (a Remote-only
 * stream a Host plugin cannot open) and pushes the visible lines here. This
 * half keeps only the most recent push in memory and exposes it to the agent
 * through a tool. Nothing is written to disk: the terminal may contain
 * secrets, so the buffer dies with the process.
 */

const PUSH_PATH = '/plugins/terminal-context/push'
const MAX_LINES = 200

let latest = { updatedAt: 0, terminalId: '', cwd: '', lines: [], truncated: false, diag: null }

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

export const inject = ['tools', 'webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PUSH_PATH,
    handler: async (req, res) => {
      try {
        const body = JSON.parse(await readBody(req))
        const lines = Array.isArray(body.lines) ? body.lines.slice(-MAX_LINES).map(String) : []
        latest = {
          diag: body.diag || null,
          updatedAt: Date.now(),
          terminalId: String(body.terminalId || ''),
          cwd: String(body.cwd || ''),
          lines,
          truncated: Boolean(body.truncated),
        }
        return send(res, 200, { ok: true, lines: lines.length })
      } catch (error) {
        return send(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }), 'terminal-context: push route')

  ctx.effect(() => {
    const dispose = ctx.tools.register({
      name: 'read_terminal_context',
      description:
        'Return the last lines the user saw in their sidebar terminal, plus its working directory and how fresh it is. Use before proposing a command when the user is working in a terminal, and after they say a command finished.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        if (!latest.updatedAt) {
          return {
            available: false,
            reason: 'browser half has not pushed anything yet',
            hint: 'the terminal-context client module must be installed and the page reloaded',
          }
        }
        return {
          available: true,
          ageSeconds: Math.round((Date.now() - latest.updatedAt) / 1000),
          terminalId: latest.terminalId,
          cwd: latest.cwd,
          truncated: latest.truncated,
          diag: latest.diag,
          lines: latest.lines,
        }
      },
    })
    return () => dispose()
  })
}
