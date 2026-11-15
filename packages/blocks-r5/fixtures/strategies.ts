// SPDX-License-Identifier: CPAL-1.0
// 策略页夹具（P6）：和视觉稿 strategy/index.html 同一组数据（7 个策略 / 2 个引擎 / 9 条事件 / 实盘 + 纸面两个账户）。
// 形状按协议（EngineStrategiesView、engine.list、LedgerEntry）；全是自造演示数据，不含真实地址或密钥。时间相对加载时刻。
const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export const ACCT_HL = 'acct_01JBSTRAT00000000000HL01'
export const ACCT_PAPER = 'acct_01JBSTRAT0000000000PAPER1'
const ACCOUNTS = [
  { accountId: ACCT_HL, alias: 'hl-main', venue: 'hyperliquid', environment: 'testnet', mode: 'live' },
  { accountId: ACCT_PAPER, alias: 'paper-1', venue: 'kernel-sim', environment: 'testnet', mode: 'paper' },
]

const inst = (n: number) => `inst_01JBSTRAT${String(n).padStart(13, '0')}`
const strategy = (n: number, engineId: string, strategyId: string, version: string, accountId: string, state: string, params: Record<string, number | boolean | string>, extra: Record<string, unknown> = {}) => ({
  engineId, instanceId: inst(n), strategyId, version, accountId, state, params, ...extra,
})
const STRATEGIES = [
  strategy(1, 'ts-builtin', 'ema-trend', '1.2', ACCT_HL, 'running', { fast: 20, slow: 60, size: 0.08, lev: 4, atr: 2 }, { lastFillTs: NOW - 8 * MIN, experimentId: 'EXP-0009' }),
  strategy(2, 'ts-builtin', 'grid-paper', '0.3', ACCT_PAPER, 'running', { lower: 63000, upper: 66000, grids: 30, first: 0.05, step: 0.01, lev: 2 }, { lastFillTs: NOW - 3 * HOUR, experimentId: 'EXP-0014' }),
  strategy(3, 'python-local', 'breakout-vol', '0.4', ACCT_HL, 'error', { window: 48, k: 1.5, size: 0.05 }, {
    lastFillTs: NOW - 5 * HOUR, experimentId: 'EXP-0010',
    problem: { code: 5001, name: 'ENGINE_CALL_FAILED', category: 'ENGINE', message: "on_bar KeyError: 'atr_14'", retryable: false },
  }),
  strategy(4, 'python-local', 'funding-carry', '0.2', ACCT_HL, 'stopped', { min_apr: 8, size: 0.2 }, { lastFillTs: NOW - 2 * DAY, experimentId: 'EXP-0012' }),
  strategy(5, 'ts-builtin', 'mean-rev', '0.1', ACCT_PAPER, 'stopped', { z: 2, size: 0.1 }, { lastFillTs: NOW - 17 * DAY, experimentId: 'EXP-0013' }),
  strategy(6, 'ts-builtin', 'vwap-revert', '0.2', ACCT_PAPER, 'stopped', { band: 0.6, size: 0.1 }, { lastFillTs: NOW - 33 * DAY, experimentId: 'EXP-0006' }),
  strategy(7, 'ts-builtin', 'rsi-div', '0.3', ACCT_PAPER, 'stopped', { len: 14, size: 0.1 }, { experimentId: 'EXP-0016' }),
]
const EXPERIMENTS = {
  items: [
    ['EXP-0009', 'live_small'], ['EXP-0014', 'shadow'], ['EXP-0010', 'live_small'], ['EXP-0012', 'holdout'],
    ['EXP-0013', 'shadow'], ['EXP-0006', 'holdout'], ['EXP-0016', 'holdout'],
  ].map(([experimentId, stage]) => ({ experimentId, stage })),
}

const gep = (engineId: string, version: string, accounts: string[], extra: Record<string, unknown> = {}) => ({
  engineId, state: 'ready', sessionId: `sess_${engineId}`, bound: accounts.length > 0, accounts, lost: false, placeCalls: 0, proposalCalls: 0, engine: `${engineId}@${version}`, ...extra,
})
const ENGINES = [
  { id: 'ts-builtin', enabled: true, builtin: true, state: 'ready', transport: 'builtin', remote: false, pid: null, restarts: 0, since: NOW - 9 * HOUR, gep: gep('ts-builtin', '0.4.2', [ACCT_HL, ACCT_PAPER]) },
  { id: 'python-local', enabled: true, builtin: false, state: 'ready', transport: 'stdio', remote: false, pid: 4242, restarts: 1, since: NOW - 4 * HOUR, gep: gep('python-local', '0.3.1', [ACCT_HL]) },
]

const origin = (actor: string, actorType: string, tool: string, via: string) => ({ actor, actorType, tool, requestId: '00000000-0000-4000-8000-000000000001', via })
const O_USER = origin('user:usr_local', 'human', 'ui:engine', 'ui')
const O_SYSTEM = origin('system:engines', 'system', 'engine:supervisor', 'internal')
const led = (type: string, ts: number, o: ReturnType<typeof origin>, engineId: string, payload: Record<string, unknown>) => ({ type, ts, o, engineId, payload })
// 先按时间排好再编号：账本的 seq 单调递增，事件卡按 seq 倒序显示
const LEDGER = [
  led('engine.health_changed', NOW - 9 * HOUR, O_SYSTEM, 'ts-builtin', { from: 'starting', to: 'ready' }),
  led('engine.health_changed', NOW - 9 * HOUR + 4_000, O_SYSTEM, 'python-local', { from: 'starting', to: 'ready' }),
  led('engine.event', NOW - 9 * DAY, O_USER, 'ts-builtin', { message: '启动 grid-paper', instanceId: inst(2) }),
  led('engine.bound', NOW - 5 * DAY, O_USER, 'python-local', { accounts: [{ accountId: ACCT_HL, mandateId: 'mdt_01JBA0003' }], instruments: [] }),
  led('engine.event', NOW - 3 * DAY, O_USER, 'python-local', { message: '停止 funding-carry', instanceId: inst(4) }),
  led('engine.event', NOW - 2 * DAY, O_USER, 'ts-builtin', { message: '改参数 grid-paper', instanceId: inst(2) }),
  led('engine.health_changed', NOW - 5 * HOUR + 40 * MIN, O_SYSTEM, 'python-local', { from: 'ready', to: 'failed', detail: 'ECONNRESET' }),
  led('engine.health_changed', NOW - 5 * HOUR + 52 * MIN, O_SYSTEM, 'python-local', { from: 'failed', to: 'ready' }),
  led('engine.event', NOW - 5 * HOUR + 58 * MIN, origin('strategy:breakout-vol', 'engine', 'strategy:breakout-vol', 'gep'), 'python-local', { message: 'breakout-vol 出错', instanceId: inst(3), problem: { message: "on_bar KeyError: 'atr_14'" } }),
].sort((a, b) => a.ts - b.ts).map((e, i) => {
  const seq = 901 + i
  return {
    schema: 'gitrader-ledger/1', seq, id: `led_01JBSTRAT${String(seq).padStart(13, '0')}`, ts: e.ts, recordedAt: e.ts + 3, type: e.type, origin: e.o, subject: { engineId: e.engineId },
    payload: e.payload, payloadHash: `sha256:${'0'.repeat(63)}1`, attestation: 'kernel-observed', prevHash: `sha256:${'0'.repeat(64)}`, hash: `sha256:${'0'.repeat(64)}`,
  }
})

const wireError = (name: string, message: string) => ({ ok: false, error: { code: 5001, name, message, category: 'ENGINE', retryable: false } })
const okCmd = { ok: true }

// engine.catalog：内核把 strategy.params 的 schema 映射成表单字段（x-hidden 的 startTs 已去掉）；键名、范围、默认值照 engine-core/examples/strategies/{grid,dca}.ts
const CATALOG = [
  { engineId: 'ts-builtin', strategies: [
    { id: 'grid', name: 'Grid, long-only (teaching example)', nameZh: '网格·只做多（教学示例）', version: '0.2.0', desc: '在「中心价 ± 区间」内等分成若干格', tags: ['震荡', '网格', '只做多'], params: [
      { key: 'center', label: '中心价（0 = 取第一根收盘价）', type: 'number', default: 0, min: 0, step: 0.01 },
      { key: 'rangeRatio', label: '区间半宽（占中心价的比例，0.1 = 10%）', type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005 },
      { key: 'grids', label: '格数', type: 'integer', default: 8, min: 2, max: 50, step: 1 },
      { key: 'maxExposure', label: '满格时占用资金比例', type: 'number', default: 1, min: 0.1, max: 1, step: 0.1 },
      { key: 'lowerPrice', label: '下限价（0 = 用中心价与区间半宽推导）', type: 'number', default: 0, min: 0, step: 0.01, help: '与 upperPrice 同时 > 0 才生效' },
      { key: 'upperPrice', label: '上限价（0 = 用中心价与区间半宽推导）', type: 'number', default: 0, min: 0, step: 0.01, help: '与 lowerPrice 同时 > 0 才生效' },
      { key: 'gridMode', label: '格子间距', type: 'select', default: 'arithmetic', options: ['arithmetic', 'geometric'] },
      { key: 'boundaryAction', label: '越界处理', type: 'select', default: 'pause', options: ['pause', 'stop_loss', 'hold'] },
    ] },
    { id: 'dca', name: 'DCA (teaching example)', nameZh: '定投（教学示例）', version: '0.2.0', desc: '每隔固定根数买入一份', tags: ['长期', '只做多', '定投'], params: [
      { key: 'everyBars', label: '每隔多少根买一次', type: 'integer', default: 24, min: 1, max: 1000, step: 1 },
      { key: 'orders', label: '最多买几次', type: 'integer', default: 10, min: 1, max: 100, step: 1 },
      { key: 'totalBudgetPct', label: '总预算（占资金比例，100 = 全部）', type: 'number', default: 100, min: 1, max: 100, step: 1 },
      { key: 'takeProfitRatio', label: '止盈线（相对持仓均价的涨幅，0.2 = 20%，0 = 不止盈）', type: 'number', default: 0, min: 0, max: 2, step: 0.005 },
    ] },
  ] },
  { engineId: 'python-local', unavailable: true, problem: { code: -32601, name: 'METHOD_NOT_FOUND', message: 'strategy.list not implemented', category: 'ENGINE', retryable: false } },
]

const normal = {
  view: 'list',
  queries: { 'engine.strategies': STRATEGIES, 'engine.catalog': CATALOG, 'engine.list': ENGINES, 'account.list': ACCOUNTS, 'lab.list': EXPERIMENTS, 'ledger.query': LEDGER },
  commands: { 'engine.call': okCmd, 'engine.stop': okCmd, 'engine.start': okCmd, 'engine.bind': { bindingId: 'bind_01JBSTRAT0000000000000001', warnings: [] } },
}

export const strategiesData = { ACCOUNTS, STRATEGIES, EXPERIMENTS, ENGINES, LEDGER, CATALOG }

export const strategiesFixtures = {
  normal,
  empty: { view: 'list', queries: { 'engine.strategies': [], 'engine.catalog': [], 'engine.list': [], 'account.list': [], 'lab.list': { items: [] }, 'ledger.query': [] } },
  loading: normal,
  error: {
    view: 'list',
    queries: {
      'engine.strategies': wireError('ENGINE_UNAVAILABLE', 'ENGINE_UNAVAILABLE python-local'),
      'engine.catalog': wireError('ENGINE_UNAVAILABLE', 'ENGINE_UNAVAILABLE engine.catalog'),
      'engine.list': wireError('KERNEL_UNAVAILABLE', 'KERNEL_UNAVAILABLE engine.list'),
      'ledger.query': wireError('LEDGER_LOCKED', 'LEDGER_LOCKED ledger.query'),
    },
  },
  // 离线 = 内核连接断开（<html data-offline>），数据保留；数据与 normal 相同，断线由测试 / 壳设置
  offline: normal,
  // 未接通：不登记 engine.* 查询，内核回 METHOD_NOT_FOUND（-32601）
  unwired: { view: 'list', queries: { 'account.list': ACCOUNTS } },
}
