// SPDX-License-Identifier: CPAL-1.0
// 标的元数据：`GET /v2/assets/{symbol_or_asset_id}`（官方 Trading API v2，字段见官方 Assets 文档）。
// QD 的 alpaca_trading/symbols.py 只做符号归一（`BRK/B` → `BRK.B`，`BTC/USDT` → `BTC/USD`），不取资产属性；
// 本连接器要的美股三件事只有资产端点有：**fractionable**（碎股）、**shortable / borrow_status**（做空）、price_increment（tick）。
// 官方 changelog（2026-07-16 条）：`easy_to_borrow` → `borrow_status`（easy_to_borrow | hard_to_borrow），
// `maintenance_margin_requirement` → `margin_requirement_long / _short`，旧字段 2026-09-22 移除；旧字段只作回落。
// 证券类型的协议口径（工单「协议是唯一标准」）：
//   kind:'spot' / assetClass:'stocks' / quote:'USD' / settle:'USD' / venueSizeUnit:'base' / contractSize:'1'。
import { asDecimal } from '@gitrader/protocol'
import type { Instrument, OrderType, TimeInForce, TradingSessionWindow } from '@gitrader/protocol'
import { SETTLEMENT_NOTE, VENUE } from './constants'
import { DEFAULT_TICK, FRACTIONAL_STEP, WHOLE_SHARE_STEP, decimalsOf } from './precision'
import type { TradingCalendar } from './sessions'
import { buildSessions } from './sessions'

/** 资产 + 本连接器要用的派生字段。 */
export interface AssetRecord {
  symbol: string
  assetId: string
  name: string
  exchange: string
  /** Alpaca `class`（us_equity / crypto / us_option…）；本连接器只收 us_equity。 */
  assetClass: string
  status: string
  tradable: boolean
  marginable: boolean
  /** 可做空（美股八条第 5 条）。 */
  shortable: boolean
  /** 借券状态：`borrow_status` 优先、旧 `easy_to_borrow` 回落；拿不到或值不认识 = 'unknown'。 */
  borrowStatus: 'easy_to_borrow' | 'hard_to_borrow' | 'unknown'
  /** 易借券（做空成本低的那一档）：只有 borrowStatus 明确为 easy_to_borrow 才为 true（未知不放行开空）。 */
  easyToBorrow: boolean
  /** 可碎股（美股八条第 4 条）。 */
  fractionable: boolean
  tick: string
  step: string
  minSize: string
  /** 多头 / 空头保证金要求百分比（官方十进制字符串）；缺 = 不可得。 */
  marginRequirementLong?: string
  marginRequirementShort?: string
  /** 旧字段回落（2026-09-22 起官方移除）。 */
  maintenanceMarginRequirement?: number
  instrument: Instrument
}

/** 本连接器支持的证券类（Alpaca `class`）。加密 / 期权不在本批次范围。 */
export const SUPPORTED_ASSET_CLASSES = ['us_equity'] as const

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
const bool = (v: unknown): boolean => v === true || v === 'true'
const decStr = (v: unknown): string | undefined => {
  const s = str(v).trim()
  return s !== '' && Number.isFinite(Number(s)) ? s : undefined
}

/** borrow_status 优先；有值但不认识 → unknown（不回落旧字段）；没有 → 旧布尔 easy_to_borrow；都没有 → unknown。 */
export function borrowStatusOf(row: Record<string, unknown>): AssetRecord['borrowStatus'] {
  const raw = row['borrow_status']
  if (raw !== undefined && raw !== null) {
    const s = str(raw).trim().toLowerCase()
    return s === 'easy_to_borrow' || s === 'hard_to_borrow' ? s : 'unknown'
  }
  const legacy = row['easy_to_borrow']
  if (legacy === true || legacy === 'true') return 'easy_to_borrow'
  if (legacy === false || legacy === 'false') return 'hard_to_borrow'
  return 'unknown'
}

export interface ParseAssetContext {
  /** 交易日历（生成 sessions）；没有就传空日历（sessions 退化为周一至周五三段）。 */
  calendar?: TradingCalendar
  /** 资产拉取时刻。 */
  now: number
}

/** Alpaca 资产 JSON → AssetRecord；缺关键字段直接抛（不猜，教训 8 同口径）。 */
export function parseAsset(payload: unknown, ctx: ParseAssetContext): AssetRecord {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('alpaca asset response is not an object')
  }
  const row = payload as Record<string, unknown>
  const symbol = str(row['symbol']).trim().toUpperCase()
  if (symbol === '') throw new TypeError('alpaca asset has no symbol')
  const klass = str(row['class']).trim().toLowerCase()
  if (klass !== '' && !(SUPPORTED_ASSET_CLASSES as readonly string[]).includes(klass)) {
    throw new TypeError(`alpaca asset ${symbol} has unsupported class ${klass} (this connector only trades us_equity)`)
  }
  const fractionable = bool(row['fractionable'])
  const tick = str(row['price_increment']).trim() === '' ? DEFAULT_TICK : str(row['price_increment']).trim()
  const step = fractionable
    ? (str(row['min_trade_increment']).trim() === '' ? FRACTIONAL_STEP : str(row['min_trade_increment']).trim())
    : WHOLE_SHARE_STEP
  const minSize = str(row['min_order_size']).trim() === ''
    ? (fractionable ? FRACTIONAL_STEP : WHOLE_SHARE_STEP)
    : str(row['min_order_size']).trim()
  const tradable = bool(row['tradable'])
  const status = str(row['status']).trim().toLowerCase()
  const borrowStatus = borrowStatusOf(row)
  const marginRequirementLong = decStr(row['margin_requirement_long'])
  const marginRequirementShort = decStr(row['margin_requirement_short'])
  const calendar = ctx.calendar
  const sessions = calendar === undefined ? undefined : buildSessions(calendar)
  const orderTypes: OrderType[] = ['market', 'limit', 'stop_market', 'stop_limit', 'trailing_stop']
  const tif: TimeInForce[] = ['gtc', 'ioc', 'fok']
  const record: AssetRecord = {
    symbol,
    assetId: str(row['id']),
    name: str(row['name']),
    exchange: str(row['exchange']),
    assetClass: klass === '' ? 'us_equity' : klass,
    status,
    tradable,
    marginable: bool(row['marginable']),
    shortable: bool(row['shortable']),
    borrowStatus,
    easyToBorrow: borrowStatus === 'easy_to_borrow',
    fractionable,
    tick,
    step,
    minSize,
    ...(marginRequirementLong !== undefined ? { marginRequirementLong } : {}),
    ...(marginRequirementShort !== undefined ? { marginRequirementShort } : {}),
    ...(num(row['maintenance_margin_requirement']) !== undefined
      ? { maintenanceMarginRequirement: num(row['maintenance_margin_requirement'])! }
      : {}),
    instrument: {
      instrumentId: `${VENUE}:${symbol}`,
      venue: VENUE,
      symbol,
      displaySymbol: symbol,
      kind: 'spot',
      base: symbol,
      quote: 'USD',
      settle: 'USD',
      settlement: 'linear',
      contractSize: asDecimal('1'),
      venueSizeUnit: 'base',
      assetClass: 'stocks',
      marketGroup: 'us_equity',
      status: !tradable ? (status === 'inactive' ? 'delisted' : 'halted') : 'trading',
      price: { tick: asDecimal(tick) },
      size: { step: asDecimal(step), decimals: decimalsOf(step), min: asDecimal(minSize) },
      // 现金账户 1 倍、保证金账户按 Reg T 初始保证金 50% = 2 倍（美股八条第 8 条：杠杆按保证金倍数如实报）。
      maxLeverage: bool(row['marginable']) ? 2 : 1,
      marginModes: ['cross'],
      orderTypes,
      tif,
      triggerPriceTypes: ['last'],
      // 美股零佣金（Alpaca 官方；卖单的 SEC / TAF 规费不在本连接器计费范围，见 README）。
      fees: { maker: asDecimal('0'), taker: asDecimal('0'), source: 'venue' },
      ...(sessions !== undefined ? { sessions } : {}),
      updatedAt: ctx.now,
    },
  }
  return record
}

/** 资产数组（`GET /v2/assets?status=active&asset_class=us_equity`）→ 记录表；坏行跳过（列表容忍，单张查询不容忍）。 */
export function parseAssetList(payload: unknown, ctx: ParseAssetContext): AssetRecord[] {
  if (!Array.isArray(payload)) throw new TypeError('alpaca asset list is not an array')
  const out: AssetRecord[] = []
  for (const raw of payload) {
    try {
      out.push(parseAsset(raw, ctx))
    } catch {
      // 列表里的单行坏了就跳过：整个列表失败会让「未知标的」变成「全部标的未知」。
    }
  }
  return out
}

/** 符号归一（照 QD alpaca_trading/symbols.py 的口径）：`BRK/B` → `BRK.B`，去空白、转大写。 */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/\//g, '.')
}

/** `alpaca:AAPL` → `AAPL`；不是本场所的 id 就抛。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  if (i <= 0 || i === instrumentId.length - 1) throw new TypeError(`invalid instrumentId: ${JSON.stringify(instrumentId)}`)
  const venue = instrumentId.slice(0, i)
  if (venue !== VENUE) throw new TypeError(`instrument ${instrumentId} is not an ${VENUE} instrument`)
  return instrumentId.slice(i + 1)
}

/** 诊断：一句话说明为什么这个标的不收单（README / 测试断言用）。 */
export function assetNotes(record: AssetRecord): string[] {
  return [
    `fractionable=${record.fractionable}`,
    `shortable=${record.shortable}`,
    `borrow_status=${record.borrowStatus}`,
    `margin_requirement_long=${record.marginRequirementLong ?? 'unavailable'}`,
    `marginable=${record.marginable}`,
    SETTLEMENT_NOTE,
    `sessions=${record.instrument.sessions?.windows.length ?? 0} windows`,
  ]
}

/** 会话窗口（诊断 / 测试断言；Instrument.sessions 是只读快照）。 */
export function sessionWindows(record: AssetRecord): TradingSessionWindow[] {
  return record.instrument.sessions?.windows ?? []
}
