// SPDX-License-Identifier: CPAL-1.0
// 壳的无头浏览器冒烟：构建壳 → 起夹具内核（假内核，随机端口，绝不连真数据）+ 块包的演示场景 → 无头 Edge 走一遍：
//   三档截图（1440×900 / 1200×800 / 900×900）、无页面滚动、无横向溢出、控制台 0 错误、禁词、首屏时间、
//   设置里设 PIN 与钥匙导入（私钥不在页面里留痕）、⌘K 全平 → 二次确认 → PIN 弹层 → 内核收到命令与在场证明、视觉体检；
//   视觉轮 r2：IXD §14 流程 2（PIN）/ 6（命令面板）/ 7（设置）/ 9 的 1–2（陈旧小标）/ 10（插件区）/ 11（关于）/ 12 的 3、6（焦点环、触控与禁词）+ 390 手机视图。
// 用法：node verify/shell.mjs         （packages/workbench 下）。不弹可见窗口；只关自己起的浏览器与服务；退出码非 0 = 有失败项。
//   截图目录 GITRADER_SHOTS（缺省 reports/F-shots）；playwright-core 用 GITRADER_PLAYWRIGHT 指过去。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const SHOTS = process.env.GITRADER_SHOTS ?? resolve(here, '..', '..', '..', 'reports', 'F-shots')
import { browserPath, loadChromium } from './browser.mjs'
const chromium = loadChromium()
const EDGE = browserPath()
const PIN = '246810' // 夹具 PIN（块包场景的人面命令也按它校验）

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? '  · ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = mkdtempSync(join(tmpdir(), 'gr-shell-'))
mkdirSync(SHOTS, { recursive: true })
let kernel = null
let browser = null
try {
  // 1. 构建壳到临时目录（不覆盖 dist）
  const dist = join(tmp, 'dist')
  const b = spawnSync(process.execPath, [join(pkgDir, 'build.mjs')], { env: { ...process.env, GITRADER_UI_OUT: dist }, encoding: 'utf8' })
  check('壳构建成功（无外链、无禁词）', b.status === 0, b.status === 0 ? '' : (b.stderr || b.stdout).slice(0, 300))
  if (b.status !== 0) throw new Error('构建失败')

  // 2. 夹具内核（TS → 临时 mjs，放在 verify/.tmp 里以便解析 ws）+ 块包的演示场景（blocks-default/fixtures：持仓、待批、风险、状态条的数据与人面命令）
  const tmpDir = join(here, '.tmp')
  mkdirSync(tmpDir, { recursive: true })
  const fk = join(tmpDir, 'fixture-kernel.mjs')
  await build({
    stdin: { contents: "export { startFixtureKernel, problem } from './fixture-kernel.ts'\nexport { installScenario } from '../../blocks-default/fixtures/install.ts'\n", resolveDir: here, loader: 'ts' },
    outfile: fk, bundle: true, platform: 'node', format: 'esm', external: ['ws'], logLevel: 'silent',
  })
  const { startFixtureKernel, installScenario, problem } = await import(pathToFileURL(fk).href)
  kernel = await startFixtureKernel({ staticDir: dist, workspacesDir: join(tmp, 'workspaces'), pluginsDir: resolve(pkgDir, '../plugin-template/example') })
  { const launch = kernel.launchUrl.bind(kernel); kernel.launchUrl = () => launch() + '&ui=r4' } // r4 出口：缺省已翻 r5，本脚本断言 r4 壳
  kernel.flags.attestFlatten = true
  installScenario(kernel, 'pending')
  const pluginBlocks = (await (await fetch(kernel.url + '/plugins/ema-reading/block.json')).json())
  check('夹具内核按真内核的方式服务插件文件（带 CORS）', pluginBlocks.id === 'block.example.ema-reading')
  check('夹具内核启动', kernel.port > 0, `端口 ${kernel.port}`)

  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  const consoleErrors = []
  const mkPage = async (w, h, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, ...opts })
    const page = await ctx.newPage()
    // 预期内的噪音：内核还没有 relink 接口时的 404；故意断网期间 WebSocket 重连失败
    const expected = (t) => (page.expectRelink404 && t.includes('Failed to load resource')) || (page.expectOffline && /WebSocket|ERR_INTERNET_DISCONNECTED/.test(t))
    page.on('console', (m) => { if (m.type() === 'error' && !expected(m.text())) consoleErrors.push(`[${w}] ${m.text()}`) })
    page.on('response', (r) => { if (r.status() >= 400 && !(page.expectRelink404 && r.url().endsWith('/api/session/relink'))) consoleErrors.push(`[${w}] HTTP ${r.status()} ${r.url().replace(/launch=[^&#]+/, 'launch=…')}`) })
    page.on('pageerror', (e) => consoleErrors.push(`[${w}] pageerror ${e.message}`))
    return { ctx, page }
  }
  /** 新开一页并等内核握手完成；init = 页面脚本之前注入的脚本。 */
  const openPage = async (w, h, hash = '#/', init) => {
    const { ctx, page } = await mkPage(w, h)
    if (init) await ctx.addInitScript(init)
    await page.goto(kernel.launchUrl() + hash, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__GR_READY__ && window.__GR_READY__.online === true, null, { timeout: 8000 })
    await page.waitForTimeout(700)
    return { ctx, page }
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '')
  const since = (n, action) => kernel.commands.slice(n).filter((c) => c.action === action)
  const BANNED = /Comfy|WalletConnect|保守|激进|标准|UNIGIT/
  const noScroll = (page) => page.evaluate(() => {
    const se = document.scrollingElement
    return { v: se.scrollHeight - innerHeight, h: se.scrollWidth - innerWidth, bodyOverflowX: document.body.scrollWidth - innerWidth }
  })
  // r4 版式几何：顶栏 / 总览条 / 两个列容器 / 五张卡的盒子、列内顺序、被裁的卡体
  const geo = (page) => page.evaluate(() => {
    const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) } }
    const q = (s) => document.querySelector(s)
    const cardsOf = (col) => [...(col ? col.querySelectorAll(':scope > [data-card]') : [])].map((e) => e.dataset.card)
    const colR = q('.gr-wb__col[data-col="r"]')
    return {
      top: R(q('.gr-top')), strip: R(q('[data-slot="statusbar"]')), colL: R(q('.gr-wb__col[data-col="l"]')), colR: R(colR),
      left: cardsOf(q('.gr-wb__col[data-col="l"]')), right: cardsOf(colR),
      cards: Object.fromEntries([...document.querySelectorAll('.gr-wb__grid [data-card]')].map((e) => [e.dataset.card, R(e)])),
      clipped: [...document.querySelectorAll('.gr-wb__grid [data-card] > .gr-tile-p__body')].filter((b) => b.scrollHeight > b.clientHeight + 1).map((b) => b.parentElement.dataset.card),
      colRScroll: colR ? colR.scrollHeight - colR.clientHeight : -1,
      end: R(q('.gr-wb')?.lastElementChild)?.b ?? -1, // 工作台最下面一件（插件区折叠头或两列）的底边：下外沿 = 视口高 − end
      // 风险卡（主会话裁决：卡体可滚，卡头 + 接管一排 + 限额行必须在卡体可视区；保护器 / 开关可滚出）
      risk: (() => {
        const card = q('[data-card="risk"]'); const body = card && card.querySelector(':scope > .gr-tile-p__body')
        if (!body) return null
        const bb = body.getBoundingClientRect(); const cb = card.getBoundingClientRect()
        const inBody = (e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top >= bb.top - 0.5 && r.bottom <= bb.bottom + 0.5 }
        const tk = [...body.querySelectorAll('[data-act^="takeover-"]')].filter((e) => !/-confirm$/.test(e.dataset.act))
        const lim = [...body.querySelectorAll('.gb-limits > *')]
        const hd = card.querySelector(':scope > .gr-tile-p__head').getBoundingClientRect()
        return { oy: getComputedStyle(body).overflowY, head: hd.top >= cb.top - 0.5 && hd.bottom <= cb.bottom + 0.5, tk: tk.length, tkIn: tk.length > 0 && tk.every(inBody), lim: lim.length, limIn: lim.length > 0 && lim.every(inBody), h: Math.round(cb.height) }
      })(),
    }
  })

  // 3. 三档截图 + 无滚动 + 禁词 + 控制台
  let riskPendingH = 0 // 1440 pending 场景的风险卡高（「待批 0 时风险卡变高」的对照）
  for (const [w, h] of [[1440, 900], [1200, 800], [900, 900]]) {
    const { ctx, page } = await mkPage(w, h)
    await page.goto(kernel.launchUrl() + '#/', { waitUntil: 'load' })
    await page.waitForFunction(() => window.__GR_READY__ && window.__GR_READY__.online === true, null, { timeout: 8000 })
    await page.waitForSelector('.gr-tile-p')
    await page.waitForTimeout(400)
    for (const [name, hash] of [['workbench', '#/'], ['settings-connect', '#/settings/connect'], ['settings-keys', '#/settings/keys'], ['about', '#/about']]) {
      await page.evaluate((x) => { location.hash = x }, hash)
      await page.waitForTimeout(350)
      const s = await noScroll(page)
      check(`${w}×${h} ${name}：无页面纵向滚动、无横向溢出`, s.v <= 1 && s.h <= 1 && s.bodyOverflowX <= 1, `纵向 ${s.v} 横向 ${s.h}`)
      const text = await page.evaluate(() => document.body.innerText)
      check(`${w} ${name}：无禁词`, !BANNED.test(text), (text.match(BANNED) ?? [''])[0])
      await page.screenshot({ path: join(SHOTS, `${w}-${name}.png`) })
    }
    // r4 版式（IA §3 / §6.2，施工单 4.4）：两列（左 持仓 / 活动，右 待批 / Agent / 风险）；右列 clamp(440px, 36vw, 520px)（1440 算出 518，±2）、
    // 1200 档 440、600–1099 档 clamp(340px, 36vw, 440px)；外沿 / 卡距 24 / 12（≤ 1319：16 / 10）；顶栏 40、总览条 56 / 52 在内容上方；上 12、下 16 / 12
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForTimeout(600) // 卡入场 320 ms + 错开 4 × 40 ms
    const S = w >= 1320 ? { gut: 24, gap: 12, ov: 56, bot: 16, col: [516, 520] } : w >= 1100 ? { gut: 16, gap: 10, ov: 52, bot: 12, col: [438, 442] } : { gut: 16, gap: 10, ov: 52, bot: 12, col: [338, 342] }
    const g = await geo(page)
    const cd = g.cards
    const colsOk = JSON.stringify(g.left) === '["positions","feed"]' && JSON.stringify(g.right) === '["pending","agents","risk"]' && g.colR.w >= S.col[0] && g.colR.w <= S.col[1] && g.colL.x === S.gut && w - g.colR.r === S.gut && g.colR.x - g.colL.r === S.gap && g.colL.y === g.colR.y
      && Math.abs(cd.positions.b + S.gap - cd.feed.y) <= 1 && Math.abs(cd.pending.b + S.gap - cd.agents.y) <= 1 && Math.abs(cd.agents.b + S.gap - cd.risk.y) <= 1
    check(`r4 ${w}×${h}：两列，左 持仓 / 活动，右 待批 / Agent / 风险；右列宽 ${S.col[0]}–${S.col[1]}、外沿 ${S.gut}、卡距 ${S.gap}`, colsOk, JSON.stringify({ left: g.left, right: g.right, colL: g.colL, colR: g.colR }))
    // 主会话裁决（D 门禁返工）：不按 comps 卡高断言；风险卡体可滚，只要求卡头 + 接管一排 + 限额行在可视区；其余四卡卡体不被裁
    const rk = g.risk
    const riskOk = !!rk && /auto|scroll/.test(rk.oy) && rk.head && rk.tk >= 3 && rk.tkIn && rk.lim >= 1 && rk.limIn
    const vOk = g.top.y === 0 && g.top.h === 40 && g.strip.y === 40 && g.strip.h === S.ov && g.colL.y === 40 + S.ov + 12 && g.end === h - S.bot && (w < 1100 || (g.clipped.filter((c) => c !== 'risk').length === 0 && g.colRScroll <= 1 && riskOk))
    check(`r4 ${w}×${h}：顶栏 40、总览条 ${S.ov} 在内容上方（上 12 / 下 ${S.bot}）${w < 1100 ? '' : '；其余卡体不被裁、右列不滚；风险卡体可滚且卡头 + 接管排 + 限额行可见'}`, vOk, JSON.stringify({ top: g.top, strip: g.strip, colL: g.colL, end: g.end, clipped: g.clipped, colRScroll: g.colRScroll, risk: rk, heights: Object.fromEntries(Object.entries(cd).map(([k, v]) => [k, v.h])) }))
    if (w === 1440) {
      const tiles = await page.$$eval('.gr-wb__grid .gr-tile-p', (els) => els.map((e) => e.getAttribute('data-block').split('.').pop()))
      const one = await page.evaluate(() => { const s = document.querySelector('[data-slot="statusbar"]'); const top = document.querySelector('.gr-top'); const main = document.querySelector('.gr-content'); return !!s && s.dataset.card === 'overview' && s.getAttribute('role') === 'region' && top.nextElementSibling === s && s.nextElementSibling === main })
      check('r4 固定五卡 + 总览条：持仓 / Agent×3 / 风险；data-slot=statusbar 与 data-card=overview 同一元素、在顶栏与内容之间', JSON.stringify(tiles) === JSON.stringify(['positions', 'agent-activity', 'agent-activity', 'agent-activity', 'risk']) && Object.keys(cd).length === 5 && one, tiles.join(',') + ' · ' + Object.keys(cd).join(','))
      const pin = await page.evaluate(() => ({ pinned: [...document.querySelectorAll('.gr-wb__grid .gr-tile-p.is-pinned')].map((e) => e.dataset.card), locks: document.querySelectorAll('.gr-wb__grid .gr-tile-p__head .gr-tile-p__pin').length }))
      check('r4 钉住：活动 / 待批 / Agent / 风险 4 张 is-pinned，持仓不钉；桌面卡头无锁标', JSON.stringify(pin.pinned) === '["feed","pending","agents","risk"]' && pin.locks === 0, JSON.stringify(pin))
      const skin = await page.evaluate(() => [...document.querySelectorAll('.gr-wb__grid [data-card]')].map((e) => { const cs = getComputedStyle(e); const pre = (p) => getComputedStyle(e, p).content; return { c: e.dataset.card, r: cs.borderTopLeftRadius, sh: cs.boxShadow, before: pre('::before'), after: pre('::after') } }))
      check('r4 五张卡圆角 10、无外投影（只有一根内线）、无顶边流光（::before / ::after 无内容）', skin.every((s) => s.r === '10px' && /inset/.test(s.sh) && !/,/.test(s.sh.replace(/rgba?\([^)]*\)/g, '')) && s.before === 'none' && s.after === 'none'), JSON.stringify(skin.map((s) => `${s.c}:${s.r}:${s.before}/${s.after}:${s.sh}`)))
      const heads = await page.evaluate(() => [...document.querySelectorAll('.gr-wb__grid [data-card]')].map((e) => ({ c: e.dataset.card, t: e.querySelector(':scope > .gr-tile-p__head > h2.gr-tile-p__title')?.textContent ?? '', slot: !!e.querySelector(':scope > .gr-tile-p__head > .gr-tile-p__slot'), h: Math.round(e.querySelector(':scope > .gr-tile-p__head').getBoundingClientRect().height) })))
      check('r4 卡头：标题（持仓 / 活动 / 待批 / Agent / 风险）+ .gr-tile-p__slot，卡头高 40', JSON.stringify(heads.map((x) => x.t)) === JSON.stringify(['持仓', '活动', '待批', 'Agent', '风险']) && heads.every((x) => x.slot && x.h === 40), JSON.stringify(heads))
      const tb = await page.evaluate(() => { const b = document.querySelector('.gr-searchbtn'); const cs = getComputedStyle(b); return { line: !!document.querySelector('.gr-nav__line, .gr-nav__glide'), kbd: b.querySelectorAll('kbd, .gr-kbd').length, ring: cs.boxShadow, bg: cs.backgroundColor, wm: Math.round(document.querySelector('.gr-brand img').getBoundingClientRect().height), k: b.querySelector('.gr-searchbtn__k')?.textContent ?? '' } })
      check('r4 顶栏：无流光下划线 / 滑块、命令入口无框无键帽（「Ctrl K」是字）、字标高 14', !tb.line && tb.kbd === 0 && tb.ring === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(tb.bg) && tb.wm === 14 && /K$/.test(tb.k), JSON.stringify(tb))
      const theme0 = await page.evaluate(() => { const t = document.documentElement.dataset.theme; document.documentElement.dataset.theme = 'light'; return t })
      await page.waitForTimeout(200)
      await page.screenshot({ path: join(SHOTS, '1440-workbench-light.png') })
      await page.hover('.gr-searchbtn')
      await page.waitForTimeout(200)
      const lt = await page.evaluate(() => { const cs = (s) => getComputedStyle(document.querySelector(s)); return { top: cs('.gr-top').backgroundColor, nav: cs('.gr-nav__item.is-active').color, card: cs('[data-card="positions"]').backgroundColor, hover: cs('.gr-searchbtn').backgroundColor } })
      await page.mouse.move(720, 600)
      await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme0)
      check('r4 浅色强制（控制台设 data-theme=light，只验证不加入口）：顶栏仍深底、顶栏字仍是暖白、卡变白、命令入口悬停底是白 6%（--gr-topbar-hover）', lt.top === 'rgb(10, 10, 11)' && lt.nav === 'rgb(244, 241, 234)' && lt.card === 'rgb(255, 255, 255)' && lt.hover === 'rgba(255, 255, 255, 0.06)', JSON.stringify(lt))
    }
    if (w === 1440) riskPendingH = cd.risk.h
    await ctx.close()
  }

  // 3b. 待批卡的「批准」按钮：三档视口、插件区折叠 / 展开，都必须完整落在块的可视区里（不靠滚动才看得到）
  for (const [w, h] of [[1440, 900], [1200, 800], [900, 900]]) {
    const { ctx, page } = await mkPage(w, h)
    await page.goto(kernel.launchUrl() + '#/', { waitUntil: 'load' })
    await page.waitForSelector('[data-act="approve"]', { timeout: 6000 })
    const dockDefault = await page.$eval('.gr-dock', (e) => e.classList.contains('is-open'))
    if (w === 1440) check('插件区默认折叠', dockDefault === false)
    for (const open of [false, true]) {
      if (open) { await page.click('[data-act="plugins-toggle"]'); await page.waitForSelector('.gr-dock iframe'); await page.waitForTimeout(450) }
      const m = await page.evaluate(() => {
        const btn = document.querySelector('[data-act="approve"]')
        const tile = btn.closest('.gr-tile-p__body')
        const r = btn.getBoundingClientRect(); const t = tile.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        const dock = document.querySelector('.gr-dock')
        const grid = document.querySelector('.gr-wb__grid').getBoundingClientRect()
        return { inTile: r.top >= t.top - 0.5 && r.bottom <= t.bottom + 0.5 && r.left >= t.left && r.right <= t.right, hit: !!hit && (hit === btn || btn.contains(hit)), dockH: dock ? dock.getBoundingClientRect().height : 0, vh: innerHeight, gridH: grid.height, page: document.scrollingElement.scrollHeight - innerHeight }
      })
      check(`${w}×${h} 插件区${open ? '展开' : '折叠'}：「批准」在块内可视区且可点`, m.inTile && m.hit, JSON.stringify(m))
      if (open) check(`${w}×${h} 插件区展开占用 ≤ 30% 视口`, m.dockH <= m.vh * 0.3 + 1, `${Math.round(m.dockH)} / ${m.vh}`)
      if (open && h <= 800) check(`G1 ${w}×${h}（视口高 ≤ 800）插件区展开占用 ≤ 25% 视口`, m.dockH <= m.vh * 0.25 + 1, `${Math.round(m.dockH)} / ${m.vh}`)
      check(`${w}×${h} 插件区${open ? '展开' : '折叠'}：无页面滚动`, m.page <= 1)
      if (open && w === 1200) {
        const rv = await page.evaluate(() => {
          const col = document.querySelector('.gr-wb__col[data-col="r"]').getBoundingClientRect()
          const risk = document.querySelector('[data-card="risk"]')
          const hd = risk.querySelector('.gr-tile-p__head').getBoundingClientRect()
          const tk = risk.querySelector('[data-act^="takeover-"]')
          const tr = tk ? tk.getBoundingClientRect() : null
          const vis = (r) => !!r && r.top >= col.top - 0.5 && r.bottom <= col.bottom + 0.5
          const hit = tr ? document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2) : null
          return { head: vis(hd), tk: vis(tr) && !!hit && (hit === tk || tk.contains(hit)), col: [Math.round(col.top), Math.round(col.bottom)], hd: Math.round(hd.top), tkb: tr ? Math.round(tr.bottom) : -1 }
        })
        check('r4 1200×800 插件区展开：批准可点，风险卡头与接管一排在可视区', m.hit && rv.head && rv.tk, JSON.stringify(rv))
      }
      await page.screenshot({ path: join(SHOTS, `${w}-workbench-pending-${open ? 'dock-open' : 'dock-closed'}.png`) })
    }
    await ctx.close()
  }

  // 3c. r4 待批为 0（清空 pending 提案）：待批卡只剩卡头（不消失），风险卡吃掉让出的高度
  {
    const stage = installScenario(kernel, 'pending')
    stage.sc.proposals = stage.sc.proposals.filter((x) => x.status !== 'pending')
    const { ctx, page } = await openPage(1440, 900)
    await page.waitForTimeout(300)
    const z = await page.evaluate(() => { const c = document.querySelector('[data-card="pending"]'); const R = (e) => Math.round(e.getBoundingClientRect().height); return { h: R(c), hd: R(c.querySelector('.gr-tile-p__head')), body: R(c.querySelector('.gr-tile-p__body')), t: c.innerText.replace(/\s+/g, ' ').trim(), risk: R(document.querySelector('[data-card="risk"]')) } })
    check('r4 待批为 0：待批卡只剩卡头（卡高 = 卡头高），风险卡变高', z.body <= 1 && Math.abs(z.h - z.hd) <= 1 && z.t.startsWith('待批') && z.risk > riskPendingH, JSON.stringify({ ...z, riskPending: riskPendingH }))
    await page.screenshot({ path: join(SHOTS, '1440-workbench-pending-0.png') })
    await ctx.close()
    installScenario(kernel, 'pending')
  }

  // 3e. r4 减少动效（VISUAL §5 A）：卡入场只淡入 120 ms、无位移、不错开；最终可见、无 transform
  {
    const { ctx, page } = await mkPage(1440, 900, { reducedMotion: 'reduce' })
    await page.goto(kernel.launchUrl() + '#/', { waitUntil: 'load' })
    await page.waitForSelector('[data-card="risk"]')
    const early = await page.evaluate(() => [...document.querySelectorAll('.gr-wb__grid [data-card]')].map((e) => { const cs = getComputedStyle(e); return { c: e.dataset.card, name: cs.animationName, dur: cs.animationDuration, delay: cs.animationDelay } }))
    await page.waitForTimeout(400)
    const late = await page.evaluate(() => [...document.querySelectorAll('.gr-wb__grid [data-card]')].map((e) => { const cs = getComputedStyle(e); return { c: e.dataset.card, op: cs.opacity, tf: cs.transform } }))
    check('r4 减少动效：卡入场只淡入 120 ms（无位移、不错开），最终全部可见且无位移', early.length === 5 && early.every((x) => x.name === 'gr-card-fade' && x.dur === '0.12s' && x.delay === '0s') && late.every((x) => x.op === '1' && x.tf === 'none'), JSON.stringify({ early: early.map((x) => `${x.c}:${x.name}:${x.dur}:${x.delay}`), late: late.map((x) => `${x.c}:${x.op}:${x.tf}`) }))
    await ctx.close()
  }

  // 3d. r4 总览条的网络卡与接管卡向下展开、整卡在视口内（块包 C2 改 side）
  {
    const { ctx, page } = await openPage(1440, 900)
    for (const [act, cls, word] of [['network', '.gb-netcard', '网络卡'], ['takeover', '.gb-tkcard', '接管卡']]) {
      const trig = `[data-slot="statusbar"] [data-act="${act}"]`
      await page.click(trig)
      await page.waitForSelector(cls, { timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(350)
      const m = await page.evaluate(([t, c]) => { const a = document.querySelector(t)?.getBoundingClientRect(); const el = document.querySelector(c); if (!a || !el) return null; const r = el.getBoundingClientRect(); return { below: r.top >= a.bottom - 1, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, box: [r.left, r.top, r.right, r.bottom].map(Math.round), trig: Math.round(a.bottom) } }, [trig, cls])
      check(`r4 总览条${word}向下展开、整卡在视口内`, !!m && m.below && m.inView, JSON.stringify(m))
      await page.screenshot({ path: join(SHOTS, `1440-overview-${act}.png`) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
    }
    await ctx.close()
  }

  // 4. 首屏时间（5 次取中位数；空载 = 夹具内核、无数据）
  const fcp = []
  const fr = []
  for (let i = 0; i < 5; i += 1) {
    const { ctx, page } = await mkPage(1440, 900)
    await page.goto(kernel.launchUrl() + '#/', { waitUntil: 'load' })
    await page.waitForSelector('.gr-tile-p')
    const m = await page.evaluate(() => ({
      first: performance.getEntriesByName('gr-first-render')[0]?.startTime ?? -1,
      paint: performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? -1,
    }))
    fr.push(m.first); fcp.push(m.paint)
    await ctx.close()
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  console.log(`首屏：壳首次渲染 ${med(fr).toFixed(0)} ms，页面 load 完成 ${med(fcp).toFixed(0)} ms（5 次中位数，本机无头 Edge）`)
  check('壳空载首屏 ≤ 1 s', med(fr) <= 1000 && med(fcp) <= 1000, `渲染 ${med(fr).toFixed(0)} ms · load ${med(fcp).toFixed(0)} ms`)

  // 5. 设置：PIN、钥匙导入；⌘K 全平 → 确认 → PIN 弹层
  {
    const { ctx, page } = await mkPage(1440, 900)
    await page.goto(kernel.launchUrl() + '#/settings/keys', { waitUntil: 'load' })
    await page.waitForFunction(() => window.__GR_READY__ && window.__GR_READY__.online === true)
    await page.waitForSelector('[data-act="pin-open"]')
    await page.click('[data-act="pin-open"]')
    await page.fill('input[aria-label="新 PIN"]', PIN)
    await page.fill('input[aria-label="再输一次 PIN"]', PIN)
    await page.click('[data-act="pin-save"]')
    await page.waitForFunction(() => document.body.innerText.includes('已设置'), null, { timeout: 4000 })
    check('设置 PIN（内核记录已设置）', kernel.settings.pinSet === true)
    const pinInputsTypes = await page.$$eval('input[aria-label*="PIN"]', (els) => els.map((e) => e.type))
    check('PIN 输入框是密码框且无「显示」按钮', pinInputsTypes.every((t) => t === 'password') && (await page.$('.gr-input__btn')) === null)

    const secret = randomBytes(32).toString('hex') // 自生成的测试私钥，只在内存里，不落盘
    await page.click('[data-act="key-open"]')
    await page.fill('input[aria-label="钥匙名称"]', '测试网交易')
    await page.fill('input[aria-label="API 钱包私钥"]', secret)
    const type = await page.$eval('input[aria-label="API 钱包私钥"]', (e) => e.type)
    check('钥匙导入框是密码框', type === 'password')
    await page.click('[data-act="key-save"]')
    await page.waitForFunction(() => /0x[0-9a-f]{6}…/.test(document.body.innerText), null, { timeout: 4000 })
    check('钥匙导入成功，列表只有地址', kernel.settings.keys.length === 1 && kernel.commands.some((c) => c.action === 'credential.import'))
    const html = await page.content()
    check('私钥不在页面里留痕（DOM / 输入框）', !html.includes(secret) && !(await page.evaluate((s) => [...document.querySelectorAll('input')].some((i) => i.value.includes(s)), secret)))
    await page.screenshot({ path: join(SHOTS, '1440-settings-keys-after.png') })

    // ⌘K 全平
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForSelector('.gr-tile-p')
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    const cmds = await page.$$eval('[data-cmd]', (els) => els.map((e) => e.getAttribute('data-cmd')))
    // fix-r4: C6 新增「撤销 Agent 钥匙…」（只跳设置 → 钥匙），基础命令 4 → 5
    check('⌘K 只有五条命令', JSON.stringify(cmds) === JSON.stringify(['agent:halt_new', 'agent:cancel_all', 'agent:flatten_all', 'agent:revoke_key', 'go:settings']), cmds.join(','))
    await page.screenshot({ path: join(SHOTS, '1440-palette.png') })
    await page.fill('.gr-palette__in input', '全平')
    await page.waitForFunction(() => document.querySelectorAll('[data-cmd]').length === 1)
    await page.keyboard.press('Enter')
    await page.waitForSelector('.gr-palette__item.is-armed')
    check('全平先要二次确认（未发命令）', !kernel.commands.some((c) => c.action === 'takeover.flatten_all'))
    await page.waitForTimeout(700) // 武装后 600 ms 死区（IXD F6-1）
    await page.keyboard.press('Enter')
    await page.waitForSelector('.gr-pin')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, '1440-pin.png') })
    const pinType = await page.$eval('.gr-pin input', (e) => e.type)
    await page.fill('.gr-pin input', PIN)
    await page.click('.gr-pin .gr-btn--primary')
    await page.waitForFunction(() => document.body.innerText.includes('已全部平仓'), null, { timeout: 4000 })
    const sent = kernel.commands.filter((c) => c.action === 'takeover.flatten_all')
    check('PIN 弹层：密码框；内核收到先无后有在场证明的两次命令', pinType === 'password' && sent.length === 2 && !sent[0].attestation && sent[1].attestation?.method === 'pin', `状态 ${kernel.state.tradingState}`)
    check('命令带 origin（via=ui）', sent[0].origin?.via === 'ui')

    // ⌘K 打开设置
    await page.keyboard.press('Control+K')
    await page.fill('.gr-palette__in input', 'shezhi')
    await page.waitForFunction(() => document.querySelectorAll('[data-cmd]').length === 1)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => location.hash.startsWith('#/settings'), null, { timeout: 4000 }).catch(async () => { await page.screenshot({ path: join(SHOTS, 'debug-palette.png') }); console.log('DEBUG', await page.evaluate(() => JSON.stringify({ hash: location.hash, text: document.body.innerText.slice(0, 300) }))) })
    check('⌘K 打开设置', true)
    await ctx.close()
  }

  // 5b. 插件块：内核报告已装插件块 → 壳在固定布局下方的插件区按清单渲染 sandbox iframe → 桥走 postMessage → 块真显示并收到数据
  {
    const { ctx, page } = await mkPage(1440, 900)
    await page.goto(kernel.launchUrl() + '#/', { waitUntil: 'load' })
    await page.waitForSelector('[data-act="plugins-toggle"]', { timeout: 6000 })
    await page.click('[data-act="plugins-toggle"]') // 默认折叠，点开
    await page.waitForSelector('.gr-dock iframe', { timeout: 6000 })
    const sandbox = await page.$eval('.gr-dock iframe', (e) => e.getAttribute('sandbox'))
    check('插件块在 sandbox="allow-scripts" 的 iframe 里（不给 allow-same-origin）', sandbox === 'allow-scripts', String(sandbox))
    const frame = page.frames().find((f) => f !== page.mainFrame())
    await frame.waitForSelector('.ema', { timeout: 6000 })
    // 订阅到达内核（经桥：宿主桥按清单声明的 maxHz 订阅，过滤带标的）
    await page.waitForFunction(() => true)
    const t0 = Date.now()
    while (!kernel.subscriptions().some((x) => x.topic === 'market.candles') && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50))
    const sub = kernel.subscriptions().find((x) => x.topic === 'market.candles')
    check('插件块的订阅经桥送到内核（market.candles，限频 1 Hz，带联动标的）', !!sub && sub.maxHz === 1 && sub.filter?.instrumentId === 'hyperliquid:BTC', JSON.stringify(sub ?? null))
    // 推 25 根新 K 线，EMA 读数要出现数字
    for (let i = 0; i < 25; i += 1) kernel.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '15m', candle: { t: 1791700000000 + i * 900000, o: 65000 + i, h: 65100 + i, l: 64900 + i, c: 65050 + i * 10, v: 10 } })
    await frame.waitForFunction(() => /\d{2},\d{3}\.\d{2}/.test(document.body.innerText), null, { timeout: 6000 })
    const txt = await frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
    check('插件块真显示并收到数据（EMA 读数 + 收盘价）', /EMA 21/.test(txt) && /收盘/.test(txt), txt.slice(0, 80))
    // 沙箱隔离：块里拿不到宿主页面
    const isolated = await frame.evaluate(() => { try { return typeof window.top.document === 'object' ? 'leak' : 'ok' } catch { return 'ok' } })
    check('插件块碰不到宿主页面（跨源隔离）', isolated === 'ok')
    // 折叠再展开
    await page.click('[data-act="plugins-toggle"]')
    await page.waitForFunction(() => !document.querySelector('.gr-dock iframe'))
    check('插件区可折叠', true)
    await page.click('[data-act="plugins-toggle"]')
    await page.waitForSelector('.gr-dock iframe')
    const s = await noScroll(page)
    check('插件区展开：无页面滚动', s.v <= 1 && s.h <= 1, `纵向 ${s.v}`)
    await page.waitForTimeout(450)
    await page.screenshot({ path: join(SHOTS, '1440-workbench-plugins.png') })
    await ctx.close()
  }

  // 5c. 会话失效：令牌已用 / 缺失 → 极简卡（relink 默认不问：内核按设计固定 404，只有带 PIN 的 gitrader open 才能重新签发）
  {
    const { ctx, page } = await mkPage(1440, 900)
    page.expectRelink404 = true // 内核还没有 relink 接口时，壳探一下得到 404 是预期内的
    await page.goto(kernel.url + '/?ui=r4#/', { waitUntil: 'load' })
    await page.waitForSelector('.gr-dead', { timeout: 6000 })
    const t = await page.$eval('.gr-dead', (e) => e.innerText.replace(/\s+/g, ' '))
    check('没有引导令牌：显示「会话已失效」+ 两条出路（serve 窗口按 Enter / 终端运行 gitrader open 要 PIN）', t.includes('会话已失效') && t.includes('gitrader serve') && t.includes('按 Enter') && t.includes('gitrader open') && t.includes('PIN'), t)
    const v = await page.evaluate(() => { const c = document.querySelector('.gr-dead__card'); const y = (s) => c.querySelector(s)?.getBoundingClientRect().top ?? -1; return { dir: getComputedStyle(c).flexDirection, icon: y('.gr-dead__icon'), title: y('.gr-dead__t'), cmd: y('.gr-dead__cmd'), act: y('.gr-dead__act') } })
    check('PLAN ⑤ 会话失效卡竖排：图标 → 状态 → 等宽命令 → 动作', v.dir === 'column' && v.icon < v.title && v.title < v.cmd && v.cmd < v.act, JSON.stringify(v))
    await page.screenshot({ path: join(SHOTS, '1440-session-expired.png') })
    const s = await noScroll(page)
    check('失效卡：无页面滚动', s.v <= 1 && s.h <= 1)
    // E0-9 / ADR-5：会话留在本标签页的 sessionStorage，启动链接用过后刷新仍登录；换一个没有存储的新标签页再用旧链接才是失效卡
    const url = kernel.launchUrl() + '#/'
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForSelector('.gr-tile-p')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.gr-tile-p', { timeout: 6000 })
    const afterReload = await page.evaluate(() => ({ dead: !!document.querySelector('.gr-dead'), tiles: document.querySelectorAll('.gr-tile-p').length }))
    check('刷新页面后（启动链接已用过）：会话保留、仍是已登录的工作台，不是失效卡也不是空白', !afterReload.dead && afterReload.tiles > 0, JSON.stringify(afterReload))
    await ctx.close()
    const fresh = await mkPage(1440, 900)
    fresh.page.expectRelink404 = true
    await fresh.page.goto(url, { waitUntil: 'load' })
    await fresh.page.waitForSelector('.gr-dead', { timeout: 6000 }).catch(() => {})
    const reused = await fresh.page.evaluate(() => ({ dead: (document.querySelector('.gr-dead')?.innerText ?? '').replace(/\s+/g, ' '), tiles: document.querySelectorAll('.gr-tile-p').length }))
    check('新标签页（无 sessionStorage）再用已用过的启动链接：显示失效卡而不是空白', reused.dead.includes('会话已失效') && reused.dead.includes('gitrader open') && reused.tiles === 0, JSON.stringify(reused))
    await fresh.ctx.close()
    // 手机：不要求在终端运行命令（IXD 390 规则 6）
    const m = await mkPage(390, 844)
    m.page.expectRelink404 = true
    await m.page.goto(kernel.url + '/?ui=r4#/', { waitUntil: 'load' })
    await m.page.waitForSelector('.gr-dead', { timeout: 6000 })
    const mt = await m.page.$eval('.gr-dead', (e) => e.innerText.replace(/\s+/g, ' '))
    check('IXD 390 规则 6：手机上的会话失效卡只有「会话已失效」+「重新连接」', mt.includes('会话已失效') && mt.includes('重新连接') && !mt.includes('gitrader open'), mt)
    await m.page.screenshot({ path: join(SHOTS, '390-session-expired.png') })
    await m.ctx.close()
  }

  // 7. PIN（IXD 流程 2）：标题 = 动作 + 对象；任意字符；错 PIN 不关（SDK 重试回路）；锁定倒计时 + 免 PIN 出口；Esc 取消焦点回原钮；PIN 打开时 Ctrl+K 无效
  {
    installScenario(kernel, 'pending')
    const { ctx, page } = await openPage(1440, 900)
    const approve = '.gb-pend [data-act="approve"]'
    await page.waitForSelector(approve, { timeout: 6000 })
    const c0 = kernel.commands.length
    const ticket = await page.$eval('.gb-pend', (e) => e.getAttribute('data-ticket'))
    await page.click(approve)
    await page.waitForSelector('.gr-pin')
    await page.waitForTimeout(300)
    const title = await text(page, '.gr-pin h2')
    check('IXD 2-4 批准触发的 PIN：标题 = 「批准」+ 票号', !!ticket && title.includes('批准') && title.includes(ticket), title)
    await page.keyboard.type('correct horse')
    const s1 = await page.evaluate(() => ({ n: document.querySelector('.gr-pin input').value.length, can: !document.querySelector('.gr-pin [data-act="pin-confirm"]').disabled }))
    check('IXD 2-1 PIN 收口令：输入「correct horse」得 13 位，确认可点', s1.n === 13 && s1.can, JSON.stringify(s1))
    await page.keyboard.press('Control+K')
    await page.waitForTimeout(300)
    check('IXD 2-6 PIN 打开时按 Ctrl+K 不出命令面板', (await page.$('.gr-palette')) === null)
    await page.screenshot({ path: join(SHOTS, '1440-pin-approve.png') })
    await page.mouse.click(24, 880) // 点在遮罩上
    await page.waitForTimeout(250)
    const s25 = await page.evaluate(() => ({ inert: document.querySelector('.gr-app')?.inert === true, open: !!document.querySelector('.gr-pin'), n: document.querySelector('.gr-pin input')?.value.length }))
    check('IXD F2-5 PIN 打开时背景 inert，点遮罩不取消（已输内容还在）', s25.inert && s25.open && s25.n === 13, JSON.stringify(s25))
    await page.fill('.gr-pin input', '111111')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => /PIN 不对/.test(document.querySelector('.gr-pin')?.textContent ?? ''), null, { timeout: 4000 })
    await page.waitForTimeout(150)
    const s2 = await page.evaluate(() => { const i = document.querySelector('.gr-pin input'); return { open: !!document.querySelector('.gr-pin'), empty: !!i && i.value === '', focus: !!i && document.activeElement === i } })
    check('IXD 2-2 错 PIN：弹层不关、内核原文在弹层里、输入清空、焦点留在输入框', s2.open && s2.empty && s2.focus, JSON.stringify(s2))
    await page.keyboard.type(PIN)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 4000 })
    const seq = since(c0, 'proposal.approve').map((c) => !!c.attestation)
    check('IXD 2-2 再输对：命令成功，proposal.approve 的在场证明序列 = [false, true, true]', JSON.stringify(seq) === '[false,true,true]', JSON.stringify(seq))

    await page.waitForTimeout(1800) // 已决卡收起 + 换卡 500 ms 死区
    await page.waitForSelector(approve)
    await page.click(approve)
    await page.waitForSelector('.gr-pin')
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 3000 })
    await page.waitForTimeout(400)
    const s5 = await page.evaluate(() => ({ err: document.querySelectorAll('.gr-toast[data-kind="err"]').length, act: document.activeElement?.getAttribute('data-act') ?? document.activeElement?.tagName }))
    check('IXD 2-5 Esc 取消：弹层消失、没有错误 toast、焦点回到「批准」', s5.err === 0 && s5.act === 'approve', JSON.stringify(s5))

    // 从命令面板触发、在 PIN 层取消：同样没有错误 toast（F2-7）；标题 = 全部平仓
    const fromPalette = async () => {
      await page.keyboard.press('Control+K')
      await page.waitForSelector('.gr-palette')
      await page.keyboard.type('平仓')
      await page.keyboard.press('Enter')
      await page.waitForSelector('.gr-palette__item.is-armed')
      await page.waitForTimeout(700)
      await page.keyboard.press('Enter')
      await page.waitForSelector('.gr-pin', { timeout: 4000 })
      await page.waitForTimeout(300)
    }
    await fromPalette()
    const ft = await text(page, '.gr-pin h2')
    check('IXD 2-4 全部平仓触发的 PIN：标题含「全部平仓」', ft.includes('全部平仓'), ft)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 3000 })
    await page.waitForTimeout(400)
    check('IXD 2-5 从命令面板触发、在 PIN 层取消：没有错误 toast', (await page.$$('.gr-toast[data-kind="err"]')).length === 0)
    check('IXD 12-3 PIN / 命令面板关闭后焦点不落到 body', await page.evaluate(() => document.activeElement && document.activeElement !== document.body))

    // 锁定（AUTH_FAILED + retryAfterMs）：倒计时 + 确认禁用 + 「改为停止新开仓」（停止新开仓永远不要 PIN）
    kernel.onCommand('takeover.flatten_all', (_p, c) => {
      if (!c.attestation) throw problem('ATTESTATION_REQUIRED', 2010, 'enter your PIN to unlock the keystore: live orders need the API wallet signature')
      throw problem('AUTH_FAILED', 5003, 'too many failed PIN attempts', { retryAfterMs: 120000 })
    })
    const h0 = kernel.commands.length
    await fromPalette()
    await page.keyboard.type(PIN)
    await page.keyboard.press('Enter')
    await page.waitForSelector('.gr-pin [data-pin-lock]', { timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(300)
    const s3 = await page.evaluate(() => ({ lock: document.querySelector('.gr-pin [data-pin-lock]')?.textContent ?? '', dis: !!document.querySelector('.gr-pin [data-act="pin-confirm"]')?.disabled, halt: !!document.querySelector('.gr-pin [data-act="pin-halt-new"]'), msg: document.querySelector('.gr-pin .gr-pin__err')?.textContent ?? '' }))
    check('IXD 2-3 锁定：弹层里出「已锁定 · mm:ss」倒计时（锁定时不再叠错误行）、确认禁用、全部平仓给「改为停止新开仓」', /\d{2}:\d{2}/.test(s3.lock) && s3.lock.includes('已锁定') && s3.dis && s3.halt && s3.msg === '', JSON.stringify(s3))
    await page.screenshot({ path: join(SHOTS, '1440-pin-locked.png') })
    await page.click('.gr-pin [data-act="pin-halt-new"]')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 4000 }).catch(() => {})
    check('IXD 2-3 点「改为停止新开仓」：内核收到 takeover.halt_new，原动作当取消、弹层关闭', since(h0, 'takeover.halt_new').length === 1 && (await page.$('.gr-pin')) === null)
    await ctx.close()
    installScenario(kernel, 'pending') // 换回块包场景的人面命令
  }

  // 8. 命令面板（IXD 流程 6）
  {
    const { ctx, page } = await openPage(1440, 900)
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    await page.waitForFunction(() => document.activeElement && document.activeElement.matches('.gr-palette__in input'), null, { timeout: 2000 }).catch(() => {})
    const role = await page.evaluate(() => document.activeElement?.getAttribute('role'))
    const titles = await page.$$eval('.gr-palette__t', (els) => els.map((e) => e.textContent))
    const riskBtns = await page.$$eval('.gb-risk [data-act^="takeover-"]', (els) => els.map((e) => e.textContent.trim()))
    // fix-r4: 命令名列表在「全部平仓」与「打开设置」之间多「撤销 Agent 钥匙…」
    check('IXD 6-5 命令名「停止新开仓 / 撤销挂单 / 全部平仓 / 撤销 Agent 钥匙… / 打开设置」，接管三条与风险块按钮同名', JSON.stringify(titles) === JSON.stringify(['停止新开仓', '撤销挂单', '全部平仓', '撤销 Agent 钥匙…', '打开设置']) && ['停止新开仓', '撤销挂单', '全部平仓'].every((t) => riskBtns.includes(t)), `${titles.join('/')} · 风险块 ${riskBtns.join('/')}`)
    await page.keyboard.type('平仓')
    await page.waitForTimeout(100)
    const first = await page.$eval('.gr-palette [data-cmd]', (e) => e.getAttribute('data-cmd'))
    const desc = await page.evaluate(() => { const i = document.activeElement; const id = i?.getAttribute('aria-activedescendant'); return !!id && document.getElementById(id)?.getAttribute('data-cmd') })
    check('IXD 6-1 Ctrl+K 打开：焦点在 role=combobox 的输入框；输入「平仓」第一行是全部平仓（activedescendant 指向它）', role === 'combobox' && first === 'agent:flatten_all' && desc === 'agent:flatten_all', JSON.stringify({ role, first, desc }))
    const f0 = kernel.commands.filter((c) => c.action === 'takeover.flatten_all').length
    const flat = () => kernel.commands.filter((c) => c.action === 'takeover.flatten_all').length - f0
    await page.keyboard.down('Enter') // 第一次回车：只武装
    await page.waitForSelector('.gr-palette__item.is-armed')
    await page.waitForTimeout(250) // 「回车确认」换字动画 150 ms
    await page.screenshot({ path: join(SHOTS, '1440-palette-armed.png') })
    await page.waitForTimeout(450)
    await page.keyboard.down('Enter') // 按住不放的连发（repeat:true）：过了死区也不执行
    await page.keyboard.up('Enter')
    await page.waitForTimeout(200)
    const repeatOk = flat() === 0 && (await page.$('.gr-palette__item.is-armed')) !== null
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    const disarmed = (await page.$('.gr-palette__item.is-armed')) === null
    check('IXD 6-3 武装后 ↓ 再 ↑：武装解除', disarmed)
    await page.keyboard.press('Enter') // 重新武装后立刻再按：600 ms 死区内无效
    await page.waitForSelector('.gr-palette__item.is-armed')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const deadOk = flat() === 0
    await page.waitForTimeout(700)
    await page.keyboard.press('Enter') // 过了死区：执行
    await page.waitForSelector('.gr-pin', { timeout: 4000 })
    check('IXD 6-2 武装后死区内的回车、按住连发（repeat:true）都不执行；过了 600 ms 再按才执行', repeatOk && deadOk && flat() === 1, JSON.stringify({ repeatOk, deadOk, sent: flat() }))
    await page.waitForFunction(() => !document.querySelector('.gr-palette'), null, { timeout: 2000 }).catch(() => {})
    const only = await page.evaluate(() => ({ pal: !!document.querySelector('.gr-palette'), pin: !!document.querySelector('.gr-pin') }))
    check('IXD 6-4 确认后面板先关，要 PIN 时屏上只有 PIN 弹层', !only.pal && only.pin, JSON.stringify(only))
    await page.keyboard.type(PIN)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => [...document.querySelectorAll('.gr-toast')].some((t) => t.textContent.includes('已全部平仓')), null, { timeout: 4000 }).catch(() => {})
    const okToast = await page.$$eval('.gr-toast[data-kind="ok"]', (els) => els.map((e) => e.textContent))
    check('IXD F3-1 面板路径读 TakeoverRecord：成功 toast 写结果「已全部平仓 · 交易已停止」', okToast.some((t) => t.includes('已全部平仓 · 交易已停止')), okToast.join(' | '))
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-palette'), null, { timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(300)
    check('IXD 12-3 命令面板 Esc 关闭后焦点不落到 body', await page.evaluate(() => document.activeElement && document.activeElement !== document.body))
    await ctx.close()
    installScenario(kernel, 'pending')
  }

  // 8b. 修复轮 1：M3 鼠标点命令行不抢焦点（按住回车的连发走输入框的 e.repeat 过滤）；M4 接管三入口互斥（壳的 <html data-takeover-busy>，跨入口）
  {
    const stage = installScenario(kernel, 'pending')
    const { ctx, page } = await openPage(1440, 900)
    const flatN = () => kernel.commands.filter((c) => c.action === 'takeover.flatten_all').length
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    const f0 = flatN()
    await page.click('.gr-palette [data-cmd="agent:flatten_all"]') // 鼠标点行 = 武装
    await page.waitForSelector('.gr-palette__item.is-armed')
    const focusIn = await page.evaluate(() => !!document.activeElement && document.activeElement.matches('.gr-palette__in input'))
    await page.keyboard.down('Enter') // 死区内的第一下
    for (let i = 0; i < 9; i += 1) { await sleep(100); await page.keyboard.down('Enter') } // 按住不放：之后都是 repeat:true，跨过 600 ms 死区
    await page.keyboard.up('Enter')
    await page.waitForTimeout(300)
    const m3 = { focusIn, sent: flatN() - f0, armed: (await page.$('.gr-palette__item.is-armed')) !== null, pin: (await page.$('.gr-pin')) !== null }
    check('M3 鼠标点命令行后焦点仍在输入框；按住回车（连发跨过死区）不执行全部平仓', m3.focusIn && m3.sent === 0 && !m3.pin, JSON.stringify(m3))
    await page.keyboard.press('Escape') // 先解除武装
    await page.keyboard.press('Escape') // 再关面板
    await page.waitForFunction(() => !document.querySelector('.gr-palette'), null, { timeout: 2000 }).catch(() => {})

    // 风险块的接管在跑（夹具让停止新开仓慢 3 s）→ 面板里三条接管命令置灰、标「执行中…」，打开设置照常
    stage.fault.delayMs = { 'takeover.halt_new': 3000 }
    const busyOn = () => page.waitForFunction(() => 'takeoverBusy' in document.documentElement.dataset, null, { timeout: 3000 }).then(() => true, () => false)
    const busyOff = () => page.waitForFunction(() => !('takeoverBusy' in document.documentElement.dataset), null, { timeout: 8000 }).then(() => true, () => false)
    await page.click('.gb-risk [data-act="takeover-halt_new"]')
    await page.waitForTimeout(700)
    await page.click('.gb-risk [data-act="takeover-halt_new-confirm"]')
    const on1 = await busyOn()
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    const rows = await page.$$eval('.gr-palette__item', (els) => els.map((e) => ({ id: e.getAttribute('data-cmd'), dis: e.getAttribute('aria-disabled'), t: e.textContent })))
    // fix-r4: agent:revoke_key 只是跳转（无 confirm），执行中照常可用，不计入三条接管命令
    check('M4 风险块的接管执行中：命令面板的三条接管命令 aria-disabled 且标「执行中…」，打开设置与撤销 Agent 钥匙…（跳转）照常', on1 && rows.filter((r) => r.id.startsWith('agent:') && r.id !== 'agent:revoke_key').length === 3 && rows.filter((r) => r.id.startsWith('agent:') && r.id !== 'agent:revoke_key').every((r) => r.dis === 'true' && r.t.includes('执行中')) && rows.find((r) => r.id === 'go:settings')?.dis !== 'true' && rows.find((r) => r.id === 'agent:revoke_key')?.dis !== 'true', JSON.stringify(rows.map((r) => r.id + ':' + r.dis)))
    await page.keyboard.press('Escape')
    const off1 = await busyOff()

    // 面板发出的接管在跑 → 风险块三档与状态条「接管」都禁用；落定后标清掉、入口恢复
    await page.waitForTimeout(300)
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    await page.keyboard.type('停止')
    await page.waitForFunction(() => document.querySelector('.gr-palette [data-cmd]')?.getAttribute('data-cmd') === 'agent:halt_new', null, { timeout: 2000 }).catch(() => {})
    await page.keyboard.press('Enter')
    await page.waitForSelector('.gr-palette__item.is-armed')
    await page.waitForTimeout(700)
    await page.keyboard.press('Enter')
    const on2 = await busyOn()
    await page.waitForTimeout(200)
    const blk = await page.evaluate(() => ({ risk: [...document.querySelectorAll('.gb-risk [data-act^="takeover-"]')].map((e) => e.disabled), sb: document.querySelector('[data-slot="statusbar"] [data-act="takeover"]')?.disabled ?? null }))
    check('M4 命令面板发出的接管执行中：风险块三档与状态条「接管」都禁用', on2 && blk.risk.length >= 3 && blk.risk.every(Boolean) && blk.sb === true, JSON.stringify(blk))
    const off2 = await busyOff()
    await page.waitForTimeout(300)
    const after = await page.evaluate(() => ({ risk: [...document.querySelectorAll('.gb-risk [data-act^="takeover-"]')].map((e) => e.disabled), sb: document.querySelector('[data-slot="statusbar"] [data-act="takeover"]')?.disabled ?? null }))
    check('M4 接管落定后 <html data-takeover-busy> 清掉、三入口恢复可点', off1 && off2 && after.risk.length >= 3 && after.risk.every((d) => !d) && after.sb === false, JSON.stringify({ off1, off2, ...after }))
    await ctx.close()
    installScenario(kernel, 'pending')
  }

  // 9. 设置（IXD 流程 7）：网络分段手动激活 + 确认前不变；没有主网钥匙 → 「导入主网钥匙」；restartRequired → 「待重启」；PIN 表单；导入失败挂栏
  {
    const { ctx, page } = await openPage(1440, 900, '#/settings/connect')
    await page.waitForSelector('.gr-seg__btn[data-v="mainnet"]')
    await page.click('.gr-seg__btn[data-v="mainnet"]')
    await page.waitForSelector('[data-ask="mainnet"]')
    const s71 = await page.evaluate(() => ({ test: document.querySelector('.gr-seg__btn[data-v="testnet"]').getAttribute('aria-checked'), main: document.querySelector('.gr-seg__btn[data-v="mainnet"]').getAttribute('aria-checked') }))
    check('IXD 7-1 点「主网」：确认条出现，分段仍选中测试网', s71.test === 'true' && s71.main === 'false', JSON.stringify(s71))
    await page.screenshot({ path: join(SHOTS, '1440-settings-mainnet-ask.png') })
    const ask = (await text(page, '[data-ask="mainnet"] .gr-btn--primary')).trim()
    await page.click('[data-ask="mainnet"] .gr-btn--primary')
    await page.waitForSelector('[data-form="key"]', { timeout: 4000 })
    const pre = await page.evaluate(() => document.querySelector('[data-form="key"] .gr-seg__btn[data-v="mainnet"]')?.getAttribute('aria-checked'))
    check('IXD 7-2 没有主网钥匙：确认条主钮是「导入主网钥匙」，点后导入表单出现且网络预选主网', ask === '导入主网钥匙' && pre === 'true' && (await page.evaluate(() => location.hash)) === '#/settings/keys', JSON.stringify({ ask, pre }))
    await page.fill('input[aria-label="钥匙名称"]', '主网交易')
    await page.fill('input[aria-label="API 钱包私钥"]', 'ab'.repeat(20)) // 够 32 位能提交，内核（夹具同口径）按格式拒绝
    await page.click('[data-act="key-save"]')
    await page.waitForFunction(() => /私钥格式不对/.test(document.querySelector('[data-form="key"]')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(150)
    const s75 = await page.evaluate(() => { const i = document.querySelector('input[aria-label="API 钱包私钥"]'); return { err: i?.closest('.gr-field')?.querySelector('.gr-field__err')?.textContent ?? '', empty: !!i && i.value === '', focus: !!i && document.activeElement === i } })
    check('IXD 7-5 导入失败：私钥栏下是内核原文、私钥栏已清空、焦点回私钥栏', s75.err.includes('私钥格式不对') && s75.empty && s75.focus, JSON.stringify(s75))
    await page.fill('input[aria-label="API 钱包私钥"]', randomBytes(32).toString('hex'))
    await page.click('[data-act="key-save"]')
    await page.waitForFunction(() => !document.querySelector('[data-form="key"]'), null, { timeout: 4000 }).catch(() => {})
    await page.evaluate(() => { location.hash = '#/settings/connect' })
    await page.waitForSelector('.gr-seg__btn[data-v="mainnet"]')
    await page.click('.gr-seg__btn[data-v="mainnet"]')
    await page.waitForSelector('[data-act="net-confirm"]', { timeout: 4000 })
    await page.click('[data-act="net-confirm"]')
    await page.waitForFunction(() => document.querySelector('.gr-set__restart') !== null, null, { timeout: 4000 }).catch(() => {})
    const toasts = await page.$$eval('.gr-toast', (els) => els.map((e) => e.textContent))
    const row = await text(page, '.gr-set__row--stack')
    check('IXD 7-3 切换成功（restartRequired）：网络行出「待重启」，toast 不说「已切到」', kernel.settings.network === 'mainnet' && row.includes('待重启') && toasts.length > 0 && !toasts.some((t) => t.includes('已切到')), `${toasts.join(' | ')} · ${row.replace(/\s+/g, ' ')}`)
    await page.screenshot({ path: join(SHOTS, '1440-settings-restart.png') })
    await page.click('.gr-seg__btn[data-v="testnet"]') // 切回测试网：收紧方向，直接保存
    for (let i = 0; i < 40 && kernel.settings.network !== 'testnet'; i += 1) await sleep(50)
    // PIN 表单（F7-5）：不一致提示的时机、保存的禁用、当前 PIN 栏能输字母；当前 PIN 错 → 原文挂在当前 PIN 栏、三栏清空、焦点回栏
    await page.evaluate(() => { location.hash = '#/settings/keys' })
    await page.waitForSelector('[data-act="pin-open"]')
    await page.click('[data-act="pin-open"]')
    await page.waitForSelector('input[aria-label="当前 PIN"]')
    const st = () => page.evaluate(() => ({ mis: (document.querySelector('[data-form="pin"]')?.textContent ?? '').includes('两次输入不一致'), dis: !!document.querySelector('[data-act="pin-save"]')?.disabled }))
    await page.fill('input[aria-label="当前 PIN"]', 'abc123xyz')
    const cur = await page.$eval('input[aria-label="当前 PIN"]', (e) => e.value)
    await page.fill('input[aria-label="新 PIN"]', '135790')
    await page.fill('input[aria-label="再输一次 PIN"]', '13')
    const a = await st()
    await page.fill('input[aria-label="再输一次 PIN"]', '135791')
    const bb = await st()
    await page.fill('input[aria-label="再输一次 PIN"]', '135790')
    const c = await st()
    check('IXD 7-4 PIN 表单：第二栏没输够不提示不一致、输够且不同才提示、一致前保存禁用；当前 PIN 栏能输字母', cur === 'abc123xyz' && !a.mis && a.dis && bb.mis && bb.dis && !c.mis && !c.dis, JSON.stringify({ cur, a, bb, c }))
    await page.click('[data-act="pin-save"]')
    await page.waitForFunction(() => /invalid PIN/.test(document.querySelector('[data-form="pin"]')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(150)
    const d = await page.evaluate(() => { const i = document.querySelector('input[aria-label="当前 PIN"]'); return { err: i?.closest('.gr-field')?.querySelector('.gr-field__err')?.textContent ?? '', empty: [...document.querySelectorAll('[data-form="pin"] input')].every((x) => x.value === ''), focus: !!i && document.activeElement === i } })
    check('IXD F7-5 当前 PIN 错：原文挂在当前 PIN 栏、三栏清空、焦点回该栏', d.err.includes('invalid PIN') && d.empty && d.focus, JSON.stringify(d))
    await ctx.close()
  }

  // 9b. 修复轮 1 · L7：导入钥匙时钥匙库锁着弹 PIN，在 PIN 层取消 = 命令没有发生（IXD 2-5）：私钥栏下不挂错、没有错误 toast
  {
    kernel.onCommand('credential.import', (_p, c) => { if (!c.attestation) throw problem('ATTESTATION_REQUIRED', 2010, 'enter your PIN to unlock the keystore'); throw problem('INVALID_PARAMS', -32602, '本用例不该走到这里') })
    const { ctx, page } = await openPage(1440, 900, '#/settings/keys')
    await page.waitForSelector('[data-act="key-open"]')
    await page.click('[data-act="key-open"]')
    await page.fill('input[aria-label="钥匙名称"]', '锁着的钥匙库')
    await page.fill('input[aria-label="API 钱包私钥"]', randomBytes(32).toString('hex'))
    await page.click('[data-act="key-save"]')
    const pinUp = await page.waitForSelector('.gr-pin', { timeout: 4000 }).then(() => true, () => false)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(400)
    const s = await page.evaluate(() => ({ form: !!document.querySelector('[data-form="key"]'), err: document.querySelector('[data-form="key"] .gr-field__err')?.textContent ?? '', toast: document.querySelectorAll('.gr-toast[data-kind="err"]').length }))
    check('L7 导入钥匙时在 PIN 层取消：私钥栏下不挂错、没有错误 toast（IXD 2-5）', pinUp && s.form && s.err === '' && s.toast === 0, JSON.stringify({ pinUp, ...s }))
    await ctx.close()
  }

  // 10. 陈旧数据（IXD 流程 9 的 1–2）：首连中不出；断开 > 2 s 块头出「已暂停更新 · mm:ss」；重连 2 s 内消失
  {
    const { ctx, page } = await mkPage(1440, 900)
    await page.route('**/api/session', async (route) => { await sleep(3000); await route.continue() }) // 会话换票故意慢 3 s：一直处在「还没连上过」
    await page.goto(kernel.launchUrl() + '#/', { waitUntil: 'load' })
    await page.waitForTimeout(2600)
    const early = await page.evaluate(() => ({ n: document.querySelectorAll('.gr-tile-p__head [data-stale]').length, tiles: document.querySelectorAll('.gr-wb__grid .gr-tile-p').length, k: document.documentElement.dataset.kernel }))
    await page.waitForFunction(() => window.__GR_READY__ && window.__GR_READY__.online === true, null, { timeout: 8000 })
    await page.waitForTimeout(600)
    const later = (await page.$$('.gr-tile-p__head [data-stale]')).length
    check('IXD 9-2 首次加载（还没连上过）不出陈旧小标', early.tiles === 5 && early.k !== 'open' && early.n === 0 && later === 0, JSON.stringify({ ...early, later }))
    await ctx.close()
  }
  {
    installScenario(kernel, 'pending')
    const { ctx, page } = await openPage(1440, 900)
    page.expectOffline = true
    await ctx.setOffline(true) // 断网 + 断开 WS：客户端退避重连全部失败，一直处在 reconnecting
    kernel.dropConnections()
    await page.waitForTimeout(12400)
    // r4：权益数字带移到总览条（C2），持仓表行内也去涨跌色（F9-1，施工单第 9 节 render.browser :874–883 同口径）
    const CLR = '[data-slot="statusbar"] .gr-up, [data-slot="statusbar"] .gr-down, .gb-pos .gr-up, .gb-pos .gr-down'
    const s = await page.evaluate((sel) => ({ heads: [...document.querySelectorAll('.gr-wb__grid .gr-tile-p')].map((t) => t.querySelector('.gr-tile-p__head [data-stale]')?.textContent ?? ''), slots: document.querySelectorAll('.gr-wb__grid .gr-tile-p > .gr-tile-p__head > .gr-tile-p__slot').length, color: document.querySelectorAll(sel).length, off: 'offline' in document.documentElement.dataset }), CLR)
    check('IXD 9-1 断开 12 s：五张卡头都出「已暂停更新 · 00:1x」（<html data-offline> 同步挂上），陈旧小标仍在 .gr-tile-p__head、槽仍在', s.heads.length === 5 && s.heads.every((t) => /已暂停更新 · 00:1\d/.test(t)) && s.slots === 5 && s.off, JSON.stringify(s.heads))
    check('IXD 9-1 陈旧期间总览条与持仓表去涨跌色（块包 C 实现）', s.color === 0, `.gr-up/.gr-down ${s.color} 个`)
    await page.screenshot({ path: join(SHOTS, '1440-stale.png') })
    await page.keyboard.press('Control+K')
    await page.waitForSelector('.gr-palette')
    await page.waitForTimeout(200)
    const off = await page.$$eval('.gr-palette__item', (els) => els.map((e) => ({ id: e.getAttribute('data-cmd'), dis: e.getAttribute('aria-disabled'), t: e.textContent })))
    // fix-r4: agent:revoke_key 只是跳转，离线时与「打开设置」一样照常可用
    check('IXD F6-5 离线时命令面板的接管类命令置灰并标「离线」，打开设置与撤销 Agent 钥匙…（跳转）照常', off.filter((o) => o.id.startsWith('agent:') && o.id !== 'agent:revoke_key').every((o) => o.dis === 'true' && o.t.includes('离线')) && off.find((o) => o.id === 'go:settings')?.dis !== 'true' && off.find((o) => o.id === 'agent:revoke_key')?.dis !== 'true', JSON.stringify(off.map((o) => o.id + ':' + o.dis)))
    await page.keyboard.press('Escape')
    await ctx.setOffline(false)
    await page.waitForFunction(() => document.documentElement.dataset.kernel === 'open', null, { timeout: 10000 })
    const t1 = Date.now()
    await page.waitForFunction(() => document.querySelectorAll('.gr-tile-p__head [data-stale]').length === 0, null, { timeout: 2600 }).catch(() => {})
    const gone = Date.now() - t1
    await page.waitForTimeout(300)
    const back = await page.$$eval(CLR, (els) => els.length)
    check('IXD 9-1 重连后 2 s 内块头小标消失', gone <= 2000 && (await page.$$('.gr-tile-p__head [data-stale]')).length === 0, `${gone} ms`)
    check('IXD 9-1 重连后涨跌色恢复（块包 C 实现）', back > 0, `.gr-up/.gr-down ${back} 个`)
    page.expectOffline = false
    await ctx.close()
  }

  // 11. 插件区（IXD 流程 10）：「插件」标 + 厂商名、不握手 → 「插件没有响应」、「N 个未加载」、aria-expanded + localStorage、iframe 焦点环
  {
    kernel.flags.silentPlugin = true
    kernel.flags.badPlugin = true
    const { ctx, page } = await openPage(1440, 900)
    await page.waitForSelector('[data-act="plugins-toggle"]', { timeout: 8000 })
    const bad = await page.$eval('[data-act="plugins-toggle"]', (e) => ({ t: e.textContent, why: e.querySelector('[data-bad]')?.getAttribute('title') ?? '' }))
    check('IXD F10-3 清单不合格的插件：折叠头写「1 个未加载」，悬停看原因', bad.t.includes('1 个未加载') && bad.why.includes('block.fixture.bad'), JSON.stringify(bad))
    const exp = () => page.$eval('[data-act="plugins-toggle"]', (e) => e.getAttribute('aria-expanded'))
    const ls = () => page.evaluate(() => localStorage.getItem('gitrader.plugins.open'))
    const e0 = await exp()
    await page.click('[data-act="plugins-toggle"]')
    const e1 = await exp(); const l1 = await ls()
    await page.focus('[data-act="plugins-toggle"]')
    await page.keyboard.press('Enter')
    const e2 = await exp(); const l2 = await ls()
    await page.keyboard.press('Enter')
    const e3 = await exp()
    check('IXD 10-3 折叠头 aria-expanded 随点击与 Enter 切换，状态写进 localStorage（gitrader.plugins.open）', e0 === 'false' && e1 === 'true' && l1 === '1' && e2 === 'false' && l2 === '0' && e3 === 'true', JSON.stringify({ e0, e1, l1, e2, l2, e3 }))
    await page.waitForSelector('.gr-dock iframe', { timeout: 6000 })
    const heads = await page.evaluate(() => ({
      plugin: [...document.querySelectorAll('.gr-dock__tile')].map((t) => ({ id: t.getAttribute('data-block'), tag: !!t.querySelector('.gr-tile-p__head [data-plugin]'), vendor: t.querySelector('.gr-tile-p__vendor')?.textContent ?? '', lock: !!t.querySelector('.gr-tile-p__pin') })),
      first: [...document.querySelectorAll('.gr-wb__grid .gr-tile-p')].map((t) => !!t.querySelector('[data-plugin]')),
    }))
    check('IXD 10-1 插件块头有「插件」标与厂商名、没有钉住锁标；五张一方卡头没有「插件」标', heads.plugin.length === 2 && heads.plugin.every((p) => p.tag && p.vendor && !p.lock) && heads.first.length === 5 && heads.first.every((x) => !x), JSON.stringify(heads))
    await page.waitForFunction(() => /插件没有响应/.test(document.querySelector('.gr-dock__tile[data-block="block.fixture.silent"]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
    const late = await page.evaluate(() => { const t = document.querySelector('.gr-dock__tile[data-block="block.fixture.silent"]'); return { msg: /插件没有响应/.test(t?.textContent ?? ''), reload: !!t?.querySelector('[data-act="plugin-reload"]'), others: /插件没有响应/.test(document.querySelector('.gr-dock__tile[data-block="block.example.ema-reading"]')?.textContent ?? '') } })
    check('IXD 10-2 插件 5 s 不握手：块内「插件没有响应」+「重新加载」（正常握手的插件不受影响）', late.msg && late.reload && !late.others, JSON.stringify(late))
    await page.screenshot({ path: join(SHOTS, '1440-plugins-silent.png') })
    await page.focus('.gr-dock__tile[data-block="block.example.ema-reading"] iframe')
    await page.waitForTimeout(100)
    const ring = await page.$eval('.gr-dock__tile[data-block="block.example.ema-reading"]', (e) => { const cs = getComputedStyle(e); return { w: parseFloat(cs.outlineWidth), s: cs.outlineStyle } })
    check('IXD 10-4 焦点进插件 iframe：外框有 ≥ 2px 焦点环', ring.s !== 'none' && ring.w >= 2, JSON.stringify(ring))
    await ctx.close()
    kernel.flags.silentPlugin = false
    kernel.flags.badPlugin = false
  }
  {
    const n0 = consoleErrors.length
    const { ctx, page } = await openPage(1440, 900, '#/', () => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('storage disabled', 'SecurityError') } }) })
    await page.waitForSelector('[data-act="plugins-toggle"]', { timeout: 8000 })
    await page.click('[data-act="plugins-toggle"]')
    await page.waitForSelector('.gr-dock iframe', { timeout: 6000 }).catch(() => {})
    const e1 = await page.$eval('[data-act="plugins-toggle"]', (e) => e.getAttribute('aria-expanded'))
    await page.click('[data-act="plugins-toggle"]')
    const e2 = await page.$eval('[data-act="plugins-toggle"]', (e) => e.getAttribute('aria-expanded'))
    check('IXD 10-3 存储不可用（读 localStorage 就抛）：壳照常启动、插件区照常展开收起、不报错', e1 === 'true' && e2 === 'false' && consoleErrors.length === n0, JSON.stringify({ e1, e2, errors: consoleErrors.slice(n0, n0 + 2) }))
    await ctx.close()
  }

  // 12. 关于（IXD 流程 11）：声明抽屉的焦点陷阱与归还、声明清单、署名链接
  {
    const { ctx, page } = await openPage(1440, 900, '#/about')
    await page.waitForSelector('[data-act="notices"]')
    await page.focus('[data-act="notices"]')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.gr-notices')
    await page.waitForTimeout(500)
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('.gr-notices'))
    const in0 = await inside()
    let stay = true
    for (let i = 0; i < 20; i += 1) { await page.keyboard.press('Tab'); if (!(await inside())) stay = false }
    const list = await text(page, '.gr-notices')
    await page.screenshot({ path: join(SHOTS, '1440-notices.png') })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-notices'), null, { timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(250)
    const back = await page.evaluate(() => document.activeElement?.getAttribute('data-act'))
    check('IXD 11-1 「第三方声明 ›」行 Enter 开抽屉：焦点进抽屉、连按 Tab 20 次不出抽屉、Esc 关闭后焦点回该行', in0 && stay && back === 'notices', JSON.stringify({ in0, stay, back }))
    check('IXD 11-2 声明列表含 Radix、Tailwind CSS、Geist 与改写自 shadcn / Beautiful UI / beUI 的条目', ['Radix', 'Tailwind CSS', 'Geist', 'shadcn', 'Beautiful UI', 'beUI'].every((k) => list.includes(k)), list.replace(/\s+/g, ' ').slice(0, 160))
    const pb = await page.$eval('[data-slot="powered-by"]', (e) => ({ tag: e.tagName, href: e.getAttribute('href'), target: e.getAttribute('target'), rel: e.getAttribute('rel') ?? '' }))
    check('IXD 11-3 署名徽标是新窗口打开 GitHub 仓库的链接（rel 含 noopener）', pb.tag === 'A' && pb.href === 'https://github.com/adtexterry-lgtm/gitrader' && pb.target === '_blank' && /\bnoopener\b/.test(pb.rel), JSON.stringify(pb))
    await ctx.close()
  }

  // 13. 全局（IXD 流程 12 的 3）：Tab 走一遍工作台，每个焦点都有 ≥ 2px 的环（输入框量外壳）；就地确认失效后焦点不落到 body
  {
    installScenario(kernel, 'pending')
    const { ctx, page } = await openPage(1440, 900)
    await page.mouse.move(720, 892)
    const seen = []
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab')
      const r = await page.evaluate(() => {
        const a = document.activeElement
        if (!a || a === document.body) return { end: true }
        const host = a.matches('input, textarea') ? (a.closest('.gr-input, .gr-pinfield__box') || a) : a
        const cs = getComputedStyle(host)
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || /0px 0px 0px (?:[2-9]|\d{2,})(?:\.\d+)?px/.test(cs.boxShadow)
        return { ring, owner: a.closest('.gr-tile-p__body, .gr-status') ? 'block' : 'shell', id: String(a.getAttribute('data-act') || a.getAttribute('data-nav') || a.getAttribute('aria-label') || a.className || a.tagName).slice(0, 48) }
      })
      if (r.end) break // 走到页尾、焦点回到浏览器自己
      seen.push(r)
    }
    const shellBad = seen.filter((r) => r.owner === 'shell' && !r.ring)
    const blockBad = seen.filter((r) => r.owner === 'block' && !r.ring)
    check('IXD 12-3 Tab 遍历工作台：壳的可聚焦件焦点环 ≥ 2px', seen.length > 5 && shellBad.length === 0, `${seen.length} 个焦点；缺环 ${shellBad.map((r) => r.id).join(' | ')}`)
    check('IXD 12-3 Tab 遍历工作台：块内可聚焦件焦点环 ≥ 2px（块包 C）', blockBad.length === 0, blockBad.map((r) => r.id).join(' | '))
    const trigger = '.gb-risk [data-act="takeover-halt_new"]'
    if (await page.$(trigger)) {
      await page.focus(trigger)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(5800) // 就地确认闲置 5 s 失效
      const after = await page.evaluate(() => ({ body: !document.activeElement || document.activeElement === document.body, act: document.activeElement?.getAttribute('data-act') }))
      check('IXD 12-3 就地确认闲置失效后焦点回触发钮（不落到 body）', !after.body, JSON.stringify(after))
    } else check('IXD 12-3 就地确认闲置失效后焦点回触发钮（不落到 body）', false, '风险块里没有 [data-act="takeover-halt_new"]')
    await ctx.close()
  }

  // 14. 手机视图（IXD F1-8 / F1-9 壳的部分）+ IXD 12-6（390：触控 ≥ 44、不含 emoji 与禁词）
  {
    installScenario(kernel, 'pending')
    const { ctx, page } = await openPage(390, 844)
    await page.waitForTimeout(300)
    const lay = await page.evaluate(() => {
      const top = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().top ?? -1)
      return {
        cols: getComputedStyle(document.querySelector('.gr-wb__grid')).gridTemplateColumns.split(' ').length,
        order: [...document.querySelectorAll('.gr-wb__grid [data-card]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => e.dataset.card),
        status: top('.gr-status'), content: top('.gr-content'),
        sw: document.documentElement.scrollWidth,
        folds: [...document.querySelectorAll('.gr-tile-p__sum')].map((b) => ({ a: b.getAttribute('data-act'), h: Math.round(b.getBoundingClientRect().height), x: b.getAttribute('aria-expanded') })),
      }
    })
    // r4（施工单第 9 节 shell.mjs :739–741）：单列 待批 → 持仓 → 风险 → Agent → 活动，除待批外四张折成 44 高摘要行
    check('IXD F1-8 / r4 390：单列 待批→持仓→风险→Agent→活动、四个摘要行 ≥ 44 且 aria-expanded=false、总览条在内容上方、无横向溢出', lay.cols === 1 && JSON.stringify(lay.order) === '["pending","positions","risk","agents","feed"]' && lay.status < lay.content && lay.sw <= 390 && lay.folds.length === 4 && lay.folds.every((f) => f.h >= 44 && f.x === 'false'), JSON.stringify(lay))
    await page.screenshot({ path: join(SHOTS, '390-workbench.png') })
    const probe = readFileSync(join(pkgDir, 'design/audit-probe.js'), 'utf8')
    const au = await page.evaluate(probe)
    const auBad = Object.entries(au.pass).filter(([, ok]) => !ok).map(([k]) => k)
    check('390 工作台视觉体检（audit-probe 全部 LIMITS）', auBad.length === 0, auBad.map((k) => `${k} ${JSON.stringify(au.samples?.[k] ?? au[k])}`).join(' | '))
    const small = await page.evaluate(() => {
      const SEL = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="menuitem"], [role="menuitemradio"], [role="option"], [tabindex]:not([tabindex="-1"])'
      return [...document.querySelectorAll(SEL)].filter((e) => {
        const r = e.getBoundingClientRect()
        if (!r.width || !r.height || e.closest('[aria-hidden="true"]')) return false
        const cs = getComputedStyle(e)
        if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false
        return r.width < 43.5 || r.height < 43.5
      }).map((e) => ({ id: String(e.getAttribute('data-act') || e.getAttribute('aria-label') || e.className || e.tagName).slice(0, 40), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), owner: e.closest('.gr-tile-p__body, .gr-status') ? 'block' : 'shell' }))
    })
    const sShell = small.filter((x) => x.owner === 'shell')
    const sBlock = small.filter((x) => x.owner === 'block')
    check('IXD 12-6 390：壳的可交互件包围盒都 ≥ 44×44', sShell.length === 0, sShell.map((x) => `${x.id} ${x.w}×${x.h}`).join(' | '))
    check('IXD 12-6 390：块内可交互件包围盒都 ≥ 44×44（块包 C）', sBlock.length === 0, sBlock.map((x) => `${x.id} ${x.w}×${x.h}`).join(' | '))
    await page.click('[data-act="fold-pos"]')
    await page.waitForTimeout(400)
    const opened = await page.evaluate(() => ({ x: document.querySelector('[data-act="fold-pos"]').getAttribute('aria-expanded'), body: !document.querySelector('[data-area="pos"] .gr-tile-p__body').hidden, h: Math.round(document.querySelector('[data-area="pos"] .gr-tile-p__body').getBoundingClientRect().height), rows: document.querySelectorAll('[data-area="pos"] tbody tr[data-row]').length }))
    check('IXD F1-9 摘要行点开就地展开（只读内容）', opened.x === 'true' && opened.body && opened.h > 100 && opened.rows > 0, JSON.stringify(opened))
    await page.click('[data-act="fold-pos"]')
    await page.locator('[data-act="approve"]:visible').first().click()
    await page.waitForSelector('.gr-pin')
    await page.waitForTimeout(400)
    const pr = await page.$eval('.gr-pin', (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width) } })
    check('IXD F1-8 390：PIN 贴顶（距顶 ≤ 12 + 安全区）、宽 = 视口 − 32', pr.top <= 13 && Math.abs(pr.w - 358) <= 1, JSON.stringify(pr))
    await page.screenshot({ path: join(SHOTS, '390-pin.png') })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.gr-pin'), null, { timeout: 3000 }).catch(() => {})
    const texts = []
    for (const hash of ['#/', '#/settings/connect', '#/settings/keys', '#/about']) { await page.evaluate((x) => { location.hash = x }, hash); await page.waitForTimeout(400); texts.push(await page.evaluate(() => document.body.innerText)) }
    const EMOJI = /\p{Emoji_Presentation}|\u{FE0F}/u
    const WORDS = /保守|激进|稳赚|跑赢|稳定盈利/
    // 页面文本层（innerText）扫；产物里中文是 \u 转义，直接扫产物是空转（H1），源码层由 build.mjs 的门禁扫（本脚本第 1 步的构建检查）
    const hit = texts.map((t) => (t.match(EMOJI) || t.match(WORDS) || [''])[0]).filter(Boolean)
    check('IXD 12-6 390 页面文本（innerText，四页）不含 emoji 与禁词（保守 / 激进 / 稳赚 / 跑赢 / 稳定盈利）；源码层见构建门禁', hit.length === 0, hit.join(' '))
    await ctx.close()
    const land = await openPage(844, 390)
    const cols = await land.page.$eval('.gr-wb__grid', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)
    const lsw = await land.page.evaluate(() => document.documentElement.scrollWidth)
    check('IXD F1-8 横屏 844×390 仍单列、无横向溢出', cols === 1 && lsw <= 844, `列 ${cols} · scrollWidth ${lsw}`)
    await land.page.screenshot({ path: join(SHOTS, '844x390-workbench.png') })
    await land.ctx.close()
  }

  // 6. 视觉体检（橙色预算、字号字重、嵌套…）。先关掉本脚本的浏览器再起体检的浏览器；体检的浏览器每页加载都要引导令牌，改成每次注入。
  installScenario(kernel, 'pending')
  kernel.options.injectAlways = true
  await browser.close(); browser = null
  // 必须异步起子进程：夹具内核跑在本进程里，spawnSync 会把它的事件循环堵死。
  const au = await new Promise((res) => {
    const p = spawn(process.execPath, [join(pkgDir, 'design/run-audit.mjs'), kernel.url + '/'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => res({ status: code, stdout: out }))
  })
  console.log(au.stdout)
  check('视觉体检 run-audit 全绿', au.status === 0, au.status === 0 ? '' : au.stdout.split(String.fromCharCode(10)).filter((l) => l.includes('超限') || l.includes('ERROR')).join(' | '))

  check('控制台 0 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (e) {
  check('冒烟脚本异常', false, String(e && e.stack ? e.stack : e).slice(0, 500))
} finally {
  try { await browser?.close() } catch { /* 已关闭 */ }
  try { await kernel?.close() } catch { /* 已关闭 */ }
  try { rmSync(join(here, '.tmp'), { recursive: true, force: true }) } catch { /* 无 */ }
  rmSync(tmp, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
writeFileSync(join(SHOTS, 'verify-result.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2))
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项；截图：${SHOTS}`)
process.exit(failed.length ? 1 : 0)
