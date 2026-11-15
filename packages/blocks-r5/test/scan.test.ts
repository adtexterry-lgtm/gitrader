// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { scan, scanFile } from '../../workbench/design/source-scan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scanner = resolve(here, '../../workbench/design/source-scan.mjs')
const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const scratch: string = home
mkdirSync(scratch, { recursive: true })
const tempDirs: string[] = []

function makeRoots() {
  const root = mkdtempSync(join(scratch, 'scan-'))
  tempDirs.push(root)
  const wb = join(root, 'workbench')
  const bd = join(root, 'blocks-default')
  const r5 = join(root, 'blocks-r5')
  for (const dir of [wb, bd, r5]) mkdirSync(dir, { recursive: true })
  return { wb, bd, r5 }
}

function put(root: string, rel: string, text: string) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('source scan color rules', () => {
  it.each([
    ['short hex', '#abc'],
    ['alpha short hex', '#abcd'],
    ['long hex', '#112233'],
    ['alpha long hex', '#11223344'],
    ['rgb', 'rgb(1 2 3)'],
    ['rgba', 'rgba(1, 2, 3, .5)'],
    ['hsl', 'hsl(120 30% 40%)'],
    ['hsla', 'hsla(120, 30%, 40%, .5)'],
  ])('detects %s literals in style values', (_label, color) => {
    expect(scanFile('workbench/src/probe.css', `.probe { color: ${color}; }`)).toHaveLength(1)
  })

  it('accepts colors only inside a complete v6 token section and the token source file', () => {
    const v6 = '/* ===== BEGIN TOKENS v6 ===== */\n:root[data-ui="r5"] { --gr-up: #123456; color: rgb(1 2 3); }\n/* ===== END TOKENS v6 ===== */'
    expect(scanFile('workbench/src/ui/theme.css', v6)).toEqual([])
    expect(scanFile('reports/visual-r5/design-system/tokens.css', ':root { --gr-up: #123456; }')).toEqual([])
    expect(scanFile('workbench/src/ui/theme.css', '/* ===== BEGIN TOKENS v6 ===== */\n:root { color: #123456; }')).not.toEqual([])
  })

  it('only exempts the unchanged legacy token section captured at work start', () => {
    const theme = readFileSync(resolve(here, '../../workbench/src/ui/theme.css'), 'utf8')
    expect(scanFile('workbench/src/ui/theme.css', theme)).toEqual([])
    const begin = '/* ===== BEGIN TOKENS ===== */'
    const end = '/* ===== END TOKENS ===== */'
    const start = theme.indexOf(begin)
    const finish = theme.indexOf(end, start) + end.length
    const legacy = theme.slice(start, finish)
    const changedLegacy = legacy.replace(/(#[\da-f]{6})/i, '#010203')
    const changed = theme.slice(0, start) + changedLegacy + theme.slice(finish)
    expect(changed).not.toBe(theme)
    expect(scanFile('workbench/src/ui/theme.css', changed).some((hit) => hit.includes('颜色'))).toBe(true)
  })

  it('ignores comments, CSS id selectors, and URL fragments', () => {
    const source = '/* color: #fff; */\n#abc { color: var(--gr-up); }\n.probe { filter: url(#fff); color: var(--gr-down); }'
    expect(scanFile('workbench/src/probe.css', source)).toEqual([])
  })

  it('rejects red and green style values without matching descriptive strings', () => {
    expect(scanFile('workbench/src/probe.css', '.a { color: red; } .b { background: GREEN; }')).toHaveLength(2)
    expect(scanFile('workbench/src/probe.tsx', '<div data-label="green-state" />')).toEqual([])
  })

  it.each([
    ['plain hex string', "const palette = '#123456'"],
    ['plain rgb string', "const paint = 'rgb(1 2 3)'"],
    ['plain hsl string', "const paint = 'hsl(120 30% 40%)'"],
    ['template hex string', 'const palette = `#abcdef`'],
  ])('detects %s constants in non-CSS source', (_label, source) => {
    expect(scanFile('workbench/src/probe.tsx', source)).toHaveLength(1)
  })

  it('detects nested palette colors and counts a style literal once', () => {
    expect(scanFile('workbench/src/probe.tsx', "const palette = { chart: { primary: '#123456' } }")).toHaveLength(1)
    expect(scanFile('workbench/src/probe.tsx', "const view = { style: { color: '#abcdef' } }")).toHaveLength(1)
  })

  it('ignores comments and URL fragments in non-CSS strings', () => {
    const source = "// const palette = '#123456'\nconst selector = 'url(#fff)'\n/* const paint = 'rgb(1 2 3)' */"
    expect(scanFile('workbench/src/probe.tsx', source)).toEqual([])
  })

  it('continues scanning a quoted string after an escaped quote', () => {
    const source = String.raw`const copy = "escaped quote: \" then #123456"`
    expect(scanFile('workbench/src/probe.tsx', source)).toHaveLength(1)
  })

  it('allows dynamic RGB channels while rejecting a hard-coded channel with dynamic alpha', () => {
    expect(scanFile('blocks-r5/src/probe.ts', 'const color = `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${alpha})`')).toEqual([])
    expect(scanFile('blocks-r5/src/probe.ts', 'const color = `rgba(255, 0, 0, ${alpha})`')).toHaveLength(1)
  })

  it('does not treat a descriptive red label as a named color value', () => {
    expect(scanFile('blocks-r5/src/probe.ts', "const label = 'red'")).toEqual([])
  })
})

describe('source scan tree and compatibility rules', () => {
  it('preserves the two-root call and scans an optional r5 root when supplied', () => {
    const { wb, bd, r5 } = makeRoots()
    put(r5, 'probe.css', '.probe { color: #123456; }')
    expect(scan(wb, bd)).toEqual([])
    expect(scan(wb, bd, r5)).toHaveLength(1)
  })

  it('keeps the three exact r5 round-dot allowances and rejects exchange-pill disguises', () => {
    const allowed = [
      ':root[data-ui="r5"] .g5-mk{width:16px;height:16px;flex:none;align-self:center;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:var(--gr-on-actor)}',
      ':root[data-ui="r5"] .g5-ldot{width:8px;height:8px;border-radius:50%;flex:none}',
      ':root[data-ui="r5"] .g5-pa .g5-end,:root[data-ui="r5"] .g5-pa .g5-dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--gr-text-2);box-shadow:0 0 0 2px var(--gr-card);pointer-events:none}',
    ]
    for (const line of allowed) expect(scanFile('workbench/src/ui/r5/components.css', line)).toEqual([])
    expect(scanFile('workbench/src/ui/r5/venues.css', '.g5-venue-pill { border-radius: 50%; }')).not.toEqual([])
    expect(scanFile('workbench/src/ui/r5/venues.css', '.g5-venue { border-radius: 9999px; }')).not.toEqual([])
    expect(scanFile('workbench/src/ui/r5/venues.css', '<span className="rounded-full" />')).not.toEqual([])
  })

  it('rejects color aliases that drift from the gr-up/gr-down vocabulary', () => {
    expect(scanFile('workbench/src/probe.css', ':root { --color-up: var(--gr-up); --color-down: var(--gr-down); }')).toHaveLength(2)
    expect(scanFile('workbench/src/probe.css', '.probe { color: var(--gr-up); background: var(--gr-down); }')).toEqual([])
  })

  it('rejects experimental promise terms and preserves ordinary banned-word checks', () => {
    const lab = 'export const title = "预期收益 预测 年化收益"'
    expect(scanFile('blocks-r5/src/pages/lab-detail.tsx', lab)).toHaveLength(3)
    expect(scanFile('blocks-r5/src/pages/overview.tsx', 'const copy = "稳赚"')).not.toEqual([])
  })

  it('scans a real temporary tree through the CLI without exposing absolute paths', () => {
    const { wb, bd, r5 } = makeRoots()
    put(r5, 'probe.css', '.probe { color: #123456; }')
    const result = spawnSync(process.execPath, [scanner, wb, bd, r5], { encoding: 'utf8' })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).toBe(1)
    expect(output).toContain('blocks-r5/src/probe.css')
    expect(output).not.toContain(scratch)
    expect(output).not.toMatch(/(?:\d{1,3}\.){3}\d{1,3}|\b\d{4,5}\b/)
  })

  it('includes the r5 tree when the CLI uses its default roots', () => {
    const root = mkdtempSync(join(scratch, 'scan-default-'))
    tempDirs.push(root)
    const design = join(root, 'packages', 'workbench', 'design')
    const wb = join(root, 'packages', 'workbench', 'src')
    const bd = join(root, 'packages', 'blocks-default', 'src')
    const r5 = join(root, 'packages', 'blocks-r5', 'src')
    for (const dir of [design, wb, bd, r5]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(design, 'source-scan.mjs'), readFileSync(scanner, 'utf8'), 'utf8')
    put(r5, 'probe.css', '.probe { color: #123456; }')
    const result = spawnSync(process.execPath, [join(design, 'source-scan.mjs')], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('blocks-r5/src/probe.css')
    expect(result.stdout).not.toContain(root)
  })
})

describe('legacy alias compatibility', () => {
  const twFile = resolve(here, '../../workbench/src/ui/tw.css')
  const twSource = readFileSync(twFile, 'utf8')
  const aliasLines = twSource.split(/\r?\n/).filter((line) => /--color-(?:up|down)(?::|-a10:)/.test(line))

  it('accepts the two exact existing alias lines in tw.css', () => {
    expect(aliasLines).toHaveLength(2)
    expect(scanFile('workbench/src/ui/tw.css', twSource).filter((hit) => hit.includes('涨跌令牌名'))).toEqual([])
  })

  it('rejects the same alias lines when moved into r5 source', () => {
    expect(scanFile('blocks-r5/src/probe.css', aliasLines.join('\n')).filter((hit) => hit.includes('涨跌令牌名'))).toHaveLength(4)
  })

  it('rejects a changed mapping on a legacy line', () => {
    const first = aliasLines[0] ?? ''
    const changed = twSource.replace(first, first.replace('var(--gr-up)', 'var(--gr-down)'))
    expect(changed).not.toBe(twSource)
    expect(scanFile('workbench/src/ui/tw.css', changed).some((hit) => hit.includes('涨跌令牌名'))).toBe(true)
  })

  it('rejects an extra alias appended to a legacy line', () => {
    const first = aliasLines[0] ?? ''
    const extended = twSource.replace(first, `${first} --color-up: var(--gr-up);`)
    expect(extended).not.toBe(twSource)
    expect(scanFile('workbench/src/ui/tw.css', extended).some((hit) => hit.includes('涨跌令牌名'))).toBe(true)
  })
})

describe('r5 comment compatibility', () => {
  const modelComment = '/** 按可用额的比例换数量：可用 × pct ÷ 价，向下截到 4 位小数；价 / 可用不可用返回 null。（不含杠杆：保守估，实际可开仓位由内核风控裁。） */'
  const labComment = '// 三口径卡：前向（涨跌色）→ 保留期 → 回测（中性色）。每张卡 = 区间收益 + 权益曲线 + 指标；不显示年化、不画预测段。'

  it('allows the current r5 model comment context', () => {
    expect(scanFile('blocks-r5/src/model-chart.ts', modelComment)).toEqual([])
  })

  it('allows experimental terms inside r5 line comments', () => {
    expect(scanFile('blocks-r5/src/views/lab-detail/tier.tsx', labComment)).toEqual([])
  })

  it('still rejects the same terms in r5 source strings', () => {
    expect(scanFile('blocks-r5/src/model-chart.ts', "const label = '保守'" )).not.toEqual([])
    expect(scanFile('blocks-r5/src/views/lab-detail/tier.tsx', "const label = '预测'" )).not.toEqual([])
  })

  it('preserves the existing raw-comment ban for r4 source trees', () => {
    expect(scanFile('workbench/src/legacy.ts', '// 保守')).not.toEqual([])
    expect(scanFile('blocks-default/src/legacy.ts', '// 保守')).not.toEqual([])
  })
})
