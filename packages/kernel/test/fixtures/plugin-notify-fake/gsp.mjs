// SPDX-License-Identifier: CPAL-1.0
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

let helloKeys = []
const attempts = new Map()
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'plugin.hello') { helloKeys = Object.keys(m.params.config); return reply(m.id, { ok: true }) }
  if (m.method === 'plugin.health') return reply(m.id, { ok: true })
  if (m.method === 'plugin.shutdown') { reply(m.id, { ok: true }); return setTimeout(() => process.exit(0), 10) }
  if (m.method !== 'tool.call') return
  if (m.params.tool === 'environment_keys') return reply(m.id, { keys: Object.keys(process.env).sort(), helloKeys })
  if (m.params.tool !== 'notify_send') return
  const { notice, params } = m.params.args
  const count = (attempts.get(notice.key) ?? 0) + 1
  attempts.set(notice.key, count)
  if (params.output) appendFileSync(params.output, JSON.stringify({ notice, params, attempt: count }) + '\n')
  if (params.mode === 'timeout') return
  if (params.mode === 'invalid') return reply(m.id, { ok: 'yes' })
  if (params.mode === 'leak') return reply(m.id, { ok: false, reason: process.env.DELIVERY_TOKEN, retryable: false })
  if (params.mode === 'error') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: process.env.DELIVERY_TOKEN } }) + '\n')
  if (params.mode === 'fail' || (params.mode === 'recover' && count === 1)) return reply(m.id, { ok: false, reason: 'fixture_failure', retryable: params.retryable !== false })
  reply(m.id, { ok: true, ref: String(count) })
})
