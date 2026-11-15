// SPDX-License-Identifier: CPAL-1.0
// 重截 UNIGIT 配方 showcase 的四张截图（1600×1000）。真内核 + 夹具行情（不联网），干净数据：Claude Code / Codex 两把钥匙，纸面账户。
//   GITRADER_PLAYWRIGHT=<playwright-core 目录> GITRADER_ENGINE_CORE_BUNDLE=<engine-core.mjs> node shoot-showcase.mjs [outDir]
// 浏览器路径只认环境变量 GITRADER_EDGE（见 scripts/verify/stage-lib.mjs）。输出默认写到 ../official.gitrader/screens。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStage, bundleHost, chromium, EDGE } from '../../../scripts/verify/stage-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? join(here, '..', 'official.gitrader', 'screens'))
mkdirSync(out, { recursive: true })
const PIN = String(100000 + Math.floor(Math.random() * 899999)) // 每次随机，不出现在图里
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-showcase-'))
let S = null, browser = null
try {
  S = await startStage({ tmp: join(tmp, 'stage'), hostFile: await bundleHost(tmp), env: { GITRADER_ENGINE_CORE_BUNDLE: process.env.GITRADER_ENGINE_CORE_BUNDLE ?? '' } })
  await sleep(1500)
  // PIN + 两把钥匙（Claude Code 纸面、Codex 需确认）
  const keys = await S.run(`
    await k.pin.setup(${JSON.stringify(PIN)})
    const proof = await k.auth.pinProofLocalTerminal(${JSON.stringify(PIN)})
    const acct = k.accounts.list().find((a) => a.mode === 'paper').accountId
    const origin = { actor: 'user:usr_local', actorType: 'human', tool: 'cli:keys.new', via: 'cli', requestId: crypto.randomUUID() }
    const a = k.agents.createKey({ name: 'Claude Code', host: 'claude-code', tier: 'paper', mandate: { accounts: [acct] } }, proof, origin)
    const b = k.agents.createKey({ name: 'Codex', host: 'codex', tier: 'confirm', mandate: { accounts: [acct], venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['hyperliquid:BTC'], limits: { maxOrderNotional: '500', maxDailyNotional: '2000' } } }, proof, { ...origin, requestId: crypto.randomUUID() })
    return { acct, claude: { keyId: a.key.keyId, mandateId: a.mandate.mandateId }, codex: { keyId: b.key.keyId } }`)
  const agentCode = (tool) => `{ principal: { kind: 'agent', keyId: ${JSON.stringify(keys.claude.keyId)}, mandateId: ${JSON.stringify(keys.claude.mandateId)} }, origin: { actor: 'agent:${keys.claude.keyId}', actorType: 'llm-agent', tool: '${tool}', via: 'mcp', requestId: crypto.randomUUID() } }`
  const BTC = 'hyperliquid:BTC'
  browser = await chromium().launch({ executablePath: EDGE, headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.goto(await S.boot(), { waitUntil: 'load' })
  await page.waitForFunction(() => window.__GR_READY__ && window.__GR_READY__.online === true, null, { timeout: 15000 })
  await page.waitForSelector('.gb-pos, .gb-agent, .gb-risk', { timeout: 15000 })
  await sleep(2500)
  const shot = (name) => page.screenshot({ path: join(out, name) })
  // 1 first-open
  await shot('first-open.png')
  // 2 paper-fill：Claude Code 下 3 笔（两次开多 + 一次减仓），理由正常中文
  const place = async (intent) => S.run(`return (await k.trading.place({ intent: { accountId: ${JSON.stringify(keys.acct)}, instrumentId: '${BTC}', type: 'market', ${intent} } }, ${agentCode('order')})).order?.status`)
  const r1 = await place(`side: 'buy', size: '0.010', leverage: 2, reason: '资金费转正，纸面试多一笔'`)
  await sleep(5600) // 开仓后冷却 5 秒
  const r2 = await place(`side: 'buy', size: '0.005', leverage: 2, reason: '回踩后企稳，小仓位加一笔'`)
  await sleep(5600) // 开仓后冷却 5 秒
  const r3 = await S.run(`return (await k.trading.closePosition({ accountId: ${JSON.stringify(keys.acct)}, instrumentId: '${BTC}', size: '0.004', reason: '跌破均线，先减掉一部分多仓' }, ${agentCode('order')})).order?.status`)
  console.log('orders:', r1, r2, r3)
  await sleep(3000)
  await shot('paper-fill.png')
  // 4 palette
  await page.keyboard.press('Control+K'); await page.waitForSelector('.gr-palette'); await sleep(500)
  await shot('palette.png')
  await page.keyboard.press('Escape'); await sleep(500)
  // 3 takeover：状态条「接管」→「停止新开仓」→ PIN → 风险块显示「只减仓」（不全平）
  await page.click('[data-act="takeover"]'); await page.waitForSelector('.gb-tkcard', { timeout: 5000 }); await sleep(500)
  await page.click('.gb-tkcard [data-act="takeover-halt_new"]')
  await page.click('[data-act="takeover-halt_new-confirm"]').catch(() => undefined)
  await sleep(600)
  if (await page.$('.gr-pin')) { await page.fill('.gr-pin input', PIN); await page.click('.gr-pin .gr-btn--primary') } // 停止新开仓不一定要 PIN
  await page.waitForFunction(() => document.querySelector('.gb-risk')?.getAttribute('data-state') === 'REDUCING', null, { timeout: 8000 })
  await page.mouse.move(800, 600); await page.waitForFunction(() => !document.querySelector('.gr-toast, [role="status"]'), null, { timeout: 12000 }).catch(() => undefined); await sleep(1500)
  await shot('takeover.png')
  console.log('done ->', out)
} finally {
  try { await browser?.close() } catch { /* */ }
  try { await S?.stop() } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
}
