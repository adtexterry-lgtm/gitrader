// SPDX-License-Identifier: CPAL-1.0
// 纸面模式端到端冒烟：一条命令证明「内核起得来 → 纸面交易可用 → 回测跑通 → 报告导出 → 账本有记录」。
//
//   node tools/smoke/journey.mjs [--keep] [--verbose]
//
// 约束：临时 GITRADER_HOME（mkdtemp）、GITRADER_SKIP_BROWSER=1、不联网（行情是进程内固定盘口）、
// 不动用户 ~/.gitrader、只按自己记录的 PID 结束自己的子进程。任一步失败 → 退出码 1，并照实打印哪一步、报什么错。
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatTable, killTargets, pickFreePort, waitForReady } from './lib/helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'bin.js')
const ENGINE = join(ROOT, 'packages', 'engine-core', 'dist', 'engine-core.mjs')
const EXAMPLE_STRATEGY = join(ROOT, 'packages', 'engine-core', 'examples', 'strategies', 'ema-cross.ts')
const PIN = '482913'
const BTC = 'hyperliquid:BTC'
const keep = process.argv.includes('--keep')
const verbose = process.argv.includes('--verbose')

const rows = []
const children = [] // 只装自己 spawn 的子进程（{pid, what, child}）

const say = (s) => process.stderr.write(s + '\n')
const vlog = (s) => { if (verbose) say(`    · ${s}`) }
const tail = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').slice(-n)

function record(step, ok, t0, detail) {
  const row = { step, ms: String(Math.round(performance.now() - t0)), result: ok ? 'ok' : 'FAIL', detail: tail(detail, 220) }
  rows.push(row)
  say(`${ok ? 'PASS' : 'FAIL'}  ${step}  (${row.ms} ms)${detail ? `  — ${tail(detail)}` : ''}`)
  return ok
}

const tmp = mkdtempSync(join(tmpdir(), 'gitrader-smoke-'))
const HOME = join(tmp, 'home')
const OUT = join(tmp, 'out')
mkdirSync(HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })

const BASE_ENV = { ...process.env, GITRADER_HOME: HOME, GITRADER_SKIP_BROWSER: '1', GITRADER_ENGINE_CORE_BUNDLE: ENGINE }
delete BASE_ENV.GITRADER_OFFLINE
delete BASE_ENV.GITRADER_PIN_STDIN

/** 跑真 CLI 单文件；PIN 要按行分开喂（非终端时 readSecret 每次只取一行，同块里的第二行会丢）。 */
function runCli(args, o = {}) {
  const t0 = performance.now()
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, ...args, '--home', HOME], { env: { ...BASE_ENV, ...(o.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    p.stdout.setEncoding('utf8').on('data', (d) => { out += d })
    p.stderr.setEncoding('utf8').on('data', (d) => { err += d })
    const lines = o.stdinLines ?? []
    if (lines.length) {
      let i = 0
      const feed = () => {
        if (i < lines.length) { p.stdin.write(lines[i++] + '\n'); setTimeout(feed, 700) }
        else p.stdin.end()
      }
      feed()
    } else p.stdin.end()
    const timer = setTimeout(() => { try { p.kill() } catch { /* already gone */ } }, o.timeoutMs ?? 180_000)
    p.on('close', (code) => { clearTimeout(timer); res({ code, out, err, ms: Math.round(performance.now() - t0) }) })
  })
}

let PORT = 0
let SERVICE_TOKEN = ''
let SESSION_TOKEN = ''
const base = () => `http://127.0.0.1:${PORT}`

/** 打 /api/op/<name>；失败抛带 Problem 名的错（调用方决定是失败还是重试）。 */
async function op(name, params, token, extraHeaders = {}) {
  const r = await fetch(`${base()}/api/op/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ params }),
    signal: AbortSignal.timeout(60_000),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j || j.ok !== true) throw new Error(`${name}: HTTP ${r.status} ${j?.error?.name ?? ''} ${j?.error?.message ?? ''}`.trim())
  return j.result
}

async function postJson(path, body) {
  const r = await fetch(`${base()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, timeoutMs = 30_000, intervalMs = 250) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await fn(); if (v) return v } catch { /* 还没好 */ }
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(intervalMs)
  }
}

/** 固定盘口的合成 1m K 线（写成文件喂给引擎的 data.source=files；不是任何真实行情）。 */
function synthCandles(n = 600, stepMs = 60_000) {
  const out = []
  let px = 80_000
  const start = Math.floor(Date.now() / stepMs) * stepMs - n * stepMs
  for (let i = 0; i < n; i++) {
    const t = start + i * stepMs
    const o = px
    const c = Math.max(1, Math.round(px + Math.sin(i / 17) * 140 + (i % 29 === 0 ? 80 : 0)))
    out.push({ t, T: t + stepMs - 1, o, h: Math.max(o, c) + 25, l: Math.min(o, c) - 25, c, v: 1 })
    px = c
  }
  return out
}

const BANNER = "import { createRequire as __smokeRequire } from 'node:module'; const require = __smokeRequire(import.meta.url);"

async function bundle(entry, outfile) {
  await build({ absWorkingDir: ROOT, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, banner: { js: BANNER }, external: ['node:*'], logLevel: 'error' })
  return outfile
}

// ─────────────────────────────────────────────────────────── 步骤

/** ① 环境 + init（先 --no-pin 证明无 PIN 也能建目录，再用 GITRADER_PIN_STDIN 非交互设 PIN，纸面下单要它）。 */
async function stepInit() {
  const t0 = performance.now()
  const a = await runCli(['init', '--no-pin'])
  if (a.code !== 0) return record('init --no-pin', false, t0, `${a.err || a.out}`)
  if (!existsSync(join(HOME, 'gitrader.json'))) return record('init --no-pin', false, t0, 'gitrader.json missing')
  const pinBefore = existsSync(join(HOME, 'keys', 'pin.json'))
  const b = await runCli(['init'], { stdinLines: [PIN, PIN], env: { GITRADER_PIN_STDIN: '1' } })
  const pinAfter = existsSync(join(HOME, 'keys', 'pin.json'))
  const ok = b.code === 0 && pinAfter && !pinBefore
  return record('init（--no-pin + GITRADER_PIN_STDIN 设 PIN）', ok, t0, `exit ${a.code}/${b.code} pin: ${pinBefore ? 'set' : 'unset'}→${pinAfter ? 'set' : 'unset'} ${ok ? '' : b.err}`)
}

/** ② 起 serve（runServe 同路径 + 进程内盘口），轮询 /api/ready 到 200。 */
async function stepServe(hostBundle) {
  const t0 = performance.now()
  mkdirSync(join(HOME, 'engines', 'gitrader-core', 'strategies'), { recursive: true })
  copyFileSync(EXAMPLE_STRATEGY, join(HOME, 'engines', 'gitrader-core', 'strategies', 'ema-cross.ts'))
  PORT = await pickFreePort()
  const child = spawn(process.execPath, [hostBundle, HOME, String(PORT)], { env: BASE_ENV, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  children.push({ pid: child.pid, what: 'smoke host', child })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
  const readyLine = await until(async () => {
    const line = stdout.split('\n').find((l) => l.includes('"ready":true'))
    return line ? JSON.parse(line) : null
  }, 60_000, 100)
  if (!readyLine) return record('serve + /api/ready', false, t0, `no ready line in 60 s: ${tail(stderr, 300)}`)
  PORT = readyLine.port
  const service = JSON.parse(readFileSync(join(HOME, 'service.json'), 'utf8'))
  SERVICE_TOKEN = service.token
  const ready = await waitForReady(`${base()}/api/ready`, { token: service.token, timeoutMs: 60_000 })
  const ok = ready.ok && ready.lastStatus === 200
  return record('serve + /api/ready', ok, t0, ok ? `pid ${readyLine.pid} port ${PORT} attempts ${ready.attempts}` : `last HTTP ${ready.lastStatus} after ${ready.attempts} attempts ${tail(stderr, 200)}`)
}

/** ③ status（CLI 走 service.json 令牌，不需要 PIN）。 */
async function stepStatus() {
  const t0 = performance.now()
  const r = await runCli(['status', '--json'])
  let st = null
  try { st = JSON.parse(r.out) } catch { /* 下面报错 */ }
  const ok = r.code === 0 && st?.running === true && Array.isArray(st.accounts) && st.accounts.some((a) => a.mode === 'paper')
  return record('status（CLI --json）', ok, t0, ok ? `trading ${st.tradingState}, ledger ${st.ledger?.count} entries, accounts ${st.accounts.length}` : `${r.err || r.out}`)
}

/** ④ 纸面下一单：PIN 换工作台会话令牌 → 账户 / 报价 → 限价买入 → 等成交。 */
async function stepPaperOrder() {
  const t0 = performance.now()
  const open = await runCli(['open', '--print', '--json'], { stdinLines: [PIN] })
  const launch = JSON.parse(open.out)?.url
  if (!launch) return record('纸面下单', false, t0, `open --print: ${open.err || open.out}`)
  const sess = await postJson('/api/session', { bootstrap: new URL(launch).searchParams.get('launch') })
  const token = sess.json?.sessionToken
  SESSION_TOKEN = token ?? ''
  if (!token) return record('纸面下单', false, t0, `session exchange HTTP ${sess.status} ${JSON.stringify(sess.json)}`)
  const accounts = await op('account.list', {}, token)
  const paper = accounts.find((a) => a.mode === 'paper')
  if (!paper) return record('纸面下单', false, t0, 'no paper account')
  const mark = await op('market.quote', { instrumentId: BTC }, token)
  const px = Number(mark?.price)
  if (!Number.isFinite(px) || px <= 0) return record('纸面下单', false, t0, `no mark for ${BTC}: ${JSON.stringify(mark)}`)
  const price = String(Math.ceil(px * 1.02))
  const placedRaw = await op('order.place', { intent: { accountId: paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', tif: 'gtc', size: '0.01', price, reason: 'smoke journey paper order' } }, token)
  const placed = placedRaw?.order ?? placedRaw
  vlog(`order.place → ${JSON.stringify(placedRaw).slice(0, 200)}`)
  const filled = await until(async () => {
    const orders = await op('account.orders', { accountId: paper.accountId, limit: 20 }, token)
    return orders.find((o) => o.clientOrderId === placed?.clientOrderId && (o.status === 'filled' || Number(o.filledSize) > 0)) ?? null
  }, 20_000, 500)
  const ok = Boolean(placed?.orderId) && Boolean(filled)
  return record('纸面下单（limit 买入 + 等成交）', ok, t0, ok ? `${paper.alias} ${BTC} 0.01 @ ${price} → ${filled.status}` : `placed ${JSON.stringify(placed).slice(0, 120)} filled=${Boolean(filled)}`)
}

/** ⑤ 示例策略回测：Agent 钥匙 → 合成 K 线文件 → agent.backtest run/result。 */
async function stepBacktest(outFile) {
  const t0 = performance.now()
  // 非终端的 keys new agent 走「接入请求 → 人输 PIN 批准」流（ADR-13）：脚本当人类模拟器，用会话令牌找到请求并带 PIN 批准。
  const keyP = runCli(['keys', 'new', 'agent', 'smoke', '--host', 'hermes', '--tier', 'paper'])
  let approved = null
  let keyDone = false
  keyP.then(() => { keyDone = true })
  const approveBy = Date.now() + 60_000
  while (!approved && !keyDone && Date.now() < approveBy) {
    const list = await op('agentkey.request.list', {}, SESSION_TOKEN).catch(() => ({ requests: [] }))
    const req = (list.requests ?? []).find((q) => q.state === 'pending' && (q.input?.name === 'smoke' || q.name === 'smoke'))
    if (req) approved = await op('agentkey.request.approve', { requestId: req.requestId }, SESSION_TOKEN, { 'x-gitrader-pin': PIN }).catch((e) => { vlog(String(e)); return null })
    else await sleep(400)
  }
  const key = await keyP
  const tokenFile = join(HOME, 'agent-tokens', 'smoke.token')
  const agentToken = key.code === 0 && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : ''
  if (!agentToken) return record('回测（agent.backtest）', false, t0, `agent key: approved=${Boolean(approved)} exit ${key.code} ${key.err || key.out}`)
  const engineReady = await until(async () => {
    const list = await op('engine.list', {}, SERVICE_TOKEN)
    return list.find((e) => e.id === 'gitrader-core' && (e.state === 'ready' || e.gep?.state === 'ready')) ?? null
  }, 30_000, 250)
  if (!engineReady) return record('回测（agent.backtest）', false, t0, 'engine gitrader-core not ready in 30 s')
  const strategies = await op('engine.call', { id: 'gitrader-core', method: 'strategy.list', params: {} }, SESSION_TOKEN).catch((e) => { vlog(String(e)); return null })
  const strategy = (strategies?.strategies ?? []).find((s) => s.id === 'ema-cross')
  if (!strategy) return record('回测（agent.backtest）', false, t0, `ema-cross not loaded: ${JSON.stringify(strategies).slice(0, 200)}`)
  const candles = synthCandles()
  const file = join(OUT, 'candles-btc-1m.json')
  writeFileSync(file, JSON.stringify(candles))
  const sha256 = 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex')
  const spec = {
    subject: { strategy: { id: strategy.id, version: strategy.version, params: {} } },
    instruments: [BTC], interval: '1m', from: candles[0].t, to: candles[candles.length - 1].t,
    data: { source: 'files', files: [{ path: file, sha256, format: 'json' }] },
    account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
    assumptions: { fees: 'venue', slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
    seed: 1,
  }
  const unwrap = (r) => r?.data ?? r
  const started = unwrap(await op('agent.backtest', { action: 'run', spec }, agentToken))
  const jobId = started?.jobId
  if (!jobId) return record('回测（agent.backtest）', false, t0, `no jobId: ${JSON.stringify(started).slice(0, 200)}`)
  const result = await until(async () => {
    const r = unwrap(await op('agent.backtest', { action: 'result', jobId }, agentToken))
    return r?.stats ? r : null
  }, 60_000, 400)
  if (!result) return record('回测（agent.backtest）', false, t0, `job ${jobId} produced no stats in 60 s`)
  writeFileSync(outFile, JSON.stringify({ ...result, candlesFile: 'candles-btc-1m.json' }, null, 2))
  return record('回测（agent.backtest，示例策略 ema-cross）', true, t0, `job ${jobId}: ${result.stats.trades} trades, ${result.equity?.length} equity points`)
}

/** ⑥ 回测结果 → packages/report 导出 Markdown（+ HTML）。 */
async function stepReport(backtestFile, reportBundle) {
  const t0 = performance.now()
  const md = join(OUT, 'report.md')
  const html = join(OUT, 'report.html')
  const r = await new Promise((res) => {
    const p = spawn(process.execPath, [reportBundle, backtestFile, '--md', md, '--html', html, '--title', 'Gitrader paper smoke'], { env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    p.stdout.setEncoding('utf8').on('data', (d) => { out += d })
    p.stderr.setEncoding('utf8').on('data', (d) => { err += d })
    const timer = setTimeout(() => { try { p.kill() } catch { /* gone */ } }, 120_000)
    p.on('close', (code) => { clearTimeout(timer); res({ code, out, err }) })
  })
  const ok = r.code === 0 && existsSync(md) && existsSync(html) && readFileSync(md, 'utf8').includes('本报告为历史数据回测结果')
  return record('报告导出（report --md/--html）', ok, t0, ok ? `${md} ${readFileSync(md, 'utf8').length} B, html ${readFileSync(html, 'utf8').length} B` : `exit ${r.code} ${r.err}`)
}

/** ⑦ 账本：verify 通过 + 有下单 / 成交 / 回测条目。 */
async function stepLedger() {
  const t0 = performance.now()
  const v = await runCli(['ledger', 'verify', '--json'])
  let verify = null
  try { verify = JSON.parse(v.out) } catch { /* 下面报错 */ }
  const service = JSON.parse(readFileSync(join(HOME, 'service.json'), 'utf8'))
  const entries = await op('ledger.query', { limit: 200 }, service.token)
  const types = new Set(entries.map((e) => e.type))
  const need = ['order.intent', 'fill', 'backtest.completed']
  const missing = need.filter((t) => !types.has(t))
  const ok = v.code === 0 && verify?.ok === true && verify.count > 0 && missing.length === 0
  return record('账本（verify + 条目）', ok, t0, ok ? `${verify.count} entries, seq 0..${verify.lastSeq}, types ${need.join('/')}` : `exit ${v.code} ok=${verify?.ok} count=${verify?.count} missing=${missing.join(',')} ${v.err}`)
}

// ─────────────────────────────────────────────────────────── 主流程

let exitCode = 0
let reportPath = ''
try {
  if (!existsSync(CLI)) throw new Error(`missing ${CLI} — run \`npm run build -w gitrader\` at the repo root first`)
  if (!existsSync(ENGINE)) throw new Error(`missing ${ENGINE} — run \`npm run build -w @gitrader/engine-core\` at the repo root first`)
  say(`Gitrader smoke · home ${HOME}`)
  const hostBundle = await bundle(join(HERE, 'lib', 'host.ts'), join(tmp, 'smoke-host.mjs'))
  const reportBundle = await bundle(join(HERE, 'lib', 'report-entry.ts'), join(tmp, 'report-cli.mjs'))

  const okSteps = []
  okSteps.push(await stepInit())
  okSteps.push(await stepServe(hostBundle))
  if (rows.at(-1)?.result === 'ok') {
    okSteps.push(await stepStatus())
    okSteps.push(await stepPaperOrder())
    const backtestFile = join(OUT, 'backtest.json')
    if (await stepBacktest(backtestFile)) okSteps.push(await stepReport(backtestFile, reportBundle))
    else { rows.push({ step: '报告导出（report --md/--html）', ms: '-', result: 'skipped', detail: 'no backtest result' }) }
    okSteps.push(await stepLedger())
  } else {
    say('serve 没起来：后续步骤不再执行（失败原因见上）。')
  }
  exitCode = rows.every((r) => r.result === 'ok' || r.result === 'skipped') && rows.length >= 7 ? 0 : 1
  reportPath = join(OUT, 'report.md')
} catch (e) {
  say(`FATAL ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  rows.push({ step: 'journey', ms: '-', result: 'FAIL', detail: tail(e instanceof Error ? e.message : String(e), 220) })
  exitCode = 1
} finally {
  // 只结束自己记录过的 PID：先请它自己停，8 s 不退再按 PID 杀。
  for (const c of children) {
    if (!c.child || c.child.exitCode !== null) continue
    try { c.child.stdin.write('stop\n') } catch { /* stdin 可能已关 */ }
  }
  await sleep(300)
  for (const c of children) {
    if (!c.child || c.child.exitCode !== null) continue
    await until(async () => c.child.exitCode !== null, 8_000, 100)
    if (c.child.exitCode !== null) continue
    for (const pid of killTargets([{ pid: c.pid }])) { try { process.kill(pid) } catch { /* 已经没了 */ } }
    await until(async () => c.child.exitCode !== null, 5_000, 100)
  }
  say('')
  say(formatTable(rows))
  if (keep) say(`\n--keep: 临时目录保留在 ${tmp}（home / out / 子进程日志都在里面）`)
  else rmSync(tmp, { recursive: true, force: true })
  say(exitCode === 0 ? '\nJOURNEY OK（7/7 步）' : '\nJOURNEY FAILED（见上表）')
  if (exitCode === 0 && keep) say(`report: ${reportPath}`)
}
process.exitCode = exitCode
