// SPDX-License-Identifier: CPAL-1.0
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 行尾统一成 LF：Windows 检出把 theme.css 变成 CRLF、基线是 LF，比较的是内容不是行尾（fix-r2 T2）
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8').replace(/\r\n/g, '\n')
const tokenPairs = (text: string) => new Map([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]))
const allRootBlocks = (text: string, selector: RegExp) => [...text.matchAll(selector)].flatMap((match) => [...tokenPairs(match[1]!).entries()])
const marked = (text: string, begin: string, end: string) => text.match(new RegExp(`${begin}([\\s\\S]*?)${end}`))?.[1] ?? ''
// fix-r2 T2：两份基线输入原本在 gitignore 掉的 reports/ 下（干净检出时不存在）；已原样复制进 test/fixtures/（首行注明来源与哈希）
const sourceTokens = read('test/fixtures/tokens-v6-design-tokens.css')
const sourceBefore = read('test/fixtures/tokens-v6-before-theme.css')
const theme = read('../workbench/src/ui/theme.css')
const sourceSegment = marked(sourceBefore, '/\\* ===== BEGIN TOKENS ===== \\*/', '/\\* ===== END TOKENS ===== \\*/')
const currentSegment = marked(theme, '/\\* ===== BEGIN TOKENS ===== \\*/', '/\\* ===== END TOKENS ===== \\*/')
const components = read('../workbench/src/ui/r5/components.css')
// S0h 在 v6 段末尾追加的两个状态色（tokens.css 没有；r4 里它们别名到 up/down）
const STATUS_PINS = { '--gr-st-ok': '#46C68D', '--gr-st-err': '#EF6A6E' }
const STATUS_BLOCK = '/* S0h：成功 / 失败状态色在 r5 固定为独立值（intl 口径，不随 data-updown 互换）。tokens.css 没有这两个令牌；r4 段里它们别名到 --gr-up / --gr-down，cn 下会跟着翻 */\n:root[data-ui="r5"]{ --gr-st-ok:#46C68D; --gr-st-err:#EF6A6E; }\n'
const v6 = marked(theme, '/\\* ===== BEGIN TOKENS v6 ===== \\*/', '/\\* ===== END TOKENS v6 ===== \\*/')

describe('r5 v6 token contract (waits for S0-C)', () => {
  it('matches the current design source after the exact v6 scope transform', () => {
    const scope = (text: string) => text.split(/(\/\*[\s\S]*?\*\/)/g).map((part) => {
      if (part.startsWith('/*')) return part
      return part.replaceAll(':root', ':root[data-ui="r5"]')
        .replace(/(^|[,{]\s*)\[data-updown="cn"\]/gm, '$1:root[data-ui="r5"][data-updown="cn"]')
        .replace(/(^|[,{]\s*)\[data-nav="rail"\]/gm, '$1:root[data-ui="r5"][data-nav="rail"]')
    }).join('')
    expect(v6).toBe('\n' + scope(sourceTokens) + STATUS_BLOCK)
  })

  it('scopes all v6 rules to the r5 root selector', () => {
    expect(v6).not.toBe('')
    expect(v6).toMatch(/:root\[data-ui="r5"\]/)
    expect(v6).not.toMatch(/(^|})\s*:root\s*\{/)
    expect(v6).toContain(':root[data-ui="r5"][data-updown="cn"]')
  })

  it('copies the design source token names and values into the v6 base selector', () => {
    const expected = new Map([...allRootBlocks(sourceTokens, /:root\s*\{([^}]*)\}/g), ...Object.entries(STATUS_PINS)])
    const actual = new Map(allRootBlocks(v6, /:root\[data-ui="r5"\]\s*\{([^}]*)\}/g))
    expect(actual).toEqual(expected)
  })

  it('preserves every r4 token name and value from the S0-A snapshot', () => {
    expect(tokenPairs(currentSegment)).toEqual(tokenPairs(sourceSegment))
  })

  it('changes only the up and down values in the cn override', () => {
    const cnBlocks = new Map(allRootBlocks(v6, /:root\[data-ui="r5"\]\[data-updown="cn"\]\s*\{([^}]*)\}/g))
    const baseBlocks = new Map(allRootBlocks(v6, /:root\[data-ui="r5"\]\s*\{([^}]*)\}/g))
    expect([...cnBlocks.keys()].sort()).toEqual(['--gr-down', '--gr-up'])
    expect(cnBlocks.get('--gr-up')).toBe(baseBlocks.get('--gr-down'))
    expect(cnBlocks.get('--gr-down')).toBe(baseBlocks.get('--gr-up'))
  })
  it('defines --tbl-gap once under the r5 root (tokens.css does not carry it) with the sample steps', () => {
    expect(sourceTokens).not.toContain('--tbl-gap')
    expect([...components.matchAll(/--tbl-gap:\s*(\d+)px/g)].length).toBeGreaterThanOrEqual(6)
    for (const rule of [
      ':root[data-ui="r5"]{--tbl-gap:12px}',
      '@media (min-width:1400px){ :root[data-ui="r5"]{--tbl-gap:20px} }',
      '@media (min-width:1760px){ :root[data-ui="r5"]{--tbl-gap:32px} }',
      ':root[data-ui="r5"][data-nav="rail"]{--tbl-gap:8px}',
      '@media (min-width:1400px){ :root[data-ui="r5"][data-nav="rail"]{--tbl-gap:16px} }',
      '@media (min-width:1760px){ :root[data-ui="r5"][data-nav="rail"]{--tbl-gap:32px} }',
    ]) expect(components.split(rule)).toHaveLength(2)
  })

  it('gives r5 a single-column workspace and a narrow, transparent-until-hover scrollbar', () => {
    expect(components).toContain(':root[data-ui="r5"] .g5-ws.g5-one{grid-template-columns:minmax(0,1fr)}')
    // 维护者 规矩：滚动条窄 + 透明（UI 反馈 10-11）。旧契约（.g5-scroll 的 scrollbar-width:none + 6px 专用规则）已被 X1 取代：
    // 全局规则在 theme.css（4px、默认透明、悬停显色），r5 components.css 不再有冲突的专用覆盖。
    expect(components).not.toContain('scrollbar-width:none')
    expect(components).not.toContain('.g5-scroll::-webkit-scrollbar{width:6px')
    // 标准属性（Firefox）只放在「没有 -webkit- 滚动条伪元素」的 @supports 里：Chromium 见到它们会忽略 4px 伪元素规则、退回 15px 系统滚动条（占版面）
    expect(theme).toContain(['@supports not selector(::-webkit-scrollbar) {', '    * { scrollbar-width: thin; scrollbar-color: var(--gr-clear) var(--gr-clear); }', '    *:hover { scrollbar-color: var(--gr-thumb) var(--gr-clear); }', '  }'].join(String.fromCharCode(10)))
    expect(theme).toContain('*::-webkit-scrollbar { width: 4px; height: 4px; }')
    expect(theme).toContain('*::-webkit-scrollbar-thumb { background: var(--gr-clear); border-radius: var(--gr-r-bar); }')
    expect(theme).toContain('*:hover::-webkit-scrollbar-thumb { background: var(--gr-thumb); }')
    expect(components).not.toContain('scrollbar-gutter')
  })

  it('keeps the status colours fixed under cn: only --gr-up and --gr-down swap', () => {
    const cn = new Map(allRootBlocks(v6, /:root\[data-ui="r5"\]\[data-updown="cn"\]\s*\{([^}]*)\}/g))
    expect([...cn.keys()].sort()).toEqual(['--gr-down', '--gr-up'])
    const base = new Map(allRootBlocks(v6, /:root\[data-ui="r5"\]\s*\{([^}]*)\}/g))
    for (const [name, value] of Object.entries(STATUS_PINS)) {
      expect(base.get(name)).toBe(value)
      expect(value).not.toMatch(/var\(/)
      expect(cn.has(name)).toBe(false)
    }
    // 固定值 = intl 口径的涨跌值；r4 段里这两个令牌仍是别名（r4 行为不变）
    expect(STATUS_PINS['--gr-st-ok']).toBe(base.get('--gr-up'))
    expect(STATUS_PINS['--gr-st-err']).toBe(base.get('--gr-down'))
    expect(currentSegment).toContain('--gr-st-ok: var(--gr-up)')
    expect(currentSegment).toContain('--gr-st-err: var(--gr-down)')
  })
})