// SPDX-License-Identifier: CPAL-1.0
// 集成验收用的"真内核 + 夹具行情"宿主（H）。由 scripts/verify/stage.mjs 用 esbuild 打成临时 ESM 后在子进程里跑。
//
// 和 `gitrader serve` 走同一条路：cli 的 runServe()（真内核、真 HTTP / WS、真工作台静态产物），唯一的替换是连接器装配：
//   · 真 HyperliquidConnector，但 fetch / WebSocket 换成夹具（fixtures/hl/），不联网；
//   · WS 端按 fixtures/hl/replay/btc-1m.json 循环推 allMids / bbo / l2Book / candle（时间戳用"现在"，避免被陈旧价保护拦下）；
//   · /exchange 由本宿主假装测试网：记录收到的已签名载荷（只记动作与签名形状，不记任何私钥），回一个"已成交"的响应；
//   · 真 PaperVenue 吃上面这个连接器的行情做纸面撮合。
// 控制：stdin 一行一个 JSON：{id, cmd:'boot'|'run'|'stop', code?}。'run' 在宿主里执行一段异步代码（k = 内核，ctx = 本宿主状态），只给验收脚本用。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { runServe } from '../../packages/cli/src/index'
import { HyperliquidConnector } from '@gitrader/connector-hyperliquid'
import { PaperVenue } from '@gitrader/venue-paper'

const [home, fxDir, staticDir, portArg, tickArg] = process.argv.slice(2) as [string, string, string, string | undefined, string | undefined]
const tickMs = Number(tickArg ?? 250)
const fixedMarket = process.env.GITRADER_STAGE_FIXED_MARKET === '1'
const load = (n: string): any => JSON.parse(readFileSync(join(fxDir, n), 'utf8')) // eslint-disable-line @typescript-eslint/no-explicit-any
const replay = load('replay/btc-1m.json') as { frames: Array<{ ts: number; marks: Record<string, number>; funding: Record<string, number>; books: Record<string, { bids: [number, number][]; asks: [number, number][] }> }> }
const candles1m = load('candleSnapshot-BTC-1m.json') as Array<{ t: number; T: number }>
const shift = Date.now() - (candles1m[candles1m.length - 1]!.T ?? candles1m[candles1m.length - 1]!.t)
void shift
// K 线：真实 50 根 BTC 1m 收盘价循环拼成 3000 根历史（合成、只用于验证管道，不代表任何行情）；WS 侧用"虚拟分钟"（每个 tick 前进 1 分钟），
// 让策略在几十秒内看到足够多的收盘 K 线。历史截止在 vt0，之后是虚拟分钟。
const vt0 = Math.floor(Date.now() / 60_000) * 60_000
const closes = candles1m.map((c) => Number((c as unknown as { c: string }).c))
const history = Array.from({ length: 3000 }, (_, i) => {
  const t = vt0 - (3000 - i) * 60_000
  const c = closes[i % closes.length]! + Math.round(Math.sin(i / 37) * 400)
  const o = closes[(i + closes.length - 1) % closes.length]! + Math.round(Math.sin((i - 1) / 37) * 400)
  return { t, T: t + 59_999, s: 'BTC', i: '1m', o: String(o), c: String(c), h: String(Math.max(o, c) + 8), l: String(Math.min(o, c) - 8), v: '1.0', n: 10 }
})

const ctx = {
  exchangeCalls: [] as Array<{ at: number; actionType: string; hasSignature: boolean; nonce: number; vaultAddress?: string; body: unknown }>,
  unhandledInfo: new Map<string, number>(),
  wsPushes: 0,
  frame: 0,
  /** 行情注入时间（Date.now()），按帧号记录，供"行情到块"测量。 */
  pushTimes: [] as Array<{ frame: number; at: number; mid: number }>,
  exchangeMode: 'ok' as 'ok' | 'error' | 'network',
  oid: 1000,
  paused: false,
  infoCounts: new Map<string, number>(),
}

const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const liveState = { positions: [] as Array<{ coin: string; szi: string; entryPx: string }>, fills: [] as unknown[] }
const clearing = (dex: string): Record<string, unknown> => {
  const pos = (dex ? [] : liveState.positions).map((p) => ({ type: 'oneWay', position: { coin: p.coin, szi: p.szi, entryPx: p.entryPx, positionValue: String(Math.abs(Number(p.szi)) * Number(p.entryPx)), unrealizedPnl: '0', returnOnEquity: '0', liquidationPx: null, leverage: { type: 'cross', value: 2 }, marginUsed: '0', maxLeverage: 40, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }))
  return { marginSummary: { accountValue: dex ? '0.0' : '1000.0', totalNtlPos: '0.0', totalRawUsd: '1000.0', totalMarginUsed: '0.0' }, crossMarginSummary: { accountValue: dex ? '0.0' : '1000.0', totalNtlPos: '0.0', totalRawUsd: '1000.0', totalMarginUsed: '0.0' }, crossMaintenanceMarginUsed: '0.0', withdrawable: dex ? '0.0' : '1000.0', assetPositions: pos, time: Date.now() }
}
const DEXES = ['', 'xyz', 'io', 'para', 'mkts']
const userPush = (sk: { push(o: unknown): void }, sub: Record<string, unknown>): boolean => {
  const user = sub.user
  if (sub.type === 'allDexsClearinghouseState') { sk.push({ channel: 'allDexsClearinghouseState', data: { user, clearinghouseStates: DEXES.map((d) => [d, clearing(d)]) } }); return true }
  if (sub.type === 'spotState') { sk.push({ channel: 'spotState', data: { user, spotState: { balances: [] } } }); return true }
  if (sub.type === 'openOrders') { sk.push({ channel: 'openOrders', data: { user, dex: sub.dex ?? '', orders: [] } }); return true }
  return false
}

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input)
  const body = JSON.parse(String(init?.body ?? '{}'))
  if (url.endsWith('/exchange')) {
    const a = body.action ?? {}
    // 只记形状：动作类型、是否带签名、nonce；载荷本身不含私钥（签名是公开可验证的数据）
    ctx.exchangeCalls.push({ at: Date.now(), actionType: String(a.type), hasSignature: !!(body.signature && body.signature.r && body.signature.s), nonce: body.nonce, ...(body.vaultAddress ? { vaultAddress: body.vaultAddress } : {}), body: { action: a, nonce: body.nonce, signature: body.signature ? { r: String(body.signature.r).slice(0, 10) + '…', v: body.signature.v } : null } })
    if (ctx.exchangeMode === 'network') { ctx.exchangeMode = 'ok'; throw new TypeError('fetch failed: ECONNRESET') }
    if (ctx.exchangeMode === 'error') return json({ status: 'err', response: 'Insufficient margin to place order.' })
    if (a.type === 'order') {
      const statuses = (a.orders ?? []).map((o: { s: string; p: string; b: boolean; a: number }) => {
        const oid = ++ctx.oid
        const px = String(replay.frames[ctx.frame % replay.frames.length]!.marks['hyperliquid:BTC'])
        liveState.positions.push({ coin: 'BTC', szi: (o.b ? '' : '-') + o.s, entryPx: px })
        // 像真场所一样随后经 WS 推 userFills（内核据此发成交 / 持仓事件）
        const fill = { coin: 'BTC', px, sz: o.s, side: o.b ? 'B' : 'A', time: Date.now(), startPosition: '0', dir: o.b ? 'Open Long' : 'Open Short', closedPnl: '0', hash: '0x' + '0'.repeat(64), oid, crossed: true, fee: '0.01', tid: oid * 10, feeToken: 'USDC', ...(o.c ? { cloid: o.c } : {}) }
        liveState.fills.push(fill)
        setTimeout(() => { for (const sk of sockets) for (const sub of sk.subs) { if (sub.type === 'userFills') sk.push({ channel: 'userFills', data: { user: sub.user, fills: [fill] } }); else userPush(sk, sub) } }, 30)
        return { filled: { totalSz: o.s, avgPx: px, oid } }
      })
      return json({ status: 'ok', response: { type: 'order', data: { statuses } } })
    }
    if (a.type === 'cancel' || a.type === 'cancelByCloid') return json({ status: 'ok', response: { type: 'cancel', data: { statuses: (a.cancels ?? []).map(() => 'success') } } })
    if (a.type === 'scheduleCancel') return json({ status: 'ok', response: { type: 'default' } })
    if (a.type === 'updateLeverage') return json({ status: 'ok', response: { type: 'default' } })
    return json({ status: 'ok', response: { type: 'default' } })
  }
  { const key = String(body.type) + (body.dex ? ':' + body.dex : ''); ctx.infoCounts.set(key, (ctx.infoCounts.get(key) ?? 0) + 1) }
  switch (body.type) {
    case 'perpDexs': return json(load('perpDexs.json'))
    case 'metaAndAssetCtxs': {
      const data = load(body.dex ? `metaAndAssetCtxs-${body.dex}.json` : 'metaAndAssetCtxs.json') as [{ universe: { name: string }[] }, Record<string, string>[]]
      if (!body.dex && Array.isArray(data) && data[0]?.universe && Array.isArray(data[1])) {
        // 与 WS 推送同源：BTC 的 markPx / midPx / oraclePx 取当前帧，否则提案时的 REST 参考价与执行时的推送价恒差（夹具文件录制时刻不同）
        const i = data[0].universe.findIndex((u) => u.name === 'BTC')
        const px = String(replay.frames[ctx.frame % replay.frames.length]!.marks['hyperliquid:BTC'])
        if (i >= 0 && data[1][i]) data[1][i] = { ...data[1][i], markPx: px, midPx: px, oraclePx: px, ...(fixedMarket ? { funding: '0' } : {}) }
      }
      return json(data)
    }
    case 'allMids': return json(load(body.dex ? `allMids-${body.dex}.json` : 'allMids.json'))
    case 'l2Book': {
      const f = replay.frames[ctx.frame % replay.frames.length]!
      const b = f.books['hyperliquid:BTC']!
      if (body.coin !== 'BTC') return json(null)
      const lv = (rows: [number, number][]) => rows.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }))
      return json({ coin: 'BTC', time: Date.now(), levels: [lv(b.bids), lv(b.asks)] })
    }
    case 'candleSnapshot': {
      const r = body.req
      if (r.coin !== 'BTC') return json([])
      return json(history.filter((c) => c.t >= r.startTime && c.t <= r.endTime))
    }
    case 'clearinghouseState': {
      if (body.type === 'clearinghouseState') return json(clearing(String(body.dex ?? '')))
      const pos = (body.dex ? [] : liveState.positions).map((p) => ({ type: 'oneWay', position: { coin: p.coin, szi: p.szi, entryPx: p.entryPx, positionValue: String(Math.abs(Number(p.szi)) * Number(p.entryPx)), unrealizedPnl: '0', returnOnEquity: '0', liquidationPx: null, leverage: { type: 'cross', value: 2 }, marginUsed: '0', maxLeverage: 40, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }))
      return json({ marginSummary: { accountValue: '1000.0', totalNtlPos: '0.0', totalRawUsd: '1000.0', totalMarginUsed: '0.0' }, crossMarginSummary: { accountValue: '1000.0', totalNtlPos: '0.0', totalRawUsd: '1000.0', totalMarginUsed: '0.0' }, crossMaintenanceMarginUsed: '0.0', withdrawable: '1000.0', assetPositions: pos, time: Date.now() })
    }
    case 'spotClearinghouseState': return json({ balances: [] })
    case 'openOrders': case 'frontendOpenOrders': return json([])
    case 'userFills': case 'userFillsByTime': return json(liveState.fills)
    case 'userRole': return json({ role: 'user' })
    case 'userAbstraction': return json('default')
    case 'maxBuilderFee': return json(0)
    case 'extraAgents': return json([])
    case 'orderStatus': return json({ status: 'unknownOid' })
    case 'userRateLimit': return json({ cumVlm: '0', nRequestsUsed: 0, nRequestsCap: 10000 })
    default:
      ctx.unhandledInfo.set(String(body.type), (ctx.unhandledInfo.get(String(body.type)) ?? 0) + 1)
      return new Response(`unhandled info type ${body.type}`, { status: 422 })
  }
}

// ---- 假 WebSocket：连上即开；订阅记下；按帧推送 ----
const sockets = new Set<FixtureWS>()
const wsSubs = (): unknown[] => [...sockets].flatMap((sk) => sk.subs)
;(ctx as Record<string, unknown>).wsSubs = wsSubs
class FixtureWS {
  readyState = 0
  subs: Array<Record<string, unknown>> = []
  private h = new Map<string, Set<(ev: unknown) => void>>()
  constructor(readonly url: string) { sockets.add(this); setTimeout(() => { this.readyState = 1; this.emit('open', {}) }, 5) }
  addEventListener(t: string, f: (ev: unknown) => void): void { if (!this.h.has(t)) this.h.set(t, new Set()); this.h.get(t)!.add(f) }
  removeEventListener(t: string, f: (ev: unknown) => void): void { this.h.get(t)?.delete(f) }
  send(data: string): void {
    const m = JSON.parse(data)
    if (m.method === 'subscribe') { this.subs.push(m.subscription); this.push({ channel: 'subscriptionResponse', data: m }); setTimeout(() => userPush(this, m.subscription), 5) }
    else if (m.method === 'unsubscribe') this.subs = this.subs.filter((s) => JSON.stringify(s) !== JSON.stringify(m.subscription))
    else if (m.method === 'ping') this.push({ channel: 'pong' })
  }
  close(): void { this.readyState = 3; sockets.delete(this); this.emit('close', {}) }
  push(o: unknown): void { if (this.readyState === 1) this.emit('message', { data: JSON.stringify(o) }) }
  private emit(t: string, ev: unknown): void { for (const f of [...(this.h.get(t) ?? [])]) f(ev) }
}

const baseMids = load('allMids.json') as Record<string, string>
function tick(): void {
  if (ctx.paused) return
  if (!fixedMarket) ctx.frame += 1
  const f = replay.frames[ctx.frame % replay.frames.length]!
  const mid = f.marks['hyperliquid:BTC']!
  const b = f.books['hyperliquid:BTC']!
  const now = Date.now()
  ctx.pushTimes.push({ frame: ctx.frame, at: now, mid })
  if (ctx.pushTimes.length > 2000) ctx.pushTimes.splice(0, 1000)
  const lv = (rows: [number, number][]) => rows.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }))
  for (const s of sockets) {
    for (const sub of s.subs) {
      const t = sub.type
      if (t === 'allMids' && !sub.dex) s.push({ channel: 'allMids', data: { mids: { ...baseMids, BTC: String(mid) } } })
      else if (t === 'bbo' && sub.coin === 'BTC') s.push({ channel: 'bbo', data: { coin: 'BTC', time: now, bbo: [{ px: String(b.bids[0]![0]), sz: String(b.bids[0]![1]), n: 1 }, { px: String(b.asks[0]![0]), sz: String(b.asks[0]![1]), n: 1 }] } })
      else if (t === 'l2Book' && sub.coin === 'BTC') s.push({ channel: 'l2Book', data: { coin: 'BTC', time: now, levels: [lv(b.bids), lv(b.asks)] } })
      else if (t === 'candle' && sub.coin === 'BTC') { const t0 = vt0 + ctx.frame * 60_000; const ms = 60_000; s.push({ channel: 'candle', data: { t: t0, T: t0 + ms - 1, s: 'BTC', i: sub.interval, o: String(mid), c: String(mid), h: String(mid + 5), l: String(mid - 5), v: '1.0', n: 10 } }) }
      else if (t === 'activeAssetCtx' && sub.coin === 'BTC') s.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { funding: fixedMarket ? '0' : String(f.funding['hyperliquid:BTC']), openInterest: '1000', prevDayPx: String(mid), dayNtlVlm: '1', premium: '0', oraclePx: String(mid), markPx: String(mid), midPx: String(mid), impactPxs: [String(mid), String(mid)], dayBaseVlm: '1' } } })
      else continue
      ctx.wsPushes += 1
    }
  }
}

const io = {
  out: (s: string) => process.stderr.write(s),
  err: (s: string) => process.stderr.write(s),
  env: { ...process.env } as Record<string, string | undefined>,
  readSecret: async () => { throw new Error('no terminal') },
  interactive: false,
}

let hl: HyperliquidConnector | undefined
let paper: PaperVenue | undefined
const h = await runServe(home, {
  ...(portArg ? { port: Number(portArg) } : {}),
  staticDir,
  io,
  connect: (k) => {
    const env = k.config.venues.find((v) => v.id === 'hyperliquid')?.environment ?? 'testnet'
    hl = new HyperliquidConnector({ environment: env, budget: k.bus.budgetFor('hyperliquid') as never, supportDeveloper: k.config.supportDeveloper === true, clock: () => k.clock.now(), fetchImpl, WebSocketImpl: FixtureWS as unknown as typeof WebSocket })
    k.registerConnector(hl as never)
    k.connectInBackground('hyperliquid', () => hl!.start())
    paper = new PaperVenue({ market: hl as never, clock: () => k.clock.now() })
    k.registerConnector(paper as never)
    paper.start()
  },
})
const timer = setInterval(tick, tickMs)
const k = h.kernel
// runServe 在替换连接器装配时不拉起随包引擎（与 serve 的离线测试口径一致）；这里补上，和真 serve 一样拉起 gitrader-core
if (process.env.GITRADER_STAGE_NO_ENGINE !== '1') { try { k.engines.start('gitrader-core') } catch (e) { process.stderr.write('engine start failed: ' + String(e) + String.fromCharCode(10)) } }
process.stdout.write(JSON.stringify({ ready: true, port: h.port, url: h.url, pid: process.pid }) + '\n')

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...x: unknown[]) => Promise<unknown>
createInterface({ input: process.stdin }).on('line', async (line) => {
  let m: { id?: number; cmd?: string; code?: string }
  try { m = JSON.parse(line) } catch { return }
  const reply = (o: Record<string, unknown>): void => { process.stdout.write(JSON.stringify({ id: m.id, ...o }) + '\n') }
  try {
    if (m.cmd === 'boot') return reply({ url: `http://127.0.0.1:${h.port}/?launch=${k.auth.mintBootToken()}` })
    if (m.cmd === 'run') return reply({ result: await new AsyncFunction('k', 'ctx', 'hl', 'paper', String(m.code))(k, ctx, hl, paper) })
    if (m.cmd === 'stop') { clearInterval(timer); await h.stop(); reply({ done: 'stop' }); setTimeout(() => process.exit(0), 50); return }
    reply({ error: `unknown cmd ${m.cmd}` })
  } catch (e) {
    reply({ error: String((e as Error)?.stack ?? e).slice(0, 1500) })
  }
})
