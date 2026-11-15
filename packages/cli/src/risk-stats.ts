// SPDX-License-Identifier: CPAL-1.0
// `gitrader risk stats` 的中文渲染：按人（actor）/ 按规则汇总拦截与转人工。
import { RULE_LABEL } from '../../blocks-default/src/labels'
import type { RiskStats } from '../../kernel/src/risk'

const label = (code: string): string => (RULE_LABEL as Record<string, string>)[code] ?? code

function sortedRows(rules: RiskStats['byRule']): Array<[string, number]> {
  return Object.entries(rules)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0])))
}

export function formatRiskStats(stats: RiskStats, by: 'actor' | 'rule', names: Record<string, string>): string {
  if (by === 'rule') return sortedRows(stats.byRule).map(([code, n]) => `${label(code)}：${n}`).join('\n')
  return Object.entries(stats.byActor)
    .map(([actor, bucket]) => ({ name: names[actor] ?? (actor.startsWith('agent:') ? names[actor.slice('agent:'.length)] : undefined) ?? actor, bucket }))
    .filter(({ bucket }) => bucket.denied > 0 || bucket.review > 0)
    .sort((a, b) => (b.bucket.denied + b.bucket.review) - (a.bucket.denied + a.bucket.review) || a.name.localeCompare(b.name))
    .map(({ name, bucket }) => {
      const rules = sortedRows(bucket.rules).map(([code, n]) => `${label(code)} ${n}`).join('、')
      return `${name}：拦 ${bucket.denied}${rules ? `（${rules}）·` : ' ·'} 转人工 ${bucket.review}`
    })
    .join('\n')
}
