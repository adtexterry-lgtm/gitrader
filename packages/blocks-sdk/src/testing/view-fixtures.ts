// SPDX-License-Identifier: Apache-2.0
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type {
  AccountAssetsView,
  BacktestResult,
  ConfigNotifySetView,
  ConfigView,
  EngineStrategyView,
  ConfigVenuesSetView,
  EngineCatalogView,
  EngineStrategiesView,
  EquityHistoryView,
  Experiment,
  LabGetView,
  LabListView,
  LabRunView,
  Order,
  PortfolioAnalysisView,
  Problem,
  RecordsQueryView,
} from '@gitrader/protocol'
import type { FakeKernel } from './fake-kernel'

export type ViewFixtureScenario = 'normal' | 'empty' | 'partial-fill' | 'venue-unavailable' | 'ok-false' | 'method-missing'

const observedAt = 1_700_000_000_000
const d = asDecimal
const accountId = 'acct_sdk_fixture' as AccountAssetsView['accountId']
const experimentId = 'exp_sdk_fixture' as Experiment['experimentId']
const instrumentId = 'hyperliquid:BTC' as Order['instrumentId']
const digest = `sha256:${'0'.repeat(64)}` as BacktestResult['dataDigest']
const origin = {
  actor: 'system:sdk-fixture',
  actorType: 'system',
  tool: 'sdk-fixture',
  requestId: 'req_sdk_fixture',
  via: 'internal',
} satisfies Order['origin']

const decimal = {
  total: d('1000'),
  available: d('900'),
  hold: d('100'),
}

const normalOrder = {
  orderId: 'ord_sdk_fixture',
  clientOrderId: '0123456789abcdef0123456789abcdef',
  accountId,
  instrumentId,
  side: 'buy',
  type: 'market',
  tif: 'gtc',
  size: d('1'),
  filledSize: d('1'),
  status: 'filled',
  fee: d('0'),
  origin,
  createdAt: observedAt,
  updatedAt: observedAt,
} satisfies Order

const partialOrder = {
  ...normalOrder,
  size: d('1'),
  filledSize: d('0.25'),
  status: 'partially_filled',
} satisfies Order

const experiment = {
  experimentId,
  title: 'SDK fixture experiment',
  hypothesis: 'A deterministic local fixture exercises the public view contract.',
  stage: 'backtest',
  subject: { params: {} },
  origin,
  createdAt: observedAt,
  updatedAt: observedAt,
} satisfies Experiment

const backtest = {
  jobId: 'job_sdk_fixture',
  specDigest: digest,
  assumptions: { fees: 'venue', slippageBps: 0, fillModel: 'next-bar-open', funding: false, liquidation: true },
  stats: {
    totalReturnRatio: 0.01,
    annualizedRatio: 0.01,
    maxDrawdownRatio: 0,
    sharpe: 1,
    winRatio: 1,
    profitFactor: 1,
    trades: 1,
    fills: 1,
    avgHoldBars: 1,
    spanDays: 1,
    finalEquity: 1010,
  },
  equity: [{ t: observedAt, v: 1010 }],
  trades: [],
  openPosition: null,
  artifacts: [],
  warnings: [],
  engine: { id: 'engine_sdk_fixture', version: '1.0.0' },
  dataDigest: digest,
} satisfies BacktestResult

const strategy: EngineStrategyView = {
  engineId: 'engine_sdk_fixture',
  instanceId: 'inst_sdk_fixture' as EngineStrategyView['instanceId'],
  strategyId: 'strategy_sdk_fixture',
  version: '1.0.0',
  accountId,
  state: 'running',
  params: {},
}

const normalConfig = {
  venues: [{ id: 'venue_sdk_fixture', environment: 'testnet', enabled: true }],
  accounts: [{ accountId, alias: 'sdk-fixture', venue: 'venue_sdk_fixture', environment: 'testnet', mode: 'paper', paper: { initialBalance: d('1000'), ccy: 'USD' } }],
  notify: { channels: [{ id: 'alerts', plugin: 'fixture-plugin', minLevel: 'info', params: {} }] },
  handles: [],
  catalog: [],
} satisfies ConfigView

const emptyConfig = {
  venues: [],
  accounts: [],
  notify: { channels: [] },
  handles: [],
  catalog: [],
} satisfies ConfigView

const catalog = [{ engineId: 'engine_sdk_fixture', strategies: [{ id: 'strategy_sdk_fixture', name: 'SDK fixture', version: '1', desc: '', tags: [], params: [{ key: 'period', label: 'period', type: 'integer', default: 7, min: 1, max: 50 }] }] }] satisfies EngineCatalogView
const portfolio = {
  scope: 'paper', scopes: ['paper'], valuationCcy: 'USD', accounts: 1, gross: d('100'), missing: [],
  byVenue: [{ key: 'hyperliquid', exposure: d('100'), weight: d('1') }],
  byStrategy: [{ key: 'unassigned', realized: d('0'), unrealized: d('1'), funding: d('0'), total: d('1') }],
  byInstrument: [{ key: instrumentId, exposure: d('100'), weight: d('1') }],
} satisfies PortfolioAnalysisView

const failure = makeProblem('DATA_UNAVAILABLE', 'The local fixture cannot provide this view.')
const unavailable = makeProblem('VENUE_UNAVAILABLE', 'The local fixture venue is unavailable.')
const evidenceMissing = makeProblem('EXPERIMENT_EVIDENCE_INCOMPLETE', 'No local experiment result is available.')

const throwProblem = (problem: Problem): never => {
  const error = Object.assign(new Error(problem.message), { code: problem.code, data: problem })
  throw error
}

const okFalse = { ok: false, error: failure } satisfies { ok: false; error: Problem }

/** Register the exact public view queries and write commands used by SDK integration tests. */
export function installViewFixtures(fakeKernel: FakeKernel, scenario: ViewFixtureScenario): void {
  if (scenario === 'method-missing') return
  const methods = ['account.assets', 'account.equity_history', 'records.query', 'engine.strategies', 'engine.catalog', 'portfolio.analysis', 'lab.list', 'lab.get', 'lab.run', 'config.view'] as const
  const actions = ['config.venues.set', 'config.notify.set'] as const
  if (scenario === 'venue-unavailable') {
    for (const method of methods) fakeKernel.onQuery(method, () => throwProblem(unavailable))
    for (const action of actions) fakeKernel.onCommand(action, () => throwProblem(unavailable))
    return
  }
  if (scenario === 'ok-false') {
    for (const method of methods) fakeKernel.onQuery(method, () => okFalse)
    for (const action of actions) fakeKernel.onCommand(action, () => okFalse)
    return
  }

  if (scenario === 'empty') {
    fakeKernel.onQuery('account.assets', () => ({ accountId, balances: [], margin: null, ts: observedAt } satisfies AccountAssetsView))
    fakeKernel.onQuery('account.equity_history', () => ({ points: [], gaps: [] } satisfies EquityHistoryView))
    fakeKernel.onQuery('records.query', () => ({ items: [] } satisfies RecordsQueryView))
    fakeKernel.onQuery('engine.strategies', () => [] satisfies EngineStrategiesView)
    fakeKernel.onQuery('engine.catalog', () => [] satisfies EngineCatalogView)
    fakeKernel.onQuery('portfolio.analysis', () => ({ ...portfolio, gross: d('0'), byVenue: [], byStrategy: [], byInstrument: [] } satisfies PortfolioAnalysisView))
    fakeKernel.onQuery('lab.list', () => ({ items: [] } satisfies LabListView))
    fakeKernel.onQuery('lab.get', () => throwProblem(evidenceMissing))
    fakeKernel.onQuery('lab.run', () => throwProblem(evidenceMissing))
    fakeKernel.onQuery('config.view', () => emptyConfig)
    const venuesResult = { config: emptyConfig, restartRequired: true } satisfies ConfigVenuesSetView
    fakeKernel.onCommand('config.venues.set', () => venuesResult)
    const notifyResult = { notify: emptyConfig.notify, restartRequired: true } satisfies ConfigNotifySetView
    fakeKernel.onCommand('config.notify.set', () => notifyResult)
    return
  }

  const isPartial = scenario === 'partial-fill'
  const currentOrder = isPartial ? partialOrder : normalOrder
  const currentBalance = isPartial
    ? { total: d('950'), available: d('850'), hold: d('100') }
    : decimal
  fakeKernel.onQuery('account.assets', () => ({
    accountId,
    balances: [{ accountId, asset: 'USD', total: isPartial ? d('950') : d('1000'), available: currentBalance.available, hold: isPartial ? d('100') : d('100'), ts: observedAt }],
    margin: { accountId, model: 'cross', valuationCcy: 'USD', equity: isPartial ? d('950') : d('1000'), initialMargin: d('100'), maintenanceMargin: d('50'), available: currentBalance.available, marginRatio: d('0.05'), leverage: 1, ts: observedAt },
    ts: observedAt,
  } satisfies AccountAssetsView))
  fakeKernel.onQuery('account.equity_history', () => ({
    points: [{ t: observedAt, equity: isPartial ? d('950') : d('1000'), available: currentBalance.available }],
    gaps: [],
  } satisfies EquityHistoryView))
  fakeKernel.onQuery('records.query', () => ({ items: [currentOrder] } satisfies RecordsQueryView))
  fakeKernel.onQuery('engine.strategies', () => [strategy] satisfies EngineStrategiesView)
  fakeKernel.onQuery('engine.catalog', () => catalog satisfies EngineCatalogView)
  fakeKernel.onQuery('portfolio.analysis', () => portfolio satisfies PortfolioAnalysisView)
  fakeKernel.onQuery('lab.list', () => ({ items: [experiment] } satisfies LabListView))
  fakeKernel.onQuery('lab.get', () => ({ ...experiment, runSummaries: [], forwardSnapshots: [] } satisfies LabGetView))
  fakeKernel.onQuery('lab.run', () => backtest satisfies LabRunView)
  fakeKernel.onQuery('config.view', () => normalConfig)
  const venuesResult = { config: normalConfig, restartRequired: true } satisfies ConfigVenuesSetView
  fakeKernel.onCommand('config.venues.set', () => venuesResult)
  const notifyResult = { notify: normalConfig.notify, restartRequired: true } satisfies ConfigNotifySetView
  fakeKernel.onCommand('config.notify.set', () => notifyResult)
}
