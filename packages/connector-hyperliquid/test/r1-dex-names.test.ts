// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it, vi } from 'vitest'
import { HyperliquidConnector } from '../src/connector'
import { FakeHl, loadFixture } from './helpers/fake-hl'

describe('discoverDexNames', () => {
  it('打一次 perpDexs、零次 metaAndAssetCtxs；xyz 状态为 live', async () => {
    const fake = new FakeHl()
    vi.stubGlobal('fetch', fake.fetch)
    const hl = new HyperliquidConnector({ environment: 'mainnet', useWs: false, discoveryIntervalMs: 0 })

    await hl.discoverDexNames()
    await hl.discoverDexNames()

    const perpDexsCalls = fake.infoCalls('perpDexs')
    const metaCalls = fake.infoCalls('metaAndAssetCtxs')
    expect(perpDexsCalls.length).toBe(1)
    expect(metaCalls.length).toBe(0)

    const status = hl['market'].dexStatus()
    const xyz = status.find((d) => d.dex === 'xyz')
    expect(xyz?.status).toBe('live')

    vi.unstubAllGlobals()
  })

  it('perpDexs 第一次失败、第二次成功：第一次抛错、第二次 xyz 在名单', async () => {
    const fake = new FakeHl()
    let perpDexsFails = 1
    fake.info.set('perpDexs', () => {
      if (perpDexsFails > 0) { perpDexsFails--; return new Response('Internal Server Error', { status: 500 }) }
      return loadFixture('perpDexs.json')
    })
    vi.stubGlobal('fetch', fake.fetch)
    const hl = new HyperliquidConnector({ environment: 'mainnet', useWs: false, discoveryIntervalMs: 0 })

    await expect(hl.discoverDexNames()).rejects.toThrow()
    expect(fake.infoCalls('perpDexs').length).toBe(1)

    await hl.discoverDexNames()
    expect(fake.infoCalls('perpDexs').length).toBe(2)

    const status = hl['market'].dexStatus()
    const xyz = status.find((d) => d.dex === 'xyz')
    expect(xyz?.status).toBe('live')

    vi.unstubAllGlobals()
  })
})
