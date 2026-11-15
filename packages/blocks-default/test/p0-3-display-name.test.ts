// SPDX-License-Identifier: CPAL-1.0
// 显示名：标的表给了 displaySymbol 就用它；没给就由 instrumentId 推，dex 前缀（a:b）保留。
import { describe, expect, it } from 'vitest'
import { displayNameOf } from '../src/util'

describe('displayNameOf', () => {
  it('prefers displaySymbol', () => {
    expect(displayNameOf('hyperliquid:BTC', 'BTC-PERP')).toBe('BTC-PERP')
    expect(displayNameOf('hyperliquid:sekaw:BTC', 'sekaw:BTC-PERP')).toBe('sekaw:BTC-PERP')
    expect(displayNameOf('hyperliquid:BTC', '')).toBe('BTC')
    expect(displayNameOf('hyperliquid:BTC', null)).toBe('BTC')
  })

  it('keeps dex prefix from instrument id', () => {
    expect(displayNameOf('hyperliquid:sekaw:BTC')).toBe('sekaw:BTC')
  })

  it('main market strips venue', () => {
    expect(displayNameOf('hyperliquid:BTC')).toBe('BTC')
    expect(displayNameOf('BTC')).toBe('BTC')
  })
})
