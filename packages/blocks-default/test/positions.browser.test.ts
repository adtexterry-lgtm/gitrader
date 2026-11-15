// SPDX-License-Identifier: CPAL-1.0
// 持仓卡（视觉轮 r4，WORK-ORDERS §5.4）真渲染：真壳 + 夹具内核 + 无头 Edge。分组 / 列序 / 数字对照、1200 档收列、行内平仓（G2 就地确认、PIN、失败原文）、
// 止损（先挂新单再撤旧单、更新中、两种失败、清除、本地先挡）、展开区（三栏、一次一行、不套卡）、部分平仓、有待批跳转、空态、离线、新仓追加组末（G7）。
// 不弹可见窗口，只关自己起的浏览器与服务。找不到无头浏览器时整体失败（不静默跳过）；确实没有浏览器的机器设 GITRADER_SKIP_BROWSER=1 并在回报里写明没验。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACCT_LIVE, ACCT_PAPER, NOW, O_HUMAN } from '../fixtures/scenarios'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const STAGE = '../verify/stage.mjs'
const mod = (await import(/* @vite-ignore */ STAGE as string)) as Any
const haveBrowser = existsSync(mod.EDGE) && existsSync(mod.PW)
const skip = !haveBrowser && process.env.GITRADER_SKIP_BROWSER === '1'
const d = skip ? describe.skip : describe

let stage: Any
let browser: Any
const errors: string[] = []

interface OpenOpts { fault?: Record<string, unknown>; patch?: (st: Any) => void; net?: boolean }
const open = async (name: string, w = 1440, h = 900, o: OpenOpts = {}): Promise<{ page: Any; close(): Promise<void>; cut(): Promise<void> }> => {
  stage.stage.load(name)
  stage.stage.calls.length = 0
  if (o.fault) Object.assign(stage.stage.fault, o.fault)
  o.patch?.(stage.stage)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const net = { cut: false, socks: [] as Any[] }
  if (o.net) await ctx.routeWebSocket(/\/ui$/, (ws: Any) => { if (net.cut) { void ws.close(); return } net.socks.push(ws.connectToServer(), ws) })
  const page = await ctx.newPage()
  page.on('console', (m: Any) => { if (m.type() === 'error' && !(o.net && net.cut && /WebSocket/.test(m.text())) && !/ATTESTATION_REQUIRED|PIN/.test(m.text())) errors.push(`[${name} ${w}] ${m.text()}`) })
  page.on('pageerror', (e: Any) => errors.push(`[${name} ${w}] pageerror ${e.message}`))
  await page.goto(stage.url, { waitUntil: 'load' })
  await page.waitForFunction(() => (window as Any).__GR_READY__?.online === true, null, { timeout: 8000 })
  await page.waitForSelector('.gb-pos', { timeout: 8000 })
  await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, null, { timeout: 8000 })
  await page.waitForTimeout(400) // 卡入场 320 ms
  const cut = async () => { net.cut = true; for (const s of net.socks.splice(0)) { try { await s.close() } catch { /* 已关闭 */ } } }
  return { page, close: () => ctx.close(), cut }
}
const text = (page: Any, sel: string): Promise<string> => page.$eval(sel, (e: Element) => (e as HTMLElement).innerText).catch(() => '')
const calls = (action: string): Any[] => stage.stage.calls.filter((c: Any) => c.action === action)
const order = (): string[] => stage.stage.calls.map((c: Any) => c.action)
const R = (sym: string) => `.gb-pos [data-row$="|hyperliquid:${sym}|${sym === 'ETH' ? 'short' : 'long'}"]`
const state = (page: Any, sym: string): Promise<string | null> => page.$eval(R(sym), (e: Element) => e.getAttribute('data-state')).catch(() => 'gone')
const act = (page: Any): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-act') ?? document.activeElement?.getAttribute('aria-label') ?? null)
const arm = async (page: Any, sym: string) => { await page.click(`${R(sym)} [data-act="pos-close"]`); await page.waitForSelector(`${R(sym)} [data-act="pos-close-confirm"]`) }
const confirm = async (page: Any, sym: string) => { await page.waitForTimeout(700); await page.click(`${R(sym)} [data-act="pos-close-confirm"]`) }
const expand = async (page: Any, sym: string) => { await page.click(`${R(sym)} [data-act="pos-expand"]`); await page.waitForSelector('.gb-pos tr.gb-detail .gb-detail__grid') }
const STOP_OLD = 'ord_stop_old'
const withStop = (st: Any) => {
  st.sc.orders[ACCT_LIVE].push({ orderId: STOP_OLD, clientOrderId: 'stopold', accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'stop_market', tif: 'gtc', size: '0.08', filledSize: '0', triggerPrice: '59000', reduceOnly: true, status: 'untriggered', fee: '0', origin: O_HUMAN, createdAt: NOW - 60_000, updatedAt: NOW - 60_000 })
}
const UPSTREAM = 'keystore is locked: unlock it with your PIN (gitrader unlock)'

beforeAll(async () => {
  if (!haveBrowser) {
    if (skip) return
    throw new Error(`找不到无头浏览器（Edge: ${mod.EDGE}；playwright-core: ${mod.PW}）。用 GITRADER_EDGE / GITRADER_PLAYWRIGHT 指过去；确实没有就设 GITRADER_SKIP_BROWSER=1 并在回报里写明没验。`)
  }
  stage = await mod.startStage('pending')
  browser = await mod.launchBrowser()
})
afterAll(async () => {
  try { await browser?.close() } catch { /* 已关闭 */ }
  await stage?.close()
  expect(errors, '控制台错误').toEqual([])
})

d('持仓卡 r4 · 表', () => {
  it('1440 pending：两组四行，列序与 data-col 正确，方向字不着色；数字对照与行高', async () => {
    const { page, close } = await open('pending')
    expect(await page.$$eval('.gb-pos .gb-grp', (els: Element[]) => els.map((e) => e.getAttribute('data-acct')))).toEqual([ACCT_LIVE, ACCT_PAPER])
    const body = await page.$$eval('.gb-pos tbody tr', (els: Element[]) => els.map((e) => (e.classList.contains('gb-grp') ? 'G' : (e.getAttribute('data-row') ?? '').split('|')[1])))
    expect(body).toEqual(['G', 'hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:xyz:TSLA', 'G', 'hyperliquid:SOL'])
    expect(await page.$$eval('.gb-pos thead th', (els: Element[]) => els.map((e) => e.getAttribute('data-col')))).toEqual(['sym', 'size', 'entry', 'mark', 'upnl', 'liq', 'sl', 'opener', 'act'])
    expect(await page.$$eval(`${R('BTC')} td`, (els: Element[]) => els.map((e) => e.getAttribute('data-col')))).toEqual(['sym', 'size', 'entry', 'mark', 'upnl', 'liq', 'sl', 'opener', 'act'])
    // 方向字不着色：多与空同一个颜色
    const sideColor = (s: string) => page.$eval(`${R(s)} .gb-sym__d`, (e: Element) => getComputedStyle(e).color)
    expect(await sideColor('BTC')).toBe(await sideColor('ETH'))
    expect(await text(page, `${R('BTC')} [data-col="upnl"]`)).toMatch(/\+53\.58\s*\+4\.13%/)
    expect(await text(page, `${R('BTC')} [data-col="liq"]`)).toMatch(/52,110\.0\s*距 19\.7%/)
    expect(await text(page, `${R('SOL')} [data-col="liq"]`)).toMatch(/≈ 121\.40\s*距 17\.4%/)
    expect(await text(page, '.gb-grp >> nth=0')).toMatch(/测试网主账户\s*实盘 3[\s\S]*\+70\.86/)
    expect(await text(page, '.gb-grp >> nth=1')).toMatch(/纸面账户\s*纸面 1[\s\S]*−42\.00/)
    expect(await page.$eval('.gb-grp >> nth=0 >> td[data-col="upnl"]', (e: Element) => e.className)).toContain('gr-up')
    expect(await page.$eval('.gb-grp >> nth=1 >> td[data-col="upnl"]', (e: Element) => e.className)).toContain('gr-down')
    const tsla = await page.$eval(`${R('xyz:TSLA')} td[data-col="upnl"]`, (e: Element) => [e.className, (e as HTMLElement).innerText])
    expect(tsla[0]).toContain('gr-flat')
    expect(tsla[1]).toMatch(/^0\.00/)
    expect(await text(page, `${R('BTC')} [data-col="sl"]`)).toBe('未设')
    const h = (sel: string) => page.$eval(sel, (e: Element) => Math.round(e.getBoundingClientRect().height))
    expect(await h(R('BTC'))).toBe(48)
    expect(await h('.gb-pos thead th')).toBe(32)
    expect(await h('.gb-pos .gb-grp')).toBe(32)
    const head = await page.$('[data-card="positions"] .gr-tile-p__head')
    if (head) expect(Math.round((await head.boundingBox()).height)).toBe(40)
    // 卡头计数：壳里经 CardHead 放进 .gr-tile-p__slot
    const slot = await page.$('[data-card="positions"] .gr-tile-p__slot, .gr-tile-p__slot:has(.gb-head__n)')
    if (slot) expect((await slot.innerText()).trim()).toBe('4')
    expect(await page.$$('.gb-pos__hero')).toHaveLength(0)
    await close()
  })

  it('1200：开仓价列收起，展开区里能看到开仓价；行 44 / 表头 30 / 分组 28', async () => {
    const { page, close } = await open('pending', 1200, 800)
    expect(await page.$eval('.gb-pos thead th[data-col="entry"]', (e: Element) => getComputedStyle(e).display)).toBe('none')
    expect(await page.$eval(`${R('BTC')} td[data-col="entry"]`, (e: Element) => getComputedStyle(e).display)).toBe('none')
    const h = (sel: string) => page.$eval(sel, (e: Element) => Math.round(e.getBoundingClientRect().height))
    expect(await h(R('BTC'))).toBe(44)
    expect(await h('.gb-pos thead th')).toBe(30)
    expect(await h('.gb-pos .gb-grp')).toBe(28)
    expect(await page.$eval('.gb-pos thead th[data-col="opener"]', (e: Element) => getComputedStyle(e).display)).not.toBe('none')
    const fits = () => page.$eval('.gb-pos__table', (e: Element) => e.scrollWidth <= e.clientWidth + 1)
    expect(await fits()).toBe(true) // 卡无横向溢出
    await expand(page, 'BTC')
    expect(await fits()).toBe(true)
    // 1200 档：表单换到明细 / 事件链下方整行
    const box = (sel: string) => page.$eval(sel, (e: Element) => { const r = e.getBoundingClientRect(); return { bottom: r.bottom, top: r.top, left: r.left } })
    expect((await box('.gb-detail__form')).top).toBeGreaterThanOrEqual((await box('.gb-detail__kv')).bottom)
    expect(Math.round((await box('.gb-detail__form')).left)).toBe(Math.round((await box('.gb-detail__kv')).left))
    expect(await page.$eval('.gb-detail__kv dd.gb-detail__entry', (e: Element) => [getComputedStyle(e).display, (e as HTMLElement).innerText])).toEqual(['block', '64,210.5'])
    await close()
  })

  it('新开仓行追加到组末、带「新」与行首竖条，原有行位置不变（G7）', async () => {
    const { page, close } = await open('pending')
    const before = await page.$$eval('.gb-pos tr[data-row]', (els: Element[]) => els.map((e) => e.getAttribute('data-row')))
    const pos = { accountId: ACCT_LIVE, instrumentId: 'hyperliquid:AAA', side: 'long', size: '3', entryPrice: '10', markPrice: '10.2', notional: '30.6', unrealizedPnl: '0.6', realizedPnl: '0', leverage: 2, marginMode: 'cross', liquidationPrice: '6', openedAt: Date.now() - 1000, updatedAt: Date.now() }
    stage.kernel.publish('account.positions', { accountId: ACCT_LIVE, instrumentId: 'hyperliquid:AAA', position: pos })
    await page.waitForSelector('.gb-pos [data-row$="|hyperliquid:AAA|long"]', { timeout: 3000 })
    const after = await page.$$eval('.gb-pos tr[data-row]', (els: Element[]) => els.map((e) => e.getAttribute('data-row')))
    expect(after.filter((k: string) => !k.includes('AAA'))).toEqual(before)
    expect(after.indexOf(`${ACCT_LIVE}|hyperliquid:AAA|long`)).toBe(3) // 实盘组末尾（纸面组之前）
    expect(await page.$eval('.gb-pos [data-row$="|hyperliquid:AAA|long"] [data-flag="new"]', (e: Element) => e.textContent)).toBe('新')
    expect(await page.$eval('.gb-pos [data-row$="|hyperliquid:AAA|long"] td[data-col="sym"]', (e: Element) => getComputedStyle(e).boxShadow)).toMatch(/inset/)
    await close()
  })

  it('空态：左上一行「当前没有持仓」，无 .gr-empty__art', async () => {
    const { page, close } = await open('empty')
    expect(await text(page, '.gb-pos__empty')).toBe('当前没有持仓')
    expect(await page.$$('.gb-pos .gr-empty__art')).toHaveLength(0)
    expect(await page.$$('.gb-pos .gb-table')).toHaveLength(0)
    await close()
  })
})

d('持仓卡 r4 · 平仓（G2 就地确认）', () => {
  it('点平仓：行 data-state=armed、出「市价平掉 30 SOL」、止损与 ⌄ 让位、焦点在取消', async () => {
    const { page, close } = await open('pending')
    await arm(page, 'SOL')
    expect(await state(page, 'SOL')).toBe('armed')
    expect(await text(page, `${R('SOL')} .gb-pos__what`)).toBe('市价平掉 30 SOL')
    expect(await page.$$(`${R('SOL')} [data-act="pos-stop"], ${R('SOL')} [data-act="pos-expand"]`)).toHaveLength(0)
    expect(await act(page)).toBe('pos-close-cancel')
    await page.waitForTimeout(250) // 底色过渡 120 ms
    expect(await page.$eval(`${R('SOL')} td[data-col="sym"]`, (e: Element) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('Escape')
    await page.waitForFunction((sel: string) => !document.querySelector(sel)?.hasAttribute('data-state'), R('SOL'), { timeout: 2000 })
    expect(calls('position.close')).toHaveLength(0)
    await close()
  })

  it('武装后 600 ms 内确认无效；按住回车（repeat）不发 position.close', async () => {
    const { page, close } = await open('pending')
    await arm(page, 'SOL')
    await page.waitForTimeout(200)
    await page.click(`${R('SOL')} [data-act="pos-close-confirm"]`)
    expect(calls('position.close')).toHaveLength(0)
    await page.focus(`${R('SOL')} [data-act="pos-close-confirm"]`)
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter') // 键没松开再按 = repeat:true
    await page.keyboard.up('Enter')
    await page.waitForTimeout(200)
    expect(calls('position.close')).toHaveLength(0)
    await close()
  })

  it('5 s 闲置复原；指针悬停暂停计时', async () => {
    const { page, close } = await open('pending')
    await arm(page, 'SOL')
    await page.hover(`${R('SOL')} [data-act="pos-close-confirm"]`)
    await page.waitForTimeout(6500)
    expect(await state(page, 'SOL')).toBe('armed')
    await page.mouse.move(4, 4)
    const t0 = Date.now()
    await page.waitForFunction((sel: string) => !document.querySelector(sel)?.hasAttribute('data-state'), R('SOL'), { timeout: 6000 })
    expect(Date.now() - t0).toBeGreaterThan(4000)
    expect(await page.$(`${R('SOL')} [data-act="pos-stop"]`)).not.toBeNull()
    expect(calls('position.close')).toHaveLength(0)
    await close()
  })

  it('确认后发 position.close {accountId, instrumentId}；「平仓中…」→「已平」→ ≥ 1.2 s 后收起', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { delayMs: { 'position.close': 600 } } })
    await arm(page, 'SOL')
    await confirm(page, 'SOL')
    await page.waitForFunction((sel: string) => /平仓中…/.test((document.querySelector(sel) as HTMLElement)?.innerText ?? ''), R('SOL'), { timeout: 2000 })
    expect(await state(page, 'SOL')).toBe('closing')
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.getAttribute('data-state') === 'closed', R('SOL'), { timeout: 4000 })
    const t0 = Date.now()
    expect(await text(page, `${R('SOL')} [data-col="act"]`)).toBe('已平')
    expect(calls('position.close').map((c: Any) => c.params)).toEqual([{ accountId: ACCT_PAPER, instrumentId: 'hyperliquid:SOL', reason: '人在持仓卡平仓' }])
    await page.waitForFunction((sel: string) => !document.querySelector(sel), R('SOL'), { timeout: 4000 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000)
    expect(await page.$$('.gb-pos .gb-grp')).toHaveLength(1) // 纸面组跟着收起
    await close()
  })

  it('平仓失败：内核原文挂行内（悬停全文）+ toast.err 原文、无成功 toast、仍在武装态可重试', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { fail: { 'position.close': UPSTREAM } } })
    await arm(page, 'BTC')
    await confirm(page, 'BTC')
    await page.waitForSelector(`${R('BTC')} .gr-iconfirm__err`, { timeout: 3000 })
    expect(await page.$eval(`${R('BTC')} .gr-iconfirm__err [data-err-detail] .gr-errd__v`, (e: Element) => e.textContent)).toBe(UPSTREAM) // ux-fix2 B2：Owner 令，总控批准的规格变更——上游原文收进详情
    expect(await page.$eval('.gr-toast[data-kind="err"] [data-err-detail] .gr-errd__v', (e: Element) => e.textContent)).toBe(UPSTREAM) // 返工 S-1：与批准 / 接管一致的原文回声；ux-fix2 B2：原文在 toast 的详情里（同一规格变更）
    expect(await page.$$('.gr-toast[data-kind="ok"]')).toHaveLength(0)
    expect(await state(page, 'BTC')).toBe('armed')
    expect(calls('position.close')).toHaveLength(1)
    await close()
  })

  it('返工 B-2 平仓只部分成交（partially_filled）：判失败、状态与成交量原值挂行内 + toast.err，不出「已平」，数量变成剩余', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: (st) => { st.fault.closeStatus = 'partially_filled' } })
    await arm(page, 'SOL')
    await confirm(page, 'SOL')
    await page.waitForSelector(`${R('SOL')} .gr-iconfirm__err`, { timeout: 3000 })
    expect(await page.$eval(`${R('SOL')} .gr-iconfirm__err [data-err-detail] .gr-errd__v`, (e: Element) => e.textContent)).toBe('partially_filled 15/30') // ux-fix2 B2：Owner 令，总控批准的规格变更
    expect(await page.$eval('.gr-toast[data-kind="err"] [data-err-detail] .gr-errd__v', (e: Element) => e.textContent)).toBe('partially_filled 15/30') // ux-fix2 B2：同一规格变更
    expect(await state(page, 'SOL')).toBe('armed')
    await page.waitForFunction((sel: string) => document.querySelector(`${sel} td[data-col="size"]`)?.textContent === '15', R('SOL'), { timeout: 3000 })
    await page.waitForTimeout(1500)
    expect(await state(page, 'SOL')).not.toBe('closed')
    expect(await page.$$('.gb-pos__done')).toHaveLength(0)
    await close()
  })

  it('返工 B-2 平仓单被撤（cancelled）：判失败、内核原文挂行内 + toast.err，仓位不变', async () => {
    const MSG = 'Order could not immediately match against any resting orders.'
    const { page, close } = await open('pending', 1440, 900, { patch: (st) => { st.fault.closeStatus = 'cancelled' } })
    await arm(page, 'SOL')
    await confirm(page, 'SOL')
    await page.waitForSelector(`${R('SOL')} .gr-iconfirm__err`, { timeout: 3000 })
    expect(await page.$eval(`${R('SOL')} .gr-iconfirm__err [data-err-detail] .gr-errd__v`, (e: Element) => e.textContent)).toBe(MSG) // ux-fix2 B2：Owner 令，总控批准的规格变更
    expect(await page.$eval('.gr-toast[data-kind="err"] [data-err-detail] .gr-errd__v', (e: Element) => e.textContent)).toBe(MSG) // ux-fix2 B2：同一规格变更
    expect(await text(page, `${R('SOL')} td[data-col="size"]`)).toBe('30')
    expect(await state(page, 'SOL')).toBe('armed')
    await close()
  })

  it('实盘回 ATTESTATION_REQUIRED：弹 PIN；取消 PIN 后没有第二次命令、行复原', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { closeNeedsPin: true } })
    await arm(page, 'BTC')
    await confirm(page, 'BTC')
    await page.waitForSelector('.gr-pin', { timeout: 4000 })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 3000 })
    await page.waitForFunction((sel: string) => !document.querySelector(sel)?.hasAttribute('data-state'), R('BTC'), { timeout: 3000 })
    expect(calls('position.close')).toHaveLength(1)
    expect(calls('position.close')[0].attested).toBe(false)
    expect(await page.$$(`${R('BTC')} .gr-iconfirm__err`)).toHaveLength(0)
    expect(await page.$$('.gr-toast')).toHaveLength(0)
    await close()
  })

  it('部分平仓 25%：InlineConfirm 后 position.close 带 size', async () => {
    const { page, close } = await open('pending')
    await expand(page, 'BTC')
    await page.click('.gb-detail__pct [data-pct="25"]')
    expect(await page.$eval('input[aria-label="平仓数量"]', (e: Element) => (e as HTMLInputElement).value)).toBe('0.02')
    await page.click('[data-act="pos-partial"]')
    await page.waitForTimeout(700)
    await page.click('[data-act="pos-partial-confirm"]')
    await expect.poll(() => calls('position.close').length, { timeout: 3000 }).toBe(1)
    expect(calls('position.close')[0].params).toEqual({ accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', size: '0.02', reason: '人在持仓卡平仓' })
    await page.waitForFunction((sel: string) => document.querySelector(`${sel} td[data-col="size"]`)?.textContent === '0.06', R('BTC'), { timeout: 3000 })
    await close()
  })
})

d('持仓卡 r4 · 止损（先挂新单、再撤旧单）', () => {
  it('设止损：点「止损」展开并聚焦触发价；place stop_market reduceOnly，止损列换成触发价', async () => {
    const { page, close } = await open('pending')
    await page.click(`${R('BTC')} [data-act="pos-stop"]`)
    await page.waitForSelector('input[aria-label="止损触发价"]')
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '止损触发价', null, { timeout: 2000 })
    await page.keyboard.type('60000')
    expect(await text(page, '.gb-stop__hint')).toBe('距标记价 7.5%')
    await page.click('[data-act="stop-save"]')
    await page.waitForFunction((sel: string) => (document.querySelector(`${sel} td[data-col="sl"]`) as HTMLElement)?.innerText === '60,000.0', R('BTC'), { timeout: 3000 })
    expect(calls('order.place').map((c: Any) => c.params.intent)).toEqual([{ accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'stop_market', size: '0.08', triggerPrice: '60000', reduceOnly: true, reason: '人在持仓卡设止损' }])
    expect(calls('order.cancel')).toHaveLength(0)
    await close()
  })

  it('改止损：先 order.place 后 order.cancel（撤旧单），期间「更新中…」', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: withStop, fault: { delayMs: { 'order.place': 600 } } })
    expect(await text(page, `${R('BTC')} [data-col="sl"]`)).toBe('59,000.0')
    await page.click(`${R('BTC')} [data-act="pos-stop"]`)
    await page.fill('input[aria-label="止损触发价"]', '61000')
    await page.click('[data-act="stop-save"]')
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.getAttribute('data-state') === 'stop-updating', R('BTC'), { timeout: 1000 })
    expect(await text(page, `${R('BTC')} [data-col="sl"]`)).toBe('更新中…')
    await page.waitForFunction((sel: string) => (document.querySelector(`${sel} td[data-col="sl"]`) as HTMLElement)?.innerText === '61,000.0', R('BTC'), { timeout: 4000 })
    expect(order()).toEqual(['order.place', 'order.cancel'])
    expect(calls('order.cancel')[0].params).toEqual({ accountId: ACCT_LIVE, orderId: STOP_OLD })
    expect(await state(page, 'BTC')).toBeNull()
    await close()
  })

  it('改止损挂新成功、撤旧失败：列显示新触发价 + 原文，toast 先陈述状态再附原文，无成功 toast', async () => {
    const MSG = 'order not found for this account'
    const { page, close } = await open('pending', 1440, 900, { patch: withStop, fault: { fail: { 'order.cancel': MSG } } })
    await page.click(`${R('BTC')} [data-act="pos-stop"]`)
    await page.fill('input[aria-label="止损触发价"]', '61000')
    await page.click('[data-act="stop-save"]')
    await page.waitForSelector('.gb-pos .gb-pos__err', { timeout: 3000 })
    expect(await page.$eval('.gb-pos .gb-pos__err', (e: Element) => [e.textContent, e.getAttribute('title')])).toEqual([MSG, MSG])
    expect(await text(page, `${R('BTC')} [data-col="sl"]`)).toBe('61,000.0')
    expect(await text(page, '.gr-toast[data-kind="err"]')).toContain(`新止损已挂上，旧止损没有撤销：${MSG}`)
    expect(await page.$$('.gr-toast[data-kind="ok"]')).toHaveLength(0)
    expect(order()).toEqual(['order.place', 'order.cancel'])
    await close()
  })

  it('改止损挂新失败：保留旧值 + 原文，不发 cancel', async () => {
    const MSG = 'MAX_OPEN_ORDERS: 20/orders'
    const { page, close } = await open('pending', 1440, 900, { patch: withStop, fault: { fail: { 'order.place': MSG } } })
    await page.click(`${R('BTC')} [data-act="pos-stop"]`)
    await page.fill('input[aria-label="止损触发价"]', '61000')
    await page.click('[data-act="stop-save"]')
    await page.waitForSelector('.gb-pos .gb-pos__err', { timeout: 3000 })
    expect(await text(page, '.gb-pos .gb-pos__err')).toBe(MSG)
    expect(await text(page, `${R('BTC')} [data-col="sl"]`)).toBe('59,000.0')
    expect(order()).toEqual(['order.place'])
    expect(await page.$$('.gr-toast[data-kind="ok"]')).toHaveLength(0)
    await close()
  })

  it('返工：撤单回 {ok:false}（清除止损）：原文挂行内、止损列不变', async () => {
    const MSG = 'Order was never placed, already canceled, or filled.'
    const { page, close } = await open('pending', 1440, 900, { patch: (st) => { withStop(st); st.fault.cancelNotOk = MSG } })
    await expand(page, 'BTC')
    await page.click('[data-act="stop-clear"]')
    await page.waitForSelector('.gb-pos .gb-pos__err', { timeout: 3000 })
    expect(await text(page, '.gb-pos .gb-pos__err')).toBe(MSG)
    expect(await text(page, `${R('BTC')} [data-col="sl"]`)).toBe('59,000.0')
    expect(calls('order.cancel')).toHaveLength(1)
    await close()
  })

  it('清除止损：order.cancel，列回「未设」', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: withStop })
    await expand(page, 'BTC')
    await page.click('[data-act="stop-clear"]')
    await page.waitForFunction((sel: string) => (document.querySelector(`${sel} td[data-col="sl"]`) as HTMLElement)?.innerText === '未设', R('BTC'), { timeout: 3000 })
    expect(calls('order.cancel').map((c: Any) => c.params)).toEqual([{ accountId: ACCT_LIVE, orderId: STOP_OLD }])
    expect(await page.$$('[data-act="stop-clear"]')).toHaveLength(0)
    await close()
  })

  it('止损价方向不对：本地挡下、就地提示、不发命令（多头 ≥ 标记价 / 空头 ≤ 标记价）', async () => {
    const { page, close } = await open('pending')
    await page.click(`${R('BTC')} [data-act="pos-stop"]`)
    await page.fill('input[aria-label="止损触发价"]', '70000')
    expect(await text(page, '.gb-stop__hint[data-bad]')).toBe('多头止损价要低于标记价')
    expect(await page.$eval('[data-act="stop-save"]', (e: Element) => (e as HTMLButtonElement).disabled)).toBe(true)
    await page.press('input[aria-label="止损触发价"]', 'Enter')
    await page.click(`${R('ETH')} [data-act="pos-stop"]`)
    await page.fill('input[aria-label="止损触发价"]', '3000')
    expect(await text(page, '.gb-stop__hint[data-bad]')).toBe('空头止损价要高于标记价')
    await page.press('input[aria-label="止损触发价"]', 'Enter')
    await page.waitForTimeout(200)
    expect(stage.stage.calls).toHaveLength(0)
    await close()
  })
})

d('持仓卡 r4 · 展开区与跳转', () => {
  it('展开：⌄ 与整行点击都可展开、一次一行、Enter / Space 可展开、三栏都在', async () => {
    const { page, close } = await open('pending')
    await expand(page, 'BTC')
    expect(await page.$eval(`${R('BTC')} [data-act="pos-expand"]`, (e: Element) => [e.getAttribute('aria-expanded'), e.getAttribute('aria-label')])).toEqual(['true', '收起'])
    expect(await page.$$eval('.gb-detail__grid > *', (els: Element[]) => els.map((e) => e.className.split(' ')[0]))).toEqual(['gb-detail__kv', 'gb-chain', 'gb-detail__form'])
    await page.waitForSelector('.gb-chain__step.is-origin', { timeout: 4000 })
    const cols = await page.$$eval('.gb-detail__grid > *', (els: Element[]) => els.map((e) => Math.round(e.getBoundingClientRect().width)))
    expect(cols[0]).toBe(160) // 主会话按 comps 定：明细 160 / 事件链 ≥ 340 / 表单 280
    expect(cols[1]).toBeGreaterThanOrEqual(340)
    expect(cols[2]).toBe(280)
    // 1440 下「◆ Claude Code 成交 买入 0.25 @ 64,210.5」完整可见（不省略）
    expect(await page.$$eval('.gb-chain__step.is-fill .gb-chain__v', (els: Element[]) => els.map((e) => e.scrollWidth <= e.clientWidth))).toEqual([true])
    // 事件链每条单行（省略号截断），悬停 title 是全文；「来源 … 经 MCP」也在一行
    const hs = await page.$$eval('.gb-chain__v', (els: Element[]) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
    expect(hs.every((x: number) => x < 30), JSON.stringify(hs)).toBe(true) // 单行：行高 18，带执行方标的行 22；两行起码 36
    await page.hover('.gb-chain__step.is-origin .gb-chain__v')
    expect(await page.$eval('.gb-chain__step.is-origin .gb-chain__v', (e: Element) => e.getAttribute('title'))).toMatch(/^来源[\s\S]*Claude Code[\s\S]*· 经 MCP$/)
    await page.click(`${R('ETH')} td[data-col="mark"]`) // 整行点击
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.getAttribute('aria-expanded') === 'true', R('ETH'), { timeout: 2000 })
    expect(await page.$$('.gb-pos tr.gb-detail')).toHaveLength(1)
    expect(await page.$eval(R('BTC'), (e: Element) => e.getAttribute('aria-expanded'))).toBe('false')
    await page.focus(R('xyz:TSLA'))
    await page.keyboard.press('Enter')
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.getAttribute('aria-expanded') === 'true', R('xyz:TSLA'), { timeout: 2000 })
    await page.keyboard.press('Space')
    await page.waitForFunction(() => document.querySelectorAll('.gb-pos tr.gb-detail').length === 0, null, { timeout: 2000 })
    await close()
  })

  it('展开区不套卡：体检 nestDepth3 = 0（audit-probe）', async () => {
    const { page, close } = await open('pending')
    await expand(page, 'BTC')
    await page.waitForSelector('.gb-chain__step.is-origin', { timeout: 4000 })
    await page.waitForTimeout(400)
    // 只量持仓卡：别的卡（待批 / Agent / 风险 / 总览条）归 C2，先藏起来（visibility:hidden 的元素体检不计）
    await page.addStyleTag({ content: '.gb-agent, .gb-risk, .gb-sb { visibility: hidden !important; }' })
    const probe = readFileSync(join(__dirname, '../../workbench/design/audit-probe.js'), 'utf8')
    const out = await page.evaluate(probe)
    expect(out.nestDepth3, JSON.stringify(out.samples?.nest ?? [])).toBe(0)
    await close()
  })

  it('有待批：点 BTC 行「有待批」→ 待批卡选中 T-…0007；点 ETH 行 → T-…0008，焦点进待批卡', async () => {
    const { page, close } = await open('pending')
    expect(await page.$$('.gb-pos [data-act="pos-goto-pending"]')).toHaveLength(2) // BTC、ETH；SOL / TSLA 没有
    await page.click(`${R('BTC')} [data-act="pos-goto-pending"]`)
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 3000 })
    expect(await page.$$('.gb-pos tr.gb-detail')).toHaveLength(0) // 点标记不展开行
    await page.waitForTimeout(700)
    await page.click(`${R('ETH')} [data-act="pos-goto-pending"]`)
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0008', null, { timeout: 3000 })
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-card="pending"]'))).toBe(true)
    await close()
  })
})

d('持仓卡 r4 · 离线（G5）', () => {
  it('离线：平仓 / 止损 / 部分平仓 / 保存禁用并写「离线」，武装态解除', async () => {
    const { page, close, cut } = await open('pending', 1440, 900, { net: true })
    await expand(page, 'BTC')
    await arm(page, 'SOL')
    await cut()
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-offline'), null, { timeout: 6000 })
    await page.waitForFunction((sel: string) => !document.querySelector(sel)?.hasAttribute('data-state'), R('SOL'), { timeout: 2000 })
    for (const s of ['BTC', 'SOL']) {
      expect(await page.$eval(`${R(s)} [data-act="pos-close"]`, (e: Element) => (e as HTMLButtonElement).disabled)).toBe(true)
      expect(await page.$eval(`${R(s)} [data-act="pos-stop"]`, (e: Element) => (e as HTMLButtonElement).disabled)).toBe(true)
      expect(await text(page, `${R(s)} .gb-pos__off`)).toBe('离线')
    }
    expect(await page.$eval('[data-act="pos-partial"]', (e: Element) => (e as HTMLButtonElement).disabled)).toBe(true)
    expect(await page.$eval('[data-act="stop-save"]', (e: Element) => (e as HTMLButtonElement).disabled)).toBe(true)
    expect(await text(page, '.gb-stop__hint')).toBe('离线')
    expect(stage.stage.calls).toHaveLength(0)
    await close()
  })

  it('离线：数字去涨跌色、正负号保留', async () => {
    const { page, close, cut } = await open('pending', 1440, 900, { net: true })
    const colored = () => page.$$eval('.gb-pos .gr-up, .gb-pos .gr-down', (e: Element[]) => e.length)
    expect(await colored()).toBeGreaterThan(0)
    await cut()
    await page.waitForFunction(() => document.querySelectorAll('.gb-pos .gr-up, .gb-pos .gr-down').length === 0, null, { timeout: 6000 })
    expect(await text(page, `${R('BTC')} [data-col="upnl"]`)).toMatch(/^\+53\.58/)
    expect(await text(page, `${R('SOL')} [data-col="upnl"]`)).toMatch(/^−42\.00/)
    expect(await text(page, '.gb-grp >> nth=1')).toContain('−42.00')
    await close()
  })
})
