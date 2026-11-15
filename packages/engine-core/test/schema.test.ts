// SPDX-License-Identifier: CPAL-1.0
// @param 注释解析 / 回写 / 生成：四种类型、坏行报错、重复键、默认值回写、互逆。
import { describe, expect, it } from 'vitest'
import { formatParamComments, parseParamComments, rewriteParamDefaults } from '../src/strategy/schema'
import type { ParamDef } from '../src/strategy/types'

const FOUR_TYPES = [
  '// @param fast number default=9 min=1 max=200 step=1 label="Fast EMA" help="short moving average"',
  '// @param slow integer default=21 min=2 max=400 label="Slow EMA"',
  '// @param useFilter boolean default=true label="Use filter"',
  '// @param mode select default=ema values=ema|sma|wma label="Mode" hidden',
  'export function evaluate() { return 1 }',
].join('\n')

const EXPECTED: ParamDef[] = [
  { key: 'fast', label: 'Fast EMA', type: 'number', default: 9, min: 1, max: 200, step: 1, help: 'short moving average' },
  { key: 'slow', label: 'Slow EMA', type: 'integer', default: 21, min: 2, max: 400 },
  { key: 'useFilter', label: 'Use filter', type: 'boolean', default: true },
  { key: 'mode', label: 'Mode', type: 'select', default: 'ema', options: ['ema', 'sma', 'wma'], hidden: true },
]

describe('parseParamComments', () => {
  it('解析四种类型，含 label / help / hidden，逐字段等于手写 ParamDef[]', () => {
    const { params, issues } = parseParamComments(FOUR_TYPES)
    expect(issues).toEqual([])
    expect(params).toEqual(EXPECTED)
  })

  it('坏行进 issues（含 1 基行号），好行不受影响', () => {
    const src = [
      '// @param n number',
      '// @param k integer default=1.5',
      '// @param m select default=z values=a|b',
      '// @param ok number default=3 label="Ok"',
    ].join('\n')
    const { params, issues } = parseParamComments(src)
    expect(params).toEqual([{ key: 'ok', label: 'Ok', type: 'number', default: 3 }])
    expect(issues).toHaveLength(3)
    expect(issues[0]).toMatchObject({ line: 1 })
    expect(issues[0]!.message).toContain('default')
    expect(issues[1]).toMatchObject({ line: 2 })
    expect(issues[1]!.message).toContain('integer')
    expect(issues[2]).toMatchObject({ line: 3 })
    expect(issues[2]!.message).toContain('values')
  })

  it('重复 key 以后者为准并记 issue', () => {
    const src = [
      '// @param fast number default=5',
      '// @param fast number default=7',
    ].join('\n')
    const { params, issues } = parseParamComments(src)
    expect(params).toEqual([{ key: 'fast', label: 'fast', type: 'number', default: 7 }])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ line: 2 })
    expect(issues[0]!.message).toContain('duplicate')
  })

  it('也能解析 Python 风格的 # @param 行', () => {
    const { params, issues } = parseParamComments('# @param period integer default=14 min=2 label="Period"')
    expect(issues).toEqual([])
    expect(params).toEqual([{ key: 'period', label: 'Period', type: 'integer', default: 14, min: 2 }])
  })
})

describe('rewriteParamDefaults', () => {
  it('只改 default=，其余字符逐字节保留；不存在的 key 进 missing', () => {
    const src = [
      '# @param fast number default=5 min=1',
      '// @param slow integer default=10 max=100 label="Slow EMA"',
      '// @param other number default=1',
      '',
    ].join('\n')
    const result = rewriteParamDefaults(src, { fast: 9, slow: 21 })
    expect(result.missing).toEqual([])
    expect(result.source.split('\n')).toEqual([
      '# @param fast number default=9 min=1',
      '// @param slow integer default=21 max=100 label="Slow EMA"',
      '// @param other number default=1',
      '',
    ])

    const miss = rewriteParamDefaults(src, { x: 3 })
    expect(miss.missing).toEqual(['x'])
    expect(miss.source).toBe(src)
  })
})

describe('formatParamComments', () => {
  it('生成的行重新解析后与原 params toEqual（互逆）', () => {
    const { params } = parseParamComments(FOUR_TYPES)
    const formatted = formatParamComments(params)
    expect(formatted.split('\n')).toHaveLength(params.length)
    expect(parseParamComments(formatted).params).toEqual(params)
    expect(parseParamComments(formatted).issues).toEqual([])
  })
})
