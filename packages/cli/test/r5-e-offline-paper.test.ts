// SPDX-License-Identifier: CPAL-1.0
// R5 / GQ-60：--offline 下账户查询全挂（ACCOUNT_NOT_BOUND no connector registered for kernel-sim）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider, initHome } from '@gitrader/kernel'
import { FakeConnector } from '../../kernel/test/helpers/fake-connector'
import { runServe } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let stdout: string[]
let stderr: string[]

function makeIo(): CliIo {
  return {
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    env: { GITRADER_HOME: home },
    interactive: false,
    deviceKey: fileProvider,
    readSecret: async () => { throw new Error('unexpected prompt') },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-r5e-off-'))
  initHome(home)
  stdout = []
  stderr = []
})

afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe('GQ-60 离线纸面场所', () => {
  it('离线 serve：kernel-sim 已注册，纸面账户快照可读（权益=10000）；离线没有标的，下单无标的可成交', async () => {
    const handle = await runServe(home, { port: 0, io: makeIo(), connectors: false })
    try {
      const k = handle.kernel
      expect(k.bus.get('kernel-sim')).toBeDefined()
      const acct = k.accounts.find('paper')!
      const snap = await k.bus.snapshot(acct, { maxAgeMs: 0 })           // 修前：ACCOUNT_NOT_BOUND
      expect(snap.equity).toBe('10000')
      // 离线行情桩 getInstrument 恒 undefined → 没有任何标的，下单在标的校验被拒（S-E4：绝不成交）
      expect(k.bus.instrument('hyperliquid:BTC')).toBeUndefined()
      expect(k.bus.instruments()).toEqual([])
    } finally { await handle.stop() }
  })

  it('带 connect 的旧用法不受影响（不重复注册 kernel-sim）', async () => {
    const handle = await runServe(home, {
      port: 0,
      io: makeIo(),
      connectors: false,
      connect: (kernel) => { kernel.registerConnector(new FakeConnector({ id: 'kernel-sim', clock: kernel.clock })) },
    })
    try {
      expect(handle.kernel.bus.get('kernel-sim')).toBeDefined()
    } finally { await handle.stop() }
  })
})
