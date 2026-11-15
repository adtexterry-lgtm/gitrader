// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it, vi } from 'vitest'
import { createRestartWatcher, readStartedAt } from '../src/core/kernel-restart'

describe('P2-6 kernel restart watcher', () => {
  it('fires only when startedAt changes within the session; first read and unreadable rounds do not fire', async () => {
    const reads: Array<number | null | Error> = [100, 100, null, new Error('down'), 100, 250, 250]
    const onRestart = vi.fn()
    const check = createRestartWatcher(async () => { const v = reads.shift()!; if (v instanceof Error) throw v; return v }, onRestart)
    for (let i = 0; i < 7; i += 1) await check()
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledWith(250)
  })
  it('reads startedAt from /api/health and returns null for errors or missing field', async () => {
    const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect(await readStartedAt(ok({ ok: true, startedAt: 1234 }))).toBe(1234)
    expect(await readStartedAt(ok({ ok: true }))).toBeNull()
    expect(await readStartedAt(ok({}, 503))).toBeNull()
  })
})
