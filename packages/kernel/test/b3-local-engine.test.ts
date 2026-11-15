// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import type { EngineHandle } from '../src/engines'

function fakePeer(): EngineHandle {
  const listeners = new Set<(line: string) => void>()
  return {
    kind: 'stdio',
    send(line) {
      const request = JSON.parse(line) as { id?: number; method?: string }
      if (request.id === undefined) return true
      const result = request.method === 'gep.hello' ? { version: '1.0.0', sessionId: 'session-local-test' }
        : request.method === 'engine.describe' ? { engine: { id: 'gitrader-core', version: '1.0.0', name: 'local test engine' }, strategies: [], capabilities: [] }
          : { subscriptionId: 'subscription-local-test' }
      const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
      queueMicrotask(() => { for (const listener of listeners) listener(response) })
      return true
    },
    onLine(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

describe('B3 adopted local engine lifecycle', () => {
  it('handshakes through GEP, stays local across startAll, and closes once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gitrader-06b-engine-'))
    let kernel: Kernel | undefined
    try {
      kernel = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
      let closed = 0
      let disconnected = 0
      kernel.engines.onDisconnected(() => { disconnected++ })
      kernel.engines.adoptLocal('gitrader-core', fakePeer(), 'token-local-test', () => { closed++ })
      kernel.engines.startAll({ builtin: true })
      for (let i = 0; i < 20 && kernel.engines.status().find((entry) => entry.id === 'gitrader-core')?.state !== 'ready'; i++) await new Promise((resolve) => setImmediate(resolve))
      expect(kernel.engines.status().find((entry) => entry.id === 'gitrader-core')?.state).toBe('ready')
      await kernel.engines.stop('gitrader-core')
      await kernel.engines.stop('gitrader-core')
      expect(closed).toBe(1)
      expect(disconnected).toBe(1)
      expect(kernel.engines.status().find((entry) => entry.id === 'gitrader-core')?.state).toBe('stopped')
    } finally { await kernel?.stop(); rmSync(home, { recursive: true, force: true }) }
  })
})
