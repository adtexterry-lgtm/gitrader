// SPDX-License-Identifier: CPAL-1.0
// 报告的组装、Markdown 渲染与落盘（JSON + Markdown 同源，避免两份数字打架）。
// 口径照 docs/perf-baseline.md：p50 / p95、首次与热启分开、全部离线、不算收益承诺。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERF_BASELINE } from './baseline.mjs'
import { humanizeCount, roundTo } from './stats.mjs'

/** 零承诺语言自检清单（照 WO-batch-2 总则的红线 5，加了英文对应词）。 */
export const PROMISE_WORDS = Object.freeze([
  '保' + '守', '激' + '进', '稳' + '赚', '跑' + '赢', '稳定' + '盈利', '保证收益', '零风险', 'risk-free', 'guaranteed', 'outperform', 'steady profit',
])

/** 找出文本里的禁词（返回命中的词，大小写不敏感）。 */
export function findPromiseWords(text) {
  const lower = String(text).toLowerCase()
  return PROMISE_WORDS.filter((w) => lower.includes(w.toLowerCase()))
}

const fmt = (x, d = 2) => (Number.isFinite(x) ? String(roundTo(x, d)) : '—')

/**
 * 组装报告对象（纯函数，不读时钟、不读环境——时间与环境由调用方传入，测试才能断言）。
 */
export function buildReport({ params, env, backtest = null, indicators = null, render = null, memoryRssMb = null }) {
  const strategies = backtest?.strategies ?? []
  const bestBarsPerSec = strategies.length > 0 ? Math.max(...strategies.map((s) => s.barsPerSec).filter(Number.isFinite)) : null
  const target = PERF_BASELINE.suggestedBarsPerSec
  return {
    suite: 'gitrader-tools-bench',
    schemaVersion: 1,
    generatedAt: env?.generatedAt ?? null,
    env: env ?? null,
    params,
    baseline: PERF_BASELINE,
    backtest,
    indicators,
    render,
    memoryRssMb,
    verdict: {
      targetBarsPerSec: target,
      bestBarsPerSec: Number.isFinite(bestBarsPerSec) ? bestBarsPerSec : null,
      backtestTargetMet: Number.isFinite(bestBarsPerSec) ? bestBarsPerSec >= target : null,
      note: '门槛只对同机同根数有意义；跨机只比数量级。',
    },
  }
}

function backtestSection(b) {
  if (b === null || b === undefined) return ['_本次未跑（--only 未包含 backtest）。_', '']
  const rows = [
    '| 策略 | K 线根数 | 首次 ms | 热启 p50 ms | 热启 p95 ms | 根 / 秒 | 成交笔数 |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const s of b.strategies) {
    rows.push(`| ${s.id} | ${b.bars} | ${fmt(s.firstMs, 1)} | ${fmt(s.warm.p50Ms, 1)} | ${fmt(s.warm.p95Ms, 1)} | ${humanizeCount(s.barsPerSec)} | ${s.fills} |`)
  }
  const warm = b.warm
  rows.push('')
  rows.push(
    `合计口径：${b.bars} 根合成 1m K 线，${b.runs} 轮（第 1 轮为首次，其余热启），数据生成 ${fmt(b.dataGenMs, 1)} ms 不计入。` +
      (warm === null ? '' : ` 全体策略热启 p50 ${fmt(warm.p50Ms, 1)} ms / p95 ${fmt(warm.p95Ms, 1)} ms。`),
  )
  const base = PERF_BASELINE.backtestThroughputBarsPerSec
  rows.push('')
  rows.push(
    `既有口径（${PERF_BASELINE.doc} ${PERF_BASELINE.revision}）：${humanizeCount(base.min)}–${humanizeCount(base.max)} 根 / 秒（${base.note}）。` +
      '该区间出自 `bench/engine/run.mjs`：与本脚本同五个策略、同参数（含 anchor 后的参数）、同数据；' +
      '它的统计量是含首次在内的各轮中位数，本表「根 / 秒」是热启 p50，两者只作参考并排，同机同代码才可比。' +
      `建议门槛 N = ${humanizeCount(PERF_BASELINE.suggestedBarsPerSec)} 根 / 秒。`,
  )
  rows.push('')
  return rows
}

function indicatorSection(s) {
  if (s === null || s === undefined) return ['_本次未跑（--only 未包含 indicators）。_', '']
  const rows = ['| 指标 | 热启 p50 ms | p95 ms | 根·指标 / 秒 |', '|---|---|---|---|']
  for (const it of s.items) {
    rows.push(`| ${it.name} | ${fmt(it.p50Ms, 2)} | ${fmt(it.p95Ms, 2)} | ${humanizeCount(it.barsPerSec)} |`)
  }
  rows.push('')
  rows.push(
    `整轮 ${s.count} 个指标 × ${s.bars} 根：热启 p50 ${fmt(s.sweepMs.p50Ms, 1)} ms / p95 ${fmt(s.sweepMs.p95Ms, 1)} ms，` +
      `合计 ${humanizeCount(s.throughputPerSec)} 根·指标 / 秒。既有口径无此项（本脚本新增口径：单线程、整序列、含预热期 null）。`,
  )
  rows.push('')
  return rows
}

function renderSection(r) {
  if (r === null || r === undefined) return ['_本次未跑（--only 未包含 render）。_', '']
  const rows = ['| 渲染 | 首次 ms | 热启 p50 ms | 热启 p95 ms | 输出字节 |', '|---|---|---|---|---|']
  for (const it of r.items) {
    rows.push(`| ${it.name} | ${fmt(it.firstMs, 1)} | ${fmt(it.p50Ms, 1)} | ${fmt(it.p95Ms, 1)} | ${it.bytes} |`)
  }
  rows.push('')
  rows.push(
    `合成结果：${r.points} 个权益点、${r.trades} 笔成交，渲染 ${r.rounds} 轮（第 1 轮为首次）。` +
      '既有口径无此项（本脚本新增口径：纯函数渲染，不含读盘与写盘）。',
  )
  rows.push('')
  return rows
}

/** 报告对象 → Markdown（一份给人看，JSON 给机器看）。 */
export function renderMarkdownReport(report) {
  const out = []
  out.push('# Gitrader 性能基准（tools/bench）', '')
  out.push(`生成时间：${report.generatedAt ?? '—'}　·　套件：\`${report.suite}\` schema ${report.schemaVersion}`, '')
  const env = report.env ?? {}
  out.push(`环境：${env.cpu ?? '—'}（${env.cores ?? '?'} 逻辑核）· ${env.platform ?? '—'} · Node ${env.node ?? '—'}`, '')
  out.push('## 口径', '')
  for (const c of PERF_BASELINE.caveats) out.push(`- ${c}`)
  out.push('')
  out.push(
    `本次参数：\`--bars ${report.params?.bars ?? '?'} --runs ${report.params?.runs ?? '?'} --rounds ${report.params?.rounds ?? '?'}` +
      ` --render-rounds ${report.params?.renderRounds ?? '?'}\`，策略 ${JSON.stringify(report.params?.strategies ?? [])}。`,
    '',
  )

  out.push('## 1. 回测吞吐', '')
  out.push(...backtestSection(report.backtest))
  out.push('## 2. 指标库吞吐', '')
  out.push(...indicatorSection(report.indicators))
  out.push('## 3. 报告渲染耗时', '')
  out.push(...renderSection(report.render))

  out.push('## 4. 判定与说明', '')
  const v = report.verdict ?? {}
  if (v.backtestTargetMet === true) {
    out.push(`- 回测吞吐最好一条：${humanizeCount(v.bestBarsPerSec)} 根 / 秒，达到建议门槛 N = ${humanizeCount(v.targetBarsPerSec)} 根 / 秒（同机、同根数下）。`)
  } else if (v.backtestTargetMet === false) {
    out.push(`- 回测吞吐最好一条：${humanizeCount(v.bestBarsPerSec)} 根 / 秒，**未达**建议门槛 N = ${humanizeCount(v.targetBarsPerSec)} 根 / 秒；如实记录，不作为产品承诺。`)
  } else {
    out.push('- 本次未跑回测吞吐，无判定。')
  }
  out.push(`- ${v.note ?? ''}`)
  if (report.memoryRssMb !== null && report.memoryRssMb !== undefined) out.push(`- 进程 RSS：${report.memoryRssMb} MB（旁证，不是内存指标）。`)
  out.push('- 复现：`node tools/bench/run.mjs`（默认 10 万根）；要与 `docs/perf-baseline.md` 直接并排，用 `--bars 525600`。')
  out.push('- 全部离线：不联网、不读密钥、不写仓库内数据文件（只写 `--out` 指定的目录）。')
  out.push('')
  return out.join('\n')
}

/**
 * 落盘：JSON + Markdown 写进同一目录（自动建目录），返回两个路径。
 * @param {object} report
 * @param {{outDir: string, jsonName?: string, mdName?: string}} o
 */
export function writeReports(report, o) {
  if (typeof o?.outDir !== 'string' || o.outDir.length === 0) throw new TypeError('writeReports: 需要 outDir')
  const dir = o.outDir
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, o.jsonName ?? 'bench.json')
  const mdPath = join(dir, o.mdName ?? 'bench.md')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  writeFileSync(mdPath, renderMarkdownReport(report), 'utf8')
  return { jsonPath, mdPath }
}
