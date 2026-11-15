// SPDX-License-Identifier: CPAL-1.0
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { launchCdp } from './helpers/cdp'
import { STATIC_GEOMETRY_SELECTORS, geometryCounts, readGeometry } from './helpers/geo'
import { captureAnchors, compareAnchors } from './helpers/anchors'

const geometryPath = new URL('../../workbench/design/geometry-probe.js', import.meta.url)
const auditSource = readFileSync(new URL('../../workbench/design/audit-probe.js', import.meta.url), 'utf8')
const baselinePage = new URL('../../../reports/visual-r5/overview/index.html', import.meta.url)
const pages = ['overview', 'chart', 'strategy', 'lab', 'lab-detail', 'funds', 'records', 'plugins', 'settings-personal', 'settings-notify', 'settings-venues']
const arrayFields = ['overflow', 'truncated', 'halfRows', 'escape', 'overlap', 'badFont', 'badSpace', 'align', 'numcol'] as const
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../')
const shotsRoot = resolve(repoRoot, 'reports/blocks-r5/T1-shots')
const summaryPath = resolve(repoRoot, 'reports/blocks-r5/t1/geometry-summary.json')

async function launchPreparedCdp(options: Parameters<typeof launchCdp>[0] = {}): Promise<Awaited<ReturnType<typeof launchCdp>>> {
  const cdp = await launchCdp(options)
  try {
    await cdp.navigate('about:blank')
    return cdp
  } catch (error) {
    await cdp.close()
    throw error
  }
}

async function setHtml(cdp: Awaited<ReturnType<typeof launchCdp>>, html: string): Promise<void> {
  await cdp.evaluate(`(() => { document.open(); document.write(${JSON.stringify(html)}); document.close(); return true })()`)
  await cdp.evaluate('document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
}

async function prepareAudit(cdp: Awaited<ReturnType<typeof launchCdp>>, query: string, html: string): Promise<void> {
  const url = new URL(baselinePage)
  url.search = query
  url.hash = '/chart'
  await cdp.navigate(url.href)
  await setHtml(cdp, html)
}

type AnchorSpec = { name: string; reference: string; product: string }
type AnchorRect = { x: number; y: number; width: number; height: number }
type AnchorSnapshot = { width: number; height: number; scenario: string; rects: Record<string, AnchorRect> }
const anchorSpec: AnchorSpec = { name: 'panel', reference: '#reference', product: '#product' }
const anchorHtml = `<!doctype html><html><head><style>
  #reference,#product { position:absolute; top:30px; width:100px; height:40px }
  #reference { left:20px } #product { left:20px }
</style></head><body><div id="reference"></div><div id="product"></div></body></html>`

describe('geometry and audit probes in a real browser', () => {
  it('matches the legacy geometry counts on all static pages at three widths', async () => {
    const summary: Array<{ page: string; width: number; oldCounts: Record<string, number>; counts: Record<string, number>; baseline: string; screenshot?: string; anchor?: { maxDelta: number; pass: boolean } }> = []
    for (const width of [1280, 1440, 1920]) {
      const cdp = await launchPreparedCdp({ width, height: 900 })
      try {
        for (const page of pages) {
          const pageUrl = new URL(`../../../reports/visual-r5/${page}/index.html?check=1`, import.meta.url)
          await cdp.navigate(pageUrl.href)
          await cdp.evaluate('new Promise((resolve) => setTimeout(resolve, 1300))')
          const previous = await cdp.evaluate(`(() => {
            const node = document.getElementById('geom-out')
            return node ? JSON.parse(node.textContent || 'null') : null
          })()`) as Record<string, unknown> | null
          expect(previous, `${page} must produce its original geometry result`).not.toBeNull()

          const current = await readGeometry(cdp, { selectors: STATIC_GEOMETRY_SELECTORS })
          const counts = geometryCounts(current)
          const oldCounts = Object.fromEntries([
            ['docScrollX', previous!.docScrollX as number],
            ...arrayFields.map((field) => [field, Array.isArray(previous![field]) ? (previous![field] as unknown[]).length : -1]),
          ])
          expect(counts, `${page} at ${width}px must preserve original counts`).toEqual(oldCounts)
          expect(current.docScrollX, `${page} at ${width}px must have no horizontal document scroll`).toBe(0)
          for (const field of arrayFields) expect(current[field], `${page} at ${width}px ${field}`).toHaveLength(0)

          const file = `${page}-${width}.png`
          let screenshot: string | undefined
          if (width === 1440 || page === 'overview') {
            mkdirSync(shotsRoot, { recursive: true })
            writeFileSync(resolve(shotsRoot, file), await cdp.screenshot())
            screenshot = file
          }
          const baseline = page === 'overview' ? 'final-geo-overview.log'
            : page === 'chart' ? 'final-geo-chart.log'
              : ['strategy', 'lab', 'lab-detail'].includes(page) ? 'final-geo-B.log'
                : page === 'funds' ? 'final-geo-funds.log'
                  : page === 'records' ? 'final-geo-records.log'
                    : page === 'plugins' ? 'final-geo-plugins.log'
                      : page === 'settings-personal' ? 'final-geo-settings-personal.log'
                        : page === 'settings-venues' ? 'final-geo-venues.log' : 'final-geo-notify.log'
          const row: (typeof summary)[number] = { page, width, oldCounts, counts, baseline }
          if (screenshot) row.screenshot = screenshot
          if (page === 'overview' && width === 1440) {
            const staticAnchor = [{ name: 'frame', reference: '.frame', product: '.frame' }]
            const reference = await captureAnchors(cdp, staticAnchor, 'reference')
            const product = await captureAnchors(cdp, staticAnchor, 'product')
            const comparison = compareAnchors(reference, product)
            expect(comparison.maxDelta).toBe(0)
            expect(comparison.pass).toBe(true)
            row.anchor = { maxDelta: comparison.maxDelta, pass: comparison.pass }
          }
          summary.push(row)
        }
      } finally {
        await cdp.close()
      }
    }
    mkdirSync(dirname(summaryPath), { recursive: true })
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }, 180_000)

  it('keeps the 11-page FINAL-audit typography baseline separate from geometry counts', () => {
    const baseline = JSON.parse(readFileSync(new URL('../../../reports/visual-r5/FINAL-audit.json', import.meta.url), 'utf8')) as Record<string, { fontSizes?: Record<string, number> }>
    expect(Object.keys(baseline).sort()).toEqual([...pages].sort())
    for (const page of pages) expect(baseline[page]?.fontSizes).toBeDefined()
  })

  it('installs the reusable geometry probe and detects default data-g5 card collisions', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await setHtml(cdp, `<!doctype html><html><head><style>
        * { box-sizing: border-box } html,body { margin:0 }
        [data-g5="card"] { position:absolute; width:100px; height:100px }
        #first { left:10px; top:10px } #second { left:90px; top:20px }
        #escape { position:absolute; left:-5px; top:8px; width:20px; height:10px }
        [data-n="qty"] { position:absolute; top:60px; white-space:nowrap }
        #qty-a { left:15px } #qty-b { left:50px }
        [data-g5="float"] { position:absolute; left:95px; top:25px; width:80px; height:80px }
      </style></head><body>
        <div data-g5="card" id="first"><i id="escape"></i><span id="qty-a" data-n="qty">1</span><span id="qty-b" data-n="qty">123</span></div>
        <div data-g5="card" id="second"></div>
        <aside data-g5="float"></aside>
      </body></html>`)
      const source = existsSync(geometryPath) ? readFileSync(geometryPath, 'utf8') : ''
      await cdp.evaluate(`(() => { const script = document.createElement('script'); script.textContent = ${JSON.stringify(source)}; document.documentElement.append(script); return true })()`)
      const installed = await cdp.evaluate('typeof window.__grGeometry?.run === "function"')
      expect(installed).toBe(true)

      const result = await cdp.evaluate('window.__grGeometry.run()') as { overlap: string[]; escape: string[]; numcol: string[] }
      expect(result.overlap.some((entry) => entry.includes('卡片相交'))).toBe(true)
      expect(result.overlap.filter((entry) => entry.includes('卡片相交'))).toHaveLength(1)
      expect(result.escape.length).toBeGreaterThan(0)
      expect(result.numcol.length).toBeGreaterThan(0)
    } finally {
      await cdp.close()
    }
  })

  it('runs a clean data-g5 card through run() without options or selectors', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await setHtml(cdp, '<!doctype html><html><body><section data-g5="card" style="position:absolute;left:20px;top:20px;width:240px;height:160px"></section></body></html>')
      const source = existsSync(geometryPath) ? readFileSync(geometryPath, 'utf8') : ''
      await cdp.evaluate(`(() => { const script = document.createElement('script'); script.textContent = ${JSON.stringify(source)}; document.documentElement.append(script); return true })()`)
      const result = await cdp.evaluate('window.__grGeometry.run()') as Record<string, unknown>
      expect(result.docScrollX).toBe(0)
      for (const field of arrayFields) expect(result[field]).toEqual([])
    } finally {
      await cdp.close()
    }
  })

  it('rejects 22px typography on a non-home r5 query route', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await prepareAudit(cdp, '?ui=r5', '<!doctype html><html><body><p style="font-size:22px">probe</p></body></html>')
      const result = await cdp.evaluate(auditSource) as { sizeViolations: number; sizes: Record<string, number> }
      expect(result.sizes['22']).toBe(1)
      expect(result.sizeViolations).toBe(1)
    } finally {
      await cdp.close()
    }
  })

  it('accepts 36px typography on a non-home r5 query route', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await prepareAudit(cdp, '?ui=r5', '<!doctype html><html><body><p style="font-size:36px">probe</p></body></html>')
      const result = await cdp.evaluate(auditSource) as { sizeViolations: number; sizes: Record<string, number> }
      expect(result.sizes['36']).toBe(1)
      expect(result.sizeViolations).toBe(0)
    } finally {
      await cdp.close()
    }
  })

  it('recognizes data-ui=r5 on a non-home route', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await prepareAudit(cdp, '', '<!doctype html><html data-ui="r5"><body><p style="font-size:22px">probe</p></body></html>')
      const result = await cdp.evaluate(auditSource) as { sizeViolations: number; sizes: Record<string, number> }
      expect(result.sizes['22']).toBe(1)
      expect(result.sizeViolations).toBe(1)
    } finally {
      await cdp.close()
    }
  })

  it('keeps 22px typography valid on a non-home r4 route', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await prepareAudit(cdp, '', '<!doctype html><html><body><p style="font-size:22px">probe</p></body></html>')
      const result = await cdp.evaluate(auditSource) as { sizeViolations: number; sizes: Record<string, number> }
      expect(result.sizes['22']).toBe(1)
      expect(result.sizeViolations).toBe(0)
    } finally {
      await cdp.close()
    }
  })

  it('exports the complete legacy selector map', () => {
    expect(STATIC_GEOMETRY_SELECTORS).toEqual({
      card: '.card',
      container: '.card,.float',
      align: '.al',
      railOverflow: '.rail,.ri',
      internalHost: '.lwc-host',
      overlay: '.ov',
      mark: '.ov g',
      graphic: '.venue,.mk,.alogo,.sw,.cb i,.ptag,.readout,.fuse',
      nonLeaf: '.venue,.readout,.ptag',
      layer: 'svg.layer',
    })
  })

  it('reads the browser geometry result and returns the nine violation counts', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await setHtml(cdp, `<!doctype html><html><body>
        <section data-g5="card" style="position:absolute;left:10px;top:10px;width:100px;height:100px">
          <span data-n="qty" style="position:absolute;left:10px;top:10px">1</span>
          <span data-n="qty" style="position:absolute;left:40px;top:10px">123</span>
        </section>
      </body></html>`)
      const result = await readGeometry(cdp)
      const counts = geometryCounts(result)
      expect(result.w).toBe(1280)
      expect(result.h).toBe(900)
      expect(counts).toEqual({
        docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0,
        badFont: 0, badSpace: 0, align: 0, numcol: 1,
      })
    } finally {
      await cdp.close()
    }
  })

  it('fails clearly when geometry has no visible card', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await setHtml(cdp, '<!doctype html><html><body><main>empty</main></body></html>')
      await expect(readGeometry(cdp)).rejects.toThrow()
    } finally {
      await cdp.close()
    }
  })

  it('captures anchors and passes the exact four-pixel boundary', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await setHtml(cdp, anchorHtml)
      const reference = await captureAnchors(cdp, [anchorSpec], 'reference') as AnchorSnapshot
      const same = await captureAnchors(cdp, [anchorSpec], 'product') as AnchorSnapshot
      expect(reference.width).toBe(1280)
      expect(reference.height).toBe(900)
      expect(reference.scenario).toBe('normal')
      expect(compareAnchors(reference, same).pass).toBe(true)

      await cdp.evaluate('document.querySelector("#product").style.left = "24px"')
      const four = await captureAnchors(cdp, [anchorSpec], 'product') as AnchorSnapshot
      expect(compareAnchors(reference, four).pass).toBe(true)

      await cdp.evaluate('document.querySelector("#product").style.left = "25px"')
      const five = await captureAnchors(cdp, [anchorSpec], 'product') as AnchorSnapshot
      const result = compareAnchors(reference, five)
      expect(result.pass).toBe(false)
      expect(result.maxDelta).toBe(5)
      expect(result.differences).toEqual([{ name: 'panel', field: 'x', delta: 5 }])
    } finally {
      await cdp.close()
    }
  })

  it('rejects empty, duplicate, missing, multi-match, and invisible anchor targets', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await setHtml(cdp, `<!doctype html><html><body>
        <div id="reference" style="width:20px;height:20px"></div>
        <div id="product" style="width:20px;height:20px"></div>
        <div class="many" style="width:10px;height:10px"></div><div class="many" style="width:10px;height:10px"></div>
        <div id="hidden" style="display:none;width:10px;height:10px"></div>
      </body></html>`)
      await expect(captureAnchors(cdp, [], 'reference')).rejects.toThrow()
      await expect(captureAnchors(cdp, [anchorSpec, { ...anchorSpec }], 'reference')).rejects.toThrow()
      await expect(captureAnchors(cdp, [{ ...anchorSpec, reference: '#missing' }], 'reference')).rejects.toThrow()
      await expect(captureAnchors(cdp, [{ ...anchorSpec, reference: '.many' }], 'reference')).rejects.toThrow()
      await expect(captureAnchors(cdp, [{ ...anchorSpec, reference: '#hidden' }], 'reference')).rejects.toThrow()

      const snapshot = await captureAnchors(cdp, [anchorSpec], 'reference') as AnchorSnapshot
      expect(() => compareAnchors({ ...snapshot, rects: {} }, snapshot)).toThrow()
      expect(() => compareAnchors(snapshot, { ...snapshot, rects: { other: snapshot.rects.panel! } })).toThrow()
    } finally {
      await cdp.close()
    }
  })

  it('rejects anchor snapshots with different viewport or scenario', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await setHtml(cdp, anchorHtml)
      const reference = await captureAnchors(cdp, [anchorSpec], 'reference') as AnchorSnapshot

      const scenarioUrl = new URL(baselinePage)
      scenarioUrl.searchParams.set('scenario', 'empty')
      await cdp.navigate(scenarioUrl.href)
      await setHtml(cdp, anchorHtml)
      const otherScenario = await captureAnchors(cdp, [anchorSpec], 'product') as AnchorSnapshot
      expect(() => compareAnchors(reference, otherScenario)).toThrow()

      const wide = await launchPreparedCdp({ width: 1440, height: 900 })
      try {
        await setHtml(wide, anchorHtml)
        const otherViewport = await captureAnchors(wide, [anchorSpec], 'reference') as AnchorSnapshot
        expect(() => compareAnchors(reference, otherViewport)).toThrow()
      } finally {
        await wide.close()
      }
    } finally {
      await cdp.close()
    }
  })

  it('counts a visible non-clickable venue capsule on r5', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      await prepareAudit(cdp, '?ui=r5', `<!doctype html><html><head><style>
        #venue { display:inline-block; box-sizing:border-box; width:100px; height:20px; border-radius:10px; border:1px solid #444 }
      </style></head><body><span id="venue" class="venue">VENUE</span></body></html>`)
      const result = await cdp.evaluate(auditSource) as { capsule: number }
      expect(result.capsule).toBe(1)
    } finally {
      await cdp.close()
    }
  })

  it('does not count the .g5-venue App Icon as a fill layer, but counts any other nested surface', async () => {
    const cdp = await launchPreparedCdp({ width: 1280, height: 900 })
    try {
      const page = (cls: string) => `<!doctype html><html><body>
        <div style="background:#111;width:400px;height:200px"><div style="background:#222;width:300px;height:100px">
          <span class="${cls}" style="display:block;width:24px;height:24px;background:linear-gradient(#444,#222)"></span>
        </div></div></body></html>`
      await prepareAudit(cdp, '?ui=r5', page('g5-venue'))
      expect(((await cdp.evaluate(auditSource)) as { fillDepth: number }).fillDepth).toBe(2)
      await setHtml(cdp, page('other'))
      expect(((await cdp.evaluate(auditSource)) as { fillDepth: number }).fillDepth).toBe(3)
    } finally {
      await cdp.close()
    }
  })
})
