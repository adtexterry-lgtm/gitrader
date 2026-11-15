// SPDX-License-Identifier: CPAL-1.0
// 真壳 + 夹具内核；截图、改动前几何基准与浏览器路径仅由命令行环境提供。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { problem } from '../../workbench/verify/fixture-kernel'
import { buildShell, openShell, PIN, type Shell } from './helpers/t2-shell'

const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const viewports = [[390, 844], [375, 812]] as const
const takeover = '[data-g5="fund"] [data-act="takeover"]'
const pages = '[data-act="pages"]'
const blocks = ['[data-pend-toggle]', '[data-view="positions"]', '[data-view="risk"]', '[data-view="keys"]', '[data-view="feed"]']
let root = ''
let sh: Shell
let requests: unknown[] = []

async function shot(name: string) {
  if (process.env.GITRADER_SHOTS_DIR) await sh.shot(join(process.env.GITRADER_SHOTS_DIR, `${name}.png`))
}
async function bounds(selector: string) {
  return sh.ev<{ x: number; y: number; width: number; height: number; right: number; bottom: number }>(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`)
}
async function hit(selector: string) {
  const result = await sh.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.height > 0 && r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight && !!target && el.contains(target);
  })()`)
  expect(result, selector).toBe(true)
}
async function noOverflow() {
  const result = await sh.ev<{ fits: boolean; wide: unknown }>(`({ fits: document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth, wide: [...document.querySelectorAll('.g5-main, .g5-shell-content, .g5-ws, .g5-card, .g5-tw, .g5-row')].filter(el => el.getBoundingClientRect().right > innerWidth).slice(0, 8).map(el => [el.className, el.getBoundingClientRect().x, el.getBoundingClientRect().width]) })`)
  expect(result.fits, JSON.stringify(result.wide)).toBe(true)
}
async function geometry() {
  return sh.ev(`Object.fromEntries(${JSON.stringify(['.g5-topbar', '[data-g5="fund"]', '.g5-ws', ...blocks.slice(1)])}.map(s => {
    const r = document.querySelector(s).getBoundingClientRect(); return [s, [r.x, r.y, r.width, r.height]];
  }))`)
}

beforeAll(async () => {
  root = mkdtempSync(join(home, 'p1-17-'))
  const staticDir = buildShell(join(root, 'static'))
  sh = await openShell({ staticDir, workDir: root, width: 390, height: 844 })
}, 120_000)

beforeEach(async () => {
  requests = []
  sh.applyPage('overview')
  // 中性夹具名称；延长待批期限，避免截图或 CI 耗时改变被测布局。
  sh.stage.sc.keys.forEach((key, i) => { key.name = `Agent ${i + 1}` })
  sh.stage.sc.proposals.forEach((p) => { if (p.status === 'pending') p.expiresAt = Date.now() + 600_000 })
  sh.kernel.onQuery('agentkey.request.list', () => ({ requests }))
  sh.kernel.onCommand('agentkey.request.approve', () => { throw problem('ATTESTATION_REQUIRED', 1010, '需要 PIN 确认') })
  await sh.setViewport(390, 844)
  await sh.open('#/overview')
  await sh.settled()
  await sh.ev(`window.dispatchEvent(new CustomEvent('gitrader:pend', { detail: { action: 'collapse' } }))`)
})

afterAll(async () => {
  if (sh) await sh.close()
  if (root && resolve(root).startsWith(resolve(home) + sep)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('P1-17 narrow shell', () => {
  it('no horizontal overflow at 390 and 375', async () => {
    for (const [width, height] of viewports) {
      await sh.setViewport(width, height)
      await noOverflow()
      for (const selector of blocks) {
        const r = await bounds(selector)
        expect(r.x, selector).toBeGreaterThanOrEqual(0)
        expect(r.right, selector).toBeLessThanOrEqual(width)
      }
    }
  })

  it('takeover button stays visible and hit-testable', async () => {
    for (const [width, height] of viewports) {
      await sh.setViewport(width, height)
      for (const atBottom of [false, true]) {
        await sh.ev(`window.scrollTo(0, ${atBottom ? 'document.scrollingElement.scrollHeight' : '0'})`)
        await hit(takeover)
        await hit('.g5-topbar [data-act="palette"]')
        await hit('.g5-topbar [data-act="settings"]')
      }
      await sh.click(takeover)
      await sh.waitFor('!!document.querySelector("[role=menu][aria-label=接管]")')
      await hit('[role="menu"][aria-label="接管"] [data-act="takeover-halt_new"]')
      await sh.click(takeover)
    }
  })

  it('pages menu opens and navigates', async () => {
    for (const [width, height] of viewports) {
      await sh.setViewport(width, height)
      await hit(pages)
      await sh.click(pages)
      await sh.waitFor('document.querySelector("[data-act=pages]")?.getAttribute("aria-expanded") === "true"')
      const links = '.g5-pages-menu a'
      expect(await sh.ev(`document.querySelectorAll('${links}').length`)).toBe(7)
      const rects = await sh.ev<Array<{ x: number; y: number; bottom: number }>>(`[...document.querySelectorAll('${links}')].map(el => el.getBoundingClientRect().toJSON())`)
      rects.slice(1).forEach((r, i) => { expect(r.x).toBe(rects[0]!.x); expect(r.y).toBeGreaterThanOrEqual(rects[i]!.bottom) })
      if (width === 390) await shot('pages-menu')
      await sh.ev('document.activeElement?.blur?.(), document.querySelector("[data-act=pages]").focus(), true')
      await sh.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await sh.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await sh.waitFor('!document.querySelector(".g5-pages-menu")')
      expect(await sh.ev('document.activeElement?.getAttribute("data-act")')).toBe('pages')
      await sh.click(pages)
      sh.applyPage('records')
      await sh.click('.g5-pages-menu [data-page="records"]')
      await sh.waitFor('!!document.querySelector(".g5-ws[data-g5-page=records]")')
      expect(await sh.ev('document.querySelector("[data-act=pages]").getAttribute("aria-expanded")')).toBe('false')
      await sh.click(pages)
      await sh.click('.g5-pages-menu [data-page="overview"]')
      await sh.settled()
    }
    await sh.ev('document.documentElement.dataset.nav = "rail"')
    await hit(pages)
    await hit(takeover)
    await hit('.g5-topbar [data-act="settings"]')
    await noOverflow()
  })

  it('overview single column order is pending, positions, risk, agent, activity', async () => {
    for (const [width, height] of viewports) {
      await sh.setViewport(width, height)
      await sh.ev('window.scrollTo(0, 0)')
      const rects = await Promise.all(blocks.map(bounds))
      rects.slice(1).forEach((r, i) => {
        expect(r.y, blocks[i + 1]).toBeGreaterThanOrEqual(rects[i]!.bottom)
        if (i > 0) { expect(r.x).toBe(rects[1]!.x); expect(r.width).toBe(rects[1]!.width) }
      })
      if (width === 390) await shot('overview-top')
      await sh.ev('document.querySelector("[data-view=feed]").scrollIntoView({ block: "end" })')
      const scroll = await sh.ev<{ top: number; nodes: unknown }>(`({ top: document.scrollingElement.scrollTop, nodes: ['html', 'body', '#app', '.gr-app', '.g5-frame', '.g5-main', '.g5-shell-content'].map(s => { const e = document.querySelector(s), c = getComputedStyle(e); return [s, e.clientHeight, e.scrollHeight, e.scrollTop, c.overflowY, e.getBoundingClientRect().height] }) })`)
      expect(scroll.top, JSON.stringify(scroll.nodes)).toBeGreaterThan(0)
      const activity = await bounds('[data-view="feed"]')
      expect(activity.bottom).toBeLessThanOrEqual(height)
      if (width === 390) {
        await sh.ev('window.scrollTo(0, scrollY + document.querySelector("[data-view=feed]").getBoundingClientRect().top - 56)')
        await shot('overview-activity')
      }
    }
  })

  it('desktop 1440 layout unchanged', async () => {
    await sh.setViewport(1440, 900)
    await sh.settled()
    const before = await geometry()
    const baseline = process.env.GITRADER_P1_17_BASELINE
    if (baseline && process.env.GITRADER_P1_17_CAPTURE === '1') writeFileSync(baseline, JSON.stringify(before))
    else if (baseline) expect(before).toEqual(JSON.parse(readFileSync(baseline, 'utf8')))
    for (const [width, height] of viewports) await sh.setViewport(width, height)
    await sh.setViewport(1440, 900)
    await sh.settled()
    expect(await geometry()).toEqual(before)
    expect(await sh.ev(`!!document.querySelector('${pages}')`)).toBe(false)
    expect(await sh.ev('getComputedStyle(document.documentElement).overflowY')).toBe('hidden')
    expect(await sh.ev('matchMedia("(max-width: 599px)").matches')).toBe(false)
    await sh.setViewport(600, 900)
    expect(await sh.ev(`!!document.querySelector('${pages}')`)).toBe(false)
    expect(await sh.ev('getComputedStyle(document.documentElement).overflowY')).toBe('hidden')
  })

  it('pending popover fits and its actions are reachable', async () => {
    for (const [width, height] of viewports) {
      await sh.setViewport(width, height)
      await sh.click('[data-pend-toggle]')
      await sh.waitFor('document.documentElement.dataset.pend === "open"')
      const r = await bounds('.g5-pendpop')
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.right).toBeLessThanOrEqual(width)
      expect(r.y).toBeGreaterThanOrEqual(40)
      expect(r.bottom).toBeLessThanOrEqual(height)
      await noOverflow()
      await hit('.g5-pendpop [data-act="pend-collapse"]')
      await sh.ev('document.querySelector(".g5-pacts").scrollIntoView({ block: "nearest" })')
      await hit('.g5-pendpop [data-act="approve"]')
      if (width === 390) await shot('pending-popover')
      await sh.click('.g5-pendpop [data-act="pend-collapse"]')
    }
  })

  it('positions and records retain four usable columns', async () => {
    const visibleHeadings = (table: string) => sh.ev<string[]>(`[...document.querySelectorAll(${JSON.stringify(table + ' thead th')})].filter(el => getComputedStyle(el).display !== 'none').map(el => el.textContent.trim())`)
    const cellsFit = async (table: string) => {
      const rows = await sh.ev<Array<{ x: number; right: number }>>(`[...document.querySelectorAll(${JSON.stringify(table + ' .g5-row > td')})].filter(el => getComputedStyle(el).display !== 'none').map(el => el.getBoundingClientRect().toJSON())`)
      expect(rows.length).toBeGreaterThanOrEqual(4)
      for (const r of rows) { expect(r.x).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(sh.width) }
    }
    for (const [width, height] of viewports) {
      await sh.setViewport(width, height)
      expect(await visibleHeadings('[data-tab="positions"]')).toEqual(['标的', '数量', '未实现', ''])
      await cellsFit('[data-tab="positions"]')
      await sh.click('[data-tab="positions"] [data-act="pos-expand"]')
      await sh.waitFor('!!document.querySelector(".g5o-xrow")')
      await noOverflow()
      sh.applyPage('records')
      await sh.goTo('#/records')
      await sh.settled()
      // 联动带来的标的筛选（夹具缺省 BTC）先清掉，看全部成交的列
      if (await sh.ev<boolean>(`!!document.querySelector('[data-act="clear-symbol"]')`)) { await sh.click('[data-act="clear-symbol"]'); await sh.settled() }
      expect(await visibleHeadings('[data-tab="fills"]')).toEqual(['标的', '方向', '已实现', ''])
      await cellsFit('[data-tab="fills"]')
      await noOverflow()
      await sh.click('[data-tab="fills"] [data-x]')
      await sh.waitFor('!!document.querySelector(".g5-xrow")')
      await noOverflow()
      await sh.click('[data-tab="orders"][role="tab"]')
      await sh.settled()
      expect(await visibleHeadings('.g5-tw[data-tab="orders"]')).toEqual(['标的', '方向', '状态', ''])
      await cellsFit('.g5-tw[data-tab="orders"]')
      await noOverflow()
      await sh.click('[data-tab="funding"][role="tab"]')
      await sh.settled()
      expect(await visibleHeadings('.g5-tw[data-tab="funding"]')).toEqual(['时间', '标的', '费率', '金额'])
      await cellsFit('.g5-tw[data-tab="funding"]')
      await noOverflow()
      sh.applyPage('overview')
      await sh.goTo('#/overview')
      await sh.settled()
    }
  })

  it('agent request and PIN fit without hiding their actions', async () => {
    requests = [{ requestId: 'akr_narrow', state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 600_000,
      input: { name: '演示助手', host: 'local-agent', tier: 'confirm', expiresInDays: 30, mandate: {
        accounts: ['paper-main'], venueAllowlist: ['paper'], instrumentAllowlist: ['ETH'], limits: { maxOrderNotional: '100', maxDailyNotional: '500' },
      } } }]
    await sh.waitFor('!!document.querySelector(".g5-agent-request")')
    for (const [width, height] of viewports) {
      await sh.setViewport(width, height)
      const r = await bounds('.g5-agent-request')
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.right).toBeLessThanOrEqual(width)
      expect(r.bottom).toBeLessThanOrEqual(height)
      await hit('[data-act="agent-request-approve"]')
      await hit(takeover)
      await sh.click('[data-act="agent-request-approve"]')
      await sh.waitFor('!!document.querySelector(".gr-pin[role=dialog]")')
      const pin = await bounds('.gr-pin')
      expect(pin.x).toBeGreaterThanOrEqual(0)
      expect(pin.right).toBeLessThanOrEqual(width)
      expect(pin.y).toBeGreaterThanOrEqual(0)
      expect(pin.bottom).toBeLessThanOrEqual(height)
      await sh.type('.gr-pin input', PIN)
      await hit('[data-act="pin-confirm"]')
      await hit('[data-act="pin-cancel"]')
      await sh.click('[data-act="pin-cancel"]')
      await sh.waitFor('!document.querySelector(".gr-pin[role=dialog]")')
    }
  })
})
