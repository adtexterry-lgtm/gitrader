// SPDX-License-Identifier: CPAL-1.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { mkOrigin } from '../src/util/origin'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

describe('exported trade log headers are localized', () => {
  it('uses localized title and table header in trade-log.md', async () => {
    h = await makeHarness()
    const ledger = h.k.ledger
    ledger.append({
      type: 'proposal.decided', origin: mkOrigin('user:usr_local', 'test.propose', 'internal'),
      subject: { proposalId: 'prop_f9' as never, ticket: 'T-F9' as never, accountId: 'acct_test' as never },
      payload: { decision: 'approved' },
    })
    const dir = join(h.home, 'export-f9')
    ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), markdown: true })
    const md = readFileSync(join(dir, 'trade-log.md'), 'utf8')
    const lines = md.split('\n')
    expect(lines[0]).toBe('# Gitrader 交易记录（trade log）')
    // fix-r4: 交易记录时间列改为本地时间，表头注明时区（UTC±hh:mm），不再是 UTC
    const headerRe = /^\| 序号 seq \| 时间（本地，UTC[+-]\d{2}:\d{2}） \| 类型 \| 执行方 \| 对象 \| 命中规则 \|$/
    const headerLine = lines.find((l) => l.startsWith('| 序号 seq'))
    expect(headerLine).toMatch(headerRe)
    expect(md).not.toContain('time (UTC)')
  })
})
