// SPDX-License-Identifier: CPAL-1.0
// 设置 × 三页（交易所 / 通知 / 个性化）浏览器用例：CDP 直连本机 Edge（无头），夹具内核 + 本文件现场打包的舞台页（壳的 r5 设置路由由 S1 并行施工，
// 这里把卡挂进与视觉稿同版式的两列里；桥是真的：真 KernelClient 连夹具内核，经 createHostBridge 校验清单与命令声明）。
// 舞台页只存在于本文件与临时目录，不进 src/。不设 GITRADER_SKIP_BROWSER，没有 Edge 就直接失败。
//   P9_WRITE_ANCHORS=1  重写 test/geo-anchors/settings-*.json（先量视觉稿，再量产品页）。
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { problem } from '../../workbench/verify/fixture-kernel'
import { settingsConfig } from '../fixtures/venues'
import { startStage } from '../verify/stage-entry'
import { launchCdp } from './helpers/cdp'
import anchorsVenues from './geo-anchors/settings-venues.json'
import anchorsNotify from './geo-anchors/settings-notify.json'
import anchorsPersonal from './geo-anchors/settings-personal.json'

const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const repo = resolve(pkgDir, '../..')
const shotsDir = process.env.GITRADER_SHOTS_DIR ?? join(repo, 'reports/blocks-r5/P9-shots')
const mockDir = join(repo, 'reports/visual-r5')
const PIN = '246810'
const WIDTHS = [1280, 1440, 1920] as const
const WRITE_ANCHORS = process.env.P9_WRITE_ANCHORS === '1'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Page = 'venues' | 'notify' | 'personal'
type State = 'normal' | 'empty' | 'loading' | 'error' | 'offline' | 'unwired'
type Rect = { x: number; y: number; w: number; h: number }
type Anchor = { anchor: string; static: Record<string, Rect>; product: Record<string, Rect> }

// ---- 舞台页 ------------------------------------------------------------------------------------------------------------------

const ENTRY = `
import { render } from 'preact'
import { KernelClient, LinkHub, createHostBridge } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { venuesBlocks } from './src/pages/venues'
import { notifyBlocks } from './src/pages/notify'
import { Personal } from '../workbench/src/shell/Personal.jsx'
import { getPrefsStore } from '../workbench/src/ui/lib/layout.js'
import '../workbench/src/ui/theme.css'
import '../workbench/src/ui/r5/components.css'
const w = window
const H = w.__H
const COLS = {
  venues: [['venues', 'accounts', 'catalog'], ['detail']],
  notify: [['channels', 'rules'], ['detail']],
}
;(async () => {
  if (H.page === 'personal') {
    w.__prefsLog = []
    const store = getPrefsStore()
    const set = store.set.bind(store)
    store.set = (patch) => { w.__prefsLog.push(patch); set(patch) }
    render(<Personal />, document.getElementById('root'))
    document.documentElement.setAttribute('data-ready', '1')
    return
  }
  const boot = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: H.boot }) }).then((r) => r.json())
  const client = new KernelClient({ url: H.ws, getToken: () => boot.sessionToken, WebSocketCtor: WebSocket, reconnect: false })
  await client.connect()
  w.__attest = { mode: 'pin', calls: 0 }
  client.setAttestor(async () => { w.__attest.calls += 1; return w.__attest.mode === 'cancel' ? null : { method: 'pin', pin: H.pin } })
  const hub = new LinkHub({ A: {} })
  const block = (H.page === 'venues' ? venuesBlocks : notifyBlocks)[0]
  const root = document.getElementById('root')
  const ws = document.createElement('div')
  ws.className = 'g5-ws'
  root.appendChild(ws)
  COLS[H.page].forEach((views, ci) => {
    const col = document.createElement('div')
    col.className = 'g5-col'
    ws.appendChild(col)
    for (const view of views) {
      const bridge = createHostBridge({ manifest: block.manifest, kernel: client, hub, instanceId: 'bi_' + H.page + '_' + view, trusted: true, isUserActive: () => true })
      const host = document.createElement('div')
      host.style.display = 'contents'
      col.appendChild(host)
      const C = block.component
      render(<BridgeContext.Provider value={bridge}><C bridge={bridge} instanceId={'bi_' + H.page + '_' + view} config={{ view }} setConfig={() => undefined} channel="A" grid={{ w: 1, h: 1 }} mode="tile" /></BridgeContext.Provider>, host)
    }
  })
  document.documentElement.setAttribute('data-ready', '1')
})()
`

const html = (page: Page, top: number) => `<!doctype html>
<html lang="zh-CN" data-ui="r5" data-updown="intl"><head><meta charset="utf-8"><title>settings-${page}</title><link rel="stylesheet" href="app.css"></head>
<body><main class="g5-frame"><div style="height:${top}px;flex:none"></div><div id="root" style="display:contents"></div></main>
<script src="h.js"></script><script src="app.js"></script></body></html>`
const hjs = (page: Page, boot: string, ws: string) => `window.__H=${JSON.stringify({ page, boot, ws, pin: PIN })}`

let staticDir = ''
let tmpRoot = ''
const live: Array<{ close(): Promise<void> }> = []

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(home, 'settings-browser-'))
  if (!resolve(tmpRoot).startsWith(resolve(home) + sep)) throw new Error('temporary directory escaped GITRADER_HOME')
  staticDir = join(tmpRoot, 'static')
  mkdirSync(staticDir)
  const svgText = {
    name: 'svg-text',
    setup(b: { onLoad(o: { filter: RegExp }, cb: (a: { path: string }) => unknown): void }) {
      b.onLoad({ filter: /\.svg$/ }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, 'utf8').replace(/fill="#FFFFFF"/gi, 'fill="currentColor"').trim())}`, loader: 'js' }))
    },
  }
  await build({
    stdin: { contents: ENTRY, resolveDir: pkgDir, loader: 'tsx', sourcefile: 'settings-stage.tsx' },
    bundle: true, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'silent',
    loader: { '.js': 'jsx', '.png': 'binary', '.woff2': 'file' }, assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, plugins: [svgText as never],
    define: { __GITRADER_VERSION__: '"settings-stage"', 'process.env.NODE_ENV': '"production"' },
    outfile: join(staticDir, 'app.js'),
  })
}, 120_000)

afterAll(async () => {
  for (const x of live.splice(0)) await x.close()
  if (tmpRoot && resolve(tmpRoot).startsWith(resolve(home) + sep)) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

// ---- 起一套：夹具内核（动态应答，带 PIN 规则）+ 无头 Edge + 打开舞台页 ---------------------------------------------------------------------

type Cdp = Awaited<ReturnType<typeof launchCdp>>
type Kernel = Awaited<ReturnType<typeof startStage>>['kernel']
interface Rig {
  cdp: Cdp
  kernel: Kernel
  cfg: { config: typeof settingsConfig }
  ev<T = unknown>(expr: string): Promise<T>
  waitFor(expr: string, ms?: number): Promise<void>
  click(sel: string): Promise<void>
  type(sel: string, text: string): Promise<void>
  shot(name: string): Promise<void>
  close(): Promise<void>
}
const rectsOf = (cdp: Cdp, names: string[], sel: (n: string) => string) => cdp.evaluate(`(() => {
  const sels = ${JSON.stringify(Object.fromEntries(names.map((n) => [n, sel(n)])))}
  return Object.fromEntries(Object.entries(sels).map(([n, s]) => { const el = document.querySelector(s); const r = el ? el.getBoundingClientRect() : null; return [n, r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null] }))
})()`) as Promise<Record<string, Rect | null>>

/** 视觉稿一侧：量设置区上缘（舞台页用它垫高，卡才落在同一纵向位置）与各锚点矩形。 */
async function measureMock(cdp: Cdp, page: Page, ids: string[]): Promise<{ top: number; rects: Record<string, Rect> }> {
  await cdp.navigate(`file:///${mockDir.replaceAll('\\', '/')}/settings-${page}/index.html`)
  await sleep(600)
  await cdp.evaluate('document.fonts.ready.then(() => 1)')
  const top = await cdp.evaluate(`document.querySelector('.ws').getBoundingClientRect().top`) as number
  const rects = await rectsOf(cdp, ids, (n) => `#${n}`)
  return { top, rects: rects as Record<string, Rect> }
}

interface OpenOpts { width?: number; state?: State; top?: number; config?: typeof settingsConfig; pinned?: boolean }
async function open(page: Page, opts: OpenOpts = {}): Promise<Rig> {
  const width = opts.width ?? 1440
  const state = opts.state ?? 'normal'
  const stateDir = mkdtempSync(join(tmpRoot, 'k-'))
  const dir = join(stateDir, 'static')
  mkdirSync(dir)
  writeFileSync(join(dir, 'app.js'), readFileSync(join(staticDir, 'app.js')))
  writeFileSync(join(dir, 'app.css'), readFileSync(join(staticDir, 'app.css')))
  const stage = await startStage({ staticDir: dir, workspacesDir: join(stateDir, 'workspaces'), scenario: `${page === 'personal' ? 'venues' : page}-${state === 'offline' ? 'normal' : state}` })
  const kernel = stage.kernel
  const cfg = { config: structuredClone(opts.config ?? settingsConfig) }
  if (state === 'normal' || state === 'offline' || state === 'loading') installHandlers(kernel, cfg)
  writeFileSync(join(dir, 'index.html'), html(page, opts.top ?? 160))
  writeFileSync(join(dir, 'h.js'), hjs(page, kernel.bootstrapToken, kernel.wsUrl))
  const cdp = await launchCdp({ width, height: 900 })
  const rig: Rig = {
    cdp, kernel, cfg,
    ev: (expr) => cdp.evaluate(expr) as Promise<never>,
    async waitFor(expr, ms = 15_000) {
      const t0 = Date.now()
      for (;;) {
        if (await cdp.evaluate(expr)) return
        if (Date.now() - t0 > ms) throw new Error(`等待超时：${expr}\n页面错误：${JSON.stringify(cdp.errors)}\n${String(await cdp.evaluate("document.body.innerText.slice(0, 500)"))}`)
        await sleep(100)
      }
    },
    async click(sel) {
      const pt = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return hit && (hit === el || el.contains(hit)) ? { x, y } : { x, y, blocked: hit ? hit.outerHTML.slice(0, 120) : 'none' } })()`) as { x: number; y: number; blocked?: string } | null
      if (!pt) throw new Error(`没有这个元素：${sel}`)
      if (pt.blocked) throw new Error(`点不到 ${sel}：被 ${pt.blocked} 挡住`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    },
    async type(sel, text) {
      await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    },
    async shot(name) {
      mkdirSync(shotsDir, { recursive: true })
      writeFileSync(join(shotsDir, `${name}.png`), await cdp.screenshot())
    },
    async close() { await cdp.close(); await kernel.close() },
  }
  live.push(rig)
  // 几何探针要往页里放一段脚本（geo.ts 的做法），内核的 CSP 不许内联脚本：只在测试浏览器里绕过
  await cdp.send('Page.setBypassCSP', { enabled: true })
  await cdp.navigate(`${kernel.url}/`)
  return rig
}
async function close(rig: Rig): Promise<void> {
  await rig.close()
  live.splice(0, live.length, ...live.filter((x) => x !== rig))
}

/** 夹具内核里的 config.view 与三条写命令：按配置整段替换；需要在场证明的放宽没带证明 → ATTESTATION_REQUIRED，带了就核 PIN。 */
function installHandlers(kernel: Kernel, cfg: { config: typeof settingsConfig }): void {
  const view = () => structuredClone(cfg.config)
  kernel.onQuery('config.view', () => view())
  const needPin = (before: typeof settingsConfig, after: { venues?: Array<{ id: string; environment: string; enabled: boolean }>; accounts?: Array<{ alias: string; mode: string }> }): boolean => {
    const venues = after.venues ?? before.venues
    const trading = (id: string) => before.catalog.find((c) => c.venue === id)?.kind === 'trading'
    const toMainnet = before.venues.some((v) => v.environment === 'testnet' && venues.find((x) => x.id === v.id)?.environment === 'mainnet')
    const newlyEnabled = venues.some((v) => v.enabled && trading(v.id) && !before.venues.some((p) => p.id === v.id && p.enabled))
    const newLive = (after.accounts ?? []).some((a) => a.mode === 'live' && !before.accounts.some((p) => p.alias === a.alias && p.mode === 'live'))
    return toMainnet || newlyEnabled || newLive
  }
  const guard = (needs: boolean, ctx: { attestation?: unknown }) => {
    if (!needs) return
    const att = ctx.attestation as { method?: string; pin?: string } | undefined
    if (!att) throw problem('ATTESTATION_REQUIRED', 2010, 'This change requires presence proof')
    if (att.method !== 'pin' || att.pin !== PIN) throw problem('AUTH_FAILED', 5003, 'invalid PIN')
  }
  kernel.onCommand('config.venues.set', (p, ctx) => {
    const patch = (p as { patch: { venues?: typeof settingsConfig.venues; accounts?: typeof settingsConfig.accounts } }).patch
    guard(needPin(cfg.config, patch), ctx)
    cfg.config = { ...cfg.config, ...(patch.venues ? { venues: patch.venues } : {}), ...(patch.accounts ? { accounts: patch.accounts } : {}) } as typeof settingsConfig
    return { config: view(), restartRequired: true }
  })
  kernel.onCommand('config.notify.set', (p) => {
    const n = p as { channels?: typeof settingsConfig.notify.channels; rules?: typeof settingsConfig.notify.rules }
    cfg.config = { ...cfg.config, notify: { ...cfg.config.notify, ...(n.channels ? { channels: n.channels } : {}), ...(n.rules ? { rules: n.rules } : {}) } } as typeof settingsConfig
    return { notify: view().notify, restartRequired: true }
  })
  kernel.onQuery('venue.status', () => [
    { venue: 'hyperliquid', wsState: 'connected', connection: 'connected', environment: 'testnet', latencyMs: { p50: 42, p95: 88 } },
    { venue: 'binance', wsState: 'disconnected', connection: 'disconnected', environment: 'testnet', connectionDetail: 'ECONNRESET venue endpoint:443' },
  ])
  kernel.onQuery('plugin.list', () => ['telegram', 'email', 'webhook', 'discord', 'slack', 'wecom'].map((n) => ({ id: `connector.gitrader.notify-${n}`, name: n, state: 'running' })))
  kernel.onCommand('notify.test', (p) => {
    const id = (p as { channelId: string }).channelId
    return id === 'mail'
      ? { results: [{ channelId: id, ok: false, reason: 'invalid_params', retryable: false, detail: 'missing secret handle: SMTP_PASS' }] }
      : { results: [{ channelId: id, ok: true }] }
  })
  kernel.onCommand('venue.reconnect', () => ({ ok: true }))
}

const text = (rig: Rig, sel: string) => rig.ev<string>(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`)
const loaded = async (rig: Rig, cards: number) => {
  await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"]').length === ${cards} && !document.querySelector('.g5-sk')`)
  await sleep(300)
}
const cmds = (rig: Rig, action: string) => rig.kernel.commands.filter((c) => c.action === action)
const waitCmd = async (rig: Rig, action: string, n = 1) => {
  for (let i = 0; i < 100 && cmds(rig, action).length < n; i += 1) await sleep(100)
  expect(cmds(rig, action).length).toBeGreaterThanOrEqual(n)
}


// ---- 几何探针：T1 的 geometry-probe.js 里 internal(el) 漏传 selectors（首个元素就抛 TypeError，见回报「发现」），落地修好前，
// 临时取视觉稿的 check.js，把选择器换成 r5 的钩子后在页内跑（做法同记录页用例）。临时代码只在本文件，不进 src/。
const probeSource = (): string => {
  let s = readFileSync(join(repo, 'reports/visual-r5/src/check.js'), 'utf8')
  const must = (re: RegExp, to: string) => { if (!re.test(s)) throw new Error(`probe pattern missing: ${re}`); s = s.replace(re, to) }
  must(/if\(!\/\[\?&\]check\/\.test\(location\.search\)\) return;/, '')
  must(/\.card,\.float/g, '[data-g5="card"],[data-g5="float"]')
  must(/\.frame \.card/g, '[data-g5="card"]')
  must(/closest\('\.card'\)/g, `closest('[data-g5="card"]')`)
  must(/querySelectorAll\('\.al'\)/g, `querySelectorAll('.g5-al')`)
  must(/\.venue,\.mk,\.alogo,\.sw,\.cb i,\.ptag,\.readout,\.fuse/g, '.g5-venue,.g5-mk,.g5-alogo,.g5-sw,.g5-clogo,.g5-ptag,.g5-readout,.g5-fuse')
  must(/var s=document\.createElement\('script'\);s\.type='application\/json';s\.id='geom-out';s\.textContent=JSON\.stringify\(out\);document\.body\.appendChild\(s\);\s*console\.log\('GEOM '\+JSON\.stringify\(out\)\);/, 'window.__geomOut=out;')
  must(/\(document\.fonts\?document\.fonts\.ready:Promise\.resolve\(\)\)\.then\(function\(\)\{setTimeout\(run,1200\);\}\);/, 'window.__runGeom=function(){return (document.fonts?document.fonts.ready:Promise.resolve()).then(function(){run();return window.__geomOut})};')
  return s
}
type Geom = Record<string, unknown> & { docScrollX: number; alignOk: number }
const readGeometry = async (cdp: Cdp): Promise<Geom> => {
  await cdp.evaluate(`(() => { ${probeSource()} })()`)
  return await cdp.evaluate('window.__runGeom()') as Geom
}
const geometryCounts = (g: Geom): Record<string, number> => Object.fromEntries([['docScrollX', g.docScrollX], ...(['overflow', 'truncated', 'halfRows', 'escape', 'overlap', 'badFont', 'badSpace', 'align', 'numcol'] as const).map((k) => [k, (g[k] as unknown[]).length])])

// ---- 用例：几何与锚点 --------------------------------------------------------------------------------------------------------------------

const ANCHORS: Record<Page, { file: string; reg: Anchor[]; ids: string[]; geo: string[]; cards: number }> = {
  venues: { file: 'settings-venues.json', reg: anchorsVenues as Anchor[], ids: ['venues', 'accts', 'catalog', 'vdetail'], geo: ['venues', 'accts', 'catalog', 'vdetail'], cards: 4 },
  notify: { file: 'settings-notify.json', reg: anchorsNotify as Anchor[], ids: ['chans', 'rules', 'cdetail'], geo: ['chans', 'rules', 'cdetail'], cards: 3 },
  personal: { file: 'settings-personal.json', reg: anchorsPersonal as Anchor[], ids: ['nav', 'updown'], geo: ['nav', 'updown'], cards: 2 },
}
const ZERO = { docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 }
const round = (r: Rect): Rect => ({ x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, w: Math.round(r.w * 100) / 100, h: Math.round(r.h * 100) / 100 })

/** 与稿同态：交易所页选中第二行（Binance）；通知页选中 mail 并发一次测试（稿里的详情带一行失败原文）。 */
async function sameStateAsMock(rig: Rig, page: Page): Promise<void> {
  if (page === 'venues') {
    await rig.click('tr[data-venue="binance"]')
    await rig.waitFor(`document.querySelector('[data-geo="vdetail"] .g5-hd').textContent.includes('Binance')`)
  } else if (page === 'notify') {
    await rig.click('tr[data-channel="mail"]')
    await rig.waitFor(`document.querySelector('[data-geo="cdetail"] .g5-hd').textContent.includes('mail')`)
    await rig.click('[data-act="notify-test"]')
    await rig.waitFor(`!!document.querySelector('[data-act="notify-test-result"]')`)
  }
  await sleep(250)
}

describe('设置 · 三页三宽度几何与锚点', () => {
  const measured: Record<Page, Record<string, Record<string, { static: Rect; product: Rect }>>> = { venues: {}, notify: {}, personal: {} }
  for (const page of ['venues', 'notify', 'personal'] as const) {
    for (const width of WIDTHS) {
      it(`${page} ${width}×900：几何探针全 0，锚点与稿差 ≤ 4 px`, async () => {
        const a = ANCHORS[page]
        const mockCdp = await launchCdp({ width, height: 900 })
        let mock: Awaited<ReturnType<typeof measureMock>>
        try { mock = await measureMock(mockCdp, page, a.ids) } finally { await mockCdp.close() }
        const rig = await open(page, { width, top: mock.top })
        try {
          await loaded(rig, a.cards)
          await sameStateAsMock(rig, page)
          const g = await readGeometry(rig.cdp)
          expect(geometryCounts(g), JSON.stringify({ overflow: g.overflow, truncated: g.truncated, halfRows: g.halfRows, escape: g.escape, overlap: g.overlap, badFont: g.badFont, badSpace: g.badSpace, align: g.align, numcol: g.numcol }).slice(0, 1800)).toEqual(ZERO)
          expect(g.alignOk).toBeGreaterThanOrEqual(page === 'personal' ? 4 : 5)
          // 每屏实心橙主按钮 ≤ 1、流光 ≤ 1、中文最小 12 px（体检探针 audit-probe.js 的同一口径）
          const audit = await rig.ev<Record<string, number>>(readFileSync(join(repo, 'packages/workbench/design/audit-probe.js'), 'utf8'))
          expect({ solidOrange: audit.solidOrange, glow: audit.glow, cjk11: audit.cjk11 }, JSON.stringify((audit as unknown as { samples?: unknown }).samples ?? {}).slice(0, 600)).toEqual({ solidOrange: expect.any(Number), glow: expect.any(Number), cjk11: 0 })
          expect(audit.solidOrange).toBeLessThanOrEqual(1)
          expect(audit.glow).toBeLessThanOrEqual(1)
          await rig.shot(`${page}-${width}`)
          const prod = await rectsOf(rig.cdp, a.geo, (n) => `[data-geo="${n}"]`)
          measured[page][String(width)] = {}
          a.ids.forEach((id, i) => {
            const p = prod[a.geo[i]!]
            expect(p, `anchor ${id}`).not.toBeNull()
            const s = mock.rects[id]!
            measured[page][String(width)]![id] = { static: s, product: p! }
            for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(p![k] - s[k]), `${page} ${width} ${id}.${k} static=${s[k]} product=${p![k]}`).toBeLessThanOrEqual(4)
          })
          expect(rig.cdp.errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([])
        } finally { await close(rig) }
      }, 120_000)
    }
    it(`${page} 的 geo-anchors 登记齐全，登记的稿与产品矩形互差 ≤ 4 px`, () => {
      const a = ANCHORS[page]
      if (WRITE_ANCHORS) {
        const out = a.ids.map((anchor) => ({ anchor, static: Object.fromEntries(WIDTHS.map((w) => [String(w), round(measured[page][String(w)]![anchor]!.static)])), product: Object.fromEntries(WIDTHS.map((w) => [String(w), round(measured[page][String(w)]![anchor]!.product)])) }))
        writeFileSync(join(here, 'geo-anchors', a.file), JSON.stringify(out, null, 2) + '\n')
        return
      }
      expect(a.reg.map((r) => r.anchor)).toEqual(a.ids)
      for (const r of a.reg) for (const w of WIDTHS) for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(r.product[String(w)]![k] - r.static[String(w)]![k]), `${w} ${r.anchor}.${k}`).toBeLessThanOrEqual(4)
    })
  }
})

describe('设置 · 图标栏形态与红涨绿跌下的几何', () => {
  for (const page of ['venues', 'notify'] as const) {
    it(`${page} 1440 图标栏（html[data-nav="rail"]）：几何全 0`, async () => {
      const rig = await open(page, { width: 1440, top: 160 })
      try {
        await loaded(rig, ANCHORS[page].cards)
        await sameStateAsMock(rig, page)
        await rig.ev(`document.documentElement.setAttribute('data-nav', 'rail')`)
        await sleep(300)
        const g = await readGeometry(rig.cdp)
        expect(geometryCounts(g), JSON.stringify({ overflow: g.overflow, truncated: g.truncated, escape: g.escape, overlap: g.overlap, badSpace: g.badSpace, align: g.align }).slice(0, 1500)).toEqual(ZERO)
        await rig.shot(`${page}-1440-rail`)
      } finally { await close(rig) }
    }, 90_000)
  }
})

// ---- 用例：启用实盘场所 PIN 旅程 ------------------------------------------------------------------------------------------------------------

describe('交易所 · 放宽要 PIN、收紧不要', () => {
  it('启用交易场所：先武装（不发命令）→ 取消无事发生 → 再武装确认 → 弹 PIN 证明 → 成功后常驻「待重启」+ 复制命令；收紧不出 PIN', async () => {
    const rig = await open('venues')
    try {
      await loaded(rig, 4)
      expect(await rig.ev('document.querySelector(\'[aria-label="Bybit 启用"]\').getAttribute("aria-checked")')).toBe('false')
      // 放宽：武装，还没有命令
      await rig.click('[aria-label="Bybit 启用"]')
      await rig.waitFor(`!!document.querySelector('[data-geo="venues"] [data-armed]')`)
      expect(await text(rig, '[data-geo="venues"] [data-armed] .g5-what')).toContain('启用 Bybit 交易')
      expect(await rig.ev('document.activeElement && document.activeElement.getAttribute("data-act")')).toBe('arm-cancel')
      expect(cmds(rig, 'config.venues.set')).toHaveLength(0)
      expect(await rig.ev('window.__attest.calls')).toBe(0)
      // 取消：武装行消失，没有命令
      await rig.click('[data-act="arm-cancel"]')
      await rig.waitFor(`!document.querySelector('[data-armed]')`)
      expect(cmds(rig, 'config.venues.set')).toHaveLength(0)
      // 再来：死区内点确认无效
      await rig.click('[aria-label="Bybit 启用"]')
      // 武装后立刻（几毫秒内）点确认：死区内无效
      await rig.ev(`new Promise((res) => { const iv = setInterval(() => { const b = document.querySelector('[data-act="arm-confirm"]'); if (b) { clearInterval(iv); b.click(); res(1) } }, 2) })`)
      await sleep(150)
      expect(cmds(rig, 'config.venues.set')).toHaveLength(0)
      await sleep(700)
      await rig.click('[data-act="arm-confirm"]')
      await waitCmd(rig, 'config.venues.set', 2)
      // 第一次不带证明被内核要求在场证明，壳的客户端取证后重发
      const sent = cmds(rig, 'config.venues.set')
      expect(sent[0]!.attestation).toBeUndefined()
      expect(sent[1]!.attestation).toMatchObject({ method: 'pin' })
      expect(await rig.ev('window.__attest.calls')).toBe(1)
      await rig.waitFor(`document.querySelector('[aria-label="Bybit 启用"]').getAttribute('aria-checked') === 'true'`)
      expect(await rig.ev(`!!document.querySelector('[data-armed]')`)).toBe(false)
      expect(await text(rig, '[data-act="restart-flag"]')).toContain('待重启')
      expect(await text(rig, '[data-act="copy-restart"]')).toContain('复制命令')
      expect(((sent[1]!.params as { patch: { venues: Array<{ id: string; enabled: boolean }> } }).patch.venues.find((v) => v.id === 'bybit'))!.enabled).toBe(true)
      await rig.shot('venues-pin-done')
      // 收紧：直接写，不武装、不出 PIN
      await rig.click('[aria-label="Hyperliquid 启用"]')
      await waitCmd(rig, 'config.venues.set', 3)
      expect(cmds(rig, 'config.venues.set')[2]!.attestation).toBeUndefined()
      expect(await rig.ev('window.__attest.calls')).toBe(1)
      await rig.waitFor(`document.querySelector('[aria-label="Hyperliquid 启用"]').getAttribute('aria-checked') === 'false'`)
      expect(await rig.ev(`!!document.querySelector('[data-armed]')`)).toBe(false)
    } finally { await close(rig) }
  }, 90_000)

  it('PIN 层被取消 = 命令没发生：武装行给「已取消」，开关不变', async () => {
    const rig = await open('venues')
    try {
      await loaded(rig, 4)
      await rig.ev(`window.__attest.mode = 'cancel'`)
      await rig.click('[aria-label="Bybit 启用"]')
      await rig.waitFor(`!!document.querySelector('[data-armed]')`)
      await sleep(700)
      await rig.click('[data-act="arm-confirm"]')
      await rig.waitFor(`document.querySelector('[data-armed]').parentElement.textContent.includes('已取消')`)
      expect(await rig.ev('document.querySelector(\'[aria-label="Bybit 启用"]\').getAttribute("aria-checked")')).toBe('false')
      expect(cmds(rig, 'config.venues.set').every((c) => c.attestation === undefined)).toBe(true)
      expect(await rig.ev(`!!document.querySelector('[data-act="restart-flag"]')`)).toBe(false)
    } finally { await close(rig) }
  }, 60_000)

  it('未验证场所的主网选项禁用、原因写在旁边；每家只许一个实盘：实盘选项禁用 + 原因', async () => {
    const rig = await open('venues')
    try {
      await loaded(rig, 4)
      await rig.click('tr[data-venue="binance"]')
      await rig.waitFor(`document.querySelector('[data-geo="vdetail"] .g5-hd').textContent.includes('Binance')`)
      expect(await rig.ev(`document.querySelector('[data-env="mainnet"]').disabled`)).toBe(true)
      expect(await text(rig, '[data-geo="vdetail"]')).toContain('未经真网验证，仅限测试网 / 模拟盘')
      expect(await rig.ev(`document.querySelector('[data-mode="live"]').disabled`)).toBe(true)
      expect(await text(rig, '[data-geo="vdetail"]')).toContain('Binance 已有实盘账户 bn-main')
      // 已验证的 Hyperliquid：主网可选；点了先武装（放宽）
      await rig.click('tr[data-venue="hyperliquid"]')
      await rig.waitFor(`document.querySelector('[data-geo="vdetail"] .g5-hd').textContent.includes('Hyperliquid')`)
      expect(await rig.ev(`document.querySelector('[data-env="mainnet"]').disabled`)).toBe(false)
      await rig.click('[data-env="mainnet"]')
      await rig.waitFor(`!!document.querySelector('[data-geo="vdetail"] [data-armed]')`)
      expect(await text(rig, '[data-geo="vdetail"] [data-armed] .g5-what')).toContain('Hyperliquid 切到主网')
      expect(cmds(rig, 'config.venues.set')).toHaveLength(0)
    } finally { await close(rig) }
  }, 60_000)

  it('凭据栏只收句柄：填了别的东西 = 遮蔽成圆点、标「不是句柄」、保存禁用，且不发给内核', async () => {
    const rig = await open('venues')
    try {
      await loaded(rig, 4)
      await rig.click('tr[data-venue="binance"]')
      await rig.waitFor(`document.querySelector('[data-geo="vdetail"] .g5-hd').textContent.includes('Binance')`)
      const inp = '[data-geo="vdetail"] input[aria-label="apiSecret 句柄"]'
      await rig.waitFor(`!!document.querySelector('${inp}')`)
      expect(await rig.ev(`document.querySelector('${inp}').type`)).toBe('text')
      await rig.type(inp, 'sk-live-planted-secret')
      if (process.env.P9_DEBUG) { await sleep(500); console.log('DBG', await rig.ev(`(() => { const e = document.querySelector('${inp}'); return JSON.stringify({ v: e && e.value, t: e && e.type, n: document.querySelectorAll('${inp}').length, act: document.activeElement && document.activeElement.outerHTML.slice(0, 80) }) })()`)) }
      await rig.waitFor(`document.querySelector('${inp}').type === 'password'`)
      expect(await text(rig, '[data-geo="vdetail"]')).toContain('不是句柄')
      expect(await rig.ev(`document.querySelector('[data-act="detail-primary"]').disabled`)).toBe(true)
      expect(JSON.stringify(rig.kernel.commands)).not.toContain('planted')
      await rig.type(inp, 'env:BINANCE_SECRET_2')
      await rig.waitFor(`document.querySelector('${inp}').type === 'text' && !document.querySelector('[data-act="detail-primary"]').disabled`)
      expect(await text(rig, '[data-act="detail-primary"]')).toBe('保存')
    } finally { await close(rig) }
  }, 60_000)
})

// ---- 用例：通知 ---------------------------------------------------------------------------------------------------------------------------

describe('通知 · 测试原文与紧急通道', () => {
  it('发测试通知：失败给上游原文（原样），表里「最近测试」同步；送达给耗时', async () => {
    const rig = await open('notify')
    try {
      await loaded(rig, 3)
      await rig.click('tr[data-channel="mail"]')
      await rig.waitFor(`document.querySelector('[data-geo="cdetail"] .g5-hd').textContent.includes('mail')`)
      await rig.click('[data-act="notify-test"]')
      await rig.waitFor(`!!document.querySelector('[data-act="notify-test-result"]')`)
      expect(await text(rig, '[data-act="notify-test-result"]')).toBe('missing secret handle: SMTP_PASS')
      expect(cmds(rig, 'notify.test')[0]!.params).toEqual({ channelId: 'mail' })
      expect(await text(rig, 'tr[data-channel="mail"]')).toContain('失败')
      await rig.click('tr[data-channel="tg-main"]')
      await rig.waitFor(`document.querySelector('[data-geo="cdetail"] .g5-hd').textContent.includes('tg-main')`)
      await rig.click('[data-act="notify-test"]')
      await rig.waitFor(`/已送达 · [0-9.]+ s/.test(((document.querySelector('[data-act="notify-test-result"]') || {}).textContent) || '')`)
      expect(await text(rig, 'tr[data-channel="tg-main"]')).toMatch(/已送达 · [0-9.]+ s/)
      await rig.shot('notify-test-result')
    } finally { await close(rig) }
  }, 60_000)

  it('紧急通道计数 3；删最后一个紧急通道走武装行「急停将不通知任何人」，取消不发命令，确认才发；删别的通道是普通武装', async () => {
    const one = structuredClone(settingsConfig)
    one.notify.rules = [{ match: 'takeover.*', level: 'critical', channels: ['tg-main'] }, { match: 'risk.denied', level: 'warn', channels: ['tg-main', 'slack-ops'] }]
    const rig = await open('notify', { config: one })
    try {
      await loaded(rig, 3)
      expect(await text(rig, '[data-act="emergency-count"]')).toBe('紧急 1')
      await rig.click('tr[data-channel="dc-desk"]')
      await rig.waitFor(`document.querySelector('[data-geo="cdetail"] .g5-hd').textContent.includes('dc-desk')`)
      await rig.click('[data-act="channel-delete"]')
      await rig.waitFor(`!!document.querySelector('[data-armed]')`)
      expect(await text(rig, '[data-armed] .g5-what')).toBe('删除通道 dc-desk：重启后生效')
      await rig.click('[data-act="arm-cancel"]')
      await rig.click('tr[data-channel="tg-main"]')
      await rig.waitFor(`document.querySelector('[data-geo="cdetail"] .g5-hd').textContent.includes('tg-main')`)
      await rig.click('[data-act="channel-delete"]')
      await rig.waitFor(`!!document.querySelector('[data-armed]')`)
      expect(await text(rig, '[data-armed] .g5-what')).toBe('删除 tg-main：急停将不通知任何人')
      await rig.shot('notify-arm-last-emergency')
      await rig.click('[data-act="arm-cancel"]')
      await rig.waitFor(`!document.querySelector('[data-armed]')`)
      expect(cmds(rig, 'config.notify.set')).toHaveLength(0)
      await rig.click('[data-act="channel-delete"]')
      await rig.waitFor(`!!document.querySelector('[data-armed]')`)
      await sleep(700)
      await rig.click('[data-act="arm-confirm"]')
      await waitCmd(rig, 'config.notify.set')
      const sent = cmds(rig, 'config.notify.set')[0]!.params as { channels: Array<{ id: string }>; rules: Array<{ match: string; channels: string[] }> }
      expect(sent.channels.map((c) => c.id)).toEqual(['mail', 'hook-ops', 'dc-desk', 'slack-ops', 'wecom-ops'])
      expect(sent.rules.find((r) => r.match === 'takeover.*')!.channels).toEqual([])
      await rig.waitFor(`!document.querySelector('tr[data-channel="tg-main"]')`)
      expect(await text(rig, '[data-act="emergency-count"]')).toContain('未设紧急通道')
      expect(await text(rig, '[data-act="restart-flag"]')).toContain('待重启')
    } finally { await close(rig) }
  }, 90_000)

  it('新增通道：参数名只能从内核句柄名清单里选，值只收句柄；填了别的东西 = 遮蔽、不能添加、不发给内核', async () => {
    const rig = await open('notify')
    try {
      await loaded(rig, 3)
      await rig.click('[data-act="channel-add"]')
      await rig.waitFor(`!!document.querySelector('[data-act="plugin-pick"]')`)
      expect(await rig.ev(`!!document.querySelector('[data-geo="cdetail"] input[aria-label="参数名"]')`)).toBe(false)
      expect(await text(rig, '[data-geo="cdetail"]')).not.toMatch(/密码|令牌|密钥/)
      await rig.click('[data-act="plugin-pick"]')
      await rig.waitFor(`!!document.querySelector('[role="menuitemradio"][data-v="connector.gitrader.notify-email"]')`)
      await rig.click('[role="menuitemradio"][data-v="connector.gitrader.notify-email"]')
      await rig.waitFor(`!!document.querySelector('[data-act="param-pick"]') && !document.querySelector('[role="menu"]')`)
      await rig.click('[data-act="param-pick"]')
      await rig.waitFor(`!!document.querySelector('[role=menu] [data-v="password"]')`)
      await rig.click('[role=menu] [data-v="password"]')
      await rig.waitFor(`!document.querySelector('[role="menu"]')`)
      await rig.waitFor(`document.querySelector('[data-act="param-pick"]').textContent.includes('password')`)
      const inp = '[data-geo="cdetail"] input[aria-label="句柄值"]'
      await rig.type(inp, 'sk-live-planted-secret')
      await rig.waitFor(`document.querySelector('${inp}').type === 'password'`)
      expect(await rig.ev(`document.querySelector('[data-act="param-add"]').disabled`)).toBe(true)
      expect(await text(rig, '[data-geo="cdetail"]')).toContain('不是句柄')
      await rig.type(inp, 'env:NEW_SMTP_PASS')
      await rig.waitFor(`!document.querySelector('[data-act="param-add"]').disabled`)
      await rig.click('[data-act="param-add"]')
      await rig.type('[data-geo="cdetail"] input[aria-label="名称"]', 'mail-2')
      await rig.waitFor(`!document.querySelector('[data-act="channel-create"]').disabled`)
      await rig.click('[data-act="channel-create"]')
      await waitCmd(rig, 'config.notify.set')
      const sent = cmds(rig, 'config.notify.set')
      expect(JSON.stringify(sent)).not.toContain('planted')
      expect((sent[0]!.params as { channels: Array<{ id: string; params: unknown }> }).channels.find((c) => c.id === 'mail-2')!.params).toEqual({ password: 'env:NEW_SMTP_PASS' })
    } finally { await close(rig) }
  }, 90_000)

  it('改最低级别 / 规则级别：收紧放宽都不要 PIN，直接写；限速只读展示', async () => {
    const rig = await open('notify')
    try {
      await loaded(rig, 3)
      expect(await text(rig, '[data-act="rate-limit"]')).toBe('20 条 / 分')
      expect(await text(rig, '[data-act="dedupe-window"]')).toBe('300 s')
      await rig.click('tr[data-channel="hook-ops"] .g5-dd')
      await rig.waitFor(`!!document.querySelector('[role="menuitemradio"][data-v="critical"]')`)
      await rig.click('[role="menuitemradio"][data-v="critical"]')
      await waitCmd(rig, 'config.notify.set')
      const sent = cmds(rig, 'config.notify.set')[0]!
      expect((sent.params as { channels: Array<{ id: string; minLevel: string }> }).channels.find((c) => c.id === 'hook-ops')!.minLevel).toBe('critical')
      expect(sent.attestation).toBeUndefined()
    } finally { await close(rig) }
  }, 60_000)
})

// ---- 用例：个性化 --------------------------------------------------------------------------------------------------------------------------

describe('个性化 · 两项切换', () => {
  it('导航形态只改 html[data-nav] 并写 prefs；涨跌配色只改 html[data-updown]，--gr-up / --gr-down 互换，预览瓦片不随全站模式', async () => {
    const rig = await open('personal', { top: 160 })
    try {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready')`)
      const up = () => rig.ev<string>(`getComputedStyle(document.documentElement).getPropertyValue('--gr-up').trim()`)
      const down = () => rig.ev<string>(`getComputedStyle(document.documentElement).getPropertyValue('--gr-down').trim()`)
      const tile = (mode: string) => rig.ev<string>(`getComputedStyle(document.querySelector('.g5-ppvw[data-updown="${mode}"] .g5-pcdl i[data-d="u"]')).backgroundColor`)
      const [up0, down0] = [await up(), await down()]
      expect(up0).not.toBe(down0)
      const intlTile0 = await tile('intl')
      const cnTile0 = await tile('cn')
      expect(intlTile0).not.toBe(cnTile0)
      expect(await rig.ev(`document.documentElement.getAttribute('data-nav')`)).toBeNull()
      // 导航形态
      await rig.click('[data-k="nav"][data-v="rail"]')
      await rig.waitFor(`document.documentElement.getAttribute('data-nav') === 'rail'`)
      expect(await rig.ev(`document.querySelector('[data-k="nav"][data-v="rail"]').getAttribute('aria-pressed')`)).toBe('true')
      expect(await rig.ev(`document.querySelector('[data-k="nav"][data-v="top"]').getAttribute('aria-pressed')`)).toBe('false')
      expect(await rig.ev('window.__prefsLog')).toEqual([{ navForm: 'rail' }])
      expect(await rig.ev(`document.documentElement.hasAttribute('data-updown') && document.documentElement.getAttribute('data-updown')`)).toBe('intl')
      await rig.click('[data-k="nav"][data-v="top"]')
      await rig.waitFor(`document.documentElement.getAttribute('data-nav') === 'top'`)
      // 涨跌配色
      await rig.click('[data-k="updown"][data-v="cn"]')
      await rig.waitFor(`document.documentElement.getAttribute('data-updown') === 'cn'`)
      expect(await up()).toBe(down0)
      expect(await down()).toBe(up0)
      expect(await rig.ev(`document.querySelector('[data-k="updown"][data-v="cn"]').getAttribute('aria-pressed')`)).toBe('true')
      expect((await rig.ev('window.__prefsLog')) as unknown[]).toEqual([{ navForm: 'rail' }, { navForm: 'top' }, { updown: 'cn' }])
      // 预览瓦片不随全站模式
      expect(await tile('intl')).toBe(intlTile0)
      expect(await tile('cn')).toBe(cnTile0)
      await rig.shot('personal-1440-cn')
      await rig.click('[data-k="updown"][data-v="intl"]')
      await rig.waitFor(`document.documentElement.getAttribute('data-updown') === 'intl'`)
      expect(await up()).toBe(up0)
    } finally { await close(rig) }
  }, 60_000)
})

// ---- 用例：四态 + 未接通 -------------------------------------------------------------------------------------------------------------------

describe('三态以外的四态与未接通（每页每态一张截图）', () => {
  const PAGES: Array<{ page: 'venues' | 'notify'; cards: number; first: string }> = [{ page: 'venues', cards: 4, first: '[data-geo="venues"]' }, { page: 'notify', cards: 3, first: '[data-geo="chans"]' }]
  for (const { page, cards, first } of PAGES) {
    it(`${page} · 加载：骨架占位，不显示任何数据`, async () => {
      const rig = await open(page, { state: 'loading' })
      try {
        await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('.g5-sk').length > 3`)
        expect(await rig.ev(`document.querySelectorAll('[data-g5="card"] tr[data-venue], [data-g5="card"] tr[data-channel]').length`)).toBe(0)
        await rig.shot(`${page}-loading`)
      } finally { await close(rig) }
    }, 60_000)

    it(`${page} · 空：一行事实`, async () => {
      const rig = await open(page, { state: 'empty' })
      try {
        await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"]').length === ${cards} && !document.querySelector('.g5-sk')`)
        await sleep(300)
        expect(await text(rig, first)).toContain(page === 'venues' ? '还没有交易所' : '还没有通知通道')
        await rig.shot(`${page}-empty`)
      } finally { await close(rig) }
    }, 60_000)

    it(`${page} · 错误：内核原文不改写、给重试`, async () => {
      const rig = await open(page, { state: 'error' })
      try {
        await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && !!document.querySelector('${first} .g5-pmsg')`)
        const t = await text(rig, first)
        expect(t).toContain('读取失败')
        expect(t).toContain('The local fixture cannot provide this view.')
        expect(t).toContain('重试')
        expect(t).not.toContain('未接通')
        await rig.shot(`${page}-error`)
      } finally { await close(rig) }
    }, 60_000)

    it(`${page} · 未接通：灰字「未接通」+ 内核原文，不给重试`, async () => {
      const rig = await open(page, { state: 'unwired' })
      try {
        await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && !!document.querySelector('${first} [data-wire="off"]')`)
        const t = await text(rig, first)
        expect(t).toContain('未接通')
        expect(t).not.toContain('重试')
        expect((await text(rig, `${first} [data-wire="off"]`)).length).toBeGreaterThan('未接通'.length)
        await rig.shot(`${page}-unwired`)
      } finally { await close(rig) }
    }, 60_000)

    it(`${page} · 离线：卡变灰、控件禁用、写「已暂停更新」，恢复后回来`, async () => {
      const rig = await open(page, { state: 'offline' })
      try {
        await loaded(rig, cards)
        await rig.ev(`document.documentElement.setAttribute('data-offline', '')`)
        await rig.waitFor(`document.querySelectorAll('[data-g5="card"].g5-off').length === ${cards}`)
        expect(await text(rig, first)).toContain('已暂停更新')
        expect(await rig.ev(`[...document.querySelectorAll('[data-g5="card"] button[role="switch"], [data-g5="card"] [data-act="channel-add"], [data-g5="card"] [data-act="catalog-attach"]')].every((b) => b.disabled)`)).toBe(true)
        await rig.shot(`${page}-offline`)
        await rig.ev(`document.documentElement.removeAttribute('data-offline')`)
        await rig.waitFor(`document.querySelectorAll('[data-g5="card"].g5-off').length === 0`)
      } finally { await close(rig) }
    }, 60_000)
  }
})

// ---- 红涨绿跌：交易所 / 通知两页本身没有涨跌数据，涨跌互换只验个性化页（上面）；这里补一张对照图用的 1440 红涨绿跌整页截图 ---------------------------------------
describe('截图补充', () => {
  it('personal 1440 缺省', async () => {
    const rig = await open('personal', { top: 160 })
    try {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready')`)
      await sleep(300)
      await rig.shot('personal-1440-intl')
    } finally { await close(rig) }
  }, 60_000)
})

// ---- 对照图：视觉稿 1440 截图（左）与产品页 1440 截图（右）拼一张，落 P9-shots/compare-*.png --------------------------------------------------------
describe('对照图', () => {
  for (const page of ['venues', 'notify', 'personal'] as const) {
    it(`${page}：稿 | 产品`, async () => {
      const mock = join(mockDir, `settings-${page}`, `settings-${page}-1440.png`)
      const prod = join(shotsDir, `${page}-1440.png`)
      const dir = mkdtempSync(join(tmpRoot, 'cmp-'))
      const file = join(dir, 'cmp.html')
      const url = (p: string) => `file:///${p.split(String.fromCharCode(92)).join('/')}`
      writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222;display:flex;gap:20px;padding:20px;font:14px sans-serif;color:#ccc"><div><div>视觉稿 settings-${page}-1440</div><img src="${url(mock)}" width="1440"></div><div><div>产品页 ${page}-1440</div><img src="${url(prod)}" width="1440"></div></body>`)
      const cdp = await launchCdp({ width: 2940, height: 980 })
      try {
        await cdp.navigate(url(file))
        await sleep(500)
        expect(await cdp.evaluate(`[...document.images].every((i) => i.complete && i.naturalWidth > 0)`)).toBe(true)
        writeFileSync(join(shotsDir, `compare-${page}-1440.png`), await cdp.screenshot())
      } finally { await cdp.close() }
    }, 60_000)
  }
})
