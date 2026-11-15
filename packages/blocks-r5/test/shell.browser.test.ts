// SPDX-License-Identifier: CPAL-1.0
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type PluginBuild } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { launchCdp } from './helpers/cdp'
import { designSet, installChartHandlers } from '../fixtures/chart'
import { overviewScenario } from '../fixtures/overview'
import { bigSet, recordsQuery } from '../fixtures/records'
import { startStage } from '../verify/stage-entry'
import type { Scenario } from '../../blocks-default/fixtures/scenarios'

// 缺省自建系统临时 home（收尾清掉）；显式给了 GITRADER_HOME 才校验它是现成目录。证据与截图写 GITRADER_SHOTS_DIR，缺省在 home 下，不碰 reports/。
let home = process.env.GITRADER_HOME ?? ''
let ownedHome = ''
if (home) {
  if (!existsSync(home) || !statSync(home).isDirectory()) throw new Error('GITRADER_HOME is not an existing directory')
} else {
  ownedHome = mkdtempSync(join(tmpdir(), 'gitrader-s1-'))
  home = ownedHome
  process.env.GITRADER_HOME = home
}

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const workbench = join(repo, 'packages/workbench')
const outRoot = process.env.GITRADER_SHOTS_DIR || join(home, 's1-out')
const evidence = join(outRoot, 's1-evidence')
const ownedLog = join(evidence, 'b2a-browser-owned.log')
const s1Shots = join(outRoot, 's1-shots')
mkdirSync(evidence, { recursive: true })
mkdirSync(s1Shots, { recursive: true })
const chartSymbol = 'hyperliquid:ETH'
const alternateChartSymbol = 'hyperliquid:BTC'
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))

let tempDir = ''
let cdp: Awaited<ReturnType<typeof launchCdp>> | undefined
let fixture: Awaited<ReturnType<typeof startStage>> | undefined
let profileName = ''
let chartFixtureSet: ReturnType<typeof designSet> | undefined
let chartBaseScenario: Scenario | undefined
let chartBaseProposals: ReturnType<typeof designSet>['proposals'] | undefined

async function buildWorkbench(staticDir: string) {
  const twOut = join(staticDir, '.tw.css')
  const twCli = resolve(repo, 'node_modules/@tailwindcss/cli/dist/index.mjs')
  execFileSync(process.execPath, [twCli, '-i', join(workbench, 'src/ui/tw.css'), '-o', twOut, '--minify'], { cwd: workbench, stdio: ['ignore', 'ignore', 'pipe'] })
  const virtualTw = {
    name: 'b2a-virtual-tailwind',
    setup(builder: PluginBuild) {
      builder.onResolve({ filter: /^virtual:tw$/ }, () => ({ path: twOut, namespace: 'b2a-tw' }))
      builder.onLoad({ filter: /.*/, namespace: 'b2a-tw' }, async () => ({ contents: await readFileSync(twOut, 'utf8'), loader: 'css', resolveDir: join(workbench, 'src/ui') }))
    },
  }
  const legacyLayer = {
    name: 'b2a-legacy-layer',
    setup(builder: PluginBuild) {
      builder.onLoad({ filter: /[\\/](shell|blocks)\.css$/ }, async (args) => {
        const source = await readFileSync(args.path, 'utf8')
        return { contents: /@layer\s+gr-legacy\b/.test(source) ? source : `@layer gr-legacy {\n${source}\n}`, loader: 'css' }
      })
    },
  }
  const svgText = {
    name: 'b2a-svg-text',
    setup(builder: PluginBuild) {
      builder.onLoad({ filter: /\.svg$/ }, async (args) => ({ contents: `export default ${JSON.stringify((await readFileSync(args.path, 'utf8')).trim())}`, loader: 'js' }))
    },
  }
  const hubReadProbe = {
    name: 'b2a-r1-hub-read-probe',
    setup(builder: PluginBuild) {
      builder.onLoad({ filter: /app\.jsx$/ }, async (args) => {
        if (resolve(args.path) !== resolve(join(workbench, 'src', 'app.jsx'))) return null
        const source = readFileSync(args.path, 'utf8').replace(
          'const runtime = createRuntime()',
          "const runtime = createRuntime()\nwindow.__S1_HUB_GET__ = (channel, group) => runtime.hub.get(channel, group)\nwindow.__S1_MODE_FIXTURE__?.attach(runtime)",
        )
        return { contents: source, loader: 'jsx' }
      })
    },
  }
  await build({
    entryPoints: [join(workbench, 'src/app.jsx')],
    outfile: join(staticDir, 'app.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.js': 'jsx', '.woff2': 'file' },
    assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
    plugins: [virtualTw, legacyLayer, svgText, hubReadProbe],
    define: { __GITRADER_VERSION__: JSON.stringify('test'), 'process.env.NODE_ENV': '"production"' },
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  })
  const html = readFileSync(join(workbench, 'src/index.html'), 'utf8')
  const fixtureScript = `
window.__S1_MODE_FIXTURE__ = {
  state: { mode: 'docked', available: false, peer: false, hostAvailable: false, blocked: false }, listeners: new Set(), handlers: {}, calls: [], runtime: null, attestor: null, readyGate: null, releaseQuery: null, missingDefs: new Set(), resolveRegistry: null, queryCalls: [], queryOverrides: {}, realQuery: null, prefsWrites: 0, originalStorageSetItem: null, searchResolvers: {},
  attach(runtime) {
    this.runtime = runtime;
    this.resolveRegistry = runtime.registry.resolve.bind(runtime.registry);
    runtime.registry.resolve = (ref) => this.missingDefs.has(ref) ? null : this.resolveRegistry(ref);
    this.realQuery = runtime.kernel.query.bind(runtime.kernel);
    runtime.kernel.query = (method, params) => { this.queryCalls.push({ method, params }); const override = this.queryOverrides[method]; return override ? override(params, () => this.realQuery(method, params)) : this.realQuery(method, params); };
    const originalSetAttestor = runtime.kernel.setAttestor.bind(runtime.kernel);
    runtime.kernel.setAttestor = (fn, opts) => { this.attestor = fn; return originalSetAttestor(fn, opts); };
    runtime.standalone = {
      getSnapshot: () => ({ ...this.state }),
      subscribe: (fn) => { this.listeners.add(fn); fn({ ...this.state }); return () => this.listeners.delete(fn); },
      setHandlers: (next) => { this.handlers = { ...this.handlers, ...next }; },
      detach: () => { this.calls.push('detach'); return true; },
      dock: () => { this.calls.push('dock'); return true; },
      dispose: () => {},
    };
    if (new URLSearchParams(location.search).has('s1-delay-ready')) this.holdReady();
    const priorReady = runtime.ready;
    runtime.ready = priorReady.then(async (result) => { if (this.readyGate) await this.readyGate; return result; });
  },
  set(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn({ ...this.state }); },
  clearCalls() { this.calls = []; },
  clearQueryCalls() { this.queryCalls = []; },
  setQueryOverride(method, fn) { this.queryOverrides[method] = fn; },
  clearQueryOverrides() { this.queryOverrides = {}; },
  setSearchGate() { this.searchResolvers = {}; this.queryOverrides['instruments.search'] = (params) => new Promise((resolve) => { this.searchResolvers[params.q] = () => resolve({ hits: [{ id: 'search:' + params.q, name: '搜索' + params.q }] }); }); },
  resolveSearch(q) { this.searchResolvers[q]?.(); },
  beginPrefsWrites() { this.prefsWrites = 0; this.originalStorageSetItem = Storage.prototype.setItem; const fixture = this; Storage.prototype.setItem = function(key, value) { if (key === 'gitrader.prefs') fixture.prefsWrites += 1; return fixture.originalStorageSetItem.call(this, key, value); }; },
  endPrefsWrites() { if (this.originalStorageSetItem) Storage.prototype.setItem = this.originalStorageSetItem; this.originalStorageSetItem = null; return this.prefsWrites; },
  requestPin(req = { action: 's1.probe', params: { probe: true }, reason: 'probe' }, ctx = {}) { return this.attestor ? this.attestor(req, ctx) : Promise.reject(new Error('attestor unavailable')); },
  setBlockCfg(blockCfg) { this.runtime.prefs.set({ blockCfg }); },
  getBlockCfg() { return this.runtime.prefs.get().blockCfg; },
  hideWorkspaceDefs() { const w=this.runtime.workspace; this.missingDefs=new Set([w.statusBar?.block,w.items.find((i)=>i.instanceId==='bi_agent_1')?.block].filter(Boolean)); this.set({}); },
  restoreWorkspaceDefs() { this.missingDefs.clear(); this.set({}); },
  holdQuery() { this.originalQuery = this.runtime.kernel.query.bind(this.runtime.kernel); this.runtime.kernel.query = (method, ...args) => method === 'proposal.list' ? new Promise((resolve) => { this.releaseQuery = () => { this.runtime.kernel.query = this.originalQuery; resolve({ proposals: [] }); }; }) : this.originalQuery(method, ...args); },
  releaseHeldQuery() { this.releaseQuery?.(); this.releaseQuery = null; },
  holdReady() { this.readyGate = new Promise((resolve) => { this.releaseReady = resolve; }); },
  release() { this.releaseReady?.(); this.readyGate = null; },
};
`
  writeFileSync(join(staticDir, 's1-mode-fixture.js'), fixtureScript)
  writeFileSync(join(staticDir, 'index.html'), html.replace('<script src="./app.js"></script>', '<script src="./s1-mode-fixture.js"></script>\n<script src="./app.js"></script>'))
}

async function waitUntilOnline() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await cdp!.evaluate('window.__GR_READY__') as { online?: boolean } | undefined
    if (ready?.online) return
    await sleep(100)
  }
  throw new Error('Shell did not become online')
}

async function reloadAndWaitOnline() {
  const marker = `r1-reload-${Date.now()}`
  await cdp!.evaluate(`window.__S1_RELOAD_MARK__ = ${JSON.stringify(marker)}`)
  await cdp!.evaluate('location.reload()')
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const loaded = await cdp!.evaluate(`window.__GR_READY__?.online === true && window.__S1_RELOAD_MARK__ !== ${JSON.stringify(marker)}`)
    if (loaded) return
    await sleep(100)
  }
  const state = await cdp!.evaluate(`({ markerChanged: window.__S1_RELOAD_MARK__ !== ${JSON.stringify(marker)}, readyOnline: window.__GR_READY__?.online === true, ui: document.documentElement.dataset.ui ?? null, nav: document.documentElement.dataset.nav ?? null, updown: document.documentElement.dataset.updown ?? null, kernel: document.documentElement.dataset.kernel ?? null, offline: document.documentElement.hasAttribute('data-offline'), fixture: !!window.__S1_MODE_FIXTURE__?.runtime, hash: location.hash })`)
  throw new Error('Reloaded browser document did not become online; state=' + JSON.stringify(state))
}

async function reloadAndWaitDocument() {
  const marker = `r3-document-${Date.now()}`
  await cdp!.evaluate(`window.__S1_RELOAD_MARK__ = ${JSON.stringify(marker)}`)
  await cdp!.evaluate('location.reload()')
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const loaded = await cdp!.evaluate(`window.__S1_RELOAD_MARK__ !== ${JSON.stringify(marker)} && !!window.__S1_MODE_FIXTURE__?.runtime`)
    if (loaded) return
    await sleep(100)
  }
  throw new Error('Reloaded browser document did not attach the shell fixture')
}

async function openChartWithFixtureSymbol(symbol = chartSymbol) {
  await goTo('#/chart/' + encodeURIComponent(symbol))
  await waitForBrowser("!!document.querySelector('.g5-srow[data-sym]')")
  await waitForBrowser(`window.__S1_HUB_GET__?.('A', 'symbol') === ${JSON.stringify(symbol)}`)
  return symbol
}

async function waitForBrowser(expression: string, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await cdp!.evaluate(expression)) return
    await sleep(100)
  }
  const state = await cdp!.evaluate(`(() => { const input=document.querySelector('.gr-palette input[role="combobox"]'); const r=input?.getBoundingClientRect(); return { hash: location.hash, ui: document.documentElement.dataset.ui, nav: document.documentElement.dataset.nav ?? null, updown: document.documentElement.dataset.updown ?? null, kernel: document.documentElement.dataset.kernel ?? null, offline: document.documentElement.hasAttribute('data-offline'), palette: !!input, paletteVisible: !!r && r.width > 0 && r.height > 0, route: document.querySelector('.gr-app')?.getAttribute('data-route'), pages: [...document.querySelectorAll('[data-g5-page]')].map((node) => node.getAttribute('data-g5-page')), intervals: [...document.querySelectorAll('[data-iv]')].map((node) => node.getAttribute('data-iv')), prefs: [...document.querySelectorAll('[data-k]')].map((node) => node.getAttribute('data-k')) } })()`)
  throw new Error('Browser condition timed out: ' + expression + '; state=' + JSON.stringify(state))
}

async function goTo(hash: string) {
  await cdp!.evaluate(`location.hash = ${JSON.stringify(hash)}`)
  await sleep(120)
}

async function openPaletteWithKeyboard() {
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await waitForBrowser("!document.querySelector('.gr-palette input[role=combobox]')")
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2 })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2 })
  await waitForBrowser("(() => { const input=document.querySelector('.gr-palette input[role=combobox]'); const r=input?.getBoundingClientRect(); return !!input && document.activeElement === input && !!r && r.width > 0 && r.height > 0 })()")
}

async function typePaletteQuery(query: string) {
  await cdp!.evaluate(`(() => { const input = document.querySelector('.gr-palette input[role="combobox"]'); if (!input) return; input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await sleep(120)
}

async function pressPaletteEnter() {
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
}

async function clickPaletteCommand(id: string) {
  await cdp!.evaluate(`document.querySelector(${JSON.stringify(`.gr-palette [data-cmd="${id}"]`)})?.click()`)
  await waitForBrowser("!document.querySelector('.gr-palette input[role=combobox]')")
}

async function setStandaloneState(state: Record<string, unknown>) {
  await cdp!.evaluate(`window.__S1_MODE_FIXTURE__.set(${JSON.stringify(state)})`)
  await sleep(100)
}

async function setNavForm(form: 'top' | 'rail') {
  await goTo('#/settings/personal')
  await waitForBrowser(`!!document.querySelector('[data-k="nav"][data-v="${form}"]')`)
  await cdp!.evaluate(`document.querySelector('[data-k="nav"][data-v="${form}"]').click()`)
  await waitForBrowser(`document.documentElement.dataset.nav === '${form}'`)
}

async function setViewport(width: number, height: number) {
  await cdp!.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(80)
}

async function saveEvidenceScreenshot(name: string, clip?: { x: number; y: number; width: number; height: number; scale: number }) {
  mkdirSync(s1Shots, { recursive: true })
  const result = await cdp!.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip } : {}) }) as { data: string }
  writeFileSync(join(s1Shots, name), Buffer.from(result.data, 'base64'))
}

async function saveElementEvidenceScreenshot(name: string, selector: string, maxHeight: number) {
  const clip = await cdp!.evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) return null; const r=node.getBoundingClientRect(); const x=Math.max(0,r.x-8), y=Math.max(0,r.y-8), right=Math.min(innerWidth,r.right+8), bottom=Math.min(innerHeight,r.y+Math.min(r.height,${maxHeight})+8); return {x,y,width:right-x,height:bottom-y,scale:1} })()`) as { x: number; y: number; width: number; height: number; scale: number } | null
  if (!clip || clip.width <= 0 || clip.height <= 0) throw new Error('Pending screenshot anchor unavailable')
  await saveEvidenceScreenshot(name, clip)
}

async function loadOverviewPendingScenario(edit?: (scenario: ReturnType<typeof overviewScenario>, now: number) => void) {
  const now = Date.now()
  const scenario = overviewScenario('normal', now)
  edit?.(scenario, now)
  fixture!.stage.sc = scenario
  type ScenarioProposal = Scenario['proposals'][number]
  chartFixtureSet!.proposals = scenario.proposals as Array<ScenarioProposal & Record<string, unknown>>
  await goTo('#/overview')
  await reloadAndWaitOnline()
  await waitForBrowser("document.documentElement.hasAttribute('data-pend') && !!document.querySelector('[data-g5=\"fund\"][data-g5-page=\"overview\"]') && !!document.querySelector('#g5-pendpop')")
}

async function pendingStateSnapshot() {
  return cdp!.evaluate(`(() => {
    const visible=(node)=>{if(!node)return false;const r=node.getBoundingClientRect(),s=getComputedStyle(node);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0}
    const toggle=document.querySelector('[data-act="pending"]'), zero=document.querySelector('[data-p="0"]'), pop=document.querySelector('#g5-pendpop')
    const floats=document.querySelectorAll('[data-g5="float"]')
    return {state:document.documentElement.dataset.pend??null,pendingVisible:visible(toggle),expanded:toggle?.getAttribute('aria-expanded')??null,
      zeroVisible:visible(zero),slotCount:document.querySelectorAll('[data-slot="pending"]').length,slotFloatCount:document.querySelectorAll('[data-slot="pending"] [data-g5="float"]').length,
      floatHostCount:document.querySelectorAll('[data-slot="pending"][data-g5="float"]').length,floatCount:floats.length,
      popCount:document.querySelectorAll('#g5-pendpop').length,popHidden:!visible(pop),popInPendingSlot:!!pop?.closest('[data-slot="pending"]')}
  })()`)
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(home, 'b2a-shell-'))
  const staticDir = join(tempDir, 'static')
  mkdirSync(staticDir, { recursive: true })
  await buildWorkbench(staticDir)
  fixture = await startStage({ staticDir, workspacesDir: join(tempDir, 'workspaces'), scenario: 'chart-normal' })
  chartFixtureSet = designSet(Date.now())
  chartBaseScenario = fixture.stage.sc
  chartBaseProposals = chartFixtureSet.proposals
  installChartHandlers(fixture.kernel, chartFixtureSet)
  const priorProfiles = new Set(readdirSync(home).filter((name) => name.startsWith('cdp-profile-')))
  cdp = await launchCdp({ width: 1280, height: 900 })
  profileName = readdirSync(home).find((name) => name.startsWith('cdp-profile-') && !priorProfiles.has(name)) ?? ''
  if (!profileName) throw new Error('CDP profile ownership was not recorded')
  appendFileSync(ownedLog, `pid=${cdp.pid}; profile=${profileName}\n`)
  const url = new URL(fixture.kernel.launchUrl())
  url.searchParams.set('ui', 'r5')
  url.hash = '#/overview'
  await cdp.navigate(url.href)
  await waitUntilOnline()
}, 30_000)

afterEach(async () => {
  await cdp?.evaluate('window.__S1_MODE_FIXTURE__?.endPrefsWrites(); window.__S1_MODE_FIXTURE__?.clearQueryOverrides()')
  if (fixture && chartFixtureSet && chartBaseScenario && chartBaseProposals) {
    fixture.stage.sc = chartBaseScenario
    chartFixtureSet.proposals = chartBaseProposals
  }
})

afterAll(async () => {
  if (cdp) {
    await cdp.close()
    let pidState = 'unknown'
    try { process.kill(cdp.pid, 0); pidState = 'alive' }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') pidState = 'exited' }
    appendFileSync(ownedLog, `closed; pid=${cdp.pid}; pidState=${pidState}; profile=${basename(cdp.profileDir)}; profileGone=${!existsSync(cdp.profileDir)}; cleanupNotes=${JSON.stringify(cdp.cleanupNotes)}\n`)
  }
  await fixture?.kernel.close()
  if (tempDir && resolve(tempDir).startsWith(resolve(home) + sep)) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (ownedHome && basename(ownedHome).startsWith('gitrader-s1-')) { try { rmSync(ownedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* temp dir; the OS reclaims it */ } }
})

describe('r5 shell browser contract', () => {
  it('renders seven navigation entries, six settings tabs, and one pending slot', async () => {
    const nav = await cdp!.evaluate(`Array.from(document.querySelectorAll('nav.g5-nav a')).map((node) => node.textContent.trim())`)
    await goTo('#/settings/venues')
    const tabs = await cdp!.evaluate(`Array.from(document.querySelectorAll('nav.g5-snav a')).map((node) => node.textContent.trim())`)
    const pendingSlots = await cdp!.evaluate(`document.querySelectorAll('[data-slot="pending"]').length`)
    const pendingFloatState = await cdp!.evaluate(`({ hosts: document.querySelectorAll('[data-slot="pending"][data-g5="float"]').length, floats: document.querySelectorAll('[data-slot="pending"] [data-g5="float"]').length })`)
    expect({ nav, tabs, pendingSlots, pendingFloatState }).toEqual({
      nav: ['总览', '图表', '记录', '资金', '策略', '实验', '插件'],
      tabs: ['连接', '钥匙', '交易所', '通知', '个性化', '关于'],
      pendingSlots: 1,
      pendingFloatState: { hosts: 0, floats: 1 },
    })
  })

  it('mounts funds cards directly in their columns and keeps topbar icon controls at 28/20', async () => {
    await goTo('#/funds')
    const result = await cdp!.evaluate(`(() => {
      const topbar = document.querySelector('.g5-topbar')
      const controls = [...document.querySelectorAll('.g5-topbar [data-act="settings"], .g5-topbar [data-act="standalone"]')]
      const cards = [...document.querySelectorAll('.g5-ws[data-g5-page="funds"] section.g5-card')]
      const rect = (node) => node ? node.getBoundingClientRect() : null
      return {
        topbarHeight: rect(topbar)?.height ?? 0,
        controls: controls.map((node) => ({ width: rect(node).width, height: rect(node).height, icon: rect(node.querySelector('svg'))?.width ?? 0, iconHeight: rect(node.querySelector('svg'))?.height ?? 0 })),
        cardCount: cards.length,
        directChildren: cards.every((card) => card.parentElement?.classList.contains('g5-col')),
      }
    })()`) as { topbarHeight: number; controls: Array<{ width: number; height: number; icon: number; iconHeight: number }>; cardCount: number; directChildren: boolean }
    appendFileSync(join(evidence, 'b2a-r2-layout.log'), `funds-top-controls: ${JSON.stringify(result.controls)}\n`)
    expect({
      topbarHeight: result.topbarHeight,
      controlsSized: result.controls.length > 0 && result.controls.every((control) => control.width === 28 && control.height === 28 && control.icon === 20 && control.iconHeight === 20),
      hasFundsCards: result.cardCount > 0,
      directChildren: result.directChildren,
    }).toEqual({ topbarHeight: 40, controlsSized: true, hasFundsCards: true, directChildren: true })
  })

  it('syncs chart route and symbol selection through the Hub without adding history, and mounts lab detail instances', async () => {
    const routedSymbol = await openChartWithFixtureSymbol()
    await waitForBrowser(`window.__S1_HUB_GET__ && window.__S1_HUB_GET__('A', 'symbol') === ${JSON.stringify(routedSymbol)}`)
    const beforeLength = await cdp!.evaluate('history.length') as number
    const picked = await cdp!.evaluate(`(() => {
      const row = document.querySelector('.g5-srow[data-sym="${alternateChartSymbol}"]')
      if (!row) return null
      row.click()
      return row.dataset.sym
    })()`) as string | null
    expect(picked).toBe(alternateChartSymbol)
    await waitForBrowser(`window.__S1_HUB_GET__('A', 'symbol') === ${JSON.stringify(alternateChartSymbol)}`)
    const routeAfterHub = await cdp!.evaluate('({ hash: location.hash, length: history.length })') as { hash: string; length: number }
    expect(routeAfterHub).toEqual({ hash: `#/chart/${encodeURIComponent(alternateChartSymbol)}`, length: beforeLength })

    await goTo('#/lab/r1-experiment')
    const lab = await cdp!.evaluate(`({
      head: !!document.querySelector('[data-g5-page="lab-detail"][data-view="head"]'),
      forward: !!document.querySelector('[data-g5-page="lab-detail"][data-view="tier"][data-tier="forward"]'),
      holdout: !!document.querySelector('[data-g5-page="lab-detail"][data-view="tier"][data-tier="holdout"]'),
      backtest: !!document.querySelector('[data-g5-page="lab-detail"][data-view="tier"][data-tier="backtest"]'),
      assumptions: !!document.querySelector('[data-g5-page="lab-detail"][data-view="assumptions"]'),
    })`) as { head: boolean; forward: boolean; holdout: boolean; backtest: boolean; assumptions: boolean }
    expect(lab).toEqual({ head: true, forward: true, holdout: true, backtest: true, assumptions: true })
  })

  it('persists the selected chart interval in the real page after reload', async () => {
    await openChartWithFixtureSymbol(alternateChartSymbol)
    await waitForBrowser("!!document.querySelector('[data-iv=\"1h\"]')")
    await cdp!.evaluate(`document.querySelector('[data-iv="1h"]').click()`)
    await waitForBrowser("document.querySelector('[data-iv=\"1h\"]')?.getAttribute('aria-selected') === 'true'")
    await reloadAndWaitOnline()
    await waitForBrowser("document.querySelector('[data-iv=\"1h\"]')?.getAttribute('aria-selected') === 'true'")
    expect(await cdp!.evaluate(`document.querySelector('[data-iv="1h"]')?.getAttribute('aria-selected')`)).toBe('true')
  })

  it('applies saved navigation and up/down preferences to html and restores them after reload', async () => {
    await goTo('#/settings/personal')
    await waitForBrowser("!!document.querySelector('[data-k=\"nav\"][data-v=\"rail\"]')")
    await cdp!.evaluate(`document.querySelector('[data-k="nav"][data-v="rail"]').click()`)
    await cdp!.evaluate(`document.querySelector('[data-k="updown"][data-v="cn"]').click()`)
    await waitForBrowser("document.documentElement.dataset.nav === 'rail' && document.documentElement.dataset.updown === 'cn'")
    await reloadAndWaitOnline()
    await waitForBrowser("document.documentElement.dataset.nav === 'rail' && document.documentElement.dataset.updown === 'cn'")
    expect(await cdp!.evaluate(`({ nav: document.documentElement.dataset.nav, updown: document.documentElement.dataset.updown })`)).toEqual({ nav: 'rail', updown: 'cn' })
  })

  it('renders the specified top navigation and command group geometry', async () => {
    await goTo('#/settings/personal')
    await waitForBrowser("!!document.querySelector('[data-k=\"nav\"][data-v=\"top\"]')")
    await cdp!.evaluate(`document.querySelector('[data-k="nav"][data-v="top"]').click()`)
    await waitForBrowser("document.documentElement.dataset.nav === 'top'")
    await goTo('#/overview')
    const result = await cdp!.evaluate(`(() => {
      const box = (node) => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, right: r.right, width: r.width, height: r.height } : null }
      const nav = [...document.querySelectorAll('.g5-nav a')]
      const cmdk = document.querySelector('.g5-topbar .g5-cmdk')
      const actions = [...document.querySelectorAll('.g5-topbar .g5-tr > *')]
      const mode = actions.find((node) => node.matches('[data-mode], [data-act="standalone"]'))
      const settings = document.querySelector('.g5-topbar [data-act="settings"]')
      return {
        labels: nav.map((node) => node.textContent.trim()),
        navIcons: document.querySelectorAll('.g5-topbar .g5-nav svg').length,
        brandGap: box(document.querySelector('.gr-brand')) && box(nav[0]) ? box(nav[0]).x - box(document.querySelector('.gr-brand')).right : null,
        brandBox: box(document.querySelector('.gr-brand')),
        navBox: box(document.querySelector('.g5-nav')),
        navMargin: getComputedStyle(document.querySelector('.g5-nav')).marginLeft,
        ordinaryGap: box(nav[2]) && box(nav[1]) ? box(nav[2]).x - box(nav[1]).right : null,
        groupedGap: box(nav[4]) && box(nav[3]) ? box(nav[4]).x - box(nav[3]).right : null,
        afterGroupGap: box(nav[5]) && box(nav[4]) ? box(nav[5]).x - box(nav[4]).right : null,
        strategyGrouped: nav[4]?.classList.contains('g5-g2'),
        topHeight: box(document.querySelector('.g5-topbar'))?.height ?? 0,
        command: cmdk ? { text: cmdk.textContent.trim(), size: box(cmdk), icon: box(cmdk.querySelector('svg')), shortcut: cmdk.querySelector('.g5-k')?.textContent.trim() } : null,
        commandGroupGap: box(mode ?? settings) && box(cmdk) ? box(mode ?? settings).x - box(cmdk).right : null,
        actions: actions.map((node) => node.matches('.g5-feed-state') ? 'feed' : node.matches('.g5-cmdk') ? 'cmdk' : node.matches('[data-mode], [data-act="standalone"]') ? 'mode' : node.matches('[data-act="settings"]') ? 'settings' : 'other'),
        settingsCurrent: settings?.getAttribute('aria-current'),
        settingsHref: settings?.getAttribute('href'),
        searchButtons: document.querySelectorAll('.g5-topbar button[aria-label*="搜索"]').length,
      }
    })()`) as any
    appendFileSync(join(evidence, 'b2a-r2-layout.log'), `top-nav-geometry: ${JSON.stringify({ brandGap: result.brandGap, brandBox: result.brandBox, navBox: result.navBox, navMargin: result.navMargin })}\n`)
    expect(result.labels).toEqual(['总览', '图表', '记录', '资金', '策略', '实验', '插件'])
    expect(result.navIcons).toBe(0)
    expect(result.brandGap).toBe(32)
    expect(result.ordinaryGap).toBe(20)
    expect(result.groupedGap).toBe(40)
    expect(result.afterGroupGap).toBe(20)
    expect(result.strategyGrouped).toBe(true)
    expect(result.topHeight).toBe(40)
    expect(result.command).toMatchObject({ size: expect.objectContaining({ height: 28 }), icon: expect.objectContaining({ width: 20, height: 20 }) })
    expect(result.command.shortcut).toMatch(/^(Ctrl K|⌘K)$/)
    expect(result.commandGroupGap).toBe(32)
    // D1：顶栏右侧最前面新增「内核 / 行情」状态指示（Shell.jsx FeedIndicators），其后才是命令入口
    expect(result.actions[0]).toBe('feed')
    expect(result.actions[1]).toBe('cmdk')
    expect(result.actions.at(-1)).toBe('settings')
    expect(result.actions.slice(2, -1).every((action: string) => action === 'mode')).toBe(true)
    expect(result.settingsHref).toBe('#/settings/connect')
    expect(result.searchButtons).toBe(1)
  })

  it('keeps real navigation in rail mode and records shell geometry at three widths', async () => {
    await goTo('#/settings/personal')
    await waitForBrowser("!!document.querySelector('[data-k=\"nav\"][data-v=\"top\"]')")
    await cdp!.evaluate(`document.querySelector('[data-k="nav"][data-v="top"]').click()`)
    await waitForBrowser("document.documentElement.dataset.nav === 'top'")

    const widths = [1280, 1440, 1920]
    const measure = async (mode: 'top' | 'rail') => {
      for (const width of widths) {
        await setViewport(width, 900)
        const rects = await cdp!.evaluate(`(() => {
          const box = (node) => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } : null }
          return { viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], frame: box(document.querySelector('.g5-frame')), topbar: box(document.querySelector('.g5-topbar')), rail: box(document.querySelector('.g5-rail')), main: box(document.querySelector('.g5-main')) }
        })()`)
        appendFileSync(join(evidence, 'b2a-r2-layout.log'), `${mode} ${width}: ${JSON.stringify(rects)}\n`)
        expect(await cdp!.evaluate('document.documentElement.scrollWidth === innerWidth')).toBe(true)
        expect(await cdp!.evaluate("document.querySelector('.g5-topbar')?.getBoundingClientRect().height === (document.documentElement.dataset.nav === 'rail' ? 0 : 40)")).toBe(true)
        if (mode === 'rail') expect(await cdp!.evaluate("document.querySelector('.g5-rail')?.getBoundingClientRect().width === 64 && getComputedStyle(document.querySelector('.g5-topbar')).display === 'none'")).toBe(true)
        writeFileSync(join(evidence, `b2a-r2-${mode}-${width}.png`), await cdp!.screenshot())
      }
    }
    await measure('top')

    await cdp!.evaluate(`document.querySelector('[data-k="nav"][data-v="rail"]').click()`)
    await waitForBrowser("document.documentElement.dataset.nav === 'rail'")
    await reloadAndWaitOnline()
    await waitForBrowser("document.documentElement.dataset.nav === 'rail'")
    const rail = await cdp!.evaluate(`(() => ({
      labels: [...document.querySelectorAll('nav.g5-rail a[data-page]')].map((node) => node.getAttribute('aria-label')),
      links: [...document.querySelectorAll('nav.g5-rail a[data-page]')].map((node) => node.getAttribute('href')),
      navWidth: document.querySelector('.g5-rail')?.getBoundingClientRect().width,
      itemSizes: [...document.querySelectorAll('nav.g5-rail a[data-page].g5-ri')].map((node) => { const r=node.getBoundingClientRect(); return [r.width,r.height] }),
      topDisplay: getComputedStyle(document.querySelector('.g5-topbar')).display,
    }))()`) as { labels: string[]; links: string[]; navWidth: number; itemSizes: number[][]; topDisplay: string }
    expect(rail).toMatchObject({
      labels: ['总览', '图表', '记录', '资金', '策略', '实验', '插件'],
      links: ['#/overview', '#/chart', '#/records', '#/funds', '#/strategies', '#/lab', '#/plugins'],
      navWidth: 64,
      itemSizes: Array(7).fill([40, 40]),
      topDisplay: 'none',
    })
    await measure('rail')
    for (const href of rail.links as string[]) {
      await cdp!.evaluate(`document.querySelector('nav.g5-rail a[href="${href}"]')?.click()`)
      await waitForBrowser(`location.hash === ${JSON.stringify(href)}`)
      expect(await cdp!.evaluate(`document.querySelector('nav.g5-rail a[aria-current="page"]')?.getAttribute('href')`)).toBe(href)
    }
    await goTo('#/settings/personal')
    await cdp!.evaluate(`document.querySelector('[data-k="nav"][data-v="rail"]').click()`)
  })

  it('keeps Settings page geometry on the shared workspace and displays the required page views', async () => {
    const pages = [
      ['venues', ['venues', 'accounts', 'catalog', 'detail']],
      ['notify', ['channels', 'rules', 'detail']],
      ['personal', []],
    ] as const
    for (const [page, expectedViews] of pages) {
      await goTo(`#/settings/${page}`)
      const result = await cdp!.evaluate(`(() => {
        const ws = document.querySelector('.g5-ws')
        const style = ws ? getComputedStyle(ws) : null
        const settings = document.querySelector('.g5-settings')
        const settingsStyle = settings ? getComputedStyle(settings) : null
        const body = document.querySelector('.gr-page__body')
        const bodyStyle = body ? getComputedStyle(body) : null
        const snav = document.querySelector('.g5-snav')
        return {
          workspaces: document.querySelectorAll('.g5-ws').length,
          page: ws?.getAttribute('data-g5-page'),
          workspaceParent: ws?.parentElement?.className,
          views: [...document.querySelectorAll('.g5-settings [data-venues-view], .g5-settings [data-notify-view]')].map((node) => node.getAttribute('data-venues-view') ?? node.getAttribute('data-notify-view')),
          single: ws?.classList.contains('g5-one') || ws?.classList.contains('g5-pers'),
          nestedWorkspaces: ws?.querySelectorAll('.g5-ws').length ?? 0,
          personalCards: ['nav', 'updown'].map((id) => !!ws?.querySelector('[data-g5="card"]#' + id)),
          personalChoices: ['nav', 'updown'].map((key) => ws?.querySelectorAll('[data-k="' + key + '"]').length ?? 0),
          settingsStyle: settingsStyle && { padding: settingsStyle.padding, margin: settingsStyle.margin, maxWidth: settingsStyle.maxWidth, flex: settingsStyle.flex, minHeight: settingsStyle.minHeight },
          settingsHeight: settings?.getBoundingClientRect().height ?? 0,
          contentHeight: document.querySelector('.g5-shell-content')?.getBoundingClientRect().height ?? 0,
          bodyStyle: bodyStyle && { gap: bodyStyle.gap, minHeight: bodyStyle.minHeight },
          tabMargin: snav ? getComputedStyle(snav).marginTop : null,
          workspacePadding: style?.padding,
        }
      })()`) as any
      expect(result.workspaces).toBe(1)
      expect(result.page).toBe(page === 'personal' ? null : page)
      expect(result.views).toEqual(expectedViews)
      expect(result.workspaceParent).toContain('gr-page__body')
      expect(result.single).toBe(page === 'personal')
      expect(result.nestedWorkspaces).toBe(0)
      if (page === 'personal') {
        expect(result.personalCards).toEqual([true, true])
        expect(result.personalChoices.every((count: number) => count > 0)).toBe(true)
      }
      expect(result.settingsStyle).toMatchObject({ padding: '0px', margin: '0px', maxWidth: 'none', flex: '1 1 0%', minHeight: '0px' })
      expect(Math.abs(result.settingsHeight - result.contentHeight)).toBeLessThanOrEqual(4)
      expect(result.bodyStyle).toMatchObject({ gap: '0px', minHeight: '0px' })
      expect(result.tabMargin).toBe('12px')
      expect(result.workspacePadding).toBe('12px 0px 16px')
    }
  })

  // GQ-65：资金页第六张卡「组合」（左列权益曲线下，不 grow）
  it('keeps all six funds cards as direct flex children and lets curve and changes grow', async () => {
    await goTo('#/funds')
    const result = await cdp!.evaluate(`(() => {
      const ws = document.querySelector('.g5-ws[data-g5-page="funds"]')
      const cards = [...(ws?.querySelectorAll('section.g5-card') ?? [])]
      return {
        count: cards.length,
        direct: cards.every((card) => card.parentElement?.classList.contains('g5-col')),
        grow: cards.filter((card) => card.classList.contains('g5-grow')).map((card) => ({ flexGrow: getComputedStyle(card).flexGrow, height: card.getBoundingClientRect().height, title: card.querySelector('.g5-hd h2')?.textContent.trim() })),
      }
    })()`) as { count: number; direct: boolean; grow: Array<{ flexGrow: string; height: number; title: string | null }> }
    expect(result.count).toBe(6)
    expect(result.direct).toBe(true)
    expect(result.grow).toHaveLength(2)
    expect(result.grow.every((card: any) => card.flexGrow === '1' && card.height > 100)).toBe(true)
  })

  it('wheel-scrolls real overflowing content to its last reachable row and records scrollbar visibility separately', async () => {
    // 记录卡自撑高后缺省夹具（13 行）一屏装得下：换 P3 夹具（bigSet 取 120 笔，一页读完不续读），让 .g5-scroll 必然溢出（断言不变）。
    const recordsSet = bigSet()
    recordsSet.fills = recordsSet.fills.slice(0, 120) // 只看 BTC（约 40 行）：一页读完（不触发续读），又远超一屏
    fixture!.kernel.onQuery('records.query', (p: unknown) => recordsQuery(recordsSet, (p ?? {}) as Record<string, unknown>)) // 只换这一个查询，其余夹具原样
    await goTo('#/records/hyperliquid:BTC') // GQ-37：按标的看走显式路由（原来靠联动组带入 BTC）
    await waitForBrowser("[...document.querySelectorAll('.g5-ws[data-g5-page=\"records\"] .g5-scroll')].some((node) => node.scrollHeight > node.clientHeight)")
    const before = await cdp!.evaluate(`(() => {
      const scroller = [...document.querySelectorAll('.g5-ws[data-g5-page="records"] .g5-scroll')].find((node) => node.scrollHeight > node.clientHeight)
      if (!scroller) return null
      const r = scroller.getBoundingClientRect()
      const pseudo = getComputedStyle(scroller, '::-webkit-scrollbar')
      return { x: r.left + r.width / 2, y: (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2, scrollTop: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight, scrollbarWidth: getComputedStyle(scroller).scrollbarWidth, barWidth: pseudo.width, barDisplay: pseudo.display, scrollbarPixels: scroller.offsetWidth - scroller.clientWidth }
    })()`) as { x: number; y: number; scrollTop: number; max: number; scrollbarWidth: string; barWidth: string; barDisplay: string; scrollbarPixels: number } | null
    expect(before).not.toBeNull()
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before!.x, y: before!.y, button: 'none' })
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before!.x, y: before!.y, deltaX: 0, deltaY: 1200 })
    await sleep(180)
    const after = await cdp!.evaluate(`(() => {
      const scroller = [...document.querySelectorAll('.g5-ws[data-g5-page="records"] .g5-scroll')].find((node) => node.scrollHeight > node.clientHeight)
      if (!scroller) return null
      const box = scroller.getBoundingClientRect()
      const tail = scroller.querySelector('tbody tr:last-child') ?? scroller.lastElementChild
      const tailBox = tail?.getBoundingClientRect()
      const pseudo = getComputedStyle(scroller, '::-webkit-scrollbar')
      return { scrollTop: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight, tailReachable: !!tailBox && tailBox.bottom <= box.bottom + 2, scrollbarWidth: getComputedStyle(scroller).scrollbarWidth, barWidth: pseudo.width, barDisplay: pseudo.display, thumb: getComputedStyle(scroller, '::-webkit-scrollbar-thumb').backgroundColor, hovered: scroller.matches(':hover'), scrollbarPixels: scroller.offsetWidth - scroller.clientWidth, barVisible: getComputedStyle(scroller).scrollbarWidth !== 'none' && pseudo.display !== 'none', docScrollX: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth }
    })()`) as { docScrollX: number; scrollTop: number; max: number; tailReachable: boolean; scrollbarWidth: string; barWidth: string; barDisplay: string; thumb: string; hovered: boolean; scrollbarPixels: number; barVisible: boolean } | null
    appendFileSync(join(evidence, 'b2a-r2-layout.log'), `records-wheel: ${JSON.stringify({ before, after })}\n`)
    writeFileSync(join(evidence, 'b2a-r2-records-scrollbar.png'), await cdp!.screenshot())
    expect(after).not.toBeNull()
    expect(after!.max).toBeGreaterThan(0)
    expect(after!.docScrollX).toBe(0)
    expect(after!.scrollTop).toBeGreaterThan(0)
    expect(after!.scrollTop).toBeGreaterThanOrEqual(after!.max - 2)
    expect(after!.tailReachable).toBe(true)
    // 维护者 规矩：滚动条窄 + 透明、悬停显色（UI 反馈 10-11；取代旧的「隐藏、不占版面」）：4 px 窄条，不是 15 px 系统条；静止时滑块透明，鼠标在滚动区上时显色。滚轮仍可滚。
    expect({ barWidth: after!.barWidth, scrollbarPixels: after!.scrollbarPixels }).toEqual({ barWidth: '4px', scrollbarPixels: 4 })
    expect(after!.thumb === 'rgba(0, 0, 0, 0)').toBe(!after!.hovered)
  })

  it('shows a mode control only for available hosts and dispatches detach/dock to the controller', async () => {
    await setNavForm('top')
    await setStandaloneState({ mode: 'docked', available: false, peer: false, hostAvailable: false, blocked: false })
    expect(await cdp!.evaluate("document.querySelectorAll('.g5-topbar [data-mode], .g5-rail [data-mode]').length")).toBe(0)
    await setStandaloneState({ available: true })
    await sleep(100)
    await openPaletteWithKeyboard()
    await waitForBrowser("!!document.querySelector('.gr-palette [data-cmd=\"standalone:toggle\"]')")
    expect(await cdp!.evaluate("document.querySelector('.gr-palette [data-cmd=\"standalone:toggle\"] .gr-palette__t')?.textContent")).toBe('独立模式')
    await setStandaloneState({ mode: 'standalone', hostAvailable: false })
    await waitForBrowser("!document.querySelector('.gr-palette [data-cmd=\"standalone:toggle\"]')")
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await waitForBrowser("!document.querySelector('.gr-palette input[role=combobox]')")
    await setStandaloneState({ mode: 'docked', hostAvailable: true })
    const frame = await cdp!.evaluate("(() => { const b=document.querySelector('.g5-topbar [data-mode]'); const r=b.getBoundingClientRect(); const css=getComputedStyle(document.documentElement).getPropertyValue('--gr-mode-label').trim().replace(/^[\"']|[\"']$/g,''); return {label:b.getAttribute('aria-label'),cssLabel:css,pressed:b.getAttribute('aria-pressed'),size:[r.width,r.height],paths:[...b.querySelectorAll('svg')].map(s=>[s.getAttribute('class'),...[...s.querySelectorAll('path')].map(p=>p.getAttribute('d'))])} })()") as { label: string | null; cssLabel: string; pressed: string | null; size: [number, number]; paths: string[][] }
    expect(frame.label).toBe('独立模式')
    expect(frame).toMatchObject({ pressed: 'false', size: [28, 28] })
    expect(frame.paths).toEqual([
      ['g5-pri', 'M10.5 4.5h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4', 'M14 4.5h5.5V10', 'M19.5 4.5l-8 8'],
      ['g5-alt', 'M10.5 4.5h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4', 'M11.5 7v5.5H17', 'M19.5 4.5l-8 8'],
    ])
    await cdp!.evaluate("document.querySelector('.g5-topbar [data-mode]').click()")
    await waitForBrowser("window.__S1_MODE_FIXTURE__.calls.includes('detach')")
    await setStandaloneState({ mode: 'standalone', available: true, hostAvailable: true })
    await waitForBrowser("document.querySelector('.g5-topbar [data-mode]')?.getAttribute('aria-pressed') === 'true'")
    expect(await cdp!.evaluate("document.querySelector('.g5-topbar [data-mode]')?.getAttribute('aria-label')")).toBe('回嵌')
    await cdp!.evaluate("document.querySelector('.g5-topbar [data-mode]').click()")
    await waitForBrowser("window.__S1_MODE_FIXTURE__.calls.includes('dock')")
    await setStandaloneState({ hostAvailable: false })
    expect(await cdp!.evaluate("document.querySelector('.g5-topbar [data-mode]')?.disabled === true && document.querySelector('.g5-topbar [data-host-unavailable]')?.textContent === '宿主侧栏未打开'")).toBe(true)
  })

  it('uses the approved gear glyph in top and rail navigation', async () => {
    const d = 'M10.11 4.95 L10.27 2.66 L13.73 2.66 L13.89 4.95 L15.65 5.68 L17.38 4.17 L19.83 6.62 L18.32 8.35 L19.05 10.11 L21.34 10.27 L21.34 13.73 L19.05 13.89 L18.32 15.65 L19.83 17.38 L17.38 19.83 L15.65 18.32 L13.89 19.05 L13.73 21.34 L10.27 21.34 L10.11 19.05 L8.35 18.32 L6.62 19.83 L4.17 17.38 L5.68 15.65 L4.95 13.89 L2.66 13.73 L2.66 10.27 L4.95 10.11 L5.68 8.35 L4.17 6.62 L6.62 4.17 L8.35 5.68Z'
    await setNavForm('top')
    const top = await cdp!.evaluate("(() => { const b=document.querySelector('.g5-topbar [data-act=\"settings\"]'); const r=b.getBoundingClientRect(); return [b.querySelector('svg path')?.getAttribute('d'),b.querySelector('svg circle')?.getAttribute('r'),r.width,r.height,b.querySelector('.g5-tip.g5-glass')?.textContent.trim()] })()")
    expect(top).toEqual([d, '3', 28, 28, '设置'])
    const tipPoint = await cdp!.evaluate("(() => { const r=document.querySelector('.g5-topbar [data-act=\"settings\"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()") as { x: number; y: number }
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tipPoint.x, y: tipPoint.y })
    await sleep(250)
    await saveEvidenceScreenshot('b2a-r4-gear-hover.png')
    await setNavForm('rail')
    const rail = await cdp!.evaluate("(() => { const b=document.querySelector('.g5-rail [data-act=\"settings\"]'); const r=b.getBoundingClientRect(); return [b.querySelector('svg path')?.getAttribute('d'),b.querySelector('svg circle')?.getAttribute('r'),r.width,r.height,b.querySelector('.g5-tip.g5-glass')?.textContent.trim()] })()")
    expect(rail).toEqual([d, '3', 40, 40, '设置'])
  })

  it('clears palette and pending PIN work when peer mode takes over', async () => {
    await setStandaloneState({ mode: 'docked', available: true, peer: false, hostAvailable: true, blocked: false })
    await cdp!.evaluate("document.querySelector('.g5-topbar [data-act=\"palette\"]').click()")
    await waitForBrowser("!!document.querySelector('[role=\"dialog\"]')")
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.holdQuery(); window.__S1_PENDING_PIN__=window.__S1_MODE_FIXTURE__.requestPin({action:'proposal.approve',params:{id:'probe'},reason:'probe'}).then(v=>window.__S1_PIN_RESULT__=v); void 0")
    await setStandaloneState({ peer: true })
    await sleep(100)
    const peer = await cdp!.evaluate("({marker:document.querySelectorAll('[data-standalone-peer=\"on\"]').length,message:document.querySelector('.g5-peer-message')?.textContent,modeLabel:document.querySelector('[data-standalone-peer=\"on\"] [data-mode]')?.getAttribute('aria-label'),pages:document.querySelectorAll('[data-g5-page]').length,status:document.querySelectorAll('[data-slot=\"statusbar\"]').length,pending:document.querySelectorAll('[data-slot=\"pending\"]').length,dialogs:document.querySelectorAll('[role=\"dialog\"]').length})")
    expect(peer).toMatchObject({ marker: 1, message: '已在独立窗口打开 · ', modeLabel: '回嵌', pages: 0, status: 0, pending: 0, dialogs: 0 })
    // 让位卡上的「回嵌」有可见字：来自令牌 --gr-mode-label-on 的伪元素，不在 JS 里写死
    expect(await cdp!.evaluate("(() => { const label = document.querySelector('[data-standalone-peer=\"on\"] .g5-peer-dock-label'); if (!label) return null; const rect = label.getBoundingClientRect(); return { text: getComputedStyle(label, '::before').content, visible: rect.width > 0 && rect.height > 0 } })()")).toEqual({ text: '"回嵌"', visible: true })
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.releaseHeldQuery()")
    await waitForBrowser('window.__S1_PIN_RESULT__ === null')
    await cdp!.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))")
    expect(await cdp!.evaluate("document.querySelectorAll('[role=\"dialog\"]').length")).toBe(0)
    await cdp!.evaluate("document.querySelector('.g5-topbar [data-mode]').click()")
    await waitForBrowser("window.__S1_MODE_FIXTURE__.calls.includes('dock')")
  })

  it('renders blocked Unwired and merges a valid dock payload into current preferences', async () => {
    await goTo('#/overview')
    await setStandaloneState({ mode: 'docked', available: true, peer: false, hostAvailable: true, blocked: true })
    await sleep(100)
    const blocked = await cdp!.evaluate("({message:document.querySelector('[data-wire=\"off\"] .g5-msg')?.textContent,frame:!!document.querySelector('.g5-frame'),retry:document.querySelectorAll('[data-act=\"retry\"],[data-act*=\"ticket\"]').length})")
    expect(blocked).toMatchObject({ message: '宿主不允许打开新窗口', frame: true, retry: 0 })
    expect(await cdp!.evaluate("document.querySelector('[data-wire=\"off\"] .g5-t3')?.textContent")).toBe('未接通')
    expect(await cdp!.evaluate("[...document.querySelector('.g5-blocked-notice')?.querySelectorAll('button') ?? []].map((button) => button.getAttribute('data-act'))")).toEqual(['copy-relink'])
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.setBlockCfg({local:{keep:true}}); window.__S1_MODE_FIXTURE__.handlers.onDock({route:'#/funds',blockCfg:{remote:{keep:true}}})")
    await waitForBrowser("location.hash === '#/funds'")
    expect(await cdp!.evaluate("window.__S1_MODE_FIXTURE__.getBlockCfg()")).toEqual({ local: { keep: true }, remote: { keep: true } })
    expect(await cdp!.evaluate("window.__S1_MODE_FIXTURE__.handlers.getPayload()")).toMatchObject({ route: '#/funds', blockCfg: { local: { keep: true }, remote: { keep: true } } })
  })

  it('keeps the same real Chart, status, pending, route, and saved config through blocked and recovery', async () => {
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.setBlockCfg({bi_chart_1:{interval:'1h',indicators:['vol']}}); location.hash='#/chart/hyperliquid%3AETH'")
    await sleep(120)
    await reloadAndWaitOnline()
    await waitForBrowser("document.querySelector('[data-g5-page=chart] [data-iv=\"1h\"][aria-selected=true]') && document.querySelector('[data-slot=statusbar]') && document.querySelector('[data-slot=pending]')")
    await cdp!.evaluate(`window.__S1_R4_KEEP__ = (() => ({
      chart: document.querySelector('[data-g5-page="chart"]'),
      status: document.querySelector('[data-slot="statusbar"]'),
      pending: document.querySelector('[data-slot="pending"]'),
      route: location.hash,
      blockCfg: JSON.stringify(JSON.parse(localStorage.getItem('gitrader.prefs') || '{}').blockCfg || {})
    }))()`)
    await setStandaloneState({ mode: 'docked', available: true, peer: false, hostAvailable: true, blocked: true })
    await waitForBrowser("!!document.querySelector('.g5-blocked-notice')")
    const blocked = await cdp!.evaluate(`(() => {
      const keep = window.__S1_R4_KEEP__;
      const chart = document.querySelector('[data-g5-page="chart"]');
      const status = document.querySelector('[data-slot="statusbar"]');
      const pending = document.querySelector('[data-slot="pending"]');
      return {
        chartSame: chart === keep.chart && chart?.isConnected,
        statusSame: status === keep.status && status?.isConnected,
        pendingSame: pending === keep.pending && pending?.isConnected,
        chartInterval: chart?.querySelector('[data-iv][aria-selected="true"]')?.getAttribute('data-iv') ?? null,
        routeSame: location.hash === keep.route,
        blockCfgSame: JSON.stringify(JSON.parse(localStorage.getItem('gitrader.prefs') || '{}').blockCfg || {}) === keep.blockCfg,
        notice: document.querySelector('.g5-blocked-notice [data-wire="off"] .g5-msg')?.textContent ?? null,
        noticeButtons: [...(document.querySelector('.g5-blocked-notice')?.querySelectorAll('button') ?? [])].map((button) => button.getAttribute('data-act'))
      }
    })()`) as { chartSame: boolean; statusSame: boolean; pendingSame: boolean; chartInterval: string | null; routeSame: boolean; blockCfgSame: boolean; notice: string | null; noticeButtons: Array<string | null> }
    expect(blocked).toEqual({ chartSame: true, statusSame: true, pendingSame: true, chartInterval: '1h', routeSame: true, blockCfgSame: true, notice: '宿主不允许打开新窗口', noticeButtons: ['copy-relink'] })
    await saveEvidenceScreenshot('b2a-r4-blocked-chart.png')
    await setStandaloneState({ blocked: false })
    await waitForBrowser("!document.querySelector('.g5-blocked-notice')")
    expect(await cdp!.evaluate(`(() => { const keep=window.__S1_R4_KEEP__; return document.querySelector('[data-g5-page="chart"]')===keep.chart && document.querySelector('[data-slot="statusbar"]')===keep.status && document.querySelector('[data-slot="pending"]')===keep.pending })()`)).toBe(true)
  })

  it('keeps missing status and pending definitions in their sole slots and opens pending fallback on focus', async () => {
    await setStandaloneState({ mode: 'docked', available: false, peer: false, hostAvailable: false, blocked: false })
    await goTo('#/overview')
    await waitUntilOnline()
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.hideWorkspaceDefs()")
    await sleep(100)
    const initial = await cdp!.evaluate(`(() => ({
      statusSlots: document.querySelectorAll('[data-slot="statusbar"]').length,
      statusFallback: document.querySelector('[data-slot="statusbar"] [data-wire="off"]')?.textContent ?? null,
      pendingSlots: document.querySelectorAll('[data-slot="pending"]').length,
      pendingFallback: document.querySelector('[data-slot="pending"][data-wire="off"] [data-wire="off"]')?.textContent ?? null,
      pendingVisible: !!document.querySelector('.g5-pending-fallback') && getComputedStyle(document.querySelector('.g5-pending-fallback')).display !== 'none',
      htmlPend: document.documentElement.dataset.pend ?? null
    }))()`) as { statusSlots: number; statusFallback: string | null; pendingSlots: number; pendingFallback: string | null; pendingVisible: boolean; htmlPend: string | null }
    expect(initial).toMatchObject({ statusSlots: 1, statusFallback: expect.stringContaining('未接通'), pendingSlots: 1, pendingFallback: expect.stringContaining('未接通'), pendingVisible: false })
    await cdp!.evaluate("window.dispatchEvent(new CustomEvent('gitrader:focus', { detail: { card: 'pending' } }))")
    await waitForBrowser("document.querySelector('.g5-pending-fallback') && getComputedStyle(document.querySelector('.g5-pending-fallback')).display !== 'none'")
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.restoreWorkspaceDefs()")
    await waitForBrowser("document.querySelector('[data-slot=\"pending\"] [data-wire=\"off\"]') === null && document.querySelector('[data-slot=\"pending\"] [data-g5=\"float\"]')")
    expect(await cdp!.evaluate("({statusSlots:document.querySelectorAll('[data-slot=\"statusbar\"]').length,pendingSlots:document.querySelectorAll('[data-slot=\"pending\"]').length,realPending:document.querySelectorAll('[data-slot=\"pending\"] [data-g5=\"float\"]').length})")).toEqual({ statusSlots: 1, pendingSlots: 1, realPending: 1 })
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.hideWorkspaceDefs()")
    await sleep(100)
    const missingAgain = await cdp!.evaluate("({statusSlots:document.querySelectorAll('[data-slot=\"statusbar\"]').length,pendingSlots:document.querySelectorAll('[data-slot=\"pending\"]').length,realFloats:document.querySelectorAll('[data-slot=\"pending\"] [data-g5=\"float\"]').length,fallbackHidden:document.querySelector('.g5-pending-fallback')?.hidden??null,htmlPend:document.documentElement.dataset.pend??null})") as { statusSlots: number; pendingSlots: number; realFloats: number; fallbackHidden: boolean | null; htmlPend: string | null }
    expect(missingAgain).toMatchObject({ statusSlots: 1, pendingSlots: 1, realFloats: 0, fallbackHidden: true, htmlPend: initial.htmlPend })
    await cdp!.evaluate("window.dispatchEvent(new CustomEvent('gitrader:focus', { detail: { card: 'pending' } }))")
    await waitForBrowser("document.querySelector('.g5-pending-fallback') && getComputedStyle(document.querySelector('.g5-pending-fallback')).display !== 'none'")
    const shownAgain = await cdp!.evaluate("({statusSlots:document.querySelectorAll('[data-slot=\"statusbar\"]').length,pendingSlots:document.querySelectorAll('[data-slot=\"pending\"]').length,realFloats:document.querySelectorAll('[data-slot=\"pending\"] [data-g5=\"float\"]').length,visibleFallback:getComputedStyle(document.querySelector('.g5-pending-fallback')).display!=='none',htmlPend:document.documentElement.dataset.pend??null})") as { statusSlots: number; pendingSlots: number; realFloats: number; visibleFallback: boolean; htmlPend: string | null }
    expect(shownAgain).toMatchObject({ statusSlots: 1, pendingSlots: 1, realFloats: 0, visibleFallback: true, htmlPend: initial.htmlPend })
  })

  it('shows the real pending empty state when the normal scenario has no pending proposals', async () => {
    await loadOverviewPendingScenario((scenario) => { scenario.proposals = scenario.proposals.filter((proposal) => proposal.status !== 'pending') })
    const snapshot = await pendingStateSnapshot()
    expect(snapshot).toMatchObject({ state: 'none', pendingVisible: false, zeroVisible: true, slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: true, popInPendingSlot: true })
    await saveElementEvidenceScreenshot('b2p-none.png', '[data-p="0"]', 48)
    appendFileSync(join(evidence, 'b2p-state-results.log'), `none ${JSON.stringify(snapshot)}\n`)
  })

  it('opens the real collapsed pending float on click and keeps one slot across routes', async () => {
    await loadOverviewPendingScenario()
    const initial = await pendingStateSnapshot()
    expect(initial).toMatchObject({ state: 'collapsed', pendingVisible: true, expanded: 'false', zeroVisible: false, slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: true, popInPendingSlot: true })
    await saveElementEvidenceScreenshot('b2p-normal-collapsed.png', '[data-act="pending"]', 48)
    await cdp!.evaluate("document.querySelector('[data-act=\"pending\"]').click()")
    await waitForBrowser("document.documentElement.dataset.pend === 'open' && document.querySelector('[data-act=\"pending\"]')?.getAttribute('aria-expanded') === 'true'")
    const opened = await pendingStateSnapshot()
    expect(opened).toMatchObject({ state: 'open', pendingVisible: true, expanded: 'true', slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: false, popInPendingSlot: true })
    await saveElementEvidenceScreenshot('b2p-normal-open.png', '#g5-pendpop', 60)
    await goTo('#/funds')
    await waitForBrowser("!!document.querySelector('[data-g5-page=\"funds\"]')")
    const acrossRoute = await pendingStateSnapshot()
    expect(acrossRoute).toMatchObject({ state: 'open', slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: false, popInPendingSlot: true })
    await goTo('#/overview')
    await cdp!.evaluate("document.querySelector('#g5-pendpop [data-act=\"pend-collapse\"]').click()")
    await waitForBrowser("document.documentElement.dataset.pend === 'collapsed' && document.querySelector('[data-act=\"pending\"]')?.getAttribute('aria-expanded') === 'false'")
    const collapsed = await pendingStateSnapshot()
    expect(collapsed).toMatchObject({ state: 'collapsed', expanded: 'false', slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: true, popInPendingSlot: true })
    appendFileSync(join(evidence, 'b2p-state-results.log'), `normal ${JSON.stringify({ initial, opened, acrossRoute, collapsed })}\n`)
  })

  it('auto-opens one real pending proposal near expiry once and stays collapsed after manual close', async () => {
    await loadOverviewPendingScenario((scenario, now) => {
      const urgent = scenario.proposals.find((proposal) => proposal.status === 'pending')
      if (!urgent) throw new Error('Normal overview fixture has no pending proposal')
      urgent.expiresAt = now + 70_000
    })
    const initial = await pendingStateSnapshot()
    expect(initial).toMatchObject({ state: 'collapsed', pendingVisible: true, expanded: 'false', slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: true, popInPendingSlot: true })
    const waitStarted = Date.now()
    await waitForBrowser("document.documentElement.dataset.pend === 'open' && document.querySelector('[data-act=\"pending\"]')?.getAttribute('aria-expanded') === 'true'", 30_000)
    const autoOpenMs = Date.now() - waitStarted
    expect(autoOpenMs).toBeLessThanOrEqual(30_000)
    const opened = await pendingStateSnapshot()
    expect(opened).toMatchObject({ state: 'open', pendingVisible: true, expanded: 'true', slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: false, popInPendingSlot: true })
    await saveElementEvidenceScreenshot('b2p-near-expiry-auto.png', '#g5-pendpop', 60)
    await cdp!.evaluate("document.querySelector('#g5-pendpop [data-act=\"pend-collapse\"]').click()")
    await waitForBrowser("document.documentElement.dataset.pend === 'collapsed' && document.querySelector('[data-act=\"pending\"]')?.getAttribute('aria-expanded') === 'false'")
    await saveElementEvidenceScreenshot('b2p-near-expiry-manual-collapse.png', '[data-act="pending"]', 48)
    await sleep(2500)
    const afterManualClose = await pendingStateSnapshot()
    expect(afterManualClose).toMatchObject({ state: 'collapsed', expanded: 'false', slotCount: 1, slotFloatCount: 1, floatHostCount: 0, floatCount: 1, popCount: 1, popHidden: true, popInPendingSlot: true })
    appendFileSync(join(evidence, 'b2p-state-results.log'), `near-expiry ${JSON.stringify({ initial, autoOpenMs, opened, afterManualClose })}\n`)
  })

  it('anchors the legal blocked notice beside the active top or rail mode key without changing the workspace', async () => {
    await setStandaloneState({ mode: 'docked', available: true, peer: false, hostAvailable: true, blocked: false })
    for (const form of ['top', 'rail'] as const) {
      await setNavForm(form)
      await goTo('#/overview')
      await waitForBrowser("!!document.querySelector('[data-g5-page]')")
      await cdp!.evaluate(`window.__S1_R5_KEEP__ = (() => { const names=['[data-g5-page]','[data-slot="statusbar"]','[data-slot="pending"]']; return {nodes:names.map(s=>document.querySelector(s)),rect:(()=>{const r=document.querySelector('.g5-shell-content').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()} })()`)
      await setStandaloneState({ blocked: true })
      const result = await cdp!.evaluate(`(() => {
        const visible = (node) => { const r=node.getBoundingClientRect(); const s=getComputedStyle(node); return s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0 }
        const button=document.querySelector('.g5-${form === 'top' ? 'topbar__actions' : 'foot'} [data-mode]');
        const notice=document.querySelector('.g5-${form === 'top' ? 'topbar__actions' : 'foot'} .g5-blocked-notice');
        const br=button?.getBoundingClientRect(), nr=notice?.getBoundingClientRect();
        const keep=window.__S1_R5_KEEP__, names=['[data-g5-page]','[data-slot="statusbar"]','[data-slot="pending"]'];
        const wr=document.querySelector('.g5-shell-content')?.getBoundingClientRect();
        return { fixtureState:{mode:window.__S1_MODE_FIXTURE__.state.mode,available:window.__S1_MODE_FIXTURE__.state.available,peer:window.__S1_MODE_FIXTURE__.state.peer},
          visibleNotices:[...document.querySelectorAll('.g5-blocked-notice')].filter(visible).length,
          modeVisible:!!button && visible(button), modeDisabled:button?.disabled ?? true,
          noticeVisible:!!notice && visible(notice), noticeClass:notice?.classList.contains('g5-glass') ?? false,
          actions:notice?[...notice.querySelectorAll('button,a')].map((n)=>n.getAttribute('data-act')):[],
          message:notice?.querySelector('[data-wire="off"] .g5-msg')?.textContent?.trim() ?? null,
          status:notice?.querySelector('[data-wire="off"] .g5-t3')?.textContent?.trim() ?? null,
          parent:notice?.parentElement?.classList.contains('${form === 'top' ? 'g5-topbar__actions' : 'g5-foot'}') ?? false,
          anchors:br&&nr?{right:Math.abs(nr.right-br.right),top:Math.abs(nr.top-(br.bottom+8)),left:Math.abs(nr.left-(br.right+12)),center:Math.abs((nr.top+nr.height/2)-(br.top+br.height/2))}:null,
          clip:br&&nr?(()=>{const x=Math.max(0,Math.min(br.x,nr.x)-12),y=Math.max(0,Math.min(br.y,nr.y)-12),right=Math.min(innerWidth,Math.max(br.right,nr.right)+12),bottom=Math.min(innerHeight,Math.max(br.bottom,nr.bottom)+12);return{x,y,width:right-x,height:bottom-y,scale:1}})():null,
          mainControls:document.querySelectorAll('.g5-topbar__actions > button,.g5-topbar__actions > a').length,
          sameNodes:names.every((s,i)=>document.querySelector(s)===keep.nodes[i]),
          sameRect:wr&&keep.rect.every((v,i)=>Math.abs(v-[wr.x,wr.y,wr.width,wr.height][i])<0.5) };
      })()`) as {
        fixtureState: { mode: string; available: boolean; peer: boolean }
        visibleNotices: number
        modeVisible: boolean
        modeDisabled: boolean
        noticeVisible: boolean
        noticeClass: boolean
        actions: Array<string | null>
        message: string | null
        status: string | null
        parent: boolean
        anchors: { right: number; top: number; left: number; center: number } | null
        clip: { x: number; y: number; width: number; height: number; scale: number } | null
        mainControls: number
        sameNodes: boolean
        sameRect: boolean
      }
      expect(result).toMatchObject({ fixtureState: { mode: 'docked', available: true, peer: false }, visibleNotices: 1, modeVisible: true, modeDisabled: false, noticeVisible: true, noticeClass: true,
        actions: ['copy-relink'], message: '宿主不允许打开新窗口', status: '未接通', parent: true, mainControls: 3, sameNodes: true, sameRect: true })
      if (!result.anchors) throw new Error('blocked notice anchor evidence unavailable')
      if (form === 'top') expect(result.anchors.right).toBeLessThanOrEqual(4), expect(result.anchors.top).toBeLessThanOrEqual(4)
      else expect(result.anchors.left).toBeLessThanOrEqual(4), expect(result.anchors.center).toBeLessThanOrEqual(4)
      if (!result.clip) throw new Error('blocked notice screenshot clip unavailable')
      await saveEvidenceScreenshot(`b2a-r5-blocked-${form}.png`, result.clip)
      await cdp!.evaluate(`document.querySelector('.g5-${form === 'top' ? 'topbar__actions' : 'foot'} [data-mode]').focus()`)
      await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' })
      await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' })
      expect(await cdp!.evaluate("document.activeElement?.getAttribute('data-act') === 'copy-relink'")).toBe(true)
      await cdp!.evaluate(`window.__S1_MODE_FIXTURE__.clearCalls(); document.querySelector('.g5-${form === 'top' ? 'topbar__actions' : 'foot'} [data-mode]').click()`)
      await waitForBrowser("window.__S1_MODE_FIXTURE__.calls.includes('detach')")
      await setStandaloneState({ blocked: false })
    }
  })

  it('holds Chart until ready and reads saved configuration on its first mount', async () => {
    await cdp!.evaluate("window.__S1_MODE_FIXTURE__.setBlockCfg({bi_chart_1:{interval:'1h',indicators:['vol']}}); location.hash='#/chart/hyperliquid%3AETH'; const u=new URL(location.href); u.searchParams.set('s1-delay-ready','1'); history.replaceState(history.state,'',u.pathname+u.search+u.hash)")
    try {
      await reloadAndWaitDocument()
      await sleep(150)
      expect(await cdp!.evaluate("({chart:document.querySelectorAll('[data-g5-page=\"chart\"]').length,pending:document.querySelectorAll('[data-slot=\"pending\"]').length,skeleton:document.querySelectorAll('.g5-card[aria-busy=\"true\"][aria-label=\"正在连接\"]').length})")).toEqual({ chart: 0, pending: 0, skeleton: 1 })
      await cdp!.evaluate("window.__S1_MODE_FIXTURE__.release()")
      await waitUntilOnline()
      await waitForBrowser("document.querySelector('[data-iv=\"1h\"]')?.getAttribute('aria-selected') === 'true'")
      expect(await cdp!.evaluate("document.querySelector('[data-iv=\"1h\"]')?.getAttribute('aria-selected')")).toBe('true')
    } finally {
      await cdp!.evaluate("const u=new URL(location.href); u.searchParams.delete('s1-delay-ready'); history.replaceState(history.state,'',u.pathname+u.search+u.hash); window.__S1_MODE_FIXTURE__?.release()")
    }
  })

  it('loads the ten r5 page commands and real experiment results only while the palette is open', async () => {
    await goTo('#/overview')
    await cdp!.evaluate('window.__S1_MODE_FIXTURE__.clearQueryCalls()')
    await openPaletteWithKeyboard()
    await sleep(450)
    const result = await cdp!.evaluate(`(() => {
      const ids = ['workbench','chart','records','funds','strategies','lab','plugins','venues','notifications','personal']
      return {
        pages: ids.map((id) => [id, document.querySelector('.gr-palette [data-cmd="go:' + id + '"] .gr-palette__t')?.textContent.trim() ?? null]),
        experiments: [...document.querySelectorAll('.gr-palette [data-cmd^="experiment:"]')].map((node) => node.getAttribute('data-cmd')),
        calls: window.__S1_MODE_FIXTURE__.queryCalls.map((call) => ({ method: call.method, params: call.params })),
      }
    })()`) as {
      pages: Array<[string, string | null]>
      experiments: Array<string | null>
      calls: Array<{ method: string; params?: { limit?: number; q?: string } | null }>
    }
    expect(result.pages).toEqual([
      ['workbench', '打开总览'], ['chart', '打开图表'], ['records', '打开记录'], ['funds', '打开资金'], ['strategies', '打开策略'],
      ['lab', '打开实验'], ['plugins', '打开插件'], ['venues', '打开交易所'], ['notifications', '打开通知'], ['personal', '打开个性化'],
    ])
    expect(result.experiments.length).toBeGreaterThan(0)
    expect(result.calls.some((call) => call.method === 'lab.list' && call.params?.limit === 500)).toBe(true)
    expect(result.calls.some((call) => call.method === 'instruments.search' && !call.params?.q)).toBe(false)
  })

  it('routes by keyboard and click with params, and preserves direct, back, and about navigation', async () => {
    await goTo('#/overview')
    await openPaletteWithKeyboard()
    await typePaletteQuery('交易所')
    await waitForBrowser("!!document.querySelector('.gr-palette [data-cmd=\"go:venues\"]')")
    await pressPaletteEnter()
    await waitForBrowser("location.hash === '#/settings/venues'")

    await goTo('#/overview')
    await openPaletteWithKeyboard()
    await typePaletteQuery('通知')
    await clickPaletteCommand('go:notifications')
    await waitForBrowser("location.hash === '#/settings/notify'")

    await goTo('#/overview')
    await openPaletteWithKeyboard()
    await typePaletteQuery('BTC')
    await waitForBrowser("!!document.querySelector('.gr-palette [data-cmd=\"instrument:hyperliquid:BTC\"]')")
    await clickPaletteCommand('instrument:hyperliquid:BTC')
    await waitForBrowser("location.hash === '#/chart/hyperliquid%3ABTC'")

    await cdp!.evaluate('history.back()')
    await waitForBrowser("location.hash === '#/overview'")
    await goTo('#/about')
    await waitForBrowser("location.hash === '#/settings/about' && document.querySelector('nav.g5-snav a[data-group=about][aria-current=page]')")
    await goTo('#/settings/keys')
    await cdp!.evaluate("document.querySelector('nav.g5-snav a[data-group=about]')?.click()")
    await waitForBrowser("location.hash === '#/settings/about'")
  })

  it('executes every r5 page command by mouse and opens a real listed experiment', async () => {
    const targets = [
      ['workbench', '#/overview', "!!document.querySelector('.g5-ws[data-g5-page=workbench]')"],
      ['chart', '#/chart', "!!document.querySelector('.g5-ws[data-g5-page=chart]')"],
      ['records', '#/records', "!!document.querySelector('.g5-ws[data-g5-page=records]')"],
      ['funds', '#/funds', "!!document.querySelector('.g5-ws[data-g5-page=funds]')"],
      ['strategies', '#/strategies', "!!document.querySelector('.g5-ws[data-g5-page=strategies]')"],
      ['lab', '#/lab', "!!document.querySelector('.g5-ws[data-g5-page=lab]')"],
      ['plugins', '#/plugins', "!!document.querySelector('.g5-ws[data-g5-page=plugins]')"],
      ['venues', '#/settings/venues', "!!document.querySelector('[data-venues-view]')"],
      ['notifications', '#/settings/notify', "!!document.querySelector('[data-notify-view]')"],
      ['personal', '#/settings/personal', "!!document.querySelector('[data-k=nav]')"],
    ] as const
    for (const [id, route, visible] of targets) {
      await goTo('#/overview')
      await openPaletteWithKeyboard()
      await clickPaletteCommand(`go:${id}`)
      await waitForBrowser(`location.hash === ${JSON.stringify(route)} && (${visible})`)
    }
    await goTo('#/overview')
    await openPaletteWithKeyboard()
    await waitForBrowser("!!document.querySelector('.gr-palette [data-cmd^=\"experiment:\"]')")
    const experimentId = await cdp!.evaluate("document.querySelector('.gr-palette [data-cmd^=\"experiment:\"]')?.getAttribute('data-cmd')?.slice('experiment:'.length)") as string
    expect(experimentId).toBeTruthy()
    await clickPaletteCommand(`experiment:${experimentId}`)
    await waitForBrowser(`location.hash === ${JSON.stringify('#/lab/' + encodeURIComponent(experimentId))} && !!document.querySelector('.g5-ws[data-g5-page=lab-detail]')`)
  })

  it('treats lab.list method-missing as an unavailable group without an error toast', async () => {
    await goTo('#/overview')
    await cdp!.evaluate(`window.__S1_MODE_FIXTURE__.clearQueryCalls(); window.__S1_MODE_FIXTURE__.setQueryOverride('lab.list', () => Promise.reject(Object.assign(new Error('query unavailable'), { code: -32601 })))`)
    const alertsBefore = await cdp!.evaluate("document.querySelectorAll('.gr-toast[role=alert]').length")
    try {
      await openPaletteWithKeyboard()
      await sleep(450)
      const result = await cdp!.evaluate(`(() => ({
        called: window.__S1_MODE_FIXTURE__.queryCalls.some((call) => call.method === 'lab.list' && call.params?.limit === 500),
        experiments: document.querySelectorAll('.gr-palette [data-cmd^="experiment:"]').length,
        alerts: document.querySelectorAll('.gr-toast[role=alert]').length
      }))()`)
      expect(result).toEqual({ called: true, experiments: 0, alerts: alertsBefore })
    } finally {
      await cdp!.evaluate('window.__S1_MODE_FIXTURE__.clearQueryOverrides()')
    }
  })

  it('keeps only the newest asynchronous instrument search result and shows the no-match state', async () => {
    await goTo('#/overview')
    await cdp!.evaluate(`(() => {
      const fixture=window.__S1_MODE_FIXTURE__;
      fixture.clearQueryCalls();
      fixture.clearQueryOverrides();
      fixture.searchResolvers={};
      fixture.setQueryOverride('instruments.search',(params)=>new Promise((resolve)=>{ fixture.searchResolvers[params.q]=()=>resolve({hits:[{id:'search:'+params.q,name:params.q==='B'?'BTC old':'BTC new'}]}) }));
    })()`)
    try {
      await openPaletteWithKeyboard()
      await typePaletteQuery('B')
      await sleep(250)
      expect(await cdp!.evaluate("window.__S1_MODE_FIXTURE__.queryCalls.some((call) => call.method === 'instruments.search' && call.params?.q === 'B' && call.params?.limit === 12)")).toBe(true)
      await cdp!.evaluate("(() => { const input=document.querySelector('.gr-palette input[role=combobox]'); input.value='BT'; input.dispatchEvent(new Event('input',{bubbles:true})); window.__S1_MODE_FIXTURE__.resolveSearch('B'); })()")
      await cdp!.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve()))')
      expect(await cdp!.evaluate("!!document.querySelector('.gr-palette [data-cmd=\"instrument:search:B\"]')")).toBe(false)
      await waitForBrowser("window.__S1_MODE_FIXTURE__.queryCalls.some((call) => call.method === 'instruments.search' && call.params?.q === 'BT' && call.params?.limit === 12)")
      await cdp!.evaluate("window.__S1_MODE_FIXTURE__.resolveSearch('BT')")
      await waitForBrowser("!!document.querySelector('.gr-palette [data-cmd=\"instrument:search:BT\"]')")
      expect(await cdp!.evaluate("({ newest: !!document.querySelector('.gr-palette [data-cmd=\"instrument:search:BT\"]'), older: !!document.querySelector('.gr-palette [data-cmd=\"instrument:search:B\"]') })")).toEqual({ newest: true, older: false })
      await typePaletteQuery('zz_no_match')
      await waitForBrowser("!!document.querySelector('.gr-palette__empty')")
      await saveEvidenceScreenshot('b2b-command-no-match.png')
    } finally {
      await cdp!.evaluate('window.__S1_MODE_FIXTURE__.clearQueryOverrides()')
    }
  })

  it('persists navigation and updown preferences from palette and Personal actions', async () => {
    await goTo('#/overview')
    await setNavForm('top')
    await goTo('#/settings/personal')
    await waitForBrowser("!!document.querySelector('[data-k=updown][data-v=intl]')")
    await cdp!.evaluate("document.querySelector('[data-k=updown][data-v=intl]')?.click()")
    await waitForBrowser("document.documentElement.dataset.updown === 'intl'")
    await goTo('#/overview')
    await cdp!.evaluate('window.__S1_MODE_FIXTURE__.beginPrefsWrites()')
    await openPaletteWithKeyboard()
    await waitForBrowser("!!document.querySelector('.gr-palette [data-cmd=\"toggle:nav\"]')")
    await clickPaletteCommand('toggle:nav')
    await waitForBrowser("document.documentElement.dataset.nav === 'rail'")
    expect(await cdp!.evaluate('window.__S1_MODE_FIXTURE__.endPrefsWrites()')).toBe(1)
    await reloadAndWaitOnline()
    expect(await cdp!.evaluate('document.documentElement.dataset.nav')).toBe('rail')

    await goTo('#/settings/personal')
    await waitForBrowser("!!document.querySelector('[data-k=nav][data-v=top]')")
    await cdp!.evaluate('window.__S1_MODE_FIXTURE__.beginPrefsWrites()')
    await cdp!.evaluate("document.querySelector('[data-k=nav][data-v=top]')?.click()")
    await waitForBrowser("document.documentElement.dataset.nav === 'top'")
    expect(await cdp!.evaluate('window.__S1_MODE_FIXTURE__.endPrefsWrites()')).toBe(1)
    await reloadAndWaitOnline()
    expect(await cdp!.evaluate('document.documentElement.dataset.nav')).toBe('top')

    await openChartWithFixtureSymbol(alternateChartSymbol)
    const before = await cdp!.evaluate(`(() => {
      const root = getComputedStyle(document.documentElement)
      const tokens = [...root].filter((name) => name.startsWith('--gr-')).map((name) => [name, root.getPropertyValue(name).trim()])
      const resolve = (value) => { const probe=document.createElement('span'); probe.style.color=value; document.body.append(probe); const color=getComputedStyle(probe).color; probe.remove(); return color }
      const change = document.querySelector('[data-g5-page="chart"] [data-n="chg"]')
      return { tokens, up: resolve(root.getPropertyValue('--gr-up').trim()), down: resolve(root.getPropertyValue('--gr-down').trim()), color: change ? getComputedStyle(change).color : null, direction: change?.classList.contains('g5-up') ? 'up' : change?.classList.contains('g5-down') ? 'down' : 'flat' }
    })()`) as { tokens: Array<[string, string]>; up: string; down: string; color: string | null; direction: 'up' | 'down' | 'flat' }
    expect(before.direction).not.toBe('flat')
    expect(before.color).toBe(before.direction === 'up' ? before.up : before.down)
    await cdp!.evaluate('window.__S1_MODE_FIXTURE__.beginPrefsWrites()')
    await openPaletteWithKeyboard()
    await waitForBrowser("!!document.querySelector('.gr-palette [data-cmd=\"toggle:updown\"]')")
    await clickPaletteCommand('toggle:updown')
    await waitForBrowser("document.documentElement.dataset.updown === 'cn'")
    expect(await cdp!.evaluate('window.__S1_MODE_FIXTURE__.endPrefsWrites()')).toBe(1)
    const after = await cdp!.evaluate(`(() => {
      const root = getComputedStyle(document.documentElement)
      const tokens = [...root].filter((name) => name.startsWith('--gr-')).map((name) => [name, root.getPropertyValue(name).trim()])
      const resolve = (value) => { const probe=document.createElement('span'); probe.style.color=value; document.body.append(probe); const color=getComputedStyle(probe).color; probe.remove(); return color }
      const change = document.querySelector('[data-g5-page="chart"] [data-n="chg"]')
      return { tokens, up: resolve(root.getPropertyValue('--gr-up').trim()), down: resolve(root.getPropertyValue('--gr-down').trim()), color: change ? getComputedStyle(change).color : null, direction: change?.classList.contains('g5-up') ? 'up' : change?.classList.contains('g5-down') ? 'down' : 'flat' }
    })()`) as { tokens: Array<[string, string]>; up: string; down: string; color: string | null; direction: 'up' | 'down' | 'flat' }
    expect(after.up).toBe(before.down)
    expect(after.down).toBe(before.up)
    expect(after.tokens.map((entry) => entry[0])).toEqual(before.tokens.map((entry) => entry[0]))
    expect.soft(after.tokens.filter(([name]) => !['--gr-up', '--gr-down'].includes(name))).toEqual(before.tokens.filter(([name]) => !['--gr-up', '--gr-down'].includes(name)))
    expect(after.color).toBe(after.direction === 'up' ? after.up : after.down)
    await reloadAndWaitOnline()
    expect(await cdp!.evaluate('document.documentElement.dataset.updown')).toBe('cn')
    await saveEvidenceScreenshot('b2b-cn.png')
    await goTo('#/settings/personal')
    await waitForBrowser("!!document.querySelector('[data-k=updown][data-v=intl]')")
    await cdp!.evaluate("document.querySelector('[data-k=updown][data-v=intl]')?.click()")
    await waitForBrowser("document.documentElement.dataset.updown === 'intl'")
    await reloadAndWaitOnline()
    expect(await cdp!.evaluate('document.documentElement.dataset.updown')).toBe('intl')
  })

  it('does not query dynamic commands after the r5 kernel connection closes', async () => {
    await goTo('#/overview')
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await waitForBrowser("!document.querySelector('.gr-palette input[role=combobox]')")
    await cdp!.evaluate('window.__S1_MODE_FIXTURE__.clearQueryCalls()')
    await fixture!.kernel.close()
    fixture = undefined
    await waitForBrowser("document.documentElement.dataset.kernel !== 'open' && !document.documentElement.hasAttribute('data-offline')")
    await cdp!.evaluate('window.__S1_MODE_FIXTURE__.clearQueryCalls()')
    await openPaletteWithKeyboard()
    await typePaletteQuery('BTC')
    await sleep(450)
    expect(await cdp!.evaluate("window.__S1_MODE_FIXTURE__.queryCalls.filter((call) => call.method === 'lab.list' || call.method === 'instruments.search').length")).toBe(0)
    await waitForBrowser("document.documentElement.hasAttribute('data-offline') && document.documentElement.dataset.kernel !== 'open'")
    await cdp!.evaluate('window.__S1_MODE_FIXTURE__.clearQueryCalls()')
    await typePaletteQuery('ETH')
    await sleep(450)
    expect(await cdp!.evaluate("window.__S1_MODE_FIXTURE__.queryCalls.filter((call) => call.method === 'lab.list' || call.method === 'instruments.search').length")).toBe(0)
  })
})
