// SPDX-License-Identifier: CPAL-1.0
// GEP over stdio：NDJSON 一行一帧（与 packages/engine-core/src/gep/server.ts:49 serveStdio 一致），
// 宿主侧只实现本测试台需要的部分：握手、发请求、回 host.* 请求（本台不回行情，回 -32601 让引擎走文件数据源）。
// 手写而不 import packages/protocol：tools/ 下的脚本必须是纯 .mjs（node --test 直接跑，不经 TS 构建）。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

/** 与 packages/protocol/src/gep/version.ts:20 的 maxStdioLineBytes 对齐（1 MiB）。 */
export const MAX_STDIO_LINE_BYTES = 1024 * 1024

export const GEP_VERSION = '0.1'

/**
 * 起一个引擎子进程并完成 gep.hello。
 * @param {{command:string, args:string[], env?:Record<string,string>, cwd?:string, token:string,
 *          host?:{name:string,version:string}, timeoutMs?:number, onHostCall?:(method:string,params:unknown)=>unknown|undefined}} opts
 */
export async function openEngine(opts) {
  const token = opts.token ?? randomBytes(16).toString('hex')
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}), GITRADER_GEP_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stderr = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { if (stderr.length < 200) stderr.push(String(d)) })

  let nextId = 1
  const pending = new Map()
  const hostCalls = []
  const notifications = []
  let closed = false
  let exitCode = null
  const closeWaiters = []

  child.on('exit', (code) => {
    exitCode = code
    closed = true
    for (const [, p] of pending) p.reject(new Error(`engine exited (code ${String(code)})`))
    pending.clear()
    for (const w of closeWaiters.splice(0)) w()
  })

  const send = (msg) => {
    const line = JSON.stringify(msg)
    if (Buffer.byteLength(line, 'utf8') > MAX_STDIO_LINE_BYTES) throw new Error('GEP frame exceeds 1 MiB stdio limit')
    child.stdin.write(line + '\n')
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (line.trim() === '') return
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg && typeof msg === 'object' && msg.method && msg.id !== undefined) {
      // 引擎 → 宿主的请求（host.*）：本台没有行情，默认回 -32601（引擎有文件数据源，回测不依赖它）
      hostCalls.push({ method: msg.method, params: msg.params })
      const answer = opts.onHostCall?.(msg.method, msg.params)
      if (answer !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, result: answer })
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `parity host does not implement ${msg.method}` } })
      }
      return
    }
    if (msg && typeof msg === 'object' && msg.method && msg.id === undefined) {
      notifications.push({ method: msg.method, params: msg.params })
      return
    }
    if (msg && typeof msg === 'object' && msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'GEP error'), { gepError: msg.error }))
      else p.resolve(msg.result)
    }
  })

  const call = (method, params, timeoutMs = opts.timeoutMs ?? 60_000) => {
    if (closed) return Promise.reject(new Error('engine is closed'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)) }, timeoutMs)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  let hello
  try {
    hello = await call('gep.hello', {
      protocol: 'gep',
      versions: [GEP_VERSION],
      host: opts.host ?? { name: 'gitrader-parity', version: '1' },
      auth: { token },
    }, 20_000)
  } catch (e) {
    // 握手失败：这个子进程没有会话了，直接收掉，别留后台进程
    try { child.kill() } catch { /* ignore */ }
    try { rl.close() } catch { /* ignore */ }
    try { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() } catch { /* ignore */ }
    throw e
  }

  const release = () => {
    try { rl.close() } catch { /* ignore */ }
    try { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() } catch { /* ignore */ }
  }

  return {
    child,
    hello,
    call,
    hostCalls,
    notifications,
    stderr: () => stderr.join(''),
    get exitCode() { return exitCode },
    async close({ graceMs = 2_000 } = {}) {
      if (closed) { release(); return exitCode }
      try { await call('engine.shutdown', { graceMs }, 3_000) } catch { /* 引擎可能已自己退出 */ }
      try { child.stdin.end() } catch { /* ignore */ }
      await Promise.race([
        new Promise((r) => closeWaiters.push(r)),
        new Promise((r) => setTimeout(r, graceMs + 1_500)),
      ])
      if (exitCode === null) {
        try { child.kill() } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 200))
      }
      release()
      return exitCode
    },
  }
}
