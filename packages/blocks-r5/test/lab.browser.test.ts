// SPDX-License-Identifier: CPAL-1.0
// 实验列表真浏览器用例：esbuild 把实验块（注册表里的同一份定义）+ 组件库打成独立页，本机 Edge 经 CDP 无头直连，不弹窗、不装依赖。
// 数据走夹具桥（与壳外预览同口径）；壳路由 `?ui=r5#/lab` 由 S1 落地后，T2 另行在真壳上复跑。
// 设 P7_SHOTS_DIR=<目录> 时把各态截图写到那里（回报用）；不设不写。
import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchCdp } from './helpers/cdp'
import anchorsJson from './geo-anchors/lab.json'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const home = process.env.GITRADER_HOME ?? mkdtempSync(join(tmpdir(), 'gr-p7-'))
process.env.GITRADER_HOME = home
const SHOTS = process.env.P7_SHOTS_DIR ? resolve(process.env.P7_SHOTS_DIR) : ''
const restricted = new Set([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831])

type Rect = [number, number, number, number]
const anchors = anchorsJson as unknown as { skip: Record<string, string[]>; widths: Record<string, Record<string, Rect>> }
const WIDTHS = [1280, 1440, 1920] as const

// ---- 页内探针：只读，返回对象 ---------------------------------------------------------------

const GEOMETRY = `(() => {
  const FS = [11, 12, 13, 14, 16, 20, 36]
  const card = document.querySelector('[data-g5-page="lab"]')
  const nm = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
  const textNodes = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
  const trect = (n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect() }
  const out = { docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth, overflow: [], truncated: [], halfRows: [], escape: [], numcol: [], align: [], badFont: [], capsule: [], fuse: 0, rows: 0 }
  const cr = card.getBoundingClientRect()
  for (const el of card.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue
    if (cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 0.5) out.overflow.push(nm(el) + ' ' + el.scrollWidth + '>' + el.clientWidth)
    const b = el.getBoundingClientRect()
    if (b.width && b.height && (b.left < cr.left - 0.5 || b.right > cr.right + 0.5 || b.top < cr.top - 0.5 || b.bottom > cr.bottom + 0.5)) out.escape.push(nm(el))
    if (el.matches('button, a') && b.width > 2 * b.height && parseFloat(cs.borderTopLeftRadius) >= b.height / 2) out.capsule.push(nm(el))
    const tn = textNodes(el)
    if (!tn.length) continue
    const fs = Math.round(parseFloat(cs.fontSize) * 100) / 100
    if (!FS.includes(fs)) out.badFont.push(nm(el) + ' ' + fs)
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) out.truncated.push('ellipsis ' + nm(el))
    for (const t of tn) {
      const r = trect(t)
      if (!r.width) continue
      if (r.right > innerWidth + 0.5 || r.left < -0.5) out.truncated.push('viewport-x ' + nm(el))
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const ac = getComputedStyle(a)
        if (ac.overflowX === 'visible' && ac.overflowY === 'visible') continue
        const ar = a.getBoundingClientRect()
        const L = ar.left + a.clientLeft, R = L + a.clientWidth, T = ar.top + a.clientTop, B = T + a.clientHeight
        if (r.bottom <= T || r.top >= B || r.right <= L || r.left >= R) break
        if (r.left < L - 0.5 || r.right > R + 0.5) out.truncated.push('clip-x ' + nm(el))
        if (r.top < T - 0.5 || r.bottom > B + 0.5) out.halfRows.push(nm(el))
      }
    }
  }
  // 卡内左缘共线：标题、表头首列、每行首列的文字左缘 = 卡片左缘 + 20
  for (const el of [card.querySelector('.g5-hd h2'), ...card.querySelectorAll('thead th:first-child, tbody td:first-child')]) {
    if (!el) continue
    const f = textNodes(el)[0] ?? el.firstElementChild
    const x = (f && f.nodeType === 3 ? trect(f) : (f ?? el).getBoundingClientRect()).left - cr.left
    if (Math.abs(x - 20) > 0.5) out.align.push(nm(el) + ' x=' + x.toFixed(2))
  }
  // 数字列右缘共线
  const groups = {}
  card.querySelectorAll('[data-n]').forEach((el) => {
    const t = textNodes(el); const r = t.length ? trect(t[t.length - 1]) : el.getBoundingClientRect()
    ;(groups[el.getAttribute('data-n')] ??= []).push(r.right)
  })
  for (const [k, xs] of Object.entries(groups)) { const d = Math.max(...xs) - Math.min(...xs); if (d > 0.5) out.numcol.push(k + ' spread=' + d.toFixed(2)) }
  out.fuse = card.querySelectorAll('.g5-fuse').length
  out.rows = card.querySelectorAll('tbody tr').length
  return out
})()`

const ANCHORS = `(() => {
  const S = { card: '[data-g5-page="lab"]', title: '.g5-hd h2', count: '.g5-hd .g5-ct', tabs: '.g5-tabs', dd: '.g5-dd', scroll: '.g5-tw' }
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 100) / 100) }
  const root = document.querySelector(S.card)
  const out = {}
  for (const [k, v] of Object.entries(S)) { const el = k === 'card' ? root : root.querySelector(v); if (el) out[k] = r(el) }
  root.querySelectorAll('.g5-tab').forEach((el, i) => { out['tab' + i] = r(el) })
  root.querySelectorAll('thead th').forEach((el, i) => { out['th' + i] = r(el) })
  const rows = [...root.querySelectorAll('tbody tr')]
  rows.forEach((el, i) => { out['row' + i] = r(el) })
  if (rows[0]) rows[0].querySelectorAll('td').forEach((el, i) => { out['r0c' + i] = r(el) })
  return out
})()`

// ---- 页面：实验块 + 夹具桥 ---------------------------------------------------------------

const ENTRY = `
import { h, render } from 'preact'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { KernelError } from '@gitrader/blocks-sdk'
import '@gitrader/workbench/ui'
import { labBlocks } from './src/pages/lab'
import { labItems, labItemsNoLastAction } from './fixtures/lab'

const calls = (window.__calls = [])
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
function bridgeFor(state) {
  const query = async (method, params) => {
    calls.push({ method, params })
    if (state === 'loading') return new Promise(() => {})
    if (state === 'error') throw new KernelError(-32000, 'The local fixture cannot provide this view.', { name: 'DATA_UNAVAILABLE' })
    if (state === 'unwired') throw new KernelError(-32601, 'unknown operation lab.list', { name: 'METHOD_NOT_FOUND' })
    if (state === 'shape') return {}
    if (state === 'okfalse') return { ok: false, error: { code: 'DATA_UNAVAILABLE', message: 'The local fixture cannot provide this view.' } }
    if (state === 'empty') return { items: [] }
    if (state === 'nolast') return { items: labItemsNoLastAction }
    if (state === 'paged') {
      const start = params && params.cursor ? Number(params.cursor) : 0
      const end = start + 8
      return { items: labItems.slice(start, end), ...(end < labItems.length ? { next: String(end) } : {}) }
    }
    return { items: labItems }
  }
  return { blockId: 'block.gitrader.lab', instanceId: 'lab-1', async hello() { return {} }, subscribe() { return () => {} }, query, async command() { return undefined },
    link: { get() { return undefined }, set() {}, subscribe() { return () => {} } } }
}
window.mountLab = async (state, rect, mode) => {
  const root = document.getElementById('root')
  render(null, root)
  calls.length = 0
  const de = document.documentElement
  de.setAttribute('data-ui', 'r5')
  if (state === 'offline') de.setAttribute('data-offline', ''); else de.removeAttribute('data-offline')
  if (mode) de.setAttribute('data-updown', mode); else de.removeAttribute('data-updown')
  root.style.cssText = 'will-change:transform;position:absolute;display:flex;flex-direction:column;left:' + rect[0] + 'px;top:' + rect[1] + 'px;width:' + rect[2] + 'px;height:' + rect[3] + 'px'
  const bridge = bridgeFor(state)
  const props = { bridge, instanceId: 'lab-1', config: { view: 'list' }, setConfig() {}, channel: 'A', grid: { w: 12, h: 8 }, mode: 'tile' }
  const Comp = labBlocks[0].component
  render(h(BridgeContext.Provider, { value: bridge }, h(Comp, props)), root)
  await frames()
  return true
}
`

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
const svgText = {
  name: 'svg-text',
  setup(b: { onLoad(o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: 'js' }>): void }) {
    b.onLoad({ filter: /\.svg$/ }, async (a) => ({ contents: `export default ${JSON.stringify((await readFile(a.path, 'utf8')).replace(/fill="#FFFFFF"/gi, 'fill="currentColor"').trim())}`, loader: 'js' }))
  },
}

let dir = ''
let server: Server | undefined
let base = ''
let cdp: Awaited<ReturnType<typeof launchCdp>> | undefined
const cdps: Array<Awaited<ReturnType<typeof launchCdp>>> = []

async function open(width: number, state: string, mode?: 'cn') {
  if (!cdp || (cdp as unknown as { width?: number }).width !== width) {
    if (cdp) await cdp.close()
    cdp = await launchCdp({ width, height: 900 })
    ;(cdp as unknown as { width?: number }).width = width
    cdps.push(cdp)
    await cdp.navigate(`${base}/index.html`)
    await cdp.evaluate('typeof window.mountLab === "function"')
  }
  const card = anchors.widths[String(width)]!.card!
  await cdp.evaluate(`window.mountLab(${JSON.stringify(state)}, ${JSON.stringify(card)}, ${JSON.stringify(mode ?? null)})`)
  if (state !== 'loading') await waitFor(`!document.querySelector('[data-g5-page="lab"][aria-busy]')`)
  await new Promise((r) => setTimeout(r, 120))
  return cdp
}
async function waitFor(expr: string, ms = 8000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cdp!.evaluate(expr)) return
    await new Promise((r) => setTimeout(r, 60))
  }
  throw new Error(`waitFor timed out: ${expr}`)
}
const shot = async (name: string) => {
  if (!SHOTS) return
  await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }) // 鼠标移开，截图里没有悬停态
  await new Promise((r) => setTimeout(r, 80))
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, name), await cdp!.screenshot())
}
const text = async (sel: string) => String(await cdp!.evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`))
/** 真鼠标点：先用 elementFromPoint 确认落点确实在目标内，再发按下 / 抬起。 */
async function clickAt(sel: string) {
  const pt = (await cdp!.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); const x = b.left + Math.min(20, b.width / 2), y = b.top + b.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (el === hit || el.contains(hit)) } })()`)) as { x: number; y: number; ok: boolean } | null
  expect(pt, `找不到 ${sel}`).not.toBeNull()
  expect(pt!.ok, `${sel} 被别的元素盖住`).toBe(true)
  for (const type of ['mousePressed', 'mouseReleased']) await cdp!.send('Input.dispatchMouseEvent', { type, x: pt!.x, y: pt!.y, button: 'left', clickCount: 1 })
}

beforeAll(async () => {
  dir = mkdtempSync(join(home, 'lab-p7-'))
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: pkg, loader: 'tsx', sourcefile: 'lab-harness.tsx' },
    outdir: dir, entryNames: 'harness', write: true, bundle: true, platform: 'browser', format: 'iife', target: 'es2022',
    jsx: 'automatic', jsxImportSource: 'preact', loader: { '.js': 'jsx', '.woff2': 'file' }, assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, plugins: [svgText as never],
    define: { __GITRADER_VERSION__: '"p7-test"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', legalComments: 'none',
  })
  expect(result.errors).toHaveLength(0)
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh-CN" data-ui="r5"><head><meta charset="utf-8"><title>lab</title><link rel="icon" href="data:,"><link rel="stylesheet" href="harness.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>')
  server = createServer((req, res) => {
    const file = resolve(dir, '.' + decodeURIComponent((req.url ?? '/').split('?')[0]!))
    if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
  })
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  if (restricted.has(port)) throw new Error('static server landed on a restricted port')
  base = `http://127.0.0.1:${port}`
}, 120_000)

afterAll(async () => {
  for (const c of cdps) await c.close().catch(() => undefined)
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const FORBIDDEN = ['保守', '激进', '稳赚', '跑赢', '稳定盈利', '预期收益', '预测', '年化收益']

describe('实验列表 · 真浏览器', () => {
  it('三宽度几何 0（横滚 / 溢出 / 截断 / 半行 / 越卡 / 左缘 / 数字列 / 字号 / 胶囊）', async () => {
    for (const width of WIDTHS) {
      const page = await open(width, 'normal')
      const g = (await page.evaluate(GEOMETRY)) as Record<string, unknown>
      expect(g, `width ${width}`).toMatchObject({ docScrollX: 0, overflow: [], truncated: [], halfRows: [], escape: [], numcol: [], align: [], badFont: [], capsule: [], rows: 16 })
      await shot(`lab-${width}.png`)
    }
    expect(cdp!.errors).toEqual([])
  })

  it('锚点与稿差 ≤ ±4 px', async () => {
    const miss: string[] = []
    for (const width of WIDTHS) {
      const page = await open(width, 'normal')
      const got = (await page.evaluate(ANCHORS)) as Record<string, Rect>
      for (const [key, want] of Object.entries(anchors.widths[String(width)]!)) {
        const have = got[key]
        if (!have) { miss.push(`${width} ${key} 缺`); continue }
        const skip = anchors.skip[key] ?? []
        ;['x', 'y', 'w', 'h'].forEach((axis, i) => { if (!skip.includes(axis) && Math.abs(have[i]! - want[i]!) > 4) miss.push(`${width} ${key}.${axis} ${have[i]} 对 ${want[i]}`) })
      }
    }
    expect(miss).toEqual([])
  })

  it('运行中流光全屏唯一；离线去引信', async () => {
    await open(1440, 'normal')
    expect(await cdp!.evaluate(`document.querySelectorAll('.g5-fuse').length`)).toBe(1)
    expect(await cdp!.evaluate(`document.querySelectorAll('.g5-btn-primary').length`)).toBe(0)
    expect(await text('.g5-runc')).toContain('回测 第 1 次')
    await open(1440, 'offline')
    expect(await cdp!.evaluate(`document.querySelectorAll('.g5-fuse').length`)).toBe(0)
    expect(await text('.g5-runc')).toContain('运行中')
  })

  it('点行进详情（行体与名称链接都走 #/lab/<id>）', async () => {
    await open(1440, 'normal')
    await cdp!.evaluate(`location.hash = ''`)
    await clickAt('tr[data-id="EXP-0014"] td:nth-child(3)')
    await waitFor(`location.hash === '#/lab/EXP-0014'`, 2000)
    await cdp!.evaluate(`location.hash = ''`)
    await clickAt('tr[data-id="EXP-0017"] a.lab-link')
    await waitFor(`location.hash === '#/lab/EXP-0017'`, 2000)
  })

  it('阶段页签与创建方筛选：计数、行数、标题计数一致', async () => {
    await open(1440, 'normal')
    expect(await text('.g5-tabs')).toBe('全部16假设2回测5保留期5影子2小额实盘2')
    await clickAt('.g5-tab:nth-child(5)')
    await waitFor(`document.querySelectorAll('tbody tr').length === 2`, 2000)
    expect(await text('.g5-hd .g5-ct')).toBe('2')
    expect(await cdp!.evaluate(`document.querySelector('.g5-tab[aria-selected="true"]').textContent`)).toBe('影子2')
    await clickAt('.g5-dd')
    await waitFor(`!!document.querySelector('[role="menuitemradio"]')`, 3000)
    expect(await cdp!.evaluate(`[...document.querySelectorAll('[role="menuitemradio"]')].map((e) => e.textContent.trim()).join('/')`)).toBe('全部/人/引擎/LLM Agent/系统')
    await clickAt('[role="menuitemradio"][data-v="human"]')
    await waitFor(`document.querySelectorAll('tbody tr').length === 1`, 2000)
    expect(await text('.g5-dd')).toBe('创建方 人')
    expect(await text('.g5-tabs')).toBe('全部6假设1回测0保留期4影子1小额实盘0')
    expect(await cdp!.evaluate(`document.querySelector('tbody tr').dataset.id`)).toBe('EXP-0014')
  })

  it('最近动作缺字段：整列灰「—」，其余列照常；游标翻页取全', async () => {
    await open(1440, 'nolast')
    expect(await cdp!.evaluate(`[...document.querySelectorAll('tbody tr')].map((tr) => tr.children[7].textContent).join('|')`)).toBe(Array(16).fill('—').join('|'))
    expect(await cdp!.evaluate(`document.querySelectorAll('.g5-fuse').length`)).toBe(0)
    expect(await text('tbody tr:first-child td:nth-child(1)')).toBe('订单簿失衡 ETH 5m')
    await open(1440, 'paged')
    expect(await cdp!.evaluate(`document.querySelectorAll('tbody tr').length`)).toBe(16)
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.method === 'lab.list').map((c) => c.method + ':' + (c.params.cursor ?? '-')).join(',')`)).toBe('lab.list:-,lab.list:8')
  })

  it('四态 + 未接通：加载 / 空 / 错误（内核原文）/ 离线 / 未接通，各一张截图', async () => {
    await open(1440, 'loading')
    expect(await cdp!.evaluate(`document.querySelectorAll('.g5-sk').length`)).toBeGreaterThan(20)
    expect(await cdp!.evaluate(`document.querySelector('[data-g5-page="lab"]').getAttribute('aria-busy')`)).toBe('true')
    await shot('lab-state-loading.png')

    await open(1440, 'empty')
    expect(await text('.g5-hd .g5-ct')).toBe('0')
    expect(await text('[data-g5-page="lab"]')).toBe('实验0还没有实验')
    expect(await cdp!.evaluate(`document.querySelectorAll('[data-g5-page="lab"] table, [data-g5-page="lab"] button').length`)).toBe(0)
    await shot('lab-state-empty.png')

    await open(1440, 'error')
    expect(await text('.lab-msg')).toBe('读取失败The local fixture cannot provide this view.重试')
    await shot('lab-state-error.png')
    await open(1440, 'okfalse')
    expect(await text('.lab-msg .g5-msg')).toBe('The local fixture cannot provide this view.')

    await open(1440, 'offline')
    expect(await cdp!.evaluate(`!!document.querySelector('[data-g5-page="lab"] .g5-off[data-state="offline"] table')`)).toBe(true)
    expect(await text('[data-stale="paused"]')).toMatch(/^已暂停更新 · \d\d:\d\d$/)
    expect(await cdp!.evaluate(`document.querySelectorAll('tbody tr').length`)).toBe(16)
    await shot('lab-state-offline.png')

    await open(1440, 'unwired')
    expect(await cdp!.evaluate(`!!document.querySelector('.lab-msg [data-wire="off"]')`)).toBe(true)
    expect(await text('.lab-msg')).toBe('未接通unknown operation lab.list')
    expect(await cdp!.evaluate(`document.querySelectorAll('[data-g5-page="lab"] button').length`)).toBe(0)
    await shot('lab-state-unwired.png')
    await open(1440, 'shape')
    expect(await text('.lab-msg')).toBe('未接通lab.list 回包缺少 items')
    expect(cdp!.errors).toEqual([])
  })

  it('涨跌互换：本页没有涨跌着色，红涨绿跌 / 绿涨红跌下卡内每个元素颜色不变', async () => {
    const colors = async (mode?: 'cn') => {
      await open(1440, 'normal', mode)
      return cdp!.evaluate(`[...document.querySelectorAll('[data-g5-page="lab"] *')].map((e) => { const c = getComputedStyle(e); return c.color + '|' + c.backgroundColor + '|' + c.borderTopColor })`)
    }
    const intl = (await colors()) as string[]
    const cn = (await colors('cn')) as string[]
    expect(cn).toEqual(intl)
    expect(await cdp!.evaluate(`document.documentElement.getAttribute('data-updown')`)).toBe('cn')
    await shot('lab-1440-cn.png')
  })

  it('禁词与收益列：各态卡内文字无禁词；表头无收益列', async () => {
    for (const state of ['normal', 'empty', 'error', 'unwired', 'offline']) {
      await open(1440, state)
      const t = String(await cdp!.evaluate(`document.querySelector('[data-g5-page="lab"]').textContent`))
      for (const w of FORBIDDEN) expect(t, `${state} 含 ${w}`).not.toContain(w)
    }
    await open(1440, 'normal')
    expect(await cdp!.evaluate(`[...document.querySelectorAll('thead th')].map((t) => t.textContent).join('/')`)).toBe('名称/阶段/登记/前向天数/前向交易/试验/偏差检查/最近动作/创建方/编号/')
  })

  it('源码：首行 SPDX、零颜色字面量、无全圆胶囊、无本机路径 / 邮箱 / 密钥', () => {
    for (const file of ['src/views/lab-list.tsx', 'src/views/lab.css', 'src/model-lab.ts', 'src/pages/lab.tsx', 'fixtures/lab.ts']) {
      const src = readFileSync(join(pkg, file), 'utf8')
      expect(src.split(/\r?\n/, 1)[0], file).toContain('SPDX-License-Identifier: CPAL-1.0')
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![-\w])/)
      expect(src, file).not.toMatch(/\b(rgba?|hsla?|oklch|oklab)\(/)
      expect(src, file).not.toMatch(/9999px|border-radius:\s*50%|border-radius:\s*100%/)
      expect(src, file).not.toMatch(/[A-Za-z]:[\\/]|@[\w-]+\.(com|cn|io)|api[_-]?key|secret/i)
    }
    const css = readFileSync(join(pkg, 'src/views/lab.css'), 'utf8')
    for (const decl of css.match(/(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|box-shadow)\s*:[^;}]+/g) ?? []) {
      if (/#|rgb|hsl/.test(decl)) throw new Error(`颜色字面量：${decl}`)
    }
  })
})

