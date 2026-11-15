// SPDX-License-Identifier: CPAL-1.0
// host.market.fundingHistory 的内核侧：数据取自场所连接器的公开资金费历史（Hyperliquid /info fundingHistory、币安 /fapi/v1/fundingRate），
// 只读、不需要钥匙、不碰账户；翻页限速（<= 2 次/秒）由连接器负责。拿不到就如实报错——引擎（回测）收到错误会把 funding 降级为 false 并写进 warnings，
// 这里不编造、不补零。
import { makeProblem } from './proto'
import type { FundingRatePoint, InstrumentId, Ms } from './proto'
import type { VenueConnector } from '@gitrader/protocol/connector'
import { KernelError } from './util/errors'

export interface FundingHistoryResult { points: FundingRatePoint[]; complete: boolean }

type FundingCapable = VenueConnector & { fundingHistory?: (id: InstrumentId, opts: { from: Ms; to?: Ms }) => Promise<FundingRatePoint[]> }

const invalid = (message: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', message))
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * 取 [from, to] 的资金费点（升序、按时间去重）。
 * - 场所没有公开资金费历史 -> CAPABILITY_UNSUPPORTED；连接器自己的错误（上游不可达等）原样抛出。
 * - 连接器给的行里，时间不合法或费率不是有限十进制的丢掉，并把 complete 记为 false（部分缺失）；区间外的多余行直接丢，不算缺失。
 */
export async function fundingHistoryFor(
  bus: { marketSource(venue: string): VenueConnector | undefined },
  params: { instrumentId?: unknown; from?: unknown; to?: unknown },
): Promise<FundingHistoryResult> {
  const id = String(params.instrumentId ?? '')
  const colon = id.indexOf(':')
  if (colon <= 0) throw invalid(`instrumentId must look like venue:SYMBOL (got ${JSON.stringify(id)})`)
  if (!isMs(params.from)) throw invalid('from must be a non-negative integer (ms)')
  if (params.to !== undefined && (!isMs(params.to) || params.to < params.from)) throw invalid('to must be an integer (ms) not before from')
  const from = params.from
  const to = params.to
  const src = bus.marketSource(id.slice(0, colon)) as FundingCapable | undefined
  if (!src) throw new KernelError(makeProblem('DATA_UNAVAILABLE', `no market source for ${id}`))
  if (typeof src.fundingHistory !== 'function') throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', `${src.venue} has no public funding history`))
  const rows = await src.fundingHistory(id as InstrumentId, { from, ...(to !== undefined ? { to } : {}) })
  let complete = true
  const byTime = new Map<number, FundingRatePoint>()
  for (const row of Array.isArray(rows) ? rows : []) {
    const t = (row as { t?: unknown })?.t
    const rate = (row as { rate?: unknown })?.rate
    if (!isMs(t) || typeof rate !== 'string' || rate.trim() === '' || !Number.isFinite(Number(rate))) { complete = false; continue }
    if (t < from || (to !== undefined && t > to)) continue
    byTime.set(t, row)
  }
  return { points: [...byTime.values()].sort((a, b) => a.t - b.t), complete }
}
