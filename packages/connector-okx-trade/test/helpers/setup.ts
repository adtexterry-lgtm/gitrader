// SPDX-License-Identifier: CPAL-1.0
// 测试脚手架：把假服务器、HTTP、账户读取与交易四块拼起来（全部进程内，不联网）。
import type { StampedQuote, TradeContext } from '@gitrader/protocol/connector'
import { OkxAccounts } from '../../src/account'
import { createCountBudget } from '../../src/budget'
import { OkxHttp } from '../../src/rest'
import { OkxTrading } from '../../src/trading'
import { parseInstrumentRecords } from '../../src/parse'
import type { InstrumentRecord } from '../../src/parse'
import { API_KEY, API_SECRET, BASE_URL, FakeOkxTrade, NOW, PASSPHRASE, instruments } from './fake-okx-trade'

export const RECORDS: InstrumentRecord[] = parseInstrumentRecords(instruments, NOW)

/** 交易上下文：本连接器不使用 signer（HMAC），行为只依赖 account / signal。 */
export function tradeContext(over: Partial<TradeContext> = {}): TradeContext {
  return {
    account: { accountId: 'acct_test', address: '0x0000000000000000000000000000000000000000' },
    signer: { kind: 'api-key', fingerprint: 'test' } as never,
    ...over,
  } as TradeContext
}

export interface Stack {
  fake: FakeOkxTrade
  http: OkxHttp
  accounts: OkxAccounts
  trading: OkxTrading
}

const DEFAULT_QUOTE: StampedQuote = {
  instrumentId: 'okx:BTC-USDT-SWAP',
  ts: NOW,
  bid: 100000,
  ask: 100002,
  stale: false,
  ageMs: 0,
}

export function stack(opts: {
  positionMode?: 'oneWay' | 'hedge'
  fake?: FakeOkxTrade
  quote?: StampedQuote | null
} = {}): Stack {
  const fake = opts.fake ?? new FakeOkxTrade()
  const budget = createCountBudget({ clock: () => NOW })
  const http = new OkxHttp({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget,
    onWarn: () => {},
  })
  const accounts = new OkxAccounts({
    http,
    clock: () => NOW,
    secrets: [API_SECRET, API_KEY, PASSPHRASE],
    records: () => RECORDS,
  })
  const quote = opts.quote === undefined ? DEFAULT_QUOTE : opts.quote
  const trading = new OkxTrading({
    http,
    recordOf: (instrumentId) => RECORDS.find((r) => r.instrument.instrumentId === instrumentId),
    clock: () => NOW,
    ...(opts.positionMode !== undefined ? { positionMode: opts.positionMode } : {}),
    secrets: [API_SECRET, API_KEY, PASSPHRASE],
    openOrders: (ref, instrumentId) => accounts.openOrders(ref, instrumentId),
    pendingRefs: (instrumentId) => accounts.pendingRefs(instrumentId),
    orderStatus: (ref, key, o) => accounts.orderStatus(ref, key, o),
    quoteOf: (instrumentId) => (quote !== null && instrumentId === 'okx:BTC-USDT-SWAP' ? quote : undefined),
  })
  return { fake, http, accounts, trading }
}
