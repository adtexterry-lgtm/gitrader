// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复第二批 B2（ux-fix2）：报错呈现（失败 toast 两行 + 详情、内联错误色、横幅）、K5 Agent 卡住横幅、UX-37 英文词条。
// 纯函数 / 源码层断言；真窗口另有 blocks-r5/test/ux-fix2-b2.browser.test.ts 与改前改后截图。
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { agentTroubleOf, agentTroubleText } from '../src/core/agent-trouble'
import { setLang, t } from '../src/ui/lib/i18n.js'
import { toastParts } from '../src/ui/lib/toast-parts.js'

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const CJK = /[㐀-鿿]/
afterEach(() => setLang('zh'))

describe('失败 toast：出了什么事 + 下一步，英文原文进「详情」', () => {
  it('中文界面整句英文：正文换成中文两行，原文进详情', () => {
    expect(toastParts('err', 'takeover gateway timed out after 15000 ms', 'zh')).toEqual({
      what: '这一步没有完成', next: '先看一眼最新状态，再决定要不要重试', detail: 'takeover gateway timed out after 15000 ms',
      body: '这一步没有完成；先看一眼最新状态，再决定要不要重试', generic: true,
    })
  })
  it('中文说明（英文原文）；下一步：括号里的英文进详情，按最后一个「；」拆两行', () => {
    expect(toastParts('err', '操作失败（engine socket closed unexpectedly）；先查看最新状态，确认结果后再重试', 'zh')).toEqual({
      what: '操作失败', next: '先查看最新状态，确认结果后再重试', detail: 'engine socket closed unexpectedly',
      body: '操作失败；先查看最新状态，确认结果后再重试',
    })
    expect(toastParts('err', '引擎内部出错，这次操作没有完成；先查看最新状态，确认结果后再重试', 'zh')).toEqual({
      what: '引擎内部出错，这次操作没有完成', next: '先查看最新状态，确认结果后再重试', detail: '',
      body: '引擎内部出错，这次操作没有完成；先查看最新状态，确认结果后再重试',
    })
  })
  it('中文句子里的英文片段（不在括号里）与成功 / 信息 toast 照原样', () => {
    expect(toastParts('err', '新止损已挂上，旧止损没有撤销：order not found for this account', 'zh').what).toBe('新止损已挂上，旧止损没有撤销：order not found for this account')
    expect(toastParts('ok', 'Layout saved; reloaded', 'en')).toEqual({ what: 'Layout saved; reloaded', next: '', detail: '', body: 'Layout saved; reloaded' })
  })
  it('英文界面：原文可读，照原样（只按「; 」拆下一步），不出现中文', () => {
    expect(toastParts('err', 'takeover gateway timed out after 15000 ms', 'en')).toEqual({ what: 'takeover gateway timed out after 15000 ms', next: '', detail: '', body: 'takeover gateway timed out after 15000 ms' })
    setLang('en')
    const p = toastParts('err', t('先看一眼最新状态，再决定要不要重试'))
    expect(CJK.test(p.what + p.next)).toBe(false)
  })
  it('组件：失败带 6px 状态点与折叠的可复制详情；带行动按钮的失败常驻（不自动消失）', () => {
    const ov = src('../src/ui/components/overlay.jsx')
    expect(ov).toMatch(/gr-dot gr-dot--err gr-toast__dot/)
    expect(ov).toMatch(/<ErrDetail detail=\{p\.detail\} \/>/)
    expect(ov).toMatch(/remain: action \? \(kind === 'err' \? Infinity/)
    expect(ov).toMatch(/t\.remain === Infinity\) return/)
    const et = src('../src/ui/components/ErrText.jsx')
    expect(et).toMatch(/<details className="gr-errd" data-err-detail=""/) // 原生折叠，默认收起（没有 open）
    expect(et).toMatch(/data-act="err-copy"/)
    expect(src('../src/ui/components/core.jsx')).toMatch(/<span className="gr-iconfirm__err" role="alert"><ErrText text=\{shownErr\} \/><\/span>/)
  })
  it('行内报错 ErrText：中文界面英文原文不进正文；bare（已有「读取失败」标签）时不补通用人话', () => {
    const p = toastParts('err', 'Order 77 does not exist or was already filled', 'zh')
    expect([p.generic, p.body, p.detail]).toEqual([true, '这一步没有完成；先看一眼最新状态，再决定要不要重试', 'Order 77 does not exist or was already filled'])
    expect(toastParts('err', '单笔上限 8,000，实际 8,424', 'zh')).toMatchObject({ body: '单笔上限 8,000，实际 8,424', detail: '' })
    expect(src('../src/ui/components/ErrText.jsx')).toMatch(/const main = p\.generic && bare \? '' : p\.body/)
  })
})

describe('内联错误与横幅', () => {
  it('内联错误用固定的失败色 --gr-st-err（--gr-down 在「红涨绿跌」下会变绿）', () => {
    const shell = src('../src/shell/shell.css')
    const comp = src('../src/ui/components/components.css')
    for (const [css, cls] of [[shell, 'gr-set__err'], [shell, 'gr-pin__err'], [comp, 'gr-field__err'], [comp, 'gr-iconfirm__err']] as const) {
      const rule = css.match(new RegExp(`\\.${cls} \\{[^}]*\\}`))?.[0] ?? ''
      expect(rule, cls).toMatch(/color: var\(--gr-st-err\)/)
    }
  })
  it('横幅不铺色底：中性表面 + 行首状态点，几何不变（28–32 高）', () => {
    const shell = src('../src/shell/shell.css')
    const pin = shell.match(/a\.g5-pinhint \{[^}]*\}/)?.[0] ?? ''
    expect(pin).toMatch(/background: transparent/)
    expect(pin).toMatch(/max-height: 32px; min-height: 28px/)
    expect(shell).not.toMatch(/g5-downhint[^{]*\{[^}]*--gr-down-a10/)
    const jsx = src('../src/shell/Shell.jsx')
    expect(jsx).toMatch(/data-act="pin-hint"><span className="gr-dot gr-dot--warn"/)
    expect(jsx).toMatch(/data-act="service-down"><span className="gr-dot gr-dot--err"/)
  })
})

describe('K5 Agent 卡住（agentTrouble ?? null）', () => {
  const trouble = { key: 'Claude Code', count: 4, lastError: 'order.place 参数不对', at: 1_700_000_000_000 }
  it('为空 / 老内核没有这个字段 / 形状不对：什么都不显示', () => {
    expect(agentTroubleOf({ agentTrouble: null })).toBeNull()
    expect(agentTroubleOf({})).toBeNull()
    expect(agentTroubleOf(undefined)).toBeNull()
    expect(agentTroubleOf({ agentTrouble: { key: '', count: 3 } })).toBeNull()
    expect(agentTroubleOf({ agentTrouble: { key: 'x', count: 0, lastError: 'a', at: 1 } })).toBeNull()
  })
  it('不为空：契约字段照收，文案照规定句式', () => {
    const x = agentTroubleOf({ accounts: [], agentTrouble: trouble })!
    expect(x).toEqual(trouble)
    expect(agentTroubleText(x)).toBe('Claude Code 连续 4 次调用没成功：order.place 参数不对。可以在它的会话里让它重新读 gitrader 技能，或叫它先停下。')
  })
  it('英文界面：原因换成英文，没有中文残留', () => {
    setLang('en')
    const s = agentTroubleText(trouble)
    expect(s).toBe('Claude Code failed 4 calls in a row: order.place invalid parameters. In its session, ask it to re-read the gitrader skill, or tell it to stop for now.')
    expect(CJK.test(s)).toBe(false)
  })
  it('壳：读 status 轮询里的 agentTrouble，横幅层级（role=status），不弹模态、不弹 toast', () => {
    const jsx = src('../src/shell/Shell.jsx')
    expect(jsx).toMatch(/agentTroubleOf\(status\)/)
    expect(jsx).toMatch(/<div className="g5-agenthint" role="status" data-act="agent-trouble"/)
    const block = jsx.slice(jsx.indexOf('agentTroubleOf(status)'), jsx.indexOf('agentTroubleOf(status)') + 400)
    expect(block).not.toMatch(/toast\.|Dialog/)
  })
})

describe('UX-37 英文词条', () => {
  it('行情中断的「mm:ss 前」是 ago 不是 by', () => {
    setLang('en')
    expect(t('{0}:{1} 前', '00', '05')).toBe('00:05 ago')
  })
})
