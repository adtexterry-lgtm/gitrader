// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  PROBLEM_CODES,
  PROBLEM_TEXT,
  RULE_CODES,
  RULE_TEXT,
  humanizeProblem,
  humanizeRuleHit,
} from '@gitrader/protocol'

/** ui / cli 面不得出现的英文错误片段。 */
const RAW_FRAGMENTS = ['violations', 'presence proof', 'invalid', 'required', 'cooldown:', 'stale_price limit', 'expected=', 'actual=']

function expectClean(text: string, where: string): void {
  for (const fragment of RAW_FRAGMENTS) {
    expect(text.toLowerCase().includes(fragment), `${where} contains "${fragment}": ${text}`).toBe(false)
  }
}

describe('problem text', () => {
  it('every ProblemName has an entry or explicit passthrough', () => {
    for (const name of Object.keys(PROBLEM_CODES)) {
      expect(PROBLEM_TEXT[name], name).toBeDefined()
      expect(humanizeProblem({ name }).zh.length, name).toBeGreaterThan(0)
    }
    expect(PROBLEM_TEXT['STATE_FILE_CORRUPT']?.zh).toContain('安全文件')
    expect(humanizeProblem({ name: 'NOT_A_REAL_CODE' }).zh).toBe('出错了（NOT_A_REAL_CODE）')
  })

  it('every RuleCode has a rule text', () => {
    for (const code of RULE_CODES) {
      const fn = RULE_TEXT[code]
      expect(typeof fn, code).toBe('function')
      expect(fn?.({ limit: '1', actual: '2', unit: 'x' }).length, code).toBeGreaterThan(0)
    }
    expect(humanizeRuleHit({ code: 'NOT_A_REAL_CODE' })).toContain('规则未通过')
  })

  it('zh text never contains raw english error fragments', () => {
    for (const [key, entry] of Object.entries(PROBLEM_TEXT)) {
      expectClean(entry.zh, `${key} zh`)
      if (entry.next) expectClean(entry.next, `${key} next`)
    }
    for (const code of RULE_CODES) {
      const fn = RULE_TEXT[code]
      expectClean(fn?.({ limit: '10', actual: '20', unit: 'ms' }) ?? '', code)
      expectClean(fn?.({ limit: '0', actual: '1', unit: 'violations' }) ?? '', `${code} violations`)
    }
    for (const name of Object.keys(PROBLEM_CODES)) {
      for (const surface of ['ui', 'cli'] as const) {
        const text = humanizeProblem({ name }, { surface })
        expectClean(text.zh, `${name} ${surface} zh`)
        if (text.next) expectClean(text.next, `${name} ${surface} next`)
      }
    }
  })

  describe('30 checklist items', () => {
    it('#1 presence proof 提示要 PIN', () => {
      const text = humanizeProblem({ name: 'AUTH_FAILED', message: 'a presence proof (PIN) is required for this action' })
      expect(text.zh).toContain('PIN 确认')
    })

    it('#2 invalid PIN 说 PIN 不对', () => {
      const text = humanizeProblem({ name: 'AUTH_FAILED', message: 'invalid PIN' })
      expect(text.zh).toContain('PIN 不对')
    })

    it('#3 PIN 格式说明用中文', () => {
      const text = humanizeProblem({ name: 'INVALID_PARAMS', message: 'PIN must be 6-12 digits, or a passphrase of 8-64 characters' })
      expect(text.zh).toContain('PIN 要')
      expect(text.zh).toContain('口令')
    })

    it.todo('#4 UI 文案，由应用半处理')

    it('#5 白名单命中不再显示 violations', () => {
      const text = humanizeRuleHit({ code: 'INSTRUMENT_NOT_ALLOWED', limit: '0', actual: '1', unit: 'violations' })
      expect(text).toContain('白名单')
      expect(text).not.toContain('violations')
    })

    it('#6 冷却剩余秒数', () => {
      expect(humanizeRuleHit({ code: 'COOLDOWN', limit: '5', actual: '4', unit: 's' })).toContain('还需 1 秒')
      expect(humanizeRuleHit({ code: 'COOLDOWN', limit: '5', actual: '9', unit: 's' })).toContain('还需 0 秒')
    })

    it('#6b 重复意图窗口不再说冷却还需 N 秒（fix-r4 C13）', () => {
      const text = humanizeRuleHit({ code: 'COOLDOWN', ruleId: 'pol_x#duplicateIntent', limit: '10', actual: '0', unit: 's' })
      expect(text).toBe('刚提交过一笔相同的单，10 秒内不重复提交')
      expect(text).not.toContain('冷却')
      expect(humanizeRuleHit({ code: 'COOLDOWN', ruleId: 'pol_x#cooldown', limit: '5', actual: '4', unit: 's' })).toContain('还需 1 秒')
    })

    it('#7 行情过期按秒换算', () => {
      const text = humanizeRuleHit({ code: 'STALE_PRICE', limit: '5000', actual: '206525', unit: 'ms' })
      expect(text).toContain('行情已')
      expect(text).toContain('206.5')
      expect(text).toContain('5.0')
    })

    it('#8 标的不在白名单用中文', () => {
      const text = humanizeRuleHit({ code: 'INSTRUMENT_NOT_ALLOWED', limit: '10', actual: '20', unit: 'x' })
      expect(text).toContain('白名单')
      expect(text).not.toContain('expected=')
      expect(text).not.toContain('actual=')
    })

    it('#9 需确认档缺项要说明补什么', () => {
      expect(humanizeRuleHit({ code: 'MANDATE_INCOMPLETE' })).toContain('补')
    })

    it('#10 对账未处理完不能恢复', () => {
      const text = humanizeProblem({ name: 'TRADING_STATE', message: 'review pending reconciliation items before resuming' })
      expect(text.zh).toContain('对账')
    })

    it('#11 安全文件损坏给 doctor 与 pin reset', () => {
      const text = humanizeProblem({ name: 'STATE_FILE_CORRUPT', message: 'security state file is corrupt; restore the original file and restart' })
      expect(text.zh).toContain('安全文件')
      expect(text.next).toContain('gitrader doctor')
      expect(text.next).toContain('gitrader pin reset')
    })

    it('#12 本地会话失效说登录过期', () => {
      const text = humanizeProblem({ name: 'AUTH_FAILED', message: 'No valid local session. Run gitrader session login' })
      expect(text.zh).toContain('登录')
      expect(text.next).toContain('serve')
    })

    it.todo('#13 UI 文案，由应用半处理')

    it('#14 导出路径错误提示 --out 写法', () => {
      const text = humanizeProblem({ name: 'INVALID_PARAMS', message: 'invalid workspace path' })
      expect(text.next).toContain('--out')
    })

    it('#15 令牌无效或撤销', () => {
      const text = humanizeProblem({ name: 'AUTH_FAILED', message: 'authentication required: Authorization: Bearer <token>' })
      expect(text.zh).toContain('撤销')
    })

    it.todo('#16 UI 文案，由应用半处理')
    it.todo('#17 UI 文案，由应用半处理')
    it.todo('#18 UI 文案，由应用半处理')
    it.todo('#19 UI 文案，由应用半处理')
    it.todo('#20 UI 文案，由应用半处理')
    it.todo('#21 UI 文案，由应用半处理')

    it('#22 MCP 检查失败同令牌失效', () => {
      const text = humanizeProblem({ name: 'AUTH_FAILED', message: 'FAILED: authentication required: Authorization: Bearer <token>' })
      expect(text.zh).toContain('撤销')
    })

    it('#23 没有行情源', () => {
      const text = humanizeProblem({ name: 'INSTRUMENT_UNKNOWN', message: 'no connector registered' })
      expect(text.zh).toContain('行情源')
    })

    it('#24 止损精度错误说精度', () => {
      const text = humanizeProblem({ name: 'PRECISION', message: 'stop loss price precision must be 5 significant digits' })
      expect(text.zh).toContain('精度')
    })

    it('#25 Agent 超时保留原文', () => {
      const message = 'the kernel did not answer within 30s'
      const text = humanizeProblem({ name: 'BUSY', message }, { surface: 'agent' })
      expect(text.zh).toContain('稍后')
      expect(text.next).toBe('原文：' + message)
    })

    it('#26 提案已拒绝不能再批', () => {
      const text = humanizeProblem({ name: 'PROPOSAL_EXPIRED', message: 'proposal prp_1 is rejected, not pending' })
      expect(text.zh).toContain('不能再批')
    })

    it('#27 钥匙被撤销', () => {
      const text = humanizeProblem({ name: 'MANDATE_EXPIRED', message: 'MANDATE_EXPIRED' })
      expect(text.zh).toContain('撤销')
    })

    it.todo('#28 UI 文案，由应用半处理')
    it.todo('#29 UI 文案，由应用半处理')

    it('#30 bp / ratio 单位写成人话', () => {
      expect(humanizeRuleHit({ code: 'SLIPPAGE', limit: '50', actual: '80', unit: 'bp' })).toContain('基点')
      expect(humanizeRuleHit({ code: 'DAILY_LOSS', limit: '0.1', actual: '0.2', unit: 'ratio' })).toContain('占权益比')
    })
  })

  describe('fix-r2 S3 texts', () => {
    it('STATE_FILE_CORRUPT splits by message: paper state / ledger database / security files', () => {
      const paper = humanizeProblem({ name: 'STATE_FILE_CORRUPT', message: 'paper state does not match the ledger' })
      expect(paper.zh).toContain('纸面状态文件和账本对不上')
      expect(paper.next).toContain('paper-state.json.prev')
      expect(paper.next).toContain('gitrader paper rebuild-from-ledger')
      const ledger = humanizeProblem({ name: 'STATE_FILE_CORRUPT', message: 'ledger database is missing' })
      expect(ledger.zh).toContain('账本数据库不见了或打不开')
      expect(ledger.next).toContain('data/gitrader.sqlite')
      const security = humanizeProblem({ name: 'STATE_FILE_CORRUPT', message: 'security state file is corrupt' })
      expect(security.zh).toContain('PIN 或钥匙文件')
    })

    it('INVALID_PARAMS invalid workspace path says relative path under exports', () => {
      const text = humanizeProblem({ name: 'INVALID_PARAMS', message: 'invalid workspace path' })
      expect(text.zh).toContain('exports')
      expect(text.zh).toContain('相对路径')
      expect(text.next).toContain('--out <名字>')
    })

    it('RATE_BUDGET splits operation rate limit / venue weight / order rate', () => {
      const op = humanizeProblem({ name: 'RATE_BUDGET', message: 'operation rate limit exceeded' })
      expect(op.zh).toContain('这把钥匙被限流')
      expect(op.next).toContain('批量调用请放慢')
      expect(humanizeProblem({ name: 'RATE_BUDGET', message: 'operation rate limit exceeded', retryAfterMs: 2500 }).next).toContain('约 3 秒后再试')
      expect(humanizeProblem({ name: 'RATE_BUDGET', message: 'venue weight budget exhausted' }).zh).toContain('场所权重预算')
      expect(humanizeProblem({ name: 'RATE_BUDGET', message: 'weight/min exceeded' }).next).toContain('一分钟')
      expect(humanizeProblem({ name: 'RATE_BUDGET', message: 'orders too fast' }).zh).toContain('下单太频繁')
    })

    it('humanizeRuleHit RATE_BUDGET weight/min says venue request weight', () => {
      const text = humanizeRuleHit({ code: 'RATE_BUDGET', limit: '1200', actual: '1500', unit: 'weight/min' })
      expect(text).toContain('场所请求权重超限')
      expect(text).toContain('1500')
      expect(text).not.toContain('weight/min')
    })

    it('VENUE_REJECTED interrupted / order unknown', () => {
      const cut = humanizeProblem({ name: 'VENUE_REJECTED', message: 'INTERRUPTED_BEFORE_VENUE: kernel stopped' })
      expect(cut.zh).toContain('从没下出去')
      expect(cut.next).toContain('重新下单')
      const unknown = humanizeProblem({ name: 'VENUE_REJECTED', message: 'kernel-sim: order unknown' })
      expect(unknown.zh).toContain('纸面场所不认识这张单')
      expect(humanizeProblem({ name: 'VENUE_REJECTED', message: 'something else' }).zh).toBe('交易场所拒了这笔单')
    })

    it('VENUE_OUTCOME_UNKNOWN says maybe filled, query by clientOrderId, do not resend', () => {
      const text = humanizeProblem({ name: 'VENUE_OUTCOME_UNKNOWN' })
      expect(text.zh).toContain('可能已成交')
      expect(text.next).toContain('clientOrderId')
      expect(text.next).toContain('不要直接重发')
    })

    it('agent surface still returns the original message in next', () => {
      const message = 'operation rate limit exceeded'
      expect(humanizeProblem({ name: 'RATE_BUDGET', message, retryAfterMs: 2500 }, { surface: 'agent' }).next).toBe('原文：' + message)
    })
  })

  it('agent surface keeps original message in next', () => {
    const message = 'invalid PIN'
    const ui = humanizeProblem({ name: 'AUTH_FAILED', message })
    const agent = humanizeProblem({ name: 'AUTH_FAILED', message }, { surface: 'agent' })
    expect(agent.zh).toBe(ui.zh)
    expect(agent.next).toBe('原文：' + message)
    expect(ui.next).not.toContain('原文：')
  })

  it('VENUE_UNAVAILABLE not_ready says the instrument list is still loading', () => {
    const text = humanizeProblem({
      name: 'VENUE_UNAVAILABLE',
      message: 'market data not ready: the hyperliquid instrument list is still loading; retry in 3 s',
      retryAfterMs: 3000,
    })
    expect(text.zh).toContain('行情尚未就绪')
    expect(text.zh).toContain('3 秒')
    expect(humanizeProblem({ name: 'VENUE_UNAVAILABLE', message: 'venue down' }).zh).toBe('交易场所暂时连不上')
  })
})

describe('fix-r4 · MANDATE_LEVEL 不再写死实盘', () => {
  it('只读档（this key is L0）说只读；实盘档位不够才说实盘；其余中性', () => {
    expect(humanizeProblem({ name: 'MANDATE_LEVEL', message: 'propose needs level L1 or higher (this key is L0)' }).zh).toBe('这把钥匙是只读档，不能下单或提案')
    expect(humanizeProblem({ name: 'MANDATE_LEVEL', message: 'live proposals need level L2 or higher (this key is L1)' }).zh).toBe('这把钥匙的档位不允许实盘下单')
    expect(humanizeProblem({ name: 'MANDATE_LEVEL', message: 'direct live order actions need L3+' }).zh).toBe('这把钥匙的档位不允许实盘下单')
    const neutral = humanizeProblem({ name: 'MANDATE_LEVEL', message: 'order.place needs level L3 or higher (this key is L2)' }).zh
    expect(neutral).not.toContain('实盘')
  })
})
