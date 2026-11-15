// SPDX-License-Identifier: CPAL-1.0
// 实验详情真浏览器用例：esbuild 把详情的七个视图（lab 块详情分流目标 LabDetailStub，同一份）+ 组件库打成独立页，
// 按稿里七张卡的矩形各摆一个实例，本机 Edge 经 CDP 无头直连，不弹窗、不装依赖。数据走夹具桥（与壳外预览同口径）。
// 壳路由 `?ui=r5#/lab/<id>` 与 pageWorkspace 由 S1 落地后，T2 另行在真壳上复跑。
// 设 P8_SHOTS_DIR=<目录> 时把各态截图写到那里（回报用）；不设不写。
import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { problem } from '../../workbench/verify/fixture-kernel'
import { startStage } from '../verify/stage-entry'
import { launchCdp } from './helpers/cdp'
import anchorsJson from './geo-anchors/lab-detail.json'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const home = process.env.GITRADER_HOME ?? mkdtempSync(join(tmpdir(), 'gr-p8-'))
process.env.GITRADER_HOME = home
const SHOTS = process.env.P8_SHOTS_DIR ? resolve(process.env.P8_SHOTS_DIR) : ''
const restricted = new Set([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831])

type Rect = [number, number, number, number]
const anchors = anchorsJson as unknown as { skip: Record<string, string[]>; widths: Record<string, Record<string, Record<string, Rect>>> }
const WIDTHS = [1280, 1440, 1920] as const

/** 七个块：键 = geo-anchors 里的分组；sel 是块根（一张卡）的选择器。 */
const BLOCKS = {
  head: { sel: '[data-view="head"]' },
  fw: { sel: '[data-view="tier"][data-tier="forward"]' },
  ho: { sel: '[data-view="tier"][data-tier="holdout"]' },
  bt: { sel: '[data-view="tier"][data-tier="backtest"]' },
  assume: { sel: '[data-view="assumptions"]' },
  bias: { sel: '[data-view="bias"]' },
  data: { sel: '[data-view="data"]' },
} as const
type BlockKey = keyof typeof BLOCKS
const KEYS = Object.keys(BLOCKS) as BlockKey[]

// ---- 页内探针：只读，返回对象 ---------------------------------------------------------------

const GEOMETRY = `((SEL) => {
  const FS = [11, 12, 13, 14, 16, 20, 36]
  const card = document.querySelector(SEL)
  if (!card) return { missing: SEL }
  const nm = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
  const textNodes = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
  const trect = (n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect() }
  const out = { docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth, overflow: [], truncated: [], halfRows: [], escape: [], numcol: [], align: [], badFont: [], capsule: [] }
  const cr = card.getBoundingClientRect()
  for (const el of card.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue
    if (cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 0.5) out.overflow.push(nm(el) + ' ' + el.scrollWidth + '>' + el.clientWidth)
    const b = el.getBoundingClientRect()
    // 稿的 check.js 同一规则：夹在元素与卡片之间的有裁切祖先（滚动区），滚出去的部分不算越卡
    const clipped = () => { for (let a = el.parentElement; a && a !== card; a = a.parentElement) { const c = getComputedStyle(a); if (c.overflowX !== 'visible' || c.overflowY !== 'visible') return true } return false }
    if (b.width && b.height && !clipped() && (b.left < cr.left - 0.5 || b.right > cr.right + 0.5 || b.top < cr.top - 0.5 || b.bottom > cr.bottom + 0.5)) out.escape.push(nm(el))
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
  // 卡内左缘共线：卡头标题、定义表 / 指标的标签首列文字左缘 = 卡片左缘 + 20（通栏头没有 h2，不检）
  for (const el of card.querySelectorAll('.g5-hd h2, .g5-defs > div:nth-child(odd) > .g5-k, .g5-defs:not(.g5-two) > div > .g5-k')) {
    const f = textNodes(el)[0]
    if (!f) continue
    const x = trect(f).left - cr.left
    if (Math.abs(x - 20) > 0.5) out.align.push(nm(el) + ' x=' + x.toFixed(2))
  }
  // 数字列右缘共线
  const groups = {}
  card.querySelectorAll('[data-n]').forEach((el) => {
    const t = textNodes(el); const r = t.length ? trect(t[t.length - 1]) : el.getBoundingClientRect()
    ;(groups[el.getAttribute('data-n')] ??= []).push(r.right)
  })
  for (const [k, xs] of Object.entries(groups)) { const d = Math.max(...xs) - Math.min(...xs); if (d > 0.5) out.numcol.push(k + ' spread=' + d.toFixed(2)) }
  return out
})`

const SELECTORS: Record<BlockKey, Record<string, string>> = {
  head: { back: '.lab-back', eid: '.lab-eid', title: '.lab-ttl', ladder: '.lab-ladder', req: '.lab-req', export: '[data-act="export"]', promote: '[data-act="promote"]' },
  fw: { title: '.g5-hd h2', plot: '.lab-plot', ya: '.lab-ya', xa: '.lab-xa', mx0: '.lab-tb3 > dl:nth-of-type(1)', mx1: '.lab-tb3 > dl:nth-of-type(2)', redge: '.lab-ret', s12: '.lab-hrow > .g5-s12.g5-t2', acct: '.lab-acct' },
  ho: { title: '.g5-hd h2', plot: '.lab-plot', ya: '.lab-ya', xa: '.lab-xa', mx0: '.lab-tb3 > dl:nth-of-type(1)', mx1: '.lab-tb3 > dl:nth-of-type(2)', redge: '.lab-ret', s12: '.lab-hrow > .g5-s12.g5-t2' },
  bt: { title: '.g5-hd h2', plot: '.lab-plot', ya: '.lab-ya', xa: '.lab-xa', mx0: '.lab-tb3 > dl:nth-of-type(1)', mx1: '.lab-tb3 > dl:nth-of-type(2)', redge: '.lab-ret', s12: '.lab-hrow > .g5-s12.g5-t2', dd: '.g5-dd', tabs: '.g5-tabs' },
  assume: { title: '.g5-hd h2', defs: '.g5-defs', row0: '.g5-defs > div:nth-child(1)', row1: '.g5-defs > div:nth-child(2)', row2: '.g5-defs > div:nth-child(3)', row3: '.g5-defs > div:nth-child(4)', row4: '.g5-defs > div:nth-child(5)', row5: '.g5-defs > div:nth-child(6)', row6: '.g5-defs > div:nth-child(7)' },
  bias: { title: '.g5-hd h2', defs: '.g5-defs', row0: '.g5-defs > div:nth-child(1)', row1: '.g5-defs > div:nth-child(2)', row2: '.g5-defs > div:nth-child(3)', row3: '.g5-defs > div:nth-child(4)', row4: '.g5-defs > div:nth-child(5)' },
  // GQ-34：数据卡的行在 .lab-dsc（可见 5 整行的滚动区）里，位置与稿相同
  data: { title: '.g5-hd h2', defs: '.g5-defs', row0: '.lab-dsc > div:nth-child(1)', row1: '.lab-dsc > div:nth-child(2)', row2: '.lab-dsc > div:nth-child(3)', row3: '.lab-dsc > div:nth-child(4)', row4: '.lab-dsc > div:nth-child(5)', notes: '.lab-notes', nh: '.lab-xh', notes0: '.lab-notes .g5-ar:first-child' },
}
const ANCHORS = (key: BlockKey) => `(() => {
  const S = ${JSON.stringify(SELECTORS[key])}
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 100) / 100) }
  const root = document.querySelector(${JSON.stringify(BLOCKS[key].sel)})
  const out = { card: r(root) }
  for (const [k, v] of Object.entries(S)) { const el = root.querySelector(v); if (el) out[k] = r(el) }
  return out
})()`

// ---- 页面：七个视图 + 夹具桥 ---------------------------------------------------------------

const ENTRY = `
import { h, render } from 'preact'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { KernelError } from '@gitrader/blocks-sdk'
import '@gitrader/workbench/ui'
import { LabDetailStub } from './src/pages/lab-detail'
import { resetShared } from './src/views/lab-detail/data'
import { labDetailItem, labDetailEmptyItem, labDetailRequests, labDetailRunResult, labDetailStrategies, labDetailAccounts } from './fixtures/lab-detail'

const calls = (window.__calls = [])
const downloads = (window.__downloads = [])
// 导出证据包：只记下载名，不真的触发浏览器下载
HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download) }
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
const never = () => new Promise(() => {})
const CONFIGS = {
  head: { view: 'head' }, fw: { view: 'tier', tier: 'forward' }, ho: { view: 'tier', tier: 'holdout' }, bt: { view: 'tier', tier: 'backtest' },
  assume: { view: 'assumptions' }, bias: { view: 'bias' }, data: { view: 'data' },
}
window.__opts = {}
function bridgeFor(key) {
  const o = () => window.__opts
  const query = async (method, params) => {
    calls.push({ method, params })
    const state = o().state
    if (method === 'lab.get') {
      if (state === 'loading') return never()
      if (state === 'error') throw new KernelError(-32000, 'The local fixture cannot provide this view.', { name: 'DATA_UNAVAILABLE' })
      if (state === 'unwired') throw new KernelError(-32601, 'unknown operation lab.get', { name: 'METHOD_NOT_FOUND' })
      if (state === 'shape') return {}
      if (state === 'okfalse') return { ok: false, error: { code: 'DATA_UNAVAILABLE', message: 'The local fixture cannot provide this view.' } }
      if (state === 'empty') return labDetailEmptyItem
      if (state === 'livesmall') return { ...labDetailItem, stage: 'live_small' }
      if (state === 'norunsummaries') return { ...labDetailItem, runSummaries: undefined }
      if (state === 'unfrozen') return { ...labDetailItem, stage: 'backtest', frozen: { hypothesis: false, subject: false, holdout: false }, holdoutWindow: null }
      if (state === 'packed') return { ...labDetailItem, runSummaries: labDetailItem.runSummaries.map((r) => r.runId === 'run_bt_7' ? { ...r, packId: 'pck_fixture' } : r) }
      if (state === 'retired') return { ...labDetailItem, stage: 'retired' }
      return labDetailItem
    }
    if (method === 'lab.run') {
      if (state === 'samerun') return labDetailRunResult('run_bt_7') // 内核不区分阶段：保留期问到的也是回测那份
      if (state === 'runerror') throw new KernelError(-32000, 'Completed result for this experiment run is unavailable', { name: 'EXPERIMENT_EVIDENCE_INCOMPLETE' })
      return labDetailRunResult(params.runId)
    }
    if (method === 'ledger.query') {
      if (o().ledger === 'none') return []
      if (o().ledger === 'denied') throw new Error('QUERY_NOT_ALLOWED ledger.query')
      return labDetailRequests
    }
    if (method === 'lab.export') return { schema: 'gitrader-lab-export/1', experiment: labDetailItem }
    if (method === 'engine.strategies') return o().strategies === 'none' ? [] : labDetailStrategies
    if (method === 'account.list') return labDetailAccounts
    throw new KernelError(-32601, 'unknown operation ' + method, { name: 'METHOD_NOT_FOUND' })
  }
  const command = async (action, params) => {
    calls.push({ method: action, params, command: true })
    await new Promise((r) => setTimeout(r, o().delay || 0))
    if (o().command === 'denied') throw new KernelError(-32000, 'forward.spanDays 14 < 21', { name: 'PROMOTION_DENIED' })
    if (o().command === 'pack1013' && action === 'lab.pack') throw new KernelError(1013, 'A recorded run intersects the proposed holdout window', { name: 'EXPERIMENT_CONTRADICTION' })
    if (o().command === 'cancel') { const e = new KernelError(1010, 'PIN cancelled', { name: 'ATTESTATION_REQUIRED' }); e.cancelled = true; throw e }
    return { experimentId: params.experimentId, stage: params.to }
  }
  return { blockId: 'block.gitrader.lab', instanceId: 'lab-detail-' + key, async hello() { return {} }, subscribe() { return () => {} }, query, command,
    link: { get(g) { return g === 'experiment' ? (o().id || 'EXP-0014') : undefined }, set() {}, subscribe() { return () => {} } } }
}
let mounted = []
window.mountDetail = async (opts, rects, mode) => {
  for (const c of mounted) { render(null, c); c.remove() }
  mounted = []
  resetShared()
  calls.length = 0
  window.__opts = opts
  const de = document.documentElement
  de.setAttribute('data-ui', 'r5')
  if (opts.state === 'offline') de.setAttribute('data-offline', ''); else de.removeAttribute('data-offline')
  if (mode) de.setAttribute('data-updown', mode); else de.removeAttribute('data-updown')
  const root = document.getElementById('root')
  if (opts.stack) {
    // lab {view:'detail'}：一块出全页的竖排整栈
    const c = document.createElement('div')
    c.style.cssText = 'position:absolute;display:flex;flex-direction:column;left:16px;top:16px;width:1248px;height:860px'
    root.append(c)
    mounted.push(c)
    render(h(BridgeContext.Provider, { value: bridgeFor('stack') }, h(LabDetailStub, { config: { view: 'detail' } })), c)
    await frames()
    return true
  }
  for (const key of Object.keys(CONFIGS)) {
    const rect = rects[key]
    const c = document.createElement('div')
    c.style.cssText = 'will-change:transform;position:absolute;display:flex;flex-direction:column;left:' + rect[0] + 'px;top:' + rect[1] + 'px;width:' + rect[2] + 'px;height:' + rect[3] + 'px'
    root.append(c)
    mounted.push(c)
    const bridge = bridgeFor(key)
    render(h(BridgeContext.Provider, { value: bridge }, h(LabDetailStub, { config: CONFIGS[key] })), c)
  }
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

interface Opts { state?: string; ledger?: 'none' | 'denied'; command?: 'denied' | 'cancel' | 'pack1013'; delay?: number; stack?: boolean; strategies?: 'none' }
async function open(width: number, opts: Opts = {}, mode?: 'cn') {
  if (!cdp || (cdp as unknown as { width?: number }).width !== width) {
    if (cdp) await cdp!.close()
    cdp = await launchCdp({ width, height: 900 })
    ;(cdp as unknown as { width?: number }).width = width
    cdps.push(cdp)
    await cdp.navigate(`${base}/index.html`)
    await cdp.evaluate('typeof window.mountDetail === "function"')
  }
  const rects: Record<string, Rect> = {}
  for (const k of KEYS) rects[k] = anchors.widths[String(width)]![k]!.card!
  const state = opts.state ?? 'normal'
  await cdp.evaluate(`window.mountDetail(${JSON.stringify({ ...opts, state })}, ${JSON.stringify(rects)}, ${JSON.stringify(mode ?? null)})`)
  if (state !== 'loading') await waitFor(`!document.querySelector('[data-g5-page="lab-detail"][aria-busy]')`)
  await new Promise((r) => setTimeout(r, 150))
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
const count = async (sel: string) => Number(await cdp!.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 真鼠标点：先用 elementFromPoint 确认落点确实在目标内，再发按下 / 抬起。 */
async function clickAt(sel: string) {
  const pt = (await cdp!.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); const x = b.left + Math.min(20, b.width / 2), y = b.top + b.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (el === hit || el.contains(hit)) } })()`)) as { x: number; y: number; ok: boolean } | null
  expect(pt, `找不到 ${sel}`).not.toBeNull()
  expect(pt!.ok, `${sel} 被别的元素盖住`).toBe(true)
  for (const type of ['mousePressed', 'mouseReleased']) await cdp!.send('Input.dispatchMouseEvent', { type, x: pt!.x, y: pt!.y, button: 'left', clickCount: 1 })
}
const calledMethods = async () => (await cdp!.evaluate(`window.__calls.map((c) => c.method + (c.command ? '!' : ''))`)) as string[]

beforeAll(async () => {
  dir = mkdtempSync(join(home, 'lab-p8-'))
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: pkg, loader: 'tsx', sourcefile: 'lab-detail-harness.tsx' },
    outdir: dir, entryNames: 'harness', write: true, bundle: true, platform: 'browser', format: 'iife', target: 'es2022',
    jsx: 'automatic', jsxImportSource: 'preact', loader: { '.js': 'jsx', '.woff2': 'file' }, assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, plugins: [svgText as never],
    define: { __GITRADER_VERSION__: '"p8-test"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', legalComments: 'none',
  })
  expect(result.errors).toHaveLength(0)
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh-CN" data-ui="r5"><head><meta charset="utf-8"><title>lab-detail</title><link rel="icon" href="data:,"><link rel="stylesheet" href="harness.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>')
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

const FORBIDDEN = ['保守', '激进', '稳赚', '跑赢', '稳定盈利', '预期收益', '预测', '年化收益', '年化']
const allText = async () => String(await cdp!.evaluate(`[...document.querySelectorAll('[data-g5-page="lab-detail"]')].map((e) => e.textContent).join('|')`))

describe('实验详情 · 真浏览器', () => {
  it('三宽度几何 0（七张卡：横滚 / 溢出 / 截断 / 半行 / 越卡 / 左缘 / 数字列 / 字号 / 胶囊）', async () => {
    for (const width of WIDTHS) {
      const page = await open(width)
      for (const key of KEYS) {
        const g = (await page.evaluate(`${GEOMETRY}(${JSON.stringify(BLOCKS[key].sel)})`)) as Record<string, unknown>
        expect(g, `width ${width} ${key}`).toMatchObject({ docScrollX: 0, overflow: [], truncated: [], halfRows: [], escape: [], numcol: [], align: [], badFont: [], capsule: [] })
      }
      await shot(`lab-detail-${width}.png`)
    }
    expect(cdp!.errors).toEqual([])
  })

  it('锚点与稿差 ≤ ±4 px', async () => {
    const miss: string[] = []
    for (const width of WIDTHS) {
      const page = await open(width)
      for (const key of KEYS) {
        const got = (await page.evaluate(ANCHORS(key))) as Record<string, Rect>
        for (const [name, want] of Object.entries(anchors.widths[String(width)]![key]!)) {
          const have = got[name]
          if (!have) { miss.push(`${width} ${key}.${name} 缺`); continue }
          const skip = anchors.skip[`${key}.${name}`] ?? []
          ;['x', 'y', 'w', 'h'].forEach((axis, i) => { if (!skip.includes(axis) && Math.abs(have[i]! - want[i]!) > 4) miss.push(`${width} ${key}.${name}.${axis} ${have[i]} 对 ${want[i]}`) })
        }
      }
    }
    expect(miss).toEqual([])
  })

  it('每屏流光 0、实心主按钮 0（弹出卡未开）；通栏头 56 是唯一例外，其余卡头都是 --gr-hd', async () => {
    await open(1440)
    expect(await count('.g5-fuse')).toBe(0)
    expect(await count('[data-g5-page="lab-detail"] .g5-btn-primary')).toBe(0)
    const heights = (await cdp!.evaluate(`(() => {
      const std = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gr-hd'))
      return { std, head: document.querySelector('[data-view="head"] .g5-hd').getBoundingClientRect().height,
        others: [...document.querySelectorAll('[data-g5-page="lab-detail"]:not([data-view="head"]) > .g5-hd')].map((e) => e.getBoundingClientRect().height) }
    })()`)) as { std: number; head: number; others: number[] }
    expect(heights.head).toBe(56)
    expect(heights.others).toHaveLength(6)
    for (const h of heights.others) expect(h).toBe(heights.std)
    expect(heights.std).not.toBe(56)
  })

  it('只有前向着色：红涨绿跌 / 绿涨红跌下，前向的区间收益与曲线换色，其余每个元素颜色不变；保留期 / 回测中性', async () => {
    const colors = async (mode?: 'cn') => {
      await open(1440, {}, mode)
      return (await cdp!.evaluate(`Object.fromEntries(${JSON.stringify(KEYS)}.map((k) => [k, [...document.querySelectorAll('[data-g5-page="lab-detail"]')].filter((c) => c.getAttribute('data-view') + (c.getAttribute('data-tier') ? ':' + c.getAttribute('data-tier') : '') === ({ head: 'head', fw: 'tier:forward', ho: 'tier:holdout', bt: 'tier:backtest', assume: 'assumptions', bias: 'bias', data: 'data' })[k]).flatMap((c) => [c, ...c.querySelectorAll('*')]).map((e) => { const s = getComputedStyle(e); return s.color + '|' + s.backgroundColor + '|' + s.borderTopColor + '|' + s.stroke })]))`)) as Record<string, string[]>
    }
    const intl = await colors()
    const retColor = async () => String(await cdp!.evaluate(`getComputedStyle(document.querySelector('[data-tier="forward"] .lab-ret')).color`))
    const intlRet = await retColor()
    const cn = await colors('cn')
    const cnRet = await retColor()
    for (const k of KEYS) if (k !== 'fw') expect(cn[k], `${k} 在两种配色下颜色应当不变`).toEqual(intl[k])
    expect(cn.fw).not.toEqual(intl.fw)
    expect(cnRet).not.toBe(intlRet)
    await shot('lab-detail-1440-cn.png')
    // 前向区间收益是涨色；保留期 / 回测的区间收益是主文字色（中性）
    const base = await open(1440)
    const rets = (await base.evaluate(`['forward', 'holdout', 'backtest'].map((t) => getComputedStyle(document.querySelector('[data-tier="' + t + '"] .lab-ret')).color)`)) as string[]
    const textColor = String(await base.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--gr-text')`)).trim()
    expect(rets[1]).toBe(rets[2])
    expect(rets[0]).not.toBe(rets[1])
    expect(await count('[data-tier="holdout"] .g5-up, [data-tier="holdout"] .g5-down, [data-tier="backtest"] .g5-up, [data-tier="backtest"] .g5-down, [data-view="head"] .g5-up, [data-view="head"] .g5-down')).toBe(0)
    expect(textColor).not.toBe('')
  })

  it('文案：三口径数字 / 无年化 / 无禁词 / 无解释性副标题（各态）', async () => {
    await open(1440)
    expect(await text('[data-tier="forward"] .g5-hd')).toBe('前向纸面acct_paper110-09 至今 · 14 天附加纸面运行区间收益+0.46%')
    expect(await text('[data-tier="holdout"] .g5-hd')).toBe('保留期样本外09-01 至 09-30 · 30 天区间收益+1.10%')
    expect(await text('[data-tier="backtest"] .g5-hd')).toBe('回测样本内04-01 至 08-31 · 153 天第 7 次 / 共 7 次曲线成交K 线出证据包区间收益+6.20%')
    for (const t of ['forward', 'holdout', 'backtest']) {
      const dl = await text(`[data-tier="${t}"] .lab-tb3`)
      expect(dl, t).toContain('交易')
      expect(dl, t).toContain('最大回撤')
      expect(dl, t).toContain('手续费')
    }
    expect(await text('[data-tier="forward"] .lab-tb3 dl:nth-of-type(1)')).toBe('交易23胜率52%夏普1.08最大回撤−0.52%')
    expect(await text('[data-tier="forward"] .lab-tb3 dl:nth-of-type(2)')).toBe('手续费−3.12资金费−0.86')
    expect(await text('[data-tier="holdout"] .lab-tb3 dl:nth-of-type(1)')).toBe('交易41胜率49%夏普0.94最大回撤−0.44%')
    expect(await text('[data-tier="backtest"] .lab-tb3 dl:nth-of-type(2)')).toBe('手续费−38.60资金费−9.85')
    expect(await text('[data-view="assumptions"]')).toBe('回测假设7手续费场所费率滑点5 bp成交模型next-bar-open资金费计入强平计入成交量上限缺延迟200 ms')
    expect(await text('[data-view="bias"]')).toBe('偏差检查前视通过递归通过试验次数7训练截止不涉及')
    expect(await text('[data-view="head"] .lab-ladder')).toBe('假设回测保留期影子小额实盘')
    expect(await cdp!.evaluate(`document.querySelector('[data-view="head"] [aria-current="step"]').textContent`)).toBe('影子')
    for (const state of ['normal', 'empty', 'error', 'unwired', 'offline', 'runerror']) {
      await open(1440, { state })
      const t = await allText()
      for (const w of FORBIDDEN) expect(t, `${state} 含 ${w}`).not.toContain(w)
    }
  })

  it('回测次数缺省最新一次；换到第 3 次重取 lab.run；成交页签有表；K 线页签未接通', async () => {
    await open(1440)
    expect(await text('[data-tier="backtest"] .g5-dd')).toBe('第 7 次 / 共 7 次')
    expect((await calledMethods()).filter((m) => m === 'lab.run')).toHaveLength(2) // 保留期 + 最新一次回测
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.method === 'lab.run').map((c) => c.params.runId).sort().join(',')`)).toBe('run_bt_7,run_ho_1')
    await clickAt('[data-tier="backtest"] .g5-dd')
    await waitFor(`!!document.querySelector('[role="menuitemradio"]')`, 3000)
    await sleep(300)
    expect(await cdp!.evaluate(`[...document.querySelectorAll('[role="menuitemradio"]')].map((e) => e.textContent.trim()).join('/')`)).toBe(Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 次 / 共 7 次`).join('/'))
    await clickAt('[role="menuitemradio"]:nth-child(3)')
    await waitFor(`document.querySelector('[data-tier="backtest"] .lab-ret')?.textContent === '+5.00%'`, 4000)
    expect(await text('[data-tier="backtest"] .g5-dd')).toBe('第 3 次 / 共 7 次')
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.method === 'lab.run').map((c) => c.params.runId).pop()`)).toBe('run_bt_3')
    await clickAt('[data-tier="backtest"] [data-tab="trades"]')
    await waitFor(`document.querySelectorAll('[data-tier="backtest"] tbody tr').length === 30`, 3000)
    expect(await text('[data-tier="backtest"] thead')).toBe('时间方向价格数量盈亏手续费原因')
    const g = (await cdp!.evaluate(`${GEOMETRY}(${JSON.stringify(BLOCKS.bt.sel)})`)) as Record<string, unknown>
    expect(g).toMatchObject({ docScrollX: 0, overflow: [], truncated: [], escape: [], numcol: [], badFont: [] })
    await shot('lab-detail-1440-trades.png')
    await clickAt('[data-tier="backtest"] [data-tab="kline"]')
    await waitFor(`!!document.querySelector('[data-tier="backtest"] [data-wire="off"]')`, 3000)
    expect(await text('[data-tier="backtest"] [data-wire="off"]')).toContain('未接通')
    await clickAt('[data-tier="backtest"] [data-tab="curve"]')
    await waitFor(`!!document.querySelector('[data-tier="backtest"] .lab-plot svg path.g5-eq-line')`, 3000)
  })

  it('三张口径卡数据互不相同：区间收益 / 指标 / 曲线各取各阶段的 run；每张卡向内核问的是自己的 runId', async () => {
    await open(1440)
    const read = (t: string) => cdp!.evaluate(`(() => { const c = document.querySelector('[data-tier="${t}"]'); return JSON.stringify({ ret: c.querySelector('.lab-ret').textContent, dl: c.querySelector('.lab-tb3').textContent, line: c.querySelector('path.g5-eq-line').getAttribute('d') }) })()`).then((v) => JSON.parse(String(v)) as { ret: string; dl: string; line: string })
    const [fw, ho, bt] = await Promise.all([read('forward'), read('holdout'), read('backtest')])
    expect(new Set([fw.ret, ho.ret, bt.ret]).size).toBe(3)
    expect(new Set([fw.dl, ho.dl, bt.dl]).size).toBe(3)
    expect(new Set([fw.line, ho.line, bt.line]).size).toBe(3)
    expect([fw.ret, ho.ret, bt.ret]).toEqual(['+0.46%', '+1.10%', '+6.20%'])
    expect(ho.dl).toContain('41')
    expect(ho.dl).toContain('−0.44%')
    expect(bt.dl).toContain('286')
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.method === 'lab.run').map((c) => c.params.runId).sort().join(',')`)).toBe('run_bt_7,run_ho_1')
  })

  it('缺某阶段数据 → 该卡未接通，不借用别的阶段：内核对保留期回了回测那份 → 保留期未接通（specDigest），回测照常；lab.get 没带 runSummaries → 保留期 / 回测都未接通，前向照常', async () => {
    await open(1440, { state: 'samerun' })
    expect(await cdp!.evaluate(`!!document.querySelector('[data-tier="holdout"] [data-wire="off"]')`)).toBe(true)
    expect(await text('[data-tier="holdout"] .lab-msg')).toBe('未接通lab.run 回包不是所请求的那次运行（specDigest 与 run_ho_1 不符）')
    expect(await count('[data-tier="holdout"] .lab-ret')).toBe(0)
    expect(await count('[data-tier="holdout"] svg path.g5-eq-line')).toBe(0)
    expect(await text('[data-tier="backtest"] .lab-ret')).toBe('+6.20%')
    expect(await text('[data-tier="forward"] .lab-ret')).toBe('+0.46%')
    await shot('lab-detail-state-holdout-unwired.png')

    await open(1440, { state: 'norunsummaries' })
    for (const t of ['holdout', 'backtest']) {
      expect(await text(`[data-tier="${t}"] .lab-msg`), t).toBe('未接通lab.get 回包缺少 runSummaries')
      expect(await count(`[data-tier="${t}"] [data-wire="off"]`), t).toBe(1)
      expect(await count(`[data-tier="${t}"] .lab-ret`), t).toBe(0)
    }
    expect(await text('[data-tier="forward"] .lab-ret')).toBe('+0.46%')
    expect((await calledMethods()).filter((m) => m === 'lab.run')).toHaveLength(0)
  })

  it('悬停读数：竖向虚线 + 点 + 读数小卡（时间 · 权益 · 币种）；移开即收；曲线只画到最后一个真实点', async () => {
    await open(1440)
    const box = (await cdp!.evaluate(`(() => { const b = document.querySelector('[data-tier="forward"] .g5-pa').getBoundingClientRect(); return [b.left, b.top, b.width, b.height] })()`)) as number[]
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0]! + box[2]! * 0.62, y: box[1]! + box[3]! / 2 })
    await waitFor(`!!document.querySelector('[data-tier="forward"] .lab-tip')`, 2000)
    expect(await text('[data-tier="forward"] .lab-tip')).toMatch(/^\d\d-\d\d \d\d:\d\d[\d,]+\.\d\dUSDC$/)
    expect(await count('[data-tier="forward"] .lab-vx')).toBe(1)
    await shot('lab-detail-1440-hover.png')
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    await waitFor(`!document.querySelector('[data-tier="forward"] .lab-tip')`, 2000)
    // 末点 = 最后一个快照（10-22 21:22 的 9,987.50），点在曲线末端
    const end = (await cdp!.evaluate(`(() => { const pa = document.querySelector('[data-tier="forward"] .g5-pa'); const i = pa.querySelector('.g5-end'); return [pa.getBoundingClientRect().right - i.getBoundingClientRect().right, document.querySelector('[data-tier="forward"] .lab-xa').lastChild.textContent] })()`)) as [number, string]
    expect(end[1]).toBe('10-22 21:22')
    expect(Math.abs(end[0] - 2)).toBeLessThan(1.5)
  })

  it('晋级旅程：弹出卡列证据 → 取消 / 晋级 → 后果 + 确认（600 ms 内不算）→ 内核命令（PIN 由壳弹）→ 回执关卡并重读', async () => {
    await open(1440, { delay: 500 })
    expect(await text('[data-view="head"] .lab-req')).toBe('Claude Code申请晋级 小额实盘09:12')
    expect(await cdp!.evaluate(`document.querySelector('[data-act="promote"]').disabled`)).toBe(false)
    await clickAt('[data-act="promote"]')
    await waitFor(`!!document.querySelector('.lab-apop')`, 3000)
    await sleep(400)
    expect(await text('.lab-apop .g5-hd')).toBe('晋级到 小额实盘')
    expect(await text('.lab-apop .lab-dl')).toBe('当前阶段影子前向天数14 天前向交易23偏差检查通过 2 / 2试验次数7')
    expect(await count('.lab-apop .g5-btn-primary')).toBe(1)
    await shot('lab-detail-1440-pop.png')
    // 取消 = 关卡、不发命令
    await clickAt('.lab-apop [data-act="promote-cancel"]')
    await waitFor(`!document.querySelector('.lab-apop')`, 3000)
    expect((await calledMethods()).filter((m) => m.endsWith('!'))).toEqual([])
    // 再开：晋级 → 后果一行
    await clickAt('[data-view="head"] [data-act="open-promote"]')
    await waitFor(`!!document.querySelector('.lab-apop')`, 3000)
    await sleep(400)
    await clickAt('.lab-apop [data-act="promote-go"]')
    await waitFor(`!!document.querySelector('.lab-apop [data-act="promote-confirm"]')`, 2000)
    expect(await text('.lab-apop .g5-armed .g5-what')).toBe('晋级后可在实盘账户启动 grid-paper')
    expect(await cdp!.evaluate(`document.activeElement.getAttribute('data-act')`)).toBe('promote-back')
    // 600 ms 内的确认点击不算数
    await clickAt('.lab-apop [data-act="promote-confirm"]')
    await sleep(100)
    expect((await calledMethods()).filter((m) => m.endsWith('!'))).toEqual([])
    await sleep(600)
    const before = (await calledMethods()).filter((m) => m === 'lab.get').length
    await clickAt('.lab-apop [data-act="promote-confirm"]')
    await waitFor(`document.querySelector('.lab-apop [data-act="promote-confirm"]')?.textContent === '晋级中…'`, 2000)
    expect(await cdp!.evaluate(`document.querySelector('.lab-apop [data-act="promote-confirm"]').disabled`)).toBe(true)
    expect(await count('.lab-apop [data-act="promote-back"]')).toBe(0)
    await waitFor(`!document.querySelector('.lab-apop')`, 4000)
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.command).map((c) => c.method + ' ' + JSON.stringify(c.params))`)).toEqual(['lab.stage {"experimentId":"EXP-0014","to":"live_small"}'])
    await waitFor(`window.__calls.filter((c) => c.method === 'lab.get').length > ${before}`, 3000) // 成功后头卡重读
  })

  it('晋级被内核拒绝：原文留在弹出卡里（不改写、不关）；PIN 层点取消 = 回到确认条、无报错', async () => {
    await open(1440, { command: 'denied' })
    await clickAt('[data-act="promote"]')
    await waitFor(`!!document.querySelector('.lab-apop')`, 3000)
    await sleep(400)
    await clickAt('.lab-apop [data-act="promote-go"]')
    await waitFor(`!!document.querySelector('.lab-apop [data-act="promote-confirm"]')`, 2000)
    await sleep(700)
    await clickAt('.lab-apop [data-act="promote-confirm"]')
    await waitFor(`!!document.querySelector('.lab-apop .lab-deny')`, 3000)
    expect(await text('.lab-apop .lab-deny')).toBe('PROMOTION_DENIED forward.spanDays 14 < 21')
    expect(await text('[data-view="head"] .lab-ladder [aria-current="step"]')).toBe('影子')
    expect(await count('.lab-apop')).toBe(1)
    await shot('lab-detail-1440-denied.png')
    await clickAt('.lab-apop [data-act="promote-close"]')
    await waitFor(`!document.querySelector('.lab-apop')`, 3000)

    await open(1440, { command: 'cancel' })
    await clickAt('[data-act="promote"]')
    await waitFor(`!!document.querySelector('.lab-apop')`, 3000)
    await sleep(400)
    await clickAt('.lab-apop [data-act="promote-go"]')
    await waitFor(`!!document.querySelector('.lab-apop [data-act="promote-confirm"]')`, 2000)
    await sleep(700)
    await clickAt('.lab-apop [data-act="promote-confirm"]')
    await waitFor(`document.querySelector('.lab-apop [data-act="promote-confirm"]')?.textContent === '确认晋级' && !document.querySelector('.lab-apop [data-act="promote-confirm"]').disabled`, 3000)
    expect(await count('.lab-apop .lab-deny')).toBe(0)
    expect(await count('.lab-apop [data-act="promote-back"]')).toBe(1)
  })

  it('目标阶段不含实盘：小额实盘的实验晋级键禁用、不出 Agent 申请；ledger.query 取不到就不出申请行', async () => {
    await open(1440, { state: 'livesmall' })
    expect(await cdp!.evaluate(`document.querySelector('[data-act="promote"]').disabled`)).toBe(true)
    expect(await count('[data-view="head"] .lab-req')).toBe(0)
    expect(await text('[data-view="head"] .lab-ladder [aria-current="step"]')).toBe('小额实盘')
    for (const ledger of ['none', 'denied'] as const) {
      await open(1440, { ledger })
      expect(await count('[data-view="head"] .lab-req')).toBe(0)
      expect(await cdp!.evaluate(`document.querySelector('[data-act="promote"]').disabled`)).toBe(false)
      expect(await text('[data-view="data"] .lab-xh')).toBe('注记3')
    }
    await open(1440)
    expect(await text('[data-view="data"] .lab-xh')).toBe('注记4')
    expect(await text('[data-view="data"] .lab-notes .g5-ar:first-child')).toBe('10-22 09:12Claude Code申请晋级 小额实盘')
    expect(await text('[data-view="data"] .lab-notes')).not.toContain('EXP-0099')
  })

  it('GQ-34 数据与来历：读得到实验自身的策略 / 参数 / 留出 / 大模型；可见 5 整行、其余区内滚动', async () => {
    await open(1440)
    const keys = await cdp!.evaluate(`[...document.querySelectorAll('[data-view="data"] .lab-dsc .g5-k')].map((e) => e.textContent.trim())`) as string[]
    expect(keys.slice(0, 7)).toEqual(['假设', '策略', 'grids', 'rangeRatio', 'gridMode', '留出', '大模型'])
    expect(keys).toContain('派生自')
    expect(await text('[data-view="data"] .lab-dsc')).toContain('已冻结')
    const box = await cdp!.evaluate(`(() => { const e = document.querySelector('[data-view="data"] .lab-dsc'); return [e.clientHeight, e.scrollHeight] })()`) as number[]
    expect(box[0]).toBe(160)
    expect(box[1]).toBeGreaterThan(160)
  })

  it('lab {view:"detail"}：一块出全页竖排整栈（七张卡）；七块同时挂载只问内核一次 lab.get', async () => {
    await open(1280, { stack: true })
    await waitFor(`document.querySelectorAll('[data-g5-page="lab-detail"] .lab-ret').length === 3`, 5000)
    expect(await count('[data-g5-page="lab-detail"]')).toBe(7)
    expect(await text('.lab-stack [data-tier="forward"] .lab-ret')).toBe('+0.46%')
    expect((await calledMethods()).filter((m) => m === 'lab.get')).toHaveLength(1)
    await open(1280)
    expect((await calledMethods()).filter((m) => m === 'lab.get')).toHaveLength(1)
  })

  it('I-6 附加纸面运行：只列纸面 + 运行 + 同策略的实例（后 6 位）→ 附加 → lab.attach 形状照契约 → 关卡并重读；没有候选只一行；已退役禁用', async () => {
    await open(1440)
    await clickAt('[data-act="attach"]')
    await waitFor(`document.querySelectorAll('.lab-apop .lab-aopt').length === 1`, 3000)
    expect(await text('.lab-apop .lab-aopt')).toBe('paper-1…a1b2c3')
    expect(await cdp!.evaluate(`document.querySelector('.lab-apop .lab-aopt').getAttribute('aria-checked')`)).toBe('true')
    await shot('lab-detail-attach.png')
    const before = Number(await cdp!.evaluate(`window.__calls.filter((c) => c.method === 'lab.get').length`))
    await clickAt('.lab-apop [data-act="attach-go"]')
    await waitFor(`!document.querySelector('.lab-apop')`, 3000)
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.command).map((c) => c.method + ' ' + JSON.stringify(c.params))`)).toEqual([
      'lab.attach {"experimentId":"EXP-0014","attach":{"run":{"accountId":"acct_paper1","executor":{"kind":"engine","engineId":"ts-builtin","instanceId":"inst_01JBPAPERGRID0000a1b2c3"}}}}',
    ])
    await waitFor(`window.__calls.filter((c) => c.method === 'lab.get').length > ${before}`, 3000)

    await open(1440, { strategies: 'none' })
    await clickAt('[data-act="attach"]')
    await waitFor(`!!document.querySelector('.lab-apop [data-empty]')`, 3000)
    expect(await text('.lab-apop .lab-pb')).toContain('没有可附加的实例')
    expect(await cdp!.evaluate(`document.querySelector('.lab-apop [data-act="attach-go"]').disabled`)).toBe(true)

    await open(1440, { state: 'retired' })
    expect(await cdp!.evaluate(`document.querySelector('[data-act="attach"]').disabled`)).toBe(true)
  }, 60_000)

  it('I-6 出证据包（未冻结、无窗口）：两个日期时间输入，起 ≥ 止不可点；填合法 → lab.pack 带 holdoutWindow（本机时区毫秒）', async () => {
    await open(1440, { state: 'unfrozen' })
    await clickAt('[data-act="pack"]')
    await waitFor(`document.querySelectorAll('.lab-apop input[type="datetime-local"]').length === 2`, 3000)
    expect(await text('.lab-apop .g5-armed .g5-what')).toBe('出包后冻结假设、策略与留出窗口')
    const fill = (a: string, b: string) => cdp!.evaluate(`(() => { const [x, y] = document.querySelectorAll('.lab-apop input[type="datetime-local"]'); for (const [el, v] of [[x, ${JSON.stringify(a)}], [y, ${JSON.stringify(b)}]]) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) } return true })()`)
    const goDisabled = () => cdp!.evaluate(`document.querySelector('.lab-apop [data-act="pack-go"]').disabled`)
    expect(await goDisabled()).toBe(true)
    await fill('2026-09-30T00:00', '2026-09-01T00:00')
    await sleep(50)
    expect(await goDisabled()).toBe(true)
    await fill('2026-09-01T00:00', '2026-09-30T00:00')
    await sleep(50)
    expect(await goDisabled()).toBe(false)
    await shot('lab-detail-pack-window.png')
    await sleep(650)
    await clickAt('.lab-apop [data-act="pack-go"]')
    await waitFor(`window.__calls.some((c) => c.method === 'lab.pack')`, 3000)
    const sent = await cdp!.evaluate(`window.__calls.find((c) => c.method === 'lab.pack').params`)
    expect(sent).toEqual({ experimentId: 'EXP-0014', runId: 'run_bt_7', holdoutWindow: { from: Number(await cdp!.evaluate('new Date(2026, 8, 1).getTime()')), to: Number(await cdp!.evaluate('new Date(2026, 8, 30).getTime()')) } })
    await waitFor(`!document.querySelector('.lab-apop')`, 3000)
  }, 60_000)

  it('I-6 出证据包（已冻结）：无输入、后果一行；内核回 1013 → 原文留在弹出卡、卡不关；已出过包的那次禁用并写原因', async () => {
    await open(1440, { command: 'pack1013' })
    await clickAt('[data-act="pack"]')
    await waitFor(`!!document.querySelector('.lab-apop [data-act="pack-go"]')`, 3000)
    expect(await count('.lab-apop input')).toBe(0)
    expect(await text('.lab-apop .g5-armed .g5-what')).toBe('出包后该运行不可重出')
    await clickAt('.lab-apop [data-act="pack-go"]') // 600 ms 内：不算
    await sleep(100)
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.command).length`)).toBe(0)
    await sleep(650)
    await clickAt('.lab-apop [data-act="pack-go"]')
    await waitFor(`!!document.querySelector('.lab-apop .lab-deny')`, 3000)
    expect(await text('.lab-apop .lab-deny')).toContain('A recorded run intersects the proposed holdout window')
    expect(await count('.lab-apop')).toBe(1)
    expect(await cdp!.evaluate(`window.__calls.find((c) => c.method === 'lab.pack').params`)).toEqual({ experimentId: 'EXP-0014', runId: 'run_bt_7' })
    await shot('lab-detail-pack-denied.png')

    await open(1440, { state: 'packed' })
    expect(await cdp!.evaluate(`[document.querySelector('[data-act="pack"]').disabled, document.querySelector('[data-act="pack"]').title]`)).toEqual([true, '这次运行已出过证据包'])
  }, 60_000)

  it('导出证据包：问内核 lab.export 并存成 <编号>-evidence.json', async () => {
    await open(1440)
    await clickAt('[data-act="export"]')
    await waitFor(`window.__downloads.length === 1`, 3000)
    expect(await cdp!.evaluate(`window.__downloads[0]`)).toBe('EXP-0014-evidence.json')
    expect(await cdp!.evaluate(`window.__calls.filter((c) => c.method === 'lab.export').map((c) => JSON.stringify(c.params)).join()`)).toBe('{"experimentId":"EXP-0014"}')
  })

  it('四态 + 未接通：加载 / 空 / 错误（内核原文）/ 离线 / 未接通，各一张截图', async () => {
    await open(1440, { state: 'loading' })
    expect(await count('[data-g5-page="lab-detail"][aria-busy="true"]')).toBe(7)
    expect(await count('[data-g5-page="lab-detail"] .g5-sk')).toBeGreaterThan(20)
    expect(await count('[data-g5-page="lab-detail"] svg path.g5-eq-line')).toBe(0) // 只画坐标框，不画假曲线
    await shot('lab-detail-state-loading.png')

    await open(1440, { state: 'empty' })
    expect(await text('[data-tier="forward"] .lab-msg')).toBe('前向 0 天')
    expect(await text('[data-tier="holdout"] .lab-msg')).toBe('未设保留期')
    expect(await text('[data-tier="backtest"] .lab-msg')).toBe('没有回测记录')
    expect(await text('[data-view="assumptions"] .lab-msg')).toBe('没有记录回测假设')
    expect(await text('[data-view="data"] .lab-xh')).toBe('注记0')
    expect(await text('[data-view="head"] .lab-ttl')).toBe('资金费套利 ETH 8h')
    expect(await text('[data-view="head"] .lab-ladder [aria-current="step"]')).toBe('假设')
    await shot('lab-detail-state-empty.png')

    await open(1440, { state: 'error' })
    for (const sel of ['[data-view="head"]', '[data-tier="forward"]', '[data-tier="holdout"]', '[data-tier="backtest"]', '[data-view="assumptions"]', '[data-view="bias"]', '[data-view="data"]'])
      expect(await text(sel), sel).toContain('The local fixture cannot provide this view.')
    expect(await text('[data-tier="forward"] .lab-msg')).toBe('读取失败The local fixture cannot provide this view.重试')
    await shot('lab-detail-state-error.png')
    await open(1440, { state: 'okfalse' })
    expect(await text('[data-tier="backtest"] .lab-msg .g5-msg')).toBe('The local fixture cannot provide this view.')
    await open(1440, { state: 'runerror' })
    expect(await text('[data-tier="backtest"] .lab-msg')).toBe('读取失败Completed result for this experiment run is unavailable重试')
    expect(await text('[data-tier="holdout"] .lab-msg')).toContain('Completed result for this experiment run is unavailable')
    expect(await text('[data-tier="forward"] .lab-ret')).toBe('+0.46%')
    await shot('lab-detail-state-run-error.png')

    await open(1440, { state: 'offline' })
    expect(await count('[data-g5-page="lab-detail"].g5-off[data-state="offline"]')).toBeGreaterThanOrEqual(6)
    expect(await text('[data-tier="forward"] [data-stale="paused"]')).toMatch(/^已暂停更新 · \d\d:\d\d$/)
    expect(await cdp!.evaluate(`document.querySelector('[data-act="promote"]').disabled`)).toBe(true)
    expect(await cdp!.evaluate(`document.querySelector('[data-act="export"]').disabled`)).toBe(true)
    expect(await cdp!.evaluate(`document.querySelector('[data-tier="forward"] .lab-ret').className`)).toContain('g5-t3') // 离线去涨跌色：三口径的区间收益都是三级灰
    // 离线去涨跌色：前向的线 / 末点不再带 up / down 类，颜色与保留期同为三级灰
    expect(await count('[data-tier="forward"] .g5-up, [data-tier="forward"] .g5-down')).toBe(0)
    expect(await cdp!.evaluate(`['.g5-eq-line', '.g5-end'].map((sel) => ['forward', 'holdout'].map((t) => { const s = getComputedStyle(document.querySelector('[data-tier="' + t + '"] ' + sel)); return sel === '.g5-end' ? s.backgroundColor : s.stroke }))`)).toSatisfy((v: string[][]) => v.every((pair) => pair[0] === pair[1]))
    await shot('lab-detail-state-offline.png')

    await open(1440, { state: 'unwired' })
    expect(await count('[data-g5-page="lab-detail"] [data-wire="off"]')).toBe(7)
    expect(await text('[data-tier="holdout"] .lab-msg')).toBe('未接通unknown operation lab.get')
    expect(await count('[data-g5-page="lab-detail"] [data-act="retry"]')).toBe(0)
    await shot('lab-detail-state-unwired.png')
    await open(1440, { state: 'shape' })
    expect(await text('[data-tier="holdout"] .lab-msg')).toBe('未接通lab.get 回包缺少 experimentId')
    expect(cdp!.errors).toEqual([])
  })

  it('源码：首行 SPDX、零颜色字面量、无全圆胶囊、无本机路径 / 邮箱 / 密钥', () => {
    const files = [
      'src/pages/lab-detail.tsx', 'src/views/lab-detail.css', 'src/model-lab.ts', 'fixtures/lab-detail.ts',
      'src/views/lab-detail/index.tsx', 'src/views/lab-detail/data.tsx', 'src/views/lab-detail/parts.tsx', 'src/views/lab-detail/head.tsx', 'src/views/lab-detail/tier.tsx', 'src/views/lab-detail/side.tsx',
    ]
    for (const file of files) {
      const src = readFileSync(join(pkg, file), 'utf8')
      expect(src.split(/\r?\n/, 1)[0], file).toContain('SPDX-License-Identifier: CPAL-1.0')
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![-\w])/)
      expect(src, file).not.toMatch(/\b(rgba?|hsla?|oklch|oklab)\(/)
      expect(src, file).not.toMatch(/9999px|border-radius:\s*50%|border-radius:\s*100%/)
      expect(src, file).not.toMatch(/[A-Za-z]:[\\/]|@[\w-]+\.(com|cn|io)|api[_-]?key|secret/i)
    }
    const css = readFileSync(join(pkg, 'src/views/lab-detail.css'), 'utf8')
    for (const decl of css.match(/(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|box-shadow)\s*:[^;}]+/g) ?? []) {
      if (/#|rgb|hsl/.test(decl)) throw new Error(`颜色字面量：${decl}`)
    }
  })
})

// ---- 晋级 PIN 旅程（真 PIN 层）---------------------------------------------------------------------------------------------------------------
// 与 settings-r5.browser.test.ts 同法：真 KernelClient 连夹具内核，经 createHostBridge 校验清单；壳的 PIN 层 = KernelClient 的 attestor
// （内核回 ATTESTATION_REQUIRED → 客户端调 attestor 取证 → 带证明重发；attestor 返回 null = 用户在 PIN 层点了取消）。

const PIN = '246810'
const PIN_ENTRY = `
import { h, render } from 'preact'
import { KernelClient, LinkHub, createHostBridge } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import '@gitrader/workbench/ui'
import { labBlocks } from './src/pages/lab'
import { LabDetailStub } from './src/pages/lab-detail'
const w = window
const H = w.__H
;(async () => {
  const boot = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: H.boot }) }).then((r) => r.json())
  const client = new KernelClient({ url: H.ws, getToken: () => boot.sessionToken, WebSocketCtor: WebSocket, reconnect: false })
  await client.connect()
  w.__attest = { mode: 'pin', calls: 0 }
  client.setAttestor(async () => { w.__attest.calls += 1; return w.__attest.mode === 'cancel' ? null : { method: 'pin', pin: H.pin } })
  const block = labBlocks[0]
  const bridge = createHostBridge({ manifest: block.manifest, kernel: client, hub: new LinkHub({ A: {} }), instanceId: 'bi_lab_head', trusted: true, isUserActive: () => true })
  const root = document.getElementById('root')
  root.style.cssText = 'position:absolute;display:flex;flex-direction:column;left:16px;top:140px;width:1248px'
  render(h(BridgeContext.Provider, { value: bridge }, h(LabDetailStub, { config: { view: 'head', experimentId: 'EXP-0014' } })), root)
  w.document.documentElement.setAttribute('data-ready', '1')
})()
`

describe('实验详情 · 晋级经真 PIN 层（真 KernelClient + 夹具内核）', () => {
  let kernel: Awaited<ReturnType<typeof startStage>>['kernel'] | undefined
  const rig = async () => {
    await kernel?.close().catch(() => undefined)
    const stateDir = mkdtempSync(join(dir, 'pin-'))
    const staticDir = join(stateDir, 'static')
    mkdirSync(staticDir)
    const result = await build({
      stdin: { contents: PIN_ENTRY, resolveDir: pkg, loader: 'tsx', sourcefile: 'lab-detail-pin.tsx' },
      outfile: join(staticDir, 'app.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022',
      jsx: 'automatic', jsxImportSource: 'preact', loader: { '.js': 'jsx', '.woff2': 'file' }, assetNames: 'fonts/[name]',
      alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, plugins: [svgText as never],
      define: { __GITRADER_VERSION__: '"p8-pin"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', legalComments: 'none',
    })
    expect(result.errors).toHaveLength(0)
    const stage = await startStage({ staticDir, workspacesDir: join(stateDir, 'workspaces'), scenario: 'lab-detail-normal' })
    kernel = stage.kernel
    kernel.onCommand('lab.stage', (_p, ctx) => {
      const att = ctx.attestation as { method?: string; pin?: string } | undefined
      if (!att) throw problem('ATTESTATION_REQUIRED', 2010, 'This change requires presence proof')
      if (att.method !== 'pin' || att.pin !== PIN) throw problem('AUTH_FAILED', 5003, 'invalid PIN')
      return { experimentId: 'EXP-0014', stage: 'live_small' }
    })
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html lang="zh-CN" data-ui="r5"><head><meta charset="utf-8"><title>lab-detail-pin</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="h.js"></script><script src="app.js"></script></body></html>')
    writeFileSync(join(staticDir, 'h.js'), `window.__H=${JSON.stringify({ boot: kernel.bootstrapToken, ws: kernel.wsUrl, pin: PIN })}`)
    if (cdp) await cdp!.close()
    cdp = await launchCdp({ width: 1440, height: 900 })
    cdps.push(cdp)
    await cdp.navigate(`${kernel.url}/`)
    await waitFor(`document.documentElement.hasAttribute('data-ready') && !!document.querySelector('[data-act="promote"]') && !document.querySelector('[data-g5-page][aria-busy]')`, 15_000)
    await sleep(300)
  }
  const commands = () => kernel!.commands.filter((c) => c.action === 'lab.stage')
  const armed = async () => {
    await clickAt('[data-act="promote"]')
    await waitFor(`!!document.querySelector('.lab-apop')`, 3000)
    await sleep(400)
    await clickAt('.lab-apop [data-act="promote-go"]')
    await waitFor(`!!document.querySelector('.lab-apop [data-act="promote-confirm"]')`, 2000)
    await sleep(700)
  }
  afterAll(async () => { await kernel?.close().catch(() => undefined) })

  it('PIN 层弹出 → 输入 PIN：第一次不带证明被内核要求在场证明，客户端取证后重发，带 pin 证明；成功后弹出卡关、头卡重读', async () => {
    await rig()
    expect(await cdp!.evaluate('window.__attest.calls')).toBe(0)
    await armed()
    const gets = () => kernel!.queries.filter((q) => q.method === 'lab.get').length
    const before = gets()
    expect(commands()).toHaveLength(0) // 确认前没有命令、没弹 PIN 层
    expect(await cdp!.evaluate('window.__attest.calls')).toBe(0)
    await clickAt('.lab-apop [data-act="promote-confirm"]')
    await waitFor(`!document.querySelector('.lab-apop')`, 6000)
    expect(commands()).toHaveLength(2)
    expect(commands()[0]!.attestation).toBeUndefined()
    expect(commands()[1]!.attestation).toMatchObject({ method: 'pin', pin: PIN })
    for (const c of commands()) expect(c.params).toEqual({ experimentId: 'EXP-0014', to: 'live_small' })
    expect(await cdp!.evaluate('window.__attest.calls')).toBe(1)
    for (let i = 0; i < 50 && gets() <= before; i += 1) await sleep(100)
    expect(gets()).toBeGreaterThan(before)
  }, 90_000)

  it('PIN 层点取消：命令没发生（只有那次被拒的不带证明请求），弹出卡留在确认条、无报错、阶梯不变', async () => {
    await rig()
    await cdp!.evaluate(`window.__attest.mode = 'cancel'`)
    await armed()
    await clickAt('.lab-apop [data-act="promote-confirm"]')
    for (let i = 0; i < 50 && Number(await cdp!.evaluate('window.__attest.calls')) < 1; i += 1) await sleep(100)
    expect(await cdp!.evaluate('window.__attest.calls')).toBe(1)
    await waitFor(`document.querySelector('.lab-apop [data-act="promote-confirm"]')?.textContent === '确认晋级' && !document.querySelector('.lab-apop [data-act="promote-confirm"]').disabled`, 4000)
    expect(commands()).toHaveLength(1)
    expect(commands().every((c) => c.attestation === undefined)).toBe(true)
    expect(await count('.lab-apop .lab-deny')).toBe(0)
    expect(await count('.lab-apop [data-act="promote-back"]')).toBe(1)
    expect(await text('[data-view="head"] .lab-ladder [aria-current="step"]')).toBe('影子')
  }, 90_000)
})
