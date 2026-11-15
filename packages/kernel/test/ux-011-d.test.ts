// SPDX-License-Identifier: CPAL-1.0
// ux-011 D 包：K1 launcher 字段 / K2 版本 / UX-10 连不上提示 / UX-17 端口占用提示 / UX-20 提示与文案（判定不变）。
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import { KERNEL_VERSION, launcherFromEnv } from '../src/kernel'
import { hintOf, zhHits, zhNote } from '../src/api/agent-out'
import { KernelError } from '../src/util/errors'
import { newClientOrderId } from '../src/util/ids'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
const saved = process.env.GITRADER_LAUNCHER
afterEach(async () => {
  await h?.cleanup(); h = undefined
  if (saved === undefined) delete process.env.GITRADER_LAUNCHER; else process.env.GITRADER_LAUNCHER = saved
})

describe('K1 launcher', () => {
  it('launcherFromEnv：没设 → gitrader；有空格 → 加双引号；已带引号不重复加', () => {
    expect(launcherFromEnv({})).toBe('gitrader')
    expect(launcherFromEnv({ GITRADER_LAUNCHER: 'C:\a\bin\gitrader.cmd' })).toBe('C:\a\bin\gitrader.cmd')
    expect(launcherFromEnv({ GITRADER_LAUNCHER: 'C:\my dir\gitrader.cmd' })).toBe('"C:\my dir\gitrader.cmd"')
    expect(launcherFromEnv({ GITRADER_LAUNCHER: '"C:\my dir\gitrader.cmd"' })).toBe('"C:\my dir\gitrader.cmd"')
  })
  it('健康快照与 status 都带 launcher（旧字段不动）；/api/health 也带', async () => {
    process.env.GITRADER_LAUNCHER = 'C:\p q\gitrader.cmd'
    h = await makeHarness()
    expect(h.k.healthSnapshot().launcher).toBe('"C:\p q\gitrader.cmd"')
    expect(h.k.status().launcher).toBe('"C:\p q\gitrader.cmd"')
    const r = await h.k.start({ port: 0 })
    const body = await (await fetch(`http://127.0.0.1:${r.port}/api/health`)).json() as Record<string, unknown>
    expect(body.launcher).toBe('"C:\p q\gitrader.cmd"')
    for (const k of ['status', 'uptimeSec', 'version', 'ts', 'ok', 'name', 'startedAt', 'stateFiles', 'warnings', 'ledgerVerify', 'paperState']) expect(body).toHaveProperty(k)
  })
  it('K2：KERNEL_VERSION 等于发布版本（根 package.json）', () => {
    const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(KERNEL_VERSION).toBe(root.version)
    expect(KERNEL_VERSION).toBe('0.1.1')
  })
})

describe('UX-17 端口占用', () => {
  it('指定端口被占时提示换 --port 或自动选端口', async () => {
    h = await makeHarness()
    const r = await h.k.start({ port: 0 })
    const h2 = await makeHarness()
    try {
      await expect(h2.k.start({ port: r.port })).rejects.toThrow(/--port/)
    } finally { await h2.cleanup() }
  })
})

describe('UX-10 连不上交易所', () => {
  it('目录为空且熔断打开 → 「连不上」，不是「标的列表还在加载」；熔断没开仍是原来的 not ready', async () => {
    h = await makeHarness()
    h.live.instrumentsList.length = 0; h.sim.instrumentsList.length = 0
    const intent: OrderIntent = { accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit', size: asDecimal('0.001'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId() }
    const probe = async (): Promise<KernelError['problem']> => {
      try { await h!.k.trading.preview(intent, h!.human()) } catch (e) { if (e instanceof KernelError) return e.problem; throw e }
      throw new Error('expected throw')
    }
    expect((await probe()).message.startsWith('market data not ready')).toBe(true)
    ;(h.live as unknown as { circuit: () => { state: string } }).circuit = () => ({ state: 'open' })
    const p = await probe()
    expect(p.name).toBe('VENUE_UNAVAILABLE')
    expect(p.message).not.toMatch(/still loading|not ready/)
    expect(p.message).toMatch(/cannot reach/)
    expect(p.retryable).toBe(true)
  })
})

describe('UX-20 提示与文案（判定数据不变）', () => {
  it('内核已取整（action: limit）的 SIZE_PRECISION 不再给「改法」；拒单（deny）的照旧', () => {
    expect(hintOf({ code: 'SIZE_PRECISION', action: 'limit', limit: '0.00154' })).toBeUndefined()
    expect(hintOf({ code: 'SIZE_PRECISION', action: 'deny', limit: '0.00151' })).toContain('0.00151')
    expect(hintOf({ code: 'SIZE_PRECISION', limit: '0.00151' })).toContain('0.00151')
  })
  it('zh 文案里计价币种金额保留 2 位小数；原始 limit / actual 一字不动；非金额单位不动', () => {
    const hit = { ruleId: 'r', code: 'ORDER_NOTIONAL', limit: '400', actual: '499.72332', unit: 'USDC', action: 'deny', scope: 'account' }
    const [out] = zhHits([hit])
    expect(out!.zh).toContain('499.72 USDC')
    expect(out!.zh).not.toContain('499.72332')
    expect(out!.actual).toBe('499.72332')
    expect(zhNote([hit])).toContain('499.72 USDC')
    const lev = { ruleId: 'r', code: 'LEVERAGE', limit: '3', actual: '5.12345', unit: 'x', action: 'deny', scope: 'account' }
    expect(zhHits([lev])[0]!.zh).toContain('5.12345')
  })
})
