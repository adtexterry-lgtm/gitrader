// SPDX-License-Identifier: CPAL-1.0
// S2 · 三把 paper 档 Agent 钥匙并发下单。用法：
//   node scripts/verify/chaos-concurrency.mjs [--port 46530] [--first 30] [--waves 5] [--wave-size 12]
// 第 0 波：三把钥匙各 first 单同时（Promise.all）preview→place，全部同向（买）。
// 之后 waves 波：三把钥匙各 wave-size 单，方向随机混合（买 / 卖），每波一起发。
// 判据：没有重复成交（venueFillId 唯一、同 clientOrderId 成交 ≤ 1）、账本 seq 从 0 起无洞、`ledger verify` OK、各钥匙状态 active 且仍能调用、
// 仓位 = 成交净量、有仓必有活着的只减仓止损单（记录，不计入硬判据，因为卖单与买单止损会互相抵消）。
import {
  agentApi, allRows, cli, countBy, createRunner, initHome, isoNow, ledgerGaps, newAgentKey, newHome, openSession, parseFlags, randomPin,
  readLedger, removeHome, setPinOnce, sleep, snapshot, standardIntent, startKernel, stopKernel, alive,
} from './chaos-lib.mjs'

const flags = parseFlags()
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]))
const PORT = num('port', 46530)
const FIRST = num('first', 30)
const WAVES = num('waves', 5)
const WAVE_SIZE = num('wave-size', 12)
const DEAD = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'expired', 'failed', 'triggered'])
const runner = createRunner('S2-concurrency', { port: PORT, first: FIRST, waves: WAVES, waveSize: WAVE_SIZE })
const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/** 一单：preview → place。永不抛，返回分类结果。 */
async function oneOrder(agent, intent, tag) {
  const t0 = performance.now()
  const pv = await agent.call('order', { action: 'preview', intent: { ...intent, reason: `s2 ${tag}` } })
  if (pv.ok && !pv.data?.confirmToken) return { tag, stage: 'preview', outcome: `denied:${(pv.data?.precheck?.ruleHits ?? []).map((h) => h.code).join('+') || 'unknown'}`, ms: Math.round(performance.now() - t0) }
  if (!pv.ok) return { tag, stage: 'preview', outcome: pv.error?.name ?? pv.netError ?? `http${pv.status}`, code: pv.error?.code ?? null, ms: Math.round(performance.now() - t0) }
  const pl = await agent.call('order', { action: 'place', confirmToken: pv.data.confirmToken })
  const ms = Math.round(performance.now() - t0)
  if (!pl.ok) return { tag, stage: 'place', outcome: pl.error?.name ?? pl.netError ?? `http${pl.status}`, code: pl.error?.code ?? null, clientOrderId: pv.data.normalizedIntent.clientOrderId, ms }
  return { tag, stage: 'done', outcome: pl.data?.order?.status ?? 'unknown', clientOrderId: pv.data.normalizedIntent.clientOrderId, ms }
}

async function integrity(ctx, label) {
  const checks = {}
  const snap = await snapshot(ctx.k, ctx.session, null, null)
  const { rows: fills, error: fe } = await allRows(ctx.keys[0].agent, 'fills', ctx.accountId)
  const { rows: orders } = await allRows(ctx.keys[0].agent, 'orders', ctx.accountId)
  const { rows: positions } = await allRows(ctx.keys[0].agent, 'positions', ctx.accountId)
  const venueIds = fills.map((f) => f.venueFillId)
  const dupVenue = venueIds.length - new Set(venueIds).size
  const byCloid = countBy(fills, (f) => f.clientOrderId)
  const multi = Object.entries(byCloid).filter(([, n]) => n > 1)
  checks.noDuplicateFills = { ok: !fe && dupVenue === 0 && multi.length === 0, detail: { fills: fills.length, duplicateVenueFillIds: dupVenue, clientOrderIdsWithMultipleFills: multi.length } }
  const entries = await readLedger(ctx.home)
  const gaps = ledgerGaps(entries)
  checks.ledgerSeqNoGaps = { ok: gaps.length === 0 && entries.length > 0, detail: { entries: entries.length, lastSeq: entries.at(-1)?.seq, gaps: gaps.slice(0, 5) } }
  const lv = snap.ledgerVerifyCli
  checks.ledgerVerifyOk = { ok: lv?.code === 0 && snap.status?.ledgerVerify?.ok !== false, detail: { cli: lv?.out?.slice(0, 200), status: snap.status?.ledgerVerify } }
  checks.tradingStateActive = { ok: snap.status?.tradingState === 'ACTIVE', detail: { tradingState: snap.status?.tradingState, stateReasons: snap.status?.stateReasons } }
  const keyStates = []
  for (const key of ctx.keys) {
    const m = await key.agent.call('mandate', { action: 'status' })
    const a = await key.agent.call('account', { action: 'list' })
    keyStates.push({ name: key.name, mandateStatus: m.data?.status ?? null, level: m.data?.level ?? null, callOk: a.ok })
  }
  checks.keysHealthy = { ok: keyStates.every((s) => s.mandateStatus === 'active' && s.callOk), detail: keyStates }
  const net = sum(positions.map((p) => (p.side === 'long' ? 1 : -1) * Number(p.size)))
  const fillNet = sum(fills.map((f) => (f.side === 'buy' ? 1 : -1) * Number(f.size)))
  checks.positionMatchesFills = { ok: Math.abs(net - fillNet) < 1e-9, detail: { positionNet: net, fillNet } }
  const stops = orders.filter((o) => o.tpslRole === 'sl' && o.reduceOnly === true && !DEAD.has(o.status))
  const submitted = orders.filter((o) => o.status === 'submitted')
  const info = { liveStopCount: stops.length, submittedOrphans: submitted.length, orderStatuses: countBy(orders, (o) => `${o.tpslRole ?? 'parent'}:${o.status}`) }
  const ok = Object.values(checks).every((c) => c.ok)
  runner.note(`[${label}] 完整性 ${ok ? '通过' : `未过：${Object.entries(checks).filter(([, c]) => !c.ok).map(([n]) => n).join(',')}`}（成交 ${fills.length}，账本 ${entries.length} 条）`)
  return { ok, checks, info }
}

async function main() {
  const home = newHome('s2')
  const pin = randomPin()
  initHome(home)
  const k = await startKernel(home, PORT)
  if (!k.ok) throw new Error(`内核起不来：${JSON.stringify(k).slice(0, 300)}`)
  const session = await openSession(k, () => pin, k.launch)
  await setPinOnce(session)
  // 默认策略有 5 秒开仓冷却、每分钟 30 单、持仓名义额 30%：并发的开仓会被风控串行化，测不到并发写。
  // 这里只放宽本测试实例自己的风控（PIN 放宽，入账 policy.relaxed）：测的是账本 / 纸面状态在并发下的完整性，不是风控额度。
  const relaxed = await session.op('risk.relax', { patch: { limits: { maxOrdersPerMinute: 100000, maxPositionNotionalRatio: '5', maxTotalNotionalRatio: '5', maxOpenPositions: 10, duplicateIntentWindowSec: 0 }, protectors: [] } }, { pin: true })
  runner.run.meta.riskRelaxedForTest = relaxed.limits
  const ctx = { home, k, session, keys: [], accountId: null }
  for (const name of ['conc-a', 'conc-b', 'conc-c']) {
    const key = await newAgentKey(k, session, name, { tier: 'paper' })
    ctx.keys.push({ name, tokenFile: key.tokenFile, agent: agentApi(k, key.token) })
  }
  const base = await standardIntent(ctx.keys[0].agent)
  ctx.accountId = base.accountId
  runner.note(`内核 pid=${k.pid} 端口 ${PORT}，三把钥匙就绪，BTC 参考价 ${base.px}`)
  const px = base.px
  let seq = 0
  // 每单大小略有不同：避开“重复意图”冷却窗口把并发单直接挡掉（那样测不到并发写）
  const intentFor = (side) => ({ accountId: base.accountId, instrumentId: 'hyperliquid:BTC', side, type: 'market', size: (0.0001 + (seq++ % 97) * 0.000005).toFixed(6), reason: 's2', tpsl: { grouping: 'order', stopLoss: { triggerPrice: String(Math.round(side === 'buy' ? px * 0.98 : px * 1.02)) } } })

  const failures = []
  const waves = [{ name: 'wave0-same-direction', plan: ctx.keys.map((key) => ({ key, sides: Array(FIRST).fill('buy') })) }]
  for (let w = 1; w <= WAVES; w++) {
    waves.push({ name: `wave${w}-mixed`, plan: ctx.keys.map((key, ki) => ({ key, sides: Array.from({ length: WAVE_SIZE }, (_, i) => ((i + ki + w) % 3 === 0 ? 'sell' : Math.random() < 0.5 ? 'buy' : 'sell')) })) })
  }
  for (const wave of waves) {
    const t0 = performance.now()
    const jobs = wave.plan.flatMap(({ key, sides }) => sides.map((side, i) => oneOrder(key.agent, intentFor(side), `${key.name}-${wave.name}-${i}-${side}`)))
    const results = await Promise.all(jobs)
    const wallMs = Math.round(performance.now() - t0)
    const outcomes = countBy(results, (r) => `${r.stage}:${r.outcome}`)
    const maxMs = Math.max(...results.map((r) => r.ms))
    await sleep(1500)
    const integ = await integrity(ctx, wave.name)
    const rec = runner.round({ wave: wave.name, orders: results.length, wallMs, maxOrderMs: maxMs, outcomes, ok: integ.ok, checks: integ.checks, info: integ.info, unexpected: results.filter((r) => r.stage !== 'done' && !/RATE_BUDGET|MANDATE_LIMIT|RISK|DENIED|NEEDS/.test(String(r.outcome))).slice(0, 8) })
    if (!rec.ok) failures.push(wave.name)
  }
  const final = await integrity(ctx, 'final')
  const stopInfo = await stopKernel(k)
  const summary = {
    waves: waves.length, wavesPassed: waves.length - failures.length, failedWaves: failures, finalIntegrityOk: final.ok, finalChecks: final.checks, finalInfo: final.info,
    kernelLeftAlive: alive(k.pid), finishedAt: isoNow(), stop: { killed: stopInfo.killed, kernelAlive: stopInfo.kernelAlive },
  }
  removeHome(home)
  return runner.finish(summary)
}

main().then(() => process.exit(0), (e) => { console.error(e); runner.finish({ fatal: String(e.stack ?? e) }); process.exit(1) })
