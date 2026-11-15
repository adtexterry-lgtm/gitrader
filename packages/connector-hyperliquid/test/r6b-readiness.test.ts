// SPDX-License-Identifier: CPAL-1.0
// R6 B 包 R2-REL-02：连接器自报目录就绪度——主 dex 标的先就位（primaryInstruments），其余 dex 慢慢来（catalogComplete）。
import { afterEach, describe, expect, it } from 'vitest'
import { HyperliquidConnector } from '../src/connector'
import { FX_NOW, FakeHl, FakeWebSocket, loadFixture } from './helpers/fake-hl'

afterEach(() => { FakeWebSocket.reset() })

const make = (hl: FakeHl) => new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => FX_NOW })
const until = async (f: () => boolean, ms = 2000): Promise<void> => { for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); expect(f()).toBe(true) }
const meta = (dex: string): unknown => loadFixture(dex === '' ? 'metaAndAssetCtxs.json' : `metaAndAssetCtxs-${dex}.json`)

describe('R2-REL-02 目录就绪度', () => {
  it('[R6B-HL1] 主 dex 先就位、其余 dex 还在拉时 primaryInstruments 已为真而 catalogComplete 为假；拉完才都为真', async () => {
    const hl = new FakeHl()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    hl.info.set('metaAndAssetCtxs', async (body: { dex?: string }) => { if (body.dex) await gate; return meta(body.dex ?? '') })
    const c = make(hl)
    expect(c.readiness()).toEqual({ primaryInstruments: false, catalogComplete: false })
    const discovery = c.market.refreshInstruments()
    await until(() => c.readiness().primaryInstruments)
    expect(c.readiness()).toEqual({ primaryInstruments: true, catalogComplete: false })
    expect(c.getInstrument('hyperliquid:BTC')).toBeDefined()
    release()
    await discovery
    expect(c.readiness()).toEqual({ primaryInstruments: true, catalogComplete: true })
    await c.close()
  })

  it('[R6B-HL1] 主 dex 加载不出来：两项都为假；拿不到 dex 清单的冷启动只有主 dex，catalogComplete 仍为假', async () => {
    const down = new FakeHl()
    down.failDex.add('')
    const c1 = make(down)
    await c1.market.refreshInstruments().catch(() => undefined)
    expect(c1.readiness()).toEqual({ primaryInstruments: false, catalogComplete: false })
    await c1.close()

    const coldStart = new FakeHl()
    coldStart.info.set('perpDexs', () => new Response('boom', { status: 500 }))
    const c2 = make(coldStart)
    await c2.market.refreshInstruments()
    expect(c2.readiness()).toEqual({ primaryInstruments: true, catalogComplete: false })
    await c2.close()
  })
})
