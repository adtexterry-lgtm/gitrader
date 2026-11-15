// SPDX-License-Identifier: CPAL-1.0
// 性能基准（H）：按产品定义 §六 口径实测（p50 / p95；首次 / 热启分开），全部离线（夹具 + 回放），无可见窗口。
//   node scripts/verify/perf.mjs
// 产物：reports/H-logs/perf.json（docs/perf-baseline.md 引用它）。只结束自己起的进程。
import { execFileSync, spawn } from 'node:child_process'
import { cpus, totalmem, release } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { root, startStage, bundleHost, chromium, EDGE, RESERVED } from './stage-lib.mjs'

const LOGS = join(root, 'reports', 'H-logs'); mkdirSync(LOGS, { recursive: true })
const CLI = join(root, 'packages', 'cli', 'dist', 'bin.js')
const MCP = join(root, 'packages', 'mcp', 'dist', 'gitrader-mcp.js')
const PIN = '482913'
const BTC = 'hyperliquid:BTC'
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hperf-'))
const ENGINE_ENV = { GITRADER_ENGINE_CORE_BUNDLE: join(root, 'packages', 'engine-core', 'dist', 'engine-core.mjs') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? Number(a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2)) : null }
const stat = (arr) => ({ n: arr.length, p50: q(arr, 0.5), p95: q(arr, 0.95), max: arr.length ? Number(Math.max(...arr).toFixed(2)) : null })
const out = { generatedAt: new Date().toISOString(), hardware: { cpu: cpus()[0].model, logicalCores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), os: `Windows ${release()}`, node: process.version }, note: '全部离线：Hyperliquid 走 fixtures/hl 夹具 + 回放；不含网络与场所处理时间。' }
const rssOf = (pid) => { try { const t = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }); const m = /"([\d,.]+) K"/.exec(t); return m ? Math.round(Number(m[1].replace(/[,.]/g, '')) / 1024) : null } catch { return null } }

let browser
try {
  browser = await chromium().launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })

  // ---- 1. 冷启 / 热启到可用工作台（真 CLI 单文件 serve，离线；可用 = 浏览器里 __GR_READY__.online）
  const startRuns = []
  const home = join(tmp, 'serve-home')
  execFileSync(process.execPath, [CLI, 'init', '--home', home, '--no-pin'], { windowsHide: true, stdio: 'ignore' })
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now()
    const p = spawn(process.execPath, [CLI, 'serve', '--home', home], { env: { ...process.env, GITRADER_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let so = ''; p.stdout.on('data', (d) => { so += d })
    let url = null
    for (let k = 0; k < 400 && !url; k++) { url = so.match(/http:\/\/127\.0\.0\.1:\d+\/\?launch=\S+/)?.[0] ?? null; if (!url) await sleep(10) }
    const tUrl = performance.now() - t0
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__GR_READY__?.online === true, null, { timeout: 15000 })
    const tReady = performance.now() - t0
    const nav = await page.evaluate(() => ({ first: performance.getEntriesByName('gr-first-render')[0]?.startTime ?? null, load: performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? null, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : null }))
    if (i === 5) { await sleep(10000); out.memoryIdle = { kernelRssMB: rssOf(p.pid), pageJsHeapMB: nav.heapMB, note: '离线 serve：内核进程 RSS（tasklist）+ 工作台页面 JS 堆；不含引擎子进程（离线模式不拉随包引擎）；Edge 渲染进程总 RSS 未单列' } }
    startRuns.push({ run: i === 0 ? 'first' : 'warm', urlMs: Math.round(tUrl), usableMs: Math.round(tReady), firstRenderMs: nav.first && Math.round(nav.first), loadMs: nav.load && Math.round(nav.load) })
    await page.close()
    p.kill(); await new Promise((r) => p.on('close', r)); await sleep(200)
  }
  out.startup = { runs: startRuns, warmUsableMs: stat(startRuns.slice(1).map((r) => r.usableMs)), firstUsableMs: startRuns[0].usableMs, shellFirstRenderMs: stat(startRuns.map((r) => r.firstRenderMs).filter(Boolean)), shellLoadMs: stat(startRuns.map((r) => r.loadMs).filter(Boolean)) }
  console.log('startup', JSON.stringify(out.startup))

  // ---- 舞台：真内核 + 夹具行情（50 ms 一帧回放）
  const S = await startStage({ tmp: join(tmp, 'stage'), hostFile: await bundleHost(tmp), env: ENGINE_ENV, tickMs: 50 })
  try {
    await sleep(1500)
    // 放开会挡住连发的速率与保护器（PIN），只为量开销；放宽本身入账
    const prep = await S.run(`
      const p = await k.auth.setupPinLocalTerminal(${JSON.stringify(PIN)}); k.keystore.unlock(p)
      const o = { actor: 'user:usr_local', actorType: 'human', tool: 'perf:setup', via: 'cli', requestId: '00000000-0000-4000-8000-0000000000d1' }
      k.risk.relax({ limits: { maxOrdersPerMinute: 100000, maxDailyOrders: 100000, duplicateIntentWindowSec: 0, maxDailyNotional: '1000000000' }, protectors: [] }, p, o)
      const acct = k.accounts.list().find((a) => a.mode === 'paper').accountId
      const key = k.agents.createKey({ name: 'perf', host: 'claude-code', tier: 'paper', mandate: { accounts: [acct] } }, p, o)
      return { acct, token: key.token, boot: k.auth.mintBootToken() }`)

    // ---- 2. 行情到 UI 通道：回放帧注入（WS 帧进连接器）→ 内核 → 工作台 WS 通道收到 market.quote
    const ses = await (await fetch(`http://127.0.0.1:${S.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: prep.boot }) })).json()
    const lat = []
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${S.port}/ui`)
      let id = 0
      ws.on('open', () => { ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'auth', params: { token: ses.sessionToken } })); ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'subscribe', params: { topic: 'market.quote', filter: { instrumentId: BTC } } })) })
      ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.method === 'event' && j.params.topic === 'market.quote') lat.push({ at: Date.now(), bid: j.params.data?.bid }) })
      setTimeout(() => { ws.close(); resolve() }, 8000)
    })
    const pushes = await S.run(`return ctx.pushTimes.slice(-400)`)
    // 每条行情事件对应其之前最近的一次注入
    const md = []
    for (const e of lat) { const p = [...pushes].reverse().find((x) => x.at <= e.at); if (p) md.push(e.at - p.at) }
    out.marketToUiChannel = { ...stat(md), events: lat.length, note: '夹具 WS 帧注入连接器 → 内核事件总线 → 工作台 WS /ui 收到 market.quote（同机，Date.now 毫秒精度）。M1 的三块检阅界面里没有行情块，所以不是"到屏"，是"到界面通道"' }
    console.log('market', JSON.stringify(out.marketToUiChannel))

    // ---- 3. 下单本地开销（内核内：授权书 + 风控闸 + 模拟场所，不含传输）
    const inproc = await S.run(`
      const acct = k.accounts.get(${JSON.stringify(prep.acct)})
      const key = k.agents.listKeys().find((x) => x.name === 'perf')
      const ctx0 = { principal: { kind: 'agent', keyId: key.keyId, mandateId: key.mandateId } }
      const xs = []
      for (let i = 0; i < 300; i++) {
        const t = performance.now()
        await k.trading.place({ intent: { accountId: acct.accountId, instrumentId: 'hyperliquid:BTC', side: i % 2 ? 'sell' : 'buy', type: 'market', size: '0.001', leverage: 2, reason: 'perf' } }, { ...ctx0, origin: { actor: 'agent:' + key.keyId, actorType: 'llm-agent', tool: 'order', via: 'mcp', requestId: crypto.randomUUID() } })
        xs.push(performance.now() - t)
      }
      return xs`, 120000)
    out.orderLocalOverheadMs = { ...stat(inproc.slice(20)), note: '内核进程内 k.trading.place：授权书 + 风控预检 + 写意图入账 + 模拟场所撮合 + 回执入账（模式 A，不含 MCP / HTTP 传输与网络）' }
    console.log('order', JSON.stringify(out.orderLocalOverheadMs))

    // ---- 4. MCP 工具调用往返（真 MCP 单文件，stdio → HTTP → 内核）
    const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: { GITRADER_HOME: S.home, GITRADER_AGENT_TOKEN: prep.token, SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, stderr: 'ignore' })
    const client = new Client({ name: 'perf', version: '0' }, { capabilities: {} })
    await client.connect(transport)
    const ro = [], ord = []
    for (let i = 0; i < 220; i++) { const t = performance.now(); await client.callTool({ name: 'market', arguments: { action: 'quote', instrumentId: BTC } }); ro.push(performance.now() - t) }
    for (let i = 0; i < 120; i++) { const t = performance.now(); await client.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: prep.acct, instrumentId: BTC, side: i % 2 ? 'sell' : 'buy', type: 'market', size: '0.001', leverage: 2, reason: 'perf mcp' } } }); ord.push(performance.now() - t) }
    await client.close()
    out.mcpRoundTripMs = { readOnlyQuote: stat(ro.slice(20)), paperOrderPlace: stat(ord.slice(20)), note: '宿主侧 callTool 发出 → 结果返回（含 stdio、MCP 进程、HTTP 回环、内核处理）' }
    console.log('mcp', JSON.stringify(out.mcpRoundTripMs))

    // ---- 5. 引擎决策（宿主侧）：已在 J13 / bench/engine 量；这里记 HL 权重空载与工作台打开时的占用
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(await S.boot(), { waitUntil: 'load' })
    await sleep(6000)
    out.hlWeight = { withWorkbenchOpen: await S.run(`return k.bus.budget('hyperliquid').usage()`), note: '只有纸面账户；有实盘账户时的占用见 reports/H-logs/budget-samples-live.json（修补前 5 s 打满 60%，修补后稳定 32%）' }
    out.memoryStage = { kernelRssMB: Math.round((await S.run(`return process.memoryUsage().rss`)) / 2 ** 20), engineRssMB: rssOf(await S.run(`return k.engines.status().find((e) => e.id === 'gitrader-core')?.pid ?? 0`)), pageJsHeapMB: await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : null) }
    await page.close()
  } finally { await S.stop() }
} catch (e) {
  out.error = String(e?.stack ?? e).slice(0, 800)
  console.log('ERROR', out.error)
} finally {
  try { await browser?.close() } catch { /* */ }
  rmSync(tmp, { recursive: true, force: true })
}
void RESERVED
writeFileSync(join(LOGS, 'perf.json'), JSON.stringify(out, null, 2))
console.log('wrote reports/H-logs/perf.json')
