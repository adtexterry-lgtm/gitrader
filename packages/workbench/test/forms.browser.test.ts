// SPDX-License-Identifier: CPAL-1.0
// 视觉轮 r4 · A2：输入件的 aria-label 落到原生 input 上（C1 的 input[aria-label="止损触发价"] 靠它）。
// workbench 的 vitest 是 node 环境、没有 JSX 转换：用 esbuild 把真组件打成一段脚本，放进无头 Edge 里渲染（同 blocks-default 的浏览器用例约定）。
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PW = process.env.GITRADER_PLAYWRIGHT ?? 'playwright-core'
const EDGE = process.env.GITRADER_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const skip = !(existsSync(EDGE) && existsSync(PW)) && process.env.GITRADER_SKIP_BROWSER === '1'
const forms = fileURLToPath(new URL('../src/ui/components/forms.jsx', import.meta.url))

const ENTRY = `
import { render, h } from 'preact'
import { useState } from 'preact/hooks'
import { NumberInput, TextInput } from ${JSON.stringify(forms)}
window.changes = []
function App() {
  const [v, setV] = useState(64000)
  return h('div', null,
    h(NumberInput, { size: 'sm', value: v, onChange: (n) => { window.changes.push(n); setV(n) }, 'aria-label': '止损触发价', 'data-probe': 'num', onInput: () => { window.badInput = true } }),
    h(TextInput, { size: 'sm', value: '', onChange: () => {}, 'aria-label': '备注' }))
}
render(h(App), document.getElementById('app'))
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let browser: Any
let script = ''

;(skip ? describe.skip : describe)('输入件 · aria-label 透传（浏览器）', () => {
  beforeAll(async () => {
    const out = await build({
      stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js' },
      bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
      jsx: 'automatic', jsxImportSource: 'preact', loader: { '.js': 'jsx' }, logLevel: 'silent',
    })
    script = out.outputFiles[0]!.text
    const { chromium } = createRequire(import.meta.url)(PW)
    browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  })
  afterAll(async () => { await browser?.close() })

  it('NumberInput：aria-label / data-* 落到原生 input；组件自己的 onInput 不被调用方覆盖', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<div id="app"></div>')
      await page.addScriptTag({ content: script })
      const el = page.locator('input[aria-label="止损触发价"]')
      expect(await el.count()).toBe(1)
      expect(await el.getAttribute('data-probe')).toBe('num')
      expect(await el.getAttribute('inputmode')).toBe('decimal')
      expect(await el.evaluate((n: Element) => n.closest('label')?.className)).toContain('gr-input--sm')
      await el.fill('63500')
      expect(await page.evaluate(() => (window as Any).changes.at(-1))).toBe(63500)
      expect(await page.evaluate(() => (window as Any).badInput ?? false)).toBe(false)
      expect(await page.locator('input[aria-label="备注"]').count()).toBe(1)
    } finally { await page.close() }
  })
})
