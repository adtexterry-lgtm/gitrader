// SPDX-License-Identifier: CPAL-1.0
// 报告渲染：把寻优结果写成 markdown 文本。首屏第一行按证据等级决定——
// 没有任何样本外证据时第一行必须是「样本内，不可作为前向证据」，不许把样本内数字排在前面。
import { describeOverfit } from './overfit'
import { IN_SAMPLE_BANNER, type OptimizeResult } from './optimize'
import type { Params } from './space'
import type { WarmupSource } from './warmup'

/** 预热来源的人话（报告里直接印，省得读代码猜）。 */
const WARMUP_SOURCE_LABEL: Record<WarmupSource, string> = {
  explicit: '调用方指定',
  params: '按参数名推上界',
  none: '没设',
}

function formatParams(params: Params): string {
  const keys = Object.keys(params).sort()
  if (keys.length === 0) return '（无参数）'
  return keys.map((key) => `${key}=${String(params[key])}`).join(', ')
}

/** 首屏第一行：有样本外证据就说清是什么证据，没有就直接挂样本内横幅。 */
export function reportHeadline(result: OptimizeResult): string {
  if (result.inSampleOnly) return IN_SAMPLE_BANNER
  const validation = result.validation
  if (validation.kind === 'holdout' && validation.holdout !== null) {
    const bars = validation.holdout.holdout[1] - validation.holdout.holdout[0]
    return `样本外证据：留出期 ${bars} 根（未参与寻优）`
  }
  const folds = validation.folds.length
  return `样本外证据：walk-forward ${folds} 折（样本外收益 ${validation.oosReturns.length} 期）`
}

export function renderReport(result: OptimizeResult, opts?: { title?: string }): string {
  const title = opts?.title ?? '参数寻优报告'
  const lines: string[] = []
  lines.push(reportHeadline(result))
  lines.push('')
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`- 搜索方式: ${result.searchKind}（种子 ${result.seed}）`)
  lines.push(`- 寻优区间: [${result.searchRange[0]}, ${result.searchRange[1]})（留出期与盲段不参与寻优、PBO、DSR）`)
  lines.push(`- 预热: 前 ${result.warmup.bars} 根不计分（来源 ${WARMUP_SOURCE_LABEL[result.warmup.source]}），计分区间 [${result.scoringRange[0]}, ${result.scoringRange[1]})`)
  lines.push(`- 样本内最优参数: ${result.best === null ? '无' : formatParams(result.best.params)}`)
  if (result.best !== null) lines.push(`- 最优样本内分数: ${result.best.score.toFixed(6)}（每期 Sharpe ${result.best.sharpe.toFixed(6)}）`)
  lines.push('')
  lines.push('## 过拟合指标（强制）')
  lines.push('')
  lines.push('```')
  lines.push(describeOverfit(result.overfit))
  lines.push('```')
  lines.push('')
  lines.push('## 样本外验证')
  lines.push('')
  if (result.validation.kind === 'walk-forward' && result.validation.folds.length > 0) {
    lines.push('| 折 | 训练窗 | 测试窗 | 训练分数 | 测试分数 |')
    lines.push('|---|---|---|---|---|')
    for (const fold of result.validation.folds) {
      lines.push(
        `| ${fold.index} | [${fold.train[0]}, ${fold.train[1]}) | [${fold.test[0]}, ${fold.test[1]}) | ${fold.trainScore.toFixed(4)} | ${fold.testScore.toFixed(4)} |`,
      )
    }
    lines.push('')
    lines.push(`- 样本外分数: ${result.validation.oosScore === null ? '不可计算' : result.validation.oosScore.toFixed(6)}`)
    lines.push(`- 效率比（平均测试/平均训练）: ${result.validation.efficiency === null ? '不可计算' : result.validation.efficiency.toFixed(4)}`)
  } else if (result.validation.holdout !== null) {
    const holdout = result.validation.holdout
    lines.push(`- 样本内区间: [${holdout.sample[0]}, ${holdout.sample[1]})，留出期: [${holdout.holdout[0]}, ${holdout.holdout[1]})`)
    lines.push(`- 留出期分数: ${holdout.score.toFixed(6)}（训练侧 ${holdout.trainScore.toFixed(6)}）`)
  } else {
    lines.push('- 无样本外结果')
  }
  if (result.warnings.length > 0) {
    lines.push('')
    lines.push('## 提示')
    lines.push('')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}
