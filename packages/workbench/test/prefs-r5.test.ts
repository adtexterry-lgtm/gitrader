// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { PrefsStore, type StorageLike } from '../src/core/prefs'

function memoryStorage(initial: string | null = null) {
  const writes: string[] = []
  const storage: StorageLike = { getItem: () => initial, setItem: (_key, value) => writes.push(value) }
  return { storage, writes }
}

describe('r5 preferences', () => {
  it('defaults new fields and drops malformed field values individually', () => {
    const { storage } = memoryStorage(JSON.stringify({ navForm: [], updown: 'unknown', blockCfg: { good: { x: 1 }, bad: [], primitive: 3 }, token: 'drop' }))
    expect(new PrefsStore(storage).get()).toMatchObject({ navForm: 'top', updown: 'intl', blockCfg: { good: { x: 1 } } })
    expect(new PrefsStore(storage).get()).not.toHaveProperty('token')
  })

  it('updates and persists one instance config while notifying subscribers', () => {
    const { storage, writes } = memoryStorage()
    const prefs = new PrefsStore(storage)
    const seen: unknown[] = []
    prefs.subscribe((next) => seen.push(next.blockCfg))
    prefs.setBlockConfig('tile-a', { color: 'blue' })
    prefs.setBlockConfig('tile-a', { visible: true })
    expect(prefs.get().blockCfg).toEqual({ 'tile-a': { color: 'blue', visible: true } })
    expect(JSON.parse(writes.at(-1)!).blockCfg).toEqual({ 'tile-a': { color: 'blue', visible: true } })
    expect(seen).toHaveLength(2)
  })

  it('keeps existing saved and URL override behavior for nav and density', () => {
    const { storage } = memoryStorage(JSON.stringify({ nav: 'right', density: 'compact' }))
    const prefs = new PrefsStore(storage, new URLSearchParams('nav=left'))
    expect(prefs.get()).toMatchObject({ nav: 'left', density: 'compact' })
    prefs.set({ nav: 'right' })
    expect(prefs.get().nav).toBe('right')
  })
})
