// SPDX-License-Identifier: CPAL-1.0
// M1 十四条验收的集成旅程（H）。真内核 + 真工作台 + 真 CLI 单文件 + 真 MCP 单文件；行情走夹具（不联网）；无头 Edge（不弹窗）。
//
//   node scripts/verify/journeys.mjs [--keep] [--only J1,J3]
//
// 环境：GITRADER_PLAYWRIGHT = playwright-core 目录（开发机上的，不进产品包）；GITRADER_EDGE 可覆盖 Edge 路径。
// 产物：reports/H-shots/*.png、reports/H-logs/journeys.json。只结束自己起的进程（按句柄）。
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { root, startStage, bundleHost, chromium, EDGE, RESERVED, checker, BANNED } from './stage-lib.mjs'

const keep = process.argv.includes('--keep')
const onlyArg = process.argv.find((a) => a.startsWith('--only'))
const only = onlyArg ? new Set((onlyArg.split('=')[1] ?? process.argv[process.argv.indexOf(onlyArg) + 1] ?? '').split(',')) : null
const want = (j) => !only || only.has(j)
const SHOTS = only?.size === 1 && only.has('J15') ? join(root, 'reports', 's1-trust-fix', 'j15-shots') : join(root, 'reports', 'H-shots')
const LOGS = only?.size === 1 && only.has('J15') ? join(root, 'reports', 's1-trust-fix', 'j15-logs') : join(root, 'reports', 'H-logs')
mkdirSync(SHOTS, { recursive: true }); mkdirSync(LOGS, { recursive: true })
// 旧 J1–J15 都是 r4 界面的旅程：显式带 ui=r4，缺省翻成 r5 以后它们保持原样（壳的 ui 参数只在加载时生效、不写偏好）。
const r4Url = (u) => { const x = new URL(u); x.searchParams.set('ui', 'r4'); return x.href }
const CLI = join(root, 'packages', 'cli', 'dist', 'bin.js')
let CLI_BIN = CLI // J1 装好 tarball 后改指安装出来的那份
const PIN = '482913'
const BTC = 'hyperliquid:BTC'
const { results, check } = checker()
const metrics = {}
const notes = []
const note = (s) => { notes.push(s); console.log('NOTE  ' + s) }
const ENGINE_ENV = { GITRADER_ENGINE_CORE_BUNDLE: join(root, 'packages', 'engine-core', 'dist', 'engine-core.mjs') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 10000, step = 100) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step) } }
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hj-'))
const mine = [] // 自己起的子进程

/** 跑真 CLI 单文件（async，不堵本进程的事件循环）。stdin 可喂 PIN（非终端时 CLI 从 stdin 读一行）。 */
function cli(args, o = {}) {
  return new Promise((res) => {
    const t0 = performance.now()
    const p = spawn(process.execPath, [CLI_BIN, ...args], { env: { ...process.env, ...(o.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
    // 多行输入逐行喂（CLI 每次读密码只取一行，同一块里的第二行会被丢掉——见报告 P3）
    if (Array.isArray(o.stdin)) { (async () => { for (const line of o.stdin) { await sleep(700); p.stdin.write(line) } p.stdin.end() })() }
    else { if (o.stdin !== undefined) p.stdin.write(o.stdin); p.stdin.end() }
    const timer = setTimeout(() => { p.kill() }, o.timeout ?? 30000)
    p.on('close', (code) => { clearTimeout(timer); res({ code, out, err, ms: performance.now() - t0 }) })
  })
}

/** 从 `gitrader mcp snippet claude-code` 的输出里取启动参数（JSON 段），按宿主的方式拉起 MCP。 */
async function mcpFromSnippet(home, token, extraEnv = {}) {
  const r = await cli(['mcp', 'snippet', 'claude-code', '--home', home])
  const json = r.out.slice(r.out.search(/^{/m), r.out.lastIndexOf('}') + 1)
  const cfg = JSON.parse(json).mcpServers.gitrader
  const env = { ...cfg.env, GITRADER_AGENT_TOKEN: token, ...extraEnv }
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...env, SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, stderr: 'pipe' })
  const client = new Client({ name: 'h-verify-host', version: '0' }, { capabilities: {} })
  const state = { changed: 0, stderr: '' }
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { state.changed += 1 })
  await client.connect(transport)
  transport.stderr?.on('data', (d) => { state.stderr += d.toString() })
  return { client, state, cfg }
}
const txt = (r) => { try { return JSON.parse(r.content[0].text) } catch { return r.content?.[0]?.text } }
const call = async (m, name, args) => { const t0 = performance.now(); const r = await m.client.callTool({ name, arguments: args }); return { r, data: txt(r), isError: r.isError === true, ms: performance.now() - t0 } }

/** CLI 创建 Agent 钥匙（服务在跑时也用离线命令——这正是真实用户的做法），返回令牌。 */
async function newAgentKey(home, name, host, tier, extra = []) {
  const r = await cli(['keys', 'new', 'agent', name, '--host', host, '--tier', tier, '--home', home, ...extra], { stdin: PIN + '\n', env: { GITRADER_PIN_STDIN: '1' } })
  const m = /\n\s+(gtk_\S+)\n/.exec(r.out)
  return { ...r, token: m?.[1] }
}

let browser = null
const consoleErrors = []
async function newPage(w, h, tag) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror ${e.message}`))
  return { ctx, page }
}
async function openWorkbench(stage, w = 1440, h = 900, tag = 'wb') {
  const { ctx, page } = await newPage(w, h, tag)
  await page.goto(r4Url(await stage.boot()), { waitUntil: 'load' })
  await page.waitForFunction(() => window.__GR_READY__ && window.__GR_READY__.online === true, null, { timeout: 10000 })
  await page.waitForSelector('.gb-pos, .gb-agent, .gb-risk', { timeout: 10000 })
  // 视觉 r4：卡入场 320 ms + 错开 40 ms。固定 600 ms 改为等待批 / 活动两张卡可见，再等五张卡自己的入场动画放完（之后才点）
  await page.waitForSelector('[data-card="pending"]', { state: 'visible', timeout: 10000 })
  await page.waitForSelector('[data-card="feed"]', { state: 'visible', timeout: 10000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.gr-tile-p[data-card]')].every((c) => c.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle')), null, { timeout: 5000 })
  return { ctx, page }
}
const noScroll = (page) => page.evaluate(() => { const se = document.scrollingElement; return { v: se.scrollHeight - innerHeight, h: se.scrollWidth - innerWidth } })
const bodyText = (page) => page.evaluate(() => document.body.innerText)
async function pinLayer(page, pin = PIN) { await page.waitForSelector('.gr-pin', { timeout: 6000 }); await page.fill('.gr-pin input', pin); await page.click('.gr-pin .gr-btn--primary') }
const shot = async (page, name) => { const p = join(SHOTS, name); await page.screenshot({ path: p }); return p }

// ================================================================== J1 装与起（v2：从 npm tarball 安装后用 npx gitrader；不在仓库里跑）
async function J1() {
  const home = join(tmp, 'j1-home')
  // npm pack 出 tarball → 干净目录 npm install <tgz> → 后续 CLI 全部走安装出来的 node_modules/.bin（等同 npx gitrader）
  const packDir = join(tmp, 'pack'); mkdirSync(packDir, { recursive: true })
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const sh = (cmd, args, cwd, env = {}) => new Promise((res) => { const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32', windowsHide: true }); let o = ''; p.stdout.on('data', (d) => { o += d }); p.stderr.on('data', (d) => { o += d }); p.on('close', (code) => res({ code, o })) })
  const pk = await sh(npmCmd, ['pack', '-w', 'packages/cli', '--pack-destination', packDir], root)
  const tgz = readdirSync(packDir).find((x) => x.endsWith('.tgz'))
  metrics.tarball = tgz ? { name: tgz, kb: Math.round(statSync(join(packDir, tgz)).size / 1024) } : null
  check('J1 `npm pack -w packages/cli` 出 tarball', pk.code === 0 && !!tgz, pk.o.slice(-300))
  const inst = join(tmp, 'clean-install'); mkdirSync(inst, { recursive: true }); writeFileSync(join(inst, 'package.json'), '{"name":"try-gitrader","private":true}')
  const t0i = performance.now()
  const ni = await sh(npmCmd, ['install', '--no-audit', '--no-fund', join(packDir, tgz ?? 'missing.tgz')], inst)
  metrics.tarballInstallMs = Math.round(performance.now() - t0i)
  const installedBin = join(inst, 'node_modules', 'gitrader', 'dist', 'bin.js')
  const deps = existsSync(join(inst, 'node_modules')) ? readdirSync(join(inst, 'node_modules')).filter((x) => !x.startsWith('.')) : []
  check('J1 干净目录 npm install <tarball>：只装 gitrader 一个包（单文件，无运行时依赖）', ni.code === 0 && existsSync(installedBin), `${ni.o.slice(-200)} deps=${deps.join(',')}`)
  metrics.tarballDeps = deps
  const nx = await sh(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'gitrader', 'help'], inst)
  check('J1 `npx gitrader` 在安装目录可执行', /gitrader init/.test(nx.o), nx.o.slice(0, 200))
  CLI_BIN = installedBin
  const ri = await cli(['init', '--home', home], { stdin: [PIN + '\n', PIN + '\n'], env: { GITRADER_PIN_STDIN: '1' } })
  const dirs = ['plugins', 'engines', 'workspaces', 'lab'].map((d) => existsSync(join(home, d)))
  check('J1 init：生成 gitrader.json 与四个目录', ri.code === 0 && existsSync(join(home, 'gitrader.json')) && dirs.every(Boolean), ri.out + ri.err)
  check('J1 init：PIN 在终端设置（不走 argv）', /PIN set/.test(ri.out), ri.out.slice(0, 300))
  const cfg = JSON.parse(readFileSync(join(home, 'gitrader.json'), 'utf8'))
  check('J1 默认：纸面账户、测试网、支持开发者默认关', cfg.accounts?.[0]?.mode === 'paper' && cfg.venues?.[0]?.environment === 'testnet' && cfg.supportDeveloper === false, JSON.stringify({ a: cfg.accounts, v: cfg.venues, s: cfg.supportDeveloper }))
  const ri2 = await cli(['init', '--home', home, '--no-pin'])
  check('J1 init 再跑一次幂等', ri2.code === 0 && /Already initialized/.test(ri2.out), ri2.out)

  // serve（离线：不连真数据）——冷启：首次 serve；热启：第二次
  for (const run of ['cold', 'warm']) {
    const t0 = performance.now()
    const p = spawn(process.execPath, [CLI_BIN, 'serve', '--home', home, '--offline'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    mine.push(p)
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
    const url = await until(() => /\/\?launch=boot_\S+/.exec(out)?.[0] && out.match(/http:\/\/127\.0\.0\.1:\d+\/\?launch=\S+/)?.[0], 20000, 20)
    const tUrl = performance.now() - t0
    const port = Number(/:(\d+)\//.exec(url ?? '')?.[1])
    const health = await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok } catch { return false } }, 5000, 20)
    const tHealth = performance.now() - t0
    metrics[`serve_${run}_ms`] = { url: Math.round(tUrl), health: Math.round(tHealth) }
    check(`J1 serve（${run}）：打印一次性链接、端口不占保留端口、/api/health 200`, !!url && port >= 47900 && !RESERVED.includes(port) && health, `port ${port} url ${tUrl.toFixed(0)} ms health ${tHealth.toFixed(0)} ms ${err.slice(-300)}`)
    if (run === 'cold') {
      // 页面：带 launch 的有引导 meta；不带的没有
      const withL = await (await fetch(url)).text()
      const without = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      check('J1 页面：带 launch 才注入引导令牌；直接访问拿不到', /gitrader-bootstrap/.test(withL) && !/gitrader-bootstrap/.test(without))
      const st = await cli(['status', '--json', '--home', home])
      let sj = {}; try { sj = JSON.parse(st.out) } catch { /* */ }
      check('J1 status：运行中、ACTIVE、账本有条目', st.code === 0 && sj.running === true && sj.tradingState === 'ACTIVE', st.out.slice(0, 300) + st.err.slice(0, 200))
      // 服务在跑时用 CLI 建一把 Agent 钥匙（两个进程同时写同一账本）
      const before = await cli(['ledger', 'verify', '--json', '--home', home])
      const kk = await newAgentKey(home, 'j1-agent', 'claude-code', 'paper')
      check('J1 服务在跑时 `keys new agent` 成功出令牌', kk.code === 0 && /^gtk_/.test(kk.token ?? ''), kk.out.slice(0, 200) + kk.err.slice(0, 300))
      // 服务进程随后再写账本（PIN 打开链接会写 session 相关条目？用 open --print 触发一次人面操作）
      const op = await cli(['open', '--print', '--home', home], { stdin: PIN + '\n' })
      check('J1 `gitrader open --print`（PIN）给出新的一次性链接', op.code === 0 && /launch=/.test(op.out), op.out + op.err)
      if (op.code === 0) { const html = await (await fetch(op.out.trim())).text(); check('J1 open --print 的链接注入引导令牌', /gitrader-bootstrap/.test(html)) }
      const after = await cli(['ledger', 'verify', '--json', '--home', home])
      let bj = {}, aj = {}; try { bj = JSON.parse(before.out); aj = JSON.parse(after.out) } catch { /* */ }
      check('J1 两个进程交替写账本后哈希链仍完整', aj.ok === true, `before ${before.out.trim()} after ${after.out.trim()} ${after.err.slice(0, 200)}`)
      // service.json 权限
      const sp = join(home, 'service.json')
      const acl = await new Promise((res) => { const q = spawn('icacls', [sp], { windowsHide: true }); let o = ''; q.stdout.on('data', (d) => { o += d }); q.on('close', () => res(o)) })
      metrics.serviceJsonAcl = acl.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6)
      const aclLines = acl.split('\n').slice(0, -2).join('\n')
      check('J1 service.json 只有当前用户可读（icacls 无 Everyone / Users / Authenticated Users）', existsSync(sp) && !/Everyone|BUILTIN\\Users|Authenticated Users/i.test(aclLines), acl.slice(0, 400))
      void bj
    }
    p.kill(); await new Promise((r) => p.on('close', r))
    await sleep(300)
  }
  const lv = await cli(['ledger', 'verify', '--home', home])
  check('J1 停服后 `ledger verify` 通过', lv.code === 0 && /Ledger OK/.test(lv.out), lv.out + lv.err)
  const cliPj = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8'))
  check('J1 可发布包：名为 gitrader、非 private、带 bin 与 files 白名单', cliPj.name === 'gitrader' && !cliPj.private && cliPj.bin?.gitrader && Array.isArray(cliPj.files), JSON.stringify({ name: cliPj.name, private: cliPj.private, files: cliPj.files }))
  // 安装版的 serve 用自带的工作台与引擎（不靠仓库路径）
  const pj2 = await new Promise((res) => { const p = spawn(process.execPath, [CLI_BIN, 'serve', '--home', join(tmp, 'j1-home-2'), '--offline'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); mine.push(p); let o = ''; p.stdout.on('data', (d) => { o += d }); const t = setInterval(() => { const u = o.match(/http:\/\/127\.0\.0\.1:\d+\/\?launch=\S+/)?.[0]; if (u) { clearInterval(t); res({ p, u }) } }, 20); setTimeout(() => { clearInterval(t); res({ p, u: null }) }, 20000) })
  if (pj2.u) {
    const html = await (await fetch(pj2.u)).text()
    check('J1 安装版 serve 自带工作台（页面不是占位页）', /app\.js/.test(html) && /gitrader-bootstrap/.test(html), html.slice(0, 200))
  } else check('J1 安装版 serve 起来', false)
  pj2.p.kill(); await new Promise((r) => pj2.p.on('close', r))
}

// ================================================================== 舞台：真内核 + 夹具行情 + 工作台
let S = null
let tokens = {}
let mcps = {}
async function setupStage() {
  S = await startStage({ keep, tmp: join(tmp, 'stage'), hostFile: await bundleHost(tmp), env: ENGINE_ENV })
  metrics.stageReadyMs = Math.round(S.readyMs)
  await sleep(1200)
  browser = await chromium().launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
}

async function J7a_and_pin() {
  // 首次打开：三档截图、无滚动、禁词、控制台
  for (const [w, h] of [[1440, 900], [1200, 800], [900, 900]]) {
    const { ctx, page } = await openWorkbench(S, w, h, `first-${w}`)
    const s = await noScroll(page)
    check(`J7 ${w}×${h} 工作台：无页面滚动 / 横向溢出`, s.v <= 1 && s.h <= 1, JSON.stringify(s))
    const t = await bodyText(page)
    check(`J12 ${w} 工作台：无禁词`, !BANNED.test(t), (t.match(BANNED) ?? [''])[0])
    if (/标准/.test(t)) note(`${w} 工作台文案里出现"标准"：${t.slice(Math.max(0, t.indexOf('标准') - 20), t.indexOf('标准') + 20)}`)
    await shot(page, `J7-${w}-first-open.png`)
    for (const [name, hash] of [['settings-connect', '#/settings/connect'], ['settings-keys', '#/settings/keys'], ['about', '#/about']]) {
      await page.evaluate((x) => { location.hash = x }, hash); await page.waitForTimeout(400)
      const s2 = await noScroll(page)
      check(`J7 ${w} ${name}：无页面滚动`, s2.v <= 1 && s2.h <= 1, JSON.stringify(s2))
      const t2 = await bodyText(page)
      check(`J12 ${w} ${name}：无禁词`, !BANNED.test(t2), (t2.match(BANNED) ?? [''])[0])
      await shot(page, `J7-${w}-${name}.png`)
      if (name === 'about' && w === 1440) {
        await page.click('[data-act="notices"]').catch(() => undefined); await page.waitForTimeout(400)
        const t3 = await bodyText(page)
        check('J12 关于页：KLineChart（含 TradingView 署名）可见', /KLineChart/.test(t3) && /TradingView/.test(t3), t3.slice(0, 300))
        await shot(page, 'J12-1440-about-notices.png')
      }
    }
    await ctx.close()
  }
  // 设置 PIN（人面，工作台）
  const { ctx, page } = await openWorkbench(S, 1440, 900, 'pin')
  await page.evaluate(() => { location.hash = '#/settings/keys' }); await page.waitForSelector('[data-act="pin-open"]')
  await page.click('[data-act="pin-open"]')
  await page.fill('input[aria-label="新 PIN"]', PIN); await page.fill('input[aria-label="再输一次 PIN"]', PIN)
  await page.click('[data-act="pin-save"]')
  const ok = await until(async () => /已设置/.test(await bodyText(page)), 5000)
  check('J9 工作台设置 PIN，内核记为已设置', ok && (await S.run('return k.pin.isSet()')) === true)
  await shot(page, 'J9-1440-pin-set.png')
  await ctx.close()
}

async function J2() {
  // 两把钥匙：纸面（Claude Code）与需确认（Codex），用 CLI 建（服务在跑）
  const a = await newAgentKey(S.home, 'claude-paper', 'claude-code', 'paper')
  const b = await newAgentKey(S.home, 'codex-confirm', 'codex', 'confirm', ['--max-order', '500', '--max-daily', '2000', '--venues', 'hyperliquid', '--instruments', BTC])
  const c = await newAgentKey(S.home, 'hermes-ro', 'hermes', 'read_only')
  check('J2 CLI 建三把钥匙（纸面 / 需确认 / 只读）', !!a.token && !!b.token && !!c.token, [a, b, c].map((x) => x.code + ' ' + x.err.slice(0, 200)).join(' | '))
  tokens = { paper: a.token, confirm: b.token, ro: c.token }
  // 四个宿主片段都能出、可解析、不含令牌
  for (const host of ['claude-code', 'codex', 'hermes', 'unigit']) {
    const r = await cli(['mcp', 'snippet', host, '--home', S.home])
    let parsed = false
    try {
      if (host === 'claude-code') parsed = !!JSON.parse(r.out.slice(r.out.search(/^{/m), r.out.lastIndexOf('}') + 1)).mcpServers.gitrader
      else if (host === 'codex') parsed = /\[mcp_servers\.gitrader\]/.test(r.out) && /command = '/.test(r.out)
      else if (host === 'hermes') parsed = /mcp_servers:\s*\n\s+gitrader:/.test(r.out)
      else parsed = /- insert:/.test(r.out) && /GITRADER_AGENT_TOKEN_FILE/.test(r.out)
    } catch { parsed = false }
    check(`J2 片段 ${host}：可粘贴、不含任何令牌`, r.code === 0 && parsed && !/gtk_[A-Z2-7]{10,}|svc_|ses_/.test(r.out), r.out.slice(0, 200))
  }
  // 按 Claude Code 片段拉起真 MCP 单文件
  mcps.paper = await mcpFromSnippet(S.home, tokens.paper)
  mcps.confirm = await mcpFromSnippet(S.home, tokens.confirm)
  mcps.ro = await mcpFromSnippet(S.home, tokens.ro)
  const names = (await mcps.paper.client.listTools()).tools.map((t) => t.name)
  const roNames = (await mcps.ro.client.listTools()).tools.map((t) => t.name)
  check('J2 纸面钥匙 16 个工具、只读钥匙 13 个；无批准 / 放宽 / 恢复类', names.length === 16 && roNames.length === 13 && !names.some((n) => /approve|relax|resume/.test(n)), `${names.length}: ${names.join(',')} | ro ${roNames.length}`)
  // 打开布局开关后 +1 = 17
  const { ctx, page } = await openWorkbench(S, 1440, 900, 'layout')
  await S.run(`return k.settings.setAgentLayout(true)`)
  await ctx.close()
  const after = await mcps.paper.client.callTool({ name: 'discover', arguments: { action: 'capabilities' } })
  await sleep(300)
  const n17 = (await mcps.paper.client.listTools()).tools.length
  check('J2 人打开"允许 Agent 调整布局"后工具数 17（tools/list_changed）', n17 === 17, `got ${n17}, changed=${mcps.paper.state.changed} ${JSON.stringify(txt(after)).slice(0, 120)}`)
  await S.run(`return k.settings.setAgentLayout(false)`)
  const chk = await new Promise((res) => { const p = spawn(mcps.paper.cfg.command, [...mcps.paper.cfg.args, '--check'], { env: { ...process.env, GITRADER_HOME: S.home, GITRADER_AGENT_TOKEN: tokens.paper }, windowsHide: true }); let o = ''; p.stdout.on('data', (d) => { o += d }); p.stderr.on('data', (d) => { o += d }); p.on('close', (code) => res({ code, o })) })
  check('J2 `gitrader-mcp --check` 连上并报出级别与工具数', chk.code === 0 && /L1|paper/i.test(chk.o), chk.o.slice(0, 300))
}

async function J3() {
  const paperAcct = await S.run(`return k.accounts.list().find((a) => a.mode === 'paper').accountId`)
  const { ctx, page } = await openWorkbench(S, 1440, 900, 'j3')
  // 在检阅块里埋一个观察器：记下理由文字出现的时刻（Date.now）
  const reason = `H-J3 paper entry ${Date.now()}`
  await page.evaluate((needle) => {
    window.__seen = null
    const root = document.querySelector('.gb-agent[data-view="feed"]') ?? document.body // r4：活动是 Agent 块的 feed 视图实例
    const mo = new MutationObserver(() => { if (window.__seen === null && root.innerText.includes(needle)) { window.__seen = Date.now(); mo.disconnect() } })
    mo.observe(root, { subtree: true, childList: true, characterData: true })
  }, '买入 0.002 BTC') // 视觉 r2：理由折进条目点开才显示（PLAN ⑪），观察器改盯条目可见的动作文字
  const t0 = Date.now()
  const placed = await call(mcps.paper, 'order', { action: 'place', intent: { accountId: paperAcct, instrumentId: BTC, side: 'buy', type: 'market', size: '0.002', leverage: 2, reason } })
  const tRet = Date.now()
  const seen = await until(() => page.evaluate(() => window.__seen), 5000, 10)
  const o = placed.data?.order
  check('J3 Agent 经 MCP 纸面市价单 → 成交', o?.status === 'filled', JSON.stringify(placed.data).slice(0, 300))
  check('J3 订单 origin：llm-agent / via mcp / 内核盖章', o?.origin?.actorType === 'llm-agent' && o?.origin?.via === 'mcp' && /^agent:/.test(o?.origin?.actor ?? ''), JSON.stringify(o?.origin))
  const rows = await S.run(`return k.ledger.query({ limit: 50 }).filter((e) => e.origin?.requestId === ${JSON.stringify(o?.origin?.requestId ?? '')}).map((e) => ({ type: e.type, ts: e.ts, verdict: e.precheck?.verdict, actorType: e.origin.actorType }))`)
  const intent = rows.find((r) => r.type === 'order.intent')
  check('J3 账本：order.intent 带预检结论与 origin，先于成交', !!intent && intent.verdict && rows.some((r) => r.type === 'fill' || r.type === 'order.accepted'), JSON.stringify(rows))
  const lat = seen ? seen - tRet : null
  const latFromCall = seen ? seen - t0 : null
  const latFromLedger = seen && intent ? seen - intent.ts : null
  metrics.j3_activity_visible_ms = { afterMcpReturn: lat, fromMcpCall: latFromCall, fromLedgerIntent: latFromLedger, mcpRoundTripMs: Math.round(placed.ms) }
  check('J3 Agent 活动块在 150 ms 内看到（从 MCP 返回算）', lat !== null && lat <= 150, `MCP 返回后 ${lat} ms；从发起 ${latFromCall} ms；从账本 order.intent ${latFromLedger} ms；MCP 往返 ${placed.ms.toFixed(0)} ms`)
  await page.waitForTimeout(800)
  await shot(page, 'J3-1440-paper-fill-activity.png')
  const posText = await page.evaluate(() => document.querySelector('.gb-pos')?.innerText ?? '')
  check('J3 持仓块出现 BTC 多头', /BTC/.test(posText), posText.slice(0, 200))
  await ctx.close()
}

async function J5() {
  const paperAcct = await S.run(`return k.accounts.list().find((a) => a.mode === 'paper').accountId`)
  const place = (intent) => call(mcps.paper, 'order', { action: 'place', intent: { accountId: paperAcct, instrumentId: BTC, type: 'market', ...intent } })
  const codes = (r) => (r.data?.error?.ruleHits ?? r.data?.order?.precheck?.ruleHits ?? r.data?.precheck?.ruleHits ?? r.data?.error?.data?.ruleHits ?? []).map((h) => h.code)
  const rawCodes = (r) => JSON.stringify(r.data).match(/"code":"[A-Z_]+"/g) ?? []
  const big = await place({ side: 'buy', size: '0.05', leverage: 2, reason: 'H-J5 single order over limit' }) // ~4000 名义 > 2000
  check('J5 单笔上限：超限被拒，返回规则名 ORDER_NOTIONAL', big.isError || big.data?.order?.status === 'rejected' || big.data?.order?.status === 'denied', JSON.stringify(big.data).slice(0, 300))
  check('J5 单笔上限：规则名可见', rawCodes(big).some((c) => /ORDER_NOTIONAL/.test(c)), rawCodes(big).join(','))
  const lev = await place({ side: 'buy', size: '0.002', leverage: 10, reason: 'H-J5 leverage over limit' })
  check('J5 杠杆上限：10× 被拒（LEVERAGE）', rawCodes(lev).some((c) => /LEVERAGE/.test(c)), JSON.stringify(lev.data).slice(0, 300))
  const wl = await call(mcps.paper, 'order', { action: 'place', intent: { accountId: paperAcct, instrumentId: 'hyperliquid:ETH', type: 'market', side: 'buy', size: '0.01', leverage: 2, reason: 'H-J5 instrument whitelist' } })
  note(`J5 白名单（纸面钥匙无标的白名单；ETH 单）：${JSON.stringify(wl.data).slice(0, 200)}`)
  // 需确认钥匙限定 BTC：ETH 提案应被白名单挡
  const wl2 = await call(mcps.confirm, 'propose', { action: 'order', accountId: paperAcct, intents: [{ instrumentId: 'hyperliquid:ETH', side: 'buy', type: 'market', size: '0.01', leverage: 2 }], reason: 'H-J5 whitelist via mandate' })
  check('J5 授权书标的白名单：BTC-only 钥匙的 ETH 单被拒（INSTRUMENT_NOT_ALLOWED）', rawCodes(wl2).some((c) => /INSTRUMENT_NOT_ALLOWED/.test(c)) || /INSTRUMENT_NOT_ALLOWED|not allowed/i.test(JSON.stringify(wl2.data)), JSON.stringify(wl2.data).slice(0, 300))
  // 冷却保护器：刚成交过，5 秒内再开仓
  const cd = await place({ side: 'buy', size: '0.002', leverage: 2, reason: 'H-J5 cooldown' })
  note(`J5 冷却（紧接上一笔）：${rawCodes(cd).join(',') || JSON.stringify(cd.data?.order?.status)}`)
  // 风控状态在 risk.state 里有 usage
  const rs = await S.run(`return (await k.ops.call(k, 'risk.state', { principal: { kind: 'service' }, params: {}, transport: 'ws', kind: 'query' }))`).catch((e) => ({ error: String(e) }))
  check('J5 risk.state 带 usage[]（protocol v0.1.6）', Array.isArray(rs?.usage) && rs.usage.length > 0, JSON.stringify(rs).slice(0, 300))

  // 接管三档（工作台风险块，人面）
  const { ctx, page } = await openWorkbench(S, 1440, 900, 'j5')
  // r4：兜底路径的接管卡改为向下展开（200 ms），等卡可见、动画放完再点
  await page.click('.gb-risk [data-act="takeover-halt_new"]').catch(async () => { await page.click('[data-act="takeover"]'); await page.waitForSelector('.gb-tkcard', { state: 'visible', timeout: 3000 }); await page.waitForTimeout(250); await page.click('.gb-tkcard [data-act="takeover-halt_new"]') })
  await page.waitForSelector('[data-act="takeover-halt_new-confirm"]', { timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(700) // 视觉 r2 G2：武装后 600 ms 死区内的确认被忽略
  await page.click('[data-act="takeover-halt_new-confirm"]').catch(() => undefined)
  await page.waitForTimeout(400)
  if (await page.$('.gr-pin')) await pinLayer(page)
  const reducing = await until(() => page.evaluate(() => document.querySelector('.gb-risk')?.getAttribute('data-state')), 5000)
  check('J5 停止新开仓 → 三态显示 REDUCING', reducing === 'REDUCING', `data-state=${reducing}`)
  await shot(page, 'J5-1440-reducing.png')
  const denied = await place({ side: 'buy', size: '0.002', leverage: 2, reason: 'H-J5 entry while reducing' })
  check('J5 REDUCING 时 Agent 开仓被拒（TRADING_STATE）', rawCodes(denied).some((c) => /TRADING_STATE/.test(c)) || /TRADING_STATE|REDUCING/.test(JSON.stringify(denied.data)), JSON.stringify(denied.data).slice(0, 300))
  const reduce = await call(mcps.paper, 'order', { action: 'close', accountId: paperAcct, instrumentId: BTC, reason: 'H-J5 reduce while reducing' })
  check('J5 REDUCING 时仍可平仓（减仓放行）', !reduce.isError, JSON.stringify(reduce.data).slice(0, 300))
  // 恢复（PIN）
  const resumeBtn = await page.$('[data-act="resume"]')
  if (resumeBtn) { await resumeBtn.click(); await page.waitForSelector('[data-act="resume-confirm"]', { timeout: 3000 }).catch(() => undefined); await page.waitForTimeout(700); await page.click('[data-act="resume-confirm"]').catch(() => undefined); await pinLayer(page) }
  else note('J5 风险块没有 data-act="resume" 按钮，改走 ⌘K')
  const active = await until(() => page.evaluate(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'ACTIVE'), 5000)
  check('J5 恢复交易要 PIN，恢复后 ACTIVE', !!active, await page.evaluate(() => document.querySelector('.gb-risk')?.getAttribute('data-state')))
  // 杀开关（全平 = flatten_all，PIN）→ HALTED
  await sleep(5500) // 夹具策略：开仓后冷却 5 s（上一步刚减仓），否则这单被 COOLDOWN 拒、全平无仓可平
  const preFlat = await call(mcps.paper, 'order', { action: 'place', intent: { accountId: paperAcct, instrumentId: BTC, type: 'market', side: 'buy', size: '0.002', leverage: 2, reason: 'H-J5 open before flatten' } })
  note('J5 全平前开仓：' + JSON.stringify({ status: preFlat.data?.order?.status, problem: preFlat.data?.order?.problem?.code }))
  await page.keyboard.press('Control+K'); await page.waitForSelector('.gr-palette')
  await page.fill('.gr-palette__in input', '全平'); await page.waitForTimeout(200); await page.keyboard.press('Enter')
  await page.waitForSelector('.gr-palette__item.is-armed', { timeout: 3000 }).catch(() => undefined); await page.waitForTimeout(700) /* G2 死区 */; await page.keyboard.press('Enter')
  await pinLayer(page).catch(() => undefined)
  const halted = await until(() => page.evaluate(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'HALTED'), 6000)
  check('J5 ⌘K 全部平仓（二次确认 + PIN）→ HALTED', !!halted, await page.evaluate(() => document.querySelector('.gb-risk')?.getAttribute('data-state')))
  await page.waitForTimeout(800)
  const pos = await S.run(`const a = k.accounts.list().find((x) => x.mode === 'paper'); return (await k.bus.snapshot(a)).positions.length`)
  check('J5 全平后纸面持仓为 0', pos === 0, `positions ${pos}`)
  await shot(page, 'J5-1440-halted-after-flatten.png')
  const deniedH = await place({ side: 'buy', size: '0.002', leverage: 2, reason: 'H-J5 entry while halted' })
  check('J5 HALTED 时开仓被拒', deniedH.isError || /TRADING_STATE|HALTED/.test(JSON.stringify(deniedH.data)), JSON.stringify(deniedH.data).slice(0, 200))
  // 恢复
  await page.click('[data-act="resume"]').catch(() => undefined); await page.waitForSelector('[data-act="resume-confirm"]', { timeout: 3000 }).catch(() => undefined); await page.waitForTimeout(700); await page.click('[data-act="resume-confirm"]').catch(() => undefined); await pinLayer(page).catch(() => undefined)
  await until(() => page.evaluate(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'ACTIVE'), 5000)
  await ctx.close()

  // 死人开关：L3 钥匙心跳 3 s 超时 → 降级 + 停止新开仓
  const hb = await S.run(`
    const proof = await k.auth.pinProofLocalTerminal(${JSON.stringify(PIN)})
    const acct = k.accounts.list().find((a) => a.mode === 'paper').accountId
    const r = k.agents.createKey({ name: 'h-deadman', host: 'claude-code', tier: 'auto_limited', mandate: { accounts: [acct], venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['hyperliquid:BTC'], limits: { maxOrderNotional: '500', maxDailyNotional: '2000', maxDailyLoss: '100', autoMaxOrderNotional: '300' }, heartbeat: { intervalSec: 1, timeoutSec: 3, onTimeout: { downgradeTo: 'L0', takeover: 'halt_new' } } } }, proof, { actor: 'user:usr_local', actorType: 'human', tool: 'h:setup', via: 'cli', requestId: '00000000-0000-4000-8000-0000000000aa' })
    return { token: r.token, mandateId: r.mandate.mandateId, level: r.mandate.level, hb: r.mandate.heartbeat }`).catch((e) => ({ error: String(e).slice(0, 400) }))
  if (hb.token) {
    const m = await mcpFromSnippet(S.home, hb.token)
    await call(m, 'account', { action: 'summary', accountId: paperAcct })
    const t0 = Date.now()
    const tripped = await until(() => S.run(`const m = k.agents.getMandate(${JSON.stringify(hb.mandateId)}); const st = k.tstate.effective([{ type: 'org', id: 'org_local' }, { type: 'mandate', id: ${JSON.stringify(hb.mandateId)} }]); return m.level !== 'L3' ? { level: m.level, state: st.state, alerts: k.ledger.query({ types: ['takeover.executed', 'mandate.downgraded', 'annotation'], limit: 5 }).map((e) => e.type) } : null`), 12000, 250)
    metrics.deadman_trip_ms = tripped ? Date.now() - t0 : null
    check('J5 死人开关：心跳 3 s 超时 → 授权书降级（并停止新开仓）', !!tripped, JSON.stringify(tripped))
    await m.client.close().catch(() => undefined)
  } else check('J5 死人开关钥匙创建', false, JSON.stringify(hb))
}

async function J6() {
  const v = await cli(['ledger', 'verify', '--json', '--home', S.home])
  let j = {}; try { j = JSON.parse(v.out) } catch { /* */ }
  check('J6 `ledger verify`（服务在跑，只读打开）哈希链通过', v.code === 0 && j.ok === true, v.out.slice(0, 200) + v.err.slice(0, 200))
  const out = join(tmp, 'j6-export')
  const e = await cli(['ledger', 'export', '--out', out, '--home', S.home])
  check('J6 `ledger export` 出 JSONL + manifest + Markdown', e.code === 0 && ['ledger.jsonl', 'manifest.json', 'trade-log.md'].every((f) => existsSync(join(out, f))), e.out + e.err.slice(0, 300))
  if (existsSync(join(out, 'trade-log.md'))) copyFileSync(join(out, 'trade-log.md'), join(LOGS, 'J6-trade-log.md'))
  const denials = await S.run(`return k.ledger.query({ types: ['risk.denied'], limit: 20 }).map((e) => ({ rule: (e.ruleHits ?? e.precheck?.ruleHits ?? []).map((h) => h.code + ':' + h.ruleId), actor: e.origin.actorType }))`)
  check('J6 预检拒绝与"撞了哪条规则"入账（risk.denied 带 ruleHits）', denials.length > 0 && denials.every((d) => d.rule.length > 0), JSON.stringify(denials).slice(0, 400))
  const v2 = await cli(['ledger', 'verify', '--json', '--home', S.home])
  let j2 = {}; try { j2 = JSON.parse(v2.out) } catch { /* */ }
  check('J6 CLI 导出（另一进程写入 ledger.exported）后，服务继续写账本，链仍完整', j2.ok === true, v2.out.slice(0, 300))
}

async function J7b() {
  const { ctx, page } = await openWorkbench(S, 1440, 900, 'j7b')
  await page.keyboard.press('Control+K'); await page.waitForSelector('.gr-palette')
  const cmds = await page.$$eval('[data-cmd]', (els) => els.map((e) => e.getAttribute('data-cmd')))
  metrics.paletteCommands = cmds
  check('J7 ⌘K 可用（暂停 Agent / 撤全部 / 全平 / 打开设置）', ['agent:halt_new', 'agent:cancel_all', 'agent:flatten_all'].every((c) => cmds.includes(c)), cmds.join(','))
  note(`J7 ⌘K ${cmds.length} 条（v2.2 收窄：三块检阅界面，工作区 / 联动 / 弹出窗后置）`)
  // 视觉 r4（施工单 7.2-4 / 第 9 节，主会话已批准改期望值）：三块 → 五卡（持仓 + Agent 块三个视图实例 + 风险），钉住 2 → 4；总览条（data-card="overview"）不算卡
  const j7 = await page.evaluate(() => ({ blocks: [...document.querySelectorAll('.gr-tile-p:not(.gr-dock__tile)')].map((e) => e.getAttribute('data-block').split('.').pop()), cards: [...document.querySelectorAll('.gr-tile-p[data-card]:not(.gr-dock__tile)')].map((e) => e.getAttribute('data-card')), pinned: document.querySelectorAll('.gr-tile-p.is-pinned').length, status: !!document.querySelector('[data-slot="statusbar"]') }))
  check('J7（r4 口径）固定五卡 + 总览条，Agent 三视图与风险钉住', JSON.stringify(j7.blocks) === JSON.stringify(['positions', 'agent-activity', 'agent-activity', 'agent-activity', 'risk']) && j7.cards.length === 5 && j7.status && j7.pinned === 4, JSON.stringify(j7))
  await shot(page, 'J7-1440-palette.png')
  await page.keyboard.press('Escape')
  // 刷新：会话只在内存 → 刷新后怎样
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500)
  const afterReload = await bodyText(page)
  await shot(page, 'J7-1440-after-reload.png')
  const onlineAfter = await page.evaluate(() => window.__GR_READY__?.online === true)
  note(`J7 刷新页面后：online=${onlineAfter}；页面文字：${afterReload.slice(0, 160).replace(/\n/g, ' / ')}`)
  check('J7 刷新页面后给出会话失效提示与取新链接的办法', /gitrader open|新链接|重新打开|会话/.test(afterReload), afterReload.slice(0, 300))
  await ctx.close()
}

async function J8() {
  const dst = join(S.home, 'plugins', 'ema-reading')
  const src = join(root, 'packages', 'plugin-template', 'example', 'ema-reading')
  mkdirSync(dst, { recursive: true })
  for (const f of readdirSync(src, { recursive: true })) { const p = join(src, f); if (statSync(p).isFile()) { mkdirSync(join(dst, f, '..'), { recursive: true }); copyFileSync(p, join(dst, f)) } }
  const r = await cli(['plugins', 'reload', '--home', S.home])
  const l = await cli(['plugins', 'list', '--home', S.home])
  check('J8 未签名示例插件默认被拒，并说清怎么开开发者模式', /unsigned plugin: enable plugins\.developerMode/.test(r.out + l.out), r.out + l.out)
  // 篡改一个字节 → 拒装
  const bj = join(dst, 'block.js'); const orig = readFileSync(bj); writeFileSync(bj, Buffer.concat([orig, Buffer.from('\n')]))
  const r2 = await cli(['plugins', 'reload', '--home', S.home])
  const l2 = await cli(['plugins', 'list', '--home', S.home])
  check('J8 插件文件被改一个字节 → 哈希不符被拒', /REJECTED/.test(l2.out) || /rejected [1-9]/.test(r2.out), r2.out + l2.out)
  writeFileSync(bj, orig)
  // 按插件模板 README：gitrader.json 里 plugins.developerMode = true（改配置要重启；与 J4 的重启合并，见 J8b）
  const cfgPath = join(S.home, 'gitrader.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); cfg.plugins.developerMode = true; writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
}

async function J8b() {
  const r = await cli(['plugins', 'reload', '--home', S.home])
  const l = await cli(['plugins', 'list', '--home', S.home])
  check('J8 开发者模式 + 重启后：示例插件清单校验通过（钉版本 + 哈希）', /ok\s+\S*ema/.test(l.out), r.out + l.out + r.err.slice(0, 200))
  const { ctx, page } = await openWorkbench(S, 1440, 900, 'j8')
  // v3：插件区默认折叠（F）。先确认折叠，再像用户一样点开
  const head = await page.waitForSelector('[data-slot="plugins"] [data-act="plugins-toggle"]', { timeout: 12000 }).catch(() => null)
  const collapsed = head ? (await head.getAttribute('aria-expanded')) === 'false' : null
  check('J8 插件区出现且默认折叠', head && collapsed === true, `expanded=${head ? await head.getAttribute('aria-expanded') : 'no dock'}`)
  await shot(page, 'J8-1440-dock-collapsed.png')
  if (head && collapsed) await head.click()
  const tile = await page.waitForSelector('[data-slot="plugins"] [data-block="block.example.ema-reading"]', { timeout: 12000 }).catch(() => null)
  check('J8 重载后插件出现为工作台插件区里的块', !!tile, (await bodyText(page)).slice(0, 200))
  const frame = await page.waitForSelector('[data-block="block.example.ema-reading"] iframe', { timeout: 8000 }).catch(() => null)
  const sandbox = frame ? await frame.getAttribute('sandbox') : null
  check('J8 插件块跑在 iframe 沙箱里（无 allow-same-origin）', !!frame && sandbox !== null && !/allow-same-origin/.test(sandbox), `sandbox=${sandbox}`)
  let inner = ''
  if (frame) { const fr = await frame.contentFrame(); for (let i = 0; i < 40 && !/EMA|\d/.test(inner); i++) { await page.waitForTimeout(250); inner = (await fr?.evaluate(() => document.body?.innerText ?? '').catch(() => '')) ?? '' } }
  check('J8 插件块里有内容（EMA 读数）', /EMA|\d/.test(inner), inner.slice(0, 160))
  const s8 = await noScroll(page)
  check('J8 有插件区时 1440 仍无页面滚动', s8.v <= 1 && s8.h <= 1, JSON.stringify(s8))
  await shot(page, 'J8-1440-after-plugin.png')
  await ctx.close()
  // v3：三档宽度 × 插件区折叠 / 展开：无页面滚动、插件区 ≤ 30% 视口、有待批时批准按钮真能点到（elementFromPoint）
  const liveId = await S.run(`return k.accounts.list().find((a) => a.mode === 'live')?.accountId ?? null`)
  const pp = liveId && mcps.confirm ? await call(mcps.confirm, 'propose', { action: 'order', accountId: liveId, intents: [{ instrumentId: BTC, side: 'sell', type: 'limit', size: '0.001', price: '70000', tif: 'ioc', leverage: 2, reduceOnly: false }], reason: 'H-J8 pending card for layout check' }) : null
  note('J8 版式检查用的待批提案：' + JSON.stringify(pp?.data ?? null).slice(0, 200))
  for (const [w, h] of [[1440, 900], [1200, 800], [900, 900]]) {
    const o = await openWorkbench(S, w, h, `j8-${w}`)
    await o.page.waitForSelector('[data-act="plugins-toggle"]', { timeout: 10000 }).catch(() => null)
    for (const mode of ['collapsed', 'expanded']) {
      const btn = await o.page.$('[data-act="plugins-toggle"]')
      const exp = btn ? (await btn.getAttribute('aria-expanded')) === 'true' : false
      if (btn && ((mode === 'expanded') !== exp)) { await btn.click(); await o.page.waitForTimeout(500) }
      await o.page.waitForTimeout(400)
      const sc = await noScroll(o.page)
      const dockH = await o.page.evaluate(() => { const d = document.querySelector('[data-slot="plugins"]'); return d ? d.getBoundingClientRect().height / innerHeight : 0 })
      const hit = await o.page.evaluate(() => { const b = document.querySelector('.gb-pend [data-act="approve"]'); if (!b) return 'no-pending'; const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el && (el === b || b.contains(el)) ? 'clickable' : 'covered' })
      check(`J7/J8 ${w}×${h} 插件区${mode === 'expanded' ? '展开' : '折叠'}：无页面滚动、插件区 ≤ 30% 视口、批准按钮可点`, sc.v <= 1 && sc.h <= 1 && dockH <= 0.301 && hit !== 'covered', JSON.stringify({ sc, dockH: +dockH.toFixed(3), hit }))
      await shot(o.page, `J8-${w}-dock-${mode}.png`)
    }
    await o.ctx.close()
  }
}

async function J4() {
  // 人：工作台导入一只测试网 API 钱包（自生成的测试私钥，只在内存，不落盘明文）
  const { randomBytes } = await import('node:crypto')
  const secret = randomBytes(32).toString('hex')
  let { ctx, page } = await openWorkbench(S, 1440, 900, 'j4')
  await page.evaluate(() => { location.hash = '#/settings/keys' }); await page.waitForSelector('[data-act="key-open"]')
  await page.click('[data-act="key-open"]')
  await page.waitForSelector('input[aria-label="API 钱包私钥"]', { state: 'visible' }); await page.waitForTimeout(300) // r2：行内展开表单有入场动画，等稳定再填
  await page.fill('input[aria-label="钥匙名称"]', 'testnet-trade')
  await page.fill('input[aria-label="API 钱包私钥"]', secret)
  await page.waitForSelector('[data-act="key-save"]:not([disabled])', { timeout: 5000 })
  await page.click('[data-act="key-save"]')
  if (await page.waitForSelector('.gr-pin', { timeout: 1500 }).catch(() => null)) await pinLayer(page)
  const imported = await until(async () => /0x[0-9a-f]{4,}/i.test(await bodyText(page)), 6000)
  check('J4 工作台导入测试网 API 钱包，列表只显示地址', !!imported)
  await shot(page, 'J4-1440-key-imported.png')
  const w = await S.run(`return k.keystore.list().map((x) => ({ id: x.walletId, name: x.name, address: x.address, network: x.network }))`)
  await ctx.close()
  // 主网默认关：没有主网钱包时切主网被拒
  const mn = await S.run(`try { await k.ops.call(k, 'settings.network.set', { principal: k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken), params: { network: 'mainnet' }, transport: 'ws', kind: 'command' }); return 'switched' } catch (e) { return e.problem?.name + ': ' + e.problem?.message }`)
  check('J4 主网默认关：没导入主网 API 钱包时切主网被拒', /VENUE_AUTH/.test(mn), mn)
  // 加一个实盘（测试网）账户：界面没有入口，专业用户改 gitrader.json 一行后重启（这就是"关掉再开"）
  const cfgPath = join(S.home, 'gitrader.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfg.accounts.push({ alias: 'testnet-live', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: w[0]?.id })
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  // 先不写主账户地址：看内核会不会说
  for (const m of Object.values(mcps)) await m.client.close().catch(() => undefined)
  await S.stop()
  S = await startStage({ keep, tmp: S.tmp, home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: ENGINE_ENV })
  const st0 = await cli(['status', '--home', S.home])
  check('J4 实盘账户缺主账户地址时，status 明确警告', /owner\.address/.test(st0.out), st0.out.slice(0, 600))
  // 按警告补上主账户地址（公开地址；这里用一个随机测试地址）
  const cfg2 = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfg2.accounts.find((a) => a.alias === 'testnet-live').owner = { address: '0x' + randomBytes(20).toString('hex') }
  writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2))
  for (const m of Object.values(mcps)) await m.client.close().catch(() => undefined)
  await S.stop()
  const t0 = performance.now()
  S = await startStage({ keep, tmp: S.tmp, home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: ENGINE_ENV })
  metrics.stageWarmRestartMs = Math.round(performance.now() - t0)
  await sleep(1500)
  const accts = await S.run(`return k.accounts.list().map((a) => ({ id: a.accountId, alias: a.alias, mode: a.mode }))`)
  const live = accts.find((a) => a.mode === 'live')
  check('J4 重启后实盘（测试网）账户出现', !!live, JSON.stringify(accts))
  mcps.paper = await mcpFromSnippet(S.home, tokens.paper)
  mcps.confirm = await mcpFromSnippet(S.home, tokens.confirm)
  check('J4 重启后 Agent 钥匙仍有效（MCP 重连即可）', (await mcps.confirm.client.listTools()).tools.length === 16)
  const old = await call(mcps.confirm, 'propose', { action: 'order', accountId: live.id, intents: [{ instrumentId: BTC, side: 'buy', type: 'limit', size: '0.002', price: '83000', tif: 'ioc', leverage: 2 }], reason: 'H-J4 old key on new account' })
  check('J4 旧钥匙不会自动覆盖新加的实盘账户（MANDATE_LIMIT）', old.isError && /MANDATE_LIMIT/.test(JSON.stringify(old.data)), JSON.stringify(old.data).slice(0, 200))
  const nk = await newAgentKey(S.home, 'codex-live', 'codex', 'confirm', ['--accounts', 'testnet-live', '--max-order', '500', '--max-daily', '2000', '--venues', 'hyperliquid', '--instruments', BTC])
  check('J4 给实盘（测试网）账户建一把"需确认"钥匙', !!nk.token, nk.out.slice(0, 200) + nk.err.slice(0, 200))
  await mcps.confirm.client.close().catch(() => undefined)
  mcps.confirm = await mcpFromSnippet(S.home, nk.token)
  // 先把工作台开好再提案：夹具行情每 250 ms 走一根真实 1 分钟 K 线（约实时的 240 倍），提案到批准之间的窗口要尽量短，否则撞上 PRICE_DRIFT（默认 30 bps，按设计拒绝执行）
  ;({ ctx, page } = await openWorkbench(S, 1440, 900, 'j4b'))
  // Agent（需确认档）提交实盘提案
  const prop = await call(mcps.confirm, 'propose', { action: 'order', accountId: live.id, intents: [{ instrumentId: BTC, side: 'buy', type: 'limit', size: '0.002', price: '83000', tif: 'ioc', leverage: 2 }], reason: 'H-J4 live testnet proposal' })
  check('J4 Agent 提交实盘提案 → 待批（票号）', prop.data?.status === 'pending' && /^T-/.test(prop.data?.ticket ?? ''), JSON.stringify({ status: prop.data?.status, ticket: prop.data?.ticket, precheck: prop.data?.precheck, problem: prop.data?.problem }).slice(0, 2000))
  await page.waitForSelector('.gb-pend', { timeout: 6000 }).catch(() => undefined)
  await shot(page, 'J4-1440-pending.png')
  const exBefore = await S.run('return ctx.exchangeCalls.length')
  await page.click('.gb-pend >> nth=0 >> [data-act="approve"]').catch((e) => note('J4 批准按钮点击失败 ' + String(e).slice(0, 100)))
  const needPin = await page.waitForSelector('.gr-pin', { timeout: 3000 }).catch(() => null)
  if (needPin) await pinLayer(page)
  const ex = await until(() => S.run(`return ctx.exchangeCalls.length > ${exBefore} ? ctx.exchangeCalls.slice(${exBefore}) : null`), 8000, 200)
  check('J4 人面批准（PIN）→ API 钱包签名 → 场所收到已签名订单', !!ex && ex.some((c) => c.actionType === 'order' && c.hasSignature), JSON.stringify(ex ?? (await bodyText(page)).slice(0, 300)).slice(0, 400))
  if (ex) writeFileSync(join(LOGS, 'J4-signed-payloads.json'), JSON.stringify(ex.map((c) => ({ actionType: c.actionType, hasSignature: c.hasSignature, nonce: c.nonce, body: c.body })), null, 2))
  check('J4 批准时 PIN 弹层出现（实盘批准要在场证明）', !!needPin)
  await page.waitForTimeout(1500)
  const p2 = await S.run(`return k.trading.getProposal(${JSON.stringify(prop.data?.proposalId ?? '')})?.status`)
  const p2full = await S.run(`const p = k.trading.getProposal(${JSON.stringify(prop.data?.proposalId ?? '')}); return p ? { status: p.status, decision: p.decision, execution: p.execution, precheck: p.precheck && { verdict: p.precheck.verdict, ruleHits: p.precheck.ruleHits } } : null`)
  note('J4 批准后提案：' + JSON.stringify(p2full).slice(0, 1500))
  const ord = await S.run(`return k.orders.list({ accountId: ${JSON.stringify(live.id)}, limit: 5 }).map((o) => ({ status: o.status, filled: o.filledSize, origin: o.origin?.actorType, tool: o.origin?.tool }))`)
  metrics.j4_budget_after_approve = await S.run(`return { ...k.bus.budget('hyperliquid').usage(), info: Object.fromEntries(ctx.infoCounts) }`, 5000).catch((e) => String(e))
  note('J4 批准后 HL 权重：' + JSON.stringify(metrics.j4_budget_after_approve).slice(0, 300))
  const snap = await S.run(`const a = k.accounts.get(${JSON.stringify(live.id)}); const s = await k.bus.snapshot(a, { maxAgeMs: 3000 }); return s.positions.map((p) => ({ i: p.instrumentId, size: p.size }))`, 70000)
  check('J4 提案执行 → 订单成交 → 账本 / 持仓一致', p2 === 'executed' && ord.some((o) => o.status === 'filled') && snap.some((p) => p.i === BTC), JSON.stringify({ p2, ord, snap }))
  const posText = await page.evaluate(() => document.querySelector('.gb-pos')?.innerText ?? '')
  check('J4 持仓块显示实盘（测试网）BTC 持仓', /BTC/.test(posText) && /(实盘|测试网|testnet|live)/i.test(posText), posText.slice(0, 300))
  await shot(page, 'J4-1440-after-approve.png')
  await ctx.close()
  // LLM 实盘开仓默认拒：再建一把 L3 钥匙预览实盘开仓
  note(`J4 测试网"真成交"部分无法验证（没有 维护者 的测试网钱包授权）；本旅程用夹具假装场所，验到"签名载荷生成 + 回执入账"`)
}

async function J13() {
  // 新人：Agent 从空白模板写第一条规则策略
  const tpl = readFileSync(join(root, 'packages', 'engine-core', 'strategy-template', 'strategy.ts'), 'utf8')
  const mine = tpl
    .replace("id: 'blank-template'", "id: 'my-first-rule'")
    .replace("name: 'Blank template (does nothing)'", "name: 'Close vs moving average'")
    .replace("nameZh: '空白模板（什么都不做）'", "nameZh: '收盘价对均线'")
    .replace("desc: 'Template with no trading logic: the target is always 0.'", "desc: 'Long when the close is above its simple moving average, flat otherwise. Whipsaws in sideways markets.'")
    .replace("tags: ['template']", "tags: ['example', 'trend']")
    .replace(`    const target: number[] = new Array(n).fill(0) // TODO(agent): compute the target position per bar, using candles[0..i] only
    const reasons: string[] = new Array(n).fill('') // TODO(agent): explain every change of target, e.g. 'close 101.2 crossed above EMA20 99.8 -> long'
    const overlays: Record<string, Array<number | null>> = {} // TODO(agent): e.g. { EMA20: emaValues } (arrays of length n, null while warming up)`,
    `    const target: number[] = new Array(n).fill(0)
    const reasons: string[] = new Array(n).fill('')
    const sma: Array<number | null> = new Array(n).fill(null)
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += candles[i]!.c
      if (i >= period) sum -= candles[i - period]!.c
      if (i >= period - 1) sma[i] = sum / period
      const m = sma[i]
      target[i] = m !== null && candles[i]!.c > m ? 1 : 0
      if (i > 0 && target[i] !== target[i - 1]) reasons[i] = target[i] === 1 ? 'close ' + candles[i]!.c + ' above SMA ' + (m as number).toFixed(1) + ' -> long' : 'close ' + candles[i]!.c + ' below SMA -> flat'
    }
    const overlays: Record<string, Array<number | null>> = { SMA: sma }`)
    .replace("{ key: 'period', label: 'Look-back period (bars)', type: 'integer', default: 20, min: 2, max: 400, step: 1 }", "{ key: 'period', label: 'Look-back period (bars)', type: 'integer', default: 5, min: 2, max: 400, step: 1 }")
  check('J13 从空白模板改出第一条策略（模板里只有接口）', mine !== tpl && /candles\[i\]!\.c > m/.test(mine))
  // 照模板注释说的目录丢进去（从模板原文读，不预设）
  const said = /Copy it to\s+~\/\.gitrader\/(\S+)\/<your-id>\.ts/.exec(tpl)?.[1] ?? 'engines/core/strategies'
  metrics.j13_template_dir = said
  const tplDir = join(S.home, ...said.split('/'))
  mkdirSync(tplDir, { recursive: true }); writeFileSync(join(tplDir, 'my-first-rule.ts'), mine)
  await sleep(2500)
  let list = await call(mcps.paper, 'engines', { action: 'strategies' })
  const loadedAtTplDir = JSON.stringify(list.data).includes('my-first-rule')
  check(`J13 按模板注释的目录（${said}）丢进去即加载`, loadedAtTplDir, JSON.stringify(list.data).slice(0, 300))
  // 内核实际交给引擎的目录
  const realDir = join(S.home, 'engines', 'gitrader-core', 'strategies')
  mkdirSync(realDir, { recursive: true }); writeFileSync(join(realDir, 'my-first-rule.ts'), mine)
  const loaded = await until(async () => { list = await call(mcps.paper, 'engines', { action: 'strategies' }); return JSON.stringify(list.data).includes('my-first-rule') }, 8000, 500)
  check('J13 丢进内核交给引擎的目录（engines/gitrader-core/strategies）→ 热加载，Agent 用 engines.strategies 看得到', !!loaded, JSON.stringify(list.data).slice(0, 300))
  // 回测：数据由 Agent 自己取（market.candles）写成文件——我们不提供数据
  const candles = await call(mcps.paper, 'market', { action: 'candles', instrumentId: BTC, interval: '1m', limit: 2000 })
  const cs = Array.isArray(candles.data) ? candles.data : candles.data?.items ?? candles.data?.candles ?? []
  const labDir = join(S.home, 'lab', 'data'); mkdirSync(labDir, { recursive: true })
  const file = join(labDir, 'btc-1m.json'); writeFileSync(file, JSON.stringify(cs))
  const { createHash } = await import('node:crypto')
  const sha = 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex')
  const from = cs[0]?.t, to = cs[cs.length - 1]?.t
  const spec = { subject: { strategy: { id: 'my-first-rule', version: '0.1.0', params: { period: 5 } } }, instruments: [BTC], interval: '1m', from, to, data: { source: 'files', files: [{ path: file, sha256: sha, format: 'json' }] }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 }, assumptions: { fees: 'venue', slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false }, seed: 1 }
  const t0 = performance.now()
  let bt = await call(mcps.paper, 'backtest', { action: 'run', spec })
  let result = null
  if (bt.data?.jobId) result = await until(async () => { const r = await call(mcps.paper, 'backtest', { action: 'result', jobId: bt.data.jobId }); return r.data?.stats ? r.data : null }, 20000, 300)
  const btMs = performance.now() - t0
  metrics.j13_backtest = { candles: cs.length, ms: Math.round(btMs), barsPerSec: result ? Math.round(cs.length / (btMs / 1000)) : null, trades: result?.stats?.trades, assumptions: result?.assumptions, lookahead: result?.biasChecks?.lookahead }
  check('J13 backtest.run（Agent 经 MCP，数据是自己取的文件）出结果与假设', !!result && !!result.assumptions, JSON.stringify(bt.data ?? {}).slice(0, 300) + ' ' + JSON.stringify(result ?? {}).slice(0, 200))
  if (!result) { const bt2 = await call(mcps.paper, 'backtest', { action: 'run', spec: { ...spec, data: { source: 'host' } } }); note(`J13 改用 data.source=host 再试：${JSON.stringify(bt2.data).slice(0, 300)}`) }
  // 纸面：人把引擎绑到纸面账户（CLI，一次，PIN），Agent strategy.start
  const bind = await cli(['engines', 'bind', 'gitrader-core', '--home', S.home], { stdin: PIN + '\n' })
  check('J13 人把引擎绑到纸面账户（`gitrader engines bind`，PIN）', bind.code === 0 && /Bound/.test(bind.out), bind.out + bind.err.slice(0, 300))
  const paperAcct = await S.run(`return k.accounts.list().find((a) => a.mode === 'paper').accountId`)
  const { ctx, page } = await openWorkbench(S, 1440, 900, 'j13')
  const st = await call(mcps.paper, 'engines', { action: 'start_strategy', strategyId: 'my-first-rule', accountId: paperAcct, instruments: [BTC], interval: '1m', params: { period: 5 } })
  check('J13 Agent 经 MCP 在纸面账户 strategy.start', !st.isError && !!(st.data?.instanceId ?? st.data?.status), JSON.stringify(st.data).slice(0, 300))
  const engOrders = await until(() => S.run(`return k.ledger.query({ limit: 200 }).filter((e) => e.origin?.actorType === 'engine' && (e.type === 'order.intent' || e.type === 'fill')).map((e) => ({ type: e.type, tool: e.origin.tool, verdict: e.precheck?.verdict }))`).then((r) => (r.length ? r : null)), 45000, 1000)
  check('J13 策略在纸面产生引擎来源的订单（origin=engine，过风控）', !!engOrders, JSON.stringify(engOrders ?? []).slice(0, 300))
  await page.waitForTimeout(1500)
  await page.click('.gb-agent__filter [data-v="engine"]').catch(() => undefined)
  await page.waitForTimeout(400)
  const at = await page.evaluate(() => { const el = document.querySelector('.gb-agent[data-view="feed"]'); if (!el) return ''; const c = el.cloneNode(true); c.querySelector('.gb-agent__filter')?.remove(); return c.innerText })
  check('J13 三块检阅面看到引擎的动作（Agent 活动块筛"引擎"后有引擎来源的条目）', /my-first-rule|引擎 ·|engine|gitrader-core/i.test(at) && /(买入|卖出|成交|订单)/.test(at), at.slice(0, 400))
  await shot(page, 'J13-1440-engine-activity.png')
  metrics.j13_ui_vs_ledger = {
    ledgerEngine: await S.run(`return k.ledger.query({ limit: 400 }).filter((e) => e.origin?.actorType === 'engine').map((e) => e.type + ':' + (e.precheck?.verdict ?? ''))`),
    uiRows: await page.evaluate(() => [...document.querySelectorAll('.gb-agent[data-view="feed"] [data-entry], .gb-agent[data-view="feed"] li, .gb-agent[data-view="feed"] .gb-ev')].map((x) => x.innerText.replace(/\n/g, ' | ').slice(0, 120))),
  }
  note('J13 账本里引擎来源条目 ' + metrics.j13_ui_vs_ledger.ledgerEngine.length + ' 条；检阅块（筛引擎）显示 ' + metrics.j13_ui_vs_ledger.uiRows.length + ' 行')
  if (st.data?.instanceId) await call(mcps.paper, 'engines', { action: 'stop_strategy', instanceId: st.data.instanceId })
  await ctx.close()
  check('J13 全程没有用到我们提供的策略 / 数据 / 因子（模板是空的；数据是 Agent 自己取的）', /target is always 0/.test(tpl) && !existsSync(join(root, 'packages', 'engine-core', 'data')))
}

async function J14() {
  // 专业：接入"自己的引擎"——任意命令的 stdio 子进程（这里用 engine-core 的单文件当作用户自己的引擎），一行配置
  const cfgPath = join(S.home, 'gitrader.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfg.engines.push({ id: 'my-engine', enabled: true, launch: { command: process.execPath, args: [join(root, 'packages', 'engine-core', 'dist', 'engine-core.mjs'), '--stdio'] } })
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  for (const m of Object.values(mcps)) await m.client.close().catch(() => undefined)
  await S.stop()
  const t0 = performance.now()
  S = await startStage({ keep, tmp: S.tmp, home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: ENGINE_ENV })
  await until(() => S.run(`return k.gep.isReady('my-engine')`), 15000, 250)
  const ready = await S.run(`return k.gep.status().map((g) => ({ id: g.engineId, state: g.state }))`)
  metrics.j14_engine_ready_ms = Math.round(performance.now() - t0)
  check('J14 gitrader.json 加一行 → 自己的引擎（任意命令 stdio）被拉起并完成 GEP 握手', ready.some((g) => g.id === 'my-engine' && g.state === 'ready'), JSON.stringify(ready))
  mcps.paper = await mcpFromSnippet(S.home, tokens.paper)
  const realDir = join(S.home, 'engines', 'my-engine', 'strategies')
  mkdirSync(realDir, { recursive: true }); copyFileSync(join(S.home, 'engines', 'gitrader-core', 'strategies', 'my-first-rule.ts'), join(realDir, 'my-first-rule.ts'))
  await sleep(2500)
  const bind = await cli(['engines', 'bind', 'my-engine', '--home', S.home], { stdin: PIN + '\n' })
  check('J14 自己的引擎绑到纸面账户', bind.code === 0, bind.out + bind.err.slice(0, 200))
  const paperAcct = await S.run(`return k.accounts.list().find((a) => a.mode === 'paper').accountId`)
  const st = await call(mcps.paper, 'engines', { action: 'start_strategy', engineId: 'my-engine', strategyId: 'my-first-rule', accountId: paperAcct, instruments: [BTC], interval: '1m', params: { period: 5 } })
  check('J14 Agent 指定 engineId 在自己的引擎上起纸面策略', !st.isError, JSON.stringify(st.data).slice(0, 300))
  const engOrders = await until(() => S.run(`return k.ledger.query({ limit: 300 }).filter((e) => e.origin?.actor === 'engine:my-engine' && e.type === 'order.intent').length`).then((n) => n || null), 45000, 1000)
  check('J14 自己的引擎的订单意图经内核风控进模拟场所（origin = engine:my-engine）', !!engOrders, String(engOrders))
  if (st.data?.instanceId) await call(mcps.paper, 'engines', { action: 'stop_strategy', engineId: 'my-engine', instanceId: st.data.instanceId })
  const v = await cli(['ledger', 'verify', '--home', S.home])
  check('J14 全程后账本哈希链完整', v.code === 0, v.out)
}

// ================================================================== J15 强停与持久化（固定本地行情、零资金费）
async function J15() {
  const hostFile = await bundleHost(tmp)
  const env = { ...ENGINE_ENV, GITRADER_STAGE_NO_ENGINE: '1', GITRADER_STAGE_FIXED_MARKET: '1' }
  const owned = []
  const launch = async (home) => {
    S = await startStage({ keep: true, tmp: join(tmp, 'j15'), ...(home ? { home } : {}), hostFile, env })
    owned.push(S.pid)
    writeFileSync(join(LOGS, 'owned-pids.json'), JSON.stringify({ pids: owned }))
    await until(() => S.run("return !!paper && k.connectionStatus().some(x => x.venue === 'hyperliquid' && x.state === 'connected')"))
    await sleep(1200)
    await S.run(`ctx.session = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken); if (!k.pin.isSet()) await k.auth.setupPin(ctx.session, ${JSON.stringify(PIN)}); return true`)
  }
  await launch()
  browser = await chromium().launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
  const observe = async () => {
    const view = await newPage(1440, 900, 'j15')
    const received = new Map()
    view.page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
      let msg
      try { msg = JSON.parse(String(payload)) } catch { return }
      const p = msg.params
      if (msg.method !== 'event' || p?.topic !== 'ledger.entry') return
      for (const e of p.events ?? [{ data: p.data }]) if (e.data?.id) received.set(e.data.id, e.data)
    }))
    await view.page.goto(r4Url(await S.boot()), { waitUntil: 'load' })
    await view.page.waitForFunction(() => window.__GR_READY__?.online === true)
    await view.page.waitForSelector('[data-card="feed"]')
    return { ...view, received }
  }
  const place = (type, side, size, extra = {}) => S.run(`return k.ops.call(k, 'order.place', { principal: ctx.session, transport: 'http', params: { intent: { accountId: k.accounts.find('paper').accountId, instrumentId: ${JSON.stringify(BTC)}, type: ${JSON.stringify(type)}, side: ${JSON.stringify(side)}, size: ${JSON.stringify(size)}, reason: 'J15 persistence', ...${JSON.stringify(extra)} } } })`)
  const snapshot = () => S.run(`const a=k.accounts.find('paper'); const s=await k.bus.snapshot(a,{maxAgeMs:0}); const raw=JSON.parse(paper.exportState()); return {equity:s.equity, positions:s.positions.map(p=>({instrumentId:p.instrumentId,side:p.side,size:p.size,entryPrice:p.entryPrice,unrealizedPnl:p.unrealizedPnl})), orders:k.orders.list({accountId:a.accountId,openOnly:true}).map(o=>({orderId:o.orderId,venueOrderId:o.venueOrderId,status:o.status,type:o.type,size:o.size,price:o.price,triggerPrice:o.triggerPrice,reduceOnly:o.reduceOnly})).sort((a,b)=>a.orderId.localeCompare(b.orderId)), fills:k.orders.fills({accountId:a.accountId}), state:raw, verify:k.ledger.verify()}`)
  let view = await observe()
  const opened = await place('market', 'buy', '0.002')
  check('J15 纸面市价成交', opened.order?.status === 'filled')
  const mark = Number(await S.run(`return (await hl.context(${JSON.stringify(BTC)})).markPrice`))
  await sleep(5100) // 尊重现有开仓冷却，不改变风险夹具
  const limit = await place('limit', 'buy', '0.001', { price: String(Math.floor(mark * 0.98)), tif: 'gtc' })
  const stop = await place('stop_market', 'sell', '0.002', { triggerPrice: String(Math.floor(mark * 0.95)), reduceOnly: true })
  check('J15 限价与未触发止损挂单', limit.order?.status === 'open' && stop.order?.status === 'untriggered')
  const before = await snapshot()
  const persisted = JSON.parse(readFileSync(join(S.home, 'paper-state.json'), 'utf8'))
  const durable = (state) => JSON.stringify(state, (key, value) => ['lastFundingTs', 'confirmedAt', 'mark'].includes(key) ? undefined : value)
  check('J15 强停前状态已落盘', durable(persisted) === durable(before.state))
  await sleep(500)
  const ledgerBefore = await S.run("return [...k.ledger.iterate()].filter(e => ['order.intent','fill'].includes(e.type)).map(e=>e.id)")
  const beforeReceived = ledgerBefore.filter((id) => view.received.has(id)).length
  check('J15 活动订阅完整接收首轮订单与成交', beforeReceived === ledgerBefore.length)
  await shot(view.page, 'J15-before.png')
  const home = S.home
  const old = S.proc
  old.kill('SIGKILL')
  await new Promise((resolve) => old.once('close', resolve))
  check('J15 真实强停内核进程', old.exitCode !== null || old.signalCode !== null)
  await view.ctx.close()
  await launch(home)
  view = await observe()
  const after = await snapshot()
  check('J15 重启持仓与权益原样', JSON.stringify(before.positions) === JSON.stringify(after.positions) && before.equity === after.equity)
  check('J15 重启挂单与止损原样', JSON.stringify(before.orders) === JSON.stringify(after.orders))
  check('J15 重启账本校验通过', after.verify.ok === true)
  await sleep(5100)
  const next = await place('market', 'buy', '0.001')
  const final = await snapshot()
  const fillIds = final.fills.map((f) => f.venueFillId)
  check('J15 再成交且订单与成交续号不撞', next.order?.status === 'filled' && next.order.venueOrderId !== opened.order?.venueOrderId && final.fills.length === before.fills.length + 1 && new Set(fillIds).size === fillIds.length && final.state.orderSeq > before.state.orderSeq && final.state.fillSeq > before.state.fillSeq)
  await sleep(600)
  const nextEntries = await S.run(`return [...k.ledger.iterate()].filter(e=>e.subject.orderId === ${JSON.stringify(next.order?.orderId)} && ['order.intent','fill'].includes(e.type)).map(e=>e.id)`)
  const feed = await view.page.locator('[data-card="feed"]').innerText()
  check('J15 重启后实际活动订阅与工作台可见', nextEntries.length >= 2 && nextEntries.every((id) => view.received.has(id)) && /成交|买入/.test(feed))
  await shot(view.page, 'J15-after.png')
  metrics.j15 = { before: { equity: before.equity, positions: before.positions, openOrders: before.orders.length, fills: before.fills.length, orderSeq: before.state.orderSeq, fillSeq: before.state.fillSeq }, after: { equity: after.equity, positions: after.positions, openOrders: after.orders.length, fills: after.fills.length }, final: { fills: final.fills.length, orderSeq: final.state.orderSeq, fillSeq: final.state.fillSeq }, activity: { beforeExpected: ledgerBefore.length, beforeReceived, afterExpected: nextEntries.length, afterReceived: nextEntries.filter(id=>view.received.has(id)).length }, pids: owned }
  await view.ctx.close()
}

// ================================================================== Jr5-1 ～ Jr5-6（r5 界面，T2；默认不跑：加 --r5 或 --only Jr5）
// 六条旅程在 packages/blocks-r5/test/journeys.browser.test.ts（真壳 ?ui=r5 + 夹具内核 + CDP 直连 Edge，无头）：这里起一个子 vitest，把每条的结果并入本脚本的检查表与 journeys.json。
// 旧 J1–J15 的计数不受影响（缺省不跑）。
const wantR5 = process.argv.includes('--r5') || (only?.has('Jr5') ?? false)
async function Jr5() {
  const pkg = join(root, 'packages', 'blocks-r5')
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
  const home = mkdtempSync(join(tmp, 'jr5-home-'))
  const out = join(tmp, 'jr5.json')
  const args = [vitest, 'run', '--config', './vitest.config.ts', '--root', '.', 'test/journeys.browser.test.ts', '--reporter=json', `--outputFile=${out}`]
  const code = await new Promise((res) => {
    const p = spawn(process.execPath, args, { cwd: pkg, env: { ...process.env, GITRADER_HOME: home }, stdio: 'ignore', windowsHide: true })
    mine.push(p)
    const timer = setTimeout(() => { p.kill() }, 40 * 60_000)
    p.on('close', (c) => { clearTimeout(timer); res(c) })
  })
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { testResults: [] }
  const rows = report.testResults.flatMap((f) => f.assertionResults).filter((r) => /Jr5-\d/.test(r.title))
  check('Jr5 六条旅程都有结果', rows.length === 6, `exit=${code} rows=${rows.length}`)
  for (const r of rows) check(r.title.trim(), r.status === 'passed', (r.failureMessages?.[0] ?? '').replace(/\s+/g, ' ').slice(0, 500))
}

// ================================================================== 主流程
const t00 = Date.now()
try {
  if (want('J1')) await J1().catch((e) => check('J1 异常', false, e.stack))
  if (want('J15')) await J15().catch((e) => check('J15 异常', false, e.stack))
  if (wantR5) await Jr5().catch((e) => check('Jr5 异常', false, e.stack))
  const needStage = ['J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J13', 'J14'].some(want)
  if (needStage) {
    await setupStage()
    await J7a_and_pin().catch((e) => check('J7a 异常', false, e.stack))
    await J2().catch((e) => check('J2 异常', false, e.stack))
    if (want('J3')) await J3().catch((e) => check('J3 异常', false, e.stack))
    if (want('J5')) await J5().catch((e) => check('J5 异常', false, e.stack))
    if (want('J6')) await J6().catch((e) => check('J6 异常', false, e.stack))
    if (want('J7')) await J7b().catch((e) => check('J7b 异常', false, e.stack))
    if (want('J8')) await J8().catch((e) => check('J8 异常', false, e.stack))
    if (want('J13')) await J13().catch((e) => check('J13 异常', false, e.stack))
    if (want('J4')) await J4().catch((e) => check('J4 异常', false, e.stack))
    if (want('J8') && want('J4')) await J8b().catch((e) => check('J8b 异常', false, e.stack))
    if (want('J14')) await J14().catch((e) => check('J14 异常', false, e.stack))
    check('控制台 0 错误（全部页面）', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))
    const unhandled = await S.run('return [...ctx.unhandledInfo]').catch(() => [])
    if (unhandled.length) note('夹具未覆盖的 info 请求：' + JSON.stringify(unhandled))
    writeFileSync(join(LOGS, 'journeys-stage-stderr.log'), S.stderr)
  }
} finally {
  for (const m of Object.values(mcps)) await m.client?.close().catch(() => undefined)
  try { await browser?.close() } catch { /* */ }
  try { await S?.stop() } catch { /* */ }
  for (const p of mine) if (p.exitCode === null) p.kill()
  if (!keep) rmSync(tmp, { recursive: true, force: true }); else console.log('kept', tmp)
}
const failed = results.filter((r) => !r.ok)
writeFileSync(join(LOGS, 'journeys.json'), JSON.stringify({ at: new Date().toISOString(), durationSec: Math.round((Date.now() - t00) / 1000), total: results.length, failed: failed.length, metrics, notes, results }, null, 2))
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项（${Math.round((Date.now() - t00) / 1000)} s）；日志 reports/H-logs/journeys.json，截图 reports/H-shots/`)
process.exit(failed.length ? 1 : 0)
