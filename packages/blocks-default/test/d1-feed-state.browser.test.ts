// SPDX-License-Identifier: CPAL-1.0
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildShell, openShell, type Shell } from '../../blocks-r5/test/helpers/t2-shell'

const home = process.env.GITRADER_HOME
const enabled = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!process.env.GITRADER_EDGE && existsSync(process.env.GITRADER_EDGE)
let dir = ''
let sh: Shell | undefined
describe.skipIf(!enabled)('D1 market feed versus kernel connection', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(home!, 'd1-browser-'))
    sh = await openShell({ workDir: dir, staticDir: buildShell(join(dir, 'static')) })
  }, 120000)
  afterAll(async () => {
    await sh?.close()
    if (dir && resolve(dir).startsWith(resolve(home!) + sep)) rmSync(dir, { recursive: true, force: true })
  })
  it('marks positions stale without declaring the kernel offline and recovers on fresh quotes', async () => {
    sh!.applyPage('overview')
    let down = false
    let last = Date.now()
    sh!.kernel.onQuery('status', () => ({ accounts: sh!.stage.sc.accounts.map((a) => ({ ...a, status: 'active' })), connectors: [{ id: 'venue_fixture', status: { wsState: down ? 'disconnected' : 'connected', lastMessageTs: down ? last : Date.now() } }] }))
    sh!.kernel.onQuery('account.positions', (p) => (sh!.stage.sc.positions[String((p as { accountId: string }).accountId)] ?? []).map((position) => ({ ...position, markTs: down ? last : Date.now() })))
    await sh!.open('#/overview')
    await sh!.settled()
    await sh!.waitFor('document.documentElement.dataset.feed === "live"')
    last = Date.now() - 10000
    down = true
    sh!.kernel.publish('venue.status', {})
    await sh!.waitFor('document.documentElement.dataset.feed === "down" && !!document.querySelector("#pos [data-feed-stale]")')
    expect(await sh!.ev('document.documentElement.hasAttribute("data-offline")')).toBe(false)
    expect(await sh!.ev('document.querySelector("#pos").textContent.includes("行情中断")')).toBe(true)
    expect(await sh!.ev('document.querySelectorAll("#pos [data-n=upnl] .gr-up, #pos [data-n=upnl] .gr-down").length')).toBe(0)
    down = false
    sh!.kernel.publish('venue.status', {})
    await sh!.waitFor('document.documentElement.dataset.feed === "live"', 5000)
  })
})
