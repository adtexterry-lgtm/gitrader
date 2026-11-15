// SPDX-License-Identifier: CPAL-1.0
// 报告与 CLI 测试：K 线文件解析、因子报告构造与渲染、扫描 / 走查结果渲染、退出码。
// 全部离线；临时文件写在系统临时目录的独立子目录里，用例结束即删。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseCandleCsv, parseCandleJson, readCandleFile } from '../../packages/cli/src/research/candles.mjs'
import { buildFactorReport, renderFactorHtml, renderFactorMarkdown } from '../../packages/cli/src/research/factor-report.mjs'
import { BACKTEST_DISCLAIMER, DISCLAIMER } from '../../packages/cli/src/research/render.mjs'
import {
  buildSweepReport,
  buildWalkForwardReport,
  detectKind,
  renderMarkdownFor,
  renderSweepHtml,
  renderWalkForwardHtml,
} from '../../packages/cli/src/research/sweep-render.mjs'
import { run as runFactor } from '../factor-report.mjs'
import { run as runSweep } from '../sweep-report.mjs'
import { barsFromCloses, noisyCandles } from './helpers.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'gitrader-research-'))
}

function csvText(candles) {
  const rows = ['t,o,h,l,c,v']
  for (const c of candles) rows.push([c.t, c.o, c.h, c.l, c.c, c.v].join(','))
  return `${rows.join('\n')}\n`
}

function capture() {
  const out = []
  const err = []
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

test('K 线解析：CSV 表头 / 坏行 / 重复时间，JSON 数组与 {candles}', () => {
  const csv = 't,o,h,l,c,v\n1,1,2,0.5,1.5,10\n2,1.5,2.5,1,2,20\nbad,row\n2,9,9,9,9,9\n'
  const parsed = parseCandleCsv(csv)
  assert.equal(parsed.format, 'csv')
  assert.equal(parsed.header, true)
  assert.equal(parsed.rows, 5)
  assert.equal(parsed.skipped, 1)
  // 时间 2 出现两次：保留先出现的（c=2）
  assert.equal(parsed.duplicates, 1)
  assert.equal(parsed.candles.length, 2)
  assert.equal(parsed.candles[1].c, 2)

  const json = parseCandleJson(JSON.stringify({ candles: [[1, 1, 2, 0.5, 1.5], { t: 2, o: 1, h: 2, l: 1, c: 2 }] }))
  assert.equal(json.format, 'json')
  assert.equal(json.candles.length, 2)
  assert.equal(json.candles[0].v, 0)
  assert.equal(json.candles[1].v, 0)
  assert.throws(() => parseCandleJson('not json'), /not valid JSON/)
})

test('readCandleFile：sha256 为 64 位十六进制，行数含表头', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'c.csv')
    const text = csvText(barsFromCloses([1, 2, 3]))
    writeFileSync(path, text, 'utf8')
    const read = readCandleFile(path)
    assert.match(read.sha256, /^[0-9a-f]{64}$/)
    assert.equal(read.rows, 4)
    assert.equal(read.candles.length, 3)
    assert.equal(read.format, 'csv')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildFactorReport：157 条因子、按 |IC| 降序、IC 落在 [-1, 1]', () => {
  const candles = noisyCandles(300, 11)
  const report = buildFactorReport({
    candles,
    horizon: 5,
    window: 20,
    quantiles: 5,
    top: 12,
    title: '合成数据因子报告',
    generatedAt: 1_700_000_000_000,
    source: { path: 'synthetic.csv', sha256: 'a'.repeat(64), rows: 301, skipped: 0, duplicates: 0, format: 'csv' },
  })
  assert.equal(report.bars, 300)
  assert.equal(report.from, '2023-11-14T22:13:20.000Z')
  assert.equal(report.catalogSize, 157)
  assert.equal(report.factors.length, 12)
  assert.ok(report.withIc > 100, `有效 IC 因子太少：${report.withIc}`)
  for (const factor of report.factors) {
    if (factor.ic !== null) assert.ok(Math.abs(factor.ic) <= 1, `${factor.name} IC 越界：${factor.ic}`)
    if (factor.ic === null) continue
    assert.equal(factor.buckets.length, 5)
    assert.ok(factor.rolling.n > 0)
  }
  for (let i = 1; i < report.factors.length; i++) {
    const prev = report.factors[i - 1].ic
    const cur = report.factors[i].ic
    if (prev === null || cur === null) continue
    assert.ok(Math.abs(prev) >= Math.abs(cur), '未按 |IC| 降序')
  }
  assert.equal(report.best, report.factors[0])
})

test('因子报告渲染：Markdown 有表头与免责声明，HTML 单文件无脚本且确定性', () => {
  const candles = noisyCandles(200, 5)
  const input = {
    candles,
    horizon: 3,
    window: 20,
    quantiles: 5,
    top: 8,
    title: '渲染测试',
    generatedAt: 1_700_000_000_000,
    source: { path: 'x.csv', sha256: 'b'.repeat(64), rows: 201, skipped: 0, duplicates: 0, format: 'csv' },
  }
  const report = buildFactorReport(input)
  const md = renderFactorMarkdown(report)
  assert.ok(md.startsWith('# 渲染测试\n'))
  assert.ok(md.includes('| 排名 | 因子 | 因子 id | 窗口 | IC | 滚动 IR |'))
  assert.ok(md.includes('## 分位组收益（'))
  assert.ok(md.includes('## 口径与限制'))
  assert.ok(md.endsWith(`${DISCLAIMER}\n`))
  assert.ok(md.includes('b'.repeat(64)))
  assert.ok(md.includes('| 1 |'))

  const html = renderFactorHtml(report)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<style>'))
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('http://'))
  assert.ok(html.includes(DISCLAIMER))
  assert.ok(html.includes('<table'))
  // 同一输入两次渲染完全一致（无时间漂移：generatedAt 固定）
  assert.equal(html, renderFactorHtml(buildFactorReport(input)))
  assert.equal(md, renderFactorMarkdown(buildFactorReport(input)))
})

test('factor-report CLI：写两份报告并返回 0；文件缺失或参数错返回 2', async () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'bars.csv')
    writeFileSync(path, csvText(barsFromCloses(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3)))), 'utf8')
    const cap = capture()
    const code = await runFactor([path, '--window', '20', '--top', '3', '--title', 'CLI 测试'], cap.io)
    assert.equal(code, 0)
    assert.match(cap.out(), /157 条因子/)
    const mdPath = join(dir, 'bars.factors.md')
    const htmlPath = join(dir, 'bars.factors.html')
    const md = readFileSync(mdPath, 'utf8')
    assert.ok(md.includes('# CLI 测试'))
    assert.ok(md.includes('前 3 条'))
    assert.ok(readFileSync(htmlPath, 'utf8').includes('<style>'))

    const missing = capture()
    assert.equal(await runFactor([join(dir, 'nope.csv')], missing.io), 2)
    assert.match(missing.err(), /读取 K 线文件失败/)

    const bad = capture()
    assert.equal(await runFactor([path, '--horizon', '0'], bad.io), 2)
    assert.match(bad.err(), /horizon/)

    const noFile = capture()
    assert.equal(await runFactor(['--top', '5'], noFile.io), 2)
    assert.match(noFile.err(), /缺少 K 线文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const SWEEP = {
  trials: [
    {
      index: 0,
      params: { fast: 5, slow: 20 },
      stats: {
        totalReturnRatio: 0.1,
        annualizedRatio: 0.2,
        maxDrawdownRatio: 0.05,
        sharpe: 0.8,
        sortino: 1.1,
        winRatio: 0.5,
        trades: 10,
        feesPaid: 1.25,
      },
      returns: [0.01],
      sharpe: 0.5,
    },
    {
      index: 1,
      params: { fast: 10, slow: 20 },
      stats: {
        totalReturnRatio: 0.25,
        annualizedRatio: 0.5,
        maxDrawdownRatio: 0.1,
        sharpe: 1.4,
        sortino: 1.9,
        winRatio: 0.6,
        trades: 12,
        feesPaid: 2.5,
      },
      returns: [0.02],
      sharpe: 1.2,
    },
    {
      index: 2,
      params: { fast: 5, slow: 40 },
      stats: {
        totalReturnRatio: 0.05,
        annualizedRatio: 0.1,
        maxDrawdownRatio: 0.02,
        sharpe: 0.4,
        sortino: 0.6,
        winRatio: 0.4,
        trades: 8,
        feesPaid: 0.75,
      },
      returns: [0.005],
      sharpe: 0.9,
    },
  ],
  best: { index: 1, params: { fast: 10, slow: 20 }, sharpe: 1.2 },
  trialVariance: 0.0625,
  dsr: 0.42,
  pbo: { pbo: 0.25, lambdas: [0.5], combos: 128, oosRankMean: 0.5, degradation: { slope: -0.1, intercept: 0.2 }, probLossOos: 0.25 },
  warnings: ['pbo skipped: 样本不足'],
}

test('扫描报告：按 Sharpe 降序、标出最优组、参数列与统计列精确', () => {
  const report = buildSweepReport(SWEEP, { top: 3, title: '扫描测试', generatedAt: 1 })
  assert.equal(report.kind, 'sweep')
  assert.equal(report.totalTrials, 3)
  assert.deepEqual(
    report.trials.map((t) => t.index),
    [1, 2, 0],
  )
  assert.equal(report.bestIndex, 1)
  assert.deepEqual(report.paramKeys, ['fast', 'slow'])
  const md = renderMarkdownFor(report)
  assert.ok(md.startsWith('# 扫描测试\n'))
  assert.ok(md.includes('| 序号 | fast | slow | 每期 Sharpe | 收益 |'))
  // 第 1 行是 index 1（最优，带 *）：Sharpe 1.200，收益 25.00%，回撤 10.00%
  assert.ok(md.includes('| 1 * | 10 | 20 | 1.200 | 25.00% |'), md.slice(0, 600))
  assert.ok(md.includes('| 2 | 5 | 40 | 0.900 | 5.00% |'))
  assert.ok(md.includes('最优参数：fast=10, slow=20'))
  assert.ok(md.includes('去膨胀 Sharpe（DSR）：0.4200'))
  assert.ok(md.includes('过拟合概率（PBO）：0.2500'))
  assert.ok(md.includes('pbo skipped: 样本不足'))
  assert.ok(md.endsWith(`${BACKTEST_DISCLAIMER}\n`))

  const html = renderSweepHtml(report)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(!html.includes('<script'))
  assert.ok(html.includes('25.00%'))
})

test('走查报告：各折训练/测试 Sharpe、样本外汇总、效率比与盲留出段', () => {
  const data = {
    folds: [
      {
        window: { index: 0, train: [0, 60], test: [60, 80] },
        bestParams: { fast: 5 },
        trainSharpe: 1.5,
        testSharpe: 0.75,
        testReturns: [0.01, 0.02],
        testStats: { totalReturnRatio: 0.05, maxDrawdownRatio: 0.02, trades: 4 },
      },
      {
        window: { index: 1, train: [20, 80], test: [80, 100], embargo: 0 },
        bestParams: { fast: 10, slow: 30 },
        trainSharpe: 1,
        testSharpe: 0.5,
        testReturns: [],
        testStats: { totalReturnRatio: 0.01, maxDrawdownRatio: 0.03, trades: 2 },
      },
    ],
    oosReturns: [0.01, 0.02],
    oosSharpe: 0.9,
    efficiency: 0.5,
    holdout: [100, 120],
    embargoBars: 0,
    warnings: [],
  }
  const report = buildWalkForwardReport(data, { top: 20, title: '走查测试' })
  assert.equal(report.kind, 'walk-forward')
  assert.equal(report.totalFolds, 2)
  const md = renderMarkdownFor(report)
  assert.ok(md.includes('| 0 | 0–60 | 60–80 | fast=5 | 1.500 | 0.750 | 5.00% | 2.00% | 4 |'))
  assert.ok(md.includes('| 1 | 20–80 | 80–100 | fast=10, slow=30 | 1.000 | 0.500 |'))
  assert.ok(md.includes('样本外 Sharpe：0.900'))
  assert.ok(md.includes('效率比（测试/训练）：0.500'))
  assert.ok(md.includes('盲留出段：100–120'))

  // 效率比为 null 时显示「—」
  const nullReport = buildWalkForwardReport({ ...data, efficiency: null }, {})
  assert.ok(renderMarkdownFor(nullReport).includes('效率比（测试/训练）：—'))
  assert.equal(detectKind({}), null)
})

test('HTML 转义：扫描 / 走查的提示文字经转义，不注入标签', () => {
  const payload = '<img src=x onerror=alert(1)>'
  const sweep = buildSweepReport({ ...SWEEP, warnings: [payload] }, { top: 3, title: '转义测试', generatedAt: 1 })
  const sweepHtml = renderSweepHtml(sweep)
  assert.ok(sweepHtml.includes('&lt;img'))
  assert.ok(!sweepHtml.includes('<img'))

  const wfReport = buildWalkForwardReport(
    { folds: [], oosReturns: [], oosSharpe: null, efficiency: null, holdout: null, embargoBars: 0, warnings: [payload] },
    { title: '转义测试', generatedAt: 1 },
  )
  const wfHtml = renderWalkForwardHtml(wfReport)
  assert.ok(wfHtml.includes('&lt;img'))
  assert.ok(!wfHtml.includes('<img'))
})

test('免责声明：扫描 / 走查 HTML 用回测版，因子报告 HTML 仍用因子版', () => {
  const sweepHtml = renderSweepHtml(buildSweepReport(SWEEP, { top: 3, title: '免责测试', generatedAt: 1 }))
  assert.ok(sweepHtml.includes(BACKTEST_DISCLAIMER))
  assert.ok(!sweepHtml.includes(DISCLAIMER))

  const wfHtml = renderWalkForwardHtml(
    buildWalkForwardReport(
      { folds: [], oosReturns: [], oosSharpe: null, efficiency: null, holdout: null, embargoBars: 0, warnings: [] },
      { title: '免责测试', generatedAt: 1 },
    ),
  )
  assert.ok(wfHtml.includes(BACKTEST_DISCLAIMER))
  assert.ok(!wfHtml.includes(DISCLAIMER))

  const factorHtml = renderFactorHtml(
    buildFactorReport({
      candles: noisyCandles(200, 5),
      horizon: 3,
      window: 20,
      quantiles: 5,
      top: 5,
      title: '免责测试',
      generatedAt: 1_700_000_000_000,
      source: { path: 'x.csv', sha256: 'c'.repeat(64), rows: 201, skipped: 0, duplicates: 0, format: 'csv' },
    }),
  )
  assert.ok(factorHtml.includes(DISCLAIMER))
  assert.ok(!factorHtml.includes(BACKTEST_DISCLAIMER))
})

test('sweep-report CLI：自动识别 sweep / walk-forward，类型不符与坏 JSON 返回 2', async () => {
  const dir = tempDir()
  try {
    const sweepPath = join(dir, 'sweep.json')
    const wfPath = join(dir, 'wf.json')
    writeFileSync(sweepPath, JSON.stringify(SWEEP), 'utf8')
    writeFileSync(wfPath, JSON.stringify({ folds: [], oosReturns: [], oosSharpe: 0, efficiency: null, holdout: null, embargoBars: 0, warnings: [] }), 'utf8')
    const cap = capture()
    assert.equal(await runSweep([sweepPath, '--top', '2'], cap.io), 0)
    assert.match(cap.out(), /3 组试验/)
    assert.ok(readFileSync(join(dir, 'sweep.sweep.md'), 'utf8').includes('| 1 * |'))
    assert.ok(readFileSync(join(dir, 'sweep.sweep.html'), 'utf8').includes('<style>'))

    const capWf = capture()
    assert.equal(await runSweep([wfPath], capWf.io), 0)
    assert.match(capWf.out(), /0 折/)

    const mismatch = capture()
    assert.equal(await runSweep([wfPath, '--kind', 'sweep'], mismatch.io), 2)
    assert.match(mismatch.err(), /缺 trials 数组/)

    const badJson = join(dir, 'bad.json')
    writeFileSync(badJson, '{not json', 'utf8')
    const bad = capture()
    assert.equal(await runSweep([badJson], bad.io), 2)
    assert.match(bad.err(), /读取结果 JSON 失败/)

    const unknown = capture()
    assert.equal(await runSweep([join(dir, 'missing.json')], unknown.io), 2)
    assert.match(unknown.err(), /读取结果 JSON 失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
