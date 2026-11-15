// SPDX-License-Identifier: CPAL-1.0
// Gate.io USDT 永续能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分（工单教训 9）：
//   · market = emulated：上游有原生市价单（price:"0" + tif:ioc），但 Gitrader 口径要求市价意图必须带
//     maxSlippageBps 并发「价带限价 + ioc」，所以能力位老实写 emulated + marketEmulation.ioc_limit；
//   · stop / take 四类 = native：走 POST /api/v4/futures/usdt/price_orders（QD native_protection.py:273-322）；
//     trailing_stop / twap 仍 none（QD 的 Gate 追踪是 `managed_by: strategy_runtime`，不是原生）；
//   · amend = none：QD 没有 amend 实现，本连接器 amend() 回 1004；
//   · tpsl.attachToOrder = false、positionLevel = false：不做父子单，触发单要单独提交；
//   · cancelAll = native：Gate 按合约全撤（DELETE /orders?contract= 与 DELETE /price_orders?contract=）；
//   · 保证金模式 cross / isolated 都支持：下单绝不切模式，显式 setLeverage 才切；
//   · clientOrderId = hex128（32 位小写十六进制），发出去时编成 `t-` + base64url(16 字节)；
//   · 单向持仓 only：dual / dual_plus 账户在 submit / setLeverage 时回 5002（不猜双仓字段）；
//   · 死人开关未实现：Gate 有 POST /futures/{settle}/countdown_cancel_all，但 QD 未用，本包不声明。
import type { VenueCapabilities } from '@gitrader/protocol'
import { GATE_ORDER_LIMIT_PER_SEC, GATE_ORDER_WINDOW_MS, GATE_QUERY_LIMIT, GATE_QUERY_WINDOW_MS } from './budget'
import { CANDLE_PAGE, MAX_CANDLES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES, VENUE } from './parse'

export interface CapabilityOptions {
  /** 市价模拟允许的最大滑点带（bps，仅用于声明；实际按 intent.maxSlippageBps）。 */
  marketPriceBandBps?: number
  /** 场所的最小下单额；Gate 永续按张数下限，没有统一名义额下限，缺省不声明。 */
  minOrderNotional?: string
  supportDeveloper?: boolean
}

export function gateioCapabilities(opts: CapabilityOptions = {}): VenueCapabilities {
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
    tpsl: { attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' },
    // 一次只发一张，不声明原子批量。
    batch: { maxOrders: 1, atomic: false },
    amend: 'none',
    cancelAll: 'native',
    positionMode: ['oneWay'],
    marginModes: ['cross', 'isolated'],
    accountModels: ['standard'],
    ...(opts.marketPriceBandBps !== undefined || opts.minOrderNotional !== undefined
      ? {
          rules: {
            ...(opts.marketPriceBandBps !== undefined ? { marketPriceBandBps: opts.marketPriceBandBps } : {}),
            ...(opts.minOrderNotional !== undefined ? { minOrderNotional: opts.minOrderNotional as never } : {}),
          },
        }
      : {}),
    signers: {
      type: 'api-key',
      withdrawCapable: false,
      noncePerSigner: false,
    },
    rateLimits: [
      {
        scope: 'ip',
        model: 'weight',
        limit: GATE_QUERY_LIMIT,
        windowMs: GATE_QUERY_WINDOW_MS,
        note: 'public + private query endpoint budget (data connector口径); Gitrader targets <= 60% (120 / 10 s)',
      },
      {
        scope: 'uid',
        model: 'count',
        limit: GATE_ORDER_LIMIT_PER_SEC,
        windowMs: GATE_ORDER_WINDOW_MS,
        note: 'local cap for order endpoints (10 / 1 s sliding window); Gate does not publish one unified weight table',
      },
    ],
    clientOrderId: { format: 'hex128' },
    history: { maxCandles: MAX_CANDLES, pageLimit: CANDLE_PAGE },
    withdrawPermissionCheck: 'unknown',
    // 提现权限未核验：Gate 的 API key 可以勾提现权，接真网前必须在后台关掉（这里只做事实提示）。
    'x-withdrawPermission': 'not verified; disable withdrawal rights on the API key before any live use',
    'x-data-source': '@gitrader/connector-gateio-data (read-only market)',
    'x-order-endpoints': [
      'POST /api/v4/futures/usdt/orders',
      'DELETE /api/v4/futures/usdt/orders/{order_id}',
      'GET /api/v4/futures/usdt/orders/{order_id}',
      'GET /api/v4/futures/usdt/orders?status=open',
      'DELETE /api/v4/futures/usdt/orders?contract=',
      'POST /api/v4/futures/usdt/price_orders',
      'GET /api/v4/futures/usdt/price_orders',
      'DELETE /api/v4/futures/usdt/price_orders',
      'GET /api/v4/futures/usdt/price_orders/{id}',
      'DELETE /api/v4/futures/usdt/price_orders/{id}',
      'GET /api/v4/futures/usdt/positions',
      'GET /api/v4/futures/usdt/positions/{contract}',
      'GET /api/v4/futures/usdt/accounts',
      'GET /api/v4/futures/usdt/my_trades',
      'GET /api/v4/futures/usdt/account_book',
      'GET /api/v4/futures/usdt/contracts/{contract}',
      'POST /api/v4/futures/usdt/positions/{contract}/leverage',
    ],
    'x-clientOrderIdEncoding': 't- + base64url(16 bytes), 24 chars (Gate text allows 28 after t-)',
    'x-triggerOrders': 'POST /api/v4/futures/usdt/price_orders (QD native_protection.py:273-322); price orders carry no client id, 3006 is reconciled by in-process fingerprint only',
    'x-deadman': 'not implemented (Gate has POST /futures/{settle}/countdown_cancel_all; QD does not use it)',
    'x-supportDeveloper': opts.supportDeveloper === true,
  }
}
