/**
 * Host half of dsh-html-annotate.
 *
 * 只读本地 HTML 原型，运行时注入批注脚本；批注写同目录 sidecar JSON。
 * 源码文件不被修改。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_FILE = path.join(HERE, 'annotation.js')
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'html-annotate.json')
const ROUTE = '/plugins/html-annotate'
const DEFAULT_ROOT = path.join(os.homedir(), 'Documents', 'workplace', 'feishu-retail-ops', 'docs', 'prototypes')

export const inject = ['webServer', 'subprocess', 'tools']

function json(res, status, payload) {
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
    return
  }
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

async function readBody(req) {
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  if (req && typeof req.text === 'function') return req.text()
  return ''
}

async function rootDir() {
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'))
    if (config && typeof config.root === 'string' && config.root.trim()) return path.resolve(config.root)
  } catch { /* 没有配置就用默认 */ }
  return path.resolve(process.env.HTML_ANNOTATE_ROOT || DEFAULT_ROOT)
}

function cwdFromSession(sessionId, sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')) {
  const norm = String(sessionId || '').replace(/^session-/, '').trim()
  if (!norm) return ''
  try {
    for (const group of readdirSync(sessionsRoot)) {
      const file = path.join(sessionsRoot, group, `session-${norm}`, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const head = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0]
      const record = JSON.parse(head)
      return typeof record.cwd === 'string' ? record.cwd : ''
    }
  } catch {
    return ''
  }
  return ''
}

async function workspaceOf(sessionId) {
  const cwd = cwdFromSession(sessionId)
  if (cwd) return { root: path.resolve(cwd), source: 'session', project: path.basename(cwd) }
  return { root: await rootDir(), source: 'config', project: path.basename(await rootDir()) }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.next', '.nuxt', '.cache', 'vendor'])

async function safePath(value, sessionId) {
  const workspace = await workspaceOf(sessionId)
  const raw = String(value || '').trim()
  if (!raw || !/\.html?$/i.test(raw)) throw new Error('bad_file')
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace.root, raw)
  if (!full.startsWith(workspace.root + path.sep)) throw new Error('outside_workspace')
  const rel = path.relative(workspace.root, full).split(path.sep).join('/')
  return { base: rel, full, root: workspace.root, workspace }
}

async function listFiles(sessionId) {
  const workspace = await workspaceOf(sessionId)
  const out = []
  const walk = async (dir, depth) => {
    if (depth > 8 || out.length >= 300) return
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (out.length >= 300) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        out.push(path.relative(workspace.root, full).split(path.sep).join('/'))
      }
    }
  }
  await walk(workspace.root, 0)
  out.sort()
  return { files: out, root: workspace.root, source: workspace.source, project: workspace.project }
}

function isLocalPreviewUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

function isUrlKey(value) {
  return /^https?:\/\//i.test(String(value || ''))
}

function urlAnnotationFile(url) {
  const hash = createHash('sha256').update(String(url)).digest('hex').slice(0, 32)
  return path.join(os.homedir(), '.dsh', 'html-annotate', 'annotations', `${hash}.json`)
}

async function annotationTarget(file, sessionId) {
  if (isUrlKey(file)) {
    if (!isLocalPreviewUrl(file)) throw new Error('bad_preview_url')
    return { base: String(file), target: urlAnnotationFile(file), url: true }
  }
  const { base, full } = await safePath(file, sessionId)
  return { base, target: `${full}.annotations.json`, url: false }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function rewriteRootUrls(html, origin) {
  let out = String(html || '')
  out = out.replace(/\b(src|href|action)=(["'])\/(?!\/)/gi, (match, attr, quote) => `${attr}=${quote}${origin}/`)
  out = out.replace(/url\((["']?)\/(?!\/)/gi, (match, quote) => `url(${quote}${origin}/`)
  return out
}

function previewShim(origin) {
  const target = JSON.stringify(String(origin).replace(/\/$/, ''))
  return `<script data-html-annotate-shim>(function(){
  var TARGET=${target};
  function abs(v){
    if (typeof v !== 'string' || v.charAt(0) !== '/' || v.charAt(1) === '/') return v;
    return TARGET + v;
  }
  try {
    var of=window.fetch;
    if (of) window.fetch=function(input,init){
      try {
        if (typeof input === 'string') input=abs(input);
        else if (input && input.url) {
          var next=abs(input.url);
          if (next !== input.url) input=new Request(next,input);
        }
      } catch (_) {}
      return of.call(this,input,init);
    };
  } catch (_) {}
  try {
    var xo=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url){
      try { url=abs(url); } catch (_) {}
      var args=[].slice.call(arguments); args[1]=url;
      return xo.apply(this,args);
    };
  } catch (_) {}
  try {
    var ES=window.EventSource;
    if (ES) {
      var Wrapped=function(url,cfg){ return new ES(abs(url),cfg); };
      Wrapped.prototype=ES.prototype;
      window.EventSource=Wrapped;
    }
  } catch (_) {}
  try {
    var nb=navigator.sendBeacon;
    if (nb) navigator.sendBeacon=function(url,data){ return nb.call(navigator,abs(url),data); };
  } catch (_) {}
  try {
    var fix=function(el){
      if (!el || el.nodeType !== 1 || !el.getAttribute) return;
      ['src','href','action'].forEach(function(attr){
        var v=el.getAttribute(attr);
        if (typeof v === 'string' && v.charAt(0) === '/' && v.charAt(1) !== '/') el.setAttribute(attr,abs(v));
      });
    };
    var mo=new MutationObserver(function(records){
      records.forEach(function(r){
        if (r.type === 'attributes') fix(r.target);
        r.addedNodes && r.addedNodes.forEach(fix);
      });
    });
    if (document.documentElement) mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href','action']});
    document.addEventListener('DOMContentLoaded',function(){
      document.querySelectorAll('[src],[href],[action]').forEach(fix);
    },{once:true});
  } catch (_) {}
})();</script>`
}

async function injectPreview(html, pageUrl, sessionId, dshOrigin) {
  const cleaned = html.replace(/<script[^>]+annotation\.js[^>]*><\/script>/gi, '')
  const baseHref = new URL('.', pageUrl).href
  const targetOrigin = new URL(pageUrl).origin
  const tag = `<script src="${dshOrigin}${ROUTE}/annotation.js" data-file="${pageUrl}" data-session="${sessionId}" data-api="${dshOrigin}${ROUTE}"></script>`
  let out = rewriteRootUrls(cleaned, targetOrigin)
  const headInjection = `<base href="${baseHref}">\n${previewShim(targetOrigin)}`
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${headInjection}`)
  else out = `${headInjection}\n${out}`
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${tag}\n</body>`)
  return `${out}\n${tag}`
}

function previewStatusPage({ token, state, config, statusUrl }) {
  const details = {
    state: state.state,
    reason: state.reason,
    command: state.command,
    cwd: state.cwd,
    startedAt: state.startedAt,
    lastError: state.lastError,
    stderrTail: state.stderrTail,
    triedPaths: config?.triedPaths || [],
    source: config?.source || null,
    configPath: config?.configPath || null,
    previewCommand: config?.previewCommand ? {
      command: config.previewCommand.command,
      cwd: config.previewCommand.cwd,
      readyTimeoutMs: config.previewCommand.readyTimeoutMs,
    } : null,
  }
  const data = JSON.stringify(details).replace(/</g, '\\u003c')
  const failed = state.state === 'failed'
  const title = failed ? '预览启动失败' : '正在启动预览…'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px;background:#f7f7f8;color:#222}
  .box{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e5e5ea;border-radius:12px;padding:24px}
  h1{font-size:18px;margin:0 0 8px} .muted{color:#666} pre{background:#f3f3f5;padding:12px;border-radius:8px;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-word}
  button{margin-top:12px;padding:8px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}
  </style></head><body><div class="box"><h1>${escapeHtml(title)}</h1><p class="muted">${failed ? '本地预览服务没有启动成功。下面是插件实际使用的命令、工作目录和错误。' : '本地预览服务正在启动，页面会自动刷新。'}</p><pre id="details"></pre>${failed ? '<button onclick="location.reload()">重试</button>' : ''}</div>
  <script>
  var DETAILS=${data};
  document.getElementById('details').textContent=JSON.stringify(DETAILS,null,2);
  ${failed ? '' : `(function poll(){ fetch(${JSON.stringify(statusUrl)}, {cache:'no-store'}).then(function(r){return r.json()}).then(function(s){ if(s && s.state==='running'){ location.reload(); return; } if(s && s.state==='failed'){ location.reload(); return; } setTimeout(poll,500); }).catch(function(){ setTimeout(poll,1000); }); })();`}
  </script></body></html>`
}


async function configCandidates(sessionId) {
  const out = []
  const seen = new Set()
  const add = (file, source) => {
    const full = path.resolve(String(file || ''))
    if (!full || seen.has(full)) return
    seen.add(full)
    out.push({ file: full, source })
  }
  const explicit = String(process.env.HTML_ANNOTATE_CONFIG || '').trim()
  if (explicit) add(explicit, 'env')
  const cwd = cwdFromSession(sessionId)
  if (cwd) {
    let dir = path.resolve(cwd)
    while (true) {
      add(path.join(dir, '.dsh', 'html-annotate.json'), 'cwd-upward')
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const projectRoot = String(process.env.HTML_ANNOTATE_PROJECT_ROOT || '').trim()
  if (projectRoot) add(path.join(path.resolve(projectRoot), '.dsh', 'html-annotate.json'), 'project-root')
  try {
    const workspace = await workspaceOf(sessionId)
    add(path.join(workspace.root, '.dsh', 'html-annotate.json'), 'workspace')
  } catch { /* ignore */ }
  add(CONFIG_FILE, 'home')
  return out
}

async function readPreviewConfig(sessionId) {
  const candidates = await configCandidates(sessionId)
  const triedPaths = candidates.map((item) => item.file)
  const warnings = []
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(await fs.readFile(candidate.file, 'utf8'))
      const previewUrl = String(data.previewUrl || data.url || '')
      if (!previewUrl || !isLocalPreviewUrl(previewUrl)) {
        warnings.push({ file: candidate.file, warning: previewUrl ? 'preview_url_not_local' : 'preview_url_missing' })
        continue
      }
      return {
        ok: true,
        previewUrl,
        autoOpen: data.autoOpen === true,
        previewCommand: data.previewCommand && typeof data.previewCommand === 'object' ? data.previewCommand : null,
        split: data.split !== false,
        source: candidate.source,
        configPath: candidate.file,
        configRoot: path.basename(path.dirname(candidate.file)) === '.dsh'
          ? path.dirname(path.dirname(candidate.file))
          : await workspaceOf(sessionId).then((workspace) => workspace.root).catch(() => ''),
        triedPaths,
        warnings,
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') warnings.push({ file: candidate.file, warning: String(error.message || error) })
    }
  }
  return {
    ok: true,
    previewUrl: '',
    autoOpen: false,
    previewCommand: null,
    split: true,
    source: null,
    configPath: null,
    triedPaths,
    warnings,
  }
}


const previewRuns = new Map()
const previewStates = new Map()
const previewTokens = new Map()
// Chrome 顶层批注页没有 DSH 父窗口；这些提交由 client 轮询后注入当前会话。
const pendingAnnotationsBySession = new Map()

async function pageReady(url, timeoutMs = 800) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function waitReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pageReady(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function pageVersion(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('preview_version_failed')
  const text = await response.text()
  return createHash('sha1').update(text).digest('hex')
}

function previewStateOf(sessionId) {
  let state = previewStates.get(sessionId)
  if (!state) {
    state = {
      state: 'idle',
      reason: '',
      pid: null,
      command: [],
      cwd: '',
      startedAt: null,
      endedAt: null,
      lastError: '',
      stderrTail: '',
      pageUrl: '',
    }
    previewStates.set(sessionId, state)
  }
  return state
}

function stderrTailOf(handle) {
  try {
    const reader = handle?.collected?.stderr
    if (!reader || typeof reader.readFrom !== 'function') return ''
    const read = reader.readFrom(0)
    return String(read?.text || '').slice(-8000)
  } catch {
    return ''
  }
}

function previewSnapshot(sessionId, pageUrl = '') {
  const state = previewStateOf(sessionId)
  const elapsedMs = state.startedAt ? Math.max(0, Date.now() - state.startedAt) : 0
  return {
    state: state.state,
    reason: state.reason,
    pid: state.pid,
    command: state.command,
    cwd: state.cwd,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    elapsedMs,
    lastError: state.lastError,
    stderrTail: state.stderrTail,
    pageUrl: state.pageUrl || pageUrl,
    // DSH subprocess handle 不暴露 child pid；这里如实为 null，不用 process.pid 冒充。
    pidSupported: false,
  }
}

function previewError(code, message, config, extra = {}) {
  const error = new Error(message || code)
  error.code = code
  error.preview = {
    code,
    reason: extra.reason || code,
    previewCommand: config?.previewCommand ? {
      command: config.previewCommand.command,
      cwd: config.previewCommand.cwd,
      readyTimeoutMs: config.previewCommand.readyTimeoutMs,
    } : null,
    triedPaths: config?.triedPaths || [],
    cwd: extra.cwd || '',
    source: config?.source || null,
    configPath: config?.configPath || null,
    stderrTail: extra.stderrTail || '',
    ...extra,
  }
  return error
}

async function startPreview(ctx, sessionId, pageUrl, config) {
  const state = previewStateOf(sessionId)
  state.pageUrl = pageUrl
  if (await pageReady(pageUrl)) {
    state.state = 'running'
    state.reason = ''
    state.startedAt = state.startedAt || Date.now()
    state.endedAt = null
    state.lastError = ''
    return { ok: true, state: 'running', started: false }
  }
  const existing = previewRuns.get(sessionId)
  if (existing && existing.handle && state.state !== 'stopped' && state.state !== 'failed') {
    state.state = 'starting'
    return { ok: true, state: 'starting', started: false, reused: true }
  }
  const commandConfig = config && config.previewCommand
  if (!commandConfig || !Array.isArray(commandConfig.command) || commandConfig.command.length === 0) {
    state.state = 'failed'
    state.reason = 'no_command'
    state.lastError = 'preview_not_running'
    state.endedAt = Date.now()
    return { ok: false, state: 'failed', reason: 'no_command' }
  }
  const workspace = await workspaceOf(sessionId)
  const configRoot = config?.configRoot ? path.resolve(config.configRoot) : workspace.root
  const cwd = path.resolve(configRoot, String(commandConfig.cwd || '.'))
  const withinWorkspace = cwd === workspace.root || cwd.startsWith(workspace.root + path.sep)
  const withinConfigRoot = cwd === configRoot || cwd.startsWith(configRoot + path.sep)
  if (!withinWorkspace && !withinConfigRoot) {
    state.state = 'failed'
    state.reason = 'cwd_outside_workspace'
    state.lastError = 'preview_cwd_outside_workspace'
    state.endedAt = Date.now()
    return { ok: false, state: 'failed', reason: 'cwd_outside_workspace' }
  }
  const env = {}
  if (commandConfig.env && typeof commandConfig.env === 'object') {
    for (const [key, value] of Object.entries(commandConfig.env)) {
      if (typeof value === 'string' || typeof value === 'number') env[String(key)] = String(value)
    }
  }
  const argv = commandConfig.command.map((item) => String(item))
  state.state = 'starting'
  state.reason = ''
  state.command = argv
  state.cwd = cwd
  state.startedAt = Date.now()
  state.endedAt = null
  state.lastError = ''
  state.stderrTail = ''
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd,
      ...(Object.keys(env).length ? { env } : {}),
      stdio: { stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
      graceMs: 5000,
    })
  } catch (error) {
    state.state = 'failed'
    state.reason = 'spawn_failed'
    state.lastError = String(error?.message || error)
    state.endedAt = Date.now()
    return { ok: false, state: 'failed', reason: 'spawn_failed' }
  }
  previewRuns.set(sessionId, { handle, pageUrl })
  const timeoutMs = Math.max(1000, Number(commandConfig.readyTimeoutMs) || 30000)
  // 不阻塞 /preview：先返回启动页，后台轮询 readiness。
  Promise.resolve().then(async () => {
    const ok = await waitReady(pageUrl, timeoutMs)
    if (ok) {
      state.state = 'running'
      state.reason = ''
      state.endedAt = null
      return
    }
    state.state = 'failed'
    state.reason = 'start_timeout'
    state.lastError = 'preview_start_timeout'
    state.stderrTail = stderrTailOf(handle)
    state.endedAt = Date.now()
    try { handle.terminate() } catch { /* ignore */ }
  }).catch((error) => {
    state.state = 'failed'
    state.reason = 'start_failed'
    state.lastError = String(error?.message || error)
    state.endedAt = Date.now()
  })
  handle.done.then((outcome) => {
    state.stderrTail = stderrTailOf(handle)
    state.endedAt = Date.now()
    if (state.state === 'running' || state.state === 'starting') {
      state.state = outcome && outcome.exitCode === 0 ? 'stopped' : 'failed'
      state.reason = state.state === 'stopped' ? 'process_exited' : 'process_failed'
      state.lastError = state.reason
    }
  }).catch((error) => {
    state.state = 'failed'
    state.reason = 'process_failed'
    state.lastError = String(error?.message || error)
    state.stderrTail = stderrTailOf(handle)
    state.endedAt = Date.now()
  })
  return { ok: true, state: 'starting', started: true }
}

async function ensurePreview(ctx, sessionId, pageUrl, config) {
  const started = await startPreview(ctx, sessionId, pageUrl, config)
  if (!started.ok) {
    throw previewError('preview_not_running', 'preview_not_running', config, { reason: started.reason })
  }
  if (started.state === 'running') return started
  const commandConfig = config && config.previewCommand
  const timeoutMs = Math.max(1000, Number(commandConfig?.readyTimeoutMs) || 30000)
  if (await waitReady(pageUrl, timeoutMs)) {
    const state = previewStateOf(sessionId)
    state.state = 'running'
    state.reason = ''
    state.lastError = ''
    return { ok: true, state: 'running', started: started.started !== false }
  }
  const state = previewStateOf(sessionId)
  state.state = 'failed'
  state.reason = 'start_timeout'
  state.lastError = 'preview_start_timeout'
  state.stderrTail = stderrTailOf(previewRuns.get(sessionId)?.handle)
  state.endedAt = Date.now()
  try { previewRuns.get(sessionId)?.handle?.terminate() } catch { /* ignore */ }
  throw previewError('preview_start_timeout', 'preview_start_timeout', config, {
    reason: 'start_timeout', cwd: state.cwd, stderrTail: state.stderrTail,
  })
}


function injectScript(html, file, sessionId) {
  // 去掉旧的本地 annotation 脚本，避免双注入（脚本自身有 guard，先加载的会赢）。
  const cleaned = html.replace(/<script[^>]+annotation\.js[^>]*><\/script>/gi, '')
  const tag = `<script src="${ROUTE}/annotation.js" data-file="${file}" data-session="${sessionId}" data-api="${ROUTE}"></script>`
  if (/<\/body>/i.test(cleaned)) return cleaned.replace(/<\/body>/i, `${tag}\n</body>`)
  return `${cleaned}\n${tag}`
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  return new Response(body, { status, headers: { 'content-type': type } })
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/health`,
    handler: async (_req, res) => json(res, 200, { ok: true }),
  }), 'html-annotate: health')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/files`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      return json(res, 200, { ok: true, ...(await listFiles(url.searchParams.get('sessionId'))) })
    },
  }), 'html-annotate: files')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/config`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        return json(res, 200, await readPreviewConfig(url.searchParams.get('sessionId')))
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: config')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/preview/register`,
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const pageUrl = String(body.url || '')
        const sessionId = String(body.sessionId || '')
        if (!isLocalPreviewUrl(pageUrl)) return json(res, 400, { ok: false, error: 'bad_preview_url' })
        const config = await readPreviewConfig(sessionId)
        await ensurePreview(ctx, sessionId, pageUrl, config)
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
        previewTokens.set(token, { pageUrl, sessionId, createdAt: Date.now() })
        if (previewTokens.size > 100) {
          const oldest = [...previewTokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
          if (oldest) previewTokens.delete(oldest[0])
        }
        return json(res, 200, { ok: true, token })
      } catch (error) {
        return json(res, 500, {
          ok: false,
          error: String(error?.message || error),
          preview: error?.preview || undefined,
        })
      }
    },
  }), 'html-annotate: preview register')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/preview`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const token = String(url.searchParams.get('pid') || '')
        const entry = previewTokens.get(token)
        if (!entry) return send(res, 400, 'html-annotate: preview not registered')
        const pageUrl = entry.pageUrl
        const sessionId = entry.sessionId
        const config = await readPreviewConfig(sessionId)
        const started = await startPreview(ctx, sessionId, pageUrl, config)
        if (!started.ok || started.state !== 'running') {
          const state = previewSnapshot(sessionId, pageUrl)
          const statusUrl = `${ROUTE}/preview/status?pid=${encodeURIComponent(token)}`
          return send(res, 200, previewStatusPage({ token, state, config, statusUrl }), 'text/html; charset=utf-8')
        }
        const navPath = String(url.searchParams.get('path') || '')
        let targetUrl = pageUrl
        if (navPath) {
          const target = new URL(navPath, pageUrl)
          if (target.origin !== new URL(pageUrl).origin) return send(res, 400, 'html-annotate: cross-origin preview navigation')
          if (target.protocol !== 'http:' && target.protocol !== 'https:') return send(res, 400, 'html-annotate: bad preview navigation')
          targetUrl = target.href
        }
        const response = await fetch(targetUrl)
        if (!response.ok) return send(res, 502, `html-annotate: preview ${response.status}`)
        const type = response.headers.get('content-type') || ''
        if (!/text\/html/i.test(type)) return send(res, 415, 'html-annotate: preview is not html')
        const html = await response.text()
        const dshOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `127.0.0.1:${process.env.PORT || ''}`}`
        return send(res, 200, await injectPreview(html, targetUrl, sessionId, dshOrigin), 'text/html; charset=utf-8')
      } catch (error) {
        return send(res, 500, `html-annotate: ${error.message}`)
      }
    },
  }), 'html-annotate: local preview')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/preview/status`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const token = String(url.searchParams.get('pid') || '')
        const entry = previewTokens.get(token)
        if (!entry) return json(res, 400, { ok: false, error: 'preview_not_registered' })
        const state = previewStateOf(entry.sessionId)
        const ready = await pageReady(entry.pageUrl)
        if (state.state === 'running' && !ready) {
          state.state = 'stopped'
          state.reason = 'page_down'
          state.lastError = 'preview_page_not_responding'
          state.endedAt = Date.now()
        } else if (state.state !== 'running' && ready) {
          state.state = 'running'
          state.reason = ''
          state.lastError = ''
          state.endedAt = null
        }
        return json(res, 200, { ok: true, ...previewSnapshot(entry.sessionId, entry.pageUrl) })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: preview status')


  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/pending-annotations`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const sessionId = String(url.searchParams.get('sessionId') || '')
      return json(res, 200, { ok: true, annotations: sessionId ? (pendingAnnotationsBySession.get(sessionId) || []) : [] })
    },
  }), 'html-annotate: pending annotations')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/pending-annotations/ack`,
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const sessionId = String(body.sessionId || '')
        if (sessionId) pendingAnnotationsBySession.delete(sessionId)
      } catch { /* ignore malformed ack */ }
      return json(res, 200, { ok: true })
    },
  }), 'html-annotate: pending annotations ack')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/preview/version`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const entry = previewTokens.get(String(url.searchParams.get('pid') || ''))
        if (!entry) return json(res, 400, { ok: false, error: 'preview_not_registered' })
        return json(res, 200, { ok: true, version: await pageVersion(entry.pageUrl) })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: preview version')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/annotation.js`,
    handler: async (_req, res) => send(res, 200, await fs.readFile(SCRIPT_FILE, 'utf8'), 'application/javascript; charset=utf-8'),
  }), 'html-annotate: script')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/page`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId')
        const { base, full } = await safePath(url.searchParams.get('file'), sessionId)
        return send(res, 200, injectScript(await fs.readFile(full, 'utf8'), base, sessionId), 'text/html; charset=utf-8')
      } catch (error) {
        return send(res, 404, `html-annotate: ${error.message}`)
      }
    },
  }), 'html-annotate: page')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/annotations`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method === 'GET') {
          const key = url.searchParams.get('file')
          const { base, target } = await annotationTarget(key, url.searchParams.get('sessionId'))
          try {
            return json(res, 200, { ok: true, file: base, annotations: JSON.parse(await fs.readFile(target, 'utf8')) })
          } catch {
            return json(res, 200, { ok: true, file: base, annotations: [] })
          }
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { base, target } = await annotationTarget(body.file, body.sessionId)
          let annotations = []
          try { annotations = JSON.parse(await fs.readFile(target, 'utf8')) } catch { /* new */ }
          const record = {
            id: `anno_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
            file: base,
            selector: String(body.selector || '').slice(0, 2000),
            snippet: String(body.snippet || '').slice(0, 6000),
            text: String(body.text || '').slice(0, 300),
            comment: String(body.comment || '').slice(0, 4000),
            url: String(body.url || '').slice(0, 2000),
            createdAt: new Date().toISOString(),
          }
          annotations.push(record)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, `${JSON.stringify(annotations, null, 2)}\n`, 'utf8')
          return json(res, 200, { ok: true, file: base, count: annotations.length, annotation: record })
        }
        return json(res, 405, { ok: false, error: 'method_not_allowed' })
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: annotations')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/annotations/submit`,
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const { base, target } = await annotationTarget(body.file, body.sessionId)
        let annotations = []
        try { annotations = JSON.parse(await fs.readFile(target, 'utf8')) } catch { /* none */ }
        const now = new Date().toISOString()
        const submitted = []
        annotations = annotations.map((item) => {
          if (item.submittedAt) return item
          const markedItem = { ...item, submittedAt: now }
          submitted.push(markedItem)
          return markedItem
        })
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, `${JSON.stringify(annotations, null, 2)}\n`, 'utf8')
        if (body.source === 'chrome' && body.sessionId && submitted.length) {
          const queue = pendingAnnotationsBySession.get(String(body.sessionId)) || []
          queue.push(...submitted)
          pendingAnnotationsBySession.set(String(body.sessionId), queue.slice(-100))
        }
        return json(res, 200, { ok: true, file: base, count: annotations.length, marked: submitted.length, submitted })
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'html-annotate: submit')

  ctx.effect(() => ctx.tools.register({
    name: 'open_html_annotate',
    description: 'Open a local HTML page in Google Chrome for annotation. Always launches Chrome; there is no DSH panel fallback. Call this when the user asks to annotate a page.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional target DSH session id. Defaults to the current session from the tool context.' },
        url: { type: 'string', description: 'Optional local preview URL. Defaults to the project .dsh/html-annotate.json previewUrl.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sessionId = String((args && args.sessionId) || exec?.agent?.id || '').trim()
      if (!sessionId) throw new Error('open_html_annotate requires a session id (tool context had none)')
      const config = await readPreviewConfig(sessionId)
      const pageUrl = String((args && args.url) || config.previewUrl || '').trim()
      if (!isLocalPreviewUrl(pageUrl)) throw new Error('open_html_annotate: needs a local preview URL')
      const started = await startPreview(ctx, sessionId, pageUrl, config)
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
      previewTokens.set(token, { pageUrl, sessionId, createdAt: Date.now() })
      const origin = String(process.env.DSH_WEB_URL || 'http://127.0.0.1:64660').replace(/\/$/, '')
      const previewUrl = `${origin}${ROUTE}/preview?pid=${encodeURIComponent(token)}`
      try {
        ctx.subprocess.spawn({
          argv: ['open', '-na', 'Google Chrome', '--args', '--new-window', previewUrl],
          cwd: process.cwd(),
          stdio: { stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
          graceMs: 5000,
        })
      } catch (error) {
        throw new Error('打开 Google Chrome 失败：' + error.message)
      }
      if (config.split !== false) {
        setTimeout(() => {
          try {
            ctx.subprocess.spawn({ argv: ['hs', '-c', '_G.splitDSHChrome()'], cwd: process.cwd(), stdio: { stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000 })
          } catch { /* Hammerspoon optional */ }
        }, 1200)
      }
      return { ok: true, mode: 'chrome', message: '已在 Google Chrome 打开标注页，并请求左右分屏', previewUrl, sessionId, previewState: started }
    },
  }), 'html-annotate: open tool')

  ctx.effect(() => () => {
    for (const entry of previewRuns.values()) {
      try { entry.handle.terminate() } catch { /* ignore */ }
    }
    previewRuns.clear()
    previewTokens.clear()
  }, 'html-annotate: preview processes')
}
