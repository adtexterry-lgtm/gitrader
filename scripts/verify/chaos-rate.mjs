// SPDX-License-Identifier: CPAL-1.0
// S3 · 限频轰炸。用法：
//   node scripts/verify/chaos-rate.mjs [--port 46540] [--a-seconds 100] [--a-rps 20] [--b-seconds 15] [--b-rps 100] [--skip-heavy]
// (a) 一把钥匙 a-rps 次/秒 × a-seconds 秒 agent.market quote：零拒绝。
// (b) 三把钥匙各 b-rps 次/秒 × b-seconds 秒（一半 quote、一半会被拒的 preview），同时第四把「正常钥匙」每 2 秒一次 quote、
//     轰炸开始后 1 秒与第 b-seconds-4 秒各一次 preview+place（节奏比 WO 的“每 30 秒”密，目的是在窗口内真下到单）；
//     轰炸钥匙之一在窗口中段直接 place（paper 档 intent，不经预览）验证下单不被限流挡住。
//     (b2 加压变体)：同一套，每把钥匙 b-rps 次/秒 quote + b-rps 次/秒 preview（总负载翻倍）。
// 判据见 verdictB()：第四把零 RATE_BUDGET / fetch failed / ACCOUNT_UNKNOWN / STALE_PRICE；轰炸钥匙超出部分 429 RATE_BUDGET 且带 retryAfterMs；
// /api/metrics 有 gitrader_op_rate_limited_total；账本有 annotation rate.limited 与 precheck.summary；账本增长 ≤ 窗口数×(轰炸钥匙数×22)+余量；内核不重启。
import {
  agentApi, countBy, createRunner, health, initHome, isoNow, newAgentKey, newHome, openSession, parseFlags, randomPin, readLedger,
  removeHome, setPinOnce, sleep, standardIntent, startKernel, stopKernel, alive, now,
} from './chaos-lib.mjs'
import { spawnSync } from 'node:child_process'

const flags = parseFlags()
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]))
const PORT = num('port', 46540)
const A_SECONDS = num('a-seconds', 100)
const A_RPS = num('a-rps', 20)
const B_SECONDS = num('b-seconds', 15)
const B_RPS = num('b-rps', 100)
const runner = createRunner('S3-rate', { port: PORT, aSeconds: A_SECONDS, aRps: A_RPS, bSeconds: B_SECONDS, bRps: B_RPS, heavy: !flags['skip-heavy'] })

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const outcomeOf = (r) => (r.ok ? 'ok' : r.netError ? `net:${r.netError.slice(0, 60)}` : `http${r.status}:${r.error?.name ?? '?'}`)

/** 进程内存（WorkingSet，MB）。拿不到返回 null。 */
function memMb(pid) {
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).WorkingSet64`], { encoding: 'utf8', windowsHide: true })
  const n = Number((ps.stdout ?? '').trim())
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1048576) : null
}

/** 探针：每 intervalMs 打一次 /api/health，记延迟，直到 stop()。 */
function startProbe(base, intervalMs = 200) {
  const lat = []
  const errs = []
  let run = true
  const loop = (async () => {
    while (run) {
      const t0 = performance.now()
      try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) }); await r.arrayBuffer(); lat.push(Math.round(performance.now() - t0)) } catch (e) { errs.push(e.message) }
      await sleep(intervalMs)
    }
  })()
  return { async stop() { run = false; await loop; return { samples: lat.length, errors: errs.length, p50: pct(lat, 0.5), p99: pct(lat, 0.99), max: lat.length ? Math.max(...lat) : null } } }
}

/** 按绝对时刻表发请求：每 tickMs 一批 batch(i) → 返回的 promise 全收集。 */
async function drive(seconds, tickMs, batch) {
  const t0 = performance.now()
  const pending = []
  for (let i = 0; performance.now() - t0 < seconds * 1000; i++) {
    for (const p of batch(i)) pending.push(p)
    const wait = t0 + (i + 1) * tickMs - performance.now()
    if (wait > 0) await sleep(wait)
  }
  return Promise.all(pending)
}

async function phaseA(ctx) {
  const key = ctx.keys.a
  const tick = 100
  const perTick = Math.max(1, Math.round(A_RPS * tick / 1000))
  const results = await drive(A_SECONDS, tick, () => Array.from({ length: perTick }, () => key.agent.call('market', { action: 'quote', instrumentId: 'hyperliquid:BTC' }).then((r) => ({ ...r, kind: 'quote' }))))
  const outcomes = countBy(results, outcomeOf)
  const rejected = results.filter((r) => !r.ok)
  const rec = {
    phase: 'a', requests: results.length, seconds: A_SECONDS, targetRps: A_RPS, achievedRps: Math.round(results.length / A_SECONDS * 10) / 10, outcomes,
    latencyMs: { p50: pct(results.map((r) => r.ms), 0.5), p99: pct(results.map((r) => r.ms), 0.99), max: Math.max(...results.map((r) => r.ms)) },
    rejectedSamples: rejected.slice(0, 5).map((r) => ({ status: r.status, netError: r.netError ?? null, error: r.error ? { name: r.error.name, code: r.error.code, message: String(r.error.message).slice(0, 200) } : null })),
  }
  rec.ok = rejected.length === 0
  return rec
}

async function phaseB(ctx, { label, quoteRps, previewRps }) {
  const before = await readLedger(ctx.home)
  const health0 = await health(ctx.k.base)
  const mem0 = memMb(ctx.k.pid)
  const probe = startProbe(ctx.k.base)
  const bombKeys = [ctx.keys.b1, ctx.keys.b2, ctx.keys.b3]
  const denyIntent = { ...ctx.baseIntent, size: '5000', reason: 's3 deny' } // 名义额远超单笔上限 → 预检拒绝
  const tick = 100
  const q = Math.max(1, Math.round(quoteRps * tick / 1000))
  const pv = Math.max(0, Math.round(previewRps * tick / 1000))
  const tStart = performance.now()
  const bombReq = drive(B_SECONDS, tick, () => bombKeys.flatMap((key) => [
    ...Array.from({ length: q }, () => key.agent.call('market', { action: 'quote', instrumentId: 'hyperliquid:BTC' }).then((r) => ({ ...r, key: key.name, kind: 'quote' }))),
    ...Array.from({ length: pv }, () => key.agent.call('order', { action: 'preview', intent: denyIntent }).then((r) => ({ ...r, key: key.name, kind: 'preview' }))),
  ]))
  // 正常钥匙：每 2 秒一次 quote；开始后 1 秒与 B_SECONDS-4 秒各一次 preview+place
  const normal = []
  const normalLoop = (async () => {
    const n = ctx.keys.n
    const placeAt = new Set([1, Math.max(2, B_SECONDS - 2)])
    for (let s = 0; s < B_SECONDS + 3; s++) {
      const target = tStart + s * 1000
      const w = target - performance.now()
      if (w > 0) await sleep(w)
      if (s % 2 === 0) normal.push({ t: s, kind: 'quote', ...(await n.agent.call('market', { action: 'quote', instrumentId: 'hyperliquid:BTC' })) })
      if (placeAt.has(s)) {
        // 第二次用不同大小，避开 10 秒重复意图窗口；预览被风控 deny（无 confirmToken）记为失败，不是限流造成的也要看得见
        const p = await n.agent.call('order', { action: 'preview', intent: { ...ctx.baseIntent, size: s === 1 ? '0.001' : '0.0012' } })
        normal.push({ t: s, kind: 'preview', ...p, ...(p.ok && !p.data?.confirmToken ? { ok: false, error: { name: `PREVIEW_DENIED:${(p.data?.precheck?.ruleHits ?? []).map((h) => h.code).join('+')}` } } : {}) })
        if (p.ok && p.data?.confirmToken) normal.push({ t: s, kind: 'place', ...(await n.agent.call('order', { action: 'place', confirmToken: p.data.confirmToken })) })
      }
    }
  })()
  // 轰炸钥匙之一在中段直接 place（paper 档带 intent）：下单不计数、不该被限流挡
  const bombPlace = (async () => {
    const w = tStart + (B_SECONDS / 2) * 1000 - performance.now()
    if (w > 0) await sleep(w)
    const r = await ctx.keys.b1.agent.call('order', { action: 'place', intent: { ...ctx.baseIntent, size: '0.0013' } })
    return { kind: 'place-during-bombard', ...r }
  })()
  const [bomb, , bp] = await Promise.all([bombReq, normalLoop, bombPlace])
  const wallMs = Math.round(performance.now() - tStart)
  const loop = await probe.stop()
  const mem1 = memMb(ctx.k.pid)
  // 恢复：轰炸结束 5 秒后，被轰炸的钥匙与正常钥匙都应能调用
  await sleep(5000)
  const recovery = {
    bombKeyQuoteAfter5s: outcomeOf(await ctx.keys.b2.agent.call('market', { action: 'quote', instrumentId: 'hyperliquid:BTC' })),
    normalQuoteAfter5s: outcomeOf(await ctx.keys.n.agent.call('market', { action: 'quote', instrumentId: 'hyperliquid:BTC' })),
  }
  const health1 = await health(ctx.k.base)
  // 预检汇总在分钟窗口结束时才写：等到下一个整分钟之后，再用一次预检把窗口滚过去，然后读账本
  await sleep(60_000 - (now() % 60_000) + 3000)
  await ctx.keys.b3.agent.call('order', { action: 'preview', intent: denyIntent })
  await sleep(2500)
  const metrics = await ctx.session.metrics()
  const limitedLines = metrics.text.split(/\r?\n/).filter((l) => l.startsWith('gitrader_op_rate_limited_total'))
  const after = await readLedger(ctx.home)
  const grown = after.slice(before.length)
  const growthByType = countBy(grown, (e) => (e.type === 'annotation' ? `annotation:${e.payload?.kind ?? e.payload?.setting ?? '?'}` : e.type))
  const bombOutcomes = {}
  for (const k of bombKeys) bombOutcomes[k.name] = countBy(bomb.filter((r) => r.key === k.name), (r) => `${r.kind}:${outcomeOf(r)}`)
  const limited = bomb.filter((r) => r.status === 429)
  const limitedWithRetry = limited.filter((r) => Number.isFinite(r.error?.retryAfterMs))
  const normalBad = normal.filter((r) => !r.ok).map((r) => ({ t: r.t, kind: r.kind, status: r.status, netError: r.netError ?? null, name: r.error?.name ?? null, message: String(r.error?.message ?? '').slice(0, 160) }))
  const normalForbidden = normal.filter((r) => !r.ok && (/RATE_BUDGET|fetch failed|ACCOUNT_UNKNOWN|STALE_PRICE/.test(`${r.error?.name ?? ''} ${r.netError ?? ''}`)))
  const windows = Math.max(1, Math.floor(after.at(-1).ts / 60_000) - Math.floor((grown[0]?.ts ?? after.at(-1).ts) / 60_000) + 1)
  const bound = windows * (bombKeys.length * 22) + 40
  const verdicts = {
    normalKeyZeroForbidden: { ok: normalForbidden.length === 0 && normalBad.length === 0, detail: { calls: normal.length, failures: normalBad } },
    bombKeysGot429WithRetryAfter: { ok: limited.length > 0 && limitedWithRetry.length === limited.length, detail: { limited: limited.length, withRetryAfterMs: limitedWithRetry.length, sampleRetryAfterMs: limitedWithRetry.slice(0, 3).map((r) => r.error.retryAfterMs) } },
    metricPresent: { ok: limitedLines.length > 0, detail: limitedLines.slice(0, 6) },
    ledgerHasRateLimitedAnnotation: { ok: growthByType['annotation:rate.limited'] > 0, detail: growthByType['annotation:rate.limited'] ?? 0 },
    ledgerHasPrecheckSummary: { ok: growthByType['annotation:precheck.summary'] > 0, detail: growthByType['annotation:precheck.summary'] ?? 0 },
    ledgerGrowthWithinBound: { ok: grown.length <= bound, detail: { grown: grown.length, bound, windows, formula: 'windows*(3 keys*(20 individual+1 summary+1 rate.limited))+40 余量(正常钥匙的预检/下单/成交等)' } },
    placeUsableDuringBombard: { ok: bp.ok && bp.data?.order?.status === 'filled', detail: { status: bp.status, error: bp.error ? { name: bp.error.name, code: bp.error.code } : null, orderStatus: bp.data?.order?.status ?? null } },
    kernelNotRestarted: { ok: health0.json?.startedAt === health1.json?.startedAt && alive(ctx.k.pid), detail: { startedAt0: health0.json?.startedAt, startedAt1: health1.json?.startedAt } },
    recoveredWithin5s: { ok: recovery.bombKeyQuoteAfter5s === 'ok' && recovery.normalQuoteAfter5s === 'ok', detail: recovery },
  }
  return {
    phase: label, wallMs, bombRequests: bomb.length, bombRpsAchieved: Math.round(bomb.length / B_SECONDS), bombOutcomes, perKeyLoad: { quoteRps, previewRps },
    eventLoopProbe: { endpoint: '/api/health 每 200ms', ...loop }, memoryMb: { before: mem0, after: mem1 }, normalKeyCalls: normal.map((r) => ({ t: r.t, kind: r.kind, ok: r.ok, ms: r.ms, status: r.status })),
    ledgerGrowth: { entries: grown.length, byType: growthByType }, verdicts, ok: Object.values(verdicts).every((v) => v.ok),
    samples: {
      rateLimitedAnnotation: grown.find((e) => e.payload?.kind === 'rate.limited')?.payload ?? null,
      precheckSummary: grown.find((e) => e.payload?.kind === 'precheck.summary')?.payload ?? null,
      limitedResponse: limited[0] ? { status: limited[0].status, error: limited[0].error, retryAfterHeader: limited[0].retryAfter ?? null } : null,
    },
  }
}

async function main() {
  const home = newHome('s3')
  const pin = randomPin()
  initHome(home)
  const k = await startKernel(home, PORT)
  if (!k.ok) throw new Error(`内核起不来：${JSON.stringify(k).slice(0, 300)}`)
  const session = await openSession(k, () => pin, k.launch)
  await setPinOnce(session)
  const keys = {}
  for (const [id, name] of [['a', 'rate-a'], ['b1', 'rate-b1'], ['b2', 'rate-b2'], ['b3', 'rate-b3'], ['n', 'rate-n']]) {
    const key = await newAgentKey(k, session, name, { tier: 'paper' })
    keys[id] = { name, agent: agentApi(k, key.token) }
  }
  const base = await standardIntent(keys.n.agent)
  const ctx = { home, k, session, keys, baseIntent: base.intent }
  runner.note(`内核 pid=${k.pid} 端口 ${PORT}，五把钥匙就绪`)

  const a = await phaseA(ctx)
  runner.round(a)
  runner.note(`(a) ${a.requests} 次 quote、拒绝 ${Object.entries(a.outcomes).filter(([n]) => n !== 'ok').map(([n, c]) => `${n}=${c}`).join(' ') || 0}：${a.ok ? '通过' : '未过'}`)

  const b = await phaseB(ctx, { label: 'b', quoteRps: B_RPS / 2, previewRps: B_RPS / 2 })
  runner.round(b)
  runner.note(`(b) ${b.bombRequests} 请求，${b.ok ? '通过' : `未过：${Object.entries(b.verdicts).filter(([, v]) => !v.ok).map(([n]) => n).join(',')}`}`)

  let b2 = null
  if (!flags['skip-heavy']) {
    await sleep(65_000) // 让上一分钟的预检窗口收口
    b2 = await phaseB(ctx, { label: 'b2-heavy', quoteRps: B_RPS, previewRps: B_RPS })
    runner.round(b2)
    runner.note(`(b2 加压) ${b2.bombRequests} 请求，${b2.ok ? '通过' : `未过：${Object.entries(b2.verdicts).filter(([, v]) => !v.ok).map(([n]) => n).join(',')}`}`)
  }
  const stop = await stopKernel(k)
  removeHome(home)
  return runner.finish({ a: a.ok, b: b.ok, b2: b2 ? b2.ok : 'skipped', kernelLeftAlive: alive(k.pid), stop: { killed: stop.killed }, finishedAt: isoNow() })
}

main().then(() => process.exit(0), (e) => { console.error(e); runner.finish({ fatal: String(e.stack ?? e) }); process.exit(1) })
