// SPDX-License-Identifier: CPAL-1.0
// Bitget USDT 永续能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分（工单教训 9）：
//   · market = emulated：上游有原生市价单，但 Gitrader 口径要求市价意图必须带 maxSlippageBps 并发「价带限价 + ioc」，
//     所以能力位老实写 emulated + marketEmulation.ioc_limit（不是 native）；
//   · amend = none：modify-order 是撤旧挂新、换新 orderId / clientOid，内核改单按原 clientOrderId 追踪，接不上 → 回 1004。
//   · tpsl 能力位不宣称：submit 带 tpsl 回 1004；保护单走 `placeProtection()`（包内方法，未进协议），
//     所以 attachToOrder / positionLevel 都为 false；
//   · 全撤 = 按标的模拟：orders-pending + cancel-order 逐张（QD open_orders.py / bitget.py:905-917）+ 计划单逐张；
//     不用 cancel-all-orders（官方按 productType 撤全部标的，QD 未调用），所以 cancelAll = 'emulated'；
//   · twap / batch 未实现；死人开关（定时全撤）上游没有，不声明 deadman。
import type { VenueCapabilities } from '@gitrader/protocol'
import { BITGET_ORDER_LIMIT_PER_SEC, BITGET_QUERY_LIMIT_PER_SEC } from './budget'
import { CANDLE_PAGE, MAX_CANDLES } from './parse'
import { VENUE } from './parse'

export interface CapabilityOptions {
  /** 市价模拟允许的最大滑点带（bps，仅用于声明；实际按 intent.maxSlippageBps）。 */
  marketPriceBandBps?: number
}

export function bitgetCapabilities(opts: CapabilityOptions = {}): VenueCapabilities {
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
      trailing_stop: 'native',
      twap: 'none',
    },
    marketEmulation: { method: 'ioc_limit' },
    tif: ['gtc', 'ioc', 'fok', 'alo'],
    triggerPriceTypes: ['mark'],
    tpsl: { attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' },
    // batch-place-order 未实现：一次只发一张，不声明原子批量。
    batch: { maxOrders: 1, atomic: false },
    amend: 'none',
    cancelAll: 'emulated',
    positionMode: ['oneWay', 'hedge'],
    marginModes: ['cross', 'isolated'],
    accountModels: ['standard'],
    // 名义额下限逐标的（minTradeUSDT），由标的元数据给出，场所级不写死任何数字；
    // 只有调用方显式给了滑点带才声明 rules.marketPriceBandBps。
    ...(opts.marketPriceBandBps !== undefined ? { rules: { marketPriceBandBps: opts.marketPriceBandBps } } : {}),
    signers: {
      type: 'api-key',
      withdrawCapable: false,
      noncePerSigner: false,
    },
    rateLimits: [
      { scope: 'uid', model: 'count', limit: BITGET_QUERY_LIMIT_PER_SEC, windowMs: 1_000, note: 'query endpoints; Gitrader targets <= 60% (12/s)' },
      { scope: 'uid', model: 'count', limit: BITGET_ORDER_LIMIT_PER_SEC, windowMs: 1_000, note: 'order endpoints (place / cancel / modify); separate bucket' },
    ],
    clientOrderId: { format: 'alnum64' },
    history: { maxCandles: MAX_CANDLES, pageLimit: CANDLE_PAGE },
    withdrawPermissionCheck: 'unknown',
    // 提现权限未核验：Bitget API key 可能带提现权，接真网前必须在后台关掉（这里只做事实提示）。
    'x-withdrawPermission': 'not verified; disable withdrawal rights on the API key before any live use',
    'x-data-source': '@gitrader/connector-bitget-data (read-only market)',
    'x-order-endpoints': [
      'POST /api/v2/mix/order/place-order',
      'POST /api/v2/mix/order/place-plan-order',
      'POST /api/v2/mix/order/place-tpsl-order',
      'POST /api/v2/mix/order/cancel-order',
      'POST /api/v2/mix/order/cancel-plan-order',
    ],
  }
}
