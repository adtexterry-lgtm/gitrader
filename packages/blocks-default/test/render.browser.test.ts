// SPDX-License-Identifier: CPAL-1.0
// 真渲染：把壳（含四个块）构建出来，起夹具内核，用无头 Edge 逐个场景看 DOM——空态 / 有数据 / 待批 / 已停止 / 读取失败；
// 来源筛选、实时事件、持仓事件链、批准 → PIN 弹层；夹具预览（块不连内核）；三档视口不溢出；视觉轮 r2 的 IXD §14 验收断言（流程 1 / 3 / 4 / 5 / 8 / 9 的 3–5）。
// 不弹可见窗口，只关自己起的浏览器与服务。找不到无头浏览器时本文件整体失败（不静默跳过）；确实没有浏览器的机器设 GITRADER_SKIP_BROWSER=1 并在回报里写明没验。
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { O_CLAUDE, entry, scenario } from '../fixtures/scenarios'
import { activityOf, filterActivity, normalizeLedger } from '../src/model-activity'

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

interface OpenOpts {
  /** 夹具内核的故障注入（fixtures/install.ts 的 Faults），load() 之后生效。 */
  fault?: Record<string, unknown>
  /** load() 之后改场景数据（到期时间、授权书状态、预算…）。 */
  patch?: (st: Any) => void
  /** 在页面与夹具内核之间代理 WebSocket，cut() 断开并拒绝重连（客户端停在「重连中」）。 */
  net?: boolean
  /** false = 不等骨架消失（看骨架本身）。 */
  ready?: boolean
}
const open = async (name: string, w = 1440, h = 900, o: OpenOpts = {}): Promise<{ page: Any; close(): Promise<void>; cut(): Promise<void>; restore(): void; connAt(): number }> => {
  stage.stage.load(name)
  stage.stage.calls.length = 0 // 每个用例只看自己发出的命令
  if (o.fault) Object.assign(stage.stage.fault, o.fault)
  o.patch?.(stage.stage)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const net = { cut: false, socks: [] as Any[], connAt: 0 }
  if (o.net) await ctx.routeWebSocket(/\/ui$/, (ws: Any) => { if (net.cut) { void ws.close(); return } net.connAt = Date.now(); net.socks.push(ws.connectToServer(), ws) })
  const page = await ctx.newPage()
  page.on('console', (m: Any) => { if (m.type() === 'error' && !(o.net && net.cut && /WebSocket/.test(m.text()))) errors.push(`[${name} ${w}] ${m.text()}`) })
  page.on('pageerror', (e: Any) => errors.push(`[${name} ${w}] pageerror ${e.message}`))
  await page.goto(stage.url, { waitUntil: 'load' })
  await page.waitForFunction(() => (window as Any).__GR_READY__?.online === true, null, { timeout: 8000 })
  await page.waitForSelector('.gb-pos, .gb-agent, .gb-risk, .gb-sb', { state: 'attached', timeout: 8000 }) // 手机视图里持仓 / 风险折成摘要行，块在但不一定可见
  if (o.ready !== false) {
    await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, null, { timeout: 8000 })
    await page.waitForTimeout(300)
  }
  const cut = async () => { net.cut = true; for (const s of net.socks.splice(0)) { try { await s.close() } catch { /* 已关闭 */ } } }
  return { page, close: () => ctx.close(), cut, restore: () => { net.cut = false }, connAt: () => net.connAt }
}
const text = (page: Any, sel: string): Promise<string> => page.$eval(sel, (e: Element) => (e as HTMLElement).innerText).catch(() => '')
/** r4（C2）：总览条数字是 RollingNumber（读屏文本在绝对定位的隐藏段里，innerText 会被拆行），按 textContent 读并收空白。 */
const tc = (page: Any, sel: string): Promise<string> => page.$eval(sel, (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).catch(() => '')
/** r4（C2）：一个容器的各子元素文本（总览条各段之间没有空白字符，按段比）。 */
const parts = (page: Any, sel: string): Promise<string[]> => page.$eval(sel, (e: Element) => [...e.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())).catch(() => [])
const ticket =(page: Any): Promise<string | null> => page.$eval('.gb-pend', (e: Element) => e.getAttribute('data-ticket')).catch(() => null)
const calls = (action: string): Any[] => stage.stage.calls.filter((c: Any) => c.action === action)
const disabled = (page: Any, sel: string): Promise<boolean> => page.$eval(sel, (e: Element) => (e as HTMLButtonElement).disabled)
const activeAct = (page: Any): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-act') ?? null)

beforeAll(async () => {
  if (!haveBrowser) {
    if (skip) return
    throw new Error(`找不到无头浏览器（Edge: ${mod.EDGE}；playwright-core: ${mod.PW}）。用 GITRADER_EDGE / GITRADER_PLAYWRIGHT 指过去；确实没有就设 GITRADER_SKIP_BROWSER=1 并在回报里写明没验。`)
  }
  stage = await mod.startStage('normal')
  browser = await mod.launchBrowser()
})
afterAll(async () => {
  try { await browser?.close() } catch { /* 已关闭 */ }
  await stage?.close()
  expect(errors, '控制台错误').toEqual([])
})

d('渲染状态', () => {
  it('空态：持仓插画 + 一句话；Agent 没接入；风险正常；今日盈亏 0.00 不着色', async () => {
    const { page, close } = await open('empty')
    // r4（VISUAL §4 空态）：卡内左上一行字，不画图标格
    expect(await text(page, '.gb-pos__empty')).toBe('当前没有持仓')
    expect(await page.$$('.gb-pos .gr-empty__art')).toHaveLength(0)
    // r4（C2，IA §2.1）：权益搬到总览条；只有纸面账户时主数就是纸面权益，今日 0.00 不着色
    expect(await parts(page, '.gb-sb__eq[data-mode="paper"]')).toEqual(['纸面权益', '10,000.00', 'USDC'])
    const pnlClass = await page.$eval('.gb-sb__today .gb-sb__mid', (e: Element) => e.className)
    expect(await tc(page, '.gb-sb__today .gb-sb__mid')).toBe('0.00')
    expect(pnlClass).not.toMatch(/gr-(up|down)\b/)
    expect(await text(page, '.gb-agent[data-view="keys"]')).toContain('还没有 Agent 接入')
    // r2：空态按过滤维度一句话（IXD 流程 5），「全部」= 还没有动作
    expect(await text(page, '.gb-agent__feed')).toContain('还没有动作')
    expect(await text(page, '.gb-state')).toBe('正常交易')
    expect(await page.$$('.gb-pend')).toHaveLength(0)
    expect(await text(page, '.gb-sb')).toContain('纸面')
    await close()
  })

  it('有数据：持仓表八列数据、盈亏着色（0.00 不着色）、纸面强平价带 ≈、执行方带钥匙名', async () => {
    const { page, close } = await open('normal')
    const rows = await page.$$eval('.gb-table tbody tr[data-row]', (els: Element[]) => els.map((e) => e.textContent ?? ''))
    expect(rows).toHaveLength(4)
    expect(rows.join('|')).toContain('xyz:TSLA')
    // r4（C2，IA §2.1）：实盘与纸面分开、不相加（r2 是相加的 22,467.70 / +115.90）
    expect(await parts(page, '.gb-sb__eq[data-mode="live"]')).toEqual(['实盘权益', '12,480.20', 'USDC'])
    expect(await parts(page, '.gb-sb__lead .gb-sb__today')).toEqual(['今日', '+128.40', '+1.04%'])
    expect(await page.$eval('.gb-sb__lead .gb-sb__today .gb-sb__mid', (e: Element) => e.className)).toContain('gr-up')
    expect(await parts(page, '.gb-sb > .gb-sb__eq[data-mode="paper"]')).toEqual(['纸面', '9,987.50', '今日 −12.50'])
    // r4：列序 标的（含方向杠杆）· 数量 · 开仓价 · 标记价 · 未实现（+ROE）· 强平价（+距）· 止损 · 开仓方 · 动作，按 data-col 取格
    const cells = await page.$$eval('[data-row$="|hyperliquid:BTC|long"] td', (els: Element[]) => els.map((e) => [e.getAttribute('data-col'), (e.textContent ?? '').trim()]))
    expect(cells.map((c: string[]) => c[0])).toEqual(['sym', 'size', 'entry', 'mark', 'upnl', 'liq', 'sl', 'opener', 'act'])
    expect(Object.fromEntries(cells.slice(0, 8))).toEqual({ sym: 'BTC多 4×', size: '0.08', entry: '64,210.5', mark: '64,880.2', upnl: '+53.58+4.13%', liq: '52,110.0距 19.7%', sl: '未设', opener: 'LLM · Claude Code' })
    const tsla = await page.$eval('[data-row$="|hyperliquid:xyz:TSLA|long"] td[data-col="upnl"]', (e: Element) => e.className)
    expect(tsla).toContain('gr-flat')
    expect(await text(page, '[data-row$="|hyperliquid:SOL|long"]')).toContain('≈')
    expect(await text(page, '.gb-grp >> nth=1')).toContain('纸面账户')
    // r4（C2，IA §2.1）：网络项「测试网 已连接 42 ms」，预算 74% 正常时不上条（在网络卡里）；风险态在条上
    expect(await parts(page, '[data-act="network"]')).toEqual(['测试网', '已连接', '42 ms'])
    expect(await page.$('.gb-sb__budget')).toBeNull()
    expect(await tc(page, '.gb-sb__state')).toBe('正常交易')
    // r4（裁决 4）：杠杆 4 / 5 = 80% 在 ≥ 85% 之下，数字与细条同源都中性（r2 是 > 60% 转 warn）
    expect(await page.$eval('[data-limit="leverage"]', (e: Element) => e.getAttribute('data-tone'))).toBe('flat')
    expect(await page.$$('[data-limit]')).toHaveLength(5)
    // 总览条数字是里程表（RollingNumber，只滚变化位）：主数整数 + 小数、今日、纸面各一份
    expect(await page.$$('.gb-sb .gr-roll')).toHaveLength(4)
    await close()
  })

  it('待批：两张卡片按到期先后排，首张是唯一的主按钮；票号 / 倒计时 / 预检 / 理由都在', async () => {
    const { page, close } = await open('pending')
    // r4（C2，IA §2.3）：一次一张 + 卡底队列代替翻页，先看最急的那张，点队列行换到第二张；卡头计数 2
    expect(await page.$$eval('.gb-pend', (els: Element[]) => els.map((e) => e.getAttribute('data-ticket')))).toEqual(['T-20261010-0008'])
    expect(await tc(page, '[data-card="pending"] .gb-head__n')).toBe('2')
    expect(await page.$$('.gb-queue li[data-ticket]')).toHaveLength(1)
    expect(await page.$$('.gr-btn--primary')).toHaveLength(1)
    const first = await text(page, '.gb-pend')
    expect(first).toContain('卖出 2 ETH @ 3,190')
    expect(first).toMatch(/0[23]:\d\d/)
    expect(first).toContain('强平价')
    expect(first).toContain('3,890.5')
    expect(first).toContain('滑点')
    expect(first).toContain('保证金')
    expect(first).toContain('对冲 BTC 多头的相关风险')
    await page.click('.gb-queue [data-act="queue-pick"]')
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 3000 })
    const second = await text(page, '.gb-pend')
    // r4：界面规则行每行可见中点 ≤ 1，「 · 」写成「，」（ruleText 本身不变）
    expect(second).toContain('需人批准，上限 2,000 USDC，实际 32,105 USDC')
    expect(await page.$$eval('.gb-queue li[data-ticket]', (els: Element[]) => els.map((e) => e.getAttribute('data-ticket')))).toEqual(['T-20261010-0008'])
    expect(await tc(page, '[data-card="pending"] .gb-head__n')).toBe('2')
    await close()
  })

  it('已停止：红色状态、原因映射成人话且保留悬停原文、有恢复交易按钮；状态条同步', async () => {
    const { page, close } = await open('halted')
    expect(await page.$eval('.gb-risk', (e: Element) => e.getAttribute('data-state'))).toBe('HALTED')
    expect(await text(page, '.gb-state')).toBe('已停止')
    expect(await text(page, '.gb-risk__reason')).toBe('全部平仓：人在检阅面触发')
    expect(await page.$eval('.gb-risk__reason', (e: Element) => e.getAttribute('title'))).toBe('takeover flatten_all: 人在检阅面触发')
    expect(await text(page, '.gb-risk__head')).toContain('恢复交易')
    expect(await text(page, '.gb-sb__state')).toBe('已停止 · 全局') // D5（维护者裁决）：状态条状态字后带作用域（useStatus），全局停机 = 「已停止 · 全局」
    await close()
  })

  it('读取失败：三个块都显示内核的话（原样）和重试，没有白屏', async () => {
    const { page, close } = await open('error')
    for (const sel of ['.gb-pos', '.gb-agent', '.gb-risk']) {
      const t = await text(page, sel)
      expect(t, sel).toContain('读取失败')
      expect(t, sel).toContain('内核暂时读不到这份数据（演示用的读取失败场景）')
    }
    // 修复轮 1 · C1：内核在线、只是读不到 → 状态条也照内核原文说，不自拟「内核未连接」（G4 / F8-1；内核真断开的情形见 8-1）
    expect(await text(page, '.gb-sb')).toContain('内核暂时读不到这份数据（演示用的读取失败场景）')
    expect(await text(page, '.gb-sb')).not.toContain('内核未连接')
    await close()
  })
})

d('来源筛选', () => {
  it('人 / 引擎 / LLM Agent / 系统：每一档的条数与逻辑一致，LLM 条目都带固定标记', async () => {
    const { page, close } = await open('normal')
    const items = activityOf(normalizeLedger(scenario('normal').ledger))
    const count = () => page.$$eval('.gb-ev', (e: Element[]) => e.length)
    expect(await count()).toBe(items.length)
    for (const f of ['human', 'engine', 'llm-agent', 'system'] as const) {
      await page.click(`.gb-agent__filter [data-v="${f}"]`)
      await page.waitForTimeout(80)
      expect(await count(), f).toBe(filterActivity(items, f).length)
    }
    await page.click('.gb-agent__filter [data-v="llm-agent"]')
    await page.waitForTimeout(80)
    const marks = await page.$$eval('.gb-ev', (els: Element[]) => els.map((e) => [e.getAttribute('data-llm'), (e.querySelector('.gr-actor') as HTMLElement | null)?.innerText ?? '']))
    expect(marks.length).toBeGreaterThan(0)
    for (const [llm, who] of marks) { expect(llm).toBe('1'); expect(who).toMatch(/^LLM/) }
    await page.click('.gb-agent__filter [data-v="all"]')
    await page.waitForTimeout(80)
    expect(await count()).toBe(items.length)
    await close()
  })

  it('每条：谁 · 做了什么 · 为什么 · 结果 · 撞了哪条规则', async () => {
    const { page, close } = await open('normal')
    // r2：理由与上游原文点开才显示（PLAN ⑪ / IXD 流程 5-3），先把可展开的条目都点开
    for (const h of await page.$$('.gb-ev > button.gb-ev__head')) await h.click()
    const t: string[] = await page.$$eval('.gb-ev', (els: Element[]) => els.map((e) => (e as HTMLElement).innerText))
    const blocked = t.find((x) => x.includes('提交订单 买入 40 SOL @ 150'))!
    expect(blocked).toContain('LLM · Hermes')
    expect(blocked).toContain('被拦截')
    expect(blocked).toContain('情绪面转多，试探性建仓')
    expect(blocked).toContain('大模型实盘开仓保护，上限 0，实际 1') // r4：界面每行中点 ≤ 1（ruleText 不变）
    const venueText = t.find((x) => x.includes('订单被拦截'))!
    expect(venueText).toContain('live entries originating from an LLM agent are denied by policy')
    await close()
  })
})

d('实时更新（事件）', () => {
  it('新账本条目、新提案、提案被决定、持仓变化、风控状态变化都实时反映', async () => {
    const { page, close } = await open('normal')
    const st = stage.stage
    const before = await page.$$eval('.gb-ev', (e: Element[]) => e.length)
    st.emitLedger(entry(5000, 'note', O_CLAUDE, { orgId: 'org_local' as never }, { text: '实时事件：先看一会儿' }, Date.now()))
    await page.waitForFunction((n: number) => document.querySelectorAll('.gb-ev').length === n + 1, before, { timeout: 3000 })
    await page.click('.gb-ev >> nth=0 >> .gb-ev__head') // r2：笔记正文是「理由」，点开才显示
    expect(await text(page, '.gb-ev')).toContain('实时事件：先看一会儿')

    // 新提案 → 待批出现
    const p = scenario('pending').proposals[0]!
    stage.kernel.publish('proposal.created', p)
    await page.waitForSelector('.gb-pend', { timeout: 3000 })
    stage.kernel.publish('proposal.decided', { ...p, status: 'rejected' })
    await page.waitForFunction(() => document.querySelectorAll('.gb-pend').length === 0, null, { timeout: 3000 })

    // 持仓变了
    const btc = { ...(scenario('normal').positions[(scenario('normal').accounts[0] as Any).accountId]![0] as Any), size: '0.5', notional: '32440.1' }
    stage.kernel.publish('account.positions', { accountId: (scenario('normal').accounts[0] as Any).accountId, positions: [btc] })
    await page.waitForFunction(() => document.querySelector('[data-row$="|hyperliquid:BTC|long"] td[data-col="size"]')?.textContent === '0.5', null, { timeout: 3000 })
    expect(await page.$$('.gb-table tbody tr[data-row]')).toHaveLength(2)

    // 风控状态：内核推 risk.state，块重新读
    st.tradingState = 'REDUCING'
    stage.kernel.publish('risk.state', { scope: { type: 'org' }, to: 'REDUCING' })
    await page.waitForFunction(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'REDUCING', null, { timeout: 3000 })
    expect(await text(page, '.gb-state')).toBe('只减仓')
    await close()
  })
})

d('持仓事件链', () => {
  it('点一行展开：持仓 → 成交 → 提案 → 来源；再点收起', async () => {
    const { page, close } = await open('normal')
    await page.click('[data-row$="|hyperliquid:BTC|long"]')
    await page.waitForSelector('.gb-chain__step.is-origin', { timeout: 4000 })
    const kinds = await page.$$eval('.gb-chain__step', (els: Element[]) => els.map((e) => /is-(\w+)/.exec(e.className)?.[1]))
    expect(kinds[0]).toBe('position')
    expect(kinds.at(-1)).toBe('origin')
    expect(kinds).toContain('fill')
    expect(kinds).toContain('proposal')
    const chain = await text(page, '.gb-chain')
    expect(chain).toContain('LLM · Claude Code')
    expect(chain).toContain('提案 T-20261010-0006 已执行')
    await page.click('[data-row$="|hyperliquid:BTC|long"]')
    expect(await page.$$('.gb-chain')).toHaveLength(0)
    // r2：键盘 Space 也能展开（IXD 12.2）
    await page.focus('[data-row$="|hyperliquid:BTC|long"]')
    await page.keyboard.press('Space')
    await page.waitForSelector('.gb-chain', { timeout: 3000 })
    await close()
  })
})

d('PIN 流程（真壳的 PIN 弹层 + 假内核）', () => {
  it('批准提案：先无证明，内核要证明，弹层输入错的 PIN 看到上游原文，再输对，卡片消失', async () => {
    const { page, close } = await open('pending')
    const st = stage.stage
    expect(await ticket(page)).toBe('T-20261010-0008')
    await page.click('[data-act="approve"]')
    await page.waitForSelector('.gr-pin')
    expect(await page.$eval('.gr-pin input', (e: Element) => (e as HTMLInputElement).type)).toBe('password')
    await page.fill('.gr-pin input', '111111')
    await page.click('.gr-pin .gr-btn--primary')
    // IXD 流程 2-2：错 PIN 弹层不关（SDK attestor 重试回路），内核原文在弹层里，输入框清空并留着焦点；同一个弹层里再输对
    await page.waitForFunction(() => /PIN 不对/.test(document.querySelector('.gr-pin')?.textContent ?? ''), null, { timeout: 4000 })
    expect(await page.$eval('.gr-pin input', (e: Element) => (e as HTMLInputElement).value)).toBe('')
    expect(await page.evaluate(() => document.activeElement === document.querySelector('.gr-pin input'))).toBe(true)
    await page.fill('.gr-pin input', mod.PIN)
    await page.click('.gr-pin .gr-btn--primary')
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 5000 })
    const approves = st.calls.filter((c: Any) => c.action === 'proposal.approve')
    expect(approves.map((c: Any) => c.attested)).toEqual([false, true, true])
    expect(await page.evaluate(() => document.body.innerHTML.includes('246810'))).toBe(false)
    await close()
  })

  it('PIN 层点取消：命令没有发生，界面没有错误提示', async () => {
    const { page, close } = await open('pending')
    await page.click('[data-act="approve"]')
    await page.waitForSelector('.gr-pin')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 3000 })
    await page.waitForTimeout(200)
    // r2：一次一张——还是那一张、还是待批
    expect(await page.$$('.gb-pend')).toHaveLength(1)
    expect(await ticket(page)).toBe('T-20261010-0008')
    expect(await page.$eval('.gb-pend', (e: Element) => e.getAttribute('data-result'))).toBeNull()
    expect(await page.$$('.gr-toast[data-kind="err"]')).toHaveLength(0)
    await close()
  })

  it('状态条接管 → 全部平仓 → 行内确认 → PIN → 风险块变已停止', async () => {
    const { page, close } = await open('normal')
    await page.click('[data-act="takeover"]')
    await page.waitForSelector('.gb-tkcard')
    await page.click('.gb-tkcard [data-act="takeover-flatten_all"]')
    // r2：就地确认 G2 的 600 ms 死区（IXD 流程 3-2）——武装后等一会儿再点确认
    await page.waitForTimeout(650)
    await page.click('.gb-tkcard [data-act="takeover-flatten_all-confirm"]')
    await page.waitForSelector('.gr-pin')
    await page.fill('.gr-pin input', mod.PIN)
    await page.click('.gr-pin .gr-btn--primary')
    await page.waitForFunction(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'HALTED', null, { timeout: 5000 })
    expect(await text(page, '.gb-sb__state')).toBe('已停止')
    await close()
  })

  it('大模型实盘开仓保护：关闭要 PIN，关掉后开关为关；再打开不要 PIN', async () => {
    const { page, close } = await open('normal')
    const sw = '.gb-guard [role="switch"]'
    expect(await page.$eval(sw, (e: Element) => e.getAttribute('aria-checked'))).toBe('true')
    await page.click(sw)
    await page.waitForSelector('.gr-pin')
    await page.fill('.gr-pin input', mod.PIN)
    await page.click('.gr-pin .gr-btn--primary')
    await page.waitForFunction((s: string) => document.querySelector(s)?.getAttribute('aria-checked') === 'false', sw, { timeout: 4000 })
    await page.click(sw)
    await page.waitForFunction((s: string) => document.querySelector(s)?.getAttribute('aria-checked') === 'true', sw, { timeout: 4000 })
    expect(await page.$('.gr-pin')).toBeNull()
    await close()
  })
})

d('夹具预览（块不连内核）', () => {
  it('四个块都能用回放文件独立渲染，并随回放事件更新', async () => {
    const { js, css } = await mod.bundlePreview()
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 } })
    const page = await ctx.newPage()
    page.on('pageerror', (e: Any) => errors.push(`[preview] pageerror ${e.message}`))
    page.on('console', (m: Any) => { if (m.type() === 'error') errors.push(`[preview] ${m.text()}`) })
    const appCss = await (await import('node:fs/promises')).readFile(`${stage.dist}/app.css`, 'utf8')
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${appCss}\n${css}</style></head><body><div class="gr-tile-p__body" id="root" style="width:900px;height:560px;display:flex;flex-direction:column;background:var(--gr-panel)"></div></body></html>`)
    await page.addScriptTag({ content: js })
    const mount = async (id: string) => { await page.evaluate((x: string) => { const r = document.getElementById('root') as HTMLElement; r.innerHTML = ''; (window as Any).mountPreview(x, r) }, id); await page.waitForTimeout(250) }

    await mount('block.gitrader.positions')
    await page.waitForSelector('.gb-table tbody tr[data-row]')
    expect(await text(page, '.gb-pos')).toContain('xyz:TSLA')
    // r4（C2）：权益不在持仓卡里了，见下面总览条的 12,480.20

    await mount('block.gitrader.agent-activity')
    await page.waitForSelector('.gb-ev')
    const n0 = await page.$$eval('.gb-ev', (e: Element[]) => e.length)
    // r4（C2）：待批一次一张 + 卡底队列（全量视图里卡头就地渲染「待批 2」）
    expect(await page.$$('.gb-pend')).toHaveLength(1)
    expect(await parts(page, '.gb-agent__pend .gb-head')).toEqual(['待批', '2'])
    expect(await page.$$('.gb-queue li[data-ticket]')).toHaveLength(1)
    await page.waitForFunction((n: number) => document.querySelectorAll('.gb-ev').length === n + 1, n0, { timeout: 4000 })
    await page.click('.gb-ev >> nth=0 >> .gb-ev__head')
    expect(await text(page, '.gb-ev')).toContain('回放中的新动作')
    // 档位菜单（Radix DropdownMenu，经 preact/compat）在离线预览里也能打开
    await page.click('.gb-tierbtn >> nth=0')
    await page.waitForSelector('[role="menuitemradio"]', { timeout: 3000 })
    await page.keyboard.press('Escape')

    await mount('block.gitrader.risk')
    await page.waitForSelector('.gb-limit')
    expect(await text(page, '.gb-state')).toBe('正常交易')
    expect(await page.$$('[data-limit]')).toHaveLength(5)

    await mount('block.gitrader.statusbar')
    await page.waitForSelector('.gb-sb')
    expect(await text(page, '.gb-sb')).toContain('测试网')
    // r4（C2）：总览条的实盘权益（权益从持仓卡搬到这里）；网络项的延迟随回放事件 42 → 37
    await page.waitForFunction(() => (document.querySelector('.gb-sb__eq[data-mode="live"]')?.textContent ?? '').includes('12,480.20'), null, { timeout: 5000 })
    await page.waitForFunction(() => /37\s*ms/.test(document.querySelector('.gb-sb [data-act="network"]')?.textContent ?? ''), null, { timeout: 5000 })
    await ctx.close()
  })
})

d('三档视口', () => {
  it.each([[1440, 900], [1200, 800], [900, 900]])('%i×%i：无页面滚动、块内容不横向溢出、没有读取失败', async (w: number, h: number) => {
    for (const name of ['normal', 'pending', 'halted']) {
      const { page, close } = await open(name, w, h)
      const s = await page.evaluate(() => { const se = document.scrollingElement as HTMLElement; return { v: se.scrollHeight - innerHeight, h: se.scrollWidth - innerWidth } })
      expect(s.v, `${name} 纵向`).toBeLessThanOrEqual(1)
      expect(s.h, `${name} 横向`).toBeLessThanOrEqual(1)
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.gr-tile-p, .gr-status')].filter((el) => el.scrollWidth > el.clientWidth + 2).map((el) => el.className))
      expect(clipped, `${name} 溢出`).toEqual([])
      expect(await page.evaluate(() => document.body.innerText.includes('读取失败')), `${name} 读取失败`).toBe(false)
      expect(await page.evaluate(() => /Comfy|WalletConnect|保守|激进|标准/.test(document.body.innerText))).toBe(false)
      await close()
    }
  })
})

// ---- 视觉轮 r2 · IXD §14 验收断言 ----------------------------------------------------------

d('IXD 流程 1 · 待批', () => {
  it('1-1 待批 1440：同时只渲染一张卡，批准恰 1 个且是主按钮，翻页器「1 / 2」', async () => {
    const { page, close } = await open('pending')
    expect(await page.$$('.gb-pend')).toHaveLength(1)
    const approve = await page.$$eval('[data-act="approve"]', (els: Element[]) => els.map((e) => e.classList.contains('gr-btn--primary')))
    expect(approve).toEqual([true])
    // r4（C2，IA §2.3）：翻页器「1 / 2」→ 卡头计数 2 + 队列 1 行
    expect(await tc(page, '[data-card="pending"] .gb-head__n')).toBe('2')
    expect(await page.$$('.gb-queue li[data-ticket]')).toHaveLength(1)
    // 卡上补「账户 · 实盘 / 纸面」（F1-3）
    expect(await text(page, '.gb-pend .gb-pend__acct')).toMatch(/测试网主账户[\s\S]*实盘/)
    await close()
  })

  it('1-2 停在第 1 张时插进一张更早到期的提案：可见卡不换，计数按 id 锚定变「2 / 3」', async () => {
    const { page, close } = await open('pending')
    expect(await ticket(page)).toBe('T-20261010-0008')
    const base = scenario('pending').proposals[1] as Any
    const fresh = { ...base, proposalId: 'prop_01JB00000000000000000000F1', ticket: 'T-20261010-0009', status: 'pending', expiresAt: Date.now() + 90_000 }
    stage.stage.sc.proposals.push(fresh)
    stage.kernel.publish('proposal.created', fresh)
    // r4（C2）：「2 / 3」→ 卡头计数 3、新提案只进队列（队列 2 行），可见卡不换
    await page.waitForFunction(() => (document.querySelector('[data-card="pending"] .gb-head__n')?.textContent ?? '').trim() === '3', null, { timeout: 3000 })
    expect(await page.$$('.gb-queue li[data-ticket]')).toHaveLength(2)
    expect(await ticket(page)).toBe('T-20261010-0008')
    expect(await page.$$('.gb-pend')).toHaveLength(1)
    await close()
  })

  it('1-3 可见卡被替换后 500 ms 内点批准：不发 proposal.approve；过了死区才发', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { approveNoPin: true } })
    expect(await ticket(page)).toBe('T-20261010-0008')
    await page.click('[data-act="reject"]')
    const swappedAt = await page.waitForFunction(() => (document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007' ? performance.now() : false), null, { timeout: 5000, polling: 'raf' }).then((h: Any) => h.jsonValue())
    const at = await page.$eval('[data-act="approve"]', (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    const n0 = calls('proposal.approve').length
    const clickAt = await page.evaluate(() => performance.now())
    await page.mouse.click(at.x, at.y)
    expect(clickAt - swappedAt).toBeLessThan(500)
    await page.waitForTimeout(700)
    expect(calls('proposal.approve')).toHaveLength(n0)
    // 死区只挡刚换上来的那一下：过了 500 ms 照常可批
    await page.click('[data-act="approve"]')
    await expect.poll(() => calls('proposal.approve').length, { timeout: 3000 }).toBe(n0 + 1)
    await close()
  })

  it('1-4 批准返回 status=failed：卡上「执行失败」+ 内核原文，不出「已批准」的成功提示，结果态不自动消失', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { approveNoPin: true, approveFails: 'price moved beyond bounds' } })
    await page.click('[data-act="approve"]')
    await page.waitForSelector('.gb-pend[data-result="failed"]', { timeout: 4000 })
    const t = await text(page, '.gb-pend[data-result="failed"]')
    expect(t).toContain('执行失败')
    expect(t).toContain('price moved beyond bounds')
    await page.waitForTimeout(1500)
    const oks: string[] = await page.$$eval('.gr-toast[data-kind="ok"]', (els: Element[]) => els.map((e) => e.textContent ?? ''))
    expect(oks.filter((x) => x.includes('已批准'))).toEqual([])
    expect(await page.$('.gb-pend[data-result="failed"]')).not.toBeNull()
    await page.click('[data-act="ack"]')
    await page.waitForFunction(() => !document.querySelector('.gb-pend[data-result]'), null, { timeout: 3000 })
    await close()
  })

  it('1-5 提案到期：倒计时「已过期」、两钮禁用，2 s 内从 DOM 移除', async () => {
    const { page, close } = await open('pending', 1440, 900, { patch: (st) => { st.sc.proposals[1].expiresAt = Date.now() + 4500 } })
    expect(await ticket(page)).toBe('T-20261010-0008')
    await page.waitForFunction(() => document.querySelector('.gb-pend__t')?.textContent === '已过期', null, { timeout: 8000 })
    const t0 = Date.now()
    expect(await disabled(page, '[data-act="approve"]')).toBe(true)
    expect(await disabled(page, '[data-act="reject"]')).toBe(true)
    await page.waitForFunction(() => !document.querySelector('[data-ticket="T-20261010-0008"]'), null, { timeout: 2500 })
    expect(Date.now() - t0).toBeLessThanOrEqual(2000)
    expect(await ticket(page)).toBe('T-20261010-0007')
    await close()
  })

  it('1-6 390×844：动作钮 ≥ 44 高、贴视口底；无横向溢出；卡上有实盘 / 纸面；断开内核 3 s 后两钮禁用并标「离线」', async () => {
    const { page, close, cut } = await open('pending', 390, 844, { net: true })
    for (const a of ['approve', 'reject']) {
      const r = await page.$eval(`[data-act="${a}"]`, (e: Element) => { const b = e.getBoundingClientRect(); return { h: b.height, gap: innerHeight - b.bottom } })
      expect(r.h, a).toBeGreaterThanOrEqual(44)
      expect(r.gap, a).toBeGreaterThanOrEqual(0)
      expect(r.gap, a).toBeLessThanOrEqual(16)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    expect(await text(page, '.gb-pend')).toMatch(/纸面|实盘/)
    await cut()
    await page.waitForTimeout(3100)
    expect(await disabled(page, '[data-act="approve"]')).toBe(true)
    expect(await disabled(page, '[data-act="reject"]')).toBe(true)
    expect(await text(page, '.gb-agent__pend')).toContain('离线')
    await close()
  })

  it('C2 可见卡被换掉后 500 ms 内列表变空（两张先后过期）：下一张新提案的批准 / 拒绝 1 s 内可点（死区不卡住）', async () => {
    const { page, close } = await open('pending')
    expect(await ticket(page)).toBe('T-20261010-0008')
    const byTicket = (t: string): Any => stage.stage.sc.proposals.find((p: Any) => p.ticket === t)
    const expire = (p: Any): void => {
      const x = { ...p, status: 'expired' }
      stage.stage.sc.proposals = stage.stage.sc.proposals.map((q: Any) => (q.proposalId === p.proposalId ? x : q))
      stage.kernel.publish('proposal.expired', x)
    }
    const p8 = byTicket('T-20261010-0008')
    const p7 = byTicket('T-20261010-0007')
    expire(p8)
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 3000, polling: 'raf' })
    expire(p7) // 换卡后立刻（远在 500 ms 死区之内）列表变空
    await page.waitForFunction(() => !document.querySelector('.gb-pend'), null, { timeout: 3000 })
    await page.waitForTimeout(600)
    const fresh = { ...p7, proposalId: 'prop_01JB00000000000000000000C2', ticket: 'T-20261010-0010', status: 'pending', expiresAt: Date.now() + 5 * 60_000 }
    stage.stage.sc.proposals.push(fresh)
    stage.kernel.publish('proposal.created', fresh)
    await page.waitForSelector('.gb-pend[data-ticket="T-20261010-0010"]', { timeout: 3000 })
    await expect.poll(() => page.$eval('[data-act="approve"]', (e: Element) => e.getAttribute('aria-disabled')), { timeout: 1000 }).toBeNull()
    expect(await page.$eval('[data-act="reject"]', (e: Element) => e.getAttribute('aria-disabled'))).toBeNull()
    await close()
  })
})

d('IXD 流程 3 · 接管', () => {
  it('3-1 点全部平仓：原地出「确认平仓」+ 取消，取消在前，焦点落取消', async () => {
    const { page, close } = await open('normal')
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    await page.waitForSelector('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    expect(await page.$eval('.gb-risk [data-act="takeover-flatten_all-confirm"]', (e: Element) => e.textContent)).toBe('确认平仓')
    const cancelFirst = await page.evaluate(() => {
      const c = document.querySelector('.gb-risk [data-act="takeover-flatten_all-cancel"]')
      const k = document.querySelector('.gb-risk [data-act="takeover-flatten_all-confirm"]')
      return !!c && !!k && !!(c.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(cancelFirst).toBe(true)
    expect(await activeAct(page)).toBe('takeover-flatten_all-cancel')
    await close()
  })

  it('3-2 武装后 300 ms 点确认不发；连发回车（第二次 repeat）不发；800 ms 后点确认才发', async () => {
    const { page, close } = await open('normal', 1440, 900, { fault: { flattenNoPin: true } })
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    const t0 = Date.now()
    await page.waitForTimeout(300)
    await page.click('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    expect(calls('takeover.flatten_all')).toHaveLength(0)
    await page.focus('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter') // playwright：键没松开再按 = repeat:true
    await page.keyboard.up('Enter')
    await page.waitForTimeout(150)
    expect(calls('takeover.flatten_all')).toHaveLength(0)
    await page.waitForTimeout(Math.max(0, 800 - (Date.now() - t0)))
    await page.click('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    await page.waitForFunction(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'HALTED', null, { timeout: 4000 })
    expect(calls('takeover.flatten_all')).toHaveLength(1)
    await close()
  })

  it('3-3 指针悬停在确认组上 7 s 不失效；移开后 5 s 内复原，焦点回到全部平仓', async () => {
    const { page, close } = await open('normal')
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    await page.waitForSelector('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    await page.hover('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    await page.waitForTimeout(7000)
    expect(await page.$('.gb-risk [data-act="takeover-flatten_all-confirm"]')).not.toBeNull()
    expect(await activeAct(page)).toBe('takeover-flatten_all-cancel')
    await page.mouse.move(4, 4)
    await page.waitForSelector('.gb-risk [data-act="takeover-flatten_all"]', { timeout: 5500 })
    expect(await activeAct(page)).toBe('takeover-flatten_all')
    await close()
  })

  it('3-4 执行中：确认组里没有取消钮；风险块与状态条卡内的接管钮全部禁用', async () => {
    const { page, close } = await open('normal', 1440, 900, { fault: { delayMs: { 'takeover.halt_new': 2500 } } })
    await page.click('[data-act="takeover"]')
    await page.waitForSelector('.gb-tkcard [data-act="takeover-halt_new"]')
    await page.click('.gb-tkcard [data-act="takeover-halt_new"]')
    await page.waitForTimeout(650)
    await page.click('.gb-tkcard [data-act="takeover-halt_new-confirm"]')
    await page.waitForSelector('.gb-tkcard [data-act="takeover-halt_new-confirm"].is-busy', { timeout: 2000 })
    expect(await page.$('.gb-tkcard [data-act="takeover-halt_new-cancel"]')).toBeNull()
    const states: Array<[string | null, boolean]> = await page.$$eval('.gb-risk [data-act^="takeover-"], .gb-tkcard [data-act^="takeover-"]', (els: Element[]) => els.map((e) => [e.getAttribute('data-act'), (e as HTMLButtonElement).disabled] as const))
    expect(states.length).toBeGreaterThanOrEqual(6)
    expect(states.filter(([, dis]) => !dis)).toEqual([])
    await page.waitForFunction(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'REDUCING', null, { timeout: 6000 })
    await close()
  })

  it('3-5 内核回 ok:false + remaining：风险块常驻「未完成」红条带标的，不出成功提示，状态仍是只减仓', async () => {
    const { page, close } = await open('normal', 1440, 900, { fault: { flattenNoPin: true, flattenLeft: [{ instrumentId: 'hyperliquid:ETH', size: '1.2' }] } })
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    await page.waitForTimeout(650)
    await page.click('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    await page.waitForSelector('.gb-risk__alert', { timeout: 4000 })
    const alert = await text(page, '.gb-risk__alert')
    expect(alert).toContain('未完成')
    expect(alert).toContain('ETH')
    await page.waitForTimeout(500)
    const toasts: string[] = await page.$$eval('.gr-toast', (els: Element[]) => els.map((e) => e.textContent ?? ''))
    expect(toasts.filter((x) => /已发出全部平仓|已全部平仓/.test(x))).toEqual([])
    expect(await page.$eval('.gb-risk', (e: Element) => e.getAttribute('data-state'))).toBe('REDUCING')
    await close()
  })

  it('3-6 活动流：takeover.requested 的结果是「已发出」，takeover.completed 存在且为「已完成」', async () => {
    const { page, close } = await open('normal')
    await page.click('.gb-risk [data-act="takeover-halt_new"]')
    await page.waitForTimeout(650)
    await page.click('.gb-risk [data-act="takeover-halt_new-confirm"]')
    await page.waitForSelector('.gb-ev[data-type="takeover.completed"]', { timeout: 4000 })
    expect(await text(page, '.gb-ev[data-type="takeover.requested"] .gb-ev__res')).toBe('已发出')
    expect(await text(page, '.gb-ev[data-type="takeover.completed"] .gb-ev__res')).toBe('已完成')
    await close()
  })

  it('C4 / C6 武装后断线：就地确认立即解除武装、触发钮禁用，焦点不落到 body；风险块头与钥匙行就地写「离线」', async () => {
    const { page, close, cut } = await open('normal', 1440, 900, { net: true })
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    await page.waitForSelector('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    await page.hover('.gb-risk [data-act="takeover-flatten_all-confirm"]') // 悬停暂停 5 s 闲置计时：这里只看断线
    await cut()
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-offline'), null, { timeout: 6000 })
    await page.waitForTimeout(200)
    expect(await page.$('.gb-risk [data-act="takeover-flatten_all-confirm"]')).toBeNull()
    expect(await disabled(page, '.gb-risk [data-act="takeover-flatten_all"]')).toBe(true)
    expect(await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true)
    expect(await text(page, '.gb-risk__head')).toContain('离线')
    expect(await text(page, '.gb-agent[data-view="keys"] .gb-agent__keys')).toContain('离线') // r4：三实例，Agent 卡
    await close()
  })

  it('C8 命令面板发出的接管执行中：风险块三档与状态条「接管」都禁用（壳的 <html data-takeover-busy>），落定后恢复', async () => {
    const { page, close } = await open('normal', 1440, 900, { fault: { delayMs: { 'takeover.halt_new': 2500 } } })
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    await page.keyboard.type('停止')
    await page.waitForFunction(() => document.querySelector('.gr-palette [data-cmd]')?.getAttribute('data-cmd') === 'agent:halt_new', null, { timeout: 2000 })
    await page.keyboard.press('Enter')
    await page.waitForSelector('.gr-palette__item.is-armed')
    await page.waitForTimeout(700)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-takeover-busy'), null, { timeout: 3000 })
    await page.waitForTimeout(150)
    const tk = () => page.$$eval('.gb-risk [data-act^="takeover-"]', (els: Element[]) => els.map((e) => (e as HTMLButtonElement).disabled))
    expect(await tk()).toEqual([true, true, true])
    expect(await disabled(page, '[data-act="takeover"]')).toBe(true)
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-takeover-busy'), null, { timeout: 6000 })
    await page.waitForTimeout(150)
    expect(await tk()).toEqual([false, false, false])
    expect(await disabled(page, '[data-act="takeover"]')).toBe(false)
    expect(calls('takeover.halt_new')).toHaveLength(1)
    await close()
  })
})

d('IXD 流程 4 · 档位', () => {
  it('4-1 档位菜单：三个 menuitemradio（只读 / 纸面 / 需确认），当前项打勾；「限额自动…」灰着带「需授权单」', async () => {
    const { page, close } = await open('normal')
    await page.click('.gb-tierbtn >> nth=0')
    await page.waitForSelector('[role="menuitemradio"]')
    const radios = await page.$$eval('[role="menuitemradio"]', (els: Element[]) => els.map((e) => [e.textContent, e.getAttribute('aria-checked')]))
    expect(radios).toEqual([['只读', 'false'], ['纸面', 'false'], ['需确认', 'true']])
    const auto = await page.$$eval('[role="menuitem"]', (els: Element[]) => els.map((e) => [e.textContent ?? '', e.getAttribute('aria-disabled')]).filter(([t]) => (t as string).includes('限额自动')))
    expect(auto).toHaveLength(1)
    expect(auto[0]![0]).toContain('需授权单')
    expect(auto[0]![1]).toBe('true')
    await close()
  })

  it('4-2 键盘：聚焦档位钮 → Enter → ↓ → Enter，弹出 PIN 且标题含「改档位」', async () => {
    const { page, close } = await open('normal')
    await page.focus('.gb-tierbtn >> nth=0')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[role="menu"]', { state: 'visible' })
    await page.waitForFunction(() => !!document.activeElement?.closest('[role="menu"]'), null, { timeout: 4000 }) // Radix 下一帧才把焦点移进菜单
    // 修复轮 1 · G2 定位：菜单刚挂上的那一帧（入场动画 t=0）Radix 还没登记菜单项，这时按 ↓ 是空操作（焦点留在菜单本身），接着 Enter 什么也不选，
    // PIN 永远不来——探针实测「焦点一进菜单就按 ↓」3 次里 1 次被吞，负载下更常见；等入场动画结束再按 3/3 正常。人不会在第一帧里按键，所以等动画是对的。
    await page.waitForFunction(() => { const m = document.querySelector('[role="menu"]'); return !!m && m.getAnimations({ subtree: true }).every((a) => a.playState !== 'running') }, null, { timeout: 4000 })
    // 当前档位（需确认）是最后一个可用项、打勾；焦点打开时落在菜单本身（键盘打开时也可能直接落到某一项，指针碰过就会落到指针下那项）
    expect(await page.$eval('[role="menuitemradio"][aria-checked="true"]', (e: Element) => e.textContent)).toBe('需确认')
    // ↓ 之后先等焦点真的落到一个「没打勾」的单选项上再按 Enter：Radix 的漫游焦点在 setTimeout 里移焦点，负载下回车可能先到；
    // 落在当前档位上回车 = 选当前项 = 无事发生（IXD 流程 4 步骤 2）。落在当前项上就再 ↓ 一次（菜单循环，「限额自动…」禁用不可聚焦）。
    const focused = () => page.evaluate(() => { const a = document.activeElement; return { role: a?.getAttribute('role') ?? null, v: a?.getAttribute('data-v') ?? null, checked: a?.getAttribute('aria-checked') ?? null, t: a?.textContent ?? '' } })
    let target = ''
    for (let i = 0; i < 3 && !target; i += 1) {
      const before = await focused()
      await page.keyboard.press('ArrowDown')
      const moved = await page.waitForFunction((b: string | null) => { const a = document.activeElement; return a?.getAttribute('role') === 'menuitemradio' && a.getAttribute('data-v') !== b }, before.v, { timeout: 4000 }).then(() => true, () => false)
      const f = await focused()
      expect(moved, `第 ${i + 1} 次 ↓：之前 ${JSON.stringify(before)} → 之后 ${JSON.stringify(f)}`).toBe(true)
      if (f.checked === 'false') target = f.t
    }
    expect(['只读', '纸面']).toContain(target)
    await page.keyboard.press('Enter')
    await page.waitForSelector('.gr-pin', { timeout: 8000 })
    const pin = await text(page, '.gr-pin')
    expect(pin).toContain('改档位')
    expect(pin).toContain(`→ ${target}`)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 3000 })
    await close()
  })

  it('4-3 已停止时档位钮禁用（aria-disabled），点它不开菜单、不发 mandate.update', async () => {
    const { page, close } = await open('halted')
    const st = await page.$eval('.gb-tierbtn', (e: Element) => [e.getAttribute('aria-disabled'), (e as HTMLButtonElement).disabled])
    expect(st[0] === 'true' || st[1] === true).toBe(true)
    await page.click('.gb-tierbtn >> nth=0', { force: true })
    await page.waitForTimeout(400)
    expect(await page.$('[role="menuitemradio"]')).toBeNull()
    expect(calls('mandate.update')).toHaveLength(0)
    await close()
  })

  it('4-4 授权书 status=expired：档位钮写「已到期」', async () => {
    const { page, close } = await open('normal', 1440, 900, { patch: (st) => { st.sc.mandates[0].status = 'expired' } })
    expect((await page.$$eval('.gb-tierbtn', (els: Element[]) => els.map((e) => e.textContent ?? '')))[0]).toContain('已到期')
    await close()
  })

  it('4-5 内核拒绝改档：该钥匙行下出现原文，档位钮回到原档位', async () => {
    const { page, close } = await open('normal', 1440, 900, { fault: { fail: { 'mandate.update': 'mandate update rejected: limits missing' } } })
    await page.click('.gb-tierbtn >> nth=0')
    await page.click('[role="menuitemradio"]:has-text("纸面")')
    await page.waitForSelector('[data-key] .gb-tier__err', { timeout: 4000 })
    expect(await text(page, '[data-key] .gb-tier__err')).toBe('mandate update rejected: limits missing')
    expect((await page.$$eval('.gb-tierbtn', (els: Element[]) => els.map((e) => e.textContent ?? '')))[0]).toBe('需确认')
    await close()
  })

  it('C7 授权书已到期：档位钮先挡（aria-disabled + 原因「授权书已到期」），点它不开菜单、不发 mandate.update', async () => {
    const { page, close } = await open('normal', 1440, 900, { patch: (st) => { st.sc.mandates[0].status = 'expired' } })
    const st = await page.$eval('.gb-tierbtn', (e: Element) => ({ dis: e.getAttribute('aria-disabled'), why: e.getAttribute('title') }))
    expect(st).toEqual({ dis: 'true', why: '授权书已到期' })
    await page.click('.gb-tierbtn >> nth=0', { force: true })
    await page.waitForTimeout(400)
    expect(await page.$('[role="menuitemradio"]')).toBeNull()
    expect(calls('mandate.update')).toHaveLength(0)
    await close()
  })
})

d('IXD 流程 5 · 活动流', () => {
  it('5-1 每片都有计数，「LLM Agent」片的数 = LLM 条目数；过滤片外没有孤立的「LLM 6」', async () => {
    const { page, close } = await open('normal')
    const chips: Array<[string | null, string]> = await page.$$eval('.gb-agent__filter .gr-seg__btn', (els: Element[]) => els.map((e) => [e.getAttribute('data-v'), e.querySelector('.gb-fchip__n')?.textContent ?? '']))
    expect(chips.map(([v]) => v)).toEqual(['all', 'human', 'engine', 'llm-agent', 'system'])
    for (const [, n] of chips) expect(n).toMatch(/^\d+$/)
    const llm = await page.$$eval('.gb-ev[data-llm="1"]', (e: Element[]) => e.length)
    expect(Number(chips.find(([v]) => v === 'llm-agent')![1])).toBe(llm)
    const stray = await page.evaluate(() => {
      const out: string[] = []
      const w = document.createTreeWalker(document.querySelector('.gb-agent[data-view="feed"]') as Node, NodeFilter.SHOW_TEXT) // r4：三实例，活动卡
      for (let n = w.nextNode(); n; n = w.nextNode()) if (/LLM\s*\d/.test(n.textContent ?? '') && !n.parentElement?.closest('.gb-agent__filter')) out.push(n.textContent ?? '')
      return out
    })
    expect(stray).toEqual([])
    await close()
  })

  it('5-2 撞规则的条目不展开也能看见规则行', async () => {
    const { page, close } = await open('normal')
    const rows = await page.$$eval('.gb-ev.has-rule', (els: Element[]) => els.map((e) => [(e.querySelector('.gb-rule') as HTMLElement).offsetHeight, e.classList.contains('is-open')] as const))
    expect(rows.length).toBeGreaterThan(0)
    for (const [h, open] of rows) { expect(h).toBeGreaterThan(0); expect(open).toBe(false) }
    await close()
  })

  it('5-3 有理由或原文的条目是按钮、aria-expanded 随回车切换；没有可展开内容的条目不可聚焦', async () => {
    const { page, close } = await open('normal')
    const items = activityOf(normalizeLedger(scenario('normal').ledger))
    const heads: Array<{ seq: string | null; tag: string; exp: string | null; tab: number; region: boolean }> = await page.$$eval('.gb-ev', (els: Element[]) => els.map((e) => { const h = e.querySelector('.gb-ev__head') as HTMLElement; return { seq: e.getAttribute('data-seq'), tag: h.tagName, exp: h.getAttribute('aria-expanded'), tab: h.tabIndex, region: !!e.querySelector('.gb-ev__more') } }))
    expect(heads.map((x) => x.seq)).toEqual(items.map((x) => String(x.seq)))
    const more = items.map((x) => !!(x.why || x.upstream))
    expect(more.some(Boolean)).toBe(true)
    expect(more.some((x) => !x)).toBe(true)
    heads.forEach((x, i) => {
      expect(x.region, `#${x.seq} 收起时不渲染展开区`).toBe(false)
      if (more[i]) { expect(x.tag).toBe('BUTTON'); expect(x.exp).toBe('false') } else { expect(x.tag).toBe('DIV'); expect(x.tab).toBe(-1) }
    })
    // 收起的条目里没有任何可聚焦的东西（「复制原文」只在展开后出现）
    expect(await page.$$('.gb-ev:not(.is-open) .gb-ev__more button')).toHaveLength(0)
    const sel = '.gb-ev > button.gb-ev__head >> nth=0'
    await page.focus(sel)
    await page.keyboard.press('Enter')
    expect(await page.$eval(sel, (e: Element) => e.getAttribute('aria-expanded'))).toBe('true')
    expect(await page.$$('.gb-ev.is-open .gb-ev__more')).toHaveLength(1)
    await page.keyboard.press('Enter')
    expect(await page.$eval(sel, (e: Element) => e.getAttribute('aria-expanded'))).toBe('false')
    expect(await page.$$('.gb-ev__more')).toHaveLength(0)
    await close()
  })

  it('5-4 滚到第 10 条后来了新动作：阅读位置不动，顶部出「新动作 1」', async () => {
    const { page, close } = await open('normal')
    const st = stage.stage
    for (let i = 0; i < 20; i += 1) st.emitLedger(entry(6000 + i, 'note', O_CLAUDE, { orgId: 'org_local' as never }, { text: `批量 ${i}` }, Date.now()))
    await page.waitForFunction(() => document.querySelectorAll('.gb-ev').length >= 33, null, { timeout: 4000 })
    await page.waitForTimeout(500) // 等新条目的进场动画落定
    await page.evaluate(() => {
      const sc = document.querySelector('.gb-agent__feed .gr-scrollarea__in') as HTMLElement
      const tenth = sc.querySelectorAll('.gb-ev')[9] as HTMLElement
      sc.scrollTop += tenth.getBoundingClientRect().top - sc.getBoundingClientRect().top
    })
    await page.waitForTimeout(250)
    const firstVisible = () => page.evaluate(() => {
      const sc = document.querySelector('.gb-agent__feed .gr-scrollarea__in') as HTMLElement
      const top = sc.getBoundingClientRect().top
      const el = [...sc.querySelectorAll('.gb-ev')].find((e) => e.getBoundingClientRect().bottom > top + 1)
      return [el?.getAttribute('data-seq'), Math.round(el?.getBoundingClientRect().top ?? 0)]
    })
    const before = await firstVisible()
    st.emitLedger(entry(7000, 'note', O_CLAUDE, { orgId: 'org_local' as never }, { text: '滚动时来的新动作' }, Date.now()))
    await page.waitForSelector('[data-act="feed-new"]', { timeout: 3000 })
    expect(await text(page, '[data-act="feed-new"]')).toContain('新动作 1')
    expect(await firstVisible()).toEqual(before)
    // 点小片回顶，新动作出现在最上面
    await page.click('[data-act="feed-new"]')
    await page.waitForFunction(() => document.querySelector('.gb-ev')?.getAttribute('data-seq') === '7000', null, { timeout: 3000 })
    expect(await page.$('[data-act="feed-new"]')).toBeNull()
    await close()
  })

  it('5-5 按维度的空态：全部 / 人 / 引擎 / LLM Agent / 系统各一句', async () => {
    const { page, close } = await open('empty')
    const want: Record<string, string> = { human: '你还没有操作', all: '还没有动作', engine: '引擎还没有动作', 'llm-agent': '大模型还没有发起动作', system: '系统还没有记录' }
    for (const [f, t] of Object.entries(want)) {
      await page.click(`.gb-agent__filter [data-v="${f}"]`)
      await page.waitForTimeout(80)
      expect(await text(page, '.gb-feed .gr-empty__t'), f).toBe(t)
    }
    await close()
  })
})

d('IXD 流程 8 · 状态条', () => {
  it('8-1 断开内核：首项「内核未连接」，接管钮禁用', async () => {
    const { page, close, cut } = await open('normal', 1440, 900, { net: true })
    // r4（C2，IA §2.1）：状态条首项 → 总览条右侧网络项 [data-act="network"]
    expect(await tc(page, '[data-act="network"] .gb-sb__netn')).toBe('测试网')
    await cut()
    await page.waitForFunction(() => (document.querySelector('[data-act="network"]')?.textContent ?? '').trim() === '内核未连接', null, { timeout: 5000 })
    expect(await disabled(page, '[data-act="takeover"]')).toBe(true)
    await close()
  })

  it('8-2 预算剩 8%：预算值红字 + 形状标（.gb-sb__budget[data-level="low"]）', async () => {
    const { page, close } = await open('normal', 1440, 900, { patch: (st) => { st.sc.venues[0].rateBudget = { used: 1104, limit: 1200, windowMs: 60000, ratio: 0.92 } } })
    expect(await page.$('.gb-sb__budget[data-level="low"] .gr-down')).not.toBeNull()
    expect(await page.$('.gb-sb__budget[data-level="low"] svg')).not.toBeNull()
    expect(await text(page, '.gb-sb__budget')).toContain('8%')
    await close()
  })

  it('8-3 网络卡：打开后焦点在卡内，Esc 关闭后焦点回到网络项', async () => {
    const { page, close } = await open('normal')
    await page.click('[data-act="network"]')
    await page.waitForSelector('.gb-netcard')
    await page.waitForFunction(() => !!document.activeElement?.closest('.gb-netcard'), null, { timeout: 2000 })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gb-netcard'), null, { timeout: 2000 })
    expect(await activeAct(page)).toBe('network')
    await close()
  })

  it('8-4 900×900 打开接管卡：卡完全在视口内', async () => {
    const { page, close } = await open('normal', 900, 900)
    await page.click('[data-act="takeover"]')
    await page.waitForSelector('.gb-tkcard')
    await page.waitForTimeout(350)
    const r = await page.$eval('.gb-tkcard', (e: Element) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: innerWidth, h: innerHeight } })
    expect(r.l).toBeGreaterThanOrEqual(0)
    expect(r.t).toBeGreaterThanOrEqual(0)
    expect(r.r).toBeLessThanOrEqual(r.w)
    expect(r.b).toBeLessThanOrEqual(r.h)
    await close()
  })

  it('C1 内核在线、只是场所状态读不到：首项是内核原文（悬停全文），「接管」可点、卡里三档可用', async () => {
    const { page, close } = await open('error')
    const MSG = '内核暂时读不到这份数据（演示用的读取失败场景）'
    const first = await page.$eval('.gb-sb [data-act="network"]', (e: Element) => ({ t: (e as HTMLElement).innerText.trim(), title: e.getAttribute('title') }))
    expect(first.t).toContain(MSG)
    expect(first.t).not.toContain('内核未连接')
    expect(first.title).toBe(MSG)
    expect(await disabled(page, '[data-act="takeover"]')).toBe(false)
    await page.click('[data-act="takeover"]')
    await page.waitForSelector('.gb-tkcard [data-act="takeover-halt_new"]')
    expect(await page.$$eval('.gb-tkcard [data-act^="takeover-"]', (els: Element[]) => els.map((e) => (e as HTMLButtonElement).disabled))).toEqual([false, false, false])
    await close()
  })
})

d('IXD 流程 9 · 通用状态（3–5，与块里的陈旧数字）', () => {
  it('9-1（块的部分）断开内核：持仓数字带去掉涨跌色、正负号保留；重连后 2 s 内颜色恢复', async () => {
    const { page, close, cut, restore, connAt } = await open('normal', 1440, 900, { net: true })
    // r4（F9-1 / 裁决 1）：权益数字带搬到总览条；离线时总览条与持仓表都无涨跌色，正负号保留
    const COLORED = '.gb-sb .gr-up, .gb-sb .gr-down, .gb-pos .gr-up, .gb-pos .gr-down'
    const colored = () => page.$$eval(COLORED, (e: Element[]) => e.length)
    expect(await colored()).toBeGreaterThan(0)
    await cut()
    await page.waitForFunction((s: string) => document.querySelectorAll(s).length === 0, COLORED, { timeout: 5000 })
    expect(await tc(page, '.gb-sb__lead .gb-sb__today')).toContain('+128.40')
    expect(await tc(page, '.gb-sb > .gb-sb__eq[data-mode="paper"]')).toContain('−12.50')
    const t0 = Date.now()
    restore()
    await expect.poll(() => connAt() > t0, { timeout: 10_000 }).toBe(true) // 客户端退避重连
    const back = connAt()
    await page.waitForFunction((s: string) => document.querySelectorAll(s).length > 0, COLORED, { timeout: 2000 })
    expect(Date.now() - back).toBeLessThanOrEqual(2000)
    await close()
  })

  it('9-3 Toast：悬停 10 s 不消失，移开后 3 s 内消失', async () => {
    const { page, close } = await open('pending')
    await page.click('[data-act="reject"]')
    await page.waitForSelector('.gr-toast[data-kind="ok"]', { timeout: 4000 })
    await page.hover('.gr-toast[data-kind="ok"]')
    await page.waitForTimeout(10_000)
    expect(await page.$('.gr-toast[data-kind="ok"]')).not.toBeNull()
    await page.mouse.move(4, 4)
    await page.waitForFunction(() => !document.querySelector('.gr-toast[data-kind="ok"]'), null, { timeout: 3500 })
    await close()
  })

  it('9-4 骨架只脉冲一次；查询慢到 8 s 以上时出「仍在读取」与重试', async () => {
    const { page, close } = await open('pending', 1440, 900, { fault: { queryDelayMs: 9000 }, ready: false })
    await page.waitForSelector('.gr-skel', { timeout: 5000 })
    expect(await page.$eval('.gr-skel', (e: Element) => getComputedStyle(e).animationIterationCount)).toBe('1')
    await page.waitForSelector('[data-skel-slow]', { timeout: 9500 })
    expect(await text(page, '[data-skel-slow]')).toContain('仍在读取')
    expect(await page.$('[data-act="skeleton-retry"]')).not.toBeNull()
    await close()
  })

  it('9-5 三块同时读取失败：Agent 块只有一个错误态，原文与内核的话全等', async () => {
    const { page, close } = await open('error')
    // r4（C2）：Agent 块是三张独立的卡（待批 / Agent / 活动），各自只有一个错误态，原文全等
    for (const v of ['pending', 'keys', 'feed']) {
      expect(await page.$$(`.gb-agent[data-view="${v}"] .gr-empty`), v).toHaveLength(1)
      expect(await page.$eval(`.gb-agent[data-view="${v}"] .gr-empty__d`, (e: Element) => e.textContent), v).toBe('内核暂时读不到这份数据（演示用的读取失败场景）')
    }
    await close()
  })

  it('L5 指针停在 toast 上点掉最后一条（堆随即卸载，pointerleave 不会来）：之后来的 toast 照常自动消失', async () => {
    const { page, close } = await open('pending')
    await page.click('[data-act="reject"]')
    await page.waitForSelector('.gr-toast[data-kind="ok"]', { timeout: 4000 })
    await page.click('.gr-toast[data-kind="ok"] .gr-toast__close') // 指针移到 ✕ 上（暂停）后点掉，不移开
    await page.waitForFunction(() => !document.querySelector('.gr-toast'), null, { timeout: 3000 })
    await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 4000 })
    await page.waitForTimeout(700) // 换卡 500 ms 死区
    await page.click('[data-act="reject"]')
    await page.mouse.move(4, 4)
    await page.waitForSelector('.gr-toast[data-kind="ok"]', { timeout: 4000 })
    await page.waitForFunction(() => !document.querySelector('.gr-toast[data-kind="ok"]'), null, { timeout: 4500 })
    await close()
  })
})
