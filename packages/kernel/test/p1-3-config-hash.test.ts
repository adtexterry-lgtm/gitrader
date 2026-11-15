// SPDX-License-Identifier: CPAL-1.0
// P1-3 / ADR-7：配置风控段按摘要持久；摘要没变时启动不合并，保留工作台 PIN 放宽过的签名策略。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import type { GitraderConfig } from '../src/config'
import { FAST_SCRYPT, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let restarted: Kernel[] = []

beforeEach(async () => {
  h = await makeHarness({
    configure: (c) => { c.risk.limits = { ...c.risk.limits, maxOrderNotional: '0.01' as never } },
  })
  restarted = []
})

afterEach(async () => {
  for (const k of restarted.splice(0)) await k.stop().catch(() => undefined)
  await h.cleanup()
})

const editConfig = (mutate: (risk: GitraderConfig['risk']) => void): void => {
  const path = join(h.home, 'gitrader.json')
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as GitraderConfig
  mutate(cfg.risk)
  writeFileSync(path, JSON.stringify(cfg, null, 2))
}

const restart = async (): Promise<Kernel> => {
  await h.k.stop()
  const k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
  restarted.push(k)
  return k
}

const relaxNotional = async (value: string): Promise<void> => {
  const pin = await h.pinProof()
  h.k.risk.relax({ limits: { maxOrderNotional: value as never } }, pin, h.human('risk.relax').origin)
}

type ConfigAppliedPayload = { kind?: string; digest?: string; tightened?: string[]; ignored?: string[] }
const appliedEntries = (k: Kernel): ReturnType<Kernel['ledger']['query']> =>
  [...k.ledger.iterate()].filter((e) => (e.payload as ConfigAppliedPayload | undefined)?.kind === 'policy.config_applied')

describe('P1-3 配置摘要持久', () => {
  it('unchanged config keeps a PIN relaxation across restart', async () => {
    expect(h.k.risk.current()?.limits.maxOrderNotional).toBe('0.01')
    await relaxNotional('2000')
    expect(h.k.risk.current()?.limits.maxOrderNotional).toBe('2000')

    const k2 = await restart()
    expect(k2.risk.current()?.limits.maxOrderNotional).toBe('2000')
    expect(k2.warnings.join('\n')).not.toContain('收紧为')
  })

  it('changed tighter config applies and warns per field', async () => {
    await relaxNotional('5000')
    editConfig((risk) => { risk.limits = { ...risk.limits, maxOrderNotional: '0.005' as never, maxSlippageBps: 20 } })

    const k2 = await restart()
    const warnings = k2.warnings.join('\n')
    expect(warnings).toContain('配置文件把 maxOrderNotional 由 5000 收紧为 0.005')
    expect(warnings).toContain('配置文件把 maxSlippageBps 由 50 收紧为 20')
    expect(k2.risk.current()?.limits).toMatchObject({ maxOrderNotional: '0.005', maxSlippageBps: 20 })

    const applied = appliedEntries(k2)
    expect(applied.length).toBeGreaterThan(0)
    const payload = applied[applied.length - 1]!.payload as ConfigAppliedPayload
    expect(payload.digest).toEqual(expect.any(String))
    expect(payload.tightened).toEqual(expect.arrayContaining(['maxOrderNotional', 'maxSlippageBps']))
    expect(payload.ignored).toEqual([])
  })

  it('changed looser config is ignored with a warning', async () => {
    await relaxNotional('2000')
    editConfig((risk) => { risk.limits = { ...risk.limits, maxOrderNotional: '5000' as never } })

    const k2 = await restart()
    expect(k2.risk.current()?.limits.maxOrderNotional).toBe('2000')
    const warnings = k2.warnings.join('\n')
    expect(warnings).toContain('looser risk fields ignored')
    expect(warnings).toContain('maxOrderNotional')
    expect(warnings).not.toContain('收紧为')

    const applied = appliedEntries(k2)
    const payload = applied[applied.length - 1]!.payload as ConfigAppliedPayload
    expect(payload.tightened).toEqual([])
    expect(payload.ignored).toContain('maxOrderNotional')
  })

  it('first run after upgrade does not undo a relaxation', async () => {
    await relaxNotional('2000')
    h.k.docs.delete('risk', 'config_applied')
    expect(h.k.docs.get('risk', 'config_applied')).toBeUndefined()

    const k2 = await restart()
    expect(k2.risk.current()?.limits.maxOrderNotional).toBe('2000')
    expect(k2.warnings.join('\n')).not.toContain('收紧为')
    expect(k2.docs.get<{ digest: string }>('risk', 'config_applied')?.digest).toEqual(expect.any(String))
  })
})
