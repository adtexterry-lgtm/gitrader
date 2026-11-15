// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复第二批 B2（ux-fix2）真壳用例：
// · K5 Agent 卡住横幅：内核 status 带 agentTrouble 时出一条横幅（role=status），为空时不出；不弹模态、不弹 toast（A2 的字段合入前用夹具 mock）；
// · Agent 自身出错第 2 层：Agent 连续被拦合成一行、不标红、挂「它会自己调整」；不弹 toast；
// · 人发起的动作失败：toast 两行 + 可复制详情（英文原文只在详情里），武装行下原文另起一行。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildShell, openShell, sleep, type Shell } from './helpers/t2-shell'

const home = process.env.GITRADER_HOME
const enabled = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!process.env.GITRADER_EDGE && existsSync(process.env.GITRADER_EDGE)
let dir = ''
let sh: Shell
type Rec = Record<string, unknown>

const TROUBLE = { key: 'Claude Code', count: 4, lastError: 'order.place 参数不对', at: Date.now() }
let trouble: typeof TROUBLE | null = null
function mockStatus() {
  const sc = sh.stage.sc as unknown as { accounts: Rec[] }
  sh.kernel.onQuery('status', () => ({ accounts: sc.accounts.map((a) => ({ ...a, status: 'active' })), connectors: [{ id: 'venue_fixture', status: { wsState: 'connected', lastMessageTs: Date.now() } }], agentTrouble: trouble }))
}

describe.skipIf(!enabled)('ux-fix2 B2 报错呈现（真壳）', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(home!, 'uxfix2-b2-'))
    sh = await openShell({ workDir: dir, staticDir: buildShell(join(dir, 'static')) })
  }, 120000)
  afterAll(async () => {
    await sh?.close()
    if (dir && resolve(dir).startsWith(resolve(home!) + sep)) rmSync(dir, { recursive: true, force: true })
  })

  it('K5：agentTrouble 为空不显示；不为空出横幅（role=status），不弹模态、不弹 toast；清空后横幅消失', async () => {
    sh.applyPage('overview')
    trouble = null
    mockStatus()
    await sh.open('#/overview')
    await sh.settled()
    await sleep(2500)
    expect(await sh.ev<number>(`document.querySelectorAll('[data-act="agent-trouble"]').length`)).toBe(0)
    trouble = TROUBLE
    await sh.waitFor(`!!document.querySelector('[data-act="agent-trouble"]')`, 6000)
    const banner = await sh.ev<Rec>(`(() => { const b = document.querySelector('[data-act="agent-trouble"]'); return { text: b.textContent, role: b.getAttribute('role'), h: b.getBoundingClientRect().height } })()`)
    expect(banner.text).toBe('Claude Code 连续 4 次调用没成功：order.place 参数不对。可以在它的会话里让它重新读 gitrader 技能，或叫它先停下。')
    expect(banner.role).toBe('status')
    expect(banner.h).toBeLessThanOrEqual(32)
    // 模态 = aria-modal（总览的待批浮层是非模态的 role=dialog 弹出卡，不算）
    expect(await sh.ev<string[]>(`[...document.querySelectorAll('[aria-modal="true"], [role=alertdialog], .gr-toast')].map((e) => e.className)`)).toEqual([])
    trouble = null
    await sh.waitFor(`!document.querySelector('[data-act="agent-trouble"]')`, 6000)
  })

  it('第 2 层：Agent 自己连续被拦合成一行，不标红，挂一句它会自己调整；不弹 toast', async () => {
    sh.applyPage('overview')
    const sc = sh.stage.sc as unknown as { ledger: Rec[] }
    const seed = sc.ledger.find((e) => (e.origin as Rec | undefined)?.actorType === 'llm-agent') ?? sc.ledger[0]!
    const hit = { ruleId: 'mdt#maxOrderNotional', code: 'ORDER_NOTIONAL', limit: '200', actual: '499.9', unit: 'USDC', action: 'deny', scope: 'mandate' }
    const origin = { ...(seed.origin as Rec), actor: 'agent:ak_b2', actorType: 'llm-agent' }
    for (const seq of [9101, 9102, 9103]) sc.ledger.unshift({ ...seed, id: `b2-miss-${seq}`, seq, ts: Date.now() - (9200 - seq) * 1000, type: 'risk.denied', origin: { ...origin, requestId: `b2-${seq}` }, payload: {}, ruleHits: [hit] })
    await sh.open('#/overview')
    await sh.settled()
    await sh.waitFor(`!!document.querySelector('[data-view="feed"] [data-agent-miss]')`, 6000)
    const rows = await sh.ev<Rec[]>(`[...document.querySelectorAll('[data-view="feed"] [data-agent-miss]')].map((r) => ({ seq: r.getAttribute('data-seq'), note: r.querySelector('[data-agent-note]')?.textContent, red: !!r.querySelector('.g5-danger'), l1: r.querySelector('.g5-l1').textContent }))`)
    const mine = rows.filter((r) => ['9101', '9102', '9103'].includes(String(r.seq)))
    expect(mine).toEqual([{ seq: '9103', note: 'Agent 自己的调用，连续 3 次没通过；它会按原因自己调整，不用你处理', red: false, l1: '订单被拦截' }])
    expect(await sh.ev<number>(`document.querySelectorAll('.gr-toast').length`)).toBe(0)
  })

  it('人发起的动作失败：toast 两行 + 详情里才有英文原文；武装行下原文另起一行', async () => {
    sh.applyPage('overview')
    const RAW = 'takeover gateway timed out after 15000 ms'
    sh.kernel.onCommand('takeover.halt_new', () => { throw Object.assign(new Error(RAW), { code: -32000, data: { code: -32000, name: 'ENGINE_GATEWAY', message: RAW, category: 'VENUE', retryable: true } }) })
    await sh.open('#/overview')
    await sh.settled()
    await sh.click('[data-view="risk"] [data-act="takeover-halt_new"]')
    await sleep(800)
    await sh.click('[data-view="risk"] [data-act="arm-confirm"]')
    await sh.waitFor(`!!document.querySelector('.gr-toast[data-kind="err"]')`, 6000)
    const t = await sh.ev<Rec>(`(() => { const e = document.querySelector('.gr-toast[data-kind="err"]'), d = e.querySelector('[data-err-detail]'); return {
      role: e.getAttribute('role'), what: e.querySelector('.gr-toast__x').textContent, next: e.querySelector('.gr-toast__n')?.textContent,
      detail: d?.querySelector('.gr-errd__v')?.textContent, open: d?.open, raw: e.innerText.includes(${JSON.stringify(RAW)}),
      dot: !!e.querySelector('.gr-dot--err'), copy: !!d?.querySelector('[data-act="err-copy"]') } })()`)
    // 详情默认折叠：原文在 DOM 里，但不在可见文本里
    expect(t).toEqual({ role: 'alert', what: '这一步没有完成', next: '先看一眼最新状态，再决定要不要重试', detail: RAW, open: false, raw: false, dot: true, copy: true })
    // 风险卡武装行下的就地报错：正文是人话、英文原文在折叠的详情里；点开后可见
    const inl = await sh.ev<Rec>(`(() => { const e = document.querySelector('[data-view="risk"] .g5o-err'); return { raw: e.innerText.includes(${JSON.stringify(RAW)}), main: e.querySelector('.gr-errt')?.textContent, detail: e.querySelector('[data-err-detail] .gr-errd__v')?.textContent } })()`)
    expect(inl).toEqual({ raw: false, main: '这一步没有完成；先看一眼最新状态，再决定要不要重试', detail: RAW })
    await sh.click('[data-view="risk"] .g5o-err [data-err-detail] summary')
    expect(await sh.ev<boolean>(`document.querySelector('[data-view="risk"] .g5o-err').innerText.includes(${JSON.stringify(RAW)})`)).toBe(true)
    const geo = await sh.ev<Rec>(`(() => { const a = document.querySelector('[data-view="risk"] .g5-armed').getBoundingClientRect(), e = document.querySelector('[data-view="risk"] .g5o-err').getBoundingClientRect(); return { below: e.top >= a.bottom - 1 } })()`)
    expect(geo.below).toBe(true)
  })
})
