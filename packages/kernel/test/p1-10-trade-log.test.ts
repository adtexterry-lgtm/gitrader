// SPDX-License-Identifier: CPAL-1.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { mkOrigin } from '../src/util/origin'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

describe('trade log markdown readability', () => {
  it('trade log uses key names, splits decisions and shows fills', async () => {
    h = await makeHarness()
    const ledger = h.k.ledger
    ledger.append({
      type: 'key.created', origin: mkOrigin('user:usr_local', 'test.key', 'internal'), subject: { orgId: 'org_local' as never },
      payload: { keyId: 'key_abc', name: '交易助手', host: 'claude-code', tier: 'confirm' },
    })
    ledger.append({
      type: 'proposal.decided', origin: mkOrigin('agent:key_abc', 'test.propose', 'internal'),
      subject: { proposalId: 'prop_1' as never, ticket: 'T-1001' as never, accountId: 'acct_test' as never },
      payload: { decision: 'approved' },
    })
    ledger.append({
      type: 'proposal.decided', origin: mkOrigin('agent:key_abc', 'test.propose', 'internal'),
      subject: { proposalId: 'prop_2' as never, ticket: 'T-1002' as never, accountId: 'acct_test' as never },
      payload: { decision: 'rejected', note: '超出单笔上限' },
    })
    ledger.append({
      type: 'fill', origin: mkOrigin('agent:key_abc', 'test.fill', 'internal'),
      subject: { accountId: 'acct_test' as never, instrumentId: 'BTC' as never, orderId: 'ord_1' as never, clientOrderId: 'c1', fillId: 'fill_1' as never },
      payload: { side: 'buy', size: '0.01', price: '80000', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '12.5', venueTs: 0 },
    })
    const dir = join(h.home, 'export-p1-10')
    ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), markdown: true })
    const md = readFileSync(join(dir, 'trade-log.md'), 'utf8')
    expect(md).toContain('检查点：每 1000 条或每 1 小时一个（seq 0 为创世）')
    // fix-r4: 导出前内核会补一枚检查点（导出尾部必带），所以不再出现「本段尚无检查点」
    expect(md).not.toContain('本段尚无检查点')
    expect(md).toContain('| checkpoint |')
    expect(md).toContain('交易助手')
    expect(md).not.toContain('agent:key_abc')
    expect(md).toContain('批准 T-1001')
    expect(md).toContain('拒绝 T-1002')
    expect(md).toContain('理由：超出单笔上限')
    expect(md).toContain('买入 0.01 @ 80000')
    expect(md).toContain('盈亏 12.5')
  })
})
