// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock, actionMatches, parseBlockRef, topicMatches, topicPermission, validateBlockManifest } from '../src'
import { good } from './helpers'

describe('块清单校验', () => {
  it('合格清单无问题', () => {
    expect(validateBlockManifest(good())).toEqual([])
  })

  it('vendor 必须是对象、fixtures 必须是数组（v0.1.6）', () => {
    expect(validateBlockManifest({ ...good(), vendor: 'gitrader' }).map((i) => i.path)).toContain('vendor')
    expect(validateBlockManifest({ ...good(), fixtures: './a.json' }).map((i) => i.path)).toContain('fixtures')
  })

  it('逐项报错', () => {
    const issues = validateBlockManifest({ ...good(), schema: 'x', id: 'chart', version: '1', entry: { module: 'a', element: 'chart' }, isolation: 'popup', permissions: ['proposal.approve'], fixtures: [] })
    const paths = issues.map((i) => i.path)
    for (const p of ['schema', 'id', 'version', 'entry.element', 'isolation', 'permissions', 'fixtures']) expect(paths).toContain(p)
  })

  it('尺寸约束：default 不能小于 min，max 不能小于 min', () => {
    const issues = validateBlockManifest(good({ size: { minW: 8, minH: 4, defaultW: 6, defaultH: 4, maxW: 5 } }))
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['size.defaultW', 'size.maxW']))
  })

  it('net.fetch 必须列主机；iframe 块不能带批准提案、不能钉住', () => {
    expect(validateBlockManifest(good({ permissions: ['net.fetch'] })).map((i) => i.path)).toContain('net.hosts')
    expect(validateBlockManifest(good({ isolation: 'iframe', actions: ['proposal.approve'] })).map((i) => i.path)).toContain('actions')
    expect(validateBlockManifest(good({ isolation: 'iframe', pinned: true })).map((i) => i.path)).toContain('pinned')
  })

  it('defineBlock 对坏清单直接抛错，注册表按 id@version 与 id 解析', () => {
    expect(() => defineBlock({ manifest: good({ id: 'bad' }) })).toThrow(/块清单不合格/)
    const reg = new BlockRegistry().register(defineBlock({ manifest: good() }))
    expect(reg.has('block.gitrader.chart@0.1.0')).toBe(true)
    expect(reg.has('block.gitrader.chart@9.9.9')).toBe(true) // 退到同 id
    expect(reg.has('block.gitrader.nope@0.1.0')).toBe(false)
  })
})

describe('主题与命令匹配', () => {
  it('前缀通配', () => {
    expect(topicMatches('proposal.*', 'proposal.created')).toBe(true)
    expect(topicMatches('proposal.*', 'proposal')).toBe(true)
    expect(topicMatches('market.quote', 'market.quote')).toBe(true)
    expect(topicMatches('market.quote', 'market.book')).toBe(false)
    expect(actionMatches('workspace.*', 'workspace.save')).toBe(true)
    expect(actionMatches('order.place', 'order.cancel')).toBe(false)
  })

  it('主题 → 权限', () => {
    expect(topicPermission('market.book')).toBe('market.read')
    expect(topicPermission('account.positions')).toBe('account.read')
    expect(topicPermission('ledger.entry')).toBe('ledger.read')
    expect(topicPermission('workspace.changed')).toBeNull()
  })

  it('块引用解析', () => {
    expect(parseBlockRef('block.gitrader.chart@0.1.0')).toEqual({ id: 'block.gitrader.chart', version: '0.1.0' })
    expect(parseBlockRef('block.gitrader.chart')).toEqual({ id: 'block.gitrader.chart', version: null })
  })
})
