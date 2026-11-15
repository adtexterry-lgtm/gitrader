// SPDX-License-Identifier: CPAL-1.0
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildShell, openShell, PIN, type Shell } from './helpers/t2-shell'
import { problem } from '../../workbench/verify/fixture-kernel'

const home = process.env.GITRADER_HOME
const enabled = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!process.env.GITRADER_EDGE && existsSync(process.env.GITRADER_EDGE)
let dir = ''
let sh: Shell | undefined
describe.skipIf(!enabled)('P2-3 tightening and loosening presence', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(home!, 'p2-3-browser-'))
    sh = await openShell({ workDir: dir, staticDir: buildShell(join(dir, 'static')) })
  }, 120000)
  afterAll(async () => {
    await sh?.close()
    if (dir && resolve(dir).startsWith(resolve(home!) + sep)) rmSync(dir, { recursive: true, force: true })
  })
  it('sends a tighter value without PIN and retains PIN for a wider value', async () => {
    sh!.applyPage('overview')
    const risk = { ...sh!.stage.sc.risk, limits: { maxOrderNotional: '100' } }
    let tightened = 0
    let relaxed = 0
    sh!.kernel.onQuery('risk.state', () => risk)
    sh!.kernel.onCommand('risk.tighten', (p, ctx) => {
      expect(ctx.attestation).toBeUndefined()
      risk.limits = (p as { patch: { limits: typeof risk.limits } }).patch.limits
      tightened++
      return { ok: true }
    })
    sh!.kernel.onCommand('risk.relax', (p, ctx) => {
      if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 2010, '需要 PIN 确认')
      risk.limits = (p as { patch: { limits: typeof risk.limits } }).patch.limits
      relaxed++
      return { ok: true }
    })
    // fix-r4: 放宽默认走 risk.temporaryRelax（同样要 PIN），计入 relaxed；永久 risk.relax 只在二次确认里（overview.browser 覆盖）
    sh!.kernel.onCommand('risk.temporaryRelax', (_p, ctx) => {
      if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 2010, '需要 PIN 确认')
      relaxed++
      return { ok: true }
    })
    await sh!.open('#/overview')
    await sh!.settled()
    await sh!.click('[data-act="risk-relax"]')
    await sh!.type('[aria-label="新上限"]', '90')
    await sh!.click('[data-act="risk-relax-confirm"]')
    await sh!.waitFor('document.querySelector(".gr-toasts")?.textContent.includes("已收紧")')
    expect(tightened).toBe(1)
    expect(await sh!.ev('!!document.querySelector(".gr-pin")')).toBe(false)
    await sh!.click('[data-act="risk-relax"]')
    await sh!.type('[aria-label="新上限"]', '110')
    await sh!.click('[data-act="risk-relax-confirm"]')
    await sh!.waitFor('!!document.querySelector(".gr-pin input")')
    expect(relaxed).toBe(0)
    await sh!.type('.gr-pin input', PIN)
    await sh!.click('[data-act="pin-confirm"]')
    await sh!.waitFor('!document.querySelector(".gr-pin")')
    expect(relaxed).toBe(1)
  })
})
