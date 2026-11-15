// SPDX-License-Identifier: CPAL-1.0
// 离线假 Alpaca REST：进程内按主机 + 路径回答（交易主机 /v2/assets、/v2/calendar、/v2/clock；
// 数据主机 /v2/stocks/{symbol}/bars、/snapshot），不开端口、不联网、不读夹具文件。
// 夹具为手写（本机离线，未取真网响应）：字段名与形状照 Alpaca 官方文档，数值是占位。
export const TRADING_HOST = 'alpaca.example.test'
export const DATA_HOST = 'alpaca.example.test.data'

/** 固定「现在」：2026-10-21 14:00:00Z = 纽约 10:00（周三，常规时段内）。 */
export const FX_NOW = Date.parse('2026-10-21T14:00:00Z')
export const FX_CLOCK = {
  timestamp: '2026-10-21T14:00:05.123456789Z',
  is_open: true,
  next_open: '2026-10-22T13:30:00Z',
  next_close: '2026-10-21T20:00:00Z',
}

/** 交易日历：2026-10-01…2026-12-31 的工作日，去掉节假日，含一个提前收盘日。 */
export const HOLIDAYS = ['2026-11-26', '2026-12-25']
export const EARLY_CLOSE: Record<string, string> = { '2026-11-27': '13:00' }

export function calendarRows(): Array<{ date: string; open: string; close: string }> {
  const rows: Array<{ date: string; open: string; close: string }> = []
  const start = Date.UTC(2026, 9, 1)
  for (let i = 0; i < 92; i++) {
    const d = new Date(start + i * 86_400_000)
    const weekday = d.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    if (HOLIDAYS.includes(date)) continue
    rows.push({ date, open: '09:30', close: EARLY_CLOSE[date] ?? '16:00' })
  }
  return rows
}

/** 一条 us_equity 资产（AAPL 形状；over 覆盖单字段）。 */
export function assetEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
    class: 'us_equity',
    exchange: 'NASDAQ',
    symbol: 'AAPL',
    name: 'Apple Inc. Common Stock',
    status: 'active',
    tradable: true,
    marginable: true,
    shortable: true,
    // 官方现行 asset schema（easy_to_borrow / maintenance_margin_requirement 已于 2026-09-22 移除）
    borrow_status: 'easy_to_borrow',
    fractionable: true,
    margin_requirement_long: '30',
    margin_requirement_short: '30',
    ...over,
  }
}

/** 一根 bar（Alpaca 原样字段：t 是带纳秒的 ISO-8601 UTC）。 */
export function barRow(iso: string, price = 200): Record<string, unknown> {
  return {
    t: iso,
    o: price,
    h: price + 1.5,
    l: price - 1.5,
    c: price + 0.5,
    v: 12_345,
    n: 42,
    vw: price + 0.25,
  }
}

/** 从 fromIso 起每 stepMs 一根，共 count 根（升序）。 */
export function barSeries(fromIso: string, count: number, stepMs = 60_000, price = 200): Record<string, unknown>[] {
  const from = Date.parse(fromIso)
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) out.push(barRow(new Date(from + i * stepMs).toISOString(), price + i))
  return out
}

export interface RawCall {
  host: string
  path: string
  url: string
  params: URLSearchParams
  headers: Record<string, string>
}

export class FakeAlpaca {
  calls: RawCall[] = []
  assets: unknown[] = [
    assetEntry(),
    assetEntry({ id: 'x2', symbol: 'MSFT', exchange: 'NASDAQ', name: 'Microsoft Corporation Common Stock', fractionable: false, shortable: false, borrow_status: 'hard_to_borrow' }),
    assetEntry({ id: 'x3', symbol: 'BRK.B', exchange: 'NYSE', name: 'Berkshire Hathaway Inc. Class B', fractionable: false }),
    assetEntry({ id: 'x4', symbol: 'OLD', exchange: 'NYSE', name: 'Delisted Co', status: 'inactive', tradable: false }),
    assetEntry({ id: 'x5', symbol: 'HALT', exchange: 'NYSE', name: 'Halted Co', tradable: false }),
    { id: 'x6', class: 'crypto', exchange: 'CRYPTO', symbol: 'BTC/USD', name: 'Bitcoin', status: 'active', tradable: true, fractionable: true },
  ]
  /** /v2/calendar：数组或按参数过滤（缺省按日历夹具过滤）。 */
  calendar: unknown = (params: URLSearchParams) => {
    const start = params.get('start') ?? ''
    const end = params.get('end') ?? ''
    return calendarRows().filter((r) => (start === '' || r.date >= start) && (end === '' || r.date <= end))
  }
  clock: unknown = FX_CLOCK
  /** /v2/stocks/{symbol}/bars：数组或按参数生成。缺省 5 根 1 分钟线，sort=desc 时倒序回。 */
  bars: unknown = (params: URLSearchParams) => {
    const rows = barSeries('2026-10-21T13:30:00Z', 5)
    return params.get('sort') === 'desc' ? [...rows].reverse() : rows
  }
  snapshot: unknown = {
    latestQuote: { t: '2026-10-21T13:59:58.123456789Z', ax: 'V', ap: 202.55, as: 300, bx: 'V', bp: 202.5, bs: 200, c: ['R'], z: 'C' },
    latestTrade: { t: '2026-10-21T13:59:59.5Z', p: 202.52, s: 100, x: 'V', c: ['@'], z: 'C' },
    minuteBar: { t: '2026-10-21T13:59:00Z', o: 202.4, h: 202.6, l: 202.3, c: 202.52, v: 1_000, vw: 202.45 },
    dailyBar: { t: '2026-10-21T04:00:00Z', o: 201, h: 203, l: 200.5, c: 202.52, v: 5_000_000, vw: 201.8 },
    prevDailyBar: { t: '2026-10-20T04:00:00Z', o: 199, h: 202, l: 198, c: 201.05, v: 4_800_000, vw: 200.1 },
  }
  /** `host + path` → 强制响应（Response 原样返回，其它对象包成 200 JSON）。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const params = url.searchParams
    const headers: Record<string, string> = {}
    const raw = init?.headers
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v
    }
    this.calls.push({ host: url.hostname, path: url.pathname, url: url.toString(), params, headers })
    const key = `${url.hostname}${url.pathname}`
    const forced = this.override.get(key)
    if (forced) {
      const out = forced(params)
      return out instanceof Response ? out : json(out)
    }
    const pick = (v: unknown): unknown => (typeof v === 'function' ? (v as (p: URLSearchParams) => unknown)(params) : v)
    if (url.hostname === TRADING_HOST) {
      if (url.pathname === '/v2/assets') return json(this.assets)
      if (url.pathname === '/v2/calendar') return json(pick(this.calendar))
      if (url.pathname === '/v2/clock') return json(pick(this.clock))
      return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
    if (url.hostname === DATA_HOST) {
      if (url.pathname.endsWith('/bars')) {
        const picked = pick(this.bars)
        // 允许夹具直接给 { bars, next_page_token }（翻页用例）；裸数组则补一个空的 next_page_token
        if (picked !== null && typeof picked === 'object' && !Array.isArray(picked)) return json(picked)
        return json({ bars: picked, symbol: symbolOfPath(url.pathname), next_page_token: null })
      }
      if (url.pathname.endsWith('/snapshot')) return json(pick(this.snapshot))
      return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
    return new Response(`unknown host ${url.hostname}`, { status: 404 })
  }

  callsTo(host: string, path: string): RawCall[] {
    return this.calls.filter((c) => c.host === host && c.path === path)
  }
}

function symbolOfPath(path: string): string {
  const m = /\/v2\/stocks\/([^/]+)\//.exec(path)
  return m ? decodeURIComponent(m[1]!) : ''
}

/** Alpaca 成功响应就是 200 + JSON（数组端点直接给裸数组）。 */
export const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** 轮询等待（真实定时器，离线；不依赖 fake timers）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
