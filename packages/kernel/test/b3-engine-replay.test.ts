// SPDX-License-Identifier: CPAL-1.0
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEngine } from '../../engine-core/build.mjs'
import { GepHost } from '../src/gep-host'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let bundle = ''
let h: Harness
let buildDir = ''

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), 'gitrader-b3-engine-replay-'))
  bundle = await buildEngine(join(buildDir, 'engine-core.mjs'))
}, 60_000)
beforeEach(async () => {
  h = await makeHarness({ configure: (cfg) => {
    cfg.engines.push({ id: 'core', enabled: true, launch: { command: process.execPath, args: [bundle, '--stdio'] } })
  } })
  h.k.engines.start('core')
  for (let i = 0; i < 600 && !h.k.gep.isReady('core'); i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(h.k.gep.isReady('core')).toBe(true)
})
afterEach(async () => { await h?.cleanup() })
afterAll(() => { if (buildDir) rmSync(buildDir, { recursive: true, force: true }) })

describe('GEP exposes built-in engine replay methods', () => {
  it('forwards replay start, stop, and status to the real engine', async () => {
    const messages: string[] = []
    const expectEngineError = async (method: string, params: Record<string, unknown>): Promise<void> => {
      let failure: unknown
      try { await GepHost.prototype.callEngine.call(h.k.gep, 'core', method, params) } catch (error) { failure = error }
      expect(failure).toBeDefined()
      messages.push((failure as { problem?: { message?: string } }).problem?.message ?? '')
    }
    await expectEngineError('replay.start', {})
    await expectEngineError('replay.stop', { replayId: 'rpl_unknown' })
    await expectEngineError('replay.status', { replayId: 'rpl_unknown' })
    expect(messages).toEqual(['spec must be an object', 'unknown replayId', 'unknown replayId'])
  })
})
