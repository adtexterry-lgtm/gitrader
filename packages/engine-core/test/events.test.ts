// SPDX-License-Identifier: CPAL-1.0
// 事件流：顺序号与去重、确认、背压（无损流不丢 / 可合并流带 conflated / 日志流带丢弃计数）、续传与缺口、溢出告警。
import { afterEach, describe, expect, it } from 'vitest'
import { checkEventSequence, type GepEvent } from '../src/proto'
import { validateEventsPush } from '../../protocol/src/validate'
import { Session } from '../src/gep/session'
import { rig, bindPaper, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

function collect(s: Session): { events: GepEvent[]; pushes: unknown[]; overflow: unknown[] } {
  const out = { events: [] as GepEvent[], pushes: [] as unknown[], overflow: [] as unknown[] }
  s.attach((method, params) => {
    if (method === 'events.push') { out.pushes.push(params); out.events.push(...(params as { events: GepEvent[] }).events) } else out.overflow.push(params)
  })
  return out
}
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

describe('Session：顺序、批量、确认', () => {
  it('10,000 条事件：seq 严格递增、eventId 不重复、每批过 schema、每批 ≤ 500 条', async () => {
    const s = new Session()
    const got = collect(s)
    s.subscribe(['signal', 'strategy'])
    for (let i = 0; i < 10_000; i++) s.emit({ stream: i % 2 ? 'signal' : 'strategy', type: i % 2 ? 'signal.created' : 'strategy.error', data: { i } })
    s.flush()
    expect(got.events).toHaveLength(10_000)
    expect(checkEventSequence(got.events)).toEqual([])
    for (const p of got.pushes) { expect(validateEventsPush(p).ok).toBe(true); expect((p as { events: unknown[] }).events.length).toBeLessThanOrEqual(500) }
  })

  it('只推订阅了的流；订阅可按账户过滤；未订阅的事件仍占 seq（保留窗内可续传）', () => {
    const s = new Session()
    const got = collect(s)
    s.subscribe(['signal'], ['acct_A'])
    s.emit({ stream: 'strategy', type: 'strategy.started', data: {} })
    s.emit({ stream: 'signal', type: 'signal.created', accountId: 'acct_A', data: {} })
    s.emit({ stream: 'signal', type: 'signal.created', accountId: 'acct_B', data: {} })
    s.flush()
    expect(got.events.map((e) => e.seq)).toEqual([2])
    expect(s.seq).toBe(3)
  })
})

describe('Session：背压（未确认 > 5,000 条）', () => {
  it('停发 ack：无损流 0 丢失；可合并流被合并并带 conflated 计数；日志流丢弃并带计数', async () => {
    const s = new Session({ conflateReleaseMs: 20 })
    const got = collect(s)
    s.subscribe(['signal', 'health', 'log'])
    for (let i = 0; i < 6000; i++) s.emit({ stream: 'signal', type: 'signal.created', data: { i } })
    s.flush()
    expect(s.unacked).toBe(6000)
    // 已超过阈值：之后的 health 事件不再逐条发出，而是按键合并
    for (let i = 0; i < 500; i++) s.emit({ stream: 'health', type: 'health.metrics', data: { n: i }, key: 'k' })
    for (let i = 0; i < 300; i++) s.emit({ stream: 'log', type: 'log.line', data: { i } })
    for (let i = 0; i < 100; i++) s.emit({ stream: 'signal', type: 'signal.created', data: { i: 6000 + i } })
    await sleep(80)
    s.flush()
    const signals = got.events.filter((e) => e.stream === 'signal')
    expect(signals).toHaveLength(6100) // 无损流一条不少
    expect(checkEventSequence(got.events)).toEqual([])
    const health = got.events.filter((e) => e.stream === 'health')
    expect(health.length).toBeGreaterThan(0)
    expect(health.length).toBeLessThan(10)
    expect(health.reduce((a, e) => a + (e.conflated ?? 0), 0) + health.length).toBe(500) // 发出的 + 被合并的 = 全部
    expect((health[health.length - 1]!.data as { n: number }).n).toBe(499) // 保留最新
    const logs = got.events.filter((e) => e.stream === 'log')
    expect(logs.reduce((a, e) => a + (e.conflated ?? 0), 0)).toBe(300) // 丢弃计数
  })

  it('确认之后恢复：被暂存的最新状态立刻补发', async () => {
    const s = new Session({ conflateReleaseMs: 10_000 })
    const got = collect(s)
    s.subscribe(['signal', 'health'])
    for (let i = 0; i < 5100; i++) s.emit({ stream: 'signal', type: 'signal.created', data: {} })
    s.flush()
    s.emit({ stream: 'health', type: 'health.metrics', data: { n: 1 } })
    s.emit({ stream: 'health', type: 'health.metrics', data: { n: 2 } })
    s.flush()
    expect(got.events.filter((e) => e.stream === 'health')).toHaveLength(0)
    s.ack(5100)
    s.flush()
    const h = got.events.filter((e) => e.stream === 'health')
    expect(h).toHaveLength(1)
    expect(h[0]!.conflated).toBe(1)
    expect((h[0]!.data as { n: number }).n).toBe(2)
  })
})

describe('Session：保留窗、续传、缺口、溢出', () => {
  it('在 seq=N 断线后续传：补发 N+1…M 无缺口、无重复', () => {
    const s = new Session()
    let got = collect(s)
    s.subscribe(['signal'])
    for (let i = 0; i < 50; i++) s.emit({ stream: 'signal', type: 'signal.created', data: { i } })
    s.flush()
    const N = 30
    s.detach()
    for (let i = 50; i < 80; i++) s.emit({ stream: 'signal', type: 'signal.created', data: { i } })
    expect(s.canResumeFrom(N)).toBe('ok')
    got = collect(s)
    s.rewindTo(N)
    s.flush()
    expect(got.events.map((e) => e.seq)).toEqual(Array.from({ length: 80 - N }, (_, i) => N + 1 + i))
  })

  it('lastSeq 早于保留窗 → gap；lastSeq 超前 → future', () => {
    const s = new Session({ retentionMinEvents: 10, retentionMinMs: 0 })
    s.subscribe(['signal'])
    collect(s)
    for (let i = 0; i < 100; i++) s.emit({ stream: 'signal', type: 'signal.created', data: {} })
    s.flush()
    s.ack(100)
    s.emit({ stream: 'signal', type: 'signal.created', data: {} }) // 触发修剪
    expect(s.firstSeq()).toBeGreaterThan(80)
    expect(s.canResumeFrom(5)).toBe('gap')
    expect(s.canResumeFrom(s.seq - 3)).toBe('ok')
    expect(s.canResumeFrom(s.seq + 10)).toBe('future')
  })

  it('缓冲到硬上限：丢最老的无损事件并发 gep.overflow（宿主随后必须 engine.snapshot）', () => {
    const s = new Session({ hardCapEvents: 100, retentionMinEvents: 10 })
    const got = collect(s)
    s.subscribe(['signal'])
    for (let i = 0; i < 150; i++) s.emit({ stream: 'signal', type: 'signal.created', data: {} })
    s.flush()
    expect(s.droppedLossless).toBeGreaterThan(0)
    expect(got.overflow.length).toBeGreaterThan(0)
    expect(s.bufferedEvents).toBeLessThanOrEqual(100)
  })
})

describe('GEP 会话：hello 续传 / 缺口', () => {
  it('断线 3 秒内重连：resumed = true，补发断线期间产生的事件', async () => {
    r = await rig()
    await bindPaper(r)
    await r.session.call('events.subscribe', { streams: ['strategy'] })
    const { instanceId } = await r.session.call('strategy.start', { strategyId: 'ema-trend', accountId: 'acct_01JABAPAPER000000000000001', instruments: ['hyperliquid:BTC'], interval: '1m', params: {}, mandateId: 'mdt_01JABAENG01' })
    expect(await r.session.waitFor(() => r!.session.events.some((e) => e.type === 'strategy.started'), 1500)).toBe(true)
    const lastSeq = Math.max(...r.session.events.map((e) => e.seq))
    const sessionId = r.session.sessionId
    r.session.close()
    await sleep(50)
    // 断线期间产生事件
    r.core.instances.stop(instanceId)
    // 重连
    const { GepSession } = await import('../../protocol/conformance/session')
    const { createMemoryPair, memoryTransport } = await import('../../protocol/conformance/transport')
    const { HostSim } = await import('../../protocol/conformance/host-sim')
    const [engineEnd, hostEnd] = createMemoryPair()
    const core = r.core
    const conn = core.connect({ kind: 'memory', send: (t) => engineEnd.send(t), closeTransport: () => engineEnd.close(), maxFrameBytes: 4 * 1024 * 1024 })
    engineEnd.onMessage((t) => { void conn.peer.receive(t) })
    engineEnd.onClose(() => core.disconnect(conn))
    const s2 = new GepSession(memoryTransport(hostEnd), new HostSim())
    const o = await s2.hello({ token: 'test-token-0000', resume: { sessionId, lastSeq } })
    expect(o.ok).toBe(true)
    if (o.ok) { expect(o.result.resumed).toBe(true); expect(o.result.sessionId).toBe(sessionId); expect(o.result.fromSeq).toBe(lastSeq + 1) }
    expect(await s2.waitFor(() => s2.events.some((e) => e.type === 'strategy.stopped'), 1500)).toBe(true)
    expect(s2.events[0]!.seq).toBeGreaterThan(lastSeq)
    expect(checkEventSequence(s2.events, lastSeq)).toEqual([])
    s2.close()
  })

  it('未知会话续传 → 5004，连接仍可用：engine.snapshot 对齐', async () => {
    r = await rig({ hello: false })
    const o = await r.session.hello({ token: 'test-token-0000', resume: { sessionId: 'ses_01JABUNKNOWN0000000000001', lastSeq: 10 } })
    expect(o.ok).toBe(false)
    if (!o.ok) expect(o.error.code).toBe(5004)
    const snap = await r.session.call('engine.snapshot', {})
    expect(snap).toHaveProperty('seq')
    expect(Array.isArray(snap.strategies)).toBe(true)
  })
})
