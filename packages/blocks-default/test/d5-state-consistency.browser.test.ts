// SPDX-License-Identifier: CPAL-1.0
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildShell, openShell, type Shell } from '../../blocks-r5/test/helpers/t2-shell'
import { problem } from '../../workbench/verify/fixture-kernel'

const home = process.env.GITRADER_HOME
const enabled = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!process.env.GITRADER_EDGE && existsSync(process.env.GITRADER_EDGE)
let dir = ''
let sh: Shell | undefined
describe.skipIf(!enabled)('D5 scoped state and command failure', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(home!, 'd5-browser-'))
    sh = await openShell({ workDir: dir, staticDir: buildShell(join(dir, 'static')) })
  }, 120000)
  afterAll(async () => {
    await sh?.close()
    if (dir && resolve(dir).startsWith(resolve(home!) + sep)) rmSync(dir, { recursive: true, force: true })
  })
  it('shows the same scoped stop in the strip and panel and displays a failed flatten action', async () => {
    sh!.applyPage('overview')
    const accountId = sh!.stage.sc.accounts[0]!.accountId
    const risk = { ...sh!.stage.sc.risk, tradingState: 'ACTIVE', reasons: [] as unknown[] }
    sh!.kernel.onQuery('risk.state', () => risk)
    sh!.kernel.onCommand('takeover.flatten_all', () => { throw problem('STALE_PRICE', 2007, '行情陈旧，无法平仓') })
    await sh!.open('#/overview')
    await sh!.settled()
    risk.tradingState = 'HALTED'
    risk.reasons = [{ scope: { type: 'account', id: accountId }, state: 'HALTED', reason: '账户停机' }]
    sh!.kernel.publish('risk.state', { scope: { type: 'account', id: accountId }, to: 'HALTED', reason: '账户停机' })
    // 用例选择器修正：真壳是 ?ui=r5，顶栏风险格是 [data-act="strip-risk"] [data-state-text]（fundcard.tsx），不是 r4 的 .gb-sb__state（statusbar.tsx）。
    const stripState = '[data-act="strip-risk"] [data-state-text]'
    await sh!.waitFor(`!!document.querySelector('[data-view="risk"] [data-scope="${accountId}"]') && document.querySelector('${stripState}')?.dataset.stateText === 'HALTED'`)
    expect(await sh!.ev('!!document.querySelector("[data-view=risk] [data-scope=org]")')).toBe(false)
    expect(await sh!.ev(`document.querySelector('${stripState}').textContent.includes("账户")`)).toBe(true)
    await sh!.click('[data-view="risk"] [data-act="takeover-flatten_all"]')
    await sh!.click('[data-view="risk"] [data-act="arm-confirm"]')
    await sh!.waitFor('document.querySelector(".gr-toasts")?.textContent.includes("行情陈旧，无法平仓")') // 维护者裁决：toast 与行内都是内核原文的中文，不再追加固定尾句
    expect(await sh!.ev('document.querySelector("[data-view=risk]").textContent.includes("行情陈旧")')).toBe(true)
  })
})
