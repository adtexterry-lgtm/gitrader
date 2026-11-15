// SPDX-License-Identifier: CPAL-1.0
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rig, bindPaper, strategyDir, FIXTURE_STRATEGIES, PAPER_ACCOUNT, MANDATE_ID, BTC, type Rig } from './harness'
import { ETH } from '../../protocol/conformance/host-sim'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })
const start = (strategyId: string, over: Record<string, unknown> = {}) => r!.session.request('strategy.start',
  { strategyId, accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: {}, mandateId: MANDATE_ID, ...over })
const boot = async () => {
  r = await rig({ strategiesDir: strategyDir([join(FIXTURE_STRATEGIES, 'ema-cross.ts'), join(FIXTURE_STRATEGIES, 'ema-cross-b.ts')]) })
  await bindPaper(r)
}

describe('同账户同标的只许一个目标仓位所有者（GQ-05）', () => {
  it('不同策略同账户同标的 → -32602，消息点名占用者', async () => {
    await boot()
    expect((await start('ema-trend')).ok).toBe(true)
    const o = await start('ema-trend-b')
    expect(o.ok).toBe(false)
    expect(o.ok ? '' : o.error.code).toBe(-32602)
    expect(o.ok ? '' : o.error.message).toMatch(/ema-trend .*already owns the target position/)
  })
  it('同策略不同周期也拒（旧规则放行）', async () => { await boot(); await start('ema-trend'); expect((await start('ema-trend', { interval: '5m' })).ok).toBe(false) })
  it('反例：不同标的放行；停掉占用者后可启动；同 instanceId 幂等重复 start 仍返回同一实例', async () => {
    await boot()
    const a = await start('ema-trend'); const id = (a as any).result.instanceId
    expect((await start('ema-trend-b', { instruments: [ETH] })).ok).toBe(true)
    expect((await start('ema-trend', { instanceId: id })).ok).toBe(true)
    await r!.session.call('strategy.stop', { instanceId: id })
    expect((await start('ema-trend-b')).ok).toBe(true)
  })
  it('已停止的实例用旧 instanceId 复位时，若别人已占位则拒', async () => {
    await boot()
    const id = (await start('ema-trend') as any).result.instanceId
    await r!.session.call('strategy.stop', { instanceId: id })
    expect((await start('ema-trend-b')).ok).toBe(true)
    expect((await start('ema-trend', { instanceId: id })).ok).toBe(false)
  })
})
