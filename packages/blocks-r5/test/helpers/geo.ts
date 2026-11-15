// SPDX-License-Identifier: CPAL-1.0
import { readFileSync } from 'node:fs'

export type GeometrySelectors = {
  card: string
  container: string
  align: string
  railOverflow: string
  internalHost: string
  overlay: string
  mark: string
  graphic: string
  nonLeaf: string
  layer: string
}

export type GeometryResult = {
  w: number
  h: number
  docScrollX: number
  overflow: string[]
  truncated: string[]
  halfRows: string[]
  escape: string[]
  overlap: string[]
  fontSizes: Record<number, number>
  badFont: string[]
  badSpace: string[]
  align: string[]
  numcol: string[]
  numcolOk: number
  alignOk: number
  baselines: Record<string, Array<[string, number]>>
  redges: Array<[string, number, number]>
}

type CdpPage = { evaluate(expression: string): Promise<unknown> }
type GeometryOptions = { selectors?: Partial<GeometrySelectors> }

export const STATIC_GEOMETRY_SELECTORS: GeometrySelectors = {
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
}

const DEFAULT_SELECTORS: GeometrySelectors = {
  card: '[data-g5="card"]',
  container: '[data-g5="card"],[data-g5="float"]',
  align: '.g5-al',
  railOverflow: '.g5-rail,.g5-ri',
  internalHost: '.g5-lwc-host',
  overlay: '.g5-ov',
  mark: '.g5-ov g',
  graphic: '.g5-venue,.g5-mk,.g5-alogo,.g5-sw,.g5-cb i,.g5-ptag,.g5-readout,.g5-fuse',
  nonLeaf: '.g5-venue,.g5-readout,.g5-ptag',
  layer: 'svg.g5-layer',
}

const arrayFields = ['overflow', 'truncated', 'halfRows', 'escape', 'overlap', 'badFont', 'badSpace', 'align', 'numcol'] as const
const source = readFileSync(new URL('../../../workbench/design/geometry-probe.js', import.meta.url), 'utf8')

async function waitForStableLayout(page: CdpPage): Promise<void> {
  const stable = await page.evaluate(`(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready
    const measure = () => {
      const root = document.documentElement
      const body = document.body
      const nodes = body ? [body, ...body.querySelectorAll('*')] : []
      const boxes = []
      for (const el of nodes) {
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || !el.getClientRects().length) continue
        const r = el.getBoundingClientRect()
        boxes.push([Math.round(r.left * 100) / 100, Math.round(r.top * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100])
      }
      return JSON.stringify([innerWidth, innerHeight, root.scrollWidth, root.scrollHeight, boxes])
    }
    let previous = ''
    let stableFrames = 0
    for (let frame = 0; frame < 16; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const current = measure()
      stableFrames = current === previous ? stableFrames + 1 : 0
      if (stableFrames >= 2) return true
      previous = current
    }
    return false
  })()`)
  if (stable !== true) throw new Error('Geometry layout did not stabilize')
}

export async function readGeometry(page: CdpPage, options: GeometryOptions = {}): Promise<GeometryResult> {
  await waitForStableLayout(page)
  const selectors = { ...DEFAULT_SELECTORS, ...options.selectors }
  const expression = `(() => {
    const script = document.createElement('script')
    script.textContent = ${JSON.stringify(source)}
    document.documentElement.append(script)
    const probe = window.__grGeometry
    if (!probe || typeof probe.run !== 'function') throw new Error('Geometry probe did not run')
    const cards = Array.from(document.querySelectorAll(${JSON.stringify(selectors.card)})).filter((el) => {
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
    })
    if (cards.length === 0) throw new Error('Geometry probe found no visible cards')
    const result = probe.run(${JSON.stringify(options)})
    if (!result || typeof result.docScrollX !== 'number') throw new Error('Geometry probe returned no result')
    for (const key of ${JSON.stringify(arrayFields)}) {
      if (!Array.isArray(result[key])) throw new Error('Geometry probe result is missing an array')
    }
    return result
  })()`
  return await page.evaluate(expression) as GeometryResult
}

export function geometryCounts(result: GeometryResult): Record<string, number> {
  return {
    docScrollX: result.docScrollX,
    overflow: result.overflow.length,
    truncated: result.truncated.length,
    halfRows: result.halfRows.length,
    escape: result.escape.length,
    overlap: result.overlap.length,
    badFont: result.badFont.length,
    badSpace: result.badSpace.length,
    align: result.align.length,
    numcol: result.numcol.length,
  }
}
