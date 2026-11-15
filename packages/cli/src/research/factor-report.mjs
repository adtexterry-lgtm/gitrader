// SPDX-License-Identifier: CPAL-1.0
// 因子研究报告：K 线 -> Alpha158 全部因子 -> 前向 n 根收益的 IC / 滚动 IR / 分位组收益 -> Markdown + HTML。
// 因子目录与计算见 lib/alpha158.mjs（复制自 packages/engine-core/src/strategy/alpha158.ts），
// 评估口径见 lib/factor-eval.mjs（复制自 packages/engine-core/src/strategy/factor-eval.ts）。
import { alpha158Catalog, alphaFactorById } from './alpha158.mjs'
import { forwardReturns, icSummary, quantileMonotonicity, quantileReturns, rankIc, rollingIc } from './factor-eval.mjs'
import { isoTime } from './candles.mjs'
import { DISCLAIMER, escapeHtml, fmt, htmlFacts, htmlPage, htmlTable, mdFacts, mdTable, pct } from './render.mjs'

/** 参数校验：任何一项不合法抛 RangeError（CLI 转成退出码 2）。 */
export function normalizeOptions(opts = {}) {
  const out = {
    horizon: opts.horizon ?? 5,
    window: opts.window ?? 60,
    quantiles: opts.quantiles ?? 5,
    top: opts.top ?? 20,
    title: opts.title ?? '因子研究报告',
  }
  for (const key of ['horizon', 'window', 'quantiles', 'top']) {
    const value = out[key]
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${key} 必须是 >= 1 的整数；收到 ${value}`)
  }
  if (typeof out.title !== 'string' || out.title.trim() === '') throw new RangeError('title 不能为空')
  return out
}

/**
 * 计算全部 Alpha158 因子的评估结果。
 * input: { candles, horizon?, window?, quantiles?, top?, title?, source?: { path, sha256, rows, skipped, duplicates, format } }
 * 返回 factors 按 |IC| 降序（IC 为 null 的排后面，同 |IC| 按名字升序）。
 */
export function buildFactorReport(input) {
  const opts = normalizeOptions(input)
  const candles = input.candles ?? []
  const warnings = []
  const fwd = forwardReturns(candles, opts.horizon)
  if (candles.length <= opts.horizon) warnings.push(`K 线 ${candles.length} 根，不足覆盖 ${opts.horizon} 根前向收益`)
  if (candles.length < opts.window) warnings.push(`K 线 ${candles.length} 根，少于滚动窗口 ${opts.window}，滚动 IC 无有效点`)

  const factors = []
  for (const entry of alpha158Catalog()) {
    const def = alphaFactorById(entry.factorId)
    if (def === undefined) continue
    const values = def.compute(candles, { period: entry.period })
    const ic = rankIc(values, fwd)
    const rolling = icSummary(rollingIc(values, fwd, opts.window), { tLags: opts.window + opts.horizon - 2 })
    const quantile = quantileReturns(values, fwd, opts.quantiles)
    const low = quantile.buckets.length > 0 ? quantile.buckets[0].meanFwd : null
    const high = quantile.buckets.length > 0 ? quantile.buckets[quantile.buckets.length - 1].meanFwd : null
    factors.push({
      name: entry.name,
      factorId: entry.factorId,
      label: def.label,
      period: entry.period,
      ic,
      rolling,
      buckets: quantile.buckets,
      low,
      high,
      spread: quantile.spread,
      monotonicity: quantileMonotonicity(quantile.buckets),
    })
  }

  factors.sort((a, b) => {
    const left = a.ic === null ? -1 : Math.abs(a.ic)
    const right = b.ic === null ? -1 : Math.abs(b.ic)
    if (right !== left) return right - left
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  const withIc = factors.filter((f) => f.ic !== null).length
  const ranked = factors.slice(0, Math.min(opts.top, factors.length))

  return {
    title: opts.title,
    generatedAt: input.generatedAt ?? Date.now(),
    source: input.source ?? null,
    bars: candles.length,
    from: candles.length > 0 ? isoTime(candles[0].t) : '—',
    to: candles.length > 0 ? isoTime(candles[candles.length - 1].t) : '—',
    horizon: opts.horizon,
    window: opts.window,
    quantiles: opts.quantiles,
    top: opts.top,
    catalogSize: factors.length,
    withIc,
    tMethod: 'newey-west',
    tLags: opts.window + opts.horizon - 2,
    /** 完整因子序列（按 |IC| 降序；IC 为 null 的排后面）：research 工具分页用，top 只决定 factors / best。 */
    all: factors,
    factors: ranked,
    best: ranked.length > 0 ? ranked[0] : null,
    warnings,
  }
}

const FACTOR_HEADERS = ['排名', '因子', '因子 id', '窗口', 'IC', '滚动 IR', 't 值（NW）', 'IC>0 占比', 'Q1 均值', 'Q5 均值', 'Q5−Q1', '单调性', '有效点']

function factorRow(index, f) {
  return [
    String(index + 1),
    f.name,
    f.factorId,
    String(f.period),
    fmt(f.ic, 4),
    fmt(f.rolling.ir, 3),
    fmt(f.rolling.tStat, 2),
    pct(f.rolling.positiveShare, 1),
    pct(f.low, 3),
    pct(f.high, 3),
    pct(f.spread, 3),
    fmt(f.monotonicity, 3),
    String(f.rolling.n),
  ]
}

function factPairs(report) {
  const src = report.source
  const pairs = [
    ['生成时间', isoTime(report.generatedAt)],
    ['K 线根数', String(report.bars)],
    ['时间范围', `${report.from} → ${report.to}`],
    ['前向收益', `${report.horizon} 根`],
    ['滚动 IC 窗口', `${report.window} 根`],
    ['分位组', `${report.quantiles} 组`],
    ['因子目录', `${report.catalogSize} 条（Alpha158 口径，KBAR 9 + 价格 3 + 滚动 29×5）`],
    ['有效 IC 因子', `${report.withIc} 条`],
  ]
  if (src) {
    pairs.splice(1, 0, ['数据文件', src.path])
    pairs.splice(2, 0, ['sha256', src.sha256])
    pairs.push(['文件行数 / 跳过 / 重复', `${src.rows} / ${src.skipped} / ${src.duplicates}`])
  }
  return pairs
}

const NOTES = [
  'IC 为全样本 Spearman 秩相关：因子值与未来 n 根收盘收益的秩相关；有效点少于 3 或任一方零方差时为「—」。',
  '滚动 IR = 滚动 IC 序列的均值 / 样本标准差（ddof 1）。',
  't 值用 Newey–West（HAC）口径：滚动 IC 序列的均值 / 稳健标准误，Bartlett 核，滞后 L = 窗口 + 前向根数 − 2（相邻滚动窗口高度重叠，把它们当独立样本会让 t 虚高数倍）。「有效点」是滚动 IC 的点数，不是独立样本数。',
  '分位组按因子值升序等分；Q5−Q1 为最高组减最低组的平均前向收益；单调性为组序与组均值收益的秩相关。',
  '因子预热期与尾部 n 根无前向收益处不参与统计；样本量写在「有效点」列。',
]

/** Markdown 报告。 */
export function renderFactorMarkdown(report) {
  const lines = [`# ${report.title}`, '', mdFacts(factPairs(report)), '']
  if (report.warnings.length > 0) {
    lines.push('## 提示', '', ...report.warnings.map((w) => `- ${w}`), '')
  }
  lines.push(`## 因子 IC / IR（按 |IC| 降序，前 ${report.factors.length} 条）`, '')
  lines.push(mdTable(FACTOR_HEADERS, report.factors.map((f, index) => factorRow(index, f))), '')
  const best = report.best
  if (best && best.buckets.length > 0) {
    lines.push(`## 分位组收益（${best.name}，|IC| 最大者）`, '')
    lines.push(
      mdTable(
        ['组', '样本数', '前向收益均值'],
        best.buckets.map((b) => [String(b.q), String(b.n), pct(b.meanFwd, 3)]),
      ),
      '',
    )
  }
  lines.push('## 口径与限制', '', ...NOTES.map((note) => `- ${note}`), '')
  lines.push('---', '', DISCLAIMER, '')
  return lines.join('\n')
}

/** 单文件 HTML 报告（内联 CSS、无脚本）。 */
export function renderFactorHtml(report) {
  const sections = []
  if (report.warnings.length > 0) {
    sections.push({
      heading: '提示',
      html: `<ul>${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`,
    })
  }
  sections.push({
    heading: `因子 IC / IR（按 |IC| 降序，前 ${report.factors.length} 条）`,
    html: htmlTable(FACTOR_HEADERS, report.factors.map((f, index) => factorRow(index, f))),
  })
  const best = report.best
  if (best && best.buckets.length > 0) {
    sections.push({
      heading: `分位组收益（${best.name}，|IC| 最大者）`,
      html: htmlTable(
        ['组', '样本数', '前向收益均值'],
        best.buckets.map((b) => [String(b.q), String(b.n), pct(b.meanFwd, 3)]),
      ),
    })
  }
  sections.push({ heading: '口径与限制', html: `<ul>${NOTES.map((n) => `<li>${n}</li>`).join('')}</ul>` })
  return htmlPage({
    title: report.title,
    subtitle: `${report.bars} 根 K 线 · 前向 ${report.horizon} 根 · ${report.catalogSize} 条因子 · 有效 IC ${report.withIc} 条`,
    sections: [{ heading: '数据与口径', html: htmlFacts(factPairs(report)) }, ...sections],
  })
}
