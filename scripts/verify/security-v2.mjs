// SPDX-License-Identifier: CPAL-1.0
// 安全复测（H，v2）：第二轮加固后的三项——口令 KDF + 设备密钥（含旧格式 pin.json 迁移）、MCP 写超时 = 结果未知、service 令牌面。
//   node scripts/verify/security-v2.mjs   → reports/H-logs/v2/security-v2.json
import { randomBytes, scryptSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { root, startStage, bundleHost, checker } from './stage-lib.mjs'

const OUT = join(root, 'reports', 'H-logs', 'v2'); mkdirSync(OUT, { recursive: true })
const PIN = '48291357'
const { results, check } = checker()
const facts = {}
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hsec2-'))
const ENV = { GITRADER_STAGE_NO_ENGINE: '1' }
let S
const op = async (name, params, headers) => { const r = await fetch(`http://127.0.0.1:${S.port}/api/op/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ params: params ?? {} }) }); let j = null; try { j = await r.json() } catch { /* */ } return { status: r.status, json: j } }
try {
  // ---- 1. 离线穷举成本：新参数单次 scrypt 实测
  const pf = { N: 1 << 17, r: 8, p: 1 }
  const t0 = performance.now(); for (let i = 0; i < 5; i++) scryptSync('48291357', randomBytes(16), 32, { ...pf, maxmem: 256 * pf.N * pf.r }); const perTry = (performance.now() - t0) / 5
  const t1 = performance.now(); for (let i = 0; i < 5; i++) scryptSync('482913', randomBytes(16), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 2 ** 20 }); const perTryOld = (performance.now() - t1) / 5
  const cores = cpus().length
  // N=2^17 每次 128 MB：并行数受内存限制（这台 63 GB → 约 400 路；按物理核 24 计）
  facts.kdf = { perTryMs: Math.round(perTry), perTryOldMs: Math.round(perTryOld), cores,
    sixDigitHoursOld16: +(1e6 * perTryOld / 1000 / 3600 / 16).toFixed(2), sixDigitHours16: +(1e6 * perTry / 1000 / 3600 / 16).toFixed(2), sixDigitHours24: +(1e6 * perTry / 1000 / 3600 / cores).toFixed(2),
    tenDigitYears24: +(1e10 * perTry / 1000 / 3600 / 24 / 365 / cores).toFixed(1) }
  check('KDF：单次 scrypt（N=2^17）实测', perTry > perTryOld * 2, JSON.stringify(facts.kdf))

  // ---- 2. 新建 home：pin.json version 2 + 设备密钥（Windows = DPAPI）
  S = await startStage({ tmp: join(tmp, 'a'), hostFile: await bundleHost(tmp), env: ENV })
  const secretHex = randomBytes(32).toString('hex')
  const a = await S.run(`
    const p = await k.auth.setupPinLocalTerminal(${JSON.stringify(PIN)}); k.keystore.unlock(p)
    const w = k.keystore.import(p, { name: 'v2-wallet', privateKey: ${JSON.stringify(secretHex)}, network: 'testnet' }); k.keystore.lock()
    return { address: w.address, version: k.pin.version(), provider: k.paths.deviceKey }`)
  const dk = JSON.parse(readFileSync(join(S.home, 'keys', 'device.key.json'), 'utf8'))
  facts.deviceKey = { provider: dk.provider, blobLen: dk.blob.length }
  check('新建：pin.json 为 version 2，设备密钥由 DPAPI（CurrentUser）包裹', a.version === 2 && dk.provider === 'dpapi-currentuser', JSON.stringify({ v: a.version, provider: dk.provider }))
  const pinFile = JSON.parse(readFileSync(join(S.home, 'keys', 'pin.json'), 'utf8'))
  const pinOnly = scryptSync(PIN, Buffer.from(pinFile.kdf.salt, 'base64'), 32, { N: pinFile.kdf.N, r: pinFile.kdf.r, p: pinFile.kdf.p, maxmem: 256 * pinFile.kdf.N * pinFile.kdf.r })
  const { createHash } = await import('node:crypto')
  const vOf = (key) => createHash('sha256').update('gitrader-pin-verify/1').update(key).digest('base64')
  check('离线：只拿 pin.json，用正确 PIN 算出的校验值也对不上（缺设备密钥）', vOf(pinOnly) !== pinFile.verifier)
  // 拷走 keys/ 但不带 device.key.json：正确 PIN 也解不开
  await S.stop()
  const copyHome = join(tmp, 'copy-home'); mkdirSync(join(copyHome, 'keys'), { recursive: true })
  for (const f of ['pin.json', 'keystore.json', 'install-key.json']) copyFileSync(join(S.home, 'keys', f), join(copyHome, 'keys', f))
  const S0 = S
  S = await startStage({ tmp: join(tmp, 'c'), home: copyHome, hostFile: join(tmp, 'stage-host.mjs'), env: ENV })
  const copyTry = await S.run(`try { await k.auth.pinProofLocalTerminal(${JSON.stringify(PIN)}); return 'UNLOCKED' } catch (e) { return e.problem?.message ?? String(e) }`)
  check('拷走 keys/（不带 device.key.json）到别的 home：正确 PIN 也解不开', /device key/.test(copyTry), copyTry)
  await S.stop()
  // 带上 device.key.json 但换一个 Windows 用户 / 机器：DPAPI 解不开（本机无法造另一个用户，只能记录）
  facts.dpapiOtherUser = '未实测（本机无第二个 Windows 用户）；依据 DPAPI CurrentUser 语义'
  S = S0

  // ---- 3. 旧格式 pin.json（version 1，无设备密钥）：首次验证即升级并换钥，私钥不丢
  S = await startStage({ tmp: join(tmp, 'legacy'), hostFile: join(tmp, 'stage-host.mjs'), env: ENV })
  const legacySecret = randomBytes(32).toString('hex')
  const lg = await S.run(`
    const PS = k.pin.constructor
    const legacy = new PS(k.paths.pin, k.clock, { N: 1 << 15, r: 8, p: 1 })   // 第一轮的格式：只有 PIN 的 scrypt、旧参数、无设备密钥
    await legacy.setup(${JSON.stringify(PIN)})
    const cb = k.pin.onLegacyUpgrade; k.pin.onLegacyUpgrade = undefined
    const p = await k.auth.pinProofLocalTerminal(${JSON.stringify(PIN)}); k.keystore.unlock(p)
    const w = k.keystore.import(p, { name: 'legacy-wallet', privateKey: ${JSON.stringify(legacySecret)}, network: 'testnet' }); k.keystore.lock()
    k.pin.onLegacyUpgrade = cb
    return { version: JSON.parse((await import('node:fs')).readFileSync(k.paths.pin, 'utf8')).version, address: w.address, walletId: w.walletId }`)
  check('造出旧格式：pin.json version 1，密钥库里一只旧主密钥加密的钱包', lg.version === 1, JSON.stringify(lg))
  // 旧格式文件被拷走（升级前）：只凭 pin.json 就能离线验证 PIN —— 这是迁移要消灭的状态
  const legacyFile = JSON.parse(readFileSync(join(S.home, 'keys', 'pin.json'), 'utf8'))
  const lk = scryptSync(PIN, Buffer.from(legacyFile.kdf.salt, 'base64'), 32, { N: legacyFile.kdf.N, r: legacyFile.kdf.r, p: legacyFile.kdf.p, maxmem: 64 * 2 ** 20 })
  check('（记录）version 1 的 pin.json 无需设备密钥即可离线验证 PIN', vOf(lk) === legacyFile.verifier)
  await S.stop()
  S = await startStage({ tmp: join(tmp, 'legacy'), home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: ENV })
  const svc = JSON.parse(readFileSync(join(S.home, 'service.json'), 'utf8')).token
  const H = { authorization: `Bearer ${svc}` }
  const un = await op('keystore.unlock', {}, { ...H, 'x-gitrader-pin': PIN })
  const after = JSON.parse(readFileSync(join(S.home, 'keys', 'pin.json'), 'utf8'))
  const signOk = await S.run(`const w = k.keystore.list().find((x) => x.name === 'legacy-wallet'); const s = k.keystore.getSigner(w.walletId); return { address: w.address, unlocked: k.keystore.isUnlocked(), signer: !!s, upgraded: k.ledger.query({ types: ['annotation'], limit: 20 }).some((e) => e.payload?.upgraded === 'v1->v2') }`)
  check('旧格式 + 正确 PIN 解锁：成功，pin.json 就地升级为 version 2（N=2^17 + 设备密钥），并入账', un.status === 200 && after.version === 2 && after.kdf.N === 131072 && signOk.upgraded, JSON.stringify({ status: un.status, v: after.version, N: after.kdf.N, signOk }))
  check('迁移后旧钱包仍可用（地址不变，签名器可取）', signOk.address === lg.address && signOk.signer === true, JSON.stringify(signOk))
  const lk2 = scryptSync(PIN, Buffer.from(after.kdf.salt, 'base64'), 32, { N: after.kdf.N, r: after.kdf.r, p: after.kdf.p, maxmem: 256 * after.kdf.N * after.kdf.r })
  check('迁移后：只凭 pin.json 离线验证不了 PIN', vOf(lk2) !== after.verifier)
  facts.legacyResidual = '升级前已经被拷走的 version 1 文件仍可离线穷举（旧 N=2^15）；迁移只能保护之后的副本——需要在发布说明里提醒老用户改 PIN / 轮换 API 钱包'

  // ---- 4. 中危 1：MCP 写超时 = 结果未知（3006），带同一个 clientOrderId 重试返回原单
  const prep = await S.run(`
    const p = await k.auth.pinProofLocalTerminal(${JSON.stringify(PIN)})
    const acct = k.accounts.list().find((a) => a.mode === 'paper').accountId
    const key = k.agents.createKey({ name: 'slow', host: 'claude-code', tier: 'paper', mandate: { accounts: [acct] } }, p, { actor: 'user:usr_local', actorType: 'human', tool: 'sec2', via: 'cli', requestId: '00000000-0000-4000-8000-0000000000e1' })
    const orig = k.trading.place.bind(k.trading); let delayed = false
    k.trading.place = async (...a) => { if (!delayed) { delayed = true; await new Promise((r) => setTimeout(r, 95_000)) } return orig(...a) }
    return { acct, token: key.token }`)
  const tr = new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages', 'cli', 'dist', 'gitrader-mcp.js')], env: { GITRADER_HOME: S.home, GITRADER_AGENT_TOKEN: prep.token, SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, stderr: 'ignore' })
  const cl = new Client({ name: 'sec2', version: '0' }, { capabilities: {} })
  await cl.connect(tr)
  const cloid = randomBytes(16).toString('hex')
  const tA = Date.now()
  const r1 = await cl.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: prep.acct, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, clientOrderId: cloid, reason: 'slow kernel' } } }, undefined, { timeout: 200_000 })
  const t1s = Math.round((Date.now() - tA) / 1000)
  const e1 = JSON.parse(r1.content[0].text)
  check('MCP 下单超过写超时：返回 3006 结果未知、不要重发、带 clientOrderId 与查法', r1.isError && e1.error?.code === 3006 && JSON.stringify(e1).includes(cloid), `${t1s}s ${JSON.stringify(e1).slice(0, 400)}`)
  await new Promise((r) => setTimeout(r, 8000))
  const r2 = await cl.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: prep.acct, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, clientOrderId: cloid, reason: 'slow kernel' } } }, undefined, { timeout: 200_000 })
  const d2 = JSON.parse(r2.content[0].text)
  const r3 = await cl.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: prep.acct, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, clientOrderId: cloid, reason: 'slow kernel (retry, reworded)' } } })
  facts.retryReworded = JSON.parse(r3.content[0].text)
  const n = await S.run(`return k.orders.list({ limit: 50 }).filter((o) => o.clientOrderId === ${JSON.stringify(cloid)}).length`)
  check('带同一个 clientOrderId 重试：返回原单，不会下第二笔', !r2.isError && d2.order?.clientOrderId === cloid && n === 1, `orders=${n} ${JSON.stringify(d2).slice(0, 200)}`)
  facts.mcpTimeout = { firstCallSec: t1s, code: e1.error?.code }
  await cl.close()

  // ---- 5. 中危 2：service 令牌面（复核是否收窄）
  const link = await op('session.link', {}, { ...H, 'x-gitrader-pin': PIN })
  const relax = await op('risk.relax', { patch: { limits: { maxOrderNotional: '2500' } } }, { ...H, 'x-gitrader-pin': PIN })
  facts.serviceTokenWithPin = { sessionLink: link.status, riskRelax: relax.status }
  check('（记录）service.json 令牌 + PIN 仍可铸会话链接、放宽风控（T-C 范围，设计未变）', true, JSON.stringify(facts.serviceTokenWithPin))
} catch (e) {
  check('安全复测脚本异常', false, String(e?.stack ?? e).slice(0, 800))
} finally {
  try { await S?.stop() } catch { /* */ }
  rmSync(tmp, { recursive: true, force: true })
}
writeFileSync(join(OUT, 'security-v2.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: results.filter((r) => !r.ok).length, facts, results }, null, 2))
process.exit(results.some((r) => !r.ok) ? 1 : 0)
