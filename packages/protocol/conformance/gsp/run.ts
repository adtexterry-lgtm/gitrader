// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs'
import { afterAll, describe, it } from 'vitest'
import { cases } from './cases'
import type { Target } from './target'

export function registerCases(target: Target): void {
  const results: { id: string; status: 'pass' | 'fail'; ms: number }[] = []
  describe(`GSP conformance (${target.kind})`, () => {
    for (const c of cases) it(`${c.id} ${c.title}`, async () => {
      const started = Date.now()
      let status: 'pass' | 'fail' = 'fail'
      try { await c.run(target); status = 'pass' }
      finally {
        await target.cleanup()
        results.push({ id: c.id, status, ms: Date.now() - started })
      }
    }, 20_000)
  })
  afterAll(() => {
    if (process.env.GSP_REPORT_PATH) writeFileSync(process.env.GSP_REPORT_PATH, JSON.stringify({
      suite: 'gsp-conformance', transport: target.kind, results,
      summary: { pass: results.filter(r => r.status === 'pass').length, fail: results.filter(r => r.status === 'fail').length },
    }, null, 2) + '\n')
  })
}
