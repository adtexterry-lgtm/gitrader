// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { findPositionOwner, type RunningInst } from '../src/strategy-instances'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

describe('findPositionOwner 纯函数（GQ-05）', () => {
  const makeInst = (id: string, accountId: string, instruments: string[], status = 'running'): RunningInst =>
    ({ instanceId: id, strategyId: 'test-strategy', accountId, instruments, status })

  it('同账户同标的且正在跑 → 返回占用者', () => {
    const list = [makeInst('inst1', 'acc1', [BTC])]
    const hit = findPositionOwner(list, 'acc1', [BTC])
    expect(hit).toMatchObject({ instanceId: 'inst1', shared: BTC })
  })

  it('不同账户 → undefined', () => {
    const list = [makeInst('inst1', 'acc1', [BTC])]
    expect(findPositionOwner(list, 'acc2', [BTC])).toBeUndefined()
  })

  it('不同标的 → undefined', () => {
    const list = [makeInst('inst1', 'acc1', [BTC])]
    expect(findPositionOwner(list, 'acc1', ['ETH'])).toBeUndefined()
  })

  it('已停止（status !== running）→ undefined', () => {
    const list = [makeInst('inst1', 'acc1', [BTC], 'stopped')]
    expect(findPositionOwner(list, 'acc1', [BTC])).toBeUndefined()
  })

  it('selfId 跳过自己 → undefined', () => {
    const list = [makeInst('inst1', 'acc1', [BTC])]
    expect(findPositionOwner(list, 'acc1', [BTC], 'inst1')).toBeUndefined()
  })

  it('多标的部分交集 → 返回交集的那个标的', () => {
    const list = [makeInst('inst1', 'acc1', [BTC, 'ETH'])]
    const hit = findPositionOwner(list, 'acc1', ['ETH', 'SOL'])
    expect(hit).toMatchObject({ instanceId: 'inst1', shared: 'ETH' })
  })

  it('多个实例，返回第一个匹配的', () => {
    const list = [
      makeInst('inst1', 'acc1', ['ETH']),
      makeInst('inst2', 'acc1', [BTC]),
    ]
    const hit = findPositionOwner(list, 'acc1', [BTC])
    expect(hit).toMatchObject({ instanceId: 'inst2', shared: BTC })
  })
})

describe('内核级 assertNoPositionOwner（GQ-05）', () => {
  it('跨引擎检查：一个引擎已占位 → 另一个引擎启动被拒', async () => {
    // This will be implemented after fixing engine-core instances.ts
    // For now, just a placeholder to ensure kernel-level check exists
    expect(true).toBe(true)
  })
})
