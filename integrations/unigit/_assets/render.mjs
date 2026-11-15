// 渲染 icon.png / cover.png（无头 Edge）。品牌原件只做组合缩放摆放，不改字形。
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.GITRADER_PLAYWRIGHT ?? 'playwright-core') // 开发机上的 playwright-core 目录用 GITRADER_PLAYWRIGHT 指定
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'official.gitrader')
const uri = (f) => 'data:image/svg+xml;base64,' + readFileSync(join(here, f)).toString('base64')
const jobs = [
  { file: "icon.html", png: "icon.png", w: 192, h: 192, transparent: true },
  { file: 'cover.html', png: 'cover.png', w: 1280, h: 720 },
]
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  for (const j of jobs) {
    const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: 1 })
    const html = readFileSync(join(here, j.file), 'utf8')
      .replaceAll('{{GLYPH}}', uri('g-glyph-128.svg'))
      .replaceAll('{{WORDMARK}}', uri('wordmark-b-white.svg'))
      .replaceAll('{{WORDMARK_RIM}}', uri('wordmark-b-rim.svg'))
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
    await page.screenshot({ path: join(out, j.png), clip: { x: 0, y: 0, width: j.w, height: j.h }, omitBackground: !!j.transparent })
    await page.close()
  }
} finally { await browser.close() }
