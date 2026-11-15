// SPDX-License-Identifier: CPAL-1.0
// HTX USDT 本位永续能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分：
//   · 订单类型：market 声明 `emulated` —— HTX 的市价单不带价、限不了滑点，所以一律发
//     「参考价 ± maxSlippageBps 的限价 + IOC」（marketEmulation.method = 'ioc_limit'）；
//     limit 声明 `native`；stop_* / take_* / trailing_stop / twap 全部 `none`：
//     触发单要「计划委托」端点，本包的参照实现（QD）里没有它，本包不凭记忆编端点（G3）；
//     追踪止损 HTX 侧也只有计划委托一种做法，同样不声明；
//   · tpsl.attachToOrder = false：submit 对带 tpsl 的意图一律回 1004；
//     tpsl.positionLevel 只在 v1 family 为 true（swap_cross_tpsl_order 是 v1 端点）；v5 family 调 setTpsl → 1004；
//   · amend = `none`：HTX 没有改单端点（官方只有撤 + 下），内核负责撤旧挂新；
//   · cancelAll = `native`：v5 走官方 POST /v5/trade/cancel_all_orders；v1 走 POST swap_cross_cancelall；
//   · deadman 不声明：v5 有 POST /v5/trade/cancel-after（on_off / time_out），**本包未实现**，scheduleCancel 一律 5002；
//   · marginModes：v1 只有 cross（swap_cross_* 是交叉保证金）；v5 支持 cross / isolated；
//   · signers.type = 'api-key'（HMAC，不是签名器句柄）；连接器不调用任何提现接口，withdrawCapable = false；
//   · clientOrderId.format = 'htx-int64'：场所的 client_order_id 是 int64，内核字符串 id 走确定性映射
//     （orders.numericClientOrderId），映射不可逆——对账时用同一函数把内核 id 换成 int64 再比。
import type { VenueCapabilities } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import { HTX_ORDER_LIMIT_PER_SEC, HTX_QUERY_LIMIT_PER_SEC, HTX_RATE_WINDOW_MS, DEFAULT_TARGET_RATIO } from './budget'
import { MAX_CANDLES } from './market'
import { SUPPORTED_ORDER_TYPES, SUPPORTED_TIF } from './orders'
import { VENUE } from './parse'

/** 线性永续的缺省最小名义额（拿不到标的规格时用；HTX 按张下单，实际门槛以合约规格为准）。 */
export const FALLBACK_MIN_NOTIONAL = '5'

export function htxCapabilities(opts: { minOrderNotional?: string; family?: 'v5' | 'v1' } = {}): VenueCapabilities {
  const family = opts.family ?? 'v5'
  return {
    venue: VENUE,
    environments: ['mainnet'],
    instrumentKinds: ['perp'],
    orderTypes: {
      market: 'emulated',
      limit: 'native',
      stop_market: 'none',
      stop_limit: 'none',
      take_market: 'none',
      take_limit: 'none',
      trailing_stop: 'none',
      twap: 'none',
    },
    marketEmulation: { method: 'ioc_limit' },
    tif: [...SUPPORTED_TIF],
    // 没有触发单，就没有触发价参考口径（不写 'last' 假装支持）。
    triggerPriceTypes: [],
    tpsl: { attachToOrder: false, positionLevel: family === 'v1', parentPartialCancel: 'keep_children' },
    batch: { maxOrders: null, atomic: false },
    amend: 'none',
    cancelAll: 'native',
    positionMode: ['oneWay', 'hedge'],
    marginModes: family === 'v1' ? ['cross'] : ['cross', 'isolated'],
    accountModels: ['unified', 'standard'],
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
        scope: 'uid',
        model: 'count',
        limit: HTX_ORDER_LIMIT_PER_SEC,
        windowMs: HTX_RATE_WINDOW_MS,
        note: `HTX counts order endpoints per UID; Gitrader targets <= ${Math.round(DEFAULT_TARGET_RATIO * 100)}% of the documented limit (kernel may inject its own budget)`,
      },
      {
        scope: 'uid',
        model: 'count',
        limit: HTX_QUERY_LIMIT_PER_SEC,
        windowMs: HTX_RATE_WINDOW_MS,
        note: 'private query endpoints are counted separately from order endpoints',
      },
      { scope: 'ip', model: 'count', limit: HTX_QUERY_LIMIT_PER_SEC, windowMs: HTX_RATE_WINDOW_MS, note: 'public market data is rate limited by IP (handled by connector-htx-data)' },
    ],
    wsLimits: { maxConnections: 0, newPerMinute: 0 },
    clientOrderId: { format: 'htx-int64' },
    history: { maxCandles: MAX_CANDLES, pageLimit: MAX_CANDLES },
    withdrawPermissionCheck: 'not_applicable',
    'x-orderTypes': SUPPORTED_ORDER_TYPES,
    'x-family': family,
    'x-tpslModel': family === 'v1'
      ? 'position-level swap_cross_tpsl_order (setTpsl) after the fill; submit never attaches protection'
      : 'v5 accounts have no TP/SL path in this connector; setTpsl returns 1004',
    'x-amendScope': 'none: cancel and re-submit',
    'x-cancelAll': family === 'v1'
      ? 'native: POST swap_cross_cancelall (data.errors checked per order)'
      : 'native: POST /v5/trade/cancel_all_orders (per-order code checked)',
  }
}
