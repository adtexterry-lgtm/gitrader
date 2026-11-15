// SPDX-License-Identifier: CPAL-1.0
// OKX 永续能力声明（契约 §1.5.1）。只声明**本连接器实际实现**的部分：
//   · 订单类型：7 种都真发；market / limit 走 /trade/order，stop / take 走 order-algo 的 conditional，
//     追踪止损走 move_order_stop，两腿保护单走 oco；twap 不声明（OKX 有 twap 算法单，但形态与协议 twap 不一致）；
//   · tpsl.attachToOrder = false：OKX 没有 attach 式父子单，带 tpsl 的 submit 直接返回 1004
//     （成交后由内核调 buildProtectionOrders，两腿合成一条原生 OCO 算法单）；
//   · amend：只有普通 limit 单走 /trade/amend-order；算法单 / 市价单返回 1004。协议只有 native / emulated / none，
//     表达不了「部分支持」——这里声明 native（原生端点真的存在）并在 README 写明限制；
//   · cancelAll：OKX 没有「一次撤掉我全部挂单」的端点（/trade/cancel-all-after 是死人开关计时器），
//     实现是「枚举 + 两个批量端点」→ 声明 emulated；
//   · deadman：/trade/cancel-all-after 的 timeOut（10–120 s）是真实的场所级到点全撤 → 声明 native；
//   · signers.type = 'api-key'（HMAC，不是签名器句柄）；连接器不调用任何提现接口，withdrawCapable = false
//     表示「本连接器不用提现能力」，API key 请勿开提现权限。
import type { VenueCapabilities } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import {
  DEFAULT_TARGET_RATIO, OKX_ACCOUNT_READ_LIMIT, OKX_ORDER_LIMIT_PER_INSTRUMENT, OKX_TRADE_LIMIT, OKX_TRADE_WINDOW_MS,
} from './budget'
import { CANCEL_AFTER_MAX_SEC, CANCEL_AFTER_MIN_SEC } from './trading'
import { SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES, VENUE } from './parse'

export function okxCapabilities(opts: { minOrderNotional?: string } = {}): VenueCapabilities {
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
    ...(opts.minOrderNotional !== undefined ? { rules: { minOrderNotional: asDecimal(opts.minOrderNotional) } } : {}),
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: [...SUPPORTED_TRIGGER_TYPES],
    // OKX 没有 attach 式父子单：attachToOrder 必须是 false，保护单在成交后补挂（可以是原生 OCO）
    tpsl: { attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' },
    batch: { maxOrders: null, atomic: false },
    // 原生 /trade/amend-order，但只对普通 limit 单成立（协议表达不了部分支持，见文件头注释）
    amend: 'native',
    cancelAll: 'emulated',
    deadman: { method: 'cancel_all_after', minDelaySec: CANCEL_AFTER_MIN_SEC, maxTriggersPerDay: 0 },
    positionMode: ['oneWay', 'hedge'],
    marginModes: ['cross', 'isolated'],
    accountModels: ['unified', 'standard'],
    signers: {
      type: 'api-key',
      perAccount: { unnamed: 1, named: 0 },
      maxValidityDays: 0,
      withdrawCapable: false,
      noncePerSigner: false,
    },
    rateLimits: [
      {
        scope: 'account',
        model: 'count',
        limit: OKX_TRADE_LIMIT,
        windowMs: OKX_TRADE_WINDOW_MS,
        note: `trade endpoints; Gitrader targets <= ${Math.round(DEFAULT_TARGET_RATIO * 100)}% of this budget`,
      },
      {
        scope: 'instrument',
        model: 'count',
        limit: OKX_ORDER_LIMIT_PER_INSTRUMENT,
        windowMs: OKX_TRADE_WINDOW_MS,
        note: 'single instId order rate is counted separately from the account bucket',
      },
      {
        scope: 'account',
        model: 'count',
        limit: OKX_ACCOUNT_READ_LIMIT,
        windowMs: OKX_TRADE_WINDOW_MS,
        note: 'balance / positions / config reads',
      },
    ],
    clientOrderId: { format: 'okx-alnum32' },
    history: { maxCandles: 300, pageLimit: 100 },
    withdrawPermissionCheck: 'not_applicable',
    'x-orderTypes': SUPPORTED_ORDER_TYPES,
    'x-orderChannels': {
      order: ['limit', 'post_only', 'ioc', 'fok'],
      'order-algo': ['conditional', 'oco', 'move_order_stop'],
    },
    'x-tpslModel': 'post-fill reduce-only protection: one native OCO algo order (see buildProtectionOrders)',
    'x-deadman': `POST /api/v5/trade/cancel-all-after timeOut ${CANCEL_AFTER_MIN_SEC}-${CANCEL_AFTER_MAX_SEC}s (0 disarms)`,
    'x-settleFilter': 'SWAP with settleCcy USDT or USDC only (parsing reused from @gitrader/connector-okx-data)',
  }
}
