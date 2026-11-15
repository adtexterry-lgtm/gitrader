// SPDX-License-Identifier: CPAL-1.0
// 模糊测试：engine-core 的 GEP 帧解析入口（批 10 · F1 欠交件补齐）。
//
// 入口（都是真实传输层必过的两处闸门，见 src/gep/server.ts 的 ws.on('message') / rl.on('line')）：
//   A. RpcPeer.receive(text)          src/gep/peer.ts   —— 单帧闸门
//   B. EngineCore 方法分发（经 A，已认证）  src/runtime/engine.ts —— 方法表 / 参数校验 / 错误映射
//   C. 批量帧成员上限                 src/gep/peer.ts（MAX_BATCH_MEMBERS）
//
// 判定（任一出现即失败）：
//   ① 异常从 receive() 逃出（未捕获异常）或出现未处理的 Promise 拒绝；
//   ② 引擎在风暴之后不再应答 engine.health（状态被打坏）；
//   ③ 响应帧不是合法 JSON、或缺 result / error 两者（静默丢帧）；
//   ④ 模糊风暴污染 Object.prototype。
//
// 记录：种子写死 42，每入口 10 000 帧，帧由 15 个变异算子从合法帧变异出来；同种子两跑帧流一致。
// 只走内存传输，离线，不碰端口、不碰磁盘。
import { expect, it } from 'vitest'
import { RpcPeer, MAX_BATCH_MEMBERS } from '../../src/gep/peer'
import { EngineCore } from '../../src/runtime/engine'

const SEED = 42
const FRAMES = 10_000
const TOKEN = 'fuzz-token-0000'
const MAX_FRAME = 4 * 1024 * 1024
const TIMEOUT_MS = 300_000

/** mulberry32：32 位状态的确定性 PRNG（自写，不碰 Math.random）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length) % xs.length] as T
}

const int = (rng: () => number, n: number): number => Math.floor(rng() * n)

const ALPHABET = '{}[]",:0123456789.eE+-\\/ \t\n\u0000\ufffd\u00ff😀'

const HELLO_PARAMS = JSON.stringify({
  protocol: 'gep', versions: ['0.1'], host: { id: 'fuzz', name: 'fuzz', version: '0.0.0' }, auth: { token: TOKEN },
})

const SEED_FRAMES: readonly string[] = [
  `{"jsonrpc":"2.0","id":1,"method":"gep.hello","params":${HELLO_PARAMS}}`,
  '{"jsonrpc":"2.0","id":2,"method":"engine.health"}',
  '{"jsonrpc":"2.0","id":3,"method":"engine.describe"}',
  '{"jsonrpc":"2.0","id":4,"method":"engine.bind","params":{"bindingId":"b1","accounts":[],"data":{"source":"host","instruments":[]},"policies":[]}}',
  '{"jsonrpc":"2.0","id":5,"method":"events.subscribe","params":{"streams":["order"],"subscriptionId":"s1"}}',
  '{"jsonrpc":"2.0","method":"gep.heartbeat","params":{"ts":1,"seq":1}}',
  '{"jsonrpc":"2.0","method":"events.push","params":{"sessionId":"x","events":[{"seq":1,"stream":"market","type":"market.candle","ts":1,"data":{}}]}}',
  '{"jsonrpc":"2.0","id":6,"method":"risk.policy.push","params":{"policies":[],"effectiveAt":1}}',
  '{"jsonrpc":"2.0","id":8,"method":"strategy.list"}',
  `[{"jsonrpc":"2.0","id":9,"method":"engine.health"},{"jsonrpc":"2.0","id":10,"method":"engine.describe"}]`,
]

const OPS = [
  'truncate', 'drop-byte', 'insert-byte', 'flip-byte', 'length-lies', 'wrong-types', 'duplicate-keys',
  'deep-nesting', 'lone-surrogate', 'oversize', 'batch-amplify', 'raw-garbage', 'frame-shape',
  'proto-pollution', 'events-malformed',
] as const

function mutate(rng: () => number, base: string, op: number): string {
  switch (op) {
    case 0: // 截断：从中间砍断
      return base.slice(0, int(rng, base.length))
    case 1: {
      const i = int(rng, base.length)
      return base.slice(0, i) + base.slice(i + 1)
    }
    case 2: {
      const i = int(rng, base.length)
      return base.slice(0, i) + pick(rng, [...ALPHABET]) + base.slice(i)
    }
    case 3: {
      const i = int(rng, base.length)
      const c = base.charCodeAt(i) ^ (1 << int(rng, 8))
      return base.slice(0, i) + String.fromCharCode(c) + base.slice(i + 1)
    }
    case 4: // 长度 / 序号字段说谎
      return base.replace(/\b(1|42|5)\b/g, pick(rng, ['-1', '0', '999999999999999999999999999999', '1e999', '0.1', '-1e999']))
    case 5: // 每个字段换成错类型
      return base.replace(
        /("(?:id|method|params|ts|seq|subscriptionId|sessionId|streams|events)":)([^,}]+)/g,
        (_m: string, k: string) => k + pick(rng, ['null', '[]', '{}', 'false', '-1', '1e308', '"\\ud800"', '[[[]]]', '{"a":{"b":[1]}}']),
      )
    case 6: // 重复键
      return base.replace('{', '{"id":1,"id":2,"method":"x","method":"engine.health",')
    case 7: { // 深嵌套
      const d = pick(rng, [2, 10, 100, 1000, 5000])
      return '{"jsonrpc":"2.0","id":1,"method":"engine.bind","params":' + '['.repeat(d) + ']'.repeat(d) + '}'
    }
    case 8: // 孤立代理对 / NUL
      return base.replace(/"(id|method)":/, '"$1":"\\ud800\\udfff\\u0000",')
    case 9: { // 超过 maxFrameBytes 的超大帧
      const pad = 'x'.repeat(200_000)
      return base.replace('}', ',"pad":"' + pad + '"}')
    }
    case 10: { // 批量放大
      const n = pick(rng, [2, 10, 50])
      return '[' + Array.from({ length: n }, () => pick(rng, SEED_FRAMES)).join(',') + ']'
    }
    case 11: // 根本不是 JSON 的垃圾
      return Array.from({ length: int(rng, 64) }, () => pick(rng, [...ALPHABET])).join('')
    case 12: // 帧形状错乱
      return JSON.stringify({
        jsonrpc: pick(rng, ['2.0', '1.0', 2, null, [], {}]),
        id: pick(rng, [null, true, [], {}, 1.5, 'x', -0]),
        method: pick(rng, ['engine.health', '', '__proto__', 'constructor', 'host.events.ack', 1, null]),
      })
    case 13: // 原型污染
      return JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'engine.health',
        params: { __proto__: { polluted: true }, constructor: { prototype: { polluted: true } }, prototype: { polluted: true } },
      })
    default: // events.push 里塞畸形事件
      return JSON.stringify({
        jsonrpc: '2.0',
        method: 'events.push',
        params: {
          sessionId: 's',
          events: Array.from({ length: pick(rng, [1, 3, 50]) }, () => ({
            seq: pick(rng, [0, -1, 1, 1e18, 'x', null]),
            stream: pick(rng, ['order', 'nope', null]),
            type: pick(rng, ['order.filled', 'x', null]),
            ts: pick(rng, [0, -1, 1e999]),
            data: pick(rng, [null, [], {}, 'x']),
          })),
        },
      })
  }
}

/** 帧流：第 i 帧用哪个算子由同一棵随机流决定（前 15 帧先把每个算子都走一遍）。 */
function frameStream(rng: () => number, count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const op = i < OPS.length ? i : int(rng, OPS.length)
    out.push(mutate(rng, pick(rng, SEED_FRAMES), op))
  }
  return out
}

/** 响应帧必须是合法 JSON-RPC：带 result 或带 error（error 里要有数字 code）。 */
function checkResponse(text: string, problems: string[]): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (problems.length < 5) problems.push(`响应不是合法 JSON：${text.slice(0, 120)}`)
    return
  }
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (item === null || typeof item !== 'object') {
      if (problems.length < 5) problems.push(`响应成员不是对象：${String(item).slice(0, 80)}`)
      continue
    }
    const msg = item as Record<string, unknown>
    const hasError = typeof msg['error'] === 'object' && msg['error'] !== null
    if (!('result' in msg) && !hasError) {
      if (problems.length < 5) problems.push(`响应既没有 result 也没有 error：${JSON.stringify(msg).slice(0, 120)}`)
      continue
    }
    if (hasError) {
      const err = msg['error'] as Record<string, unknown>
      if (typeof err['code'] !== 'number') {
        if (problems.length < 5) problems.push(`错误帧缺数字 code：${JSON.stringify(err).slice(0, 120)}`)
      }
    }
  }
}

it(`RpcPeer.receive 吃 ${FRAMES} 个变异帧：不抛异常、响应帧全部合法`, async () => {
  const rng = mulberry32(SEED)
  const sent: string[] = []
  const problems: string[] = []
  let responses = 0
  const peer = new RpcPeer({
    send: (text: string) => {
      responses += 1
      sent.push(text)
    },
    maxFrameBytes: MAX_FRAME,
    handle: () => ({ ok: true }),
    onNotify: () => undefined,
  })
  const unhandled: string[] = []
  const onRejection = (e: unknown): void => {
    if (unhandled.length < 5) unhandled.push(String((e as Error)?.message ?? e).slice(0, 160))
  }
  process.on('unhandledRejection', onRejection)
  try {
    for (const frame of frameStream(rng, FRAMES)) {
      try {
        await peer.receive(frame)
      } catch (err) {
        if (problems.length < 5) problems.push(`异常逃出 receive：${(err as Error).name}: ${(err as Error).message}｜帧=${frame.slice(0, 120)}`)
      }
      for (const text of sent.splice(0)) checkResponse(text, problems)
    }
  } finally {
    process.off('unhandledRejection', onRejection)
    peer.close()
  }
  expect(problems).toEqual([])
  expect(unhandled).toEqual([])
  expect(responses).toBeGreaterThan(0)
}, TIMEOUT_MS)

it(`EngineCore 已认证后吃 ${FRAMES} 个变异帧：不崩、风暴后仍应答、不污染原型`, async () => {
  const rng = mulberry32(SEED)
  const core = new EngineCore({ token: TOKEN, tickMs: 3_600_000 })
  await core.ready
  const outbox: string[] = []
  const problems: string[] = []
  const ENGINE_TO_HOST = /^\{"jsonrpc":"2\.0",("id":-?\d+,)?"method":"host\./

  /**
   * 引擎会回调宿主（host.describe / host.market.history …）。这里当场用**同一个 id** 回 5002：
   * 不回的话每一帧都要等 callTimeoutMs，测出来的就不是引擎而是超时。
   */
  const answerHost = (text: string): void => {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    for (const item of Array.isArray(msg) ? msg : [msg]) {
      if (item === null || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      if (typeof m['method'] !== 'string' || !m['method'].startsWith('host.') || !('id' in m)) continue
      const answer = { jsonrpc: '2.0', id: m['id'], error: { code: 5002, message: 'not implemented in the fuzz harness' } }
      queueMicrotask(() => void conn.peer.receive(JSON.stringify(answer)))
    }
  }

  const conn = core.connect({
    kind: 'memory',
    send: (text: string) => {
      if (ENGINE_TO_HOST.test(text.slice(0, 200))) {
        answerHost(text)
        return
      }
      outbox.push(text)
    },
    closeTransport: () => undefined,
    maxFrameBytes: MAX_FRAME,
  })

  await conn.peer.receive(`{"jsonrpc":"2.0","id":0,"method":"gep.hello","params":${HELLO_PARAMS}}`)
  expect(outbox.splice(0).join('')).toContain('"result"')

  const unhandled: string[] = []
  const onRejection = (e: unknown): void => {
    if (unhandled.length < 5) unhandled.push(String((e as Error)?.message ?? e).slice(0, 160))
  }
  process.on('unhandledRejection', onRejection)
  let answered = 0
  try {
    let i = 0
    for (const frame of frameStream(rng, FRAMES)) {
      i += 1
      try {
        await conn.peer.receive(frame)
      } catch (err) {
        if (problems.length < 5) problems.push(`异常逃出 receive：#${i} ${(err as Error).name}: ${(err as Error).message}｜帧=${frame.slice(0, 120)}`)
      }
      for (const text of outbox.splice(0)) {
        checkResponse(text, problems)
        answered += 1
      }
    }
  } finally {
    process.off('unhandledRejection', onRejection)
  }

  expect(problems).toEqual([])
  expect(unhandled).toEqual([])
  expect(answered).toBeGreaterThan(0)

  // 风暴之后引擎必须还能答（状态没被打坏）
  await conn.peer.receive('{"jsonrpc":"2.0","id":999999,"method":"engine.health"}')
  expect(outbox.splice(0).join('')).toContain('"result"')

  // 原型没有被污染
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  expect(Object.keys(Object.prototype)).toEqual([])

  core.disconnect(conn)
  core.close()
}, TIMEOUT_MS)

it('批量帧成员数超过 MAX_BATCH_MEMBERS 时整帧拒绝（不放大响应）', async () => {
  const core = new EngineCore({ token: TOKEN, tickMs: 3_600_000 })
  await core.ready
  const outbox: string[] = []
  const conn = core.connect({
    kind: 'memory',
    send: (text: string) => outbox.push(text),
    closeTransport: () => undefined,
    maxFrameBytes: MAX_FRAME,
  })
  await conn.peer.receive(`{"jsonrpc":"2.0","id":0,"method":"gep.hello","params":${HELLO_PARAMS}}`)
  outbox.length = 0
  const frame = '[' + Array.from({ length: MAX_BATCH_MEMBERS + 1 }, () => '{"jsonrpc":"2.0","id":1,"method":"engine.health"}').join(',') + ']'
  await conn.peer.receive(frame)
  const answer = outbox.join('')
  expect(answer).toContain('"error"')
  expect(answer.length).toBeLessThan(frame.length)
  core.disconnect(conn)
  core.close()
})

it('同种子两跑产出同一串帧（可复现）', () => {
  const a = frameStream(mulberry32(SEED), 256)
  const b = frameStream(mulberry32(SEED), 256)
  expect(b).toEqual(a)
  expect(a).toHaveLength(256)
})
