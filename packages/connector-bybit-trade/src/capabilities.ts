// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 线性永续能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分：
//   · 订单类型：market 声明 `emulated` —— Bybit 的 Market 单不带价，限不了滑点，所以一律发
//     「参考价 ± maxSlippageBps 的 Limit + IOC」（marketEmulation.method = 'ioc_limit'）；
//     limit / stop_market / stop_limit / take_market / take_limit 都是真发（触发单靠 triggerBy + triggerDirection，
//     线性建单不发 orderFilter——orderFilter 只对现货生效）；
//     twap 不声明；trailing_stop 声明 `none`：Bybit 没有 /v5/order/create 的追踪单类型，
//     追踪只能做**持仓级**（positions/trading-stop），本包把它放在 setTradingStop()，不进 submit；
//   · tpsl.attachToOrder = false / positionLevel = false：submit 对带 tpsl 的意图一律回 1004。
//     Bybit 其实支持建单时附带 TP/SL（tpslMode=Partial），但那些保护腿**没有独立的订单号**，
//     内核按 clientOrderId 对账时会对不上 —— 宁可老实说做不到，由内核成交后补挂（buildProtectionOrders）
//     或用持仓级 buildTradingStop()。协议表达不了「原生但无法对账」，这里按更严的口径声明；
//   · amend = 'emulated'：只有 Limit 系（limit / stop_limit / take_limit）有原生改单，其它类型回 1004。
//     协议 SupportLevel 表达不了「部分支持」，照 Binance 包的写法声明 'emulated' 并在 README 写明；
//   · cancelAll = 'native'（POST /v5/order/cancel-all，按 symbol 或 settleCoin）；
//   · deadman 不声明：Bybit v5 没有场所级定时撤单，scheduleCancel 一律 5002；
//   · signers.type = 'api-key'（HMAC，不是签名器句柄）；连接器不调用任何提现接口，withdrawCapable = false。
import type { VenueCapabilities } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import { BYBIT_RATE_LIMIT, BYBIT_RATE_WINDOW_MS, DEFAULT_TARGET_RATIO, ORDER_LIMIT_PER_SEC } from './budget'
import { SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES, VENUE } from './parse'

/** 线性永续的最小名义额缺省（Bybit 逐 symbol 的 minNotionalValue，拿不到标的时用这个）。 */
export const FALLBACK_MIN_NOTIONAL = '5'
/** 历史 K 线条数上限（复用数据包的口径：单页 1000）。 */
export const MAX_CANDLES = 1_000

export function bybitCapabilities(opts: { minOrderNotional?: string } = {}): VenueCapabilities {
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
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: [...SUPPORTED_TRIGGER_TYPES],
    // submit 不挂保护单（Bybit 建单附带的 TP/SL 没有独立订单号，无法按 clientOrderId 对账）。
    tpsl: { attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' },
    batch: { maxOrders: null, atomic: false },
    // 只有 Limit 系支持原生改单——协议表达不了部分支持，见文件头注释。
    amend: 'emulated',
    cancelAll: 'native',
    positionMode: ['oneWay', 'hedge'],
    marginModes: ['cross', 'isolated'],
    accountModels: ['unified'],
    rules: { minOrderNotional: asDecimal(opts.minOrderNotional ?? FALLBACK_MIN_NOTIONAL) },
    signers: {
      type: 'api-key',
      perAccount: { unnamed: 1, named: 0 },
      maxValidityDays: 0,
      withdrawCapable: false,
      noncePerSigner: false,
    },
    rateLimits: [
      {
        scope: 'ip',
        model: 'weight',
        limit: BYBIT_RATE_LIMIT,
        windowMs: BYBIT_RATE_WINDOW_MS,
        note: `Bybit counts 600 requests / 5 s per IP; Gitrader targets <= ${Math.round(DEFAULT_TARGET_RATIO * 100)}% of this budget`,
      },
      { scope: 'uid', model: 'count', limit: ORDER_LIMIT_PER_SEC, windowMs: 1_000, note: 'order endpoints are counted separately from request weight' },
      { scope: 'ip', model: 'count', limit: 120, windowMs: 5_000, note: 'public market data is rate limited by IP (handled by the data connector)' },
    ],
    wsLimits: { maxConnections: 500, newPerMinute: 500 },
    clientOrderId: { format: 'bybit-36' },
    history: { maxCandles: MAX_CANDLES, pageLimit: MAX_CANDLES },
    withdrawPermissionCheck: 'not_applicable',
    'x-orderTypes': SUPPORTED_ORDER_TYPES,
    'x-tpslModel': 'post-fill reduce-only StopOrder legs (buildProtectionOrders) or position-level trading-stop (buildTradingStop)',
    'x-amendScope': 'limit / stop_limit / take_limit only',
  }
}
