// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid 能力声明（契约 §1.5.1）。只声明本连接器**实际实现**的部分：
//   · 现货 / 结果市场（instrumentKinds）、twap、trailing_stop、批量改单本轮没做，不声明；
//   · 数值取自知识库实测 / 官方文档，出处写在 README。
import type { VenueCapabilities } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import { BUILDER_FEE_TENTH_BPS } from './orders'
import { MARKET_PRICE_BAND_BPS, MIN_ORDER_NOTIONAL, VENUE } from './parse'
import { MAX_CANDLES, CANDLE_PAGE } from './market'

export function hyperliquidCapabilities(opts: { supportDeveloper?: boolean; marketPriceBandBps?: number } = {}): VenueCapabilities {
  return {
    venue: VENUE,
    environments: ['mainnet', 'testnet'],
    instrumentKinds: ['perp'],
    orderTypes: {
      market: 'emulated',
      limit: 'native',
      stop_market: 'native',
      stop_limit: 'native',
      take_market: 'native',
      take_limit: 'native',
      trailing_stop: 'none',
      twap: 'none',
    },
    marketEmulation: { method: 'ioc_limit' },
    tif: ['gtc', 'ioc', 'alo'],
    triggerPriceTypes: ['mark'],
    tpsl: { attachToOrder: true, positionLevel: true, parentPartialCancel: 'cancel_children' },
    // 官方未给批量上限；批量对 IP 计 1 次、对地址计 n 次
    batch: { maxOrders: null, atomic: false },
    amend: 'native',
    cancelAll: 'emulated',
    deadman: { method: 'schedule_cancel', minDelaySec: 5, maxTriggersPerDay: 10 },
    positionMode: ['oneWay'],
    marginModes: ['cross', 'isolated', 'strictIsolated', 'noCross'],
    accountModels: ['standard', 'unified', 'portfolio'],
    rules: { marketPriceBandBps: opts.marketPriceBandBps ?? MARKET_PRICE_BAND_BPS, minOrderNotional: asDecimal(MIN_ORDER_NOTIONAL) },
    signers: {
      type: 'api-wallet',
      perAccount: { unnamed: 1, named: 3 },
      perSubaccountNamed: 2,
      maxValidityDays: 180,
      withdrawCapable: false,
      noncePerSigner: true,
    },
    rateLimits: [
      { scope: 'ip', model: 'weight', limit: 1200, windowMs: 60_000, note: 'Gitrader targets <= 60% of this budget (720/min)' },
      { scope: 'address', model: 'volume', note: 'local in-memory estimate only; starts at 10000 plus observed USDC fills, larger cancel estimate capped by venue rule, incomplete across history and other clients' },
    ],
    wsLimits: { maxConnections: 10, newPerMinute: 30, maxSubscriptions: 1000, maxDistinctUsersInUserSubs: 10 },
    clientOrderId: { format: 'hex128' },
    builderFee: {
      supported: true,
      perpMaxTenthBps: 100,
      spotMaxTenthBps: 1000,
      spotChargedSide: 'sell',
      maxApprovalsPerUser: 10,
      collectorAccountModel: 'standard',
      collectorMinValue: asDecimal('100'),
    },
    history: { maxCandles: MAX_CANDLES, pageLimit: CANDLE_PAGE },
    withdrawPermissionCheck: 'not_applicable',
    'x-builderFeeTenthBps': BUILDER_FEE_TENTH_BPS,
    /** 场所支持 builder 费，但 Gitrader 默认不用：只有用户打开「支持开发者」才为 true。 */
    'x-supportDeveloper': opts.supportDeveloper === true,
  }
}
