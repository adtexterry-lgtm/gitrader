// SPDX-License-Identifier: CPAL-1.0
// 视觉轮 r4（C2）浏览器用例：Agent 块三视图（待批 / Agent / 活动）+ 总览条 + 风险卡，跑在真壳（五卡两列）+ 夹具内核上，无头 Edge。
// 与 render.browser.test.ts 同一套舞台（verify/stage.mjs）；找不到无头浏览器时整体失败（不静默跳过），确实没有才设 GITRADER_SKIP_BROWSER=1 并在回报里写明。
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
const open = async (name: string, w = 1440, h = 900, o: OpenOpts = {}): Promise<{ page: Any; ctx: Any; close(): Promise<void>; cut(): Promise<void> }> => {
  stage.stage.load(name)
  stage.stage.calls.length = 0
  if (o.fault) Object.assign(stage.stage.fault, o.fault)
  o.patch?.(stage.stage)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const net = { cut: false, socks: [] as Any[] }
  if (o.net) await ctx.routeWebSocket(/\/ui$/, (ws: Any) => { if (net.cut) { void ws.close(); return } net.socks.push(ws.connectToServer(), ws) })
  const page = await ctx.newPage()
  page.on('console', (m: Any) => { if (m.type() === 'error' && !(net.cut && /WebSocket/.test(m.text()))) errors.push(`[${name} ${w}] ${m.text()}`) })
  page.on('pageerror', (e: Any) => errors.push(`[${name} ${w}] pageerror ${e.message}`))
  await page.goto(stage.url, { waitUntil: 'load' })
  await page.waitForFunction(() => (window as Any).__GR_READY__?.online === true, null, { timeout: 8000 })
  await page.waitForSelector('.gb-agent[data-view="pending"]', { state: 'attached', timeout: 8000 })
  await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, null, { timeout: 8000 })
  await page.waitForTimeout(700) // 卡入场 320 ms + 错开、引信点亮 400 ms
  const cut = async () => { net.cut = true; for (const s of net.socks.splice(0)) { try { await s.close() } catch { /* 已关闭 */ } } }
  return { page, ctx, close: () => ctx.close(), cut }
}
const tc = (page: Any, sel: string): Promise<string> => page.$eval(sel, (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).catch(() => '')
/** 一个容器的各子元素文本（总览条 / 卡头：子元素之间没有空白字符，按段比）。 */
const parts = (page: Any, sel: string): Promise<string[]> => page.$eval(sel, (e: Element) => [...e.children].filter((c) => !c.classList.contains('gr-sr')).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())).catch(() => [])
/** 壳卡头：标题 + 槽里的计数。 */
const head = (page: Any, card: string): Promise<string> => page.$eval(`[data-card="${card}"] .gr-tile-p__head`, (e: Element) => `${e.querySelector('.gr-tile-p__title')?.textContent ?? ''} ${(e.querySelector('.gb-head__n')?.textContent ?? '').trim()}`.trim()).catch(() => '')
const calls = (action: string): Any[] => stage.stage.calls.filter((c: Any) => c.action === action)
const byTicket = (st: Any, t: string): Any => st.sc.proposals.find((p: Any) => p.ticket === t)
/** 夹具时间是进程启动时刻定的；要读精确倒计时 / 引信的用例把到期时间改成「现在起」。 */
const fresh = (st: Any) => { byTicket(st, 'T-20261010-0008').expiresAt = Date.now() + 185_000; byTicket(st, 'T-20261010-0007').expiresAt = Date.now() + 582_000 }

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

d('Agent 块三视图', () => {
  it('三个实例：data-view 各一张卡，各只渲染自己的部分', async () => {
    const { page, close } = await open('pending')
    const v = await page.evaluate(() => [...document.querySelectorAll('.gb-agent[data-view]')].map((e) => [e.getAttribute('data-view'), e.closest('[data-card]')?.getAttribute('data-card'), !!e.querySelector('.gb-pend'), !!e.querySelector('.gb-tier'), !!e.querySelector('.gb-ev')]))
    expect(v).toEqual([['feed', 'feed', false, false, true], ['pending', 'pending', true, false, false], ['keys', 'agents', false, true, false]])
    expect(await page.$$('.gb-agent:not([data-view])')).toHaveLength(0)
    await close()
  })

  it('待批：卡头「待批」+ 计数 2（在壳的卡头槽里）；引信宽度比例 ≈ 61.7%', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: fresh })
    expect(await head(page, 'pending')).toBe('待批 2')
    expect(await page.$('[data-card="pending"] .gr-tile-p__slot .gb-head__n')).not.toBeNull()
    const r = await page.$eval('.gb-fuse', (e: Element) => (e.querySelector('i') as HTMLElement).getBoundingClientRect().width / e.getBoundingClientRect().width)
    expect(Math.abs(r - 0.617)).toBeLessThan(0.015)
    await close()
  })

  it('待批：批后仓位「空 1.2 → 空 3.2」；「实盘」是字不是框', async () => {
    const { page, close } = await open('pending')
    expect(await parts(page, '.gb-pend__after')).toEqual(['批后 ETH', '空 1.2', '', '空 3.2'])
    expect(await tc(page, '.gb-pend__to')).toBe('空 3.2')
    const live = await page.$eval('.gb-pend .gb-mode[data-mode="live"]', (e: Element) => { const s = getComputedStyle(e); return { t: e.textContent, sh: s.boxShadow, bw: s.borderTopWidth, bg: s.backgroundColor } })
    expect(live.t).toBe('实盘')
    expect(live.sh).toBe('none')
    expect(live.bw).toBe('0px')
    expect(live.bg).toBe('rgba(0, 0, 0, 0)')
    await close()
  })

  it('队列：点 T-…0007 换卡，500 ms 内两钮 aria-disabled，之后可点', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { approveNoPin: true } })
    expect(await tc(page, '.gb-queue [data-act="queue-pick"] .gb-queue__tk')).toBe('T-…0007')
    await page.click('.gb-queue [data-act="queue-pick"]')
    const swappedAt = await page.waitForFunction(() => (document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007' ? performance.now() : false), null, { timeout: 3000, polling: 'raf' }).then((h: Any) => h.jsonValue())
    const st = await page.$$eval('[data-act="approve"], [data-act="reject"]', (els: Element[]) => els.map((e) => { const r = e.getBoundingClientRect(); return { dis: e.getAttribute('aria-disabled'), x: r.x + r.width / 2, y: r.y + r.height / 2 } }))
    expect(st.map((x: Any) => x.dis)).toEqual(['true', 'true'])
    const at = await page.evaluate(() => performance.now())
    await page.mouse.click(st[1].x, st[1].y) // 直接按坐标点（不等元素稳定），确保落在 500 ms 死区里
    expect(at - swappedAt).toBeLessThan(500)
    await page.waitForTimeout(150)
    expect(calls('proposal.approve')).toHaveLength(0)
    await page.waitForTimeout(600)
    expect(await page.$eval('[data-act="approve"]', (e: Element) => e.getAttribute('aria-disabled'))).toBeNull()
    // 队列按钮本身不溢出（省略号在内层，体检 truncated 不计）
    expect(await page.$$eval('[data-act="queue-pick"]', (els: Element[]) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length)).toBe(0)
    await close()
  })

  it('批准成功：已批准 → 退场 → 下一张落位 → 卡头计数 2 → 1（≤ 1.6 s）', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { approveNoPin: true, approveExecutes: true } })
    const t0 = Date.now()
    await page.click('[data-act="approve"]')
    await page.waitForSelector('.gb-pend[data-result="executed"]', { timeout: 3000 })
    expect(await tc(page, '.gb-pend .gb-pend__res')).toBe('已批准 · 已执行')
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 3000 })
    await page.waitForFunction(() => (document.querySelector('[data-card="pending"] .gb-head__n')?.textContent ?? '').trim() === '1', null, { timeout: 2000 })
    expect(Date.now() - t0).toBeLessThanOrEqual(1600 + 400) // 命令往返 + 1.2 s 三拍；留 400 ms 给无头浏览器的调度
    expect(await page.$$('.gb-queue li')).toHaveLength(0)
    await close()
  })

  it('批准后提案列表比 1.2 s 慢（旧卡又以待审推回来）：退场中的卡不接指针，换上来的是下一张且完全可见，透明旧卡不回可见位（审稿 C2-2）', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { approveNoPin: true, approveExecutes: true } })
    const p8 = byTicket(stage.stage, 'T-20261010-0008')
    await page.click('[data-act="approve"]')
    await page.waitForSelector('.gb-pend[data-result="executed"]', { timeout: 3000 })
    // 退场开始后（约 0.9 s）卡不接指针
    await page.waitForFunction(() => (document.querySelector('.gb-pend[data-ticket="T-20261010-0008"]') as HTMLElement | null)?.style.pointerEvents === 'none', null, { timeout: 2000 })
    // 模拟慢到的旧状态：内核又把这张当成待审推一次
    stage.kernel.publish('proposal.created', { ...p8, status: 'pending', expiresAt: Date.now() + 120_000 })
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 3000 })
    await page.waitForTimeout(500) // 入场 280 ms + 死区 500 ms 的大部分
    const st = await page.evaluate(() => { const e = document.querySelector('.gb-pend') as HTMLElement; const cs = getComputedStyle(e); return { n: document.querySelectorAll('.gb-pend').length, op: cs.opacity, pe: cs.pointerEvents, q: [...document.querySelectorAll('.gb-queue li[data-ticket]')].map((x) => x.getAttribute('data-ticket')) } })
    expect(st).toEqual({ n: 1, op: '1', pe: 'auto', q: [] })
    await close()
  })

  it('待批 0：卡只剩卡头「待批 0」，块体不占高；风险卡保护器列表自动展开', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: (st) => { st.sc.proposals = st.sc.proposals.filter((p: Any) => p.status !== 'pending') } })
    expect(await head(page, 'pending')).toBe('待批 0')
    const h = await page.$eval('[data-card="pending"] .gr-tile-p__body', (e: Element) => e.getBoundingClientRect().height)
    expect(h).toBeLessThanOrEqual(1)
    expect(await page.$eval('[data-act="protectors"]', (e: Element) => e.getAttribute('aria-expanded'))).toBe('true')
    expect(await page.$$('.gb-risk .gb-plist li')).not.toHaveLength(0)
    await close()
  })

  it('Agent：两行，名字 + LLM + 最后活动「20 秒前」「1 小时前」+ 档位件（填充家族，不在 ButtonGroup 外框里）', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: (st) => { st.sc.keys[0].lastSeenAt = Date.now() - 20_000; st.sc.keys[1].lastSeenAt = Date.now() - 3_600_000 } })
    const rows = await page.$$eval('.gb-agent[data-view="keys"] .gb-tier', (els: Element[]) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^LLM · Claude Code ?2[0-9] 秒前需确认$/)
    expect(rows[1]).toBe('LLM · Hermes1 小时前纸面')
    expect(await head(page, 'agents')).toBe('Agent 2')
    const btn = await page.$eval('.gb-tierbtn', (e: Element) => ({ bg: getComputedStyle(e).backgroundColor, h: e.getBoundingClientRect().height, group: !!e.closest('.gr-btngroup') }))
    expect(btn.bg).not.toBe('rgba(0, 0, 0, 0)')
    expect(btn.h).toBe(28)
    expect(btn.group).toBe(false)
    await close()
  })

  it('活动：页签带计数、选中有底；静止态最后一条完整可见（无半行）；结果字紧跟做什么，不成列', async () => {
    const { page, close } = await open('normal')
    const tabs = await page.$$eval('[data-card="feed"] .gb-agent__filter .gr-seg__btn', (els: Element[]) => els.map((e) => [e.getAttribute('aria-checked'), getComputedStyle(e).backgroundColor, (e.querySelector('.gb-fchip__n')?.textContent ?? '')]))
    expect(tabs.map((t: string[]) => t[2])).toEqual(['13', '1', '3', '6', '3'])
    expect(tabs[0]![0]).toBe('true')
    expect(tabs[0]![1]).not.toBe('rgba(0, 0, 0, 0)')
    const clip = await page.evaluate(() => {
      const sc = document.querySelector('[data-card="feed"] .gr-scrollarea__in') as HTMLElement
      const b = sc.getBoundingClientRect().bottom
      const half = [...sc.querySelectorAll('.gb-ev')].filter((e) => { const r = e.getBoundingClientRect(); return r.top < b - 0.5 && r.bottom > b + 0.5 })
      const cut = sc.querySelector('.gb-ev[data-cut]')
      return { half: half.length, cut: !!cut, cutShadow: cut ? getComputedStyle(cut).boxShadow : '' }
    })
    expect(clip.half).toBe(0)
    if (clip.cut) expect(clip.cutShadow).toBe('none')
    const lefts = await page.$$eval('[data-card="feed"] .gb-ev__res', (els: Element[]) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
    expect(new Set(lefts).size).toBeGreaterThan(1)
    // 结果字只两类上色：被拦截 down、待批 warn；其余 text-3
    const colors = await page.$$eval('[data-card="feed"] .gb-ev__res', (els: Element[]) => els.map((e) => [e.textContent, getComputedStyle(e).color]))
    const c3 = colors.find(([t]: string[]) => t === '已记录')![1]
    expect(colors.find(([t]: string[]) => t === '已暂停')![1]).toBe(c3)
    expect(colors.find(([t]: string[]) => t === '被拦截')![1]).not.toBe(c3)
    // fix-r4: 夹具里唯一的「待批」创建行同票已批准并执行，状态回写后显示「已执行」，活动流里不再有橙色「待批」
    expect(colors.find(([t]: string[]) => t === '待批')).toBeUndefined()
    expect(colors.find(([t]: string[]) => t === '已执行')).toBeDefined()
    await close()
  })
})

d('总览条', () => {
  it('七项读数与顺序（1440）：实盘权益 · 今日 · 纸面 · 风险 · 待批 最急 · 网络 · 接管', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: fresh })
    expect(await page.$$eval('.gb-sb > *', (els: Element[]) => els.map((e) => e.className.split(' ')[0] + (e.getAttribute('data-mode') ? ':' + e.getAttribute('data-mode') : '')))).toEqual(['gb-sb__lead', 'gb-sb__g:paper', 'gb-sb__g', 'gb-sb__pend', 'gb-sb__right'])
    expect(await parts(page, '.gb-sb__lead > .gb-sb__eq')).toEqual(['实盘权益', '12,480.20', 'USDC'])
    expect(await parts(page, '.gb-sb__lead > .gb-sb__today')).toEqual(['今日', '+128.40', '+1.04%'])
    expect(await parts(page, '.gb-sb > .gb-sb__eq[data-mode="paper"]')).toEqual(['纸面', '9,987.50', '今日 −12.50'])
    expect(await parts(page, '[data-act="strip-risk"]')).toEqual(['风险', '正常交易'])
    const pend = await parts(page, '[data-act="strip-pending"]')
    expect(pend[0]).toBe('待批 2')
    expect(pend[1]).toMatch(/^最急 03:0[0-5]$/)
    expect(await parts(page, '[data-act="network"]')).toEqual(['测试网', '已连接', '42 ms'])
    expect(await tc(page, '.gb-sb__right [data-act="takeover"]')).toBe('接管')
    // 只有一个实心橙（批准）；待批数字是橙字
    expect(await page.$$('.gr-btn--primary')).toHaveLength(1)
    expect(await page.$eval('.gb-sb__pn', (e: Element) => getComputedStyle(e).fontWeight)).toBe('600')
    expect(await page.$eval('.gb-sb__hero', (e: Element) => getComputedStyle(e).fontSize)).toBe('36px')
    await close()
  })

  it('1200：网络只留名字；条内不溢出', async () => {
    const { page, close } = await open('pending', 1200, 800)
    expect(await page.$eval('[data-act="network"]', (e: Element) => (e as HTMLElement).innerText.trim())).toBe('测试网')
    expect(await page.$eval('.gr-status', (e: Element) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(2)
    await close()
  })

  it('点「待批 2」焦点到待批卡；点风险态焦点到风险卡', async () => {
    const { page, close } = await open('pending')
    await page.click('[data-act="strip-pending"]')
    await page.waitForFunction(() => document.activeElement?.closest('[data-card]')?.getAttribute('data-card') === 'pending', null, { timeout: 2000 })
    await page.click('[data-act="strip-risk"]')
    await page.waitForFunction(() => document.activeElement?.closest('[data-card]')?.getAttribute('data-card') === 'risk', null, { timeout: 2000 })
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H2')
    await close()
  })

  it('网络卡 / 接管卡向下展开、在视口内、Esc 回焦点', async () => {
    const { page, close } = await open('pending')
    for (const [act, sel] of [['network', '.gb-netcard'], ['takeover', '.gb-tkcard']]) {
      const trig = await page.$eval(`[data-act="${act}"]`, (e: Element) => e.getBoundingClientRect().bottom)
      await page.click(`[data-act="${act}"]`)
      await page.waitForSelector(sel)
      await page.waitForTimeout(300)
      const r = await page.$eval(sel, (e: Element) => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: innerWidth, h: innerHeight } })
      expect(r.t, act).toBeGreaterThanOrEqual(trig)
      expect(r.b, act).toBeLessThanOrEqual(r.h)
      expect(r.l, act).toBeGreaterThanOrEqual(0)
      expect(r.r, act).toBeLessThanOrEqual(r.w)
      await page.keyboard.press('Escape')
      await page.waitForFunction((s: string) => !document.querySelector(s), sel, { timeout: 2000 })
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-act'))).toBe(act)
    }
    await close()
  })

  it('读取失败（内核在线）：网络项是内核原文、接管可点（r2 C1 红线：不写成「内核未连接」）', async () => {
    const { page, close } = await open('error')
    const MSG = '内核暂时读不到这份数据（演示用的读取失败场景）'
    expect(await tc(page, '[data-act="network"]')).toBe(MSG)
    expect(await page.$eval('[data-act="network"]', (e: Element) => e.getAttribute('title'))).toBe(MSG)
    expect(await tc(page, '.gb-sb')).not.toContain('内核未连接')
    expect(await page.$eval('[data-act="takeover"]', (e: Element) => (e as HTMLButtonElement).disabled)).toBe(false)
    await close()
  })

  it('离线：整条 text-3、无 .gr-up/.gr-down、正负号在、接管禁用写原因', async () => {
    const { page, close, cut } = await open('pending', 1440, 900, { net: true })
    expect(await page.$$('.gb-sb .gr-up, .gb-sb .gr-down')).not.toHaveLength(0)
    await cut()
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-offline'), null, { timeout: 6000 })
    await page.waitForTimeout(300)
    expect(await page.$$('.gb-sb .gr-up, .gb-sb .gr-down')).toHaveLength(0)
    expect(await tc(page, '.gb-sb__lead .gb-sb__today')).toContain('+128.40')
    expect(await tc(page, '.gb-sb > .gb-sb__eq[data-mode="paper"]')).toContain('−12.50')
    const c = await page.evaluate(() => { const t3 = getComputedStyle(document.documentElement).getPropertyValue('--gr-text-3').trim(); const probe = document.createElement('i'); probe.style.color = t3; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); return { want, hero: getComputedStyle(document.querySelector('.gb-sb__hero') as Element).color, mid: getComputedStyle(document.querySelector('.gb-sb__mid') as Element).color } })
    expect(c.hero).toBe(c.want)
    expect(c.mid).toBe(c.want)
    expect(await page.$eval('[data-act="takeover"]', (e: Element) => (e as HTMLButtonElement).disabled)).toBe(true)
    expect(await page.$eval('.gb-sb__tkoff', (e: Element) => e.getAttribute('title'))).toBe('内核未连接')
    expect(await tc(page, '[data-act="network"]')).toBe('内核未连接')
    await close()
  })

  it('接管：风险卡执行中 → 总览条接管钮与风险卡三档同时禁用（r2 M4，读 data-takeover-busy）', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { delayMs: { 'takeover.halt_new': 2500 } } })
    await page.click('.gb-risk [data-act="takeover-halt_new"]')
    await page.waitForTimeout(650)
    await page.click('.gb-risk [data-act="takeover-halt_new-confirm"]')
    await page.waitForSelector('.gb-risk [data-act="takeover-halt_new-confirm"].is-busy', { timeout: 2000 })
    expect(await page.$eval('[data-act="takeover"]', (e: Element) => (e as HTMLButtonElement).disabled)).toBe(true)
    expect(await page.$$eval('.gb-risk [data-act="takeover-cancel_all"], .gb-risk [data-act="takeover-flatten_all"]', (els: Element[]) => els.map((e) => (e as HTMLButtonElement).disabled))).toEqual([true, true])
    await page.waitForFunction(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'REDUCING', null, { timeout: 6000 })
    await page.waitForFunction(() => !(document.querySelector('[data-act="takeover"]') as HTMLButtonElement).disabled, null, { timeout: 3000 })
    await close()
  })
})

d('风险卡', () => {
  it('状态只有字无点；三钮自然宽度一排、间距 8、填充家族；限额 1 px 轨 + 2 px 已用段', async () => {
    const { page, close } = await open('pending')
    expect(await page.$$('[data-card="risk"] .gr-dot, [data-card="risk"] .gb-state .gr-dot')).toHaveLength(0)
    expect(await tc(page, '[data-card="risk"] .gr-tile-p__head .gb-state')).toBe('正常交易')
    const b = await page.$$eval('.gb-risk .gb-takeover [data-iconfirm="trigger"]', (els: Element[]) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: Math.round(r.width), h: r.height, bg: getComputedStyle(e).backgroundColor } }))
    expect(b).toHaveLength(3)
    expect(new Set(b.map((x: Any) => x.w)).size).toBeGreaterThan(1) // 自然宽度，不等分
    expect(Math.round(b[1].l - b[0].r)).toBe(8)
    expect(Math.round(b[2].l - b[1].r)).toBe(8)
    for (const x of b) { expect(x.h).toBe(32); expect(x.bg).not.toBe('rgba(0, 0, 0, 0)') }
    const bar = await page.$eval('[data-limit="order"] .gb-limit__bar', (e: Element) => ({ h: e.getBoundingClientRect().height, track: getComputedStyle(e, '::before').height, fill: (e.querySelector('i') as HTMLElement).getBoundingClientRect().width / e.getBoundingClientRect().width }))
    expect(bar.h).toBe(2)
    expect(bar.track).toBe('1px')
    expect(bar.fill).toBeCloseTo(0.642, 2)
    expect(await page.$$('.gb-risk .gr-progress')).toHaveLength(0)
    await close()
  })

  it('全部平仓武装：确认条前带后果「4 个持仓，实盘 3」', async () => {
    const { page, close } = await open('pending')
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    await page.waitForSelector('.gb-risk .gb-takeover__hint')
    expect(await tc(page, '.gb-risk .gb-takeover__hint')).toBe('4 个持仓，实盘 3')
    await page.keyboard.press('Escape')
    await close()
  })
})

d('手机与切换', () => {
  it('390：队列行 ≥ 44；切回 1440 后卡头计数仍挂在壳的卡头槽里（槽重建后现找）', async () => {
    const { page, close } = await open('pending', 390, 844)
    const h = await page.$eval('[data-act="queue-pick"]', (e: Element) => e.getBoundingClientRect().height)
    expect(h).toBeGreaterThanOrEqual(44)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(600)
    expect(await page.$('[data-card="pending"] .gr-tile-p__slot .gb-head__n')).not.toBeNull()
    expect(await page.$('[data-card="agents"] .gr-tile-p__slot .gb-head__n')).not.toBeNull()
    expect(await head(page, 'pending')).toBe('待批 2')
    await close()
  })
})
