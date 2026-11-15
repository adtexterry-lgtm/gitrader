// SPDX-License-Identifier: CPAL-1.0
// P1-14 界面偏好存在内核 docs 里（按数据目录，换端口不丢）：会话主体可读写，Agent 主体不行；偏好不是交易事实，不写账本。
import { afterEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const call = (name: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  h!.k.ops.call(h!.k, name, { principal: h!.session, params, transport: 'ws' })

describe('P1-14 UI prefs stored in the kernel', () => {
  it('prefs round-trip through the kernel docs', async () => {
    h = await makeHarness()
    expect(await call('ui.prefs.get')).toEqual({})
    const prefs = { theme: 'graphite', density: 'compact', nav: 'right', navForm: 'rail', updown: 'cn', blockCfg: { 'tile-a': { color: 'blue' } } }
    expect(await call('ui.prefs.set', { prefs })).toEqual({ ok: true })
    expect(await call('ui.prefs.get')).toEqual(prefs)
    expect(h.k.docs.get('ui', 'prefs')).toEqual(prefs)
  })

  it('rejects oversized prefs', async () => {
    h = await makeHarness()
    const oversized = { theme: 'deep', padding: 'x'.repeat(17 * 1024) }
    await expect(call('ui.prefs.set', { prefs: oversized })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: '偏好太大或格式不对' } })
    await expect(call('ui.prefs.set', { prefs: ['theme'] })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: '偏好太大或格式不对' } })
    expect(await call('ui.prefs.get')).toEqual({})
  })

  it('agent principal cannot read or write prefs', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'read_only')
    const asAgent = (name: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      h!.k.ops.call(h!.k, name, { principal: agent.principal, params, transport: 'ws' })
    await expect(asAgent('ui.prefs.get')).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    await expect(asAgent('ui.prefs.set', { prefs: { theme: 'graphite' } })).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(await call('ui.prefs.get')).toEqual({})
  })
})
