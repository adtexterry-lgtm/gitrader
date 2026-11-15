// SPDX-License-Identifier: CPAL-1.0
// 持仓差异：按标的 × 方向 × 保证金模式比，数量比较带容差。
//
// 三个刻意的设计点：
//   1. 按方向比，不只比净额：净额相同但一边是「多 1 空 1」、另一边是「平」，含义完全不同；
//      场所按双向持仓报两条腿而账本是净额（或反之）时，数量比较没有意义，单独报「持仓形状不符」。
//   2. 保证金模式单独报：它改不了数量，却改变强平价与可用额度。
//   3. 差额若能由「推断成交」解释，就在 tags 里写明 —— 仍然要人确认，但不让人重算一遍。
// 设计参照：nautilus_trader crates/live/src/execution/reconciliation.rs（PositionQuantityComparison：
//           净额与分方向数量都比，方向报告存在时按方向判，另判 report_shape）@55c0e820
import { adviceFor, severityFor } from './advice'
import { absDecimal, addDecimal, compareDecimal, normalizeDecimal, subtractDecimal, sumDecimal } from './decimal'
import { sizeEqual, priceDriftBeyondBps, type ResolvedOptions } from './tolerance'
import type {
  Evidence, Finding, FindingCode, LocalPositionView, MarginMode, PositionSide, ReconcileInput, Severity, VenuePositionView,
} from './types'

interface Leg {
  size: string
  entryPrice: string
  marginMode: MarginMode
}

function ev(report: Evidence['report'], id: string, field: string, value: string): Evidence {
  return { report, id, field, value }
}

function makeFinding(
  code: FindingCode,
  accountId: string,
  subject: Omit<Finding['subject'], 'accountId'>,
  detail: string,
  evidence: Evidence[],
  opts?: { severity?: Severity; tags?: string[]; why?: string },
): Finding {
  return {
    code,
    severity: severityFor(code, opts?.severity),
    subject: { accountId, ...subject },
    detail,
    advice: adviceFor(code, opts?.why === undefined ? undefined : { why: opts.why }),
    evidence,
    ...(opts?.tags ? { tags: opts.tags } : {}),
  }
}

function legsOf(positions: readonly (LocalPositionView | VenuePositionView)[]): Map<string, Map<PositionSide, Leg>> {
  const out = new Map<string, Map<PositionSide, Leg>>()
  for (const p of positions) {
    const legMap = out.get(p.instrumentId) ?? new Map<PositionSide, Leg>()
    const existing = legMap.get(p.side)
    if (existing) {
      legMap.set(p.side, { size: addDecimal(existing.size, p.size), entryPrice: existing.entryPrice, marginMode: existing.marginMode })
    } else {
      legMap.set(p.side, { size: p.size, entryPrice: p.entryPrice, marginMode: p.marginMode })
    }
    out.set(p.instrumentId, legMap)
  }
  return out
}

function signedNet(legs: Map<PositionSide, Leg> | undefined): string {
  if (!legs) return '0'
  const long = legs.get('long')?.size ?? '0'
  const short = legs.get('short')?.size ?? '0'
  return subtractDecimal(long, short)
}

/** 某标的的推断成交净量（买入为正）。 */
export interface InferredNet {
  instrumentId: string
  signedSize: string
}

export function classifyPositions(
  input: ReconcileInput,
  opts: ResolvedOptions,
  inferred: readonly InferredNet[] = [],
): Finding[] {
  const accountId = input.local.accountId
  const findings: Finding[] = []
  const localLegs = legsOf(input.local.positions)
  const venueLegs = legsOf(input.venue.positions)
  const instruments = new Set<string>([...localLegs.keys(), ...venueLegs.keys()])
  const inferredByInstrument = new Map<string, string>()
  for (const item of inferred) {
    inferredByInstrument.set(item.instrumentId, addDecimal(inferredByInstrument.get(item.instrumentId) ?? '0', item.signedSize))
  }

  for (const instrumentId of instruments) {
    const local = localLegs.get(instrumentId)
    const venue = venueLegs.get(instrumentId)
    const localLong = local?.get('long')?.size ?? '0'
    const localShort = local?.get('short')?.size ?? '0'
    const venueLong = venue?.get('long')?.size ?? '0'
    const venueShort = venue?.get('short')?.size ?? '0'
    const localNet = signedNet(local)
    const venueNet = signedNet(venue)
    const localHasBoth = compareDecimal(localLong, '0') > 0 && compareDecimal(localShort, '0') > 0
    const venueHasBoth = compareDecimal(venueLong, '0') > 0 && compareDecimal(venueShort, '0') > 0
    const localAny = compareDecimal(localLong, '0') > 0 || compareDecimal(localShort, '0') > 0
    const venueAny = compareDecimal(venueLong, '0') > 0 || compareDecimal(venueShort, '0') > 0
    const evidenceBase: Evidence[] = [
      ev('local.positions', instrumentId, 'net', normalizeDecimal(localNet)),
      ev('venue.positions', instrumentId, 'net', normalizeDecimal(venueNet)),
    ]

    if (localHasBoth !== venueHasBoth && (localAny || venueAny)) {
      findings.push(makeFinding('position_shape_mismatch', accountId, { instrumentId },
        `持仓形状不符：账本多=${normalizeDecimal(localLong)} 空=${normalizeDecimal(localShort)}，场所多=${normalizeDecimal(venueLong)} 空=${normalizeDecimal(venueShort)}`,
        [
          ...evidenceBase,
          ev('local.positions', instrumentId, 'legs', `${local?.size ?? 0}`),
          ev('venue.positions', instrumentId, 'legs', `${venue?.size ?? 0}`),
        ]))
      // 形状不符时数量对比没有意义：不再按腿报缺失 / 方向 / 数量
      continue
    }

    const localSign = compareDecimal(localNet, '0')
    const venueSign = compareDecimal(venueNet, '0')
    if (localSign !== 0 && venueSign !== 0 && localSign !== venueSign) {
      findings.push(makeFinding('position_side_mismatch', accountId, { instrumentId },
        `方向相反：账本净 ${normalizeDecimal(localNet)}，场所净 ${normalizeDecimal(venueNet)}`,
        evidenceBase))
      continue
    }

    if (!venueAny && localAny) {
      findings.push(makeFinding('position_missing_at_venue', accountId, { instrumentId },
        `账本有持仓（多 ${normalizeDecimal(localLong)} / 空 ${normalizeDecimal(localShort)}），场所报无持仓`,
        [...evidenceBase, ev('local.positions', instrumentId, 'size', normalizeDecimal(addDecimal(localLong, localShort)))]))
      continue
    }
    if (!localAny && venueAny) {
      findings.push(makeFinding('position_missing_locally', accountId, { instrumentId },
        `场所有持仓（多 ${normalizeDecimal(venueLong)} / 空 ${normalizeDecimal(venueShort)}），账本没有`,
        [...evidenceBase, ev('venue.positions', instrumentId, 'size', normalizeDecimal(addDecimal(venueLong, venueShort)))]))
      continue
    }

    for (const side of ['long', 'short'] as const) {
      const ls = local?.get(side)
      const vs = venue?.get(side)
      const localSize = ls?.size ?? '0'
      const venueSize = vs?.size ?? '0'
      const localZero = compareDecimal(localSize, '0') === 0
      const venueZero = compareDecimal(venueSize, '0') === 0
      if (localZero && venueZero) continue
      if (localZero && !venueZero) {
        findings.push(makeFinding('position_missing_locally', accountId, { instrumentId },
          `场所 ${side} 持仓 ${normalizeDecimal(venueSize)}，账本这一侧为 0`, [
            ev('venue.positions', instrumentId, `${side}.size`, normalizeDecimal(venueSize)),
            ev('local.positions', instrumentId, `${side}.size`, '0'),
          ]))
        continue
      }
      if (!localZero && venueZero) {
        findings.push(makeFinding('position_missing_at_venue', accountId, { instrumentId },
          `账本 ${side} 持仓 ${normalizeDecimal(localSize)}，场所这一侧为 0`, [
            ev('local.positions', instrumentId, `${side}.size`, normalizeDecimal(localSize)),
            ev('venue.positions', instrumentId, `${side}.size`, '0'),
          ]))
        continue
      }
      if (!sizeEqual(localSize, venueSize, opts.positionTolerance)) {
        const diff = subtractDecimal(venueSize, localSize)
        const inferredSize = inferredByInstrument.get(instrumentId)
        const explained = inferredSize !== undefined && sizeEqual(addDecimal(localSize, absDecimal(inferredSize)), venueSize, opts.positionTolerance)
        findings.push(makeFinding('position_size_mismatch', accountId, { instrumentId },
          `数量不符（${side}）：账本 ${normalizeDecimal(localSize)}，场所 ${normalizeDecimal(venueSize)}，差 ${normalizeDecimal(diff)}（容差 ${opts.positionTolerance}）`,
          [
            ev('local.positions', instrumentId, `${side}.size`, normalizeDecimal(localSize)),
            ev('venue.positions', instrumentId, `${side}.size`, normalizeDecimal(venueSize)),
            ...(explained ? [ev('local.fills', instrumentId, 'inferred', normalizeDecimal(inferredSize ?? '0'))] : []),
          ], { tags: explained ? ['explained_by_inferred_fill'] : undefined }))
      } else if (ls && vs) {
        if (ls.marginMode !== vs.marginMode) {
          findings.push(makeFinding('position_margin_mode_mismatch', accountId, { instrumentId },
            `${side} 保证金模式不符：账本 ${ls.marginMode}，场所 ${vs.marginMode}`,
            [
              ev('local.positions', instrumentId, `${side}.marginMode`, ls.marginMode),
              ev('venue.positions', instrumentId, `${side}.marginMode`, vs.marginMode),
            ]))
        }
        if (priceDriftBeyondBps(vs.entryPrice, ls.entryPrice, opts.priceToleranceBps)) {
          findings.push(makeFinding('position_entry_price_drift', accountId, { instrumentId },
            `${side} 开仓均价有偏移：账本 ${normalizeDecimal(ls.entryPrice)}，场所 ${normalizeDecimal(vs.entryPrice)}（容差 ${opts.priceToleranceBps} bp）`,
            [
              ev('local.positions', instrumentId, `${side}.entryPrice`, normalizeDecimal(ls.entryPrice)),
              ev('venue.positions', instrumentId, `${side}.entryPrice`, normalizeDecimal(vs.entryPrice)),
            ]))
        }
      }
    }
  }
  return findings
}

/** 合并同标的的持仓（resulting size 与 entry 采用加权，仅供渲染摘要用，不参与判定）。 */
export function totalPositionSize(positions: readonly LocalPositionView[] | readonly VenuePositionView[]): string {
  return sumDecimal(positions.map((p) => p.size))
}
