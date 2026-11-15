// SPDX-License-Identifier: CPAL-1.0
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildShell, openShell, repo, type PageKey, type Shell } from './helpers/t2-shell'

const home = process.env.GITRADER_HOME
const enabled = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!process.env.GITRADER_EDGE && existsSync(process.env.GITRADER_EDGE)
let dir = ''
let sh: Shell
const view = async (width: number) => { await sh.setViewport(width, width === 390 ? 844 : 900); await new Promise((r) => setTimeout(r, 300)) }
async function overview(width = 1280) {
  sh.applyPage('overview')
  sh.stage.sc.keys.forEach((key, i) => { key.name = `Agent ${i + 1}` })
  sh.stage.sc.proposals.forEach((p) => { if (p.status === 'pending') { p.expiresAt = Date.now() + 600000; p.reason = '核对价格、持仓与当前限额后再处理本提案。'.repeat(30) } })
  const instruments = [...new Set(Object.values(sh.stage.sc.positions).flat().map((p) => p.instrumentId))]
  sh.kernel.onQuery('market.instruments', () => instruments.map((instrumentId) => ({ instrumentId, price: { tick: '0.01', maxDecimals: 2 } })))
  for (const p of Object.values(sh.stage.sc.positions).flat()) { p.markPrice = '12345.678912' as never; p.markTs = Date.now() }
  // Explicit duplicate and approval fixtures, not a vacuous scan of unrelated rows.
  const seed = sh.stage.sc.ledger[0]!
  sh.stage.sc.ledger.unshift({ ...seed, id: 'x1-denied' as never, seq: 9001, type: 'risk.denied', ts: Date.now(), payload: {}, ruleHits: [] })
  // 用例夹具补齐：旧夹具里没有任何「需人批准」规则命中，琥珀待批提示（clock 图标）无从出现，断言会空跑
  sh.stage.sc.ledger.unshift({ ...seed, id: 'x1-approval' as never, seq: 9002, type: 'risk.denied', ts: Date.now(), payload: {},
    ruleHits: [{ ruleId: 'mdt_x1#approval', code: 'NEEDS_APPROVAL', limit: '0', actual: '1', unit: 'entries', action: 'review', scope: 'org' }] } as never)
  await sh.open('#/overview')
  await sh.settled()
  await view(width) // 用例修正：t2-shell 的 open() 每次导航都会把视口重置回 1440，必须在 open 之后再设宽度，否则 1280 / 390 等断言实际跑在 1440 上
  await sh.ev(`window.dispatchEvent(new CustomEvent('gitrader:pend', { detail: { action: 'collapse' } }))`)
}
async function noPageOverflow() {
  const b = await sh.ev<{ scroll: number; client: number }>(`({scroll:document.scrollingElement.scrollWidth,client:document.scrollingElement.clientWidth})`)
  expect(b.scroll).toBeLessThanOrEqual(b.client)
}

describe.skipIf(!enabled)('X1 appearance in the real shell', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(home!, 'x1-browser-'))
    sh = await openShell({ workDir: dir, staticDir: buildShell(join(dir, 'static')) })
  }, 120000)
  afterAll(async () => {
    await sh?.close()
    if (dir && resolve(dir).startsWith(resolve(home!) + sep)) rmSync(dir, { recursive: true, force: true })
  })
  it('shows each state once and uses amber approval cues', async () => {
    await overview()
    const text = await sh.ev<string>(`document.querySelector('[data-view="feed"] [data-seq="9001"] .g5-l1').textContent`)
    expect(text).toBe('订单被拦截')
    expect(await sh.ev<string>(`document.querySelector('[data-view="feed"]').textContent`)).not.toMatch(/被拦截被拦截|只减仓只减仓/)
    expect(await sh.ev<number>(`document.querySelectorAll('.g5-await .gr-icon').length`)).toBeGreaterThan(0)
  })
  it('uses instrument precision for displayed prices', async () => {
    await overview()
    await sh.waitFor(`document.querySelector('[data-view="positions"] td[data-n="mark"]')?.textContent.includes('12,345.67')`)
    const texts = await sh.ev<string[]>(`Array.from(document.querySelectorAll('[data-view="positions"] td[data-n="entry"], [data-view="positions"] td[data-n="mark"], [data-view="positions"] td[data-n="sl"]')).map(e=>e.firstChild?.textContent||'')`)
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) for (const number of text.matchAll(/\d+\.(\d+)/g)) expect(number[1]!.length).toBeLessThanOrEqual(2)
  })
  it('reserves red buttons for destructive actions, including confirmation rows', async () => {
    await overview()
    await sh.click('[data-view="risk"] [data-act="takeover-halt_new"]')
    expect(await sh.ev<string>(`document.querySelector('[data-view="risk"] [data-act="arm-confirm"]').className`)).not.toContain('g5-btn-kill')
    const labels = await sh.ev<string[]>(`Array.from(document.querySelectorAll('button.g5-btn-kill, button.g5-danger')).filter(e=>e.getClientRects().length).map(e=>e.textContent.trim())`)
    for (const text of labels) expect(text).toMatch(/平仓|删除|重置|卸载/)
  })
  it('keeps funds and settings venues inside a 390 px document', async () => {
    for (const page of ['funds', 'settings-venues'] as PageKey[]) {
      sh.applyPage(page)
      await sh.open(page === 'funds' ? '#/funds' : '#/settings/venues')
      await sh.settled()
      await view(390)
      await noPageOverflow()
      // An error must not masquerade as an overflow-free empty page.
      expect(await sh.ev<number>(`document.querySelectorAll('.g5-tbl tbody .g5-row').length`)).toBeGreaterThan(0)
    }
  })
  it('aligns all position headers and first-row cell edges within one pixel at 1280', async () => {
    await overview(1280)
    const cells = await sh.ev<Array<{ left: number; right: number; width: number }>>(`(() => {
      const table=document.querySelector('[data-view="positions"] [data-tab="positions"]');
      const head=[...table.querySelectorAll('thead th')], row=[...table.querySelector('.g5-row').children];
      return head.map((h,i)=>{const a=h.getBoundingClientRect(),b=row[i].getBoundingClientRect();return {left:Math.abs(a.left-b.left),right:Math.abs(a.right-b.right),width:b.width}})
    })()`)
    expect(cells).toHaveLength(9)
    for (const c of cells) { expect(c.width).toBeGreaterThan(0); expect(c.left).toBeLessThanOrEqual(1); expect(c.right).toBeLessThanOrEqual(1) }
  })
  it('expands long proposal reasons without losing countdown bounds', async () => {
    await overview()
    await sh.ev(`window.dispatchEvent(new CustomEvent('gitrader:pend', { detail: { action: 'open' } }))`)
    await sh.waitFor(`!!document.querySelector('[data-act="reason-expand"]')`)
    await sh.click('[data-act="reason-expand"]')
    expect(await sh.ev<string>(`document.querySelector('.g5-why-copy').dataset.expanded`)).toBe('true')
    expect(await sh.ev<boolean>(`(()=>{const box=document.querySelector('.g5-pendpop').getBoundingClientRect();return [...document.querySelectorAll('.g5-pendpop .g5-cd')].every(e=>e.getBoundingClientRect().right<=box.right)})()`)).toBe(true)
  })
  it('captures requested widths and surfaces for visual review', async () => {
    const shots = process.env.GITRADER_SHOTS_DIR ?? join(repo, 'reports/fix-r3/x1-shots')
    for (const width of [1280, 1440, 1920, 800, 390]) {
      await overview(width)
      await sh.shot(join(shots, `${width}-overview.png`))
      await sh.ev(`window.dispatchEvent(new CustomEvent('gitrader:pend', { detail: { action: 'open' } }))`)
      await sh.waitFor(`document.querySelector('#g5-pendpop')?.getBoundingClientRect().height>0`)
      await sh.shot(join(shots, `${width}-pending.png`))
      for (const [key, page, hash] of [['chart','chart','#/chart'],['funds','funds','#/funds'],['about','settings-personal','#/settings/about'],['keys','settings-venues','#/settings/keys']] as const) {
        sh.applyPage(page)
        await sh.open(hash)
        await sh.waitFor(`document.fonts.status==='loaded' && !document.querySelector('.g5-sk, [data-skeleton]')`)
        await view(width)
        await sh.shot(join(shots, `${width}-${key}.png`))
      }
    }
  }, 180000)
})
