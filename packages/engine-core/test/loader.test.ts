// SPDX-License-Identifier: CPAL-1.0
// 文件夹即安装：策略文件的校验（写给 Agent 看的可读错误）、热加载、热更新、卸载；以及空白模板与教学示例本身必须通过校验。
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { StrategyFolder, StrategyRegistry, loadStrategyFile } from '../src/strategy'
import { rig, bindPaper, strategyDir, BTC, PAPER_ACCOUNT, MANDATE_ID, EXAMPLE_STRATEGIES, FIXTURE_STRATEGIES, type Rig } from './harness'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gitrader-loader-')); dirs.push(d); return d }
let r: Rig | null = null
afterEach(() => { r?.close(); r = null; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const HEAD = `type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }
type Params = Record<string, number | boolean | string>
`
/** 造一个策略文件源码：可替换各部分。默认是「第 20 根之后永远做多」的合法策略。 */
function src(over: { id?: string; params?: string; body?: string; extra?: string; top?: string } = {}): string {
  return `${HEAD}${over.top ?? ''}
const strategy = {
  id: '${over.id ?? 'probe-strategy'}', name: 'Probe', version: '0.1.0', desc: 'test probe', tags: [],
  params: ${over.params ?? "[{ key: 'period', label: 'Period', type: 'integer', default: 20, min: 2, max: 100 }]"},
  ${over.extra ?? ''}
  evaluate(candles: Candle[], params: Params) {
    const n = candles.length
    ${over.body ?? "const target = candles.map((_, i) => (i >= 20 ? 1 : 0)); const reasons = candles.map((_, i) => (i === 20 ? 'go long' : '')); return { target, reasons, overlays: {}, warmup: 20 }"}
  },
}
export default strategy
`
}
async function check(source: string, name = 'probe.ts', opts?: { budgetMs?: number }) {
  const d = tmp()
  const p = join(d, name)
  writeFileSync(p, source)
  return loadStrategyFile(p, opts)
}
const rules = (x: { errors: { rule: string }[] }): string[] => x.errors.map((e) => e.rule)

describe('随包文件本身必须过校验', () => {
  it('空白模板：通过，只有一条「从不交易」的提示；教学示例 + 夹具全部通过', async () => {
    const t = await loadStrategyFile(join(root, 'strategy-template', 'strategy.ts'))
    expect(t.errors).toEqual([])
    expect(t.def?.id).toBe('blank-template')
    expect(t.warnings.map((w) => w.rule)).toEqual(['never-trades'])
    for (const f of ['mean-reversion', 'breakout', 'grid', 'dca', 'ema-cross', 'rsi-reversion', 'supertrend', 'momentum-roc', 'martingale', 'trend-atr']) {
      const x = await loadStrategyFile(join(EXAMPLE_STRATEGIES, `${f}.ts`))
      expect(x.errors, f).toEqual([])
      expect(x.def?.name, f).toMatch(/teaching example/)
    }
    expect((await loadStrategyFile(join(FIXTURE_STRATEGIES, 'ema-cross.ts'))).errors).toEqual([])
  })

  it('合法的最小策略（TS 与 .mjs 两种写法）通过，并得到由 params 派生的 defaults', async () => {
    const ts = await check(src())
    expect(ts.errors).toEqual([])
    expect(ts.def?.defaults).toEqual({ period: 20 })
    expect(ts.def?.file).toBe('probe.ts')
    const mjs = await check(`export default { id: 'plain-js', name: 'Plain', version: '1.0.0', desc: 'js', tags: [], params: [], evaluate(c) { const n = c.length; return { target: new Array(n).fill(0), reasons: new Array(n).fill(''), overlays: {}, warmup: 0 } } }\n`, 'plain.mjs')
    expect(mjs.errors).toEqual([])
  })
})

describe('校验失败：给出规则名 + 哪里不对 + 怎么改', () => {
  it('前视偏差：用了下一根 K 线 / 用了全段统计量', async () => {
    const peek = await check(src({ body: "const target = candles.map((c, i) => (candles[i + 1] ? (candles[i + 1]!.c > c.c ? 1 : -1) : 0)); return { target, reasons: target.map((t, i) => (i === 0 || t !== target[i - 1] ? 'x' : '')), overlays: {}, warmup: 0 }" }))
    expect(rules(peek)).toContain('lookahead')
    const e = peek.errors.find((x) => x.rule === 'lookahead')!
    expect(e.message).toMatch(/looks at future candles/)
    expect(e.hint).toMatch(/candles\[0\.\.i\]/)
    const whole = await check(src({ body: "const m = candles.reduce((a, c) => a + c.c, 0) / Math.max(1, n); const target = candles.map((c) => (c.c > m ? 1 : 0)); return { target, reasons: target.map((t, i) => (i === 0 || t !== target[i - 1] ? 'above mean' : '')), overlays: {}, warmup: 0 }" }))
    expect(rules(whole)).toContain('lookahead')
  })

  it('目标变化却没有理由 / 越界 / 长度不对 / NaN', async () => {
    expect(rules(await check(src({ body: "const target = candles.map((_, i) => (i >= 20 ? 1 : 0)); return { target, reasons: candles.map(() => ''), overlays: {}, warmup: 20 }" })))).toContain('reason-missing')
    expect(rules(await check(src({ body: "const target = candles.map((_, i) => (i >= 20 ? 2 : 0)); return { target, reasons: candles.map((_, i) => (i === 20 ? 'x' : '')), overlays: {}, warmup: 20 }" })))).toContain('output-target')
    expect(rules(await check(src({ body: 'return { target: [0], reasons: [], overlays: {}, warmup: 0 }' })))).toContain('output-length')
    expect(rules(await check(src({ body: "const target = candles.map((_, i) => (i === 3 ? NaN : 0)); return { target, reasons: candles.map(() => ''), overlays: {}, warmup: 0 }" })))).toContain('output-target')
    expect(rules(await check(src({ body: 'return { target: [], reasons: [], warmup: 0 }' })))).toContain('output-overlays')
  })

  it('不确定性 / 修改入参 / 空序列与极端参数抛错', async () => {
    const nd = await check(src({ top: 'let calls = 0\n', body: "calls += 1; const target = candles.map((_, i) => (i >= 20 && calls % 2 === 0 ? 1 : 0)); return { target, reasons: target.map((t, i) => (t !== (target[i - 1] ?? 0) ? 'x' : '')), overlays: {}, warmup: 20 }" }))
    expect(rules(nd)).toContain('non-deterministic')
    const mut = await check(src({ body: "candles.sort((a, b) => b.t - a.t); return { target: candles.map(() => 0), reasons: candles.map(() => ''), overlays: {}, warmup: 0 }" }))
    expect(rules(mut)).toContain('evaluate-throws')
    expect(mut.errors[0]!.hint).toMatch(/must not modify its inputs/)
    const empty = await check(src({ body: "if (n === 0) throw new Error('boom'); return { target: candles.map(() => 0), reasons: candles.map(() => ''), overlays: {}, warmup: 0 }" }))
    expect(rules(empty)).toContain('empty-input')
    const extreme = await check(src({ body: "if (params.period === 2) throw new Error('period 2 not supported'); return { target: candles.map(() => 0), reasons: candles.map(() => ''), overlays: {}, warmup: 0 }" }))
    expect(rules(extreme)).toContain('extreme-params')
  })

  it('不许碰 IO / 环境 / 时钟 / 随机数 / 运行时 import（注释里提到不算）', async () => {
    const zero = "return { target: candles.map(() => 0), reasons: candles.map(() => ''), overlays: {}, warmup: 0 }"
    for (const [what, body] of [
      ['fetch', `void fetch('http://x'); ${zero}`], ['random', `void Math.random(); ${zero}`], ['clock', `void Date.now(); ${zero}`],
      ['process', `void process.env; ${zero}`], ['eval', `void eval('1'); ${zero}`], ['require', `void require('fs'); ${zero}`],
    ] as const) expect(rules(await check(src({ body }))), what).toContain('no-io')
    expect(rules(await check(src({ top: "import { readFileSync } from 'node:fs'\n" })))).toContain('no-io')
    const commented = await check(src({ top: '// we never call fetch() or Math.random() here\n', body: "return { target: candles.map(() => 0), reasons: candles.map(() => ''), overlays: {}, warmup: 0 }" }))
    expect(commented.errors).toEqual([])
  })

  it('字段与参数定义：坏 id、保留名 size、像秘密的参数名、默认值越界、未知字段、重复键', async () => {
    expect(rules(await check(src({ id: 'Bad_ID' })))).toContain('id')
    const size = await check(src({ params: "[{ key: 'size', label: 'Size', type: 'number', default: 1 }]" }))
    expect(rules(size)).toContain('param-key')
    expect(size.errors.find((e) => e.rule === 'param-key')!.hint).toMatch(/per-order size cap/)
    expect(rules(await check(src({ params: "[{ key: 'privateKey', label: 'k', type: 'boolean', default: true }]" })))).toContain('param-key')
    expect(rules(await check(src({ params: "[{ key: 'period', label: 'P', type: 'integer', default: 500, min: 2, max: 100 }]" })))).toContain('param-range')
    expect(rules(await check(src({ params: "[{ key: 'a', label: 'A', type: 'boolean', default: 'yes' }]" })))).toContain('param-default')
    expect(rules(await check(src({ params: "[{ key: 'a', label: 'A', type: 'boolean', default: true }, { key: 'a', label: 'A', type: 'boolean', default: true }]" })))).toContain('param-key')
    expect(rules(await check(src({ extra: 'sizing: 3,' })))).toContain('unknown-field')
  })

  it('语法错误 / 死循环 / 没有默认导出 / 不支持的扩展名 都有可读的错误', async () => {
    expect(rules(await check('const x = ;\nexport default x\n'))).toEqual(['syntax'])
    expect(rules(await check('const x = ;\nexport default x\n', 'bad.mjs'))).toEqual(['load'])
    expect(rules(await check(src({ body: 'while (true) {}' }), 'loop.ts', { budgetMs: 1500 }))).toEqual(['timeout'])
    expect(rules(await check('export const nothing = 1\n', 'nodefault.mjs'))).toEqual(['load'])
    expect(rules(await check('{}', 'notes.json'))).toEqual(['extension'])
  })
})

describe('StrategyFolder：文件夹即安装', () => {
  const hooks = { now: () => Date.now() }

  it('新增 → 加载；改版本 → 热更新；改坏 → 报错但旧版本继续可用；删除 → 卸载；同 id 的第二个文件被拒', async () => {
    const dir = tmp()
    const reg = new StrategyRegistry()
    const seen: string[] = []
    const f = new StrategyFolder(dir, reg, { ...hooks, onChange: (x) => seen.push(`${x.file}:${x.status}`) }, { debounceMs: 20, pollMs: 60_000 })
    await f.start()
    expect(reg.size).toBe(0) // 空文件夹 = 没有任何策略
    copyFileSync(join(FIXTURE_STRATEGIES, 'ema-cross.ts'), join(dir, 'ema.ts'))
    await f.rescan()
    expect(reg.ids()).toEqual(['ema-trend'])
    expect(reg.get('ema-trend')?.file).toBe('ema.ts')
    // 热更新
    writeFileSync(join(dir, 'ema.ts'), src({ id: 'ema-trend' }).replace("version: '0.1.0'", "version: '0.2.0'"))
    await f.rescan()
    expect(reg.get('ema-trend')?.version).toBe('0.2.0')
    // 改坏
    writeFileSync(join(dir, 'ema.ts'), 'this is not a strategy')
    await f.rescan()
    expect(f.reports().find((x) => x.file === 'ema.ts')?.status).toBe('error')
    expect(reg.get('ema-trend')?.version).toBe('0.2.0')
    // 同 id 的另一个文件
    writeFileSync(join(dir, 'other.ts'), src({ id: 'ema-trend' }))
    await f.rescan()
    expect(f.reports().find((x) => x.file === 'other.ts')?.errors.map((e) => e.rule)).toContain('duplicate-id')
    // 被忽略的文件名
    writeFileSync(join(dir, '_draft.ts'), src({ id: 'draft-one' }))
    writeFileSync(join(dir, 'notes.md'), 'hello')
    await f.rescan()
    expect(reg.has('draft-one')).toBe(false)
    expect(f.reports().map((x) => x.file)).not.toContain('_draft.ts')
    // 删除
    rmSync(join(dir, 'ema.ts'))
    await f.rescan()
    expect(reg.has('ema-trend')).toBe(false)
    expect(seen).toContain('ema.ts:loaded')
    expect(seen).toContain('ema.ts:error')
    expect(seen).toContain('ema.ts:removed')
    f.stop()
  })

  it('真的在监视目录：丢进一个文件，几秒内出现在注册表里；目录不存在时自动创建', async () => {
    const parent = tmp()
    const dir = join(parent, 'engines', 'core', 'strategies')
    const reg = new StrategyRegistry()
    const f = new StrategyFolder(dir, reg, hooks, { debounceMs: 30, pollMs: 200 })
    await f.start()
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(EXAMPLE_STRATEGIES, 'grid.ts'), join(dir, 'grid.ts'))
    const t0 = Date.now()
    while (!reg.has('grid') && Date.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 50))
    expect(reg.has('grid')).toBe(true)
    f.stop()
  })
})

describe('经 GEP：策略文件夹对 Agent 可见', () => {
  it('x-gitrader.strategy.files 给出每个文件的校验结果；strategy.list 随文件热变化；订阅 strategy 流能看到 loaded / load_failed', async () => {
    const dir = strategyDir([])
    r = await rig({ strategiesDir: dir })
    const caps = (await r.session.call('engine.describe', {})).capabilities
    expect(caps['x-gitrader.strategy-folder']).toBe(true)
    expect((await r.session.call('strategy.list', {})).strategies).toEqual([]) // 空文件夹 = 没有策略
    await r.session.call('events.subscribe', { streams: ['strategy'] })
    copyFileSync(join(EXAMPLE_STRATEGIES, 'dca.ts'), join(dir, 'dca.ts'))
    writeFileSync(join(dir, 'broken.ts'), src({ params: "[{ key: 'size', label: 'S', type: 'number', default: 1 }]" }))
    await r.core.strategyFolder!.rescan()
    const files = await r.session.call('x-gitrader.strategy.files', {})
    expect(files.loaded).toEqual(['dca'])
    const broken = files.files.find((x: { file: string }) => x.file === 'broken.ts')
    expect(broken.status).toBe('error')
    expect(broken.errors[0].rule).toBe('param-key')
    expect(broken.errors[0].message).toBeTruthy()
    expect((await r.session.call('strategy.list', {})).strategies.map((s: { id: string }) => s.id)).toEqual(['dca'])
    expect(await r.session.waitFor(() => r!.session.events.some((e) => e.type === 'strategy.load_failed') && r!.session.events.some((e) => e.type === 'strategy.loaded'), 2000)).toBe(true)
    const h = await r.session.call('engine.health', {})
    expect(h.metrics.strategiesLoaded).toBe(1)
    expect(h.metrics.strategyFileErrors).toBe(1)
  })

  it('没有策略文件夹的引擎：没有任何策略，start 给出可读的指引', async () => {
    r = await rig({ strategiesDir: undefined as never })
    r.core.strategies.remove('ema-trend')
    await bindPaper(r)
    const e = await r.session.expectError('strategy.start', { strategyId: 'x', accountId: PAPER_ACCOUNT, instruments: [BTC], params: {}, mandateId: MANDATE_ID })
    expect(e.message).toMatch(/put a strategy file in the strategies folder/)
  })

  it('运行中的实例钉住启动时的版本：改策略文件不影响它，重启实例才用新版本', async () => {
    const dir = strategyDir([join(FIXTURE_STRATEGIES, 'ema-cross.ts')])
    r = await rig({ strategiesDir: dir })
    await bindPaper(r)
    const { instanceId } = await r.session.call('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: {}, mandateId: MANDATE_ID })
    writeFileSync(join(dir, 'ema-cross.ts'), src({ id: 'ema-trend' }).replace("version: '0.1.0'", "version: '9.9.9'"))
    await r.core.strategyFolder!.rescan()
    expect((await r.session.call('strategy.list', {})).strategies[0].version).toBe('9.9.9')
    expect(r.core.instances.get(instanceId)!.def!.version).toBe('0.1.0')
  })
})
