// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C3：账本导出给人看 —— 账单.csv（本地时间、中文方向、执行方）、trade-log.md 本地时间、目录名、inline 回 files。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { mkOrigin } from '../src/util/origin'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  const note = (actor: Parameters<typeof mkOrigin>[0], tool: string): ReturnType<typeof mkOrigin> => mkOrigin(actor, tool, 'internal')
  h.k.ledger.append({ type: 'key.created', origin: note('user:usr_local', 'test'), subject: { orgId: 'org_local' }, payload: { keyId: 'KEY1', name: '我的Agent' } })
  h.k.ledger.append({
    type: 'fill', origin: note('user:usr_local', 'test.fill'), subject: { orgId: 'org_local', accountId: h.paper.accountId as never, instrumentId: 'sim:BTC' as never },
    payload: { price: '60000', size: '0.01', side: 'buy', fee: '0.3', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0' },
  })
  h.k.ledger.append({
    type: 'fill', origin: note('agent:KEY1', 'test.fill'), subject: { orgId: 'org_local', accountId: h.paper.accountId as never, instrumentId: 'sim:BTC' as never },
    payload: { price: '61000', size: '0.01', side: 'sell', fee: '0.3', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '9.7' },
  })
  h.k.ledger.append({
    type: 'fill', origin: note('venue:sim', 'test.fill'), subject: { orgId: 'org_local', accountId: h.paper.accountId as never, instrumentId: 'sim:ETH' as never },
    payload: { price: '2400', size: '1', side: 'buy', fee: '0', feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '-1.5' },
  })
})
afterEach(async () => { await h.cleanup() })

const call = (params: Record<string, unknown>): Promise<Record<string, any>> => // eslint-disable-line @typescript-eslint/no-explicit-any
  h.k.ops.call(h.k, 'ledger.export', { principal: h.session, params, transport: 'http' }) as Promise<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('账单.csv', () => {
  it('表头固定；只含 fill；时间是本地时间（非 ISO）；方向中文；执行方 你 / Agent 名字 / 系统；账户列是别名', async () => {
    const dir = join(h.home, 'export-human')
    h.k.ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), markdown: true })
    const raw = readFileSync(join(dir, '账单.csv'), 'utf8')
    expect(raw.charCodeAt(0)).toBe(0xfeff) // 磁盘件带 BOM，Excel 双击不乱码
    const csv = raw.slice(1)
    const rows = csv.trim().split('\n')
    expect(rows[0]).toBe('时间,账户,标的,方向,数量,价格,手续费,已实现盈亏,执行方')
    expect(rows).toHaveLength(4)
    for (const r of rows.slice(1)) {
      expect(r).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},/)
      expect(r).not.toMatch(/\dT\d|Z,/)
    }
    expect(rows[1]).toMatch(/^\S+ \S+,paper,/)
    expect(rows[1]).toMatch(/,sim:BTC,买入,0\.01,60000,0\.3,0,你$/)
    expect(rows[2]).toMatch(/,sim:BTC,卖出,0\.01,61000,0\.3,9\.7,我的Agent$/)
    expect(rows[3]).toMatch(/,sim:ETH,买入,1,2400,0,-1\.5,系统$/)
  })

  it('trade-log.md 的时间列是本地时间并在表头写明时区', async () => {
    const dir = join(h.home, 'export-human-md')
    h.k.ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), markdown: true })
    const md = readFileSync(join(dir, 'trade-log.md'), 'utf8')
    expect(md).toMatch(/\| 序号 seq \| 时间（本地，UTC[+-]\d{2}:\d{2}） \|/)
    const row = md.split('\n').find((l) => l.includes('| fill |'))!
    expect(row).toMatch(/^\| \d+ \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| fill \|/)
    expect(md).not.toMatch(/\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  })

  it('去载荷导出（redaction）不产出账单.csv', async () => {
    const dir = join(h.home, 'export-human-redact')
    h.k.ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), markdown: true, redaction: 'payload' })
    expect(existsSync(join(dir, '账单.csv'))).toBe(false)
  })
})

describe('ledger.export op', () => {
  it('默认目录名是本地时间 gitrader-ledger-YYYYMMDD-HHmmss；同一秒再导出加 -2；回包带 billName', async () => {
    const a = await call({})
    expect(a.dir).toMatch(/[\\/]exports[\\/]gitrader-ledger-\d{8}-\d{6}$/)
    expect(a.billName).toMatch(/^gitrader-账单-\d{8}-\d{4}\.csv$/)
    expect(existsSync(join(a.dir, '账单.csv'))).toBe(true)
    const b = await call({})
    expect(b.dir).toBe(`${a.dir}-2`)
    expect(a.files).toBeUndefined()
    expect(a.inline).toBeUndefined()
  })

  it('inline:true 回 files.bill / files.manifest，内容与落盘一致', async () => {
    const r = await call({ inline: true })
    expect(r.inline).toBe(true)
    expect(r.files.bill.charCodeAt(0)).not.toBe(0xfeff) // 回包不带 BOM，前端补
    expect(r.files.bill).toBe(readFileSync(join(r.dir, '账单.csv'), 'utf8').slice(1))
    expect(r.files.bill.split('\n')[0]).toBe('时间,账户,标的,方向,数量,价格,手续费,已实现盈亏,执行方')
    expect(JSON.parse(r.files.manifest).schema).toBe('gitrader-ledger-export/2')
    expect(r.files.manifest).toBe(readFileSync(join(r.dir, 'manifest.json'), 'utf8'))
  })
})
