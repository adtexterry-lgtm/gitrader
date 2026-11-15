// SPDX-License-Identifier: CPAL-1.0
// UNIGIT 内嵌（R8，H v2）：用无头浏览器模拟宿主页面，把工作台放进 iframe。
//   宿主页 = 另一个本机源（http://127.0.0.1:<另一端口>），gitrader.json 的 embed.allowedOrigins 写它；
//   宿主拿启动链接的方式 = 读 `gitrader serve` 的 stdout（目前唯一的办法）。
//   node scripts/verify/embed.mjs   → reports/H-logs/v2/embed.json、reports/H-shots/EMB-*.png
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, chromium, EDGE, checker } from './stage-lib.mjs'

const CLI = join(root, 'packages', 'cli', 'dist', 'bin.js')
const SHOTS = join(root, 'reports', 'H-shots'); mkdirSync(SHOTS, { recursive: true })
const { results, check } = checker()
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hemb-'))
const home = join(tmp, 'home')
let serve, host, browser
const hostPage = (src) => `<!doctype html><meta charset="utf-8"><title>host</title><body style="margin:0;background:#111"><div style="display:flex;height:100vh"><div style="flex:1;color:#ccc;font:14px system-ui;padding:16px">宿主应用（模拟）</div><iframe id="gr" src="${src}" style="width:1100px;height:100vh;border:0"></iframe></div></body>`
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
try {
  let pageHtml = ''
  host = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHtml) })
  const hostPort = await listen(host)
  const hostOrigin = `http://127.0.0.1:${hostPort}`
  execFileSync(process.execPath, [CLI, 'init', '--home', home, '--no-pin'], { stdio: 'ignore', windowsHide: true })
  const cfgPath = join(home, 'gitrader.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); cfg.embed = { allowedOrigins: [hostOrigin] }; writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  serve = spawn(process.execPath, [CLI, 'serve', '--home', home, '--offline'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let out = ''; serve.stdout.on('data', (d) => { out += d })
  let launch = null
  for (let i = 0; i < 500 && !launch; i++) { launch = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?launch=\S+/)?.[0] ?? null; if (!launch) await new Promise((r) => setTimeout(r, 20)) }
  check('serve 打印一次性启动链接（宿主从 stdout 读）', !!launch)
  const base = launch.replace(/\/\?launch=.*$/, '')
  const head = await fetch(base + '/')
  const csp = head.headers.get('content-security-policy') ?? ''
  check('工作台响应头 frame-ancestors 只列配置的宿主源', csp.includes(`frame-ancestors ${hostOrigin}`), csp.match(/frame-ancestors[^;]*/)?.[0])
  browser = await chromium().launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  const errs = []
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  // (a) 带 launch 的 iframe
  pageHtml = hostPage(launch)
  await page.goto(hostOrigin + '/', { waitUntil: 'load' })
  const fr = await (await page.waitForSelector('#gr')).contentFrame()
  const online = await fr.waitForFunction(() => window.__GR_READY__?.online === true, null, { timeout: 12000 }).then(() => true, () => false)
  await page.waitForTimeout(800)
  const txt = await fr.evaluate(() => document.body.innerText).catch(() => '')
  check('(a) 宿主页 iframe 打开带 launch 的链接：换票成功，工作台连上内核', online && /持仓与盈亏/.test(txt), txt.slice(0, 120))
  await page.screenshot({ path: join(SHOTS, 'EMB-a-launch-in-iframe.png') })
  const noScroll = await fr.evaluate(() => ({ v: document.scrollingElement.scrollHeight - innerHeight, h: document.scrollingElement.scrollWidth - innerWidth }))
  check('(a) iframe 宽 1100 内无页面滚动', noScroll.v <= 1 && noScroll.h <= 1, JSON.stringify(noScroll))
  // (b) 现在配方里的 embed.url（不带 launch）
  pageHtml = hostPage(base + '/')
  await page.goto(hostOrigin + '/', { waitUntil: 'load' })
  const fr2 = await (await page.waitForSelector('#gr')).contentFrame()
  await page.waitForTimeout(2500)
  const t2 = await fr2.evaluate(() => document.body.innerText).catch(() => '')
  check('(b) 配方现在的 embed.url（不带 launch）：iframe 里是"会话已失效"卡，不是工作台', /会话已失效|gitrader open/.test(t2), t2.slice(0, 120))
  await page.screenshot({ path: join(SHOTS, 'EMB-b-recipe-url-no-launch.png') })
  // (c) 不在白名单的宿主源
  const evil = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHtml) })
  const evilPort = await listen(evil)
  const l2 = await new Promise((res) => { serve.stdin.write('\n'); const t = setInterval(() => { const all = [...out.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?launch=\S+/g)].map((m) => m[0]); if (all.length > 1) { clearInterval(t); res(all[all.length - 1]) } }, 20); setTimeout(() => { clearInterval(t); res(null) }, 3000) })
  pageHtml = hostPage(l2 ?? launch)
  const page3 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const blocked = []
  page3.on('console', (m) => blocked.push(m.text()))
  await page3.goto(`http://127.0.0.1:${evilPort}/`, { waitUntil: 'load' })
  await page3.waitForTimeout(2000)
  const fr3 = await (await page3.waitForSelector('#gr')).contentFrame()
  const t3 = await fr3?.evaluate(() => document.body?.innerText ?? '').catch(() => 'BLOCKED') ?? 'BLOCKED'
  check('(c) 不在 allowedOrigins 的宿主嵌不进来（frame-ancestors 拦截）', !/持仓与盈亏/.test(t3) && blocked.some((m) => /frame-ancestors|Refused to frame/i.test(m)), `${t3.slice(0, 60)} | ${blocked.find((m) => /frame/i.test(m))?.slice(0, 120)}`)
  await page3.screenshot({ path: join(SHOTS, 'EMB-c-other-origin-blocked.png') })
  evil.close()
  check('(a)(b) 控制台 0 错误', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  check('内嵌旅程异常', false, String(e?.stack ?? e).slice(0, 600))
} finally {
  try { await browser?.close() } catch { /* */ }
  if (serve && serve.exitCode === null) { serve.kill(); await new Promise((r) => serve.on('close', r)) }
  host?.close()
  rmSync(tmp, { recursive: true, force: true })
}
writeFileSync(join(root, 'reports', 'H-logs', 'v2', 'embed.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
process.exit(results.some((r) => !r.ok) ? 1 : 0)
