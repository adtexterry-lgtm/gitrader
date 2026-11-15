// SPDX-License-Identifier: CPAL-1.0
// 状态条"重连"按钮 → 内核 venue.reconnect（命名对齐的端到端确认，H）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, startStage, bundleHost, chromium, EDGE } from './stage-lib.mjs'
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hrc-'))
const S = await startStage({ tmp: join(tmp, 'stage'), hostFile: await bundleHost(tmp), env: { GITRADER_STAGE_NO_ENGINE: '1' } })
let ok = false, detail = ''
try {
  await new Promise((r) => setTimeout(r, 1200))
  const browser = await chromium().launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  await page.goto(await S.boot(), { waitUntil: 'load' })
  await page.waitForFunction(() => window.__GR_READY__?.online === true, null, { timeout: 10000 })
  await page.waitForTimeout(800)
  const before = await S.run(`return ctx.wsSubs().length`)
  await page.click('[data-act="network"]')
  await page.waitForSelector('.gb-netcard', { timeout: 4000 })
  await page.click('.gb-netcard [data-act="reconnect"]')
  await page.waitForTimeout(1500)
  const text = await page.evaluate(() => document.body.innerText)
  await page.screenshot({ path: join(root, 'reports', 'H-shots', 'J7-1440-reconnect.png') })
  const conns = await S.run(`return k.connectionStatus()`)
  ok = errs.length === 0 && !/METHOD_NOT_FOUND|unknown method|失败/.test(text) && conns.some((c) => c.state === 'connected')
  detail = JSON.stringify({ errs, conns, before, toast: text.split('\n').filter((l) => /重连|连接/.test(l)).slice(0, 5) })
  await browser.close()
} catch (e) { detail = String(e?.stack ?? e).slice(0, 400) } finally { await S.stop(); rmSync(tmp, { recursive: true, force: true }) }
console.log(ok ? 'PASS' : 'FAIL', '状态条重连按钮 → venue.reconnect →连接恢复', detail.slice(0, 500))
process.exit(ok ? 0 : 1)
