// SPDX-License-Identifier: CPAL-1.0
// GSP（Gitrader 插件 stdio 协议）服务循环：stdin 一行一个 JSON-RPC 请求（单行或数组批量），stdout 一行一个应答。
// 行为照 packages/protocol/examples/python-plugin/plugin.py 的参考实现搬成 JS（帧 / 批量 / 令牌 / 版本协商 /
// describe / health / shutdown / Problem 对象 / 秘密字段 5006 / 单行 1 MiB 上限 / 退出码）。
// stdout 只放协议应答；日志只能写 stderr，且不打印请求参数。
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { secretEquals } from './webhook.mjs'

export const GSP_VERSION = '0.1.0'
const MAX_LINE = 1024 * 1024

const PROBLEMS = {
  PARSE_ERROR: [-32700, 'PARSE_ERROR'],
  INVALID_REQUEST: [-32600, 'INVALID_REQUEST'],
  METHOD_NOT_FOUND: [-32601, 'METHOD_NOT_FOUND'],
  INVALID_PARAMS: [-32602, 'INVALID_PARAMS'],
  INTERNAL_ERROR: [-32603, 'INTERNAL_ERROR'],
  VERSION_UNSUPPORTED: [5001, 'VERSION_UNSUPPORTED'],
  AUTH_FAILED: [5003, 'AUTH_FAILED'],
  SECRET_FIELD_REJECTED: [5006, 'SECRET_FIELD_REJECTED'],
  PAYLOAD_TOO_LARGE: [5007, 'PAYLOAD_TOO_LARGE'],
}

const SECRET_FIELD_NAMES = new Set(['privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase', 'pin', 'password'])
/** `env:NAME` 句柄不是密钥本身：但只有清单 secrets[] 里声明过的名字允许走工具参数。 */
const ENV_HANDLE_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/
const DECLARED_SECRET_HANDLES = new Set(['WEBHOOK_SECRET'])

/** 是否是清单里声明过的 `env:NAME` 句柄（未声明的名字按秘密字段拒绝）。 */
function isDeclaredEnvHandle(value) {
  return typeof value === 'string' && ENV_HANDLE_RE.test(value) && DECLARED_SECRET_HANDLES.has(value.slice('env:'.length))
}

function failure(id, name) {
  // 错误里不带请求值、不带异常文本、不带密钥。
  const [code, problemName] = PROBLEMS[name]
  const data = { code, name: problemName, category: 'PROTOCOL', message: 'request rejected', retryable: false }
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message: data.message, data } }
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** 递归找秘密字段名；已声明的 `env:` 句柄放行，未声明的句柄按秘密字段拒绝。 */
export function findSecretField(value) {
  if (Array.isArray(value)) return value.some((item) => findSecretField(item))
  const obj = asRecord(value)
  if (!obj) return false
  for (const [key, child] of Object.entries(obj)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')
    if (SECRET_FIELD_NAMES.has(normalized) && !isDeclaredEnvHandle(child)) return true
    if (findSecretField(child)) return true
  }
  return false
}

export class GspPlugin {
  #token
  #manifest
  #tools
  authed = false
  exitCode = null

  constructor({ token, manifest, tools }) {
    this.#token = token
    this.#manifest = manifest
    this.#tools = tools
  }

  async dispatch(msg) {
    const record = asRecord(msg)
    if (!record) return failure(null, 'INVALID_REQUEST')
    const id = record.id
    if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') return failure(id, 'INVALID_REQUEST')
    if (!Object.hasOwn(record, 'id')) return null
    const params = asRecord(record.params) ?? {}
    if (record.params !== undefined && !asRecord(record.params)) return failure(id, 'INVALID_PARAMS')
    const method = record.method

    if (method === 'plugin.hello') {
      if (!secretEquals(typeof params.token === 'string' ? params.token : '', this.#token)) {
        this.exitCode = 1
        return failure(id, 'AUTH_FAILED')
      }
      if (typeof params.gsp !== 'string' || !/^0\.1\.\d+$/.test(params.gsp)) return failure(id, 'VERSION_UNSUPPORTED')
      this.authed = true
      return { jsonrpc: '2.0', id, result: { gsp: GSP_VERSION } }
    }

    if (!this.authed) return failure(id, 'AUTH_FAILED')
    if (findSecretField(params)) return failure(id, 'SECRET_FIELD_REJECTED')

    if (method === 'plugin.describe') return { jsonrpc: '2.0', id, result: this.#manifest }
    if (method === 'plugin.health') return { jsonrpc: '2.0', id, result: { ok: true } }
    if (method === 'plugin.shutdown') {
      this.exitCode = 0
      return { jsonrpc: '2.0', id, result: { ok: true } }
    }
    if (method !== 'tool.call') return failure(id, 'METHOD_NOT_FOUND')

    const tool = typeof params.tool === 'string' ? params.tool : ''
    const handler = Object.hasOwn(this.#tools, tool) ? this.#tools[tool] : undefined
    if (typeof handler !== 'function') return failure(id, 'METHOD_NOT_FOUND')
    if (!asRecord(params.args)) return failure(id, 'INVALID_PARAMS')
    try {
      return { jsonrpc: '2.0', id, result: await handler(params.args) }
    } catch {
      // 处理函数自己负责把业务失败表达成 { ok:false }；走到这里就是意外，不暴露细节。
      return failure(id, 'INTERNAL_ERROR')
    }
  }

  async frame(payload) {
    if (!Array.isArray(payload)) return this.dispatch(payload)
    if (payload.length === 0) return failure(null, 'INVALID_REQUEST')
    const responses = []
    for (const item of payload) {
      const response = await this.dispatch(item)
      if (response !== null) responses.push(response)
      if (this.exitCode !== null) break
    }
    return responses.length > 0 ? responses : null
  }
}

function write(frame) {
  if (frame === null) return
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

/** 读清单：只用自己目录里的 gitrader-plugin.json（插件进程 cwd = 插件目录）。 */
export function loadManifest(url = new URL('./gitrader-plugin.json', import.meta.url)) {
  return JSON.parse(readFileSync(url, 'utf8'))
}

/**
 * 起循环。`tools` 是 `{ 工具名: async (args) => 结果 }`。
 * 退出码：0 正常 shutdown / stdin 关闭；1 令牌不对或帧过大；2 没有 GITRADER_GSP_TOKEN。
 */
export async function serve({ tools, manifest }) {
  const token = process.env.GITRADER_GSP_TOKEN ?? ''
  if (token === '') {
    process.stderr.write('GSP channel token is required\n')
    return 2
  }
  const described = manifest ?? loadManifest()
  const plugin = new GspPlugin({ token, manifest: described, tools })
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let exitCode = 0
  for await (const line of rl) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE) {
      write(failure(null, 'PAYLOAD_TOO_LARGE'))
      exitCode = 1
      break
    }
    if (line.trim() === '') continue
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      write(failure(null, 'PARSE_ERROR'))
      continue
    }
    // 工具调用并发处理（R2-REL-03）：一个通道的请求挂着（慢 / 挂死的 Webhook）不能挡住同一个插件进程里别的通道。
    // 握手、描述、健康、关机和批量帧仍按顺序处理；应答带请求 id，乱序到达没有问题。
    if (plugin.authed && asRecord(payload)?.method === 'tool.call') {
      void plugin.frame(payload).then(write, () => write(failure(null, 'INTERNAL_ERROR')))
      continue
    }
    try {
      write(await plugin.frame(payload))
    } catch {
      write(failure(null, 'INTERNAL_ERROR'))
    }
    if (plugin.exitCode !== null) {
      exitCode = plugin.exitCode
      break
    }
  }
  rl.close()
  return exitCode
}

/**
 * 内核看到的失败结果：可重试的失败都是插件在自己的预算内已经重试到头（见 webhook.mjs：最多 3 次 HTTP 尝试，退避递增）才返回的，
 * 标上 exhausted，内核就不会在外面再叠一层重试（全链路一条通知最多 3 次 HTTP 尝试）。notifySend 本身的返回值不变。
 */
export function markExhausted(result) {
  return result && result.ok === false && result.retryable === true ? { ...result, exhausted: true } : result
}

/** 入口：`node gsp.mjs`（被测试 import 时不启动循环）。 */
export async function main() {
  const { notifySend } = await import('./index.mjs')
  const send = async (args) => markExhausted(await notifySend(args))
  // 清单只能声明 `notify_send`（协议的工具名正则不允许点号）；插件只暴露这一个名字，不再注册 `notify.send` 别名（L5-10）。
  const tools = { notify_send: send }
  // 用 exitCode 而不是 process.exit()：让 stdout 的应答先刷出去（shutdown 的应答不能丢）。
  process.exitCode = await serve({ tools })
}

const entryArg = process.argv[1]
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) await main()
