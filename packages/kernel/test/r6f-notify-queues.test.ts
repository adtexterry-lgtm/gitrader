// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03：通知出口按通道拆独立队列（一个通道挂死不拖慢别的通道）、critical 插队、落盘补发。
// 用假的插件宿主直接驱动 NotifyOutlet，不起真插件进程。
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '../src/events'
import { NotifyOutlet } from '../src/notify/outlet'
import type { PluginHost } from '../src/plugins'
import type { NotifyConfig } from '../src/config'

interface Sent { plugin: string; key: string; topic: string; level: string; lines: string[] }
type Behaviour = 'ok' | 'hang' | { gate: Promise<void> }

const dirs: string[] = []
const outlets: NotifyOutlet[] = []
afterEach(() => {
  for (const o of outlets.splice(0)) o.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function world(behaviour: Record<string, Behaviour>, outboxFile?: string, nowMs: () => number = Date.now) {
  const sent: Sent[] = []
  const events = new EventBus(nowMs, () => {})
  const host = {
    get: () => ({}),
    callTool: async (plugin: string, _tool: string, args: { notice: Sent & { lines: string[] } }): Promise<unknown> => {
      sent.push({ plugin, key: args.notice.key, topic: args.notice.topic, level: args.notice.level, lines: args.notice.lines })
      const b = behaviour[plugin] ?? 'ok'
      if (b === 'hang') return new Promise(() => {})
      if (b !== 'ok') await b.gate
      return { ok: true }
    },
  } as unknown as PluginHost
  const config: NotifyConfig = {
    channels: [
      { id: 'A', plugin: 'pA', minLevel: 'info', params: {} },
      { id: 'B', plugin: 'pB', minLevel: 'info', params: {} },
    ],
    rateLimit: { perChannelPerMinute: 100, dedupeWindowSec: 300 },
  }
  const outlet = new NotifyOutlet({ events, plugins: host, config: () => config, now: nowMs, log: () => {}, ...(outboxFile ? { outboxFile } : {}) })
  outlets.push(outlet)
  return { events, outlet, sent, config }
}
const tick = (ms = 20): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (check: () => boolean, ms = 3000): Promise<void> => { const end = Date.now() + ms; while (!check() && Date.now() < end) await tick(10) }
const takeover = (id: string) => ({ takeoverId: id, phase: 'failed', accountId: 'acct_fixture' })
const denial = (id: string) => ({ accountId: 'acct_fixture', precheckId: id, ruleHits: [{ ruleId: 'size', actual: '12.50', limit: '10.00' }] })
const tmpFile = (): string => { const d = mkdtempSync(join(tmpdir(), 'gt-r6f-outbox-')); dirs.push(d); return join(d, 'notify-outbox.jsonl') }
/** 回放落盘日志（一行一条 add / del），得到现在还没确认送达的记录。 */
function onDisk(file: string): { channelId: string; notice: { key: string; topic: string; level: string } }[] {
  const live = new Map<string, { channelId: string; notice: { key: string; topic: string; level: string } }>()
  for (const line of existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []) {
    if (!line) continue
    const op = JSON.parse(line) as { op: string; id?: string; entry?: { id: string; channelId: string; notice: { key: string; topic: string; level: string } } }
    if (op.op === 'add') live.set(op.entry!.id, op.entry!)
    else live.delete(op.id!)
  }
  return [...live.values()]
}

describe('R2-REL-03 通道独立队列', () => {
  it('[R6F-NQ1] per-channel queues: a hung channel does not delay delivery on another channel', async () => {
    const { events, outlet, sent } = world({ pA: 'hang' })
    events.publish('takeover.alert', takeover('t1'))
    events.publish('takeover.alert', takeover('t2'))
    await until(() => sent.filter(s => s.plugin === 'pB').length === 2)
    expect(sent.filter(s => s.plugin === 'pB').map(s => s.topic)).toEqual(['takeover.alert', 'takeover.alert'])
    // A 挂在第一条上，第二条在 A 自己的队列里排着，没有别的通道的份
    expect(sent.filter(s => s.plugin === 'pA')).toHaveLength(1)
    // 人工测试通知发给 B 也不受 A 挂死影响
    const started = Date.now()
    const result = await outlet.test('B')
    expect(result.results[0]).toMatchObject({ channelId: 'B', ok: true })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('[R6F-NQ2] critical notice is sent before queued info/warn notices of the same channel', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { events, sent } = world({ pB: { gate } })
    // 第一条（warn）已经在发（卡在 gate 里）；之后排队 2 条 warn，再来 1 条 critical
    events.publish('risk.denials', denial('first'))
    await until(() => sent.some(s => s.plugin === 'pB'))
    events.publish('risk.denials', denial('second'))
    events.publish('risk.denials', denial('third'))
    events.publish('takeover.alert', takeover('urgent'))
    release()
    await until(() => sent.filter(s => s.plugin === 'pB').length === 4)
    const order = sent.filter(s => s.plugin === 'pB').map(s => (s.topic === 'takeover.alert' ? 'CRITICAL' : s.lines.find(l => l.startsWith('precheckId'))?.replace('precheckId: ', '')))
    // 正在发的那条不打断；critical 排在还没发的 warn 前面
    expect(order).toEqual(['first', 'CRITICAL', 'second', 'third'])
  })
})

describe('R2-REL-03 落盘补发', () => {
  it('[R6F-NQ4] unacknowledged warn/critical notices survive a crash and are re-sent once after restart with the same key; acknowledged ones are not', async () => {
    const file = tmpFile()
    // 第一次运行：A 挂死（请求发出去了，没有应答），B 正常送达
    const first = world({ pA: 'hang' }, file)
    first.events.publish('takeover.alert', takeover('crash-1'))
    first.events.publish('proposal.decided', { proposalId: 'p1', status: 'approved' }) // info：不落盘
    await until(() => first.sent.some(s => s.plugin === 'pA') && first.sent.some(s => s.plugin === 'pB' && s.topic === 'takeover.alert'))
    await tick(50)
    const pending = onDisk(file)
    expect(pending.map(e => e.channelId)).toEqual(['A']) // B 已送达，不在盘上
    expect(pending[0]!.notice.topic).toBe('takeover.alert')
    const originalKey = pending[0]!.notice.key
    expect(originalKey).toBe(first.sent.find(s => s.plugin === 'pA' && s.topic === 'takeover.alert')!.key)
    first.outlet.stop() // 模拟内核没了（挂着的 A 没有应答；停机不会清盘上的记录）

    // 重启：A 恢复正常 → 对没送达的 A 补发一次，键不变；已送达的 B 不再收到
    const second = world({}, file)
    await until(() => second.sent.length > 0)
    await tick(200)
    expect(second.sent.map(s => [s.plugin, s.key])).toEqual([['pA', originalKey]])
    // 补发成功以后记录清掉，再重启不会第三次补发
    await until(() => onDisk(file).length === 0)
    second.outlet.stop()
    const third = world({}, file)
    await tick(300)
    expect(third.sent).toEqual([])
  })

  it('过期（超过 10 分钟）的记录不补发；通道已被删掉的记录直接丢弃；info 与诊断通知不落盘', async () => {
    const file = tmpFile()
    const now = Date.now()
    const notice = { key: 'old-key', level: 'critical', title: 'x', lines: ['a'], ts: now, topic: 'takeover.alert' }
    writeFileSync(file, [
      { op: 'add', entry: { id: 'old', channelId: 'A', notice, queuedAt: now - 11 * 60_000 } },
      { op: 'add', entry: { id: 'gone', channelId: 'Z', notice: { ...notice, key: 'gone-key' }, queuedAt: now - 1000 } },
    ].map(op => `${JSON.stringify(op)}\n`).join('') + '{"op":"add","entry":{"id":"torn')
    const w = world({}, file)
    await tick(300)
    expect(w.sent).toEqual([])
    expect(onDisk(file)).toEqual([])
    // info 级和人工测试通知不落盘
    const hang = world({ pA: 'hang' }, file)
    hang.events.publish('proposal.decided', { proposalId: 'p2', status: 'approved' })
    void hang.outlet.test('A')
    await until(() => hang.sent.filter(s => s.plugin === 'pA').length >= 1)
    await tick(50)
    expect(onDisk(file)).toEqual([])
  })
})
