// SPDX-License-Identifier: CPAL-1.0
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined, thrown: undefined as unknown }))

vi.mock('@gitrader/connector-binance-trade', () => ({
  BinanceTradeConnector: class {
    readonly venue = 'binance'
    constructor(options: Record<string, unknown>) {
      mocked.options = options
      if (mocked.thrown !== undefined) throw mocked.thrown
    }
  },
}))

import { assembleConnectors, factoryFor } from '../src/connectors'
import type { Kernel } from '@gitrader/kernel'
import type { CliIo } from '../src/index'

function setup() {
  const errors: string[] = []
  const registrations: { connector: { venue: string }; options?: unknown }[] = []
  const kernel = {
    config: {
      venues: [{ id: 'binance', environment: 'testnet', enabled: true }],
      accounts: [{ venue: 'binance', environment: 'testnet', mode: 'live', alias: 'test', credentials: { apiKey: 'env:k', apiSecret: 'env:s' } }],
      supportDeveloper: false,
    },
    opts: { resolveSecret: (ref: string) => ref === 'env:k' ? 'synthetic-api-key' : 'synthetic-api-secret' },
    bus: { budgetFor: () => ({ take: () => true, takeSync: () => true, charge: () => undefined, remaining: () => 1, snapshot: () => ({}) }) },
    clock: { now: () => 1_700_000_000_000 },
    registerConnector: (connector: { venue: string }, options?: unknown) => registrations.push({ connector, options }),
    connectInBackground: () => undefined,
  }
  const io: CliIo = { out: () => undefined, err: (s) => errors.push(s), env: {}, interactive: false, readSecret: async () => '' }
  return { kernel: kernel as unknown as Kernel, io, errors, registrations }
}

beforeEach(() => { mocked.options = undefined; mocked.thrown = undefined })

describe('A3F trade connector log boundary', () => {
  it('logs only the fixed venue warning when onWarn receives arbitrary sensitive text', () => {
    const h = setup()
    factoryFor('binance')!.create({ k: h.kernel, io: h.io, environment: 'testnet' })
    const onWarn = mocked.options?.onWarn as (message: string) => void
    onWarn('synthetic-api-key synthetic-api-secret synthetic-passphrase remote-detail')
    expect(h.errors).toEqual(['[gitrader] warning: binance connector reported a background warning\n'])
  })

  it('does not expose a constructor exception containing a synthetic secret', () => {
    mocked.thrown = new Error('synthetic-api-secret')
    const h = setup()
    const result = assembleConnectors({ k: h.kernel, io: h.io })
    expect(h.errors.join('')).not.toContain('synthetic-api-secret')
    expect(h.errors).toContain('[gitrader] warning: binance trade connector could not be created; using data connector\n')
    expect(result.find((item) => item.id === 'binance')?.ok).toBe(true)
  })
})
