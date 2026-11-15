// SPDX-License-Identifier: CPAL-1.0
// 提示词构造 + 生成后静态校验：只测纯函数（不执行生成代码、不调模型）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildStrategyPrompt, paramsFromGenerated, validateGeneratedStrategy } from '../src/strategy/ai-generation'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VALID = readFileSync(join(root, 'examples', 'strategies', 'breakout.ts'), 'utf8')
const SAMPLE = readFileSync(join(root, 'examples', 'strategies', 'ema-cross.ts'), 'utf8')

const ruleOf = (text: string): string[] => validateGeneratedStrategy(text).issues.map((i) => i.rule)

describe('buildStrategyPrompt', () => {
  it('带上硬规则、输出契约、意图原文与风格词，且规则段在意图段之前', () => {
    const p = buildStrategyPrompt({ intent: '均线交叉', style: 'trend' })
    for (const needle of ['export default', 'evaluate', 'target', 'reasons', 'warmup', 'No imports', 'Math.random', '均线交叉', 'trend']) {
      expect(p).toContain(needle)
    }
    const rulesAt = p.indexOf('# Hard rules')
    const intentAt = p.indexOf('# User intent')
    expect(rulesAt).toBeGreaterThan(-1)
    expect(intentAt).toBeGreaterThan(rulesAt)
    expect(p.indexOf('均线交叉')).toBeGreaterThan(rulesAt)
    expect(p.indexOf('Math.random')).toBeGreaterThan(rulesAt)
  })

  it('可选字段只在给出时出现', () => {
    const bare = buildStrategyPrompt({ intent: 'x' })
    expect(bare).not.toContain('Instrument hint')
    expect(bare).not.toContain('# Constraints from the user')
    const full = buildStrategyPrompt({ intent: 'x', instrumentHint: 'BTC/USDT', interval: '1h', idHint: 'my-btc', constraints: ['long only'] })
    expect(full).toContain('Instrument hint: BTC/USDT')
    expect(full).toContain('Interval: 1h')
    expect(full).toContain("id hint: 'my-btc'")
    expect(full).toContain('- long only')
  })
})

describe('validateGeneratedStrategy', () => {
  it('合法样例：没有 issue，source 与输入逐字一致', () => {
    const r = validateGeneratedStrategy(VALID)
    expect(r.issues).toEqual([])
    expect(r.source).toBe(VALID)
  })

  it('带 ```ts 围栏：去围栏后与输入一致', () => {
    const fenced = '```ts\n' + VALID + '```'
    const r = validateGeneratedStrategy(fenced)
    expect(r.source).toBe(VALID)
    expect(r.issues).toEqual([])
  })

  it('缺 export default → export-default', () => {
    expect(ruleOf(VALID.replace('export default strategy', 'void strategy'))).toContain('export-default')
  })

  it('运行期 import → no-import；import type 不报', () => {
    expect(ruleOf(VALID.replace('const strategy: StrategyDef = {', "import { x } from 'y'\n\nconst strategy: StrategyDef = {"))).toContain('no-import')
    const typeOnly = VALID.replace('type Candle =', "import type { Params as P } from './somewhere'\ntype Candle =")
    expect(ruleOf(typeOnly)).not.toContain('no-import')
  })

  it('fetch( → no-io', () => {
    expect(ruleOf(VALID.replace('const closes =', "const junk = fetch('/x')\n    const closes ="))).toContain('no-io')
  })

  it("id: 'Bad_ID' → id", () => {
    expect(ruleOf(VALID.replace("id: 'breakout'", "id: 'Bad_ID'"))).toContain('id')
  })

  it("desc: '稳赚不赔' → no-promise", () => {
    expect(ruleOf(VALID.replace(/desc: '[^']*'/, "desc: '稳赚不赔'"))).toContain('no-promise')
  })

  it("参数 key apiSecret → param-key", () => {
    expect(ruleOf(VALID.replace("{ key: 'allowShort'", "{ key: 'apiSecret'"))).toContain('param-key')
  })

  it('空字符串：至少一条 issue，不抛', () => {
    const r = validateGeneratedStrategy('')
    expect(r.source).toBe('')
    expect(r.issues.length).toBeGreaterThan(0)
  })
})

describe('参数质量', () => {
  const PARAM_RULES = ['param-default-range', 'param-unused', 'param-comment-mismatch']
  const withGhost = SAMPLE.replace(
    "{ key: 'allowShort', label: '允许做空', type: 'boolean', default: true },",
    "{ key: 'allowShort', label: '允许做空', type: 'boolean', default: true },\n    { key: 'ghost', label: 'g', type: 'number', default: 1 },",
  )

  it('合法样例（ema-cross）：新规则不报，paramsFromGenerated 从数组抓 3 个 key', () => {
    const rules = ruleOf(SAMPLE)
    for (const rule of PARAM_RULES) expect(rules).not.toContain(rule)
    expect(rules).toEqual([])

    const got = paramsFromGenerated(SAMPLE)
    expect(got.source).toBe('array')
    expect(got.params.map((p) => p.key)).toEqual(['fast', 'slow', 'allowShort'])
    expect(got.params[0]?.default).toBe(12)
    expect(got.params[0]?.max).toBe(100)
    expect(got.params[2]?.type).toBe('boolean')
  })

  it('default 超出 [min, max] → param-default-range；step 与范围不整除 → 同规则', () => {
    expect(ruleOf(SAMPLE.replace('default: 12', 'default: 500'))).toContain('param-default-range')
    expect(ruleOf(SAMPLE.replace('step: 1', 'step: 4'))).toContain('param-default-range') // max−min = 98 不被 4 整除
  })

  it('params 里声明但 evaluate 没读的 key → param-unused', () => {
    expect(withGhost).toContain("key: 'ghost'")
    const rules = ruleOf(withGhost)
    expect(rules).toContain('param-unused')
    const unused = validateGeneratedStrategy(withGhost).issues.filter((i) => i.rule === 'param-unused')
    expect(unused.map((i) => i.message)).toEqual([expect.stringContaining('ghost')])
  })

  it('@param 注释的 key 集合与 params 数组不一致 → param-comment-mismatch', () => {
    const withComments = SAMPLE.replace(
      'const strategy: StrategyDef = {',
      '// @param fast integer default=12 min=2 max=100 step=1\n// @param ghost2 number default=1\nconst strategy: StrategyDef = {',
    )
    expect(ruleOf(withComments)).toContain('param-comment-mismatch')
  })

  it('只有 @param 注释、没有 params 数组 → source 为 comments 且与注释一致', () => {
    const text = [
      '// @param fast integer default=12 min=2 max=100 step=1',
      '// @param allowShort boolean default=true',
      "export default { id: 'x-y', version: '0.1.0', desc: 'd', params: [], evaluate() {} }",
    ].join('\n')
    const got = paramsFromGenerated(text)
    expect(got.source).toBe('comments')
    expect(got.params.map((p) => p.key)).toEqual(['fast', 'allowShort'])
    expect(got.params[0]).toMatchObject({ key: 'fast', type: 'integer', default: 12, min: 2, max: 100, step: 1 })
    expect(got.params[1]?.default).toBe(true)
  })
})
