// SPDX-License-Identifier: CPAL-1.0
// GSP（Gitrader 插件的 stdio 协议）stdio 循环，分发 notify_send 到 index.mjs。骨架照 packages/plugin-template/
// example/position-size/gsp.mjs，鉴权 / 版本协商 / 秘密字段拒绝 / 退出码照 packages/protocol/examples/python-plugin/plugin.py。
// stdin 一行一个 JSON-RPC 请求（对象或数组批次），stdout 一行一个应答；日志只能写 stderr，stdout 只放协议应答。
// 令牌比较用 node:crypto 的 timingSafeEqual（先比长度），与另两个通知插件一致。
// 本文件与 packages/plugin-notify-telegram/gsp.mjs 同构，只有分发的处理函数不同（Slack / Telegram）。
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { handleNotifySend } from './index.mjs'

const VERSION = '0.1.0'
const MAX_LINE = 1024 * 1024
const PROBLEMS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  VERSION_UNSUPPORTED: 5001,
  AUTH_FAILED: 5003,
  SECRET_FIELD_REJECTED: 5006,
  PAYLOAD_TOO_LARGE: 5007,
}
const SECRET_FIELDS = new Set(['privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase', 'pin', 'password'])

/** 工具运行期参数问题 → 应答 -32602（message 不带堆栈、不带参数值）。 */
export class InvalidParams extends Error {}

/** 清单随插件目录走：只读自己目录里的文件（内核把 cwd 设成插件目录，这里用模块路径更稳）。 */
export function loadManifest() {
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitrader-plugin.json'), 'utf8'))
}

function secretFields(value) {
  if (Array.isArray(value)) return value.some((item) => secretFields(item))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => SECRET_FIELDS.has(key.toLowerCase().replace(/[_-]/g, '')) || secretFields(child))
  }
  return false
}

function fault(id, name) {
  const code = PROBLEMS[name]
  const data = { code, name, category: 'PROTOCOL', message: 'request rejected', retryable: false }
  return { jsonrpc: '2.0', id, error: { code, message: 'request rejected', data } }
}

/** 令牌比较：常量时间（长度不同先比长度，直接返回 false）。 */
export function sameToken(offered, expected) {
  if (typeof offered !== 'string') return false
  const a = Buffer.from(offered, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

// 工具名与参数只认协议写法 {tool, args}（内核 plugins.callTool 就发这个形状）：
// 不再接受 {name, input} 旧写法，也不再注册清单没声明的 notify.send 别名（L5-10）。

/**
 * 单条请求 → 应答（或 null = 通知，不应答）。
 * 只做协议层判断；工具自己处理业务错误，返回 {ok:false,...} 而不是抛异常。
 */
export async function dispatch(msg, { token, tools, manifest, state }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fault(null, 'INVALID_REQUEST')
  const id = msg.id ?? null
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fault(id, 'INVALID_REQUEST')
  if (!Object.hasOwn(msg, 'id')) return null
  const params = msg.params === undefined || msg.params === null ? {} : msg.params
  if (typeof params !== 'object' || Array.isArray(params)) return fault(id, 'INVALID_PARAMS')
  const method = msg.method

  if (method === 'plugin.hello') {
    if (!sameToken(params.token, token)) {
      state.exitCode = 1
      return fault(id, 'AUTH_FAILED')
    }
    if (typeof params.gsp !== 'string' || !/^0\.1\.\d+$/.test(params.gsp)) return fault(id, 'VERSION_UNSUPPORTED')
    state.authed = true
    return { jsonrpc: '2.0', id, result: { gsp: VERSION } }
  }
  if (!state.authed) return fault(id, 'AUTH_FAILED')
  if (secretFields(params)) return fault(id, 'SECRET_FIELD_REJECTED')
  if (method === 'plugin.describe') return { jsonrpc: '2.0', id, result: manifest }
  if (method === 'plugin.health') return { jsonrpc: '2.0', id, result: { ok: true } }
  if (method === 'plugin.shutdown') {
    state.exitCode = 0
    return { jsonrpc: '2.0', id, result: { ok: true } }
  }
  if (method !== 'tool.call') return fault(id, 'METHOD_NOT_FOUND')
  const name = params.tool
  if (typeof name !== 'string' || !Object.hasOwn(tools, name)) return fault(id, 'METHOD_NOT_FOUND')
  const args = params.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fault(id, 'INVALID_PARAMS')
  try {
    return { jsonrpc: '2.0', id, result: await tools[name](args) }
  } catch (e) {
    return fault(id, e instanceof InvalidParams ? 'INVALID_PARAMS' : 'INTERNAL_ERROR')
  }
}

/** 一行 → 一行应答（数组批次回数组，id 一一对应）。 */
export async function handleFrame(msg, ctx) {
  if (!Array.isArray(msg)) return dispatch(msg, ctx)
  if (msg.length === 0) return fault(null, 'INVALID_REQUEST')
  const out = []
  for (const item of msg) {
    const response = await dispatch(item, ctx)
    if (response !== null) out.push(response)
    if (ctx.state.exitCode !== null) break
  }
  return out.length > 0 ? out : null
}

export function serve({ tools, manifest = loadManifest() }) {
  const token = process.env.GITRADER_GSP_TOKEN ?? ''
  if (token === '') {
    process.stderr.write('GSP channel token is required\n')
    process.exit(2)
  }
  const state = { authed: false, exitCode: null }
  const ctx = { token, tools, manifest, state }
  /** 最近一次 stdout 写入的完成 promise：stdin 关闭时要等它落地再退出，否则应答会被吞掉。 */
  let inflight = Promise.resolve()
  const send = (frame, after) => {
    inflight = new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify(frame)}\n`, () => {
        if (after) after()
        resolve()
      })
    })
  }

  const handle = async (raw) => {
    if (Buffer.byteLength(raw) > MAX_LINE) {
      send(fault(null, 'PAYLOAD_TOO_LARGE'))
      process.exit(1)
    }
    if (raw.trim() === '') return
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      send(fault(null, 'PARSE_ERROR'))
      return
    }
    let frame
    try {
      frame = await handleFrame(msg, ctx)
    } catch {
      send(fault(null, 'INTERNAL_ERROR'))
      return
    }
    if (frame === null) return
    send(frame, () => {
      if (state.exitCode !== null) process.exit(state.exitCode)
    })
  }

  let queue = Promise.resolve()
  createInterface({ input: process.stdin }).on('line', (line) => {
    queue = queue.then(() => handle(line)).catch(() => {})
  })
  // stdin 关闭：先把队列跑完，再等最后一次 stdout 写完成，最后才退出（L5-11：直接 exit 会丢未 flush 的应答）。
  process.stdin.on('end', () => {
    queue = queue.then(() => inflight).then(() => process.exit(state.exitCode ?? 0))
  })
}

/**
 * R2-REL-03：这个插件自己已经按客户端的重试与预算重试过（HTTP 尝试数有上限，内核不再叠一层），
 * 所以能重试的失败都是「插件重试到头」才返回的，标上 exhausted，内核据此不再重试（全链路一条通知在一个通道上最多 3 次 HTTP 尝试）。
 * 做法与 packages/plugin-notify-webhook/gsp.mjs 的 markExhausted 相同；handleNotifySend 本身的返回值不变。
 */
export function markExhausted(result) {
  return result && result.ok === false && result.retryable === true ? { ...result, exhausted: true } : result
}

/** 交给内核的 notify_send 工具：handleNotifySend + exhausted 标记。 */
export async function notifySendTool(args, deps) {
  return markExhausted(await handleNotifySend(args, deps))
}

// 被测试 import 时不起循环：只有作为插件进程入口（node gsp.mjs）才 serve
// 清单里声明的是协议合法名 notify_send（^[A-Za-z0-9_-]{1,64}$，不含点号）；插件只暴露这一个名字，
// B0 契约里的 notify.send 由内核侧映射（L5-10：清单与运行时能力必须一致）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const notify = (args) => notifySendTool(args)
  serve({ tools: { notify_send: notify } })
}
