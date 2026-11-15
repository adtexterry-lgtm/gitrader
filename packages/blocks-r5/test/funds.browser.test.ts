// SPDX-License-Identifier: CPAL-1.0
// 资金页浏览器用例：CDP 直连本机 Edge（无头），夹具内核 + 本文件现场打包的舞台页（壳的 r5 路由还没落地时，用它把五张卡挂进与视觉稿同版式的两列里）。
// 舞台页只存在于本文件与临时目录，不进 src/。不设 GITRADER_SKIP_BROWSER，没有 Edge 就直接失败。
// 设 GITRADER_SHOTS_DIR 才写截图。
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { problem } from '../../workbench/verify/fixture-kernel'
import { FUND_ACCOUNT, PROBLEM_TEXT, installFundsHandlers, type FundsState } from '../fixtures/funds'
import { startStage } from '../verify/stage-entry'
import anchorsJson from './geo-anchors/funds.json'
import { captureAnchors } from './helpers/anchors'
import { launchCdp } from './helpers/cdp'
import { geometryCounts, readGeometry } from './helpers/geo'

const home = process.env.GITRADER_HOME
if (!home) throw new Error('GITRADER_HOME is required')
const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const shotsDir = process.env.GITRADER_SHOTS_DIR
const auditSource = readFileSync(resolve(pkgDir, '../workbench/design/audit-probe.js'), 'utf8')
const referencePage = resolve(here, '../../../reports/visual-r5/funds/index.html')
const PIN = '246810'
const WIDTHS = [1280, 1440, 1920] as const
const CARDS = ['账户', '权益', '资产', '保证金', '权益变动'] as const
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const DIAG = "document.body.innerText.slice(0, 600) + ' | cards=' + document.querySelectorAll('[data-g5=card]').length + ' sk=' + document.querySelectorAll('.g5-sk').length + ' ready=' + document.documentElement.hasAttribute('data-ready')"
const anchors = anchorsJson.widths as Record<string, Record<string, number[]>>

// ---- 舞台页：五张卡按视觉稿的两列版式挂好；桥是真的（真 KernelClient 连夹具内核，经 createHostBridge 校验清单） ------------------------------

const ENTRY = `
import { render } from 'preact'
import { KernelClient, LinkHub, createHostBridge } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { fundsBlock } from './src/pages/funds'
import '../workbench/src/ui/theme.css'
import '../workbench/src/ui/r5/components.css'
const w = window
const H = w.__H
;(async () => {
  const boot = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: H.boot }) }).then((r) => r.json())
  const client = new KernelClient({ url: H.ws, getToken: () => boot.sessionToken, WebSocketCtor: WebSocket, reconnect: false })
  await client.connect()
  w.__attest = { mode: 'pin', calls: 0 }
  client.setAttestor(async () => { w.__attest.calls += 1; return w.__attest.mode === 'cancel' ? null : { method: 'pin', pin: H.pin } })
  const hub = new LinkHub({ A: {} })
  w.__hub = hub
  const col = { accounts: 'colL', curve: 'colL', portfolio: 'colL', assets: 'colR', margin: 'colR', changes: 'colR' }
  for (const view of H.views || ['accounts', 'curve', 'assets', 'margin', 'changes']) {
    const bridge = createHostBridge({ manifest: fundsBlock.manifest, kernel: client, hub, instanceId: 'bi_funds_' + view, trusted: true, isUserActive: () => true })
    const host = document.createElement('div')
    host.style.display = 'contents'
    document.getElementById(col[view]).appendChild(host)
    const C = fundsBlock.component
    render(<BridgeContext.Provider value={bridge}><C bridge={bridge} instanceId={'bi_funds_' + view} config={{ view }} setConfig={() => undefined} channel="A" grid={{ w: 1, h: 1 }} mode="tile" /></BridgeContext.Provider>, host)
  }
  document.documentElement.setAttribute('data-ready', '1')
})()
`

const HTML = `<!doctype html>
<html lang="zh-CN" data-ui="r5" data-updown="intl"><head><meta charset="utf-8"><title>funds</title><link rel="stylesheet" href="app.css"></head>
<body><main class="g5-frame"><header class="g5-topbar"></header><section class="g5-fund" aria-label="资金"></section>
<div class="g5-ws"><div class="g5-col" id="colL"></div><div class="g5-col" id="colR"></div></div></main>
<script src="h.js"></script><script src="geometry-probe.js"></script><script src="app.js"></script></body></html>`

let staticDir = ''
let tmpRoot = ''
const live: Rig[] = []

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(home, 'funds-browser-'))
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
    stdin: { contents: ENTRY, resolveDir: pkgDir, loader: 'tsx', sourcefile: 'funds-stage.tsx' },
    bundle: true, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'silent',
    loader: { '.js': 'jsx', '.png': 'binary', '.woff2': 'file' }, assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, plugins: [svgText as never],
    define: { __GITRADER_VERSION__: '"funds-stage"', 'process.env.NODE_ENV': '"production"' },
    outfile: join(staticDir, 'app.js'),
  })
})

afterAll(async () => {
  for (const x of live.splice(0)) await x.close()
  if (tmpRoot && resolve(tmpRoot).startsWith(resolve(home) + sep)) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

// ---- 起一套：夹具内核 + 无头 Edge + 打开舞台页 ---------------------------------------------------------------------------------------------

type Stage = Awaited<ReturnType<typeof startStage>>
interface Rig {
  stage: Stage
  cdp: Awaited<ReturnType<typeof launchCdp>>
  ev<T = unknown>(expr: string): Promise<T>
  waitFor(expr: string, ms?: number): Promise<void>
  settled(ms?: number): Promise<void>
  calls: Array<{ action: string; params: unknown; attestation: unknown }>
  queries: Array<{ method: string; params: unknown }>
  shot(name: string): Promise<void>
  close(): Promise<void>
}
type Command = (p: unknown, ctx: { attestation?: unknown }) => unknown
interface OpenOptions {
  delayMs?: number
  commands?: Record<string, Command>
  /** 页面打开之前对夹具内核再动一次手（覆盖某个查询之类）。 */
  prepare?: (kernel: Stage['kernel']) => void
  /** 舞台上挂哪些卡（缺省五张；GQ-65 的组合卡用 SIX）。 */
  views?: readonly string[]
}

async function open(state: FundsState, width: number, opts: OpenOptions = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpRoot, 'k-'))
  const pub = join(dir, 'static')
  mkdirSync(pub)
  writeFileSync(join(pub, 'app.js'), readFileSync(join(staticDir, 'app.js')))
  writeFileSync(join(pub, 'app.css'), readFileSync(join(staticDir, 'app.css')))
  // 探针里 `internal(el)` 漏传 selectors（T1 文件，本包不改）：在预装的副本里补上，上游修好后这句替换就是空操作
  writeFileSync(join(pub, 'geometry-probe.js'), readFileSync(resolve(pkgDir, '../workbench/design/geometry-probe.js'), 'utf8').replace('if(internal(el))continue;', 'if(internal(el,selectors))continue;'))
  writeFileSync(join(pub, 'index.html'), HTML)
  const stage = await startStage({ staticDir: pub, workspacesDir: join(dir, 'workspaces'), scenario: `funds-${state === 'unreachable' ? 'normal' : state}` })
  const calls: Rig['calls'] = []
  const queries: Rig['queries'] = []
  installFundsHandlers(stage.kernel, state, { delayMs: opts.delayMs ?? 0, onQuery: (method, params) => queries.push({ method, params }) })
  for (const [action, fn] of Object.entries(opts.commands ?? {})) {
    stage.kernel.onCommand(action, (p, ctx) => { calls.push({ action, params: p, attestation: ctx.attestation }); return fn(p, ctx) })
  }
  opts.prepare?.(stage.kernel)
  // 内核的 CSP 只许同源脚本：引导令牌与地址放进同源的 h.js，不用内联脚本
  writeFileSync(join(pub, 'h.js'), `window.__H=${JSON.stringify({ boot: stage.kernel.bootstrapToken, ws: stage.kernel.wsUrl, pin: PIN, ...(opts.views ? { views: opts.views } : {}) })}`)
  // launchCdp 自带 EBUSY 重试（helpers/cdp.ts 的 retryBusy）；启动失败时先关掉本次的夹具内核
  const cdp = await launchCdp({ width, height: 900 }).catch(async (e: unknown) => { await stage.kernel.close(); throw e })
  const rig: Rig = {
    stage, cdp, calls, queries,
    ev: (expr) => cdp.evaluate(expr) as Promise<never>,
    async waitFor(expr, ms = 15_000) {
      const t0 = Date.now()
      for (;;) {
        if (await cdp.evaluate(expr)) return
        if (Date.now() - t0 > ms) throw new Error(`等待超时：${expr}\n页面错误：${JSON.stringify(cdp.errors)}\n${String(await cdp.evaluate(DIAG))}`)
        await sleep(100)
      }
    },
    async settled(ms) {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"]').length === ${(opts.views ?? CARDS).length} && !document.querySelector('.g5-sk, .g5-ghostplot')`, ms)
      await sleep(250)
    },
    async shot(name) {
      if (!shotsDir) return
      mkdirSync(shotsDir, { recursive: true })
      writeFileSync(join(shotsDir, `${name}.png`), await cdp.screenshot())
    },
    async close() { await cdp.close(); await stage.kernel.close() },
  }
  live.push(rig)
  await cdp.navigate(`${stage.kernel.url}/`)
  return rig
}

async function using(state: FundsState, width: number, opts: OpenOptions, fn: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await open(state, width, opts)
  try { await fn(rig) } finally {
    await rig.close()
    live.splice(0, live.length, ...live.filter((x) => x !== rig))
  }
}

const card = (label: string) => `document.querySelector('[data-g5="card"][aria-label="${label}"]')`
const text = (rig: Rig, label: string) => rig.ev<string>(`${card(label)}.innerText`)
const click = (rig: Rig, selector: string) => rig.ev<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)

// ---- 用例 ----------------------------------------------------------------------------------------------------------------------------------

describe('funds page · 三宽度几何与锚点', () => {
  for (const width of WIDTHS) {
    it(`${width}×900：几何探针全 0；五张卡矩形与视觉稿相差 ≤ 4 px；每屏流光 ≤ 1、实心主按钮 ≤ 1`, async () => {
      await using('normal', width, {}, async (rig) => {
        await rig.settled()
        const g = await readGeometry(rig.cdp)
        expect(geometryCounts(g), JSON.stringify(g)).toEqual({ docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 })
        expect(g.alignOk).toBeGreaterThan(20)
        expect(g.numcolOk).toBeGreaterThan(8)
        const rects = await rig.ev<Record<string, { x: number; y: number; w: number; h: number }>>(`Object.fromEntries([...document.querySelectorAll('[data-g5="card"]')].map((c) => { const r = c.getBoundingClientRect(); return [c.getAttribute('aria-label'), { x: r.left, y: r.top, w: r.width, h: r.height }] }))`)
        expect(Object.keys(rects).sort()).toEqual([...CARDS].sort())
        for (const name of CARDS) {
          const [x, y, w, h] = anchors[String(width)]![name]!
          const r = rects[name]!
          for (const [axis, want, got] of [['x', x, r.x], ['y', y, r.y], ['w', w, r.w], ['h', h, r.h]] as const) {
            expect(Math.abs(got - want!), `${width} ${name}.${axis}: 稿 ${want} 页 ${got}`).toBeLessThanOrEqual(4)
          }
        }
        const audit = await rig.ev<Record<string, number> & { pass: Record<string, boolean>; samples?: Record<string, unknown> }>(auditSource)
        // 体检其余项全过；fillDepth 只命中交易所 App Icon 自带的光影底（kit / components.css 的件，不是本页写的），其余命中一律不放过
        const fillDepth = ((audit.samples?.fillDepth ?? []) as unknown[]).map(String)
        const failed = Object.entries(audit.pass).filter(([k, ok]) => !ok && !(k === 'fillDepth' && fillDepth.length > 0 && fillDepth.every((x) => x.startsWith('g5-venue')))).map(([k]) => k)
        expect(failed, JSON.stringify(audit.samples)).toEqual([])
        expect(audit.glow).toBeLessThanOrEqual(1)
        expect(audit.solidOrange).toBeLessThanOrEqual(1)
        expect(audit.capsule).toBe(0)
        expect(audit.sizeViolations).toBe(0)
        expect(audit.cjk11).toBe(0)
        expect(audit.coloredZero).toBe(0)
        await rig.shot(`funds-${width}`)
      })
    })
  }

  it.skipIf(!existsSync(referencePage))('登记的稿矩形与现稿一致（三宽度，视觉稿实测）', async () => {
    for (const width of WIDTHS) {
      const cdp = await launchCdp({ width, height: 900 })
      try {
        await cdp.navigate(new URL(`file:///${referencePage.replace(/\\/g, '/')}`).href)
        await cdp.evaluate('new Promise((r) => setTimeout(r, 1500))')
        const specs = [['账户', '#acct'], ['权益', '#eqcard'], ['资产', '#assets'], ['保证金', '#margin'], ['权益变动', '#chg']].map(([name, sel]) => ({ name: name!, reference: `.frame ${sel}`, product: `.frame ${sel}` }))
        const snap = await captureAnchors(cdp, specs, 'reference')
        for (const name of CARDS) {
          const want = anchors[String(width)]![name]!
          const r = snap.rects[name]!
          expect([r.x, r.y, r.width, r.height].map((v) => Math.round(v))).toEqual(want.map((v) => Math.round(v)))
        }
      } finally { await cdp.close() }
    }
  })
})

const SIX = ['accounts', 'curve', 'portfolio', 'assets', 'margin', 'changes'] as const
describe('funds page · 组合卡（GQ-65）', () => {
  for (const width of WIDTHS) {
    it(`${width}×900：六张卡（组合在左列权益曲线下）几何探针全 0`, async () => {
      await using('normal', width, { views: SIX }, async (rig) => {
        await rig.settled()
        const g = await readGeometry(rig.cdp)
        expect(geometryCounts(g), JSON.stringify(g)).toEqual({ docScrollX: 0, overflow: 0, truncated: 0, halfRows: 0, escape: 0, overlap: 0, badFont: 0, badSpace: 0, align: 0, numcol: 0 })
        await rig.shot(`funds-portfolio-${width}`)
      })
    })
  }
  it('场所 / 策略 / 标的三节：份额与盈亏照内核十进制串；未归属置底；前 5 + 其余；实盘纸面切换只换口径', async () => {
    await using('normal', 1440, { views: SIX }, async (rig) => {
      await rig.settled()
      const t = await text(rig, '组合')
      for (const w of ['场所', '策略', '标的', '75.00%', '25.00%', 'ema-trend', '+128.40', '未归属', '其余 2', '7.00%', 'USDC']) expect(t, w).toContain(w)
      const strat = await rig.ev<string[]>(`[...document.querySelectorAll('[data-section="策略"] [data-row]')].map((e) => e.getAttribute('data-row'))`)
      expect(strat).toEqual(['ema-trend', 'funding-carry', 'unassigned'])
      expect(rig.queries.filter((q) => q.method === 'portfolio.analysis').map((q) => q.params)).toEqual([{}])
      expect(await rig.ev(`document.querySelector('[data-act="portfolio-scope"]').textContent`)).toBe('实盘')
    })
  })
  it('估不了值：一行「无法估值」+ 内核原文逐条；未接通显示未接通', async () => {
    await using('normal', 1440, { views: SIX, prepare: (k) => k.onQuery('portfolio.analysis', () => ({ unavailable: true, details: ['missing_fx: EUR->USDC'] })) }, async (rig) => {
      await rig.settled()
      const t = await text(rig, '组合')
      expect(t).toContain('无法估值')
      expect(t).toContain('missing_fx: EUR->USDC')
      await rig.shot('funds-portfolio-unavailable')
    })
    await using('normal', 1440, { views: SIX, prepare: (k) => k.onQuery('portfolio.analysis', () => ({ scope: 'live' })) }, async (rig) => {
      await rig.settled()
      expect(await text(rig, '组合')).toContain('未接通')
    })
  })
})

describe('funds page · 内容与数字（正常态）', () => {
  it('账户表：实盘 / 纸面两组，小计只组内加；今日 = 权益 − 日初；保证金率；资金卡对得上（10,480.20 + 2,000.00 = 12,480.20）', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const rows = await rig.ev<string[][]>(`[...document.querySelectorAll('[data-g5="card"][aria-label="账户"] tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText.replace(/\\s+/g, ' ').trim()))`)
      const flat = rows.map((r) => r.join('|'))
      expect(flat[0]).toMatch(/^实盘 2\|\|.*12,480\.20\|7,792\.76\|\|\+128\.40/)
      expect(flat[1]).toContain('hl-main')
      expect(flat[1]).toContain('Hyperliquid')
      expect(flat[1]).toContain('10,480.20')
      expect(flat[1]).toContain('2.41%')
      expect(flat[1]).toContain('+128.40')
      expect(flat[2]).toContain('bn-1')
      expect(flat[2]).toContain('未验证')
      expect(flat[2]).toContain('0.00%')
      expect(flat[3]).toMatch(/^纸面 1\|\|.*9,987\.50\|8,367\.20\|\|−12\.50/)
      expect(flat[4]).toContain('paper-1')
      expect(flat[4]).toContain('模拟盘')
      expect(flat[4]).toContain('0.61%')
      expect(flat[4]).toContain('重置')
      const [assets, margin, changes] = await Promise.all(['资产', '保证金', '权益变动'].map((l) => text(rig, l)))
      expect(assets).toContain('USDC')
      expect(assets).toContain('4,687.44')
      expect(margin).toContain('4,687.44')
      expect(margin).toContain('252.33')
      expect(margin).toContain('1.28×')
      expect(margin).toContain('2.41%')
      for (const w of ['期初', '已实现', '+32.90', '手续费', '−16.55', '资金费', '−3.85', '未实现', '+27.76', '期末', '10,480.20', '成交 10 笔', '持仓 3']) expect(changes).toContain(w)
    })
  })

  it('权益曲线：缺采样段断开不补（两段线）；切 1D 换步长重查，只画区间内的点', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await rig.ev('document.querySelectorAll("[data-g5-chart=equity] polyline[data-segment]").length')).toBe(2)
      const seven = rig.queries.filter((q) => q.method === 'account.equity_history').map((q) => q.params as { step: string; accountId: string })
      expect(seven.length).toBeGreaterThan(0)
      expect(seven.every((p) => p.step === '1h' && p.accountId === FUND_ACCOUNT.hl)).toBe(true)
      expect(await click(rig, '[data-tab="1D"]')).toBe(true)
      await rig.waitFor(`document.querySelector('[data-tab="1D"]').getAttribute('aria-selected') === 'true' && document.querySelectorAll("[data-g5-chart=equity] polyline[data-segment]").length === 1`)
      const last = rig.queries.filter((q) => q.method === 'account.equity_history').at(-1)!.params as { step: string; from: number; to: number }
      expect(last.step).toBe('1m')
      expect(last.to - last.from).toBe(86_400_000)
      expect(await text(rig, '权益')).toContain('10,480.20')
    })
  })

  it('点账户行写联动 account，其余四张卡跟随并按该账户重查；「记录」跳 #/records', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await rig.ev('window.__hub.get("A", "account")')).toBeUndefined()
      expect(await click(rig, `tr[data-acct="${FUND_ACCOUNT.bn}"]`)).toBe(true)
      await rig.waitFor(`window.__hub.get('A', 'account') === '${FUND_ACCOUNT.bn}' && ${card('资产')}.innerText.includes('bn-1') && ${card('保证金')}.innerText.includes('bn-1') && ${card('权益')}.innerText.includes('bn-1')`)
      expect(await rig.ev(`document.querySelector('tr[data-acct="${FUND_ACCOUNT.bn}"]').getAttribute('aria-selected')`)).toBe('true')
      expect(await rig.ev(`document.querySelector('tr[data-acct="${FUND_ACCOUNT.hl}"]').getAttribute('aria-selected')`)).toBe('false')
      const assetsFor = rig.queries.filter((q) => q.method === 'account.assets').map((q) => (q.params as { accountId: string }).accountId)
      expect(assetsFor).toContain(FUND_ACCOUNT.bn)
      expect(await click(rig, `tr[data-acct="${FUND_ACCOUNT.paper}"] [data-act="records"]`)).toBe(true)
      await rig.waitFor(`window.__hub.get('A', 'account') === '${FUND_ACCOUNT.paper}' && location.hash === '#/records'`)
    })
  })

  it('涨跌色只用 --gr-up / --gr-down；data-updown="cn" 互换', async () => {
    await using('normal', 1440, {}, async (rig) => {
      await rig.settled()
      const colors = () => rig.ev<{ up: string; down: string; todayUp: string; todayDown: string; realized: string }>(`(() => {
        const probe = document.createElement('i'); document.body.append(probe)
        probe.style.color = 'var(--gr-up)'; const up = getComputedStyle(probe).color
        probe.style.color = 'var(--gr-down)'; const down = getComputedStyle(probe).color
        probe.remove()
        const c = (sel) => getComputedStyle(document.querySelector(sel)).color
        return { up, down, todayUp: c('tr[data-acct="${FUND_ACCOUNT.hl}"] [data-n="td"] > span'), todayDown: c('tr[data-acct="${FUND_ACCOUNT.paper}"] [data-n="td"] > span'), realized: c('[data-row="realized"] [data-n="chg"] > span') }
      })()`)
      const intl = await colors()
      expect(intl.up).not.toBe(intl.down)
      expect(intl.todayUp).toBe(intl.up)
      expect(intl.realized).toBe(intl.up)
      expect(intl.todayDown).toBe(intl.down)
      await rig.ev(`document.documentElement.setAttribute('data-updown', 'cn')`)
      const cn = await colors()
      expect(cn.up).toBe(intl.down)
      expect(cn.down).toBe(intl.up)
      expect(cn.todayUp).toBe(cn.up)
      expect(cn.todayDown).toBe(cn.down)
      expect(cn.realized).toBe(cn.up)
      await rig.shot('funds-1440-cn')
    })
  })
})

describe('funds page · 数值按内核精度原样显示', () => {
  it('0.00412345 BTC 的资产行原样显示，不被取整成 0.00', async () => {
    const assets = (p: unknown) => ({ accountId: (p as { accountId: string }).accountId, balances: [{ asset: 'BTC', total: '0.00412345', available: '0.00412345', hold: '0.00000001', borrowed: '0' }], margin: null, ts: 1 })
    await using('normal', 1440, { prepare: (k) => k.onQuery('account.assets', assets) }, async (rig) => {
      await rig.settled()
      const row = await rig.ev<string>(`${card('资产')}.querySelector('tbody tr').innerText.replace(/\\s+/g, ' ').trim()`)
      expect(row).toBe('BTC 0.00412345 0.00412345 0.00000001 0.00')
    })
  })
})

describe('funds page · 场所不可达只落在那一行', () => {
  it('bn-1 行显示「场所不可达」+ [重连]，其余行与别的卡照常；该组小计留空；重连发 venue.reconnect', async () => {
    await using('unreachable', 1440, { commands: { 'venue.reconnect': () => ({ ok: true }) } }, async (rig) => {
      await rig.settled()
      const row = await rig.ev<string>(`document.querySelector('tr[data-acct="${FUND_ACCOUNT.bn}"]').innerText.replace(/\\s+/g, ' ')`)
      expect(row).toContain('场所不可达')
      expect(row).toContain('重连')
      expect(row).not.toContain('2,000.00')
      expect(await rig.ev('document.querySelectorAll("[data-row-state=unreachable]").length')).toBe(1)
      expect(await rig.ev<string>(`document.querySelector('tr[data-acct="${FUND_ACCOUNT.hl}"]').innerText`)).toContain('10,480.20')
      expect(await rig.ev<string>(`document.querySelector('tr[data-acct="${FUND_ACCOUNT.paper}"]').innerText`)).toContain('9,987.50')
      // 实盘组小计留空（不拿残缺的和冒充合计），纸面组小计仍在
      const groups = await rig.ev<string[]>(`[...document.querySelectorAll('[data-g5="card"][aria-label="账户"] tr.g5-grp')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').trim())`)
      expect(groups[0]).toBe('实盘 2')
      expect(groups[1]).toContain('9,987.50')
      expect(await text(rig, '资产')).toContain('USDC')
      expect(await text(rig, '权益变动')).toContain('期末')
      await rig.shot('funds-1440-unreachable')
      expect(await click(rig, '[data-act="reconnect"]')).toBe(true)
      for (let i = 0; i < 50 && !rig.calls.length; i += 1) await sleep(100)
      expect(rig.calls).toMatchObject([{ action: 'venue.reconnect', params: { venue: 'binance' } }])
    })
  })
})

describe('funds page · 重置纸面走 PIN', () => {
  const reset = (after: Command = () => ({ ok: true })): Record<string, Command> => ({
    'paper.reset': (p, ctx) => {
      if (!ctx.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '重置纸面账户需要在场证明')
      return after(p, ctx)
    },
  })
  const arm = async (rig: Rig) => {
    expect(await click(rig, `tr[data-acct="${FUND_ACCOUNT.paper}"] [data-act="reset"]`)).toBe(true)
    await rig.waitFor(`document.querySelector('.g5-armed') && document.querySelector('.g5-armed .g5-what').innerText.startsWith('清空')`)
  }

  it('武装行写出后果；确认前 600 ms 防连点；内核先要证明、壳弹 PIN、带证明重发，成功后武装行消失', async () => {
    await using('normal', 1440, { commands: reset() }, async (rig) => {
      await rig.settled()
      await arm(rig)
      expect(await rig.ev('document.querySelector(".g5-armed .g5-what").innerText')).toBe('清空 paper-1：持仓 1、挂单 0，余额回到 10,000.00')
      expect(await rig.ev('document.querySelector(".g5-armed [data-act=reset-confirm]").disabled')).toBe(true)
      await rig.shot('funds-1440-reset-armed')
      await sleep(750)
      expect(await rig.ev('document.querySelector(".g5-armed [data-act=reset-confirm]").disabled')).toBe(false)
      expect(await click(rig, '.g5-armed [data-act="reset-confirm"]')).toBe(true)
      await rig.waitFor('!document.querySelector(".g5-armed")')
      expect(rig.calls).toHaveLength(2)
      expect(rig.calls[0]).toMatchObject({ action: 'paper.reset', params: { accountId: FUND_ACCOUNT.paper }, attestation: undefined })
      expect(rig.calls[1]).toMatchObject({ action: 'paper.reset', params: { accountId: FUND_ACCOUNT.paper }, attestation: { method: 'pin', pin: PIN } })
      expect(await rig.ev('window.__attest.calls')).toBe(1)
    })
  })

  it('PIN 层点取消 = 命令没发生：武装行还在、不报错；点「取消」收起', async () => {
    await using('normal', 1440, { commands: reset() }, async (rig) => {
      await rig.settled()
      await rig.ev('window.__attest.mode = "cancel"')
      await arm(rig)
      await sleep(750)
      expect(await click(rig, '.g5-armed [data-act="reset-confirm"]')).toBe(true)
      await rig.waitFor('window.__attest.calls === 1')
      await sleep(300)
      expect(rig.calls).toHaveLength(1)
      expect(rig.calls[0]!.attestation).toBeUndefined()
      expect(await rig.ev('document.querySelector(".g5-armed .g5-what").innerText')).toBe('清空 paper-1：持仓 1、挂单 0，余额回到 10,000.00')
      expect(await rig.ev('document.querySelector(".g5-armed [data-act=reset-confirm]").disabled')).toBe(false)
      expect(await click(rig, '.g5-armed [data-act="reset-cancel"]')).toBe(true)
      await rig.waitFor('!document.querySelector(".g5-armed")')
    })
  })

  it('内核拒绝：武装行显示内核原文，不改写', async () => {
    const message = 'paper.reset requires a paper or shadow account'
    await using('normal', 1440, { commands: reset(() => { throw problem('INVALID_PARAMS', -32602, message) }) }, async (rig) => {
      await rig.settled()
      await arm(rig)
      await sleep(750)
      await click(rig, '.g5-armed [data-act="reset-confirm"]')
      await rig.waitFor(`document.querySelector('.g5-armed .g5-what').innerText === ${JSON.stringify(message)}`)
    })
  })
})

describe('funds page · 四态与未接通', () => {
  it('加载：五张卡都是骨架，数据到了再换成内容', async () => {
    // 每个查询都延迟 3 s；账户表要串着查 5 次，所以等「全部落定」给到 90 s
    await using('loading', 1440, { delayMs: 3000 }, async (rig) => {
      await rig.waitFor(`document.documentElement.hasAttribute('data-ready') && document.querySelectorAll('[data-g5="card"]').length === 5`)
      for (const label of CARDS) expect(await rig.ev(`${card(label)}.querySelectorAll('.g5-sk, .g5-ghostplot').length`), `${label} 应是骨架`).toBeGreaterThan(0)
      await rig.shot('funds-loading')
      await rig.settled(90_000)
      expect(await text(rig, '账户')).toContain('hl-main')
    })
  })

  it('空：每张卡一行空态；账户卡给「去配置交易所」', async () => {
    await using('empty', 1440, {}, async (rig) => {
      await rig.settled()
      expect(await text(rig, '账户')).toContain('还没有账户')
      expect(await text(rig, '账户')).toContain('去配置交易所')
      expect(await text(rig, '权益')).toContain('还没有权益历史')
      expect(await text(rig, '资产')).toContain('还没有资产')
      expect(await text(rig, '保证金')).toContain('还没有保证金数据')
      expect(await text(rig, '权益变动')).toContain('这段时间没有权益变动')
      await rig.shot('funds-empty')
    })
  })

  it('错误：内核原文原样、带重试；{ok:false} 形状的成功返回同样取出原文', async () => {
    await using('error', 1440, {}, async (rig) => {
      await rig.settled()
      for (const label of CARDS) {
        const t = await text(rig, label)
        expect(t, label).toContain('读取失败')
        expect(await rig.ev(`${card(label)}.querySelector('[data-err-detail] .gr-errd__v')?.textContent ?? ''`), label).toContain(PROBLEM_TEXT) // ux-fix2 B2：同一规格变更（Owner 令，总控批准）——原文在该报错的详情里
        expect(await rig.ev(`${card(label)}.querySelectorAll('[data-act="read-retry"]').length`), label).toBe(1)
      }
      await rig.shot('funds-error')
    })
    await using('normal', 1440, { prepare: (k) => k.onQuery('account.list', () => ({ ok: false, error: { code: -32000, message: PROBLEM_TEXT } })) }, async (rig) => {
      await rig.settled()
      expect(await rig.ev(`${card('账户')}.querySelector('[data-err-detail] .gr-errd__v')?.textContent ?? ''`)).toContain(PROBLEM_TEXT) // ux-fix2 B2：同一规格变更（Owner 令，总控批准）——原文在该报错的详情里
    })
  })

  it('离线：卡降灰、卡头写「已暂停更新 · mm:ss」、命令钮禁用；恢复后复原', async () => {
    await using('offline', 1440, {}, async (rig) => {
      await rig.settled()
      await rig.ev(`document.documentElement.setAttribute('data-offline', '')`)
      await rig.waitFor(`document.querySelectorAll('[data-g5="card"][data-state="offline"]').length === 5`)
      for (const label of CARDS) expect(await text(rig, label), label).toMatch(/已暂停更新 · \d\d:\d\d/)
      expect(await rig.ev('[...document.querySelectorAll("[data-act=records],[data-act=reset]")].every((b) => b.disabled)')).toBe(true)
      expect(await rig.ev('document.querySelectorAll(".g5-off").length')).toBe(5)
      await rig.shot('funds-offline')
      await rig.ev(`document.documentElement.removeAttribute('data-offline')`)
      await rig.waitFor('document.querySelectorAll(".g5-off").length === 0 && ![...document.querySelectorAll("[data-act=records]")].some((b) => b.disabled)')
    })
  })

  it('未接通：接口不存在时写「未接通」+ 内核原文，不给重试；账户表其余部分照常', async () => {
    await using('unwired', 1440, {}, async (rig) => {
      await rig.settled()
      for (const label of ['权益', '资产', '保证金', '权益变动'] as const) {
        const t = await text(rig, label)
        expect(t, label).toContain('未接通')
        expect(t, label).toMatch(/未知查询 (account\.assets|account\.equity_history|records\.query)/)
        expect(await rig.ev(`${card(label)}.querySelectorAll('[data-wire="off"]').length`), label).toBe(1)
        expect(await rig.ev(`${card(label)}.querySelectorAll('[data-act="read-retry"]').length`), label).toBe(0)
      }
      expect(await text(rig, '账户')).not.toContain('读取失败')
      await rig.shot('funds-unwired')
    })
  })
})

describe('funds page · 源码红线', () => {
  const files = ['src/views/funds.tsx', 'src/views/funds.css', 'src/model-funds.ts', 'src/pages/funds.tsx', 'fixtures/funds.ts', 'test/model-funds.test.ts', 'test/funds.browser.test.ts']
  const read = (f: string) => readFileSync(resolve(pkgDir, f), 'utf8')
  // 禁词表本身不能在本文件里写成连续字面量，否则本文件自己就命中
  const banned = new RegExp(['保' + '守', '激' + '进', '稳' + '赚', '跑' + '赢', '稳定' + '盈利'].join('|'))
  it('新文件首行 SPDX；无颜色字面量（页内 CSS）；无全圆 / 直角；无禁词；无邮箱 / IP / 本机绝对路径', () => {
    for (const f of files) {
      const s = read(f)
      expect(s.split('\n')[0], f).toMatch(/SPDX-License-Identifier: CPAL-1\.0/)
      expect(s, f).not.toMatch(banned)
      expect(s, f).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
      expect(s, f).not.toMatch(/[\w.-]+@[\w-]+\.[a-z]{2,}/i)
      if (f.startsWith('src/') || f.startsWith('fixtures/')) expect(s, f).not.toMatch(/\b[A-Za-z]:[\\/]/)
    }
    const css = read('src/views/funds.css')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/)
    expect(css).not.toMatch(/9999px|border-radius:\s*50%/)
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/var\(--(?!gr-|tbl-gap)/)
  })
})
