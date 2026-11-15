// SPDX-License-Identifier: CPAL-1.0
// 总览页浏览器用例：CDP 直连本机 Edge（无头），夹具内核 + 本文件现场打包的舞台页。
// 壳的 ?ui=r5 路由与全局待批槽还没落地时，舞台页把五个视图挂成与视觉稿同版式：资金卡（statusbar 块）在框架里，持仓 / 活动在左列，风险 / Agent 在右列，
// 待批浮层（agent-activity {view:'pending'}）作为框架的直接子节点（它是 position:absolute，盖在右列上方）。舞台页只存在于本文件与临时目录，不进 src/。
// 不设 GITRADER_SKIP_BROWSER，没有 Edge 就直接失败。设 GITRADER_SHOTS_DIR 才写截图。
// 命令比对：数据形状 = blocks-default 的假内核场景，命令走 installScenario 同一份代码，调用记录在 stage.calls，与 r4 的块发出的命令逐字相同。
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KEY_CLAUDE, PIN } from '../../blocks-default/fixtures/scenarios'
import { problem } from '../../workbench/verify/fixture-kernel'
import { overviewScenario, type OverviewState } from '../fixtures/overview'
import { startStage } from '../verify/stage-entry'
import anchorsJson from './geo-anchors/overview.json'
import { captureAnchors } from './helpers/anchors'
import { launchCdp } from './helpers/cdp'
import { geometryCounts, readGeometry } from './helpers/geo'

const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const shotsDir = process.env.GITRADER_SHOTS_DIR
const auditSource = readFileSync(resolve(pkgDir, '../workbench/design/audit-probe.js'), 'utf8')
const referencePage = resolve(here, '../../../reports/visual-r5/overview/index.html')
const WIDTHS = [1280, 1440, 1920] as const
const CARDS = ['持仓与挂单', '活动', '风险', 'Agent'] as const
// X1 ⑨ / ⑮（维护者验收）：待批浮层里理由完整折行（稿里一行 24 px → 夹具理由折两行，+24）、队列行改「内容列 + 独立倒计时列」（40 → 76，+36），浮层比稿高 60 px；
// 只在待批浮层的高度上加这 60 px，其余锚点与 4 px 容差不变。
const PEND_EXTRA_H = 60
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const DIAG = "document.body.innerText.slice(0, 600) + ' | cards=' + document.querySelectorAll('[data-g5=card]').length + ' sk=' + document.querySelectorAll('.g5-sk').length + ' ready=' + document.documentElement.hasAttribute('data-ready') + ' pend=' + document.documentElement.getAttribute('data-pend')"
const anchors = anchorsJson.widths as unknown as Record<string, Record<string, number[]>>

// ---- 舞台页：视图按稿的版式挂好；桥是真的（真 KernelClient 连夹具内核，经 createHostBridge 校验清单） --------------------------------------------

const ENTRY = `
import { render } from 'preact'
import { KernelClient, LinkHub, createHostBridge } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { agentActivityBlock, positionsBlock, riskBlock, statusBarBlock } from './src/pages/overview'
import '../workbench/src/ui/theme.css'
import '../workbench/src/ui/r5/components.css'
const w = window
const H = w.__H
// 用例舞台页没有壳；行情新鲜度由壳写在 <html data-feed>（D1），缺省按陈旧处理（去涨跌色、出「行情中断」）。这里模拟壳已判定为实时。
document.documentElement.dataset.feed = 'live'
;(async () => {
  const boot = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: H.boot }) }).then((r) => r.json())
  const client = new KernelClient({ url: H.ws, getToken: () => boot.sessionToken, WebSocketCtor: WebSocket, reconnect: false })
  await client.connect()
  w.__attest = { mode: 'pin', calls: 0 }
  client.setAttestor(async () => { w.__attest.calls += 1; return w.__attest.mode === 'cancel' ? null : { method: 'pin', pin: H.pin } })
  const hub = new LinkHub({ A: {} })
  w.__hub = hub
  const mount = (def, id, config, hostId) => {
    const bridge = createHostBridge({ manifest: def.manifest, kernel: client, hub, instanceId: id, trusted: true, isUserActive: () => true })
    const host = document.createElement('div')
    host.style.display = 'contents'
    document.getElementById(hostId).appendChild(host)
    const C = def.component
    render(<BridgeContext.Provider value={bridge}><C bridge={bridge} instanceId={id} config={config} setConfig={() => undefined} channel="A" grid={{ w: 1, h: 1 }} mode="tile" /></BridgeContext.Provider>, host)
  }
  mount(statusBarBlock, 'bi_status_1', {}, 'fundHost')
  mount(positionsBlock, 'bi_positions_1', { view: 'all' }, 'colL')
  mount(agentActivityBlock, 'bi_agent_feed_1', { view: 'feed' }, 'colL')
  mount(riskBlock, 'bi_risk_1', {}, 'colR')
  mount(agentActivityBlock, 'bi_agent_keys_1', { view: 'keys' }, 'colR')
  mount(agentActivityBlock, 'bi_agent_1', { view: 'pending' }, 'popHost')
  document.documentElement.setAttribute('data-ready', '1')
})()
`

const HTML = `<!doctype html>
<html lang="zh-CN" data-ui="r5" data-updown="intl"><head><meta charset="utf-8"><title>overview</title><link rel="stylesheet" href="app.css"><link rel="stylesheet" href="stage.css"></head>
<body><main class="g5-frame"><header class="g5-topbar"></header><div id="fundHost" style="display:contents"></div>
<div class="g5-ws"><div class="g5-col" id="colL"></div><div class="g5-col" id="colR"></div></div><div id="popHost" style="display:contents"></div></main>
<script src="h.js"></script><script src="geometry-probe.js"></script><script src="app.js"></script></body></html>`

// 图标栏版式的框架规则：components.css 里同名规则写成 `:root[data-ui] [data-nav]`（只匹配 <html> 的后代），而 data-nav 实际挂在 <html> 上（Personal.jsx），匹配不到——
// 舞台页自己补 <html> 版本来量总览内容在图标栏版式下的几何；这条差异写进 P1 回报（需要主会话在 components.css 补）。
const STAGE_CSS = `:root[data-ui="r5"][data-nav="rail"] .g5-topbar{display:none}
:root[data-ui="r5"][data-nav="rail"] .g5-frame{padding-left:calc(var(--gr-rail-w) + var(--gr-gutter));padding-top:12px}`

let staticDir = ''
let tmpRoot = ''
const live: Rig[] = []

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(home, 'overview-browser-'))
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
    stdin: { contents: ENTRY, resolveDir: pkgDir, loader: 'tsx', sourcefile: 'overview-stage.tsx' },
    bundle: true, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'silent',
    loader: { '.js': 'jsx', '.png': 'binary', '.woff2': 'file' }, assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, plugins: [svgText as never],
    define: { __GITRADER_VERSION__: '"overview-stage"', 'process.env.NODE_ENV': '"production"' },
    outfile: join(staticDir, 'app.js'),
  })
})

afterAll(async () => {
  for (const x of live.splice(0)) await x.close()
  if (tmpRoot && resolve(tmpRoot).startsWith(resolve(home) + sep)) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

// ---- 起一套：夹具内核 + 无头 Edge + 打开舞台页 ---------------------------------------------------------------------------------------------

type Started = Awaited<ReturnType<typeof startStage>>
type Call = { action: string; params: Record<string, unknown>; attested: boolean }
interface Rig {
  started: Started
  cdp: Awaited<ReturnType<typeof launchCdp>>
  ev<T = unknown>(expr: string): Promise<T>
  waitFor(expr: string, ms?: number): Promise<void>
  settled(): Promise<void>
  /** 夹具内核收到的命令（含有没有带在场证明）。 */
  calls: Call[]
  shot(name: string): Promise<void>
  close(): Promise<void>
}
interface OpenOptions {
  /** 在页面打开之前对场景动一次手。 */
  scenario?: (sc: ReturnType<typeof overviewScenario>) => void
  queryDelayMs?: number
  /** 页面打开之前对夹具内核再动一次手（覆盖某个查询之类）。 */
  prepare?: (started: Started) => void
  fault?: Started['stage']['fault']
}

async function open(state: OverviewState, width: number, opts: OpenOptions = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpRoot, 'k-'))
  const pub = join(dir, 'static')
  mkdirSync(pub)
  writeFileSync(join(pub, 'app.js'), readFileSync(join(staticDir, 'app.js')))
  writeFileSync(join(pub, 'app.css'), readFileSync(join(staticDir, 'app.css')))
  // 内核的 CSP 不许内联脚本：几何探针当同源文件加载（readGeometry 的内联注入会被 CSP 挡掉，用已加载的 window.__grGeometry）
  writeFileSync(join(pub, 'geometry-probe.js'), readFileSync(resolve(pkgDir, '../workbench/design/geometry-probe.js')))
  writeFileSync(join(pub, 'stage.css'), STAGE_CSS)
  writeFileSync(join(pub, 'index.html'), HTML)
  const started = await startStage({ staticDir: pub, workspacesDir: join(dir, 'workspaces'), scenario: `overview-${state === 'unwired' || state === 'offline' ? 'normal' : state}` })
  const sc = overviewScenario(state)
  opts.scenario?.(sc)
  started.stage.sc = sc
  started.stage.fault = { ...(opts.queryDelayMs ? { queryDelayMs: opts.queryDelayMs } : {}), ...(opts.fault ?? {}) }
  if (state === 'unwired') {
    for (const m of ['account.list', 'account.positions', 'account.summary', 'account.orders', 'account.fills', 'proposal.list', 'agentkey.list', 'mandate.list', 'risk.state', 'ledger.query', 'venue.status']) {
      started.kernel.onQuery(m, () => { throw problem('METHOD_NOT_FOUND', -32601, `未知查询 ${m}`) })
    }
  }
  opts.prepare?.(started)
  // 内核的 CSP 只许同源脚本：引导令牌与地址放进同源的 h.js，不用内联脚本
  writeFileSync(join(pub, 'h.js'), `window.__H=${JSON.stringify({ boot: started.kernel.bootstrapToken, ws: started.kernel.wsUrl, pin: PIN })}`)
  // launchCdp 自带 EBUSY 重试（helpers/cdp.ts 的 retryBusy）；启动失败时先关掉本次的夹具内核
  const cdp = await launchCdp({ width, height: 900 }).catch(async (e: unknown) => { await started.kernel.close(); throw e })
  const rig: Rig = {
    started, cdp, calls: started.stage.calls,
    ev: (expr) => cdp.evaluate(expr) as Promise<never>,
    async waitFor(expr, ms = 15_000) {
      const t0 = Date.now()
      for (;;) {
        if (await cdp.evaluate(expr)) return
        if (Date.now() - t0 > ms) throw new Error(`等待超时：${expr}\n页面错误：${JSON.stringify(cdp.errors)}\n${String(await cdp.evaluate(DIAG))}`)
        await sleep(100)
      }
    },
    async settled() {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"]').length === 4 && !document.querySelector('.g5-sk') && document.documentElement.hasAttribute('data-pend')`)
      await sleep(250)
    },
    async shot(name) {
      if (!shotsDir) return
      mkdirSync(shotsDir, { recursive: true })
      writeFileSync(join(shotsDir, `${name}.png`), await cdp.screenshot())
    },
    async close() { await cdp.close(); await started.kernel.close() },
  }
  live.push(rig)
  await cdp.navigate(`${started.kernel.url}/`)
  return rig
}

async function using(state: OverviewState, width: number, opts: OpenOptions, fn: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await open(state, width, opts)
  try { await fn(rig) } finally {
    await rig.close()
    live.splice(0, live.length, ...live.filter((x) => x !== rig))
  }
}

const card = (label: string) => `document.querySelector('[data-g5="card"][aria-label="${label}"]')`
const text = (rig: Rig, label: string) => rig.ev<string>(`${card(label)}.innerText`)
const click = (rig: Rig, selector: string) => rig.ev<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
const pendOf = (rig: Rig) => rig.ev<string | null>(`document.documentElement.getAttribute('data-pend')`)
const callsOf = (rig: Rig, action: string) => rig.calls.filter((c) => c.action === action)
const rectsJs = `Object.fromEntries([...document.querySelectorAll('[data-g5="card"],[data-g5="fund"],[data-g5="float"]')].filter((c) => c.getClientRects().length).map((c) => { const r = c.getBoundingClientRect(); return [c.getAttribute('aria-label'), { x: r.left, y: r.top, w: r.width, h: r.height }] }))`

// ---- 用例 ----------------------------------------------------------------------------------------------------------------------------------

describe('overview page · 三宽度几何与锚点', () => {
  for (const width of WIDTHS) {
    it(`${width}×900：几何探针全 0；资金卡 / 四张卡 / 待批浮层矩形与视觉稿相差 ≤ 4 px；每屏流光 ≤ 1、实心主按钮 ≤ 1`, async () => {
      await using('normal', width, {}, async (rig) => {
        await rig.settled()
        expect(await pendOf(rig)).toBe('collapsed')
        expect(await click(rig, '[data-act="pending"]')).toBe(true)
        await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open' && getComputedStyle(document.getElementById('g5-pendpop')).display !== 'none'`)
        await sleep(300)
        const g = await readGeometry(rig.cdp).catch(async (e) => { throw new Error(String(e) + JSON.stringify(rig.cdp.errors) + String(await rig.ev(DIAG))) })
        expect(geometryCounts(g), JSON.stringify(g)).toEqual({ docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 })
        expect(g.alignOk).toBeGreaterThan(20)
        expect(g.numcolOk).toBeGreaterThan(8)
        const rects = await rig.ev<Record<string, { x: number; y: number; w: number; h: number }>>(rectsJs)
        const want = anchors[String(width)]!
        const names = { 资金: '资金', 持仓与挂单: '持仓与挂单', 活动: '活动', 风险: '风险', Agent: 'Agent', 待批: '待批' } as const
        expect(Object.keys(rects).sort()).toEqual(Object.keys(names).sort())
        for (const name of Object.keys(names)) {
          const [x, y, w, h] = want[name]!
          const r = rects[name]!
          for (const [axis, wantV, got] of [['x', x, r.x], ['y', y, r.y], ['w', w, r.w], ['h', h, r.h]] as const) {
            expect(Math.abs(got - (wantV! + (name === '待批' && axis === 'h' ? PEND_EXTRA_H : 0))), `${width} ${name}.${axis}: 稿 ${wantV} 页 ${got}`).toBeLessThanOrEqual(4)
          }
        }
        const audit = await rig.ev<Record<string, number>>(auditSource)
        expect(audit.glow).toBeLessThanOrEqual(1)
        expect(audit.solidOrange).toBeLessThanOrEqual(1)
        expect(audit.capsule).toBe(0)
        expect(audit.sizeViolations).toBe(0)
        expect(audit.cjk11).toBe(0)
        expect(audit.coloredZero).toBe(0)
        await rig.shot(`overview-${width}`)
      })
    })
  }

  for (const width of WIDTHS) {
    it(`${width}×900 图标栏版式（html[data-nav="rail"]）：几何探针全 0；矩形与稿 ?nav=rail 相差 ≤ 4 px`, async () => {
      await using('normal', width, {}, async (rig) => {
        await rig.settled()
        await rig.ev(`document.documentElement.setAttribute('data-nav', 'rail')`)
        expect(await click(rig, '[data-act="pending"]')).toBe(true)
        await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open' && getComputedStyle(document.getElementById('g5-pendpop')).display !== 'none'`)
        await sleep(400)
        const g = await readGeometry(rig.cdp)
        expect(geometryCounts(g), JSON.stringify(g)).toEqual({ docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 })
        const rects = await rig.ev<Record<string, { x: number; y: number; w: number; h: number }>>(rectsJs)
        const want = (anchorsJson as unknown as { rail: Record<string, Record<string, number[]>> }).rail[String(width)]!
        for (const name of Object.keys(want)) {
          const [x, y, w, h] = want[name]!
          const r = rects[name]!
          for (const [axis, wantV, got] of [['x', x, r.x], ['y', y, r.y], ['w', w, r.w], ['h', h, r.h]] as const) {
            expect(Math.abs(got - (wantV! + (name === '待批' && axis === 'h' ? PEND_EXTRA_H : 0))), `rail ${width} ${name}.${axis}: 稿 ${wantV} 页 ${got}`).toBeLessThanOrEqual(4)
          }
        }
        if (width === 1440) await rig.shot('overview-1440-rail')
      })
    })
  }

  it.skipIf(!existsSync(referencePage))('登记的稿矩形与现稿一致（三宽度，视觉稿实测）', async () => {
    for (const width of WIDTHS) {
      const cdp = await launchCdp({ width, height: 900 })
      try {
        await cdp.navigate(new URL(`file:///${referencePage.replace(/\\/g, '/')}`).href)
        await cdp.evaluate('new Promise((r) => setTimeout(r, 1500))')
        const specs = [['资金', '.frame .fund'], ['持仓与挂单', '#pos'], ['活动', '#act'], ['风险', '#risk'], ['Agent', '#agent'], ['待批', '#pendpop']].map(([name, sel]) => ({ name: name!, reference: sel!, product: sel! }))
        const snap = await captureAnchors(cdp, specs, 'reference')
        for (const spec of specs) {
          const want = anchors[String(width)]![spec.name]!
          const r = snap.rects[spec.name]!
          expect([r.x, r.y, r.width, r.height].map((v) => Math.round(v))).toEqual(want.map((v) => Math.round(v)))
        }
      } finally { await cdp.close() }
    }
  })

  it('待批浮层三态：没有待批 = none（芯片换成 0、浮层不显示）；有待批缺省 collapsed；点芯片开合；Esc / 收起钮回到 collapsed；卡位置三态相同', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await pendOf(rig)).toBe('collapsed')
      expect(await rig.ev(`getComputedStyle(document.getElementById('g5-pendpop')).display`)).toBe('none')
      const base = await rig.ev<Record<string, { x: number; y: number; w: number; h: number }>>(rectsJs)
      expect(await click(rig, '[data-act="pending"]')).toBe(true)
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open' && document.querySelector('[data-act="pending"]').getAttribute('aria-expanded') === 'true'`)
      await sleep(200)
      const open = await rig.ev<Record<string, { x: number; y: number; w: number; h: number }>>(rectsJs)
      for (const name of ['资金', ...CARDS]) expect(open[name], name).toEqual(base[name])
      expect(await rig.ev(`document.getElementById('g5-pendpop').getAttribute('data-pend')`)).toBe('open')
      await rig.shot('overview-1440-open')
      await rig.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'collapsed'`)
      expect(await click(rig, '[data-act="pending"]')).toBe(true)
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open'`)
      expect(await click(rig, '[data-act="pend-collapse"]')).toBe(true)
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'collapsed'`)
      await rig.shot('overview-1440-collapsed')
    })
    await using('normal', 1440, { scenario: (sc) => { sc.proposals = sc.proposals.filter((p) => p.status !== 'pending') } }, async (rig) => {
      await rig.settled()
      expect(await pendOf(rig)).toBe('none')
      expect(await rig.ev(`getComputedStyle(document.querySelector('[data-act="pending"]')).display`)).toBe('none')
      expect(await rig.ev(`getComputedStyle(document.querySelector('[data-p="0"]')).display`)).not.toBe('none')
      expect(await rig.ev<string>(`document.querySelector('[data-p="0"]').innerText`)).toContain('0')
      const g = await readGeometry(rig.cdp)
      expect(geometryCounts(g), JSON.stringify(g)).toEqual({ docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 })
      await rig.shot('overview-1440-nopending')
    })
  })

  it('最急一张剩余 ≤ 60 s 自动展开（每张只一次）：人手收起后不再抢开', async () => {
    await using('normal', 1440, { scenario: (sc) => { for (const p of sc.proposals) if (p.status === 'pending' && p.ticket === 'T-0007') { (p as { expiresAt: number }).expiresAt = Date.now() + 70_000 } } }, async (rig) => {
      await rig.settled()
      expect(await pendOf(rig)).toBe('collapsed')
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open'`, 30_000)
      expect(await click(rig, '[data-act="pend-collapse"]')).toBe(true)
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'collapsed'`)
      await sleep(2500)
      expect(await pendOf(rig)).toBe('collapsed')
    })
  })
})

describe('overview page · 内容与数字（正常态）', () => {
  it('资金卡：实盘 12,480.20 · 今日 +128.40 · +1.04% · 纸面 9,987.50 / −12.50 · 风险 · 网络 · 待批 2 最急 mm:ss · 接管', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const t = await rig.ev<string>(`document.querySelector('[data-g5="fund"]').innerText.replace(/\\s+/g, ' ')`)
      for (const w of ['实盘权益', '12,480', '.20', 'USDC', '今日', '+128.40', '+1.04%', '纸面', '9,987.50', '−12.50', '风险', '正常交易', '测试网', '已连接', '42 ms', '待批', '2', '最急', '接管']) expect(t, w).toContain(w)
      expect(await rig.ev<string>(`document.querySelector('[data-act="pending"]').innerText`)).toMatch(/最急 0[23]:\d\d/)
    })
  })

  it('持仓表：实盘 / 纸面两组，小计只组内加（+27.76 / +45.60）；行内容、止损、开仓方；挂单页签', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const rows = await rig.ev<string[]>(`[...document.querySelectorAll('[data-tab="positions"] tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText.replace(/\\s+/g, ' ').trim()).join('|'))`)
      expect(rows[0]).toContain('hl-main')
      expect(rows[0]).toContain('实盘 3')
      expect(rows[0]).toContain('+27.76')
      const flat = rows.join('\n')
      // X1 ②（维护者验收）：价格按标的精度展示、去掉多余尾零（共享 display.formatPrice），旧稿的「64,210.0」写法不再适用
      for (const w of ['BTC', '多 4×', '0.08', '64,210', '64,812', '+48.16', 'ROE +3.72%', '52,100', '距 19.6%', '63,100', 'ema-trend', 'ETH', '空 2×', '+69.60', '未设', 'Claude Code', 'SOL', '−90.00', '你', 'paper-1', '纸面 1', '+45.60', 'grid-paper']) expect(flat, w).toContain(w)
      expect(await text(rig, '持仓与挂单')).toContain('Hyperliquid')
      expect(await click(rig, '[data-tab="ord"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-tab="orders"]')`)
      const ord = await text(rig, '持仓与挂单')
      // X1 ②：委托价按标的精度展示、去掉多余尾零（旧稿「63,100.0」写法不再适用）
      for (const w of ['止损\u3000只减仓', '63,100', '限价', '64,400', '65,200', '撤单', '你', 'grid-paper']) expect(ord, w).toContain(w)
      expect(await rig.ev('document.querySelectorAll("[data-tab=orders] tbody tr.g5-row").length')).toBe(3)
    })
  })

  it('风险卡：限额五条（单笔 / 日亏 / 总敞口 / 杠杆 / 日笔数）· 笔数 17/20 转琥珀 · 保护器 6 · 触发 1 次', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const t = await text(rig, '风险')
      for (const w of ['正常交易', '停止新开仓', '撤销挂单', '全部平仓', '单笔', '3,246.5', '/ 8,000', '日笔数', '17', '/ 20', '触发 1 次', '止损保护', '触发 1 次']) expect(t, w).toContain(w)
      // X1 ⑳：「保护器」现在是带悬停说明的 Term（flex 子项），innerText 在名称与数量之间断行；视觉上仍是同一行「保护器 6」，按空白折叠后断言
      expect(t.replace(/\s+/g, ' '), '保护器 6').toContain('保护器 6')
      expect(await rig.ev('document.querySelectorAll("[data-view=risk] .g5-lim").length')).toBe(5)
      expect(await rig.ev('document.querySelector("[data-limit=日笔数] .g5-v").classList.contains("g5-warn")')).toBe(true)
      expect(await rig.ev('document.querySelectorAll("[data-view=risk] .g5-pr").length')).toBe(6)
    })
  })

  it('活动卡：来源页签计数 全部 13 / 人 1 / 引擎 3 / LLM Agent 6 / 系统 3；点页签筛选；撞规则一行常显', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const tabs = await rig.ev<string[]>(`[...document.querySelectorAll('[data-view=feed] [data-filter]')].map((b) => b.textContent)`)
      expect(tabs).toEqual(['全部13', '人1', '引擎3', 'LLM Agent6', '系统3'])
      expect(await text(rig, '活动')).toContain('单笔上限，上限 8,000 USDC，实际 32,105 USDC')
      expect(await click(rig, '[data-filter="human"]')).toBe(true)
      await rig.waitFor(`document.querySelectorAll('[data-view=feed] .g5-ar').length === 1`)
      expect(await text(rig, '活动')).toContain('批准提案 T-0006')
    })
  })

  it('Agent 卡：Claude Code 需确认 · Codex CLI 只读；授权范围与单笔上限', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const t = await text(rig, 'Agent')
      for (const w of ['Claude Code', 'Codex CLI', 'LLM', '需确认', '只读', '今日提议', '拦截', 'hl-main', 'BTC ETH SOL', '单笔 ≤ 8,000', '只读，不能提议']) expect(t, w).toContain(w)
    })
  })

  it('涨跌色只用 --gr-up / --gr-down；data-updown="cn" 互换', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const colors = () => rig.ev<{ up: string; down: string; sub: string; today: string; sol: string }>(`(() => {
        const probe = document.createElement('i'); document.body.append(probe)
        probe.style.color = 'var(--gr-up)'; const up = getComputedStyle(probe).color
        probe.style.color = 'var(--gr-down)'; const down = getComputedStyle(probe).color
        probe.remove()
        const c = (el) => getComputedStyle(el).color
        const rows = [...document.querySelectorAll('[data-tab=positions] tr.g5-row')]
        return { up, down, sub: c(document.querySelector('[data-tab=positions] tr.g5-grp [data-n=upnl] > span')), today: c(document.querySelector('[data-n=today] > span')), sol: c(rows[2].querySelector('[data-n=upnl] > span')) }
      })()`)
      const intl = await colors()
      expect(intl.up).not.toBe(intl.down)
      expect(intl.sub).toBe(intl.up)
      expect(intl.today).toBe(intl.up)
      expect(intl.sol).toBe(intl.down)
      await rig.ev(`document.documentElement.setAttribute('data-updown', 'cn')`)
      const cn = await colors()
      expect(cn.up).toBe(intl.down)
      expect(cn.down).toBe(intl.up)
      expect(cn.sub).toBe(cn.up)
      expect(cn.today).toBe(cn.up)
      expect(cn.sol).toBe(cn.down)
      await rig.shot('overview-1440-cn')
    })
  })
})

describe('overview page · 命令与 r4 相同（夹具内核 stage.calls 比对）', () => {
  it('批准：proposal.approve {id}，先要证明、壳弹 PIN、带证明重发；拒绝：proposal.reject {id}', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      await click(rig, '[data-act="pending"]')
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open'`)
      await sleep(700)
      const id = rig.started.stage.sc.proposals.find((p) => p.ticket === 'T-0007')!.proposalId
      expect(await click(rig, '#g5-pendpop [data-act="approve"]')).toBe(true)
      await rig.waitFor(`document.querySelector('#g5-pendpop [data-result]')?.getAttribute('data-result')`)
      const calls = callsOf(rig, 'proposal.approve')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.at(-1)).toEqual({ action: 'proposal.approve', params: { id }, attested: true })
      expect(await rig.ev('window.__attest.calls')).toBe(1)
      // 结果播完（1.2 s）后换下一张：T-0008
      await rig.waitFor(`document.querySelector('#g5-pendpop .g5-pitem[data-ticket="T-0008"]')`)
      await sleep(700)
      const id8 = rig.started.stage.sc.proposals.find((p) => p.ticket === 'T-0008')!.proposalId
      expect(await click(rig, '#g5-pendpop [data-act="reject"]')).toBe(true)
      // P1-8：拒绝先就地展开理由行（可留空），再点「确认拒绝」才发命令
      await rig.waitFor(`document.querySelector('#g5-pendpop [data-act="reject-confirm"]')`)
      expect(await click(rig, '#g5-pendpop [data-act="reject-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'proposal.reject').length; i += 1) await sleep(100)
      expect(callsOf(rig, 'proposal.reject')[0]).toEqual({ action: 'proposal.reject', params: { id: id8 }, attested: false })
    })
  })

  it('接管三档：takeover.halt_new / cancel_all / flatten_all，参数 {reason, scope:{type:"org"}}；风险卡与资金卡弹出卡都走同一条', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      for (const level of ['halt_new', 'cancel_all'] as const) {
        expect(await click(rig, `[data-view=risk] [data-act="takeover-${level}"]`)).toBe(true)
        await rig.waitFor(`document.querySelector('[data-view=risk] [data-act="arm-confirm"]')`)
        expect(await click(rig, '[data-view=risk] [data-act="arm-confirm"]')).toBe(true)
        await rig.waitFor(`!document.querySelector('[data-view=risk] .g5-armed')`)
      }
      expect(callsOf(rig, 'takeover.halt_new')).toHaveLength(1)
      expect(callsOf(rig, 'takeover.halt_new')[0]).toEqual({ action: 'takeover.halt_new', params: { reason: '人在检阅面触发', scope: { type: 'org' } }, attested: false })
      expect(callsOf(rig, 'takeover.cancel_all')).toHaveLength(1)
      // 全部平仓：从资金卡的接管弹出卡发（先要证明，壳弹 PIN）
      expect(await click(rig, '[data-g5="fund"] [data-act="takeover"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="takeover-flatten_all"]')`)
      expect(await click(rig, '.g5o-pop [data-act="takeover-flatten_all"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="arm-confirm"]')`)
      expect(await rig.ev<string>(`document.querySelector('.g5o-pop .g5-what').innerText`)).toContain('全部平仓')
      expect(await click(rig, '.g5o-pop [data-act="arm-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'takeover.flatten_all').some((c) => c.attested); i += 1) await sleep(100)
      expect(callsOf(rig, 'takeover.flatten_all').at(-1)).toEqual({ action: 'takeover.flatten_all', params: { reason: '人在检阅面触发', scope: { type: 'org' } }, attested: true })
    })
  })

  it('平仓：整仓 position.close {accountId, instrumentId, reason}；部分平仓带 size；两步确认，取消不发命令', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const sol = `tr[data-row$="hyperliquid:SOL|long"]`
      expect(await click(rig, `${sol} [data-act="pos-close"]`)).toBe(true)
      await rig.waitFor(`document.querySelector('tr[data-armed-for] .g5-what')`)
      expect(await rig.ev<string>(`document.querySelector('tr[data-armed-for] .g5-what').innerText`)).toMatch(/^市价平掉 30 SOL，约 4,446\.00$/)
      expect(await click(rig, 'tr[data-armed-for] [data-act="arm-cancel"]')).toBe(true)
      await rig.waitFor(`!document.querySelector('tr[data-armed-for]')`)
      expect(callsOf(rig, 'position.close')).toHaveLength(0)
      await click(rig, `${sol} [data-act="pos-close"]`)
      await rig.waitFor(`document.querySelector('tr[data-armed-for] [data-act="pos-close-confirm"]')`)
      expect(await click(rig, 'tr[data-armed-for] [data-act="pos-close-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'position.close').length; i += 1) await sleep(100)
      expect(callsOf(rig, 'position.close')[0]).toEqual({ action: 'position.close', params: { accountId: rig.started.stage.sc.accounts[0]!.accountId, instrumentId: 'hyperliquid:SOL', reason: '人在持仓卡平仓' }, attested: false })
      // 部分平仓（ETH 25%）
      await rig.waitFor(`!document.querySelector('${sol}')`, 10_000)
      const eth = `tr[data-row$="hyperliquid:ETH|short"]`
      expect(await click(rig, `${eth} [data-act="pos-expand"]`)).toBe(true)
      await rig.waitFor(`document.querySelector('[data-g5-detail] [data-pct="25"]')`)
      expect(await click(rig, '[data-g5-detail] [data-pct="25"]')).toBe(true)
      expect(await click(rig, '[data-g5-detail] [data-act="pos-partial"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-g5-detail] [data-act="pos-partial-confirm"]')`)
      expect(await click(rig, '[data-g5-detail] [data-act="pos-partial-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && callsOf(rig, 'position.close').length < 2; i += 1) await sleep(100)
      expect(callsOf(rig, 'position.close')[1]).toEqual({ action: 'position.close', params: { accountId: rig.started.stage.sc.accounts[0]!.accountId, instrumentId: 'hyperliquid:ETH', size: '0.3', reason: '人在持仓卡平仓' }, attested: false })
    })
  })

  it('止损：order.place {intent: stop_market + reduceOnly + triggerPrice}，已有止损时先挂新单再撤旧单（order.cancel）；挂单页签撤单 order.cancel {accountId, orderId}', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await click(rig, `[data-tab=positions] tr[data-row^="${rig.started.stage.sc.accounts[0]!.accountId}"][data-row$="hyperliquid:BTC|long"] [data-act="pos-stop"]`)).toBe(true)
      await rig.waitFor(`document.querySelector('[data-g5-detail] input[aria-label="止损触发价"]') === document.activeElement`)
      await rig.ev(`(() => { const i = document.querySelector('[data-g5-detail] input[aria-label="止损触发价"]'); i.value = '63400'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await rig.waitFor(`!document.querySelector('[data-g5-detail] [data-act="stop-save"]').disabled`)
      expect(await click(rig, '[data-g5-detail] [data-act="stop-save"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'order.cancel').length; i += 1) await sleep(100)
      expect(callsOf(rig, 'order.place')[0]).toEqual({ action: 'order.place', params: { intent: { accountId: rig.started.stage.sc.accounts[0]!.accountId, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'stop_market', size: '0.08', triggerPrice: '63400', reduceOnly: true, reason: '人在持仓卡设止损' } }, attested: false })
      expect(callsOf(rig, 'order.cancel')[0]).toEqual({ action: 'order.cancel', params: { accountId: rig.started.stage.sc.accounts[0]!.accountId, orderId: 'ord_ov_4' }, attested: false })
      // 挂单页签撤单（paper-1 的限价买单）
      await click(rig, '[data-tab="ord"]')
      await rig.waitFor(`document.querySelector('[data-tab=orders] [data-order="ord_ov_6"]')`)
      expect(await click(rig, '[data-order="ord_ov_6"] [data-act="order-cancel"]')).toBe(true)
      for (let i = 0; i < 60 && callsOf(rig, 'order.cancel').length < 2; i += 1) await sleep(100)
      expect(callsOf(rig, 'order.cancel')[1]).toEqual({ action: 'order.cancel', params: { accountId: rig.started.stage.sc.accounts[1]!.accountId, orderId: 'ord_ov_6' }, attested: false })
    })
  })

  it('改 Agent 档位：mandate.update {mandateId, input}，要在场证明（壳弹 PIN）', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await click(rig, '[data-key] [data-act="tier"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-tier="paper"]')`)
      expect(await click(rig, '.g5o-pop [data-tier="paper"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'mandate.update').some((c) => c.attested); i += 1) await sleep(100)
      const call = callsOf(rig, 'mandate.update').at(-1)!
      expect(call.attested).toBe(true)
      const m = rig.started.stage.sc.mandates[0]!
      expect(JSON.parse(JSON.stringify(call.params))).toEqual({ mandateId: m.mandateId, input: JSON.parse(JSON.stringify({ subject: m.subject, level: 'L1', accounts: m.accounts, venueAllowlist: m.venueAllowlist, instrumentAllowlist: m.instrumentAllowlist, limits: m.limits, notAfter: m.notAfter })) })
    })
  })
})

describe('overview page · 失败、取消与其它入口', () => {
  const approveIt = async (rig: Rig) => {
    await click(rig, '[data-act="pending"]')
    await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open'`)
    await sleep(700)
    expect(await click(rig, '#g5-pendpop [data-act="approve"]')).toBe(true)
  }

  it('批准后执行失败：停在结果态，显示「已批准 · 执行失败」+ 内核原文 + 知道了；不出成功提示', async () => {
    const message = 'venue rejected the order: insufficient margin'
    await using('normal', 1440, { fault: { approveFails: message } }, async (rig) => {
      await rig.settled()
      await approveIt(rig)
      await rig.waitFor(`document.querySelector('#g5-pendpop [data-result="failed"]')`)
      const t = await rig.ev<string>(`document.querySelector('#g5-pendpop .g5-pacts').innerText`)
      expect(t).toContain('已批准 · 执行失败')
      expect(t).toContain(message)
      await rig.shot('overview-1440-approve-failed')
      expect(await click(rig, '#g5-pendpop [data-act="ack"]')).toBe(true)
      await rig.waitFor(`!document.querySelector('#g5-pendpop [data-result]')`)
    })
  })

  it('PIN 层点取消 = 什么都没发生：不报错、卡还在、两钮可再点', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      await rig.ev('window.__attest.mode = "cancel"')
      await approveIt(rig)
      await rig.waitFor('window.__attest.calls === 1')
      await sleep(400)
      expect(callsOf(rig, 'proposal.approve').every((c) => !c.attested)).toBe(true)
      expect(await rig.ev('!!document.querySelector("#g5-pendpop [data-result]")')).toBe(false)
      expect(await rig.ev('document.querySelector("#g5-pendpop [data-act=approve]").disabled')).toBe(false)
    })
  })

  it('已停止：状态行写内核原因 + 恢复交易（两步确认，trading_state.resume 要证明）；大模型实盘开仓保护开关（关闭 = 放宽，要证明）', async () => {
    await using('normal', 1440, { prepare: (s) => { s.stage.tradingState = 'HALTED' } }, async (rig) => {
      await rig.settled()
      expect(await rig.ev<string>(`document.querySelector('[data-view=risk] .g5o-status').innerText`)).toContain('恢复交易')
      expect(await rig.ev(`document.querySelector('[data-state-text]').getAttribute('data-state-text')`)).toBe('HALTED')
      expect(await click(rig, '[data-view=risk] [data-act="resume"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-view=risk] [data-act="arm-confirm"]')`)
      expect(await click(rig, '[data-view=risk] [data-act="arm-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'trading_state.resume').some((c) => c.attested); i += 1) await sleep(100)
      expect(callsOf(rig, 'trading_state.resume').some((c) => c.attested)).toBe(true)
      await rig.waitFor(`!document.querySelector('[data-view=risk] .g5o-status')`)
      expect(await click(rig, '[data-view=risk] [data-act="llm-guard"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'risk.setLlmLiveEntries').some((c) => c.attested); i += 1) await sleep(100)
      expect(callsOf(rig, 'risk.setLlmLiveEntries').at(-1)).toEqual({ action: 'risk.setLlmLiveEntries', params: { deny: false }, attested: true })
    })
  })

  it('放宽限额：risk.relax {patch:{limits:{项目: 值}}}，内核先要证明；没填值时确认钮禁用', async () => {
    const seen: Array<{ params: unknown; attested: boolean }> = []
    await using('normal', 1440, {
      prepare: (s) => s.kernel.onCommand('risk.relax', (p, ctx) => {
        seen.push({ params: p, attested: !!ctx.attestation })
        if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '放宽限额需要在场证明')
        return { ok: true }
      }),
    }, async (rig) => {
      await rig.settled()
      expect(await click(rig, '[data-view=risk] [data-act="risk-relax"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]')`)
      expect(await rig.ev('document.querySelector(".g5o-pop [data-act=risk-relax-confirm]").disabled')).toBe(true)
      await rig.ev(`(() => { const i = document.querySelector('.g5o-pop input[aria-label="新上限"]'); i.value = '9000'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await rig.waitFor(`!document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').disabled`)
      // fix-r4: 放宽默认改走 risk.temporaryRelax（见下一条）；旧的永久 risk.relax 只剩二次确认入口，这里改走它，其余断言不变
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-permanent"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-permanent-confirm"]')`)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-permanent-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && seen.length < 2; i += 1) await sleep(100)
      expect(seen.map((x) => x.attested)).toEqual([false, true])
      expect(seen[1]!.params).toEqual({ patch: { limits: { maxOrderNotional: '9000' } } })
    })
  })

  type RelaxCall = { action: string; params: Record<string, unknown>; attested: boolean; at: number }
  const typeLimit = (rig: Rig, v: string) => rig.ev(`(() => { const i = document.querySelector('.g5o-pop input[aria-label="新上限"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const popText = (rig: Rig, sel: string) => rig.ev<string>(`(document.querySelector(${JSON.stringify(`.g5o-pop ${sel}`)}) || { innerText: '' }).innerText.trim()`)

  it('放宽限额默认走 risk.temporaryRelax：时长 1/4/12/24 小时默认 4，确认钮写到期时刻；成功后卡头出「临时放宽 · 至」、被放宽的限额行带标记', async () => {
    const seen: RelaxCall[] = []
    let relax: { fields: Record<string, string>; from: number; until: number } | null = null
    await using('normal', 1440, {
      prepare: (s) => {
        s.kernel.onQuery('risk.state', () => ({ ...s.stage.sc.risk, tradingState: s.stage.tradingState, limits: { ...(s.stage.sc.risk.limits as object), ...(relax?.fields ?? {}) }, policy: { ...(s.stage.sc.risk.policy as object), temporaryRelax: relax } }))
        s.kernel.onCommand('risk.temporaryRelax', (p, ctx) => {
          seen.push({ action: 'risk.temporaryRelax', params: p as Record<string, unknown>, attested: !!ctx.attestation, at: Date.now() })
          if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '临时放宽需要在场证明')
          const q = p as { fields: Record<string, string>; until: number }
          relax = { fields: q.fields, from: Date.now(), until: q.until }
          s.kernel.publish('risk.state', { kind: 'policy' })
          return { ok: true }
        })
      },
    }, async (rig) => {
      await rig.settled()
      expect(await rig.ev('!!document.querySelector("[data-view=risk] [data-act=relax-active]")')).toBe(false)
      expect(await click(rig, '[data-view=risk] [data-act="risk-relax"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]')`)
      expect(await rig.ev('[...document.querySelectorAll(".g5o-pop [data-hours]")].map((b) => b.getAttribute("data-hours"))')).toEqual(['1', '4', '12', '24'])
      expect(await rig.ev('document.querySelector(".g5o-pop [data-hours][aria-checked=true]").getAttribute("data-hours")')).toBe('4')
      await typeLimit(rig, '9000')
      await rig.waitFor(`!document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').disabled`)
      expect(await popText(rig, '[data-act="risk-relax-confirm"]')).toMatch(/^确认临时放宽至 \d{2}:\d{2}$/)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && seen.length < 2; i += 1) await sleep(100)
      expect(seen.map((x) => x.attested)).toEqual([false, true])
      const call = seen[1]!
      expect(call.params.fields).toEqual({ maxOrderNotional: '9000' })
      const ahead = (call.params.until as number) - call.at
      expect(ahead).toBeGreaterThan(0)
      expect(ahead).toBeLessThanOrEqual(24 * 3600_000)
      expect(Math.abs(ahead - 4 * 3600_000)).toBeLessThan(60_000)
      expect(callsOf(rig, 'risk.relax')).toHaveLength(0)
      await rig.waitFor(`!!document.querySelector('[data-view=risk] [data-act="relax-active"]')`)
      expect(await rig.ev<string>(`document.querySelector('[data-view=risk] [data-act="relax-active"]').innerText`)).toMatch(/^临时放宽 · 至 \d{2}:\d{2}（剩 (3 小时 \d{1,2}|4 小时 0) 分）$/)
      expect(await rig.ev<string>(`document.querySelector('[data-view=risk] [data-relaxed="1"]').getAttribute('data-limit')`)).toBe('单笔')
    })
  })

  it('放宽时长可选 24 小时（until−now ≤ 24h）；收紧叫「确认收紧」且不出时长与永久入口；永久改先出「不会自动收回」二次确认才发 risk.relax', async () => {
    const temp: RelaxCall[] = []
    const perm: RelaxCall[] = []
    await using('normal', 1440, {
      prepare: (s) => {
        s.kernel.onCommand('risk.temporaryRelax', (p, ctx) => {
          temp.push({ action: 'risk.temporaryRelax', params: p as Record<string, unknown>, attested: !!ctx.attestation, at: Date.now() })
          if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '临时放宽需要在场证明')
          return { ok: true }
        })
        s.kernel.onCommand('risk.relax', (p, ctx) => {
          perm.push({ action: 'risk.relax', params: p as Record<string, unknown>, attested: !!ctx.attestation, at: Date.now() })
          if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '放宽限额需要在场证明')
          return { ok: true }
        })
      },
    }, async (rig) => {
      await rig.settled()
      expect(await click(rig, '[data-view=risk] [data-act="risk-relax"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]')`)
      await typeLimit(rig, '9000')
      expect(await click(rig, '.g5o-pop [data-hours="24"]')).toBe(true)
      await rig.waitFor(`!document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').disabled`)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && temp.length < 2; i += 1) await sleep(100)
      const ahead = (temp[1]!.params.until as number) - temp[1]!.at
      expect(ahead).toBeGreaterThan(23 * 3600_000)
      expect(ahead).toBeLessThanOrEqual(24 * 3600_000)
      // 收紧：更小的上限
      await rig.waitFor(`!document.querySelector('.g5o-pop')`)
      expect(await click(rig, '[data-view=risk] [data-act="risk-relax"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]')`)
      await typeLimit(rig, '100')
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').innerText.trim() === '确认收紧'`)
      expect(await rig.ev('!document.querySelector(".g5o-pop [data-hours]") && !document.querySelector(".g5o-pop [data-act=risk-relax-permanent]")')).toBe(true)
      // 永久：二次确认之前不发命令
      await typeLimit(rig, '9000')
      await rig.waitFor(`!!document.querySelector('.g5o-pop [data-act="risk-relax-permanent"]') && !document.querySelector('.g5o-pop [data-act="risk-relax-permanent"]').disabled`)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-permanent"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-perm-ask"]')`)
      expect(await popText(rig, '[data-act="risk-relax-perm-ask"]')).toBe('永久修改风控上限，不会自动收回')
      await sleep(300)
      expect(perm).toHaveLength(0)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-permanent-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && perm.length < 2; i += 1) await sleep(100)
      expect(perm.map((x) => x.attested)).toEqual([false, true])
      expect(perm[1]!.params).toEqual({ patch: { limits: { maxOrderNotional: '9000' } } })
      expect(temp).toHaveLength(2)
    })
  })

  it('Agent 卡：今日提议 / 拦截取自 risk.stats（不再是 —）；档位菜单「撤销此 Agent…」先确认再 agentkey.revoke {keyId}，PIN 层带证明', async () => {
    const seen: Array<{ params: unknown; attested: boolean }> = []
    await using('normal', 1440, {
      prepare: (s) => {
        s.kernel.onQuery('risk.stats', () => ({ denied: 1, review: 0, byActor: { [`agent:${KEY_CLAUDE}`]: { proposals: 3, denied: 1 } }, byRule: {} }))
        s.kernel.onCommand('agentkey.revoke', (p, ctx) => {
          seen.push({ params: p, attested: !!ctx.attestation })
          if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '撤销 Agent 钥匙需要 PIN')
          return { keyId: KEY_CLAUDE, status: 'revoked', withdrawn: 0, openPositions: 0, openOrders: 0 }
        })
      },
    }, async (rig) => {
      await rig.settled()
      const rowText = () => rig.ev<string>(`document.querySelector('[data-key="${KEY_CLAUDE}"]').innerText.replace(/\\s+/g, ' ')`)
      for (let i = 0; i < 60 && !/今日提议 3/.test(await rowText()); i += 1) await sleep(100)
      const row = await rowText()
      expect(row).toMatch(/今日提议 3/)
      expect(row).toMatch(/拦截 1/)
      expect(await click(rig, `[data-key="${KEY_CLAUDE}"] [data-act="tier"]`)).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="revoke-agent"]')`)
      expect(await popText(rig, '[data-act="revoke-agent"]')).toBe('撤销此 Agent…')
      expect(await click(rig, '.g5o-pop [data-act="revoke-agent"]')).toBe(true)
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="revoke-agent-confirm"]')`)
      const ask = await popText(rig, '[data-act="revoke-agent-ask"]')
      for (const w of ['立刻不能下单', '待批', '已有持仓和挂单不会自动处理']) expect(ask, w).toContain(w)
      await sleep(300)
      expect(seen).toHaveLength(0)
      expect(await click(rig, '.g5o-pop [data-act="revoke-agent-confirm"]')).toBe(true)
      for (let i = 0; i < 60 && seen.length < 2; i += 1) await sleep(100)
      expect(seen.map((x) => x.attested)).toEqual([false, true])
      expect(seen[1]!.params).toEqual({ keyId: KEY_CLAUDE })
    })
  })

  it('撤权是收紧：已停止（HALTED）与离线时档位项和「编辑授权…」禁用，但「撤销此 Agent…」仍可点并发出 agentkey.revoke {keyId}', async () => {
    for (const mode of ['halted', 'offline'] as const) {
      const seen: Array<{ params: unknown; attested: boolean }> = []
      await using('normal', 1440, {
        prepare: (s) => {
          if (mode === 'halted') s.stage.tradingState = 'HALTED'
          s.kernel.onCommand('agentkey.revoke', (p, ctx) => {
            seen.push({ params: p, attested: !!ctx.attestation })
            if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '撤销 Agent 钥匙需要 PIN')
            return { keyId: KEY_CLAUDE, status: 'revoked', withdrawn: 0, openPositions: 0, openOrders: 0 }
          })
        },
      }, async (rig) => {
        await rig.settled()
        if (mode === 'offline') {
          await rig.ev(`document.documentElement.setAttribute('data-offline', '')`)
          await rig.waitFor(`document.querySelectorAll('[data-g5="card"][data-state="offline"]').length === 4`)
        }
        const key = `[data-key="${KEY_CLAUDE}"]`
        expect(await rig.ev<boolean>(`!document.querySelector('${key} [data-act="tier"]').disabled`), mode).toBe(true)
        expect(await click(rig, `${key} [data-act="tier"]`)).toBe(true)
        await rig.waitFor(`document.querySelector('.g5o-pop [data-act="revoke-agent"]')`)
        expect(await rig.ev('[...document.querySelectorAll(".g5o-pop [data-tier]")].every((b) => b.disabled)'), mode).toBe(true)
        expect(await rig.ev('document.querySelector(".g5o-pop [data-act=revoke-agent]").disabled'), mode).toBe(false)
        expect(await click(rig, '.g5o-pop [data-act="revoke-agent"]')).toBe(true)
        await rig.waitFor(`document.querySelector('.g5o-pop [data-act="revoke-agent-confirm"]')`)
        expect(await rig.ev('document.querySelector(".g5o-pop [data-act=revoke-agent-confirm]").disabled'), mode).toBe(false)
        expect(await click(rig, '.g5o-pop [data-act="revoke-agent-confirm"]')).toBe(true)
        for (let i = 0; i < 60 && seen.length < 2; i += 1) await sleep(100)
        expect(seen.map((x) => x.attested), mode).toEqual([false, true])
        expect(seen[1]!.params, mode).toEqual({ keyId: KEY_CLAUDE })
      })
    }
  })

  it('已有临时放宽时按基线判断：介于基线与放宽值之间 = 临时放宽（fields 并入原放宽键，提示统一到期时间）；≤ 基线 = risk.tighten', async () => {
    const calls: RelaxCall[] = []
    const until = Date.now() + 2 * 3600_000
    let b = 0 // 基线单笔上限（取自场景），放宽值 = b+4000
    let lev = 0
    await using('normal', 1440, {
      prepare: (s) => {
        const base = s.stage.sc.risk.limits as Record<string, unknown>
        b = Number(base.maxOrderNotional)
        lev = Number(base.maxLeverage)
        s.kernel.onQuery('risk.state', () => ({ ...s.stage.sc.risk, tradingState: s.stage.tradingState, limits: { ...base, maxOrderNotional: String(b + 4000) },
          policy: { ...(s.stage.sc.risk.policy as object), limits: base, temporaryRelax: { fields: { maxOrderNotional: String(b + 4000) }, from: Date.now() - 60_000, until, revertToVersion: 3 } } }))
        for (const action of ['risk.temporaryRelax', 'risk.tighten']) {
          s.kernel.onCommand(action, (p, ctx) => {
            calls.push({ action, params: p as Record<string, unknown>, attested: !!ctx.attestation, at: Date.now() })
            if (action === 'risk.temporaryRelax' && !ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '临时放宽需要在场证明')
            return { ok: true }
          })
        }
      },
    }, async (rig) => {
      await rig.settled()
      const open = async () => { expect(await click(rig, '[data-view=risk] [data-act="risk-relax"]')).toBe(true); await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]')`) }
      const sent = async (n: number) => { for (let i = 0; i < 60 && calls.length < n; i += 1) await sleep(100) }
      await open()
      expect(await rig.ev<string>(`document.querySelector('.g5o-pop input[aria-label="新上限"]').placeholder`)).toContain(`当前 ${b + 4000}（临时，至`)
      expect(await rig.ev<string>(`document.querySelector('.g5o-pop input[aria-label="新上限"]').placeholder`)).toContain(`基线 ${b}）`)
      // 基线+2000：高于基线、低于放宽值——按基线比是放宽，不是收紧
      await typeLimit(rig, String(b + 2000))
      await rig.waitFor(`/^确认临时放宽至 /.test(document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').innerText.trim())`)
      expect(await popText(rig, '[data-act="risk-relax-unify"]')).toMatch(/^会把现有临时放宽的到期时间统一改为 \d{2}:\d{2}$/)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-confirm"]')).toBe(true)
      await sent(2)
      expect(calls.map((c) => [c.action, c.attested])).toEqual([['risk.temporaryRelax', false], ['risk.temporaryRelax', true]])
      expect(calls[1]!.params.fields).toEqual({ maxOrderNotional: String(b + 2000) })
      // 另一项（杠杆高于基线）：并入原放宽键
      await rig.waitFor(`!document.querySelector('.g5o-pop')`)
      await open()
      expect(await click(rig, '.g5o-pop [data-field="maxLeverage"]')).toBe(true)
      await typeLimit(rig, String(lev + 3))
      await rig.waitFor(`!document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').disabled`)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-confirm"]')).toBe(true)
      await sent(4)
      expect(calls[3]!.action).toBe('risk.temporaryRelax')
      expect(calls[3]!.params.fields).toEqual({ maxOrderNotional: String(b + 4000), maxLeverage: lev + 3 })
      // ≤ 基线（基线−2000 与等于基线）：收紧
      await rig.waitFor(`!document.querySelector('.g5o-pop')`)
      await open()
      expect(await click(rig, '.g5o-pop [data-field="maxOrderNotional"]')).toBe(true)
      await typeLimit(rig, String(b - 2000))
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').innerText.trim() === '确认收紧'`)
      expect(await rig.ev('!document.querySelector(".g5o-pop [data-act=risk-relax-unify]")')).toBe(true)
      expect(await click(rig, '.g5o-pop [data-act="risk-relax-confirm"]')).toBe(true)
      await sent(5)
      expect(calls[4]).toMatchObject({ action: 'risk.tighten', params: { patch: { limits: { maxOrderNotional: String(b - 2000) } } } })
      await rig.waitFor(`!document.querySelector('.g5o-pop')`)
      await open()
      await typeLimit(rig, String(b))
      await rig.waitFor(`document.querySelector('.g5o-pop [data-act="risk-relax-confirm"]').innerText.trim() === '确认收紧'`)
    })
  })

  it('全部平仓没平完：常驻红条写剩余持仓，不出成功提示，可再次平仓', async () => {
    await using('normal', 1440, { fault: { flattenNoPin: true, flattenLeft: [{ instrumentId: 'hyperliquid:SOL', size: '30' }] } }, async (rig) => {
      await rig.settled()
      expect(await click(rig, '[data-view=risk] [data-act="takeover-flatten_all"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-view=risk] [data-act="arm-confirm"]')`)
      expect(await rig.ev<string>(`document.querySelector('[data-view=risk] .g5-what').innerText`)).toBe('全部平仓：4 个持仓，实盘 3')
      expect(await click(rig, '[data-view=risk] [data-act="arm-confirm"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-act="takeover-leftover"]')`)
      const t = await rig.ev<string>(`document.querySelector('[data-act="takeover-leftover"]').innerText.replace(/\\s+/g, ' ')`)
      expect(t).toContain('平仓未完成 · 剩 1 个持仓')
      expect(t).toContain('SOL 30')
      expect(await rig.ev('!!document.querySelector("[data-view=risk] [data-act=takeover-retry]")')).toBe(true)
    })
  })

  it('展开区 / 武装行 / 武装的接管行全开时，几何探针仍全 0', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await click(rig, 'tr[data-row$="hyperliquid:SOL|long"] [data-act="pos-expand"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-g5-detail]')`)
      expect(await click(rig, 'tr[data-row$="hyperliquid:ETH|short"] [data-act="pos-close"]')).toBe(true)
      await rig.waitFor(`document.querySelector('tr[data-armed-for]')`)
      expect(await click(rig, '[data-view=risk] [data-act="takeover-halt_new"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-view=risk] .g5-armed')`)
      await sleep(300)
      const g = await readGeometry(rig.cdp)
      expect(geometryCounts(g), JSON.stringify(g)).toEqual({ docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 })
      await rig.shot('overview-1440-expanded-armed')
    })
  })
})

describe('overview page · 在途卡不计入「待批 N」', () => {
  it('批准后结果态里那张卡还留在浮层（标在途），浮层头与资金卡的 N 都只数 pending：2 → 1；在途卡不触发自动展开', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      await click(rig, '[data-act="pending"]')
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open'`)
      await sleep(700)
      expect(await rig.ev<string>('document.querySelector("#g5-pendpop > .g5-hd .g5-ct").innerText')).toBe('2')
      expect(await rig.ev<string>('document.querySelector("[data-n=pending]").innerText')).toBe('2')
      expect(await click(rig, '#g5-pendpop [data-act="approve"]')).toBe(true)
      await rig.waitFor(`document.querySelector('#g5-pendpop .g5-pitem[data-inflight="1"][data-result]')`)
      expect(await rig.ev<string>('document.querySelector("#g5-pendpop > .g5-hd .g5-ct").innerText')).toBe('1')
      expect(await rig.ev<string>('document.querySelector("[data-n=pending]").innerText')).toBe('1')
    })
  })
})

describe('overview page · 批准钮：只有内核 deny 才置灰', () => {
  const openPop = async (rig: Rig) => {
    await rig.settled()
    await click(rig, '[data-act="pending"]')
    await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open'`)
    await sleep(700)
  }
  it('前端算出批后超限、内核没判 deny：占用行标超限（数字，按提案所在账户口径），批准仍可点、点了照发 proposal.approve', async () => {
    await using('normal', 1440, { scenario: (sc) => { (sc.risk as { limits: Record<string, unknown> }).limits = { ...(sc.risk as { limits: Record<string, unknown> }).limits, maxTotalNotionalRatio: '0.5' } } }, async (rig) => {
      await openPop(rig)
      expect(await rig.ev('document.querySelectorAll("#g5-pendpop .g5-lim.g5-over").length')).toBeGreaterThan(0)
      // 单账户口径：hl-main 的敞口 = 它自己的持仓 / 它自己的权益（不是实盘 + 纸面合算）
      const exposure = await rig.ev<string>('document.querySelector("#g5-pendpop [data-limit=总敞口] .g5-v").innerText')
      expect(exposure).toBe('1.08× → 1.59×')
      expect(await rig.ev('document.querySelector("#g5-pendpop [data-act=approve]").disabled')).toBe(false)
      expect(await rig.ev('!!document.querySelector("#g5-pendpop [data-blocked]")')).toBe(false)
      await rig.shot('overview-1440-approve-overlimit')
      expect(await click(rig, '#g5-pendpop [data-act="approve"]')).toBe(true)
      for (let i = 0; i < 60 && !callsOf(rig, 'proposal.approve').some((c) => c.attested); i += 1) await sleep(100)
      expect(callsOf(rig, 'proposal.approve').some((c) => c.attested)).toBe(true)
    })
  })
  it('内核预检判 deny：批准置灰 + 旁边写内核规则原文；点禁用的批准不发命令；拒绝照常可点', async () => {
    await using('normal', 1440, { scenario: (sc) => {
      const p = sc.proposals.find((x) => x.ticket === 'T-0007') as unknown as { precheck: { verdict: string; ruleHits: unknown[] } }
      p.precheck.verdict = 'deny'
      p.precheck.ruleHits = [{ ruleId: 'r', code: 'ORDER_NOTIONAL', limit: '5000', actual: '6380', unit: 'USDC', action: 'deny', scope: 'org' }]
    } }, async (rig) => {
      await openPop(rig)
      expect(await rig.ev('document.querySelector("#g5-pendpop [data-act=approve]").disabled')).toBe(true)
      expect(await rig.ev<string>('document.querySelector("#g5-pendpop [data-blocked]").innerText')).toContain('单笔上限，上限 5,000 USDC，实际 6,380 USDC')
      expect(await rig.ev('document.querySelector("#g5-pendpop [data-act=reject]").disabled')).toBe(false)
      await rig.ev('document.querySelector("#g5-pendpop [data-act=approve]").click()')
      await sleep(400)
      expect(callsOf(rig, 'proposal.approve')).toHaveLength(0)
      await rig.shot('overview-1440-approve-blocked')
    })
  })
})

describe('overview page · 出口', () => {
  it('持仓标的名 → #/chart/<id>；展开区「全部记录」→ #/records（联动 account + symbol）；活动里的引擎名 → #/strategies；资金卡 权益 → #/funds、网络 → #/settings/venues；待批 N → 打开浮层不跳页', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const row = (inst: string) => `[data-tab=positions] tr[data-row$="${inst}|long"]`
      expect(await click(rig, `${row('hyperliquid:BTC')} [data-act="to-chart"]`)).toBe(true)
      await rig.waitFor(`location.hash.startsWith('#/chart/hyperliquid:BTC')`)
      await rig.ev(`location.hash = ''`)
      expect(await click(rig, `${row('hyperliquid:SOL')} [data-act="pos-expand"]`)).toBe(true)
      await rig.waitFor(`document.querySelector('[data-g5-detail] [data-act="to-records"]')`)
      expect(await click(rig, '[data-g5-detail] [data-act="to-records"]')).toBe(true)
      // GQ-37：标的走显式路由（不再写联动 symbol），账户仍经联动
      await rig.waitFor(`location.hash === '#/records/hyperliquid:SOL' && window.__hub.get('A', 'account') === ${JSON.stringify(rig.started.stage.sc.accounts[0]!.accountId)}`)
      expect(await click(rig, '[data-view=feed] [data-act="to-strategies"]')).toBe(true)
      await rig.waitFor(`location.hash === '#/strategies'`)
      expect(await click(rig, '[data-g5="fund"] [data-act="to-funds"]')).toBe(true)
      await rig.waitFor(`location.hash === '#/funds'`)
      expect(await click(rig, '[data-g5="fund"] [data-act="network"]')).toBe(true)
      await rig.waitFor(`location.hash === '#/settings/venues'`)
      const before = await rig.ev<string>('location.hash')
      expect(await click(rig, '[data-act="pending"]')).toBe(true)
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open'`)
      expect(await rig.ev<string>('location.hash')).toBe(before)
    })
  })

  it('持仓行「有待批」→ 打开浮层并选中那张提案', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await rig.ev('document.querySelectorAll("[data-act=pos-goto-pending]").length')).toBe(2)
      expect(await click(rig, 'tr[data-row$="hyperliquid:ETH|short"] [data-act="pos-goto-pending"]')).toBe(true)
      await rig.waitFor(`document.documentElement.getAttribute('data-pend') === 'open' && document.querySelector('#g5-pendpop [data-ticket="T-0007"]')`)
    })
  })
})

describe('overview page · 四态与未接通', () => {
  it('加载：四张卡骨架，资金卡权益骨架，数据到了再换成内容', async () => {
    await using('loading', 1440, { queryDelayMs: 2500 }, async (rig) => {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"]').length === 4`)
      for (const label of CARDS) expect(await rig.ev(`${card(label)}.querySelectorAll('.g5-sk').length`), `${label} 应是骨架`).toBeGreaterThan(0)
      await rig.shot('overview-loading')
      await rig.settled()
      expect(await text(rig, '持仓与挂单')).toContain('hl-main')
    })
  })

  it('空：持仓「当前没有持仓」、活动「还没有活动」、Agent「还没有 Agent 接入」、浮层 none', async () => {
    await using('empty', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await text(rig, '持仓与挂单')).toContain('当前没有持仓')
      expect(await text(rig, '活动')).toContain('还没有活动')
      expect(await text(rig, 'Agent')).toContain('还没有 Agent 接入')
      expect(await pendOf(rig)).toBe('none')
      await rig.shot('overview-empty')
    })
  })

  it('错误：内核原文原样、带重试', async () => {
    await using('error', 1440, {}, async (rig) => {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"] [data-state="error"]').length >= 3`)
      for (const label of ['持仓与挂单', '活动', '风险', 'Agent']) {
        const t = await text(rig, label)
        expect(t, label).toContain('读取失败')
        expect(t, label).toContain('内核暂时读不到这份数据（演示用的读取失败场景）')
        expect(await rig.ev(`${card(label)}.querySelectorAll('[data-act="read-retry"]').length`), label).toBe(1)
      }
      await rig.shot('overview-error')
    })
  })

  it('离线：卡降灰、卡头写「已暂停更新 · mm:ss」、命令钮禁用、涨跌色去掉（正负号保留）；恢复后复原', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      await rig.ev(`document.documentElement.setAttribute('data-offline', '')`)
      await rig.waitFor(`document.querySelectorAll('[data-g5="card"][data-state="offline"]').length === 4`)
      for (const label of ['持仓与挂单', '风险', 'Agent']) expect(await text(rig, label), label).toMatch(/已暂停更新 · \d\d:\d\d/)
      expect(await rig.ev(`document.querySelector('[data-view=risk] [role=status]').textContent`)).toBe('—') // UX-09：风险卡状态标签断开时写「—」
      expect(await rig.ev('[...document.querySelectorAll("[data-tab=positions] [data-act=pos-close],[data-tab=positions] [data-act=pos-stop],[data-view=risk] [data-act^=takeover-]")].every((b) => b.disabled)')).toBe(true)
      expect(await rig.ev('document.querySelector("[data-g5=fund] [data-act=takeover]").disabled')).toBe(true)
      expect(await rig.ev<string>(`document.querySelector('[data-tab=positions] tr.g5-row [data-n=upnl]').innerText`)).toMatch(/^\+48\.16$/)
      const c = await rig.ev<{ off: string; dim: string }>(`(() => { const p = document.createElement('i'); document.body.append(p); p.style.color = 'var(--gr-text-3)'; const dim = getComputedStyle(p).color; p.remove(); return { off: getComputedStyle(document.querySelector('[data-tab=positions] tr.g5-row [data-n=upnl] > span')).color, dim } })()`)
      expect(c.off).toBe(c.dim)
      expect(await rig.ev<string>(`document.querySelector('[data-n=today] > span').className`)).not.toMatch(/g5-up|g5-down/)
      await rig.shot('overview-offline')
      await rig.ev(`document.documentElement.removeAttribute('data-offline')`)
      await rig.waitFor('document.querySelectorAll(".g5-off").length === 0')
    })
  })

  it('未接通：接口不存在时写「未接通」+ 内核原文，不给重试', async () => {
    await using('unwired', 1440, {}, async (rig) => {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"] [data-wire="off"]').length >= 3`)
      for (const label of ['持仓与挂单', '活动', '风险', 'Agent']) {
        const t = await text(rig, label)
        expect(t, label).toContain('未接通')
        expect(t, label).toMatch(/未知查询 /)
        expect(await rig.ev(`${card(label)}.querySelectorAll('[data-act="read-retry"]').length`), label).toBe(0)
      }
      await rig.shot('overview-unwired')
    })
  })
})

describe('overview page · 源码红线', () => {
  const files = ['src/views/ovkit.tsx', 'src/views/positions.tsx', 'src/views/activity.tsx', 'src/views/agents.tsx', 'src/views/risk.tsx', 'src/views/pending.tsx', 'src/views/fundcard.tsx', 'src/views/overview.css', 'src/pages/overview.tsx', 'fixtures/overview.ts', 'test/overview.test.ts', 'test/overview.browser.test.ts']
  const read = (f: string) => readFileSync(resolve(pkgDir, f), 'utf8')
  // 禁词表本身不能在本文件里写成连续字面量，否则本文件自己就命中
  const banned = new RegExp(['保' + '守', '激' + '进', '稳' + '赚', '跑' + '赢', '稳定' + '盈利'].join('|'))
  it('新文件首行 SPDX；页内 CSS 无颜色字面量 / 全圆 / 直角；无禁词；无邮箱 / IP / 本机绝对路径', () => {
    for (const f of files) {
      const s = read(f)
      expect(s.split('\n')[0], f).toMatch(/SPDX-License-Identifier: CPAL-1\.0/)
      expect(s, f).not.toMatch(banned)
      expect(s, f).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
      expect(s, f).not.toMatch(/[A-Za-z]:[\\/](?:Users|Gitrader|gitrader)/i)
      expect(s, f).not.toMatch(/[\w.+-]+@[A-Za-z][\w-]*\.[A-Za-z]{2,}/)
    }
    const css = read('src/views/overview.css')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(css).not.toMatch(/9999px|border-radius:\s*50%|border-radius:\s*0\b/)
  })
})
