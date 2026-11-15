// SPDX-License-Identifier: CPAL-1.0
// 测试用装配：假服务器 + 假时钟 + 假 TradeContext + 标的记录。全部离线，不建连、不开端口。
import { parseInstruments } from '@gitrader/connector-bybit-data'
import type { Instrument } from '@gitrader/protocol'
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import { BybitHttp } from '../../src/rest'
import type { BybitHttpOptions } from '../../src/rest'
import { API_KEY, API_SECRET, BASE_URL, NOW, RECV_WINDOW, perpEntry } from './fake-bybit-trade'
import type { FakeBybitTrade } from './fake-bybit-trade'

export function newHttp(fake: FakeBybitTrade, over: Partial<BybitHttpOptions> = {}): BybitHttp {
  return new BybitHttp({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    recvWindowMs: RECV_WINDOW,
    timeoutMs: 5_000,
    onWarn: () => {},
    ...over,
  })
}

export const account = (): AccountRef => ({ accountId: 'acc_bybit_1' as AccountRef['accountId'], address: '0xbybit' as AccountRef['address'] })

/** TradeContext 的最小形状：本包不使用 signer（HMAC 没有签名器句柄），所以给个空壳。 */
export const ctx = (signal?: AbortSignal): TradeContext => ({
  account: account(),
  signer: {} as TradeContext['signer'],
  ...(signal ? { signal } : {}),
})

/** BTCUSDT / ETHUSDT 两条真网形状的线性永续（精度与假服务器一致）。 */
export function instruments(): Instrument[] {
  return parseInstruments([
    perpEntry(),
    perpEntry({
      symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT',
      priceFilter: { tickSize: '0.01' }, lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01', minNotionalValue: '5' },
    }),
  ], NOW)
}

export function instrumentOf(id: string, list: Instrument[] = instruments()): Instrument | undefined {
  return list.find((i) => i.instrumentId === id)
}

export const btc = (): Instrument => instrumentOf('bybit:BTCUSDT') ?? instruments()[0]!

/** 标准报价（买 100 / 卖 100.2，与假服务器 ticker 同尺度）。 */
export const freshQuote = (): { bid: number; ask: number; mid: number; stale: boolean } => ({ bid: 100, ask: 100.2, mid: 100.1, stale: false })
