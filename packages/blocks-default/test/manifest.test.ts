// SPDX-License-Identifier: CPAL-1.0
// 清单：每块一份 gitrader-block/1，过 SDK 与协议两套校验；声明的主题 / 查询 / 命令必须落在块申请的权限里（桥会拒绝，所以这里提前卡住）；
// 与壳的布局预设、占位清单对得上（同 id 同版本，尺寸不小于壳的假设）；源码里没有禁词。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validateBlockManifest as validateSdk, actionPermission, topicPermission, FIRST_PARTY_ONLY_ACTIONS, BlockRegistry } from '@gitrader/blocks-sdk'
import { validateBlockManifest as validateProtocol } from '@gitrader/protocol'
import { BLOCK, PLACEHOLDER_MANIFESTS } from '@gitrader/workbench'
import { describe, expect, it } from 'vitest'
import { defaultBlocks } from '../src/index'

const root = join(__dirname, '..')
const manifests = defaultBlocks.map((d) => d.manifest)

describe('默认块清单', () => {
  it('导出四个块：持仓与盈亏 / Agent 活动与待批 / 风险状态 / 状态条', () => {
    expect(manifests.map((m) => m.name)).toEqual(['持仓与盈亏', 'Agent 活动与待批', '风险状态', '状态条'])
    expect(new Set(manifests.map((m) => m.id)).size).toBe(4)
  })

  it.each(manifests.map((m) => [m.id, m] as const))('%s：SDK 校验通过', (_id, m) => {
    expect(validateSdk(m)).toEqual([])
  })

  // protocol v0.1.6 裁决后 SDK 与协议的块清单形状一致（vendor = {name, url?}、license = SPDX 字符串、fixtures = 数组）：协议校验必须零问题。
  it.each(manifests.map((m) => [m.id, m] as const))('%s：协议校验通过', (_id, m) => {
    const r = validateProtocol(m)
    const paths = r.ok ? [] : r.issues.map((i: { path: string }) => i.path).sort()
    expect(paths).toEqual([])
  })

  it.each(manifests.map((m) => [m.id, m] as const))('%s：声明的主题 / 查询 / 命令都在申请的权限里', (_id, m) => {
    for (const e of m.inputs?.events ?? []) {
      const need = topicPermission(e.topic)
      if (need) expect(m.permissions, `订阅 ${e.topic} 需要 ${need}`).toContain(need)
    }
    for (const q of m.inputs?.queries ?? []) {
      const need = topicPermission(q)
      if (need) expect(m.permissions, `查询 ${q} 需要 ${need}`).toContain(need)
    }
    for (const a of m.actions ?? []) {
      const need = actionPermission(a)
      if (need) expect(m.permissions, `命令 ${a} 需要 ${need}`).toContain(need)
    }
    // 只有一方签名的 inline 块能带批准 / 拒绝
    for (const a of m.actions ?? []) if (FIRST_PARTY_ONLY_ACTIONS.includes(a)) expect(m.isolation).toBe('inline')
  })

  it('每块都有联动 / 动作 / 尺寸 / 权限 / 回放文件，高频主题声明了 maxHz', () => {
    for (const m of manifests) {
      expect(m.size.minW).toBeGreaterThan(0)
      expect(m.permissions.length).toBeGreaterThan(0)
      expect(Array.isArray(m.linkGroups)).toBe(true)
      expect(m.fixtures.length).toBeGreaterThan(0)
      for (const f of m.fixtures) {
        expect(f).toMatch(/^\.\/fixtures\/[a-z-]+\.json$/)
        expect(() => readFileSync(join(root, f), 'utf8')).not.toThrow()
      }
      for (const e of m.inputs?.events ?? []) if (e.topic.startsWith('account.positions') || e.topic === 'ledger.entry' || e.topic === 'venue.status') expect(e.maxHz, `${m.id} ${e.topic}`).toBeGreaterThan(0)
    }
  })

  it('不申请不该有的权限：只有持仓块能平仓 / 挂撤止损单，没有块能改布局，批准只在待批块里', () => {
    for (const m of manifests) {
      expect(m.permissions).not.toContain('workspace.control')
      expect(m.permissions).not.toContain('net.fetch')
    }
    // r4 持仓卡行内动作（WORK-ORDERS 5.2-10）：三条人面命令只在持仓块，别的块一条都没有
    const trades = ['position.close', 'order.place', 'order.cancel']
    for (const m of manifests) {
      if (m.id === 'block.gitrader.positions') expect([...(m.actions ?? [])].sort()).toEqual([...trades].sort())
      else for (const a of trades) expect(m.actions ?? [], `${m.id} ${a}`).not.toContain(a)
    }
    const withApprove = manifests.filter((m) => (m.actions ?? []).includes('proposal.approve')).map((m) => m.id)
    expect(withApprove).toEqual(['block.gitrader.agent-activity'])
    const withTakeover = manifests.filter((m) => m.permissions.includes('takeover.trigger')).map((m) => m.id)
    expect(withTakeover.sort()).toEqual(['block.gitrader.risk', 'block.gitrader.statusbar'])
  })

  it('Agent 块（r2）：查账户（卡上的实盘 / 纸面）与风控态（已停止时先挡改档），权限仍只有 account.read + ledger.read', () => {
    const m = manifests.find((x) => x.id === 'block.gitrader.agent-activity')!
    expect(m.inputs?.queries).toEqual(expect.arrayContaining(['account.list', 'risk.state']))
    expect(m.inputs?.events?.map((e) => e.topic)).toContain('risk.state')
    expect([...m.permissions].sort()).toEqual(['account.read', 'ledger.read'])
    for (const q of ['account.list', 'risk.state']) expect(m.permissions).toContain(topicPermission(q)!)
  })

  it('r4（C2）：总览条读权益与待批、风险卡读待批张数、Agent 块读持仓（批后仓位）——都只追加查询 / 主题，权限不变', () => {
    const by = (id: string) => manifests.find((x) => x.id === id)!
    const sb = by('block.gitrader.statusbar')
    expect(sb.inputs?.queries).toEqual(expect.arrayContaining(['venue.status', 'risk.state', 'account.list', 'account.summary', 'account.positions', 'proposal.list']))
    expect(sb.inputs?.events?.map((e) => e.topic)).toEqual(expect.arrayContaining(['venue.status', 'risk.state', 'account.summary', 'account.positions', 'proposal.*']))
    expect([...sb.permissions].sort()).toEqual(['account.read', 'takeover.trigger'])
    const risk = by('block.gitrader.risk')
    expect(risk.inputs?.queries).toContain('proposal.list')
    expect(risk.inputs?.events?.map((e) => e.topic)).toContain('proposal.*')
    expect([...risk.permissions].sort()).toEqual(['account.read', 'ledger.read', 'takeover.trigger'])
    const agent = by('block.gitrader.agent-activity')
    expect(agent.inputs?.queries).toEqual(expect.arrayContaining(['account.positions', 'account.summary']))
    for (const m of [sb, risk, agent]) {
      for (const q of m.inputs?.queries ?? []) { const need = topicPermission(q); if (need) expect(m.permissions, `${m.id} 查询 ${q}`).toContain(need) }
      for (const e of m.inputs?.events ?? []) { const need = topicPermission(e.topic); if (need) expect(m.permissions, `${m.id} 订阅 ${e.topic}`).toContain(need) }
    }
  })

  it('与壳的布局预设对得上：同 id 同版本，钉住块钉住，尺寸不小于壳的假设', () => {
    const reg = new BlockRegistry()
    for (const d of defaultBlocks) reg.register(d)
    const want: Array<[keyof typeof BLOCK, string]> = [['positions', 'block.gitrader.positions'], ['agent', 'block.gitrader.agent-activity'], ['risk', 'block.gitrader.risk'], ['statusbar', 'block.gitrader.statusbar']]
    for (const [k, id] of want) {
      const ref = BLOCK[k]
      expect(ref).toBe(`${id}@0.1.0`)
      const def = reg.resolve(ref)
      expect(def, ref).toBeDefined()
      const ph = PLACEHOLDER_MANIFESTS.find((p) => p.id === id)!
      expect(def!.manifest.size.minW).toBeLessThanOrEqual(ph.size.minW)
      expect(def!.manifest.size.minH).toBeLessThanOrEqual(ph.size.minH)
      expect(def!.manifest.pinned === true, id).toBe(ph.pinned === true)
    }
  })
})

describe('源码门禁', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === '.tmp' ? [] : files(join(dir, e.name))) : [join(dir, e.name)]))
  const src = [...files(join(root, 'src')), ...files(join(root, 'fixtures'))].filter((f) => /\.(tsx?|css|json|mjs)$/.test(f))

  it('产品文案与源码里没有禁词（Comfy / WalletConnect / 保守 / 激进 / 标准 / 内部标识）', () => {
    for (const f of src) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/Comfy|WalletConnect|保守|激进|标准|UNIGIT/)
    }
  })

  it('样式只用令牌：src 里没有颜色字面量', () => {
    for (const f of src.filter((x) => /\.(css|tsx?)$/.test(x))) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    }
  })

  it('样式里中文字重只用 400 / 600，没有 500 / 700 / 300', () => {
    const css = readFileSync(join(root, 'src/blocks.css'), 'utf8')
    expect(css).not.toMatch(/font-weight:\s*(300|500|700|bold)/)
  })

  it('所有源文件头是 CPAL-1.0', () => {
    for (const f of src.filter((x) => /\.(tsx?|mjs)$/.test(x))) expect(readFileSync(f, 'utf8').split('\n')[0], f).toMatch(/SPDX-License-Identifier: CPAL-1\.0|^\/\*|^\/\//)
  })
})
