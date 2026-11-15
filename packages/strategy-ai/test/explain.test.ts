// SPDX-License-Identifier: CPAL-1.0
// 解释器：四段结论（请求 / 结果 / 静态检查 / 冒烟）+ 每轮记录，且整份输出零承诺语言。
import { describe, expect, it } from 'vitest'
import { findPromiseLanguage } from '../../protocol/src/plugin/manifest'
import { explain, repairLoop } from '../src'
import { GOOD_STRATEGY, NO_EXPORT, WRONG_LENGTH, scriptedLlm, zigzagCandles } from './fixtures'

const SPEC = {
  intent: 'buy when the short average crosses the long one',
  style: 'trend' as const,
  instrumentHint: 'BTC/USDT',
  interval: '1h',
  constraints: ['long only'],
}
const CANDLES = zigzagCandles(180)

describe('explain', () => {
  it('通过的结果：写清请求、修复轮数、最终策略字段与历史冒烟数字', async () => {
    const { llm } = scriptedLlm([NO_EXPORT, GOOD_STRATEGY])
    const result = await repairLoop(SPEC, llm, { candles: CANDLES })
    const md = explain(result)

    expect(md).toContain('# 策略生成报告')
    expect(md).toContain('## 请求')
    expect(md).toContain('buy when the short average crosses the long one')
    expect(md).toContain('- 标的提示：BTC/USDT')
    expect(md).toContain('  - long only')
    expect(md).toContain('## 结果')
    expect(md).toContain('第 1 轮修复后通过')
    expect(md).toContain('生成调用：2 次')
    expect(md).toContain('- id：gen-average-cross')
    expect(md).toContain('- 版本：0.1.0')
    expect(md).toContain('## 冒烟回测（合成 K 线，历史数据）')
    expect(md).toContain('K 线 180 根')
    expect(md).toContain('## 每一轮')
    expect(md).toContain('| 0 | 1 条 | 未运行 | 退回 |')
  })

  it('失败的结果：写明轮数上限、最后一版失败规则，并说明没进回测', async () => {
    const { llm } = scriptedLlm([NO_EXPORT, NO_EXPORT, NO_EXPORT])
    const result = await repairLoop(SPEC, llm, { candles: CANDLES })
    const md = explain(result)

    expect(md).toContain('未通过——2 轮修复（上限 2 轮）之后仍有失败')
    expect(md).toContain('## 最终策略（最后一版，未采用）')
    expect(md).toContain('`export-default`')
    expect(md).toContain('未运行（静态检查未通过，没有进入回测）')
    expect(md).toContain('生成调用：3 次')
  })

  it('llm 中断：写成「中断」而不是「代码不合格」，且不编造策略字段', async () => {
    const { llm } = scriptedLlm([new Error('socket hang up')])
    const result = await repairLoop(SPEC, llm, { candles: CANDLES })
    const md = explain(result)

    expect(md).toContain('状态：中断')
    expect(md).toContain('socket hang up')
    expect(md).toContain('没有产出代码')
    expect(md).toContain('| — | — | — | 没有产出可检查的代码 |')
  })

  it('静态过、冒烟失败的那一轮：表格里「静态检查」记通过，「冒烟」记失败（不把加载器错误算进静态列）', async () => {
    const { llm } = scriptedLlm([WRONG_LENGTH, GOOD_STRATEGY])
    const result = await repairLoop(SPEC, llm, { candles: CANDLES })
    const md = explain(result)
    expect(md).toContain('| 0 | 通过 | 失败 | 退回 |')
    expect(md).toContain('| 1 | 通过 | 成交')
  })

  it('修复轮里 client 失败：写成「第 2 次调用」，不写成首次生成失败', async () => {
    const result = await repairLoop(SPEC, scriptedLlm([NO_EXPORT, new Error('reset during repair')]).llm, { candles: CANDLES })
    const md = explain(result)

    expect(md).toContain('第 2 次调用')
    expect(md).not.toContain('首次生成时失败')
  })

  it('整份报告零承诺语言（findPromiseLanguage 返回 null），也不写「预期」类推断', async () => {
    const ok = await repairLoop(SPEC, scriptedLlm([GOOD_STRATEGY]).llm, { candles: CANDLES })
    const bad = await repairLoop(SPEC, scriptedLlm([NO_EXPORT, NO_EXPORT, NO_EXPORT]).llm, { candles: CANDLES })
    const broken = await repairLoop(SPEC, scriptedLlm([new Error('x')]).llm, { candles: CANDLES })
    for (const md of [explain(ok), explain(bad), explain(broken)]) {
      expect(findPromiseLanguage(md)).toBeNull()
      expect(md).not.toContain('预期收益')
      expect(md).not.toContain('expected return')
    }
  })
})
