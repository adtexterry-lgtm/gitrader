// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
// @ts-expect-error The JSX shell component is outside the package TypeScript compilation boundary.
import { pinTitle } from '../src/shell/PinDialog.jsx'

describe('r5 PIN action titles', () => {
  it.each([
    ['paper.reset', '重置纸面账户'], ['engine.bind', '绑定策略'], ['lab.stage', '晋级实验'],
    ['config.venues.set', '修改交易所配置'], ['plugin.grant', '授予插件权限'], ['order.place', '下单'],
    ['engine.call', '调整策略'], ['strategy.update', '更新策略'],
  ])('maps %s to its user-facing action', async (action, title) => {
    await expect(pinTitle({}, { action, params: {} })).resolves.toBe(title)
  })

  it('keeps the special stop order title', async () => {
    await expect(pinTitle({}, { action: 'order.place', params: { intent: { reduceOnly: true, type: 'stop_market' } } })).resolves.toBe('挂止损')
  })
})
