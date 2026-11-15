// SPDX-License-Identifier: CPAL-1.0
// 回测—纸面一致性测试台：两侧运行记录的规范形（schema gitrader-parity-run/1）。
// 只做「已存在的公开接口产物」之间的归一，不驱动内核、不改内核。
//
// 归一来源（都是现有公开产物，只读）：
//   · 回测侧：GEP `backtest.result` 的 BacktestResult（packages/protocol/src/gep/backtest.ts:64）。
//   · 纸面侧：PaperVenue.exportState() 落的 ~/.gitrader/paper-state.json（packages/venue-paper/src/venue.ts:986）。
// 两侧字段不同名不同单位，这里统一成：金额/数量用 number（分析级），时间用 Unix ms，订单/成交按时间序。

export const PARITY_SCHEMA = 'gitrader-parity-run/1'

/** 协议 Fx 的定点标度（packages/protocol/src/decimal.ts:8 SCALE = 18）。 */
export const FX_SCALE = 18n
const FX_ONE = 10n ** FX_SCALE

/** 把协议定点大整数（bigint / {$b} 串 / 十进制串 / number）换成 number；无法识别时返回 null。 */
export function fxToNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'bigint') return Number(v) / Number(FX_ONE)
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  if (v && typeof v === 'object' && typeof v.$b === 'string') {
    let raw
    try { raw = BigInt(v.$b) } catch { return null }
    const neg = raw < 0n
    const abs = neg ? -raw : raw
    const dec = abs / FX_ONE
    const frac = abs % FX_ONE
    const text = `${dec}.${frac.toString().padStart(18, '0')}`
    const n = Number(neg ? `-${text}` : text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const num = (v) => {
  const n = typeof v === 'number' ? v : fxToNumber(v)
  return n === null ? null : n
}

/** 空运行记录骨架。 */
export function emptyRun(side, meta = {}) {
  return {
    schema: PARITY_SCHEMA,
    side,
    runId: meta.runId ?? '',
    instrument: meta.instrument ?? '',
    interval: meta.interval ?? '',
    source: meta.source ?? { kind: 'unknown' },
    clock: meta.clock ?? { mode: 'unknown', start: null, end: null },
    capabilities: { orders: false, fills: false, equity: false, equityCurve: false },
    orders: [],
    fills: [],
    equity: [],
    finalEquity: null,
    notes: [],
  }
}

/**
 * 回测侧：BacktestResult → 规范形。
 * 已知不对称（如实写进 notes，不假装）：回测模拟器只产出成交（trades），没有订单对象，
 * 所以 capabilities.orders = false —— 订单序列这一栏在这个测试台上是「无法核对」，不是「一致」。
 */
export function fromBacktestResult(result, meta = {}) {
  if (!result || typeof result !== 'object') throw new TypeError('backtest result must be an object')
  const equity = Array.isArray(result.equity) ? result.equity.map((p) => ({ t: num(p.t), v: num(p.v) })).filter((p) => p.t !== null && p.v !== null) : []
  const fills = Array.isArray(result.trades)
    ? result.trades.map((tr, i) => ({
      seq: i + 1,
      ts: num(tr.t),
      side: tr.side === 'sell' ? 'sell' : 'buy',
      price: num(tr.price),
      size: num(tr.size),
      fee: num(tr.fee) ?? 0,
      realizedPnl: num(tr.pnl) ?? 0,
      orderRef: null,
      fillId: `bt-${String(i + 1).padStart(6, '0')}`,
      reason: typeof tr.reason === 'string' ? tr.reason : '',
    })).filter((f) => f.ts !== null && f.price !== null && f.size !== null)
    : []
  const finalEquity = num(result.stats?.finalEquity) ?? (equity.length > 0 ? equity[equity.length - 1].v : null)
  const run = emptyRun('backtest', {
    ...meta,
    source: {
      kind: 'gep-backtest',
      engine: result.engine ?? null,
      jobId: result.jobId ?? null,
      specDigest: result.specDigest ?? null,
      dataDigest: result.dataDigest ?? null,
      fillModel: result.assumptions?.fillModel ?? null,
    },
  })
  run.capabilities = { orders: false, fills: true, equity: true, equityCurve: equity.length > 0 }
  run.clock = {
    mode: 'event-time',
    start: equity.length > 0 ? equity[0].t : (fills[0]?.ts ?? null),
    end: equity.length > 0 ? equity[equity.length - 1].t : (fills[fills.length - 1]?.ts ?? null),
  }
  run.fills = fills
  run.equity = equity
  run.finalEquity = finalEquity
  if (Array.isArray(result.warnings) && result.warnings.length > 0) run.notes.push(...result.warnings.map((w) => String(w)))
  run.notes.push('回测侧没有订单对象：Simulator 只产出成交（packages/engine-core/src/strategy/simulator.ts），订单序列无法核对')
  return run
}

/**
 * 纸面侧：paper-state.json → 规范形。
 * state 形如 { v:1, orderSeq, fillSeq, accounts:[{ id, ccy, initial, cash, realized, fees, funding, positions, orders, fills }] }
 * 里面的 Fx 是 18 位定点大整数，JSON 化后成 { $b: "..." }（venue.ts:986 的 replacer）。
 *
 * 权益口径：cash（已实现现金）+ 各持仓按 state 里的 mark 的未实现盈亏。state 只留最后一根 mark，
 * 所以「权益曲线」只能逐成交时刻重放（无成交时段的浮动盈亏、资金费逐点不重算）——可核对的是末值。
 */
export function fromPaperState(state, meta = {}) {
  const parsed = typeof state === 'string' ? JSON.parse(state) : state
  if (!parsed || typeof parsed !== 'object') throw new TypeError('paper state must be an object')
  if (parsed.v !== 1) throw new TypeError(`unsupported paper state version ${String(parsed.v)}`)
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
  const wanted = meta.accountId
  const acct = wanted ? accounts.find((a) => a.id === wanted) : accounts[0]
  if (!acct) throw new TypeError(wanted ? `paper state has no account ${wanted}` : 'paper state has no accounts')

  const orders = (Array.isArray(acct.orders) ? acct.orders : []).map((o, i) => ({
    seq: i + 1,
    clientOrderId: String(o.clientOrderId ?? ''),
    venueOrderId: String(o.venueOrderId ?? ''),
    instrumentId: String(o.instrumentId ?? ''),
    side: o.side === 'sell' ? 'sell' : 'buy',
    type: String(o.type ?? ''),
    tif: String(o.tif ?? ''),
    size: num(o.size),
    filledSize: num(o.filled),
    price: o.price === null || o.price === undefined ? null : num(o.price),
    avgFillPrice: num(o.avgPx),
    status: String(o.status ?? ''),
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
  }))

  const fills = (Array.isArray(acct.fills) ? acct.fills : []).map((f, i) => ({
    seq: i + 1,
    ts: num(f.ts),
    side: f.side === 'sell' ? 'sell' : 'buy',
    price: num(f.price),
    size: num(f.size),
    fee: num(f.fee) ?? 0,
    realizedPnl: num(f.realizedPnl) ?? 0,
    orderRef: f.clientOrderId ?? null,
    fillId: String(f.venueFillId ?? `paper-${i + 1}`),
    reason: typeof f.liquidity === 'string' ? f.liquidity : '',
  }))

  const equity = equitySeries(acct, fills)
  const run = emptyRun('paper', {
    instrument: meta.instrument ?? orders[0]?.instrumentId ?? fills[0]?.instrumentId ?? '',
    interval: meta.interval ?? '',
    source: { kind: 'paper-state', version: parsed.v, orderSeq: parsed.orderSeq ?? null, fillSeq: parsed.fillSeq ?? null, accountId: acct.id },
    clock: { mode: 'system', start: fills[0]?.ts ?? null, end: fills[fills.length - 1]?.ts ?? null },
  })
  run.capabilities = { orders: true, fills: true, equity: equity.length > 0, equityCurve: equity.length > 1 }
  run.orders = orders.filter((o) => meta.instrument === undefined || o.instrumentId === meta.instrument)
  run.fills = fills
  run.equity = equity
  run.finalEquity = equity.length > 0 ? equity[equity.length - 1].v : num(acct.cash)
  run.notes.push('纸面侧权益按 state 末根 mark 重放：末值可核对，逐点曲线只反映有成交的时刻')
  if (num(acct.funding) !== 0 && num(acct.funding) !== null) run.notes.push('纸面 cash 已含资金费；历史点无法逐点还原资金费，曲线中段不可用于逐点比对')
  if (parsed.orderSeq !== undefined) run.notes.push(`paper state 只保留最近 ${orders.length} 张订单（KEEP_ORDERS = 500），更早的已滚动丢弃`)
  return run
}

/** 用成交序列重放权益：初始资金 + 逐笔已实现盈亏 − 逐笔费用；末点叠加当前持仓按 mark 的未实现盈亏与已计资金费。 */
function equitySeries(acct, fills) {
  const initial = num(acct.initial) ?? 0
  const funding = num(acct.funding) ?? 0
  const out = []
  if (typeof acct.createdAt === 'number') out.push({ t: acct.createdAt, v: initial })
  let running = initial
  for (const f of fills) {
    if (f.ts === null) continue
    running += (f.realizedPnl ?? 0) - (f.fee ?? 0)
    out.push({ t: f.ts, v: running })
  }
  const cash = num(acct.cash)
  const equityEnd = (cash === null ? running : cash) + unrealizedOf(acct)
  out.push({ t: out.length > 0 ? out[out.length - 1].t + 1 : (num(acct.createdAt) ?? 0), v: equityEnd })
  // state 的 cash 已含资金费；历史点无法逐点还原资金费（见 fromPaperState 的 notes）。
  void funding
  return out.filter((p) => Number.isFinite(p.v))
}

/** 未实现盈亏：Σ size × (mark − entry)，方向按 side。 */
function unrealizedOf(acct) {
  const positions = acct.positions
  const entries = Array.isArray(positions) ? positions : positions && Array.isArray(positions.$m) ? positions.$m.map((x) => x[1]) : []
  let sum = 0
  for (const p of entries) {
    if (!p || typeof p !== 'object') continue
    const size = num(p.size) ?? 0
    const entry = num(p.entry) ?? 0
    const mark = num(p.mark) ?? entry
    const sign = p.side === 'short' ? -1 : 1
    sum += sign * size * (mark - entry)
  }
  return sum
}

/** 结构校验：返回 { ok, errors[] }。只查规范形的形状与必需字段，不查业务合理性。 */
export function validateArtifact(run) {
  const errors = []
  if (!run || typeof run !== 'object') return { ok: false, errors: ['run must be an object'] }
  if (run.schema !== PARITY_SCHEMA) errors.push(`schema must be ${PARITY_SCHEMA}`)
  if (run.side !== 'backtest' && run.side !== 'paper') errors.push('side must be backtest | paper')
  if (typeof run.instrument !== 'string' || run.instrument === '') errors.push('instrument is required')
  if (!run.capabilities || typeof run.capabilities !== 'object') errors.push('capabilities is required')
  for (const key of ['orders', 'fills', 'equity']) {
    if (!Array.isArray(run[key])) errors.push(`${key} must be an array`)
  }
  if (Array.isArray(run.fills)) {
    run.fills.forEach((f, i) => {
      if (!Number.isFinite(f.ts)) errors.push(`fills[${i}].ts must be a finite number`)
      if (!Number.isFinite(f.price)) errors.push(`fills[${i}].price must be a finite number`)
      if (!Number.isFinite(f.size)) errors.push(`fills[${i}].size must be a finite number`)
      if (f.side !== 'buy' && f.side !== 'sell') errors.push(`fills[${i}].side must be buy | sell`)
    })
  }
  if (Array.isArray(run.equity)) {
    run.equity.forEach((p, i) => {
      if (!Number.isFinite(p.t)) errors.push(`equity[${i}].t must be a finite number`)
      if (!Number.isFinite(p.v)) errors.push(`equity[${i}].v must be a finite number`)
    })
  }
  if (run.finalEquity !== null && !Number.isFinite(run.finalEquity)) errors.push('finalEquity must be a finite number or null')
  return { ok: errors.length === 0, errors }
}
