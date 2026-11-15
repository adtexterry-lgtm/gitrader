// SPDX-License-Identifier: CPAL-1.0
// P1-14 界面偏好经内核存档：连上后先读内核值覆盖本机缓存，之后每次 set 写穿；老内核没有这个 op 时只用 localStorage。
import { describe, expect, it } from 'vitest'
import { PrefsStore } from '../src/core/prefs'
import type { StorageLike, UiPrefsApi } from '../src/core/prefs'

function memoryStorage(initial: string | null = null) {
  let saved = initial
  const writes: string[] = []
  const storage: StorageLike = { getItem: () => saved, setItem: (_key, value) => { saved = value; writes.push(value) } }
  return { storage, writes }
}

function fakeKernel(initial: Record<string, unknown> = {}) {
  const writes: Record<string, unknown>[] = []
  const api: UiPrefsApi = {
    getUiPrefs: async () => initial,
    setUiPrefs: async (prefs) => { writes.push(prefs) },
  }
  return { api, writes }
}

describe('P1-14 prefs through the kernel', () => {
  it('kernel prefs override local cache on attach', async () => {
    const { storage, writes } = memoryStorage(JSON.stringify({ theme: 'deep', density: 'comfortable', nav: 'right' }))
    const prefs = new PrefsStore(storage)
    const { api } = fakeKernel({ theme: 'graphite', density: 'compact', nav: 'left', navForm: 'rail', updown: 'cn', blockCfg: { 'tile-a': { color: 'blue' } } })
    await prefs.attachKernel(api)
    expect(prefs.get()).toMatchObject({ theme: 'graphite', density: 'compact', nav: 'left', navForm: 'rail', updown: 'cn', blockCfg: { 'tile-a': { color: 'blue' } } })
    expect(JSON.parse(writes.at(-1)!).nav).toBe('left')
  })

  it('set writes through to the kernel', async () => {
    const { storage, writes } = memoryStorage()
    const prefs = new PrefsStore(storage)
    const { api, writes: kernelWrites } = fakeKernel()
    await prefs.attachKernel(api)
    prefs.set({ theme: 'graphite', updown: 'cn' })
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({ theme: 'graphite', updown: 'cn' })
    expect(kernelWrites).toHaveLength(1)
    expect(kernelWrites[0]).toMatchObject({ theme: 'graphite', updown: 'cn' })
    prefs.set({ nav: 'right' })
    expect(kernelWrites).toHaveLength(2)
    expect(kernelWrites[1]).toMatchObject({ theme: 'graphite', nav: 'right' })
  })

  it('kernel without the op falls back silently', async () => {
    const { storage, writes } = memoryStorage()
    const prefs = new PrefsStore(storage)
    const missing = Object.assign(new Error('unknown operation ui.prefs.get'), { code: -32601 })
    const api: UiPrefsApi = { getUiPrefs: () => Promise.reject(missing), setUiPrefs: () => Promise.reject(missing) }
    await expect(prefs.attachKernel(api)).resolves.toBeUndefined()
    expect(() => prefs.set({ nav: 'right' })).not.toThrow()
    expect(prefs.get().nav).toBe('right')
    expect(JSON.parse(writes.at(-1)!).nav).toBe('right')
  })
})
