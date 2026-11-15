// SPDX-License-Identifier: CPAL-1.0
// TtlLruCache：命中 / 过期 / LRU 淘汰 / 统计。
import { describe, expect, it } from 'vitest'
import { TtlLruCache } from '../src/util/lru-cache'

function fakeClock(start = 0): { now: number; clock: () => number } {
  const t: { now: number; clock: () => number } = {
    now: start,
    clock: (): number => t.now,
  }
  return t
}

describe('TtlLruCache', () => {
  it('set 后 get 命中，命中计数 +1', () => {
    const t = fakeClock()
    const c = new TtlLruCache<string>({ maxEntries: 2, defaultTtlMs: 1000, clock: t.clock })
    c.set('a', 'A')
    expect(c.get('a')).toBe('A')
    const s = c.stats()
    expect(s.size).toBe(1)
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(0)
  })

  it('过期后 miss、size 减一、expirations +1', () => {
    const t = fakeClock()
    const c = new TtlLruCache<string>({ maxEntries: 2, defaultTtlMs: 1000, clock: t.clock })
    c.set('a', 'A')
    t.now += 1001
    expect(c.get('a')).toBeUndefined()
    const s = c.stats()
    expect(s.size).toBe(0)
    expect(s.expirations).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.hits).toBe(0)
  })

  it('单条 ttl 覆盖 defaultTtlMs', () => {
    const t = fakeClock()
    const c = new TtlLruCache<string>({ maxEntries: 2, defaultTtlMs: 1000, clock: t.clock })
    c.set('long', 'L', 5000)
    c.set('short', 'S', 10)
    t.now += 100
    expect(c.get('long')).toBe('L')
    expect(c.get('short')).toBeUndefined()
  })

  it('超 maxEntries 淘汰最久未用；先 get 过的保留，evictions +1', () => {
    const t = fakeClock()
    const c = new TtlLruCache<string>({ maxEntries: 2, defaultTtlMs: 10_000, clock: t.clock })
    c.set('a', 'A')
    c.set('b', 'B')
    expect(c.get('a')).toBe('A') // a 成为最近使用
    c.set('c', 'C') // 淘汰最久未用的 b
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe('A')
    expect(c.get('c')).toBe('C')
    const s = c.stats()
    expect(s.size).toBe(2)
    expect(s.evictions).toBe(1)
  })

  it('hitRatio = hits / (hits + misses)；无请求时为 0', () => {
    const t = fakeClock()
    const c = new TtlLruCache<number>({ maxEntries: 4, defaultTtlMs: 1000, clock: t.clock })
    expect(c.stats().hitRatio).toBe(0)
    c.set('k', 1)
    expect(c.get('k')).toBe(1)
    expect(c.get('k')).toBe(1)
    expect(c.get('nope')).toBeUndefined()
    expect(c.stats().hitRatio).toBeCloseTo(2 / 3, 10)
  })

  it('delete 报告是否删掉；clear 后 size 0，统计保留', () => {
    const t = fakeClock()
    const c = new TtlLruCache<string>({ maxEntries: 4, defaultTtlMs: 1000, clock: t.clock })
    c.set('a', 'A')
    c.set('b', 'B')
    expect(c.get('a')).toBe('A')
    expect(c.delete('a')).toBe(true)
    expect(c.delete('a')).toBe(false)
    expect(c.stats().size).toBe(1)
    c.clear()
    expect(c.stats().size).toBe(0)
    expect(c.stats().hits).toBe(1)
  })
})
