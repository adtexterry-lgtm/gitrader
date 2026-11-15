// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { PrecheckThrottle } from '../src/precheck-throttle'
import type { PrecheckNote } from '../src/precheck-throttle'

function setup(write?: (note: PrecheckNote) => void): {
  throttle: PrecheckThrottle
  notes: PrecheckNote[]
  advance: (ms: number) => void
} {
  let now = Date.UTC(2026, 9, 25, 3, 0, 0)
  const notes: PrecheckNote[] = []
  const throttle = new PrecheckThrottle({
    now: () => now,
    dayOf: (ms) => new Date(ms).toISOString().slice(0, 10),
    write: write ?? ((n) => { notes.push(n) }),
  })
  return { throttle, notes, advance: (ms) => { now += ms } }
}

describe('PrecheckThrottle', () => {
  it('first 20 per minute are individual entries', () => {
    const { throttle } = setup()
    for (let i = 0; i < 20; i++) expect(throttle.admit('agent:a', [], `pc_${i}`)).toBe(true)
    expect(throttle.admit('agent:a', [], 'pc_20')).toBe(false)
    expect(throttle.admit('agent:b', [], 'pc_b0')).toBe(true)
  })

  it('overflow is summarised once', () => {
    const { throttle, notes, advance } = setup()
    for (let i = 0; i < 50; i++) throttle.admit('agent:a', ['STALE_PRICE'], `pc_${i}`)
    expect(notes.length).toBe(0)
    advance(60_000)
    throttle.flush()
    expect(notes.length).toBe(1)
    const note = notes[0]
    expect(note?.kind).toBe('precheck.summary')
    if (note?.kind !== 'precheck.summary') throw new Error('expected summary')
    expect(note.count).toBe(30)
    expect(note.ruleHits.STALE_PRICE).toBe(30)
    expect(note.samplePrecheckIds).toEqual(['pc_20', 'pc_21', 'pc_22'])
    expect(note.windowEnd - note.windowStart).toBe(60_000)
    throttle.flush()
    expect(notes.length).toBe(1)
  })

  it('daily rollup is written only when something was summarised', () => {
    const { throttle, notes, advance } = setup()
    for (let i = 0; i < 25; i++) throttle.admit('agent:a', ['STALE_PRICE'], `pc_${i}`)
    for (let i = 0; i < 3; i++) throttle.admit('agent:b', ['STALE_PRICE'], `pb_${i}`)
    advance(86_400_000)
    throttle.flush()
    const forA = notes.filter((n) => n.actor === 'agent:a')
    expect(forA.length).toBe(2)
    const summary = forA.find((n) => n.kind === 'precheck.summary')
    const daily = forA.find((n) => n.kind === 'precheck.daily')
    expect(summary?.kind === 'precheck.summary' ? summary.count : undefined).toBe(5)
    expect(daily?.kind === 'precheck.daily' ? daily.individual : undefined).toBe(20)
    expect(daily?.kind === 'precheck.daily' ? daily.summarized : undefined).toBe(5)
    expect(notes.filter((n) => n.actor === 'agent:b').length).toBe(0)
  })

  it('force flush on shutdown writes open windows', () => {
    const { throttle, notes } = setup()
    for (let i = 0; i < 22; i++) throttle.admit('agent:a', ['STALE_PRICE'], `pc_${i}`)
    throttle.flush(true)
    expect(notes.length).toBe(2)
    const summary = notes.find((n) => n.kind === 'precheck.summary')
    const daily = notes.find((n) => n.kind === 'precheck.daily')
    expect(summary?.kind === 'precheck.summary' ? summary.count : undefined).toBe(2)
    expect(daily?.kind === 'precheck.daily' ? daily.summarized : undefined).toBe(2)
  })

  it('write errors do not break the throttle', () => {
    const { throttle } = setup(() => { throw new Error('disk') })
    for (let i = 0; i < 25; i++) throttle.admit('agent:a', ['STALE_PRICE'], `pc_${i}`)
    expect(() => throttle.flush(true)).not.toThrow()
    expect(throttle.admit('agent:a', ['STALE_PRICE'], 'pc_after')).toBe(true)
  })
})
