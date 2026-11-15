// SPDX-License-Identifier: CPAL-1.0
export type AnchorSpec = { name: string; reference: string; product: string }
export type AnchorRect = { x: number; y: number; width: number; height: number }
export type AnchorSnapshot = { width: number; height: number; scenario: string; rects: Record<string, AnchorRect> }
export type AnchorField = keyof AnchorRect
export type AnchorDifference = { name: string; field: AnchorField; delta: number }
export type AnchorComparison = { pass: boolean; maxDelta: number; differences: AnchorDifference[] }
export type AnchorSide = 'reference' | 'product'
type CdpPage = { evaluate(expression: string): Promise<unknown> }

export async function captureAnchors(page: CdpPage, specs: AnchorSpec[], side: AnchorSide): Promise<AnchorSnapshot> {
  const validation = validateSpecs(specs, side)
  const snapshot = await page.evaluate(`(() => {
    const specs = ${JSON.stringify(validation)}
    const side = ${JSON.stringify(side)}
    const rects = Object.create(null)
    const vw = innerWidth, vh = innerHeight
    for (const spec of specs) {
      let matches
      try { matches = Array.from(document.querySelectorAll(spec.selector)) }
      catch { throw new Error('Anchor selector is invalid: ' + spec.name) }
      const visible = matches.filter((el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw &&
          cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
      })
      if (visible.length !== 1) throw new Error('Anchor must match exactly one visible element: ' + spec.name)
      const r = visible[0].getBoundingClientRect()
      rects[spec.name] = { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return {
      width: innerWidth,
      height: innerHeight,
      scenario: new URL(location.href).searchParams.get('scenario') || 'normal',
      rects,
    }
  })()`)
  return validateSnapshot(snapshot) as AnchorSnapshot
}

export function compareAnchors(reference: AnchorSnapshot, product: AnchorSnapshot, tolerance = 4): AnchorComparison {
  const ref = validateSnapshot(reference)
  const prod = validateSnapshot(product)
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Anchor tolerance must be a non-negative number')
  if (ref.width !== prod.width || ref.height !== prod.height) throw new Error('Anchor snapshots must use the same viewport')
  if (ref.scenario !== prod.scenario) throw new Error('Anchor snapshots must use the same scenario')
  const names = Object.keys(ref.rects).sort()
  const productNames = Object.keys(prod.rects).sort()
  if (names.length !== productNames.length || names.some((name, index) => name !== productNames[index])) {
    throw new Error('Anchor snapshots must contain the same names')
  }

  let maxDelta = 0
  const differences: AnchorDifference[] = []
  for (const name of names) {
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      const delta = Math.abs((ref.rects[name]?.[field] ?? NaN) - (prod.rects[name]?.[field] ?? NaN))
      maxDelta = Math.max(maxDelta, delta)
      if (delta > tolerance) differences.push({ name, field, delta })
    }
  }
  return { pass: differences.length === 0, maxDelta, differences }
}

function validateSpecs(specs: AnchorSpec[], side: AnchorSide): Array<{ name: string; selector: string }> {
  if (side !== 'reference' && side !== 'product') throw new Error('Anchor side is invalid')
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('Anchor configuration is empty')
  const names = new Set<string>()
  return specs.map((spec) => {
    if (!spec || typeof spec.name !== 'string' || !spec.name.trim() ||
      typeof spec.reference !== 'string' || !spec.reference.trim() ||
      typeof spec.product !== 'string' || !spec.product.trim()) {
      throw new Error('Anchor configuration requires a name and both selectors')
    }
    if (names.has(spec.name)) throw new Error('Anchor names must be unique')
    names.add(spec.name)
    return { name: spec.name, selector: spec[side] }
  })
}

function validateSnapshot(value: unknown): AnchorSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Anchor snapshot is empty')
  const snapshot = value as Partial<AnchorSnapshot>
  if (!Number.isFinite(snapshot.width) || !Number.isFinite(snapshot.height) ||
    typeof snapshot.scenario !== 'string' || !snapshot.rects || typeof snapshot.rects !== 'object') {
    throw new Error('Anchor snapshot is invalid')
  }
  const names = Object.keys(snapshot.rects)
  if (names.length === 0) throw new Error('Anchor snapshot has no rectangles')
  for (const name of names) {
    const rect = snapshot.rects[name]
    if (!rect || !['x', 'y', 'width', 'height'].every((field) => Number.isFinite(rect[field as AnchorField]))) {
      throw new Error('Anchor snapshot has an invalid rectangle')
    }
  }
  return snapshot as AnchorSnapshot
}
