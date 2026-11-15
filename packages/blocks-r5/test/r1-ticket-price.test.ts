// SPDX-License-Identifier: CPAL-1.0
// release-r1 P0-3：下单票预填价必须能过内核的精度校验。
// 「精度不对」来自内核 normalize.ts 的 normalizePrice（rounding:'reject' 时价格超精度 → 1002 PRECISION）；
// 这里直接拿那条规则去验 ticket.tsx 的 prefillPrice（formatPrice + 价格规则），不另抄一份规则。
import type { Instrument, InstrumentPriceRule } from '@gitrader/protocol/types'
import { describe, expect, it } from 'vitest'
import { normalizePrice } from '../../kernel/src/normalize'
import { prefillPrice, withPriceRule } from '../src/views/ticket'

const HL_BTC: InstrumentPriceRule = { sigFigs: 5, maxDecimals: 1 } // HL：5 位有效数字，小数位 = 6 − szDecimals(5)
const HL_ALT: InstrumentPriceRule = { sigFigs: 5, maxDecimals: 6 }
const inst = (price: InstrumentPriceRule) => ({ instrumentId: 'hyperliquid:X', price }) as unknown as Instrument
/** 内核那条规则：合法 → 原样返回；超精度 → 抛 PRECISION。 */
const kernelAccepts = (value: string, rule: InstrumentPriceRule): boolean => {
  try { return normalizePrice(inst(rule), value as never, 'buy', 'reject') === value } catch { return false }
}

describe('release-r1 P0-3 下单票预填价', () => {
  it('中间价位数超限（77315.5 是 6 位有效数字）→ 内核拒；预填值截成合法的 77315', () => {
    expect(kernelAccepts('77315.5', HL_BTC)).toBe(false)
    expect(prefillPrice('77315.5', HL_BTC)).toBe('77315')
  })

  it('截断后的值都能通过内核那条精度校验（含目录没到时的 5 位有效数字退回规则）', () => {
    const cases: Array<[string, InstrumentPriceRule | undefined, InstrumentPriceRule]> = [
      ['77315.5', HL_BTC, HL_BTC], ['123456.789', HL_BTC, HL_BTC], ['99999.9', HL_BTC, HL_BTC], ['3456.789', HL_BTC, HL_BTC],
      ['0.123456', HL_ALT, HL_ALT], ['0.00012345678', HL_ALT, HL_ALT], ['12.34567', HL_ALT, HL_ALT],
      ['77315.5', undefined, HL_BTC], ['3456.789', undefined, { sigFigs: 5, maxDecimals: 2 }], ['0.123456', undefined, HL_ALT],
    ]
    for (const [raw, given, kernelRule] of cases) {
      const v = prefillPrice(raw, given)
      expect(v, `${raw} → ${v}`).not.toContain(',')
      expect(kernelAccepts(v, kernelRule), `${raw} → ${v}`).toBe(true)
    }
  })

  it('已经合法的值原样保留', () => {
    for (const v of ['77316', '12345', '1234.5', '123.4', '0.12345']) {
      const rule = Number(v) >= 1 ? HL_BTC : HL_ALT
      expect(kernelAccepts(v, rule), v).toBe(true)
      expect(prefillPrice(v, rule), v).toBe(v)
    }
  })

  it('精度被拒那一行补上规则和例子，括号里的内核原文保留；别的拒绝原样', () => {
    const line = '价格或数量精度不对（price 77315.5 exceeds allowed precision (5 significant figures, max 1 decimals)）'
    expect(withPriceRule(line, 'BTC', HL_BTC, '77315.5')).toBe(`价格或数量精度不对：BTC 价格最多 5 位有效数字，例如 77315${line.slice('价格或数量精度不对'.length)}`)
    expect(withPriceRule('余额不足（insufficient margin）', 'BTC', HL_BTC, '77315.5')).toBe('余额不足（insufficient margin）')
    expect(withPriceRule(line, 'BTC', undefined, '77315.5')).toBe(line)
    expect(withPriceRule(null, 'BTC', HL_BTC, '1')).toBeNull()
  })
})
