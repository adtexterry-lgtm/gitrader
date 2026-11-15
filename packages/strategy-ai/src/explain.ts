// SPDX-License-Identifier: CPAL-1.0
// 把一次生成的完整结果写成人能读的 Markdown：请求 → 结果 → 最终策略 → 静态检查 → 冒烟回测 → 每一轮 → 说明。
// 只陈述「跑过什么、算出来什么」，不写任何关于以后的说法；描述性文字里不出现结果承诺类用语
// （测试用 protocol 的 `findPromiseLanguage` 扫输出）。
//
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/ai_calibration.py:162-311; adapted
// (QD keeps a per-run record of decisions and measured outcomes so the caller can audit how a threshold was reached;
// here the same "keep the measured facts, drop the forecast" rule shapes the report: history only, no推断 numbers).
import type { GenerationResult, RepairAttempt, SmokeSummary, StaticIssue } from './types'

const UNKNOWN = '（未声明）'

/** 从源码里读一个字符串字段；读不出就是未声明（报告不编造）。 */
function stringField(code: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*:\\s*(['"\`])([^'"\`\\n]*)\\1`)
  return re.exec(code)?.[2] ?? UNKNOWN
}

const pct = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`
const money = (value: number): string => value.toFixed(2)

function issueLines(issues: readonly StaticIssue[]): string[] {
  if (issues.length === 0) return ['- 无']
  return issues.map((i) => `- \`${i.rule}\`${i.line === undefined ? '' : ` 第 ${i.line} 行`}：${i.message}`)
}

function smokeLines(s: SmokeSummary): string[] {
  const head = `- K 线 ${s.bars} 根，成交 ${s.trades} 笔（${s.fills} 次成交），期末权益 ${money(s.finalEquity)}，手续费 ${money(s.feesPaid)}，最大回撤 ${pct(s.maxDrawdownRatio)}`
  const tail = `- 强平 ${s.liquidations} 次，未成交占比 ${pct(s.unfilledShare)}`
  const warn = s.warnings.length === 0 ? [] : ['- 加载警告：', ...s.warnings.map((w) => `  - ${w}`)]
  return [head, tail, ...warn]
}

function statusLine(result: GenerationResult): string {
  if (result.stopped === 'passed') return result.rounds === 0 ? '- 状态：首次生成即通过静态检查与冒烟回测' : `- 状态：第 ${result.rounds} 轮修复后通过静态检查与冒烟回测`
  if (result.stopped === 'llm-error') return `- 状态：中断——注入的 client 在${result.attempts.length === 0 ? '首次生成' : `第 ${result.attempts.length + 1} 次调用`}时失败（${result.error ?? '原因未知'}）`
  return `- 状态：未通过——${result.rounds} 轮修复（上限 ${result.maxRounds} 轮）之后仍有失败`
}

function attemptRow(a: RepairAttempt): string {
  // 冒烟跑过就说明静态检查过了；此时 a.issues 存的是加载器 / 回测报的错，不能算进「静态检查」列。
  const checks = a.smoke === undefined ? (a.issues.length === 0 ? '通过' : `${a.issues.length} 条`) : '通过'
  const smokeCell = a.smoke === undefined ? '未运行' : a.smoke.ok ? `成交 ${a.smoke.trades} 笔` : '失败'
  const verdict = a.ok ? '采用' : '退回'
  return `| ${a.round} | ${checks} | ${smokeCell} | ${verdict} |`
}

/** 生成可给用户看的报告。纯函数，不读时间、不读环境。 */
export function explain(result: GenerationResult): string {
  const { spec } = result
  const calls = result.attempts.length === 0 ? 0 : result.attempts.length
  const out: string[] = []
  out.push('# 策略生成报告', '')
  out.push('本报告只写跑过什么、算出什么；所有数字都来自历史数据上的回测，不含对以后的任何说法。', '')

  out.push('## 请求', '')
  out.push(`- 意图：${spec.intent.trim() === '' ? '（未填写）' : spec.intent.trim()}`)
  out.push(`- 风格：${spec.style ?? 'custom'}`)
  out.push(`- 标的提示：${spec.instrumentHint ?? '未指定'}`)
  out.push(`- 周期：${spec.interval ?? '未指定'}`)
  const constraints = (spec.constraints ?? []).map((c) => c.trim()).filter((c) => c !== '')
  out.push(`- 约束：${constraints.length === 0 ? '无' : ''}`)
  for (const c of constraints) out.push(`  - ${c}`)
  out.push('')

  out.push('## 结果', '')
  out.push(statusLine(result))
  out.push(`- 生成调用：${calls} 次（首次生成 1 次，修复轮 ${Math.max(0, calls - 1)} 次）`)
  out.push(`- 修复轮上限：${result.maxRounds}`)
  out.push('')

  out.push(result.ok ? '## 最终策略' : '## 最终策略（最后一版，未采用）', '')
  if (result.code.trim() === '') {
    out.push('- 没有产出代码')
  } else {
    out.push(`- id：${stringField(result.code, 'id')}`)
    out.push(`- 版本：${stringField(result.code, 'version')}`)
    out.push(`- 描述：${stringField(result.code, 'desc')}`)
  }
  out.push('')

  out.push('## 最后一版的失败清单', '')
  out.push('静态检查与加载器 / 回测报的错都在这里，规则名以引擎实际报的为准。', '')
  out.push(...issueLines(result.final.issues))
  out.push('')

  out.push('## 冒烟回测（合成 K 线，历史数据）', '')
  if (result.final.smoke === undefined) out.push('- 未运行（静态检查未通过，没有进入回测）')
  else out.push(...smokeLines(result.final.smoke))
  out.push('')

  out.push('## 每一轮', '')
  out.push('| 轮 | 静态检查 | 冒烟回测 | 结果 |', '|---|---|---|---|')
  for (const a of result.attempts) out.push(attemptRow(a))
  if (result.attempts.length === 0) out.push('| — | — | — | 没有产出可检查的代码 |')
  out.push('')

  out.push('## 说明', '')
  out.push('- 产物是一个普通策略文件：用户可以读、可以改，引擎在加载时会再跑一遍完整校验。')
  out.push('- 上面的权益与回撤是生成数据上的历史结果，不是预测，也不构成任何建议。')
  out.push('- 本次运行没有人工审阅生成的代码；文件不进仓库、不落盘（冒烟用的是临时文件，跑完即删）。')
  return out.join('\n') + '\n'
}
