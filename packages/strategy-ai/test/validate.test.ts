// SPDX-License-Identifier: CPAL-1.0
// 静态校验：直接用 engine-core 的规则，断言规则名稳定（修复循环与解释器都按规则名转述）。
import { describe, expect, it } from 'vitest'
import { validate } from '../src'
import { GOOD_STRATEGY, NO_EXPORT, WITH_IMPORT, WITH_PROMISE } from './fixtures'

const rules = (code: string): string[] => validate(code).issues.map((i) => i.rule)

describe('validate', () => {
  it('合法策略：ok、无问题、源码去围栏后逐字等于输入', () => {
    const r = validate(GOOD_STRATEGY)
    expect(r.issues).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.source).toBe(GOOD_STRATEGY)
  })

  it('套了代码围栏的同一份代码仍然通过，且 source 里没有围栏', () => {
    const r = validate('```ts\n' + GOOD_STRATEGY + '```\n')
    expect(r.ok).toBe(true)
    expect(r.source.startsWith('export interface Candle')).toBe(true)
    expect(r.source).not.toContain('```')
  })

  it('运行期 import → no-import', () => {
    const r = validate(WITH_IMPORT)
    expect(r.ok).toBe(false)
    expect(rules(WITH_IMPORT)).toContain('no-import')
  })

  it('缺 export default → export-default；缺 evaluate → evaluate', () => {
    expect(rules(NO_EXPORT)).toContain('export-default')
    expect(rules(GOOD_STRATEGY.replace('evaluate(candles, params) {', 'run(candles, params) {'))).toContain('evaluate')
  })

  it('desc 里的承诺口气 → no-promise，并指出是哪个词', () => {
    const r = validate(WITH_PROMISE)
    expect(r.ok).toBe(false)
    expect(rules(WITH_PROMISE)).toContain('no-promise')
    expect(r.issues.find((i) => i.rule === 'no-promise')?.message.toLowerCase()).toContain('guaranteed')
  })

  it('参数默认值越过 max → param-default-range（行号指向该参数）', () => {
    const bad = GOOD_STRATEGY.replace("default: 20, min: 3, max: 60", "default: 90, min: 3, max: 60")
    const r = validate(bad)
    expect(r.ok).toBe(false)
    const hit = r.issues.find((i) => i.rule === 'param-default-range')
    expect(hit?.message).toContain('above max 60')
    expect(typeof hit?.line).toBe('number')
  })
})
