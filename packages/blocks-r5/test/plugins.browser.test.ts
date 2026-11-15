// SPDX-License-Identifier: CPAL-1.0
// 插件页的真浏览器用例：esbuild 把「真块 + 真桥 + 真 KernelClient」打成预览包，夹具内核（stage-entry 的 plugins-<态> 场景）服务它，
// CDP 直连无头 Edge（test/helpers/cdp.ts，随机端口、只关自己起的进程）。壳的 r5 路由由 S1 并行施工，这里不依赖它：
// 预览页只摆 r5 的卡片框架（顶栏 + 资金条的占位高度 128 + 单列工作区），块本身与上线形态一致。
// 选填环境变量：GITRADER_SHOTS_DIR（落截图）、GITRADER_GEOM_OUT（落几何 / 锚点实测 JSON）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHostBridge, LinkHub } from '@gitrader/blocks-sdk'
import { pluginsFixtures } from '../fixtures/plugins'
import { startStage } from '../verify/stage-entry'
import { launchCdp } from './helpers/cdp'
import anchors from './geo-anchors/plugins.json'
import { pluginsBlock } from '../src/pages/plugins'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const root = mkdtempSync(join(home, 'p5-browser-'))
if (!resolve(root).startsWith(resolve(home) + sep)) throw new Error('temporary directory escaped GITRADER_HOME')
const dist = join(root, 'dist')
const shots = process.env.GITRADER_SHOTS_DIR
// 内核真回的绝对路径形状（Windows 盘符 + 反斜杠、POSIX 各一份）；拼接写法是为了让源码卫生检查不把测试自己当成泄漏
const WIN_DIR = 'C:' + '\\Users\\tester-marker\\AppData\\Local\\Gitrader\\plugins\\'
const POSIX_DIR = '/home/' + 'tester-marker/.gitrader/plugins/'
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const ENTRY = `
import { KernelClient, createHostBridge, LinkHub } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { h, render, Fragment } from 'preact'
import { ToastHost } from '@gitrader/workbench/ui'
import { pluginsBlock } from '../src/pages/plugins'
async function main() {
  const q = new URLSearchParams(location.search)
  const boot = document.querySelector('meta[name="gitrader-bootstrap"]')?.getAttribute('content')
  const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: boot }) })
  const { sessionToken } = await res.json()
  const kernel = new KernelClient({ url: 'ws://' + location.host + '/ui', getToken: () => sessionToken, WebSocketCtor: WebSocket, reconnect: false })
  await kernel.connect()
  window.__attests = []
  window.__configs = []
  kernel.setAttestor(async (req) => { window.__attests.push({ action: req.action, params: req.params }); return window.__pinMode === 'cancel' ? null : { method: 'pin', pin: '246810' } })
  const bridge = createHostBridge({ manifest: pluginsBlock.manifest, instanceId: 'bi_plugins_1', kernel, hub: new LinkHub({ A: {} }), trusted: true, isUserActive: () => true })
  const C = pluginsBlock.component
  const config = q.get('tab') ? { tab: q.get('tab') } : {}
  render(h(Fragment, null, h(ToastHost, null), h(BridgeContext.Provider, { value: bridge }, h(C, { bridge, instanceId: 'bi_plugins_1', config, setConfig: (p) => window.__configs.push(p), channel: 'A', grid: { w: 15, h: 9 }, mode: 'tile' }))), document.getElementById('root'))
}
main().catch((e) => { window.__bootError = String(e && e.message || e) })
`
const INDEX = `<!doctype html>
<html lang="zh-CN" data-ui="r5"><head><meta charset="utf-8"><title>p5</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/preview.css"><!--BOOTSTRAP--></head>
<body><main class="g5-frame"><div style="height:128px"></div><div class="g5-ws g5-one" style="grid-template-columns:minmax(0,1fr)"><div class="g5-col"><div id="root" style="display:contents"></div></div></div></main><script src="/preview.js"></script></body></html>`

beforeAll(async () => {
  mkdirSync(dist, { recursive: true })
  await build({
    stdin: { contents: ENTRY, resolveDir: here, loader: 'tsx', sourcefile: 'p5-preview-entry.tsx' },
    outfile: join(dist, 'preview.js'), bundle: true, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'silent',
    loader: { '.js': 'jsx', '.svg': 'text', '.woff2': 'file' }, alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/compat/jsx-runtime' },
    define: { __GITRADER_VERSION__: '"p5"', 'process.env.NODE_ENV': '"production"' },
  })
  writeFileSync(join(dist, 'index.html'), INDEX)
})
afterAll(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) })

type Cdp = Awaited<ReturnType<typeof launchCdp>>
type Stage = Awaited<ReturnType<typeof startStage>>
interface Open { cdp: Cdp; st: Stage; ev<T = unknown>(js: string): Promise<T>; waitFor(js: string, ms?: number): Promise<void>; shot(name: string): Promise<void>; close(): Promise<void> }
type Fail = { code: number; message: string; name: string }
let seq = 0
const sleepBefore = (ms: number, fn: () => unknown) => async () => { await wait(ms); return fn() }

async function open(state: 'normal' | 'empty' | 'loading' | 'error' | 'offline' | 'unwired', width = 1440, opts: { query?: string; missing?: boolean; delayMs?: number; withDir?: boolean } = {}): Promise<Open> {
  const st = await startStage({ staticDir: dist, workspacesDir: join(root, `ws-${++seq}`), scenario: `plugins-${state}` })
  const fx = (pluginsFixtures as Record<string, { queries?: Record<string, unknown>; fail?: Record<string, Fail> }>)[state]!
  for (const [method, f] of Object.entries(fx.fail ?? {})) st.kernel.onQuery(method, () => { throw Object.assign(new Error(f.message), { code: f.code, data: { name: f.name } }) })
  if (opts.missing) st.kernel.onQuery('plugin.list', () => { throw Object.assign(new Error('unknown query plugin.list'), { code: -32601, data: { name: 'METHOD_NOT_FOUND' } }) })
  if (opts.withDir) st.kernel.onQuery('plugin.list', () => (fx.queries!['plugin.list'] as Record<string, unknown>[]).map((r, i) => ({ ...r, dir: (i % 2 ? POSIX_DIR : WIN_DIR) + String(r.id) })))
  if (state === 'loading') st.kernel.onQuery('plugin.list', sleepBefore(opts.delayMs ?? 1500, () => fx.queries!['plugin.list']))
  const cdp = await launchCdp({ width, height: 900 })
  const ev = async <T,>(js: string) => (await cdp.evaluate(js)) as T
  const waitFor = async (js: string, ms = 10_000) => {
    const t0 = Date.now()
    for (;;) {
      if (await ev<boolean>(`Boolean(${js})`).catch(() => false)) return
      if (Date.now() - t0 > ms) throw new Error(`waitFor timed out: ${js} ${await ev<string>('window.__bootError || document.body.innerText.slice(0, 200)').catch(() => '')}`)
      await wait(100)
    }
  }
  const shot = async (name: string) => { if (shots) { mkdirSync(shots, { recursive: true }); writeFileSync(join(shots, `${name}.png`), await cdp.screenshot()) } }
  await cdp.navigate(`${st.kernel.url}/${opts.query ?? ''}`)
  return { cdp, st, ev, waitFor, shot, close: async () => { await cdp.close(); await st.kernel.close() } }
}
const settled = async (p: Open) => { await p.waitFor(`document.querySelector('.g5-plg') && !document.querySelector('[aria-busy="true"]')`); await wait(300) }
const click = (p: Open, sel: string) => p.ev(`document.querySelector(${JSON.stringify(sel)}).click()`)
const text = (p: Open, sel: string) => p.ev<string>(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '')`)

/** 几何探针：reports/visual-r5/src/check.js 的同一规则，选择器改成产品的钩子（卡 = [data-g5=card|float]，左缘标记 = .g5-al）。T1 的 geometry-probe.js 落地后换它。 */
function geomProbe(): Record<string, unknown> {
  const FS = [11, 12, 13, 14, 16, 20, 36]
  const nm = (el: Element) => { const c = (typeof el.className === 'string' && el.className.trim()) ? '.' + el.className.trim().split(/\s+/).join('.') : ''; return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + c }
  const path = (el: Element) => { const p: string[] = []; for (let e: Element | null = el; e && e !== document.body && p.length < 4; e = e.parentElement) p.unshift(nm(e)); return p.join('>') }
  const textNodes = (el: Element) => Array.prototype.filter.call(el.childNodes, (n: Node) => n.nodeType === 3 && (n.textContent ?? '').trim()) as Node[]
  const trect = (n: Node) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect() }
  const out: Record<string, unknown[] | number | Record<string, number>> = { docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth, overflow: [], truncated: [], halfRows: [], escape: [], overlap: [], badFont: [], badSpace: [], align: [], numcol: [], alignOk: 0, numcolOk: 0, fontSizes: {} }
  const push = (k: string, v: string) => (out[k] as unknown[]).push(v)
  const els = document.querySelectorAll('body *')
  for (const el of Array.from(els)) {
    if (el.closest('svg') || /^(SCRIPT|STYLE|TEMPLATE|CANVAS)$/.test(el.tagName)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue
    if (cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 0.5) push('overflow', path(el) + ' ' + el.scrollWidth + '>' + el.clientWidth)
    const sm = (el as HTMLElement & { computedStyleMap?: () => { get(p: string): unknown } }).computedStyleMap?.()
    for (const p of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'row-gap', 'column-gap']) {
      const v = sm ? String(sm.get(p)) : cs.getPropertyValue(p)
      if (!v || v === 'normal' || v === 'auto') continue
      const n = parseFloat(v)
      if (n && Math.abs(Math.round(n * 100) / 100) % 4 !== 0) push('badSpace', path(el) + ' ' + p + '=' + v)
    }
    const tn = textNodes(el)
    if (!tn.length) continue
    const fs = Math.round(parseFloat(cs.fontSize) * 100) / 100
    const fsz = out.fontSizes as Record<string, number>
    fsz[fs] = (fsz[fs] ?? 0) + 1
    if (!FS.includes(fs)) push('badFont', path(el) + ' ' + fs)
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) push('truncated', 'ellipsis ' + path(el))
    for (const t of tn) {
      const r = trect(t)
      if (!r.width) continue
      if (r.right > innerWidth + 0.5 || r.left < -0.5) push('truncated', 'viewport-x ' + path(el))
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const ac = getComputedStyle(a)
        const ox = ac.overflowX !== 'visible'
        const oy = ac.overflowY !== 'visible'
        if (!ox && !oy) continue
        const ar = a.getBoundingClientRect()
        const L = ar.left + a.clientLeft, R = L + a.clientWidth, T = ar.top + a.clientTop, B = T + a.clientHeight
        if (r.bottom <= T || r.top >= B || r.right <= L || r.left >= R) break
        if (ox && (r.left < L - 0.5 || r.right > R + 0.5) && r.bottom > T && r.top < B) push('truncated', 'clip-x ' + path(el) + ' by ' + nm(a))
        if (oy && r.top < B && r.bottom > T && (r.top < T - 0.5 || r.bottom > B + 0.5)) push(ac.overflowY === 'auto' || ac.overflowY === 'scroll' ? 'halfRows' : 'truncated', 'clip-y ' + path(el) + ' by ' + nm(a))
      }
    }
  }
  document.querySelectorAll('.g5-al').forEach((el) => {
    const card = el.closest('[data-g5="card"],[data-g5="float"]')
    if (!card || getComputedStyle(el).display === 'none' || !(el as HTMLElement).offsetParent) return
    const f = Array.prototype.filter.call(el.childNodes, (n: Node) => (n.nodeType === 3 && (n.textContent ?? '').trim()) || (n.nodeType === 1 && getComputedStyle(n as Element).display !== 'none'))[0] as Node | undefined
    const x = (f ? (f.nodeType === 3 ? trect(f) : (f as Element).getBoundingClientRect()) : el.getBoundingClientRect()).left - card.getBoundingClientRect().left
    if (Math.abs(x - 20) > 0.5) push('align', path(el) + ' x=' + x.toFixed(2))
    else (out.alignOk as number) += 1
  })
  const vis = (el: Element) => { const c = getComputedStyle(el); return c.display !== 'none' && c.visibility !== 'hidden' && el.getClientRects().length > 0 }
  const clippedWithin = (el: Element, sc: Element) => { for (let a = el.parentElement; a && a !== sc; a = a.parentElement) { const c = getComputedStyle(a); if (c.overflowX !== 'visible' || c.overflowY !== 'visible') return true } return false }
  const inter = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
  document.querySelectorAll('[data-g5="card"],[data-g5="float"]').forEach((sc) => {
    if (!vis(sc)) return
    const cr = sc.getBoundingClientRect()
    const items: { el: Element; r: DOMRect; txt?: string }[] = []
    sc.querySelectorAll('*').forEach((el) => {
      if ((el.closest('svg') && el.tagName.toLowerCase() !== 'svg') || !vis(el)) return
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return
      if (!clippedWithin(el, sc) && (r.left < cr.left - 0.5 || r.right > cr.right + 0.5 || r.top < cr.top - 0.5 || r.bottom > cr.bottom + 0.5)) push('escape', path(el) + ' 越出 ' + nm(sc))
      if (/^(img|svg|input)$/i.test(el.tagName) || el.matches('.g5-venue,.g5-mk,.g5-alogo,.g5-sw')) items.push({ el, r })
      for (const t of textNodes(el)) { const tr = trect(t); if (tr.width) items.push({ el, r: tr, txt: (t.textContent ?? '').trim().slice(0, 16) }) }
    })
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i]!, B = items[j]!
      if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue
      if (inter(A.r, B.r)) push('overlap', nm(sc) + ': ' + (A.txt ?? nm(A.el)) + ' × ' + (B.txt ?? nm(B.el)))
    }
  })
  return out
}
const GEOM_KEYS = ['overflow', 'truncated', 'halfRows', 'escape', 'overlap', 'badFont', 'badSpace', 'align', 'numcol'] as const
const probe = (p: Open) => p.ev<Record<string, unknown>>(`(${geomProbe.toString()})()`)

/** 全圆胶囊（宽 > 2 倍高且圆角 ≥ 半高的可点件）/ 实心主按钮 / 颜色字面量以外的审计量。 */
const audit = (p: Open) => p.ev<{ capsules: string[]; primary: number; glow: number }>(`(() => {
  const capsules = []
  let glow = 0
  document.querySelectorAll('.g5-plg *').forEach((el) => {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return
    const cs = getComputedStyle(el)
    const rad = parseFloat(cs.borderTopLeftRadius) || 0
    if (el.getAttribute('role') !== 'switch' && !el.classList.contains('g5-sw') && r.width > 2 * r.height && rad >= r.height / 2 && r.height >= 12) capsules.push(el.className + ' ' + rad + ' ' + r.height)
    if (/\\d+px\\s+\\d+px\\s+(\\d+)px/.test(cs.boxShadow) && /rgba?\\(2[0-5]\\d, ?(1\\d\\d|9\\d), ?\\d{1,2}[,)]/.test(cs.boxShadow)) glow += 1
  })
  return { capsules, primary: document.querySelectorAll('.g5-plg .g5-btn-primary').length, glow }
})()`)

interface Rect { x: number; y: number; w: number; h: number }
const GEO = ['card', 'tabs', 'thead', 'grp-first', 'row-1', 'row-3', 'x-3'] as const
/** 取 data-geo 锚点相对卡片左上角的矩形（与稿同口径：卡片 = 原点）。 */
const measure = (p: Open) => p.ev<Record<string, Rect>>(`(() => {
  const card = document.querySelector('[data-geo="plugins.card"]').getBoundingClientRect()
  const out = {}
  for (const el of document.querySelectorAll('[data-geo]')) {
    const r = el.getBoundingClientRect()
    out[el.getAttribute('data-geo').slice(8)] = { x: Math.round(r.left - card.left), y: Math.round(r.top - card.top), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return out
})()`)

const geomOut: Record<string, unknown> = {}
afterAll(() => { if (process.env.GITRADER_GEOM_OUT) writeFileSync(process.env.GITRADER_GEOM_OUT, JSON.stringify(geomOut, null, 2)) })

describe('plugins page · geometry', () => {
  for (const width of [1280, 1440, 1920]) {
    it(`${width} × 900: geometry probe is all zero, with and without an expanded row`, async () => {
      const p = await open('normal', width)
      try {
        await settled(p)
        await p.waitFor(`document.querySelectorAll('tbody tr.g5-row').length === 13`)
        const plain = await probe(p)
        await click(p, 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-expand"]')
        await p.waitFor(`document.querySelector('tr.g5-xrow')`)
        const open = await probe(p)
        for (const [name, g] of [['plain', plain], ['open', open]] as const) {
          for (const k of GEOM_KEYS) expect(g[k], `${width} ${name} ${k}`).toEqual([])
          expect(g.docScrollX, `${width} ${name} docScrollX`).toBe(0)
        }
        expect(plain.alignOk as number).toBeGreaterThanOrEqual(20)
        const a = await audit(p)
        expect(a.capsules).toEqual([])
        expect(a.primary).toBe(0)
        expect(a.glow).toBeLessThanOrEqual(1)
        expect(await p.ev<string[]>(`[...document.querySelectorAll('[data-g5="card"]')].map((c) => c.closest('.g5-col') ? 'col' : 'x')`)).toEqual(['col'])
        geomOut[`probe-${width}`] = { plain: Object.fromEntries(GEOM_KEYS.map((k) => [k, (plain[k] as unknown[]).length])), open: Object.fromEntries(GEOM_KEYS.map((k) => [k, (open[k] as unknown[]).length])), alignOk: plain.alignOk, fontSizes: plain.fontSizes }
        await p.shot(`plugins-${width}-open`)
        await click(p, 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-expand"]')
        await p.waitFor(`!document.querySelector('tr.g5-xrow')`)
        await p.shot(`plugins-${width}`)
      } finally { await p.close() }
    })
  }

  it('anchors match the static mock within ±4 px at all three widths', async () => {
    const table = anchors as { anchor: string; static: Rect; product: Rect; tolerance?: number; reason?: string }[]
    expect(table.length).toBeGreaterThanOrEqual(GEO.length * 3)
    for (const width of [1280, 1440, 1920]) {
      const p = await open('normal', width)
      try {
        await settled(p)
        await p.waitFor(`document.querySelectorAll('tbody tr.g5-row').length === 13`)
        await click(p, 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-expand"]')
        await p.waitFor(`document.querySelector('tr.g5-xrow')`)
        const got = await measure(p)
        geomOut[`anchors-${width}`] = got
        geomOut[`scroller-${width}`] = await p.ev(`(() => { const s = document.querySelector('.g5-tw.g5-scroll'); return { cw: s.clientWidth, ow: s.offsetWidth, ch: s.clientHeight, sh: s.scrollHeight, h: s.style.height, ovY: getComputedStyle(s).overflowY } })()`)
        for (const name of GEO) {
          const want = table.find((r) => r.anchor === `${width}.${name}`)
          expect(want, `${width}.${name} missing in geo-anchors`).toBeDefined()
          // P2-8（详情新增「许可证」一行，min-height 24 px）：稿的展开行没有这一行，展开行高度只在这一处加 24 px，其余锚点与容差不变
          for (const k of ['x', 'y', 'w', 'h'] as const) { const stat = want!.static[k] + (name === 'x-3' && k === 'h' ? 24 : 0); expect(Math.abs(got[name]![k] - stat), `${width}.${name}.${k} product ${got[name]![k]} static ${stat}`).toBeLessThanOrEqual(want!.tolerance ?? 4) } // 条目级 tolerance 优先于全局 4
        }
      } finally { await p.close() }
    }
  })
})

describe('plugins page · interaction', () => {
  it('enabling a plugin that widens permissions asks inline first, then the kernel asks for the PIN', async () => {
    const p = await open('normal')
    try {
      await settled(p)
      p.st.kernel.onCommand('plugin.grant', (_params, ctx) => {
        if (!ctx.attestation) throw Object.assign(new Error('attestation required'), { code: 1010, data: { name: 'ATTESTATION_REQUIRED' } })
        return { ok: true }
      })
      const sw = 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-toggle"]'
      expect(await p.ev(`document.querySelector('${sw}').getAttribute('aria-checked')`)).toBe('false')
      await click(p, sw)
      await p.waitFor(`document.querySelector('.g5-armed')`)
      expect(await text(p, '.g5-armed .g5-what')).toContain('启用 Bybit：新增 4 项权限')
      expect(p.st.kernel.commands.filter((c) => c.action === 'plugin.grant')).toHaveLength(0) // 确认前什么也没发
      await p.shot('plugins-armed')
      await click(p, '[data-act="arm-confirm"]') // 死区内的点击被忽略
      await wait(150)
      expect(p.st.kernel.commands.filter((c) => c.action === 'plugin.grant')).toHaveLength(0)
      await wait(700)
      await click(p, '[data-act="arm-confirm"]')
      await p.waitFor(`window.__attests.length === 1`)
      const grants = p.st.kernel.commands.filter((c) => c.action === 'plugin.grant')
      expect(grants).toHaveLength(2)
      expect(grants[0]!.attestation).toBeUndefined()
      expect(grants[1]!.attestation).toMatchObject({ method: 'pin' })
      expect(grants[1]!.params).toEqual({ id: 'connector.tradekit.bybit', permissions: ['venue.credentials', 'net.fetch', 'trade.live', 'trade.paper'] })
      expect(await p.ev('window.__attests[0].action')).toBe('plugin.grant')
      await p.waitFor(`!document.querySelector('.g5-armed')`)
    } finally { await p.close() }
  })

  it('cancelling the inline confirmation sends nothing; a failed command shows the kernel text', async () => {
    const p = await open('normal')
    try {
      await settled(p)
      p.st.kernel.onCommand('plugin.grant', () => { throw Object.assign(new Error('permission trade.live is not declared by the manifest'), { code: 1004, data: { name: 'INVALID_PARAMS' } }) })
      await click(p, 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-toggle"]')
      await p.waitFor(`document.querySelector('[data-act="arm-cancel"]')`)
      await click(p, '[data-act="arm-cancel"]')
      await p.waitFor(`!document.querySelector('.g5-armed')`)
      expect(p.st.kernel.commands.filter((c) => c.action === 'plugin.grant')).toHaveLength(0)
      await click(p, 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-toggle"]')
      await p.waitFor(`document.querySelector('[data-act="arm-confirm"]')`)
      await wait(800)
      await click(p, '[data-act="arm-confirm"]')
      await p.waitFor(`[...document.querySelectorAll('[data-err-detail] .gr-errd__v')].some((e) => e.textContent.includes('permission trade.live is not declared by the manifest'))`) // ux-fix2 B2：同一规格变更（Owner 令，总控批准）——原文在该报错的详情里
      expect(await p.ev(`Boolean(document.querySelector('.g5-armed'))`)).toBe(true) // 失败：保持武装，可重试
    } finally { await p.close() }
  })

  // GQ-55：开关 = 是否在运行。内核没有停用命令，开关只发 plugin.start / plugin.stop，不再发 plugin.disable、不再标「未接通」
  it('the switch means running: a running plugin turns off with plugin.stop (session, no PIN) and the switch stays live', async () => {
    const p = await open('normal')
    try {
      await settled(p)
      const sw = 'tr[data-id="connector.gitrader.hyperliquid"] [data-act="plugin-toggle"]'
      expect(await p.ev(`document.querySelector('${sw}').getAttribute('aria-checked')`)).toBe('true')
      await click(p, sw)
      await p.waitFor(`document.body.innerText.includes('已停止 Hyperliquid')`)
      expect(p.st.kernel.commands.map((c) => c.action)).toEqual(['plugin.stop'])
      expect(p.st.kernel.commands[0]!.params).toEqual({ id: 'connector.gitrader.hyperliquid' })
      expect(await p.ev<number>('window.__attests.length')).toBe(0)
      await p.waitFor(`!document.querySelector('${sw}').disabled`)
      expect(await p.ev<number>(`document.querySelectorAll('[data-wire="off"]').length`)).toBe(0)
      await p.shot('plugins-toggle-stop')
    } finally { await p.close() }
  })

  it('a failed stop shows the kernel text and the switch can be clicked again; block plugins have nothing to start or stop', async () => {
    const p = await open('normal')
    try {
      await settled(p)
      p.st.kernel.onCommand('plugin.stop', () => { throw Object.assign(new Error('plugin connector.gitrader.binance-data is busy'), { code: 1004, data: { name: 'INVALID_PARAMS' } }) })
      const sw = 'tr[data-id="connector.gitrader.binance-data"] [data-act="plugin-toggle"]'
      await click(p, sw)
      await p.waitFor(`[...document.querySelectorAll('[data-err-detail] .gr-errd__v')].some((e) => e.textContent.includes('plugin connector.gitrader.binance-data is busy'))`) // ux-fix2 B2：同一规格变更（Owner 令，总控批准）——原文在该报错的详情里
      expect(p.st.kernel.commands.map((c) => c.action)).toEqual(['plugin.stop'])
      await p.waitFor(`!document.querySelector('${sw}').disabled`)
      expect(await p.ev(`document.querySelector('${sw}').getAttribute('aria-checked')`)).toBe('true')
      expect(await p.ev(`document.querySelector('tr[data-id="block.gitrader.default"] [data-act="plugin-toggle"]').disabled`)).toBe(true)
      expect(await p.ev(`document.querySelector('tr[data-id="block.gitrader.default"] [data-act="plugin-toggle"]').getAttribute('aria-checked')`)).toBe('true')
      expect(p.st.kernel.commands.some((c) => c.action === 'plugin.disable')).toBe(false)
    } finally { await p.close() }
  })

  it('tabs: 发现 shows one fact and one way out; rescanning goes through plugin.reload', async () => {
    const p = await open('normal', 1440, { query: '?tab=discover' })
    try {
      await settled(p)
      expect(await text(p, '[data-panel="discover"]')).toContain('插件目录尚未开放')
      expect(await p.ev<number>(`document.querySelectorAll('[data-panel="discover"] button').length`)).toBe(1)
      await p.shot('plugins-discover')
      await click(p, '[data-act="plugin-rescan"]')
      await p.waitFor(`document.querySelector('[data-panel="installed"] tbody')`)
      expect(p.st.kernel.commands.map((c) => c.action)).toEqual(['plugin.reload'])
      expect(await p.ev<number>('window.__configs.length')).toBeGreaterThan(0)
    } finally { await p.close() }
  })

  it('expanded detail lists capabilities, audit notes with kernel text, and signature', async () => {
    const p = await open('normal')
    try {
      await settled(p)
      await click(p, 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-expand"]')
      await p.waitFor(`document.querySelector('tr.g5-xrow')`)
      const t = await text(p, 'tr.g5-xrow')
      expect(t).toContain('实盘交易')
      expect(t).toContain('场所凭据')
      expect(t).toContain('secrets-unused')
      expect(t).toContain('BYBIT_API_SECRET 已声明，源码里找不到引用')
      expect(t).toContain('已签名')
    } finally { await p.close() }
  })
})

describe('plugins page · states', () => {
  it('normal: 13 rows in six groups, unverified connectors marked, no directory anywhere in the DOM', async () => {
    const p = await open('normal')
    try {
      await settled(p)
      expect(await p.ev<string[]>(`[...document.querySelectorAll('tr.g5-grp')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`)).toEqual(['交易连接器 3', '行情数据源 2', '策略引擎 2', '通知通道 2', '工作台块 2', '工具 2'])
      expect(await p.ev<string[]>(`[...document.querySelectorAll('.g5-unv')].map((e) => e.closest('tr').getAttribute('data-id'))`)).toEqual(['connector.gitrader.binance-trade', 'connector.tradekit.bybit', 'connector.gitrader.binance-data'])
      expect(await text(p, '[data-tab="installed"]')).toContain('13')
      expect(await p.ev<boolean>(`document.documentElement.outerHTML.includes('secret-dir-marker')`)).toBe(false)
      expect(await p.ev<number>(`document.querySelectorAll('[data-wire="off"]').length`)).toBe(0)
      // 内核校验没过的包：失败 + 开关禁用 + 原文在展开行
      expect(await p.ev(`document.querySelector('tr[data-id="engine.local.py-lab"] [data-act="plugin-toggle"]').disabled`)).toBe(true)
      expect(await text(p, 'tr[data-id="engine.local.py-lab"]')).toContain('失败 1')
      expect(await p.cdp.errors).toEqual([])
    } finally { await p.close() }
  })

  it('K-r5-0: a plugin.list reply that still carries the directory never reaches the DOM or any browser storage', async () => {
    const p = await open('normal', 1440, { withDir: true })
    try {
      await settled(p)
      await p.waitFor(`document.querySelectorAll('tbody tr.g5-row').length === 13`)
      await click(p, 'tr[data-id="connector.tradekit.bybit"] [data-act="plugin-expand"]')
      expect(p.st.kernel.queries.some((q) => q.method === 'plugin.list')).toBe(true)
      expect(await p.ev<boolean>(`document.documentElement.outerHTML.includes('tester-marker') || document.documentElement.outerHTML.includes('plugins/')`)).toBe(false)
      expect(await p.ev<string>(`JSON.stringify([localStorage.length, sessionStorage.length])`)).toBe('[0,0]')
      expect(await p.ev<boolean>(`document.body.innerText.includes('tester-marker')`)).toBe(false)
      // 页面状态：从 Preact 根沿对象图走一遍（组件状态、props、钩子），任何对象都不许有 dir 键、任何字符串都不许含路径
      const scan = await p.ev<{ visited: number; dirKey: boolean; marker: boolean; rows: number }>(`(() => {
        const seen = new WeakSet(); const stack = []; let visited = 0, dirKey = false, marker = false, rows = 0
        const root = document.getElementById('root')
        for (const el of [root, ...root.querySelectorAll('*')]) for (const k of Object.getOwnPropertyNames(el)) { try { stack.push(el[k]) } catch (e) { /* 取不到就跳过 */ } }
        while (stack.length) {
          const o = stack.pop()
          if (typeof o === 'string') { if (o.includes('tester-marker')) marker = true; continue }
          if (!o || typeof o !== 'object' || o instanceof Node || o === window || seen.has(o)) continue
          seen.add(o); visited += 1
          if (Object.keys(o).includes('dir')) dirKey = true
          if (o.id === 'connector.tradekit.bybit' && 'hosts' in o) rows += 1
          for (const k of Object.keys(o)) { try { stack.push(o[k]) } catch (e) { /* 同上 */ } }
        }
        return { visited, dirKey, marker, rows }
      })()`)
      expect(scan.rows, 'scan must reach the view model').toBeGreaterThanOrEqual(1)
      expect(scan.visited).toBeGreaterThan(200)
      expect(scan.dirKey).toBe(false)
      expect(scan.marker).toBe(false)
    } finally { await p.close() }
  })

  it('cancelling the PIN layer means the grant did not happen and the row does not change', async () => {
    const p = await open('normal')
    try {
      await settled(p)
      p.st.kernel.onCommand('plugin.grant', (_params, ctx) => {
        if (!ctx.attestation) throw Object.assign(new Error('attestation required'), { code: 1010, data: { name: 'ATTESTATION_REQUIRED' } })
        return { ok: true }
      })
      await p.ev(`window.__pinMode = 'cancel'`)
      const row = 'tr[data-id="connector.tradekit.bybit"]'
      const before = await text(p, row)
      await click(p, `${row} [data-act="plugin-toggle"]`)
      await p.waitFor(`document.querySelector('[data-act="arm-confirm"]')`)
      await wait(800)
      await click(p, '[data-act="arm-confirm"]')
      await p.waitFor(`window.__attests.length === 1`)
      await wait(500)
      const grants = p.st.kernel.commands.filter((c) => c.action === 'plugin.grant')
      expect(grants).toHaveLength(1) // 只有第一次（被要求证明），带证明的重发没有发生
      expect(grants[0]!.attestation).toBeUndefined()
      expect(await p.ev(`document.querySelector('${row} [data-act="plugin-toggle"]').getAttribute('aria-checked')`)).toBe('false')
      expect(await text(p, row)).toBe(before)
      expect(await p.ev<boolean>(`document.body.innerText.includes('已启用') || document.body.innerText.includes('attestation required')`)).toBe(false) // 取消不打扰：没有成功也没有失败提示
      expect(p.st.kernel.queries.filter((q) => q.method === 'plugin.list')).toHaveLength(1) // 没有重读
    } finally { await p.close() }
  })

  it('unwired: fields the kernel does not return yet show 未接通 with the field name; nothing is invented', async () => {
    const p = await open('unwired')
    try {
      await settled(p)
      await p.waitFor(`document.querySelectorAll('tbody tr.g5-row').length === 13`)
      const row = 'tr[data-id="connector.gitrader.hyperliquid"]'
      const t = await text(p, row)
      for (const field of ['source', 'net.hosts', 'secrets', 'audit']) expect(t, field).toContain(field)
      expect(t).toContain('未接通')
      expect(t).not.toContain('官方')
      expect(await text(p, 'tr[data-id="skill.gitrader.symbol-search"]')).not.toContain('net.hosts') // 没声明 net.fetch：主机一定是「无」
      expect(await p.ev<number>(`document.querySelectorAll('button[role="switch"]').length`)).toBe(13)
      const g = await probe(p)
      for (const k of GEOM_KEYS) expect(g[k], `unwired ${k}`).toEqual([])
      await p.shot('plugins-unwired')
      geomOut['probe-unwired'] = Object.fromEntries(GEOM_KEYS.map((k) => [k, (g[k] as unknown[]).length]))
    } finally { await p.close() }
  })

  it('empty: one fact and one way out', async () => {
    const p = await open('empty')
    try {
      await settled(p)
      await p.waitFor(`document.querySelector('[data-panel="installed"].g5-pmsg')`)
      expect(await text(p, '[data-panel="installed"]')).toContain('还没有安装插件')
      expect(await text(p, '[data-tab="installed"]')).toContain('0')
      const g = await probe(p)
      for (const k of GEOM_KEYS) expect(g[k], `empty ${k}`).toEqual([])
      await p.shot('plugins-empty')
    } finally { await p.close() }
  })

  it('loading: skeleton rows with aria-busy, then the table', async () => {
    const p = await open('loading', 1440, { delayMs: 1500 })
    try {
      await p.waitFor(`document.querySelector('[aria-busy="true"] .g5-sk')`)
      expect(await p.ev<number>(`document.querySelectorAll('.g5-sk').length`)).toBeGreaterThan(10)
      expect(await p.ev<string>(`document.querySelector('.g5-sk').style.width`)).toBe('96px') // Preact 11：数值样式不再自动补 px
      const g = await probe(p)
      for (const k of GEOM_KEYS) expect(g[k], `loading ${k}`).toEqual([])
      await p.shot('plugins-loading')
      await p.waitFor(`document.querySelectorAll('tbody tr.g5-row').length === 13`)
    } finally { await p.close() }
  })

  it('error: kernel text unchanged with a retry; a missing query is unwired and gives no retry', async () => {
    const p = await open('error')
    try {
      await settled(p)
      await p.waitFor(`document.querySelector('[data-panel="installed"].g5-pmsg')`)
      expect(await text(p, '[data-panel="installed"]')).toContain('plugin host is not ready: scan failed')
      expect(await p.ev(`Boolean(document.querySelector('[data-act="read-retry"]'))`)).toBe(true)
      await p.shot('plugins-error')
    } finally { await p.close() }
    const m = await open('error', 1440, { missing: true })
    try {
      await settled(m)
      await m.waitFor(`document.querySelector('[data-panel="installed"].g5-pmsg')`)
      expect(await text(m, '[data-panel="installed"]')).toContain('unknown query plugin.list')
      expect(await m.ev(`document.querySelector('[data-panel="installed"]').getAttribute('data-wire')`)).toBe('off')
      expect(await m.ev(`Boolean(document.querySelector('[data-act="read-retry"]'))`)).toBe(false)
      await m.shot('plugins-error-missing')
    } finally { await m.close() }
  })

  it('offline: dimmed, paused marker, every switch and action disabled', async () => {
    const p = await open('offline')
    try {
      await settled(p)
      await p.waitFor(`document.querySelectorAll('tbody tr.g5-row').length === 13`)
      await p.ev(`document.documentElement.setAttribute('data-offline', '')`)
      await p.waitFor(`document.querySelector('.g5-off') && document.body.innerText.includes('已暂停更新')`)
      expect(await p.ev<number>(`[...document.querySelectorAll('button[role="switch"]')].filter((b) => !b.disabled).length`)).toBe(0)
      const g = await probe(p)
      for (const k of GEOM_KEYS) expect(g[k], `offline ${k}`).toEqual([])
      await p.shot('plugins-offline')
    } finally { await p.close() }
  })
})

describe('plugins page · first-party commands', () => {
  const noKernel = { command: () => Promise.resolve(undefined), query: () => Promise.resolve(undefined), subscribe: () => () => undefined } as never
  const iframeManifest = { ...pluginsBlock.manifest, isolation: 'iframe' as const }
  it('a third-party (untrusted or iframe) bridge cannot send plugin.grant or plugin.uninstall', async () => {
    for (const action of ['plugin.grant', 'plugin.uninstall']) {
      for (const [manifest, trusted] of [[pluginsBlock.manifest, false], [iframeManifest, true]] as const) {
        const bridge = createHostBridge({ manifest, instanceId: 'bi_x', kernel: noKernel, hub: new LinkHub({ A: {} }), trusted, isUserActive: () => true })
        await expect(bridge.command(action, { id: 'x' })).rejects.toMatchObject({ code: 'FIRST_PARTY_ONLY' })
      }
    }
    const first = createHostBridge({ manifest: pluginsBlock.manifest, instanceId: 'bi_x', kernel: noKernel, hub: new LinkHub({ A: {} }), trusted: true, isUserActive: () => true })
    await expect(first.command('plugin.grant', { id: 'x', permissions: [] })).resolves.toBeUndefined()
  })
})

describe('plugins page · source hygiene', () => {
  const files = ['../src/views/plugins.tsx', '../src/views/plugins.css', '../src/model-plugins.ts', '../src/pages/plugins.tsx', '../fixtures/plugins.ts', './model-plugins.test.ts', './plugins.browser.test.ts']
  const read = (f: string) => readFileSync(join(here, f), 'utf8')
  const production = files.slice(0, 5)
  it('has the SPDX header, no colour literals, no round-pill radii, no forbidden words, no local paths or addresses', () => {
    for (const f of files) expect(read(f).split(/\r?\n/, 1)[0], f).toMatch(/SPDX-License-Identifier: CPAL-1\.0/)
    for (const f of production) {
      const src = read(f)
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, f).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/)
      expect(src, f).not.toMatch(/9999px|border-radius:\s*50%/)
      expect(src, f).not.toMatch(/保守|激进|稳赚|跑赢|稳定盈利/)
    }
    for (const f of files) {
      const src = read(f)
      expect(src, f).not.toMatch(/[A-Za-z]:[\\/](?:Users|gitrader|Gitrader)/)
      expect(src, f).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
      expect(src, f).not.toMatch(/[\w.+-]+@[A-Za-z][\w-]*\.[A-Za-z]{2,}\b/)
    }
    const css = read('../src/views/plugins.css')
    for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) expect(m[1], 'radius').toMatch(/var\(--gr-r-[a-z]+\)|^0 /)
  })
})
