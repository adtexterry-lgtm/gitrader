// SPDX-License-Identifier: CPAL-1.0
// 视觉轮 r4 · A1 令牌：theme.css / tw.css 的值对照 reports/visual-r4/comps/r4.css（数值真源）与施工单 3.2。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const theme = read('../src/ui/theme.css')
const tw = read('../src/ui/tw.css')
const comps = read('../../../reports/visual-r4/comps/r4.css')
const prefs = read('../src/core/prefs.ts')

/** 取 `marker` 之后第一个 `{…}` 的正文（令牌块里没有嵌套花括号）。 */
const block = (css: string, marker: string): string => {
  const at = css.indexOf(marker)
  if (at < 0) throw new Error(`找不到 ${marker}`)
  const open = css.indexOf('{', at + marker.length - 1)
  return css.slice(open + 1, css.indexOf('}', open))
}
const decl = (body: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|[\\s;{])${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`).exec(body)
  return m?.[1]?.replace(/\s+/g, ' ').trim()
}
const tokens = theme.slice(theme.indexOf('/* ===== BEGIN TOKENS ===== */'), theme.indexOf('/* ===== END TOKENS ===== */'))
const dark = block(tokens, ':root {')
const legacy = block(tokens.slice(tokens.indexOf('r1（v4）令牌名')), ':root {')
const mid = block(tokens.slice(tokens.indexOf('@media (max-width: 1319px)')), ':root {')
const light = block(tokens, ':root[data-theme="light"] {')
const compsDark = block(comps, ':root {')
const compsLight = block(comps, ':root[data-theme="light"] {')
const twTheme = block(tw, '@theme {')
const twInline = block(tw, '@theme inline {')
const px = (v: string | undefined) => (v && /^\d+px$/.test(v) ? Number.parseInt(v, 10) : NaN)

describe('令牌 r4（A1）', () => {
  it('新面与语义令牌存在，值与 comps/r4.css 一致（深色）', () => {
    const pairs: Array<[string, string]> = [
      ['--gr-card', '--card'], ['--gr-card-edge', '--card-edge'], ['--gr-kill', '--kill'], ['--gr-kill-hi', '--kill-hi'],
      ['--gr-down-wash', '--down-wash'], ['--gr-orange-text', '--orange-text'], ['--gr-switch-on', '--switch-on'], ['--gr-switch-knob-on', '--switch-knob-on'],
      ['--gr-text', '--text'], ['--gr-text-body', '--body'], ['--gr-text-2', '--t2'], ['--gr-text-3', '--t3'], ['--gr-text-dis', '--dis'],
      ['--gr-up', '--up'], ['--gr-down', '--down'], ['--gr-warn', '--warn'],
      ['--gr-line-1', '--line'], ['--gr-line-2', '--line'], ['--gr-row-sep', '--sep'],
      ['--gr-sel-fill', '--fill-1'], ['--gr-hover-fill', '--fill-2'], ['--gr-press-fill', '--fill-3'],
      ['--gr-flow-btn', '--flow-btn'], ['--gr-flow-btn-hover', '--flow-btn-hi'], ['--gr-ink-0', '--canvas'],
      ['--gr-ease-out', '--ease'], ['--gr-ease-exit', '--ease-exit'],
    ]
    for (const [gr, c] of pairs) {
      expect(decl(compsDark, c), c).toBeDefined()
      expect(decl(dark, gr), gr).toBe(decl(compsDark, c))
    }
    expect(decl(legacy, '--gr-line')).toBe('var(--gr-line-1)')
    expect(decl(dark, '--gr-sep')).toBe('var(--gr-row-sep)')
    // 派生三元组跟着换色相
    expect(decl(dark, '--gr-up-a10')).toBe('rgb(70 198 141 / .10)')
    expect(decl(dark, '--gr-down-a10')).toBe('rgb(239 106 110 / .10)')
    expect(decl(dark, '--gr-warn-a10')).toBe('rgb(221 176 84 / .10)')
  })

  it('卡边是单根 6.5% 内线，没有顶内高光（§10）', () => {
    expect(decl(dark, '--gr-card-edge')).toBe('inset 0 0 0 1px rgb(255 255 255 / .065)')
    expect(decl(dark, '--gr-card-edge')).not.toMatch(/inset 0 1px/)
    expect(decl(light, '--gr-card-edge')).toBe('0 0 0 1px rgb(10 10 11 / .08), 0 1px 2px rgb(10 10 11 / .035)')
  })

  it('圆角只产出 2 / 4 / 6 / 10 / 12（旧阶 md/xl/2xl/3xl 已收档）；Tailwind full 也收进控件档（整体微圆角，fix-r3 X1 起）', () => {
    const allowed = [2, 4, 6, 10, 12]
    const names = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl']
    for (const n of names) expect(allowed, `--gr-radius-${n}`).toContain(px(decl(dark, `--gr-radius-${n}`)))
    expect(names.map((n) => px(decl(dark, `--gr-radius-${n}`)))).toEqual([4, 6, 6, 12, 12, 12, 12])
    expect(['bar', 'mark', 'ctl', 'card', 'float'].map((n) => px(decl(dark, `--gr-r-${n}`)))).toEqual([2, 4, 6, 10, 12])
    expect(decl(legacy, '--gr-r-panel')).toBe('var(--gr-r-card)')
    expect(decl(legacy, '--gr-r-lg')).toBe('var(--gr-r-float)')
    expect(decl(legacy, '--gr-r-xl')).toBe('var(--gr-r-float)')
    // Tailwind：rounded-* 全部落在五档，full 例外
    const twRadius = [...`${twTheme};${twInline}`.matchAll(/--radius-([a-z0-9]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()] as const)
    for (const [n, v] of twRadius) {
      if (n === 'full') { expect(v).toBe('var(--gr-r-ctl)'); continue } // rounded-full 不再出胶囊；真圆点（Dot / ActorMark）在源码里单独写 50% / 9999px，由 source-scan 的 round 白名单管
      expect(allowed, `--radius-${n}`).toContain(px(v))
    }
    expect(Object.fromEntries(twRadius.filter(([n]) => ['bar', 'mark', 'ctl', 'card', 'float'].includes(n)).map(([n, v]) => [n, px(v)])))
      .toEqual({ bar: 2, mark: 4, ctl: 6, card: 10, float: 12 })
  })

  it('1440 档尺寸与 1200 档断点 1319px', () => {
    const at1440 = { '--gr-topbar': 40, '--gr-gutter': 24, '--gr-gap': 12, '--gr-pad': 20, '--gr-row': 48, '--gr-ctl-xs': 28,
      '--gr-overview': 56, '--gr-hd': 40, '--gr-th': 32, '--gr-grp': 32, '--gr-row-1': 40, '--gr-lim': 24,
      '--gr-ov-gap': 32, '--gr-ov-lead': 24, '--gr-ov-tail': 24 }
    for (const [k, v] of Object.entries(at1440)) expect(px(decl(dark, k)), k).toBe(v)
    expect(decl(dark, '--gr-col-r')).toBe('clamp(440px, 36vw, 520px)')
    const at1200 = { '--gr-gutter': 16, '--gr-gap': 10, '--gr-pad': 16, '--gr-overview': 52, '--gr-hd': 36, '--gr-th': 30,
      '--gr-grp': 28, '--gr-row': 44, '--gr-row-1': 36, '--gr-lim': 22, '--gr-ov-gap': 24, '--gr-ov-lead': 20, '--gr-ov-tail': 16 }
    for (const [k, v] of Object.entries(at1200)) expect(px(decl(mid, k)), `1319: ${k}`).toBe(v)
    const narrow = block(tokens.slice(tokens.indexOf('@media (min-width: 600px) and (max-width: 1099px)')), ':root {')
    expect(decl(narrow, '--gr-col-r')).toBe('clamp(340px, 36vw, 440px)')
  })

  it('字号：text-3xl = 36 / 40；--gr-fs-hero = 36；细体与字距', () => {
    expect(decl(twTheme, '--text-3xl')).toBe('36px')
    expect(decl(twTheme, '--text-3xl--line-height')).toBe('40px')
    expect(decl(dark, '--gr-fs-hero')).toBe('36px')
    expect(decl(dark, '--gr-fw-light')).toBe('300')
    expect(decl(dark, '--gr-track-hero')).toBe('-0.02em')
    expect(decl(dark, '--gr-track-num')).toBe('-0.01em')
  })

  it('动效：ease-out (.16,1,.3,1)、ease-exit (.4,0,1,1)、flow-dur 24s、13 个新时长齐全', () => {
    expect(decl(dark, '--gr-ease-out')).toBe('cubic-bezier(.16, 1, .3, 1)')
    expect(decl(dark, '--gr-ease-exit')).toBe('cubic-bezier(.4, 0, 1, 1)')
    expect(decl(dark, '--gr-flow-dur')).toBe('24s')
    const durs = { '--gr-dur-row': '240ms', '--gr-dur-row-out': '180ms', '--gr-dur-arm-out': '120ms', '--gr-dur-arm-in': '180ms',
      '--gr-dead': '600ms', '--gr-stagger': '40ms', '--gr-dur-roll': '300ms', '--gr-dur-bar': '400ms', '--gr-dur-fuse': '400ms',
      '--gr-dur-pop': '200ms', '--gr-dur-pop-out': '140ms', '--gr-dur-focus': '120ms' }
    for (const [k, v] of Object.entries(durs)) expect(decl(dark, k), k).toBe(v)
    // --gr-dur-enter 是 r1 别名块里的旧名，改值不挪位
    expect(decl(legacy, '--gr-dur-enter')).toBe('320ms')
    expect(Object.keys(durs).length + 1).toBe(13)
  })

  it('浅色令牌块齐全且与 comps 同值；prefs.ts 的主题枚举不含 light（不可经设置激活）', () => {
    const pairs: Array<[string, string]> = [
      ['--gr-ink-0', '--canvas'], ['--gr-card', '--card'], ['--gr-card-edge', '--card-edge'], ['--gr-line-1', '--line'], ['--gr-row-sep', '--sep'],
      ['--gr-sel-fill', '--fill-1'], ['--gr-hover-fill', '--fill-2'], ['--gr-press-fill', '--fill-3'],
      ['--gr-text', '--text'], ['--gr-text-body', '--body'], ['--gr-text-2', '--t2'], ['--gr-text-3', '--t3'], ['--gr-text-dis', '--dis'],
      ['--gr-up', '--up'], ['--gr-down', '--down'], ['--gr-warn', '--warn'], ['--gr-down-wash', '--down-wash'], ['--gr-kill', '--kill'],
      ['--gr-kill-hi', '--kill-hi'], ['--gr-orange-text', '--orange-text'], ['--gr-focus', '--focus'], ['--gr-glass-fill', '--glass'],
      ['--gr-switch-on', '--switch-on'], ['--gr-switch-knob-on', '--switch-knob-on'],
    ]
    for (const [gr, c] of pairs) {
      expect(decl(compsLight, c), c).toBeDefined()
      expect(decl(light, gr), gr).toBe(decl(compsLight, c))
    }
    expect(decl(light, 'color-scheme')).toBe('light')
    expect(decl(light, '--gr-chrome-bg')).toBe('#0A0A0B')
    expect(tokens).toContain(':root[data-theme="graphite"]')
    expect(prefs).toMatch(/export type Theme = 'deep' \| 'graphite'/)
    expect(prefs).not.toMatch(/'light'/)
  })

  it('--gr-font-num 不再指 Geist Mono；--gr-font-mono 仍指 Geist Mono', () => {
    expect(decl(dark, '--gr-font-num')).toBe('var(--gr-font)')
    expect(decl(dark, '--gr-font')).toMatch(/^"Geist Variable"/)
    expect(decl(dark, '--gr-font-mono')).toMatch(/^"Geist Mono Variable"/)
    expect(decl(twInline, '--font-mono')).toBe('var(--gr-font-mono)')
    expect(decl(twInline, '--font-num')).toBe('var(--gr-font-num)')
  })
})
