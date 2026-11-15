// SPDX-License-Identifier: CPAL-1.0
// MCP 冒烟：起一个内核（临时 GITRADER_HOME + 模拟场所吃夹具行情，端口自动避开 8765/8188/9872/9222/8080/5198/4184/14609/47831）
// → stdio 拉起 gitrader-mcp → 数工具 → 调只读工具 → 纸面下单 → 查账本 origin → 提交实盘提案 / 预览实盘开仓，断言被拦并返回规则名
// → 在内核里降级钥匙，断言 tools/list_changed 到达、工具清单收缩 → 收尾（只结束自己起的进程，按句柄，不按进程名）。
//
// 用法：node scripts/verify/mcp.mjs [--keep]   （--keep：保留临时目录，便于排查）
// 不联网、不连真数据、不弹窗。内核与 MCP 都用 esbuild 现场打成临时 ESM（不依赖 TS 运行时、不写仓库里的 dist）。
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const keep = process.argv.includes('--keep')
const REQUIRE_BANNER = "import { createRequire as __gtCreateRequire } from 'node:module'; const require = __gtCreateRequire(import.meta.url);"
const RESERVED = [8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831]

let failures = 0
const log = (ok, name, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const check = (name, cond, detail) => log(Boolean(cond), name, cond ? '' : detail)
const text = (r) => { try { return JSON.parse(r.content[0].text) } catch { return r.content?.[0]?.text } }

// ---------------------------------------------------------------- 内核宿主（打成临时 ESM 后在子进程里跑）
const HOST_SRC = `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Kernel, initHome } from '@gitrader/kernel'
import { PaperVenue } from '@gitrader/venue-paper'

const [home, fixturePath] = process.argv.slice(2)
const PIN = '482916'
const BTC = 'hyperliquid:BTC'
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'))
const f0 = fx.frames[0]

const inst = {
  instrumentId: BTC, venue: 'hyperliquid', symbol: 'BTC', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USDC', settle: 'USDC', settlement: 'linear',
  contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto', marketGroup: null, status: 'trading', price: { sigFigs: 5, maxDecimals: 1 },
  size: { step: '0.00001', decimals: 5, min: '0.00001' }, minNotional: '10', maxLeverage: 40, marginModes: ['cross'],
  orderTypes: ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'], tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'],
  fundingIntervalMs: 3600000, fees: { maker: '0.00015', taker: '0.00045', source: 'assumed' }, updatedAt: 0,
}
const caps = { venue: 'hyperliquid', environments: ['mainnet', 'testnet'], instrumentKinds: ['perp'], orderTypes: { market: 'emulated', limit: 'native' }, tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'], signers: { type: 'api-wallet', withdrawCapable: false } }

// 行情来自夹具（真实 BTC 收盘价 + 真实盘口形状），时间戳用"现在"，避免被陈旧价保护拦下
class FixtureMarket {
  venue = 'hyperliquid'
  environment = 'testnet'
  describe() { return caps }
  listInstruments() { return [inst] }
  getInstrument(id) { return id === BTC ? inst : undefined }
  quote(id) {
    const b = f0.books[id]
    if (!b) return undefined
    return { instrumentId: id, ts: Date.now(), bid: b.bids[0][0], ask: b.asks[0][0], last: f0.marks[id], stale: false, ageMs: 0 }
  }
  async book(id, depth = 20) {
    const b = f0.books[id]
    return { instrumentId: id, ts: Date.now(), bids: b.bids.slice(0, depth).map(([price, size]) => ({ price, size })), asks: b.asks.slice(0, depth).map(([price, size]) => ({ price, size })) }
  }
  async candles() { return [] }
  async context(id) { return { instrumentId: id, ts: Date.now(), markPrice: f0.marks[id], midPrice: f0.marks[id], fundingRate: f0.funding[id], fundingIntervalMs: 3600000 } }
  subscribe() { return () => {} }
  status() { return { venue: 'hyperliquid', environment: 'testnet', ts: Date.now(), wsState: 'connected', stale: false, source: 'ws', lastMessageTs: Date.now() } }
}

// 配置：在默认纸面账户之外加一个实盘账户（只用来验证拦截；没有任何真实凭据，签名器从不会被调用）
const first = initHome(home)
const cfg = JSON.parse(readFileSync(first.paths.config, 'utf8'))
if (!cfg.accounts.some((a) => a.alias === 'live')) cfg.accounts.push({ alias: 'live', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'w-none' })
writeFileSync(first.paths.config, JSON.stringify(cfg, null, 2))

const k = await Kernel.create({ home, log: () => {} })
const market = new FixtureMarket()
const sim = new PaperVenue({ market, clock: () => Date.now() })
k.registerConnector(sim)
// 实盘账户的场所替身：另一个模拟场所实例，对内核声明为 hyperliquid（只回答账户与行情查询，下单前就被策略拦下）
const standIn = new PaperVenue({ market, clock: () => Date.now() })
const live = new Proxy(standIn, { get(t, p) { if (p === 'venue') return 'hyperliquid'; const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v } })
const paperAcct = k.accounts.list().find((a) => a.mode === 'paper')
const liveAcct = k.accounts.list().find((a) => a.mode === 'live')
standIn.createAccount({ accountId: liveAcct.accountId, initialBalance: '5000', ccy: 'USDC' })
k.registerConnector(live)

const proof = await k.auth.setupPinLocalTerminal(PIN)
k.keystore.unlock(proof)
const origin = { actor: 'user:usr_local', actorType: 'human', tool: 'smoke:setup', requestId: '00000000-0000-4000-8000-000000000001', via: 'cli' }
const accounts = [paperAcct.accountId, liveAcct.accountId]
const lim = { maxOrderNotional: '500', maxDailyNotional: '2000', maxDailyLoss: '100', autoMaxOrderNotional: '300' }
const mk = (name, tier, extra = {}) => k.agents.createKey({ name, host: 'claude-code', tier, mandate: { accounts, ...extra } }, proof, origin)
const keys = {
  paper: mk('smoke-paper', 'paper'),
  readonly: mk('smoke-readonly', 'read_only'),
  confirm: mk('smoke-confirm', 'confirm', { venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '500', maxDailyNotional: '2000' } }),
  auto: mk('smoke-auto', 'auto_limited', { venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: lim }),
}
const started = await k.start({})
const tokens = Object.fromEntries(Object.entries(keys).map(([n, v]) => [n, v.token]))
const mandates = Object.fromEntries(Object.entries(keys).map(([n, v]) => [n, v.mandate.mandateId]))
process.stdout.write(JSON.stringify({ ready: true, port: started.port, tokens, mandates, paperAccount: paperAcct.accountId, liveAccount: liveAcct.accountId, pid: process.pid }) + '\\n')

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  try {
    if (m.cmd === 'revoke') {
      k.agents.revokeMandate(mandates[m.who], k.auth.sessionProof(k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)), origin)
      process.stdout.write(JSON.stringify({ done: 'revoke', who: m.who }) + '\\n')
    } else if (m.cmd === 'ledger') {
      const rows = k.ledger.query({ limit: 500 })
      process.stdout.write(JSON.stringify({ done: 'ledger', head: k.ledger.head(), verify: k.ledger.verify(), liveOrders: k.orders.list({ accountId: liveAcct.accountId, limit: 50 }).length }) + '\\n')
      void rows
    } else if (m.cmd === 'stop') {
      await k.stop()
      process.stdout.write(JSON.stringify({ done: 'stop' }) + '\\n')
      process.exit(0)
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }) + '\\n')
  }
})
`

async function bundleTo(outfile, opts) {
  await build({ absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, banner: { js: REQUIRE_BANNER }, external: ['node:*'], logLevel: 'error', ...opts })
}

// ---------------------------------------------------------------- 主流程
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-mcp-smoke-'))
const home = join(tmp, 'home')
let host
const clients = []
const hostLines = []
const waiters = []
const hostSend = (obj) => host.stdin.write(JSON.stringify(obj) + '\n')
const hostNext = (pred, ms = 15000) => new Promise((res, rej) => {
  const found = hostLines.find(pred)
  if (found) return res(found)
  const t = setTimeout(() => rej(new Error('timeout waiting for the kernel host')), ms)
  waiters.push({ pred, res: (v) => { clearTimeout(t); res(v) } })
})

async function connectMcp(mcpPath, token) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: { GITRADER_HOME: home, GITRADER_AGENT_TOKEN: token }, stderr: 'pipe' })
  const client = new Client({ name: 'gitrader-smoke-host', version: '0' }, { capabilities: {} })
  const state = { changed: 0, stderr: '' }
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { state.changed += 1 })
  await client.connect(transport)
  transport.stderr?.on('data', (d) => { state.stderr += d.toString() })
  clients.push(client)
  return { client, state }
}

try {
  await bundleTo(join(tmp, 'kernel-host.mjs'), { stdin: { contents: HOST_SRC, resolveDir: root, sourcefile: 'mcp-kernel-host.ts', loader: 'ts' } })
  await bundleTo(join(tmp, 'gitrader-mcp.mjs'), { entryPoints: [join(root, 'packages', 'mcp', 'src', 'bin.ts')] })
  const fixture = join(root, 'fixtures', 'hl', 'replay', 'btc-1m.json')

  host = spawn(process.execPath, [join(tmp, 'kernel-host.mjs'), home, fixture], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GITRADER_HOME: home } })
  let hostErr = ''
  host.stderr.on('data', (d) => { hostErr += d.toString() })
  createInterface({ input: host.stdout }).on('line', (line) => {
    let o; try { o = JSON.parse(line) } catch { return }
    hostLines.push(o)
    for (const w of waiters.splice(0)) { if (w.pred(o)) w.res(o); else waiters.push(w) }
  })
  const ready = await hostNext((o) => o.ready).catch((e) => { throw new Error(`${e.message}\n${hostErr.slice(-800)}`) })
  check('内核起来了，端口避开固定端口', ready.port >= 47900 && !RESERVED.includes(ready.port), `port ${ready.port}`)
  console.log(`      kernel pid ${ready.pid}, port ${ready.port}, home ${home}`)

  const mcpPath = join(tmp, 'gitrader-mcp.mjs')

  // 1. 默认纸面钥匙：工具数
  const paper = await connectMcp(mcpPath, ready.tokens.paper)
  const { tools } = await paper.client.listTools()
  const names = tools.map((t) => t.name)
  check('默认（纸面）钥匙看到 16 个工具', tools.length === 16, `got ${tools.length}: ${names.join(',')}`)
  check('工具里没有批准 / 拒绝 / 恢复类', !names.some((n) => /approve|reject|resume|relax/.test(n)), names.join(','))
  check('默认没有 workspace（要人打开布局开关）', !names.includes('workspace'))
  check('order 的描述写明 LLM 实盘开仓默认被拒', /LLM 实盘开仓默认被策略拒绝/.test(tools.find((t) => t.name === 'order')?.description ?? ''))
  check('握手说明提到默认受大模型实盘开仓保护', /大模型实盘开仓默认被策略拒绝/.test(paper.client.getInstructions() ?? ''))

  // 2. 只读工具
  const quote = text(await paper.client.callTool({ name: 'market', arguments: { action: 'quote', instrumentId: 'hyperliquid:BTC' } }))
  check('market.quote 返回夹具里的 BTC 价', quote && quote.instrumentId === 'hyperliquid:BTC' && quote.last === 80677, JSON.stringify(quote))
  const groups = text(await paper.client.callTool({ name: 'discover', arguments: { action: 'groups' } }))
  check('discover.groups 说明 order 已加载', groups?.groups?.E?.[0]?.loaded === true, JSON.stringify(groups?.groups?.E))
  const summary = text(await paper.client.callTool({ name: 'account', arguments: { action: 'summary', accountId: ready.paperAccount } }))
  check('account.summary 看到纸面账户权益', summary && summary.accountId === ready.paperAccount && Number(summary.equity) > 0, JSON.stringify(summary))

  // 3. 纸面下单 → 成交
  const placed = text(await paper.client.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: ready.paperAccount, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, reason: 'smoke: paper entry' } } }))
  check('纸面市价单成交', placed?.order?.status === 'filled', JSON.stringify(placed).slice(0, 300))
  const o = placed?.order?.origin
  check('订单 origin：llm-agent / order / mcp / UUID', o && o.actorType === 'llm-agent' && o.tool === 'order' && o.via === 'mcp' && /^[0-9a-f-]{36}$/.test(o.requestId) && /^agent:ak_/.test(o.actor), JSON.stringify(o))

  // 3b. clientOrderId 必带：MCP 生成并随单回显；"结果未知"后的安全路径——按它查得到原单，带同一个再发不会下第二笔
  const cloid = placed?.order?.clientOrderId
  check('MCP 为下单补了 clientOrderId（32 位十六进制）并随单回显', /^[0-9a-f]{32}$/.test(cloid ?? ''), String(cloid))
  const orderDesc = tools.find((t) => t.name === 'order')?.description ?? ''
  check('order 描述写明"结果未知勿重发"', /结果未知勿重发/.test(orderDesc), orderDesc)
  const lookup = text(await paper.client.callTool({ name: 'ledger', arguments: { action: 'trace', id: cloid } }))
  check('按 clientOrderId 用 ledger.trace 查得到原单', lookup?.items?.some((e) => e.type === 'order.accepted'), JSON.stringify(lookup?.items?.map((e) => e.type)))
  const again = text(await paper.client.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: ready.paperAccount, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, reason: 'smoke: paper entry', clientOrderId: cloid } } }))
  check('带同一个 clientOrderId 重发返回原单，不重复下单', again?.order?.orderId === placed?.order?.orderId, JSON.stringify(again).slice(0, 200))

  // 4. 账本里查得到，带 origin
  const led = text(await paper.client.callTool({ name: 'ledger', arguments: { action: 'query', filter: { 'origin.actorType': 'llm-agent', accountId: ready.paperAccount }, limit: 50 } }))
  const intentRow = led?.items?.find((e) => e.type === 'order.intent')
  check('账本 order.intent 带同一个 requestId 与 llm-agent', intentRow && intentRow.origin.requestId === o?.requestId && intentRow.origin.actorType === 'llm-agent', JSON.stringify(intentRow?.origin))
  const trace = text(await paper.client.callTool({ name: 'ledger', arguments: { action: 'trace', id: placed?.order?.orderId } }))
  check('ledger.trace 追得到下单全程', trace?.items?.some((e) => e.type === 'order.accepted') && trace.items.some((e) => e.type === 'fill'), JSON.stringify(trace?.items?.map((e) => e.type)))

  // 5. 实盘：L3 预览被 denyLlmLiveEntries 拦住（规则名原样返回）；L2 提案进待批
  const auto = await connectMcp(mcpPath, ready.tokens.auto)
  const liveIntent = { accountId: ready.liveAccount, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, reason: 'smoke: live entry' }
  const pv = text(await auto.client.callTool({ name: 'order', arguments: { action: 'preview', intent: liveIntent } }))
  const hit = pv?.precheck?.ruleHits?.find((h) => h.code === 'LLM_LIVE_ENTRY')
  check('L3 实盘开仓预览被默认策略拒绝，返回 LLM_LIVE_ENTRY 与规则名', pv?.precheck?.verdict === 'deny' && hit && /#denyLlmLiveEntries$/.test(hit.ruleId) && !pv.confirmToken, JSON.stringify(pv?.precheck?.ruleHits))
  const bad = await auto.client.callTool({ name: 'order', arguments: { action: 'place', confirmToken: 'ctk_forged.token' } })
  check('伪造 confirmToken 被拒（1008）', bad.isError === true && text(bad)?.error?.code === 1008, JSON.stringify(text(bad)))

  const confirm = await connectMcp(mcpPath, ready.tokens.confirm)
  const direct = await confirm.client.callTool({ name: 'order', arguments: { action: 'preview', intent: liveIntent } })
  check('L2 钥匙不能直接预览 / 下实盘单（MANDATE_LEVEL）', direct.isError === true && text(direct)?.error?.code === 2003, JSON.stringify(text(direct)))
  const prop = text(await confirm.client.callTool({ name: 'propose', arguments: { action: 'order', accountId: ready.liveAccount, intents: [{ instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.002', price: '80000', tif: 'gtc', leverage: 2 }], reason: 'smoke: live proposal' } }))
  check('L2 实盘提案进待批，带票号，来源 llm-agent / propose', prop?.status === 'pending' && /^T-\d{8}-\d{4}$/.test(prop.ticket) && prop.origin?.actorType === 'llm-agent' && prop.origin?.tool === 'propose', JSON.stringify(prop).slice(0, 300))
  const apv = await confirm.client.callTool({ name: 'proposals', arguments: { action: 'approve', proposalId: prop?.proposalId } })
  check('工具面上没有批准动作', apv.isError === true && text(apv)?.error?.code === -32602, JSON.stringify(text(apv)))
  hostSend({ cmd: 'ledger' })
  const lg = await hostNext((x) => x.done === 'ledger')
  check('场所没有收到任何实盘单；账本哈希链完整', lg.liveOrders === 0 && lg.verify?.ok === true, JSON.stringify(lg))

  // 6. 只读钥匙：13 个工具；动态降级 → tools/list_changed
  const ro = await connectMcp(mcpPath, ready.tokens.readonly)
  check('只读钥匙 13 个工具', (await ro.client.listTools()).tools.length === 13)
  hostSend({ cmd: 'revoke', who: 'paper' })
  await hostNext((x) => x.done === 'revoke')
  const after = await paper.client.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: ready.paperAccount, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', reason: 'smoke: after revoke' } } })
  check('授权书撤销后下单被拒', after.isError === true, JSON.stringify(text(after)))
  await new Promise((r) => setTimeout(r, 300))
  check('收到 tools/list_changed，清单收缩到 13', paper.state.changed >= 1 && (await paper.client.listTools()).tools.length === 13, `changed=${paper.state.changed}`)

  // 7. 日志里没有令牌
  const allStderr = [paper, auto, confirm, ro].map((c) => c.state.stderr).join('\n') + hostErr
  check('各进程 stderr 不含令牌', !/gtk_[A-Z2-7]{20,}/.test(allStderr))
} catch (e) {
  failures += 1
  console.log(`FAIL  smoke aborted — ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
} finally {
  // 收尾：只结束自己起的——MCP 子进程由各自 transport 的句柄结束，内核宿主按 spawn 返回的句柄
  for (const c of clients) { try { await c.close() } catch { /* 已关 */ } }
  if (host && host.exitCode === null) {
    try { hostSend({ cmd: 'stop' }); await Promise.race([hostNext((x) => x.done === 'stop', 5000).catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]) } catch { /* 下面兜底 */ }
    await new Promise((r) => setTimeout(r, 300))
    if (host.exitCode === null) host.kill()
  }
  if (!keep) rmSync(tmp, { recursive: true, force: true })
  else console.log(`      kept ${tmp}`)
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall MCP smoke checks passed')
process.exit(failures ? 1 : 0)
