// SPDX-License-Identifier: CPAL-1.0
// research.portfolio：账户组合分析（估值 / 敞口 / 集中度）。账户必须在调用方授权书覆盖范围内；只读，不下单、不写账本。
// 估值 / 敞口 / 集中度的算术全部来自 @gitrader/portfolio（十进制字符串，不碰浮点）。取不到的东西（标的元数据、标记价、汇率）
// 一律列进 missing 并从汇总里剔除，绝不当 0 参与。
import { analyzePortfolio, staticPriceSource } from '@gitrader/portfolio'
import type { ConcentrationReport, ExposureBucket, ValuedPosition } from '@gitrader/portfolio'
import type { Kernel } from '../kernel'
import { makeProblem } from '../proto'
import type { Instrument, Position } from '../proto'
import { KernelError } from '../util/errors'

const MAX_POSITIONS = 200
const bucket = (b: ExposureBucket) => ({ key: b.key, gross: b.gross, net: b.net, long: b.long, short: b.short, quantity: b.quantity, positionCount: b.positionCount })
const conc = (c: ConcentrationReport) => ({ gross: c.gross, hhi: c.hhi, effectiveN: c.effectiveN, top1: c.top1, top3: c.top3, top5: c.top5, largest: c.largest ? { key: c.largest.key, weight: c.largest.weight } : null })

export async function portfolioOf(k: Kernel, accountId: string): Promise<Record<string, unknown>> {
  const acct = k.accounts.get(accountId)
  const snap = await k.bus.snapshot(acct, { maxAgeMs: 3000 })
  const byId = new Map<string, Instrument>(k.bus.instruments().map((i) => [i.instrumentId, i]))
  const ccy = acct.paper?.ccy ?? byId.get(snap.positions[0]?.instrumentId ?? '')?.quote ?? 'USD'
  const missing: string[] = []
  const usable: Position[] = []
  const instruments: Instrument[] = []
  for (const p of snap.positions) {
    const ins = byId.get(p.instrumentId)
    if (!ins) { missing.push(`unknown_instrument: ${p.instrumentId}`); continue }
    if (ins.settlement !== 'linear') { missing.push(`unsupported_settlement: ${p.instrumentId}`); continue }
    if (!(Number(p.markPrice) > 0)) { missing.push(`missing_price: ${p.instrumentId}`); continue }
    if (ins.quote !== ccy) { missing.push(`missing_fx: ${ins.quote}/${ccy}`); continue }
    usable.push(p)
    if (!instruments.includes(ins)) instruments.push(ins)
  }
  let a
  try {
    a = analyzePortfolio({ positions: usable, instruments, valuationCcy: ccy, prices: staticPriceSource(Object.fromEntries(usable.map((p) => [p.instrumentId, p.markPrice]))), onMissingPrice: 'skip' })
  } catch (e) {
    throw new KernelError(makeProblem('INTERNAL', `portfolio analysis failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  const pos = (v: ValuedPosition) => ({ instrumentId: v.instrumentId, venue: v.venue, side: v.side, size: v.size, markPrice: v.markPrice, grossExposure: v.grossExposure, signedExposure: v.signedExposure, unrealizedPnl: v.unrealizedPnl, realizedPnl: v.realizedPnl, funding: v.funding, strategyId: v.strategyId })
  const v = a.valuation
  return {
    accountId: acct.accountId,
    ccy,
    valuation: {
      total: snap.equity, available: snap.available, asOf: snap.ts, cost: v.cost, grossExposure: v.grossExposure, netExposure: v.netExposure, unrealizedPnl: v.unrealizedPnl, realizedPnl: v.realizedPnl, funding: v.funding,
      positions: v.positions.slice(0, MAX_POSITIONS).map(pos), ...(v.positions.length > MAX_POSITIONS ? { positionsOmitted: v.positions.length - MAX_POSITIONS } : {}),
    },
    exposure: { totals: bucket(a.exposure.totals), byAsset: a.exposure.byAsset.slice(0, 20).map(bucket), byVenue: a.exposure.byVenue.map(bucket), byDirection: a.exposure.byDirection },
    concentration: { byAsset: conc(a.concentration.byAsset), byVenue: conc(a.concentration.byVenue), byInstrument: conc(a.concentration.byInstrument) },
    missing: [...missing, ...v.unpriced.map((id) => `missing_price: ${id}`)],
  }
}
