// SPDX-License-Identifier: CPAL-1.0
// 舞台冒烟：起真内核 + 夹具行情，打印状态与连接器情况，无头浏览器打开工作台看能否连上。
import { startStage, chromium, EDGE } from './stage-lib.mjs'
const s = await startStage({ keep: process.argv.includes('--keep') })
try {
  console.log('ready', s.port, s.pid, Math.round(s.readyMs) + 'ms')
  await new Promise((r) => setTimeout(r, 1500))
  console.log(JSON.stringify(await s.run(`const st = k.status(); return { state: st.tradingState, conns: st.connections, accounts: st.accounts, engines: st.engines, warnings: st.warnings, unhandled: [...ctx.unhandledInfo], pushes: ctx.wsPushes, instruments: k.bus.instruments().length }`), null, 1))
  const browser = await chromium().launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errs = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', (e) => errs.push('pageerror ' + e.message))
  await page.goto(s.url, { waitUntil: 'load' })
  await page.waitForTimeout(3000)
  console.log('ready flag', JSON.stringify(await page.evaluate(() => window.__GR_READY__ ?? null)))
  console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 1500))
  console.log('errors', errs)
  await browser.close()
} finally {
  await s.stop()
  console.log('stderr tail', s.stderr.slice(-1500))
  s.cleanup()
}
