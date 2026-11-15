// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelClient, LinkHub, type Workspace } from '@gitrader/blocks-sdk'
import { WorkspaceController } from '../src/core/controller'
import { HostApi } from '../src/core/host-api'
import { presetWorkspace, BLOCK } from '../src/core/presets'
import { validateWorkspace } from '../src/core/workspace'
import { startFixtureKernel, type FixtureKernel } from '../verify/fixture-kernel'
import { sizeOf } from './helpers'

let k: FixtureKernel
let dir: string
let client: KernelClient
let api: HostApi

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('超时'); await new Promise((r) => setTimeout(r, 10)) }
}
const connect = async (): Promise<KernelClient> => {
  const r = await fetch(`${k.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: k.bootstrapToken }) })
  const tok = ((await r.json()) as { sessionToken: string }).sessionToken
  const c = new KernelClient({ url: k.wsUrl, getToken: () => tok })
  await c.connect()
  return c
}
const make = (over: { debounceMs?: number; fallback?: { get(): Workspace | null; set(ws: Workspace): void } } = {}) =>
  new WorkspaceController({ api, sizeOf, debounceMs: 0, now: () => 1791549000000, user: 'usr_local', ...over })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gr-ws-'))
  k = await startFixtureKernel({ workspacesDir: dir })
  client = await connect()
  api = new HostApi(client)
})
afterEach(async () => { client.close(); await k.close(); rmSync(dir, { recursive: true, force: true }) })

describe('工作区保存 / 加载往返（经内核 API 落到 workspaces/*.json）', () => {
  it('保存 → 文件落盘 → 另一个控制器加载后与原布局逐字节相同（含联动通道的值）', async () => {
    const a = make()
    await a.init()
    expect(a.get().items).toHaveLength(9)
    expect(a.pin('bi_agent_1', false).ok).toBe(true) // 人可以取消钉住
    expect(a.resize('bi_chart_1', 14, 17).ok).toBe(true)
    expect(a.usePreset('review').ok).toBe(true)
    expect(a.move('bi_chart_1', 10, 13).ok).toBe(true)
    a.setLink('A', 'symbol', 'hyperliquid:ETH')
    a.configure('bi_chart_1', { interval: '4h' })
    const meta = await a.saveAs('我的盯盘')
    expect(meta.name).toBe('我的盯盘')
    expect(readdirSync(dir)).toEqual(['我的盯盘.json'])
    const onDisk = JSON.parse(readFileSync(join(dir, '我的盯盘.json'), 'utf8')) as Workspace
    expect(onDisk.schema).toBe('gitrader-workspace/1')
    expect(onDisk.channels.A?.symbol).toBe('hyperliquid:ETH')
    expect(onDisk.savedBy).toEqual({ actor: 'user:usr_local', at: 1791549000000 })

    const b = make()
    await b.init() // 内核当前布局
    // 先改乱，再按名字加载
    b.usePreset('minimal')
    const res = await b.loadNamed('我的盯盘')
    expect(res.ok).toBe(true)
    expect(JSON.stringify(b.get())).toBe(JSON.stringify(onDisk))
    expect(validateWorkspace(b.get(), sizeOf)).toEqual([])
    expect((await b.list()).map((m) => m.name)).toEqual(['我的盯盘'])
  })

  it('编辑落盘到内核当前布局：重新连接的新控制器看到同样的布局', async () => {
    const a = make()
    await a.init()
    a.usePreset('minimal')
    await a.flush()
    const b = make()
    await b.init()
    expect(b.get().items.map((i) => i.instanceId)).toEqual(a.get().items.map((i) => i.instanceId))
  })

  it('加载时丢掉本机没装的块，其余照常', async () => {
    const ws = presetWorkspace('minimal')
    ws.items.push({ instanceId: 'bi_x_1', block: 'block.acme.nope@1.0.0', x: 0, y: 0, w: 1, h: 1, channel: 'A' })
    await api.save('带陌生块', ws)
    const c = make()
    await c.init()
    const r = await c.loadNamed('带陌生块')
    expect(r.ok).toBe(true)
    expect(c.get().items.find((i) => i.instanceId === 'bi_x_1')).toBeUndefined()
  })

  it('一键还原：回到人最后保存的布局', async () => {
    const a = make()
    await a.init()
    await a.saveAs('基线')
    a.usePreset('minimal')
    await a.flush()
    await a.revert()
    expect(a.get().items).toHaveLength(9)
  })
})

describe('Agent 改布局', () => {
  it('收到 workspace.changed → 应用并给出可撤销提示；自己的回声按版本号丢弃', async () => {
    const a = make()
    await a.init()
    const seen: string[] = []
    a.onNotice((n) => seen.push(n ? n.by : 'cleared'))
    client.subscribe('workspace.changed', (e) => a.onRemoteChange(e.data as Parameters<typeof a.onRemoteChange>[0]))
    await until(() => k.subscriptions().length === 1)
    k.agentChangeLayout(presetWorkspace('minimal'), 'ak_01JAB5')
    await until(() => a.get().items.length === 4)
    expect(seen).toEqual(['agent:ak_01JAB5'])
    expect(a.notice?.by).toBe('agent:ak_01JAB5')
    a.move('bi_positions_1', 0, 18) // 人的编辑产生新版本，不带 notice
    await a.flush()
    const ver = k.state.revision
    k.publish('workspace.changed', { workspace: presetWorkspace('trade'), by: 'agent:ak_x', revision: ver - 1 }) // 旧版本回声
    await new Promise((r) => setTimeout(r, 60))
    expect(a.get().items).toHaveLength(4)
    await a.revert()
    expect(a.notice).toBeNull()
  })

  it('联动通道值随布局保存', async () => {
    const hub = new LinkHub({ A: { symbol: 'hyperliquid:BTC' } })
    const a = make()
    await a.init()
    hub.onAny((ch, g, v) => a.setLink(ch, g, v))
    hub.set('A', 'symbol', 'hyperliquid:SOL')
    hub.set('B', 'account', 'acct_demo')
    expect(a.get().channels).toMatchObject({ A: { symbol: 'hyperliquid:SOL' }, B: { account: 'acct_demo' } })
    await a.flush()
    expect(k.state.current.channels.A?.symbol).toBe('hyperliquid:SOL')
  })
})

describe('内核没有工作区接口时退到本机', () => {
  it('METHOD_NOT_FOUND → 本地存储兜底，不抛错', async () => {
    const bare = new HostApi({ query: () => Promise.reject(Object.assign(new Error('x'), { code: -32601 })), command: () => Promise.reject(Object.assign(new Error('x'), { code: -32601 })) } as unknown as KernelClient)
    let saved: Workspace | null = null
    const c = new WorkspaceController({ api: bare, sizeOf, debounceMs: 0, fallback: { get: () => saved, set: (w) => { saved = w } } })
    await c.init()
    expect(c.isLocalOnly).toBe(true)
    c.usePreset('minimal')
    await c.flush()
    expect(saved).not.toBeNull()
    expect((saved as unknown as Workspace).items).toHaveLength(4)
    const spy = vi.fn()
    c.subscribe(spy)
    c.move('bi_positions_1', 0, 18)
    expect(spy).toHaveBeenCalled()
  })
})

describe('套用预设不会因为个别块未安装而整体失败', () => {
  it('跳过尺寸查不到的块', async () => {
    const partial = (ref: string) => (ref === BLOCK.equity ? undefined : sizeOf(ref))
    const c = new WorkspaceController({ api, sizeOf: partial, debounceMs: 0 })
    await c.init()
    const r = c.usePreset('trade')
    expect(r.ok).toBe(true)
    expect(c.get().items.some((i) => i.block === BLOCK.equity)).toBe(false)
    expect(validateWorkspace(c.get(), partial)).toEqual([])
  })
})
