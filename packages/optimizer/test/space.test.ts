// SPDX-License-Identifier: CPAL-1.0
// 参数空间：校验、取值域枚举、贴网格、稳定键。
import { describe, expect, it } from 'vitest'
import { canonicalKey, domainValues, randomValue, snapValue, spaceSize, validateSpace, type ParamSpace } from '../src/space'

describe('validateSpace', () => {
  it('空参数空间直接抛 TypeError', () => {
    expect(() => validateSpace({})).toThrowError(TypeError)
  })

  it('min > max、非有限数、step <= 0 都抛错（不静默夹住）', () => {
    expect(() => validateSpace({ a: { type: 'number', min: 5, max: 1 } })).toThrowError(RangeError)
    expect(() => validateSpace({ a: { type: 'number', min: 0, max: Number.POSITIVE_INFINITY } })).toThrowError(RangeError)
    expect(() => validateSpace({ a: { type: 'integer', min: 0, max: 5, step: 0 } })).toThrowError(RangeError)
  })

  it('integer 的边界与 step 必须是整数', () => {
    expect(() => validateSpace({ a: { type: 'integer', min: 0.5, max: 5 } })).toThrowError(RangeError)
    expect(() => validateSpace({ a: { type: 'integer', min: 0, max: 5, step: 1.5 } })).toThrowError(RangeError)
  })

  it('select 必须给非空且不重复的选项，未知 type 抛错', () => {
    expect(() => validateSpace({ a: { type: 'select', options: [] } })).toThrowError(RangeError)
    expect(() => validateSpace({ a: { type: 'select', options: ['x', 'x'] } })).toThrowError(RangeError)
    expect(() => validateSpace({ a: { type: 'decimal', min: 0, max: 1 } as never })).toThrowError(TypeError)
  })

  it('合法空间按声明顺序返回键名', () => {
    const space: ParamSpace = {
      slow: { type: 'integer', min: 10, max: 20 },
      fast: { type: 'integer', min: 2, max: 5 },
      mode: { type: 'select', options: ['a', 'b'] },
      flag: { type: 'boolean' },
    }
    expect(validateSpace(space)).toEqual(['slow', 'fast', 'mode', 'flag'])
  })
})

describe('domainValues', () => {
  it('带 step 的数值维度按 min..max 逐格列出，integer 取整', () => {
    expect(domainValues({ type: 'number', min: 0, max: 1, step: 0.25 })).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(domainValues({ type: 'integer', min: 2, max: 10, step: 4 })).toEqual([2, 6, 10])
  })

  it('不带 step 时等距取 maxPoints 个（含两端）', () => {
    expect(domainValues({ type: 'number', min: 0, max: 1 }, 5)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(domainValues({ type: 'boolean' })).toEqual([false, true])
    expect(domainValues({ type: 'select', options: ['b', 'a'] })).toEqual(['b', 'a'])
  })

  it('候选数超过 maxPoints 时等距抽下标并保住两端', () => {
    const values = domainValues({ type: 'number', min: 0, max: 100, step: 1 }, 5)
    expect(values).toEqual([0, 25, 50, 75, 100])
  })

  it('integer 的等距枚举去重后不重复', () => {
    const values = domainValues({ type: 'integer', min: 0, max: 5 })
    expect(values).toEqual([0, 1, 2, 3, 4, 5])
    expect(new Set(values.map((value) => String(value))).size).toBe(values.length)
  })
})

describe('snapValue / canonicalKey', () => {
  it('数值贴到 step 网格并夹到边界，integer 取整', () => {
    const spec = { type: 'number', min: 0, max: 1, step: 0.25 } as const
    expect(snapValue(spec, 0.31)).toBe(0.25)
    expect(snapValue(spec, 0.38)).toBe(0.5)
    expect(snapValue(spec, 9)).toBe(1)
    expect(snapValue(spec, -3)).toBe(0)
    expect(snapValue({ type: 'integer', min: 1, max: 5, step: 2 }, 2)).toBe(3)
  })

  it('select 收到不在选项里的值抛错，boolean 只接受 true/false', () => {
    expect(() => snapValue({ type: 'select', options: ['a', 'b'] }, 'c')).toThrowError(RangeError)
    expect(snapValue({ type: 'boolean' }, 'true')).toBe(true)
    expect(() => snapValue({ type: 'boolean' }, 'yes')).toThrowError(TypeError)
  })

  it('canonicalKey 与键的插入顺序无关，值类型不同则键不同', () => {
    expect(canonicalKey({ a: 1, b: 'x' })).toBe(canonicalKey({ b: 'x', a: 1 }))
    expect(canonicalKey({ a: 1 })).not.toBe(canonicalKey({ a: '1' }))
  })

  it('spaceSize 与抽样都只看合法取值域', () => {
    const space: ParamSpace = { x: { type: 'integer', min: 0, max: 4, step: 1 }, flag: { type: 'boolean' } }
    expect(spaceSize(space)).toBe(10)
    const values = new Set<string>()
    const xSpec = space.x
    const flagSpec = space.flag
    if (xSpec === undefined || flagSpec === undefined) throw new Error('fixture space is incomplete')
    for (let i = 0; i < 200; i++) values.add(canonicalKey({ x: randomValue(xSpec, Math.random), flag: randomValue(flagSpec, Math.random) }))
    for (const key of values) {
      expect(key).toMatch(/^flag=boolean:(true|false)\|x=number:[0-4]$/)
    }
  })
})
