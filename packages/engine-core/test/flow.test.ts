// SPDX-License-Identifier: CPAL-1.0
// 工作流 JSON 运行器（gitrader-workflow/2）：模板与原策略逐笔一致、校验（schema 层 + 语义层）、解释器。搬运自 Demo test/flow.test.ts。
import { describe, expect, it } from 'vitest'
import { runBacktest } from '../src/strategy'
import { backtestWorkflow, evaluateWorkflow, nodeCatalog, validateWorkflow } from '../src/flow'
import { WORKFLOW_TEMPLATES, templateOf } from './fixtures/workflow-templates'
import { ALL as STRATEGIES } from './defs'
import type { Workflow } from '../src/flow'
import { mk } from './helpers'

// 趋势 + 震荡 + 噪声，保证五个策略都会开平仓
const closes = Array.from({ length: 900 }, (_, i) => 100 + 25 * Math.sin(i / 40) + 8 * Math.sin(i / 7) + i * 0.02 + ((i * 7919) % 13) * 0.15)
const candles = mk(closes)
const opts = { feeRate: 0.00045, slippageBps: 2 }
const src = { author: 'test', license: 'Apache-2.0' }

describe('工作流引擎：模板与原策略一致', () => {
  it('五个模板都符合 gitrader-workflow/2 schema，通过校验，且可回测', () => {
    expect(WORKFLOW_TEMPLATES.map((w) => w.meta?.strategyId)).toEqual(['ema-trend', 'mean-reversion', 'breakout', 'grid', 'dca'])
    for (const w of WORKFLOW_TEMPLATES) {
      expect(w.schema).toBe('gitrader-workflow/2')
      const v = validateWorkflow(w)
      expect(v.errors, w.id).toEqual([])
      expect(v.ok && v.backtestable, w.id).toBe(true)
      expect(v.primarySignal, w.id).not.toBeNull()
      expect(w.meta?.source?.author).toBe('Gitrader')
      expect(templateOf(w.meta!.strategyId!)?.id).toBe(w.id)
    }
  })

  for (const s of STRATEGIES) {
    it(`${s.id}：模板回测与原策略逐笔一致（统计 / 成交 / 权益曲线）`, async () => {
      const tpl = templateOf(s.id)!
      const a = runBacktest(s, candles, s.id === 'grid' ? { center: closes[0] } : {}, opts)
      const b = await backtestWorkflow(tpl, candles, { ...opts, params: s.id === 'grid' ? { center: closes[0]! } : {} })
      expect(a.trades.length).toBeGreaterThan(0)
      const norm = (r: { trades: typeof a.trades }): unknown[] => r.trades.map((t) => [t.t, t.side, Number(t.price.toFixed(8)), Number(t.size.toFixed(8))])
      expect(norm(b.result)).toEqual(norm(a))
      expect(b.result.stats).toEqual(a.stats)
      expect(b.result.equity.length).toBe(a.equity.length)
      expect(b.result.equity.at(-1)!.v).toBeCloseTo(a.equity.at(-1)!.v, 6)
    })
  }

  it('工作流参数覆盖（$fast / $slow）生效，且与原策略同参数一致', async () => {
    const tpl = templateOf('ema-trend')!
    const a = runBacktest(STRATEGIES[0]!, candles, { fast: 8, slow: 30 }, opts)
    const b = await backtestWorkflow(tpl, candles, { ...opts, params: { fast: 8, slow: 30 } })
    expect(b.result.stats).toEqual(a.stats)
  })

  it('叠加线：ema 模板有两条 EMA，布林模板有上中下轨', async () => {
    const e = await backtestWorkflow(templateOf('ema-trend')!, candles, opts)
    expect(new Set(Object.keys(e.result.overlays))).toEqual(new Set(['慢线(60)', '快线(20)']))
    const m = await backtestWorkflow(templateOf('mean-reversion')!, candles, opts)
    expect(Object.keys(m.result.overlays).length).toBe(3)
  })
})

describe('工作流 JSON：schema 层', () => {
  const clone = (): Workflow => JSON.parse(JSON.stringify(templateOf('ema-trend')!)) as Workflow
  const msgs = (w: unknown): string => validateWorkflow(w).errors.map((e) => e.message).join('|')

  it('v1 的 schema 串、顶层 authority、缺必填、id 格式不对都在 schema 层被拒', () => {
    const v1 = clone() as unknown as Record<string, unknown>
    v1.schema = 'gitrader-workflow/1'
    expect(validateWorkflow(v1).ok).toBe(false)
    const auth = clone() as unknown as Record<string, unknown>
    auth.authority = 'full' // 运行权限不再写在工作流里（§5.9）
    expect(msgs(auth)).toMatch(/authority/)
    const noNodes = clone() as unknown as Record<string, unknown>
    delete noNodes.nodes
    expect(validateWorkflow(noNodes).ok).toBe(false)
    const badId = clone()
    badId.id = 'A'
    expect(validateWorkflow(badId).ok).toBe(false)
    expect(validateWorkflow(42).ok).toBe(false)
    expect(validateWorkflow(null).ok).toBe(false)
  })

  it('requires 钉版本：格式不对被拒；合法的放行', () => {
    const w = clone()
    w.requires = [{ kind: 'plugin', id: 'p', version: '1.0', sha256: 'sha256:' + 'a'.repeat(64) }]
    expect(validateWorkflow(w).ok).toBe(false)
    w.requires = [{ kind: 'plugin', id: 'p', version: '1.0.0', sha256: 'sha256:' + 'a'.repeat(64) }]
    expect(validateWorkflow(w).ok).toBe(true)
  })

  it('model.research 已在 v2 删除；插件节点本引擎没有加载', () => {
    const w = clone()
    w.nodes.push({ id: 'r', type: 'model.research', params: {} })
    expect(msgs(w)).toMatch(/model\.research.*已删除/)
    const p = clone()
    p.nodes.push({ id: 'pl', type: 'plugin:vendor.demo@1.0.0/ind.foo', params: {} })
    expect(msgs(p)).toMatch(/插件节点/)
  })
})

describe('工作流 JSON：语义层', () => {
  const clone = (): Workflow => JSON.parse(JSON.stringify(templateOf('ema-trend')!)) as Workflow
  const msgs = (w: Workflow): string => validateWorkflow(w).errors.map((e) => e.message).join('|')

  it('端口类型不匹配 / 缺必填输入 / 多线接同一输入 / 环 / 未知节点 / 未知参数引用 都被拒并说明', () => {
    const w1 = clone(); w1.edges.push({ from: { node: 'k', port: 'close' }, to: { node: 'long', port: 'a' } })
    expect(msgs(w1)).toMatch(/类型不匹配|接了多条线/)
    const w2 = clone(); w2.edges = w2.edges.filter((e) => !(e.to.node === 'f_gt_s' && e.to.port === 'b'))
    expect(msgs(w2)).toMatch(/必填输入 b/)
    const w3 = clone(); w3.edges.push({ from: { node: 'sig', port: 'signal' }, to: { node: 'ema_f', port: 'src' } })
    expect(msgs(w3)).toMatch(/类型不匹配|接了多条线/)
    const w4 = clone(); w4.nodes.push({ id: 'x', type: 'ind.nope', params: {} })
    expect(msgs(w4)).toMatch(/类型 ind.nope 不存在/)
    const w5 = clone(); w5.nodes.find((n) => n.id === 'ema_f')!.params.period = '$nope'
    expect(msgs(w5)).toMatch(/不存在的工作流参数/)
    const w6: Workflow = { schema: 'gitrader-workflow/2', id: 'cyc', name: '环', version: 1, params: {}, nodes: [{ id: 'a', type: 'math.op', params: {} }, { id: 'b', type: 'math.op', params: {} }], edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'a' } }, { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'a' } }, { from: { node: 'a', port: 'out' }, to: { node: 'a', port: 'b' } }] }
    expect(msgs(w6)).toMatch(/环|自己/)
  })

  it('number 可以广播接到 series；信号不能接到 series', () => {
    const w: Workflow = { schema: 'gitrader-workflow/2', id: 'bc', name: '广播', version: 1, params: {}, meta: { source: src },
      nodes: [{ id: 'k', type: 'data.candles', params: {} }, { id: 'c', type: 'math.const', params: { value: 100 } }, { id: 'cmp', type: 'cond.compare', params: { op: '>' } }, { id: 's', type: 'sig.state', params: {} }, { id: 'o', type: 'act.signal', params: {} }],
      edges: [{ from: { node: 'k', port: 'close' }, to: { node: 'cmp', port: 'a' } }, { from: { node: 'c', port: 'value' }, to: { node: 'cmp', port: 'b' } }, { from: { node: 'cmp', port: 'out' }, to: { node: 's', port: 'enterLong' } }, { from: { node: 's', port: 'signal' }, to: { node: 'o', port: 'signal' } }] }
    expect(validateWorkflow(w).ok).toBe(true)
    const bad = JSON.parse(JSON.stringify(w)) as Workflow
    bad.edges.push({ from: { node: 's', port: 'signal' }, to: { node: 'cmp', port: 'a' } })
    expect(validateWorkflow(bad).ok).toBe(false)
  })

  it('含实时节点 / 没有信号终点 → 校验通过但不可回测，并给出原因；回测直接拒绝', async () => {
    const w = clone()
    w.nodes.push({ id: 'pos', type: 'data.position', params: {} })
    const v = validateWorkflow(w)
    expect(v.ok).toBe(true)
    expect(v.backtestable).toBe(false)
    expect(v.backtestBlockers.join('|')).toMatch(/实时节点/)
    await expect(backtestWorkflow(w, candles, opts)).rejects.toThrow(/不能回测/)
    const w2 = clone()
    const drop = ['out_signal', 'size', 'precheck', 'place']
    w2.nodes = w2.nodes.filter((n) => !drop.includes(n.id))
    w2.edges = w2.edges.filter((e) => !drop.includes(e.to.node) && !drop.includes(e.from.node))
    expect(validateWorkflow(w2).backtestable).toBe(false)
  })

  it('解释器：同一张图输出每个节点的整段序列；SMA 与交叉正确', async () => {
    const w: Workflow = { schema: 'gitrader-workflow/2', id: 'xw', name: 'x', version: 1, params: { p: 3 }, meta: { source: src },
      nodes: [{ id: 'k', type: 'data.candles', params: {} }, { id: 'a', type: 'ind.sma', params: { period: '$p' } }, { id: 'b', type: 'ind.sma', params: { period: 6 } }, { id: 'x', type: 'cond.cross', params: {} }, { id: 'log', type: 'out.log', params: {} }],
      edges: [{ from: { node: 'k', port: 'close' }, to: { node: 'a', port: 'src' } }, { from: { node: 'k', port: 'close' }, to: { node: 'b', port: 'src' } }, { from: { node: 'a', port: 'out' }, to: { node: 'x', port: 'a' } }, { from: { node: 'b', port: 'out' }, to: { node: 'x', port: 'b' } }, { from: { node: 'x', port: 'up' }, to: { node: 'log', port: 'value' } }] }
    const cs = mk([10, 10, 10, 10, 10, 10, 9, 8, 7, 8, 9, 12, 14])
    const ev = await evaluateWorkflow(w, cs, { mode: 'backtest', run: { instrumentId: 'hyperliquid:T', interval: '1h' } })
    const sma3 = ev.values.a!.out as Array<number | null>
    expect(sma3.slice(0, 2)).toEqual([null, null])
    expect(sma3[2]).toBeCloseTo(10, 9)
    expect(sma3[8]).toBeCloseTo(8, 9)
    const upX = ev.values.x!.up as boolean[]
    expect(upX.filter(Boolean).length).toBeGreaterThanOrEqual(1)
    expect(upX.findIndex(Boolean)).toBeGreaterThan(8)
  })

  it('节点库：除已删除的 LLM 节点外，七个分组都有节点；每个节点规格完整', () => {
    const cat = nodeCatalog()
    expect(new Set(cat.map((c) => c.group))).toEqual(new Set(['data', 'indicator', 'condition', 'model', 'risk', 'action', 'output']))
    expect(cat.some((c) => c.kind === 'model.research')).toBe(false)
    for (const c of cat) { expect(c.kind).toMatch(/^[a-z]+\.[a-z]+$/); expect(c.name).toBeTruthy(); expect(c.desc).toBeTruthy() }
  })
})
