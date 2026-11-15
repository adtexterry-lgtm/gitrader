// SPDX-License-Identifier: CPAL-1.0
// 差异表渲染：列固定、行数一致、转义与汇总正确；JSON 形态给脚本用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffRuns } from '../lib/diff.mjs'
import { renderMarkdown, toJson } from '../lib/report.mjs'
import { backtestRun, paperRun, absentPaper } from './fixtures/runs.mjs'

const COLUMNS = ['序号', '类别', '键', '字段', '回测', '纸面', '差异', '严重度', '判读']

test('Markdown：表头列固定，每个差异行都落在同一列数上', () => {
  const paper = paperRun()
  paper.fills[0] = { ...paper.fills[0], price: 100.4 }
  const diff = diffRuns(backtestRun(), paper)
  const md = renderMarkdown({ diff, backtest: backtestRun(), paper, meta: { generatedAt: '2026-01-01T00:00:00.000Z' } })
  const header = md.split('\n').find((l) => l.startsWith('| 序号 |'))
  assert.equal(header, `| ${COLUMNS.join(' | ')} |`)
  const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l))
  assert.equal(rows.length, diff.rows.length)
  for (const r of rows) assert.equal(r.split('|').length, COLUMNS.length + 2)
  assert.ok(md.includes('阻断 1'))
})

test('Markdown：判读文字里的竖线被转义，不会把表格撑坏', () => {
  const paper = paperRun()
  paper.notes = ['口径 A | 口径 B']
  const diff = diffRuns(backtestRun(), paper)
  diff.rows[0].judgement = '一侧 a|b 另一侧 c'
  const md = renderMarkdown({ diff, backtest: backtestRun(), paper })
  const row = md.split('\n').find((l) => l.includes('一侧 a'))
  assert.ok(row.includes('a\\|b'))
  // 未被转义的竖线才是列分隔符
  assert.equal(row.split(/(?<!\\)\|/).length, COLUMNS.length + 2)
})

test('Markdown：停机分支写出预检结论与「缺什么」，且明说不是一致', () => {
  const preflight = {
    verdict: 'stop',
    checks: [{ id: 'paper-clock-injection', ok: false, evidence: 'packages/cli/src/connectors.ts:181', detail: '硬接系统时钟' }],
    missing: [{ what: '配置加回放数据源', where: 'packages/kernel/src/config.ts', why: '用户开不出这条路' }],
  }
  const diff = diffRuns(backtestRun(), absentPaper())
  const md = renderMarkdown({ diff, backtest: backtestRun(), paper: absentPaper(), preflight })
  assert.ok(md.includes('能力预检：停机'))
  assert.ok(md.includes('### 缺什么'))
  assert.ok(md.includes('packages/kernel/src/config.ts'))
  assert.ok(md.includes('不是一致'))
  assert.ok(md.includes('partly-unverifiable'))
})

test('toJson：结构与计数可直接给脚本消费', () => {
  const paper = paperRun()
  const diff = diffRuns(backtestRun(), paper)
  const j = toJson({ diff, backtest: backtestRun(), paper, preflight: { verdict: 'stop' }, meta: { generatedAt: '2026-01-01T00:00:00.000Z' } })
  assert.equal(j.format, 'gitrader-parity-diff/1')
  assert.equal(j.summary.total, diff.rows.length)
  assert.equal(j.preflight.verdict, 'stop')
  assert.equal(j.sides.backtest.capabilities.orders, false)
  assert.equal(j.sides.paper.capabilities.orders, true)
  assert.equal(j.rows.length, diff.rows.length)
  assert.equal(JSON.parse(JSON.stringify(j)).rows.length, diff.rows.length)
})
