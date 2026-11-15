// SPDX-License-Identifier: CPAL-1.0
// 修复循环：断言「问了几次、每次为什么失败、最后拿到的结果」。三形态假 client：合法 / 非法 / 带 import。
import { describe, expect, it } from 'vitest'
import { repairLoop } from '../src'
import { GOOD_STRATEGY, NO_EXPORT, WITH_IMPORT, WRONG_LENGTH, scriptedLlm, zigzagCandles } from './fixtures'

const SPEC = { intent: 'buy when the short average crosses the long one', style: 'trend' as const }
const CANDLES = zigzagCandles(240)

describe('repairLoop', () => {
  it('首轮非法、次轮合法：只用 1 轮修复，调用 2 次，结果采用第二版', async () => {
    const { llm, prompts } = scriptedLlm([NO_EXPORT, GOOD_STRATEGY])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.ok).toBe(true)
    expect(r.stopped).toBe('passed')
    expect(r.rounds).toBe(1)
    expect(r.maxRounds).toBe(2)
    expect(r.attempts).toHaveLength(2)
    expect(r.attempts[0]?.issues.map((i) => i.rule)).toContain('export-default')
    expect(r.attempts[1]?.issues).toEqual([])
    expect(r.attempts[1]?.smoke?.ok).toBe(true)
    expect(r.code).toBe(GOOD_STRATEGY)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('# Repair round 1 of 2')
  })

  it('一直非法（缺 export default）：用满缺省 2 轮，调用 3 次，结果 exhausted', async () => {
    const { llm, prompts } = scriptedLlm([NO_EXPORT, NO_EXPORT, NO_EXPORT])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.ok).toBe(false)
    expect(r.stopped).toBe('exhausted')
    expect(r.rounds).toBe(2)
    expect(r.attempts).toHaveLength(3)
    expect(prompts).toHaveLength(3)
    expect(r.final.issues.map((i) => i.rule)).toContain('export-default')
    expect(r.code).toBe(NO_EXPORT)
    expect(r.final.smoke).toBeUndefined()
  })

  it('maxRounds 可配：0 表示只生成一次、不修复；1 表示最多追问一次', async () => {
    const zero = scriptedLlm([NO_EXPORT])
    const r0 = await repairLoop(SPEC, zero.llm, { candles: CANDLES, maxRounds: 0 })
    expect(r0.attempts).toHaveLength(1)
    expect(r0.rounds).toBe(0)
    expect(r0.stopped).toBe('exhausted')
    expect(zero.prompts).toHaveLength(1)

    const one = scriptedLlm([NO_EXPORT, NO_EXPORT])
    const r1 = await repairLoop(SPEC, one.llm, { candles: CANDLES, maxRounds: 1 })
    expect(r1.attempts).toHaveLength(2)
    expect(r1.rounds).toBe(1)
    expect(one.prompts).toHaveLength(2)
    expect(one.prompts[1]).toContain('# Repair round 1 of 1')
  })

  it('带 import 的代码：静态拒 no-import，模型照错误改一版就通过', async () => {
    const { llm, prompts } = scriptedLlm([WITH_IMPORT, GOOD_STRATEGY])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.ok).toBe(true)
    expect(r.rounds).toBe(1)
    expect(r.attempts[0]?.issues.map((i) => i.rule)).toContain('no-import')
    expect(prompts[1]).toContain('[no-import]')
    expect(prompts).toHaveLength(2)
    expect(r.stopped).toBe('passed')
    expect(r.code).toBe(GOOD_STRATEGY)
  })

  it('静态能过但冒烟失败（序列长度不对）：错误来自加载器，且被原样喂回', async () => {
    const { llm, prompts } = scriptedLlm([WRONG_LENGTH, GOOD_STRATEGY])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.ok).toBe(true)
    expect(r.rounds).toBe(1)
    expect(r.attempts[0]?.smoke?.ok).toBe(false)
    expect(r.attempts[0]?.issues.map((i) => i.rule)).toContain('output-length')
    expect(prompts[1]).toContain('[output-length]')
  })

  it('上限钐制：maxRounds 超过 8 按 8 计；负数按 0 计', async () => {
    const many = scriptedLlm(Array(9).fill(NO_EXPORT))
    const rMany = await repairLoop(SPEC, many.llm, { candles: CANDLES, maxRounds: 100 })
    expect(rMany.maxRounds).toBe(8)
    expect(rMany.rounds).toBe(8)
    expect(rMany.attempts).toHaveLength(9)
    expect(many.prompts).toHaveLength(9)
    expect(rMany.stopped).toBe('exhausted')

    const neg = scriptedLlm([NO_EXPORT])
    const rNeg = await repairLoop(SPEC, neg.llm, { candles: CANDLES, maxRounds: -1 })
    expect(rNeg.maxRounds).toBe(0)
    expect(neg.prompts).toHaveLength(1)
  })

  it('client 抛错：stopped 为 llm-error，一次都没产出，不伪装成「代码不合格」', async () => {
    const { llm } = scriptedLlm([new Error('connection reset by peer')])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.ok).toBe(false)
    expect(r.stopped).toBe('llm-error')
    expect(r.attempts).toEqual([])
    expect(r.rounds).toBe(0)
    expect(r.error).toContain('connection reset by peer')
  })

  it('client 返回空白：同样记成 llm-error（empty completion）', async () => {
    const { llm } = scriptedLlm(['   \n\n'])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.stopped).toBe('llm-error')
    expect(r.error).toContain('empty completion')
    expect(r.attempts).toEqual([])
  })

  it('修复轮里 client 抛错：第一次的产出保留，rounds 仍为 0', async () => {
    const { llm } = scriptedLlm([NO_EXPORT, new Error('reset during repair')])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.stopped).toBe('llm-error')
    expect(r.attempts).toHaveLength(1)
    expect(r.rounds).toBe(0)
    expect(r.code).toBe(NO_EXPORT)
    expect(r.error).toContain('reset during repair')
  })

  it('代码围栏被去掉后再校验：带围栏的合法代码一次通过', async () => {
    const { llm } = scriptedLlm(['```ts\n' + GOOD_STRATEGY + '```\n'])
    const r = await repairLoop(SPEC, llm, { candles: CANDLES })

    expect(r.ok).toBe(true)
    expect(r.rounds).toBe(0)
    expect(r.code).not.toContain('```')
  })
})
