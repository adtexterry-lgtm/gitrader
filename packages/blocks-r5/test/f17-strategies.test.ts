// SPDX-License-Identifier: CPAL-1.0
// F17：策略页「启动」表单的校验（空标的不可提交、格式提示、周期默认 15m）与生成的 strategy.start 命令参数。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_START_INTERVAL, INTERVAL_OPTIONS, isStartInterval, normalizeAccounts, normalizeStrategies, parseInstruments, readStartForm, startFormSeed, startStrategyCmd,
} from '../src/model-strategies'
import { ACCT_PAPER, strategiesData } from '../fixtures/strategies'
import { EMPTY_LABEL, hasContent } from '../src/views/strategies'

const accounts = normalizeAccounts(strategiesData.ACCOUNTS)
const model = normalizeStrategies(strategiesData.STRATEGIES, accounts)
const paperStopped = model.rows.find((r) => r.strategyId === 'mean-rev')!

describe('f17 · start form validation', () => {
  it('an empty instrument list cannot be submitted', () => {
    expect(readStartForm('', '15m')).toEqual({ ok: false, message: '请填写标的' })
    expect(readStartForm('   ', '15m')).toMatchObject({ ok: false })
    expect(readStartForm(' , , ', '15m')).toMatchObject({ ok: false })
    expect(parseInstruments('')).toMatchObject({ ok: false })
  })

  it('instruments must be <venue>:<symbol>', () => {
    expect(parseInstruments('BTC')).toEqual({ ok: false, message: 'BTC 应写成 <场所>:<符号>' })
    expect(parseInstruments('hyperliquid:')).toMatchObject({ ok: false })
    expect(parseInstruments(':BTC')).toMatchObject({ ok: false })
    expect(parseInstruments('hyper liquid:BTC')).toMatchObject({ ok: false })
    expect(parseInstruments('hyperliquid:BTC, okx:ETH')).toEqual({ ok: true, instruments: ['hyperliquid:BTC', 'okx:ETH'] })
    expect(parseInstruments('hyperliquid:BTC, hyperliquid:BTC')).toEqual({ ok: true, instruments: ['hyperliquid:BTC'] })
  })

  it('the interval defaults to 15m', () => {
    expect(DEFAULT_START_INTERVAL).toBe('15m')
    expect(INTERVAL_OPTIONS).toEqual(['1m', '5m', '15m', '1h', '4h', '1d'])
    expect(startFormSeed(paperStopped)).toEqual({ text: '', interval: '15m' })
    expect(readStartForm('hyperliquid:BTC', '')).toMatchObject({ pick: { interval: '15m' } })
    expect(readStartForm('hyperliquid:BTC', '30m')).toMatchObject({ pick: { interval: '15m' } })
    expect(readStartForm('hyperliquid:BTC', '4h')).toMatchObject({ pick: { interval: '4h' } })
    expect(isStartInterval('5m')).toBe(true)
    expect(isStartInterval('30m')).toBe(false)
    // 内核将来在行里给了 instruments / interval：表单预填。
    expect(startFormSeed({ ...paperStopped, instruments: ['hyperliquid:BTC'], interval: '1h' })).toEqual({ text: 'hyperliquid:BTC', interval: '1h' })
  })
})

describe('f17 · strategy.start command', () => {
  it('carries the picked instruments, interval, account and instance', () => {
    const cmd = startStrategyCmd(paperStopped, { instruments: ['hyperliquid:BTC', 'okx:ETH'], interval: '15m' })
    expect(cmd).toEqual({
      action: 'engine.call',
      params: {
        id: 'ts-builtin', method: 'strategy.start',
        params: {
          strategyId: 'mean-rev', instanceId: paperStopped.instanceId, accountId: ACCT_PAPER,
          instruments: ['hyperliquid:BTC', 'okx:ETH'], interval: '15m', params: { z: 2, size: 0.1 },
        },
      },
    })
    const form = readStartForm(' hyperliquid:BTC , okx:ETH ', '1h')
    if (!form.ok) throw new Error('form refused')
    expect(startStrategyCmd(paperStopped, form.pick).params).toMatchObject({ params: { instruments: ['hyperliquid:BTC', 'okx:ETH'], interval: '1h' } })
  })
})

describe('f17 · empty copy', () => {
  it('the strategy list and the engine list do not share the same empty text', () => {
    expect(EMPTY_LABEL.strategies).toBe('还没有策略')
    expect(EMPTY_LABEL.strategies).not.toContain('引擎')
    expect(EMPTY_LABEL.engines).toBe('没有已连接的引擎')
  })
})

describe('f17 · engine events without content', () => {
  it('a row that only has the fallback text is hidden; rows with text, upstream text or a note stay', () => {
    expect(hasContent({ text: '引擎事件', bad: null, note: null })).toBe(false)
    expect(hasContent({ text: '引擎事件', bad: '引擎报错原文', note: null })).toBe(true)
    expect(hasContent({ text: '启动 mean-rev', bad: null, note: null })).toBe(true)
  })
})
