// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { FIRST_PARTY_ONLY_ACTIONS, validateBlockManifest } from '@gitrader/blocks-sdk'
import { pluginsFixtures } from '../fixtures/plugins'
import { GROUP_ORDER, enableAsksPin, enablePlan, groupOf, normalizePlugins, togglePlan, unverifiedVenues, type PluginRow } from '../src/model-plugins'
import { pluginsBlocks } from '../src/pages/plugins'

const normalList = pluginsFixtures.normal.queries['plugin.list']
const unwiredList = pluginsFixtures.unwired.queries['plugin.list']
const byId = (view: ReturnType<typeof normalizePlugins>, id: string) => view.rows.find((r) => r.id === id)!

describe('plugins model', () => {
  it('maps the thirteen fixture plugins into six groups in fixed order', () => {
    const view = normalizePlugins(normalList)
    expect(view.count).toBe(13)
    expect(view.groups.map((g) => [g.id, g.rows.length])).toEqual([
      ['trading', 3], ['data', 2], ['engine', 2], ['notify', 2], ['block', 2], ['tool', 2],
    ])
    expect(view.groups.map((g) => g.label)).toEqual(['交易连接器', '行情数据源', '策略引擎', '通知通道', '工作台块', '工具'])
    expect(view.groups.map((g) => g.id)).toEqual([...GROUP_ORDER])
  })

  it('maps kinds, uses the id prefix when the kernel dropped kind, and omits empty groups', () => {
    expect(groupOf({ id: 'datasource.a.b', kind: 'datasource' })).toBe('data')
    expect(groupOf({ id: 'connector.a.x-data', kind: 'connector' })).toBe('data')
    expect(groupOf({ id: 'connector.a.notify-slack', kind: 'connector' })).toBe('notify')
    expect(groupOf({ id: 'connector.a.chat', kind: 'connector', tools: [{ name: 'notify_send' }] })).toBe('notify')
    expect(groupOf({ id: 'decision.a.m' })).toBe('engine')
    expect(groupOf({ id: 'strategy.a.s', kind: 'strategy' })).toBe('engine')
    expect(groupOf({ id: 'layout-preset.a.p' })).toBe('block')
    for (const kind of ['factor', 'protector', 'skill', 'workflow-template', 'what']) expect(groupOf({ id: `${kind}.a.b`, kind })).toBe('tool')
    expect(normalizePlugins([{ id: 'skill.a.b', kind: 'skill', permissions: [] }]).groups.map((g) => g.id)).toEqual(['tool'])
    expect(normalizePlugins([]).groups).toEqual([])
  })

  it('splits permissions into network hosts / files / secret names', () => {
    const view = normalizePlugins(normalList)
    const bybit = byId(view, 'connector.tradekit.bybit')
    expect(bybit.hosts).toEqual({ wired: true, value: ['api.bybit.com', 'api-testnet.bybit.com', 'stream-testnet.bybit.com'] })
    expect(bybit.secrets).toEqual({ wired: true, value: ['BYBIT_API_KEY', 'BYBIT_API_SECRET'] })
    expect(bybit.files).toEqual({ wired: true, value: [] })
    expect(byId(view, 'engine.gitrader.core').files).toEqual({ wired: true, value: ['~/Gitrader/strategies'] })
    expect(bybit.capabilities).toEqual(['场所凭据', '网络访问', '实盘交易', '纸面交易'])
  })

  it('marks fields the kernel does not return yet as unwired with the field name', () => {
    const view = normalizePlugins(unwiredList)
    const hl = byId(view, 'connector.gitrader.hyperliquid')
    expect(hl.source).toEqual({ wired: false, field: 'source' })
    expect(hl.compliance).toEqual({ wired: false, field: 'audit' })
    expect(hl.health.detail).toEqual({ wired: false, field: 'health' })
    expect(hl.hosts).toEqual({ wired: false, field: 'net.hosts' })
    expect(hl.secrets).toEqual({ wired: false, field: 'secrets' })
    expect(hl.health.label).toBe('正常')
    // 没声明 net.fetch / fs.read.user 的包：主机与文件一定是「无」，不是未接通
    const sym = byId(view, 'skill.gitrader.symbol-search')
    expect(sym.hosts).toEqual({ wired: true, value: [] })
    expect(sym.files).toEqual({ wired: true, value: [] })
    expect(byId(view, 'engine.gitrader.core').files).toEqual({ wired: false, field: 'files' })
  })

  it('reads health from state and compliance from the audit findings', () => {
    const view = normalizePlugins(normalList)
    expect(byId(view, 'connector.gitrader.hyperliquid').health).toMatchObject({ label: '正常', tone: 'ok', detail: { wired: true, value: '42 ms' } })
    expect(byId(view, 'datasource.gitrader.alphavantage').health).toMatchObject({ label: '降级', tone: 'warn', detail: { wired: true, value: 'HTTP 429' } })
    expect(byId(view, 'connector.tradekit.bybit').health.label).toBe('未运行')
    const ok = byId(view, 'connector.gitrader.hyperliquid').compliance
    expect(ok).toMatchObject({ wired: true, value: { level: 'ok', count: 0 } })
    const warn = byId(view, 'connector.tradekit.bybit').compliance
    expect(warn).toMatchObject({ wired: true, value: { level: 'warn', count: 1, notes: [{ id: 'secrets-unused', level: 'warn', detail: 'BYBIT_API_SECRET 已声明，源码里找不到引用' }] } })
    if (warn.wired) expect(warn.value.groups.find((g) => g.label === '密钥')?.level).toBe('warn')
  })

  it('shows a plugin the kernel rejected as failed with the kernel text unchanged', () => {
    const bad = byId(normalizePlugins(normalList), 'engine.local.py-lab')
    expect(bad).toMatchObject({ ok: false, name: 'py-lab', group: 'engine', enabled: false })
    expect(bad.compliance).toEqual({ wired: true, value: { level: 'fail', count: 1, groups: [], notes: [{ id: 'validation', level: 'fail', detail: '[SCHEMA] entry.command: required for runtime sidecar' }] } })
    expect(bad.issues).toEqual(['[SCHEMA] entry.command: required for runtime sidecar'])
  })

  it('marks connectors whose venue.status says unverified', () => {
    const set = unverifiedVenues(pluginsFixtures.normal.queries['venue.status'])
    expect([...set].sort()).toEqual(['binance', 'bybit'])
    const view = normalizePlugins(normalList, set)
    expect(view.rows.filter((r) => r.unverified).map((r) => r.id)).toEqual(['connector.gitrader.binance-trade', 'connector.tradekit.bybit', 'connector.gitrader.binance-data'])
    expect(unverifiedVenues('x')).toEqual(new Set())
  })

  it('plans enabling: widening when permissions are still pending', () => {
    const view = normalizePlugins(normalList)
    expect(enablePlan(byId(view, 'connector.tradekit.bybit'))).toEqual({
      widen: true, added: ['场所凭据', '网络访问', '实盘交易', '纸面交易'],
      params: { id: 'connector.tradekit.bybit', permissions: ['venue.credentials', 'net.fetch', 'trade.live', 'trade.paper'] },
    })
    expect(enablePlan(byId(view, 'connector.gitrader.hyperliquid')).widen).toBe(false)
  })

  it('K-r5-0: the view model never carries the plugin directory', () => {
    // 内核真回的绝对路径形状：Windows 盘符 + 反斜杠一份、POSIX 一份
    const win = 'C:' + '\\Users\\tester-marker\\AppData\\Local\\Gitrader\\plugins\\hyperliquid'
    const posix = '/home/' + 'tester-marker/.gitrader/plugins/py-lab'
    const raw = [{ ...(normalList[0] as Record<string, unknown>), dir: win, issues: [] }, { id: 'tool.x.y', ok: false, dir: posix, issues: ['[SCHEMA] bad'] }]
    const view = normalizePlugins(raw)
    expect(JSON.stringify(view)).not.toContain('tester-marker')
    // 视图模型里任何层级的对象都没有 dir 键
    const keys = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) v.forEach((x) => keys(x, out))
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out) }
      return out
    }
    expect(keys(view)).not.toContain('dir')
    expect(JSON.stringify(pluginsFixtures)).not.toContain('"dir"')
  })

  it('rejects a reply that is not a list', () => {
    expect(() => normalizePlugins({ plugins: [] })).toThrow('plugin.list')
  })
})

describe('plugins permission policy and license', () => {
  const view = normalizePlugins(normalList)

  it('enable does not ask for a PIN', () => {
    const row = byId(view, 'connector.gitrader.hyperliquid')
    expect(enableAsksPin(row)).toBe(false)
    // 只启用：不重新交一遍已授予的权限
    expect(enablePlan(row).params).toEqual({ id: 'connector.gitrader.hyperliquid', permissions: [] })
  })

  it('adding a permission asks for a PIN', () => {
    const bybit = byId(view, 'connector.tradekit.bybit')
    expect(enableAsksPin(bybit)).toBe(true)
    expect(enablePlan(bybit).params.permissions).toEqual(['venue.credentials', 'net.fetch', 'trade.live', 'trade.paper'])
    expect(enableAsksPin(byId(view, 'connector.gitrader.notify-email'))).toBe(true)
  })

  it('license shows or falls back to 未声明', () => {
    const raw = [
      { id: 'tool.a.text', license: 'MIT' },
      { id: 'tool.a.spdx', license: { spdx: 'Apache-2.0' } },
      { id: 'tool.a.missing' },
      { id: 'tool.a.blank', license: { spdx: '' } },
      { id: 'tool.a.manifest', manifest: { license: { spdx: 'BSD-3-Clause' } } },
    ]
    expect(normalizePlugins(raw).rows.map((r) => r.license)).toEqual(['MIT', 'Apache-2.0', '未声明', '未声明', 'BSD-3-Clause'])
    // 现有夹具与当前 plugin.list 回包都不带清单 license：回退到未声明
    expect(byId(view, 'connector.gitrader.hyperliquid').license).toBe('未声明')
  })
})

describe('plugins toggle = running (GQ-55)', () => {
  const view = normalizePlugins(normalList)
  const row = (id: string, patch: Partial<PluginRow> = {}): PluginRow => ({ ...byId(view, id), ...patch })
  it('a running plugin turns off with plugin.stop; a stopped enabled plugin turns on with plugin.start', () => {
    expect(togglePlan(row('connector.gitrader.hyperliquid'))).toMatchObject({ checked: true, needsPin: false, steps: [{ action: 'plugin.stop', params: { id: 'connector.gitrader.hyperliquid' } }] })
    expect(togglePlan(row('connector.gitrader.hyperliquid', { state: 'stopped' }))).toMatchObject({ checked: false, steps: [{ action: 'plugin.start' }] })
    expect(togglePlan(row('connector.gitrader.hyperliquid', { state: 'failed' })).checked).toBe(false)
  })
  it('never enabled -> grant then start; widening permissions asks for the PIN (no silent grant)', () => {
    const p = togglePlan(row('connector.tradekit.bybit'))
    expect(p.needsPin).toBe(true)
    expect(p.checked).toBe(false)
    expect(p.steps.map((s) => s.action)).toEqual(['plugin.grant', 'plugin.start'])
    expect(p.steps[0]!.params).toEqual(enablePlan(row('connector.tradekit.bybit')).params)
  })
  it('block plugins only authorize and never emit start / stop', () => {
    expect(togglePlan(row('block.gitrader.default'))).toEqual({ checked: true, needsPin: false, steps: [] })
    expect(togglePlan(row('block.gitrader.default', { enabled: false })).steps.map((s) => s.action)).toEqual(['plugin.grant'])
  })
  it('never emits plugin.disable', () => {
    const actions = view.rows.flatMap((r) => [r, { ...r, enabled: !r.enabled }, { ...r, state: 'stopped' }]).flatMap((r) => togglePlan(r).steps.map((s) => s.action))
    expect(actions.length).toBeGreaterThan(0)
    expect(actions).not.toContain('plugin.disable')
  })
})

describe('plugins block manifest', () => {
  const manifest = pluginsBlocks[0]!.manifest
  it('is a valid first-party inline block that declares the plugin commands', () => {
    expect(validateBlockManifest(manifest)).toEqual([])
    expect(manifest.id).toBe('block.gitrader.plugins')
    expect(manifest.isolation).toBe('inline')
    expect(manifest.inputs?.queries).toEqual(expect.arrayContaining(['plugin.list', 'venue.status']))
    expect(manifest.actions).toEqual(expect.arrayContaining(['plugin.grant', 'plugin.start', 'plugin.stop', 'plugin.uninstall', 'plugin.reload']))
  })
  it('rejects a third-party (iframe) manifest that declares plugin.grant or plugin.uninstall', () => {
    expect(FIRST_PARTY_ONLY_ACTIONS).toEqual(expect.arrayContaining(['plugin.grant', 'plugin.uninstall']))
    for (const action of ['plugin.grant', 'plugin.uninstall']) {
      const issues = validateBlockManifest({ ...manifest, isolation: 'iframe', actions: [action] })
      expect(issues.map((i) => i.path)).toContain('actions')
    }
  })
})
