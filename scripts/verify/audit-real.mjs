// SPDX-License-Identifier: CPAL-1.0
// 视觉体检（workbench/design/audit-probe.js）对真内核跑一遍：已鉴权的页面里依次切路由求值探针（run-audit.mjs 只能对夹具内核用：真内核的引导令牌一次性）。
//   node scripts/verify/audit-real.mjs     → reports/H-logs/audit-real.json，任一页超限退出 1
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, startStage, bundleHost, chromium, EDGE } from './stage-lib.mjs'
const probe = readFileSync(join(root, 'packages', 'workbench', 'design', 'audit-probe.js'), 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-haudit-'))
const S = await startStage({ tmp: join(tmp, 'stage'), hostFile: await bundleHost(tmp), env: { GITRADER_ENGINE_CORE_BUNDLE: join(root, 'packages/engine-core/dist/engine-core.mjs') } })
const rows = []
let failed = 0
try {
  await new Promise((r) => setTimeout(r, 1200))
  const browser = await chromium().launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  for (const [w, h] of [[1440, 900], [1200, 800], [900, 900]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
    await page.goto(await S.boot(), { waitUntil: 'load' })
    await page.waitForFunction(() => window.__GR_READY__?.online === true, null, { timeout: 10000 })
    for (const r of ['', 'settings/connect', 'settings/keys', 'about']) {
      await page.evaluate((x) => { location.hash = '#/' + x }, r)
      await page.waitForTimeout(1500)
      const res = await page.evaluate(probe)
      const bad = Object.entries(res.pass ?? {}).filter(([, ok]) => !ok).map(([k]) => k)
      if (bad.length) failed += 1
      rows.push({ viewport: `${w}x${h}`, route: '#/' + r, bad, samples: Object.fromEntries(bad.map((k) => [k, res.samples?.[k] ?? res[k]])), metrics: Object.fromEntries(Object.entries(res).filter(([k, v]) => typeof v === 'number')) })
      console.log(`${w} #/${r}`.padEnd(28), bad.length ? '超限 ' + bad.join(',') : '通过')
    }
    await page.close()
  }
  await browser.close()
} finally { await S.stop(); rmSync(tmp, { recursive: true, force: true }) }
writeFileSync(join(root, 'reports', 'H-logs', 'audit-real.json'), JSON.stringify({ at: new Date().toISOString(), failed, rows }, null, 2))
process.exit(failed ? 1 : 0)
