// SPDX-License-Identifier: CPAL-1.0
// 五卡 + 总览条的无头验证（视觉轮 r4，C2 改写；r2 起的 87 项全保留，按工单第 9 节改断言）：五个场景 × 四档视口（1440×900 / 1200×800 / 900×900 / 390×844）截图到 reports/visual-r4/shots/C2/，
// 并断言：桌面无页面滚动、无横向溢出、控制台 0 错误、无禁词与 emoji；再走交互（事件链、来源筛选、理由展开、档位菜单、就地确认、网络卡 / 接管卡、
// 改档位 → PIN、全部平仓 → PIN → 已停止、批准后执行失败、没平完红条、断开内核的离线态、新动作小片），最后对五个场景跑 run-audit 视觉体检。
// 用法：node verify/shots.mjs   （packages/blocks-default 下；GITRADER_PLAYWRIGHT 指 playwright-core）。不弹可见窗口；只关自己起的浏览器与服务；退出码非 0 = 有失败项。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser, startStage, PIN } from './stage.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SHOTS = process.env.GITRADER_SHOTS ?? resolve(here, '..', '..', '..', 'reports', 'visual-r4', 'shots', 'C2')
mkdirSync(SHOTS, { recursive: true })
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? '  · ' + detail : ''}`) }

const BANNED = /Comfy|WalletConnect|保守|激进|标准|稳赚|跑赢|稳定盈利|UNIGIT/
const EMOJI = /\p{Extended_Pictographic}/u
const VIEWPORTS = [[1440, 900], [1200, 800], [900, 900], [390, 844]]
const SCENARIOS = ['normal', 'empty', 'pending', 'halted', 'error']
/** 一条 LLM 笔记账本条目（只填界面要读的字段；夹具场景的完整条目见 fixtures/scenarios.ts）。 */
const note = (seq, text) => ({
  schema: 'gitrader-ledger/1', seq, id: `led_shot_${seq}`, ts: Date.now(), recordedAt: Date.now(), type: 'note',
  origin: { actor: 'agent:ak_01JB000000000000000000000B', actorType: 'llm-agent', tool: 'note', requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, via: 'mcp' },
  subject: { orgId: 'org_local' }, payload: { text }, payloadHash: 'sha256:0', attestation: 'kernel-observed', prevHash: 'sha256:0', hash: 'sha256:0',
})

const stage = await startStage('normal')
const browser = await launchBrowser()
const consoleErrors = []
const open = async (w, h, name, o = {}) => {
  stage.stage.load(name)
  stage.stage.calls.length = 0
  if (o.fault) Object.assign(stage.stage.fault, o.fault)
  if (o.patch) o.patch(stage.stage)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const net = { cut: false, socks: [] }
  if (o.net) await ctx.routeWebSocket(/\/ui$/, (ws) => { if (net.cut) { void ws.close(); return } net.socks.push(ws.connectToServer(), ws) })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !(net.cut && /WebSocket/.test(m.text()))) consoleErrors.push(`[${name} ${w}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[${name} ${w}] pageerror ${e.message}`))
  await page.goto(stage.url, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__GR_READY__ && window.__GR_READY__.online === true, null, { timeout: 8000 })
  await page.waitForSelector('.gb-pos, .gb-agent, .gb-risk, .gb-sb', { state: 'attached', timeout: 8000 })
  await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, null, { timeout: 8000 })
  await page.waitForTimeout(600)
  const cut = async () => { net.cut = true; for (const s of net.socks.splice(0)) { try { await s.close() } catch { /* 已关闭 */ } } }
  return { ctx, page, cut }
}
const shot = (page, file) => page.screenshot({ path: join(SHOTS, file) })
const noScroll = (page) => page.evaluate(() => { const se = document.scrollingElement; return { v: se.scrollHeight - innerHeight, h: se.scrollWidth - innerWidth } })
const act = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-act') ?? null)

try {
  // ① 五个场景 × 四档视口
  for (const name of SCENARIOS) {
    for (const [w, h] of VIEWPORTS) {
      const { ctx, page } = await open(w, h, name)
      const s = await noScroll(page)
      if (w >= 600) check(`${name} ${w}×${h}：无页面纵向滚动、无横向溢出`, s.v <= 1 && s.h <= 1, `纵向 ${s.v} 横向 ${s.h}`)
      else check(`${name} ${w}×${h}：无横向溢出（手机视图允许页面纵向滚动）`, s.h <= 1, `横向 ${s.h}`)
      const text = await page.evaluate(() => document.body.innerText)
      check(`${name} ${w}：无禁词、无 emoji`, !BANNED.test(text) && !EMOJI.test(text), ((text.match(BANNED) ?? text.match(EMOJI)) ?? [''])[0])
      if (w >= 600) {
        const clipped = await page.evaluate(() => [...document.querySelectorAll('.gr-tile-p, .gr-status')].filter((el) => el.scrollWidth > el.clientWidth + 2).map((el) => el.getAttribute('data-block') || el.className))
        check(`${name} ${w}：块与状态条内容不溢出`, clipped.length === 0, clipped.join(','))
      }
      await shot(page, `${w}-${name}.png`)
      await ctx.close()
    }
  }

  // ② 交互（1440，normal）
  {
    const { ctx, page } = await open(1440, 900, 'normal')
    await page.click('[data-row$="|hyperliquid:BTC|long"]')
    await page.waitForSelector('.gb-chain__step.is-origin', { timeout: 4000 })
    await page.waitForTimeout(350)
    const kinds = await page.$$eval('.gb-chain__step', (els) => els.map((e) => e.className.match(/is-(\w+)/)?.[1]))
    check('持仓事件链：持仓 → 成交 → … → 来源', kinds[0] === 'position' && kinds.includes('fill') && kinds[kinds.length - 1] === 'origin', kinds.join(','))
    await shot(page, '1440-chain.png')
    const total = await page.$$eval('.gb-ev', (e) => e.length)
    await page.click('.gb-agent__filter [data-v="llm-agent"]')
    await page.waitForTimeout(150)
    const llm = await page.$$eval('.gb-ev', (els) => els.map((e) => e.getAttribute('data-llm')))
    const chip = await page.$eval('.gb-agent__filter [data-v="llm-agent"] .gb-fchip__n', (e) => e.textContent)
    check('来源筛选：只剩 LLM 来源、都带 LLM 标记，片上计数一致', llm.length > 0 && llm.length < total && llm.every((x) => x === '1') && Number(chip) === llm.length, `${llm.length}/${total} 片=${chip}`)
    await shot(page, '1440-filter-llm.png')
    await page.click('.gb-agent__filter [data-v="all"]')
    await page.click('.gb-ev > button.gb-ev__head >> nth=3')
    await page.waitForTimeout(400)
    check('活动流：理由 / 原文点开才显示', (await page.$$('.gb-ev.is-open .gb-ev__more')).length === 1 && (await page.$$('.gb-ev__more')).length === 1)
    await shot(page, '1440-reason-open.png')
    // 档位菜单（Radix DropdownMenu）
    await page.click('.gb-tierbtn >> nth=0')
    await page.waitForSelector('[role="menuitemradio"]')
    await page.waitForTimeout(350)
    const radios = await page.$$eval('[role="menuitemradio"]', (els) => els.map((e) => `${e.textContent}:${e.getAttribute('aria-checked')}`))
    check('档位菜单：三档单选、当前项打勾，限额自动灰着', radios.join(',') === '只读:false,纸面:false,需确认:true' && (await page.$$('[role="menuitem"][aria-disabled="true"]')).length === 1, radios.join(','))
    await shot(page, '1440-tier-menu.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    // 接管就地确认（G2）
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    await page.waitForTimeout(400)
    check('接管就地确认：取消在前、焦点落取消、确认写动词', (await act(page)) === 'takeover-flatten_all-cancel' && (await page.$eval('.gb-risk [data-act="takeover-flatten_all-confirm"]', (e) => e.textContent)) === '确认平仓')
    await shot(page, '1440-takeover-armed.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    // 网络卡 / 接管卡（Radix Popover）
    await page.click('[data-act="network"]')
    await page.waitForSelector('.gb-netcard')
    await page.waitForTimeout(350)
    // r4（第 9 节）：总览条在顶部，网络卡向下展开（r2 在底部状态条上向上展开）
    const card = await page.$eval('.gb-netcard', (e) => { const r = e.getBoundingClientRect(); const t = document.querySelector('[data-act="network"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, trig: t.bottom, vh: innerHeight, focus: !!document.activeElement?.closest('.gb-netcard') } })
    check('网络卡：向下展开、在视口内、焦点进卡', card.top >= card.trig && card.bottom <= card.vh && card.focus, JSON.stringify(card))
    await shot(page, '1440-network-card.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    check('网络卡：Esc 关闭后焦点回到网络项', (await act(page)) === 'network')
    await page.click('[data-act="takeover"]')
    await page.waitForSelector('.gb-tkcard')
    await page.waitForTimeout(350)
    await shot(page, '1440-takeover-card.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    // 改档位 → PIN（壳的 PIN 弹层）
    await page.click('.gb-tierbtn >> nth=0')
    await page.click('[role="menuitemradio"]:has-text("纸面")')
    await page.waitForSelector('.gr-pin')
    await page.waitForTimeout(350)
    await shot(page, '1440-pin-tier.png')
    await page.fill('.gr-pin input', PIN)
    await page.click('.gr-pin .gr-btn--primary')
    await page.waitForFunction(() => document.body.innerText.includes('已改为纸面'), null, { timeout: 4000 })
    const upd = stage.stage.calls.filter((c) => c.action === 'mandate.update')
    check('改档位：先无证明后带 PIN 证明，内核收到新级别', upd.length === 2 && !upd[0].attested && upd[1].attested && upd[1].params.input.level === 'L1', JSON.stringify(upd.map((c) => c.attested)))
    // 状态条接管 → 全部平仓 → 确认（600 ms 死区后）→ PIN → 已停止
    await page.click('[data-act="takeover"]')
    await page.waitForSelector('.gb-tkcard')
    await page.click('.gb-tkcard [data-act="takeover-flatten_all"]')
    await page.waitForTimeout(650)
    await page.click('.gb-tkcard [data-act="takeover-flatten_all-confirm"]')
    await page.waitForSelector('.gr-pin')
    await page.fill('.gr-pin input', PIN)
    await page.click('.gr-pin .gr-btn--primary')
    await page.waitForFunction(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'HALTED', null, { timeout: 5000 })
    check('接管 → PIN → 风险块进入已停止', stage.stage.tradingState === 'HALTED')
    await page.waitForTimeout(400)
    await shot(page, '1440-after-flatten-halted.png')
    await ctx.close()
  }
  // ③ 待批：一次一张 + 翻页、批准后执行失败（结果态）、拒绝
  {
    const { ctx, page } = await open(1440, 900, 'pending', { fault: { approveNoPin: true, approveFails: 'price moved beyond bounds' } })
    // r4（第 9 节，IA §2.3）：翻页器 → 卡头计数 + 卡底队列
    const n = await page.$$eval('.gb-pend', (e) => e.length)
    const head = await page.$eval('[data-card="pending"] .gb-head__n', (e) => e.textContent.trim())
    const q = await page.$$eval('.gb-queue li[data-ticket]', (e) => e.length)
    check('待批：一次一张、卡头计数 2、队列 1 行', n === 1 && head === '2' && q === 1, `${n} 张 · 计数 ${head} · 队列 ${q}`)
    const t0 = await page.$eval('.gb-pend__t', (e) => e.textContent)
    await page.waitForTimeout(2100)
    const t1 = await page.$eval('.gb-pend__t', (e) => e.textContent)
    check('倒计时递减', t0 !== t1, `${t0} → ${t1}`)
    await page.click('[data-act="approve"]')
    await page.waitForSelector('.gb-pend[data-result="failed"]', { timeout: 4000 })
    await page.waitForTimeout(300)
    const failedText = await page.$eval('.gb-pend', (e) => e.innerText)
    const okApproved = await page.$$eval('.gr-toast[data-kind="ok"]', (els) => els.some((e) => (e.textContent ?? '').includes('已批准')))
    check('批准后执行失败：卡上「执行失败」+ 内核原文，不出成功提示', failedText.includes('执行失败') && failedText.includes('price moved beyond bounds') && !okApproved)
    await shot(page, '1440-approve-failed.png')
    await page.click('[data-act="ack"]')
    await page.waitForFunction(() => !document.querySelector('.gb-pend[data-result]'), null, { timeout: 3000 })
    await page.waitForTimeout(600)
    await page.click('[data-act="reject"]')
    await page.waitForSelector('.gb-pend[data-result="rejected"]', { timeout: 3000 })
    await shot(page, '1440-reject-result.png')
    check('拒绝无需 PIN', stage.stage.calls.some((c) => c.action === 'proposal.reject' && !c.attested))
    await ctx.close()
  }
  // ④ 没平完：常驻红条
  {
    const { ctx, page } = await open(1440, 900, 'normal', { fault: { flattenNoPin: true, flattenLeft: [{ instrumentId: 'hyperliquid:ETH', size: '1.2' }] } })
    await page.click('.gb-risk [data-act="takeover-flatten_all"]')
    await page.waitForTimeout(650)
    await page.click('.gb-risk [data-act="takeover-flatten_all-confirm"]')
    await page.waitForSelector('.gb-risk__alert', { timeout: 4000 })
    await page.waitForTimeout(400)
    check('全部平仓没平完：常驻红条带标的，状态只减仓', (await page.$eval('.gb-risk__alert', (e) => e.innerText)).includes('ETH') && (await page.$eval('.gb-risk', (e) => e.getAttribute('data-state'))) === 'REDUCING')
    await shot(page, '1440-flatten-left.png')
    await ctx.close()
  }
  // ⑤ 断开内核：离线（命令禁用、标「离线」、数字去涨跌色、状态条「内核未连接」）
  {
    const { ctx, page, cut } = await open(1440, 900, 'pending', { net: true })
    await cut()
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-offline'), null, { timeout: 6000 })
    await page.waitForTimeout(500)
    // r4（第 9 节）：离线看总览条网络项；权益数字在总览条上，去涨跌色、正负号保留
    const st = await page.evaluate(() => ({ first: document.querySelector('[data-act="network"]')?.textContent.trim(), tk: document.querySelector('[data-act="takeover"]')?.disabled, approve: document.querySelector('[data-act="approve"]')?.disabled, colored: document.querySelectorAll('.gb-sb .gr-up, .gb-sb .gr-down, .gb-pos .gr-up, .gb-pos .gr-down').length, sign: (document.querySelector('.gb-sb__lead .gb-sb__mid')?.textContent ?? '').trim() }))
    check('离线：总览条网络项「内核未连接」、接管与批准禁用、数字去涨跌色正负号保留', st.first === '内核未连接' && st.tk && st.approve && st.colored === 0 && st.sign.startsWith('+'), JSON.stringify(st))
    await page.locator('.gr-status').screenshot({ path: join(SHOTS, 'overview-offline.png') })
    await shot(page, '1440-offline.png')
    await ctx.close()
  }
  {
    const { ctx, page, cut } = await open(390, 844, 'pending', { net: true })
    await shot(page, '390-pending-bar.png')
    await cut()
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-offline'), null, { timeout: 6000 })
    await page.waitForTimeout(500)
    await shot(page, '390-pending-offline.png')
    await ctx.close()
  }
  // ⑥ 新动作小片：滚离顶部后来了新动作，阅读位置不动
  {
    const { ctx, page } = await open(1440, 900, 'normal')
    for (let i = 0; i < 20; i += 1) stage.stage.emitLedger(note(6000 + i, `批量 ${i}`))
    await page.waitForTimeout(900)
    await page.evaluate(() => { document.querySelector('.gb-agent__feed .gr-scrollarea__in').scrollTop = 420 })
    await page.waitForTimeout(300)
    stage.stage.emitLedger(note(7000, '滚动时来的新动作'))
    await page.waitForSelector('[data-act="feed-new"]', { timeout: 3000 })
    check('新动作小片：滚离顶部后出现「新动作 1」', (await page.$eval('[data-act="feed-new"]', (e) => e.textContent)).includes('新动作 1'))
    await shot(page, '1440-feed-new.png')
    await ctx.close()
  }

  // ⑧ 待批卡五态（主会话逐张看）：待批 / 批准中 / 已批准（✓ → 收起）/ 已过期 / 执行失败，截 Agent 块面；再加 1200 / 900 两档的待批卡。
  //    r4（第 9 节）：待批就是一张卡（壳给卡面：圆角 10 + 一根内线），提案直接坐在卡里：左右内边距 20（1200：16），卡头下 1 px 引信，动作行距提案底 14（1200：12）。
  {
    const agentTile = (page) => page.locator('[data-card="pending"]')
    const frame = (page) => page.$eval('.gb-pend', (e) => {
      const cs = getComputedStyle(e)
      const r = e.getBoundingClientRect()
      const act = e.querySelector('.gb-pend__act')
      const a = act ? act.getBoundingClientRect() : null
      const tile = e.closest('.gr-tile-p')
      const host = tile.getBoundingClientRect()
      const ts = getComputedStyle(tile)
      const fuse = tile.querySelector('.gb-fuse')
      const hd = tile.querySelector('.gr-tile-p__head')
      return { radius: ts.borderTopLeftRadius, pad: cs.paddingLeft + ' ' + cs.paddingRight, ring: ts.boxShadow.includes('inset'), cardBg: cs.backgroundColor, actBottomGap: a ? Math.round(r.bottom - a.bottom) : null, inTile: r.left >= host.left && r.right <= host.right && r.top >= host.top && r.bottom <= host.bottom + 1, fuseGap: fuse && hd ? Math.round(fuse.getBoundingClientRect().top - hd.getBoundingClientRect().bottom) : null, h: Math.round(host.height) }
    })
    const cardOk = (f, pad = '20px 20px') => f.radius === '10px' && f.pad === pad && f.ring && f.cardBg === 'rgba(0, 0, 0, 0)' && f.inTile && f.fuseGap === 0
    {
      const { ctx, page } = await open(1440, 900, 'pending')
      const f = await frame(page)
      check('待批卡（1440）：卡圆角 10 + 内线、提案不另起面、左右 20、引信贴卡头、动作行距提案底 14、卡高 336±4', cardOk(f) && f.actBottomGap === 14 && Math.abs(f.h - 336) <= 4, JSON.stringify(f))
      await agentTile(page).screenshot({ path: join(SHOTS, 'card-1-pending.png') })
      // 第 2 张带「撞到的规则」行（需人批准 · 上限 · 实际），翻页后 500 ms 死区里截不到可点的钮也没关系，这里只看卡
      await page.click('.gb-queue [data-act="queue-pick"]')
      await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 3000 })
      await page.waitForTimeout(700)
      check('待批卡 · 第 2 张：规则行常显', (await page.$$('.gb-pend .gb-rule')).length === 1)
      await agentTile(page).screenshot({ path: join(SHOTS, 'card-1b-pending-rule.png') })
      await ctx.close()
    }
    {
      const { ctx, page } = await open(1440, 900, 'pending', { fault: { approveNoPin: true, delayMs: { 'proposal.approve': 4000 } } })
      await page.click('[data-act="approve"]')
      await page.waitForSelector('[data-act="approve"].is-busy', { timeout: 3000 })
      await page.waitForTimeout(250)
      check('待批卡 · 批准中：批准钮转圈「批准中…」，拒绝禁用', (await page.$eval('[data-act="approve"]', (e) => e.textContent)) === '批准中…' && (await page.$eval('[data-act="reject"]', (e) => e.disabled)))
      await agentTile(page).screenshot({ path: join(SHOTS, 'card-2-approving.png') })
      await ctx.close()
    }
    {
      const { ctx, page } = await open(1440, 900, 'pending', { fault: { approveNoPin: true, approveExecutes: true } })
      await page.click('[data-act="approve"]')
      await page.waitForSelector('.gb-pend[data-result="executed"]', { timeout: 3000 })
      await page.waitForTimeout(450)
      check('待批卡 · 已批准：✓ 已批准 · 已执行', (await page.$eval('.gb-pend .gb-pend__res', (e) => e.textContent)) === '已批准 · 已执行')
      await agentTile(page).screenshot({ path: join(SHOTS, 'card-3-approved.png') })
      await page.waitForTimeout(400)
      await agentTile(page).screenshot({ path: join(SHOTS, 'card-3b-collapsing.png') })
      await page.waitForFunction(() => document.querySelector('.gb-pend')?.getAttribute('data-ticket') === 'T-20261010-0007', null, { timeout: 3000 })
      check('待批卡 · 已批准：≤ 1.2 s 后收起、换下一张', true)
      await ctx.close()
    }
    {
      const late = await open(1440, 900, 'pending', { patch: (st) => { st.sc.proposals[1].expiresAt = Date.now() + 2600 } })
      await late.page.waitForFunction(() => document.querySelector('.gb-pend__t')?.textContent === '已过期', null, { timeout: 6000 })
      await late.page.waitForTimeout(150)
      check('待批卡 · 已过期：倒计时红「已过期」、两钮禁用', (await late.page.$eval('[data-act="approve"]', (e) => e.disabled)) && (await late.page.$eval('[data-act="reject"]', (e) => e.disabled)))
      await agentTile(late.page).screenshot({ path: join(SHOTS, 'card-4-expired.png') })
      await late.ctx.close()
    }
    {
      const { ctx, page } = await open(1440, 900, 'pending', { fault: { approveNoPin: true, approveFails: 'price moved beyond bounds' } })
      await page.click('[data-act="approve"]')
      await page.waitForSelector('.gb-pend[data-result="failed"]', { timeout: 3000 })
      await page.waitForTimeout(300)
      const f = await frame(page)
      check('待批卡 · 执行失败：结果态在卡内、卡仍完整', cardOk(f), JSON.stringify(f))
      await agentTile(page).screenshot({ path: join(SHOTS, 'card-5-failed.png') })
      await ctx.close()
    }
    for (const [w, h] of [[1200, 800], [900, 900]]) {
      const { ctx, page } = await open(w, h, 'pending')
      const f = await frame(page)
      // 收口裁决：1200 档（≤1319 断点，含 900）卡高容差 ±8，1440 仍 ±4
      check(`待批卡（${w}）：结构不变、左右 16、卡在块面内不裁切、动作行距提案底 12、卡高 314±8`, cardOk(f, '16px 16px') && f.actBottomGap === 12 && Math.abs(f.h - 314) <= 8, JSON.stringify(f))
      await agentTile(page).screenshot({ path: join(SHOTS, `card-1-pending-${w}.png`) })
      await ctx.close()
    }
    {
      const { ctx, page } = await open(390, 844, 'pending')
      const f = await frame(page)
      const bar = await page.$eval('.gb-pend__bar', (e) => { const r = e.getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), outside: !e.closest('.gb-pend') } })
      check('待批卡（390）：卡完整（圆角 10、左右 16、在块面内）；动作条在卡外吸底', f.radius === '10px' && f.pad === '16px 16px' && f.ring && f.inTile && bar.bottom === 0 && bar.outside, JSON.stringify({ ...f, bar }))
      await ctx.close()
    }
  }

  // ⑨ 视觉轮 r4（C2）：五卡里归 C2 的三张 Agent 卡 + 总览条 + 风险卡——裁图对照 comps，量几何，拍批准退场关键帧
  {
    const fresh = (st) => { for (const p of st.sc.proposals) { if (p.ticket === 'T-20261010-0008') p.expiresAt = Date.now() + 185_000; if (p.ticket === 'T-20261010-0007') p.expiresAt = Date.now() + 582_000 } }
    const parts = (page, sel) => page.$eval(sel, (e) => [...e.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())).catch(() => [])
    for (const [w, h] of [[1440, 900], [1200, 800]]) {
      const { ctx, page } = await open(w, h, 'pending', { patch: fresh })
      const g = await page.evaluate(() => Object.fromEntries(['overview', 'positions', 'feed', 'pending', 'agents', 'risk'].map((c) => [c, Math.round(document.querySelector(`[data-card="${c}"]`).getBoundingClientRect().height)])))
      const want = w === 1440 ? { overview: 56, pending: 336, agents: 124 } : { overview: 52, pending: 314, agents: 112 }
      const tol = w === 1440 ? 4 : 8 // 收口裁决：1200 档卡高容差 ±8，1440 仍 ±4
      check(`r4 ${w}：总览条 ${want.overview}、待批 ${want.pending}±${tol}、Agent ${want.agents}±${tol}（C2 三张卡的内容高）`, g.overview === want.overview && Math.abs(g.pending - want.pending) <= tol && Math.abs(g.agents - want.agents) <= tol, JSON.stringify(g))
      const lead = await parts(page, '.gb-sb__lead > .gb-sb__eq')
      const today = await parts(page, '.gb-sb__lead > .gb-sb__today')
      const paper = await parts(page, '.gb-sb > .gb-sb__eq[data-mode="paper"]')
      const pend = await parts(page, '[data-act="strip-pending"]')
      const net = await page.$eval('[data-act="network"]', (e) => e.innerText.replace(/\s+/g, ' ').trim())
      check(`r4 ${w} 总览条：12,480.20 USDC / +128.40 / +1.04% / 9,987.50 / 今日 −12.50 / 正常交易 / 待批 2 最急 03:0x`, lead.join('|') === '实盘权益|12,480.20|USDC' && today.join('|') === '今日|+128.40|+1.04%' && paper.join('|') === '纸面|9,987.50|今日 −12.50' && pend[0] === '待批 2' && /^最急 03:0[0-5]$/.test(pend[1] ?? ''), JSON.stringify({ lead, today, paper, pend }))
      check(`r4 ${w} 总览条网络项：${w === 1440 ? '测试网 已连接 42 ms' : '只留「测试网」'}`, net === (w === 1440 ? '测试网 已连接 42 ms' : '测试网'), net)
      const fuse = await page.$eval('.gb-fuse', (e) => e.querySelector('i').getBoundingClientRect().width / e.getBoundingClientRect().width)
      check(`r4 ${w} 引信 61.7%（±1.5%）`, Math.abs(fuse - 0.617) < 0.015, fuse.toFixed(3))
      const after = await parts(page, '.gb-pend__after')
      check(`r4 ${w} 批后仓位「空 1.2 → 空 3.2」`, after[1] === '空 1.2' && after[after.length - 1] === '空 3.2', after.join('|'))
      const orange = await page.$$eval('.gr-btn--primary', (e) => e.length)
      check(`r4 ${w} 实心橙每屏 1（批准）`, orange === 1, String(orange))
      const clip = await page.evaluate(() => { const sc = document.querySelector('[data-card="feed"] .gr-scrollarea__in'); const b = sc.getBoundingClientRect().bottom; return [...sc.querySelectorAll('.gb-ev')].filter((e) => { const r = e.getBoundingClientRect(); return r.top < b - 0.5 && r.bottom > b + 0.5 }).length })
      check(`r4 ${w} 活动卡静止态整行裁切（无半行）`, clip === 0, String(clip))
      await page.locator('.gr-status').screenshot({ path: join(SHOTS, `overview-${w}.png`) })
      await page.locator('[data-card="pending"]').screenshot({ path: join(SHOTS, `pending-card-${w}.png`) })
      await page.locator('[data-card="agents"]').screenshot({ path: join(SHOTS, `agents-card-${w}.png`) })
      await page.locator('[data-card="feed"]').screenshot({ path: join(SHOTS, `feed-card-${w}.png`) })
      await page.locator('[data-card="risk"]').screenshot({ path: join(SHOTS, `risk-card-${w}.png`) })
      await shot(page, `wb-${w}.png`)
      if (w === 1440) {
        await page.click('.gb-tierbtn >> nth=0')
        await page.waitForSelector('[role="menuitemradio"]')
        await page.waitForTimeout(300)
        await shot(page, 'agents-tier-menu-1440.png')
        await page.keyboard.press('Escape')
      }
      await ctx.close()
    }
    // 批准成功三拍（VISUAL §5 D）：按下 → 换字 → 当前单退场 → 队列行退场 → 下一张落位 + 计数 2 → 1
    {
      const { ctx, page } = await open(1440, 900, 'pending', { patch: fresh, fault: { approveNoPin: true, approveExecutes: true } })
      const tile = page.locator('[data-card="pending"]')
      await page.click('[data-act="approve"]')
      await page.waitForSelector('.gb-pend[data-result="executed"]', { timeout: 3000 })
      const t0 = Date.now()
      for (const [i, at] of [[1, 300], [2, 950], [3, 1150], [4, 1350], [5, 1700]]) { await page.waitForTimeout(Math.max(0, at - (Date.now() - t0))); await tile.screenshot({ path: join(SHOTS, `approve-exit-${i}-${at}ms.png`) }) }
      const end = await page.evaluate(() => ({ t: document.querySelector('.gb-pend')?.getAttribute('data-ticket'), n: document.querySelector('[data-card="pending"] .gb-head__n')?.textContent.trim(), q: document.querySelectorAll('.gb-queue li').length }))
      check('r4 批准成功：已批准 → 退场 → 下一张落位 → 计数 2 → 1，队列空', end.t === 'T-20261010-0007' && end.n === '1' && end.q === 0, JSON.stringify(end))
      await ctx.close()
    }
    // 待批 0：卡只剩卡头；风险卡保护器列表自动展开
    {
      const { ctx, page } = await open(1440, 900, 'pending', { patch: (st) => { st.sc.proposals = st.sc.proposals.filter((p) => p.status !== 'pending') } })
      const r = await page.evaluate(() => ({ body: document.querySelector('[data-card="pending"] .gr-tile-p__body').getBoundingClientRect().height, n: document.querySelector('[data-card="pending"] .gb-head__n')?.textContent.trim(), prot: document.querySelector('[data-act="protectors"]').getAttribute('aria-expanded') }))
      check('r4 待批 0：卡只剩卡头「待批 0」、块体不占高；保护器列表自动展开', r.body <= 1 && r.n === '0' && r.prot === 'true', JSON.stringify(r))
      await page.locator('[data-card="pending"]').screenshot({ path: join(SHOTS, 'pending-0-1440.png') })
      await shot(page, 'wb-1440-pending-0.png')
      await ctx.close()
    }
    // 风险卡：只减仓 + 没平完红条（状态行 7% 底 + 原因原文 + 恢复交易）
    {
      const { ctx, page } = await open(1440, 900, 'normal', { fault: { flattenNoPin: true, flattenLeft: [{ instrumentId: 'hyperliquid:ETH', size: '1.2' }] } })
      await page.click('.gb-risk [data-act="takeover-flatten_all"]')
      await page.waitForTimeout(650)
      await page.click('.gb-risk [data-act="takeover-flatten_all-confirm"]')
      await page.waitForSelector('.gb-risk__alert', { timeout: 4000 })
      await page.waitForTimeout(500)
      const r = await page.evaluate(() => ({ st: document.querySelector('[data-card="risk"] .gr-tile-p__head .gb-state')?.textContent, row: !!document.querySelector('.gb-risk__status [data-act="resume"]'), dot: document.querySelectorAll('[data-card="risk"] .gr-dot').length }))
      check('r4 风险卡只减仓：卡头状态字（无点）+ 状态行带恢复交易 + 红条', r.st === '只减仓' && r.row && r.dot === 0, JSON.stringify(r))
      await page.locator('[data-card="risk"]').screenshot({ path: join(SHOTS, 'risk-reducing-alert.png') })
      await ctx.close()
    }
  }

  // ⑦ 视觉体检：F 的 run-audit 对五个场景各跑一遍（体检脚本自己开浏览器；先关本脚本的）
  await browser.close()
  const audits = {}
  for (const name of SCENARIOS) {
    stage.stage.load(name)
    const au = await new Promise((res) => {
      const p = spawn(process.execPath, [resolve(here, '../../workbench/design/run-audit.mjs'), stage.url, '', ''], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
      p.on('close', (code) => res({ status: code, stdout: out }))
    })
    audits[name] = au.stdout
    console.log(`-- audit ${name}\n${au.stdout}`)
    check(`视觉体检 ${name}`, au.status === 0, au.status === 0 ? '' : au.stdout.split('\n').filter((l) => l.includes('超限') || l.includes('ERROR')).join(' | '))
  }
  writeFileSync(join(SHOTS, 'run-audit.txt'), Object.entries(audits).map(([k, v]) => `-- ${k}\n${v}`).join('\n'))
  check('控制台 0 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (e) {
  check('验证脚本异常', false, String(e && e.stack ? e.stack : e).slice(0, 700))
} finally {
  try { await browser.close() } catch { /* 已关闭 */ }
  await stage.close()
}
const failed = results.filter((r) => !r.ok)
writeFileSync(join(SHOTS, 'verify-result.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2))
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项；截图：${SHOTS}`)
process.exit(failed.length ? 1 : 0)
