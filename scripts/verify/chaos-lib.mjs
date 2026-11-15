// SPDX-License-Identifier: CPAL-1.0
// 混沌验收公共件（纯 Node，无浏览器）：独立临时 GITRADER_HOME、起 / 杀内核、HTTP 调 op、会话、设 PIN、批 Agent 钥匙。
// 红线：端口只用 46500-46599；只按自己记录的 PID 杀，杀前核对命令行；测试 PIN 随机、只在内存，不进日志与结果。
import { spawn, spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CLI = join(ROOT, 'packages', 'cli', 'dist', 'bin.js')
export const OUT_DIR = join(ROOT, 'reports', 'fix-r2', 'chaos')
export const PORT_MIN = 46500
export const PORT_MAX = 46599

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const _kernels = new Set()
const _homes = new Set()
export const now = () => Date.now()
export const isoNow = () => new Date().toISOString()

export function parseFlags(argv = process.argv.slice(2)) {
  const f = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const nx = argv[i + 1]
    if (nx === undefined || nx.startsWith('--')) f[k] = true
    else { f[k] = nx; i++ }
  }
  return f
}

export function assertPort(p) {
  if (!Number.isInteger(p) || p < PORT_MIN || p > PORT_MAX) throw new Error(`port ${p} 不在 ${PORT_MIN}-${PORT_MAX}`)
  return p
}

export const randomPin = () => String(randomInt(10_000_000, 100_000_000))

// ---- 结果 --------------------------------------------------------------------
export function writeResult(name, obj) {
  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = isoNow().replace(/[:.]/g, '-')
  const path = join(OUT_DIR, `${name}-${stamp}.json`)
  writeFileSync(path, JSON.stringify(obj, null, 1), 'utf8')
  return path
}

// ---- 临时主目录 ---------------------------------------------------------------
export function newHome(tag = 'x') {
  const h = mkdtempSync(join(tmpdir(), `gitrader-chaos-${tag}-`))
  _homes.add(h)
  return h
}
export function removeHome(home) {
  if (!home || !home.includes('gitrader-chaos-')) throw new Error(`拒绝删除不像临时主目录的路径：${home}`)
  for (let i = 0; i < 5; i++) {
    try { rmSync(home, { recursive: true, force: true }); _homes.delete(home); return true } catch { /* 句柄还没放 */ }
    sleepSync(400)
  }
  return !existsSync(home)
}

// ---- CLI ------------------------------------------------------------------------
/** 同步跑 CLI；返回 { code, out, err }。 */
export function cli(home, args, { input, timeoutMs = 120_000, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, GITRADER_HOME: home, ...env }, input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', signal: r.signal }
}

export function initHome(home) {
  const r = cli(home, ['init', '--no-pin'])
  if (r.code !== 0) throw new Error(`init 失败：${r.err || r.out}`)
  return r
}

// ---- 进程 --------------------------------------------------------------------------
export function procInfo(pid) {
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.CommandLine }`], { encoding: 'utf8', windowsHide: true })
  const line = (ps.stdout ?? '').trim()
  return line || null
}
export function childPids(pid) {
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true })
  return (ps.stdout ?? '').split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf('|'); return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) } })
}
export function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
/** 杀前核对：命令行含 serve 与自己的端口。 */
export function verifyKernelPid(pid, port) {
  const cmd = procInfo(pid)
  return cmd !== null && /\bserve\b/.test(cmd) && cmd.includes(`--port ${port}`) && cmd.replace(/\//g, '\\').toLowerCase().includes(join('packages', 'cli', 'dist', 'bin.js').toLowerCase())
}

/**
 * 起内核：`serve --detach --port P`，取 PID 与启动令牌，等 /api/health 200。
 * 返回 { pid, port, base, launch, home, children, logPath }；children 是启动后记录的子进程（引擎），收尾时一并按 PID 清。
 */
export async function startKernel(home, port, { extraArgs = [], healthTimeoutMs = 40_000, requireHealthy = true } = {}) {
  assertPort(port)
  const r = cli(home, ['serve', '--detach', '--port', String(port), ...extraArgs], { timeoutMs: 60_000 })
  const text = `${r.out}\n${r.err}`
  const pid = Number(/进程\s+(\d+)/.exec(text)?.[1] ?? NaN)
  const launch = /launch=([A-Za-z0-9_-]+)/.exec(text)?.[1]
  const logPath = /日志：(.+?)[　\s]+停止/.exec(text)?.[1]
  if (r.code !== 0 || !Number.isInteger(pid)) return { ok: false, code: r.code, out: r.out, err: r.err, port, home }
  const base = `http://127.0.0.1:${port}`
  const k = { ok: true, pid, port, base, launch, home, logPath, children: [], startedAt: now() }
  const deadline = now() + healthTimeoutMs
  while (requireHealthy && now() < deadline) {
    try { const h = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }); if (h.status === 200) break } catch { /* 还没起 */ }
    await sleep(150)
  }
  k.children = childPids(pid)
  _kernels.add(k)
  return k
}

/** 按记录的 PID 杀内核（process.kill = TerminateProcess，等价 taskkill /F 但无进程启动延迟），随后清它记录过的子进程。 */
export function killKernel(k, { verify = true } = {}) {
  if (!k?.pid) return { killed: false, reason: 'no pid' }
  if (verify && alive(k.pid) && !verifyKernelPid(k.pid, k.port)) return { killed: false, reason: `命令行核对不符：${procInfo(k.pid)}` }
  const kids = [...(k.children ?? [])]
  try { process.kill(k.pid, 'SIGKILL') } catch { /* 已退出 */ }
  return { killed: true, kids }
}
/** 等内核退出，并清子进程（只清核对过命令行含 engine-core 与本树 dist 的）。 */
export async function reapKernel(k, kids = k?.children ?? []) {
  const deadline = now() + 8000
  while (alive(k.pid) && now() < deadline) await sleep(100)
  await sleep(500)
  const leftovers = []
  for (const c of kids) {
    if (!alive(c.pid)) continue
    const cmd = procInfo(c.pid) ?? ''
    if (cmd.includes('engine-core') && cmd.replace(/\//g, '\\').toLowerCase().includes(join('packages', 'cli', 'dist').toLowerCase())) {
      leftovers.push(c.pid)
      try { process.kill(c.pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  }
  return { kernelAlive: alive(k.pid), orphanEnginesKilled: leftovers }
}
export async function stopKernel(k) {
  const a = killKernel(k)
  const b = await reapKernel(k, a.kids)
  return { ...a, ...b }
}
// ponytail: Windows 上 detach 出来的服务没有控制台，没法投递真 Ctrl+C（实测 AttachConsole 失败，前台隐藏控制台下 Ctrl+C 也没停下内核）。
// 需要“正常停服务（含关机冲刷）”的场景用一个薄包装进程在同一进程里加载 CLI，并在收到停止文件时对自己 emit('SIGINT')：
// 走的正是 `gitrader serve` 里 process.once('SIGINT') → stopper.stop() → k.stop() 这条路径，只是信号来源不是操作系统。
const WRAPPER_SRC = [
  "import { existsSync } from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  'const [cli, stopFile, ...rest] = process.argv.slice(2)',
  "process.argv = [process.argv[0], cli, ...rest]",
  "setInterval(() => { if (existsSync(stopFile)) { process.emit('SIGINT') } }, 50)",
  'await import(pathToFileURL(cli).href)',
].join('\n')
const WRAPPER_PATH = join(tmpdir(), 'gitrader-chaos-serve-wrapper.mjs')

/** 可正常停的内核：同 startKernel 的返回形状；k.stopFile 存在即触发正常停机。 */
export async function startKernelGraceful(home, port, { extraArgs = [], healthTimeoutMs = 40_000 } = {}) {
  assertPort(port)
  writeFileSync(WRAPPER_PATH, WRAPPER_SRC, 'utf8')
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', `graceful-${port}-${now()}.log`)
  const stopFile = join(home, `stop-${port}.flag`)
  const fd = openSync(logPath, 'a')
  const child = spawn(process.execPath, [WRAPPER_PATH, CLI, stopFile, 'serve', '--port', String(port), ...extraArgs], {
    detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, GITRADER_HOME: home },
  })
  child.unref()
  closeSync(fd)
  const base = `http://127.0.0.1:${port}`
  const k = { ok: true, pid: child.pid, port, base, home, logPath, children: [], startedAt: now(), graceful: true, stopFile }
  const deadline = now() + healthTimeoutMs
  let launch
  while (now() < deadline) {
    try { launch = launch ?? /launch=([A-Za-z0-9_-]+)/.exec(readFileSync(logPath, 'utf8'))?.[1] } catch { /* 日志还没出 */ }
    try { const h = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }); if (h.status === 200 && launch) break } catch { /* 还没起 */ }
    if (!alive(k.pid)) { k.ok = false; k.err = readFileSync(logPath, 'utf8').slice(-800); return k }
    await sleep(150)
  }
  k.launch = launch
  k.children = childPids(k.pid).filter((c) => c.cmd.includes('engine-core'))
  _kernels.add(k)
  return k
}

/** 正常停服务：写停止文件 → 包装进程 emit SIGINT → k.stop()（含关机冲刷）；超时回退硬杀。 */
export async function gracefulStop(k, { timeoutMs = 25_000 } = {}) {
  if (!k.graceful) throw new Error('gracefulStop 只支持 startKernelGraceful 起的内核')
  if (alive(k.pid) && !verifyKernelPid(k.pid, k.port)) return { graceful: false, reason: '命令行核对不符' }
  writeFileSync(k.stopFile, 'stop', 'utf8')
  const deadline = now() + timeoutMs
  while (alive(k.pid) && now() < deadline) await sleep(100)
  try { rmSync(k.stopFile, { force: true }) } catch { /* 无所谓 */ }
  if (!alive(k.pid)) { const r = await reapKernel(k); return { graceful: true, ...r, exitedInMs: now() - (deadline - timeoutMs) } }
  const hard = await stopKernel(k)
  return { graceful: false, hard }
}

// ---- HTTP ------------------------------------------------------------------------
async function post(base, path, headers, body, timeoutMs) {
  const t0 = performance.now()
  let res
  try {
    res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    return { status: 0, netError: `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code ?? e.cause.message})` : ''}`, ms: Math.round(performance.now() - t0) }
  }
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, json, headers: res.headers, ms: Math.round(performance.now() - t0) }
}

export async function health(base) {
  try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }); return { status: r.status, json: await r.json() } } catch (e) { return { status: 0, netError: e.message } }
}

/** 会话：op(name, params, {pin:true}) → 成功返回 result，失败抛带 problem 的 Error；raw(name, params, opts) 返回原始响应。 */
export class Session {
  constructor(base, token, getPin) { this.base = base; this.token = token; this.getPin = getPin }
  async raw(name, params = {}, { pin = false, timeoutMs = 20_000 } = {}) {
    return post(this.base, `/api/op/${name}`, { authorization: `Bearer ${this.token}`, ...(pin ? { 'x-gitrader-pin': this.getPin() } : {}) }, { params }, timeoutMs)
  }
  async op(name, params = {}, opts = {}) {
    const r = await this.raw(name, params, opts)
    if (r.status === 200 && r.json?.ok) return r.json.result
    throw Object.assign(new Error(`${name}: ${r.netError ?? r.json?.error?.message ?? r.status}`), { problem: r.json?.error, status: r.status, netError: r.netError })
  }
  async metrics() {
    const r = await fetch(`${this.base}/api/metrics`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) })
    return { status: r.status, text: await r.text() }
  }
}

export async function openSession(k, getPin, launch = k.launch) {
  const r = await post(k.base, '/api/session', {}, { bootstrap: launch }, 15_000)
  if (r.status !== 200) throw new Error(`会话失败：${r.status} ${r.netError ?? JSON.stringify(r.json)}`)
  return new Session(k.base, r.json.sessionToken, getPin)
}

/** 首次设 PIN（会话即可）；已有 PIN 时不重复设。 */
export async function setPinOnce(session) {
  return session.op('pin.set', { pin: session.getPin() })
}

// ---- Agent 钥匙 ----------------------------------------------------------------------
/**
 * 创建并批准一把 Agent 钥匙：非终端跑 `keys new agent`（会在内核登记接入请求并轮询），
 * 脚本同时用会话令牌找到请求并带 PIN 批准。返回 { name, tokenFile, token }。
 */
export async function newAgentKey(k, session, name, { tier = 'paper', maxOrder = '100000', maxDaily = '1000000000', extra = [], instruments = 'BTC,ETH' } = {}) {
  await waitMarketReady(session)
  const args = [CLI, 'keys', 'new', 'agent', name, '--host', 'claude-code', '--tier', tier, '--preset', 'starter',
    '--max-order', String(maxOrder), '--max-daily', String(maxDaily), '--instruments', instruments, '--days', '3', ...extra]
  const child = spawn(process.execPath, args, { env: { ...process.env, GITRADER_HOME: k.home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const exited = new Promise((res) => child.on('close', (code) => res(code)))
  let approved = null
  const deadline = now() + 60_000
  while (!approved && now() < deadline) {
    const list = await session.op('agentkey.request.list').catch(() => ({ requests: [] }))
    const req = (list.requests ?? []).find((q) => q.state === 'pending' && (q.input?.name === name || q.name === name))
    if (req) approved = await session.op('agentkey.request.approve', { requestId: req.requestId }, { pin: true })
    else await sleep(400)
  }
  const code = await Promise.race([exited, sleep(30_000).then(() => 'timeout')])
  if (!approved || code !== 0) { try { child.kill() } catch { /* 已退出 */ } throw new Error(`新建钥匙 ${name} 失败（approved=${!!approved}，退出码 ${code}）：${out.slice(-400)}`) }
  const tokenFile = join(k.home, 'agent-tokens', `${name}.token`)
  const token = readFileSync(tokenFile, 'utf8').trim()
  return { name, tokenFile, token, keyId: approved.keyId, cliOutput: out }
}

/** Agent 面：POST /api/op/agent.<tool>，params 自带 action。返回 { status, ok, data, error, ms, netError }。 */
export function agentApi(k, token) {
  const call = async (tool, params = {}, { timeoutMs = 30_000 } = {}) => {
    const r = await post(k.base, `/api/op/agent.${tool}`, { authorization: `Bearer ${token}` }, { params }, timeoutMs)
    const ok = r.status === 200 && r.json?.ok === true
    return { status: r.status, ok, data: ok ? r.json.result?.data : undefined, session: ok ? r.json.result?.session : undefined, error: ok ? undefined : r.json?.error, netError: r.netError, ms: r.ms, retryAfter: r.headers?.get?.('retry-after') }
  }
  return { call }
}

/** 纸面账户 + BTC 市价买 + 附带止损的标准意图。 */
export async function standardIntent(agent, { size = '0.001', side = 'buy', stopFactor = 0.98, reason = 'chaos', instrumentId = 'hyperliquid:BTC' } = {}) {
  const acct = await agent.call('account', { action: 'list' })
  if (!acct.ok) throw new Error(`account.list 失败：${JSON.stringify(acct.error ?? acct.netError)}`)
  const accountId = (acct.data?.accounts ?? acct.data)?.[0]?.accountId ?? acct.data?.items?.[0]?.accountId
  if (!accountId) throw new Error(`取不到 accountId：${JSON.stringify(acct.data).slice(0, 200)}`)
  let q
  for (let i = 0; i < 20; i++) { q = await agent.call('market', { action: 'quote', instrumentId }); if (q.ok && Number.isFinite(Number(q.data?.last ?? q.data?.mark ?? q.data?.price))) break; await sleep(1000) }
  const px = Number(q.data?.last ?? q.data?.mark ?? q.data?.price)
  if (!q.ok || !Number.isFinite(px)) throw new Error(`quote 失败：${JSON.stringify(q.error ?? q.netError ?? q.data).slice(0, 300)}`)
  const trigger = String(Math.round(px * (side === 'buy' ? stopFactor : 2 - stopFactor)))
  return { accountId, px, intent: { accountId, instrumentId, side, type: 'market', size, reason, tpsl: { grouping: 'order', stopLoss: { triggerPrice: trigger } } } }
}

// ---- 核对 ---------------------------------------------------------------------------
/** 重启后的一键核对：status 子集 + ledger verify + 账户视图 + doctor 结论。agent 可为空（只做内核级核对）。 */
export async function snapshot(k, session, agent, accountId) {
  const out = { at: isoNow() }
  try {
    const st = await session.op('status')
    out.status = { tradingState: st.tradingState, stateReasons: st.stateReasons, paperState: st.paperState, ledgerVerify: st.ledgerVerify, ledger: st.ledger, stateFiles: st.stateFiles }
  } catch (e) { out.statusError = e.message }
  const lv = cli(k.home, ['ledger', 'verify', '--json'])
  out.ledgerVerifyCli = { code: lv.code, out: lv.out.trim().slice(0, 400), err: lv.err.trim().slice(0, 200) }
  if (agent && accountId) {
    for (const view of ['positions', 'orders', 'fills']) {
      const r = await agent.call('account', { action: view, accountId, limit: 200 })
      out[view] = r.ok ? r.data : { error: r.error ?? r.netError }
    }
  }
  out.doctor = doctorSummary(k.home)
  return out
}
export function doctorSummary(home) {
  const r = cli(home, ['doctor', '--json'], { timeoutMs: 90_000 })
  let j = null
  try { j = JSON.parse(r.out) } catch { /* 非 JSON */ }
  const checks = (j?.checks ?? []).map((c) => ({ id: c.id, level: c.level, zh: c.zh, next: c.next ?? null }))
  return { code: r.code, summary: j?.summary ?? null, blocks: checks.filter((c) => c.level === 'block'), warns: checks.filter((c) => c.level === 'warn'), raw: j ? undefined : (r.out + r.err).slice(0, 400) }
}

/** 数组/视图里取行：兼容 { items } / { positions } / 直接数组。 */
export function rowsOf(view) {
  if (Array.isArray(view)) return view
  if (!view || typeof view !== 'object') return []
  for (const key of ['items', 'positions', 'orders', 'fills', 'rows', 'entries']) if (Array.isArray(view[key])) return view[key]
  return []
}

export function createRunner(name, meta = {}) {
  const run = { scenario: name, startedAt: isoNow(), meta, rounds: [], notes: [], summary: null }
  return {
    run,
    note: (s) => { run.notes.push(s); console.log(`[${name}] ${s}`) },
    round: (r) => { run.rounds.push(r); return r },
    finish(summary) { run.finishedAt = isoNow(); run.summary = summary; const path = writeResult(name, run); console.log(`[${name}] 结果：${path}`); return path },
  }
}

// ---- MCP 客户端（真走 gitrader-mcp 的 stdio，复现 Agent 实际收到的文案 / 结构）-----------------------------
export const MCP_BIN = join(ROOT, 'packages', 'cli', 'dist', 'gitrader-mcp.js')
export function mcpConnect(home, tokenFile) {
  const p = spawn(process.execPath, [MCP_BIN], { env: { ...process.env, GITRADER_HOME: home, GITRADER_AGENT_TOKEN_FILE: tokenFile }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''
  let id = 0
  let stderr = ''
  const pend = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try { const m = JSON.parse(line); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } } catch { /* 非 JSON 帧 */ }
    }
  })
  p.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
  const rpc = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`) })
  return {
    pid: p.pid,
    stderr: () => stderr,
    async init() {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gitrader-chaos', version: '1' } })
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      return r
    },
    async call(name, args, { timeoutMs = 120_000 } = {}) {
      const t0 = performance.now()
      const r = await Promise.race([rpc('tools/call', { name, arguments: args }), sleep(timeoutMs).then(() => ({ timeout: true }))])
      const ms = Math.round(performance.now() - t0)
      if (r.timeout) return { ms, timeout: true }
      let res = r
      try { const txt = r.result?.content?.[0]?.text; res = txt ? JSON.parse(txt) : r } catch { res = { raw: r.result?.content?.[0]?.text ?? r } }
      return { ms, isError: !!r.result?.isError || !!r.error, res, rpcError: r.error }
    },
    close() { try { p.stdin.end() } catch { /* 已关 */ } try { p.kill() } catch { /* 已退出 */ } },
  }
}

// ---- 账本直读（只读打开 SQLite；服务在跑也能读）--------------------------------------------------------------
export async function readLedger(home, { fromSeq = 0 } = {}) {
  const { DatabaseSync } = await import('node:sqlite')
  const path = join(home, 'data', 'gitrader.sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare('SELECT seq, entry FROM ledger WHERE seq >= ? ORDER BY seq').all(fromSeq)
    return rows.map((r) => JSON.parse(r.entry))
  } finally { db.close() }
}
/** seq 必须从 0 起连续；返回缺口列表。 */
export function ledgerGaps(entries) {
  const gaps = []
  let prev = -1
  for (const e of entries) { if (e.seq !== prev + 1) gaps.push({ after: prev, got: e.seq }); prev = e.seq }
  return gaps
}
export function countBy(xs, f) {
  const m = {}
  for (const x of xs) { const key = f(x); m[key] = (m[key] ?? 0) + 1 }
  return m
}

/** 账户视图翻页取全（每页 200，沿 next 游标）。 */
export async function allRows(agent, view, accountId, extra = {}) {
  const rows = []
  let cursor
  for (let i = 0; i < 50; i++) {
    const r = await agent.call('account', { action: view, accountId, limit: 200, ...extra, ...(cursor ? { cursor } : {}) })
    if (!r.ok) return { error: r.error ?? r.netError, rows }
    rows.push(...rowsOf(r.data))
    cursor = r.data?.next
    if (!cursor) break
  }
  return { rows }
}

/** 恢复交易：先 org，再 stateReasons 里点名的各 scope（都要 PIN）；返回每次尝试与最终状态。 */
export async function resumeTrading(session) {
  const tries = []
  const attempt = async (scope) => {
    try { const r = await session.op('trading_state.resume', { ...(scope ? { scope } : {}), reason: 'chaos resume' }, { pin: true }); tries.push({ scope: scope ?? 'org', ok: true, result: r }); return true } catch (e) { tries.push({ scope: scope ?? 'org', ok: false, error: e.problem ? { name: e.problem.name, code: e.problem.code, message: String(e.problem.message).slice(0, 240) } : e.message }); return false }
  }
  await attempt(null)
  let st = await session.op('status').catch(() => null)
  for (const r of st?.stateReasons ?? []) {
    if (st?.tradingState === 'ACTIVE') break
    const scope = r.scope
    if (scope?.type && scope?.id) { await attempt(scope); st = await session.op('status').catch(() => null) }
  }
  return { tries, tradingState: st?.tradingState ?? null, stateReasons: st?.stateReasons ?? null }
}

// ---- 兜底清理：异常退出时只按自己记录的 PID 杀内核（核对命令行），并删自己建的临时主目录 -------------------------------------
export function cleanupAll() {
  for (const k of _kernels) {
    try {
      if (alive(k.pid) && verifyKernelPid(k.pid, k.port)) process.kill(k.pid, 'SIGKILL')
      for (const c of k.children ?? []) if (alive(c.pid) && (procInfo(c.pid) ?? '').includes('engine-core')) process.kill(c.pid, 'SIGKILL')
    } catch { /* 已退出 */ }
  }
  _kernels.clear()
  if (_homes.size) sleepSync(800)
  for (const h of [..._homes]) { try { removeHome(h) } catch { /* 留给人工 */ } }
}
process.on('exit', cleanupAll)

/** 内核刚起（或刚重启）后行情目录与报价是异步加载的：等到 market.instruments 非空、BTC 有报价再下单。 */
export async function waitMarketReady(session, { timeoutMs = 60_000 } = {}) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    try {
      const rows = await session.op('market.instruments', { limit: 5 })
      if (Array.isArray(rows) && rows.length > 0) {
        const q = await session.op('market.quote', { instrumentId: 'hyperliquid:BTC' }).catch(() => null)
        if (q) return true
      }
    } catch { /* 还没好 */ }
    await sleep(500)
  }
  return false
}
