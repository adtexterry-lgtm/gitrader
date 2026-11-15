// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { explainBacktestSpec } from '../src/lab/spec-explain'

const base = () => ({
  subject: { strategy: { id: 's', version: '1', params: {} } },
  instruments: ['hyperliquid:BTC'],
  interval: '1h',
  from: 1_000,
  to: 2_000,
  data: { source: 'host' },
  account: { initialBalance: '10000', ccy: 'USDC' },
  assumptions: { fees: 'venue', slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
  seed: 7,
})

describe('GQ-20 explainBacktestSpec', () => {
  it('合法 spec 通过', () => expect(explainBacktestSpec(base())).toBeUndefined())

  it.each([
    ['leverage=0', (s: any) => { s.account.leverage = 0 }, '/account/leverage'],
    ['initialBalance=1e30', (s: any) => { s.account.initialBalance = '1e30' }, '/account/initialBalance'],
    ['from>to', (s: any) => { s.from = 5_000 }, '/from must be earlier than /to'],
    ['重复标的', (s: any) => { s.instruments = ['hyperliquid:BTC', 'hyperliquid:BTC'] }, '/instruments contains duplicates'],
    ['未知字段', (s: any) => { s.__evil = 1 }, '/__evil'],
    ['account 下未知字段', (s: any) => { s.account.foo = 1 }, '/account/foo'],
  ])('%s 被点名', (_n, mut, expected) => {
    const s = base()
    mut(s)
    expect(explainBacktestSpec(s)).toContain(expected)
  })

  it('x- 扩展字段放行', () => {
    const s: any = base()
    s['x-note'] = 'ok'
    expect(explainBacktestSpec(s)).toBeUndefined()
  })

  it('允许键清单与 schema 一致（防漂移）', () => {
    const schema = JSON.parse(readFileSync(new URL('../../protocol/schemas/gep.BacktestSpec.json', import.meta.url), 'utf8'))
    expect(Object.keys(schema.properties).sort()).toEqual(['account', 'assumptions', 'data', 'from', 'instruments', 'interval', 'seed', 'subject', 'to'])
  })
})
