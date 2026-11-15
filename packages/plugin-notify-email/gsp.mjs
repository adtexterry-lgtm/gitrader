// SPDX-License-Identifier: CPAL-1.0
// GSP（插件 stdio 协议）循环，移植自 packages/protocol/examples/python-plugin/plugin.py（Apache-2.0，只读参考，未改其代码）。
// stdin 一行一个 JSON-RPC 请求（可为数组批量），stdout 一行一个应答；日志只写 stderr。
// 令牌从 GITRADER_GSP_TOKEN 读；令牌不符 → 5003 后退出码 1；plugin.shutdown → 退出码 0。
// 工具分发：清单声明的 notify_send → index.mjs 的 handleNotify（不再注册 notify.send 别名，L5-10）。
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { handleNotify } from './index.mjs'

export const GSP_VERSION = '0.1.0'
const MAX_LINE = 1024 * 1024
const PROBLEMS = {
  PARSE_ERROR: -32700, INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603, VERSION_UNSUPPORTED: 5001,
  AUTH_FAILED: 5003, SECRET_FIELD_REJECTED: 5006,
  PAYLOAD_TOO_LARGE: 5007,
}
const SECRET_FIELDS = new Set(['privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase', 'pin', 'password'])
/** 工具表：只有清单里 tools[].name 声明的那一个名字（`notify_send`）。 */
export const TOOLS = { notify_send: (args) => handleNotify(args) }
/** describe 返回的就是部署目录里的这份清单（与清单文件同源，避免两处漂移）。 */
export const MANIFEST = JSON.parse(readFileSync(new URL('./gitrader-plugin.json', import.meta.url), 'utf8'))

/** 错误应答：数值码 + Problem data；message 不含请求值与异常文本。 */
export function problem(id, name, message = 'request rejected') {
  const data = { code: PROBLEMS[name], name, category: 'PROTOCOL', message, retryable: false }
  return { jsonrpc: '2.0', id, error: { code: data.code, message: data.message, data } }
}

/** 递归找密钥样子的字段名（请求参数里出现即 5006，请求值不回显）。 */
export function hasSecretField(value) {
  if (Array.isArray(value)) return value.some((item) => hasSecretField(item))
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) =>
    SECRET_FIELDS.has(key.toLowerCase().replace(/[_-]/g, '')) || hasSecretField(child))
}

function sameToken(offered, expected) {
  if (typeof offered !== 'string') return false
  const a = Buffer.from(offered, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export class Plugin {
  constructor(token, tools = TOOLS) {
    this.token = token
    this.tools = tools
    this.authed = false
    /** null = 继续跑；数字 = 应答写完后以该退出码结束。 */
    this.exitCode = null
  }

  dispatch(msg) {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return problem(null, 'INVALID_REQUEST')
    const id = msg.id ?? null
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return problem(id, 'INVALID_REQUEST')
    if (!('id' in msg)) return null
    const params = msg.params ?? {}
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return problem(id, 'INVALID_PARAMS')
    const method = msg.method

    if (method === 'plugin.hello') {
      if (!sameToken(params.token, this.token)) {
        this.exitCode = 1
        return problem(id, 'AUTH_FAILED')
      }
      const version = params.gsp
      if (typeof version !== 'string' || !/^0\.1\.\d+$/.test(version)) return problem(id, 'VERSION_UNSUPPORTED')
      this.authed = true
      return { jsonrpc: '2.0', id, result: { gsp: GSP_VERSION } }
    }

    if (!this.authed) return problem(id, 'AUTH_FAILED')
    if (hasSecretField(params)) return problem(id, 'SECRET_FIELD_REJECTED')

    if (method === 'plugin.describe') return { jsonrpc: '2.0', id, result: MANIFEST }
    if (method === 'plugin.health') return { jsonrpc: '2.0', id, result: { ok: true } }
    if (method === 'plugin.shutdown') {
      this.exitCode = 0
      return { jsonrpc: '2.0', id, result: { ok: true } }
    }
    if (method === 'tool.call') {
      const name = params.tool
      if (typeof name !== 'string' || !Object.hasOwn(this.tools, name)) return problem(id, 'METHOD_NOT_FOUND')
      const args = params.args
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return problem(id, 'INVALID_PARAMS')
      // dispatch 对工具是异步的：返回 promise，frame 逐个 await。
      return this.tools[name](args).then(
        (result) => ({ jsonrpc: '2.0', id, result }),
        () => problem(id, 'INTERNAL_ERROR'),
      )
    }
    return problem(id, 'METHOD_NOT_FOUND')
  }

  /** 一帧（对象或数组）→ 应答（对象或数组）；通知（无 id）不回。 */
  async frame(msg) {
    if (!Array.isArray(msg)) return this.dispatch(msg)
    if (msg.length === 0) return problem(null, 'INVALID_REQUEST')
    const responses = []
    for (const item of msg) {
      const response = await this.dispatch(item)
      if (response !== null) responses.push(response)
      if (this.exitCode !== null) break
    }
    return responses.length > 0 ? responses : null
  }
}

function writeFrame(value) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve())
  })
}

function finish(code) {
  // 应答已 flush（writeFrame 的回调）后再退出，保证 G08 的退出码与 G02 的 1 s 内关闭。
  process.exit(code)
}

export function start(token) {
  const plugin = new Plugin(token)
  const rl = createInterface({ input: process.stdin })
  let chain = Promise.resolve()

  const handleLine = async (line) => {
    if (line.trim().length === 0) return
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE) {
      await writeFrame(problem(null, 'PAYLOAD_TOO_LARGE'))
      finish(1)
      return
    }
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      await writeFrame(problem(null, 'PARSE_ERROR'))
      return
    }
    const response = await plugin.frame(msg)
    if (response !== null) await writeFrame(response)
    if (plugin.exitCode !== null) finish(plugin.exitCode)
  }

  rl.on('line', (line) => {
    chain = chain.then(() => handleLine(line)).catch(() => {
      // 任何未预期异常都不崩：转 INTERNAL_ERROR，继续读下一行。
      chain = chain.then(() => writeFrame(problem(null, 'INTERNAL_ERROR')))
    })
  })
  rl.on('close', () => {
    chain = chain.then(() => {
      if (plugin.exitCode === null) plugin.exitCode = 0
      finish(plugin.exitCode)
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GITRADER_GSP_TOKEN ?? ''
  if (token.length === 0) {
    process.stderr.write('GSP channel token is required\n')
    process.exit(2)
  }
  start(token)
}
