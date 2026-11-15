// SPDX-License-Identifier: CPAL-1.0
// 数据摘要：对结果的可复现投影算 sha256，用于「这份报告对应哪一版结果」。
import { createHash } from 'node:crypto'
import type { BacktestResult } from './types'

/** 稳定 JSON：对象键按字典序，数组保序，数字保留原值。 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`
}

/** 结果投影：只取影响报告内容的字段，避免 jobId / 生成时间这类每次不同的字段污染摘要。 */
export function reportPayload(result: BacktestResult): Record<string, unknown> {
  return {
    stats: result.stats,
    equity: result.equity,
    trades: result.trades,
    params: result.params ?? null,
    assumptions: result.assumptions ?? null,
    trialCount: result.trialCount ?? 1,
    engine: result.engine ?? null,
  }
}

/** 16 进制 sha256。 */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

/** 报告里显示的数据摘要：结果自带 dataDigest 优先，否则按投影算。 */
export function reportDigest(result: BacktestResult): string {
  return result.dataDigest ?? sha256Hex(reportPayload(result))
}
