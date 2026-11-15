// SPDX-License-Identifier: Apache-2.0
// v0.1.4：速率类限额（可选）、HALTED 勘误、构建 banner。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_PACKAGE_VERSION, TRADING_STATES, TRADING_STATE_ALLOWS, validateMandate, validateRiskPolicy } from '../src'
import { PKG_ROOT, clone, contract, sample } from './helpers'

describe('v0.1.4 速率类限额', () => {
  it('版本', () => expect(PROTOCOL_PACKAGE_VERSION).toMatch(/^0.1.[0-9]+$/))
  it('RiskLimits：maxDailyOrders / maxCancelsPerMinute / duplicateIntentWindowSec 可选，旧文档照样通过', () => {
    const p = sample('RiskPolicy')
    expect(validateRiskPolicy(p).ok).toBe(true)
    p.limits = { ...p.limits, maxDailyOrders: 200, maxCancelsPerMinute: 30, duplicateIntentWindowSec: 5 }
    expect(validateRiskPolicy(p).ok).toBe(true)
    for (const [k, v] of [['maxDailyOrders', 0], ['maxCancelsPerMinute', 1.5], ['duplicateIntentWindowSec', -1], ['maxDailyOrders', '200']] as const) {
      const q = clone(p)
      q.limits[k] = v
      expect(validateRiskPolicy(q).ok, `${k}=${v}`).toBe(false)
    }
    const zeroWindow = clone(p)
    zeroWindow.limits.duplicateIntentWindowSec = 0 // 0 = 关闭去重
    expect(validateRiskPolicy(zeroWindow).ok).toBe(true)
  })
  it('MandateLimits 同样追加', () => {
    const m = clone(contract('mandate-l3'))
    m.limits = { ...m.limits, maxDailyOrders: 100, maxCancelsPerMinute: 20, duplicateIntentWindowSec: 3 }
    expect(validateMandate(m).ok).toBe(true)
    m.limits.maxCancelsPerMinute = 0
    expect(validateMandate(m).ok).toBe(false)
  })
})

describe('v0.1.4 HALTED 勘误', () => {
  it('HALTED 允许撤单与仅减仓平仓单，不允许增加敞口；REDUCING 同；ACTIVE 全允许', () => {
    expect([...TRADING_STATES]).toEqual(['ACTIVE', 'REDUCING', 'HALTED'])
    expect(TRADING_STATE_ALLOWS.HALTED).toEqual({ query: true, cancel: true, reduceOnly: true, openOrIncrease: false })
    expect(TRADING_STATE_ALLOWS.REDUCING).toEqual({ query: true, cancel: true, reduceOnly: true, openOrIncrease: false })
    expect(TRADING_STATE_ALLOWS.ACTIVE.openOrIncrease).toBe(true)
  })
})

describe('构建脚本', () => {
  it('ESM 产物带 createRequire banner（ws 等 CJS 依赖的 require 才可用）', () => {
    const text = readFileSync(join(PKG_ROOT, '..', '..', 'scripts', 'build.mjs'), 'utf8')
    expect(text).toContain('createRequire')
    expect(text).toContain('banner')
  })
})
