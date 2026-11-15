// SPDX-License-Identifier: CPAL-1.0
// Alpaca 美股交易连接器的场所常量。**所有 REST 路径以 Alpaca 官方 Trading API v2 文档为准**
// （QD 的 alpaca_trading/client.py 走 alpaca-py SDK，只有 account activities 一处手写 HTTP，路径要自己核）：
//   · 基址：paper = https://paper-api.alpaca.markets，live = https://api.alpaca.markets
//     （QD alpaca_trading/README.md:27-30「PK* = paper-api / AK* = live」，QD live_trading/factory.py:463 同一对基址）；
//   · 鉴权是**请求头密钥对**，不是 HMAC：`APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`
//     （QD alpaca_trading/client.py:623-627 手写 activities 请求即这两个头）；
//   · 行情参考价走数据 API v2：https://data.alpaca.markets（与交易 API 不同主机、同一对头）。
import type { Ms } from '@gitrader/protocol'

/** 场所 id（`<venue>:<symbol>` 的前半段）。 */
export const VENUE = 'alpaca'
export const VENUE_ID = 'alpaca'

/** 交易环境：Alpaca 只有纸面 / 实盘两套基址（不是 testnet 概念）。 */
export type AlpacaMode = 'paper' | 'live'
export const ALPACA_MODES: readonly AlpacaMode[] = ['paper', 'live']

/** 基址表（QD factory.py:463）。 */
export const TRADING_BASE_URLS: Record<AlpacaMode, string> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
}
/** 数据 API 基址（参考价 / 行情；交易连接器只用来拿价带参考价）。 */
export const DATA_BASE_URL = 'https://data.alpaca.markets'
/** 私有流（trade_updates）地址：paper / live 各一套（官方 streaming 文档）。 */
export const STREAM_URLS: Record<AlpacaMode, string> = {
  paper: 'wss://paper-api.alpaca.markets/stream',
  live: 'wss://api.alpaca.markets/stream',
}

/** 密钥前缀 → 模式（QD README:27-30：`PK` = paper，`AK` = live）。只比前缀，从不打印密钥。 */
export const KEY_PREFIX_MODES: ReadonlyArray<{ prefix: string; mode: AlpacaMode }> = [
  { prefix: 'PK', mode: 'paper' },
  { prefix: 'AK', mode: 'live' },
]

/** 鉴权头名字（不是 HMAC 签名头）。 */
export const AUTH_HEADERS = { keyId: 'APCA-API-KEY-ID', secret: 'APCA-API-SECRET-KEY' } as const

/** 美股时区与三个窗口的边界（ET，`America/New_York`）。常规时段以交易日历为准，这里的 09:30 / 16:00 只是日历缺省。 */
export const MARKET_TZ = 'America/New_York'
export const PRE_MARKET_OPEN = '04:00'
export const REGULAR_OPEN = '09:30'
export const REGULAR_CLOSE = '16:00'
export const POST_MARKET_CLOSE = '20:00'

/** Alpaca Trading API 限频：每个账户每分钟 200 次（官方 rate limit 文档）；我们目标 ≤ 60%。 */
export const REQUESTS_PER_MINUTE = 200
export const TARGET_RATIO = 0.6

/** 默认参考价最大年龄（毫秒）：市价意图要拿它当价带基准。 */
export const DEFAULT_REF_PRICE_MAX_AGE_MS = 5_000
/** 账户限制 / 持仓归属的缓存时长（毫秒）：下单前的账户预检不必每次打上游。 */
export const PREFLIGHT_TTL_MS = 5_000

/** account activities 单页上限（官方 page_size ≤ 100，QD client.py:614）。 */
export const ACTIVITIES_PAGE_SIZE = 100
/** account activities 翻页硬上限（防上游游标不前进）。 */
export const ACTIVITIES_MAX_PAGES = 50

/** 本连接器支持的协议单型（take_* 不在其中：Alpaca 没有独立的止盈单型）。 */
export const SUPPORTED_ORDER_TYPES = ['market', 'limit', 'stop_market', 'stop_limit', 'trailing_stop'] as const
/** 协议 TIF 里能落到 Alpaca 的三种；`alo` / `gtd` 没有对应物。 */
export const SUPPORTED_TIF = ['gtc', 'ioc', 'fok'] as const

/** 美股 T+1 结算；本连接器不做公司行动（拆股 / 分红），见 README。 */
export const SETTLEMENT_NOTE = 'US equities settle T+1; corporate actions (splits / dividends) are out of scope for this connector'

/** 协议里没有的账户限制字段（PDT / 日内次数 / 冻结）——只在本包内上报，不改协议。 */
export const ACCOUNT_RESTRICTION_FIELDS = [
  'trading_blocked', 'account_blocked', 'transfers_blocked', 'pattern_day_trader', 'daytrade_count', 'shorting_enabled',
] as const
export type AccountRestrictionField = (typeof ACCOUNT_RESTRICTION_FIELDS)[number]

/**
 * 诊断用：私有流 / REST 两种成交来源的去重键说明。
 * 官方未说明活动 id 与 execution_id 的对应关系，故用 order_id + 累计成交量。
 */
export const FILL_DEDUPE_NOTE = 'REST and stream fills share the key <order_id>:<cumulative filled qty>; official docs do not map activity ids to execution ids'
export const NOW_SENTINEL: Ms = 0
