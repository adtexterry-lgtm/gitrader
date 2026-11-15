// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error The shell controller is JavaScript and has no declaration file.
import * as standalone from '../src/shell/standalone.js'
// @ts-expect-error The boot entry point is JavaScript and has no declaration file.
import { createRuntime } from '../src/shell/boot.js'

const kernelMocks = vi.hoisted(() => ({ connect: vi.fn(async () => {}) }))
vi.mock('@gitrader/blocks-sdk', () => ({ KernelClient: class { connect() { return kernelMocks.connect() } }, LinkHub: class {} }))
vi.mock('../src/core/host-api', () => ({ HostApi: class {} }))
const sessionMocks = vi.hoisted(() => {
  class MockSessionError extends Error {
    status: number
    problemName: string
    constructor(message: string, status = 401, problemName = 'AUTH_FAILED') {
      super(message)
      this.name = 'SessionError'
      this.status = status
      this.problemName = problemName
    }
  }
  return {
    SessionError: MockSessionError,
    exchangeSession: vi.fn(async (..._args: unknown[]) => null as unknown),
    relinkSession: vi.fn(async (..._args: unknown[]) => null as unknown),
    takeBootstrap: vi.fn((): string | null => null),
  }
})
vi.mock('../src/core/session', () => ({
  SessionError: sessionMocks.SessionError,
  exchangeSession: sessionMocks.exchangeSession,
  relinkSession: sessionMocks.relinkSession,
  takeBootstrap: sessionMocks.takeBootstrap,
}))
vi.mock('../src/core/presets', () => ({ fixedWorkspace: () => ({}) }))
vi.mock('../src/shell/registry.jsx', () => ({ createRegistry: () => ({ registry: {}, firstParty: new Set() }) }))
vi.mock('../src/ui/lib/layout.js', () => ({ setPrefsStore: () => {} }))

class FakeWindow {
  name = ''
  opener: FakeWindow | null = null
  top: FakeWindow = this
  self: FakeWindow = this
  closed = false
  location = { origin: 'https://workbench.invalid', hash: '#/chart/market-a', href: 'https://workbench.invalid/?ui=r5#/chart/market-a' }
  messages: Array<{ data: unknown; targetOrigin: string }> = []
  private listeners = new Map<string, Set<(event: any) => void>>()
  openResult: FakeWindow | null = null
  openCalls: Array<[string, string]> = []
  dispatched: string[] = []
  postSource: FakeWindow = this
  BroadcastChannel?: new (name: string) => FakeChannel
  performance: { getEntriesByType: (type: string) => Array<{ type: string }> } | undefined = { getEntriesByType: () => [{ type: 'navigate' }] }
  history = { state: null as unknown, calls: [] as string[], replaceState: (_state: unknown, _title: string, url: string) => { this.history.calls.push(url) } }

  addEventListener(type: string, fn: (event: any) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(fn); this.listeners.set(type, set) }
  removeEventListener(type: string, fn: (event: any) => void) { this.listeners.get(type)?.delete(fn) }
  emit(type: string, event: any = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event) }
  dispatchEvent(event: { type: string }) { this.dispatched.push(event.type); return true }
  postMessage(data: unknown, targetOrigin: string) {
    this.messages.push({ data, targetOrigin })
    const target = this === this.postSource ? this : this
    target.emit('message', { data, origin: this.location.origin, source: this.postSource })
  }
  open(url: string, name: string) { this.openCalls.push([url, name]); return this.openResult }
  close() { this.closed = true }
  listenerCount(type: string) { return this.listeners.get(type)?.size ?? 0 }
}

class FakeChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  constructor(private bus: FakeChannelBus) { bus.channels.add(this) }
  postMessage(data: unknown) { this.bus.messages.push(data); for (const channel of this.bus.channels) if (channel !== this && !channel.closed) channel.onmessage?.({ data }) }
  close() { this.closed = true }
}

class FakeChannelBus {
  channels = new Set<FakeChannel>()
  messages: unknown[] = []
  factory = () => new FakeChannel(this)
}

function pair() {
  const host = new FakeWindow()
  const child = new FakeWindow()
  child.name = 'gitrader-standalone'
  child.opener = host
  child.top = child
  host.top = new FakeWindow()
  host.openResult = child
  host.postSource = child
  child.postSource = host
  return { host, child, bus: new FakeChannelBus() }
}

function make(options: { win: FakeWindow; bus?: FakeChannelBus; channelFactory?: (name: string) => FakeChannel; getSession?: () => unknown; getPayload?: () => unknown; onDock?: (payload: unknown) => void }) {
  const create = standalone.createStandalone
  if (!create) throw new Error('createStandalone export is not implemented')
  const bus = options.bus ?? new FakeChannelBus()
  return create({ win: options.win, getSession: options.getSession ?? (() => null), getPayload: options.getPayload ?? (() => null), onDock: options.onDock ?? (() => {}), channelFactory: options.channelFactory ?? bus.factory })
}

function bindChannelBus(win: FakeWindow, bus: FakeChannelBus) {
  win.BroadcastChannel = class extends FakeChannel {
    constructor(_name: string) { super(bus) }
  }
}

beforeEach(() => {
  kernelMocks.connect.mockReset().mockResolvedValue(undefined)
  sessionMocks.exchangeSession.mockReset().mockResolvedValue(null)
  sessionMocks.relinkSession.mockReset().mockResolvedValue(null)
  sessionMocks.takeBootstrap.mockReset().mockReturnValue(null)
})
afterEach(() => vi.useRealTimers())

describe('standalone window handshake', () => {
  it('exports the controller and CSS label reader', () => {
    expect(typeof standalone.createStandalone).toBe('function')
    expect(typeof standalone.readModeLabel).toBe('function')
  })

  describe('controller behavior', () => {
  it('distinguishes an embedded host, its named child, and an ordinary tab', () => {
    const host = new FakeWindow(); host.top = new FakeWindow()
    const child = new FakeWindow(); child.name = 'gitrader-standalone'; child.opener = host
    const tab = new FakeWindow()
    expect(make({ win: host }).getSnapshot()).toMatchObject({ mode: 'docked', available: true })
    expect(make({ win: child }).getSnapshot()).toMatchObject({ mode: 'standalone', available: true })
    expect(make({ win: tab }).getSnapshot()).toMatchObject({ mode: 'docked', available: false })
  })

  it('accepts only a same-origin session reply from its opener with the current nonce', async () => {
    vi.useFakeTimers()
    const { host, child } = pair()
    const controller = make({ win: child })
    const pending = controller.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    const helloMessage = host.messages.find((message) => (message.data as any)?.gr === 'standalone-hello')
    expect(helloMessage).toBeDefined()
    const hello = helloMessage!.data as any
    expect(hello).toMatchObject({ gr: 'standalone-hello' })
    child.emit('message', { origin: 'https://other.invalid', source: host, data: { gr: 'standalone-session', nonce: hello.nonce, token: 'bad' } })
    child.emit('message', { origin: host.location.origin, source: new FakeWindow(), data: { gr: 'standalone-session', nonce: hello.nonce, token: 'bad' } })
    child.emit('message', { origin: host.location.origin, source: host, data: { gr: 'standalone-session', nonce: 'stale', token: 'bad' } })
    child.emit('message', { origin: host.location.origin, source: host, data: { gr: 'standalone-session', nonce: hello.nonce, token: 'session-token', pairId: 'pair-a', payload: { route: '#/chart/saved', blockCfg: { chart: { interval: '15m' } } } } })
    await expect(pending).resolves.toEqual({ token: 'session-token' })
    child.emit('message', { origin: host.location.origin, source: host, data: { gr: 'standalone-session', nonce: '', token: 'rejected-token', payload: { route: '#/chart/rejected', blockCfg: { rejected: true } } } })
    await expect(controller.requestSession()).resolves.toEqual({ token: 'session-token' })
    expect(controller.takeInitialPayload()).toEqual({ route: '#/chart/saved', blockCfg: { chart: { interval: '15m' } } })
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('session-token')
    controller.dispose()
  })

  it('polls for a session without persisting or broadcasting the token', async () => {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    let session: { token: string } | null = null
    const parent = make({ win: host, bus, getSession: () => session })
    parent.detach()
    const controller = make({ win: child, bus })
    const pending = controller.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    session = { token: 'session-token' }
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toEqual(session)
    expect(bus.messages.some((message) => JSON.stringify(message).includes('token'))).toBe(false)
    controller.dispose(); parent.dispose()
  })

  it('marks a blocked popup without relinquishing the embedded page', () => {
    const win = new FakeWindow(); win.top = new FakeWindow(); win.openResult = null
    const controller = make({ win })
    controller.detach()
    expect(controller.getSnapshot()).toMatchObject({ mode: 'docked', blocked: true, peer: false })
    expect(win.openCalls[0]?.[1]).toBe('gitrader-standalone')
    expect(win.openCalls[0]?.[0]).toContain('/?ui=r5#/chart/market-a')
    controller.dispose()
  })

  it('marks a thrown popup as blocked and notifies subscribers', () => {
    const win = new FakeWindow(); win.top = new FakeWindow(); win.open = () => { throw new Error('blocked') }
    const controller = make({ win })
    const seen: unknown[] = []
    const unsubscribe = controller.subscribe((snapshot: { blocked: boolean; peer: boolean }) => seen.push(snapshot))
    controller.detach()
    expect(controller.getSnapshot().blocked).toBe(true)
    expect(seen.at(-1)).toMatchObject({ blocked: true, peer: false })
    const count = seen.length
    unsubscribe()
    controller.detach()
    expect(seen).toHaveLength(count)
    controller.dispose()
  })

  it('uses CSS mode labels and removes paired quotes without a JS fallback', () => {
    const doc = { documentElement: {}, defaultView: { getComputedStyle: () => ({ getPropertyValue: (name: string) => name.endsWith('-on') ? '"回嵌"' : "'独立模式'" }) } } as any
    expect(standalone.readModeLabel(doc, false)).toBe('独立模式')
    expect(standalone.readModeLabel(doc, true)).toBe('回嵌')
  })
  })
})

describe('standalone peer lifecycle', () => {
  it('only becomes a peer after ready, pings the host, and docks with route and block config', async () => {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    const received: unknown[] = []
    const parent = make({ win: host, bus, getSession: () => ({ token: 'session-token' }), onDock: (payload: unknown) => received.push(payload) })
    parent.detach()
    const peer = make({ win: child, bus, getPayload: () => ({ route: '#/lab/run-1', blockCfg: { chart: { interval: '1h' } } }) })
    const pending = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toEqual({ token: 'session-token' })
    peer.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(peer.getSnapshot().hostAvailable).toBe(true)
    peer.dock()
    expect(child.closed).toBe(true)
    expect(received).toEqual([{ route: '#/lab/run-1', blockCfg: { chart: { interval: '1h' } } }])
    parent.dispose(); peer.dispose()
  })

  it('disables docking after 500 ms without host pong and cleans resources on dispose', async () => {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    const parent = make({ win: host, bus, getSession: () => ({ token: 'session-token' }) })
    parent.detach()
    const peer = make({ win: child, bus })
    const pending = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toEqual({ token: 'session-token' })
    peer.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    expect(peer.getSnapshot().hostAvailable).toBe(true)
    parent.dispose()
    await vi.advanceTimersByTimeAsync(1500)
    expect(peer.getSnapshot().hostAvailable).toBe(false)
    expect(peer.dock()).toBe(false)
    const before = child.listenerCount('message')
    peer.dispose()
    expect(child.listenerCount('message')).toBeLessThan(before)
  })

  it('does not accept ready messages from a different pair', () => {
    const { host, bus } = pair()
    const parent = make({ win: host, bus })
    const channel = [...bus.channels][0]
    expect(channel).toBeDefined()
    channel!.onmessage?.({ data: { gr: 'ready', pairId: 'other-pair', from: 'standalone' } })
    expect(parent.getSnapshot().peer).toBe(false)
    parent.dispose()
  })

  it('recovers a refreshed host from the child peer offer and confirms the same session', async () => {
    vi.useFakeTimers()
    const bus = new FakeChannelBus()
    const child = new FakeWindow(); child.name = 'gitrader-standalone'
    const oldHost = new FakeWindow(); child.opener = oldHost
    const peer = make({ win: child, bus })
    const initial = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    const helloMessage = oldHost.messages.find((message) => (message.data as any)?.gr === 'standalone-hello')
    expect(helloMessage).toBeDefined()
    const hello = helloMessage!.data as any
    child.emit('message', { origin: oldHost.location.origin, source: oldHost, data: { gr: 'standalone-session', nonce: hello.nonce, token: 'session-token', pairId: 'pair-child' } })
    await expect(initial).resolves.toEqual({ token: 'session-token' })
    peer.connected()

    const refreshedHost = new FakeWindow(); refreshedHost.top = new FakeWindow()
    refreshedHost.postSource = child
    child.opener = refreshedHost
    child.postSource = refreshedHost
    const hostController = make({ win: refreshedHost, bus })
    const recovered = hostController.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    expect(child.messages.map((message) => (message.data as any)?.gr)).toContain('standalone-recover')
    await expect(recovered).resolves.toEqual({ token: 'session-token' })
    expect(hostController.getSnapshot().peer).toBe(true)
    peer.dispose(); hostController.dispose()
  })

  it('re-handshakes after the child refreshes and loses its in-memory session', async () => {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    const parent = make({ win: host, bus, getSession: () => ({ token: 'session-token' }) })
    parent.detach()
    const first = make({ win: child, bus })
    const initial = first.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(initial).resolves.toEqual({ token: 'session-token' })
    first.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    first.dispose()

    const refreshed = make({ win: child, bus })
    const current = refreshed.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(current).resolves.toEqual({ token: 'session-token' })
    refreshed.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    refreshed.dispose(); parent.dispose()
  })
})

describe('r5 isolated coordination', () => {
  it('completes ready, ping, pong, and dock over direct windows with isolated channel buses', async () => {
    vi.useFakeTimers()
    const { host, child } = pair()
    const received: unknown[] = []
    const parent = make({ win: host, bus: new FakeChannelBus(), getSession: () => ({ token: 'test-session-value' }), onDock: (payload: unknown) => received.push(payload) })
    parent.detach()
    const peer = make({ win: child, bus: new FakeChannelBus(), getPayload: () => ({ route: '#/lab/run-1', blockCfg: { bi_chart_1: { interval: '1m' } } }) })
    const pending = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toEqual({ token: 'test-session-value' })
    peer.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(peer.getSnapshot().hostAvailable).toBe(true)
    expect(peer.dock()).toBe(true)
    expect(child.closed).toBe(true)
    expect(received).toEqual([{ route: '#/lab/run-1', blockCfg: { bi_chart_1: { interval: '1m' } } }])
    parent.dispose(); peer.dispose()
  })

  it('deduplicates a dock envelope delivered by both the channel and direct window', async () => {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    const received: unknown[] = []
    const parent = make({ win: host, bus, getSession: () => ({ token: 'test-session-value' }), onDock: (payload: unknown) => received.push(payload) })
    parent.detach()
    const peer = make({ win: child, bus, getPayload: () => ({ route: '#/records', blockCfg: {} }) })
    const pending = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toEqual({ token: 'test-session-value' })
    peer.connected()
    expect(peer.dock()).toBe(true)
    expect(received).toEqual([{ route: '#/records', blockCfg: {} }])
    const dock = bus.messages.find((message) => (message as any)?.gr === 'dock') as any
    expect(dock).toMatchObject({ messageId: expect.any(String), pairId: expect.any(String), from: 'standalone' })
    parent.dispose(); peer.dispose()
  })

  it('keeps the direct window path when BroadcastChannel construction is unavailable', async () => {
    vi.useFakeTimers()
    const { host, child } = pair()
    const unavailable = () => { throw new Error('channel unavailable') }
    const received: unknown[] = []
    const parent = make({ win: host, channelFactory: unavailable, getSession: () => ({ token: 'test-session-value' }), onDock: (payload: unknown) => received.push(payload) })
    expect(parent.getSnapshot().available).toBe(true)
    expect(parent.detach()).toBe(child)
    const peer = make({ win: child, channelFactory: unavailable, getPayload: () => ({ route: '#/records', blockCfg: {} }) })
    const pending = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toEqual({ token: 'test-session-value' })
    peer.connected()
    await vi.advanceTimersByTimeAsync(1000)
    expect(peer.getSnapshot().hostAvailable).toBe(true)
    expect(peer.dock()).toBe(true)
    expect(received).toEqual([{ route: '#/records', blockCfg: {} }])
    parent.dispose(); peer.dispose()
  })

  it('rejects peer offers with invalid origin, source, request id, or pair', async () => {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    const parent = make({ win: host, bus })
    parent.detach()
    const pending = parent.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    const discover = bus.messages.find((message) => (message as any)?.gr === 'host-discover') as any
    expect(discover).toMatchObject({ requestId: expect.any(String) })
    const offer = { gr: 'peer-offer', requestId: discover.requestId, pairId: 'pair-offer', from: 'standalone' }
    host.emit('message', { origin: 'https://invalid.invalid', source: child, data: offer })
    const wrongSource = new FakeWindow(); wrongSource.name = 'gitrader-standalone'
    host.emit('message', { origin: host.location.origin, source: wrongSource, data: offer })
    host.emit('message', { origin: host.location.origin, source: child, data: { ...offer, requestId: 'stale-request' } })
    host.emit('message', { origin: host.location.origin, source: child, data: { ...offer, pairId: 'wrong-pair' } })
    const hostileSource = Object.defineProperties({}, {
      name: { get() { throw new Error('inaccessible source') } },
      opener: { get() { throw new Error('inaccessible opener') } },
    })
    const beforeHostile = parent.getSnapshot()
    expect(() => host.emit('message', { origin: host.location.origin, source: hostileSource, data: offer })).not.toThrow()
    expect(() => host.emit('message', { origin: host.location.origin, source: hostileSource, data: { gr: 'standalone-presence' } })).not.toThrow()
    expect(parent.getSnapshot()).toEqual(beforeHostile)
    expect(child.messages.some((message) => (message.data as any)?.gr === 'standalone-recover')).toBe(false)
    parent.dispose()
    await expect(pending).resolves.toBeNull()
  })
})

describe('r5 refresh and payload recovery', () => {
  it('recovers a refreshed parent over isolated buses and returns a cached session immediately', async () => {
    vi.useFakeTimers()
    const { host, child } = pair()
    const unavailable = () => { throw new Error('channel unavailable') }
    const oldParent = make({ win: host, channelFactory: unavailable, getSession: () => ({ token: 'test-session-value' }) })
    oldParent.detach()
    let payload = { route: '#/records', blockCfg: { bi_chart_1: { interval: '5m' } } }
    const peer = make({ win: child, channelFactory: unavailable, getPayload: () => payload })
    const initial = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(initial).resolves.toEqual({ token: 'test-session-value' })
    peer.connected()
    expect(oldParent.getSnapshot().peer).toBe(true)
    oldParent.dispose()

    const refreshedHost = new FakeWindow(); refreshedHost.top = new FakeWindow()
    refreshedHost.postSource = child
    child.opener = refreshedHost
    child.postSource = refreshedHost
    payload = { route: '#/lab/latest', blockCfg: { bi_chart_1: { interval: '1m' } } }
    const hostController = make({ win: refreshedHost, channelFactory: unavailable })
    const recovered = hostController.requestSession()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(recovered).resolves.toEqual({ token: 'test-session-value' })
    expect(hostController.getSnapshot().peer).toBe(true)
    expect(hostController.takeInitialPayload()).toEqual(payload)
    expect(hostController.takeInitialPayload()).toBeNull()

    let settled = false
    const cached = hostController.requestSession().then((session: unknown) => { settled = true; return session })
    await Promise.resolve()
    expect(settled).toBe(true)
    await expect(cached).resolves.toEqual({ token: 'test-session-value' })
    peer.dispose(); hostController.dispose()
  })

  it('re-handshakes after a child refresh with isolated channel buses', async () => {
    vi.useFakeTimers()
    const { host, child } = pair()
    const unavailable = () => { throw new Error('channel unavailable') }
    const parent = make({ win: host, channelFactory: unavailable, getSession: () => ({ token: 'test-session-value' }) })
    parent.detach()
    const first = make({ win: child, channelFactory: unavailable })
    const initial = first.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(initial).resolves.toEqual({ token: 'test-session-value' })
    first.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    first.dispose()

    const refreshed = make({ win: child, channelFactory: unavailable })
    const current = refreshed.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(current).resolves.toEqual({ token: 'test-session-value' })
    refreshed.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    refreshed.dispose(); parent.dispose()
  })
})

describe('r5 refresh-before-startup request', () => {
  it('returns a nonce-verified parent recovery token immediately if recovery precedes requestSession', async () => {
    vi.useFakeTimers()
    const { host, child } = pair()
    const unavailable = () => { throw new Error('channel unavailable') }
    const oldParent = make({ win: host, channelFactory: unavailable, getSession: () => ({ token: 'test-session-value' }) })
    oldParent.detach()
    const peer = make({ win: child, channelFactory: unavailable })
    const initial = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(initial).resolves.toEqual({ token: 'test-session-value' })
    peer.connected()
    oldParent.dispose()

    const refreshedHost = new FakeWindow(); refreshedHost.top = new FakeWindow()
    refreshedHost.postSource = child
    child.opener = refreshedHost
    child.postSource = refreshedHost
    const hostController = make({ win: refreshedHost, channelFactory: unavailable })
    await vi.advanceTimersByTimeAsync(1000)
    expect(hostController.getSnapshot().peer).toBe(true)
    let settled = false
    const recovered = hostController.requestSession().then((session: unknown) => { settled = true; return session })
    await Promise.resolve()
    expect(settled).toBe(true)
    await expect(recovered).resolves.toEqual({ token: 'test-session-value' })
    peer.dispose(); hostController.dispose()
  })
})

describe('r5 authenticated startup payload', () => {
  it('takes a nonce-verified initial payload once and applies it across isolated storage', async () => {
    const { host, child } = pair()
    const payload = { route: '#/lab/initial', blockCfg: { bi_chart_1: { interval: '15m' } } }
    const parent = make({ win: host, bus: new FakeChannelBus(), getSession: () => ({ token: 'test-session-value' }), getPayload: () => payload })
    parent.detach()
    bindChannelBus(child, new FakeChannelBus())
    const doc = { defaultView: child, documentElement: { setAttribute() {} }, getElementById: () => null }
    const loc = {
      protocol: 'https:', host: 'workbench.invalid', origin: child.location.origin,
      search: '?ui=r5&keep=1', hash: '#/chart/start',
      href: `${child.location.origin}/?ui=r5&keep=1#/chart/start`,
    }
    const writes: string[] = []
    const storage = { getItem: () => null, setItem: (_key: string, value: string) => writes.push(value) }
    const runtime = createRuntime({ doc, loc, storage, win: child })
    await runtime.ready
    expect(runtime.prefs.get().blockCfg).toEqual(payload.blockCfg)
    expect(writes).toHaveLength(1)
    expect(child.history.calls).toEqual(['/?ui=r5&keep=1#/lab/initial'])
    expect(child.dispatched).toEqual(['hashchange'])
    expect(runtime.standalone.takeInitialPayload()).toBeNull()
    parent.dispose(); runtime.standalone.dispose()
  })

  it('ignores invalid routes and non-plain block config from an initial payload', async () => {
    const { host, child } = pair()
    const parent = make({ win: host, bus: new FakeChannelBus(), getSession: () => ({ token: 'test-session-value' }), getPayload: () => ({ route: '/not-a-hash-route', blockCfg: [] }) })
    parent.detach()
    bindChannelBus(child, new FakeChannelBus())
    const doc = { defaultView: child, documentElement: { setAttribute() {} }, getElementById: () => null }
    const loc = { protocol: 'https:', host: 'workbench.invalid', origin: child.location.origin, search: '?ui=r5&keep=1', hash: '#/chart/start', href: `${child.location.origin}/?ui=r5&keep=1#/chart/start` }
    const writes: string[] = []
    const storage = { getItem: () => null, setItem: (_key: string, value: string) => writes.push(value) }
    const runtime = createRuntime({ doc, loc, storage, win: child })
    await runtime.ready
    expect(runtime.prefs.get().blockCfg).toEqual({})
    expect(writes).toHaveLength(0)
    expect(child.history.calls).toEqual([])
    parent.dispose(); runtime.standalone.dispose()
  })
})

describe('r5 iframe bootstrap error recovery', () => {
  const makeFrameRuntime = (win: FakeWindow, storage: { getItem: () => null; setItem: (_key: string, value: string) => void }, ui = 'r5') => {
    bindChannelBus(win, new FakeChannelBus())
    const doc = { defaultView: win, documentElement: { setAttribute() {} }, getElementById: () => null }
    const loc = { protocol: 'https:', host: 'workbench.invalid', origin: win.location.origin, search: `?ui=${ui}`, hash: '#/chart/start', href: `${win.location.origin}/?ui=${ui}#/chart/start` }
    return createRuntime({ doc, loc, storage, win })
  }

  it('preserves a fetch rejection when iframe recovery times out', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow(); win.top = new FakeWindow()
    const error = new Error('exchange rejected')
    sessionMocks.takeBootstrap.mockReturnValue('bootstrap-placeholder')
    sessionMocks.exchangeSession.mockRejectedValue(error)
    const runtime = makeFrameRuntime(win, { getItem: () => null, setItem: () => {} })
    const ready = runtime.ready
    await vi.advanceTimersByTimeAsync(3000)
    const result = await ready
    expect(result.kind).toBe('network')
    expect(result.error).toBe(error)
    runtime.standalone.dispose()
  })

  it('preserves a server session error when iframe recovery times out', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow(); win.top = new FakeWindow()
    const error = new sessionMocks.SessionError('temporary exchange failure', 503, 'TEMPORARY')
    sessionMocks.takeBootstrap.mockReturnValue('bootstrap-placeholder')
    sessionMocks.exchangeSession.mockRejectedValue(error)
    const runtime = makeFrameRuntime(win, { getItem: () => null, setItem: () => {} })
    const ready = runtime.ready
    await vi.advanceTimersByTimeAsync(3000)
    const result = await ready
    expect(result.kind).toBe('session')
    expect(result.error).toBe(error)
    runtime.standalone.dispose()
  })

  it('keeps expected session expiry unified when iframe recovery times out', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow(); win.top = new FakeWindow()
    const error = new sessionMocks.SessionError('expired', 401, 'AUTH_FAILED')
    sessionMocks.takeBootstrap.mockReturnValue('bootstrap-placeholder')
    sessionMocks.exchangeSession.mockRejectedValue(error)
    const runtime = makeFrameRuntime(win, { getItem: () => null, setItem: () => {} })
    const ready = runtime.ready
    await vi.advanceTimersByTimeAsync(3000)
    const result = await ready
    expect(result.kind).toBe('session')
    expect(result.error).not.toBe(error)
    runtime.standalone.dispose()
  })

  it('keeps the r4 exchange failure branch unchanged', async () => {
    const win = new FakeWindow(); win.top = new FakeWindow()
    const error = new Error('exchange rejected')
    sessionMocks.takeBootstrap.mockReturnValue('bootstrap-placeholder')
    sessionMocks.exchangeSession.mockRejectedValue(error)
    const runtime = makeFrameRuntime(win, { getItem: () => null, setItem: () => {} }, 'r4')
    const result = await runtime.ready
    expect(result.kind).toBe('network')
    expect(result.error).toBe(error)
    expect(runtime.standalone).toBeNull()
  })

  it('recovers from the saved child session and applies its last payload over partitioned storage', async () => {
    vi.useFakeTimers()
    const { host, child } = pair()
    const unavailable = () => { throw new Error('channel unavailable') }
    const oldParent = make({ win: host, channelFactory: unavailable, getSession: () => ({ token: 'test-session-value' }) })
    oldParent.detach()
    let payload = { route: '#/records/initial', blockCfg: { bi_chart_1: { interval: '5m' } } }
    const peer = make({ win: child, channelFactory: unavailable, getPayload: () => payload })
    const initial = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await expect(initial).resolves.toEqual({ token: 'test-session-value' })
    peer.connected()
    oldParent.dispose()

    const hostBus = new FakeChannelBus()
    bindChannelBus(host, hostBus)
    const error = new sessionMocks.SessionError('temporary exchange failure', 503, 'TEMPORARY')
    sessionMocks.takeBootstrap.mockReturnValue('bootstrap-placeholder')
    sessionMocks.exchangeSession.mockRejectedValue(error)
    payload = { route: '#/lab/recovered', blockCfg: { bi_chart_1: { interval: '1m' } } }
    const doc = { defaultView: host, documentElement: { setAttribute() {} }, getElementById: () => null }
    const loc = { protocol: 'https:', host: 'workbench.invalid', origin: host.location.origin, search: '?ui=r5&keep=1', hash: '#/chart/start', href: `${host.location.origin}/?ui=r5&keep=1#/chart/start` }
    const writes: string[] = []
    const storage = { getItem: () => null, setItem: (_key: string, value: string) => writes.push(value) }
    const runtime = createRuntime({ doc, loc, storage, win: host })
    const ready = runtime.ready
    await vi.advanceTimersByTimeAsync(1000)
    const result = await ready
    expect(result.online).toBe(true)
    expect(runtime.state.session).toEqual({ token: 'test-session-value' })
    expect(runtime.prefs.get().blockCfg).toEqual(payload.blockCfg)
    expect(writes).toHaveLength(1)
    expect(host.history.calls).toEqual(['/?ui=r5&keep=1#/lab/recovered'])
    peer.dispose(); runtime.standalone.dispose()
  })
})

describe('r5 launch parameter cleanup', () => {
  it('removes launch from the address while preserving ui, other params, and route hash', async () => {
    const win = new FakeWindow()
    vi.stubGlobal('window', win)
    const doc = { defaultView: win, documentElement: { setAttribute() {} }, getElementById: () => null }
    const loc = { protocol: 'https:', host: 'workbench.invalid', origin: 'https://workbench.invalid', search: '?ui=r5&launch=bootstrap-marker&keep=1', hash: '#/chart/market-a', href: 'https://workbench.invalid/?ui=r5&launch=bootstrap-marker&keep=1#/chart/market-a' }
    const storage = { getItem: () => null, setItem: () => {} }
    const runtime = createRuntime({ doc, loc, storage, fetchFn: async () => ({}), relink: false })
    await runtime.ready
    expect(runtime.ui).toBe('r5')
    expect(win.history.calls).toEqual(['/?ui=r5&keep=1#/chart/market-a'])
    runtime.standalone?.dispose()

    win.history.calls.length = 0
    const r4loc = { ...loc, search: '?ui=r4&launch=leave-alone&keep=1', href: 'https://workbench.invalid/?ui=r4&launch=leave-alone&keep=1#/chart/market-a' }
    const oldRuntime = createRuntime({ doc, loc: r4loc, storage, fetchFn: async () => ({}), relink: false })
    await oldRuntime.ready
    expect(oldRuntime.ui).toBe('r4')
    expect(oldRuntime.standalone).toBeNull()
    expect(win.history.calls).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe('r5 successful session reconnect hint cleanup', () => {
  const makeDocWithHint = (win: FakeWindow, hint: { remove: () => void }) => ({
    defaultView: win,
    documentElement: { setAttribute() {} },
    getElementById: (id: string) => id === 'gitrader-relink-hint' ? hint : null,
  })

  it('keeps the hint while recovered r5 connect is pending, then removes it after success', async () => {
    const { host, child } = pair()
    const parent = make({ win: host, bus: new FakeChannelBus(), getSession: () => ({ token: 'test-session-value' }) })
    parent.detach()
    bindChannelBus(child, new FakeChannelBus())
    const hint = { remove: vi.fn() }
    const doc = makeDocWithHint(child, hint)
    const loc = { protocol: 'https:', host: 'workbench.invalid', origin: child.location.origin, search: '?ui=r5', hash: '#/chart/start', href: `${child.location.origin}/?ui=r5#/chart/start` }
    let finishConnect = () => {}
    let markConnectStarted = () => {}
    const connectStarted = new Promise<void>((resolve) => { markConnectStarted = resolve })
    kernelMocks.connect.mockImplementation(() => {
      markConnectStarted()
      return new Promise<void>((resolve) => { finishConnect = resolve })
    })
    const runtime = createRuntime({ doc, loc, storage: { getItem: () => null, setItem: () => {} }, win: child })
    const ready = runtime.ready
    try {
      await connectStarted
      expect(runtime.state.session).toEqual({ token: 'test-session-value' })
      expect(hint.remove).not.toHaveBeenCalled()
      finishConnect()
      const result = await ready
      expect(result.online).toBe(true)
      expect(hint.remove).toHaveBeenCalledTimes(1)
    } finally {
      finishConnect()
      parent.dispose()
      runtime.standalone?.dispose()
    }
  })

  it('does not add successful hint removal to r4 startup', async () => {
    const win = new FakeWindow()
    const hint = { remove: vi.fn() }
    const doc = makeDocWithHint(win, hint)
    const loc = { protocol: 'https:', host: 'workbench.invalid', origin: win.location.origin, search: '?ui=r4', hash: '#/chart/start', href: `${win.location.origin}/?ui=r4#/chart/start` }
    sessionMocks.takeBootstrap.mockReturnValue('bootstrap-placeholder')
    sessionMocks.exchangeSession.mockResolvedValue({ token: 'test-session-value' })
    const runtime = createRuntime({ doc, loc, storage: { getItem: () => null, setItem: () => {} }, win })
    const result = await runtime.ready
    expect(result.online).toBe(true)
    expect(hint.remove).not.toHaveBeenCalled()
    expect(runtime.standalone).toBeNull()
  })

  it('preserves the original connect error and kind', async () => {
    const win = new FakeWindow()
    const doc = { defaultView: win, documentElement: { setAttribute() {} }, getElementById: () => null }
    const loc = { protocol: 'https:', host: 'workbench.invalid', origin: win.location.origin, search: '?ui=r4', hash: '#/chart/start', href: `${win.location.origin}/?ui=r4#/chart/start` }
    const error = new Error('kernel connect failed')
    sessionMocks.takeBootstrap.mockReturnValue('bootstrap-placeholder')
    sessionMocks.exchangeSession.mockResolvedValue({ token: 'test-session-value' })
    kernelMocks.connect.mockRejectedValueOnce(error)
    const runtime = createRuntime({ doc, loc, storage: { getItem: () => null, setItem: () => {} }, win })
    const result = await runtime.ready
    expect(result.online).toBe(false)
    expect(result.kind).toBe('network')
    expect(result.error).toBe(error)
  })
})

describe('r5 refreshed child payload precedence', () => {
  const unavailable = () => { throw new Error('channel unavailable') }
  const parentPayload = {
    route: '#/records/parent',
    blockCfg: {
      bi_chart_1: { interval: '5m', source: 'parent' },
      bi_symbols_1: { recent: ['parent'] },
    },
  }
  const localPayload = {
    route: '#/chart/local',
    blockCfg: {
      bi_chart_1: { interval: '1h', localOnly: true },
      bi_positions_1: { view: 'symbol' },
    },
  }

  async function recoveredPayload(performance: FakeWindow['performance']) {
    vi.useFakeTimers()
    const { host, child } = pair()
    child.performance = performance
    const parent = make({ win: host, channelFactory: unavailable, getSession: () => ({ token: 'session-marker' }), getPayload: () => parentPayload })
    parent.detach()
    const refreshedChild = make({ win: child, channelFactory: unavailable, getPayload: () => localPayload })
    try {
      const session = refreshedChild.requestSession()
      await vi.advanceTimersByTimeAsync(0)
      await expect(session).resolves.toEqual({ token: 'session-marker' })
      return refreshedChild.takeInitialPayload()
    } finally {
      refreshedChild.dispose()
      parent.dispose()
    }
  }

  const restoreExpected = {
    route: '#/chart/local',
    blockCfg: {
      bi_chart_1: { interval: '1h', source: 'parent', localOnly: true },
      bi_symbols_1: { recent: ['parent'] },
      bi_positions_1: { view: 'symbol' },
    },
  }

  it('uses child route and merged local config after reload while retaining unrelated parent instances', async () => {
    expect(await recoveredPayload({ getEntriesByType: () => [{ type: 'reload' }] })).toEqual(restoreExpected)
  })

  it('uses child route and merged local config after back-forward restoration', async () => {
    expect(await recoveredPayload({ getEntriesByType: () => [{ type: 'back_forward' }] })).toEqual(restoreExpected)
  })

  it('uses the full parent payload after a fresh navigation despite stale local values', async () => {
    expect(await recoveredPayload({ getEntriesByType: () => [{ type: 'navigate' }] })).toEqual(parentPayload)
  })

  it('falls back to first-use parent payload when navigation type is missing or unreadable', async () => {
    const missing = await recoveredPayload(undefined)
    const unreadable = await recoveredPayload({ getEntriesByType: () => { throw new Error('navigation unavailable') } })
    const other = await recoveredPayload({ getEntriesByType: () => [{ type: 'prerender' }] })
    expect(missing).toEqual(parentPayload)
    expect(unreadable).toEqual(parentPayload)
    expect(other).toEqual(parentPayload)
  })
})

describe('r5 CSS mode label decoding', () => {
  const read = (serialized: string, standaloneMode = false) => {
    const doc = {
      documentElement: {},
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => serialized }) },
    } as any
    return standalone.readModeLabel(doc, standaloneMode)
  }

  it('decodes both serialized Chinese mode labels from CSS tokens', () => {
    expect(read('"\\72ec\\7acb\\6a21\\5f0f"')).toBe('独立模式')
    expect(read('"\\56de\\5d4c"', true)).toBe('回嵌')
  })

  it('consumes one CSS whitespace terminator after a hexadecimal escape', () => {
    expect(read('"\\41 B"')).toBe('AB')
    expect(read('"\\41\r\nB"')).toBe('AB')
  })

  it('decodes simple quote and backslash escapes once', () => {
    expect(read("'a\\'b\\\\c'")).toBe("a'b\\c")
    expect(read('plain\\q')).toBe('plainq')
  })

  it('removes escaped LF, CRLF, and form-feed continuations', () => {
    expect(read('"a\\\nb"')).toBe('ab')
    expect(read('"a\\\r\nb"')).toBe('ab')
    expect(read('"a\\\fb"')).toBe('ab')
  })

  it('replaces zero, surrogate, and out-of-range code points', () => {
    expect(read('"\\0  \\d800  \\110000"')).toBe('\uFFFD \uFFFD \uFFFD')
  })

  it('keeps empty values and computed-style failures empty', () => {
    expect(read('')).toBe('')
    const doc = { documentElement: {}, defaultView: { getComputedStyle: () => { throw new Error('style unavailable') } } } as any
    expect(standalone.readModeLabel(doc, false)).toBe('')
  })
})

describe('r5 peer liveness (S1d B1)', () => {
  async function attach() {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    const docked: unknown[] = []
    const parent = make({ win: host, bus, getSession: () => ({ token: 'session-token' }), onDock: (payload: unknown) => docked.push(payload) })
    parent.detach()
    const peer = make({ win: child, bus, getPayload: () => ({ route: '#/records' }) })
    const pending = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await pending
    peer.connected()
    expect(parent.getSnapshot().peer).toBe(true)
    return { host, child, bus, parent, peer, docked }
  }

  it('resets the embedded page within 3 s when the child window is hard-closed without a dock message', async () => {
    const { child, parent, peer, docked } = await attach()
    child.closed = true
    peer.dispose() // 渲染进程直接消失：没有 pagehide、没有 dock
    await vi.advanceTimersByTimeAsync(3000)
    expect(parent.getSnapshot().peer).toBe(false)
    expect(docked).toEqual([null])
    parent.dispose()
  })

  it('resets when a still-open child goes silent for more than 3 pings', async () => {
    const { parent, peer } = await attach()
    peer.dispose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(parent.getSnapshot().peer).toBe(true)
    await vi.advanceTimersByTimeAsync(2100)
    expect(parent.getSnapshot().peer).toBe(false)
    parent.dispose()
  })

  it('sends dock on pagehide even when the host was never reachable', async () => {
    vi.useFakeTimers()
    const { host, child, bus } = pair()
    const parent = make({ win: host, bus, getSession: () => ({ token: 'session-token' }) })
    parent.detach()
    const peer = make({ win: child, bus })
    const pending = peer.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(peer.getSnapshot().hostAvailable).toBe(false)
    child.emit('pagehide')
    expect(bus.messages.some((m: any) => m?.gr === 'dock' && m.reason === 'pagehide')).toBe(true)
    parent.dispose(); peer.dispose()
  })

  it('keeps the peer card when the child only reloads, and docks when it never comes back', async () => {
    const { child, bus, parent, peer, docked } = await attach()
    child.emit('pagehide') // 子窗刷新：旧文档 pagehide
    peer.dispose()
    await vi.advanceTimersByTimeAsync(800)
    expect(parent.getSnapshot().peer).toBe(true)
    // 新文档上线
    const reloaded = make({ win: child, bus, getPayload: () => ({ route: '#/records' }) })
    const again = reloaded.requestSession()
    await vi.advanceTimersByTimeAsync(0)
    await again
    reloaded.connected()
    await vi.advanceTimersByTimeAsync(2000)
    expect(parent.getSnapshot().peer).toBe(true)
    expect(docked).toEqual([])
    // 再来一次，这回不回来
    child.emit('pagehide')
    reloaded.dispose()
    await vi.advanceTimersByTimeAsync(1600)
    expect(parent.getSnapshot().peer).toBe(false)
    expect(docked).toEqual([{ route: '#/records' }])
    parent.dispose()
  })

  it('makes the dock request fall back to a reset when the child window is already closed', async () => {
    const { child, parent, peer } = await attach()
    child.closed = true
    expect(parent.dock()).toBe(false)
    expect(parent.getSnapshot().peer).toBe(false)
    parent.dispose(); peer.dispose()
  })
})
