// SPDX-License-Identifier: CPAL-1.0
// E0-10（应用半）：工作台这一侧的人话报错——runCommand 把内核 Problem 查成中文并把原文留在 upstream，
// ruleText 不把内部字面量（violations / expected= / actual=）写到界面上；PIN 弹层的标题覆盖 Agent 钥匙动作。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KernelError } from '@gitrader/blocks-sdk'
import type { BlockBridge } from '@gitrader/blocks-sdk'
import { runCommand } from '../src/actions'
import { ruleText } from '../src/model-activity'

const bridgeThrowing = (e: unknown): BlockBridge => ({ command: async () => { throw e } }) as unknown as BlockBridge

type Fail = { ok: false; cancelled: boolean; message: string; problem?: string; upstream?: string }

const ruleHit = (code: string, unit: string, limit = '10', actual = '20'): Parameters<typeof ruleText>[0] =>
  ({ ruleId: `r#${code}`, code: code as never, limit: limit as never, actual: actual as never, unit, action: 'deny', scope: 'org' })

describe('E0-10：工作台的中文报错', () => {
  it('runCommand maps kernel errors to chinese and keeps upstream', async () => {
    const problem = { code: 5003, name: 'AUTH_FAILED', category: 'AUTH', message: 'invalid PIN', retryable: false }
    const r = await runCommand(bridgeThrowing(new KernelError(5003, 'invalid PIN', problem)), 'trading_state.resume', {})
    expect(r.ok).toBe(false)
    const fail = r as Fail
    expect(fail.cancelled).toBe(false)
    expect(fail.problem).toBe('AUTH_FAILED')
    // 界面只看到中文；原文留在 upstream 给「详情」展开
    expect(fail.message).toBe('PIN 不对，请再输一次')
    expect(fail.message).not.toContain('invalid')
    expect(fail.upstream).toBe('invalid PIN')
  })

  it('ruleText never shows violations', () => {
    for (const h of [
      ruleHit('INSTRUMENT_NOT_ALLOWED', 'violations'),
      ruleHit('SIZE_PRECISION', 'violations'),
      ruleHit('STALE_PRICE', 'ms', '10000', '12000'),
      ruleHit('COOLDOWN', 'ms', '60000', '30000'),
    ]) {
      const text = ruleText(h)
      expect(text).toMatch(/[一-龥]/)
      expect(text).not.toContain('violations')
      expect(text).not.toContain('expected=')
      expect(text).not.toContain('actual=')
    }
  })

  it('pin titles cover agent key actions', () => {
    const src = readFileSync(fileURLToPath(new URL('../../workbench/src/shell/PinDialog.jsx', import.meta.url)), 'utf8')
    for (const action of ['agentkey.create', 'mandate.update', 'agentkey.request.approve']) expect(src).toContain(`'${action}'`)
    for (const title of ['创建 Agent 钥匙', '修改 Agent 授权', '批准 Agent 接入']) expect(src).toContain(title)
  })
})
