// SPDX-License-Identifier: CPAL-1.0
// 实验列表夹具：16 条，与 reports/visual-r5/lab/index.html 同口径（阶段页签 全部 16 / 假设 2 / 回测 5 / 保留期 5 / 影子 2 / 小额实盘 2）。
// 错误态与未接通态不写 queries：stage-entry 按场景让内核回 ok:false / 未知方法，错误原文由内核给。
type Stage = 'hypothesis' | 'backtest' | 'holdout' | 'shadow' | 'live_small'
type Bias = 'pass' | 'unrun' | 'cutoff' | 'lookahead'
type Who = 'claude' | 'codex' | 'me' | 'grid'
type Kind = 'run' | 'stage' | 'note' | 'promotion_request'

const at = (month: number, day: number, hour: number, minute: number): number => new Date(2026, month - 1, day, hour, minute).getTime()
const DAY = 86_400_000

const WHO: Record<Who, { actor: string; actorType: 'human' | 'engine' | 'llm-agent' }> = {
  claude: { actor: 'agent:Claude Code', actorType: 'llm-agent' },
  codex: { actor: 'agent:Codex CLI', actorType: 'llm-agent' },
  me: { actor: 'user:local', actorType: 'human' },
  grid: { actor: 'engine:grid-paper', actorType: 'engine' },
}

interface Spec {
  n: number; title: string; stage: Stage; created: number
  fwd?: [days: number, trades: number]
  trials: number; bias: Bias; who: Who
  last: { at: number; kind: Kind; runStage?: Stage; running?: boolean }
}
const SPECS: Spec[] = [
  { n: 19, title: '订单簿失衡 ETH 5m', stage: 'hypothesis', created: at(10, 22, 16, 40), trials: 1, bias: 'unrun', who: 'claude', last: { at: at(10, 22, 16, 41), kind: 'run', runStage: 'backtest', running: true } },
  { n: 18, title: '资金费回归 ETH 1h', stage: 'backtest', created: at(10, 20, 11, 2), trials: 4, bias: 'cutoff', who: 'claude', last: { at: at(10, 21, 14, 5), kind: 'run', runStage: 'backtest' } },
  { n: 17, title: '成交量突增 SOL 1h', stage: 'backtest', created: at(10, 17, 15, 31), trials: 6, bias: 'pass', who: 'codex', last: { at: at(10, 18, 9, 40), kind: 'run', runStage: 'backtest' } },
  { n: 16, title: 'RSI 背离 BTC 1h', stage: 'holdout', created: at(10, 14, 10, 12), trials: 15, bias: 'pass', who: 'claude', last: { at: at(10, 20, 18, 22), kind: 'run', runStage: 'holdout' } },
  { n: 15, title: '网格 ETH 震荡区间', stage: 'backtest', created: at(10, 11, 9, 48), trials: 2, bias: 'pass', who: 'grid', last: { at: at(10, 12, 11, 16), kind: 'run', runStage: 'backtest' } },
  { n: 14, title: '网格 BTC 震荡区间', stage: 'shadow', created: at(10, 8, 14, 20), fwd: [14, 23], trials: 7, bias: 'pass', who: 'me', last: { at: at(10, 22, 9, 12), kind: 'promotion_request' } },
  { n: 13, title: '均值回归 SOL 15m', stage: 'shadow', created: at(9, 22, 17, 5), fwd: [13, 31], trials: 9, bias: 'pass', who: 'claude', last: { at: at(10, 22, 0, 0), kind: 'run', runStage: 'shadow' } },
  { n: 12, title: '资金费套利 BTC 8h', stage: 'holdout', created: at(9, 19, 13, 20), trials: 3, bias: 'pass', who: 'me', last: { at: at(10, 2, 16, 30), kind: 'run', runStage: 'holdout' } },
  { n: 11, title: '网格 BTC 宽区间', stage: 'holdout', created: at(9, 15, 20, 44), trials: 5, bias: 'pass', who: 'me', last: { at: at(9, 20, 10, 8), kind: 'run', runStage: 'holdout' } },
  { n: 10, title: '波动收缩突破 BTC 1h', stage: 'live_small', created: at(9, 10, 11, 30), fwd: [21, 38], trials: 11, bias: 'pass', who: 'codex', last: { at: at(10, 22, 0, 0), kind: 'run', runStage: 'live_small' } },
  { n: 9, title: 'EMA 交叉 BTC 4h', stage: 'live_small', created: at(9, 2, 10, 15), fwd: [24, 14], trials: 7, bias: 'pass', who: 'claude', last: { at: at(10, 22, 0, 0), kind: 'run', runStage: 'live_small' } },
  { n: 8, title: '动量轮动 主流币 1d', stage: 'backtest', created: at(8, 30, 21, 6), trials: 23, bias: 'lookahead', who: 'codex', last: { at: at(9, 2, 13, 51), kind: 'note' } },
  { n: 7, title: '开盘区间突破 BTC 15m', stage: 'holdout', created: at(8, 27, 9, 33), trials: 8, bias: 'pass', who: 'me', last: { at: at(9, 5, 22, 14), kind: 'run', runStage: 'holdout' } },
  { n: 6, title: 'VWAP 回归 BTC 15m', stage: 'holdout', created: at(8, 25, 14, 2), trials: 4, bias: 'pass', who: 'me', last: { at: at(9, 1, 15, 37), kind: 'run', runStage: 'holdout' } },
  { n: 5, title: '资金费套利 ETH 8h', stage: 'hypothesis', created: at(8, 22, 18, 47), trials: 0, bias: 'unrun', who: 'me', last: { at: at(8, 22, 18, 47), kind: 'stage' } },
  { n: 4, title: '均线带 BTC 1d', stage: 'backtest', created: at(8, 20, 10, 0), trials: 3, bias: 'pass', who: 'claude', last: { at: at(8, 24, 8, 30), kind: 'run', runStage: 'backtest' } },
]

function experiment(s: Spec) {
  const id = `EXP-${String(s.n).padStart(4, '0')}`
  const who = WHO[s.who]
  const dataFrom = at(1, 1, 0, 0)
  const cutoff = dataFrom - 30 * DAY // 训练截止在数据起点前 30 天，不足 90 天余量 → 存疑
  const lastRun = s.last.runStage
  const runs = s.last.kind === 'run' && lastRun
    ? Array.from({ length: Math.max(1, lastRun === 'backtest' ? s.trials : 1) }, (_, i) => ({ stage: lastRun, from: dataFrom, to: dataFrom + 90 * DAY, attachedAt: s.created + (i + 1) * 60_000 }))
    : []
  return {
    experimentId: id,
    title: s.title,
    hypothesis: s.title,
    stage: s.stage,
    subject: { params: {} },
    origin: { actor: who.actor, actorType: who.actorType, tool: 'lab.create', requestId: `req-${id}`, via: 'mcp' },
    createdAt: s.created,
    updatedAt: at(10, 1, 0, 0) + s.n * 60_000,
    biasChecks: { lookahead: s.bias === 'lookahead' ? 'fail' : s.bias === 'unrun' ? 'not_run' : 'pass', recursive: s.bias === 'unrun' ? 'not_run' : 'pass', trialCount: s.trials },
    ...(runs.length ? { runs } : {}),
    ...(s.bias === 'cutoff' ? { llm: { involved: true, derivedFrom: 'declared', models: [{ id: 'fixture-model', trainingCutoff: cutoff, source: 'declared' }] } } : {}),
    ...(s.fwd ? { forward: { sample: { trades: s.fwd[1], fills: s.fwd[1], roundTrips: s.fwd[1], spanDays: s.fwd[0], activeDays: s.fwd[0], snapshotDays: s.fwd[0] } } } : {}),
    // K-r5-1 建议形状；内核补字段前真实回包没有它（labItemsNoLastAction 是去掉它的版本）
    lastAction: { kind: s.last.kind, at: s.last.at, running: s.last.running === true },
  }
}

export const labItems = SPECS.map(experiment)
/** 去掉 lastAction 的回包：内核补 K-r5-1 之前就是这样，「最近动作」整列显示未接通。 */
export const labItemsNoLastAction = labItems.map((item) => {
  const copy: Record<string, unknown> = { ...item }
  delete copy.lastAction
  return copy
})

const list = { view: 'list', queries: { 'lab.list': { items: labItems } } }
export const labFixtures = {
  normal: list,
  empty: { view: 'list', queries: { 'lab.list': { items: [] } } },
  loading: list,
  error: { view: 'list' },
  offline: list,
  unwired: { view: 'list' },
}
