// SPDX-License-Identifier: CPAL-1.0
// 人类模拟器（Playwright 无头 Edge）。只做两件事：在浏览器设 PIN（setPin）、在待批卡点批准（approve）。
// 其它任何操作都不做；每个动作记进 actions（即 human-actions.json）。PIN 只经这里进浏览器，不进 Agent 提示词。
import { createRequire } from 'node:module'
import { screenCode } from './patterns.mjs'
import { addVisible, pageVisibleErrors, RULE_SELECTORS } from './visible-errors.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function createHuman({ playwright, edge, pin, shotsDir }) {
  const { chromium } = createRequire(import.meta.url)(playwright)
  const browser = await chromium.launch({ executablePath: edge, headless: true, args: ['--lang=zh-CN'] })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  // toast 错误 8 s 就消失：页内观察器随手记下
  await ctx.addInitScript(() => {
    window.__e0Toasts = []; window.__e0ToastsAll = []
    const scan = () => document.querySelectorAll('.gr-toast').forEach((el) => {
      const t = el.textContent.trim(); if (!t) return
      if (!window.__e0ToastsAll.includes(t)) window.__e0ToastsAll.push(t)
      if ((el.getAttribute('data-kind') === 'err' || el.getAttribute('role') === 'alert') && !window.__e0Toasts.includes(t)) window.__e0Toasts.push(t)
    })
    new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true })
  })
  const st = { page: null, consoleErrors: [], toastErrors: [], screenCodes: [], englishLines: [], visible: [], actions: [], shots: 0 }
  const act = (kind, extra = {}) => { st.actions.push({ kind, at: Date.now(), ...extra }); return true }
  /** 页面快照 -> 判据 j 的可见报错（红色规则行 / 错误页）；每条记下当前截图路径。扫描失败不影响流程。 */
  const scan = async (path) => {
    try {
      const snap = await st.page.evaluate((sels) => {
        const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
        return { title: document.title, body: document.body?.innerText ?? '', rules: [...document.querySelectorAll(sels.join(','))].filter(vis).map((el) => el.textContent.trim()).filter(Boolean) }
      }, RULE_SELECTORS)
      for (const v of pageVisibleErrors(snap)) addVisible(st.visible, v, path)
    } catch { /* 页面已关 / 正在跳转 */ }
  }
  const shot = async (name, { scanPage = true } = {}) => {
    const path = `${shotsDir}/${String(++st.shots).padStart(2, '0')}-${name}.png`
    if (scanPage) await scan(path)
    for (const v of st.visible) if (!v.shots.length) v.shots.push(path) // 先于截图发生、还没挂图的（toast / HTTP 状态）挂到这一张
    try { await st.page?.screenshot({ path }) } catch { /* 截图失败不影响判据 */ }
    return path
  }

  async function open(url) {
    st.page = await ctx.newPage()
    st.page.on('console', (m) => { if (m.type() === 'error') st.consoleErrors.push(m.text().replace(/launch=[^&#\s]+/g, 'launch=…').slice(0, 300)) })
    st.page.on('pageerror', (e) => st.consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`))
    st.page.on('response', (r) => { if (r.status() >= 400 && r.request().isNavigationRequest() && r.frame() === st.page.mainFrame()) addVisible(st.visible, { kind: 'http', text: `HTTP ${r.status()} ${r.url().replace(/launch=[^&#\s]+/g, 'launch=…').slice(0, 120)}` }) })
    try { await st.page.goto(url, { waitUntil: 'load', timeout: 20000 }) } catch (e) {
      // 浏览器自己的错误页（如 ERR_CONNECTION_REFUSED）：截一张，记一条，再把原异常交给调用方
      addVisible(st.visible, { kind: 'nav', text: `导航失败: ${String(e.message).split(/\r?\n/)[0].replace(/launch=[^&#\s]+/g, 'launch=…').slice(0, 160)}` }, await shot('nav-failed', { scanPage: false }))
      throw e
    }
    await sleep(1500)
    await shot('opened')
  }

  async function hasPinForm() {
    await st.page.evaluate(() => { location.hash = '#/settings/keys' })
    return await st.page.waitForSelector('[data-act="pin-open"]', { timeout: 8000 }).then(() => true).catch(() => false)
  }

  /** 设 PIN。已设返回 'already'；设置按钮找不到返回 'no-form'（界面上没有入口，如实记录，不绕路）。 */
  async function setPin() {
    if (!(await hasPinForm())) { await shot('no-pin-form'); return 'no-form' }
    const label = (await st.page.textContent('[data-act="pin-open"]')) ?? ''
    if (/修改/.test(label)) return 'already'
    await st.page.click('[data-act="pin-open"]')
    await st.page.fill('input[aria-label="新 PIN"]', pin)
    await st.page.fill('input[aria-label="再输一次 PIN"]', pin)
    await st.page.click('[data-act="pin-save"]')
    await sleep(2500)
    await shot('pin-saved')
    act('setPin')
    return 'set'
  }

  /** 在待批卡点批准（PIN 层要求在场证明时输同一个测试 PIN）。没有可批的卡返回 false。 */
  async function approve({ waitMs = 8000 } = {}) {
    await st.page.evaluate(() => { location.hash = '#/' })
    const btn = 'button[data-act="approve"]:not([disabled])'
    // 待批浮层收起时先展开一次（waitMs=0 的巡视也要做，否则永远看不到批准键）
    if (await st.page.$('html[data-pend="collapsed"] [data-pend-toggle]')) await st.page.click('[data-pend-toggle]').catch(() => undefined)
    const t0 = Date.now()
    while (Date.now() - t0 < waitMs) {
      if (await st.page.$(btn)) break
      if (await st.page.$('html[data-pend="collapsed"] [data-pend-toggle]')) await st.page.click('[data-pend-toggle]').catch(() => undefined)
      await sleep(500)
    }
    if (!(await st.page.$(btn))) { if (waitMs) await shot('no-pending'); return false }
    await sleep(900) // 弹层刚出现有防误点死区
    await shot('pending')
    await st.page.click(btn)
    if (await st.page.waitForSelector('.gr-pin input', { timeout: 4000 }).catch(() => null)) {
      await st.page.fill('.gr-pin input', pin)
      await st.page.click('.gr-pin .gr-btn--primary')
    }
    await sleep(4000)
    await shot('approved')
    act('approve')
    return true
  }

  /** 批准 Agent 接入请求（ADR-13）：核对卡上内容后点批准，PIN 层输同一个测试 PIN。仍属「输 PIN + 点批准」两件事。没有请求卡返回 false。 */
  async function approveRequest() {
    if (!st.page) return false
    const btn = '[data-act="agent-request-approve"]:not([disabled])'
    if (!(await st.page.$(btn))) return false
    await sleep(900)
    await shot('agent-request')
    await st.page.click(btn)
    if (await st.page.waitForSelector('.gr-pin input', { timeout: 4000 }).catch(() => null)) {
      await st.page.fill('.gr-pin input', pin)
      await st.page.click('.gr-pin .gr-btn--primary')
    }
    await sleep(3000)
    await shot('agent-request-approved')
    act('approve', { what: 'agent-request' })
    return true
  }

  /** 收一遍浏览器侧证据：toast 错误 + 当前屏上的英文内部码。 */
  async function sweep() {
    if (!st.page) return
    try {
      for (const t of await st.page.evaluate(() => window.__e0Toasts ?? [])) { if (!st.toastErrors.includes(t)) st.toastErrors.push(t); addVisible(st.visible, { kind: 'toast', text: t.replace(/\s+/g, ' ').slice(0, 200) }) }
      await shot('sweep') // 检查点：扫一遍红字 / 错误页，并给 toast 挂图
      const text = await st.page.evaluate(() => document.body.innerText)
      for (const line of text.split(/\r?\n/)) { const c = screenCode(line); if (c && !st.screenCodes.includes(c)) st.screenCodes.push(c) }
      // 软提示（不进判据）：屏上出现的英文整句，和所有 toast 原文，供读报告的人判断是不是「用户语言」
      const tall = await st.page.evaluate(() => window.__e0ToastsAll ?? [])
      for (const line of [...text.split(/\r?\n/), ...tall]) if (!/[一-鿿]/.test(line) && /(?:[A-Za-z]+[ ,.']+){4,}/.test(line) && !st.englishLines.includes(line.trim())) st.englishLines.push(line.trim())
    } catch { /* 页面已关 */ }
  }

  return {
    open, setPin, approve, approveRequest, sweep, shot, act,
    reset: async () => { await st.page?.close().catch(() => undefined); st.page = null },
    get isOpen() { return !!st.page },
    browserEvidence: () => ({ consoleErrors: [...st.consoleErrors], toastErrors: [...st.toastErrors], screenCodes: [...st.screenCodes], englishLines: [...st.englishLines], visibleErrors: st.visible.map((v) => ({ ...v, shots: [...v.shots] })) }),
    actions: () => st.actions.map((a) => ({ ...a })),
    close: async () => { await browser.close().catch(() => undefined) },
  }
}
