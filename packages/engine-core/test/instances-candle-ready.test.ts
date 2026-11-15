// SPDX-License-Identifier: CPAL-1.0
// K 线就绪门与缺 bar 恢复：未就绪/缺 bar 时推送不直接出信号，改拉历史；连续推送仍走增量。
import { describe, expect, it } from 'vitest'
import { InstanceManager, needsHistoryReload } from '../src/runtime/instances'

const c = (t: number) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 })
const M = 60_000

describe('needsHistoryReload', () => {
  it('未就绪（无序列/空序列）-> true', () => {
    expect(needsHistoryReload(undefined, [c(M)], M)).toBe(true)
    expect(needsHistoryReload([], [c(M)], M)).toBe(true)
  })
  it('缺 bar -> true；连续、同根修订、迟到旧根 -> false', () => {
    const have = [c(0), c(M)]
    expect(needsHistoryReload(have, [c(3 * M)], M)).toBe(true)
    expect(needsHistoryReload(have, [c(2 * M)], M)).toBe(false)
    expect(needsHistoryReload(have, [c(M)], M)).toBe(false)
    expect(needsHistoryReload(have, [c(0)], M)).toBe(false)
  })
})

describe('InstanceManager.onMarketEvent', () => {
  const mk = () => {
    const m = new InstanceManager({} as never) as any
    const jobs: any[] = []
    m.enqueue = (_i: unknown, j: unknown) => { jobs.push(j) }
    m.items.set('i1', { instanceId: 'i1', status: 'running', interval: '1m', instruments: ['X'] })
    return { m, jobs }
  }
  it('历史未加载：推送不带残缺序列评估，改 recover 拉历史', () => {
    const { m, jobs } = mk()
    m.onMarketEvent('X', { interval: '1m', candle: c(0), closed: true })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].candles).toBeNull()
    expect(jobs[0].trigger).toBe('recover')
    expect(m.series.size).toBe(0)
  })
  it('缺 bar：丢序列并 recover；连续推送走增量', () => {
    const { m, jobs } = mk()
    m.series.set('X|1m', { candles: [c(0), c(M)], interval: '1m' })
    m.onMarketEvent('X', { interval: '1m', candle: c(2 * M), closed: true })
    expect(jobs[0].trigger).toBe('push')
    expect(m.series.get('X|1m').candles).toHaveLength(3)
    m.onMarketEvent('X', { interval: '1m', candle: c(5 * M), closed: true })
    expect(jobs[1].trigger).toBe('recover')
    expect(jobs[1].candles).toBeNull()
    expect(m.series.has('X|1m')).toBe(false)
  })
})
