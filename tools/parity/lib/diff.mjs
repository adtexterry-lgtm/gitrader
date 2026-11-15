// SPDX-License-Identifier: CPAL-1.0
// 差异计算：两份规范形运行记录（回测 / 纸面）→ 差异表（行数组 + 汇总）。
// 纯函数，不读文件、不联网、不看时钟；同一输入逐位同输出（测试依赖这一点）。
//
// 比对三类 + 一类能力声明：
//   orders  订单序列：按 clientOrderId 对齐；缺单、多单、状态/数量/价格漂移各记一行。
//   fills   成交序列：按「同方向 + 时间在容差内」就近配对；数量/价格/费用逐一比；配不上记缺/多。
//   equity  最终权益：绝对 + 相对容差取宽者；曲线最大偏离单列一行（信息级）。
//   capability  某一侧没有该类记录（例如回测没有订单对象）→ 记「无法核对」，绝不记成「一致」。

export const DEFAULT_TOLERANCES = {
  priceEpsAbs: 1e-9,
  sizeEpsAbs: 1e-9,
  feeEpsAbs: 1e-9,
  equityEpsAbs: 1e-6,
  equityEpsPct: 1e-6,
  timeToleranceMs: 0,
}

export const SEVERITIES = ['blocking', 'fix', 'note']
const SEVERITY_TEXT = { blocking: '阻断', fix: '应修', note: '备注' }
export const severityText = (s) => SEVERITY_TEXT[s] ?? s

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fmt = (v) => {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(10)))
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
const close = (a, b, eps) => a !== null && b !== null && Math.abs(a - b) <= eps
/** 差值去掉浮点尾巴：差异表给人看，不允许 0.0010000000000000009 这种噪音。 */
const sub = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) return null
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const d = a - b
  return Number.isInteger(d) ? d : Number(d.toPrecision(12))
}

/**
 * @param {object} backtest 规范形（side=backtest）
 * @param {object} paper    规范形（side=paper）
 * @param {object} [options] 容差与说明
 * @returns {{ rows: object[], summary: object, tolerances: object }}
 */
export function diffRuns(backtest, paper, options = {}) {
  if (!backtest || !paper) throw new TypeError('diffRuns needs two runs')
  const tol = { ...DEFAULT_TOLERANCES, ...options }
  const rows = []
  let seq = 0
  const push = (row) => {
    rows.push({ n: ++seq, ...row })
    return rows[rows.length - 1]
  }

  // ---- 能力声明 ---------------------------------------------------------------------
  for (const field of ['orders', 'fills', 'equity']) {
    const bt = backtest.capabilities?.[field] === true
    const pp = paper.capabilities?.[field] === true
    if (bt && pp) continue
    const missingSide = bt ? 'paper' : pp ? 'backtest' : 'both'
    push({
      kind: 'capability',
      key: field,
      field: `capabilities.${field}`,
      backtest: bt,
      paper: pp,
      delta: null,
      severity: 'note',
      judgement: missingSide === 'both' ? '两侧都没有这一类记录：无法核对' : `${missingSide === 'backtest' ? '回测' : '纸面'}侧不提供这一类记录：无法核对（不是一致）`,
    })
  }

  // ---- 订单序列 ---------------------------------------------------------------------
  // 只有两侧都声称有订单对象时才逐单比对；一侧没有 → 只留上面那条「无法核对」，不把对方的单记成「缺失」。
  const ordersComparable = backtest.capabilities?.orders === true && paper.capabilities?.orders === true
  const btOrders = ordersComparable && Array.isArray(backtest.orders) ? backtest.orders : []
  const ppOrders = ordersComparable && Array.isArray(paper.orders) ? paper.orders : []
  if (btOrders.length > 0 || ppOrders.length > 0) {
    const ppByKey = new Map()
    for (const o of ppOrders) ppByKey.set(o.clientOrderId || o.venueOrderId, o)
    const seen = new Set()
    for (const o of btOrders) {
      const key = o.clientOrderId || o.venueOrderId
      const other = ppByKey.get(key)
      if (!other) {
        push({ kind: 'orders', key, field: '*', backtest: 'present', paper: 'missing', delta: null, severity: 'blocking', judgement: '回测有此订单，纸面没有：订单没有到达场所或客户端单号变了' })
        continue
      }
      seen.add(key)
      compareOrder(o, other, key, tol, push)
    }
    for (const o of ppOrders) {
      const key = o.clientOrderId || o.venueOrderId
      if (seen.has(key)) continue
      push({ kind: 'orders', key, field: '*', backtest: 'missing', paper: 'present', delta: null, severity: 'blocking', judgement: '纸面有此订单，回测没有：纸面多下的单（策略分流或重启恢复）' })
    }
  }

  // ---- 成交序列 ---------------------------------------------------------------------
  const fillsComparable = backtest.capabilities?.fills === true && paper.capabilities?.fills === true
  const btFills = fillsComparable && Array.isArray(backtest.fills) ? backtest.fills : []
  const ppFills = fillsComparable && Array.isArray(paper.fills) ? paper.fills : []
  const used = new Set()
  for (const f of btFills) {
    let best = -1
    let bestDt = Infinity
    ppFills.forEach((g, j) => {
      if (used.has(j)) return
      if (g.side !== f.side) return
      const dt = Math.abs((g.ts ?? 0) - (f.ts ?? 0))
      if (dt <= tol.timeToleranceMs && dt < bestDt) { best = j; bestDt = dt }
    })
    if (best < 0) {
      push({ kind: 'fills', key: f.fillId ?? `bt#${f.seq}`, field: '*', backtest: `${f.side} ${fmt(f.size)}@${fmt(f.price)}`, paper: 'missing', delta: null, severity: 'blocking', judgement: '回测成交在纸面找不到对应成交：成交模型或成交概率不同' })
      continue
    }
    used.add(best)
    const g = ppFills[best]
    const key = f.fillId ?? `bt#${f.seq}`
    if (!close(f.price, n(g.price), tol.priceEpsAbs)) {
      const delta = sub(n(g.price), n(f.price))
      push({ kind: 'fills', key, field: 'price', backtest: f.price, paper: g.price, delta, severity: 'blocking', judgement: '成交价不同：回测是下一根开盘价，纸面按盘口逐档吃量' })
    }
    if (!close(f.size, n(g.size), tol.sizeEpsAbs)) {
      const delta = sub(n(g.size), n(f.size))
      push({ kind: 'fills', key, field: 'size', backtest: f.size, paper: g.size, delta, severity: 'blocking', judgement: '成交数量不同：成交量上限、部分成交或流动性消耗不同' })
    }
    if (!close(f.fee ?? 0, n(g.fee ?? 0), tol.feeEpsAbs)) {
      const delta = sub(n(g.fee ?? 0) ?? 0, n(f.fee ?? 0) ?? 0)
      push({ kind: 'fills', key, field: 'fee', backtest: f.fee ?? 0, paper: g.fee ?? 0, delta, severity: 'fix', judgement: '手续费不同：一侧按 taker 固定费率、一侧按 maker/taker 分别计费' })
    }
    if (f.ts !== g.ts) {
      push({ kind: 'fills', key, field: 'ts', backtest: f.ts, paper: g.ts, delta: sub(n(g.ts), n(f.ts)), severity: 'note', judgement: '成交时刻落在容差内但不同：回测用 K 线时间戳，纸面用撮合时刻' })
    }
  }
  ppFills.forEach((g, j) => {
    if (used.has(j)) return
    push({ kind: 'fills', key: g.fillId ?? `paper#${g.seq}`, field: '*', backtest: 'missing', paper: `${g.side} ${fmt(g.size)}@${fmt(g.price)}`, delta: null, severity: 'blocking', judgement: '纸面成交在回测找不到对应成交：纸面多成交（触发、强平、改单行为不同）' })
  })

  // ---- 最终权益 ---------------------------------------------------------------------
  const btEq = n(backtest.finalEquity)
  const ppEq = n(paper.finalEquity)
  if (btEq !== null && ppEq !== null) {
    const delta = sub(ppEq, btEq)
    const limit = Math.max(tol.equityEpsAbs, Math.abs(btEq) * tol.equityEpsPct)
    push({
      kind: 'equity',
      key: 'finalEquity',
      field: 'finalEquity',
      backtest: btEq,
      paper: ppEq,
      delta,
      severity: Math.abs(delta) > limit ? 'blocking' : 'note',
      judgement: Math.abs(delta) > limit
        ? `最终权益差 ${fmt(delta)}（容忍 ${fmt(limit)}）：先看成交价差，再看费用与资金费口径`
        : '最终权益在容差内',
    })
  } else {
    push({ kind: 'equity', key: 'finalEquity', field: 'finalEquity', backtest: btEq, paper: ppEq, delta: null, severity: 'note', judgement: '至少一侧没有最终权益：无法核对' })
  }

  // ---- 权益曲线（信息级）-------------------------------------------------------------
  const btCurve = Array.isArray(backtest.equity) ? backtest.equity : []
  const ppCurve = Array.isArray(paper.equity) ? paper.equity : []
  if (btCurve.length > 1 && ppCurve.length > 1) {
    let worst = 0
    for (const p of ppCurve) {
      const match = nearest(btCurve, p.t, tol.timeToleranceMs)
      if (!match) continue
      worst = Math.max(worst, Math.abs((p.v ?? 0) - (match.v ?? 0)))
    }
    push({ kind: 'equity', key: 'curve', field: 'maxDeviation', backtest: null, paper: null, delta: worst, severity: 'note', judgement: `逐点最大偏离 ${fmt(worst)}：两侧时间基不同（K 线收盘 vs 撮合时刻），只看趋势不看逐点` })
  }

  const summary = summarize(rows)
  return { rows, summary, tolerances: tol }
}

function compareOrder(a, b, key, tol, push) {
  const fields = [
    ['side', (x) => x.side, (x) => x.side],
    ['type', (x) => x.type, (x) => x.type],
    ['size', (x) => n(x.size), (x) => n(x.size), tol.sizeEpsAbs],
    ['price', (x) => n(x.price), (x) => n(x.price), tol.priceEpsAbs],
    ['status', (x) => x.status, (x) => x.status],
  ]
  for (const [field, getA, getB, eps] of fields) {
    const va = getA(a)
    const vb = getB(b)
    if (eps !== undefined) {
      if (va === null && vb === null) continue
      if (close(va, vb, eps)) continue
      push({ kind: 'orders', key, field, backtest: va, paper: vb, delta: sub(vb, va), severity: 'fix', judgement: field === 'size' ? '数量不同：手数归一或部分成交口径不同' : '价格不同：挂单价或改单时机不同' })
      continue
    }
    if (va === vb) continue
    push({ kind: 'orders', key, field, backtest: va, paper: vb, delta: null, severity: field === 'status' ? 'blocking' : 'fix', judgement: field === 'status' ? '订单状态不同：一侧判定已成交 / 已撤，另一侧没有' : '订单字段不同：意图编码不同' })
  }
}

function nearest(points, t, tolMs) {
  if (!Number.isFinite(t)) return null
  let best = null
  let bestDt = Infinity
  for (const p of points) {
    const dt = Math.abs((p.t ?? 0) - t)
    if (dt <= tolMs && dt < bestDt) { best = p; bestDt = dt }
  }
  return best
}

export function summarize(rows) {
  const byKind = { orders: 0, fills: 0, equity: 0, capability: 0 }
  const bySeverity = { blocking: 0, fix: 0, note: 0 }
  for (const r of rows) {
    if (byKind[r.kind] !== undefined) byKind[r.kind] += 1
    if (bySeverity[r.severity] !== undefined) bySeverity[r.severity] += 1
  }
  const verdict = bySeverity.blocking > 0 ? 'divergent' : rows.some((r) => r.kind === 'capability') ? 'partly-unverifiable' : 'consistent'
  return { total: rows.length, byKind, bySeverity, verdict }
}
