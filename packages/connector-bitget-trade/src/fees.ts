// SPDX-License-Identifier: CPAL-1.0
// Bitget 手续费拆解：上游把「扣费」写成负数，并且同一笔成交可能扣两种币（BGB 抵扣 + 结算币）。
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bitget_fees.py:7-59; adapted.
//
// 三种真实形状（都实测出现过）：
//   1) `feeDetail.newFees = { d, r }`：d = 抵扣币（BGB）扣费，r = 收取币扣费（QD bitget_fees.py:15-24）；
//   2) `feeDetail = [{ feeCoin, totalFee }]` 列表（逐币）；
//   3) `feeDetail = '{"feeCoin":..,"totalFee":..}'` JSON 字符串，或按币种为键的字典。
// 符号统一成「正 = 付出」：上游负数是扣费，取反后与协议一致（QD bitget_fees.py:48-51）。
// 金额全走 @gitrader/protocol 的 decimal：`String(5e-8)` = "5e-8"，浮点写法会让 asDecimal 抛错，
// 一行小额 BGB 抵扣就能让整批成交失败。多币不相加（QD fee_storage：多币 → '0' + 'MIXED'）。
import { asDecimal, normalizeDecimal } from '@gitrader/protocol'
import type { Decimal } from '@gitrader/protocol'
import { addDec, cmpDec, subDec } from '@gitrader/protocol/decimal'

/** 上游金额 → 正 = 付出；解析不了返回 undefined（调用方跳过该项）。 */
function negAmount(value: unknown): Decimal | undefined {
  if (value === undefined || value === null || value === '') return undefined
  try {
    return subDec('0', normalizeDecimal(String(value).trim()))
  } catch {
    return undefined
  }
}

function accrue(out: Record<string, Decimal>, currency: string, amount: Decimal): void {
  const current = out[currency]
  out[currency] = current === undefined ? amount : addDec(current, amount)
}

/** 上游 feeDetail → { 币种: 金额 }（正 = 付出，与协议一致）。空 / 解析不了返回 {}。 */
export function feeBreakdown(raw: unknown, opts: { receivedCurrency?: string } = {}): Record<string, Decimal> {
  const received = (opts.receivedCurrency ?? '').toUpperCase()
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return {}
    }
  }
  if (value === null || typeof value !== 'object') return {}

  if (!Array.isArray(value) && isRecord(value) && isRecord((value as { newFees?: unknown }).newFees)) {
    const details = (value as { newFees: Record<string, unknown> }).newFees
    const out: Record<string, Decimal> = {}
    const deducted = negAmount(details['d'])
    if (deducted !== undefined && cmpDec(deducted, '0') !== 0) out['BGB'] = deducted
    const charged = negAmount(details['r'])
    if (charged !== undefined) out[received === '' ? 'UNKNOWN' : received] = charged
    return out
  }

  const entries: Record<string, unknown>[] = []
  if (Array.isArray(value)) {
    for (const entry of value) if (isRecord(entry)) entries.push(entry)
  } else if (isRecord(value)) {
    const single = value as Record<string, unknown>
    if ('totalFee' in single || 'fee' in single) {
      entries.push(single)
    } else {
      for (const [key, entry] of Object.entries(single)) {
        if (isRecord(entry)) entries.push({ ...(entry as Record<string, unknown>), feeCoin: (entry as Record<string, unknown>)['feeCoinCode'] ?? key })
      }
    }
  }

  const out: Record<string, Decimal> = {}
  for (const entry of entries) {
    const currency = String(entry['feeCoin'] ?? entry['feeCcy'] ?? entry['feeCoinCode'] ?? received ?? 'UNKNOWN').toUpperCase()
    const amount = negAmount(entry['totalFee'] ?? entry['fee'])
    if (amount === undefined) continue
    accrue(out, currency, amount)
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bitget_fees.py:55-60; adapted.
/** 单币种口径：{ fee, feeCcy }；无币种 → { '0', '' }；多币种 → { '0', 'MIXED' }（不把不同币相加）。 */
export function feeStorage(raw: unknown, opts: { receivedCurrency?: string } = {}): { fee: Decimal; feeCcy: string } {
  const fees = feeBreakdown(raw, opts)
  const keys = Object.keys(fees)
  if (keys.length === 1) {
    const currency = keys[0]!
    return { fee: fees[currency]!, feeCcy: currency }
  }
  if (keys.length === 0) return { fee: asDecimal('0'), feeCcy: '' }
  return { fee: asDecimal('0'), feeCcy: 'MIXED' }
}

/** 一笔成交的费率（优先 feeDetail，回落 fee / feeCoin 平铺字段，照 QD bitget.py:1078-1088）。 */
export function feeOfFill(row: Record<string, unknown>, opts: { receivedCurrency?: string } = {}): Record<string, Decimal> {
  const detail = feeBreakdown(row['feeDetail'], opts)
  if (Object.keys(detail).length > 0) return detail
  // 平铺字段两种拼写都见过：fill*（WS 通道，QD normalizers.py:219-223）与 fee / feeCoin（REST 成交）。
  const flatFee = row['fee'] ?? row['fillFee']
  const flatCcy = row['feeCoin'] ?? row['feeCcy'] ?? row['fillFeeCoin']
  const flat = feeBreakdown({ fee: flatFee, feeCoin: flatCcy }, opts)
  return flat
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
