// SPDX-License-Identifier: CPAL-1.0
// 真壳、真块桥、真 PIN 层；仅内核响应使用隔离夹具。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { overviewScenario } from '../fixtures/overview'
import { startStage } from '../verify/stage-entry'
import { problem } from '../../workbench/verify/fixture-kernel'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const home = process.env.GITRADER_HOME
const shots = process.env.GITRADER_SHOTS_DIR
const require = createRequire(import.meta.url)
let dir = ''
let rig: Awaited<ReturnType<typeof startStage>>
let browser: any
let page: any
let requests: any[] = []
let calls: Array<{ action: string; params: any }> = []
let failNext = false
let pageErrors: string[] = []
let tokenPath = 'agent-tokens/demo.token'
const req = (id = 'akr_demo', offset = 0) => ({ requestId: id, state: 'pending', createdAt: Date.now() + offset, expiresAt: Date.now() + 600000, input: {
  name: '演示助手', host: 'codex', tier: 'confirm', expiresInDays: 30,
  mandate: { accounts: ['paper-1'], venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL', 'hyperliquid:AVAX'], limits: { maxOrderNotional: '150.25', maxDailyNotional: '800' } },
} })
async function visible(locator: any) { await locator.waitFor({ state: 'visible', timeout: 10000 }) }
async function absent(locator: any) { await locator.waitFor({ state: 'hidden', timeout: 10000 }) }
async function pin() {
  const dialog = page.locator('.gr-pin')
  await visible(dialog)
  await dialog.locator('input').first().fill('246810')
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await absent(dialog)
}
async function hit(locator: any) {
  expect(await locator.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return at === el || el.contains(at) })).toBe(true)
}
async function shot(name: string, width: number) {
  if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${name}-${width}.png`), animations: 'disabled' }) }
}
beforeAll(async () => {
  if (!home || !process.env.GITRADER_PLAYWRIGHT || !process.env.GITRADER_EDGE) throw new Error('浏览器测试需要 GITRADER_HOME、GITRADER_PLAYWRIGHT、GITRADER_EDGE')
  mkdirSync(home, { recursive: true })
  dir = mkdtempSync(join(home, 'e06-'))
  const workbench = join(repo, 'packages/workbench')
  const tw = join(dir, 'tw.css')
  execFileSync(process.execPath, [join(repo, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', join(workbench, 'src/ui/tw.css'), '-o', tw, '--minify'], { cwd: workbench, stdio: 'pipe', windowsHide: true })
  await build({ entryPoints: [join(workbench, 'src/app.jsx')], outfile: join(dir, 'app.js'), bundle: true, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
    loader: { '.js': 'jsx', '.woff2': 'file' }, alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, define: { __GITRADER_VERSION__: '"test"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    plugins: [{ name: 'e06-assets', setup(b) {
      b.onResolve({ filter: /^virtual:tw$/ }, () => ({ path: tw, namespace: 'e06-tw' }))
      b.onLoad({ filter: /.*/, namespace: 'e06-tw' }, () => ({ contents: readFileSync(tw, 'utf8'), loader: 'css', resolveDir: join(workbench, 'src/ui') }))
      b.onLoad({ filter: /[\\/](shell|blocks)\.css$/ }, (a) => { const source = readFileSync(a.path, 'utf8'); return { contents: /@layer\s+gr-legacy\b/.test(source) ? source : `@layer gr-legacy {${source}}`, loader: 'css' } })
      b.onLoad({ filter: /\.svg$/ }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, 'utf8'))}`, loader: 'js' }))
    } }],
  })
  writeFileSync(join(dir, 'index.html'), readFileSync(join(workbench, 'src/index.html'), 'utf8'))
  rig = await startStage({ staticDir: dir, workspacesDir: join(dir, 'workspaces') })
  rig.kernel.settings.pinSet = true
  rig.kernel.onQuery('agentkey.request.list', () => ({ requests }))
  for (const action of ['agentkey.create', 'mandate.update', 'agentkey.request.approve', 'agentkey.request.reject']) {
    rig.kernel.onCommand(action, (params: any, envelope: any) => {
      if (action !== 'agentkey.request.reject' && !envelope?.attestation) throw problem('ATTESTATION_REQUIRED', 1010, '需要 PIN 确认', { action })
      calls.push({ action, params })
      if (failNext) { failNext = false; throw problem('INVALID_INPUT', 1001, '暂时无法保存，请重试') }
      if (action === 'agentkey.create') return { key: { keyId: 'ak_new' }, mandate: {}, tokenFilePath: tokenPath, token: 'MUST_NOT_RENDER_FIXTURE_VALUE' }
      if (action === 'mandate.update') {
        rig.stage.sc.mandates = rig.stage.sc.mandates.map((m: any) => m.mandateId === params.mandateId ? { ...m, ...params.input } : m)
        return { mandate: rig.stage.sc.mandates.find((m: any) => m.mandateId === params.mandateId) }
      }
      requests = requests.filter((r) => r.requestId !== params.requestId)
      return { keyId: 'ak_requested', tokenFilePath: 'agent-tokens/request.token', name: '演示助手' }
    })
  }
  browser = await require(process.env.GITRADER_PLAYWRIGHT).chromium.launch({ executablePath: process.env.GITRADER_EDGE, headless: true, args: ['--no-first-run', '--lang=zh-CN'] })
}, 120000)
beforeEach(async () => {
  await page?.close()
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  pageErrors = []
  page.on('pageerror', (e: Error) => pageErrors.push(e.stack || e.message))
  requests = []; calls = []; failNext = false
  tokenPath = 'agent-tokens/demo.token'
  rig.stage.sc = overviewScenario('normal')
  const sc = rig.stage.sc
  sc.keys = sc.keys.slice(0, 1).map((k: any) => ({ ...k, name: '演示助手', host: 'codex' }))
  sc.mandates = sc.mandates.filter((m: any) => m.mandateId === sc.keys[0]!.mandateId).map((m: any) => ({ ...m, level: 'L1', instrumentAllowlist: [], venueAllowlist: [], limits: {} }))
  rig.kernel.onQuery('risk.state', () => ({ tradingState: 'ACTIVE', limits: { maxOrderNotional: '150.25', maxDailyNotional: '800' } }))
  const launch = new URL(rig.kernel.launchUrl())
  launch.searchParams.set('ui', 'r5')
  await page.goto(launch.href)
  try { await page.waitForFunction(() => (window as any).__GR_READY__?.online, undefined, { timeout: 8000 }) }
  catch { throw new Error(`壳启动失败：${JSON.stringify({ errors: pageErrors, ready: await page.evaluate(() => (window as any).__GR_READY__) }).replace(/https?:\/\/[^/\s)]+/g, 'test-origin')}`) }
  await visible(page.locator('[data-view="keys"] [data-act="tier"]'))
})
afterAll(async () => {
  await browser?.close()
  await rig?.kernel.close()
  if (dir && home && resolve(dir).startsWith(resolve(home) + sep)) rmSync(dir, { recursive: true, force: true })
})

describe('E0-6 real shell', () => {
  it('tier menu flips above anchor near viewport bottom', async () => {
    for (const [width, height] of [[1440, 900], [1920, 1080]] as const) {
      await page.setViewportSize({ width, height })
      await page.locator('[data-view="keys"]').evaluate((el: HTMLElement) => Object.assign(el.style, { position: 'fixed', bottom: '8px', right: '20px', width: '420px', zIndex: '30' }))
      const anchor = page.locator('[data-act="tier"]')
      await anchor.click()
      const menu = page.getByRole('menu', { name: '权限档位' })
      await visible(menu)
      const a = await anchor.boundingBox(), b = await menu.boundingBox()
      expect(b.y + b.height).toBeLessThanOrEqual(a.y - 7)
      expect(b.x).toBeGreaterThanOrEqual(8)
      expect(b.x + b.width).toBeLessThanOrEqual(width - 8)
      await hit(menu.getByRole('menuitem', { name: '编辑授权…' }))
      await shot('tier-menu', width)
      await page.keyboard.press('Escape')
    }
    await page.locator('[data-act="tier"]').click()
    await page.setViewportSize({ width: 320, height: 180 })
    const menu = page.getByRole('menu', { name: '权限档位' })
    await page.waitForFunction(() => { const el = document.querySelector('[aria-label="权限档位"]'); if (!el) return false; const r = el.getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8 })
    expect(await menu.evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight)).toBe(true)
  })
  it('paper→confirm opens prefilled dialog', async () => {
    await page.locator('[data-act="tier"]').click()
    await page.getByRole('menuitemradio', { name: '需确认', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑授权' })
    await visible(dialog)
    expect(await dialog.getByLabel('名字', { exact: true }).inputValue()).toBe('演示助手')
    expect(await dialog.getByRole('radio', { name: /每笔开仓等你批/ }).isChecked()).toBe(true)
    expect(await dialog.locator('[data-missing="true"]').count()).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
    for (const [width, height] of [[1440, 900], [1920, 1080]] as const) { await page.setViewportSize({ width, height }); await hit(dialog.getByRole('button', { name: '保存授权', exact: true })); await shot('grant-dialog', width) }
    await dialog.getByRole('button', { name: '保存授权', exact: true }).click()
    await pin()
    await absent(dialog)
    expect(calls[0]?.action).toBe('mandate.update')
    expect(calls[0]?.params.input).toMatchObject({ level: 'L2', instrumentAllowlist: expect.arrayContaining(['hyperliquid:BTC', 'hyperliquid:ETH']), limits: { maxOrderNotional: '150.25', maxDailyNotional: '800' } })
    await visible(page.locator('[data-act="tier"]').filter({ hasText: '需确认' }))
  })
  it('create key shows token file path not token', async () => {
    tokenPath = join(dir, 'agent tokens', 'demo.token')
    await page.getByRole('button', { name: '接入 Agent', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '接入 Agent' })
    await visible(dialog)
    expect(await dialog.getByLabel('名字', { exact: true }).evaluate((el: HTMLElement) => document.activeElement === el)).toBe(true)
    await dialog.getByLabel('名字', { exact: true }).fill('新助手')
    await dialog.getByLabel('宿主', { exact: true }).selectOption('codex')
    await dialog.getByLabel('添加标的', { exact: true }).fill('SOL')
    await dialog.getByRole('button', { name: '添加', exact: true }).click()
    await dialog.getByRole('button', { name: '创建钥匙', exact: true }).click()
    await pin()
    await visible(page.getByText('令牌已存到', { exact: false }))
    const text = await dialog.innerText()
    expect(text).toContain(tokenPath)
    expect(text).toContain('gitrader mcp snippet codex --token-file')
    const q = process.platform === 'win32' ? '"' : "'" // 规格变更：win32 双引号 / POSIX 单引号
    expect(text).toContain(`--token-file ${q}${tokenPath}${q}`)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await dialog.getByRole('button', { name: '复制配置提示', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`请运行 gitrader mcp snippet codex --token-file ${q}${tokenPath}${q} 并按输出配置`)
    expect(await page.locator('body').innerText()).not.toContain('MUST_NOT_RENDER_FIXTURE_VALUE')
    expect(calls[0]?.params).toMatchObject({ tokenFile: true, input: { name: '新助手', host: 'codex', tier: 'confirm', expiresInDays: 30, mandate: { limits: { maxOrderNotional: '150.25', maxDailyNotional: '800' } } } })
    expect(calls[0]?.params.input.mandate.instrumentAllowlist).toContain('hyperliquid:SOL')
  })
  it('cancels PIN, retries a failed save and closes with Escape', async () => {
    await page.getByRole('button', { name: '接入 Agent', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '接入 Agent' })
    await dialog.getByLabel('名字', { exact: true }).fill('可重试助手')
    await dialog.getByRole('button', { name: '创建钥匙', exact: true }).click()
    await visible(page.locator('.gr-pin'))
    await page.keyboard.press('Escape')
    await visible(dialog)
    expect(calls).toHaveLength(0)
    expect(await dialog.getByLabel('名字', { exact: true }).inputValue()).toBe('可重试助手')
    failNext = true
    await dialog.getByRole('button', { name: '创建钥匙', exact: true }).click()
    await pin()
    await visible(dialog.getByRole('alert'))
    expect(await dialog.getByRole('alert').innerText()).toMatch(/[一-龥]/)
    expect(await dialog.getByRole('alert').innerText()).toContain('暂时无法保存，请重试')
    await dialog.getByRole('button', { name: '创建钥匙', exact: true }).click()
    await pin()
    await visible(page.getByText('令牌已存到', { exact: false }))
    expect(calls).toHaveLength(2)
    await page.keyboard.press('Escape')
    await absent(dialog)
  })
  it('reviews every request field and approves through the shell PIN', async () => {
    requests = [req('akr_later', 100), req()]
    const card = page.getByRole('region', { name: 'Agent 接入请求' })
    await visible(card)
    expect(await card.innerText()).toContain('还有 1 个')
    expect(await card.innerText()).toContain('hyperliquid:AVAX')
    await page.keyboard.press('Escape'); await visible(card)
    for (const [width, height] of [[1440, 900], [1920, 1080]] as const) { await page.setViewportSize({ width, height }); await hit(card.getByRole('button', { name: '批准（输入 PIN）' })); await hit(page.locator('.g5-status-slot .g5-btn-takeover').first()); await shot('request-card', width) }
    await card.getByRole('button', { name: '批准（输入 PIN）' }).click()
    await pin()
    expect(calls[0]).toEqual({ action: 'agentkey.request.approve', params: { requestId: 'akr_demo' } })
    await visible(page.getByText('已批准：演示助手', { exact: true }))
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await absent(card)
    expect(calls[1]).toEqual({ action: 'agentkey.request.reject', params: { requestId: 'akr_later' } })
  })
  it('keeps all grant controls reachable by keyboard on a narrow screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '接入 Agent', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '接入 Agent' })
    await visible(dialog)
    const reached: string[] = []
    for (let i = 0; i < 24; i++) {
      reached.push(await page.evaluate(() => { const el = document.activeElement; return el?.getAttribute('aria-label') || el?.textContent?.trim() || '' }))
      expect(await dialog.evaluate((el: HTMLElement) => el.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Tab')
    }
    for (const label of ['名字', '宿主', '账户', '添加标的', '单笔上限', '每日上限', '有效期（天）', '创建钥匙', '取消']) expect(reached).toContain(label)
    const bounds = await dialog.boundingBox()
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
    await absent(dialog)
  })
  it('stops polling while hidden and refreshes on return', async () => {
    const count = () => rig.kernel.queries.filter((q) => q.method === 'agentkey.request.list').length
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    const before = count()
    await new Promise((resolveWait) => setTimeout(resolveWait, 3200))
    expect(count()).toBe(before)
    requests = [req()]
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await visible(page.getByRole('region', { name: 'Agent 接入请求' }))
    expect(count()).toBeGreaterThan(before)
  })
  it('removes expired requests without executing them', async () => {
    requests = [{ ...req(), expiresAt: Date.now() + 5500 }]
    const card = page.getByRole('region', { name: 'Agent 接入请求' })
    await visible(card)
    await absent(card)
    expect(calls).toHaveLength(0)
  })
  it('requires the additional finite limits for automatic grants', async () => {
    await page.locator('[data-act="tier"]').click()
    await page.getByRole('menuitemradio', { name: '限额自动', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑授权' })
    await visible(dialog)
    await dialog.getByRole('button', { name: '保存授权', exact: true }).click()
    await visible(dialog.getByRole('alert'))
    expect(calls).toHaveLength(0)
    await dialog.getByLabel('日亏上限', { exact: true }).fill('25')
    await dialog.getByLabel('自动单笔上限', { exact: true }).fill('100')
    await dialog.getByRole('button', { name: '保存授权', exact: true }).click()
    await pin()
    expect(calls[0]?.params.input).toMatchObject({ level: 'L3', limits: { maxDailyLoss: '25', autoMaxOrderNotional: '100' } })
  })
})
