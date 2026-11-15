// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { D } from '../src/util/dec'
import type { AccountSnapshot as ConnectorAccountSnapshot } from '@gitrader/protocol/connector'
import type { Harness } from './helpers/harness'
import { makeHarness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const q = (accountId: string, from: number, to: number, step: '1m' | '1h' | '1d' = '1m'): Promise<unknown> => h!.k.ops.call(h!.k, 'account.equity_history', {
  principal: h!.session, params: { accountId, from, to, step }, transport: 'ws', kind: 'query',
})
const windowAt = (clockNow: number): { from: number; to: number } => {
  const from = Math.floor(clockNow / 60_000) * 60_000
  return { from, to: from + 60_000 }
}
const rows = (value: unknown): { points: { t: number; equity: string; available: string }[]; gaps: { from: number; to: number }[] } => value as { points: { t: number; equity: string; available: string }[]; gaps: { from: number; to: number }[] }

describe('B2-05 local equity history through real kernel sampling', () => {
  it('stores the first fresh observation in a minute, then records the next minute without rewriting source time', async () => {
    h = await makeHarness()
    const w = windowAt(h.clock.now())
    h.clock.set(w.from + 5_000)
    h.sim.accountSnapshotOverrides = { ts: w.from - 8 * 60_000, asOf: w.from - 8 * 60_000, confirmedAt: h.clock.now() }
    h.sim.equity = D('9400')
    await h.k.tickOnce()
    h.clock.advance(20_000)
    h.sim.equity = D('-100')
    await h.k.tickOnce()
    const firstSample = h.k.docs.get('equity-sample', JSON.stringify([h.paper.accountId, Math.floor((w.from + 5_000) / 60_000)]))
    expect(firstSample).toMatchObject({ t: w.from + 5_000, sourceTs: w.from - 8 * 60_000, asOf: w.from - 8 * 60_000, confirmedAt: w.from + 5_000, equity: '9400' })
    expect(rows(await q(h.paper.accountId, w.from, w.to)).points).toEqual([{ t: w.from + 5_000, equity: '9400', available: '9400' }])
    h.clock.set(w.to + 2_000)
    await h.k.tickOnce()
    expect(rows(await q(h.paper.accountId, w.from, w.to + 60_000)).points).toEqual([
      { t: w.from + 5_000, equity: '9400', available: '9400' },
      { t: w.to + 2_000, equity: '-100', available: '-100' },
    ])
  })

  it('rejects stale, truncated, invalid or old-confirmation snapshots but accepts old source time with fresh confirmation', async () => {
    h = await makeHarness()
    const w = windowAt(h.clock.now())
    h.clock.set(w.from + 5_000)
    const accountState = h.sim.accountState.bind(h.sim)
    const base = await accountState(h.k.bus.accountRef(h.paper))
    const samples: Partial<ConnectorAccountSnapshot>[] = [
      { ...base, stale: true },
      { ...base, truncated: true } as never,
      { ...base, confirmedAt: h.clock.now() - 60_001 },
      { ...base, confirmedAt: h.clock.now() + 1 },
      { ...base, ts: -1 },
      { ...base, ts: h.clock.now() + 1 },
      { ...base, asOf: -1 },
      { ...base, asOf: h.clock.now() + 1 },
    ]
    for (const bad of samples) {
      vi.spyOn(h.sim, 'accountState').mockResolvedValueOnce({ ...base, ...bad })
      await h.k.tickOnce()
      h.clock.advance(60_000)
    }
    const acceptedMinute = Math.floor(h.clock.now() / 60_000)
    vi.spyOn(h.sim, 'accountState').mockResolvedValueOnce({ ...base, ts: w.from - 7 * 60_000, asOf: w.from - 7 * 60_000, confirmedAt: h.clock.now(), stale: false })
    await h.k.tickOnce()
    expect(h.k.docs.get('equity-sample', JSON.stringify([h.paper.accountId, acceptedMinute]))).toMatchObject({ sourceTs: w.from - 7 * 60_000, asOf: w.from - 7 * 60_000 })
    h.clock.advance(60_000)
    const noConfirmedAtMinute = Math.floor(h.clock.now() / 60_000)
    vi.spyOn(h.sim, 'accountState').mockResolvedValueOnce({ ...base, ts: w.from - 9 * 60_000, asOf: w.from - 9 * 60_000, confirmedAt: undefined, stale: false })
    await h.k.tickOnce()
    const withoutConfirmation = h.k.docs.get('equity-sample', JSON.stringify([h.paper.accountId, noConfirmedAtMinute]))
    expect(withoutConfirmation).toMatchObject({ sourceTs: w.from - 9 * 60_000 })
    expect(withoutConfirmation).not.toHaveProperty('confirmedAt')
  })

  it('does not sample a runtime ok:false connector response before translation', async () => {
    h = await makeHarness()
    const original = h.sim.accountState.bind(h.sim)
    vi.spyOn(h.sim, 'accountState').mockImplementation(async (ref) => ({ ...await original(ref), ok: false } as never))
    await h.k.tickOnce()
    expect(h.k.docs.get('equity-sample', JSON.stringify([h.paper.accountId, Math.floor(h.clock.now() / 60_000)]))).toBeUndefined()
  })

  it('keeps ordinary account events flowing after a sample write fails and retries the same minute', async () => {
    const logs: string[] = []
    h = await makeHarness({ kernel: { log: (message) => logs.push(message) } })
    const w = windowAt(h.clock.now())
    h.clock.set(w.from + 5_000)
    const events: string[] = []
    const unsub = h.k.events.subscribe('account.*', (event) => events.push(event.topic))
    const put = h.k.docs.put.bind(h.k.docs)
    const failWrite = vi.spyOn(h.k.docs, 'put').mockImplementation(((collection: string, id: string, doc: unknown, ver?: number) => {
      if (collection === 'equity-sample') throw new Error('PRIVATE_CANARY')
      return put(collection, id, doc, ver)
    }) as typeof h.k.docs.put)
    await h.k.tickOnce()
    expect(events).toContain('account.summary')
    expect(events).toContain('account.positions')
    expect(logs).toContain('tick equity-sample failed')
    expect(logs.join('\n')).not.toContain('PRIVATE_CANARY')
    expect(failWrite).toHaveBeenCalled()
    unsub()
    failWrite.mockRestore()
    await h.k.tickOnce()
    expect(h.k.docs.get('equity-sample', JSON.stringify([h.paper.accountId, Math.floor((w.from + 5_000) / 60_000)]))).toMatchObject({ t: w.from + 5_000 })
  })

  it('preserves a committed minute across restart and keeps the first observation', async () => {
    h = await makeHarness()
    const w = windowAt(h.clock.now())
    h.clock.set(w.from + 5_000)
    h.sim.equity = D('7000')
    await h.k.tickOnce()
    const accountId = h.paper.accountId
    const sampleId = JSON.stringify([accountId, Math.floor(h.clock.now() / 60_000)])
    await h.k.stop()
    const restarted = await Kernel.create({ home: h.home, clock: h.clock, timers: false, deviceKeyProvider: fileProvider })
    try {
      restarted.registerConnector(h.sim)
      const boot = restarted.auth.mintBootToken()
      const session = restarted.auth.authenticateToken(restarted.auth.exchangeBoot(boot).sessionToken)!
      h.clock.advance(10_000)
      h.sim.equity = D('6500')
      await restarted.tickOnce()
      expect(restarted.docs.get('equity-sample', sampleId)).toMatchObject({ t: w.from + 5_000, equity: '7000' })
      const view = await restarted.ops.call(restarted, 'account.equity_history', {
        principal: session, params: { accountId, from: w.from, to: w.to, step: '1m' }, transport: 'ws', kind: 'query',
      })
      expect(rows(view).points).toEqual([{ t: w.from + 5_000, equity: '7000', available: '7000' }])
    } finally {
      await restarted.stop()
    }
  })

  it('returns minute gaps across outages and keeps internal gaps when coarse points are downsampled', async () => {
    h = await makeHarness()
    const w = windowAt(h.clock.now())
    h.clock.set(w.from + 10_000)
    await h.k.tickOnce()
    h.clock.set(w.from + 3 * 60_000 + 10_000)
    await h.k.tickOnce()
    const minute = rows(await q(h.paper.accountId, w.from, w.from + 4 * 60_000, '1m'))
    expect(minute.points.map((point) => point.t)).toEqual([w.from + 10_000, w.from + 3 * 60_000 + 10_000])
    expect(minute.gaps).toEqual([{ from: w.from + 60_000, to: w.from + 3 * 60_000 }])
    const hourly = rows(await q(h.paper.accountId, w.from, w.from + 4 * 60_000, '1h'))
    expect(hourly.points.map((point) => point.t)).toEqual([w.from + 10_000, w.from + 3 * 60_000 + 10_000])
    expect(hourly.gaps).toEqual(minute.gaps)
  })

  it('uses covering minute buckets at half-minute boundaries while filtering points by exact time', async () => {
    h = await makeHarness()
    const w = windowAt(h.clock.now())
    h.clock.set(w.from + 10_000)
    await h.k.tickOnce()
    h.clock.set(w.from + 60_000 + 10_000)
    await h.k.tickOnce()
    const view = rows(await q(h.paper.accountId, w.from + 30_000, w.from + 90_000))
    expect(view.points.map((point) => point.t)).toEqual([w.from + 60_000 + 10_000])
    expect(view.gaps).toEqual([])
    const endingAtBoundary = rows(await q(h.paper.accountId, w.from, w.from + 60_000))
    expect(endingAtBoundary.gaps).toEqual([])
  })

  it('keeps account buckets distinct, rejects invalid windows, and returns a huge empty gap in one interval', async () => {
    h = await makeHarness({ configure: (config) => {
      const first = config.accounts.find((account) => account.alias === 'paper')!
      first.accountId = 'acct_1' as typeof first.accountId
      config.accounts.push({ ...first, alias: 'paper-2', accountId: 'acct_12' as typeof first.accountId })
    } })
    const first = 'acct_1'
    const second = 'acct_12'
    const empty = rows(await q(first, 0, Number.MAX_SAFE_INTEGER, '1m'))
    expect(empty.points).toEqual([])
    expect(empty.gaps).toEqual([{ from: 0, to: Number.MAX_SAFE_INTEGER }])
    const accountState = h.sim.accountState.bind(h.sim)
    let equityByAccount = new Map([[first, '8000'], [second, '18000']])
    vi.spyOn(h.sim, 'accountState').mockImplementation(async (ref) => {
      const snapshot = await accountState(ref)
      return { ...snapshot, margin: { ...snapshot.margin, equity: equityByAccount.get(ref.accountId)! as never, available: equityByAccount.get(ref.accountId)! as never } }
    })
    h.clock.set(23 * 60_000 + 10_000)
    await h.k.tickOnce()
    equityByAccount = new Map([[first, '5000'], [second, '30000']])
    h.clock.set(3 * 60_000 + 10_000)
    await h.k.tickOnce()
    expect(h.k.docs.get('equity-sample', JSON.stringify([first, 23]))).toBeDefined()
    expect(h.k.docs.get('equity-sample', JSON.stringify([second, 3]))).toMatchObject({ equity: '30000' })
    expect(h.k.docs.get('equity-sample', JSON.stringify([first, 23]))).toMatchObject({ equity: '8000' })
    expect(rows(await q(first, 23 * 60_000, 24 * 60_000)).points.map((point) => point.equity)).toEqual(['8000'])
    expect(rows(await q(second, 23 * 60_000, 24 * 60_000)).points.map((point) => point.equity)).toEqual(['18000'])
    expect(rows(await q(first, 3 * 60_000, 4 * 60_000)).points.map((point) => point.equity)).toEqual(['5000'])
    expect(rows(await q(second, 3 * 60_000, 4 * 60_000)).points.map((point) => point.equity)).toEqual(['30000'])
    await expect(q(first, 10, 10)).rejects.toMatchObject({ problem: expect.anything() })
    await expect(q(first, -1, 10)).rejects.toMatchObject({ problem: expect.anything() })
    await expect(q(first, 0, Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ problem: expect.anything() })
    await expect(q(first, 0, 10, '2m' as never)).rejects.toMatchObject({ problem: expect.anything() })
    await expect(q('missing-account', 0, 60_000)).rejects.toMatchObject({ problem: expect.anything() })
  })
})
