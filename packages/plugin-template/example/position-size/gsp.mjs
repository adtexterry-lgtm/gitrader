// SPDX-License-Identifier: Apache-2.0
// GSP（Gitrader 插件的 stdio 协议）最小循环：stdin 一行一个 JSON-RPC 请求，stdout 一行一个应答。
// 用法：serve({ tools: { 工具名: async (args) => 结果 } })。工具里抛 Error → 应答 -32603（message 不带堆栈）。
// 日志只能写 stderr；stdout 只放协议应答。
import { createInterface } from 'node:readline'

export class InvalidParams extends Error {}

export function serve({ tools }) {
  const send = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n')
  const fail = (id, code, message) => send(id, { error: { code, message } })
  createInterface({ input: process.stdin }).on('line', async (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    const { id, method, params } = m
    if (method === 'plugin.hello' || method === 'plugin.health') return send(id, { result: { ok: true } })
    if (method === 'plugin.shutdown') { send(id, { result: { ok: true } }); return setTimeout(() => process.exit(0), 10) }
    if (method !== 'tool.call') return fail(id, -32601, `method not found: ${method}`)
    const fn = Object.hasOwn(tools, params?.tool) ? tools[params.tool] : undefined
    if (!fn) return fail(id, -32601, `tool not found: ${params?.tool}`)
    try { send(id, { result: await fn(params.args ?? {}) }) } catch (e) {
      fail(id, e instanceof InvalidParams ? -32602 : -32603, e instanceof Error ? e.message : 'tool failed')
    }
  })
}
