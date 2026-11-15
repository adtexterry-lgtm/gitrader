// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：起一个假 TWS（真 socket），再装一个连接器打它。时钟固定，时段判定可复现。
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import type { AccountId, ClientOrderId } from '@gitrader/protocol'
import { IbkrTradeConnector } from '../../src/index'
import type { IbkrTradeConnectorOptions } from '../../src/index'
import { FakeTws } from './fake-tws'
import type { FakeTwsOptions } from './fake-tws'

/** 2026-10-21 是周三；纽约 10:30（EDT）＝常规时段。 */
export const NOW = Date.UTC(2026, 9, 21, 14, 30, 0)
/** 纽约 08:00：盘前（thin 窗口）。 */
export const PRE_MARKET = Date.UTC(2026, 9, 21, 12, 0, 0)
/** 纽约 17:00：盘后（thin 窗口）。 */
export const POST_MARKET = Date.UTC(2026, 9, 21, 21, 0, 0)
/** 纽约 21:00：收盘后（窗口外）。 */
export const CLOSED = Date.UTC(2026, 9, 22, 1, 0, 0)
/** 2026-10-24 是周六，contractDetails 里标 CLOSED。 */
export const HOLIDAY = Date.UTC(2026, 9, 24, 14, 30, 0)

export interface Harness {
  tws: FakeTws
  connector: IbkrTradeConnector
  ref: AccountRef
  ctx: TradeContext
  clock: { now: number }
  close(): Promise<void>
}

export const REF: AccountRef = { accountId: 'acct_ibkr_paper' as AccountId, address: '0x0000000000000000000000000000000000000001' }

export const CTX: TradeContext = {
  account: REF,
  signer: {
    address: '0x0000000000000000000000000000000000000001',
    signTypedData: () => Promise.resolve('0xdeadbeef'),
  },
}

export interface MakeOptions {
  tws?: FakeTwsOptions
  connector?: Partial<IbkrTradeConnectorOptions>
  symbols?: string[]
  /** 不调用 start()（测构造 / 未连接路径）。 */
  start?: boolean
  now?: number
}

export async function makeHarness(o: MakeOptions = {}): Promise<Harness> {
  const tws = await FakeTws.start({
    catalogue: { AAPL: {}, MSFT: {}, TSLA: {}, 'BRK B': {} },
    quote: { bid: 100, ask: 100.02, last: 100.01 },
    ...(o.tws ?? {}),
  })
  const clock = { now: o.now ?? NOW }
  const connector = new IbkrTradeConnector({
    mode: 'paper',
    port: tws.port,
    allowCustomPort: true,
    clientId: 7,
    symbols: o.symbols ?? ['AAPL'],
    clock: () => clock.now,
    ackTimeoutMs: 1500,
    requestTimeoutMs: 2500,
    connectTimeoutMs: 3000,
    reconnect: { enabled: false },
    ...(o.connector ?? {}),
  })
  if (o.start !== false) await connector.start()
  return {
    tws,
    connector,
    ref: REF,
    ctx: CTX,
    clock,
    close: async () => {
      await connector.close()
      await tws.stop()
    },
  }
}

export function clientOrderId(seed: string): ClientOrderId {
  return seed.padEnd(32, '0').slice(0, 32) as ClientOrderId
}

/** 等一会儿（让 socket 上的帧跑完）。 */
export const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
