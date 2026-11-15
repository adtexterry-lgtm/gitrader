// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  NEVER_GRANTABLE_PERMISSIONS, PERMISSION_ALLOWED_KINDS, PLUGIN_KINDS, PLUGIN_PERMISSIONS, SIGNER_ALGS, LAYOUT_API, bridgeOriginTool, checkPluginManifest,
  checkWorkspace, validatePluginManifest, validateWorkspace, validateBlockManifest, BRIDGE_METHOD_NAMES, BLOCK_PERMISSIONS, FIRST_PARTY_ONLY_COMMANDS,
  type PluginManifest, type Workspace,
} from '../src'
import { clone, contract, sample } from './helpers'

describe('插件清单 gitrader-plugin/1', () => {
  const m = (): PluginManifest => contract('plugin-nautilus')
  it('kind 枚举 12 种；权限 14 种；永不可授予 10 种', () => {
    expect(PLUGIN_KINDS.length).toBe(12)
    expect(PLUGIN_PERMISSIONS.length).toBe(14)
    // fix-r4: 永不可授予清单追加 risk.temporaryRelax（9 -> 10）
    expect(NEVER_GRANTABLE_PERMISSIONS.length).toBe(10)
    expect(NEVER_GRANTABLE_PERMISSIONS).toContain('risk.temporaryRelax')
    expect(PLUGIN_KINDS).not.toContain('model')
    expect(PLUGIN_KINDS).toEqual(expect.arrayContaining(['factor', 'decision-model']))
  })
  it('permissions 缺省 = 全部拒绝：清单必须显式写 permissions（可为空数组）', () => {
    const x = clone(m()) as unknown as Record<string, unknown>
    delete x['permissions']
    expect(validatePluginManifest(x).ok).toBe(false)
    x['permissions'] = []
    expect(validatePluginManifest(x).ok).toBe(true)
  })
  it('永不可授予的权限出现即拒装', () => {
    for (const p of NEVER_GRANTABLE_PERMISSIONS) {
      const x = clone(m())
      ;(x.permissions as string[]).push(p)
      expect(validatePluginManifest(x).ok, p).toBe(false)
      expect(checkPluginManifest(x).join(), p).toContain('never be granted')
    }
  })
  it('权限与 kind 的矩阵', () => {
    const x = clone(m())
    x.kind = 'protector'
    x.id = 'protector.gitrader.nautilus' // r2：id 前缀必须等于 kind
    x.permissions = ['trade.paper']
    expect(checkPluginManifest(x).join()).toContain('cannot request trade.paper')
    x.permissions = ['takeover.trigger', 'notify.user', 'market.read']
    expect(checkPluginManifest(x)).toEqual([])
    expect(PERMISSION_ALLOWED_KINDS['venue.credentials']).toEqual(['connector'])
    expect(PERMISSION_ALLOWED_KINDS['trade.live']).toEqual(['executor', 'engine'])
  })
  it('未签名插件不得申请 trade.live / venue.credentials', () => {
    const x = clone(m())
    x.permissions = ['trade.live']
    x.signature = undefined
    expect(checkPluginManifest(x).join()).toContain('unsigned')
    x.signature = m().signature
    expect(checkPluginManifest(x)).toEqual([])
  })
  it('net.fetch 必须配 net.hosts；factor 不得配置远端端点', () => {
    const x = clone(m())
    x.kind = 'executor'
    x.permissions = ['net.fetch']
    x.net = { hosts: [] }
    expect(checkPluginManifest(x).join()).toContain('net.hosts')
    expect(validatePluginManifest(x).ok).toBe(false)
    const f = clone(m())
    f.kind = 'factor'
    f.net = { hosts: ['api.example.org'] }
    f.permissions = []
    expect(checkPluginManifest(f).join()).toContain('remote endpoints')
  })
  it('依赖版本必须精确：范围与 latest 都被拒', () => {
    const x = clone(m())
    x.requires = [{ kind: 'pypi', name: 'nautilus_trader', version: '^1.231.0', sha256: m().requires![0]!.sha256 }]
    expect(validatePluginManifest(x).ok).toBe(false)
    x.requires![0]!.version = 'latest'
    expect(validatePluginManifest(x).ok).toBe(false)
    expect(validatePluginManifest({ ...clone(m()), version: '0.1' }).ok).toBe(false)
  })
  it('install.requireHashes 必须为 true', () => {
    const x = clone(m()) as unknown as { install: { requireHashes: boolean } }
    x.install.requireHashes = false
    expect(validatePluginManifest(x).ok).toBe(false)
  })
  it('engine 类必须有 engine.gep；strategy 类必须有 evidence 与 risk；数据源必须有 tos', () => {
    const e = clone(m()) as unknown as Record<string, unknown>
    delete e['engine']
    expect(validatePluginManifest(e).ok).toBe(false)
    const s = clone(m())
    s.kind = 'strategy'
    expect(validatePluginManifest(s).ok).toBe(false)
    const d = clone(m())
    d.kind = 'datasource'
    expect(validatePluginManifest(d).ok).toBe(false)
  })
  it('包装形态只能是 skill 或 block；skill 包必须是 skill 类', () => {
    const x = clone(m()) as unknown as { package: string }
    x.package = 'zip'
    expect(validatePluginManifest(x).ok).toBe(false)
    const y = clone(m())
    y.package = 'skill'
    expect(checkPluginManifest(y).join()).toContain('package skill')
  })
  it('v0.1.2：引擎语言无关——任意语言的子进程与远程 wss 都能写进清单；python 字段只是可选便利', () => {
    const go = clone(m())
    go.runtime = { type: 'sidecar', native: true, diskMB: 20 }
    go.entry = { command: ['./bin/my-engine', '--gep', 'stdio'], transport: 'stdio' }
    go.engine = { gep: { versions: ['0.1'], transports: ['stdio'], modes: ['A'] }, launch: { command: './bin/my-engine', args: ['--gep', 'stdio'] } }
    go.requires = []
    go.id = 'engine.acme.fast'
    go.vendor = { ...go.vendor, id: 'acme' } // r2：id 第二段必须等于 vendor.id
    expect(validatePluginManifest(go).ok).toBe(true)
    const remote = clone(go)
    remote.runtime = { type: 'rest', native: false, diskMB: 0 }
    remote.engine = { gep: { versions: ['0.1'], transports: ['wss'], modes: ['A'] }, launch: { url: 'wss://engine.example.org/gep', auth: { method: 'mtls', clientCertRef: 'keychain:cert' } } }
    expect(validatePluginManifest(remote).ok).toBe(true)
    const bad = clone(go)
    bad.engine = { gep: { versions: ['0.1'], transports: ['stdio'], modes: ['A'] }, launch: { url: 'wss://engine.example.org/gep' } as never }
    expect(validatePluginManifest(bad).ok).toBe(false)
  })
  it('GSP 签名算法 5 种', () => {
    expect([...SIGNER_ALGS]).toEqual(['hmac-sha256', 'hmac-sha512', 'ed25519', 'rsa-sha256', 'eip712-secp256k1'])
  })
})

describe('块与工作区', () => {
  const ws = (): Workspace => contract('workspace-default')
  it('默认工作区：5 个瓦片 + 4 个堆叠，共 9 个块实例 + 状态条', () => {
    const w = ws()
    expect(w.items.length).toBe(9)
    expect(w.items.filter((i) => i.pinned).map((i) => i.instanceId).sort()).toEqual(['bi_agent_1', 'bi_risk_1'])
    expect(w.statusBar.takeover).toEqual(['halt_new', 'cancel_all', 'flatten_all'])
    expect(checkWorkspace(w)).toEqual([])
  })
  it('stack 必须恰好一个 active', () => {
    const w = clone(ws())
    w.items.find((i) => i.instanceId === 'bi_book_1')!.active = true
    expect(checkWorkspace(w).join()).toContain('exactly one active')
    expect(validateWorkspace(w).ok).toBe(false)
    const w2 = clone(ws())
    w2.items.find((i) => i.instanceId === 'bi_positions_1')!.active = false
    expect(checkWorkspace(w2).join()).toContain('exactly one active')
  })
  it('钉住块不得进 stack；超出网格、重复实例 id 被拒', () => {
    const w = clone(ws())
    w.items.find((i) => i.instanceId === 'bi_risk_1')!.stack = 'bottom'
    expect(checkWorkspace(w).join()).toContain('pinned')
    const o = clone(ws())
    o.items[0]!.w = 30
    expect(checkWorkspace(o).join()).toContain('outside')
    const d = clone(ws())
    d.items[1]!.instanceId = d.items[0]!.instanceId
    expect(checkWorkspace(d).join()).toContain('duplicate')
  })
  it('stack 内瓦片必须同位置', () => {
    const w = clone(ws())
    w.items.find((i) => i.instanceId === 'bi_book_1')!.x = 3
    expect(checkWorkspace(w).join()).toContain('share one position')
  })
  it('块清单：第三方块权限里没有批准提案；批准类命令只给一方块', () => {
    expect(BLOCK_PERMISSIONS).not.toContain('proposal.approve')
    expect([...FIRST_PARTY_ONLY_COMMANDS]).toEqual(['proposal.approve', 'proposal.reject'])
    expect(validateBlockManifest(sample('BlockManifest')).ok).toBe(true)
    expect(BRIDGE_METHOD_NAMES.length).toBe(5)
    expect(bridgeOriginTool('block.gitrader.chart', 'order.cancel')).toBe('block:block.gitrader.chart:order.cancel')
  })
  it('布局 API：9 个方法，只有 workspace.revert 不对 Agent 开放', () => {
    expect(LAYOUT_API.length).toBe(9)
    expect(LAYOUT_API.filter((m) => !m.agentCallable).map((m) => m.method)).toEqual(['workspace.revert'])
  })
})
