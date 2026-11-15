// SPDX-License-Identifier: CPAL-1.0
// UX-20 显示层：规则命中里金额类的「实际」最多保留 2 位小数。
import { describe, expect, it } from 'vitest'
import { ruleText } from '../src/model-activity'

describe('UX-20 金额两位小数', () => {
  it('USDC 的实际值 123.456789 → 123.46', () => {
    const line = ruleText({ code: 'MAX_NOTIONAL', limit: 100, actual: 123.456789, unit: 'USDC', message: '' } as never)
    expect(line).toMatch(/123\.46/)
    expect(line).not.toMatch(/123\.4567/)
  })
})
