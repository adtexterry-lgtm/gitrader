// SPDX-License-Identifier: CPAL-1.0
// Prometheus 告警规则与内核指标的一致性：规则里出现的指标名、事件主题、交易状态都必须在内核源码里找得到。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRADING_STATES } from '@gitrader/protocol'
import { EVENT_TOPICS } from '../src/events'

/** 从当前工作目录向上找含 ops/prometheus/alerts.yml 的仓库根。 */
const repoRoot = (): string => {
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, 'ops', 'prometheus', 'alerts.yml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('ops/prometheus/alerts.yml not found')
    dir = parent
  }
}

const root = repoRoot()
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8')
const alertsText = read('ops', 'prometheus', 'alerts.yml')
const metricsSrc = read('packages', 'kernel', 'src', 'metrics.ts')
const eventsSrc = read('packages', 'kernel', 'src', 'events.ts')

interface Rule { name: string; expr: string; forClause: string; severity: string; block: string }

/** 逐行切出 `- alert:` 开头的规则块，再从块里取 expr / for / labels.severity。 */
const parseRules = (text: string): Rule[] => {
  const out: Rule[] = []
  let cur: string[] = []
  const flush = (): void => {
    if (cur.length === 0) return
    const block = cur.join('\n')
    const name = /- alert:\s*([A-Za-z0-9_]+)/.exec(block)?.[1] ?? ''
    const expr = /^\s*expr:\s*(\S.*)$/m.exec(block)?.[1]?.trim() ?? ''
    const forClause = /^\s*for:\s*(\S+)\s*$/m.exec(block)?.[1] ?? ''
    const labelsAt = block.search(/^\s*labels:\s*$/m)
    const sev = /^\s*severity:\s*(\S+)\s*$/m.exec(block)
    const sevValue = sev?.[1]
    const severity = labelsAt >= 0 && sev !== null && sev.index > labelsAt && sevValue !== undefined ? sevValue : ''
    out.push({ name, expr, forClause, severity, block })
    cur = []
  }
  for (const line of text.split('\n')) {
    const isAlert = /^\s*- alert:/.test(line)
    if (isAlert) flush()
    if (isAlert || cur.length > 0) cur.push(line)
  }
  flush()
  return out
}

const rules = parseRules(alertsText)

const distinct = (pattern: RegExp): string[] => {
  const found = new Set<string>()
  for (const rule of rules) for (const m of rule.expr.matchAll(pattern)) if (m[1] !== undefined) found.add(m[1])
  return [...found]
}

describe('ops/prometheus/alerts.yml', () => {
  it('文件头注明改编来源', () => {
    const head = alertsText.split('\n').slice(0, 3).join('\n')
    expect(head).toContain('Adapted from QuantDinger')
  })

  it('至少 6 条规则，每条都有 expr、for 与 labels.severity', () => {
    expect(rules.length).toBeGreaterThanOrEqual(6)
    for (const rule of rules) {
      expect(rule.name, 'alert name').toMatch(/^Gitrader[A-Za-z0-9]+$/)
      expect(rule.expr, `${rule.name} expr`).not.toBe('')
      expect(rule.forClause, `${rule.name} for`).toMatch(/^\d+[smhd]$/)
      expect(rule.severity, `${rule.name} severity`).toMatch(/^(critical|warning|info)$/)
    }
  })

  it('expr 里的指标名都存在于 metrics.ts', () => {
    const names = new Set<string>()
    for (const rule of rules) for (const m of rule.expr.matchAll(/gitrader_[a-z_]+/g)) names.add(m[0])
    expect(names.size).toBeGreaterThan(0)
    for (const name of names) {
      expect(new RegExp(`${name}(?![a-z0-9_])`).test(metricsSrc), `metrics.ts 缺指标 ${name}`).toBe(true)
    }
  })

  it('expr 里的 topic 标签值都在 events.ts 的 EVENT_TOPICS 里', () => {
    const topics = distinct(/topic="([^"]*)"/g)
    expect(topics.length).toBeGreaterThan(0)
    expect(eventsSrc).toContain('EVENT_TOPICS')
    for (const topic of topics) {
      expect(EVENT_TOPICS as readonly string[], `EVENT_TOPICS 缺主题 ${topic}`).toContain(topic)
    }
  })

  it('expr 里的 state 标签值都在交易状态枚举里', () => {
    const states = distinct(/state="([^"]*)"/g)
    expect(states.length).toBeGreaterThan(0)
    for (const state of states) {
      expect(TRADING_STATES as readonly string[], `TRADING_STATES 缺状态 ${state}`).toContain(state)
    }
  })
})
