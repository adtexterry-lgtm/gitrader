// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { KernelError } from '@gitrader/blocks-sdk'
import { sumStr } from '../src/model-records'
import {
  EMPTY_ROW, assetsOf, barPct, changesOf, countOpenOrders, countPositions, curveOf, failOf, fmtAmt, fmtSigned, fmtTicks, groupAccounts, marginOf, marginWarn,
  negStr, niceTicks, normalizeAccounts, okFalse, portfolioView, rangeOf, resetText, rowState, sharePct, summaryOf, timeTicks, toneOf, venueHealth, type FundAccount, type RowState,
} from '../src/model-funds'
import { wireState } from '../src/kit'
import { PORTFOLIO } from '../fixtures/funds'

const acct = (accountId: string, mode: string, extra: Record<string, unknown> = {}) => ({ accountId, alias: accountId, mode, venue: mode === 'paper' ? 'kernel-sim' : 'hyperliquid', environment: 'testnet', ...extra })
const accounts = normalizeAccounts([
  acct('hl', 'live'), acct('bn', 'live', { venue: 'binance' }), acct('p1', 'paper', { paper: { initialBalance: '10000', ccy: 'USDC' } }), acct('sh', 'shadow'),
])
const ok = (equity: string, available: string, today: string): RowState => ({ ...EMPTY_ROW, summary: { equity, available, today } })

describe('funds model · 组小计只组内加', () => {
  it('实盘与纸面各加各的，影子账户不进任何一组', () => {
    const groups = groupAccounts(accounts, { hl: ok('10480.20', '5792.76', '128.40'), bn: ok('2000.00', '2000.00', '0.00'), p1: ok('9987.50', '8367.20', '-12.50'), sh: ok('777', '777', '7') })
    expect(groups.map((g) => g.mode)).toEqual(['live', 'paper'])
    expect(groups[0]!.rows.map((r) => r.account.accountId)).toEqual(['hl', 'bn'])
    expect(fmtAmt(groups[0]!.subtotal.equity)).toBe('12,480.20')
    expect(fmtAmt(groups[0]!.subtotal.available)).toBe('7,792.76')
    expect(fmtSigned(groups[0]!.subtotal.today)).toBe('+128.40')
    expect(fmtAmt(groups[1]!.subtotal.equity)).toBe('9,987.50')
    expect(fmtSigned(groups[1]!.subtotal.today)).toBe('−12.50')
    expect(groups.flatMap((g) => g.rows).some((r) => r.account.accountId === 'sh')).toBe(false)
  })

  it('组里有一行缺数据（场所不可达）时，这组小计留空，另一组不受影响', () => {
    const groups = groupAccounts(accounts, { hl: ok('10480.20', '5792.76', '128.40'), bn: { ...EMPTY_ROW, unreachable: true }, p1: ok('9987.50', '8367.20', '-12.50') })
    expect(groups[0]!.subtotal).toEqual({ equity: null, available: null, today: null })
    expect(groups[1]!.subtotal.equity).toBe('9987.50')
  })

  it('求和不丢精度：0.1 + 0.2 = 0.3；超出浮点安全范围的金额逐位精确', () => {
    const small = groupAccounts(accounts, { hl: ok('0.1', '0.1', '0.1'), bn: ok('0.2', '0.2', '0.2'), p1: ok('0', '0', '0') })
    expect(small[0]!.subtotal).toEqual({ equity: '0.3', available: '0.3', today: '0.3' })
    const big = groupAccounts(accounts, { hl: ok('12345678901234567.89', '1', '1'), bn: ok('0.01', '1', '1'), p1: ok('0', '0', '0') })
    expect(big[0]!.subtotal.equity).toBe('12345678901234567.90')
    expect(fmtAmt(big[0]!.subtotal.equity)).toBe('12,345,678,901,234,567.90')
    const tiny = groupAccounts(accounts, { hl: ok('0.00412345', '0', '0'), bn: ok('0.00000001', '0', '0'), p1: ok('0', '0', '0') })
    expect(fmtAmt(tiny[0]!.subtotal.equity)).toBe('0.00412346')
  })

  it('没有任何账户的模式不出组', () => {
    expect(groupAccounts(normalizeAccounts([acct('p1', 'paper')]), {}).map((g) => g.mode)).toEqual(['paper'])
  })
})

describe('funds model · 今日 = 权益 − 日初', () => {
  it('有日初权益：今日是差值，且以差值为准而不是 dayPnl', () => {
    expect(summaryOf({ equity: '10480.2', available: '5792.76', dayStartEquity: '10351.8', dayPnl: '999' })).toEqual({ equity: '10480.2', available: '5792.76', today: '128.4' })
    expect(fmtSigned(summaryOf({ equity: '9987.5', dayStartEquity: '10000' })!.today)).toBe('−12.50')
  })
  it('没有日初退到 dayPnl，两者都没有就缺失', () => {
    expect(summaryOf({ equity: '100', dayPnl: '5' })!.today).toBe('5')
    expect(summaryOf({ equity: '0.3', dayStartEquity: '0.1' })!.today).toBe('0.2')
    expect(summaryOf({ equity: '100' })!.today).toBeNull()
    expect(summaryOf(null)).toBeNull()
  })
  it('数值为零 = 中性色、不带符号；非零按内核精度带符号着色（不取整成 0.00）', () => {
    expect(toneOf('0.00')).toBe('neutral')
    expect(fmtSigned('0.00')).toBe('0.00')
    expect(fmtSigned('-0.00')).toBe('0.00')
    expect(toneOf('0.004')).toBe('up')
    expect(fmtSigned('0.004')).toBe('+0.004')
    expect(toneOf('-0.004')).toBe('down')
    expect(toneOf('128.4')).toBe('up')
    expect(toneOf('-12.5')).toBe('down')
    expect(toneOf(null)).toBe('neutral')
    expect(toneOf('abc')).toBe('neutral')
  })
  it('金额按内核精度原样显示：0.00412345 BTC 不会变成 0.00；至少两位、至多八位、千分位', () => {
    expect(fmtAmt('0.00412345')).toBe('0.00412345')
    expect(fmtAmt('0.5')).toBe('0.50')
    expect(fmtAmt('10480.2')).toBe('10,480.20')
    expect(fmtAmt('-0.00000123')).toBe('−0.00000123')
    expect(fmtSigned('0.00412345')).toBe('+0.00412345')
    expect(fmtAmt(null)).toBe('—')
    expect(negStr('0.00412345')).toBe('-0.00412345')
    expect(negStr('-3')).toBe('3')
    expect(sumStr(['0.00412345', negStr('0.00412345')])).toBe('0.00000000')
  })
})

describe('funds model · 缺采样段断开不补', () => {
  const H = 3_600_000
  const raw = {
    points: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ t: i * H, equity: String(100 + i), available: '0' })),
    gaps: [{ from: 3 * H, to: 5 * H }],
  }
  it('gap 两侧各成一段，gap 里的点不出现', () => {
    const c = curveOf(raw)
    expect(c.segments.map((s) => s.map((p) => p.t / H))).toEqual([[0, 1, 2], [5, 6, 7]])
    expect(c.first).toEqual({ t: 0, v: 100, s: '100' })
    expect(c.last).toEqual({ t: 7 * H, v: 107, s: '107' })
  })
  it('没有 gap 就是一整段；区间外的点被丢弃；乱序也按时间排', () => {
    const c = curveOf({ points: [{ t: 3, equity: '3' }, { t: 1, equity: '1' }, { t: 2, equity: '2' }, { t: 99, equity: '9' }], gaps: [] }, 0, 50)
    expect(c.segments).toHaveLength(1)
    expect(c.segments[0]!.map((p) => p.t)).toEqual([1, 2, 3])
  })
  it('空与垃圾输入不抛错', () => {
    expect(curveOf({ points: [], gaps: [] }).segments).toEqual([])
    expect(curveOf(null).last).toBeNull()
    expect(curveOf({ points: [{ t: 'x', equity: 'y' }] }).segments).toEqual([])
  })
  it('区间：1D 取分钟步长，全部从 0 起', () => {
    expect(rangeOf('1D', 1000 * H)).toMatchObject({ step: '1m', to: 1000 * H })
    expect(rangeOf('7D', 1000 * H).from).toBe(1000 * H - 7 * 24 * H)
    expect(rangeOf('ALL', 5).from).toBe(0)
  })
  it('刻度落在区间内、等差；时间刻度按天', () => {
    const t = niceTicks(10300, 10575, 6)
    expect(t[0]).toBeGreaterThanOrEqual(10300)
    expect(t[t.length - 1]).toBeLessThanOrEqual(10575)
    expect(new Set(t.slice(1).map((v, i) => Math.round((v - t[i]!) * 1e6)))).toHaveLength(1)
    const days = timeTicks(new Date(2026, 9, 16, 5).getTime(), new Date(2026, 9, 22, 21).getTime())
    expect(days.map((d) => d.label)).toEqual(['17日', '18日', '19日', '20日', '21日', '22日'])
  })
})

describe('funds model · 保证金率断色阈值', () => {
  it('< 85% 中性，≥ 85% 转琥珀；缺失不转', () => {
    expect(marginWarn(0.0241)).toBe(false)
    expect(marginWarn(0.8499)).toBe(false)
    expect(marginWarn(0.85)).toBe(true)
    expect(marginWarn(1.2)).toBe(true)
    expect(marginWarn(null)).toBe(false)
  })
  it('条宽夹在 0–100，两位小数', () => {
    expect(barPct(0.0241)).toBe(2.41)
    expect(barPct(1.5)).toBe(100)
    expect(barPct(-1)).toBe(0)
    expect(barPct(null)).toBe(0)
  })
  it('保证金卡：初始 / 维持占权益的比例；没有快照返回 null', () => {
    const m = marginOf({ margin: { equity: '10480.20', initialMargin: '4687.44', maintenanceMargin: '252.33', available: '5792.76', marginRatio: '0.0241', leverage: 1.28 } })!
    expect(m.initialPct).toBe(44.73)
    expect(m.maintPct).toBe(2.41)
    expect(m.leverage).toBe(1.28)
    expect(marginOf({ balances: [], margin: null })).toBeNull()
    expect(marginOf({ margin: { equity: '1' } })).toBeNull()
  })
})

describe('funds model · 行状态与错误原文', () => {
  const hl = accounts[0] as FundAccount
  const bn = accounts[1] as FundAccount
  const paper = accounts[2] as FundAccount
  const health = venueHealth([{ venue: 'hyperliquid', wsState: 'connected' }, { venue: 'binance', wsState: 'disconnected', unverified: true }, { venue: 'kernel-sim', wsState: 'connected' }])
  it('场所断开只让这一行不可达，并带「未验证」', () => {
    const r = rowState(bn, { summary: { equity: '1' }, summaryFail: null, assets: null, health })
    expect(r).toMatchObject({ unreachable: true, unverified: true, summary: null })
    expect(rowState(hl, { summary: { equity: '5', dayStartEquity: '4' }, summaryFail: null, assets: { margin: { marginRatio: '0.1' } }, health })).toMatchObject({ unreachable: false, ratio: 0.1, summary: { equity: '5', today: '1' } })
  })
  it('权益查询回「场所不可达」也算不可达；纸面从不不可达', () => {
    const fail = failOf(Object.assign(new Error('The local fixture venue is unavailable.'), { code: -32000, data: { name: 'VENUE_UNAVAILABLE' } }))
    expect(rowState(hl, { summary: null, summaryFail: fail, assets: null, health: {} }).unreachable).toBe(true)
    expect(rowState(paper, { summary: null, summaryFail: fail, assets: null, health: { 'kernel-sim': { down: true, unverified: false } } }).unreachable).toBe(false)
  })
  it('错误码与原文照样取出，不改写', () => {
    expect(failOf(Object.assign(new Error('Method not found: account.assets'), { code: -32601 }))).toEqual({ message: 'Method not found: account.assets', code: -32601, name: null })
    expect(failOf(new Error('boom'))).toEqual({ message: 'boom', code: null, name: null })
    // 真 KernelError：Problem 名取 problemName，不是 JS 的 "KernelError"
    expect(failOf(new KernelError(-32000, 'Venue binance is unavailable.', { name: 'VENUE_UNAVAILABLE' }))).toEqual({ message: 'Venue binance is unavailable.', code: -32000, name: 'VENUE_UNAVAILABLE' })
  })
  it('{ok:false, error} 形状的成功返回也取出错误原文', () => {
    expect(okFalse({ ok: false, error: { code: 1, message: 'The local fixture cannot provide this view.' } })).toMatchObject({ message: 'The local fixture cannot provide this view.' })
    expect(okFalse({ ok: true })).toBeNull()
    expect(okFalse([])).toBeNull()
  })
})

describe('funds model · 资产 / 权益变动 / 重置文案', () => {
  it('资产行：冻结 = hold，借入缺省 0', () => {
    expect(assetsOf({ balances: [{ asset: 'USDC', total: '10480.20', available: '5792.76', hold: '4687.44' }] })).toEqual([{ asset: 'USDC', total: '10480.20', available: '5792.76', frozen: '4687.44', borrowed: '0' }])
    // 小数位很多的币种原样保留
    const btc = assetsOf({ balances: [{ asset: 'BTC', total: '0.00412345', available: '0.00412345', hold: '0' }] })[0]!
    expect([btc.total, btc.available, btc.frozen].map(fmtAmt)).toEqual(['0.00412345', '0.00412345', '0.00'])
    expect(assetsOf({ balances: [] })).toEqual([])
  })
  it('权益变动六行：期初 + 已实现 + 手续费 + 资金费 + 未实现 = 期末（夹具自洽），资金费按标的拆开', () => {
    const fills = { items: Array.from({ length: 10 }, (_, i) => ({ realizedPnl: ['0', '0', '8.2', '0', '5.6', '0', '0', '11.4', '0', '7.7'][i], fee: '1.655', price: '66200', size: '0.05' })) }
    const funding = { items: [['hyperliquid:BTC', '-1.77'], ['hyperliquid:ETH', '0.35'], ['hyperliquid:SOL', '-2.43']].map(([i, a]) => ({ subject: { instrumentId: i }, payload: { amount: a } })) }
    const positions = { positions: [{ size: '1', unrealizedPnl: '14.50' }, { size: '1', unrealizedPnl: '9.40' }, { size: '1', unrealizedPnl: '3.86' }] }
    const rows = changesOf({ first: { t: 0, v: 10439.94, s: '10439.94' }, last: { t: 1, v: 10480.2, s: '10480.2' }, fills, funding, positions })!
    expect(rows.map((r) => r.key)).toEqual(['start', 'realized', 'fee', 'funding', 'unrealized', 'end'])
    expect(rows.map((r) => fmtSigned(r.value))).toEqual(['+10,439.94', '+32.90', '−16.550', '−3.85', '+27.76', '+10,480.20'])
    expect(rows[1]!.detail).toBe('成交 10 笔')
    expect(rows[2]!.detail).toBe('费率 0.05%')
    expect(rows[3]!.detail).toBe('BTC −1.77　ETH +0.35　SOL −2.43')
    expect(rows[4]!.detail).toBe('持仓 3')
    expect(rows.slice(0, 1).concat(rows.slice(5)).every((r) => r.tone === 'neutral')).toBe(true)
    expect(rows[1]!.tone).toBe('up')
    expect(rows[2]!.tone).toBe('neutral')
    expect(rows[3]!.tone).toBe('neutral')
    // 期初 + 四项 − 期末 = 0，按十进制精确求和
    expect(Number(sumStr([...rows.slice(0, 5).map((r) => r.value), negStr(rows[5]!.value)]))).toBe(0)
  })
  it('整段什么都没发生返回 null；没有曲线也是 null', () => {
    expect(changesOf({ first: { t: 0, v: 5, s: '5' }, last: { t: 1, v: 5, s: '5.00' }, fills: { items: [] }, funding: { items: [] }, positions: { positions: [] } })).toBeNull()
    expect(changesOf({ first: null, last: null, fills: null, funding: null, positions: null })).toBeNull()
  })
  it('重置文案写出后果：持仓、挂单、回到初始资金', () => {
    const paper = accounts[2] as FundAccount
    expect(resetText({ ...paper, alias: 'paper-1' }, 1, 0)).toBe('清空 paper-1：持仓 1、挂单 0，余额回到 10,000.00')
    expect(countPositions({ positions: [{ size: '0' }, { size: '2' }] })).toBe(1)
    expect(countOpenOrders([{ status: 'open' }, { status: 'filled' }, { status: 'partially_filled' }])).toBe(2)
  })
  it('账户标准化：影子保留 mode，未知模式按实盘；缺 id 丢弃', () => {
    expect(normalizeAccounts([{ alias: 'x' }, acct('a', 'shadow'), acct('b', 'weird')]).map((a) => a.mode)).toEqual(['shadow', 'live'])
  })
  it('纵轴刻度：整数刻度不带 .00；一组里有小数时整组同位数（release-r1 R1）', () => {
    const a = fmtTicks([10000, 10025, 10050])
    expect([10000, 10025, 10050].map(a)).toEqual(['10,000', '10,025', '10,050'])
    const b = fmtTicks([9997.5, 10000, 10002.5])
    expect([9997.5, 10000, 10002.5].map(b)).toEqual(['9,997.5', '10,000.0', '10,002.5'])
    expect(fmtTicks([0.1 + 0.2, 0.5])(-0.5)).toBe('−0.5')
  })
})

// ---- 组合（GQ-65）---------------------------------------------------------------------------

describe('model-funds · portfolioView', () => {
  it('three sections; shares sum to 100%; strategies by P&L with 未归属 last; top 5 instruments + 其余', () => {
    const m = portfolioView(PORTFOLIO.live)
    if (m.kind !== 'ready') throw new Error(m.kind)
    expect(m.venues.map((r) => [r.key, sharePct(r.share)])).toEqual([['hyperliquid', '75.00%'], ['binance', '25.00%']])
    expect(sumStr(m.venues.map((r) => r.share))).toBe('1.00')
    expect(m.strategies.map((r) => r.label)).toEqual(['ema-trend', 'funding-carry', '未归属'])
    expect(m.strategies.map((r) => r.tone)).toEqual(['up', 'down', 'down'])
    expect(m.instruments.map((r) => r.key)).toEqual(['hyperliquid:BTC', 'hyperliquid:ETH', 'binance:SOLUSDT', 'binance:BNBUSDT', 'hyperliquid:HYPE', '__rest'])
    expect(m.instruments.at(-1)).toMatchObject({ label: '其余 2', amount: '2800.00', share: '0.07' })
    expect(sumStr(m.instruments.map((r) => r.share))).toBe('1.00')
    expect(m.scopes).toEqual(['live', 'paper'])
  })
  it('unavailable keeps the kernel details verbatim (反例：不抛、不改写)', () => {
    expect(portfolioView(PORTFOLIO.unavailable)).toEqual({ kind: 'unavailable', details: ['missing_fx: EUR->USDC', 'unknown_instrument: hyperliquid:NOPE'] })
  })
  it('no positions is empty, not an error', () => {
    expect(portfolioView(PORTFOLIO.empty)).toEqual({ kind: 'empty', scope: 'live', scopes: ['live'] })
  })
  it('a wrong shape throws an unwired error naming the field (反例：不猜)', () => {
    let err: unknown
    try { portfolioView({ scope: 'live', byVenue: [] }) } catch (e) { err = e }
    expect((err as Error).message).toBe('portfolio.analysis 回包缺少 byStrategy')
    expect(wireState(err)).toBe('off')
    expect(() => portfolioView(null)).toThrow('回包缺少 scope')
  })
})
