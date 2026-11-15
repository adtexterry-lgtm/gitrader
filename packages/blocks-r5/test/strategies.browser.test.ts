// SPDX-License-Identifier: CPAL-1.0
// 策略页（P6）真浏览器用例：夹具内核 + 真客户端 + 真宿主桥 + 无头 Edge（CDP 直连）。
// 壳的 r5 路由（S1）落地之前，三张卡直接挂在舞台页上（本文件里的 buildSite / HTML，不进 src/）；落地后由 T2 改走真壳。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchCdp } from './helpers/cdp'
import { startStage } from '../verify/stage-entry'
import { ACCT_HL, ACCT_PAPER, strategiesData } from '../fixtures/strategies'

const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const here = dirname(fileURLToPath(import.meta.url))
const pkgs = resolve(here, '../..')
const repo = resolve(pkgs, '..')
const shots = resolve(repo, 'reports/blocks-r5/P6-shots')
const mockPage = resolve(repo, 'reports/visual-r5/strategy/index.html')
const anchorFile = resolve(here, 'geo-anchors/strategy.json')
const geometrySource = readFileSync(resolve(pkgs, 'workbench/design/geometry-probe.js'), 'utf8')
const auditSource = readFileSync(resolve(pkgs, 'workbench/design/audit-probe.js'), 'utf8')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Cdp = Awaited<ReturnType<typeof launchCdp>>
type Run = Awaited<ReturnType<typeof startStage>>

// ---- 舞台页 -----------------------------------------------------------------------------

const png: Plugin = {
  name: 'png-bytes',
  setup(b) {
    b.onLoad({ filter: /\.png$/ }, (a) => ({ contents: `export default new Uint8Array([${[...readFileSync(a.path)].join(',')}])`, loader: 'js' }))
    b.onLoad({ filter: /\.svg$/ }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, 'utf8').trim())}`, loader: 'js' }))
  },
}

const ENTRY = (page: string) => `
import { render, h } from 'preact'
import { KernelClient, LinkHub, createHostBridge } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { strategiesBlocks } from ${JSON.stringify(page)}
const st = { pinMode: 'ok', asks: [], ready: false, error: '' }
window.__p6 = st
async function main() {
  const token = document.querySelector('meta[name="gitrader-bootstrap"]').getAttribute('content')
  const boot = await fetch('/api/session', { method: 'POST', body: JSON.stringify({ bootstrap: token }) }).then((r) => r.json())
  const client = new KernelClient({ url: 'ws://' + location.host + '/ui', getToken: () => boot.sessionToken, reconnect: false })
  client.setAttestor(async (req) => { st.asks.push(req.action); return st.pinMode === 'cancel' ? null : { method: 'pin', pin: '246810' } })
  await client.connect()
  const def = strategiesBlocks[0]
  const hub = new LinkHub({ A: {} })
  for (const [id, view] of [['a-list', 'list'], ['a-eng', 'engines'], ['a-ev', 'events']]) {
    const bridge = createHostBridge({ manifest: def.manifest, instanceId: 'bi_' + view, kernel: client, hub, trusted: true })
    render(h(BridgeContext.Provider, { value: bridge }, h(def.component, { bridge, instanceId: 'bi_' + view, config: { view }, setConfig() {}, channel: 'A', grid: { w: 15, h: 9 }, mode: 'tile' })), document.getElementById(id))
  }
  st.ready = true
}
main().catch((e) => { st.error = String((e && e.message) || e) })
`

const HTML = `<!doctype html>
<html lang="zh-CN" data-ui="r5" data-updown="intl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><!--BOOTSTRAP--><link rel="icon" href="data:,"><link rel="stylesheet" href="bundle.css"></head>
<body>
<main class="g5-frame">
  <div class="g5-topbar"></div>
  <section class="g5-fund" aria-hidden="true"></section>
  <div class="g5-ws">
    <div class="g5-col" data-col="left"><div id="a-list" style="display:contents"></div></div>
    <div class="g5-col" data-col="right"><div id="a-eng" style="display:contents"></div><div id="a-ev" style="display:contents"></div></div>
  </div>
</main>
<script src="bundle.js"></script>
</body>
</html>
`

async function buildSite(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true })
  await build({
    stdin: { contents: ENTRY(join(pkgs, 'blocks-r5/src/pages/strategies.tsx').replace(/\\/g, '/')), resolveDir: join(pkgs, 'blocks-r5'), loader: 'js' },
    outfile: join(dir, 'bundle.js'), bundle: true, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
    loader: { '.js': 'jsx', '.json': 'json', '.woff2': 'file' }, plugins: [png], logLevel: 'silent', absWorkingDir: pkgs,
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/compat/jsx-runtime' },
    define: { __GITRADER_VERSION__: '"test"', 'process.env.NODE_ENV': '"production"' },
  })
  writeFileSync(join(dir, 'index.html'), HTML)
  return dir
}

// ---- 浏览器小工具 -----------------------------------------------------------------------------

const J = (v: unknown) => JSON.stringify(v)
const ev = <T = unknown>(cdp: Cdp, expr: string) => cdp.evaluate(expr) as Promise<T>
async function waitFor(cdp: Cdp, expr: string, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ev(cdp, `Boolean(${expr})`)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}
async function box(cdp: Cdp, sel: string, index = 0) {
  const r = await ev<{ x: number; y: number; w: number; h: number } | null>(cdp, `(() => { const e = document.querySelectorAll(${J(sel)})[${index}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  if (!r) throw new Error(`no element ${sel}[${index}]`)
  return r
}
async function click(cdp: Cdp, sel: string, index = 0): Promise<void> {
  const r = await box(cdp, sel, index)
  const x = r.x + r.w / 2
  const y = r.y + r.h / 2
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
async function key(cdp: Cdp, k: 'Escape' | 'Enter'): Promise<void> {
  const code = k === 'Escape' ? 27 : 13
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code })
}
async function fill(cdp: Cdp, sel: string, text: string): Promise<void> {
  await ev(cdp, `(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select() })()`)
  await cdp.send('Input.insertText', { text })
}
const textOf = (cdp: Cdp, sel: string, index = 0) => ev<string>(cdp, `(document.querySelectorAll(${J(sel)})[${index}]?.textContent ?? '').trim()`)
const countOf = (cdp: Cdp, sel: string) => ev<number>(cdp, `document.querySelectorAll(${J(sel)}).length`)
const setWidth = async (cdp: Cdp, width: number) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(cdp, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
}
async function shot(cdp: Cdp, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true })
  writeFileSync(join(shots, name), await cdp.screenshot())
}
const problem = (name: string, code: number, message: string) => Object.assign(new Error(message), { code, data: { code, name, message, category: 'PROTOCOL', retryable: false } })
const cmds = (run: Run, action: string) => run.kernel.commands.filter((c) => c.action === action)

type Geometry = Record<'overflow' | 'truncated' | 'halfRows' | 'escape' | 'overlap' | 'badFont' | 'badSpace' | 'align' | 'numcol', string[]> & { docScrollX: number; alignOk: number }
async function geometry(cdp: Cdp): Promise<Geometry> {
  // geometry-probe.js（T1）有两处 internal(el) 漏传 selectors，在注入时补上；探针修好后这行替换是空操作
  await ev(cdp, geometrySource.replaceAll('internal(el)', 'internal(el,selectors)'))
  const out = await ev<Geometry & { __error?: string }>(cdp, `(() => { try { return window.__grGeometry.run() } catch (e) { return { __error: String((e && e.stack) || e) } } })()`)
  if (out.__error) throw new Error(out.__error)
  return out
}
const GEOM_FIELDS = ['overflow', 'truncated', 'halfRows', 'escape', 'overlap', 'badFont', 'badSpace', 'align', 'numcol'] as const
const geomCounts = (g: Geometry) => ({ docScrollX: g.docScrollX, ...Object.fromEntries(GEOM_FIELDS.map((f) => [f, g[f].length])) })

// 锚点：视觉稿（mock 选择器）与产品（mine 选择器）上同一处的矩形，容差 ±4 px
const A = (name: string, mock: string, mine: string, index = 0) => ({ name, mock, mine, index })
const ANCHORS = [
  A('list-card', '#strat', '[data-view="list"]'), A('engines-card', '#eng', '[data-view="engines"]'), A('events-card', '#engev', '[data-view="events"]'),
  A('list-title', '#strat .hd h2', '[data-view="list"] .g5-hd h2'), A('list-tabs', '#strat .tabs', '[data-view="list"] .g5-tabs'), A('bind-button', '#bindbtn', '[data-act="bind-open"]'),
  ...[1, 2, 3, 4, 5, 6].map((i) => A(`th-${i}`, `#strat thead th:nth-child(${i})`, `[data-view="list"] thead th:nth-child(${i})`)),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => A(`row-${i}`, `#strat tbody tr:nth-child(${i})`, `[data-view="list"] tbody tr:nth-child(${i})`)),
  A('x-params', '#strat .xpar', '[data-view="list"] .g5-xpar'), A('x-values', '#strat .pv', '[data-view="list"] .g5-pv'), A('x-events', '#strat .xev', '[data-view="list"] .g5-xev'),
  A('krow-1', '#eng .krow', '[data-view="engines"] .g5-krow', 0), A('krow-2', '#eng .krow', '[data-view="engines"] .g5-krow', 1),
  ...Array.from({ length: 9 }, (_, i) => A(`event-${i + 1}`, '#engev .ar', '[data-view="events"] .g5-ar', i)),
]

// ---- 用例 -----------------------------------------------------------------------------

describe('strategies page in a real browser', () => {
  let site = ''
  let cdp: Cdp
  const runs: Run[] = []

  const open = async (scenario: string, prepare?: (run: Run) => void | Promise<void>): Promise<Run> => {
    const run = await startStage({ staticDir: site, workspacesDir: join(home, `p6-ws-${runs.length}-${Date.now()}`), scenario })
    runs.push(run)
    if (prepare) await prepare(run)
    await cdp.navigate(`${run.kernel.url}/`)
    await waitFor(cdp, 'window.__p6 && (window.__p6.ready || window.__p6.error)', 'page boot')
    expect(await ev<string>(cdp, 'window.__p6.error')).toBe('')
    return run
  }
  const settled = async () => { await waitFor(cdp, '!document.querySelector(".g5-sk")', 'skeletons gone'); await sleep(250) }

  beforeAll(async () => {
    site = await buildSite(join(home, 'p6-site'))
    cdp = await launchCdp({ width: 1440, height: 900 })
  }, 120_000)
  afterAll(async () => {
    await cdp?.close()
    for (const r of runs) await r.kernel.close().catch(() => undefined)
  })

  it('renders the seven strategies, two engines and nine events from the fixture', async () => {
    await open('strategies-normal')
    await settled()
    expect(await countOf(cdp, '[data-view="list"] tbody tr[data-strategy]')).toBe(7)
    expect(await textOf(cdp, '[data-view="list"] .g5-hd .g5-ct')).toBe('7')
    expect(await textOf(cdp, '[data-view="list"] .g5-tab[aria-selected="true"]')).toBe('全部7')
    expect(await countOf(cdp, '[data-view="engines"] .g5-krow')).toBe(2)
    expect(await countOf(cdp, '[data-view="events"] .g5-ar')).toBe(9)
    expect(await textOf(cdp, '[data-view="list"] tr[data-strategy="ema-trend"]')).toContain('EXP-0009 小额实盘')
    expect(await textOf(cdp, '[data-view="list"] tr[data-strategy="ema-trend"]')).toContain('最近成交 8 分钟前')
    expect(await textOf(cdp, '[data-view="list"] tr[data-strategy="breakout-vol"]')).toContain("on_bar KeyError: 'atr_14'")
    expect(await textOf(cdp, '[data-view="list"] tr[data-strategy="funding-carry"] [data-act="promote"]')).toBe('去晋级')
    expect(await countOf(cdp, '[data-view="list"] tr[data-strategy="funding-carry"] [data-act="start-strategy"]')).toBe(0)
    // fix-r3 K-r5-11（裁决依据：WI-F17——「启动」接通，点了先展开行内表单填标的与周期）：已停的纸面行启动键可用、不再标未接通
    expect(await ev(cdp, `(() => { const b = document.querySelector('tr[data-strategy="mean-rev"] [data-act="start-strategy"]'); return !!b && !b.disabled && b.getAttribute('data-wire') !== 'off' })()`)).toBe(true)
    expect(cdp.errors).toEqual([])
  })

  it('filter tabs count and narrow by state', async () => {
    await open('strategies-normal')
    await settled()
    expect(await ev(cdp, `[...document.querySelectorAll('[data-view="list"] .g5-tab')].map((t) => t.textContent)`)).toEqual(['全部7', '运行2', '已停4', '出错1', '可用2'])
    await click(cdp, '[data-filter="error"]')
    await waitFor(cdp, 'document.querySelectorAll("[data-view=list] tbody tr[data-strategy]").length === 1', 'error filter')
    expect(await textOf(cdp, '[data-view="list"] tr[data-strategy] .g5-sym')).toBe('breakout-vol')
  })

  it('GQ-11 可用: lists loaded strategies with documented parameter names and starts a new instance', async () => {
    const run = await open('strategies-normal')
    await settled()
    await click(cdp, '[data-filter="catalog"]')
    await waitFor(cdp, 'document.querySelectorAll("[data-table=catalog] tr[data-catalog]").length === 2', 'catalog rows')
    expect(await countOf(cdp, '[data-table="catalog"] tr[data-failure="python-local"]')).toBe(1)
    await click(cdp, 'tr[data-catalog="grid"] [data-act="catalog-start"]')
    await waitFor(cdp, 'document.querySelector("[data-form=start-new]")', 'start form')
    expect(await ev(cdp, `[...document.querySelectorAll('[data-form="start-new"] [data-param]')].map((e) => e.getAttribute('data-param'))`)).toEqual(['center', 'rangeRatio', 'grids', 'maxExposure', 'lowerPrice', 'upperPrice', 'gridMode', 'boundaryAction'])
    expect(await textOf(cdp, '[data-act="new-account"]')).toBe('paper-1') // 只有绑定到该引擎的纸面账户
    await fill(cdp, '#np-instruments', 'hyperliquid:BTC')
    await fill(cdp, '#np-grids', '1')
    await click(cdp, '[data-act="new-confirm"]')
    await waitFor(cdp, 'document.querySelector("[data-form=start-new] .g5-sx-err")', 'field error')
    expect(await textOf(cdp, '[data-form="start-new"] .g5-sx-err')).toBe('grids 必须在 2–50 之间')
    expect(await ev(cdp, `document.querySelector('#np-grids').getAttribute('aria-invalid')`)).toBe('true')
    await fill(cdp, '#np-grids', '10')
    await fill(cdp, '#np-lowerPrice', '110000')
    await fill(cdp, '#np-upperPrice', '90000')
    await click(cdp, '[data-act="new-confirm"]')
    await waitFor(cdp, 'document.querySelector("#np-upperPrice[aria-invalid=true]")', 'cross-field error')
    expect(await textOf(cdp, '[data-form="start-new"] .g5-sx-err')).toBe('upperPrice 必须大于 lowerPrice')
    expect(cmds(run, 'engine.call')).toHaveLength(0)
    await fill(cdp, '#np-lowerPrice', '0')
    await fill(cdp, '#np-upperPrice', '0')
    await click(cdp, '[data-act="new-confirm"]')
    await waitFor(cdp, '!document.querySelector("[data-form=start-new]")', 'form closed')
    const calls = cmds(run, 'engine.call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual({ id: 'ts-builtin', method: 'strategy.start', params: { strategyId: 'grid', accountId: ACCT_PAPER, instruments: ['hyperliquid:BTC'], interval: '15m', params: { center: 0, rangeRatio: 0.1, grids: 10, maxExposure: 1, lowerPrice: 0, upperPrice: 0, gridMode: 'arithmetic', boundaryAction: 'pause' } } })
    expect(await textOf(cdp, '[data-view="list"] .g5-tab[aria-selected="true"]')).toBe('全部7')
    expect(cdp.errors).toEqual([])
  })

  it('GQ-11 可用: no instances yet lands on 可用 once; catalog failure shows the kernel text', async () => {
    await open('strategies-normal', (run) => { run.kernel.onQuery('engine.strategies', async () => []) })
    await settled()
    await waitFor(cdp, 'document.querySelector("[data-filter=catalog][aria-selected=true]")', 'auto catalog tab')
    expect(await countOf(cdp, '[data-table="catalog"] tr[data-catalog]')).toBe(2)
    await open('strategies-normal', (run) => { run.kernel.onQuery('engine.catalog', async () => ({ ok: false, error: { code: 5001, name: 'ENGINE_UNAVAILABLE', message: 'ENGINE_UNAVAILABLE engine.catalog', category: 'ENGINE', retryable: false } })) })
    await settled()
    await click(cdp, '[data-filter="catalog"]')
    await waitFor(cdp, 'document.querySelector("[data-view=list] [data-state=error]")', 'catalog error')
    expect(await textOf(cdp, '[data-view="list"] [data-state="error"]')).toContain('ENGINE_UNAVAILABLE engine.catalog')
  })

  it('parameters open read-only and only switch to inputs after 编辑', async () => {
    await open('strategies-normal')
    await settled()
    await click(cdp, 'tr[data-strategy="grid-paper"] [data-act="expand"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow")', 'expanded row')
    expect(await countOf(cdp, '.g5-xrow input')).toBe(0)
    expect(await countOf(cdp, '.g5-xrow .g5-pv .g5-k')).toBe(6)
    await click(cdp, '[data-act="edit-params"]')
    await waitFor(cdp, 'document.querySelectorAll(".g5-xrow input").length === 6', 'inputs')
    await click(cdp, '[data-act="edit-cancel"]')
    await waitFor(cdp, 'document.querySelectorAll(".g5-xrow input").length === 0', 'back to read-only')
  })

  // ---- 几何 / 锚点 / 体检 -------------------------------------------------------------------

  it('geometry probe is all zero at 1280, 1440 and 1920 with a row expanded', async () => {
    await open('strategies-normal')
    await settled()
    await click(cdp, 'tr[data-strategy="grid-paper"] [data-act="expand"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow")', 'expanded row')
    const seen: Record<number, unknown> = {}
    for (const width of [1280, 1440, 1920]) {
      await setWidth(cdp, width)
      const g = await geometry(cdp)
      seen[width] = geomCounts(g)
      for (const f of GEOM_FIELDS) expect(g[f], `${width}px ${f}`).toEqual([])
      expect(g.docScrollX, `${width}px horizontal scroll`).toBe(0)
      expect(g.alignOk, `${width}px aligned items checked`).toBeGreaterThan(10)
      await shot(cdp, `strategies-${width}.png`)
    }
    expect(Object.keys(seen)).toHaveLength(3)
    expect(cdp.errors).toEqual([])
  })

  it('audit probe: at most one glow and one solid primary on screen', async () => {
    await open('strategies-normal')
    await settled()
    const audit = await ev<{ glow: number; solidOrange: number; sizeViolations: number; cjk11: number; orb: number }>(cdp, auditSource)
    expect(audit.glow).toBeLessThanOrEqual(1)
    expect(audit.solidOrange).toBeLessThanOrEqual(1)
    expect(audit.cjk11).toBe(0)
  })

  it('card, table and row rectangles match the visual draft within 4 px', async () => {
    type Rect = { x: number; y: number; width: number; height: number }
    const measure = (selectors: 'mock' | 'mine') => ev<Record<string, Rect | null>>(cdp, `(() => { const out = {}; for (const a of ${J(ANCHORS)}) { const e = document.querySelectorAll(a[${J(selectors)}])[a.index]; if (!e) { out[a.name] = null; continue } const r = e.getBoundingClientRect(); out[a.name] = { x: r.left, y: r.top, width: r.width, height: r.height } } return out })()`)
    if (process.env.P6_RECORD === '1') {
      // 重录：量视觉稿本身（file://，三个宽度，稿默认就展开 grid-paper），写回 geo-anchors/strategy.json
      const rects: Record<string, Record<string, Rect>> = {}
      await cdp.navigate(pathToFileURL(mockPage).href)
      await sleep(1200)
      for (const width of [1280, 1440, 1920]) {
        await setWidth(cdp, width)
        const got = await measure('mock')
        for (const [name, r] of Object.entries(got)) expect(r, `draft ${width} ${name}`).not.toBeNull()
        rects[String(width)] = got as Record<string, Rect>
      }
      writeFileSync(anchorFile, JSON.stringify({ source: 'reports/visual-r5/strategy/index.html', tolerancePx: 4, anchors: ANCHORS.map(({ name, mock, mine, index }) => ({ name, mock, mine, index })), rects }, null, 1) + '\n')
    }
    const spec = JSON.parse(readFileSync(anchorFile, 'utf8')) as { rects?: Record<string, Record<string, Rect>> }
    expect(spec.rects, 'run once with P6_RECORD=1 to record the draft rectangles').toBeDefined()
    expect(Object.keys(spec.rects!['1440']!).length).toBe(ANCHORS.length)
    await open('strategies-normal')
    await settled()
    await click(cdp, 'tr[data-strategy="grid-paper"] [data-act="expand"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow")', 'expanded row')
    const bad: string[] = []
    for (const width of [1280, 1440, 1920]) {
      await setWidth(cdp, width)
      const rects = await measure('mine')
      for (const a of ANCHORS) {
        const want = spec.rects![String(width)]?.[a.name]
        const got = rects[a.name]
        if (!want || !got) { bad.push(`${width} ${a.name} missing`); continue }
        for (const f of ['x', 'y', 'width', 'height'] as const) if (Math.abs(got[f] - want[f]) > 4) bad.push(`${width} ${a.name}.${f} mine=${got[f].toFixed(1)} draft=${want[f].toFixed(1)}`)
      }
    }
    expect(bad).toEqual([])
  })

  // ---- 四态 + 未接通 + 离线 -----------------------------------------------------------------

  it('loading: skeletons show while the queries are slow', async () => {
    await open('strategies-loading', (run) => { run.kernel.onQuery('ledger.query', async () => { await sleep(2500); return strategiesData.LEDGER }) })
    await waitFor(cdp, 'document.querySelector("[data-view=list] .g5-sk") && document.querySelector("[data-view=engines] .g5-sk") && document.querySelector("[data-view=events] .g5-sk")', 'three skeletons', 4000)
    await shot(cdp, 'strategies-loading.png')
    const g = await geometry(cdp)
    for (const f of GEOM_FIELDS) expect(g[f], `loading ${f}`).toEqual([])
    await settled()
    expect(await countOf(cdp, '[data-view="list"] tbody tr[data-strategy]')).toBe(7)
  })

  it('empty: one fact and a copyable command', async () => {
    await open('strategies-empty')
    await waitFor(cdp, 'document.querySelector("[data-view=list] [data-state=empty]")', 'empty list')
    // fix-r4: 左栏是策略列表，空时写「还没有策略」且不给命令；命令只在右栏引擎列表空时给
    expect(await textOf(cdp, '[data-view="list"] [data-state="empty"]')).toContain('还没有策略')
    expect(await textOf(cdp, '[data-view="engines"] .g5-sx-cmd')).toBe('gitrader engines list')
    expect(await textOf(cdp, '[data-view="events"] [data-state="empty"]')).toBe('还没有引擎事件')
    await shot(cdp, 'strategies-empty.png')
    const g = await geometry(cdp)
    for (const f of GEOM_FIELDS) expect(g[f], `empty ${f}`).toEqual([])
  })

  it('error: the kernel text is shown verbatim on all three cards', async () => {
    await open('strategies-error')
    await waitFor(cdp, 'document.querySelectorAll("[data-state=error]").length === 3', 'three errors')
    expect(await textOf(cdp, '[data-view="list"] [data-state="error"] .g5-msg [data-err-detail] .gr-errd__v')).toBe('ENGINE_UNAVAILABLE python-local') // ux-fix2 B2：同一规格变更（Owner 令，总控批准）——原文在该报错的详情里
    expect(await textOf(cdp, '[data-view="engines"] [data-state="error"] .g5-msg [data-err-detail] .gr-errd__v')).toBe('KERNEL_UNAVAILABLE engine.list') // ux-fix2 B2：同一规格变更（Owner 令，总控批准）——原文在该报错的详情里
    expect(await textOf(cdp, '[data-view="events"] [data-state="error"] .g5-msg [data-err-detail] .gr-errd__v')).toBe('LEDGER_LOCKED ledger.query') // ux-fix2 B2：同一规格变更（Owner 令，总控批准）——原文在该报错的详情里
    await shot(cdp, 'strategies-error.png')
    const g = await geometry(cdp)
    for (const f of GEOM_FIELDS) expect(g[f], `error ${f}`).toEqual([])
  })

  it('unwired: a missing kernel method shows 未接通 with the original text and no retry', async () => {
    await open('strategies-unwired')
    await waitFor(cdp, 'document.querySelectorAll("[data-state=unwired]").length >= 2', 'unwired cards')
    expect(await textOf(cdp, '[data-view="list"] [data-state="unwired"]')).toBe('未接通未知查询 engine.strategies')
    expect(await textOf(cdp, '[data-view="engines"] [data-state="unwired"]')).toBe('未接通未知查询 engine.list')
    expect(await countOf(cdp, '[data-state="unwired"] [data-act="read-retry"]')).toBe(0)
    expect(await countOf(cdp, '[data-state="unwired"] [data-wire="off"]')).toBeGreaterThanOrEqual(2)
    await shot(cdp, 'strategies-unwired.png')
    const g = await geometry(cdp)
    for (const f of GEOM_FIELDS) expect(g[f], `unwired ${f}`).toEqual([])
  })

  it('offline: data stays, the cards dim, buttons lock and the pause time shows', async () => {
    await open('strategies-offline')
    await settled()
    await ev(cdp, `document.documentElement.setAttribute('data-offline', '')`)
    await waitFor(cdp, 'document.querySelectorAll(".g5-card.g5-off").length === 3', 'three dimmed cards')
    expect(await textOf(cdp, '[data-view="list"] .g5-hd')).toMatch(/已暂停更新 · \d{2}:\d{2}/)
    expect(await ev(cdp, `[...document.querySelectorAll('[data-act="stop-strategy"], [data-act="stop-engine"]')].every((b) => b.disabled)`)).toBe(true)
    expect(await countOf(cdp, '[data-view="list"] tbody tr[data-strategy]')).toBe(7)
    await shot(cdp, 'strategies-offline.png')
    const g = await geometry(cdp)
    for (const f of GEOM_FIELDS) expect(g[f], `offline ${f}`).toEqual([])
  })

  it('has no gain/loss colouring: flipping 红涨绿跌 changes nothing on this page', async () => {
    await open('strategies-normal')
    await settled()
    const snapshot = () => ev<string>(cdp, `JSON.stringify([...document.querySelectorAll('body *')].map((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderTopColor] }))`)
    const intl = await snapshot()
    await ev(cdp, `document.documentElement.setAttribute('data-updown', 'cn')`)
    await sleep(100)
    expect(await snapshot()).toBe(intl)
    expect(await ev(cdp, `(() => { const r = getComputedStyle(document.documentElement); const up = r.getPropertyValue('--gr-up').trim(); const down = r.getPropertyValue('--gr-down').trim(); return up !== '' && down !== '' && up !== down })()`)).toBe(true)
  })

  // ---- 旅程 -----------------------------------------------------------------------------

  it('stopping a strategy is two steps, the consequence comes first, and the command matches the contract', async () => {
    const run = await open('strategies-normal')
    await settled()
    await click(cdp, 'tr[data-strategy="ema-trend"] [data-act="stop-strategy"]')
    await waitFor(cdp, 'document.querySelector("[data-armed]")', 'armed bar')
    expect(await textOf(cdp, '[data-armed] .g5-what')).toBe('停止 ema-trend：不会自动平仓，持仓与挂单保留')
    expect(await ev(cdp, `document.activeElement?.getAttribute('data-act')`)).toBe('stop-strategy-cancel')
    expect(cmds(run, 'engine.call')).toHaveLength(0)
    await click(cdp, '[data-act="stop-strategy-confirm"]') // 600 ms 死区内：不算数
    await sleep(150)
    expect(cmds(run, 'engine.call')).toHaveLength(0)
    await click(cdp, '[data-act="stop-strategy-cancel"]')
    await waitFor(cdp, '!document.querySelector("[data-armed]")', 'bar closed')
    await click(cdp, 'tr[data-strategy="ema-trend"] [data-act="stop-strategy"]')
    await waitFor(cdp, 'document.querySelector("[data-armed]")', 'armed again')
    await key(cdp, 'Escape')
    await waitFor(cdp, '!document.querySelector("[data-armed]")', 'Esc closes')
    await click(cdp, 'tr[data-strategy="ema-trend"] [data-act="stop-strategy"]')
    await waitFor(cdp, 'document.querySelector("[data-armed]")', 'armed third time')
    await sleep(700)
    await click(cdp, '[data-act="stop-strategy-confirm"]')
    await sleep(300)
    const calls = cmds(run, 'engine.call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual({ id: 'ts-builtin', method: 'strategy.stop', params: { instanceId: strategiesData.STRATEGIES[0]!.instanceId } })
  })

  it('stopping an engine says how many strategies stop with it', async () => {
    const run = await open('strategies-normal')
    await settled()
    await click(cdp, '[data-engine="ts-builtin"] [data-act="stop-engine"]')
    await waitFor(cdp, 'document.querySelector("[data-view=engines] [data-armed]")', 'armed engine row')
    expect(await textOf(cdp, '[data-view="engines"] [data-armed] .g5-what')).toBe('停止 ts-builtin：2 个策略随之停止，持仓保留')
    await shot(cdp, 'strategies-stop-engine.png')
    const g = await geometry(cdp)
    for (const f of GEOM_FIELDS) expect(g[f], `armed engine ${f}`).toEqual([])
    await sleep(700)
    await click(cdp, '[data-act="stop-engine-confirm"]')
    await sleep(400)
    expect(cmds(run, 'engine.stop').map((c) => c.params)).toEqual([{ id: 'ts-builtin' }])
  })

  it('a failed stop keeps the bar open with the kernel text and allows a retry', async () => {
    const run = await open('strategies-normal', (r) => { r.kernel.onCommand('engine.call', () => { throw problem('ENGINE_CALL_FAILED', 5001, 'engine ts-builtin did not answer in 15000 ms') }) })
    await settled()
    await click(cdp, 'tr[data-strategy="grid-paper"] [data-act="stop-strategy"]')
    await waitFor(cdp, 'document.querySelector("[data-armed]")', 'armed')
    await sleep(700)
    await click(cdp, '[data-act="stop-strategy-confirm"]')
    await waitFor(cdp, 'document.querySelector("[data-armed] [role=alert]")', 'inline error')
    expect(await textOf(cdp, '[data-armed] [role="alert"] [data-err-detail] .gr-errd__v')).toBe('engine ts-builtin did not answer in 15000 ms') // ux-fix2 B2：Owner 令，总控批准的规格变更——上游原文收进详情
    expect(cmds(run, 'engine.call')).toHaveLength(1)
    await click(cdp, '[data-act="stop-strategy-confirm"]')
    await sleep(300)
    expect(cmds(run, 'engine.call')).toHaveLength(2)
  })

  it('binding an engine goes through the PIN layer and sends the accounts to bind', async () => {
    const lone = { id: 'local-new', enabled: true, builtin: false, state: 'ready', transport: 'stdio', remote: false, pid: 77, restarts: 0, since: Date.now(), gep: { engineId: 'local-new', state: 'ready', sessionId: 's', bound: false, accounts: [], lost: false, placeCalls: 0, proposalCalls: 0, engine: 'local-new@0.1.0' } }
    const run = await open('strategies-normal', (r) => {
      r.kernel.onQuery('engine.list', () => [lone])
      r.kernel.onCommand('engine.bind', (_p, ctx) => { if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '绑定引擎需要在场证明'); return { bindingId: 'bind_x', warnings: [] } })
    })
    await settled()
    await click(cdp, '[data-act="bind-open"]')
    await waitFor(cdp, 'document.querySelector("[role=dialog]")', 'bind popover')
    expect(await textOf(cdp, '[role="dialog"] [role="option"]')).toContain('paper-1')
    expect(await countOf(cdp, '[role="dialog"] [role="option"]')).toBe(1)
    expect(await textOf(cdp, '[role="dialog"] .g5-fact')).toBe('实盘账户另签授权书后绑定')
    await shot(cdp, 'strategies-bind.png')
    const g = await geometry(cdp)
    for (const f of GEOM_FIELDS) expect(g[f], `bind popover ${f}`).toEqual([])
    await click(cdp, '[data-act="bind-confirm"]')
    await waitFor(cdp, '!document.querySelector("[role=dialog]")', 'popover closes after the bind')
    const calls = cmds(run, 'engine.bind')
    expect(calls.map((c) => !!c.attestation)).toEqual([false, true])
    expect(calls[1]!.params).toEqual({ id: 'local-new', accounts: [ACCT_PAPER] })
    expect(await ev(cdp, 'window.__p6.asks')).toEqual(['engine.bind'])
  })

  it('cancelling the PIN layer means the bind did not happen and the popover stays', async () => {
    const lone = { id: 'local-new', enabled: true, builtin: false, state: 'ready', since: Date.now(), gep: { accounts: [], lost: false } }
    const run = await open('strategies-normal', (r) => {
      r.kernel.onQuery('engine.list', () => [lone])
      r.kernel.onCommand('engine.bind', (_p, ctx) => { if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '绑定引擎需要在场证明'); return { bindingId: 'bind_x', warnings: [] } })
    })
    await settled()
    await ev(cdp, `window.__p6.pinMode = 'cancel'`)
    await click(cdp, '[data-act="bind-open"]')
    await waitFor(cdp, 'document.querySelector("[role=dialog]")', 'bind popover')
    await click(cdp, '[data-act="bind-confirm"]')
    await sleep(500)
    expect(await countOf(cdp, '[role="dialog"]')).toBe(1)
    expect(await countOf(cdp, '[role="dialog"] [role="alert"]')).toBe(0)
    expect(cmds(run, 'engine.bind').map((c) => !!c.attestation)).toEqual([false])
  })

  it('an engine that already holds a live binding is not re-bound from the page', async () => {
    const run = await open('strategies-normal')
    await settled()
    await click(cdp, '[data-act="bind-open"]')
    await waitFor(cdp, 'document.querySelector("[role=dialog]")', 'bind popover')
    expect(await textOf(cdp, '[role="dialog"] .g5-fact[data-state="blocked"]')).toContain('已绑定实盘账户')
    expect(await ev(cdp, 'document.querySelector("[data-act=bind-confirm]").disabled')).toBe(true)
    expect(cmds(run, 'engine.bind')).toHaveLength(0)
    await key(cdp, 'Escape')
    await waitFor(cdp, '!document.querySelector("[role=dialog]")', 'Esc closes the popover')
  })

  it('changing a live strategy parameter goes through the PIN layer; a paper one does not', async () => {
    const run = await open('strategies-normal', (r) => {
      r.kernel.onCommand('engine.call', (p, ctx) => {
        const q = p as { method: string; params: { instanceId: string } }
        const live = strategiesData.STRATEGIES.find((s) => s.instanceId === q.params.instanceId)?.accountId === ACCT_HL
        if (q.method === 'strategy.update' && live && !ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '改实盘策略参数需要在场证明')
        return { status: 'running', appliedAt: Date.now() }
      })
    })
    await settled()
    await click(cdp, 'tr[data-strategy="ema-trend"] [data-act="expand"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow")', 'expanded')
    await click(cdp, '[data-act="edit-params"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow input")', 'inputs')
    await fill(cdp, 'input[aria-label="fast"]', 'abc')
    await click(cdp, '[data-act="edit-save"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow [role=alert]")', 'inline validation')
    expect(await textOf(cdp, '.g5-xrow [role="alert"]')).toBe('fast 需要数字')
    expect(cmds(run, 'engine.call')).toHaveLength(0)
    await fill(cdp, 'input[aria-label="fast"]', '30')
    await click(cdp, '[data-act="edit-save"]')
    await waitFor(cdp, '!document.querySelector(".g5-xrow input")', 'back to read-only after the save')
    const calls = cmds(run, 'engine.call')
    expect(calls.map((c) => !!c.attestation)).toEqual([false, true])
    expect(calls[1]!.params).toEqual({ id: 'ts-builtin', method: 'strategy.update', params: { instanceId: strategiesData.STRATEGIES[0]!.instanceId, params: { fast: 30 } } })
    expect(await ev(cdp, 'window.__p6.asks')).toEqual(['engine.call'])
    // 纸面策略：不弹 PIN
    await click(cdp, 'tr[data-strategy="grid-paper"] [data-act="expand"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow")', 'expanded paper row')
    await click(cdp, '[data-act="edit-params"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow input")', 'paper inputs')
    await fill(cdp, 'input[aria-label="grids"]', '24')
    await click(cdp, '[data-act="edit-save"]')
    await waitFor(cdp, '!document.querySelector(".g5-xrow input")', 'paper save done')
    const paper = cmds(run, 'engine.call').at(-1)!
    expect(paper.attestation).toBeUndefined()
    expect(paper.params).toMatchObject({ method: 'strategy.update', params: { params: { grids: 24 } } })
    expect(await ev(cdp, 'window.__p6.asks')).toEqual(['engine.call'])
  })

  it('new events slide in on top and do not move a reader who has scrolled down', async () => {
    const base = strategiesData.LEDGER
    const many = Array.from({ length: 36 }, (_, i) => ({ ...base[i % base.length]!, seq: 2000 + i, id: `led_many_${i}`, ts: Date.now() - (i + 1) * 60_000, payload: { message: `事件 ${i}` }, type: 'engine.event' }))
    const run = await open('strategies-normal', (r) => { r.kernel.onQuery('ledger.query', () => many) })
    await waitFor(cdp, 'document.querySelectorAll("[data-view=events] .g5-ar").length === 36', 'long list')
    const scroller = '[data-view="events"] .g5-sx-evs'
    expect(await ev(cdp, `(() => { const e = document.querySelector(${J(scroller)}); return e.scrollHeight > e.clientHeight })()`)).toBe(true)
    // 读者翻到了下面
    await ev(cdp, `document.querySelector(${J(scroller)}).scrollTop = 160`)
    await sleep(100)
    const probeKey = await ev<string>(cdp, `(() => { const s = document.querySelector(${J(scroller)}); const top = s.getBoundingClientRect().top; return [...s.querySelectorAll('[data-key]')].find((r) => r.getBoundingClientRect().top >= top + 8).dataset.key })()`)
    const before = (await box(cdp, `[data-key="${probeKey}"]`)).y
    const fresh = (n: number) => ({ ...many[0]!, seq: 3000 + n, id: `led_new_${n}`, ts: Date.now(), payload: { message: `新事件 ${n}` } })
    expect(run.kernel.publish('ledger.entry', fresh(1))).toBeGreaterThan(0)
    await waitFor(cdp, 'document.querySelectorAll("[data-view=events] .g5-ar").length === 37', 'new row added')
    await sleep(500)
    expect(await ev<number>(cdp, `document.querySelector(${J(scroller)}).scrollTop`)).toBeGreaterThan(160)
    expect(Math.abs((await box(cdp, `[data-key="${probeKey}"]`)).y - before)).toBeLessThanOrEqual(1)
    // 读者在顶部：新事件排第一并留在视野里
    await ev(cdp, `document.querySelector(${J(scroller)}).scrollTop = 0`)
    await sleep(100)
    run.kernel.publish('ledger.entry', fresh(2))
    await waitFor(cdp, 'document.querySelectorAll("[data-view=events] .g5-ar").length === 38', 'second new row')
    await sleep(400)
    expect(await textOf(cdp, '[data-view="events"] .g5-ar:first-child .g5-l1')).toBe('新事件 2')
    expect(await ev<number>(cdp, `document.querySelector(${J(scroller)}).scrollTop`)).toBe(0)
  })

  it('writes the side-by-side comparison with the draft', async () => {
    await open('strategies-normal')
    await settled()
    await click(cdp, 'tr[data-strategy="grid-paper"] [data-act="expand"]')
    await waitFor(cdp, 'document.querySelector(".g5-xrow")', 'expanded row')
    await setWidth(cdp, 1440)
    await shot(cdp, 'strategies-1440.png')
    const draft = resolve(repo, 'reports/visual-r5/strategy/strategy-1440.png')
    expect(existsSync(draft)).toBe(true)
    const page = join(shots, 'compare.html')
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><body style="margin:0;display:flex;gap:16px;background:#222"><img src="file:///${draft.replace(/\\/g, '/')}" width="1440"><img src="file:///${join(shots, 'strategies-1440.png').replace(/\\/g, '/')}" width="1440"></body>`)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2896, height: 900, deviceScaleFactor: 1, mobile: false })
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: pathToFileURL(page).href })
    await loaded
    await sleep(800)
    await shot(cdp, 'compare-1440.png')
  })
})
