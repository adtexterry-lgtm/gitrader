// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { createWeightBudget } from '../src/budget'
import { HlHttp, HlNetworkError } from '../src/rest'

describe('Hyperliquid HTTP server clock', () => {
  it('does not repeat a skew warning for responses at the same time', async () => {
    const now = 1_800_000_000_000
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: { date: new Date(now + 12_000).toUTCString() } }),
    })
    await http.info({ type: 'userAbstraction' })
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(1)
  })

  it('estimates offset from the request midpoint and warns only beyond ten seconds', async () => {
    let now = 1_800_000_000_000
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => {
        now += 2_000
        return new Response('{}', { status: 200, headers: { date: new Date(1_800_000_014_000).toUTCString() } })
      },
    })
    await http.info({ type: 'userAbstraction' })
    expect(http.serverClockOffsetMs).toBe(13_000)
    expect(warnings).toEqual(['场所时钟偏差较大；签名到期时间按偏差换算'])
  })

  it('warns for a negative offset beyond ten seconds', async () => {
    const now = 1_800_000_000_000
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: { date: new Date(now - 12_000).toUTCString() } }),
    })
    await http.info({ type: 'userAbstraction' })
    expect(http.serverClockOffsetMs).toBe(-12_000)
    expect(warnings).toEqual(['场所时钟偏差较大；签名到期时间按偏差换算'])
  })

  it('does not warn at exactly ten seconds and ignores missing or invalid Date headers', async () => {
    let now = 1_800_000_020_000
    let date: string | undefined = new Date(now + 10_000).toUTCString()
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: date ? { date } : {} }),
    })
    await http.info({ type: 'userAbstraction' })
    expect(http.serverClockOffsetMs).toBe(10_000)
    expect(warnings).toEqual([])
    const validOffset = http.serverClockOffsetMs
    date = 'not-a-date'
    now += 1_000
    await http.info({ type: 'userAbstraction' })
    date = undefined
    now += 1_000
    await http.info({ type: 'userAbstraction' })
    expect(http.serverClockOffsetMs).toBe(validOffset)
    expect(warnings).toEqual([])
  })

  it('preserves the last offset and skew band when Date is invalid or missing', async () => {
    let now = 1_800_000_000_000
    let date: string | undefined = new Date(now + 12_000).toUTCString()
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: date ? { date } : {} }),
    })
    await http.info({ type: 'userAbstraction' })
    date = 'not-a-date'
    now += 1_000
    await http.info({ type: 'userAbstraction' })
    date = undefined
    now += 1_000
    await http.info({ type: 'userAbstraction' })
    now += 1_000
    date = new Date(now + 12_000).toUTCString()
    await http.info({ type: 'userAbstraction' })
    expect(http.serverClockOffsetMs).toBe(12_000)
    expect(warnings).toHaveLength(1)
  })

  it('limits repeated warnings across twenty responses in the same skew band', async () => {
    const now = 1_800_000_000_000
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now, targetRatio: 1, queryShare: 1 }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: { date: new Date(now + 12_000).toUTCString() } }),
    })
    for (let i = 0; i < 20; i++) await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(1)
  })

  it('warns when skew changes bands and after returning inside and leaving the threshold', async () => {
    let now = 1_800_000_000_000
    let offset = 12_000
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: { date: new Date(now + offset).toUTCString() } }),
    })
    await http.info({ type: 'userAbstraction' })
    offset = -12_000
    await http.info({ type: 'userAbstraction' })
    offset = 10_000
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(2)
    offset = 12_000
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(3)
  })

  it('warns again after a positive skew returns to zero and leaves the threshold', async () => {
    let now = 1_800_000_000_000
    let offset = 12_000
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: { date: new Date(now + offset).toUTCString() } }),
    })
    await http.info({ type: 'userAbstraction' })
    offset = 0
    await http.info({ type: 'userAbstraction' })
    expect(http.serverClockOffsetMs).toBe(0)
    offset = 12_000
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toEqual([
      '场所时钟偏差较大；签名到期时间按偏差换算',
      '场所时钟偏差较大；签名到期时间按偏差换算',
    ])
  })

  it('waits ten minutes after a clock rollback but treats a skew-band switch as a new event', async () => {
    let now = 1_800_000_000_000
    let offset = 12_000
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget({ clock: () => now }), clock: () => now,
      onWarn: (message) => warnings.push(message),
      fetchImpl: async () => new Response('{}', { status: 200, headers: { date: new Date(now + offset).toUTCString() } }),
    })
    await http.info({ type: 'userAbstraction' })
    now += 600_000
    await http.info({ type: 'userAbstraction' })
    now -= 600_000
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(2)
    now += 1_199_999
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(2)
    now += 1
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(3)
    now -= 700_000
    offset = -12_000
    await http.info({ type: 'userAbstraction' })
    expect(warnings).toHaveLength(4)
  })

  it('does not update offset or warn when a fetch returns after its timeout', async () => {
    let resolveFetch: (response: Response) => void = () => {}
    const warnings: string[] = []
    const http = new HlHttp({
      environment: 'testnet', budget: createWeightBudget(), timeoutMs: 1,
      onWarn: (message) => warnings.push(message),
      fetchImpl: () => new Promise<Response>((resolve) => { resolveFetch = resolve }),
    })
    await expect(http.info({ type: 'userAbstraction' })).rejects.toBeInstanceOf(HlNetworkError)
    resolveFetch(new Response('{}', { status: 200, headers: { date: new Date(Date.now() + 12_000).toUTCString() } }))
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)))
    expect(http.serverClockOffsetMs).toBeUndefined()
    expect(warnings).toEqual([])
  })
})
