// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { defaultBlocks } from '@gitrader/blocks-default'
import { createStubBlock } from '../src/kit'
import { LabDetailStub } from '../src/pages/lab-detail'
import { labBlocks } from '../src/pages/lab'
import { r5Blocks } from '../src/index'
import { r5Fixtures } from '../fixtures'
import { PLACEHOLDER_MANIFESTS } from '../../workbench/src/core/placeholders'
// @ts-expect-error registry.jsx has no declaration; this test verifies its runtime routing contract.
import { createRegistry as createRegistryImpl } from '../../workbench/src/shell/registry.jsx'

const createRegistry = createRegistryImpl as unknown as (ui: 'r4' | 'r5') => {
  registry: { has(ref: string): boolean; resolve(ref: string): any }
  firstParty: Set<string>
}
const expectedIds = [
  'block.gitrader.positions', 'block.gitrader.agent-activity', 'block.gitrader.risk', 'block.gitrader.statusbar',
  'block.gitrader.chart', 'block.gitrader.symbols', 'block.gitrader.audit', 'block.gitrader.equity',
  'block.gitrader.lab', 'block.gitrader.strategies', 'block.gitrader.venues', 'block.gitrader.notify', 'block.gitrader.plugins',
  'block.gitrader.reconcile', // P1-2 新增对账块（其夹具复用 overview.ts）
]
const expectedPageById: Record<string, string> = {
  'block.gitrader.positions': 'overview',
  'block.gitrader.agent-activity': 'overview',
  'block.gitrader.risk': 'overview',
  'block.gitrader.statusbar': 'overview',
  'block.gitrader.chart': 'chart',
  'block.gitrader.symbols': 'chart',
  'block.gitrader.audit': 'records',
  'block.gitrader.equity': 'funds',
  'block.gitrader.lab': 'lab',
  'block.gitrader.strategies': 'strategies',
  'block.gitrader.venues': 'venues',
  'block.gitrader.notify': 'notify',
  'block.gitrader.plugins': 'plugins',
  'block.gitrader.reconcile': 'overview',
}
// 权限白名单 = 工单各 P 节 ② 用到的查询 / 命令所需权限：行情（chart 的 market.read）、账户 / 资金 / 引擎 / 实验 / 插件 / 配置（account.read）、
// 记录 / 事件链 / 导出 / P8 的 ledger.query（ledger.read）、总览接管三档（takeover.trigger）。workspace.control / net.fetch 没有任何 P 用到，出现即红。
const PERMISSION_ALLOWLIST: readonly string[] = ['market.read', 'account.read', 'ledger.read', 'takeover.trigger']
const newIds = ['block.gitrader.lab', 'block.gitrader.strategies', 'block.gitrader.venues', 'block.gitrader.notify', 'block.gitrader.plugins']

function renderFacts(node: any): { pages: string[]; text: string } {
  if (node == null || typeof node === 'boolean') return { pages: [], text: '' }
  if (typeof node === 'string' || typeof node === 'number') return { pages: [], text: String(node) }
  if (Array.isArray(node)) {
    const facts = node.map(renderFacts)
    return { pages: facts.flatMap((fact) => fact.pages), text: facts.map((fact) => fact.text).join('') }
  }
  if (typeof node.type === 'function') return renderFacts(node.type(node.props))
  const childFacts = renderFacts(node.props?.children)
  const page = node.props?.['data-page']
  return { pages: [...(typeof page === 'string' ? [page] : []), ...childFacts.pages], text: childFacts.text }
}

describe('r5 registry preparation', () => {
  it('registers r5 definitions over r4 by id and version only in r5 mode', () => {
    const r4 = createRegistry('r4')
    const r5 = createRegistry('r5')
    const defaults = new Map(defaultBlocks.map((definition) => [definition.manifest.id, definition]))
    const ids = r5Blocks.map((definition) => definition.manifest.id)
    expect([...ids].sort()).toEqual([...expectedIds].sort())
    for (const definition of r5Blocks) {
      const key = `${definition.manifest.id}@0.1.0`
      expect(definition.manifest.version).toBe('0.1.0')
      for (const permission of definition.manifest.permissions) expect(PERMISSION_ALLOWLIST).toContain(permission)
      expect(definition.manifest.fixtures?.length).toBeGreaterThan(0)
      const resolved = r5.registry.resolve(key)
      expect(resolved?.manifest).toEqual(definition.manifest)
      // 桩时代这里直接调组件函数、断言渲染出「未接通」；真块用 hooks，脱离 BlockHost 调用会抛，所以改为契约断言：夹具文件名对得上页、组件是函数。
      expect(typeof resolved?.component).toBe('function')
      const page = expectedPageById[definition.manifest.id]!
      expect(definition.manifest.fixtures).toContain(`./fixtures/${page}.ts`)
      expect(Object.keys(r5Fixtures[page as keyof typeof r5Fixtures])).toContain('normal')
      const r4Definition = r4.registry.resolve(key)
      const old = defaults.get(definition.manifest.id)
      if (old) expect(r4Definition?.manifest).toEqual(old.manifest)
      else expect(r4Definition).not.toBe(definition)
    }
  })

  it('still renders the unwired stub with its page hook and the original text', () => {
    const facts = renderFacts(createStubBlock('stub.sample', 'overview', '示例').component!({ config: {} } as any))
    expect(facts.pages).toContain('overview')
    expect(facts.text).toContain('未接通')
  })

  it('keeps all five new placeholders and first-party ids in each selected registry', () => {
    const placeholders = new Map(PLACEHOLDER_MANIFESTS.map((manifest) => [manifest.id, manifest]))
    const r4 = createRegistry('r4')
    const r5 = createRegistry('r5')
    for (const id of newIds) {
      expect(placeholders.has(id)).toBe(true)
      expect(r4.firstParty.has(id)).toBe(true)
      expect(r5.firstParty.has(id)).toBe(true)
      expect(r4.registry.resolve(`${id}@0.1.0`)?.placeholder).toBe(true)
      expect(r4.registry.resolve(`${id}@0.1.0`)).not.toBe(r5Blocks.find((definition) => definition.manifest.id === id))
    }
  })

  it('registers one lab id and routes list versus every detail view', () => {
    const labs = r5Blocks.filter((definition) => definition.manifest.id === 'block.gitrader.lab')
    expect(labs).toHaveLength(1)
    const component = labs[0]!.component!
    const props = (view?: string) => ({ config: view === undefined ? {} : { view } }) as any
    expect((component(props()) as any).type).not.toBe(LabDetailStub)
    expect((component(props('list')) as any).type).not.toBe(LabDetailStub)
    for (const view of ['head', 'tier', 'assumptions', 'bias', 'data', 'detail']) {
      expect((component(props(view)) as any).type).toBe(LabDetailStub)
      // P8 已把 LabDetailStub 换成真详情视图（用 hooks，脱离 BlockHost 不能渲染），所以这里只断言分流到同一个详情组件。
    }
    expect(labBlocks).toHaveLength(1)
    expect(r5Fixtures.lab.normal).toMatchObject({ view: 'list' })
    expect(r5Fixtures['lab-detail'].normal).toMatchObject({ view: 'detail' })
  })

  it('keeps block ids unique across all page modules', () => {
    const ids = r5Blocks.map((definition) => definition.manifest.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
