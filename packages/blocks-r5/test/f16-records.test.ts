// SPDX-License-Identifier: CPAL-1.0
// WI-F16：总条数提示、执行方下拉的 Agent 钥匙项、按 actor 的筛选参数；外加内核 actor 筛的一条用例。
import { afterEach, describe, expect, it } from 'vitest'
import { actorFilters, agentActorOptions, loadedNote, pageOf, queryParams } from '../src/model-records'
import { billDownload } from '../src/views/records'
import { makeHarness } from '../../kernel/test/helpers/harness'
import type { Harness } from '../../kernel/test/helpers/harness'
import { mkOrigin } from '../../kernel/src/util/origin'

const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime()

const keys = {
  keys: [
    { keyId: 'key_claude', name: 'Claude Code', host: 'mcp', status: 'active' },
    { keyId: 'key_hermes', name: 'Hermes', host: 'mcp', status: 'revoked' },
  ],
}

describe('记录 · 总条数提示', () => {
  it('total note uses the first page total', () => {
    expect(loadedNote(100, 128, true)).toBe('已加载 100 / 共 128 条，合计只含已加载部分')
  })
  it('missing total keeps the old note; no more pages means no note', () => {
    expect(loadedNote(100, null, true)).toBe('已加载 100 条，合计只含已加载部分')
    expect(loadedNote(15, 15, false)).toBeUndefined()
  })
  it('pageOf keeps the first page total', () => {
    expect(pageOf('fills', { items: [], total: 0 }).total).toBe(0)
    expect(pageOf('fills', { items: [] }).total).toBeNull()
  })
})

describe('记录 · 执行方按钥匙筛', () => {
  it('actor options include agent names and the revoked suffix', () => {
    expect(agentActorOptions(keys)).toEqual([
      { id: 'agent:key_claude', label: 'Claude Code' },
      { id: 'agent:key_hermes', label: 'Hermes（已撤销）' },
    ])
  })
  it('picking a key generates actor params, role ids stay actorType', () => {
    expect(actorFilters('agent:key_claude')).toEqual({ actor: 'agent:key_claude' })
    expect(actorFilters('llm-agent')).toEqual({ actorType: 'llm-agent' })
    expect(actorFilters(undefined)).toEqual({})
    expect(queryParams('fill', { range: 'all', ...actorFilters('agent:key_claude') }, NOW)).toEqual({ kind: 'fill', limit: 100, actor: 'agent:key_claude' })
  })
})

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

async function view(params: Record<string, unknown>): Promise<unknown> {
  return h!.k.ops.call(h!.k, 'records.query', { principal: h!.session, params, transport: 'ws', kind: 'query' })
}

describe('内核 · 记录按执行方筛', () => {
  it('records.query filters funding rows by origin.actor', async () => {
    h = await makeHarness()
    const subject = { accountId: h.paper.accountId, instrumentId: 'hyperliquid:BTC' as never }
    h.k.ledger.append({ type: 'funding', origin: mkOrigin('agent:key_a' as never, 'funding.test', 'mcp'), subject, payload: { amount: '-0.12' } })
    h.k.ledger.append({ type: 'funding', origin: mkOrigin('agent:key_b' as never, 'funding.test', 'mcp'), subject, payload: { amount: '-0.24' } })
    const only = await view({ kind: 'funding', actor: 'agent:key_a' }) as { items: Array<{ origin: { actor: string } }>; total?: number }
    expect(only.items.map((e) => e.origin.actor)).toEqual(['agent:key_a'])
    expect(only.total).toBe(1)
    await expect(view({ kind: 'funding', actor: 'agent:key_missing' })).resolves.toMatchObject({ items: [], total: 0 })
    await expect(view({ kind: 'funding', actor: ' ' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })
})

describe('记录 · 导出账单下载（C3）', () => {
  it('uses the kernel file name and prefixes exactly one UTF-8 BOM', () => {
    const bom = String.fromCharCode(0xfeff)
    const d = billDownload({ dir: 'x', billName: 'gitrader-账单-20261028-0135.csv', files: { bill: '时间,方向\n', manifest: '{}' } })!
    expect(d.name).toBe('gitrader-账单-20261028-0135.csv')
    expect(d.text).toBe(bom + '时间,方向\n')
    expect(billDownload({ billName: 'a.csv', files: { bill: bom + 'x' } })!.text).toBe(bom + 'x')
  })
  it('the bytes handed to the Blob start with EF BB BF (Blob.text() would hide it by stripping the BOM while decoding)', async () => {
    const d = billDownload({ billName: 'a.csv', files: { bill: '时间,方向' } })!
    const bytes = new Uint8Array(await new Blob([d.text], { type: 'text/csv;charset=utf-8' }).arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })
  it('no files (too many entries, written to disk only) means no download', () => {
    expect(billDownload({ dir: 'x', billName: 'a.csv' })).toBeNull()
    expect(billDownload(undefined)).toBeNull()
  })
})
