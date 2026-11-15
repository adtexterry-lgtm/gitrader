// SPDX-License-Identifier: CPAL-1.0
// 参数校验验收：越界 / 类型 / 未知键 / 枚举一律拒（不静默夹范围），安全上限必须在每个模板的声明里。
import { describe, expect, it } from 'vitest'
import { validateParams } from '../src/params'
import { SAFETY_KEYS, assertSafetyDeclared, capsOf } from '../src/safety'
import { TEMPLATES, createBot, templateIds } from '../src/index'
import { GRID_PARAMS } from '../src/grid'
import { MARTINGALE_PARAMS } from '../src/martingale'
import { BotParamError } from '../src/errors'

describe('validateParams', () => {
  it('fills defaults when input is missing', () => {
    const res = validateParams(GRID_PARAMS, undefined)
    expect(res.ok).toBe(true)
    expect(res.params.gridCount).toBe(10)
    expect(res.params.gridMode).toBe('arithmetic')
    expect(res.params.maxExposureNotional).toBe(10_000)
  })

  it('rejects unknown keys instead of ignoring them', () => {
    const res = validateParams(GRID_PARAMS, { gridCount: 10, maxOpenOrders: 5 })
    expect(res.ok).toBe(false)
    expect(res.errors.join(' ')).toContain('unknown parameter')
  })

  it('rejects a value below min', () => {
    const res = validateParams(GRID_PARAMS, { gridCount: 1 })
    expect(res.ok).toBe(false)
    expect(res.errors.join(' ')).toContain('>= 2')
  })

  it('rejects a value above max', () => {
    const res = validateParams(GRID_PARAMS, { gridCount: 500 })
    expect(res.ok).toBe(false)
    expect(res.errors.join(' ')).toContain('<= 200')
  })

  it('rejects a fractional value for an integer parameter', () => {
    const res = validateParams(GRID_PARAMS, { gridCount: 2.5 })
    expect(res.ok).toBe(false)
    expect(res.errors.join(' ')).toContain('integer')
  })

  it('rejects a select value outside its options', () => {
    const res = validateParams(GRID_PARAMS, { gridMode: 'fibonacci' })
    expect(res.ok).toBe(false)
    expect(res.errors.join(' ')).toContain('must be one of')
  })

  it('rejects NaN and Infinity rather than coercing them', () => {
    expect(validateParams(GRID_PARAMS, { lowerPrice: Number.NaN }).ok).toBe(false)
    expect(validateParams(GRID_PARAMS, { lowerPrice: Number.POSITIVE_INFINITY }).ok).toBe(false)
    expect(validateParams(GRID_PARAMS, { gridMode: 3 }).ok).toBe(false)
  })

  it('rejects a wrong boolean type', () => {
    const res = validateParams(TEMPLATES.dca.params, { dipBuyEnabled: 'yes' })
    expect(res.ok).toBe(false)
  })

  it('rejects a value that would silently be clamped by a lenient resolver', () => {
    const res = validateParams(MARTINGALE_PARAMS, { maxAdds: 99 })
    expect(res.ok).toBe(false)
    // 说明：engine-core 的 resolveParams 会把 99 夹成 20 继续跑，这里必须拒
    expect(res.errors.join(' ')).toContain('<= 20')
  })
})

describe('safety declarations', () => {
  it('every template declares its mandatory safety caps', () => {
    for (const id of templateIds()) {
      const keys = SAFETY_KEYS[id]
      expect(keys.length).toBeGreaterThan(0)
      const declared = TEMPLATES[id].params.map((p) => p.key)
      for (const k of keys) expect(declared).toContain(k)
    }
  })

  it('the martingale template declares maxAdds and maxTotalNotional', () => {
    const keys = MARTINGALE_PARAMS.map((p) => p.key)
    expect(keys).toContain('maxAdds')
    expect(keys).toContain('maxTotalNotional')
    expect(keys).toContain('maxExposureNotional')
  })

  it('rejects a template whose id requires caps it does not declare', () => {
    expect(() => assertSafetyDeclared('martingale', GRID_PARAMS)).toThrow(BotParamError)
    expect(() => assertSafetyDeclared('dca', MARTINGALE_PARAMS)).toThrow(BotParamError)
    expect(() => assertSafetyDeclared('grid', MARTINGALE_PARAMS)).not.toThrow()
  })

  it('reads caps from validated params, never defaulting to unlimited', () => {
    const caps = capsOf('martingale', { maxExposureNotional: 100, maxAdds: 2, maxTotalNotional: 500 })
    expect(caps).toEqual({ maxExposureNotional: 100, maxAdds: 2, maxTotalNotional: 500 })
    expect(() => capsOf('grid', { maxExposureNotional: 0 })).toThrow(BotParamError)
  })

  it('rejects each missing safety cap even when every other parameter is present', () => {
    for (const id of templateIds()) {
      for (const key of SAFETY_KEYS[id]) {
        const params = defaultParams(id)
        delete params[key]
        let error: unknown
        try {
          TEMPLATES[id].create(params)
        } catch (e) {
          error = e
        }
        expect(error).toBeInstanceOf(BotParamError)
        expect((error as BotParamError).key).toBe(key)
      }
    }
  })

  it('rejects createBot without params because safety caps have no default', () => {
    expect(() => createBot('grid')).toThrow(BotParamError)
  })
})

function defaultParams(id: keyof typeof TEMPLATES): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const p of TEMPLATES[id].params) params[p.key] = p.default
  return params
}
