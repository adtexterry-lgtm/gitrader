// SPDX-License-Identifier: Apache-2.0
// 宿主仿真 + 确定性假场所 + 合成夹具（种子生成，不含任何录制的第三方行情）。扮演契约 §2 里的"宿主"：
// 实现 host.* 方法，按脚本注入故障（风控拒单、精度拒绝、结果未知 3006、429），记录引擎的每一次调用。
import { createHash } from 'node:crypto'
import {
  asDecimal, isDecimal, makeProblem, validateOrderIntent, type Candle, type Instrument, type OrderIntent, type OrderResult, type Problem, type VenueCapabilities,
} from '../src'

export const PAPER_ACCOUNT = 'acct_01JABAPAPER000000000000001'
export const LIVE_ACCOUNT = 'acct_01JAB0QZ8W3K5M7N9P1R3T5V7X'
export const MANDATE_ID = 'mdt_01JABAENG01'
export const BTC = 'hyperliquid:BTC'
export const ETH = 'hyperliquid:ETH'
export const T0 = 1_790_000_000_000

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 合成 K 线：正弦 + 噪声，固定种子则逐字节一致。 */
export function genCandles(seed: number, count: number, intervalMs = 60_000, start = T0, base = 2400): Candle[] {
  const rnd = mulberry32(seed)
  const out: Candle[] = []
  let prev = base
  for (let i = 0; i < count; i++) {
    const close = Math.round((base + 80 * Math.sin(i / 25) + (rnd() - 0.5) * 6) * 10) / 10
    const high = Math.max(prev, close) + Math.round(rnd() * 3 * 10) / 10
    const low = Math.min(prev, close) - Math.round(rnd() * 3 * 10) / 10
    out.push({ t: start + i * intervalMs, o: prev, h: high, l: low, c: close, v: Math.round(rnd() * 1000) / 10 })
    prev = close
  }
  return out
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

export type Fault = 'deny-risk' | 'precision' | 'timeout-3006' | 'rate-limited'

export interface PlaceRecord { at: number; params: any; result: OrderResult }
export interface HostCall { at: number; method: string; params: any }

export const INSTRUMENTS: Instrument[] = ['BTC', 'ETH'].map((sym) => ({
  instrumentId: `hyperliquid:${sym}`, venue: 'hyperliquid', symbol: sym, displaySymbol: sym, kind: 'perp', base: sym, quote: 'USDC', settle: 'USDC',
  settlement: 'linear', contractSize: asDecimal('1'), venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
  price: { sigFigs: 5, maxDecimals: sym === 'BTC' ? 1 : 2 }, size: { step: asDecimal('0.001'), decimals: 3, min: asDecimal('0.001') },
  minNotional: asDecimal('10'), maxLeverage: 20, marginModes: ['cross', 'isolated'], orderTypes: ['market', 'limit'], tif: ['gtc', 'ioc', 'alo'],
  triggerPriceTypes: ['mark'], fundingIntervalMs: 3_600_000, fees: { maker: asDecimal('0.00015'), taker: asDecimal('0.00045'), source: 'assumed' },
  updatedAt: T0,
}))

export const VENUE_CAPS: VenueCapabilities = {
  venue: 'hyperliquid', environments: ['mainnet', 'testnet'], instrumentKinds: ['perp'], orderTypes: { market: 'emulated', limit: 'native' },
  marketEmulation: { method: 'ioc_limit' }, tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'], clientOrderId: { format: 'hex128' },
  history: { maxCandles: 5000, pageLimit: 500 }, withdrawPermissionCheck: 'not_applicable',
}

export class HostSim {
  /** 所有引擎调用（含通知）。 */
  readonly calls: HostCall[] = []
  readonly placed: PlaceRecord[] = []
  /** host.proposal.create 收到的请求。 */
  readonly proposals: any[] = []
  /** clientOrderId → 已创建订单（幂等）。 */
  readonly orders = new Map<string, OrderResult>()
  private faults: Fault[] = []
  /** 风控拒单阈值：名义额超过则 2001（只在设置后生效）。 */
  denyAboveNotional: number | null = null
  lastPrice = 2400
  private orderSeq = 0

  /** 排队的故障按顺序消耗，每次下单一个。 */
  queueFault(...f: Fault[]): void { this.faults.push(...f) }
  clear(): void { this.calls.length = 0; this.placed.length = 0; this.proposals.length = 0; this.orders.clear(); this.faults = []; this.denyAboveNotional = null }

  private id(): string {
    this.orderSeq += 1
    return `ord_01JABC${String(this.orderSeq).padStart(8, '0')}00000000`.slice(0, 30)
  }

  /** 返回 { result } 或 { error: Problem+code }；未实现的方法返回 METHOD_NOT_FOUND。 */
  handle(method: string, params: any): { result: unknown } | { error: Problem } {
    this.calls.push({ at: Date.now(), method, params })
    switch (method) {
      case 'host.describe':
        return { result: { host: { name: 'gep-conformance-host', version: '0.1.2' }, venues: [VENUE_CAPS], accounts: [
          { accountId: PAPER_ACCOUNT, alias: 'paper', venue: 'hyperliquid', environment: 'mainnet', mode: 'paper' },
          { accountId: LIVE_ACCOUNT, alias: 'live-testnet', venue: 'hyperliquid', environment: 'testnet', mode: 'live' },
        ] } }
      case 'host.instruments': {
        const ids: string[] | undefined = params?.ids
        return { result: { instruments: INSTRUMENTS.filter((i) => (!ids || ids.includes(i.instrumentId)) && (!params?.venue || params.venue === i.venue)) } }
      }
      case 'host.market.subscribe': return { result: { subscriptionId: `sub_${this.calls.length}` } }
      case 'host.market.unsubscribe': return { result: { ok: true } }
      case 'host.market.snapshot': return { result: { instrumentId: params?.instrumentId ?? BTC, ts: T0, bid: this.lastPrice - 0.5, ask: this.lastPrice + 0.5, last: this.lastPrice } }
      case 'host.market.history': {
        const limit = Math.min(params?.limit ?? 500, 5000)
        return { result: { candles: genCandles(7, limit), source: 'synthetic', complete: true } }
      }
      case 'host.account.snapshot':
        return { result: {
          balances: [{ accountId: params.accountId, asset: 'USDC', total: '10000', available: '10000', hold: '0', ts: T0 }],
          margin: { accountId: params.accountId, model: 'standard', valuationCcy: 'USDC', equity: '10000', initialMargin: '0', maintenanceMargin: '0', available: '10000', marginRatio: '0', leverage: 1, ts: T0 },
          positions: [], openOrders: [], ts: T0, attestation: 'kernel-observed',
        } }
      case 'host.risk.precheck': return { result: { precheckId: 'pck_01JABCPRECHECK', verdict: 'allow', policyVersion: 1, ruleHits: [], estimates: {} } }
      case 'host.order.place': return { result: this.place(params) }
      case 'host.order.cancel': case 'host.order.amend': return { result: { orderId: this.id(), clientOrderId: params?.clientOrderId ?? '0'.repeat(32), status: 'cancelled' } }
      case 'host.order.cancelAll': return { result: { cancelled: 0 } }
      case 'host.order.batch': return { result: { results: (params?.orders ?? []).map((o: any) => this.place(o)) } }
      case 'host.order.status': {
        const o = this.orders.get(params?.clientOrderId)
        if (!o) return { error: makeProblem('INSTRUMENT_UNKNOWN', 'order not found') }
        return { result: { ...o.order! } }
      }
      case 'host.proposal.create': {
        const ok = Array.isArray(params?.intents) && params.intents.length > 0 && typeof params?.reason === 'string' && params.reason.length > 0
        if (!ok) return { error: makeProblem('INVALID_PARAMS', 'intents and reason are required') }
        this.proposals.push(params)
        const n = this.proposals.length
        return { result: {
          proposalId: `prop_01JABCP${String(n).padStart(6, '0')}`, ticket: `T-20261010-${String(n).padStart(4, '0')}`, status: 'pending',
          precheck: { precheckId: 'pck_01JABCPRECHECK', verdict: 'review', policyVersion: 1, ruleHits: [], estimates: {} }, expiresAt: Date.now() + 600_000,
        } }
      }
      case 'host.events.subscribe': return { result: { subscriptionId: `evsub_${this.calls.length}` } }
      case 'host.ledger.append': return { result: { seqs: (params?.entries ?? []).map((_: unknown, i: number) => i + 1) } }
      case 'host.artifact.put': return { result: { artifactId: `art_${sha256(String(params?.path)).slice(0, 12)}` } }
      default: return { error: makeProblem('METHOD_NOT_FOUND', `unknown host method ${method}`) }
    }
  }

  private place(params: any): OrderResult {
    const cid: string = params.clientOrderId
    const existing = this.orders.get(cid)
    if (existing) { this.placed.push({ at: Date.now(), params, result: existing }); return existing }
    const fault = this.faults.shift()
    const intent: OrderIntent | undefined = params.intent
    const mk = (status: OrderResult['status'], problem?: Problem): OrderResult => {
      const orderId = this.id() as OrderResult['orderId']
      const res: OrderResult = {
        orderId, clientOrderId: cid, status, ...(problem ? { problem } : {}),
        order: {
          orderId, clientOrderId: cid, accountId: params.accountId, instrumentId: intent?.instrumentId ?? BTC, side: intent?.side ?? 'buy', type: intent?.type ?? 'market',
          tif: intent?.tif ?? 'ioc', size: intent?.size ?? asDecimal('0'), filledSize: status === 'filled' ? (intent?.size ?? asDecimal('0')) : asDecimal('0'),
          status, fee: asDecimal('0'), ...(problem ? { problem } : {}),
          origin: { actor: 'engine:conformance', actorType: 'engine', tool: `strategy:${params.strategyId ?? 'unknown'}`, requestId: '6c5d4e3f-2a1b-4c0d-9e8f-7a6b5c4d3e2f', via: 'gep' },
          createdAt: Date.now(), updatedAt: Date.now(),
        },
      }
      return res
    }
    let out: OrderResult
    const shapeOk = intent && validateOrderIntent(intent).ok && (intent.size === undefined || isDecimal(intent.size))
    if (!shapeOk) {
      out = mk('denied', makeProblem('INVALID_PARAMS', 'intent does not satisfy the OrderIntent schema'))
    } else if (fault === 'precision' || (intent.size && decimals(intent.size) > 3)) {
      out = mk('denied', makeProblem('PRECISION', 'size precision exceeds szDecimals 3'))
    } else if (fault === 'rate-limited') {
      out = mk('rejected', makeProblem('VENUE_RATE_LIMITED', 'rate limited', { retryAfterMs: 1000, venue: { id: 'hyperliquid', message: 'Too many requests' } }))
    } else if (fault === 'timeout-3006') {
      // 结果未知不是 JSON-RPC 错误：成功返回 + problem 3006；订单其实已在场所（之后 host.order.status 查得到）
      out = mk('submitted', makeProblem('VENUE_OUTCOME_UNKNOWN', 'request timed out; outcome unknown', { venue: { id: 'hyperliquid', message: 'request timed out' } }))
    } else {
      const notional = intent.size ? Number(intent.size) * this.lastPrice : 0
      if (fault === 'deny-risk' || (this.denyAboveNotional !== null && notional > this.denyAboveNotional)) {
        const limit = this.denyAboveNotional ?? 100
        out = mk('denied', makeProblem('RULE_DENIED', 'order notional exceeds maxOrderNotional', {
          precheckId: 'pck_01JABCPRECHECK' as Problem['precheckId'],
          ruleHits: [{ ruleId: 'pol_01JAB1#maxOrderNotional', code: 'ORDER_NOTIONAL', limit: asDecimal(String(limit)), actual: asDecimal(notional.toFixed(2).replace(/\.?0+$/, '') || '0'), unit: 'USDC', action: 'deny', scope: 'account' }],
        }))
      } else {
        out = mk('filled')
      }
    }
    this.orders.set(cid, out)
    this.placed.push({ at: Date.now(), params, result: out })
    return out
  }
}

function decimals(s: string): number {
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}
