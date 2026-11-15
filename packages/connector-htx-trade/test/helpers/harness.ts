// SPDX-License-Identifier: CPAL-1.0
// 测试用装配：假服务器 + 假时钟 + 假 TradeContext + 标的记录。全部离线，不建连、不开端口。
import type { Instrument } from '@gitrader/protocol'
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import type { HtxHttpOptions } from '../../src/rest'
import { HtxHttp } from '../../src/rest'
import { createWeightBudget } from '../../src/budget'
import { parseContract } from '../../src/market'
import { API_KEY, API_SECRET, BASE_URL, NOW, FakeHtx } from './fake-htx'

export const RECV_WINDOW = 5_000

export function newHttp(fake: FakeHtx, over: Partial<HtxHttpOptions> = {}): HtxHttp {
  return new HtxHttp({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    timeoutMs: 5_000,
    // 测试用高限额预算：测试时钟是冻结的，真实的窗口等待永远不会推进（生产用 Date.now，不受影响）
    budget: createWeightBudget({ limit: 10_000, clock: () => NOW, sleep: async () => {} }),
    onWarn: () => {},
    ...over,
  })
}

export const account = (): AccountRef => ({ accountId: 'acc_htx_1' as AccountRef['accountId'], address: 'htx' as AccountRef['address'] })

/** TradeContext 的最小形状：本包不使用 signer（HMAC 没有签名器句柄），所以给个空壳。 */
export const ctx = (signal?: AbortSignal): TradeContext => ({
  account: account(),
  signer: {} as TradeContext['signer'],
  ...(signal ? { signal } : {}),
})

/** BTC-USDT / ETH-USDT 两条真网形状的 USDT 本位永续（精度与假服务器一致）。 */
export function instruments(): Instrument[] {
  return [
    parseContract({ contract_code: 'BTC-USDT', contract_size: 0.001, price_tick: 0.1, contract_status: 1, max_leverage: 125 }, NOW),
    parseContract({ contract_code: 'ETH-USDT', contract_size: 0.01, price_tick: 0.01, contract_status: 1, max_leverage: 75 }, NOW),
  ].filter((i): i is Instrument => i !== null)
}

export function instrumentOf(id: string, list: Instrument[] = instruments()): Instrument | undefined {
  return list.find((i) => i.instrumentId === id)
}

export const btc = (): Instrument => instrumentOf('htx:BTC-USDT') ?? instruments()[0]!

/** 合约面值查表（parse.ts 的 ContractSizeOf）。 */
export function contractSizeOf(code: string): string | undefined {
  return ({
    'BTC-USDT': '0.001',
    'ETH-USDT': '0.01',
  } as Record<string, string>)[code]
}

/** 面值查表（TradingDeps.faceValueOf）。 */
export function faceValueOf(instrumentId: string): string | undefined {
  return contractSizeOf(instrumentId.replace(/^htx:/i, ''))
}

/** 标准报价（买 99.9 / 卖 100.1，与假服务器 ticker 同尺度）。 */
export const freshQuote = (): { bid: number; ask: number; mid: number; stale: boolean } => ({ bid: 99.9, ask: 100.1, mid: 100, stale: false })
