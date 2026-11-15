// SPDX-License-Identifier: Apache-2.0
// 修复轮 4 · C9：接管 / 平仓 / 全撤 / 恢复交易这类串行多步的长命令用 60 s 超时，其余仍 15 s。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODE_TIMEOUT, KernelClient, isLongCommand } from '../src'
import { startFakeKernel, type FakeKernel } from '../src/testing/fake-kernel'

let k: FakeKernel
let c: KernelClient | null = null
beforeEach(async () => { k = await startFakeKernel() })
afterEach(async () => { c?.close(); c = null; await k.close() })

describe('长命令超时', () => {
  it('isLongCommand 只认接管 / 平仓 / 全撤 / 恢复交易', () => {
    for (const a of ['takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all', 'position.close', 'order.cancel_all', 'trading_state.resume']) expect(isLongCommand(a), a).toBe(true)
    for (const a of ['order.place', 'order.cancel', 'proposal.approve', 'risk.tighten', 'position.closeX']) expect(isLongCommand(a), a).toBe(false)
  })

  it('长命令按 longRequestTimeoutMs、普通命令按 requestTimeoutMs；超时抛 CODE_TIMEOUT', async () => {
    const r = await fetch(`${k.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: k.bootstrapToken }) })
    const tok = ((await r.json()) as { sessionToken: string }).sessionToken
    c = new KernelClient({ url: k.wsUrl, getToken: () => tok, requestTimeoutMs: 80, longRequestTimeoutMs: 600 })
    await c.connect()
    const slow = (ms: number) => () => new Promise((res) => setTimeout(() => res({ ok: true }), ms))
    k.onCommand('takeover.flatten_all', slow(250))
    k.onCommand('order.place', slow(250))
    await expect(c.command('takeover.flatten_all', {})).resolves.toEqual({ ok: true })
    await expect(c.command('order.place', {})).rejects.toMatchObject({ code: CODE_TIMEOUT })
  })
})
