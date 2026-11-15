// SPDX-License-Identifier: CPAL-1.0
// 提示词：engine-core 的规格段必须在、本流水线的检查段必须追加、修复轮必须带上上一版代码与逐条失败原因。
import { describe, expect, it } from 'vitest'
import { findPromiseLanguage } from '../../protocol/src/plugin/manifest'
import { buildPrompt, buildRepairPrompt, stripCodeFences } from '../src'
import { GOOD_STRATEGY } from './fixtures'

const SPEC = { intent: 'buy when the short average crosses the long one', style: 'trend' as const, interval: '1h' }

describe('buildPrompt', () => {
  it('保留 engine-core 的四段规格，并带上用户意图 / 风格 / 周期', () => {
    const prompt = buildPrompt(SPEC)
    for (const block of ['# Role', '# Hard rules', '# Interface and output contract', '# Forbidden']) {
      expect(prompt).toContain(block)
    }
    expect(prompt).toContain('buy when the short average crosses the long one')
    expect(prompt).toContain('Style: trend')
    expect(prompt).toContain('Interval: 1h')
  })

  it('追加流水线检查段：说明会被静态校验、加载校验与冒烟回测，失败会原样喂回', () => {
    const prompt = buildPrompt(SPEC)
    expect(prompt).toContain('# What happens to the file you return')
    expect(prompt).toContain('checked statically first')
    expect(prompt).toContain('backtested on generated candles')
    expect(prompt).toContain('sent back to you verbatim')
  })

  it('用户约束逐条出现；空意图走缺省句而不是报错', () => {
    const prompt = buildPrompt({ intent: '   ', constraints: ['flat only, no shorting', '  ', 'max two parameters'] })
    expect(prompt).toContain('# Constraints from the user')
    expect(prompt).toContain('- flat only, no shorting')
    expect(prompt).toContain('- max two parameters')
    expect(prompt).not.toContain('-  \n')
    expect(prompt).toContain('(no intent given')
  })

  it('提示词本身零承诺语言（findPromiseLanguage 返回 null）', () => {
    expect(findPromiseLanguage(buildPrompt(SPEC))).toBeNull()
  })
})

describe('stripCodeFences', () => {
  it('去掉开闭围栏后内容逐字保留；没有围栏时原文返回；BOM 去掉', () => {
    expect(stripCodeFences('```ts\nconst a = 1\n```')).toBe('const a = 1\n')
    expect(stripCodeFences('const a = 1\n')).toBe('const a = 1\n')
    expect(stripCodeFences('\uFEFFconst a = 1\n')).toBe('const a = 1\n')
    expect(stripCodeFences('```ts\nconst a = 1\n')).toBe('const a = 1\n')
  })
})

describe('buildRepairPrompt', () => {
  it('带上轮次标题、上一版完整代码与每条失败（规则名 + 行号 + 原话）', () => {
    const prompt = buildRepairPrompt(SPEC, GOOD_STRATEGY, [
      { rule: 'no-import', message: 'the file imports a module at run time', line: 3 },
      { rule: 'param-default-range', message: 'parameter "slow": default 90 is above max 60' },
    ], 1, 2)

    expect(prompt).toContain('# Repair round 1 of 2')
    expect(prompt).toContain('# Previous file')
    expect(prompt).toContain("id: 'gen-average-cross'")
    expect(prompt).toContain('- [no-import] line 3: the file imports a module at run time')
    expect(prompt).toContain('- [param-default-range]: parameter "slow": default 90 is above max 60')
    // 硬规则每轮都在：模型没有跨轮记忆
    expect(prompt).toContain('# Hard rules')
    expect(findPromiseLanguage(prompt)).toBeNull()
  })
})
