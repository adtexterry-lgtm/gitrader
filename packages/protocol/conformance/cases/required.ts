// SPDX-License-Identifier: Apache-2.0
// 必测（所有引擎）：契约 §2.11 T01–T27。
import { expect } from 'vitest'
import {
  ENGINE_METHOD_NAMES, GEP_METHODS, GEP_STREAMS, GEP_SUPPORTED_VERSIONS, isDecimal, isKnownCapability, majorMinor, validateBySchemaId, validateProblem,
  validateRiskPolicy, type GepEvent, gepId,
} from '../../src'
import { PAPER_ACCOUNT } from '../host-sim'
import { sleep } from '../session'
import {
  allEventsJson, binding, boot, connect, describe, feed, halt, intentOf, placeCalls, provokesOrders, riskPolicy, type Case,
} from './common'

const ERR_UNSUPPORTED = [5002, -32601]

/** 引擎→宿主的每个事件都要过 schema；返回问题列表。 */
function eventProblems(events: readonly GepEvent[]): string[] {
  const out: string[] = []
  for (const e of events.slice(0, 20_000)) {
    const r = validateBySchemaId(gepId('GepEvent'), e)
    if (!r.ok) { out.push(`event ${e.eventId}: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`); if (out.length > 5) break }
  }
  return out
}

const DECIMAL_KEYS = new Set(['size', 'price', 'notional', 'triggerPrice', 'fee', 'amount', 'total', 'available', 'hold', 'equity', 'realizedPnl', 'unrealizedPnl', 'filledSize', 'avgFillPrice'])
const MS_KEYS = new Set(['ts', 'createdAt', 'updatedAt', 'expiresAt', 'submittedAt', 'closedAt', 'startedAt', 'appliedAt'])

function walkFields(v: unknown, visit: (key: string, value: unknown, path: string) => void, path = '$'): void {
  if (Array.isArray(v)) v.forEach((x, i) => walkFields(x, visit, `${path}[${i}]`))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { visit(k, x, `${path}.${k}`); walkFields(x, visit, `${path}.${k}`) }
}

export const REQUIRED_CASES: Case[] = [
  {
    id: 'T01', title: '帧格式：100 个混合请求 + 一批 JSON 数组，响应 id 一一对应，UTF-8 无 BOM',
    async run(t) {
      const s = await connect(t)
      const methods = ['engine.health', 'engine.describe', 'no.such.method']
      const outs = await Promise.all(Array.from({ length: 100 }, (_, i) => s.request(methods[i % 3]!, i % 3 === 2 ? {} : undefined)))
      outs.forEach((o, i) => {
        if (i % 3 === 2) { expect(o.ok).toBe(false); if (!o.ok) expect(o.error.code).toBe(-32601) } else expect(o.ok, `request ${i}`).toBe(true)
      })
      const batch = await s.requestBatch([{ method: 'engine.health' }, { method: 'engine.describe' }, { method: 'engine.health' }])
      expect(batch.every((o) => o.ok)).toBe(true)
      for (const raw of s.raw) {
        expect(raw.charCodeAt(0), 'no BOM').not.toBe(0xfeff)
        expect(() => JSON.parse(raw), 'every frame is valid JSON').not.toThrow()
        expect(raw.includes('\n') && t.kind === 'stdio', 'stdio: one JSON value per line').toBe(false)
      }
      s.close()
    },
  },
  {
    id: 'T02', title: '版本协商：["0.1"] 选中 0.1；["9.9"] 返回 5001',
    async run(t) {
      const bad = await t.open()
      const o = await bad.hello({ token: t.token, versions: ['9.9'] })
      expect(o.ok).toBe(false)
      if (!o.ok) expect(o.error.code).toBe(5001)
      bad.close()
      const good = await t.open()
      const g = await good.hello({ token: t.token, versions: ['0.1'] })
      expect(g.ok).toBe(true)
      if (g.ok) { expect(g.result.version).toBe('0.1'); expect(validateBySchemaId(gepId('GepHelloResult'), g.result).ok).toBe(true) }
      good.close()
      const mixed = await t.open()
      const m = await mixed.hello({ token: t.token, versions: ['9.9', '0.1'] })
      expect(m.ok && m.result.version).toBe('0.1')
      mixed.close()
    },
  },
  {
    id: 'T03', title: '鉴权：错误令牌返回 5003 且 1 s 内断开',
    async run(t) {
      const s = await t.open()
      const t0 = Date.now()
      const o = await s.hello({ token: `${t.token}-wrong` })
      expect(o.ok).toBe(false)
      if (!o.ok) expect(o.error.code).toBe(5003)
      const closed = await s.waitClosed(1500)
      expect(closed, 'connection must be closed after a failed hello').toBe(true)
      expect(s.closedAt - t0, 'closed within about 1 s').toBeLessThanOrEqual(1250)
      // 没有 hello 就调用其它方法也要被拒
      const s2 = await t.open()
      const e = await s2.request('engine.describe', {})
      expect(e.ok).toBe(false)
      s2.close()
    },
  },
  {
    id: 'T04', title: 'engine.describe 通过 schema；能力位均为已知名或 x- 前缀',
    async run(t) {
      const s = await connect(t)
      const d = await describe(s)
      for (const k of Object.keys(d.capabilities)) expect(isKnownCapability(k), `capability ${k}`).toBe(true)
      expect(majorMinor(d.protocol.version)).toBe(GEP_SUPPORTED_VERSIONS[0])
      expect(d.capabilities['halt.levels'] ?? ['halt_new']).toContain('halt_new')
      expect(d.capabilities['market.useHost'] === true || d.capabilities['market.own'] === true).toBe(true)
      if (d.capabilities['execution.modeA'] !== true && d.capabilities['execution.modeB'] !== true) throw new Error('engine declares neither execution.modeA nor execution.modeB')
      s.close()
    },
  },
  {
    id: 'T05', title: '能力位诚实：未声明的可选组调用全部返回 5002 或 -32601',
    async run(t) {
      const s = await connect(t)
      const d = await describe(s)
      for (const m of ENGINE_METHOD_NAMES) {
        const meta = GEP_METHODS[m]
        if (meta.requirement === 'always' || !meta.capability) continue
        if (d.capabilities[meta.capability as keyof typeof d.capabilities] === true) continue
        const o = await s.request(m, {})
        expect(o.ok, `${m} must not succeed without ${meta.capability}`).toBe(false)
        if (!o.ok) expect(ERR_UNSUPPORTED, `${m} -> ${o.error.code}`).toContain(o.error.code)
      }
      const x = await s.request('x-conformance.nothing', {})
      expect(x.ok).toBe(false)
      s.close()
    },
  },
  {
    id: 'T06', title: 'engine.bind：回显生效配置；绑定未知账户返回 1005；模式 B 签名者重复被拒',
    async run(t, skip) {
      const s = await connect(t)
      const d = await describe(s)
      if (d.capabilities['execution.modeA'] !== true) skip('engine does not declare execution.modeA; mode B binding needs a fake venue (see OPEN-QUESTIONS)')
      const b = binding()
      const o = await s.call<{ bindingId: string; effective: typeof b; warnings: string[] }>('engine.bind', b)
      expect(o.bindingId).toBe(b.bindingId)
      expect(o.effective.accounts.map((a) => `${a.accountId}:${a.mode}`)).toEqual(b.accounts.map((a) => `${a.accountId}:${a.mode}`))
      expect(Array.isArray(o.warnings)).toBe(true)
      const unknown = await s.expectError('engine.bind', binding('acct_01JABUNKNOWN00000000000001'))
      expect(unknown.code).toBe(1005)
      if (d.capabilities['execution.modeB'] === true) {
        const dup = binding()
        dup.accounts = [{ accountId: PAPER_ACCOUNT, mode: 'B' as never, mandateId: dup.accounts[0]!.mandateId, signer: { address: '0xabc' } } as never, { accountId: 'acct_01JAB0QZ8W3K5M7N9P1R3T5V7X', mode: 'B' as never, mandateId: dup.accounts[0]!.mandateId, signer: { address: '0xabc' } } as never]
        const r = await s.request('engine.bind', dup)
        expect(r.ok, 'duplicate mode B signers must be refused').toBe(false)
      }
      s.close()
    },
  },
  {
    id: 'T07', title: '心跳与失联：停发心跳后，引擎不再发出任何开仓类请求',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed, so there is nothing to withhold')
      s.stopHeartbeats()
      await sleep(t.timing.heartbeatLossWaitMs)
      t.host.calls.length = 0
      await feed(t, s, 40, { seed: 2 })
      expect(placeCalls(t).length, 'no opening requests after heartbeat loss').toBe(0)
      s.close()
    },
  },
  {
    id: 'T08', title: '事件信封与顺序：引擎发出的事件全部通过 schema，seq 严格递增无重复',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      await feed(t, s, t.timing.eventVolume, { batch: 500, settle: false })
      await s.waitFor(() => s.events.length > 0, 3000)
      await sleep(t.timing.settleMs * 3)
      expect(s.events.length, 'engine emitted at least one event').toBeGreaterThan(0)
      expect(eventProblems(s.events)).toEqual([])
      let last = 0
      const ids = new Set<string>()
      for (const e of s.events) {
        expect(e.seq, `seq ${e.seq} after ${last}`).toBeGreaterThan(last)
        last = e.seq
        expect(ids.has(e.eventId), `duplicate eventId ${e.eventId}`).toBe(false)
        ids.add(e.eventId)
        expect(GEP_STREAMS.some((x) => x.stream === e.stream && x.direction !== 'host_to_engine'), `stream ${e.stream} must be engine-to-host`).toBe(true)
        expect(e.type.split('.')[0]).toBe(e.stream)
      }
      s.close()
    },
  },
  {
    id: 'T09', title: '去重：重放同一批宿主事件（同 eventId）不引起重复下单',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      const first = await feed(t, s, 40, { seed: 3 })
      if (t.host.orders.size === 0) skip('engine placed no order on the synthetic feed')
      const before = t.host.orders.size
      const callsBefore = placeCalls(t).length
      await feed(t, s, 40, { seed: 3, eventIds: first.eventIds })
      expect(t.host.orders.size, 'replayed events must not create new orders').toBe(before)
      expect(placeCalls(t).length, 'replayed events must not even trigger new order requests').toBe(callsBefore)
      s.close()
    },
  },
  {
    id: 'T10', title: '断线续传：在 seq=N 断线后重连，补发 N+1…M 无缺口',
    requires: ['events.resume'],
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      await feed(t, s, 60, { seed: 4 })
      await s.waitFor(() => s.events.length > 0, 2000)
      const lastSeq = Math.max(...s.events.map((e) => e.seq))
      const sessionId = s.sessionId
      s.close()
      await sleep(t.timing.reconnectAfterMs)
      const s2 = await t.reopen(s)
      if (!s2) return skip('this transport cannot resume (the engine process ends with the connection)')
      const o = await s2.hello({ token: t.token, resume: { sessionId, lastSeq } })
      expect(o.ok, o.ok ? '' : `resume failed: ${JSON.stringify(o.error)}`).toBe(true)
      if (o.ok) {
        expect(o.result.resumed).toBe(true)
        if (o.result.fromSeq !== undefined) expect(o.result.fromSeq).toBe(lastSeq + 1)
      }
      s2.startHeartbeats(1000)
      await sleep(t.timing.settleMs * 2)
      const seqs = s2.events.map((e) => e.seq)
      if (seqs.length > 0) {
        expect(seqs[0], 'resume starts right after the last acknowledged seq').toBe(lastSeq + 1)
        for (let i = 1; i < seqs.length; i++) expect(seqs[i], 'no gap after resume').toBe(seqs[i - 1]! + 1)
      }
      s2.close()
    },
  },
  {
    id: 'T11', title: '缺口处理：补不齐回 5004，engine.snapshot 后状态对齐',
    requires: ['events.resume'],
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      await feed(t, s, 200, { seed: 5, batch: 100 })
      await s.waitFor(() => s.events.length > 0, 2000)
      const lastSeq = Math.max(...s.events.map((e) => e.seq))
      const sessionId = s.sessionId
      s.close()
      const s2 = await t.reopen(s)
      if (!s2) return skip('this transport cannot resume')
      const o = await s2.hello({ token: t.token, resume: { sessionId, lastSeq: 0 } })
      if (o.ok) {
        // 引擎保留了全部事件（保留窗内），补得齐，合法
        expect(o.result.resumed).toBe(true)
      } else {
        expect(o.error.code, 'a resume that cannot be completed must fail with 5004').toBe(5004)
        const snap = await s2.request('engine.snapshot', {})
        expect(snap.ok, 'engine.snapshot must work to realign after 5004').toBe(true)
        if (snap.ok) expect(snap.result.seq).toBeGreaterThanOrEqual(lastSeq)
      }
      s2.close()
    },
  },
  {
    id: 'T12', title: '背压：停发 ack 期间无损流不丢，可合并流只带 conflated 计数',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      s.autoAck = false
      await feed(t, s, 6500, { batch: 500, settle: false, seed: 6 })
      await sleep(t.timing.backpressureWaitMs)
      const lossless = new Set<string>(GEP_STREAMS.filter((x) => x.loss === 'lossless').map((x) => x.stream))
      const conflatable = new Set<string>(GEP_STREAMS.filter((x) => x.loss === 'conflatable').map((x) => x.stream))
      const seqs = s.events.map((e) => e.seq)
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!, 'seq stays increasing under backpressure').toBeGreaterThan(seqs[i - 1]!)
      const missing = seqs.length > 0 ? seqs[seqs.length - 1]! - seqs[0]! + 1 - seqs.length : 0
      const overflow = s.notificationsOf('gep.overflow').length
      if (missing > 0) expect(s.events.some((e) => (e.conflated ?? 0) > 0) || overflow > 0, 'missing seq must be explained by conflation or gep.overflow').toBe(true)
      for (const e of s.events) if ((e.conflated ?? 0) > 0) expect(conflatable.has(e.stream) && !lossless.has(e.stream), `conflated on ${e.stream}`).toBe(true)
      if (seqs.length > 0) s.notify('host.events.ack', { upToSeq: seqs[seqs.length - 1] })
      const h = await s.request('engine.health', {})
      expect(h.ok, 'engine still healthy after backpressure').toBe(true)
      s.close()
    },
  },
  {
    id: 'T13', title: '错误模型：参数、能力、未知方法的 error.data 是合法 Problem 且类别正确',
    async run(t) {
      const s = await connect(t)
      const checks: [string, unknown, number[]][] = [
        ['engine.bind', {}, [-32602]],
        ['no.such.method', {}, [-32601]],
      ]
      for (const [m, p, codes] of checks) {
        const e = await s.expectError(m, p)
        expect(codes, `${m}`).toContain(e.code)
        expect(e.data, `${m}: error.data`).toBeTruthy()
        expect(validateProblem(e.data).ok, `${m}: error.data is a valid Problem`).toBe(true)
        expect(e.data!.code).toBe(e.code)
        expect(e.data!.category).toBe('PROTOCOL')
      }
      const d = await describe(s)
      const undeclared = ENGINE_METHOD_NAMES.find((m) => GEP_METHODS[m].capability && GEP_METHODS[m].requirement !== 'always' && d.capabilities[GEP_METHODS[m].capability as keyof typeof d.capabilities] !== true)
      if (undeclared) {
        const e = await s.expectError(undeclared, {})
        expect(validateProblem(e.data).ok).toBe(true)
        expect(e.data!.category).toBe('PROTOCOL')
      }
      s.close()
    },
  },
  {
    id: 'T14', title: '拒收秘密字段：返回 5006，值不被回显',
    async run(t) {
      const canary = `CANARY-${Math.random().toString(36).slice(2)}-${Date.now()}`
      const s = await connect(t)
      const b = { ...binding(), privateKey: canary }
      const e1 = await s.expectError('engine.bind', b)
      expect(e1.code).toBe(5006)
      const e2 = await s.expectError('strategy.list', { nested: { deep: { apiSecret: canary } } })
      expect(e2.code).toBe(5006)
      const e3 = await s.expectError('risk.policy.push', { policies: [], effectiveAt: 1, mnemonic: canary })
      expect(e3.code).toBe(5006)
      await sleep(t.timing.settleMs)
      expect(s.raw.join('\n').includes(canary), 'the secret value must never be echoed').toBe(false)
      expect((await s.request('engine.health', {})).ok, 'engine keeps working').toBe(true)
      s.close()
    },
  },
  {
    id: 'T15', title: '日志脱敏：令牌与金丝雀串在全部日志事件里 0 命中',
    async run(t) {
      const canary = `CANARY-${Math.random().toString(36).slice(2)}`
      const { s, instanceId } = await boot(t)
      await s.request('strategy.list', { privateKey: canary })
      await s.request('engine.bind', { ...binding(), seed: canary })
      if (instanceId) await feed(t, s, 80, { seed: 7 })
      await sleep(t.timing.settleMs)
      const everything = `${allEventsJson(s)}\n${s.raw.join('\n')}`
      expect(everything.includes(canary), 'canary must not appear in anything the engine sent').toBe(false)
      const logs = s.events.filter((e) => e.stream === 'log')
      expect(JSON.stringify(logs).includes(t.token), 'the auth token must not appear in log events').toBe(false)
      expect(allEventsJson(s).includes(t.token), 'the auth token must not appear in any event').toBe(false)
      s.close()
    },
  },
  {
    id: 'T16', title: 'halt_new：200 ms 内 ack，之后 0 个开仓类请求',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      const t0 = Date.now()
      const ack = await s.call<{ ack: boolean }>('engine.halt', halt('halt_new'))
      const rtt = Date.now() - t0
      expect(ack.ack).toBe(true)
      expect(rtt, 'engine.halt acknowledged within about 200 ms').toBeLessThanOrEqual(200 + 100)
      t.host.calls.length = 0
      await feed(t, s, 40, { seed: 8 })
      expect(placeCalls(t).length, 'no opening requests after halt_new').toBe(0)
      s.close()
    },
  },
  {
    id: 'T17', title: 'cancel_all（模式 A）：引擎不再挂新单',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      await s.call('engine.halt', halt('cancel_all'))
      t.host.calls.length = 0
      await feed(t, s, 40, { seed: 9 })
      expect(placeCalls(t).filter((c) => intentOf(c).reduceOnly !== true).length, 'no new resting orders after cancel_all').toBe(0)
      s.close()
    },
  },
  {
    id: 'T18', title: 'flatten_all（模式 A）：引擎不发任何反向开仓',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      await s.call('engine.halt', halt('flatten_all'))
      t.host.calls.length = 0
      await feed(t, s, 40, { seed: 10 })
      expect(placeCalls(t).filter((c) => intentOf(c).reduceOnly !== true).length, 'no opening orders after flatten_all').toBe(0)
      s.close()
    },
  },
  {
    id: 'T19', title: '恢复只由宿主发起：未收到 engine.resume 前保持受限',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      await s.call('engine.halt', halt('halt_new', 'tko_01JABCCONF19'))
      await sleep(2000)
      t.host.calls.length = 0
      await feed(t, s, 40, { seed: 11 })
      expect(placeCalls(t).length, 'engine must stay restricted without engine.resume').toBe(0)
      const wrong = await s.request('engine.resume', { takeoverId: 'tko_01JABWRONG', scope: { accountIds: [PAPER_ACCOUNT] }, approvedBy: 'user:usr_local' })
      expect(wrong.ok, 'a resume for an unknown takeover must not lift the restriction').toBe(false)
      const ok = await s.call<{ resumedAt: number }>('engine.resume', { takeoverId: 'tko_01JABCCONF19', scope: { accountIds: [PAPER_ACCOUNT] }, approvedBy: 'user:usr_local' })
      expect(typeof ok.resumedAt).toBe('number')
      await feed(t, s, 60, { seed: 12 })
      expect(placeCalls(t).length, 'after engine.resume the engine may trade again').toBeGreaterThan(0)
      s.close()
    },
  },
  {
    id: 'T20', title: '风控推送：ack 版本号；此后引擎发出的订单 0 条违反推送限额',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      const p = riskPolicy(7, '1')
      expect(validateRiskPolicy(p).ok).toBe(true)
      const r = await s.call<{ acceptedVersions: number[] }>('risk.policy.push', { policies: [p], effectiveAt: Date.now() })
      expect(r.acceptedVersions).toContain(7)
      t.host.calls.length = 0
      const { candles } = await feed(t, s, 60, { seed: 13 })
      const maxPrice = Math.max(...candles.map((c) => c.c))
      for (const c of placeCalls(t)) {
        const i = intentOf(c)
        const notional = i.size !== undefined ? Number(i.size) * maxPrice : 0
        expect(notional, `order notional ${notional} must not exceed the pushed limit 1`).toBeLessThanOrEqual(1)
      }
      s.close()
    },
  },
  {
    id: 'T21', title: '数值格式：对账级字段是规范十进制字符串，时间是整数毫秒',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      await feed(t, s, 200, { seed: 14 })
      let checked = 0
      const bad: string[] = []
      const visit = (key: string, value: unknown, path: string): void => {
        if (DECIMAL_KEYS.has(key)) { checked += 1; if (!isDecimal(value)) bad.push(`${path} = ${JSON.stringify(value)}`) }
        if (MS_KEYS.has(key) && typeof value !== 'object') { checked += 1; if (!Number.isInteger(value)) bad.push(`${path} = ${JSON.stringify(value)} (not an integer ms)`) }
      }
      for (const c of placeCalls(t)) walkFields(c.params, visit)
      for (const e of s.events) walkFields({ ts: e.ts, ...e.data }, visit, `event ${e.eventId}`)
      expect(bad.slice(0, 5)).toEqual([])
      expect(checked, 'at least one reconciliation-grade field was sampled').toBeGreaterThan(0)
      s.close()
    },
  },
  {
    id: 'T22', title: '精度：收到 1002 后不原样重发',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      t.host.calls.length = 0
      t.host.orders.clear()
      t.host.queueFault('precision')
      await feed(t, s, 6, { seed: 15, settle: false })
      await s.waitFor(() => t.host.placed.some((p) => p.result.problem?.code === 1002), 2000)
      await sleep(t.timing.settleMs * 2)
      const denied = t.host.placed.find((p) => p.result.problem?.code === 1002)
      if (!denied) return skip('the injected precision fault was never exercised')
      const resent = placeCalls(t).filter((c) => c.params.clientOrderId === denied.params.clientOrderId)
      expect(resent.length, 'the rejected order must not be re-sent unchanged').toBe(1)
      s.close()
    },
  },
  {
    id: 'T23', title: '幂等：同一 clientOrderId 的重复提交携带相同意图，只产生 1 个订单',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      // 同一根 K 线（同 t）用不同 eventId 再喂一次
      const { candles } = await feed(t, s, 30, { seed: 16 })
      const again = await feed(t, s, 30, { seed: 16 })
      expect(again.candles).toEqual(candles)
      await sleep(t.timing.settleMs)
      const byCid = new Map<string, string[]>()
      for (const c of placeCalls(t)) {
        expect(c.params.clientOrderId, 'clientOrderId is 32 hex chars').toMatch(/^[0-9a-f]{32}$/)
        byCid.set(c.params.clientOrderId, [...(byCid.get(c.params.clientOrderId) ?? []), JSON.stringify(c.params.intent)])
      }
      for (const [cid, intents] of byCid) expect(new Set(intents).size, `${cid}: repeated submissions carry the same intent`).toBe(1)
      expect(t.host.orders.size).toBe(byCid.size)
      s.close()
    },
  },
  {
    id: 'T24', title: '结果未知：收到 3006 后先 host.order.status 查询，不盲目重发',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      t.host.calls.length = 0
      t.host.orders.clear()
      t.host.queueFault('timeout-3006')
      await feed(t, s, 8, { seed: 17, settle: false })
      await s.waitFor(() => t.host.placed.some((p) => p.result.problem?.code === 3006), 2000)
      await sleep(t.timing.settleMs * 2)
      const unknown = t.host.placed.find((p) => p.result.problem?.code === 3006)
      if (!unknown) return skip('the injected 3006 fault was never exercised')
      const cid = unknown.params.clientOrderId as string
      const calls = t.host.calls
      const firstPlace = calls.findIndex((c) => c.method === 'host.order.place' && c.params.clientOrderId === cid)
      const statusIdx = calls.findIndex((c) => c.method === 'host.order.status' && c.params?.clientOrderId === cid)
      expect(statusIdx, 'engine must query the order by clientOrderId after 3006').toBeGreaterThan(firstPlace)
      const resendIdx = calls.findIndex((c, i) => i > firstPlace && c.method === 'host.order.place' && JSON.stringify(c.params.intent) === JSON.stringify(unknown.params.intent) && c.params.clientOrderId !== cid)
      if (resendIdx >= 0) expect(resendIdx, 'any re-send must come after the status query').toBeGreaterThan(statusIdx)
      s.close()
    },
  },
  {
    id: 'T25', title: '退出：engine.shutdown 后 5 s 内退出（stdio：退出码 0）',
    async run(t) {
      const s = await connect(t)
      const o = await s.call<{ ok: boolean }>('engine.shutdown', { graceMs: 500 })
      expect(o.ok).toBe(true)
      const closed = await s.waitClosed(5000)
      expect(closed, 'connection closed within 5 s of shutdown').toBe(true)
      if (t.kind === 'stdio') {
        await s.waitFor(() => s.transport.exitCode?.() !== undefined, 2000)
        expect(s.transport.exitCode?.(), 'exit code 0').toBe(0)
      }
    },
  },
  {
    id: 'T26', title: '来源归因：引擎发出的订单 100% 带 strategyId 与 instanceId',
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      for (const c of placeCalls(t)) {
        expect(c.params.strategyId, 'strategyId present').toBeTruthy()
        const viaOrigin = c.params.origin?.causation?.instanceId
        expect(c.params.instanceId ?? viaOrigin, 'instanceId present (instanceId param or origin.causation.instanceId)').toBe(instanceId)
        if (c.params.origin) expect(typeof c.params.origin.tool, 'origin.tool is a string when origin is sent').toBe('string')
      }
      s.close()
    },
  },
  {
    id: 'T27', title: '引擎心跳：绑定后按 heartbeatMs 主动发 gep.heartbeat，任意两条间隔 ≤ 3 个周期',
    async run(t, skip) {
      const s = await connect(t)
      const d = await describe(s)
      if (d.capabilities['execution.modeA'] !== true) skip('engine does not declare execution.modeA')
      await s.call('engine.bind', { ...binding(), heartbeatMs: 1000 })
      s.notifications.length = 0
      await sleep(3500)
      const beats = s.notificationsOf('gep.heartbeat')
      expect(beats.length, 'engine must send gep.heartbeat on its own').toBeGreaterThanOrEqual(2)
      for (let i = 1; i < beats.length; i++) expect(beats[i]!.at - beats[i - 1]!.at, 'gap between heartbeats').toBeLessThanOrEqual(3000)
      s.close()
    },
  },
]

