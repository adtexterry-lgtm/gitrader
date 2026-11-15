// SPDX-License-Identifier: CPAL-1.0
// 夹具内核 + 真壳的对账处理旅程；不声称是真内核双提案端到端验收。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ReconcileAccountView, ReconcileReviewItem } from '@gitrader/protocol/types'
import { problem } from '../../workbench/verify/fixture-kernel'
import { buildShell, openShell, PIN, type Shell } from './helpers/t2-shell'

const home = process.env.GITRADER_HOME
const edge = process.env.GITRADER_EDGE
const browserAvailable = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!edge && existsSync(edge)
let root = ''
let sh: Shell | undefined

async function enterPin() {
  await sh!.waitFor('!!document.querySelector(".gr-pin input")')
  await sh!.type('.gr-pin input', PIN)
  await sh!.waitFor('document.querySelector("[data-act=pin-confirm]") && !document.querySelector("[data-act=pin-confirm]").disabled')
  await sh!.click('[data-act="pin-confirm"]')
  await sh!.waitFor('!document.querySelector(".gr-pin")')
}

describe.skipIf(!browserAvailable)('P1-2 reconcile browser flow', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(home!, 'p1-2-reconcile-'))
    if (!resolve(root).startsWith(resolve(home!) + sep)) throw new Error('temporary directory escaped GITRADER_HOME')
    const staticDir = buildShell(join(root, 'static'))
    sh = await openShell({ staticDir, workDir: root })
  }, 120_000)

  afterAll(async () => {
    await sh?.close()
    if (root && resolve(root).startsWith(resolve(home!) + sep)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('风险入口逐项处理两笔对账待办，回到风险后恢复', async () => {
    sh!.applyPage('overview')
    const accountId = String(sh!.stage.sc.accounts[0]!.accountId) as ReconcileReviewItem['accountId']
    const finding = (id: string) => ({ id, code: 'position_difference', severity: 'blocker' as const,
      detail: '账户持仓存在差异', advice: { action: 'review', requiresHuman: true, why: '需要核对' },
      evidence: [{ report: 'report_fixture', id: `${id}_e`, field: 'size', value: '1' }] })
    let items: ReconcileReviewItem[] = [0, 1].map((n) => ({ itemId: `review_fixture_${n}`, accountId, kind: 'known_difference',
      evidenceDigest: `digest_fixture_${n}`, observedAt: Date.now(), summary: '持仓差异待核对', blocking: true,
      finding: finding(`finding_fixture_${n}`) }))
    const status = (): ReconcileAccountView[] => [{ accountId, state: 'ready', verdict: items.length ? 'blocked' : 'clean',
      findings: items.map((item) => item.finding!), suggestions: [], reviews: structuredClone(items) }]

    sh!.kernel.onQuery('reconcile.status', () => status())
    // 用例夹具修正：真内核恢复成功后 risk.state 变 ACTIVE；风险卡成功后会重查 risk.state，仍 HALTED 时只会提示「仍有 N 项停机」而不是「已恢复交易」（risk.tsx StatusLine）。
    let halted = true
    sh!.kernel.onQuery('risk.state', () => halted
      ? { tradingState: 'HALTED', accounts: sh!.stage.sc.accounts, reasons: [{ scope: { type: 'org' }, state: 'HALTED', reason: '需要处理对账待办' }] }
      : { tradingState: 'ACTIVE', accounts: sh!.stage.sc.accounts, reasons: [] })
    sh!.kernel.onCommand('reconcile.resolve', (params, ctx) => {
      if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '需要 PIN 确认')
      const input = params as { itemId: string; reason: string }
      const current = items.find((item) => item.itemId === input.itemId)
      if (!current || !input.reason) throw problem('VALIDATION_FAILED', 4000, '处理项已变化')
      items = items.filter((item) => item.itemId !== input.itemId)
      return { receipt: { resolutionId: `resolution_${input.itemId}`, input: params, resolvedAt: Date.now(), resolvedBy: 'user_fixture' }, alreadyRecorded: false }
    })
    sh!.kernel.onCommand('trading_state.resume', (_params, ctx) => {
      if (items.length) throw problem('TRADING_STATE_INVALID', 4001, '仍有对账待办')
      if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '需要 PIN 确认')
      halted = false
      return { tradingState: 'ACTIVE' }
    })

    await sh!.open('#/overview')
    await sh!.settled()
    await sh!.click('[data-view="risk"] [data-act="resume"]')
    await sh!.click('[data-act="arm-confirm"]')
    await sh!.waitFor('!!document.querySelector("[data-act=reconcile-entry]")')
    await sh!.click('[data-act="reconcile-entry"]')
    await sh!.waitFor('location.hash === "#/reconcile" && document.querySelectorAll("[data-review=known_difference]").length === 2')

    for (let remaining = 2; remaining > 0; remaining -= 1) {
      await sh!.type('[aria-label="处理理由"]', `已核对第 ${3 - remaining} 项`)
      await sh!.click('[data-act="reconcile-resolve"]')
      await enterPin()
      await sh!.waitFor(`document.querySelectorAll("[data-review=known_difference]").length === ${remaining - 1}`)
    }
    expect(await sh!.ev('document.body.innerText.includes("对账待处理项已清零")')).toBe(true)
    await sh!.click('.g5-rec-card button.g5-btn-ghost')
    await sh!.waitFor('location.hash === "#/workbench"')
    await sh!.waitFor('!!document.querySelector("[data-view=risk] [data-act=resume]")')
    await sh!.click('[data-view="risk"] [data-act="resume"]')
    await sh!.click('[data-act="arm-confirm"]')
    await enterPin()
    await sh!.waitFor('document.body.innerText.includes("已恢复交易")')
    expect(sh!.commands('trading_state.resume').some((call) => !!call.attestation)).toBe(true)
  }, 60_000)

  // fix-r4 C10：真内核恢复被对账挡住时抛 TRADING_STATE（或 BUSY）+ 英文原文；reconcile.status 没有 blocking 项（count=0）也要出持久行和「进入对账」。
  for (const [code, name, raw] of [[2002, 'TRADING_STATE', 'review pending reconciliation items before resuming'], [4004, 'BUSY', 'confirmation follow-up is in progress']] as const) {
    it(`恢复被挡（${name} · 内核原文）：对账 reviews 为空也出「恢复被挡住」持久行 + 进入对账`, async () => {
      sh!.applyPage('overview')
      const accountId = String(sh!.stage.sc.accounts[0]!.accountId) as ReconcileReviewItem['accountId']
      sh!.kernel.onQuery('reconcile.status', () => [{ accountId, state: 'ready', verdict: 'clean', findings: [], suggestions: [], reviews: [] }])
      sh!.kernel.onQuery('risk.state', () => ({ tradingState: 'HALTED', accounts: sh!.stage.sc.accounts, reasons: [{ scope: { type: 'org' }, state: 'HALTED', reason: 'takeover flatten_all: 人在检阅面触发' }] }))
      sh!.kernel.onCommand('trading_state.resume', () => { throw problem(name, code, raw) })
      await sh!.open('#/overview')
      await sh!.settled()
      await sh!.click('[data-view="risk"] [data-act="resume"]')
      await sh!.click('[data-act="arm-confirm"]')
      await sh!.waitFor('!!document.querySelector("[data-view=risk] [data-act=reconcile-entry]")')
      expect(await sh!.ev('document.querySelector("[data-view=risk] [data-act=rec-blocked]").innerText.trim()')).toBe('恢复被挡住：有对账待处理')
      expect(await sh!.ev('!!document.querySelector("[data-view=risk] [data-act=arm-confirm]")')).toBe(false)
      await sh!.click('[data-view="risk"] [data-act="reconcile-entry"]')
      await sh!.waitFor('location.hash === "#/reconcile"')
    }, 60_000)
  }
})
