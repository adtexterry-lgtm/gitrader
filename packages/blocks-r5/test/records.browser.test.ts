// SPDX-License-Identifier: CPAL-1.0
// 记录页真浏览器用例：CDP 直连本机 Edge（无头），舞台 = 夹具内核 + 真桥（createHostBridge，清单权限照常校验）+ 真块。
// 挂块的临时办法只在本文件里（harness 源码内联、构建到 GITRADER_HOME 临时目录），不进 src/。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startStage } from '../verify/stage-entry'
import { launchCdp } from './helpers/cdp'
import { ACCT_LIVE, ACCT_PAPER, bigSet, designSet, installRecordsHandlers, type RecordsSet } from '../fixtures/records'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const repo = resolve(pkg, '../..')
const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
// 截图目录：GITRADER_SHOTS_DIR 指定；缺省写系统临时目录，不覆盖回报里的证据截图
const shots = process.env.GITRADER_SHOTS_DIR ? resolve(process.env.GITRADER_SHOTS_DIR) : mkdtempSync(join(tmpdir(), 'p3-shots-'))
const written = new Set<string>()
const design = pathToFileURL(join(repo, 'reports/visual-r5/records/index.html')).href
const WIDTHS = [1280, 1440, 1920] as const
const anchorsFile = join(here, 'geo-anchors/records.json')
const EXTRA = Object.fromEntries((JSON.parse(readFileSync(anchorsFile, 'utf8')) as Array<{ anchor: string; tolerance?: number; reason?: string }>).filter((r) => r.tolerance !== undefined).map((r) => [r.anchor, { tolerance: r.tolerance, reason: r.reason }]))
const tolOf = (anchor: string): number => EXTRA[anchor]?.tolerance ?? 4 // 条目级 tolerance（带 reason）优先于全局 4
const ANCHORS = ['records.card', 'records.head', 'records.fbar', 'records.thead', 'records.grp1', 'records.row1'] as const
const STATIC_SEL: Record<(typeof ANCHORS)[number], string> = {
  'records.card': '#rec', 'records.head': '#rec > .hd', 'records.fbar': '#rec .fbar', 'records.thead': '#rec [data-panel="fills"] thead',
  'records.grp1': '#rec [data-panel="fills"] tr.grp', 'records.row1': '#rec [data-panel="fills"] tr.row',
}
type Rect = { x: number; y: number; w: number; h: number }

const harness = `
import { render, h } from 'preact'
import { createHostBridge, KernelClient, LinkHub } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { ToastHost } from '@gitrader/workbench/ui'
import { recordsBlocks } from './src/pages/records'
const def = recordsBlocks[0]
const root = document.getElementById('root')
let client
let hub
window.__ready = (async () => {
  const q = new URLSearchParams(location.search)
  const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: q.get('boot') }) })
  const session = await r.json()
  client = new KernelClient({ url: q.get('ws'), getToken: () => session.sessionToken, WebSocketCtor: WebSocket, reconnect: false })
  await client.connect()
  return true
})()
window.__mount = (opts) => {
  hub = new LinkHub({ A: opts.links || {} })
  window.__hub = hub
  const bridge = createHostBridge({ manifest: def.manifest, instanceId: 'rec1', kernel: client, hub, trusted: true })
  const f = document.getElementById('frame')
  Object.assign(f.style, { left: opts.rect.x + 'px', top: opts.rect.y + 'px', width: opts.rect.w + 'px', height: opts.rect.h + 'px' })
  render(h(BridgeContext.Provider, { value: bridge }, h(def.component, { config: opts.config || {}, bridge, instanceId: 'rec1', setConfig() {}, channel: 'A', grid: { w: 1, h: 1 }, mode: 'tile' }), h(ToastHost, {})), root)
}
window.__unmount = () => render(null, root)
`

let run = ''
let staticDir = ''
let stageSeq = 0
const owned: Array<{ close(): Promise<void> }> = []

beforeAll(async () => {
  run = mkdtempSync(join(home, 'p3-run-'))
  if (!resolve(run).startsWith(resolve(home) + sep)) throw new Error('run dir escaped GITRADER_HOME')
  staticDir = join(run, 'static')
  mkdirSync(staticDir, { recursive: true })
  await build({
    stdin: { contents: harness, resolveDir: pkg, loader: 'tsx', sourcefile: 'p3-harness.tsx' },
    outfile: join(staticDir, 'p3-records.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
    loader: { '.js': 'jsx', '.woff2': 'file' }, assetNames: 'fonts/[name]', alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
    define: { __GITRADER_VERSION__: '"p3"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    plugins: [{
      name: 'svg-text',
      setup(b) {
        b.onLoad({ filter: /\.svg$/ }, async (a) => {
          const raw = await readFile(a.path, 'utf8')
          const text = /[\\/]assets[\\/]brand[\\/]/.test(a.path) ? raw : raw.replace(/fill="#FFFFFF"/gi, 'fill="currentColor"').trim()
          return { contents: `export default ${JSON.stringify(text)}`, loader: 'js' }
        })
      },
    }],
  })
  writeFileSync(join(staticDir, 'p3-records.html'), '<!doctype html><html lang="zh-CN" data-ui="r5" data-updown="intl"><head><meta charset="utf-8"><title>p3</title><link rel="stylesheet" href="/p3-records.css"></head><body style="margin:0"><div id="frame" style="position:absolute;display:flex;flex-direction:column"><div id="root" style="display:flex;flex-direction:column;flex:1 1 0;min-height:0"></div></div><script src="/p3-records.js"></script></body></html>')
  mkdirSync(shots, { recursive: true })
}, 120_000)

afterAll(async () => {
  for (const o of owned.splice(0).reverse()) { try { await o.close() } catch { /* 已关 */ } }
  if (run && resolve(run).startsWith(resolve(home) + sep)) rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}, 60_000)

// ---- 工具 ---------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
type Cdp = Awaited<ReturnType<typeof launchCdp>>
type Stage = Awaited<ReturnType<typeof startStage>>

async function waitFor(cdp: Cdp, expr: string, what: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await cdp.evaluate(expr)) return; await sleep(80) }
  throw new Error(`timeout: ${what}`)
}

/** 静态稿同宽下的矩形（卡片 + 各锚点）与「过滤」后的探针结果。 */
async function staticRects(cdp: Cdp): Promise<Record<string, Rect>> {
  await cdp.navigate(design)
  await waitFor(cdp, 'document.readyState==="complete" && !!document.querySelector("#rec")', 'static design')
  await sleep(300)
  if (process.env.P3_DEBUG) console.log('STATIC_SCROLLER', JSON.stringify(await cdp.evaluate(`(() => { const s = document.querySelector('#rec .tw.scroll'); return [s.offsetWidth, s.clientWidth, s.scrollHeight, s.clientHeight, getComputedStyle(s).scrollbarWidth, getComputedStyle(s, '::-webkit-scrollbar').width] })()`)))
  const out = await cdp.evaluate(`(() => { const sel = ${JSON.stringify(STATIC_SEL)}; const o = {}; for (const k in sel) { const r = document.querySelector(sel[k]).getBoundingClientRect(); o[k] = { x: r.x, y: r.y, w: r.width, h: r.height } } return o })()`)
  return out as Record<string, Rect>
}

interface Opts { width: number; scenario?: string; set?: RecordsSet | null; links?: Record<string, unknown>; config?: Record<string, unknown>; hash?: string }
interface Page { cdp: Cdp; stage: Stage; log: ReturnType<typeof installRecordsHandlers> | undefined; rects: Record<string, Rect>; errors: () => string[] }

/** 起舞台 + 浏览器 + 挂块。set = 装 parametric 处理器的数据集；缺省不装（用场景自带的夹具 / 失败注入）。 */
async function open(o: Opts): Promise<Page> {
  stageSeq += 1
  const stage = await startStage({ staticDir, workspacesDir: join(run, `ws-${stageSeq}`), scenario: o.scenario ?? 'records-normal' })
  owned.push({ close: () => stage.kernel.close() })
  const log = o.set === null ? undefined : installRecordsHandlers(stage.kernel, o.set ?? designSet())
  const cdp = await launchCdp({ width: o.width, height: 900 })
  owned.push({ close: () => cdp.close() })
  const rects = await staticRects(cdp)
  await cdp.navigate(`${stage.kernel.url}/p3-records.html?boot=${encodeURIComponent(stage.kernel.bootstrapToken)}&ws=${encodeURIComponent(stage.kernel.wsUrl)}`)
  await cdp.evaluate('window.__ready')
  if (o.hash) await cdp.evaluate(`history.replaceState(null, '', ${JSON.stringify(o.hash)})`)
  await cdp.evaluate(`window.__mount(${JSON.stringify({ rect: rects['records.card'], links: o.links ?? {}, config: o.config ?? {} })})`)
  return { cdp, stage, log, rects, errors: () => cdp.errors }
}

const q = (cdp: Cdp, expr: string) => cdp.evaluate(`(() => { ${expr} })()`)
const rectOf = (cdp: Cdp, sel: string) => cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`) as Promise<Rect | null>
/** 真鼠标点击（CDP Input）：命令桥要求瞬时用户激活，element.click() 不算；Radix 菜单也只认真指针事件。 */
async function clickSel(cdp: Cdp, sel: string): Promise<void> {
  await cdp.evaluate(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'nearest' })`)
  const r = await rectOf(cdp, sel)
  if (!r) throw new Error(`click target missing: ${sel}`)
  const x = r.x + r.w / 2
  const y = r.y + r.h / 2
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
async function waitRows(p: Page, n = 1): Promise<void> {
  await waitFor(p.cdp, `document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length >= ${n}`, `rows >= ${n}`)
  await sleep(120)
}
/** 滚到底续读，直到行数到齐。 */
async function loadAll(p: Page, n: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const c = await p.cdp.evaluate(`document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length`) as number
    if (c >= n) break
    await q(p.cdp, `const s = document.querySelector('.g5-tw.g5-scroll'); s.scrollTop = s.scrollHeight`)
    await sleep(150)
  }
  await waitFor(p.cdp, `document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length === ${n}`, `rows === ${n}`)
  await q(p.cdp, `document.querySelector('.g5-tw.g5-scroll').scrollTop = 0`)
}
async function shot(p: Page, name: string): Promise<void> {
  const file = join(shots, name)
  writeFileSync(file, await p.cdp.screenshot())
  written.add(file)
}

/** 把 visual-r5 的几何自检（check.js）移植到产品页：选择器换成 data-g5 / g5- 钩子，去掉 ?check 门，结果落 window.__geomOut。临时代码只在这里，不进产品树。 */
const probeSource = (): string => {
  let s = readFileSync(join(repo, 'reports/visual-r5/src/check.js'), 'utf8')
  const must = (re: RegExp, to: string) => { if (!re.test(s)) throw new Error(`probe pattern missing: ${re}`); s = s.replace(re, to) }
  must(/if\(!\/\[\?&\]check\/\.test\(location\.search\)\) return;/, '')
  must(/\.card,\.float/g, '[data-g5="card"],[data-g5="float"]')
  must(/\.frame \.card/g, '[data-g5="card"]')
  must(/closest\('\.card'\)/g, `closest('[data-g5="card"]')`)
  must(/querySelectorAll\('\.al'\)/g, `querySelectorAll('.g5-al')`)
  must(/\.venue,\.mk,\.alogo,\.sw,\.cb i,\.ptag,\.readout,\.fuse/g, '.g5-venue,.g5-mk,.g5-alogo,.g5-sw,.g5-ptag,.g5-readout,.g5-fuse')
  must(/var s=document\.createElement\('script'\);s\.type='application\/json';s\.id='geom-out';s\.textContent=JSON\.stringify\(out\);document\.body\.appendChild\(s\);\s*console\.log\('GEOM '\+JSON\.stringify\(out\)\);/, 'window.__geomOut=out;')
  must(/\(document\.fonts\?document\.fonts\.ready:Promise\.resolve\(\)\)\.then\(function\(\)\{setTimeout\(run,1200\);\}\);/, 'window.__runGeom=function(){return (document.fonts?document.fonts.ready:Promise.resolve()).then(function(){run();return window.__geomOut;});};')
  return s
}
const ZERO_KEYS = ['overflow', 'truncated', 'halfRows', 'escape', 'overlap', 'badFont', 'badSpace', 'align', 'numcol'] as const
async function geometry(p: Page): Promise<Record<string, unknown>> {
  await p.cdp.evaluate(`(() => { ${probeSource()} })()`)
  return await p.cdp.evaluate('window.__runGeom()') as Record<string, unknown>
}
const counts = (g: Record<string, unknown>) => Object.fromEntries([...ZERO_KEYS.map((k) => [k, (g[k] as unknown[]).length]), ['docScrollX', g.docScrollX]])

// ---- 用例 ---------------------------------------------------------------------------------

describe('记录 · 三宽度几何与锚点', () => {
  const measured: Record<string, Record<string, { static: Rect; product: Rect }>> = {}
  for (const width of WIDTHS) {
    it(`${width} × 900：几何探针全 0，锚点与稿差 ≤ 4 px`, async () => {
      const p = await open({ width })
      try {
        await waitRows(p, 15)
        // 与稿同态：第一行展开（T-0006 事件链）
        await clickSel(p.cdp, '[data-row] [data-x]')
        await waitFor(p.cdp, `!!document.querySelector('.g5-chain') && document.querySelector('.g5-chain').textContent.includes('成交')`, 'chain')
        await sleep(200)
        if (process.env.P3_DEBUG) console.log('SCROLLER', JSON.stringify(await p.cdp.evaluate(`(() => { const s = document.querySelector('.g5-tw.g5-scroll'); const r = s.getBoundingClientRect(); return [r.width, s.clientWidth, s.scrollHeight, s.clientHeight, getComputedStyle(s).overflowY, getComputedStyle(s, '::-webkit-scrollbar').width, getComputedStyle(s).scrollbarWidth, s.className, getComputedStyle(s).scrollbarColor] })()`)))
        const g = await geometry(p)
        await shot(p, `records-${width}.png`)
        const zero = counts(g)
        expect(zero, JSON.stringify({ overflow: g.overflow, truncated: g.truncated, halfRows: g.halfRows, escape: g.escape, overlap: g.overlap, badFont: g.badFont, badSpace: g.badSpace, align: g.align, numcol: g.numcol }).slice(0, 1500)).toEqual({ overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0, docScrollX: 0 })
        measured[width] = {}
        for (const a of ANCHORS) {
          const prod = await rectOf(p.cdp, `[data-geo="${a}"]`)
          expect(prod, `anchor ${a}`).not.toBeNull()
          const st = p.rects[a]!
          measured[width]![a] = { static: st, product: prod! }
          for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(prod![k] - st[k]), `${width} ${a}.${k} static=${st[k]} product=${prod![k]}`).toBeLessThanOrEqual(tolOf(a))
        }
        expect(p.errors().filter((e) => !/Failed to load resource/.test(e))).toEqual([])
        if (process.env.P3_WRITE_ANCHORS && Object.keys(measured).length === WIDTHS.length) {
          const out = ANCHORS.map((anchor) => ({ anchor, ...(EXTRA[anchor] ? { tolerance: EXTRA[anchor]!.tolerance, reason: EXTRA[anchor]!.reason } : {}), static: Object.fromEntries(WIDTHS.map((w) => [String(w), round(measured[w]![anchor]!.static)])), product: Object.fromEntries(WIDTHS.map((w) => [String(w), round(measured[w]![anchor]!.product)])) }))
          writeFileSync(anchorsFile, JSON.stringify(out, null, 2) + '\n')
        }
      } finally { await p.cdp.close(); await p.stage.kernel.close() }
    }, 90_000)
  }
  it('geo-anchors/records.json 登记的锚点齐全，登记的稿矩形与现稿一致', async () => {
    const reg = JSON.parse(readFileSync(anchorsFile, 'utf8')) as Array<{ anchor: string; static: Record<string, Rect>; product: Record<string, Rect> }>
    expect(reg.map((r) => r.anchor)).toEqual([...ANCHORS])
    const p = await open({ width: 1440, set: null, scenario: 'records-empty' })
    try {
      for (const r of reg) {
        const st = r.static['1440']!
        for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(st[k] - p.rects[r.anchor]![k])).toBeLessThanOrEqual(1)
        for (const w of WIDTHS) for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(r.product[String(w)]![k] - r.static[String(w)]![k]), `${w} ${r.anchor}.${k}`).toBeLessThanOrEqual(4)
      }
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)
})

const round = (r: Rect): Rect => ({ x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, w: Math.round(r.w * 100) / 100, h: Math.round(r.h * 100) / 100 })

describe('记录 · 行为', () => {
  it('滚到底续读：1200 笔不重复不丢行，续读游标不换筛选条件', async () => {
    const set = bigSet()
    const p = await open({ width: 1440, set })
    try {
      await waitRows(p, 20)
      for (let i = 0; i < 60; i += 1) {
        const n = await p.cdp.evaluate(`document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length`) as number
        if (n >= 1200) break
        await q(p.cdp, `const s = document.querySelector('.g5-tw.g5-scroll'); s.scrollTop = s.scrollHeight`)
        await sleep(150)
      }
      const ids = await p.cdp.evaluate(`[...document.querySelectorAll('[data-g5-page="records"] tr[data-row]')].map((r) => r.getAttribute('data-row'))`) as string[]
      expect(ids).toHaveLength(1200)
      expect(new Set(ids).size).toBe(1200)
      const fillQueries = p.stage.kernel.queries.filter((x) => x.method === 'records.query' && (x.params as { kind: string }).kind === 'fill') as Array<{ params: Record<string, unknown> }>
      expect(fillQueries).toHaveLength(12)
      expect(new Set(fillQueries.map((x) => x.params.sinceTs)).size).toBe(1)
      expect(fillQueries.slice(1).every((x) => typeof x.params.cursor === 'string')).toBe(true)
      expect(p.errors().filter((e) => !/Failed to load resource/.test(e))).toEqual([])
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 120_000)

  it('行展开事件链：意图 → 预检 → 待批 → 批准 → 提交 → 成交，经 ledger.trace 按订单号取', async () => {
    const p = await open({ width: 1440 })
    try {
      await waitRows(p, 15)
      await clickSel(p.cdp, '[data-row] [data-x]')
      await waitFor(p.cdp, `!!document.querySelector('.g5-chain .g5-nd')`, 'chain nodes')
      const text = await p.cdp.evaluate(`document.querySelector('.g5-chain').textContent`) as string
      for (const w of ['意图', '预检 需批准', '待批 T-0006', '批准', '提交', '成交']) expect(text).toContain(w)
      const trace = p.stage.kernel.queries.filter((x) => x.method === 'ledger.trace')
      expect(trace).toHaveLength(1)
      expect(trace[0]!.params).toEqual({ orderId: 'ord_00001' })
      expect(await p.cdp.evaluate(`document.querySelector('[data-row] [data-x]').getAttribute('aria-expanded')`)).toBe('true')
      await clickSel(p.cdp, '[data-row] [data-x]')
      await sleep(150)
      expect(await p.cdp.evaluate(`!!document.querySelector('.g5-chain')`)).toBe(false)
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)

  it('导出命令带时间范围：先按时间界取首条 seq，再发 ledger.export { fromSeq }', async () => {
    const p = await open({ width: 1440 })
    try {
      await waitRows(p, 15)
      // 选「1 天」
      await clickSel(p.cdp, '[data-filter="时间"]')
      await waitFor(p.cdp, `!!document.querySelector('[role="menuitemradio"][data-v="1d"]')`, 'time menu')
      await clickSel(p.cdp, '[role="menuitemradio"][data-v="1d"]')
      await waitFor(p.cdp, `document.querySelector('[data-filter="时间"]').textContent.includes('1 天')`, 'range chosen')
      await waitRows(p, 1)
      const before = p.stage.kernel.queries.length
      const t0 = Date.now()
      await clickSel(p.cdp, '[data-act="export"]')
      await waitFor(p.cdp, `document.body.textContent.includes('已导出')`, 'export toast')
      const exp = p.stage.kernel.commands.filter((c) => c.action === 'ledger.export')
      expect(exp).toHaveLength(1)
      const lq = p.stage.kernel.queries.slice(before).filter((x) => x.method === 'ledger.query')
      expect(lq).toHaveLength(1)
      const since = (lq[0]!.params as { sinceTs: number }).sinceTs
      expect(Math.abs(since - (t0 - 86_400_000))).toBeLessThan(5_000)
      expect((lq[0]!.params as { order: string }).order).toBe('asc')
      const first = designSet().ledger.concat(designSet().funding).filter((e) => (e.ts as number) >= since).sort((a, b) => (a.seq as number) - (b.seq as number))[0]!
      // fix-r4: C3 界面导出带 inline:true，回包里直接拿账单下载
      expect(exp[0]!.params).toEqual({ fromSeq: first.seq, inline: true })
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)

  it('从资金页带 account 进来自动筛；页内改筛选写回联动', async () => {
    const p = await open({ width: 1440, links: { account: ACCT_PAPER } })
    try {
      await waitRows(p, 5)
      const rows = await p.cdp.evaluate(`document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length`)
      expect(rows).toBe(5)
      const fq = p.stage.kernel.queries.filter((x) => x.method === 'records.query') as Array<{ params: Record<string, unknown> }>
      expect(fq.length).toBeGreaterThanOrEqual(3)
      expect(fq.every((x) => x.params.accountId === ACCT_PAPER)).toBe(true)
      expect(await p.cdp.evaluate(`document.querySelector('[data-filter="账户"]').textContent`)).toContain('paper-1')
      // 别页后来改了账户：自动重筛
      await p.cdp.evaluate(`window.__hub.set('A', 'account', ${JSON.stringify(ACCT_LIVE)})`)
      await waitFor(p.cdp, `document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length === 10`, 'refilter to live')
      // 页内选标的 → 写回 symbol 联动
      await clickSel(p.cdp, '[data-filter="标的"]')
      await waitFor(p.cdp, `!!document.querySelector('[role="menuitemradio"][data-v="hyperliquid:ETH"]')`, 'symbol menu')
      await clickSel(p.cdp, '[role="menuitemradio"][data-v="hyperliquid:ETH"]')
      await waitFor(p.cdp, `window.__hub.get('A', 'symbol') === 'hyperliquid:ETH'`, 'symbol linked')
      await waitFor(p.cdp, `[...document.querySelectorAll('[data-g5-page="records"] tr[data-row] .g5-sym')].every((e) => e.textContent === 'ETH') && document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length === 3`, 'eth rows')
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)

  it('红涨绿跌互换：只换 --gr-up / --gr-down，涨跌色不写死', async () => {
    const p = await open({ width: 1440 })
    try {
      await waitRows(p, 15)
      const read = `(() => { const up = document.querySelector('.g5-up'); const dn = document.querySelector('.g5-down'); return [getComputedStyle(up).color, getComputedStyle(dn).color] })()`
      const intl = await p.cdp.evaluate(read) as string[]
      await p.cdp.evaluate(`document.documentElement.setAttribute('data-updown', 'cn')`)
      await sleep(100)
      const cn = await p.cdp.evaluate(read) as string[]
      expect(intl[0]).not.toBe(intl[1])
      expect(cn).toEqual([intl[1], intl[0]])
      await shot(p, 'records-1440-cn.png')
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)

  it('离线：行保留、盈亏去涨跌色、筛选与导出禁用、卡头写已暂停更新', async () => {
    const p = await open({ width: 1440 })
    try {
      await waitRows(p, 15)
      const upColor = await p.cdp.evaluate(`getComputedStyle(document.querySelector('tr[data-row] .g5-up')).color`) as string
      await p.cdp.evaluate(`document.documentElement.setAttribute('data-offline', '')`)
      await waitFor(p.cdp, `document.querySelector('[data-state="offline"]') !== null`, 'offline wrapper')
      await sleep(150)
      expect(await p.cdp.evaluate(`document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length`)).toBe(15)
      expect(await p.cdp.evaluate(`document.querySelector('[data-act="export"]').disabled`)).toBe(true)
      expect(await p.cdp.evaluate(`[...document.querySelectorAll('.g5-fbar .g5-dd')].every((b) => b.disabled)`)).toBe(true)
      expect(await p.cdp.evaluate(`document.querySelector('[data-g5-page="records"] .g5-hd').textContent`)).toContain('已暂停更新')
      const off = await p.cdp.evaluate(`getComputedStyle(document.querySelector('tr[data-row] td.g5-n span[data-n="pnl"]')).color`) as string
      expect(off).not.toBe(upColor)
      await shot(p, 'records-offline.png')
      await p.cdp.evaluate(`document.documentElement.removeAttribute('data-offline')`)
      await waitFor(p.cdp, `document.querySelector('[data-state="offline"]') === null`, 'back online')
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)

  it('委托与资金费页签：已拦截带内核原文，资金费组小计与稿同数', async () => {
    const p = await open({ width: 1440 })
    try {
      await waitRows(p, 15)
      await clickSel(p.cdp, '[data-tab="orders"]')
      await waitFor(p.cdp, `document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length === 12`, 'orders rows')
      expect(await p.cdp.evaluate(`document.querySelector('[data-g5-page="records"] .g5-tw').textContent`)).toContain('单笔上限 8,000，实际 32,105')
      await shot(p, 'records-orders-1440.png')
      await clickSel(p.cdp, '[data-tab="funding"]')
      await loadAll(p, 122)
      const subs = await p.cdp.evaluate(`[...document.querySelectorAll('tr.g5-grp [data-n="fa"]')].map((e) => e.textContent)`) as string[]
      expect(subs).toEqual(['−3.85', '−0.17'])
      expect(await p.cdp.evaluate(`document.querySelector('[data-g5-page="records"] .g5-hd .g5-rd').textContent`)).toBe('资金费实盘−3.85纸面−0.17')
      await shot(p, 'records-funding-1440.png')
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)
})

describe('记录 · GQ-37 默认全部 / 导出口径 / 被拦', () => {
  const rowSyms = (p: Page) => p.cdp.evaluate(`[...document.querySelectorAll('[data-g5-page="records"] tr[data-row] .g5-sym')].map((e) => e.textContent)`) as Promise<string[]>
  it('联动里留着 BTC 直接进 #/records：不按 BTC 筛，成交是全量', async () => {
    const p = await open({ width: 1440, links: { symbol: 'hyperliquid:BTC' } })
    try {
      await waitRows(p, 15)
      expect(await p.cdp.evaluate(`document.querySelector('[data-filter="标的"]').textContent`)).toContain('全部')
      expect(new Set(await rowSyms(p)).size).toBeGreaterThan(1)
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)

  it('显式路由 #/records/hyperliquid:BTC 带筛选；清掉后路由回到 #/records；导出全部的命令不带标的、toast 明说含全部', async () => {
    const p = await open({ width: 1440, hash: '#/records/hyperliquid:BTC' })
    try {
      await waitFor(p.cdp, `document.querySelector('[data-filter="标的"]').textContent.includes('BTC')`, 'btc filter')
      await waitRows(p, 1)
      expect([...new Set(await rowSyms(p))]).toEqual(['BTC'])
      expect(await p.cdp.evaluate(`document.querySelector('[data-act="export"]').textContent`)).toBe('导出全部')
      await clickSel(p.cdp, '[data-act="export"]')
      await waitFor(p.cdp, `document.body.textContent.includes('含全部标的与账户')`, 'export toast')
      const exp = p.stage.kernel.commands.filter((c) => c.action === 'ledger.export')
      expect(exp).toHaveLength(1)
      expect(Object.keys(exp[0]!.params as object).sort()).toEqual(['fromSeq', 'inline'])
      await clickSel(p.cdp, '[data-filter="标的"]')
      await waitFor(p.cdp, `!!document.querySelector('[role="menuitemradio"][data-v="__all"]')`, 'symbol menu')
      await clickSel(p.cdp, '[role="menuitemradio"][data-v="__all"]')
      await waitFor(p.cdp, `location.hash === '#/records' && document.querySelector('[data-filter="标的"]').textContent.includes('全部')`, 'cleared')
      await waitRows(p, 15)
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)

  it('「被拦」页签：risk.denials 的拦截单逐条列出摘要与规则，计数一致', async () => {
    const p = await open({ width: 1440 })
    try {
      await waitRows(p, 15)
      expect(await p.cdp.evaluate(`[...document.querySelectorAll('[role=tab]')].map((t) => t.getAttribute('data-tab'))`)).toEqual(['fills', 'orders', 'funding', 'blocked'])
      await clickSel(p.cdp, '[data-tab="blocked"]')
      await waitFor(p.cdp, `document.querySelectorAll('[data-g5-page="records"] tr[data-row]').length === 2`, 'blocked rows')
      expect(await p.cdp.evaluate(`document.querySelector('[data-tab="blocked"] .g5-c').textContent`)).toBe('2')
      const t = await p.cdp.evaluate(`document.querySelector('[data-g5-page="records"] .g5-tw').textContent`) as string
      expect(t).toContain('订单被拦截')
      expect(await rowSyms(p)).toEqual(['ETH', 'BTC'])
      expect(p.stage.kernel.queries.some((x) => x.method === 'risk.denials')).toBe(true)
      await shot(p, 'records-blocked-1440.png')
    } finally { await p.cdp.close(); await p.stage.kernel.close() }
  }, 60_000)
})

describe('记录 · 四态与未接通', () => {
  const states: Array<{ state: string; check: (p: Page) => Promise<void> }> = [
    { state: 'loading', check: async (p) => { await waitFor(p.cdp, `document.querySelector('[data-g5-page="records"] .g5-sk') !== null`, 'skeleton') ; expect(await p.cdp.evaluate(`[...document.querySelectorAll('.g5-fbar .g5-dd')].every((b) => b.disabled)`)).toBe(true) } },
    { state: 'empty', check: async (p) => { await waitFor(p.cdp, `document.querySelector('[data-g5-page="records"]').textContent.includes('这段时间没有成交')`, 'empty text'); expect(await p.cdp.evaluate(`document.querySelector('[data-act="export"]').disabled`)).toBe(false) } },
    { state: 'error', check: async (p) => {
      await waitFor(p.cdp, `document.querySelector('[data-g5-page="records"] .g5-pstate') !== null`, 'error row')
      const t = await p.cdp.evaluate(`document.querySelector('.g5-pstate').textContent`) as string
      expect(t).toContain('读取失败')
      expect(t).toContain('The local fixture cannot provide this view.')
      expect(await p.cdp.evaluate(`document.querySelector('[data-wire="off"]')`)).toBeNull()
      expect(await p.cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => /重试/.test(b.textContent))`)).toBe(false)
    } },
    { state: 'unwired', check: async (p) => {
      await waitFor(p.cdp, `document.querySelector('[data-wire="off"]') !== null`, 'wire off')
      const t = await p.cdp.evaluate(`document.querySelector('.g5-pstate').textContent`) as string
      expect(t).toContain('未接通')
      expect(t).toContain('records.query')
      expect(await p.cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => /重试/.test(b.textContent))`)).toBe(false)
    } },
  ]
  for (const s of states) {
    it(`${s.state}：1440 截图，内核原文不改写，不给重试`, async () => {
      const p = await open({ width: 1440, scenario: `records-${s.state}`, set: s.state === 'loading' ? undefined : null })
      try {
        await s.check(p)
        await sleep(250)
        await shot(p, `records-${s.state}.png`)
        expect(p.errors().filter((e) => !/Failed to load resource|METHOD_NOT_FOUND|未知查询/.test(e))).toEqual([])
      } finally { await p.cdp.close(); await p.stage.kernel.close() }
    }, 60_000)
  }
  it('本次写出的截图都在、非空', () => {
    expect(written.size).toBeGreaterThanOrEqual(6)
    for (const f of written) expect(statSync(f).size, f).toBeGreaterThan(1000)
  })
})
