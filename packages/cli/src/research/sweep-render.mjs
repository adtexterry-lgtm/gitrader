// SPDX-License-Identifier: CPAL-1.0
// 参数扫描 / 走查结果渲染：把 packages/engine-core 的 SweepResult（sweep.ts:148-159）与
// WalkForwardResult（walk-forward.ts:74-87）的 JSON 结果渲染成 Markdown + HTML 表。
// 只读结果 JSON，不重跑回测；字段缺失一律显示「—」，不对数字做二次解释。
import { BACKTEST_DISCLAIMER, escapeHtml, fmt, htmlFacts, htmlPage, htmlTable, mdFacts, mdTable, pct } from './render.mjs'

/** 参数列上限：超过时只显示前 6 个（结果 JSON 里的参数键按首次出现顺序）。
 *  参数之所以受限：宽表在 Markdown 里会挤成一团，完整值仍在 JSON 里。 */
export const MAX_PARAM_COLUMNS = 6

/** 判断结果类型：有 folds 数组为 walk-forward，有 trials 数组为 sweep；都不符返回 null。 */
export function detectKind(data) {
  if (data === null || typeof data !== 'object') return null
  if (Array.isArray(data.folds)) return 'walk-forward'
  if (Array.isArray(data.trials)) return 'sweep'
  return null
}

function paramKeys(items) {
  const keys = []
  for (const item of items) {
    const params = item?.params ?? item?.bestParams
    if (params === null || typeof params !== 'object') continue
    for (const key of Object.keys(params)) if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

function paramText(params) {
  if (params === null || typeof params !== 'object') return '—'
  return Object.entries(params)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
}

function stat(stats, key) {
  const value = stats?.[key]
  return typeof value === 'number' ? value : null
}

/** 扫描结果 -> 报告数据（纯函数，便于测试）。 */
export function buildSweepReport(data, opts = {}) {
  const top = opts.top ?? 10
  if (!Number.isInteger(top) || top < 1) throw new RangeError(`top 必须是 >= 1 的整数；收到 ${top}`)
  const kind = detectKind(data)
  if (kind !== 'sweep') throw new RangeError('结果 JSON 不是参数扫描结果（缺 trials 数组）')
  const trials = data.trials
  const keys = paramKeys(trials)
  const shown = keys.slice(0, MAX_PARAM_COLUMNS)
  const sorted = [...trials].sort((a, b) => {
    const left = typeof a?.sharpe === 'number' ? a.sharpe : -Infinity
    const right = typeof b?.sharpe === 'number' ? b.sharpe : -Infinity
    if (right !== left) return right - left
    return (a?.index ?? 0) - (b?.index ?? 0)
  })
  const bestIndex = data.best && typeof data.best.index === 'number' ? data.best.index : null
  return {
    kind,
    title: opts.title ?? '参数扫描结果',
    generatedAt: opts.generatedAt ?? Date.now(),
    trials: sorted.slice(0, Math.min(top, sorted.length)),
    totalTrials: trials.length,
    paramKeys: shown,
    droppedParamKeys: keys.slice(MAX_PARAM_COLUMNS),
    best:
      data.best && typeof data.best === 'object'
        ? { index: bestIndex, params: data.best.params ?? null, sharpe: typeof data.best.sharpe === 'number' ? data.best.sharpe : null }
        : null,
    bestIndex,
    trialVariance: typeof data.trialVariance === 'number' ? data.trialVariance : null,
    dsr: typeof data.dsr === 'number' ? data.dsr : null,
    pbo: data.pbo && typeof data.pbo === 'object' ? data.pbo : null,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  }
}

/** 走查结果 -> 报告数据。 */
export function buildWalkForwardReport(data, opts = {}) {
  const top = opts.top ?? 20
  if (!Number.isInteger(top) || top < 1) throw new RangeError(`top 必须是 >= 1 的整数；收到 ${top}`)
  if (detectKind(data) !== 'walk-forward') throw new RangeError('结果 JSON 不是走查结果（缺 folds 数组）')
  const folds = data.folds
  return {
    kind: 'walk-forward',
    title: opts.title ?? '走查（walk-forward）结果',
    generatedAt: opts.generatedAt ?? Date.now(),
    folds: folds.slice(0, Math.min(top, folds.length)),
    totalFolds: folds.length,
    oosSharpe: typeof data.oosSharpe === 'number' ? data.oosSharpe : null,
    oosPeriods: Array.isArray(data.oosReturns) ? data.oosReturns.length : null,
    efficiency: typeof data.efficiency === 'number' ? data.efficiency : null,
    holdout: Array.isArray(data.holdout) ? data.holdout : null,
    embargoBars: typeof data.embargoBars === 'number' ? data.embargoBars : null,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  }
}

const SWEEP_STAT_HEADERS = ['收益', '年化', '最大回撤', '回测 Sharpe', 'Sortino', '胜率', '成交笔数', '费用']

function sweepRow(report, trial) {
  const stats = trial?.stats ?? null
  const flag = report.bestIndex !== null && trial?.index === report.bestIndex ? ' *' : ''
  return [
    `${trial?.index ?? '—'}${flag}`,
    ...report.paramKeys.map((key) => {
      const value = trial?.params?.[key]
      return value === undefined ? '—' : String(value)
    }),
    fmt(typeof trial?.sharpe === 'number' ? trial.sharpe : null, 3),
    pct(stat(stats, 'totalReturnRatio'), 2),
    pct(stat(stats, 'annualizedRatio'), 2),
    pct(stat(stats, 'maxDrawdownRatio'), 2),
    fmt(stat(stats, 'sharpe'), 3),
    fmt(stat(stats, 'sortino'), 3),
    pct(stat(stats, 'winRatio'), 1),
    stat(stats, 'trades') === null ? '—' : String(stat(stats, 'trades')),
    fmt(stat(stats, 'feesPaid'), 4),
  ]
}

function sweepFacts(report) {
  const pairs = [
    ['试验数', String(report.totalTrials)],
    ['显示行数', String(report.trials.length)],
  ]
  if (report.best) {
    pairs.push(['最优试验', report.bestIndex === null ? '—' : String(report.bestIndex)])
    pairs.push(['最优参数', paramText(report.best.params)])
    pairs.push(['最优 Sharpe', fmt(report.best.sharpe, 3)])
  }
  pairs.push(['试验间方差', fmt(report.trialVariance, 6)])
  pairs.push(['去膨胀 Sharpe（DSR）', fmt(report.dsr, 4)])
  if (report.pbo) {
    pairs.push(['过拟合概率（PBO）', fmt(typeof report.pbo.pbo === 'number' ? report.pbo.pbo : null, 4)])
    pairs.push(['CSCV 组合数', String(report.pbo.combos ?? '—')])
  }
  return pairs
}

/** 扫描结果 Markdown。 */
export function renderSweepMarkdown(report) {
  const lines = [`# ${report.title}`, '', mdFacts(sweepFacts(report)), '']
  if (report.droppedParamKeys.length > 0) {
    lines.push(`参数列只显示前 ${MAX_PARAM_COLUMNS} 个（${report.droppedParamKeys.join(', ')} 未显示，完整值见结果 JSON）。`, '')
  }
  lines.push(`## 试验排行（按 Sharpe 降序，前 ${report.trials.length} 组；* 为结果里的最优组）`, '')
  const headers = ['序号', ...report.paramKeys, '每期 Sharpe', ...SWEEP_STAT_HEADERS]
  lines.push(mdTable(headers, report.trials.map((t) => sweepRow(report, t))), '')
  if (report.warnings.length > 0) lines.push('## 提示', '', ...report.warnings.map((w) => `- ${w}`), '')
  lines.push('---', '', BACKTEST_DISCLAIMER, '')
  return lines.join('\n')
}

/** 扫描结果 HTML。 */
export function renderSweepHtml(report) {
  const headers = ['序号', ...report.paramKeys, '每期 Sharpe', ...SWEEP_STAT_HEADERS]
  const sections = [
    { heading: '试验排行（按 Sharpe 降序）', html: htmlTable(headers, report.trials.map((t) => sweepRow(report, t))) },
  ]
  if (report.warnings.length > 0) {
    sections.push({ heading: '提示', html: `<ul>${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` })
  }
  return htmlPage({
    title: report.title,
    subtitle: `${report.totalTrials} 组试验 · 显示 ${report.trials.length} 组`,
    sections: [{ heading: '汇总', html: htmlFacts(sweepFacts(report)) }, ...sections],
    disclaimer: BACKTEST_DISCLAIMER,
  })
}

const FOLD_HEADERS = ['折', '训练窗', '测试窗', '最优参数', '训练 Sharpe', '测试 Sharpe', '测试收益', '测试回撤', '测试成交']

function foldRow(fold) {
  const window = fold?.window ?? {}
  const train = Array.isArray(window.train) ? window.train : null
  const test = Array.isArray(window.test) ? window.test : null
  const stats = fold?.testStats ?? null
  return [
    String(window.index ?? '—'),
    train === null ? '—' : `${train[0]}–${train[1]}`,
    test === null ? '—' : `${test[0]}–${test[1]}`,
    paramText(fold?.bestParams),
    fmt(typeof fold?.trainSharpe === 'number' ? fold.trainSharpe : null, 3),
    fmt(typeof fold?.testSharpe === 'number' ? fold.testSharpe : null, 3),
    pct(stat(stats, 'totalReturnRatio'), 2),
    pct(stat(stats, 'maxDrawdownRatio'), 2),
    stat(stats, 'trades') === null ? '—' : String(stat(stats, 'trades')),
  ]
}

function walkForwardFacts(report) {
  const pairs = [
    ['折数', String(report.totalFolds)],
    ['显示行数', String(report.folds.length)],
    ['样本外 Sharpe', fmt(report.oosSharpe, 3)],
    ['样本外期数', report.oosPeriods === null ? '—' : String(report.oosPeriods)],
    ['效率比（测试/训练）', fmt(report.efficiency, 3)],
    ['盲留出段', report.holdout === null ? '—' : `${report.holdout[0]}–${report.holdout[1]}`],
    ['embargo 根数', report.embargoBars === null ? '—' : String(report.embargoBars)],
  ]
  return pairs
}

/** 走查结果 Markdown。 */
export function renderWalkForwardMarkdown(report) {
  const lines = [`# ${report.title}`, '', mdFacts(walkForwardFacts(report)), '']
  lines.push('## 各折结果', '')
  lines.push(mdTable(FOLD_HEADERS, report.folds.map((f) => foldRow(f))), '')
  if (report.warnings.length > 0) lines.push('## 提示', '', ...report.warnings.map((w) => `- ${w}`), '')
  lines.push('---', '', BACKTEST_DISCLAIMER, '')
  return lines.join('\n')
}

/** 走查结果 HTML。 */
export function renderWalkForwardHtml(report) {
  const sections = [{ heading: '各折结果', html: htmlTable(FOLD_HEADERS, report.folds.map((f) => foldRow(f))) }]
  if (report.warnings.length > 0) {
    sections.push({ heading: '提示', html: `<ul>${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` })
  }
  return htmlPage({
    title: report.title,
    subtitle: `${report.totalFolds} 折 · 样本外 Sharpe ${fmt(report.oosSharpe, 3)}`,
    sections: [{ heading: '汇总', html: htmlFacts(walkForwardFacts(report)) }, ...sections],
    disclaimer: BACKTEST_DISCLAIMER,
  })
}

/** 按类型分发渲染。 */
export function renderMarkdownFor(report) {
  return report.kind === 'walk-forward' ? renderWalkForwardMarkdown(report) : renderSweepMarkdown(report)
}

/** 按类型分发渲染（HTML）。 */
export function renderHtmlFor(report) {
  return report.kind === 'walk-forward' ? renderWalkForwardHtml(report) : renderSweepHtml(report)
}
