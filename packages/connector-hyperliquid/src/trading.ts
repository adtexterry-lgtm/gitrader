// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 改单 / 撤单 / 批量 / 杠杆 / 场所级死人开关。签名与发送交给 @nktkas/hyperliquid（精确版本锁定），
// 本模块只做：意图 → 线上订单（orders.ts）、按内核句柄签名、每个签名者独立 nonce、回执 → 统一模型、错误原话带回。
// 连接器永远拿不到私钥：signer 是内核给的 signTypedData 句柄，每次签名只回调载荷摘要。
import { ExchangeClient } from '@nktkas/hyperliquid'
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange'
import { makeProblem } from '@gitrader/protocol'
import type { OrderIntent, Problem, InstrumentId } from '@gitrader/protocol'
import { createHash } from 'node:crypto'
import { normalizeDecimal } from '@gitrader/protocol'
import { HlHttpError, HlNetworkError } from './rest'
import type { HlHttp } from './rest'
import type { HlMarket } from './market'
import type { NonceManager } from './nonce'
import { BUILDER_FEE_TENTH_BPS, OrderBuildError, buildOrder, newClientOrderId } from './orders'
import type { BuiltOrder, OrderRole, WireGrouping, WireOrder } from './orders'
import { ProblemError, problemFromTransportError, problemFromVenueMessage, venueProblem } from './errors'
import type {
  AmendRequest, CancelAck, CancelTarget, DeadmanHandle, Hex, OrderAck, SignedEvent, SubmitResult, TradeContext, VenueOpenOrder,
} from '@gitrader/protocol/connector'

export interface TradingDeps {
  http: HlHttp
  market: HlMarket
  nonce: NonceManager
  clock?: () => number
  /** 收费地址（Gitrader 自己的 builder 地址）。缺省 = 永远不附 builder。 */
  builderAddress?: Hex
  /** 「支持开发者」开关，默认 false：关闭时订单永远不带 builder 字段。 */
  supportDeveloper?: boolean
  onDiagnostic?: (event: VenueExpiryDiagnostic) => void
  /** cancelAll 要先列出挂单。 */
  openOrders: (account: TradeContext['account']) => Promise<VenueOpenOrder[]>
}

export interface VenueExpiryDiagnostic {
  event: 'venue_expiry_prepared'
  localExpiresAt: number
  serverClockOffsetMs: number
  venueExpiresAt: number
}

/** 官方：scheduleCancel 的时间必须在 5 秒之后。 */
export const SCHEDULE_CANCEL_MIN_LEAD_MS = 5_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

function amendStatusProblem(status: unknown): Problem {
  if (status !== null && typeof status === 'object' && typeof (status as { error?: unknown }).error === 'string') {
    return problemFromVenueMessage((status as { error: string }).error)
  }
  return venueProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; query by clientOrderId before retrying', JSON.stringify(status ?? null))
}

function readAmendStatuses(value: unknown): unknown[] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const response = (value as { response?: unknown }).response
  if (response === null || typeof response !== 'object') return undefined
  const data = (response as { data?: unknown }).data
  if (data === null || typeof data !== 'object') return undefined
  const statuses = (data as { statuses?: unknown }).statuses
  return Array.isArray(statuses) ? statuses : undefined
}

function outcomeUnknownProblem(message: string): Problem {
  return venueProblem('VENUE_OUTCOME_UNKNOWN', message, 'unrecognized exchange order outcome; query by clientOrderId before retrying')
}

function validVenueOrderId(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0
}

function parseNonNegativeDecimal(value: unknown): ReturnType<typeof normalizeDecimal> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const normalized = normalizeDecimal(value)
    return normalized.startsWith('-') ? undefined : normalized
  } catch { return undefined }
}

function isPositiveDecimal(value: string): boolean {
  return !/^0(?:\.0*)?$/.test(value)
}

interface Planned { intentIndex: number; built: BuiltOrder; expiresAt?: number }

export class HlTrading {
  private readonly clock: () => number
  private readonly onDiagnostic: (event: VenueExpiryDiagnostic) => void
  private readonly leverageSet = new Map<string, string>()

  constructor(private readonly d: TradingDeps) {
    this.clock = d.clock ?? (() => Date.now())
    this.onDiagnostic = d.onDiagnostic ?? ((event) => console.info(event))
  }

  // ───────────── 下单 ─────────────

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const planned: Planned[] = []
    intents.forEach((intent, i) => {
      try {
        const q = this.d.market.quote(intent.instrumentId)
        const built = buildOrder(intent, this.d.market.getRecord(intent.instrumentId), {
          ...(q ? { bid: q.bid, ask: q.ask, mid: q.last ?? (q.bid + q.ask) / 2, stale: q.stale } : {}),
        })
        planned.push({ intentIndex: i, built, ...(intent.expiresAt !== undefined ? { expiresAt: intent.expiresAt } : {}) })
      } catch (e) {
        if (!(e instanceof OrderBuildError)) throw e
        acks.push(this.rejectedAck(i, intent.clientOrderId ?? newClientOrderId(), e.problem, 'parent'))
      }
    })

    // 杠杆是持仓级设置：下单前先设好（只在变化时发）
    const sendable: Planned[] = []
    for (const p of planned) {
      const intent = intents[p.intentIndex]!
      const err = await this.ensureLeverage(ctx, intent)
      if (err) acks.push(this.rejectedAck(p.intentIndex, p.built.clientOrderId, err, 'parent'))
      else sendable.push(p)
    }

    const builder = this.builderFor(ctx)
    const raws: unknown[] = []
    let weight = 0
    for (const action of this.groupActions(sendable)) {
      const wires = action.flatMap((p) => p.built.orders)
      const expiresAfter = action.map((p) => p.expiresAt).filter((x): x is number => x !== undefined).sort((a, b) => a - b)[0]
      const out = await this.sendOrders(ctx, wires, action[0]!.built.grouping, builder, expiresAfter)
      raws.push(out.raw)
      weight += 1 + Math.floor(wires.length / 40)
      let k = 0
      for (const p of action) {
        p.built.orders.forEach((_o, j) => {
          const role = p.built.roles[j]!
          const base = { intentIndex: p.intentIndex, role, clientOrderId: role === 'parent' ? p.built.clientOrderId : '' }
          acks.push(out.problem ? this.problemAck(base, out.problem) : this.ackFromStatus(out.statuses[k], base, !!builder))
          k++
        })
      }
    }
    acks.sort((a, b) => a.intentIndex - b.intentIndex)
    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: weight }
  }

  /** tpsl 订单各自成组（一个 action 只有一个 grouping）；其余按 ALO / 非 ALO 分两批（官方建议分批，纯 ALO 批次被优先处理）。 */
  private groupActions(items: Planned[]): Planned[][] {
    const out: Planned[][] = []
    const alo: Planned[] = []
    const rest: Planned[] = []
    for (const p of items) {
      if (p.built.grouping !== 'na') { out.push([p]); continue }
      const w = p.built.orders[0]!
      const isAlo = 'limit' in w.t && w.t.limit.tif === 'Alo'
      ;(isAlo ? alo : rest).push(p)
    }
    if (alo.length) out.push(alo)
    if (rest.length) out.push(rest)
    return out
  }

  private async sendOrders(ctx: TradeContext, wires: WireOrder[], grouping: WireGrouping, builder: { b: Hex; f: number } | undefined, expiresAfter: number | undefined):
    Promise<{ statuses: unknown[]; problem?: Problem; raw: unknown }> {
    try {
      const res = await this.client(ctx, 'order').order(
        { orders: wires as never, grouping, ...(builder ? { builder } : {}) },
        this.opts(ctx, expiresAfter),
      )
      const statuses = readAmendStatuses(res)
      return statuses?.length === wires.length
        ? { statuses, raw: res }
        : { statuses: [], problem: outcomeUnknownProblem('unrecognized exchange order outcome; query by clientOrderId before retrying'), raw: res }
    } catch (e) {
      if (e instanceof ApiRequestError) {
        const resp = e.response
        const statuses = readAmendStatuses(resp)
        if (statuses?.length === wires.length) return { statuses, raw: resp }
        if (resp !== null && typeof resp === 'object') {
          const error = resp as { status?: unknown; response?: unknown }
          if (error.status === 'err' && typeof error.response === 'string') {
            return { statuses: [], problem: problemFromVenueMessage(error.response), raw: resp }
          }
        }
        return { statuses: [], problem: outcomeUnknownProblem('unrecognized exchange order outcome; query by clientOrderId before retrying'), raw: resp }
      }
      if (e instanceof HlHttpError || e instanceof HlNetworkError) {
        if (e instanceof HlHttpError && e.status >= 200 && e.status < 300) {
          return { statuses: [], problem: outcomeUnknownProblem('unrecognized exchange order outcome; query by clientOrderId before retrying'), raw: { error: e.message } }
        }
        return { statuses: [], problem: this.errorProblem(e), raw: { error: e.message } }
      }
      return { statuses: [], problem: outcomeUnknownProblem('unrecognized exchange order outcome; query by clientOrderId before retrying'), raw: { error: e instanceof Error ? e.message : String(e) } }
    }
  }

  private errorProblem(e: unknown): Problem {
    if (e instanceof HlHttpError || e instanceof HlNetworkError) return problemFromTransportError(e, 'exchange')
    return makeProblem('INTERNAL', e instanceof Error ? e.message : String(e))
  }

  // ───────────── 回执映射 ─────────────

  private ackFromStatus(st: unknown, base: { intentIndex: number; role: OrderRole; clientOrderId: string }, builderAttached: boolean): OrderAck {
    const builder = this.builderInfo(builderAttached)
    if (st === 'waitingForTrigger' || st === 'waitingForFill') {
      return { ...base, venueOrderId: null, status: 'untriggered', filledSize: normalizeDecimal('0'), avgFillPrice: null, builder }
    }
    if (st === null || typeof st !== 'object' || Array.isArray(st)) {
      return this.problemAck(base, outcomeUnknownProblem('unrecognized exchange order status; query by clientOrderId before retrying'))
    }
    const o = st as { resting?: unknown; filled?: unknown; error?: unknown }
    const hasResting = Object.hasOwn(o, 'resting')
    const hasFilled = Object.hasOwn(o, 'filled')
    const hasError = Object.hasOwn(o, 'error')
    if (Number(hasResting) + Number(hasFilled) + Number(hasError) !== 1) {
      return this.problemAck(base, outcomeUnknownProblem('conflicting exchange order status; query by clientOrderId before retrying'))
    }
    if (hasError) return typeof o.error === 'string'
      ? this.problemAck(base, problemFromVenueMessage(o.error))
      : this.problemAck(base, outcomeUnknownProblem('unrecognized exchange order status; query by clientOrderId before retrying'))
    if (hasResting) {
      const resting = o.resting as { oid?: unknown } | null
      if (resting === null || typeof resting !== 'object' || !validVenueOrderId(resting.oid)) {
        return this.problemAck(base, outcomeUnknownProblem('incomplete exchange order status; query by clientOrderId before retrying'))
      }
      return { ...base, venueOrderId: String(resting.oid), status: 'open', filledSize: normalizeDecimal('0'), avgFillPrice: null, builder }
    }
    const filled = o.filled as { oid?: unknown; totalSz?: unknown; avgPx?: unknown } | null
    if (filled === null || typeof filled !== 'object' || !validVenueOrderId(filled.oid)) {
      return this.problemAck(base, outcomeUnknownProblem('incomplete exchange order status; query by clientOrderId before retrying'))
    }
    const size = parseNonNegativeDecimal(filled.totalSz)
    const price = parseNonNegativeDecimal(filled.avgPx)
    if (size === undefined || price === undefined || !isPositiveDecimal(price)) {
      return this.problemAck(base, outcomeUnknownProblem('invalid exchange fill details; query by clientOrderId before retrying'))
    }
    return { ...base, venueOrderId: String(filled.oid), status: 'filled', filledSize: size, avgFillPrice: price, builder }
  }

  private problemAck(base: { intentIndex: number; role: OrderRole; clientOrderId: string }, problem: Problem): OrderAck {
    const unknown = problem.code === 3006
    return {
      ...base, venueOrderId: null, status: unknown ? 'unknown' : 'rejected',
      filledSize: normalizeDecimal('0'), avgFillPrice: null, builder: this.builderInfo(false), problem,
    }
  }

  private rejectedAck(intentIndex: number, clientOrderId: string, problem: Problem, role: OrderRole): OrderAck {
    return this.problemAck({ intentIndex, role, clientOrderId }, problem)
  }

  private builderInfo(attached: boolean): OrderAck['builder'] {
    return attached ? { attached: true, feeTenthBps: BUILDER_FEE_TENTH_BPS } : { attached: false }
  }

  /** 产品默认免费：supportDeveloper 打开 + 配了收费地址 + 账户 builder 授权为 approved，三者齐备才附 1 bp builder；其余一律不附，照常下单。 */
  builderFor(ctx: TradeContext): { b: Hex; f: number } | undefined {
    if (this.d.supportDeveloper !== true || !this.d.builderAddress || ctx.account.builder?.status !== 'approved') return undefined
    return { b: this.d.builderAddress.toLowerCase() as Hex, f: BUILDER_FEE_TENTH_BPS }
  }

  // ───────────── 改单 / 撤单 ─────────────

  async amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    let built: BuiltOrder
    try {
      const q = this.d.market.quote(req.instrumentId)
      built = buildOrder(req.order, this.d.market.getRecord(req.instrumentId), {
        ...(q ? { bid: q.bid, ask: q.ask, mid: q.last ?? (q.bid + q.ask) / 2, stale: q.stale } : {}),
      })
      if (built.orders.length > 1) throw new OrderBuildError(makeProblem('ORDER_TYPE_UNSUPPORTED', 'amend does not support attached tpsl'))
    } catch (e) {
      if (!(e instanceof OrderBuildError)) throw e
      return { acks: [this.rejectedAck(0, req.clientOrderId ?? '', e.problem, 'parent')], receiptHash: sha256(e.problem.message), requestWeight: 0 }
    }
    const oid: number | Hex | undefined = req.venueOrderId !== undefined ? Number(req.venueOrderId) : req.clientOrderId ? (`0x${req.clientOrderId}` as Hex) : undefined
    if (oid === undefined) {
      const p = makeProblem('INVALID_PARAMS', 'amend needs venueOrderId or clientOrderId')
      return { acks: [this.rejectedAck(0, '', p, 'parent')], receiptHash: sha256(p.message), requestWeight: 0 }
    }
    const base = { intentIndex: 0, role: 'parent' as const, clientOrderId: built.clientOrderId }
    try {
      const res: unknown = await this.client(ctx, 'modify').modify({ oid, order: built.orders[0] as never }, this.opts(ctx, req.order.expiresAt))
      const statuses = readAmendStatuses(res) ?? []
      if (statuses[0] !== 'success') {
        const problem = amendStatusProblem(statuses[0])
        return { acks: [this.problemAck(base, problem)], receiptHash: sha256(problem.venue?.message ?? problem.message), requestWeight: 1 }
      }
      const ack: OrderAck = { ...base, venueOrderId: req.venueOrderId ?? null, status: 'open', filledSize: normalizeDecimal('0'), avgFillPrice: null, builder: this.builderInfo(false) }
      return { acks: [ack], receiptHash: sha256(JSON.stringify(res, jsonSafe)), requestWeight: 1 }
    } catch (e) {
      let problem: Problem
      if (e instanceof ApiRequestError) {
        const statuses = readAmendStatuses(e.response)
        if (Array.isArray(statuses)) problem = amendStatusProblem(statuses[0])
        else {
          const response = e.response as { response?: unknown } | undefined
          problem = problemFromVenueMessage(typeof response?.response === 'string' ? response.response : e.message)
        }
      } else {
        problem = this.errorProblem(e)
      }
      return { acks: [this.problemAck(base, problem)], receiptHash: sha256(problem.venue?.message ?? problem.message), requestWeight: 1 }
    }
  }

  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = new Array(targets.length)
    const byOid: Array<{ i: number; a: number; o: number }> = []
    const byCloid: Array<{ i: number; asset: number; cloid: Hex }> = []
    targets.forEach((t, i) => {
      const rec = this.d.market.getRecord(t.instrumentId)
      if (!rec) { out[i] = { target: t, ok: false, problem: makeProblem('INSTRUMENT_UNKNOWN', `unknown instrument ${t.instrumentId}`) }; return }
      if (t.venueOrderId !== undefined) byOid.push({ i, a: rec.assetId, o: Number(t.venueOrderId) })
      else if (t.clientOrderId) byCloid.push({ i, asset: rec.assetId, cloid: `0x${t.clientOrderId}` as Hex })
      else out[i] = { target: t, ok: false, problem: makeProblem('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId') }
    })
    const settle = async (idx: number[], run: () => Promise<unknown>) => {
      try {
        const res = (await run()) as { response?: { data?: { statuses?: unknown[] } } }
        this.mapCancel(targets, out, idx, res?.response?.data?.statuses)
      } catch (e) {
        if (e instanceof ApiRequestError) {
          const resp = e.response as { response?: unknown } | undefined
          const statuses = (resp?.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses
          if (Array.isArray(statuses)) { this.mapCancel(targets, out, idx, statuses); return }
          const text = typeof resp?.response === 'string' ? resp.response : e.message
          for (const i of idx) out[i] = { target: targets[i]!, ok: false, problem: problemFromVenueMessage(text) }
          return
        }
        const p = this.errorProblem(e)
        for (const i of idx) out[i] = { target: targets[i]!, ok: false, problem: p }
      }
    }
    const client = this.client(ctx, 'cancel')
    const opts = this.opts(ctx)
    if (byOid.length) await settle(byOid.map((x) => x.i), () => client.cancel({ cancels: byOid.map(({ a, o }) => ({ a, o })) }, opts))
    if (byCloid.length) await settle(byCloid.map((x) => x.i), () => client.cancelByCloid({ cancels: byCloid.map(({ asset, cloid }) => ({ asset, cloid })) }, opts))
    return out
  }

  private mapCancel(targets: CancelTarget[], out: CancelAck[], idx: number[], statuses: unknown[] | undefined): void {
    idx.forEach((i, k) => {
      const st = statuses?.[k]
      if (st === 'success') out[i] = { target: targets[i]!, ok: true }
      else if (st && typeof st === 'object' && typeof (st as { error?: unknown }).error === 'string') {
        out[i] = { target: targets[i]!, ok: false, problem: problemFromVenueMessage((st as { error: string }).error) }
      } else out[i] = { target: targets[i]!, ok: false, problem: venueProblem('VENUE_REJECTED', 'unrecognized cancel status from venue', JSON.stringify(st ?? null)) }
    })
  }

  /** 全撤是模拟的：先列挂单再逐单撤（能力声明 cancelAll: emulated）。 */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    const open = await this.d.openOrders(ctx.account)
    const targets = open.filter((o) => !instrumentId || o.instrumentId === instrumentId).map((o) => ({ instrumentId: o.instrumentId, venueOrderId: o.venueOrderId }))
    return targets.length ? this.cancel(ctx, targets) : []
  }

  // ───────────── 杠杆 ─────────────

  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    await this.updateLeverage(ctx, instrumentId, leverage, marginMode)
  }

  private async updateLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated', intentExpiry?: number): Promise<void> {
    const rec = this.d.market.getRecord(instrumentId)
    if (!rec) throw new OrderBuildError(makeProblem('INSTRUMENT_UNKNOWN', `unknown instrument ${instrumentId}`))
    if (!Number.isInteger(leverage) || leverage < 1) throw new OrderBuildError(makeProblem('INVALID_PARAMS', 'leverage must be an integer >= 1'))
    try {
      await this.client(ctx, 'updateLeverage').updateLeverage({ asset: rec.assetId, isCross: marginMode === 'cross', leverage }, this.opts(ctx, intentExpiry))
    } catch (e) {
      throw this.asProblemError(e)
    }
    this.leverageSet.set(`${ctx.account.address}:${instrumentId}`, `${marginMode}:${leverage}`)
  }

  private async ensureLeverage(ctx: TradeContext, intent: OrderIntent): Promise<Problem | null> {
    if (intent.leverage === undefined) return null
    const mode = intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated' || intent.marginMode === 'noCross' ? 'isolated' : 'cross'
    if (this.leverageSet.get(`${ctx.account.address}:${intent.instrumentId}`) === `${mode}:${intent.leverage}`) return null
    try {
      await this.updateLeverage(ctx, intent.instrumentId, intent.leverage, mode, intent.expiresAt)
      return null
    } catch (e) {
      return e instanceof ProblemError ? e.problem : this.errorProblem(e)
    }
  }

  private asProblemError(e: unknown): Error {
    if (e instanceof ApiRequestError) {
      const resp = e.response as { response?: unknown } | undefined
      return new ProblemError(problemFromVenueMessage(typeof resp?.response === 'string' ? resp.response : e.message))
    }
    return new ProblemError(this.errorProblem(e))
  }

  // ───────────── 场所级死人开关 ─────────────

  /**
   * scheduleCancel：到点撤销全部挂单（持仓不动）。atMs = null 清除。
   * 官方限制：时间须在 5 秒之后；每天最多触发 10 次（触发 = 到点真的撤了，刷新不算——刷新是否计入次数待核）。
   */
  async scheduleCancel(ctx: TradeContext, atMs: number | null): Promise<void> {
    if (atMs !== null && atMs < this.clock() + SCHEDULE_CANCEL_MIN_LEAD_MS) {
      throw new OrderBuildError(makeProblem('INVALID_PARAMS', `scheduleCancel time must be at least ${SCHEDULE_CANCEL_MIN_LEAD_MS / 1000} s in the future`))
    }
    try {
      const c = this.client(ctx, 'scheduleCancel')
      const opts = this.opts(ctx)
      if (atMs === null) await c.scheduleCancel({ time: undefined }, opts)
      else await c.scheduleCancel({ time: atMs }, opts)
    } catch (e) {
      throw this.asProblemError(e)
    }
  }

  /** 自动续期由内核统一负责；此兼容入口不再启动本地定时器或请求。 */
  armDeadman(_ctx: TradeContext, _opts: { delaySec?: number; onError?: (e: Error) => void } = {}): DeadmanHandle {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'automatic deadman renewal is disabled; use kernel scheduleCancel'))
  }

  // ───────────── 内部 ─────────────

  /** 每次调用造一个轻量 ExchangeClient：钱包是内核句柄的包装，传输层是带权重预算的 HlHttp。 */
  private client(ctx: TradeContext, purpose: string): ExchangeClient {
    const wallet = {
      address: ctx.signer.address,
      signTypedData: async (params: Parameters<TradeContext['signer']['signTypedData']>[0], options?: unknown) => {
        const sig = await ctx.signer.signTypedData(params, options)
        const ev: SignedEvent = {
          purpose,
          digest: sha256(JSON.stringify({ primaryType: params.primaryType, message: params.message }, jsonSafe)),
          signer: ctx.signer.address,
          ts: this.clock(),
        }
        ctx.onSigned?.(ev)
        return sig
      },
    }
    return new ExchangeClient({
      transport: this.d.http.exchangeTransport(ctx.account.vaultAddress ?? ctx.account.address) as never,
      wallet: wallet as never,
      nonceManager: (addr: string) => this.d.nonce.next(addr),
      ...(ctx.account.vaultAddress ? { defaultVaultAddress: ctx.account.vaultAddress } : {}),
    })
  }

  private opts(ctx: TradeContext, optionalIntentExpiry?: number): { expiresAfter?: number; signal?: AbortSignal } {
    const gateExpiry = ctx.gate?.expiresAt
    const deadline = gateExpiry !== undefined && optionalIntentExpiry !== undefined
      ? Math.min(gateExpiry, optionalIntentExpiry)
      : gateExpiry ?? optionalIntentExpiry
    if (deadline === undefined) {
      return { ...(ctx.signal ? { signal: ctx.signal } : {}) }
    }
    const serverClockOffsetMs = this.d.http.serverClockOffsetMs ?? 0
    const expiresAfter = deadline + serverClockOffsetMs
    this.onDiagnostic({
      event: 'venue_expiry_prepared',
      localExpiresAt: deadline,
      serverClockOffsetMs,
      venueExpiresAt: expiresAfter,
    })
    return {
      expiresAfter,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }
  }
}

