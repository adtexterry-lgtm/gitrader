// SPDX-License-Identifier: CPAL-1.0
// fix3 WI-F8 / D2：锁定期间不显示上一次的「PIN 不对」，锁定结束后也不把那句旧话翻出来（等到下一次提交）。
// workbench 的 vitest 是 node 环境、没有 JSX 转换：照 forms.browser.test.ts 的写法，用 esbuild 把真组件打成一段脚本，放进无头 Edge 里渲染。
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error The JSX shell component is outside the package TypeScript compilation boundary.
import { pinErrorText } from '../src/shell/PinDialog.jsx'

const PW = process.env.GITRADER_PLAYWRIGHT ?? 'playwright-core'
const EDGE = process.env.GITRADER_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const skip = !(existsSync(EDGE) && existsSync(PW)) && process.env.GITRADER_SKIP_BROWSER === '1'
const dialog = fileURLToPath(new URL('../src/shell/PinDialog.jsx', import.meta.url))

// 受控 harness：window.setItem 换 item（同 id 才保留 PinBody 的 lockedRound 状态），window.calls 记 onSubmit。
const ENTRY = `
import { render, h } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { PinDialog } from ${JSON.stringify(dialog)}
const subs = new Set()
window.calls = []
window.setItem = (item) => { window.item = item; for (const fn of subs) fn(item) }
function App() {
  const [item, setItem] = useState(window.item ?? null)
  useEffect(() => {
    subs.add(setItem)
    if (window.item) setItem(window.item)
    return () => { subs.delete(setItem) }
  }, [])
  return h(PinDialog, {
    item, pinSet: true, offline: false,
    onSubmit: (pin) => { window.calls.push(pin) },
    onCancel: () => {}, onHaltNew: () => Promise.resolve(), onSettings: () => {}, onRestore: () => {},
  })
}
render(h(App), document.getElementById('app'))
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let browser: Any
let page: Any
let script = ''

/** 壳排队的 PIN 请求：同 id，round / lockUntil / req.error 由各用例改。 */
const pinItem = (over: Any = {}) => ({
  id: 'pin-f8', title: '下单', from: '策略引擎', busy: false, round: 1, lockUntil: 0,
  req: { action: 'order.place', reason: '这一步需要你输入 PIN 确认', error: 'invalid PIN' },
  ...over,
})

const setItem = (next: Any) => page.evaluate((x: Any) => (window as Any).setItem(x), next)
const lockBar = () => page.locator('[data-pin-lock]')
const errRow = () => page.locator('.gr-pin__err')
const pinInput = () => page.locator('.gr-pin input[aria-label="PIN"]')

async function open() {
  const p = await browser.newPage()
  await p.setContent('<div id="app"></div>')
  await p.addScriptTag({ content: script })
  return p
}

// 错误行文案的来源：先钉住 pinErrorText 对 invalid PIN 的产出，浏览器用例里的「PIN 不对」就以它为准。
describe('PIN 错误行文案（pinErrorText）', () => {
  it('invalid PIN → 「PIN 不对」；试错过多 → 「试错次数过多」', () => {
    expect(pinErrorText('invalid PIN')).toBe('PIN 不对，请再输一次')
    expect(pinErrorText('too many failed attempts', 30_000)).toContain('试错次数过多')
  })
})

;(skip ? describe.skip : describe)('PIN 弹层 · 锁定期间不显示「PIN 不对」（浏览器）', () => {
  beforeAll(async () => {
    const out = await build({
      stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js' },
      bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
      jsx: 'automatic', jsxImportSource: 'preact', loader: { '.js': 'jsx' }, logLevel: 'silent',
      alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, // Radix 三件落到 preact/compat
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    script = out.outputFiles[0]!.text
    const { chromium } = createRequire(import.meta.url)(PW)
    browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  })
  afterAll(async () => { await browser?.close() })

  it('no wrong-pin text while locked', async () => {
    page = await open()
    try {
      await setItem(pinItem({ lockUntil: Date.now() + 30_000 }))
      const dlg = page.locator('.gr-pin')
      await dlg.waitFor({ state: 'visible', timeout: 10000 })
      await lockBar().waitFor({ state: 'visible', timeout: 10000 })
      expect(await lockBar().innerText()).toContain('已锁定')
      // 错误行不出现（error 还在 req 上，只是锁定期间不显示）
      expect(await errRow().count()).toBe(0)
      const text = await dlg.innerText()
      expect(text).not.toContain('PIN 不对')
      expect(text).not.toContain(pinErrorText('invalid PIN'))
      // 锁定中输入框禁用
      expect(await pinInput().isDisabled()).toBe(true)
    } finally { await page.close() }
  })

  it('lock clears error line', async () => {
    page = await open()
    try {
      // 未锁定 + 有错误：错误行可见
      await setItem(pinItem({ lockUntil: 0 }))
      await errRow().waitFor({ state: 'visible', timeout: 10000 })
      expect(await errRow().innerText()).toContain('PIN 不对')

      // 同一 round 转为已锁定：错误行消失，锁定条出现
      await setItem(pinItem({ lockUntil: Date.now() + 20_000 }))
      await lockBar().waitFor({ state: 'visible', timeout: 10000 })
      await errRow().waitFor({ state: 'hidden', timeout: 10000 })
      expect(await errRow().count()).toBe(0)

      // 锁定结束（lockUntil 在过去、round 不变）：错误行仍不出现
      await setItem(pinItem({ lockUntil: Date.now() - 5_000 }))
      await lockBar().waitFor({ state: 'hidden', timeout: 10000 })
      await page.waitForTimeout(1500)
      expect(await errRow().count()).toBe(0)
      expect(await page.locator('.gr-pin').innerText()).not.toContain('PIN 不对')

      // 下一次提交（round 变了）才把新的错误说出来
      await setItem(pinItem({ round: 2, lockUntil: 0 }))
      await errRow().waitFor({ state: 'visible', timeout: 10000 })
      expect(await errRow().innerText()).toContain('PIN 不对')
    } finally { await page.close() }
  })

  it('correct pin after lock ends submits', async () => {
    page = await open()
    try {
      await setItem(pinItem({ lockUntil: Date.now() + 20_000 }))
      await lockBar().waitFor({ state: 'visible', timeout: 10000 })
      expect(await pinInput().isDisabled()).toBe(true)

      await setItem(pinItem({ lockUntil: Date.now() - 5_000 }))
      await lockBar().waitFor({ state: 'hidden', timeout: 10000 })
      await pinInput().waitFor({ state: 'visible', timeout: 10000 })

      await pinInput().fill('246810')
      await pinInput().press('Enter')
      expect(await page.evaluate(() => (window as Any).calls)).toEqual(['246810'])
    } finally { await page.close() }
  })
})
