// SPDX-License-Identifier: CPAL-1.0
// S1 · 下单途中按毫秒扫杀内核。用法：
//   node scripts/verify/chaos-kill-sweep.mjs --from 0 --to 140 --step 4 [--port 46520] [--skip-approve] [--approve-from 0 --approve-to 49 --approve-step 7]
// 直下路径：preview → 经真实 gitrader-mcp（stdio）place，place 发出后 d 毫秒按记录的 PID 杀内核，重启后逐项核对。
// 批准路径：confirm 档钥匙提案 → 会话 proposal.approve，批准发出后 d 毫秒杀，重启后 proposal.list 不许留 approved / executing。
// 每轮判据见 judge()。某一轮不过就换新 home 继续（不让坏状态污染后面的轮次），失败证据（paper-state.json）存到 reports/fix-r2/chaos/evidence/。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  OUT_DIR, agentApi, cli, createRunner, initHome, isoNow, killKernel, mcpConnect, newAgentKey, newHome, openSession, parseFlags, randomPin,
  removeHome, reapKernel, resumeTrading, rowsOf, setPinOnce, sleep, snapshot, standardIntent, startKernel, stopKernel, verifyKernelPid, waitMarketReady, alive, now,
} from './chaos-lib.mjs'

const flags = parseFlags()
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]))
const FROM = num('from', 0)
const TO = num('to', 140)
const STEP = num('step', 4)
const PORT = num('port', 46520)
const A_FROM = num('approve-from', 0)
const A_TO = num('approve-to', 49)
const A_STEP = num('approve-step', 7)
const DEAD = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'expired', 'failed', 'triggered'])

const TAG = typeof flags.tag === 'string' ? flags.tag : ''
const runner = createRunner(`S1-kill-sweep${TAG ? `-${TAG}` : ''}`, { from: FROM, to: TO, step: STEP, port: PORT, approve: [A_FROM, A_TO, A_STEP], skipApprove: !!flags['skip-approve'], startedBy: 'chaos-kill-sweep.mjs' })

async function startWithRetry(home, port) {
  let last
  for (let i = 0; i < 8; i++) {
    last = await startKernel(home, port)
    if (last.ok) return last
    await sleep(1500)
  }
  throw new Error(`内核起不来：${JSON.stringify(last).slice(0, 400)}`)
}

/** 新场景：新 home + 内核 + PIN + 两把钥匙（paper 直下、confirm 提案）。 */
async function bootstrap(tag) {
  const home = newHome(tag)
  const pin = randomPin()
  initHome(home)
  let k = await startWithRetry(home, PORT)
  let session = await openSession(k, () => pin, k.launch)
  await setPinOnce(session)
  const paperKey = await newAgentKey(k, session, 'sweep-paper', { tier: 'paper' })
  const confirmKey = await newAgentKey(k, session, 'sweep-confirm', { tier: 'confirm' })
  return { home, pin, k, session, paperKey, confirmKey, agent: agentApi(k, paperKey.token), cagent: agentApi(k, confirmKey.token), accountId: null }
}

async function restart(ctx) {
  const killed = ctx.killedPid
  if (killed) await reapKernel({ pid: killed }, ctx.killedKids ?? [])
  ctx.k = await startWithRetry(ctx.home, PORT)
  ctx.session = await openSession(ctx.k, () => ctx.pin, ctx.k.launch)
  ctx.agent = agentApi(ctx.k, ctx.paperKey.token)
  ctx.cagent = agentApi(ctx.k, ctx.confirmKey.token)
}

async function allRows(agent, view, accountId) {
  const rows = []
  let cursor
  for (let i = 0; i < 20; i++) {
    const r = await agent.call('account', { action: view, accountId, limit: 200, ...(cursor ? { cursor } : {}) })
    if (!r.ok) return { error: r.error ?? r.netError, rows }
    rows.push(...rowsOf(r.data))
    cursor = r.data?.next
    if (!cursor) break
  }
  return { rows }
}

/** 重启后等启动对账结束（最多 30 s）。 */
async function settle(ctx) {
  const deadline = now() + 30_000
  let st
  while (now() < deadline) {
    st = await ctx.session.op('status').catch(() => null)
    if (st && (st.reconciliation ?? []).every((r) => r.state !== 'running' && r.state !== 'pending')) break
    await sleep(300)
  }
  await waitMarketReady(ctx.session)
  await sleep(800)
  return st
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/** 核对：返回 { checks:{名:{ok,detail}}, ok }。 */
async function judge(ctx, { cloid, agentOutcome, proposalId }) {
  const checks = {}
  // 重启后允许最多 30 s 内自行恢复 ACTIVE：轮询 status，不只取一次快照
  let recoveredAfterMs = null
  const t0 = now()
  while (now() - t0 < 30_000) {
    const st0 = await ctx.session.op('status').catch(() => null)
    if (st0?.tradingState === 'ACTIVE') { recoveredAfterMs = now() - t0; break }
    await sleep(1000)
  }
  const snap = await snapshot(ctx.k, ctx.session, null, null)
  const [orders, fills, positions] = await Promise.all([allRows(ctx.agent, 'orders', ctx.accountId), allRows(ctx.agent, 'fills', ctx.accountId), allRows(ctx.agent, 'positions', ctx.accountId)])
  const st = snap.status ?? {}
  checks.notHalted = { ok: st.tradingState === 'ACTIVE', detail: { settledAfterMs: recoveredAfterMs, tradingState: st.tradingState, stateReasons: st.stateReasons, paperState: st.paperState } }
  const submitted = orders.rows.filter((o) => o.status === 'submitted')
  checks.noSubmittedOrphans = { ok: !orders.error && submitted.length === 0, detail: { submitted: submitted.map((o) => ({ orderId: o.orderId, clientOrderId: o.clientOrderId, tpslRole: o.tpslRole ?? null })), error: orders.error ?? null } }
  const longSize = sum(positions.rows.filter((p) => p.side === 'long').map((p) => Number(p.size))) - sum(positions.rows.filter((p) => p.side === 'short').map((p) => Number(p.size)))
  const stops = orders.rows.filter((o) => o.tpslRole === 'sl' && o.reduceOnly === true && !DEAD.has(o.status))
  const stopSize = sum(stops.map((o) => Number(o.size) - Number(o.filledSize ?? 0)))
  const hasPos = Math.abs(longSize) > 1e-12
  checks.positionHasLiveReduceOnlyStop = { ok: !positions.error && (!hasPos || stopSize + 1e-9 >= Math.abs(longSize)), detail: { positionNet: longSize, liveStopSize: stopSize, liveStops: stops.length } }
  const ledgerOk = (st.ledgerVerify?.ok !== false) && snap.ledgerVerifyCli?.code === 0 && /"ok":true/.test(snap.ledgerVerifyCli?.out ?? '')
  checks.ledgerVerifyOk = { ok: ledgerOk, detail: { status: st.ledgerVerify, cli: snap.ledgerVerifyCli } }
  const sameCloid = cloid ? fills.rows.filter((f) => f.clientOrderId === cloid) : []
  const venueIds = fills.rows.map((f) => f.venueFillId)
  checks.noDuplicateFill = { ok: !fills.error && sameCloid.length <= 1 && new Set(venueIds).size === venueIds.length, detail: { fillsForClientOrderId: sameCloid.length, totalFills: fills.rows.length, uniqueVenueFillIds: new Set(venueIds).size } }
  // 订单与成交一致：已成交的父单必须有成交行，且仓位 = 成交净量
  const filledParents = orders.rows.filter((o) => !o.parentOrderId && o.status === 'filled' && o.side === 'buy')
  const fillNet = sum(fills.rows.map((f) => (f.side === 'buy' ? 1 : -1) * Number(f.size)))
  checks.positionMatchesFills = { ok: !fills.error && Math.abs(fillNet - longSize) < 1e-9, detail: { fillNet, positionNet: longSize, filledParentOrders: filledParents.length } }
  if (agentOutcome) checks.agentOutcome = { ok: agentOutcome.ok, detail: agentOutcome.detail }
  if (proposalId !== undefined) {
    const pl = await ctx.session.op('proposal.list', { limit: 200 }).catch((e) => ({ error: e.message }))
    const list = Array.isArray(pl) ? pl : []
    const stuck = list.filter((p) => p.status === 'approved' || p.status === 'executing')
    checks.noStuckProposals = { ok: !pl.error && stuck.length === 0, detail: { stuck: stuck.map((p) => ({ proposalId: p.proposalId, status: p.status })), statuses: Object.fromEntries(list.map((p) => [p.proposalId, p.status])), error: pl.error ?? null } }
  }
  const ok = Object.values(checks).every((c) => c.ok)
  return { ok, checks, snapshot: { tradingState: st.tradingState, paperState: st.paperState, doctor: snap.doctor?.summary, doctorBlocks: snap.doctor?.blocks }, counts: { orders: orders.rows.length, fills: fills.rows.length, positions: positions.rows.length, orderStatuses: orders.rows.reduce((m, o) => { const key = `${o.tpslRole ?? 'parent'}:${o.status}`; m[key] = (m[key] ?? 0) + 1; return m }, {}) } }
}

/** MCP 回给 Agent 的结果分类。 */
function classifyMcp(r) {
  if (r.timeout) return { ok: false, detail: { kind: 'mcp-timeout' } }
  const res = r.res ?? {}
  const err = res.error ?? (r.isError ? res : null)
  if (!r.isError && (res.data?.order || res.order || res.status === 'filled' || res.orderId)) return { ok: true, detail: { kind: 'success' } }
  if (!err) return { ok: false, detail: { kind: 'unrecognised', res: JSON.stringify(res).slice(0, 400) } }
  const name = err.name ?? err.error?.name
  const code = err.code
  const ids = err.clientOrderIds ?? err.data?.clientOrderIds
  if (code === 3006 || name === 'VENUE_OUTCOME_UNKNOWN') {
    return { ok: Array.isArray(ids) && ids.length > 0, detail: { kind: 'VENUE_OUTCOME_UNKNOWN', code, retryable: err.retryable ?? null, clientOrderIds: ids ?? null, message: String(err.message ?? '').slice(0, 300) } }
  }
  if (name === 'INTERNAL' && err.retryable === true) return { ok: false, detail: { kind: 'INTERNAL-retryable(违规)', code, message: String(err.message ?? '').slice(0, 300) } }
  return { ok: false, detail: { kind: 'other-error', name, code, retryable: err.retryable ?? null, message: String(err.message ?? '').slice(0, 300) } }
}

/** 失败轮的真实影响：照 doctor 的下一步（停服务 → paper rebuild-from-ledger → 重启 → PIN 恢复）走一遍，看终态是否一致。 */
async function tryRecovery(ctx) {
  const out = {}
  try {
    await stopKernel(ctx.k)
    const r = cli(ctx.home, ['paper', 'rebuild-from-ledger', '--yes'], { timeoutMs: 120_000 })
    out.rebuild = { code: r.code, out: r.out.slice(0, 600), err: r.err.slice(0, 300) }
    ctx.killedPid = null
    ctx.k = await startWithRetry(ctx.home, PORT)
    ctx.session = await openSession(ctx.k, () => ctx.pin, ctx.k.launch)
    ctx.agent = agentApi(ctx.k, ctx.paperKey.token)
    await settle(ctx)
    out.resume = await resumeTrading(ctx.session)
    const j = await judge(ctx, {})
    out.after = { ok: j.ok, failed: Object.entries(j.checks).filter(([, c]) => !c.ok).map(([n, c]) => ({ n, detail: c.detail })), counts: j.counts }
  } catch (e) { out.error = String(e.stack ?? e).slice(0, 500) }
  return out
}

function keepEvidence(ctx, label) {
  try {
    const dir = join(OUT_DIR, 'evidence')
    mkdirSync(dir, { recursive: true })
    const src = join(ctx.home, 'paper-state.json')
    if (existsSync(src)) copyFileSync(src, join(dir, `${label}-paper-state.json`))
  } catch { /* 证据拷不了就算了 */ }
}

async function directRound(ctx, d, idx) {
  const rec = { path: 'direct', index: idx, delayMs: d, startedAt: isoNow() }
  if (!verifyKernelPid(ctx.k.pid, ctx.k.port)) throw new Error(`命令行核对不符，拒绝继续：${ctx.k.pid}`)
  const si = await standardIntent(ctx.agent)
  ctx.accountId = si.accountId
  // 预览与下单走同一个 MCP 进程：MCP 靠预览缓存把 confirmToken 对回 clientOrderId（真实 Agent 就是这么用的）
  const mcp = mcpConnect(ctx.home, ctx.paperKey.tokenFile)
  await mcp.init()
  let pv, pvd
  const TRANSIENT = /COOLDOWN|STALE_PRICE|ACCOUNT_UNKNOWN|INSTRUMENT_UNKNOWN|VENUE_UNAVAILABLE/
  for (let attempt = 0; attempt < 20; attempt++) { // 冷却窗口、重启后目录 / 行情 / 账户还没就绪：等一等再试，不算故障
    pv = await mcp.call('order', { action: 'preview', intent: si.intent })
    pvd = pv.res?.data ?? pv.res
    if (pvd?.confirmToken) break
    const why = JSON.stringify(pv.res?.error ?? pvd?.precheck?.ruleHits ?? [])
    if (!TRANSIENT.test(why)) break
    await sleep(2000)
  }
  if (pv.isError || !pvd?.confirmToken) throw new Error(`preview 失败：verdict=${pvd?.precheck?.verdict} ruleHits=${JSON.stringify((pvd?.precheck?.ruleHits ?? []).map((h) => h.code))} error=${JSON.stringify(pv.res?.error ?? null).slice(0, 300)}`)
  rec.clientOrderId = pvd.normalizedIntent?.clientOrderId
  rec.previewEchoedClientOrderId = pv.res?.clientOrderId ?? pvd.clientOrderId ?? null
  const t0 = performance.now()
  const placed = mcp.call('order', { action: 'place', confirmToken: pvd.confirmToken }, { timeoutMs: 100_000 })
  let killedAtMs = null
  const timer = setTimeout(() => { const kr = killKernel(ctx.k, { verify: false }); killedAtMs = Math.round(performance.now() - t0); rec.kill = { ...kr, kids: undefined } }, d)
  const r = await placed
  clearTimeout(timer)
  rec.killedAtMs = killedAtMs
  rec.mcpMs = r.ms
  rec.mcpResult = JSON.stringify(r.res ?? r).slice(0, 900)
  mcp.close()
  ctx.killedPid = ctx.k.pid
  ctx.killedKids = ctx.k.children
  if (killedAtMs === null) { rec.note = '内核在 d 毫秒内没被杀（place 已先返回）'; killKernel(ctx.k, { verify: true }) }
  const outcome = classifyMcp(r)
  await restart(ctx)
  await settle(ctx)
  rec.judge = await judge(ctx, { cloid: rec.clientOrderId, agentOutcome: outcome })
  rec.ok = rec.judge.ok
  return rec
}

async function approveRound(ctx, d, idx) {
  const rec = { path: 'approve', index: idx, delayMs: d, startedAt: isoNow() }
  if (!verifyKernelPid(ctx.k.pid, ctx.k.port)) throw new Error(`命令行核对不符，拒绝继续：${ctx.k.pid}`)
  const si = await standardIntent(ctx.cagent)
  ctx.accountId = si.accountId
  let pr
  for (let attempt = 0; attempt < 20; attempt++) {
    pr = await ctx.cagent.call('propose', { action: 'order', intents: [si.intent], reason: 'chaos approve sweep' })
    if (pr.ok || !/COOLDOWN|STALE_PRICE|ACCOUNT_UNKNOWN|INSTRUMENT_UNKNOWN|VENUE_UNAVAILABLE/.test(JSON.stringify(pr.error ?? ''))) break
    await sleep(2000)
  }
  if (!pr.ok) throw new Error(`propose 失败：${JSON.stringify(pr.error ?? pr.netError)}`)
  rec.proposalId = pr.data.proposalId
  rec.clientOrderId = pr.data.intents?.[0]?.clientOrderId
  const t0 = performance.now()
  const approving = ctx.session.raw('proposal.approve', { id: rec.proposalId }, { timeoutMs: 20_000 })
  let killedAtMs = null
  const timer = setTimeout(() => { const kr = killKernel(ctx.k, { verify: false }); killedAtMs = Math.round(performance.now() - t0); rec.kill = { ...kr, kids: undefined } }, d)
  const r = await approving
  clearTimeout(timer)
  rec.killedAtMs = killedAtMs
  rec.approveReply = { status: r.status, netError: r.netError ?? null, resultStatus: r.json?.result?.status ?? null, error: r.json?.error ? { name: r.json.error.name, code: r.json.error.code } : null }
  ctx.killedPid = ctx.k.pid
  ctx.killedKids = ctx.k.children
  if (killedAtMs === null) { rec.note = '内核在 d 毫秒内没被杀（批准已先返回）'; killKernel(ctx.k, { verify: true }) }
  await restart(ctx)
  await settle(ctx)
  rec.judge = await judge(ctx, { cloid: rec.clientOrderId, proposalId: rec.proposalId })
  rec.ok = rec.judge.ok
  return rec
}

async function main() {
  let ctx = await bootstrap('s1')
  runner.note(`起内核 pid=${ctx.k.pid} 端口 ${PORT}，home=<临时>`)
  const jobs = []
  for (let d = FROM; d <= TO; d += STEP) jobs.push(['direct', d])
  if (!flags['skip-approve']) for (let d = A_FROM; d <= A_TO; d += A_STEP) jobs.push(['approve', d])
  let idx = 0
  let failures = 0
  for (const [path, d] of jobs) {
    idx++
    let rec
    try {
      rec = path === 'direct' ? await directRound(ctx, d, idx) : await approveRound(ctx, d, idx)
    } catch (e) {
      rec = { path, index: idx, delayMs: d, ok: false, harnessError: String(e.stack ?? e).slice(0, 800) }
    }
    runner.round(rec)
    const failed = Object.entries(rec.judge?.checks ?? {}).filter(([, c]) => !c.ok).map(([n]) => n)
    runner.note(`#${idx} ${path} d=${d}ms 杀于 ${rec.killedAtMs ?? '-'}ms ${rec.ok ? '通过' : `未过：${rec.harnessError ? 'harness' : failed.join(',')}`}`)
    if (!rec.ok) {
      failures++
      keepEvidence(ctx, `S1${TAG ? `-${TAG}` : ''}-r${idx}`)
      if (rec.judge) rec.recovery = await tryRecovery(ctx)
      // 坏状态不污染后面：换新 home
      try { await stopKernel(ctx.k) } catch { /* 已退出 */ }
      removeHome(ctx.home)
      ctx = await bootstrap('s1')
    }
  }
  const total = jobs.length
  const summary = { rounds: total, passed: total - failures, failed: failures, directRounds: jobs.filter((j) => j[0] === 'direct').length, approveRounds: jobs.filter((j) => j[0] === 'approve').length }
  await stopKernel(ctx.k)
  const left = alive(ctx.k.pid)
  removeHome(ctx.home)
  summary.kernelLeftAlive = left
  return runner.finish(summary)
}

main().then(() => process.exit(0), (e) => { console.error(e); runner.finish({ fatal: String(e.stack ?? e) }); process.exit(1) })
