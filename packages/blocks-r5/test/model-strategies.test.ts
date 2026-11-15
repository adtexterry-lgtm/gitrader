// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import {
  bindCmd, bindPlan, clockText, eventsOfStrategy, filterCounts, filterRows, healthText, heartbeatAge, mergeEvent, normalizeAccounts, normalizeEngines, normalizeEvents, normalizeExperiments,
  normalizeStrategies, paperAccounts, paramEntries, parseParamEdit, readFail, readStartForm, recentOf, relTime, rowAction, stageLabel, startEngineCmd, startFormSeed, startStrategyCmd,
  stopEngineCmd, stopEngineText, stopStrategyCmd, stopStrategyText, toEventRow, updateParamsCmd, venueLabel,
} from '../src/model-strategies'
import { ACCT_HL, ACCT_PAPER, strategiesData, strategiesFixtures } from '../fixtures/strategies'

const MIN = 60_000
const HOUR = 3_600_000
const accounts = normalizeAccounts(strategiesData.ACCOUNTS)
const stages = normalizeExperiments(strategiesData.EXPERIMENTS)
const model = normalizeStrategies(strategiesData.STRATEGIES, accounts, stages)
const row = (id: string) => model.rows.find((r) => r.strategyId === id)!

describe('strategies model · rows', () => {
  it('maps the fixture into seven rows with account, stage and experiment', () => {
    expect(model.fail).toBeNull()
    expect(model.failures).toEqual([])
    expect(model.rows.map((r) => r.strategyId)).toEqual(['ema-trend', 'grid-paper', 'breakout-vol', 'funding-carry', 'mean-rev', 'vwap-revert', 'rsi-div'])
    expect(row('ema-trend')).toMatchObject({ account: { alias: 'hl-main', mode: 'live', venueLabel: 'Hyperliquid' }, experimentId: 'EXP-0009', stage: 'live_small' })
    expect(row('grid-paper').account).toMatchObject({ alias: 'paper-1', mode: 'paper' })
    expect(stageLabel('live_small')).toBe('小额实盘')
    expect(stageLabel('holdout')).toBe('保留期')
    expect(stageLabel('paper')).toBe('影子')
    expect(stageLabel('something_new')).toBe('something_new')
    expect(venueLabel('okx')).toBe('OKX')
    expect(venueLabel('xyz')).toBe('Xyz')
  })

  it('failure rows never fake a strategy or an account identity', () => {
    const raw = [
      ...strategiesData.STRATEGIES.slice(0, 1),
      { engineId: 'python-local', unavailable: true, problem: { code: 3001, name: 'VENUE_UNAVAILABLE', message: 'engine python-local is not ready' } },
      { engineId: 'broken', instanceId: 'inst_x' },
      null,
    ]
    const m = normalizeStrategies(raw, accounts, stages)
    expect(m.rows.map((r) => r.strategyId)).toEqual(['ema-trend'])
    expect(m.failures).toEqual([{ key: 'python-local:unavailable', engineId: 'python-local', name: 'VENUE_UNAVAILABLE', message: 'engine python-local is not ready' }])
    expect(JSON.stringify(m.failures)).not.toMatch(/accountId|strategyId|instanceId/)
  })

  it('an account missing from account.list stays null instead of being invented', () => {
    const m = normalizeStrategies(strategiesData.STRATEGIES.slice(0, 1), [], stages)
    expect(m.rows[0]!.account).toBeNull()
    expect(rowAction({ ...m.rows[0]!, state: 'stopped' })).toEqual({ kind: 'none' })
  })

  it('a whole-query ok:false reply keeps the kernel text verbatim', () => {
    const reply = { ok: false, error: { code: 5001, name: 'ENGINE_UNAVAILABLE', message: 'ENGINE_UNAVAILABLE python-local' } }
    expect(readFail(reply)).toBe('ENGINE_UNAVAILABLE python-local')
    expect(normalizeStrategies(reply)).toMatchObject({ rows: [], fail: 'ENGINE_UNAVAILABLE python-local' })
    expect(readFail([])).toBeNull()
    expect(normalizeStrategies([]).fail).toBeNull()
  })

  it('filters and counts by state', () => {
    expect(filterCounts(model.rows)).toEqual({ all: 7, running: 2, stopped: 4, error: 1 })
    expect(filterRows(model.rows, 'error').map((r) => r.strategyId)).toEqual(['breakout-vol'])
    expect(filterRows(model.rows, 'all')).toHaveLength(7)
  })
})

describe('strategies model · recent fills and actions', () => {
  it('shows the last fill as a relative time', () => {
    const now = 1_000_000_000_000
    expect(relTime(now - 10_000, now)).toBe('刚刚')
    expect(relTime(now - 3 * MIN, now)).toBe('3 分钟前')
    expect(relTime(now - 59 * MIN, now)).toBe('59 分钟前')
    expect(relTime(now - 2 * HOUR - 5 * MIN, now)).toBe('2 小时前')
    expect(relTime(now - 30 * HOUR, now)).toBe('1 天前')
    expect(relTime(now - 5 * 24 * HOUR, now)).toBe('5 天前')
    expect(relTime(now - 20 * 24 * HOUR, now)).toMatch(/^\d{2}-\d{2}$/)
    expect(relTime(now + 5000, now)).toBe('刚刚')
    const fixtureNow = Date.now()
    expect(recentOf(row('ema-trend'), fixtureNow)).toEqual({ l1: '最近成交 8 分钟前', bad: null })
    expect(recentOf(row('rsi-div'), fixtureNow)).toEqual({ l1: '暂无成交', bad: null })
  })

  it('an errored row shows the engine name and the original message', () => {
    expect(recentOf(row('breakout-vol'), Date.now())).toEqual({ l1: 'ENGINE_CALL_FAILED', bad: "on_bar KeyError: 'atr_14'" })
  })

  it('formats event times: today as clock, other days with the date', () => {
    const now = new Date(2026, 9, 23, 19, 30, 0).getTime()
    expect(clockText(new Date(2026, 9, 23, 9, 5, 7).getTime(), now)).toBe('09:05:07')
    expect(clockText(new Date(2026, 9, 21, 19, 5, 0).getTime(), now)).toBe('10-21 19:05')
  })

  it('a live row has no start: it offers promotion to its experiment', () => {
    expect(rowAction(row('funding-carry'))).toEqual({ kind: 'promote', href: '#/lab/EXP-0012' })
    expect(rowAction({ ...row('funding-carry'), experimentId: null })).toEqual({ kind: 'promote', href: null })
    expect(rowAction({ ...row('funding-carry'), state: 'stopped' })).not.toMatchObject({ kind: 'start' })
  })

  it('running and errored rows stop; paper stopped rows start only when the kernel gave instruments', () => {
    expect(rowAction(row('ema-trend'))).toEqual({ kind: 'stop' })
    expect(rowAction(row('breakout-vol'))).toEqual({ kind: 'stop' })
    expect(rowAction(row('mean-rev'))).toEqual({ kind: 'start', wired: false, reason: 'engine.strategies 缺 instruments / interval' })
    expect(rowAction({ ...row('mean-rev'), instruments: ['hyperliquid:BTC'] })).toEqual({ kind: 'start', wired: true, reason: '' })
  })
})

describe('strategies model · commands match the kernel contract', () => {
  it('strategy stop / start / update go through engine.call with the instance id', () => {
    const r = row('grid-paper')
    expect(stopStrategyCmd(r)).toEqual({ action: 'engine.call', params: { id: 'ts-builtin', method: 'strategy.stop', params: { instanceId: r.instanceId } } })
    expect(stopStrategyText(r)).toBe('停止 grid-paper：不会自动平仓，持仓与挂单保留')
    expect(updateParamsCmd(r, { grids: 24 })).toEqual({ action: 'engine.call', params: { id: 'ts-builtin', method: 'strategy.update', params: { instanceId: r.instanceId, params: { grids: 24 } } } })
    const start = startStrategyCmd({ ...row('mean-rev'), instruments: ['hyperliquid:BTC'], interval: '15m' })
    expect(start.params).toMatchObject({ id: 'ts-builtin', method: 'strategy.start', params: { strategyId: 'mean-rev', accountId: ACCT_PAPER, instruments: ['hyperliquid:BTC'], interval: '15m' } })
  })

  it('engine stop / start / bind use their own actions; stop text counts running strategies', () => {
    const engines = normalizeEngines(strategiesData.ENGINES, model.rows, accounts)
    const ts = engines.find((e) => e.id === 'ts-builtin')!
    expect(stopEngineText(ts)).toBe('停止 ts-builtin：2 个策略随之停止，持仓保留')
    expect(stopEngineCmd('ts-builtin')).toEqual({ action: 'engine.stop', params: { id: 'ts-builtin' } })
    expect(startEngineCmd('python-local')).toEqual({ action: 'engine.start', params: { id: 'python-local' } })
    expect(bindCmd('python-local', [ACCT_PAPER])).toEqual({ action: 'engine.bind', params: { id: 'python-local', accounts: [ACCT_PAPER] } })
  })

  it('binding never silently drops a live binding: such engines are refused, paper ones keep their old accounts', () => {
    const engines = normalizeEngines(strategiesData.ENGINES, model.rows, accounts)
    expect(bindPlan(engines[1]!, ACCT_PAPER, accounts)).toEqual({ ok: false, reason: '该引擎已绑定实盘账户，绑定会整体替换它；请用 gitrader engines bind' })
    expect(bindPlan({ boundIds: [] }, ACCT_PAPER, accounts)).toEqual({ ok: true, accounts: [ACCT_PAPER] })
    expect(bindPlan({ boundIds: [ACCT_PAPER] }, ACCT_PAPER, accounts)).toEqual({ ok: true, accounts: [ACCT_PAPER] })
    expect(bindPlan({ boundIds: ['acct_gone'] }, ACCT_PAPER, accounts)).toMatchObject({ ok: false })
  })

  it('the bind popover lists paper accounts only', () => {
    expect(paperAccounts(accounts).map((a) => a.accountId)).toEqual([ACCT_PAPER])
    expect(paperAccounts(accounts).some((a) => a.accountId === ACCT_HL)).toBe(false)
  })
})

describe('strategies model · parameters', () => {
  it('lists parameters read-only with number formatting and on/off for booleans', () => {
    expect(paramEntries({ lower: 63000, on: true, mode: 'fast' })).toEqual([{ key: 'lower', text: '63,000' }, { key: 'on', text: '开' }, { key: 'mode', text: 'fast' }])
  })

  it('edits keep the original type and send only changed keys', () => {
    const original = { grids: 24, lev: 2, on: true, mode: 'fast' }
    expect(parseParamEdit(original, { grids: '30', lev: '2', on: 'true', mode: 'fast' })).toEqual({ ok: true, changed: { grids: 30 } })
    expect(parseParamEdit(original, { on: 'false', mode: 'slow' })).toEqual({ ok: true, changed: { on: false, mode: 'slow' } })
    expect(parseParamEdit(original, {})).toEqual({ ok: true, changed: {} })
  })

  it('rejects text that cannot become the original type', () => {
    expect(parseParamEdit({ grids: 24 }, { grids: '三十' })).toEqual({ ok: false, key: 'grids', message: 'grids 需要数字' })
    expect(parseParamEdit({ grids: 24 }, { grids: '' })).toMatchObject({ ok: false, key: 'grids' })
    expect(parseParamEdit({ on: true }, { on: 'yes' })).toMatchObject({ ok: false, key: 'on' })
  })
})

describe('strategies model · engines', () => {
  const engines = normalizeEngines(strategiesData.ENGINES, model.rows, accounts)
  it('derives name, version, bound accounts and strategy counts', () => {
    expect(engines.map((e) => e.id)).toEqual(['ts-builtin', 'python-local'])
    expect(engines[0]).toMatchObject({ stateText: '就绪', tone: 'ok', version: '0.4.2', canStop: true, bound: ['hl-main', 'paper-1'], boundIds: [ACCT_HL, ACCT_PAPER], strategies: 5, running: 2, errors: 0 })
    expect(engines[1]).toMatchObject({ version: '0.3.1', bound: ['hl-main'], strategies: 2, running: 0, errors: 1 })
  })

  it('lost, failed and stopped engines show the kernel detail and offer start', () => {
    const raw = [
      { id: 'a', state: 'ready', gep: { lost: true, accounts: [] } },
      { id: 'b', state: 'failed', detail: 'bundled Python entry is unavailable' },
      { id: 'c', state: 'stopped' },
      { id: 'd', state: 'stopping' },
    ]
    const list = normalizeEngines(raw)
    expect(list[0]).toMatchObject({ stateText: '失联', tone: 'bad' })
    expect(list[1]).toMatchObject({ stateText: '失败', tone: 'bad', canStop: false, detail: 'bundled Python entry is unavailable' })
    expect(list[2]).toMatchObject({ stateText: '已停止', canStop: false, busy: false })
    expect(list[3]).toMatchObject({ busy: true })
    expect(normalizeEngines({ ok: false })).toEqual([])
    expect(healthText('lost')).toBe('失联')
    expect(healthText('ready')).toBe('已就绪')
  })
})

describe('strategies model · events', () => {
  const events = normalizeEvents(strategiesData.LEDGER, accounts)
  it('lists engine entries newest first with who did it', () => {
    expect(events).toHaveLength(9)
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => b - a))
    expect(events[0]).toMatchObject({ text: 'breakout-vol 出错', actor: { kind: 'engine', name: 'breakout-vol' }, bad: "on_bar KeyError: 'atr_14'" })
    expect(events.find((e) => e.text === '停止 funding-carry')?.actor).toEqual({ kind: 'human', name: '你' })
    expect(events.find((e) => e.text.startsWith('绑定'))).toMatchObject({ text: '绑定 python-local · hl-main', actor: { kind: 'human', name: '你' }, note: '授权书 mdt_01JBA0003' })
  })

  it('health changes read as a sentence and keep the failure detail verbatim', () => {
    const failed = events.find((e) => e.text === 'python-local 失败')!
    expect(failed).toMatchObject({ actor: { kind: 'system', name: '系统' }, bad: 'ECONNRESET' })
    expect(events.filter((e) => e.text === 'python-local 已就绪')).toHaveLength(2)
  })

  it('ignores entries that are not engine events and tolerates junk', () => {
    expect(toEventRow({ type: 'fill', seq: 1, ts: 1 })).toBeNull()
    expect(toEventRow({ type: 'engine.event', seq: 'x', ts: 1 })).toBeNull()
    expect(toEventRow(null)).toBeNull()
    expect(normalizeEvents({ ok: false })).toEqual([])
  })

  it('a live entry is not added twice and goes to the top', () => {
    const top = events[0]!
    expect(mergeEvent(events, top)).toHaveLength(9)
    const fresh = { ...top, key: 'fresh', seq: top.seq + 1 }
    expect(mergeEvent(events, fresh)[0]!.key).toBe('fresh')
    expect(mergeEvent(events, fresh)).toHaveLength(10)
  })

  it('the expanded row only shows events of its own instance', () => {
    const mine = eventsOfStrategy(events, row('grid-paper'))
    expect(mine.map((e) => e.text)).toEqual(['改参数 grid-paper', '启动 grid-paper'])
    expect(eventsOfStrategy(events, row('ema-trend'))).toEqual([])
  })
})

describe('strategies fixtures', () => {
  it('cover every stage state and carry no forbidden wording', () => {
    expect(Object.keys(strategiesFixtures).sort()).toEqual(['empty', 'error', 'loading', 'normal', 'offline', 'unwired'])
    const text = JSON.stringify(strategiesFixtures)
    for (const word of ['保守', '激进', '稳赚', '跑赢', '稳定盈利']) expect(text).not.toContain(word)
  })

  it('the error state replies with the original kernel text for every query it breaks', () => {
    const q = strategiesFixtures.error.queries
    expect(readFail(q['engine.strategies'])).toBe('ENGINE_UNAVAILABLE python-local')
    expect(readFail(q['engine.list'])).toBe('KERNEL_UNAVAILABLE engine.list')
    expect(readFail(q['ledger.query'])).toBe('LEDGER_LOCKED ledger.query')
  })
})

describe('strategies model · F17 start form, bindings and heartbeat', () => {
  it('start is wired for stopped paper rows', () => {
    const r = row('mean-rev')
    expect(rowAction(r)).toMatchObject({ kind: 'start' })
    expect(readStartForm('hyperliquid:BTC', '15m')).toEqual({ ok: true, pick: { instruments: ['hyperliquid:BTC'], interval: '15m' } })
    expect(startStrategyCmd(r, { instruments: ['hyperliquid:BTC'], interval: '15m' }).params).toMatchObject({
      method: 'strategy.start', params: { strategyId: 'mean-rev', accountId: ACCT_PAPER, instruments: ['hyperliquid:BTC'], interval: '15m' },
    })
    expect(startFormSeed({ ...r, instruments: ['hyperliquid:ETH'], interval: '1h' })).toEqual({ text: 'hyperliquid:ETH', interval: '1h' })
    expect(startFormSeed(r)).toEqual({ text: '', interval: '15m' })
  })

  it('bind keeps live bindings and never sends replaceLive', () => {
    const withBindings = { boundIds: [ACCT_HL], bindings: [{ accountId: ACCT_HL, mode: 'live', mandateId: 'mdt_01JBA0003' }] }
    const plan = bindPlan(withBindings, ACCT_PAPER, accounts)
    expect(plan).toEqual({ ok: true, accounts: [{ accountId: ACCT_HL, mandateId: 'mdt_01JBA0003' }, ACCT_PAPER] })
    if (!plan.ok) throw new Error('plan refused')
    const cmd = bindCmd('ts-builtin', plan.accounts)
    expect(cmd).toEqual({ action: 'engine.bind', params: { id: 'ts-builtin', accounts: [{ accountId: ACCT_HL, mandateId: 'mdt_01JBA0003' }, ACCT_PAPER] } })
    expect(JSON.stringify(cmd)).not.toContain('replaceLive')
    expect(bindPlan({ boundIds: [], bindings: [] }, ACCT_PAPER, accounts)).toEqual({ ok: true, accounts: [ACCT_PAPER] })
    expect(bindPlan({ boundIds: [ACCT_HL], bindings: [{ accountId: ACCT_HL, mode: 'live' }] }, ACCT_PAPER, accounts)).toMatchObject({ ok: false })
  })

  it('old kernel without bindings keeps the cli hint', () => {
    expect(bindPlan({ boundIds: [ACCT_HL] }, ACCT_PAPER, accounts)).toEqual({ ok: false, reason: '该引擎已绑定实盘账户，绑定会整体替换它；请用 gitrader engines bind' })
    expect(normalizeEngines(strategiesData.ENGINES, model.rows, accounts)[1]!.bindings).toBeNull()
  })

  it('heartbeat age text', () => {
    const now = 1_000_000_000_000
    expect(heartbeatAge(now - 3_000, now)).toEqual({ text: '3 秒前', stale: false })
    expect(heartbeatAge(now - 60_000, now)).toEqual({ text: '1 分钟前', stale: false })
    expect(heartbeatAge(now - 5 * MIN, now)).toEqual({ text: '5 分钟前', stale: true })
    expect(heartbeatAge(null, now)).toEqual({ text: '—', stale: false })
    const live = normalizeEngines([{ id: 'ts-builtin', state: 'ready', bindings: [{ accountId: ACCT_HL, mode: 'live', mandateId: 'mdt_x' }], lastHeartbeatAt: now - 3_000 }], model.rows, accounts)[0]!
    expect(live).toMatchObject({ lastHeartbeatAt: now - 3_000, bindings: [{ accountId: ACCT_HL, mode: 'live', mandateId: 'mdt_x' }] })
    expect(heartbeatAge(live.lastHeartbeatAt, now).text).toBe('3 秒前')
  })
})
