// SPDX-License-Identifier: CPAL-1.0
// 能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分（工单教训 9）：
//   · market = emulated：dYdX 没有「市价单」这一种消息，市价必须做「价带限价 + IOC」（trailing 参考 HL 包口径）；
//   · limit / stop_* / take_* = native：limit 走 Order + TIF；stop / take 走 condition_type + 触发 subticks；
//   · trailing_stop / twap = none：proto 里有 twap_parameters，但本包不构造 TWAP，明确回 1004；
//   · tif 只有 gtc / ioc / alo(post-only)：proto 的 FILL_OR_KILL 官方标 deprecated，不声明；
//   · triggerPriceTypes 只有 mark：dYdX 条件单按**预言机价**触发（order.proto condition_type 注释），不支持 last/index；
//   · amend = none：链上没有改单消息，只能撤单 + 下单（内核侧按新单处理）；
//   · cancelAll = emulated：逐单发 MsgCancelOrder（scoped 版本只撤指定标的的挂单）；
//   · marginModes 只有 cross：MsgUpdateLeverage 未接线，setLeverage 回 1004；
//   · batch.maxOrders = 1：一次交易只放一条消息（多消息同 tx 未经真网验证）；
//   · signers.type = chain-key：签名者是链上账户私钥（可用 dYdX 的 API key / authenticator 指向主账户，但本包未接 authenticator 流程）。
import type { VenueCapabilities } from '@gitrader/protocol'
import { DEFAULT_MARKET_BAND_BPS, INDEXER_RATE_LIMIT, INDEXER_RATE_WINDOW_MS, VENUE } from './constants'

export interface CapabilityOptions {
  /** 声明用的市价价带（bps）；实际发单按 intent.maxSlippageBps。 */
  marketPriceBandBps?: number
  /** 是否允许测试网（默认 true；连接器两侧都支持）。 */
  testnet?: boolean
}

export function dydxTradeCapabilities(o: CapabilityOptions = {}): VenueCapabilities {
  return {
    venue: VENUE,
    environments: o.testnet === false ? ['mainnet'] : ['mainnet', 'testnet'],
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
    rules: { marketPriceBandBps: o.marketPriceBandBps ?? DEFAULT_MARKET_BAND_BPS },
    marketEmulation: { method: 'ioc_limit' },
    tif: ['gtc', 'ioc', 'alo'],
    triggerPriceTypes: ['mark'],
    tpsl: { attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' },
    batch: { maxOrders: 1, atomic: false },
    amend: 'none',
    cancelAll: 'emulated',
    positionMode: ['oneWay'],
    marginModes: ['cross'],
    accountModels: ['standard'],
    signers: {
      type: 'chain-key',
      withdrawCapable: false,
      noncePerSigner: true,
    },
    rateLimits: [
      {
        scope: 'ip',
        model: 'count',
        limit: INDEXER_RATE_LIMIT,
        windowMs: INDEXER_RATE_WINDOW_MS,
        note: 'Indexer REST per IP (docs.dydx.xyz/concepts/trading/limits/rate-limits)',
      },
      {
        scope: 'account',
        model: 'count',
        limit: 4000,
        windowMs: 25_000,
        note: 'chain block rate limit: short-term orders + cancels 4000 / 5 blocks (~25 s at 1 s blocks)',
      },
      {
        scope: 'account',
        model: 'count',
        limit: 2,
        windowMs: 1000,
        note: 'chain block rate limit: stateful orders 2 / block and 20 / 100 blocks (the tighter one is enforced per block)',
      },
    ],
    clientOrderId: { format: 'hex128' },
    withdrawPermissionCheck: 'not_applicable',
    'x-signing': 'secp256k1 ECDSA over sha256(SignDoc), 64-byte r||s, SIGN_MODE_DIRECT; Node built-in crypto only',
    'x-order-endpoints': [
      'POST /cosmos/tx/v1beta1/txs (MsgPlaceOrder / MsgCancelOrder)',
      'GET /cosmos/auth/v1beta1/accounts/{address}',
      'GET /cosmos/base/tendermint/v1beta1/blocks/latest',
      'GET /v4/addresses/{address}/subaccountNumber/{n}',
      'GET /v4/perpetualPositions?address=&subaccountNumber=&status=OPEN',
      'GET /v4/orders?address=&subaccountNumber=&status=OPEN',
      'GET /v4/fills?address=&subaccountNumber=&limit=',
      'GET /v4/perpetualMarkets',
    ],
    'x-order-flags': { shortTerm: 0, conditional: 32, longTerm: 64, twap: 128 },
    'x-fee': 'short-term orders are broadcast with an empty fee (gas 0); stateful orders require an explicit fee config',
    'x-unverified': 'not verified against a real network; do not use for live trading',
  }
}
