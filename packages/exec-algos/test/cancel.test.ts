// SPDX-License-Identifier: CPAL-1.0
// 撤单二次确认：三种结果与优先级。
import { describe, expect, it } from 'vitest'
import { cancelOutcome } from '../src'

describe('cancelOutcome', () => {
  it('撤单确认 + 快照 cancelled + 无新成交 → confirmed', () => {
    expect(cancelOutcome({ ackOk: true, status: 'cancelled', fillsSinceCancel: '0' })).toBe('confirmed')
  })

  it('美式拼写 canceled 同样算终态 → confirmed', () => {
    expect(cancelOutcome({ ackOk: true, status: 'Canceled', fillsSinceCancel: '0' })).toBe('confirmed')
  })

  it('撤单回执只是 open（未终态）→ pending', () => {
    expect(cancelOutcome({ ackOk: true, status: 'open', fillsSinceCancel: '0' })).toBe('pending')
  })

  it('状态缺失 → pending（回执不是快照）', () => {
    expect(cancelOutcome({ ackOk: true, fillsSinceCancel: '0' })).toBe('pending')
  })

  it('撤单请求没确认（ackOk false）但快照已 cancelled → confirmed：结果以快照为准', () => {
    expect(cancelOutcome({ ackOk: false, status: 'cancelled', fillsSinceCancel: '0' })).toBe('confirmed')
  })

  it('撤销期间有成交 → filled_meanwhile（状态报 cancelled 也不算撤干净）', () => {
    expect(cancelOutcome({ ackOk: true, status: 'cancelled', fillsSinceCancel: '0.001' })).toBe('filled_meanwhile')
  })

  it('成交优先于 ack：ackOk false 但有成交 → filled_meanwhile', () => {
    expect(cancelOutcome({ ackOk: false, status: 'open', fillsSinceCancel: '0.4' })).toBe('filled_meanwhile')
  })

  it('负的成交量是非法输入', () => {
    expect(() => cancelOutcome({ ackOk: true, status: 'cancelled', fillsSinceCancel: '-0.1' })).toThrow(RangeError)
  })
})
