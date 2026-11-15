// SPDX-License-Identifier: CPAL-1.0
// 实验详情夹具：EXP-0014「网格 BTC 震荡区间」，与 reports/visual-r5/lab-detail/index.html 同口径
// （前向 14 天 +0.46% / 保留期 30 天 +1.10% / 回测第 7 次共 7 次 +6.20%；假设七项缺成交量上限；晋级申请来自 Claude Code）。
// 错误态与未接通态不写 queries：stage-entry 按场景让内核回 ok:false / 未知方法，错误原文由内核给。
const at = (month: number, day: number, hour = 0, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime()
const sha = (head: string): string => `sha256:${head}${'0123456789abcdef'.repeat(4).slice(0, 64 - head.length)}`

const origin = (actor: string, actorType: 'human' | 'engine' | 'llm-agent' | 'system') => ({ actor, actorType, tool: 'lab.fixture', requestId: 'req-fixture', via: 'mcp' })
const ME = origin('user:local', 'human')
const SYSTEM = origin('system:lab', 'system')

const EXP_ID = 'EXP-0014'
const ACCOUNT = 'acct_paper1'

// 前向：稿里 15 个点（10-09 09:00 起点、每日 0 点收盘、10-22 21:22 末点）
const FORWARD_EQUITY = [9941.3, 9924.25, 9914.9, 9889.15, 9908.48, 9916.49, 9943.54, 9960.2, 9945.72, 9970.46, 9948.07, 9955.58, 9982.43, 10000, 9987.5]
const forwardAt = (i: number): number => (i === 0 ? at(10, 9, 9, 0) : i === FORWARD_EQUITY.length - 1 ? at(10, 22, 21, 22) : at(10, 9 + i, 0, 0))
const forwardSnapshots = FORWARD_EQUITY.map((v, i) => ({
  seq: 100 + i, accountId: ACCOUNT, at: forwardAt(i), recordedAt: forwardAt(i), kind: i === 0 ? 'stage' : 'daily',
  equity: v.toFixed(2), unrealizedPnl: '0', valuationCcy: 'USDC',
  attestation: { alg: 'ed25519', keyId: 'fixture', digest: sha('aa'), sig: 'fixture' },
}))

// 保留期：稿里 31 个点
const HOLDOUT_EQUITY = [10000, 10024.35, 10044.14, 10038.37, 10070.69, 10041.65, 10026.59, 10059.75, 10056.31, 10043.29, 10063.81, 10053.31, 10058.39, 10049.51, 10089.01, 10051.21, 10075.37, 10072.43, 10109.36, 10100.58, 10096.18, 10120.11, 10133.49, 10122.84, 10131.25, 10114.68, 10101.88, 10113.86, 10107.83, 10089.09, 10110]

/** 固定种子的游走：首末点精确落在 start / end（布朗桥），夹具每次生成同一条曲线。 */
function walk(seed: number, count: number, start: number, end: number, vol: number): number[] {
  let s = seed
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 - 0.5 }
  const noise = [0]
  for (let i = 1; i < count; i += 1) noise.push(noise[i - 1]! + rand() * vol)
  const tail = noise[count - 1]!
  return noise.map((n, i) => Number((start + (end - start) * (i / (count - 1)) + n - tail * (i / (count - 1))).toFixed(2)))
}

const BT_FROM = at(4, 1)
const BT_TO = at(8, 31)
const HO_FROM = at(9, 1)
const HO_TO = at(9, 30)
const RUNS = 7

const backtestRun = (n: number) => ({
  runId: `run_bt_${n}`, kind: 'backtest', experimentId: EXP_ID, executor: { kind: 'agent', mandateId: 'mdt_fixture' },
  subjectKey: null, specDigest: sha('bb'), instruments: ['hyperliquid:BTC'], window: { from: BT_FROM, to: BT_TO },
  startedAt: at(10, 1 + n, 10, 0), status: 'done',
})
const holdoutRunSummary = {
  runId: 'run_ho_1', kind: 'backtest', experimentId: EXP_ID, executor: { kind: 'agent', mandateId: 'mdt_fixture' },
  subjectKey: null, specDigest: sha('bc'), instruments: ['hyperliquid:BTC'], window: { from: HO_FROM, to: HO_TO },
  startedAt: at(10, 8, 15, 0), status: 'done',
}

const ASSUMPTIONS = { fees: 'venue', slippageBps: 5, fillModel: 'next-bar-open', funding: true, liquidation: true, latencyMs: 200 }

const trades = (seed: number) => {
  const prices = walk(seed, 30, 64000, 66000, 900)
  return prices.map((price, i) => ({ t: at(8, 31) - i * 4 * 3_600_000, side: i % 2 === 0 ? 'sell' : 'buy', price, size: 0.05, pnl: Number((((i * 37) % 21) - 9).toFixed(2)), fee: 0.32, reason: i % 5 === 4 ? 'stop' : 'signal' }))
}

/** lab.run 回包（BacktestResult 的界面用到的部分）：runId 决定哪一次回测或保留期。 */
export function labDetailRunResult(runId: string) {
  if (runId === 'run_ho_1') {
    return {
      jobId: 'job_ho', specDigest: sha('bc'), assumptions: ASSUMPTIONS,
      stats: { totalReturnRatio: 0.011, annualizedRatio: 0.9, maxDrawdownRatio: 0.0044, sharpe: 0.94, winRatio: 0.49, profitFactor: 1.2, trades: 41, fills: 82, avgHoldBars: 10, spanDays: 30, finalEquity: 10110, feesPaid: 5.48, fundingPaid: 1.37 },
      equity: HOLDOUT_EQUITY.map((v, i) => ({ t: HO_FROM + (i * (HO_TO - HO_FROM)) / (HOLDOUT_EQUITY.length - 1), v })), trades: trades(7), openPosition: null, artifacts: [], warnings: [], engine: { id: 'fixture', version: '1' }, dataDigest: sha('cc'),
    }
  }
  const n = Number(runId.replace('run_bt_', '')) || RUNS
  const last = n === RUNS
  return {
    jobId: `job_bt_${n}`, specDigest: sha('bb'), assumptions: ASSUMPTIONS,
    stats: {
      totalReturnRatio: last ? 0.062 : Number((0.041 + 0.003 * n).toFixed(3)), annualizedRatio: 0.15, maxDrawdownRatio: last ? 0.0179 : 0.02, sharpe: last ? 1.31 : Number((0.8 + 0.07 * n).toFixed(2)),
      winRatio: last ? 0.54 : 0.5, profitFactor: 1.3, trades: 244 + 6 * n, fills: 500, avgHoldBars: 12, spanDays: 153, finalEquity: 10620, feesPaid: last ? 38.6 : 30 + n, fundingPaid: last ? 9.85 : 7 + n * 0.2,
    },
    equity: walk(n * 101, 154, 10000, last ? 10620 : 10000 * (1 + 0.041 + 0.003 * n), 70).map((v, i) => ({ t: BT_FROM + (i * (BT_TO - BT_FROM)) / 153, v })),
    trades: trades(n), openPosition: null, artifacts: [], warnings: [], engine: { id: 'fixture', version: '1' }, dataDigest: sha('cc'),
  }
}

export const labDetailItem = {
  experimentId: EXP_ID,
  title: '网格 BTC 震荡区间',
  hypothesis: '网格 BTC 震荡区间',
  stage: 'shadow',
  subject: { strategy: { kind: 'strategy', id: 'grid-paper', version: '0.3.1', sha256: sha('dd') }, params: { grids: 12, rangeRatio: 0.08, gridMode: 'arithmetic' } },
  frozen: { hypothesis: true, subject: true, holdout: true },
  data: [{ source: 'candles BTC-PERP 15m', range: '04-01 至 09-30', sha256: sha('7c41') }],
  assumptions: ASSUMPTIONS,
  biasChecks: { lookahead: 'pass', recursive: 'pass', trialCount: 7 },
  runs: [
    ...Array.from({ length: RUNS }, (_, i) => ({ stage: 'backtest', runId: `run_bt_${i + 1}`, from: BT_FROM, to: BT_TO })),
    { stage: 'holdout', runId: 'run_ho_1', from: HO_FROM, to: HO_TO },
    { stage: 'shadow', accountId: ACCOUNT, runId: 'run_fw_1', from: at(10, 9, 9, 0), to: null, attachedAt: at(10, 9, 9, 0) },
  ],
  origin: ME,
  createdAt: at(10, 8, 14, 20),
  updatedAt: at(10, 22, 9, 12),
  subjectKey: sha('3f2a9c1e'),
  holdoutWindow: { from: HO_FROM, to: HO_TO },
  holdoutRunId: 'run_ho_1',
  forward: {
    tier: 'forward_paper', runIds: ['run_fw_1'], accountIds: [ACCOUNT], window: { from: at(10, 9, 9, 0), to: at(10, 22, 21, 22) }, ledgerRange: { fromSeq: 100, toSeq: 114 },
    sample: { trades: 23, fills: 40, roundTrips: 20, spanDays: 14, activeDays: 13, snapshotDays: 14 }, valuationCcy: 'USDC',
    realizedPnl: '-10.00', unrealizedPnlEnd: '-2.50', fees: '3.12', funding: '0.86', returnRatio: 0.0046, maxDrawdownRatio: 0.0052, sharpe: 1.08, sortino: null, winRatio: 0.52,
    periodsPerYear: 365, includesUnrealized: true, provisional: true, computedAt: at(10, 22, 21, 22), computedBy: 'kernel', digest: sha('ee'),
  },
  lineage: { parentExperimentId: 'EXP-0011' },
  notes: [
    { text: '导出证据包', origin: ME, at: at(10, 16, 10, 2) },
    { text: '前向开始 paper-1', origin: SYSTEM, at: at(10, 9, 9, 0) },
    { text: '登记 冻结假设与保留期', origin: ME, at: at(10, 8, 14, 20) },
  ],
  runSummaries: [...Array.from({ length: RUNS }, (_, i) => backtestRun(i + 1)), holdoutRunSummary],
  forwardSnapshots,
}

/** 刚登记的假设：没有任何运行结果，三口径与右列各自一行空态。 */
// I-6：附加纸面运行的候选来源。只有 inst_paper_grid 合格（纸面 + 运行 + 同策略 grid-paper）；其余是反例：实盘、别的策略、已停。
export const labDetailAccounts = [
  { accountId: ACCOUNT, alias: 'paper-1', venue: 'kernel-sim', environment: 'testnet', mode: 'paper' },
  { accountId: 'acct_hl_main', alias: 'hl-main', venue: 'hyperliquid', environment: 'testnet', mode: 'live' },
]
const inst = (instanceId: string, strategyId: string, accountId: string, state: string) => ({ engineId: 'ts-builtin', instanceId, strategyId, version: '0.3.1', accountId, state, params: {} })
export const labDetailStrategies = [
  inst('inst_01JBPAPERGRID0000a1b2c3', 'grid-paper', ACCOUNT, 'running'),
  inst('inst_01JBLIVEGRID00000d4e5f6', 'grid-paper', 'acct_hl_main', 'running'),
  inst('inst_01JBPAPEREMA000000778899', 'ema-trend', ACCOUNT, 'running'),
  inst('inst_01JBPAPERGRIDSTOP0aabbcc', 'grid-paper', ACCOUNT, 'stopped'),
]

export const labDetailEmptyItem = {
  experimentId: 'EXP-0005', title: '资金费套利 ETH 8h', hypothesis: '资金费套利 ETH 8h', stage: 'hypothesis', subject: { params: {} },
  origin: ME, createdAt: at(8, 22, 18, 47), updatedAt: at(8, 22, 18, 47), runSummaries: [], forwardSnapshots: [],
}

/** ledger.query 回包：Claude Code 对本实验的晋级申请（K-r5-2 落地前由块内筛）；另一条是别的实验的，必须被筛掉。 */
export const labDetailRequests = [
  { seq: 300, ts: at(10, 22, 9, 12), recordedAt: at(10, 22, 9, 12), type: 'annotation', origin: origin('agent:Claude Code', 'llm-agent'), subject: { orgId: 'org_local' }, payload: { kind: 'experiment_promotion_request', experimentId: EXP_ID, to: 'live_small' } },
  { seq: 299, ts: at(10, 21, 9, 0), recordedAt: at(10, 21, 9, 0), type: 'annotation', origin: origin('agent:Codex CLI', 'llm-agent'), subject: { orgId: 'org_local' }, payload: { kind: 'experiment_promotion_request', experimentId: 'EXP-0099', to: 'live_small' } },
]

const normal = {
  view: 'detail',
  // lab.run 必须按 runId 答：保留期（run_ho_1）与回测（run_bt_n）是两份不同的数据；舞台与真壳的夹具内核都认函数值
  queries: { 'lab.get': labDetailItem, 'lab.run': (params: { runId?: string }) => labDetailRunResult(String(params?.runId ?? `run_bt_${RUNS}`)), 'ledger.query': labDetailRequests, 'engine.strategies': labDetailStrategies, 'account.list': labDetailAccounts },
  commands: { 'lab.attach': labDetailItem, 'lab.pack': labDetailItem },
}
export const labDetailFixtures = {
  normal,
  empty: { view: 'detail', queries: { 'lab.get': labDetailEmptyItem, 'ledger.query': [] } },
  loading: normal,
  error: { view: 'detail' },
  offline: normal,
  unwired: { view: 'detail' },
}
