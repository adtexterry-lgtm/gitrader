// SPDX-License-Identifier: CPAL-1.0
// T2 · 十一页 × 三宽度，真壳 `?ui=r5#/<页>`（workbench/build.mjs 的真产物 + 夹具内核 + CDP 直连 Edge，无头）：
//   几何探针（geometry-probe.js 作为同源外部脚本预装）· 卡片锚点对稿（visual-r5/<页>/index.html，同宽同夹具，差 ≤ 4 px）· 体检 audit-probe 五项 · 截图与并排对照图。
// 数据一次采全（beforeAll），下面各用例只读矩阵断言，失败信息逐项列出，不放宽阈值。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchCdp } from './helpers/cdp'
import { PAGES, WIDTHS, buildShell, openShell, realErrors, repo, sleep, type PageKey, type Shell } from './helpers/t2-shell'

const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const shotsRoot = process.env.T2_SHOTS_DIR ? resolve(process.env.T2_SHOTS_DIR) : join(repo, 'reports/blocks-r5/shots')
const matrixFile = join(shotsRoot, '..', 't2', 'anchors-matrix.json')
const TOL = 4
const GEO_FIELDS = ['docScrollX', 'overflow', 'truncated', 'halfRows', 'escape', 'overlap', 'badFont', 'badSpace', 'align', 'numcol'] as const
const AUDIT_FIELDS = ['glow', 'solidOrange', 'capsule', 'sizeViolations', 'cjk11'] as const
const AUDIT_LIMIT: Record<(typeof AUDIT_FIELDS)[number], number> = { glow: 1, solidOrange: 1, capsule: 0, sizeViolations: 0, cjk11: 0 }

type Card = { label: string; x: number; y: number; w: number; h: number }
type Row = {
  page: PageKey
  width: number
  geometry: Record<string, number>
  /** 视觉隐藏的 .gr-sr 文字被探针算成 overflow：单列出来，不计入 geometry。 */
  srOnlyOverflow: number
  geometrySamples: Record<string, unknown[]>
  cards: { static: Card[]; product: Card[]; diffs: string[]; maxDelta: number }
  audit: Record<string, number> & { otherLimitsFailed: string[]; samples: unknown }
  errors: string[]
}

const matrix: Row[] = []
const compareInputs = new Map<PageKey, { static: Buffer; product: Buffer }>()
let tempDir = ''

const CARDS = (selector: string) => `(() => JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
  return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'
}).map((el) => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') || '', x: r.x, y: r.y, w: r.width, h: r.height } })))()`

/**
 * 稿（reports/visual-r5/<页>/index.html）之后签过字的版面变更：稿还没跟上，这里只剔掉稿里没有的卡、把被它让位的那一项按稿的值比。
 * - funds · GQ-65（r7/i，Opus 视觉签字）：左列权益曲线下加第六张卡「组合」，权益卡让出高度。稿补上第六张卡后删掉这一项。
 */
const SIGNED: Partial<Record<PageKey, { drop: string[]; keepHeight: string[] }>> = { funds: { drop: ['组合'], keepHeight: ['权益'] } }
let staticForSigned: Card[] = []
function signedDelta(page: PageKey, prod: Card[]): Card[] {
  const s = SIGNED[page]
  if (!s) return prod
  return prod.filter((c) => !s.drop.includes(c.label)).map((c) => {
    const st = s.keepHeight.includes(c.label) ? staticForSigned.find((x) => x.label === c.label) : undefined
    return st ? { ...c, h: st.h } : c
  })
}

async function cards(sh: Shell, selector: string): Promise<Card[]> {
  return JSON.parse(await sh.ev<string>(CARDS(selector))) as Card[]
}

/** 与稿同态：交易所页选中第二行（Binance）；通知页选中 mail 并发一次测试（稿里的详情带一行失败原文）。同 P9 的 sameStateAsMock。 */
async function sameStateAsMock(sh: Shell, page: PageKey) {
  if (page === 'settings-venues') {
    await sh.click('tr[data-venue="binance"]')
    await sh.waitFor(`document.querySelector('[data-geo="vdetail"] .g5-hd').textContent.includes('Binance')`)
  } else if (page === 'settings-notify') {
    await sh.click('tr[data-channel="mail"]')
    await sh.waitFor(`document.querySelector('[data-geo="cdetail"] .g5-hd').textContent.includes('mail')`)
    await sh.click('[data-act="notify-test"]')
    await sh.waitFor(`!!document.querySelector('[data-act="notify-test-result"]')`)
  }
  await sleep(250)
}

function compareCards(stat: Card[], prod: Card[]): { diffs: string[]; maxDelta: number } {
  const diffs: string[] = []
  let maxDelta = 0
  if (stat.length !== prod.length) diffs.push(`card count static=${stat.length} product=${prod.length}`)
  const labels = (list: Card[]) => list.map((c) => c.label)
  const byLabel = stat.every((c) => c.label) && prod.every((c) => c.label) && new Set(labels(stat)).size === stat.length
    && [...labels(stat)].sort().join('|') === [...labels(prod)].sort().join('|')
  stat.forEach((s, i) => {
    const p = byLabel ? prod.find((c) => c.label === s.label) : prod[i]
    const name = s.label || `#${i}`
    if (!p) { diffs.push(`${name}: no product card`); return }
    for (const [field, a, b] of [['x', s.x, p.x], ['y', s.y, p.y], ['width', s.w, p.w], ['height', s.h, p.h]] as const) {
      const delta = Math.abs(a - b)
      maxDelta = Math.max(maxDelta, delta)
      if (delta > TOL) diffs.push(`${name}.${field} static=${Math.round(a * 100) / 100} product=${Math.round(b * 100) / 100}`)
    }
  })
  return { diffs, maxDelta: Math.round(maxDelta * 100) / 100 }
}

async function compose(pairs: Array<{ page: PageKey; static: Buffer; product: Buffer }>) {
  const cdp = await launchCdp({ width: 2900, height: 900 })
  try {
    await cdp.navigate('about:blank')
    for (const pair of pairs) {
      const html = `<!doctype html><html><body style="margin:0;background:#050505"><div style="display:flex;gap:20px;width:2900px;height:900px"><img src="data:image/png;base64,${pair.static.toString('base64')}"><img src="data:image/png;base64,${pair.product.toString('base64')}"></div></body></html>`
      await cdp.evaluate(`(async () => { document.open(); document.write(${JSON.stringify(html)}); document.close(); await Promise.all([...document.images].map((i) => i.decode())); return true })()`)
      writeFileSync(join(shotsRoot, `compare-${pair.page}-1440.png`), await cdp.screenshot())
    }
  } finally { await cdp.close() }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(home, 't2-anchors-'))
  if (!resolve(tempDir).startsWith(resolve(home) + sep)) throw new Error('temporary directory escaped GITRADER_HOME')
  const staticDir = buildShell(join(tempDir, 'static'))
  mkdirSync(shotsRoot, { recursive: true })
  for (const width of WIDTHS) {
    const sh = await openShell({ staticDir, workDir: tempDir, width })
    try {
      for (const def of PAGES) {
        // 稿一侧：同一个浏览器、同一宽度，file:// 直开
        await sh.cdp.navigate(pathToFileURL(join(repo, 'reports/visual-r5', def.mock, 'index.html')).href)
        await sleep(1400)
        await sh.cdp.evaluate('document.fonts.ready.then(() => 1)')
        const staticCards = await cards(sh, '.card')
        staticForSigned = staticCards
        const staticShot = width === 1440 ? await sh.cdp.screenshot() : null
        // 真壳一侧
        sh.applyPage(def.key)
        sh.cdp.errors.length = 0
        await sh.open(def.hash)
        await sh.settled()
        await sameStateAsMock(sh, def.key)
        const productCards = signedDelta(def.key, await cards(sh, '[data-g5="card"]'))
        const geometry = await sh.geometry()
        const raw = geometry.raw as Record<string, unknown[]>
        const srOnly = (raw.overflow ?? []).filter((entry) => /\.gr-sr\b/.test(String(entry))).length
        const geo: Record<string, number> = {}
        for (const field of GEO_FIELDS) geo[field] = field === 'docScrollX' ? (raw.docScrollX as unknown as number) : (raw[field] ?? []).length
        geo.overflow = (geo.overflow ?? 0) - srOnly
        const audit = await sh.audit() as Record<string, unknown> & { pass?: Record<string, boolean>; samples?: Record<string, unknown> }
        const auditRow: Record<string, number> = {}
        for (const field of AUDIT_FIELDS) auditRow[field] = Number(audit[field])
        const otherLimitsFailed = Object.entries(audit.pass ?? {}).filter(([key, ok]) => !ok && !(AUDIT_FIELDS as readonly string[]).includes(key)).map(([key]) => key)
        const shot = await sh.cdp.screenshot()
        writeFileSync(join(shotsRoot, `${def.key}-${width}.png`), shot)
        if (staticShot) compareInputs.set(def.key, { static: staticShot, product: shot })
        const cmp = compareCards(staticCards, productCards)
        matrix.push({
          page: def.key, width, geometry: geo, srOnlyOverflow: srOnly,
          geometrySamples: Object.fromEntries(GEO_FIELDS.filter((f) => f !== 'docScrollX' && (raw[f] ?? []).length > 0).map((f) => [f, (raw[f] ?? []).slice(0, 4)])),
          cards: { static: staticCards, product: productCards, ...cmp },
          audit: { ...auditRow, otherLimitsFailed, samples: audit.samples ?? {} } as Row['audit'],
          errors: realErrors(sh.cdp.errors),
        })
      }
    } finally { await sh.close() }
  }
  await compose(PAGES.map((def) => ({ page: def.key, ...compareInputs.get(def.key)! })))
  mkdirSync(dirname(matrixFile), { recursive: true })
  writeFileSync(matrixFile, `${JSON.stringify(matrix, null, 1)}\n`)
}, 900_000)

afterAll(() => {
  if (tempDir && resolve(tempDir).startsWith(resolve(home) + sep)) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('真壳 ?ui=r5 · 十一页 × 三宽度（1280 / 1440 / 1920 × 900）', () => {
  it('采样完整：33 个页面格子都有数据', () => {
    expect(matrix).toHaveLength(PAGES.length * WIDTHS.length)
    for (const def of PAGES) for (const width of WIDTHS) expect(matrix.some((r) => r.page === def.key && r.width === width), `${def.key}@${width}`).toBe(true)
  })

  it('几何探针全 0（外部预装 geometry-probe.js；视觉隐藏的 .gr-sr 单列）', () => {
    const failures = matrix.flatMap((r) => {
      const bad = GEO_FIELDS.filter((f) => (r.geometry[f] ?? 0) !== 0)
      return bad.length ? [`${r.page}@${r.width} ${bad.map((f) => `${f}=${r.geometry[f]}`).join(' ')} ${JSON.stringify(r.geometrySamples).slice(0, 500)}`] : []
    })
    expect(failures).toEqual([])
  })

  it(`卡片锚点与稿同宽同夹具差 ≤ ±${TOL} px`, () => {
    const failures = matrix.flatMap((r) => (r.cards.diffs.length ? [`${r.page}@${r.width} maxDelta=${r.cards.maxDelta} ${r.cards.diffs.slice(0, 6).join('; ')}`] : []))
    expect(failures).toEqual([])
  })

  it('体检 audit-probe：glow ≤ 1、solidOrange ≤ 1、capsule 0、sizeViolations 0、cjk11 0', () => {
    const failures = matrix.flatMap((r) => {
      const bad = AUDIT_FIELDS.filter((f) => (r.audit[f] ?? 0) > AUDIT_LIMIT[f])
      return bad.length ? [`${r.page}@${r.width} ${bad.map((f) => `${f}=${r.audit[f]}`).join(' ')} ${JSON.stringify(r.audit.samples).slice(0, 300)}`] : []
    })
    expect(failures).toEqual([])
  })

  it('页面无未捕获异常、无 console.error', () => {
    const failures = matrix.flatMap((r) => (r.errors.length ? [`${r.page}@${r.width} ${r.errors.slice(0, 3).join(' | ')}`] : []))
    expect(failures).toEqual([])
  })

  it('截图 33 张 + 并排对照 11 张已落盘', async () => {
    const { statSync } = await import('node:fs')
    for (const def of PAGES) {
      for (const width of WIDTHS) expect(statSync(join(shotsRoot, `${def.key}-${width}.png`)).size, `${def.key}-${width}`).toBeGreaterThan(5_000)
      expect(statSync(join(shotsRoot, `compare-${def.key}-1440.png`)).size, `compare-${def.key}`).toBeGreaterThan(20_000)
    }
  })
})
