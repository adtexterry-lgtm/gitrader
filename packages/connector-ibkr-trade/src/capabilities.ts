// SPDX-License-Identifier: CPAL-1.0
// IBKR 能力声明（契约 §1.5.1）。只声明本连接器**实际实现**的部分（工单教训 9 / 八条 8）：做不到的写 none 并回 1004。
//   · market = emulated：IB 有原生 MKT 单，但 Gitrader 口径要求市价意图必须带 maxSlippageBps 并发「价带限价 + IOC」，
//     所以能力位写 emulated + marketEmulation.ioc_limit；
//   · take_market / take_limit / twap = none：IB 现金股票没有原生止盈单型（止盈只能作为 bracket 的限价子单）；
//   · amend = none：IB 没有原生改单，撤旧挂新会换 orderId（内核按原 clientOrderId 追踪会断）；
//   · cancelAll = emulated：逐张走 cancel()；其它 clientId 的单不能代撤；
//   · tpsl.attachToOrder = true（父 + 止盈 LMT + 止损 STP，parentId 关联，最后一张 transmit）、positionLevel = false；
//   · deadman 不声明：IB 没有定时全撤（reqGlobalCancel 是立即全撤，不是死人开关）；
//   · 不声明杠杆：现金股票账户没有按单杠杆（八条 8「杠杆按账户保证金倍数如实报」——由账户摘要的 Leverage 反映）。
import { asDecimal } from '@gitrader/protocol'
import type { VenueCapabilities } from '@gitrader/protocol'
import { SUPPORTED_ORDER_TYPES, SUPPORTED_TIF } from './contracts'
import { VENUE } from './ids'
import { API_VERSION } from './wire'

export interface CapabilityOptions {
  /** 声明用的市价价带上限（bps）；实际按 intent.maxSlippageBps（缺省拒单）。 */
  marketPriceBandBps?: number
  /** 是否声明按合约最小名义额；IB 没有统一门槛，缺省不声明。 */
  minOrderNotional?: string
  /** 是否允许盘前盘后（八条 2：显式声明才允许，且只限 DAY 限价）。 */
  extendedHours?: boolean
}

export function ibkrCapabilities(o: CapabilityOptions = {}): VenueCapabilities {
  const orderTypes: VenueCapabilities['orderTypes'] = {
    market: 'emulated',
    limit: 'native',
    stop_market: 'native',
    stop_limit: 'native',
    trailing_stop: 'native',
    take_market: 'none',
    take_limit: 'none',
    twap: 'none',
  }
  return {
    venue: VENUE,
    environments: ['testnet', 'mainnet'],
    instrumentKinds: ['spot'],
    orderTypes,
    rules: {
      ...(o.marketPriceBandBps !== undefined ? { marketPriceBandBps: o.marketPriceBandBps } : {}),
      ...(o.minOrderNotional !== undefined ? { minOrderNotional: asDecimal(o.minOrderNotional) } : {}),
    },
    marketEmulation: { method: 'ioc_limit' },
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: ['last'],
    tpsl: { attachToOrder: true, positionLevel: false, parentPartialCancel: 'cancel_children' },
    batch: { maxOrders: null, atomic: false },
    amend: 'none',
    cancelAll: 'emulated',
    positionMode: ['oneWay'],
    marginModes: ['cross'],
    accountModels: ['standard'],
    signers: {
      type: 'gateway-session',
      maxValidityDays: 1,
      withdrawCapable: false,
      perAccount: { unnamed: 1, named: 0 },
    },
    rateLimits: [{ scope: 'connection', model: 'count', limit: 45, windowMs: 1000, note: 'IB API 每秒 50 条消息上限，本包本地限到 45' }],
    clientOrderId: { format: 'orderRef:[A-Za-z0-9._:-]{1,56}' },
    history: { maxCandles: 0, pageLimit: 0 },
    withdrawPermissionCheck: 'not_applicable',
    'x-ibkr': {
      supportedOrderTypes: [...SUPPORTED_ORDER_TYPES],
      socketApi: { apiVersion: API_VERSION, loopbackOnly: true },
      extendedHours: o.extendedHours === true ? 'limit_day_only' : 'refused',
      notes: [
        'cancelAll only cancels orders placed by this session clientId; orders from other clientIds (or TWS clientId 0) must be cancelled by their owner',
        'no candles / L2 / bookSnapshot: only snapshot quotes for the market-order price band',
        'no corporate actions (splits / dividends) in this build',
      ],
    },
  }
}
