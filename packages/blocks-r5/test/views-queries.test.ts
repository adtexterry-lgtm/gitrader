// SPDX-License-Identifier: CPAL-1.0
// 静态防再发：视图里写死的查询名必须在所属区块清单 inputs.queries 里（桥对没声明的查询直接 QUERY_NOT_ALLOWED，
// 「今日提议 —」就是 agents.tsx 查 risk.stats 而清单没声明）。总览六个视图能精确归属到区块；其余视图（图表 / 记录 / 资金 ……）归属靠页面映射太绕，
// 只断言落在「全部 r5 区块清单查询的并集」内。视图间接经钩子发的查询（useRisk / useStatus / useKeys）不在扫描范围，由 overview.test.ts 单点断言。
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Q } from '../../blocks-default/src/api'
import { r5Blocks } from '../src/index'

const viewsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/views')
const queriesOf = (id: string): Set<string> => new Set(r5Blocks.filter((b) => b.manifest.id === `block.gitrader.${id}`).flatMap((b) => b.manifest.inputs?.queries ?? []))
const union = new Set(r5Blocks.flatMap((b) => b.manifest.inputs?.queries ?? []))
const OWNER: Record<string, string[]> = {
  'risk.tsx': ['risk'], 'agents.tsx': ['agent-activity'], 'agent-grant.tsx': ['agent-activity'], 'activity.tsx': ['agent-activity'], 'pending.tsx': ['agent-activity'],
  'positions.tsx': ['positions'], 'fundcard.tsx': ['statusbar'],
}
/** useRes('x') / useRes(Q.x) / queryRetry(bridge, 'x') / bridge.query('x')（含泛型写法）里的查询名。 */
const CALL = /(?:useRes(?:<[^>()]*>)?\(|queryRetry(?:<[^>()]*>)?\(\s*(?:bridge|b),\s*|\bquery(?:<[^>()]*>)?\()\s*(?:'([a-z_]+(?:\.[a-z_]+)+)'|Q\.(\w+))/g

function scanned(file: string): string[] {
  const src = readFileSync(join(viewsDir, file), 'utf8')
  const found: string[] = []
  for (const m of src.matchAll(CALL)) {
    const name = m[1] ?? (m[2] ? (Q as Record<string, string>)[m[2]] : undefined)
    if (name) found.push(name)
  }
  return found
}

describe('r5 视图里写死的查询名都在区块清单内', () => {
  const files = readdirSync(viewsDir).filter((f) => f.endsWith('.tsx'))
  it('扫描器能抓到 agents.tsx 的 risk.stats（防止正则失效而空过）', () => {
    expect(scanned('agents.tsx')).toEqual(expect.arrayContaining(['risk.stats', 'agentkey.list', 'risk.state', 'account.list']))
  })
  it.each(files)('%s', (file) => {
    const owners = OWNER[file]
    for (const name of scanned(file)) {
      if (owners) expect(owners.some((id) => queriesOf(id).has(name)), `${file} 查询 ${name} 没有在区块 ${owners.join('/')} 的 inputs.queries 里声明`).toBe(true)
      else expect(union.has(name), `${file} 查询 ${name} 不在任何 r5 区块清单里`).toBe(true)
    }
  })
})
