// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { LLM_LEAK_MARGIN_DAYS } from '@gitrader/protocol/constants'
import { labItems, labItemsNoLastAction } from '../fixtures/lab'
import {
  LAB_TABS, LabShapeError, attachCandidates, attachCmd, biasView, packableRun, packConsequence, shortId, toWindowMs, canonicalStage, filterByCreator, filterRows, lastView, originRows, readPage, rowOf, rowsOf, stageCounts, stageLabel, stamp, trainingCutoffDoubtful, ymd,
} from '../src/model-lab'

const DAY = 86_400_000
import { labDetailAccounts, labDetailStrategies } from '../fixtures/lab-detail'

describe('model-lab · 附加纸面运行 / 出证据包（I-6）', () => {
  it('attachCandidates 只列纸面账户上、运行中、同策略的实例（反例：不列实盘、不列别的策略、不列已停、不列已挂着的）', () => {
    const c = attachCandidates(labDetailItem, labDetailStrategies, labDetailAccounts)
    expect(c.map((x) => x.instanceId)).toEqual(['inst_01JBPAPERGRID0000a1b2c3'])
    expect(c[0]).toMatchObject({ accountId: 'acct_paper1', alias: 'paper-1', engineId: 'ts-builtin' })
    const attached = { ...labDetailItem, runs: [{ stage: 'shadow', accountId: 'acct_paper1', runId: 'r', from: 1, to: null, executor: { kind: 'engine', engineId: 'ts-builtin', instanceId: 'inst_01JBPAPERGRID0000a1b2c3' } }] }
    expect(attachCandidates(attached, labDetailStrategies, labDetailAccounts)).toEqual([])
    expect(attachCandidates({ ...labDetailItem, subject: { params: {} } }, labDetailStrategies, labDetailAccounts)).toEqual([])
    expect(attachCandidates(labDetailItem, { ok: false, error: { message: 'x' } }, labDetailAccounts)).toEqual([])
    expect(attachCmd('EXP-0014', c[0]!)).toEqual({ experimentId: 'EXP-0014', attach: { run: { accountId: 'acct_paper1', executor: { kind: 'engine', engineId: 'ts-builtin', instanceId: 'inst_01JBPAPERGRID0000a1b2c3' } } } })
    expect(shortId('inst_01JBPAPERGRID0000a1b2c3')).toBe('…a1b2c3')
  })
  it('packableRun：已出包或没跑完的不能出；未冻结且没窗口的第一次要填窗口', () => {
    expect(packableRun({ runSummaries: [{ runId: 'r1', status: 'done' }], frozen: { holdout: false } }, 'r1')).toEqual({ ok: true, needsWindow: true })
    expect(packableRun({ runSummaries: [{ runId: 'r1', status: 'done' }], frozen: { holdout: false }, holdoutWindow: { from: 1, to: 2 } }, 'r1')).toEqual({ ok: true, needsWindow: false })
    expect(packableRun({ runSummaries: [{ runId: 'r1', status: 'done' }], frozen: { holdout: true } }, 'r1')).toEqual({ ok: true, needsWindow: false })
    expect(packableRun({ runSummaries: [{ runId: 'r1', status: 'done', packId: 'pck_1' }] }, 'r1')).toMatchObject({ ok: false })
    expect(packableRun({ runSummaries: [{ runId: 'r1', status: 'done' }], packs: [{ runId: 'r1' }] }, 'r1')).toMatchObject({ ok: false })
    expect(packableRun({ runSummaries: [{ runId: 'r1', status: 'running' }] }, 'r1')).toMatchObject({ ok: false, reason: '这次运行还没跑完' })
    expect(packableRun({ runSummaries: [] }, 'r1')).toMatchObject({ ok: false })
    expect(packConsequence({ frozen: { holdout: true } })).toBe('出包后该运行不可重出')
    expect(packConsequence({})).toBe('出包后冻结假设、策略与留出窗口')
  })
  it('toWindowMs 按本机时区转毫秒；空、读不懂、起 ≥ 止都拒', () => {
    expect(toWindowMs('2026-09-01T00:00', '2026-09-30T00:00')).toEqual({ ok: true, window: { from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 8, 30).getTime() } })
    expect(toWindowMs('2026-09-30T00:00', '2026-09-01T00:00')).toMatchObject({ ok: false })
    expect(toWindowMs('2026-09-01T00:00', '2026-09-01T00:00')).toMatchObject({ ok: false })
    expect(toWindowMs('', '2026-09-01T00:00')).toMatchObject({ ok: false })
    expect(toWindowMs('昨天', '2026-09-01T00:00')).toMatchObject({ ok: false })
  })
})
const rows = rowsOf(labItems)

describe('model-lab · 阶段页签计数', () => {
  it('16 条夹具按 全部 16 / 假设 2 / 回测 5 / 保留期 5 / 影子 2 / 小额实盘 2 计数', () => {
    expect(stageCounts(rows)).toEqual({ all: 16, hypothesis: 2, backtest: 5, holdout: 5, shadow: 2, live_small: 2 })
    expect(LAB_TABS.map((t) => t.label)).toEqual(['假设', '回测', '保留期', '影子', '小额实盘'])
  })
  it('页签筛选与计数一致；draft / paper 别名折进假设 / 影子；实盘等只在全部里', () => {
    for (const t of LAB_TABS) expect(filterRows(rows, t.id, 'all')).toHaveLength(stageCounts(rows)[t.id])
    expect(canonicalStage('draft')).toBe('hypothesis')
    expect(canonicalStage('paper')).toBe('shadow')
    expect(stageLabel('paper')).toBe('影子')
    expect(stageLabel('live')).toBe('实盘')
    const extra = rowsOf([{ ...labItems[0], experimentId: 'EXP-x', stage: 'live' }, { ...labItems[1], experimentId: 'EXP-y', stage: 'draft' }])
    expect(stageCounts(extra)).toMatchObject({ all: 2, hypothesis: 1 })
  })
  it('按更新时间新→旧排序，同刻编号大→小', () => {
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 16 }, (_, i) => `EXP-${String(19 - i).padStart(4, '0')}`))
    const tie = rowsOf([{ ...labItems[0], experimentId: 'EXP-a', updatedAt: 5 }, { ...labItems[0], experimentId: 'EXP-b', updatedAt: 5 }])
    expect(tie.map((r) => r.id)).toEqual(['EXP-b', 'EXP-a'])
  })
})

describe('model-lab · 最近动作缺字段标未接通', () => {
  it('回包没有 lastAction（K-r5-1 未落地）→ 每行 last 为 null', () => {
    const bare = rowsOf(labItemsNoLastAction)
    expect(bare).toHaveLength(16)
    expect(bare.every((r) => r.last === null)).toBe(true)
  })
  it('形状不对（缺 at / kind 不认识）同样是 null，不猜', () => {
    expect(lastView({ lastAction: { kind: 'run', running: false } })).toBeNull()
    expect(lastView({ lastAction: { kind: 'snapshot', at: 1 } })).toBeNull()
    expect(lastView({ lastAction: 'x' })).toBeNull()
    expect(lastView({})).toBeNull()
  })
  it('有字段时：运行中 + 回测第 N 次 / 申请晋级', () => {
    const running = rows.find((r) => r.id === 'EXP-0019')!
    expect(running.last).toMatchObject({ text: '回测 第 1 次', running: true })
    expect(rows.filter((r) => r.last?.running)).toHaveLength(1)
    expect(rows.find((r) => r.id === 'EXP-0018')!.last).toMatchObject({ text: '回测 第 4 次', running: false })
    expect(rows.find((r) => r.id === 'EXP-0014')!.last?.text).toBe('申请晋级')
  })
})

describe('model-lab · 创建方筛选', () => {
  it('人 / 引擎 / LLM Agent / 系统四类；人显示「你」，其余取 actor 冒号后的名字', () => {
    expect(filterByCreator(rows, 'human').map((r) => r.id)).toEqual(['EXP-0014', 'EXP-0012', 'EXP-0011', 'EXP-0007', 'EXP-0006', 'EXP-0005'])
    expect(filterByCreator(rows, 'engine').map((r) => r.creatorName)).toEqual(['grid-paper'])
    expect(filterByCreator(rows, 'llm-agent')).toHaveLength(9)
    expect(filterByCreator(rows, 'system')).toHaveLength(0)
    expect(filterByCreator(rows, 'all')).toHaveLength(16)
    expect(rows.find((r) => r.id === 'EXP-0014')!.creatorName).toBe('你')
    expect(rows.find((r) => r.id === 'EXP-0019')!.creatorName).toBe('Claude Code')
  })
  it('页签计数按创建方筛选后的集合算', () => {
    expect(stageCounts(filterByCreator(rows, 'human'))).toEqual({ all: 6, hypothesis: 1, backtest: 0, holdout: 4, shadow: 1, live_small: 0 })
    expect(filterRows(rows, 'holdout', 'human')).toHaveLength(4)
  })
  it('owner 优先于 origin；两者都认不出时按 actor 前缀推，再不行归系统', () => {
    const base = labItems[0]!
    expect(rowOf({ ...base, owner: { actorType: 'engine' } } as never).creatorType).toBe('engine')
    expect(rowOf({ ...base, origin: { ...base.origin, actorType: 'bogus' } } as never).creatorType).toBe('llm-agent')
    expect(rowOf({ ...base, origin: { actor: 'zzz', actorType: 'bogus' } } as never).creatorType).toBe('system')
  })
})

describe('model-lab · 无收益列', () => {
  it('行里没有任何收益 / 夏普 / 回撤字段，前向天数与交易数缺则 null', () => {
    const keys = Object.keys(rows[0]!).join(',')
    expect(keys).not.toMatch(/return|pnl|sharpe|drawdown|roi|apy|收益/i)
    const shadow = rows.find((r) => r.id === 'EXP-0014')!
    expect([shadow.forwardDays, shadow.forwardTrades]).toEqual([14, 23])
    const none = rows.find((r) => r.id === 'EXP-0018')!
    expect([none.forwardDays, none.forwardTrades]).toEqual([null, null])
  })
})

describe('model-lab · 偏差检查与训练截止', () => {
  const cutoff = 1_000 * DAY
  const llm = (trainingCutoff?: number) => ({ involved: true, derivedFrom: 'declared' as const, models: [{ id: 'm', source: 'declared' as const, ...(trainingCutoff === undefined ? {} : { trainingCutoff }) }] })
  const run = (from: number) => [{ stage: 'backtest' as const, from, to: from + DAY }]
  it('训练截止 + 90 天之内起算的回测判存疑；刚好满 90 天不算', () => {
    expect(LLM_LEAK_MARGIN_DAYS).toBe(90)
    expect(trainingCutoffDoubtful({ llm: llm(cutoff), runs: run(cutoff + 89 * DAY) })).toBe(true)
    expect(trainingCutoffDoubtful({ llm: llm(cutoff), runs: run(cutoff + 90 * DAY) })).toBe(false)
    expect(trainingCutoffDoubtful({ llm: llm(cutoff), runs: run(cutoff + 91 * DAY) })).toBe(false)
  })
  it('训练截止未知 → 存疑；没用大模型或没跑过回测 → 不判', () => {
    expect(trainingCutoffDoubtful({ llm: llm(), runs: run(5000 * DAY) })).toBe(true)
    expect(trainingCutoffDoubtful({ llm: { involved: true, derivedFrom: 'declared', models: [] }, runs: run(5000 * DAY) })).toBe(true)
    expect(trainingCutoffDoubtful({ llm: llm(), runs: [] })).toBe(false)
    expect(trainingCutoffDoubtful({ llm: { ...llm(cutoff), involved: false }, runs: run(cutoff) })).toBe(false)
    expect(trainingCutoffDoubtful({ runs: run(cutoff) })).toBe(false)
  })
  it('优先级：未通过 > 存疑 > 通过 n / 2 > 未跑；夹具里 0008 前视未通过、0018 存疑、0019 未跑', () => {
    const by = (id: string) => rows.find((r) => r.id === id)!.bias
    expect(by('EXP-0008')).toEqual({ kind: 'lookahead_fail' })
    expect(by('EXP-0018')).toEqual({ kind: 'cutoff' })
    expect(by('EXP-0019')).toEqual({ kind: 'unrun' })
    expect(by('EXP-0017')).toEqual({ kind: 'pass', passed: 2, total: 2 })
    const sick = { biasChecks: { lookahead: 'pass', recursive: 'fail', trialCount: 1 }, llm: llm(cutoff), runs: run(cutoff) } as never
    expect(biasView(sick)).toEqual({ kind: 'recursive_fail' })
    expect(biasView({ biasChecks: { lookahead: 'pass', recursive: 'not_run', trialCount: 1 } } as never)).toEqual({ kind: 'pass', passed: 1, total: 2 })
    expect(biasView({})).toEqual({ kind: 'unrun' })
  })
})

describe('model-lab · 回包', () => {
  it('items 缺失 → LabShapeError(items)；ok:false 抛内核原文；分页游标原样带出', () => {
    expect(() => readPage({})).toThrow(LabShapeError)
    expect(() => readPage(null)).toThrow('lab.list 回包缺少 items')
    expect(() => readPage({ ok: false, error: { code: 'DATA_UNAVAILABLE', message: '内核原文 X' } })).toThrow('内核原文 X')
    expect(readPage({ items: [1], next: 'c1' })).toEqual({ items: [1], next: 'c1' })
    expect(readPage({ items: [] })).toEqual({ items: [] })
  })
  it('缺 experimentId / stage / title 的条目整条丢掉，不崩', () => {
    expect(rowsOf([null, 3, {}, { experimentId: 'a' }, { ...labItems[0], title: 5 }, labItems[0]])).toHaveLength(1)
  })
  it('stamp 用本地时间 MM-DD HH:mm', () => {
    expect(stamp(new Date(2026, 9, 22, 16, 40).getTime())).toBe('10-22 16:40')
    expect(stamp(new Date(2026, 0, 5, 3, 7).getTime())).toBe('01-05 03:07')
  })
})

// =================================================================================================
// P8 · 实验详情（追加）
// =================================================================================================
import { labDetailEmptyItem, labDetailItem, labDetailRequests, labDetailRunResult } from '../fixtures/lab-detail'
import {
  LabDetailShapeError, actorOf, assumptionRows, backtestRuns, biasRows, curveOf, dataRows, denyText, evidenceRows, exportFileName, forwardView, hasHoldoutWindow, holdoutRun,
  ladderOf, notesOf, pctSigned, pickRun, promotionConsequence, promotionRequest, promotionTarget, readDetail, resultView, runLabel, runSummariesMissing, tradeRows,
} from '../src/model-lab'

const detail = labDetailItem as Record<string, unknown>
const ho = holdoutRun(detail)!
const bt7 = backtestRuns(detail).at(-1)!

describe('model-lab · 三口径着色', () => {
  it('只有前向着色：前向涨 → up、跌 → down、零 / 缺 → neutral；保留期与回测无论多大的正负都是 neutral', () => {
    expect(forwardView(detail)!.tone).toBe('up')
    const down = { ...detail, forward: { ...(detail.forward as object), returnRatio: -0.03 } }
    expect(forwardView(down)!.tone).toBe('down')
    expect(forwardView(down)!.ret).toBe('−3.00%')
    expect(forwardView({ ...detail, forward: { ...(detail.forward as object), returnRatio: 0 } })!.tone).toBe('neutral')
    expect(forwardView({ ...detail, forward: { ...(detail.forward as object), returnRatio: undefined } })!.ret).toBe('无')
    for (const ratio of [0.5, -0.5, 0]) {
      const withRatio = (id: string) => ({ ...labDetailRunResult(id), stats: { ...labDetailRunResult(id).stats, totalReturnRatio: ratio } })
      expect(resultView('backtest', bt7, withRatio(bt7.runId)).tone).toBe('neutral')
      expect(resultView('holdout', ho, withRatio(ho.runId)).tone).toBe('neutral')
    }
  })
  it('数字照稿：前向 +0.46% / 保留期 +1.10% / 回测 +6.20%；指标 交易 · 胜率 · 夏普 · 最大回撤 ｜ 手续费 · 资金费（费用显示成负的现金流）', () => {
    const fw = forwardView(detail)!
    expect(fw.ret).toBe('+0.46%')
    expect(fw.left).toEqual([{ key: '交易', value: '23' }, { key: '胜率', value: '52%' }, { key: '夏普', value: '1.08' }, { key: '最大回撤', value: '−0.52%' }])
    expect(fw.right).toEqual([{ key: '手续费', value: '−3.12' }, { key: '资金费', value: '−0.86' }])
    expect(fw.basis).toBe('纸面')
    expect(fw.account).toEqual({ id: 'acct_paper1', paper: true })
    expect(fw.ccy).toBe('USDC')
    const h = resultView('holdout', ho, labDetailRunResult('run_ho_1'))
    expect(h.ret).toBe('+1.10%')
    expect(h.left.map((r) => r.value)).toEqual(['41', '49%', '0.94', '−0.44%'])
    expect(h.right.map((r) => r.value)).toEqual(['−5.48', '−1.37'])
    expect(h.basis).toBe('样本外')
    expect(h.windowText).toBe('09-01 至 09-30 · 30 天')
    const b = resultView('backtest', bt7, labDetailRunResult('run_bt_7'))
    expect(b.ret).toBe('+6.20%')
    expect(b.windowText).toBe('04-01 至 08-31 · 153 天')
    expect(b.basis).toBe('样本内')
  })
  it('无年化字段渲染：视图对象里没有 annual*，夹具回包里的 annualizedRatio 不会漏进显示；没有统计的项显示「无」', () => {
    const raw = labDetailRunResult('run_bt_7')
    expect(raw.stats.annualizedRatio).toBeGreaterThan(0)
    for (const v of [forwardView(detail)!, resultView('backtest', bt7, raw), resultView('holdout', ho, labDetailRunResult('run_ho_1'))]) {
      expect(JSON.stringify(Object.keys(v))).not.toMatch(/annual/i)
      expect(JSON.stringify(v)).not.toMatch(/annual|年化/i)
    }
    const bare = resultView('backtest', bt7, { stats: { totalReturnRatio: 0.01 }, equity: [] })
    expect(bare.left.map((r) => r.value)).toEqual(['无', '无', '无', '无'])
    expect(bare.right.map((r) => r.value)).toEqual(['无', '无'])
    expect(bare.curve).toBeNull()
  })
  it('没有前向统计 = null（前向 0 天）；多账户相加、按账户过滤快照', () => {
    expect(forwardView(labDetailEmptyItem)).toBeNull()
    expect(forwardView({ ...detail, forward: null })).toBeNull()
    const snaps = [
      { accountId: 'a1', at: 1000, equity: '100' }, { accountId: 'a2', at: 1000, equity: '50' }, { accountId: 'x', at: 1000, equity: '9999' },
      { accountId: 'a1', at: 2000, equity: '110' }, { accountId: 'a2', at: 2000, equity: '50' }, { accountId: 'x', at: 2000, equity: '1' },
    ]
    const v = forwardView({ forward: { ...(detail.forward as object), accountIds: ['a1', 'a2'] }, forwardSnapshots: snaps })!
    expect(v.curve!.pts.map((p) => p.v)).toEqual([150, 160])
    expect(v.account!.id).toBe('a1 +1')
  })
})

describe('model-lab · 回测次数', () => {
  it('回测次数缺省最新：7 次旧→新，不含保留期那一次；选中的不在了也回最新', () => {
    const runs = backtestRuns(detail)
    expect(runs.map((r) => r.runId)).toEqual(Array.from({ length: 7 }, (_, i) => `run_bt_${i + 1}`))
    expect(pickRun(runs, null)).toBe(6)
    expect(pickRun(runs, undefined)).toBe(6)
    expect(pickRun(runs, 'run_bt_3')).toBe(2)
    expect(pickRun(runs, 'gone')).toBe(6)
    expect(runLabel(6, 7)).toBe('第 7 次 / 共 7 次')
    expect(runLabel(0, 7)).toBe('第 1 次 / 共 7 次')
    expect(pickRun([], null)).toBe(-1)
  })
  it('只算跑完的回测：失败 / 排队 / 回放不计；保留期单独取', () => {
    const d = { ...detail, runSummaries: [...(detail.runSummaries as object[]), { runId: 'f', kind: 'backtest', window: { from: 1, to: 2 }, startedAt: 9e15, status: 'failed' }, { runId: 'r', kind: 'replay', window: { from: 1, to: 2 }, startedAt: 9e15, status: 'done' }] }
    expect(backtestRuns(d)).toHaveLength(7)
    expect(holdoutRun(detail)!.runId).toBe('run_ho_1')
    expect(holdoutRun({ ...detail, holdoutRunId: null })).toBeNull()
    expect(hasHoldoutWindow(detail)).toBe(true)
    expect(hasHoldoutWindow(labDetailEmptyItem)).toBe(false)
  })
})

describe('model-lab · 训练截止存疑', () => {
  const cutoff = new Date(2026, 0, 1).getTime()
  const from = (d: number) => cutoff + d * DAY
  const exp = (start: number, models: { trainingCutoff?: number }[] = [{ trainingCutoff: cutoff }]) => ({ llm: { involved: true, derivedFrom: 'declared', models }, runs: [{ stage: 'backtest', from: start, to: null }] }) as never
  it('训练截止 + 90 天判存疑：数据起点早于 截止 + 90 天 → 存疑；恰好 90 天 → 不存疑；少 1 ms → 存疑', () => {
    expect(trainingCutoffDoubtful(exp(from(LLM_LEAK_MARGIN_DAYS)))).toBe(false)
    expect(trainingCutoffDoubtful(exp(from(LLM_LEAK_MARGIN_DAYS) - 1))).toBe(true)
    expect(trainingCutoffDoubtful(exp(from(400)))).toBe(false)
    expect(trainingCutoffDoubtful(exp(from(10), [{}]))).toBe(true) // 训练截止未知
  })
  it('偏差检查四行：不涉及 / 存疑 / 无存疑 / 未通过 / 未跑', () => {
    const d = (over: object) => ({ ...detail, ...over })
    expect(biasRows(detail)).toEqual([{ key: '前视', value: '通过' }, { key: '递归', value: '通过' }, { key: '试验次数', value: '7' }, { key: '训练截止', value: '不涉及', tone: 'muted' }])
    expect(biasRows(d(exp(from(10))))[3]).toEqual({ key: '训练截止', value: '存疑', tone: 'warn' })
    expect(biasRows(d(exp(from(400))))[3]).toEqual({ key: '训练截止', value: '无存疑' })
    expect(biasRows(d({ biasChecks: { lookahead: 'fail', recursive: 'not_run', trialCount: 2 } })).slice(0, 3)).toEqual([{ key: '前视', value: '未通过', tone: 'bad' }, { key: '递归', value: '未跑', tone: 'muted' }, { key: '试验次数', value: '2' }])
    expect(biasRows({})[2]).toEqual({ key: '试验次数', value: '无', tone: 'muted' })
  })
})

describe('model-lab · 曲线', () => {
  it('稿口径：前向 15 点 → 三条刻度 9,900 / 9,950 / 10,000、起点基准线在 52.38%、末点 18.77%', () => {
    const c = forwardView(detail)!.curve!
    expect(c.grid.map((g) => g.label)).toEqual(['9,900', '9,950', '10,000'])
    expect(c.grid.map((g) => Number(g.y.toFixed(2)))).toEqual([82.43, 46.05, 9.68])
    expect(Number(c.base.toFixed(2))).toBe(52.38)
    expect(Number(c.end.y.toFixed(2))).toBe(18.77)
    expect(c.pts).toHaveLength(15)
    expect(c.startLabel).toBe('10-09')
    expect(c.endLabel).toBe('10-22 21:22')
    expect(c.line.startsWith('M0 52.38')).toBe(true)
    expect(c.area.endsWith('L1000 100L0 100Z')).toBe(true)
  })
  it('保留期 / 回测：日期收尾；点数过多时抽稀到 400 以内并保留最后一点；少于 2 点不画', () => {
    expect(resultView('holdout', ho, labDetailRunResult('run_ho_1')).curve!.endLabel).toBe('09-30')
    const many = Array.from({ length: 5000 }, (_, i) => ({ t: i * 60_000, v: 100 + Math.sin(i / 50) }))
    const c = curveOf(many, false)!
    expect(c.pts.length).toBeLessThanOrEqual(401)
    expect(c.pts.at(-1)!.t).toBe(4999 * 60_000)
    expect(c.pts[0]!.x).toBe(0)
    expect(c.pts.at(-1)!.x).toBe(1000)
    expect(curveOf([{ t: 1, v: 1 }], true)).toBeNull()
    expect(curveOf([], true)).toBeNull()
    expect(curveOf([{ t: 1, v: Number.NaN }, { t: 2, v: 1 }], true)).toBeNull()
  })
  it('平线不除零；y 都在 0..100 内', () => {
    const flat = curveOf([{ t: 0, v: 5 }, { t: 1, v: 5 }, { t: 2, v: 5 }], false)!
    expect(flat.pts.every((p) => Number.isFinite(p.y) && p.y >= 0 && p.y <= 100)).toBe(true)
    const wild = curveOf(Array.from({ length: 50 }, (_, i) => ({ t: i, v: (i * 7919) % 101 })), false)!
    expect(wild.pts.every((p) => p.y > 0 && p.y < 100)).toBe(true)
  })
})

describe('model-lab · 回包形状与原文', () => {
  it('lab.get：缺 experimentId / title / stage → LabDetailShapeError（name = LabShapeError，kit 认作未接通）；ok:false 抛内核原文', () => {
    expect(() => readDetail({})).toThrow(LabDetailShapeError)
    expect(() => readDetail({ experimentId: 'a', title: 't' })).toThrow('lab.get 回包缺少 stage')
    expect(() => readDetail(null)).toThrow('lab.get 回包缺少 experimentId')
    expect(() => readDetail({ ok: false, error: { code: 'EXPERIMENT_NOT_FOUND', message: '内核原文 Y' } })).toThrow('内核原文 Y')
    expect(new LabDetailShapeError('lab.get', 'stage').name).toBe('LabShapeError')
    expect(readDetail(detail).experimentId).toBe('EXP-0014')
  })
  it('lab.run：缺 stats → 形状错；ok:false 抛原文', () => {
    expect(() => resultView('backtest', bt7, {})).toThrow('lab.run 回包缺少 stats')
    expect(() => resultView('backtest', bt7, { ok: false, problem: { message: 'EXPERIMENT_EVIDENCE_INCOMPLETE 原文' } })).toThrow('EXPERIMENT_EVIDENCE_INCOMPLETE 原文')
  })
  it('拒绝原文：名字不在消息里才补在前面，消息本身一字不改', () => {
    expect(denyText('forward.spanDays 14 < 21', 'PROMOTION_DENIED')).toBe('PROMOTION_DENIED forward.spanDays 14 < 21')
    expect(denyText('PROMOTION_DENIED forward.spanDays 14 < 21', 'PROMOTION_DENIED')).toBe('PROMOTION_DENIED forward.spanDays 14 < 21')
    expect(denyText('只有消息')).toBe('只有消息')
  })
  it('pctSigned / 导出文件名', () => {
    expect(pctSigned(0.0046)).toBe('+0.46%')
    expect(pctSigned(-0.00004)).toBe('0.00%')
    expect(pctSigned(null)).toBe('无')
    expect(exportFileName('EXP-0014')).toBe('EXP-0014-evidence.json')
  })
})

describe('model-lab · 阶梯 / 晋级目标 / 申请 / 注记', () => {
  it('阶梯五步协议口径，当前一步标 current（paper → 影子）；晋级目标只到小额实盘、不含 live', () => {
    expect(ladderOf('shadow').map((s) => s.label)).toEqual(['假设', '回测', '保留期', '影子', '小额实盘'])
    expect(ladderOf('paper').filter((s) => s.current).map((s) => s.id)).toEqual(['shadow'])
    expect(ladderOf('closed').some((s) => s.current)).toBe(false)
    expect(promotionTarget('draft')).toBe('backtest')
    expect(promotionTarget('shadow')).toBe('live_small')
    expect(promotionTarget('live_small')).toBeNull()
    for (const s of ['live', 'review', 'closed', 'retired', 'nonsense']) expect(promotionTarget(s)).toBeNull()
    for (const s of ['hypothesis', 'backtest', 'holdout', 'shadow', 'live_small']) expect(promotionTarget(s)).not.toBe('live')
  })
  it('Agent 晋级申请：只取本实验、取最新；已晋级到该阶段或更后就不出；回包不对 = null', () => {
    const req = promotionRequest(labDetailRequests, detail as never)!
    expect(req.actor).toEqual({ kind: 'agent', name: 'Claude Code' })
    expect(req.to).toBe('live_small')
    expect(promotionRequest({ entries: labDetailRequests }, detail as never)!.to).toBe('live_small')
    expect(promotionRequest(labDetailRequests, { experimentId: 'EXP-0001', stage: 'shadow' })).toBeNull()
    expect(promotionRequest(labDetailRequests, { ...detail, stage: 'live_small' } as never)).toBeNull()
    expect(promotionRequest(null, detail as never)).toBeNull()
    expect(promotionRequest('x', detail as never)).toBeNull()
    expect(promotionRequest([{ payload: null }, { payload: { kind: 'other' } }], detail as never)).toBeNull()
    const newer = [...labDetailRequests, { ...labDetailRequests[0]!, seq: 400, ts: labDetailRequests[0]!.ts + 5, payload: { kind: 'experiment_promotion_request', experimentId: 'EXP-0014', to: 'live_small', n: 2 } }]
    expect(promotionRequest(newer, detail as never)!.at).toBe(labDetailRequests[0]!.ts + 5)
  })
  it('注记 = notes + conclusions + 晋级申请，新→旧；人显示「你」', () => {
    const rows = notesOf(detail, promotionRequest(labDetailRequests, detail as never))
    expect(rows.map((r) => r.text)).toEqual(['申请晋级 小额实盘', '导出证据包', '前向开始 paper-1', '登记 冻结假设与保留期'])
    expect(rows.map((r) => r.actor.name)).toEqual(['Claude Code', '你', '系统', '你'])
    expect(rows.map((r) => r.kind)).toEqual(['promotion', 'note', 'note', 'note'])
    expect(notesOf(detail, null)).toHaveLength(3)
    const withConclusion = notesOf({ conclusions: [{ text: '放弃', at: 5, origin: { actor: 'user:local', actorType: 'human' } }], notes: [{ text: 'n', at: 1, origin: {} }, { text: '', at: 2 }, { at: 3 }] }, null)
    expect(withConclusion.map((r) => r.text)).toEqual(['结论 放弃', 'n'])
    expect(actorOf({ actor: 'engine:grid-paper', actorType: 'engine' })).toEqual({ kind: 'engine', name: 'grid-paper' })
    expect(actorOf(undefined)).toEqual({ kind: 'system', name: '系统' })
  })
  it('弹出卡证据事实与后果；小额实盘写策略号', () => {
    expect(evidenceRows(detail)).toEqual([
      { key: '当前阶段', value: '影子' }, { key: '前向天数', value: '14 天' }, { key: '前向交易', value: '23' }, { key: '偏差检查', value: '通过 2 / 2' }, { key: '试验次数', value: '7' },
    ])
    expect(evidenceRows(labDetailEmptyItem).map((r) => r.value)).toEqual(['假设', '无', '无', '未跑', '无'])
    expect(promotionConsequence(detail, 'live_small')).toBe('晋级后可在实盘账户启动 grid-paper')
    expect(promotionConsequence(labDetailEmptyItem, 'live_small')).toBe('晋级后可在实盘账户启动 本实验的策略')
    expect(promotionConsequence(detail, 'holdout')).toBe('晋级后阶段变为 保留期')
  })
})

describe('model-lab · 右列三卡', () => {
  it('假设七项：场所费率 / 5 bp / next-bar-open / 计入 / 计入 / 成交量上限缺 / 延迟 200 ms；没写的项「缺」+ 琥珀', () => {
    const rows = assumptionRows(detail.assumptions)!
    expect(rows.map((r) => `${r.key}:${r.value}`)).toEqual(['手续费:场所费率', '滑点:5 bp', '成交模型:next-bar-open', '资金费:计入', '强平:计入', '成交量上限:缺', '延迟:200 ms'])
    expect(rows.filter((r) => r.tone === 'warn').map((r) => r.key)).toEqual(['成交量上限'])
    expect(assumptionRows(undefined)).toBeNull()
    const sparse = assumptionRows({ fees: { maker: '0.0002', taker: '0.0005' }, funding: false, maxVolumeShare: 0.1 })!
    expect(sparse.map((r) => r.value)).toEqual(['maker 0.0002 / taker 0.0005', '缺', '缺', '不计入', '缺', '10%', '缺'])
  })
  it('数据与来历：数据 / 区间 / 摘要（可复制）/ 协议（可复制）/ 派生自（链接）；没有的写「无」', () => {
    const rows = dataRows(detail)
    expect(rows.map((r) => `${r.key}:${r.value}`)).toEqual(['数据:candles BTC-PERP 15m', '区间:04-01 至 09-30', '摘要:sha256 7c41', '协议:3f2a9c1e', '派生自:EXP-0011'])
    expect(rows[2]!.copy).toHaveLength(64)
    expect(rows[3]!.copy).toHaveLength(64)
    expect(rows[4]!.href).toBe('#/lab/EXP-0011')
    expect(dataRows(labDetailEmptyItem).map((r) => r.value)).toEqual(['无', '无', '无'])
  })
  it('成交页签：新→旧，盈亏带符号，买卖用中文', () => {
    const rows = tradeRows(labDetailRunResult('run_bt_7'))
    expect(rows).toHaveLength(30)
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort((a, b) => b - a))
    expect(new Set(rows.map((r) => r.side))).toEqual(new Set(['买入', '卖出']))
    expect(tradeRows({ trades: [{ t: 1, side: 'buy', price: 1234.5, size: 1, pnl: -2, fee: 0.5, reason: 'x' }, { t: 2, side: 'oops', price: 1, size: 1 }, null] })).toEqual([
      { at: 1, side: '买入', price: '1,234.50', size: '1', pnl: '−2.00', fee: '−0.50', reason: 'x' },
    ])
    expect(tradeRows(null)).toEqual([])
    expect(tradeRows({ trades: Array.from({ length: 300 }, (_, i) => ({ t: i, side: 'buy', price: 1, size: 1, pnl: 0, fee: 0 })) })).toHaveLength(200)
  })
})

describe('model-lab · 三口径各取各的 run，不借用', () => {
  it('三张口径卡数据互不相同：前向 / 保留期 / 回测的区间收益、指标、曲线都不同（夹具按稿：+0.46% / +1.10% / +6.20%）', () => {
    const fw = forwardView(detail)!
    const h = resultView('holdout', ho, labDetailRunResult(ho.runId))
    const b = resultView('backtest', bt7, labDetailRunResult(bt7.runId))
    expect(new Set([fw.ret, h.ret, b.ret]).size).toBe(3)
    expect(new Set([JSON.stringify([fw.left, fw.right]), JSON.stringify([h.left, h.right]), JSON.stringify([b.left, b.right])]).size).toBe(3)
    expect(new Set([fw.curve!.line, h.curve!.line, b.curve!.line]).size).toBe(3)
    expect(h.left.map((r) => r.value)).toEqual(['41', '49%', '0.94', '−0.44%'])
    expect(b.left.map((r) => r.value)).toEqual(['286', '54%', '1.31', '−1.79%'])
    // 回测 7 次之间也各不相同
    const rets = backtestRuns(detail).map((r) => resultView('backtest', r, labDetailRunResult(r.runId)).ret)
    expect(new Set(rets).size).toBe(7)
  })
  it('保留期与回测取的是各自的 run：holdoutRun 是 holdoutRunId，backtestRuns 不含它；两者 specDigest 不同', () => {
    expect(ho.runId).toBe('run_ho_1')
    expect(backtestRuns(detail).some((r) => r.runId === ho.runId)).toBe(false)
    expect(ho.specDigest).toBeTruthy()
    expect(ho.specDigest).not.toBe(bt7.specDigest)
  })
  it('缺某阶段数据 → 不借用：回来的结果不是所请求的那次运行（specDigest 对不上）→ 形状错（kit 认作未接通），不出任何数字', () => {
    expect(() => resultView('holdout', ho, labDetailRunResult(bt7.runId))).toThrow(LabDetailShapeError)
    expect(() => resultView('holdout', ho, labDetailRunResult(bt7.runId))).toThrow('specDigest 与 run_ho_1 不符')
    expect(() => resultView('backtest', bt7, labDetailRunResult(ho.runId))).toThrow(LabDetailShapeError)
    // 回包或 run 摘要没带 specDigest 时不比（内核旧版）：照常画
    expect(resultView('holdout', { ...ho, specDigest: undefined }, labDetailRunResult(bt7.runId)).ret).toBe('+6.20%')
    const { specDigest: _drop, ...bare } = labDetailRunResult(ho.runId)
    expect(resultView('holdout', ho, bare).ret).toBe('+1.10%')
  })
  it('lab.get 没带 runSummaries → 保留期 / 回测都未接通（字段名原文），前向不受影响；没有保留期的 run = 空态而不是回退回测', () => {
    const err = runSummariesMissing({ ...detail, runSummaries: undefined })!
    expect(err).toBeInstanceOf(LabDetailShapeError)
    expect(err.message).toBe('lab.get 回包缺少 runSummaries')
    expect(err.name).toBe('LabShapeError')
    expect(runSummariesMissing(detail)).toBeNull()
    expect(runSummariesMissing(labDetailEmptyItem)).toBeNull()
    expect(forwardView({ ...detail, runSummaries: undefined })!.ret).toBe('+0.46%')
    expect(holdoutRun({ ...detail, holdoutRunId: null })).toBeNull()
    expect(backtestRuns({ ...detail, holdoutRunId: null })).toHaveLength(8) // 没标保留期时，那一次按普通回测算，仍不会出现在保留期卡里
  })
})

describe('model-lab · 数据与来历补齐实验自身字段（GQ-34）', () => {
  it('originRows lists hypothesis, strategy, params, holdout window and llm; empty ones say 无', () => {
    const rows = originRows({ hypothesis: 'x', subject: { strategy: { id: 'grid-paper', version: '0.3.1' }, params: { grids: 12, mode: 'arithmetic' } },
      holdoutWindow: { from: 1_730_000_000_000, to: 1_731_000_000_000 }, frozen: { holdout: true },
      llm: { involved: true, derivedFrom: 'creator', models: [{ id: 'm1', trainingCutoff: 1_700_000_000_000, source: 'declared' }] } })
    expect(rows.map((r) => r.key)).toEqual(['假设', '策略', 'grids', 'mode', '留出', '大模型', '模型'])
    expect(rows.find((r) => r.key === '策略')!.value).toBe('grid-paper 0.3.1')
    expect(rows.find((r) => r.key === '留出')!.value).toContain('已冻结')
    expect(rows.find((r) => r.key === '大模型')!.value).toBe('参与 · 创建者是 Agent')
    expect(rows.find((r) => r.key === '模型')!.value).toBe(`m1 · 截止 ${ymd(1_700_000_000_000)} · 自报`)
  })
  it('originRows of an empty experiment is all 无 (反例：不抛、不省略)', () => {
    const rows = originRows({})
    expect(rows.map((r) => r.key)).toEqual(['假设', '策略', '参数', '留出', '大模型'])
    expect(rows.every((r) => (r.value === '无' || r.value === '未参与') && r.tone === 'muted')).toBe(true)
  })
  it('more than eight params fold into 另 N 项; workflow subjects say 工作流', () => {
    const params = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, i]))
    const rows = originRows({ subject: { workflow: { id: 'wf', version: '1' }, params } })
    expect(rows.find((r) => r.key === '工作流')!.value).toBe('wf 1')
    expect(rows.filter((r) => r.key.startsWith('p'))).toHaveLength(8)
    expect(rows.find((r) => r.key === '参数')).toMatchObject({ value: '另 3 项', tone: 'muted' })
  })
  it('kernel-table models are not marked 自报 and dataRows stays as before', () => {
    expect(originRows({ llm: { involved: true, derivedFrom: 'workflow', models: [{ id: 'k', source: 'kernel-table' }] } }).slice(-1)[0]!.value).toBe('k')
    expect(dataRows({}).map((r) => r.key)).toEqual(['数据', '协议', '派生自'])
  })
})
