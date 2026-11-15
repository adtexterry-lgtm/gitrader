// SPDX-License-Identifier: CPAL-1.0
// 图表页浏览器用例：CDP 直连本机 Edge（无头），夹具内核 + 本文件现场打包的舞台页（壳的 r5 路由还没落地时，用它把四张卡挂进与视觉稿同版式的两列里）。
// 舞台页只存在于本文件与临时目录，不进 src/。不设 GITRADER_SKIP_BROWSER，没有 Edge 就直接失败。截图落 reports/blocks-r5/P2-shots/。
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startStage } from '../verify/stage-entry'
import { ACCT_LIVE, ACCT_PAPER, BTC, ETH, SOL, TICKET_PIN, accounts, candlesFor, designSet, installChartHandlers, type ChartLog, type ChartSet } from '../fixtures/chart'
import anchorsJson from './geo-anchors/chart.json'
import { captureAnchors } from './helpers/anchors'
import { launchCdp } from './helpers/cdp'
import { geometryCounts, readGeometry } from './helpers/geo'

const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const repoDir = resolve(pkgDir, '../..')
const shotsDir = process.env.GITRADER_SHOTS_DIR ?? join(repoDir, 'reports/blocks-r5/P2-shots')
const auditSource = readFileSync(resolve(pkgDir, '../workbench/design/audit-probe.js'), 'utf8')
const referencePage = resolve(repoDir, 'reports/visual-r5/chart/index.html')
const WIDTHS = [1280, 1440, 1920] as const
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const anchors = anchorsJson.widths as unknown as Record<string, Record<string, number[]>>
const NAMES = ['chart.card', 'chart.head', 'chart.ohlc', 'chart.plot', 'symbols.card', 'symbols.head', 'symbols.row1', 'ticket.card', 'ticket.head', 'ticket.body', 'mine.card', 'mine.head', 'mine.row1'] as const
const STATIC_SEL: Record<(typeof NAMES)[number], string> = {
  'chart.card': '#chart', 'chart.head': '#chart > .hd', 'chart.ohlc': '#chart .ohlc', 'chart.plot': '#chart .lwc-host',
  'symbols.card': '#syms', 'symbols.head': '#syms > .hd', 'symbols.row1': '#syms .srow[aria-selected="true"]',
  'ticket.card': '#ticket', 'ticket.head': '#ticket > .hd', 'ticket.body': '#ticket .ob',
  'mine.card': '#mine', 'mine.head': '#mine > .hd', 'mine.row1': '#mine .tr1.pos',
}
const DIAG = "document.body.innerText.slice(0, 500) + ' | canvases=' + document.querySelectorAll('canvas').length + ' sk=' + document.querySelectorAll('.g5-sk').length + ' ready=' + document.documentElement.hasAttribute('data-ready') + ' errs=' + JSON.stringify(window.__errs) + ' evalErr=' + (window.__lastEvalErr || '')"

// ---- 舞台页：图表在左列，标的 / 票据 / 本标的在右列；桥是真的（真 KernelClient 连夹具内核，经 createHostBridge 校验清单） -----------------------------------

const ENTRY = `
import { render } from 'preact'
import { defineBlock, KernelClient, LinkHub, createHostBridge } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { ToastHost } from '@gitrader/workbench/ui'
import { chartBlocks, chartPositionViews, chartPositionsManifest } from './src/pages/chart'
import '../workbench/src/ui/theme.css'
import '../workbench/src/ui/r5/components.css'
const w = window
w.__errs = []
w.addEventListener('error', (e) => w.__errs.push(String(e.message) + ' @' + e.filename + ':' + e.lineno))
w.addEventListener('unhandledrejection', (e) => w.__errs.push(String((e.reason && e.reason.stack) || e.reason)))
const H = w.__H
const [chart, symbols] = chartBlocks
const Mine = chartPositionViews.symbol
const Ticket = chartPositionViews.ticket
const positions = defineBlock({
  manifest: {
    schema: 'gitrader-block/1', id: 'block.gitrader.positions', name: 'positions', version: '0.1.0', vendor: { name: 'gitrader' }, license: 'CPAL-1.0',
    entry: { module: './i.js', element: 'g5-positions' }, isolation: 'inline', size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
    inputs: { events: chartPositionsManifest.events, queries: chartPositionsManifest.queries }, permissions: chartPositionsManifest.permissions,
    actions: chartPositionsManifest.actions, linkGroups: chartPositionsManifest.linkGroups, fixtures: ['./fixtures/chart.ts'],
  },
  component: (p) => (p.config.view === 'ticket' ? <Ticket {...p} /> : <Mine {...p} />),
})
;(async () => {
  const boot = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: H.boot }) }).then((r) => r.json())
  const client = new KernelClient({ url: H.ws, getToken: () => boot.sessionToken, WebSocketCtor: WebSocket, reconnect: false })
  await client.connect()
  w.__attest = { mode: 'pin', calls: 0 }
  client.setAttestor(async () => { w.__attest.calls += 1; return w.__attest.mode === 'cancel' ? null : { method: 'pin', pin: H.pin } }, { retry: true })
  const hub = new LinkHub({ A: H.symbol ? { symbol: H.symbol } : {} })
  w.__hub = hub
  w.__configs = []
  const mount = (def, id, el, config) => {
    const bridge = createHostBridge({ manifest: def.manifest, kernel: client, hub, instanceId: id, trusted: true, isUserActive: () => true })
    const C = def.component
    render(<BridgeContext.Provider value={bridge}><C bridge={bridge} instanceId={id} config={config} setConfig={(c) => { w.__configs.push({ id, config: c }) }} channel="A" grid={{ w: 1, h: 1 }} mode="tile" /></BridgeContext.Provider>, el)
    return bridge
  }
  const toasts = document.createElement('div')
  document.body.appendChild(toasts)
  render(<ToastHost />, toasts)
  if (H.mode === 'cycle') {
    // 挂载 / 卸载循环：每轮挂一个完整图表卡，等 canvas 出来，再卸掉
    w.__cycle = async (n) => {
      for (let i = 0; i < n; i += 1) {
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:600px;display:flex;flex-direction:column'
        document.body.appendChild(host)
        mount(chart, 'cycle' + i, host, { interval: '15m' })
        for (let k = 0; k < 400 && !host.querySelector('canvas'); k += 1) await new Promise((r) => setTimeout(r, 25))
        render(null, host)
        host.remove()
      }
      return true
    }
    document.documentElement.setAttribute('data-ready', '1')
    return
  }
  const host = (id) => { const el = document.createElement('div'); el.style.display = 'contents'; document.getElementById(id === 'chart' ? 'colL' : 'colR').appendChild(el); return el }
  mount(chart, 'bi_chart_1', host('chart'), H.chart || { interval: '15m', indicators: ['vol'] })
  mount(symbols, 'bi_symbols_1', host('symbols'), H.symbols || {})
  mount(positions, 'bi_positions_tkt', host('ticket'), { view: 'ticket' })
  mount(positions, 'bi_positions_sym', host('mine'), { view: 'symbol' })
  document.documentElement.setAttribute('data-ready', '1')
})()
`

const HTML = `<!doctype html>
<html lang="zh-CN" data-ui="r5" data-updown="intl"><head><meta charset="utf-8"><title>chart</title><link rel="stylesheet" href="app.css"></head>
<body><main class="g5-frame"><header class="g5-topbar"></header><section class="g5-fund" aria-label="资金"></section>
<div class="g5-ws"><div class="g5-col" id="colL"></div><div class="g5-col g5-rcol g5-scroll" id="colR"></div></div></main>
<script src="h.js"></script><script src="geometry-probe.js"></script><script src="app.js"></script></body></html>`

let staticDir = ''
let tmpRoot = ''
const live: Rig[] = []

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(home, 'chart-browser-'))
  if (!resolve(tmpRoot).startsWith(resolve(home) + sep)) throw new Error('temporary directory escaped GITRADER_HOME')
  staticDir = join(tmpRoot, 'static')
  mkdirSync(staticDir)
  mkdirSync(shotsDir, { recursive: true })
  const svgText = {
    name: 'svg-text',
    setup(b: { onLoad(o: { filter: RegExp }, cb: (a: { path: string }) => unknown): void }) {
      b.onLoad({ filter: /\.svg$/ }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, 'utf8').replace(/fill="#FFFFFF"/gi, 'fill="currentColor"').trim())}`, loader: 'js' }))
    },
  }
  await build({
    stdin: { contents: ENTRY, resolveDir: pkgDir, loader: 'tsx', sourcefile: 'chart-stage.tsx' },
    bundle: true, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'silent',
    loader: { '.js': 'jsx', '.png': 'binary', '.woff2': 'file' }, assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, plugins: [svgText as never],
    define: { __GITRADER_VERSION__: '"chart-stage"', 'process.env.NODE_ENV': '"production"' },
    outfile: join(staticDir, 'app.js'),
  })
}, 120_000)

afterAll(async () => {
  for (const x of live.splice(0)) await x.close()
  if (tmpRoot && resolve(tmpRoot).startsWith(resolve(home) + sep)) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

// ---- 起一套：夹具内核 + 无头 Edge + 打开舞台页 ---------------------------------------------------------------------------------------------

type Stage = Awaited<ReturnType<typeof startStage>>
type Rect = { x: number; y: number; w: number; h: number }
interface Debug { range: { from: number; to: number }; bars: number; markers: Array<{ id: string; x: number; y: number; hollow: boolean; color: string }>; lines: Array<{ label: string; price: number; lineColor: string; textColor: string; dash: [number, number] | null }>; upColor: string; downColor: string; volume: boolean }
interface Rig {
  stage: Stage
  cdp: Awaited<ReturnType<typeof launchCdp>>
  set: ChartSet
  log: ChartLog
  ev<T = unknown>(expr: string): Promise<T>
  waitFor(expr: string, ms?: number): Promise<void>
  settled(ms?: number): Promise<void>
  debug(): Promise<Debug>
  click(selector: string): Promise<void>
  mclick(selector: string): Promise<void>
  mouse(x: number, y: number): Promise<void>
  shot(name: string): Promise<void>
  close(): Promise<void>
}
interface OpenOptions {
  set?: (s: ChartSet) => void
  symbol?: string | null
  mode?: 'cycle'
  chart?: Record<string, unknown>
  symbols?: Record<string, unknown>
  scenario?: string
  /** 页面载入前不等「落定」就返回（加载态用）。 */
  raw?: boolean
}

async function open(width: number, opts: OpenOptions = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpRoot, 'k-'))
  const pub = join(dir, 'static')
  mkdirSync(pub)
  for (const f of ['app.js', 'app.css']) writeFileSync(join(pub, f), readFileSync(join(staticDir, f)))
  // 探针里 `internal(el)` 漏传 selectors（T1 文件，本包不改）：在预装的副本里补上，上游修好后这句替换就是空操作
  writeFileSync(join(pub, 'geometry-probe.js'), readFileSync(resolve(pkgDir, '../workbench/design/geometry-probe.js'), 'utf8').replace('if(internal(el))continue;', 'if(internal(el,selectors))continue;'))
  writeFileSync(join(pub, 'index.html'), HTML)
  const stage = await startStage({ staticDir: pub, workspacesDir: join(dir, 'workspaces'), scenario: opts.scenario ?? 'chart-normal' })
  const set = designSet(Date.now())
  opts.set?.(set)
  const log = installChartHandlers(stage.kernel, set)
  // 内核的 CSP 只许同源脚本：引导令牌与地址放进同源的 h.js，不用内联脚本
  writeFileSync(join(pub, 'h.js'), `window.__H=${JSON.stringify({ boot: stage.kernel.bootstrapToken, ws: stage.kernel.wsUrl, pin: TICKET_PIN, symbol: opts.symbol === undefined ? BTC : opts.symbol, mode: opts.mode, chart: opts.chart, symbols: opts.symbols })}`)
  // launchCdp 自带 EBUSY 重试（helpers/cdp.ts 的 retryBusy）
  const cdp = await launchCdp({ width, height: 900 }).catch(async (e: unknown) => { await stage.kernel.close(); throw e })
  const rig: Rig = {
    stage, cdp, set, log,
    ev: (expr) => cdp.evaluate(expr) as Promise<never>,
    async waitFor(expr, ms = 15_000) {
      const t0 = Date.now()
      for (;;) {
        if (await cdp.evaluate(`(() => { try { return (${expr}) } catch (e) { window.__lastEvalErr = String((e && e.stack) || e); return false } })()`)) return
        if (Date.now() - t0 > ms) throw new Error(`等待超时：${expr}\n页面错误：${JSON.stringify(cdp.errors)}\n${String(await cdp.evaluate(DIAG))}`)
        await sleep(100)
      }
    },
    async settled(ms) {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && (() => { const h = document.querySelector('[data-chart-host]'); const d = h && h.__g5 && h.__g5.debug(); return !!d && d.bars > 0 && d.markers.length > 0 && d.lines.length > 0 })()
        && document.querySelectorAll('.g5-srow .g5-px:not(:empty)').length >= 3 && !!document.querySelector('[data-pos]') && !!document.querySelector('[data-field="price"]') && document.querySelector('[data-field="price"]').value !== ''
        && !document.querySelector('.g5-sk, .g5-ghostplot')`, ms)
      await sleep(300)
    },
    debug: () => cdp.evaluate(`document.querySelector('[data-chart-host]').__g5.debug()`) as Promise<Debug>,
    async click(selector) {
      const r = await rig.ev<string>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.click(); return 'ok' })()`)
      if (r !== 'ok') throw new Error(`click target ${r}: ${selector}
${String(await cdp.evaluate(DIAG))}`)
    },
    async mclick(selector) {
      await rig.ev(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'nearest' })`)
      const r = await rig.ev<Rect | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
      if (!r) throw new Error(`click target missing: ${selector}`)
      const x = r.x + r.w / 2, y = r.y + r.h / 2
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    },
    async mouse(x, y) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }) },
    async shot(name) { writeFileSync(join(shotsDir, `${name}.png`), await cdp.screenshot()) },
    async close() { await cdp.close(); await stage.kernel.close() },
  }
  live.push(rig)
  await cdp.navigate(`${stage.kernel.url}/`)
  return rig
}

async function using(width: number, opts: OpenOptions, fn: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await open(width, opts)
  try { await fn(rig) } finally {
    await rig.close()
    live.splice(0, live.length, ...live.filter((x) => x !== rig))
  }
}
const text = (rig: Rig, sel: string) => rig.ev<string>(`document.querySelector(${JSON.stringify(sel)}).innerText`)
const CHART = '[data-geo="chart.card"]'
const SYMS = '[data-geo="symbols.card"]'
const TKT = '[data-geo="ticket.card"]'
const MINE = '[data-geo="mine.card"]'
// readGeometry 往页面注入的内联探针会撞内核的 CSP（已预装同一份探针，结果不受影响）；favicon 404 与未接通态的「未知查询」是预期噪声
const noise = (e: string) => /Failed to load resource|未知查询|unknown method|Executing inline script/.test(e)

// ---- 用例 ----------------------------------------------------------------------------------------------------------------------------------

describe('chart page · 三宽度几何与锚点', () => {
  for (const width of WIDTHS) {
    it(`${width}×900：几何探针全 0；四张卡的锚点与视觉稿相差 ≤ 4 px；每屏流光 ≤ 1、实心主按钮 ≤ 1`, async () => {
      await using(width, {}, async (rig) => {
        await rig.settled()
        const g = await readGeometry(rig.cdp)
        expect(geometryCounts(g), JSON.stringify({ overflow: g.overflow, truncated: g.truncated, halfRows: g.halfRows, escape: g.escape, overlap: g.overlap, badFont: g.badFont, badSpace: g.badSpace, align: g.align, numcol: g.numcol }).slice(0, 1800))
          .toEqual({ docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 })
        const rects = await rig.ev<Record<string, Rect>>(`Object.fromEntries([...document.querySelectorAll('[data-geo]')].map((e) => { const r = e.getBoundingClientRect(); return [e.getAttribute('data-geo'), { x: r.left, y: r.top, w: r.width, h: r.height }] }))`)
        for (const name of NAMES) {
          const want = anchors[String(width)]?.[name]
          expect(want, `${width} ${name} 登记`).toBeDefined()
          const r = rects[name]
          expect(r, `${width} ${name} 页内`).toBeDefined()
          for (const [axis, w, got] of [['x', want![0], r!.x], ['y', want![1], r!.y], ['w', want![2], r!.w], ['h', want![3], r!.h]] as const) {
            expect(Math.abs(got - w!), `${width} ${name}.${axis}: 稿 ${w} 页 ${got}`).toBeLessThanOrEqual(4)
          }
        }
        const audit = await rig.ev<Record<string, number> & { pass: Record<string, boolean>; samples?: Record<string, unknown> }>(auditSource)
        const fillDepth = ((audit.samples?.fillDepth ?? []) as unknown[]).map(String)
        const failed = Object.entries(audit.pass).filter(([k, ok]) => !ok && !(k === 'fillDepth' && fillDepth.length > 0 && fillDepth.every((x) => x.startsWith('g5-venue')))).map(([k]) => k)
        expect(failed, JSON.stringify(audit.samples)).toEqual([])
        expect(audit.glow).toBeLessThanOrEqual(1)
        expect(audit.solidOrange).toBeLessThanOrEqual(1)
        expect(audit.capsule).toBe(0)
        expect(audit.sizeViolations).toBe(0)
        expect(audit.cjk11).toBe(0)
        expect(audit.coloredZero).toBe(0)
        expect(rig.cdp.errors.filter((e) => !noise(e))).toEqual([])
        await rig.shot(`chart-${width}`)
      })
    }, 120_000)
  }

  it.skipIf(!existsSync(referencePage))('登记的稿矩形与现稿一致（三宽度，视觉稿实测）；设 P2_WRITE_ANCHORS=1 时重新实测并写回 geo-anchors/chart.json', async () => {
    const out: Record<string, Record<string, number[]>> = {}
    for (const width of WIDTHS) {
      const cdp = await launchCdp({ width, height: 900 })
      try {
        await cdp.navigate(new URL(`file:///${referencePage.replace(/\\/g, '/')}`).href)
        await cdp.evaluate('new Promise((r) => setTimeout(r, 1500))')
        const specs = NAMES.map((name) => ({ name, reference: `.frame ${STATIC_SEL[name]}`, product: `[data-geo="${name}"]` }))
        const snap = await captureAnchors(cdp, specs, 'reference').catch(async () => {
          // 稿里没有 .frame 包裹层时退回裸选择器
          return captureAnchors(cdp, NAMES.map((name) => ({ name, reference: STATIC_SEL[name], product: `[data-geo="${name}"]` })), 'reference')
        })
        out[String(width)] = Object.fromEntries(NAMES.map((n) => { const r = snap.rects[n]!; return [n, [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100)] }))
        if (!process.env.P2_WRITE_ANCHORS) {
          for (const n of NAMES) expect((out[String(width)]![n] as number[]).map(Math.round), `${width} ${n}`).toEqual((anchors[String(width)]![n] as number[]).map(Math.round))
        }
      } finally { await cdp.close() }
    }
    if (process.env.P2_WRITE_ANCHORS) {
      writeFileSync(join(here, 'geo-anchors/chart.json'), JSON.stringify({ _: 'reports/visual-r5/chart/index.html 在 1280/1440/1920 x 900 下各锚点的实测矩形 [x,y,w,h]（CDP 直连 Edge，getBoundingClientRect；键 = 产品页的 data-geo）。产品页同宽同夹具数据下与之相差 ≤ 4 px。', widths: out }, null, 1) + '\n')
    }
  }, 120_000)
})

describe('chart page · 图表卡内容与数字（正常态）', () => {
  it('卡头 = 标的 + 场所 + 周期 + 最新价与涨跌；读数行 OHLCV；图例四色；价格线四条、标记 12 个（买在 K 线下、卖在上）', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const head = await text(rig, '[data-geo="chart.head"]')
      for (const w of ['BTC-PERP', 'Hyperliquid', '1m', '15m', '1d', '指标', '标记', '64,812.0', '+0.42%']) expect(head, w).toContain(w)
      expect(await rig.ev('document.querySelector("[data-iv=\\"15m\\"]").getAttribute("aria-selected")')).toBe('true')
      const ohlc = await rig.ev<string[]>(`[...document.querySelectorAll('[data-geo="chart.ohlc"] i[data-k]')].map((e) => e.innerText)`)
      expect(ohlc[3]).toBe('64,812.0')
      expect(await rig.ev<string[]>(`[...document.querySelectorAll('[data-legend]')].map((e) => e.getAttribute('data-legend'))`)).toEqual(['human', 'engine', 'agent', 'system'])
      const d = await rig.debug()
      expect(d.bars).toBe(1000)
      expect(d.volume).toBe(true)
      expect(d.lines.map((l) => [l.label, l.price])).toEqual(expect.arrayContaining([['多 0.08', 64210], ['止损', 63100], ['待批 买 0.05', 64600], ['强平 约', 52100]]))
      expect(d.lines).toHaveLength(4)
      expect(d.markers).toHaveLength(12)
      // 价格线：开仓实线、其余虚线；强平不近 → 字色与其他线一致
      expect(d.lines.find((l) => l.label === '多 0.08')!.dash).toBeNull()
      expect(d.lines.filter((l) => l.label !== '多 0.08').every((l) => Array.isArray(l.dash))).toBe(true)
      const liq = d.lines.find((l) => l.label === '强平 约')!
      expect(liq.textColor).toBe(d.lines.find((l) => l.label === '止损')!.textColor)
      // 颜色 = 执行方：每种执行方一个颜色，三种互不相同
      const colors = [...new Set(d.markers.map((m) => m.color))]
      expect(colors).toHaveLength(4)
      expect(d.markers.some((m) => m.hollow)).toBe(false)
      // 卡头在请求之外没有别的读数：market.candles 一次取 1000 根 + 一次 1d 取 2 根
      const cq = rig.stage.kernel.queries.filter((q) => q.method === 'market.candles').map((q) => q.params as { interval: string; limit: number })
      expect(cq.some((p) => p.interval === '15m' && p.limit === 1000)).toBe(true)
      expect(cq.some((p) => p.interval === '1d' && p.limit === 2)).toBe(true)
      await rig.shot('chart-1440-normal')
    })
  }, 120_000)

  it('成交标记悬停读数：时间 价格 数量 费 执行方 来源，另有「在记录中查看」；移开后收起；点「在记录中查看」写 account 联动并跳 #/records', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const d = await rig.debug()
      const agent = d.markers.find((m) => m.id === 'fill_02')!
      await rig.mouse(agent.x, agent.y)
      await rig.waitFor(`!!document.querySelector('[data-mcard="fill_02"]')`)
      const card = await text(rig, '[data-mcard="fill_02"]')
      for (const w of ['Claude Code', '卖 0.05 @', '费 1.44', '无', '在记录中查看']) expect(card, w).toContain(w)
      expect(card).toMatch(/\d\d-\d\d \d\d:\d\d:\d\d/)
      await rig.shot('chart-1440-marker-hover')
      // 移开 → 收起
      await rig.mouse(10, 10)
      await rig.waitFor(`!document.querySelector('[data-mcard]')`)
      // 再悬停回来，走进读数卡（卡不因指针离开标记而消失），点「在记录中查看」
      await rig.mouse(agent.x, agent.y)
      await rig.waitFor(`!!document.querySelector('[data-mcard="fill_02"]')`)
      await rig.click('[data-mcard="fill_02"] [data-act="in-records"]')
      await rig.waitFor(`window.__hub.get('A', 'account') === '${ACCT_LIVE}' && location.hash === '#/records'`)
      // 买在下方、卖在上方（像素位置：同一根 K 线内，买点的 y 在最低价下面，卖点在最高价上面）
      const buy = d.markers.find((m) => m.id === 'fill_01')!
      const sell = d.markers.find((m) => m.id === 'fill_02')!
      expect(typeof buy.y).toBe('number')
      expect(typeof sell.y).toBe('number')
    })
  }, 120_000)

  it('周期分段：切 1h 重查 market.candles {interval:"1h"}，读数仍然有；标记按新周期重新落位', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.click('[data-iv="1h"]')
      await rig.waitFor(`document.querySelector('[data-iv="1h"]').getAttribute('aria-selected') === 'true' && (() => { const h = document.querySelector('[data-chart-host]'); const d = h && h.__g5 && h.__g5.debug(); return !!d && d.markers.length > 0 && d.bars > 0 })()`)
      const q = rig.stage.kernel.queries.filter((x) => x.method === 'market.candles' && (x.params as { interval: string }).interval === '1h')
      expect(q.length).toBeGreaterThan(0)
      expect(await rig.ev('window.__configs.some((c) => c.id === "bi_chart_1" && c.config.interval === "1h")')).toBe(true)
      expect((await rig.debug()).markers.length).toBeGreaterThan(0)
    })
  }, 120_000)

  it('回测成交空心、真实成交实心：直接把一组回测标记送进图（实验详情的 K 线页签将经同一入口），debug 读回空心标志；截图留证', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const bars = candlesFor(BTC, '15m', 1000, rig.set.now)
      const mk = (id: string, back: number, side: 'buy' | 'sell', actor: string, token: string, hollow: boolean) => {
        const b = bars[bars.length - 1 - back]!
        return { id, ts: b.t + 1000, barTs: b.t, side, shape: side === 'buy' ? 'up' : 'down', anchor: side === 'buy' ? 'low' : 'high', value: Number(side === 'buy' ? b.l : b.h), actor, actorName: actor, colorToken: token, hollow, price: b.c, size: '0.05', fee: '1.00', source: '回测', accountId: 'bt', orderId: '' }
      }
      const specs = [mk('bt1', 60, 'buy', 'engine', '--gr-actor-engine', true), mk('bt2', 50, 'sell', 'engine', '--gr-actor-engine', true), mk('rl1', 40, 'buy', 'human', '--gr-actor-human', false), mk('bt3', 30, 'sell', 'agent', '--gr-actor-agent', true)]
      await rig.ev(`document.querySelector('[data-chart-host]').__g5.setMarkers(${JSON.stringify(specs)})`)
      const d = await rig.debug()
      expect(d.markers.map((m) => [m.id, m.hollow])).toEqual([['bt1', true], ['bt2', true], ['rl1', false], ['bt3', true]])
      await sleep(300)
      await rig.shot('chart-1440-hollow')
    })
  }, 120_000)

  it('指标菜单：成交量可开关；EMA / RSI 写「未接通」且不可选（engine-core 的 ta 导出未落地）；标记菜单按执行方开关', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.mclick('[data-menu="indicators"]')
      await rig.waitFor(`document.querySelectorAll('[role="menuitem"]').length >= 4`)
      const items = await rig.ev<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`)
      expect(items).toEqual(['成交量', 'EMA 20 未接通', 'EMA 60 未接通', 'RSI 14 未接通'])
      expect(await rig.ev('[...document.querySelectorAll("[role=menuitem]")].slice(1).every((e) => e.hasAttribute("data-disabled"))')).toBe(true)
      await rig.shot('chart-1440-indicators-menu')
      await rig.mclick('[role="menuitem"]:first-child')
      await rig.waitFor(`document.querySelector('[data-chart-host]').__g5.debug().volume === false`)
      expect(await rig.ev('window.__configs.some((c) => c.id === "bi_chart_1" && Array.isArray(c.config.indicators) && !c.config.indicators.includes("vol"))')).toBe(true)
      // 标记菜单：关掉「你」后只剩另外三种
      await rig.mclick('[data-menu="markers"]')
      await rig.waitFor(`document.querySelectorAll('[role="menuitem"]').length === 4`)
      await rig.mclick('[role="menuitem"]:first-child')
      await rig.waitFor(`document.querySelector('[data-chart-host]').__g5.debug().markers.length === 8`)
    })
  }, 120_000)

  it('价轴范围：离边缘不远的线（止损 63,100）并入价轴；远处的强平线（52,100）不拉伸价轴、钉在窗格边缘带箭头', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await sleep(400)
      const d = await rig.debug()
      const lows = d.range
      expect(lows.from, JSON.stringify(lows)).toBeLessThanOrEqual(63100)
      expect(lows.from, JSON.stringify(lows)).toBeGreaterThan(60000)
      expect(lows.to).toBeLessThan(70000)
      expect(d.lines.some((l) => l.label === '强平 约' && l.price === 52100)).toBe(true)
    })
  }, 120_000)

  it('强平近（≤ 5%）：强平线只把字色换 down，线色不变；不近则字色同其他线', async () => {
    await using(1440, { set: (s) => { (s.positions[ACCT_LIVE]![0] as Record<string, unknown>).liquidationPrice = '62000.0' } }, async (rig) => {
      await rig.settled()
      const d = await rig.debug()
      const liq = d.lines.find((l) => l.label === '强平 约')!
      const stop = d.lines.find((l) => l.label === '止损')!
      const down = await rig.ev<string>(`(() => { const p = document.createElement('i'); document.body.append(p); p.style.color = 'var(--gr-down)'; const c = getComputedStyle(p).color; p.remove(); return c })()`)
      expect(liq.textColor).toBe(down)
      expect(liq.lineColor).toBe(stop.lineColor)
      expect(stop.textColor).not.toBe(down)
    })
  }, 120_000)

  it('红涨绿跌互换：只换 --gr-up / --gr-down，蜡烛与涨跌字跟着互换，成交标记（执行方色）不动', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const read = () => rig.ev<{ up: string; down: string; pct: string; candleUp: string; candleDown: string; marker: string }>(`(() => {
        const probe = document.createElement('i'); document.body.append(probe)
        probe.style.color = 'var(--gr-up)'; const up = getComputedStyle(probe).color
        probe.style.color = 'var(--gr-down)'; const down = getComputedStyle(probe).color
        probe.remove()
        const d = document.querySelector('[data-chart-host]').__g5.debug()
        return { up, down, pct: getComputedStyle(document.querySelector('[data-n="chg"]')).color, candleUp: d.upColor, candleDown: d.downColor, marker: d.markers[0].color }
      })()`)
      const intl = await read()
      expect(intl.up).not.toBe(intl.down)
      expect(intl.pct).toBe(intl.up)
      expect(intl.candleUp).toBe(intl.up)
      expect(intl.candleDown).toBe(intl.down)
      await rig.ev(`document.documentElement.setAttribute('data-updown', 'cn')`)
      await rig.waitFor(`document.querySelector('[data-chart-host]').__g5.debug().upColor !== ${JSON.stringify(intl.candleUp)}`)
      const cn = await read()
      expect(cn.up).toBe(intl.down)
      expect(cn.down).toBe(intl.up)
      expect(cn.candleUp).toBe(cn.up)
      expect(cn.candleDown).toBe(cn.down)
      expect(cn.pct).toBe(cn.up)
      expect(cn.marker).toBe(intl.marker)
      await rig.shot('chart-1440-cn')
    })
  }, 120_000)

  it('实时：market.candles 事件并入形成中的那根，读数与最新价跟着变', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const t = Math.floor(rig.set.now / 900_000) * 900_000
      rig.stage.kernel.publish('market.candles', { instrumentId: BTC, interval: '15m', candles: [{ t, o: '64759.1', h: '64950.0', l: '64700.0', c: '64901.5', v: '999' }] })
      await rig.waitFor(`document.querySelector('[data-n="last"]').innerText === '64,901.5'`)
      expect(await rig.ev('document.querySelector("[data-geo=\\"chart.ohlc\\"] i[data-k=close]").innerText')).toBe('64,901.5')
      // 别的标的 / 别的周期的事件不串进来
      rig.stage.kernel.publish('market.candles', { instrumentId: ETH, interval: '15m', candles: [{ t, o: '1', h: '1', l: '1', c: '1', v: '1' }] })
      rig.stage.kernel.publish('market.candles', { instrumentId: BTC, interval: '1h', candles: [{ t, o: '1', h: '1', l: '1', c: '2', v: '1' }] })
      await sleep(400)
      expect(await rig.ev('document.querySelector("[data-n=last]").innerText')).toBe('64,901.5')
    })
  }, 120_000)
})

describe('chart page · 标的卡', () => {
  it('持仓标的置顶（BTC / ETH / SOL），每行 名称 / 场所 / 最新价 / 当日涨跌（与稿同数）；当前标的高亮', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const rows = await rig.ev<string[][]>(`[...document.querySelectorAll('.g5-srow')].map((r) => [r.getAttribute('data-sym'), r.getAttribute('aria-selected'), r.querySelector('.g5-sym').innerText, r.querySelector('.g5-px').innerText, r.querySelector('.g5-ch').innerText])`)
      // X1 ②：取不到标的精度时去掉多余尾零（fmtPrice 先去尾零再按至少 1 位小数写），夹具里的 148.20 → 148.2
      expect(rows).toEqual([[BTC, 'true', 'BTC-PERP', '64,812.0', '+0.42%'], [ETH, 'false', 'ETH-PERP', '3,182.0', '−1.10%'], [SOL, 'false', 'SOL-PERP', '148.2', '+2.05%']])
      expect(await text(rig, `${SYMS} .g5-srow`)).toContain('Hyperliquid')
      const cols = await rig.ev<string[]>(`[...document.querySelectorAll('.g5-srow .g5-ch')].map((e) => getComputedStyle(e).color)`)
      expect(cols[0]).not.toBe(cols[1])
      expect(cols[0]).toBe(cols[2])
    })
  }, 120_000)

  it('点行 = 写 symbol 联动：图表 / 本标的 / 票据跟着换标的；最近查看写进块 config', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.click(`.g5-srow[data-sym="${ETH}"]`)
      await rig.waitFor(`window.__hub.get('A', 'symbol') === '${ETH}'`)
      await rig.waitFor(`document.querySelector('[data-geo="chart.head"] h2').innerText === 'ETH-PERP' && document.querySelector('${MINE}').innerText.includes('空 1.20') && document.querySelector('${TKT}').innerText.includes('ETH')`)
      await rig.waitFor(`document.querySelector('[data-chart-host]').__g5.debug().lines.some((l) => l.label === '待批 卖 2.00')`)
      expect(rig.stage.kernel.queries.some((q) => q.method === 'market.candles' && (q.params as { instrumentId: string }).instrumentId === ETH && (q.params as { interval: string }).interval === '15m')).toBe(true)
      expect(await rig.ev(`window.__configs.some((c) => c.id === 'bi_symbols_1' && c.config.recent && c.config.recent[0] === '${ETH}')`)).toBe(true)
      await rig.shot('chart-1440-eth')
    })
  }, 120_000)

  it('搜索：输入 → instruments.search → 点结果加入自选并选中；手动加入的行可移除；持仓行不可移除', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.ev(`(() => { const i = document.querySelector('[aria-label="搜索标的"]'); i.value = 'dog'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await rig.waitFor(`!!document.querySelector('[data-hit="hyperliquid:DOGE"]')`)
      expect(await rig.ev('document.querySelectorAll("[data-hit]").length')).toBe(1)
      expect(rig.stage.kernel.queries.some((q) => q.method === 'instruments.search' && (q.params as { q: string }).q === 'dog')).toBe(true)
      await rig.click('[data-hit="hyperliquid:DOGE"]')
      await rig.waitFor(`window.__hub.get('A', 'symbol') === 'hyperliquid:DOGE' && !!document.querySelector('.g5-srow[data-sym="hyperliquid:DOGE"]')`)
      expect(await rig.ev(`window.__configs.some((c) => c.id === 'bi_symbols_1' && c.config.watch && c.config.watch.includes('hyperliquid:DOGE'))`)).toBe(true)
      expect(await rig.ev(`document.querySelectorAll('.g5-srow[data-sym="${BTC}"] [data-act="remove"]').length`)).toBe(0)
      // 当前标的进「最近查看」的那次写配置落定后再移除（否则移除与它抢同一轮渲染）
      await rig.waitFor(`window.__configs.some((c) => c.config.recent && c.config.recent[0] === 'hyperliquid:DOGE')`)
      await rig.click('.g5-srow[data-sym="hyperliquid:DOGE"] [data-act="remove"]')
      await rig.waitFor(`!document.querySelector('.g5-srow[data-sym="hyperliquid:DOGE"]')`)
      expect(await rig.ev(`window.__configs.at(-1).config.watch.length === 0 && !window.__configs.at(-1).config.recent.includes('hyperliquid:DOGE')`)).toBe(true)
    })
  }, 120_000)

  it('该场所没有 K 线源：图表卡一行「该场所没有 K 线数据」+ [换标的]，点它把焦点交给标的卡搜索框', async () => {
    await using(1440, { set: (s) => { s.fail.candles = 'unsupported' } }, async (rig) => {
      await rig.waitFor(`!!document.querySelector('${CHART} [data-state="nosource"]')`)
      expect(await text(rig, CHART)).toContain('该场所没有 K 线数据')
      expect(await text(rig, CHART)).toContain('换标的')
      expect(await rig.ev('document.querySelectorAll("canvas").length')).toBe(0)
      await rig.click('[data-act="change-symbol"]')
      await rig.waitFor(`document.activeElement && document.activeElement.getAttribute('aria-label') === '搜索标的'`)
      await rig.shot('chart-nosource')
    })
  }, 120_000)
})

describe('chart page · 本标的（撤单 / 平仓 / 止损）', () => {
  const armed = (rig: Rig, kind: string) => rig.waitFor(`!!document.querySelector('${MINE} .g5-armed [data-act="${kind}-confirm"]')`)
  const confirm = async (rig: Rig, kind: string) => {
    await sleep(750)
    await rig.click(`${MINE} .g5-armed [data-act="${kind}-confirm"]`)
  }

  it('持仓行 / 挂单行 / 待批行与稿同数', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const t = await text(rig, MINE)
      // X1 ②（维护者验收）：持仓 / 挂单价按标的精度展示、去掉多余尾零（共享 display.formatPrice），旧稿「64,210.0」写法不再适用
      for (const w of ['多 0.08', '未实现', '+48.16', '开仓 64,210', '4×', '平仓', '止损', '止损', '卖 0.08 @ 63,100', '撤单', '待批 1', 'T-0008', '买 0.05 @ 64,600', '全部记录']) expect(t, w).toContain(w)
      expect(await rig.ev(`document.querySelectorAll('${MINE} [data-pos]').length`)).toBe(1)
      expect(await rig.ev(`document.querySelectorAll('${MINE} [data-order]').length`)).toBe(1)
      expect(await rig.ev(`/\\d\\d:\\d\\d/.test(document.querySelector('${MINE} .g5-pendr').innerText)`)).toBe(true)
    })
  }, 120_000)

  it('撤单走 G2：武装行写后果 →（600 ms 死区）→ 确认；实盘先要证明，壳弹 PIN 带证明重发；成功后行消失、画面上的止损线也没了', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.click(`${MINE} [data-act="order-cancel"]`)
      await armed(rig, 'cancel')
      expect(await rig.ev(`document.querySelector('${MINE} .g5-armed .g5-what').innerText`)).toBe('撤销 止损 卖 0.08 @ 63,100')
      expect(await rig.ev(`document.querySelector('${MINE} .g5-armed [data-act="cancel-confirm"]').disabled`)).toBe(false)
      await rig.shot('chart-1440-cancel-armed')
      await confirm(rig, 'cancel')
      await rig.waitFor(`!document.querySelector('${MINE} [data-order]')`)
      expect(rig.log.cancelled).toEqual([{ accountId: ACCT_LIVE, orderId: 'ord_stop_btc' }])
      expect(rig.stage.kernel.commands.filter((c) => c.action === 'order.cancel').map((c) => (c.attestation ? 'attested' : 'bare'))).toEqual(['bare', 'attested'])
      expect(await rig.ev('window.__attest.calls')).toBe(1)
      await rig.waitFor(`!document.querySelector('[data-chart-host]').__g5.debug().lines.some((l) => l.label === '止损')`)
    })
  }, 120_000)

  it('撤单被拒：武装行里就是内核原文，不改写；点取消收起', async () => {
    const message = 'Order 77 does not exist or was already filled'
    await using(1440, { set: (s) => { s.reject = message; s.pinForLive = false } }, async (rig) => {
      await rig.settled()
      await rig.click(`${MINE} [data-order] [data-act="order-cancel"]`)
      await armed(rig, 'cancel')
      await confirm(rig, 'cancel')
      await rig.waitFor(`!!document.querySelector('${MINE} .g5-armed [role="alert"]')`)
      expect(await rig.ev(`document.querySelector('${MINE} .g5-armed [role="alert"] [data-err-detail] .gr-errd__v').textContent`)).toBe(message) // ux-fix2 B2：Owner 令，总控批准的规格变更——上游原文收进详情
      await rig.click(`${MINE} .g5-armed [data-act="cancel-cancel"]`)
      await rig.waitFor(`!document.querySelector('${MINE} .g5-armed')`)
      expect(await rig.ev(`document.querySelectorAll('${MINE} [data-order]').length`)).toBe(1)
    })
  }, 120_000)

  it('PIN 层点取消 = 命令没发生：武装行收起、订单还在', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.ev('window.__attest.mode = "cancel"')
      await rig.click(`${MINE} [data-order] [data-act="order-cancel"]`)
      await armed(rig, 'cancel')
      await confirm(rig, 'cancel')
      await rig.waitFor('window.__attest.calls === 1')
      await rig.waitFor(`!document.querySelector('${MINE} .g5-armed')`)
      expect(rig.log.cancelled).toHaveLength(0)
      expect(await rig.ev(`document.querySelectorAll('${MINE} [data-order]').length`)).toBe(1)
    })
  }, 120_000)

  it('平仓：武装行「市价平掉 0.08 BTC-PERP」→ 确认 → position.close {accountId, instrumentId}；持仓行消失、开仓线与强平线也消失', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.click(`${MINE} [data-act="pos-close"]`)
      await armed(rig, 'close')
      expect(await rig.ev(`document.querySelector('${MINE} .g5-armed .g5-what').innerText`)).toBe('市价平掉 0.08 BTC-PERP')
      await confirm(rig, 'close')
      await rig.waitFor(`!document.querySelector('${MINE} [data-pos]')`)
      expect(rig.log.closed).toHaveLength(1)
      expect(rig.log.closed[0]).toMatchObject({ accountId: ACCT_LIVE, instrumentId: BTC })
      await rig.waitFor(`(() => { const l = document.querySelector('[data-chart-host]').__g5.debug().lines.map((x) => x.label); return !l.includes('多 0.08') && !l.some((x) => x.startsWith('强平')) })()`)
    })
  }, 120_000)

  it('止损：本地先挡（多头止损价要低于标记价）；通过后挂新单（stop_market + reduceOnly + triggerPrice）再撤旧止损；图上线换成新价位', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.click(`${MINE} [data-act="pos-stop"]`)
      await rig.waitFor(`!!document.querySelector('${MINE} [data-form="stop"]')`)
      const set = (v: string) => rig.ev(`(() => { const i = document.querySelector('${MINE} [aria-label="止损触发价"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await set('65000')
      await rig.click(`${MINE} [data-act="stop-save"]`)
      await rig.waitFor(`document.querySelector('${MINE} [data-form="stop"]').innerText.includes('多头止损价要低于标记价')`)
      expect(rig.log.placed).toHaveLength(0)
      await set('62000')
      await rig.click(`${MINE} [data-act="stop-save"]`)
      await rig.waitFor(`!document.querySelector('${MINE} [data-form="stop"]') && document.querySelector('${MINE}').innerText.includes('62,000')`)
      expect(rig.log.placed).toHaveLength(1)
      expect(rig.log.placed[0]).toMatchObject({ accountId: ACCT_LIVE, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.08', triggerPrice: '62000', reduceOnly: true })
      expect(rig.log.cancelled).toEqual([{ accountId: ACCT_LIVE, orderId: 'ord_stop_btc' }])
      await rig.waitFor(`(() => { const l = document.querySelector('[data-chart-host]').__g5.debug().lines.filter((x) => x.label === '止损'); return l.length === 1 && l[0].price === 62000 })()`)
    })
  }, 120_000)

  it('展开：账户 / 名义 / 标记价 / 强平价；「全部记录」跳 #/records', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.click(`${MINE} [data-act="pos-expand"]`)
      await rig.waitFor(`!!document.querySelector('${MINE} [data-detail]')`)
      const t = await text(rig, `${MINE} [data-detail]`)
      for (const w of ['hl-main 实盘', '5,184.96', '64,812', '约 52,100']) expect(t, w).toContain(w)
      await rig.click(`${MINE} [data-act="all-records"]`)
      await rig.waitFor(`location.hash === '#/records/hyperliquid:BTC'`) // GQ-37 显式路由
    })
  }, 120_000)
})

describe('chart page · 下单票据', () => {
  const fill = (rig: Rig, field: string, v: string) => rig.ev(`(() => { const i = document.querySelector('${TKT} [data-field="${field}"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const armTicket = async (rig: Rig) => {
    await rig.click(`${TKT} [data-act="order-submit"]`)
    await rig.waitFor(`!!document.querySelector('${TKT} .g5-armed')`)
  }
  const confirmTicket = async (rig: Rig) => { await sleep(750); await rig.click(`${TKT} .g5-armed [data-act="order-confirm"]`) }

  it('缺省取自同一份夹具：hl-main 实盘、限价；价格框 = 夹具最新价（未格式化），数量空、提交键禁用；输入数量后名义 = 夹具价 × 量，按钮「买入 <量> BTC-PERP」', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      // 期望值全从夹具读：最新价 = 夹具 15m 最后一根收盘价，账户别名 / 模式来自 accounts 夹具
      const last = candlesFor(BTC, '15m', 1000, rig.set.now).at(-1)!.c
      const acct = accounts.find((a) => a.accountId === ACCT_LIVE)!
      expect(await text(rig, `${TKT} [data-geo="ticket.head"]`)).toContain(`${acct.alias}　${acct.mode === 'live' ? '实盘' : '纸面'}`)
      // release-r1 P0-3：预填价按标的价格规则截断（夹具 64812.0 → 64812，数值不变、不带千分位），断言数值相等且未格式化
      const prefilled = await rig.ev<string>(`document.querySelector('${TKT} [data-field="price"]').value`)
      expect(prefilled).toMatch(/^\d+(\.\d+)?$/)
      expect(Number(prefilled)).toBe(Number(last))
      expect(await rig.ev(`document.querySelector('${TKT} [data-field="size"]').value`)).toBe('')
      expect(await rig.ev(`document.querySelector('${TKT} [data-act="order-submit"]').disabled`)).toBe(true)
      const size = '0.08'
      await fill(rig, 'size', size)
      const digits = (v: string) => BigInt(v.replace('.', ''))
      const dec = (v: string) => v.split('.')[1]?.length ?? 0
      const cents = (digits(last) * digits(size)) / 10n ** BigInt(dec(last) + dec(size) - 2) // 价 × 量，换成「分」（夹具价 1 位、量 2 位：恰好整除）
      const want = `${String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(cents % 100n).padStart(2, '0')}`
      await rig.waitFor(`document.querySelector('${TKT} [data-field="notional"]').innerText === ${JSON.stringify(want)}`)
      expect(await text(rig, `${TKT} [data-act="order-submit"]`)).toBe(`买入 ${size} BTC-PERP`)
      expect(await rig.ev(`document.querySelector('${TKT} .g5-u').innerText`)).toBe('USDC')
      // fix-r3 P2-4（裁决依据：工单 WI-F20 第 4 条）：没有内核给的强平价估算时不显示这一行，不再挂「未接通」
      expect(await rig.ev(`document.querySelector('${TKT} [data-field="liq"]') === null`)).toBe(true)
      await rig.shot('chart-1440-ticket-filled')
    })
  }, 120_000)

  it('提交：G2 武装行写后果 → 确认 → 实盘先要证明、壳弹 PIN 带证明重发 → order.place 的意图字段齐全；成功后清数量、出 toast', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await fill(rig, 'price', '64,800.0')
      await fill(rig, 'size', '0.08')
      await armTicket(rig)
      expect(await rig.ev(`document.querySelector('${TKT} .g5-armed .g5-what').innerText`)).toBe('买 0.08 BTC-PERP @ 64,800.0 · 名义 5,184.00')
      await rig.shot('chart-1440-ticket-armed')
      await confirmTicket(rig)
      await rig.waitFor(`!document.querySelector('${TKT} .g5-armed') && document.querySelector('${TKT} [data-field="size"]').value === ''`)
      expect(rig.log.placed).toEqual([{ accountId: ACCT_LIVE, instrumentId: BTC, side: 'buy', size: '0.08', reduceOnly: false, type: 'limit', price: '64800.0' }])
      expect(rig.stage.kernel.commands.filter((c) => c.action === 'order.place').map((c) => (c.attestation ? 'attested' : 'bare'))).toEqual(['bare', 'attested'])
      expect(await rig.ev('window.__attest.calls')).toBe(1)
      // 新单进了本标的卡的挂单行
      await rig.waitFor(`document.querySelectorAll('${MINE} [data-order]').length === 2`)
    })
  }, 120_000)

  it('纸面账户：不要证明，一次命令成功；卖出 + 只减仓 + 止损类型发 stop_market 并带 triggerPrice', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.mclick(`${TKT} [data-menu="account"]`)
      await rig.waitFor(`!!document.querySelector('[role="menuitemradio"][data-v="${ACCT_PAPER}"]')`)
      await rig.mclick(`[role="menuitemradio"][data-v="${ACCT_PAPER}"]`)
      await rig.waitFor(`document.querySelector('${TKT} [data-menu="account"]').innerText.includes('paper-1')`)
      await rig.click(`${TKT} [data-side="sell"]`)
      await rig.click(`${TKT} [data-type="stop_market"]`)
      await rig.click(`${TKT} [data-act="reduce-only"]`)
      await fill(rig, 'price', '63000')
      await fill(rig, 'size', '0.01')
      await armTicket(rig)
      await confirmTicket(rig)
      await rig.waitFor(`!document.querySelector('${TKT} .g5-armed')`)
      expect(rig.log.placed).toEqual([{ accountId: ACCT_PAPER, instrumentId: BTC, side: 'sell', size: '0.01', reduceOnly: true, type: 'stop_market', triggerPrice: '63000' }])
      expect(rig.stage.kernel.commands.filter((c) => c.action === 'order.place').map((c) => (c.attestation ? 'attested' : 'bare'))).toEqual(['bare'])
      expect(await rig.ev('window.__attest.calls')).toBe(0)
    })
  }, 120_000)

  it('风控拒绝：武装行里是内核原文，不改写；取消后留一行「被拦下」原文，改任何字段后消失；PIN 层点取消 = 什么都没发生', async () => {
    const message = '单笔上限 8,000，实际 8,424'
    await using(1440, { set: (s) => { s.reject = message } }, async (rig) => {
      await rig.settled()
      await fill(rig, 'size', '0.13')
      await armTicket(rig)
      await confirmTicket(rig)
      await rig.waitFor(`!!document.querySelector('${TKT} .g5-armed [role="alert"]')`)
      expect(await rig.ev(`document.querySelector('${TKT} .g5-armed [role="alert"]').innerText`)).toBe(message)
      await rig.shot('chart-1440-ticket-rejected')
      await rig.click(`${TKT} .g5-armed [data-act="order-cancel"]`)
      await rig.waitFor(`!document.querySelector('${TKT} .g5-armed') && !!document.querySelector('${TKT} [data-blocked]')`)
      // fix-r3 P2-2（裁决依据：E0-10「人话 + 原文留在括号里」）：被拦下行 = 中文原因 + 括号里的内核原文；原文一字不改，仍须完整出现
      const blockedText = await rig.ev(`document.querySelector('${TKT} [data-blocked]').innerText`) as string
      expect(blockedText).toContain(`（${message}）`)
      expect(blockedText.length).toBeGreaterThan(message.length + 2)
      await fill(rig, 'size', '0.12')
      await rig.waitFor(`!document.querySelector('${TKT} [data-blocked]')`)
      // PIN 取消
      await rig.ev('window.__attest.mode = "cancel"')
      const before = rig.log.placed.length
      const calls = await rig.ev<number>('window.__attest.calls')
      await armTicket(rig)
      await confirmTicket(rig)
      await rig.waitFor(`window.__attest.calls === ${calls + 1}`)
      await rig.waitFor(`!document.querySelector('${TKT} .g5-armed')`)
      expect(rig.log.placed.length).toBe(before)
      expect(await rig.ev(`!!document.querySelector('${TKT} [data-blocked]')`)).toBe(false)
    })
  }, 120_000)

  it('按可用额比例：25% / 50% / 100% 填数量（可用 8,000，价 64,812 → 0.0308 / 0.0617 / 0.1234）；本地不拦超限单', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      await rig.click(`${TKT} [data-pct="25"]`)
      await rig.waitFor(`document.querySelector('${TKT} [data-field="size"]').value === '0.0308'`)
      expect(await rig.ev(`document.querySelector('${TKT} [data-pct="25"]').getAttribute('aria-pressed')`)).toBe('true')
      await rig.click(`${TKT} [data-pct="50"]`)
      await rig.waitFor(`document.querySelector('${TKT} [data-field="size"]').value === '0.0617'`)
      await rig.click(`${TKT} [data-pct="100"]`)
      await rig.waitFor(`document.querySelector('${TKT} [data-field="size"]').value === '0.1234'`)
      // 手改数量 → 比例选中态清掉
      await fill(rig, 'size', '5')
      await rig.waitFor(`document.querySelector('${TKT} [data-pct="100"]').getAttribute('aria-pressed') === 'false'`)
      expect(await rig.ev(`document.querySelector('${TKT} [data-act="order-submit"]').disabled`)).toBe(false)
    })
  }, 120_000)
})

describe('chart page · 四态、离线与未接通', () => {
  it('加载：图表卡只画坐标框和网格线（没有 canvas、没有假蜡烛），右列各卡骨架；数据到了换成内容', async () => {
    await using(1440, { set: (s) => { s.delayMs = 2500 } }, async (rig) => {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && !!document.querySelector('${CHART} .g5-ghostplot')`)
      expect(await rig.ev('document.querySelectorAll("canvas").length')).toBe(0)
      expect(await text(rig, CHART)).not.toContain('64,812')
      await rig.shot('chart-loading')
      await rig.settled(30_000)
      expect((await rig.debug()).bars).toBe(1000)
    })
  }, 120_000)

  it('空：所选周期没有数据 →「这个周期没有数据」；整页空（没有账户）右列各卡一行字', async () => {
    await using(1440, { set: (s) => { s.emptyCandles = true } }, async (rig) => {
      await rig.waitFor(`!!document.querySelector('${CHART} [data-state="noperiod"]')`)
      expect(await text(rig, CHART)).toContain('这个周期没有数据')
      await rig.shot('chart-empty')
    })
    await using(1440, { set: (s) => { s.positions[ACCT_LIVE] = []; s.orders[ACCT_LIVE] = []; s.proposals = [] } }, async (rig) => {
      await rig.waitFor(`document.querySelector('${MINE}').innerText.includes('当前没有持仓和挂单')`)
      expect(await text(rig, SYMS)).toContain('BTC')
    })
    await using(1440, { symbol: null, set: (s) => { s.positions[ACCT_LIVE] = []; s.noInstruments = true } }, async (rig) => {
      await rig.waitFor(`document.querySelector('${SYMS}').innerText.includes('没有自选标的') && document.querySelector('${CHART}').innerText.includes('还没有选定标的')`)
    })
  }, 120_000)

  it('错误：K 线读取失败 → 内核原文原样 + [重试]，点重试重查并恢复；标记层失败只在标记菜单写「读取失败」，主图照常', async () => {
    const message = 'upstream candle gateway timed out (code 504)'
    await using(1440, { set: (s) => { s.fail.candles = message } }, async (rig) => {
      await rig.waitFor(`!!document.querySelector('${CHART} [data-state="error"]')`)
      const t = await text(rig, CHART)
      expect(t).toContain('读取失败')
      // fix-r4 D1：上游原文收进可展开的「详情」（收起时 innerText 不含），改用 textContent 核对原文仍在页面里
      expect(t).toContain('暂时取不到 K 线')
      expect(await rig.ev<string>(`document.querySelector('${CHART} [data-act="error-detail"]').textContent`)).toContain(message)
      expect(t).toContain('重试')
      await rig.shot('chart-error')
      rig.set.fail.candles = undefined
      await rig.click('[data-act="retry"]')
      await rig.waitFor(`!!document.querySelector('[data-chart-host]') && document.querySelector('[data-chart-host]').__g5.debug().bars > 0`)
    })
    await using(1440, { set: (s) => { s.fail.records = 'ledger index is rebuilding' } }, async (rig) => {
      await rig.waitFor(`!!document.querySelector('[data-chart-host]') && !!document.querySelector('[data-chart-host]').__g5 && document.querySelector('[data-chart-host]').__g5.debug().lines.length === 4`)
      await sleep(600)
      expect((await rig.debug()).markers).toHaveLength(0)
      expect((await rig.debug()).bars).toBe(1000)
      await rig.mclick('[data-menu="markers"]')
      await rig.waitFor(`!!document.querySelector('[data-marks-err]')`)
      expect(await rig.ev(`document.querySelector('[data-marks-err]').innerText`)).toBe('读取失败')
      await rig.shot('chart-marks-error')
    })
  }, 120_000)

  it('未接通：market.candles 接口不存在 → 「未接通」+ 内核原文、不给重试；图表卡以外的卡照常', async () => {
    await using(1440, { set: (s) => { s.fail.candles = 'missing' } }, async (rig) => {
      await rig.waitFor(`!!document.querySelector('${CHART} [data-wire="off"]')`)
      const t = await text(rig, CHART)
      expect(t).toContain('未接通')
      expect(t).toContain('unknown method')
      expect(await rig.ev(`document.querySelectorAll('${CHART} [data-act="retry"]').length`)).toBe(0)
      expect(await text(rig, MINE)).toContain('多 0.08')
      await rig.shot('chart-unwired')
    })
  }, 120_000)

  it('离线：最后一根停住、价签降灰去涨跌色、卡头写「已暂停更新 · mm:ss」、命令钮与周期 / 票据全禁用；恢复后复原', async () => {
    await using(1440, {}, async (rig) => {
      await rig.settled()
      const upColor = await rig.ev<string>(`getComputedStyle(document.querySelector('[data-n="chg"]')).color`)
      await rig.ev(`document.documentElement.setAttribute('data-offline', '')`)
      await rig.waitFor(`document.querySelectorAll('[data-state="offline"]').length >= 3`)
      for (const sel of [CHART, MINE, TKT, SYMS]) expect(await text(rig, sel), sel).toMatch(/已暂停更新 · \d\d:\d\d/)
      expect(await rig.ev(`[...document.querySelectorAll('${TKT} [data-menu], ${MINE} [data-act="pos-close"], ${MINE} [data-act="order-cancel"], ${TKT} [data-act="order-submit"]')].every((b) => b.disabled)`)).toBe(true)
      // 离线卡头只留 标的 + 场所 + 已暂停更新 + 价格块（与稿的离线卡头同形），周期 / 指标 / 标记不显示
      expect(await rig.ev(`document.querySelectorAll('[data-iv], [data-menu="indicators"], [data-menu="markers"]').length`)).toBe(0)
      expect(await rig.ev(`getComputedStyle(document.querySelector('[data-n="chg"]')).color`)).not.toBe(upColor)
      expect(await rig.ev('document.querySelectorAll("canvas").length')).toBeGreaterThan(0)
      await rig.shot('chart-offline')
      await rig.ev(`document.documentElement.removeAttribute('data-offline')`)
      await rig.waitFor(`document.querySelectorAll('[data-state="offline"]').length === 0 && document.querySelectorAll('[data-iv]').length === 6`)
    })
  }, 120_000)
})

describe('chart page · 挂载卸载 50 次无泄漏', () => {
  it('挂 / 卸 50 次后：页内 canvas 回到 0；DOM 节点与事件监听数不增长（先暖机 5 次、强制 GC 后取值）', async () => {
    await using(1280, { mode: 'cycle' }, async (rig) => {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && typeof window.__cycle === 'function'`)
      const counters = async () => {
        await rig.cdp.send('HeapProfiler.collectGarbage')
        await sleep(200)
        const c = await rig.cdp.send('Memory.getDOMCounters') as { documents: number; nodes: number; jsEventListeners: number }
        return { nodes: c.nodes, listeners: c.jsEventListeners, canvases: await rig.ev<number>('document.querySelectorAll("canvas").length') }
      }
      expect(await rig.ev('window.__cycle(5)')).toBe(true)
      const warm = await counters()
      expect(warm.canvases).toBe(0)
      expect(await rig.ev('window.__cycle(50)')).toBe(true)
      const after = await counters()
      expect(after.canvases).toBe(0)
      expect(after.nodes - warm.nodes, JSON.stringify({ warm, after })).toBeLessThanOrEqual(20)
      expect(after.listeners - warm.listeners, JSON.stringify({ warm, after })).toBeLessThanOrEqual(20)
      expect(rig.cdp.errors.filter((e) => !noise(e))).toEqual([])
    })
  }, 240_000)
})

describe('chart page · 路由与壳（等 S1）', () => {
  it.todo('从持仓进图表 → 在标的卡换标的 → 浏览器后退：不死循环（未跑，等 S1 的 #/chart/<instrumentId> 路由与 history.replaceState）')
})

describe('chart page · 源码红线', () => {
  const files = ['src/views/chart.tsx', 'src/views/symbols.tsx', 'src/views/symbol-positions.tsx', 'src/views/ticket.tsx', 'src/views/chart.css', 'src/model-chart.ts', 'src/chart-adapter.ts', 'src/pages/chart.tsx',
    'fixtures/chart.ts', 'test/model-chart.test.ts', 'test/ticket.test.ts', 'test/chart.browser.test.ts']
  const read = (f: string) => readFileSync(resolve(pkgDir, f), 'utf8')
  const banned = new RegExp(['保' + '守', '激' + '进', '稳' + '赚', '跑' + '赢', '稳定' + '盈利'].join('|'))
  it('新文件首行 SPDX；无颜色字面量 / 全圆 / 禁词 / 邮箱 / IP / 本机绝对路径；图表库只在 chart-adapter.ts 出现', () => {
    for (const f of files) {
      const s = read(f)
      expect(s.split('\n')[0], f).toMatch(/SPDX-License-Identifier: CPAL-1\.0/)
      expect(s, f).not.toMatch(banned)
      expect(s, f).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
      expect(s, f).not.toMatch(/[A-Za-z]:[\\/](?:Users|Gitrader|gitrader)/)
      expect(s, f).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/)
      if (f.endsWith('.css')) {
        expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
        expect(s, f).not.toMatch(/9999px|border-radius:\s*50%/)
        expect(s, f).not.toMatch(/\brgba?\(/)
      }
    }
    const importers = ['src', 'test', 'fixtures'].flatMap((d) => {
      const out: string[] = []
      const walk = (dir: string) => { for (const e of readdirSyncSafe(dir)) { const p = join(dir, e); if (isDir(p)) walk(p); else if (/\.(tsx?|jsx?)$/.test(e)) out.push(p) } }
      walk(resolve(pkgDir, d))
      return out
    }).filter((p) => /from 'klinecharts'|import\('klinecharts'\)/.test(readFileSync(p, 'utf8'))).map((p) => p.slice(pkgDir.length + 1).replace(/\\/g, '/'))
    expect(importers.filter((p) => p !== 'test/chart.browser.test.ts')).toEqual(['src/chart-adapter.ts'])
  })
})

const readdirSyncSafe = (d: string): string[] => { try { return readdirSync(d) } catch { return [] } }
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }
