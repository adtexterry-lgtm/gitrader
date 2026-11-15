// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 永续能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分：
//   · 订单类型：7 种都真发（market / limit / stop_market / stop_limit / take_market / take_limit / trailing_stop）；
//     twap 不声明（Binance 有 TWAP 但形态不同，本包不做）；
//   · tpsl.attachToOrder = false / positionLevel = false：币安没有原生父子单，带 tpsl 的 submit 直接返回 1004
//     （protect 单靠 buildProtectionOrders 在成交后补挂，由内核调用）；本包也不直接提供「持仓级」tpsl 入口；
//   · amend：**只有 LIMIT 走原生 PUT /fapi/v1/order**，其它类型返回 1004。协议 SupportLevel 只有
//     native / emulated / none，表达不了「部分支持」——所以这里声明 'emulated' 并在 README 里写明；
//   · deadman 不声明：Binance 有 countdownCancelAll（按 symbol），但本包未接入内核死人开关；
//     scheduleCancel 一律抛 CAPABILITY_UNSUPPORTED。
//   · signers.type = 'api-key'（HMAC，不是签名器句柄）；连接器不调用任何提现接口，
//     所以 withdrawCapable = false 表示「本连接器不用提现能力」，API key 请勿开提现权限。
import type { VenueCapabilities } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import { BINANCE_WEIGHT_LIMIT_PER_MIN, DEFAULT_TARGET_RATIO } from './budget'
import { FALLBACK_MIN_NOTIONAL, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES, VENUE } from './parse'

export function binanceCapabilities(opts: { minOrderNotional?: string } = {}): VenueCapabilities {
  return {
    venue: VENUE,
    environments: ['mainnet', 'testnet'],
    instrumentKinds: ['perp'],
    orderTypes: {
      market: 'native',
      limit: 'native',
      stop_market: 'native',
      stop_limit: 'native',
      take_market: 'native',
      take_limit: 'native',
      trailing_stop: 'native',
      twap: 'none',
    },
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: [...SUPPORTED_TRIGGER_TYPES],
    // 币安没有原生父子单：attachToOrder 必须是 false，位置级 tpsl 也不在本包实现。
    tpsl: { attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' },
    batch: { maxOrders: null, atomic: false },
    // 只有 LIMIT 支持原生改单（PUT /fapi/v1/order）——协议表达不了部分支持，见文件头注释。
    amend: 'emulated',
    cancelAll: 'native',
    positionMode: ['oneWay', 'hedge'],
    marginModes: ['cross', 'isolated'],
    accountModels: ['standard'],
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
        limit: BINANCE_WEIGHT_LIMIT_PER_MIN,
        windowMs: 60_000,
        note: `Gitrader targets <= ${Math.round(DEFAULT_TARGET_RATIO * 100)}% of this budget`,
      },
      { scope: 'account', model: 'count', limit: 300, windowMs: 10_000, note: 'order rate limit is counted separately from request weight' },
    ],
    wsLimits: { maxConnections: 300, newPerMinute: 300 },
    clientOrderId: { format: 'binance-36' },
    history: { maxCandles: 1_500, pageLimit: 1_500 },
    withdrawPermissionCheck: 'not_applicable',
    'x-orderTypes': SUPPORTED_ORDER_TYPES,
    'x-tpslModel': 'post-fill reduce-only protection orders (see buildProtectionOrders)',
  }
}
