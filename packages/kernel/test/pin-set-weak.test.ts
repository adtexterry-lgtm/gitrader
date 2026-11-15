// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C5：pin.set 弱 PIN（连号 / 全相同）要 confirmWeak；非弱 PIN 不受影响。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const WEAK = { problem: { name: 'INVALID_PARAMS', message: expect.stringMatching(/^WEAK_PIN:/) } }
const setPin = (params: Record<string, unknown>, pin?: string): Promise<unknown> =>
  h.k.ops.call(h.k, 'pin.set', { principal: h.session, params, ...(pin ? { pin } : {}), transport: 'http' })

describe('pin.set 弱 PIN', () => {
  it('123456 / 000000 / 654321 没带 confirmWeak → 拒绝，消息以 WEAK_PIN: 开头，PIN 没被设上', async () => {
    for (const pin of ['123456', '000000', '654321']) {
      await expect(setPin({ pin })).rejects.toMatchObject(WEAK)
    }
    expect(h.k.pin.isSet()).toBe(false)
  })

  it('confirmWeak 不是 true（false / 字符串）也拒绝', async () => {
    await expect(setPin({ pin: '123456', confirmWeak: false })).rejects.toMatchObject(WEAK)
    await expect(setPin({ pin: '123456', confirmWeak: 'true' })).rejects.toMatchObject(WEAK)
    expect(h.k.pin.isSet()).toBe(false)
  })

  it('带 confirmWeak:true → 设置成功', async () => {
    expect(await setPin({ pin: '123456', confirmWeak: true })).toMatchObject({ ok: true, changed: false })
    expect(h.k.pin.isSet()).toBe(true)
  })

  it('不弱的 PIN 无需确认', async () => {
    expect(await setPin({ pin: '739204' })).toMatchObject({ ok: true })
    expect(h.k.pin.isSet()).toBe(true)
  })

  it('修改 PIN 时同样检查：新 PIN 太弱要确认', async () => {
    await setPin({ pin: '739204' })
    await expect(setPin({ pin: '111111' }, '739204')).rejects.toMatchObject(WEAK)
    expect(await setPin({ pin: '111111', confirmWeak: true }, '739204')).toMatchObject({ ok: true, changed: true })
  })
})
