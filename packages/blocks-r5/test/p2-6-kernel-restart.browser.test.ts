// SPDX-License-Identifier: CPAL-1.0
// P2-6：壳在会话内发现 /api/health 的 startedAt 变了，活动流里出现一条本页内存里的「内核已重启」行（不写内核账本）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildShell, openShell, type Shell } from './helpers/t2-shell'

const home = process.env.GITRADER_HOME
const enabled = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!process.env.GITRADER_EDGE && existsSync(process.env.GITRADER_EDGE)
let dir = ''
let sh: Shell
describe.skipIf(!enabled)('P2-6 kernel restart row in the activity feed', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(home!, 'p2-6-browser-'))
    sh = await openShell({ workDir: dir, staticDir: buildShell(join(dir, 'static')) })
  }, 120000)
  afterAll(async () => {
    await sh?.close()
    if (dir && resolve(dir).startsWith(resolve(home!) + sep)) rmSync(dir, { recursive: true, force: true })
  })
  it('inserts exactly one local row when startedAt changes', async () => {
    sh.applyPage('overview')
    await sh.open('#/overview')
    await sh.settled()
    expect(await sh.ev<number>(`document.querySelectorAll('[data-view="feed"] .g5-ar').length`)).toBeGreaterThan(0)
    expect(await sh.ev<boolean>(`document.querySelector('[data-view="feed"]').textContent.includes('内核已重启')`)).toBe(false)
    // 页面里的 /api/health：前两次返回同一个 startedAt，之后换成新的 = 内核重启过
    await sh.ev(`(() => { const real = window.fetch.bind(window); let n = 0; window.fetch = (input, init) => String(input).includes('/api/health') ? Promise.resolve(new Response(JSON.stringify({ ok: true, startedAt: n++ < 2 ? 1000 : 2000 }), { status: 200 })) : real(input, init); return 1 })()`)
    await sh.waitFor(`document.querySelector('[data-view="feed"]').textContent.includes('内核已重启')`, 25_000)
    expect(await sh.ev<number>(`[...document.querySelectorAll('[data-view="feed"] .g5-ar')].filter((n) => n.textContent.includes('内核已重启')).length`)).toBe(1)
  }, 40000)
})
