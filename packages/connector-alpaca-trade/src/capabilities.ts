// SPDX-License-Identifier: CPAL-1.0
// Alpaca 美股能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分（教训 9 / 八条 #8）：
//   · market = emulated：上游有原生市价单，但 Gitrader 口径要求市价意图必须带 maxSlippageBps 并发
//     「价带限价 + IOC」，所以能力位老实写 emulated（不是 native）；
//   · take_market / take_limit = none：Alpaca 没有独立止盈单型，止盈只能用 bracket / oto 的 take_profit 或限价单；
//   · twap = none；alo / gtd 两种 TIF 没有对应物（只声明 gtc / ioc / fok）；
//   · amend = native，但只对 simple 单成立（带腿的单与市价价带单一律 1004——协议 SupportLevel 表达不了「部分支持」，
//     已在 README / REPORT 写明）；
//   · cancelAll = native：官方 `DELETE /v2/orders`（207 多状态逐行核结果）；
//   · tpsl：attachToOrder = true（原生 bracket / oto），positionLevel = false（协议 grouping='position' 回 1004；
//     placeProtection() 是包内扩展方法，不算协议能力）；父单部分成交时子单继续挂着 → 'keep_children'；
//   · 保证金：账户级 multiplier（Reg T 2 倍），不声明逐仓；没有资金费、没有永续强平价（不是永续）；
//   · 公司行动（拆股 / 分红）不在本批次范围，README 写明。
import type { VenueCapabilities } from '@gitrader/protocol'
import { REQUESTS_PER_MINUTE, TARGET_RATIO, VENUE } from './constants'

export interface CapabilityOptions {
  /** 市价模拟允许的最大滑点带（bps，仅用于声明；实际按 intent.maxSlippageBps）。 */
  marketPriceBandBps?: number
  /** 是否允许盘前盘后（与构造参数 extendedHours 一致）。 */
  extendedHours?: boolean
}

export function alpacaCapabilities(opts: CapabilityOptions = {}): VenueCapabilities {
  return {
    venue: VENUE,
    // paper = testnet（Alpaca 的纸面账户就是另一套基址），live = mainnet。
    environments: ['mainnet', 'testnet'],
    instrumentKinds: ['spot'],
    orderTypes: {
      market: 'emulated',
      limit: 'native',
      stop_market: 'native',
      stop_limit: 'native',
      take_market: 'none',
      take_limit: 'none',
      trailing_stop: 'native',
      twap: 'none',
    },
    marketEmulation: { method: 'ioc_limit' },
    tif: ['gtc', 'ioc', 'fok'],
    triggerPriceTypes: ['last'],
    tpsl: { attachToOrder: true, positionLevel: false, parentPartialCancel: 'keep_children' },
    // 一次一张单（bracket / oto 是同一张父单的原生结构，不是批量）。
    batch: { maxOrders: 1, atomic: false },
    amend: 'native',
    cancelAll: 'native',
    marginModes: ['cross'],
    accountModels: ['standard'],
    signers: {
      type: 'api-key',
      withdrawCapable: false,
      noncePerSigner: false,
    },
    rateLimits: [
      { scope: 'account', model: 'count', limit: REQUESTS_PER_MINUTE, windowMs: 60_000, note: `Trading API requests per minute; Gitrader targets <= ${Math.round(TARGET_RATIO * 100)}%` },
    ],
    clientOrderId: { format: 'alnum48' },
    withdrawPermissionCheck: 'unknown',
    'x-asset-metadata': 'fractionable / shortable / borrow_status / price_increment come from GET /v2/assets/{symbol}',
    'x-sessions': opts.extendedHours === true
      ? 'regular 09:30-16:00 ET from GET /v2/calendar; pre/post limit+day accepted because extendedHours was declared'
      : 'regular 09:30-16:00 ET from GET /v2/calendar; pre/post refused (extendedHours not declared)',
    'x-corrections': 'no funding rate, no perp liquidation price, no corporate-action handling (splits / dividends out of scope)',
    'x-margin': 'margin multiplier is account-level (Reg T 2x); no per-symbol leverage endpoint',
    ...(opts.marketPriceBandBps !== undefined ? { rules: { marketPriceBandBps: opts.marketPriceBandBps } } : {}),
  }
}
