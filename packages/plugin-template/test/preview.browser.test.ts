// SPDX-License-Identifier: Apache-2.0
// 夹具预览（harness）：把打好的 block.js 放进只给 allow-scripts 的 iframe，宿主用 SDK 的块桥 + 夹具桥服务它；无头 Edge 看它真的渲染、随回放事件更新、能切周期，
// 并且确实被隔离（访问不到宿主页面）。找不到无头浏览器时整体失败；确实没有就设 GITRADER_SKIP_BROWSER=1 并在回报里写明没验。
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const PW = process.env.GITRADER_PLAYWRIGHT ?? 'playwright-core' // 开发机上的 playwright-core：默认按模块名解析（npm i -D playwright-core），GITRADER_PLAYWRIGHT 可指到别处
const EDGE = process.env.GITRADER_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const canLoadPw = (): boolean => { try { createRequire(import.meta.url).resolve(PW); return true } catch { return existsSync(PW) } }
const have = canLoadPw() && existsSync(EDGE)
const d = !have && process.env.GITRADER_SKIP_BROWSER === '1' ? describe.skip : describe

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any
let hostJs = ''

beforeAll(async () => {
  if (!have) throw new Error(`找不到无头浏览器（Edge: ${EDGE}；playwright-core: ${PW}）。用 GITRADER_EDGE / GITRADER_PLAYWRIGHT 指过去；确实没有就设 GITRADER_SKIP_BROWSER=1 并在回报里写明没验。`)
  const r = await build({ entryPoints: [join(root, 'test/host-entry.ts')], bundle: true, write: false, format: 'iife', target: 'es2022', loader: { '.json': 'json' }, logLevel: 'silent', outfile: join(root, 'host.js') })
  hostJs = r.outputFiles[0]!.text
  const { chromium } = createRequire(import.meta.url)(PW)
  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
}, 60000)
afterAll(async () => { try { await browser?.close() } catch { /* 已关闭 */ } })

d('指标块在 iframe 沙箱里（夹具桥）', () => {
  it('渲染 EMA 读数，随回放事件更新，能切周期；iframe 只有 allow-scripts 且碰不到宿主', async () => {
    const errors: string[] = []
    const page = await browser.newPage({ viewport: { width: 600, height: 300 } })
    page.on('pageerror', (e: Error) => errors.push(e.message))
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.setContent('<!doctype html><html><body style="margin:0;background:#111"></body></html>')
    await page.addScriptTag({ content: hostJs })
    await page.evaluate((js: string) => { (window as unknown as { mountBlock(s: string): void }).mountBlock(js) }, readFileSync(join(root, 'example/ema-reading/block.js'), 'utf8'))

    expect(await page.$eval('iframe', (f: Element) => f.getAttribute('sandbox'))).toBe('allow-scripts')
    const frame = page.frames().find((f: { parentFrame(): unknown }) => f.parentFrame() !== null)
    expect(frame).toBeDefined()
    await frame.waitForSelector('.ema__v', { timeout: 6000 })
    const first = await frame.$eval('.ema__v', (e: Element) => e.textContent)
    expect(first).toMatch(/^\d{2},\d{3}\.\d{2}$/)
    expect(await frame.$eval('.ema__top span', (e: Element) => e.textContent)).toBe('EMA 21')
    expect(await frame.$eval('.ema__sub', (e: Element) => (e as HTMLElement).innerText)).toMatch(/收盘 [\d,]+\.\d{2}[\s\S]*[▲▼–] [+−]?\d+\.\d{2}%/)

    // 回放事件让最后一根的收盘价变了：读数里的收盘价随之更新
    const lastBefore = await frame.$eval('.ema__sub span', (e: Element) => e.textContent)
    await frame.waitForFunction((b: string) => document.querySelector('.ema__sub span')?.textContent !== b, lastBefore, { timeout: 6000 })

    // 切周期
    await frame.click('.ema__top button:has-text("55")')
    expect(await frame.$eval('.ema__top span', (e: Element) => e.textContent)).toBe('EMA 55')
    expect(await frame.$eval('.ema__top button[aria-pressed="true"]', (e: Element) => e.textContent)).toBe('55')
    expect(await frame.$eval('.ema__v', (e: Element) => e.textContent)).not.toBe(first)

    // 隔离：opaque 源，读不到宿主页面
    expect(await frame.evaluate(() => { try { return window.parent.document.title } catch { return 'blocked' } })).toBe('blocked')
    expect(await frame.evaluate(() => { try { return typeof localStorage.length } catch { return 'blocked' } })).toBe('blocked')
    expect(errors, '控制台错误').toEqual([])
    await page.close()
  })
})
