// SPDX-License-Identifier: CPAL-1.0
// T2 公共件：真壳（workbench/build.mjs 的真产物）+ 夹具内核 + CDP 直连 Edge。旅程与锚点用例共用，不进 src/。
// 要点：几何探针作为同源外部脚本预装（内核页 CSP 不许内联脚本）；按页换夹具（applyPage）而不是为每页重起内核。
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installViewFixtures } from '@gitrader/blocks-sdk/testing'
import { installScenario } from '../../../blocks-default/fixtures/install'
import { problem } from '../../../workbench/verify/fixture-kernel'
import { designSet as chartSet, installChartHandlers } from '../../fixtures/chart'
import { installFundsHandlers } from '../../fixtures/funds'
import { overviewScenario } from '../../fixtures/overview'
import { designSet as recordsSet, installRecordsHandlers } from '../../fixtures/records'
import { r5Fixtures } from '../../fixtures/index'
import { settingsConfig } from '../../fixtures/venues'
import { startStage } from '../../verify/stage-entry'
import { launchCdp } from './cdp'

export const here = dirname(fileURLToPath(import.meta.url))
export const repo = resolve(here, '../../../..')
export const PIN = '246810'
export const WIDTHS = [1280, 1440, 1920] as const
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 十一页：hash = 真壳路由；mock = visual-r5 下的稿目录；group = r5Fixtures 的键。 */
export const PAGES = [
  { key: 'overview', hash: '#/overview', mock: 'overview', group: 'overview' },
  { key: 'chart', hash: '#/chart', mock: 'chart', group: 'chart' },
  { key: 'records', hash: '#/records', mock: 'records', group: 'records' },
  { key: 'funds', hash: '#/funds', mock: 'funds', group: 'funds' },
  { key: 'strategies', hash: '#/strategies', mock: 'strategy', group: 'strategies' },
  { key: 'lab', hash: '#/lab', mock: 'lab', group: 'lab' },
  { key: 'lab-detail', hash: '#/lab/r1-experiment', mock: 'lab-detail', group: 'lab-detail' },
  { key: 'plugins', hash: '#/plugins', mock: 'plugins', group: 'plugins' },
  { key: 'settings-venues', hash: '#/settings/venues', mock: 'settings-venues', group: 'venues' },
  { key: 'settings-notify', hash: '#/settings/notify', mock: 'settings-notify', group: 'notify' },
  { key: 'settings-personal', hash: '#/settings/personal', mock: 'settings-personal', group: 'venues' },
] as const
export type PageKey = typeof PAGES[number]['key']

/** 真壳产物：build.mjs 写进 outDir，再放入外部几何探针并在 index.html 里预装。 */
export function buildShell(outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  execFileSync(process.execPath, [join(repo, 'packages/workbench/build.mjs')], { cwd: repo, env: { ...process.env, GITRADER_UI_OUT: outDir }, stdio: ['ignore', 'ignore', 'pipe'] })
  copyFileSync(join(repo, 'packages/workbench/design/geometry-probe.js'), join(outDir, 'geometry-probe.js'))
  const index = readFileSync(join(outDir, 'index.html'), 'utf8')
  if (!index.includes('<script src="./app.js"></script>')) throw new Error('index.html has no app.js script tag')
  writeFileSync(join(outDir, 'index.html'), index.replace('<script src="./app.js"></script>', '<script src="./geometry-probe.js"></script>\n<script src="./app.js"></script>'))
  return outDir
}

type Kernel = Awaited<ReturnType<typeof startStage>>['kernel']
type Rec = Record<string, unknown>

/** 设置三页的 config.view + 三条写命令（放宽要 PIN；形状同 settings-r5.browser.test.ts 的 installHandlers）。 */
function installSettingsHandlers(kernel: Kernel, cfg: { config: typeof settingsConfig }): void {
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
  kernel.onCommand('notify.test', (p) => ({ results: [{ channelId: (p as { channelId: string }).channelId, ok: true }] }))
  kernel.onCommand('venue.reconnect', () => ({ ok: true }))
}

export interface Shell {
  kernel: Kernel
  stage: ReturnType<typeof installScenario>
  cdp: Awaited<ReturnType<typeof launchCdp>>
  width: number
  settings: { config: typeof settingsConfig }
  /** 按页换夹具（同 startStage 对该页做的事 + 该页测试自己装的处理器）。 */
  applyPage(page: PageKey): void
  /** 载入真壳（?ui=r5）。 */
  open(hash: string): Promise<void>
  goTo(hash: string): Promise<void>
  ev<T = unknown>(expression: string): Promise<T>
  waitFor(expression: string, ms?: number): Promise<void>
  click(selector: string): Promise<void>
  /** 在输入框里写字（原生 setter + input 事件）。 */
  type(selector: string, text: string): Promise<void>
  setViewport(width: number, height?: number): Promise<void>
  shot(file: string): Promise<void>
  /** 页面加载完：壳 online、工作区在、无骨架。 */
  settled(): Promise<void>
  /** 外部预装的几何探针；返回各项计数（raw 是探针原样结果）。 */
  geometry(): Promise<Record<string, number> & { raw: Rec }>
  audit(): Promise<Rec>
  commands(action: string): Array<{ action: string; params: unknown; attestation?: unknown }>
  close(): Promise<void>
}

let seq = 0
export async function openShell(opts: { staticDir: string; workDir: string; width?: number; height?: number }): Promise<Shell> {
  const width = opts.width ?? 1440
  const height = opts.height ?? 900
  seq += 1
  const dir = join(opts.workDir, `shell-${seq}`)
  mkdirSync(dir, { recursive: true })
  const started = await startStage({ staticDir: opts.staticDir, workspacesDir: join(dir, 'workspaces'), scenario: 'overview-normal' })
  const kernel = started.kernel
  // 与稿同态：稿里 PIN 已设。夹具内核默认 pinSet:false 会让真壳顶上多一条「先设置 PIN」提示（fix-r4 加的，高 28px），把每页卡片整体下推
  kernel.settings.pinSet = true
  let cdp: Awaited<ReturnType<typeof launchCdp>> | undefined
  for (let attempt = 0; ; attempt += 1) {
    try { cdp = await launchCdp({ width, height }); break }
    catch (error) {
      if (attempt >= 3 || !/EBUSY/.test(String((error as Error).message))) { await kernel.close(); throw error }
      await sleep(500)
    }
  }
  const sh = { kernel, stage: started.stage, cdp: cdp!, width, settings: { config: structuredClone(settingsConfig) } } as unknown as Shell
  const ev = async (expression: string) => {
    const result = await sh.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const exception = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    if (exception) throw new Error(`page evaluation failed: ${exception.exception?.description ?? exception.text ?? 'unknown'}`.slice(0, 600))
    return (result.result as { value?: unknown } | undefined)?.value as never
  }
  Object.assign(sh, {
    applyPage(page: PageKey) {
      const def = PAGES.find((p) => p.key === page)!
      const now = Date.now()
      sh.stage = installScenario(kernel, 'normal')
      installViewFixtures(kernel, 'normal')
      const fixture = ((r5Fixtures as Record<string, Record<string, { queries?: Rec; commands?: Rec }>>)[def.group]?.normal) ?? {}
      for (const [method, value] of Object.entries(fixture.queries ?? {})) kernel.onQuery(method, (params) => typeof value === 'function' ? (value as (p: unknown) => unknown)(params) : value)
      for (const [action, value] of Object.entries(fixture.commands ?? {})) kernel.onCommand(action, () => value)
      if (page === 'overview') sh.stage.sc = overviewScenario('normal', now)
      if (page === 'chart') installChartHandlers(kernel, chartSet(now))
      if (page === 'records') {
        const set = recordsSet(now)
        installRecordsHandlers(kernel, set)
      }
      if (page === 'funds') installFundsHandlers(kernel, 'normal', { now })
      if (page.startsWith('settings-')) { sh.settings.config = structuredClone(settingsConfig); installSettingsHandlers(kernel, sh.settings) }
    },
    async open(hash: string) {
      const url = new URL(kernel.url + '/')
      url.searchParams.set('ui', 'r5')
      url.hash = hash
      // 先在同源的静态文件页清掉 localStorage（偏好、联动标的、块配置），再完整载入真壳：每页都从干净状态起，与稿同夹具
      await sh.cdp.navigate(kernel.url + '/geometry-probe.js')
      await sh.cdp.evaluate('localStorage.clear(); sessionStorage.clear(); 1')
      await sh.cdp.navigate('about:blank')
      await sh.cdp.navigate(url.href)
      await sh.waitFor('window.__GR_READY__?.online === true', 20_000)
    },
    async goTo(hash: string) { await ev(`location.hash = ${JSON.stringify(hash)}`); await sleep(120) },
    ev,
    async waitFor(expression: string, ms = 15_000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await ev(expression)) return
        await sleep(100)
      }
      const state = await ev(`({ hash: location.hash, ui: document.documentElement.dataset.ui, pages: [...document.querySelectorAll('[data-g5-page]')].map((n) => n.getAttribute('data-g5-page')), text: document.body.innerText.slice(0, 300) })`).catch(() => null)
      throw new Error(`waitFor timed out: ${expression}; state=${JSON.stringify(state)}; errors=${JSON.stringify(sh.cdp.errors.slice(-4))}`)
    },
    async click(selector: string) {
      const point = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return hit && (hit === el || el.contains(hit) || hit.contains(el)) ? { x, y } : { x, y, blocked: hit ? hit.outerHTML.slice(0, 140) : 'none' } })()`) as { x: number; y: number; blocked?: string } | null
      if (!point) throw new Error(`no element for ${selector}`)
      if (point.blocked) throw new Error(`cannot click ${selector}: blocked by ${point.blocked}`)
      await sh.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await sh.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await sh.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    },
    async type(selector: string, text: string) {
      await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    },
    async setViewport(w: number, h = height) {
      sh.width = w
      await sh.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      await sleep(120)
    },
    async shot(file: string) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, await sh.cdp.screenshot()) },
    async settled() {
      await sh.waitFor(`window.__GR_READY__?.online === true && !!document.querySelector('[data-g5-page]') && !document.querySelector('.g5-sk, [data-skeleton]')`, 20_000)
      await sh.cdp.evaluate(`document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`)
      await sleep(350)
    },
    async geometry() {
      // 稳定布局后跑外部预装的 window.__grGeometry（不走 geo.ts 的内联注入，内核页 CSP 会挡）
      const raw = await ev(`(async () => {
        if (typeof window.__grGeometry?.run !== 'function') throw new Error('external geometry probe is not installed')
        const snap = () => JSON.stringify([...document.querySelectorAll('[data-g5="card"]')].map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }))
        let prev = ''
        for (let i = 0; i < 24; i += 1) { await new Promise((r) => requestAnimationFrame(r)); const now = snap(); if (now === prev) break; prev = now; await new Promise((r) => setTimeout(r, 80)) }
        return window.__grGeometry.run({})
      })()`) as Rec
      const count = (k: string) => (raw[k] as unknown[]).length
      return { raw, docScrollX: raw.docScrollX as number, overflow: count('overflow'), truncated: count('truncated'), halfRows: count('halfRows'), escape: count('escape'), overlap: count('overlap'), badFont: count('badFont'), badSpace: count('badSpace'), align: count('align'), numcol: count('numcol') } as never
    },
    async audit() {
      const source = readFileSync(join(repo, 'packages/workbench/design/audit-probe.js'), 'utf8')
      return await ev(source) as Rec
    },
    commands(action: string) { return kernel.commands.filter((c) => c.action === action) },
    async close() {
      await sh.cdp.close()
      await kernel.close().catch(() => undefined) // Jr5-6 会先把内核关掉
    },
  })
  return sh
}

/** 噪声过滤：favicon 之类与产品无关的资源 404。 */
export const realErrors = (errors: string[]): string[] => errors.filter((e) => !/favicon/i.test(e))
