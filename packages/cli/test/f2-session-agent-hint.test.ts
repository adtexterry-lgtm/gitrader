// SPDX-License-Identifier: CPAL-1.0
// F2：人用命令缺本机会话时，中英两半都点出 Agent 该走的路（gitrader agent …，Agent 令牌）；只是文案，鉴权不变。
import { describe, expect, it } from 'vitest'
import { SessionRequiredError } from '../src/session'

describe('F2 缺会话报错带 Agent 路径', () => {
  for (const reason of ['missing', 'invalid', 'expired', 'service-restarted', 'service-unavailable'] as const) {
    it(`${reason}：原句不变 + 中英两半各一句 gitrader agent`, () => {
      const m = new SessionRequiredError(reason).message
      expect(m).toContain('gitrader session login')
      expect(m).toContain('No valid local session. Run `gitrader session login` to sign in again.')
      expect(m).toMatch(/Agent 请改用：gitrader agent <工具>/)
      expect(m).toMatch(/Agents: use `gitrader agent <tool>/)
      expect(m).not.toMatch(/token-file|session link/)
    })
  }
})
