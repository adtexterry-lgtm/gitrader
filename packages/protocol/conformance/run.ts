// SPDX-License-Identifier: Apache-2.0
// 把用例登记成 vitest 测试，并生成 gep-conformance-report.json（环境变量 GEP_REPORT_PATH 指定位置）。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, it } from 'vitest'
import { PROTOCOL_PACKAGE_VERSION, GEP_SUPPORTED_VERSIONS, canonicalize, type EngineDescribe } from '../src'
import { PERF } from './cases/optional'
import type { Case } from './cases/common'
import type { Target } from './target'

export class SkipSignal extends Error {
  constructor(readonly reason: string) { super(reason) }
}

export interface CaseResult { id: string; title: string; status: 'pass' | 'fail' | 'skip'; ms: number; note?: string; error?: unknown }

export async function runCase(c: Case, t: Target): Promise<CaseResult> {
  const t0 = Date.now()
  try {
    await c.run(t, (reason) => { throw new SkipSignal(reason) })
    return { id: c.id, title: c.title, status: 'pass', ms: Date.now() - t0 }
  } catch (e) {
    if (e instanceof SkipSignal) return { id: c.id, title: c.title, status: 'skip', ms: Date.now() - t0, note: e.reason }
    return { id: c.id, title: c.title, status: 'fail', ms: Date.now() - t0, error: e, note: e instanceof Error ? e.message : String(e) }
  } finally {
    await t.cleanup()
  }
}

const collected: CaseResult[] = []

export function registerCases(suite: string, cases: readonly Case[], t: Target, caps: EngineDescribe['capabilities']): void {
  describe(suite, () => {
    for (const c of cases) {
      const supported = (c.requires ?? []).every((k) => (caps as Record<string, unknown>)[k] === true)
      if (!supported) {
        collected.push({ id: c.id, title: c.title, status: 'skip', ms: 0, note: `engine does not declare ${(c.requires ?? []).join(' + ')}` })
        it.skip(`${c.id} ${c.title}`, () => {})
        continue
      }
      it(`${c.id} ${c.title}`, async (ctx) => {
        const r = await runCase(c, t)
        collected.push(r)
        if (r.status === 'skip') ctx.skip(r.note)
        if (r.status === 'fail') throw r.error
      }, 120_000)
    }
  })
}

export function registerTodos(suite: string, items: readonly { id: string; title: string; criteria: string }[], applicable: boolean): void {
  describe(suite, () => {
    for (const it_ of items) {
      collected.push({ id: it_.id, title: it_.title, status: 'skip', ms: 0, note: applicable ? `not implemented: ${it_.criteria}` : 'engine does not declare execution.modeB' })
      it.todo(`${it_.id} ${it_.title} — ${it_.criteria}`)
    }
  })
}

/** 写报告：同一路径被多个测试文件写入时按 id 合并。 */
export function registerReport(t: Target, d: EngineDescribe): void {
  afterAll(() => {
    const path = process.env['GEP_REPORT_PATH']
    if (!path) return
    let prev: { results?: CaseResult[]; performance?: Record<string, unknown> } = {}
    if (existsSync(path)) { try { prev = JSON.parse(readFileSync(path, 'utf8')) } catch { /* start over */ } }
    const byId = new Map<string, Omit<CaseResult, 'error'>>()
    for (const r of prev.results ?? []) byId.set(r.id, r)
    for (const { error: _e, ...r } of collected) byId.set(r.id, r)
    const results = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
    const report = {
      suite: 'gep-conformance', suiteVersion: PROTOCOL_PACKAGE_VERSION, gepVersions: GEP_SUPPORTED_VERSIONS, target: t.label, transport: t.kind,
      describeDigest: `sha256:${createHash('sha256').update(canonicalize(d)).digest('hex')}`, generatedAt: new Date().toISOString(),
      summary: { pass: results.filter((r) => r.status === 'pass').length, fail: results.filter((r) => r.status === 'fail').length, skip: results.filter((r) => r.status === 'skip').length },
      performance: { ...(prev.performance ?? {}), ...PERF },
      results,
    }
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
  })
}
