// SPDX-License-Identifier: CPAL-1.0
// 钥匙与授权书期限统一：同一次创建用同一个到期日，默认 30 天，显式天数与配置覆盖同时作用于两者。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const DAY = 86_400_000

async function createKey(h: Harness, expiresInDays?: number) {
  const pin = await h.pinProof()
  return h.k.agents.createKey({
    name: 'expiry-fixture', host: 'codex', tier: 'paper',
    mandate: { accounts: [h.paper.accountId as never] },
    ...(expiresInDays === undefined ? {} : { expiresInDays }),
  }, pin, h.human('agentkey.create').origin)
}

describe('P1-18 钥匙与授权书期限', () => {
  let h: Harness
  beforeEach(async () => { h = await makeHarness() })
  afterEach(async () => { await h.cleanup() })

  it('key and mandate expire on the same day by default (30 days)', async () => {
    const now = h.clock.now()
    const { key, mandate } = await createKey(h)
    expect(key.expiresAt).toBe(now + 30 * DAY)
    expect(mandate.notAfter).toBe(now + 30 * DAY)
    expect(key.expiresAt).toBe(mandate.notAfter)
  })

  it('expiresInDays applies to both', async () => {
    const now = h.clock.now()
    const { key, mandate } = await createKey(h, 7)
    expect(key.expiresAt).toBe(now + 7 * DAY)
    expect(mandate.notAfter).toBe(now + 7 * DAY)
    expect(key.expiresAt).toBe(mandate.notAfter)
  })

  it('config agentKeyExpiryDays still overrides', async () => {
    const custom = await makeHarness({ configure: (c) => { c.keys.agentKeyExpiryDays = 12 } })
    try {
      const now = custom.clock.now()
      const { key, mandate } = await createKey(custom)
      expect(key.expiresAt).toBe(now + 12 * DAY)
      expect(mandate.notAfter).toBe(now + 12 * DAY)
      expect(key.expiresAt).toBe(mandate.notAfter)
    } finally {
      await custom.cleanup()
    }
  })
})
