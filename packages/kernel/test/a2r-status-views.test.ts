// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'

const REQUEST_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

describe('A2R status views', () => {
  it('keeps unverified metadata across kernel, ops, and Agent views and warns once on registration', async () => {
    const h = await makeHarness({ registerLive: false })
    try {
      const simStatus = h.sim.status.bind(h.sim)
      h.sim.status = () => ({ ...simStatus(), venue: 'kernel-sim' })
      h.k.registerConnector(h.live, { unverified: true })
      expect(() => h.k.registerConnector(h.live, { unverified: true })).toThrow()
      expect(h.k.warnings.filter((warning) => warning.includes('registered as unverified'))).toHaveLength(1)

      const kernelStatus = h.k.status().connectors as Array<{ id: string; status: Record<string, unknown> }>
      expect(kernelStatus.find((connector) => connector.id === 'hyperliquid')?.status).toMatchObject({ unverified: true })

      const opsStatus = await h.k.ops.call(h.k, 'venue.status', { principal: h.session, params: {}, transport: 'ws' }) as Array<Record<string, unknown>>
      expect(opsStatus.find((status) => status.venue === 'hyperliquid')).toMatchObject({ unverified: true, connection: 'connected' })

      const agent = await makeAgent(h, 'paper')
      const reply = await h.k.ops.call(h.k, 'agent.market', {
        principal: agent.principal,
        params: { requestId: REQUEST_ID, action: 'venue_status' },
        transport: 'http',
      }) as { data: Array<Record<string, unknown>> }
      expect(reply.data.find((status) => status.venue === 'hyperliquid')).toMatchObject({ unverified: true })
    } finally {
      await h.cleanup()
    }
  })

  it('warns about a missing owner address only for api-wallet accounts', async () => {
    const apiKey = await makeHarness({ configure: (config) => {
      const account = config.accounts.find((item) => item.alias === 'live')!
      account.credentials = { apiKey: 'env:A2R_TEST_KEY' }
      delete account.owner
    } })
    const apiWallet = await makeHarness({ configure: (config) => {
      delete config.accounts.find((item) => item.alias === 'live')!.owner
    } })
    try {
      expect(apiKey.k.warnings.some((warning) => warning.includes('owner.address'))).toBe(false)
      expect(apiWallet.k.warnings.some((warning) => warning.includes('owner.address'))).toBe(true)
    } finally {
      await Promise.all([apiKey.cleanup(), apiWallet.cleanup()])
    }
  })
})
