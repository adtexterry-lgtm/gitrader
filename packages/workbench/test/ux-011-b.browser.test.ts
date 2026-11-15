// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复 B 包（ux-011）真浏览器用例：关于页版本 = 内核健康快照版本（K2 / UX-06）、PIN 表单的规则提示与保存键（UX-07）。
// workbench 的 vitest 是 node 环境：照 d2-pin-lock-copy.browser.test.ts 的写法，用 esbuild 把真组件打成脚本放进无头 Edge 渲染。
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PW = process.env.GITRADER_PLAYWRIGHT ?? 'playwright-core'
const EDGE = process.env.GITRADER_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const skip = !(existsSync(EDGE) && existsSync(PW)) && process.env.GITRADER_SKIP_BROWSER === '1'
const here = fileURLToPath(new URL('.', import.meta.url))
const about = fileURLToPath(new URL('../src/shell/About.jsx', import.meta.url))
const settings = fileURLToPath(new URL('../src/shell/Settings.jsx', import.meta.url))
const ctx = fileURLToPath(new URL('../src/shell/ctx.js', import.meta.url))

const ENTRY_ABOUT = `
import { render, h } from 'preact'
import { About } from ${JSON.stringify(about)}
render(h(About, {}), document.getElementById('app'))
`
// 设置 · 钥匙里的 PIN 表单：只要 PinForm，用壳的上下文给一份最小的 sh
const ENTRY_SETTINGS = `
import { render, h } from 'preact'
import { ShellCtx } from ${JSON.stringify(ctx)}
import { Settings } from ${JSON.stringify(settings)}
const sh = {
  ui: 'r5', status: 'open', offline: false, setPinSet: () => {}, go: () => {},
  api: { settings: async () => ({ network: 'testnet', pinSet: false, keys: [] }), agentKeys: async () => [], setPin: async () => ({}) },
}
render(h(ShellCtx.Provider, { value: sh }, h(Settings, { group: 'keys' })), document.getElementById('app'))
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let browser: Any
const scripts: Record<string, string> = {}

async function bundle(contents: string): Promise<string> {
  const out = await build({
    stdin: { contents, resolveDir: here, loader: 'js' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    jsx: 'automatic', jsxImportSource: 'preact', loader: { '.js': 'jsx', '.svg': 'text', '.css': 'empty', '.woff2': 'empty' }, logLevel: 'silent',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  return out.outputFiles[0]!.text
}

async function open(name: string, health?: Any): Promise<Any> {
  const p = await browser.newPage()
  // 相对路径 /api/health 要有个真源：用一个被拦截的假站点，健康快照由用例给
  await p.route('http://app.test/**', (route: Any) => {
    if (route.request().url().endsWith('/api/health')) return health ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health) }) : route.fulfill({ status: 503, body: 'x' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="app"></div>' })
  })
  await p.goto('http://app.test/')
  await p.addScriptTag({ content: scripts[name]! })
  return p
}

;(skip ? describe.skip : describe)('ux-011 B（浏览器）', () => {
  beforeAll(async () => {
    scripts.about = await bundle(ENTRY_ABOUT)
    scripts.settings = await bundle(ENTRY_SETTINGS)
    const { chromium } = createRequire(import.meta.url)(PW)
    browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  }, 120000)
  afterAll(async () => { await browser?.close() })

  it('UX-06：关于页版本 = 健康快照里的 version（不是工作台包自己的版本号）', async () => {
    const page = await open('about', { ok: true, version: '9.8.7' })
    try {
      await page.waitForFunction(() => document.querySelector('.gr-about__ver')?.textContent === '9.8.7', null, { timeout: 10000 })
    } finally { await page.close() }
  })

  it('UX-06：读不到健康快照时不编版本号', async () => {
    const page = await open('about')
    try {
      await page.waitForSelector('.gr-about__ver', { timeout: 10000 })
      await page.waitForTimeout(600)
      expect(await page.locator('.gr-about__ver').innerText()).toBe('—')
    } finally { await page.close() }
  })

  it('UX-07：新 PIN 旁有规则提示；不合规时保存键置灰，合规且两次一致才可点', async () => {
    const page = await open('settings')
    try {
      await page.locator('[data-act="pin-open"]').click()
      const rule = page.locator('[data-pin-rule]')
      await rule.waitFor({ state: 'visible', timeout: 10000 })
      expect(await rule.innerText()).toContain('6–12 位数字，或 8–64 位口令')
      const save = page.locator('[data-act="pin-save"]')
      await page.locator('input[aria-label="新 PIN"]').fill('123')
      await page.locator('input[aria-label="再输一次 PIN"]').fill('123')
      expect(await save.isDisabled()).toBe(true)
      await page.locator('input[aria-label="新 PIN"]').fill('abcdefg') // 7 位字母：既不是 6–12 位数字、也不到 8 位口令，内核会拒，界面也不放行
      await page.locator('input[aria-label="再输一次 PIN"]').fill('abcdefg')
      expect(await save.isDisabled()).toBe(true)
      await page.locator('input[aria-label="新 PIN"]').fill('246810')
      await page.locator('input[aria-label="再输一次 PIN"]').fill('246810')
      expect(await save.isDisabled()).toBe(false)
    } finally { await page.close() }
  })
})
