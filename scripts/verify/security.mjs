// SPDX-License-Identifier: CPAL-1.0
// 安全审（对抗式，H）：按审稿 S1–S3 与产品定义 §五，对真内核（夹具行情，不联网）逐项打。每项打印复现要点与结果。
//   node scripts/verify/security.mjs [--keep]
// 产物：reports/H-logs/security.json。只结束自己起的进程。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { root, startStage, bundleHost, checker } from './stage-lib.mjs'

const keep = process.argv.includes('--keep')
const LOGS = join(root, 'reports', 'H-logs')
mkdirSync(LOGS, { recursive: true })
const CLI = join(root, 'packages', 'cli', 'dist', 'bin.js')
const PIN = '482913'
const { results, check } = checker()
const facts = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hsec-'))
const ENGINE_ENV = { GITRADER_ENGINE_CORE_BUNDLE: join(root, 'packages', 'engine-core', 'dist', 'engine-core.mjs') }
const cli = (args, stdin) => new Promise((res) => { const p = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); if (stdin) p.stdin.write(stdin); p.stdin.end(); p.on('close', (code) => res({ code, out, err })) })

let S = await startStage({ keep, tmp: join(tmp, 'stage'), hostFile: await bundleHost(tmp), env: ENGINE_ENV })
const base = `http://127.0.0.1:${S.port}`
const host = `127.0.0.1:${S.port}`
/** 原始 HTTP（node fetch 不让改 Host / 不自动带 Origin）。 */
function raw(method, path, { headers = {}, body } = {}) {
  return new Promise((res) => {
    import('node:http').then(({ request }) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = request({ host: '127.0.0.1', port: S.port, path, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (r) => {
        let t = ''; r.on('data', (c) => { t += c }); r.on('end', () => { let j = null; try { j = JSON.parse(t) } catch { /* html */ } res({ status: r.statusCode, headers: r.headers, text: t, json: j }) })
      })
      req.on('error', (e) => res({ status: 0, text: String(e) }))
      if (data) req.write(data)
      req.end()
    })
  })
}
const op = (name, params, headers) => raw('POST', `/api/op/${name}`, { headers, body: { params: params ?? {} } })

try {
  // ---- 准备：PIN、导入一只测试私钥（只在内存里，事后 grep 它）、钥匙
  const secretHex = randomBytes(32).toString('hex')
  const setup = await S.run(`
    const p = await k.auth.setupPinLocalTerminal(${JSON.stringify(PIN)}); k.keystore.unlock(p)
    const w = k.keystore.import(p, { name: 'sec-test', privateKey: ${JSON.stringify(secretHex)}, network: 'testnet' })
    const acct = k.accounts.list().find((a) => a.mode === 'paper').accountId
    const o = { actor: 'user:usr_local', actorType: 'human', tool: 'sec:setup', via: 'cli', requestId: '00000000-0000-4000-8000-0000000000b1' }
    const pk = k.agents.createKey({ name: 'sec-paper', host: 'claude-code', tier: 'paper', mandate: { accounts: [acct] } }, p, o)
    k.keystore.lock()
    return { wallet: w.walletId, address: w.address, agent: pk.token, acct }`)
  const svc = JSON.parse(readFileSync(join(S.home, 'service.json'), 'utf8')).token
  facts.serviceJsonKeys = Object.keys(JSON.parse(readFileSync(join(S.home, 'service.json'), 'utf8')))

  // ==== S1：伪造头 / 无令牌 / 过期引导令牌
  let r = await op('status', {}, { host, 'sec-fetch-site': 'same-origin' })
  check('S1 伪造 Sec-Fetch-Site: same-origin、无令牌 → 401', r.status === 401, `${r.status} ${r.text.slice(0, 120)}`)
  r = await op('status', {}, { host, 'sec-fetch-site': 'none', origin: `http://127.0.0.1:${S.port}` })
  check('S1 伪造本机 Origin + Sec-Fetch-Site: none、无令牌 → 401', r.status === 401, `${r.status}`)
  r = await op('status', {}, { host, origin: 'http://evil.example', authorization: `Bearer ${svc}` })
  check('S1 跨站 Origin（即使带有效令牌）→ 403', r.status === 403, `${r.status}`)
  r = await op('status', {}, { host, 'sec-fetch-site': 'cross-site', authorization: `Bearer ${svc}` })
  check('S1 Sec-Fetch-Site: cross-site（即使带有效令牌）→ 403', r.status === 403, `${r.status}`)
  r = await op('status', {}, { host: `evil.example:${S.port}`, authorization: `Bearer ${svc}` })
  check('S1 DNS 重绑定（Host 不是本机）→ 403', r.status === 403, `${r.status}`)
  r = await op('proposal.approve', { id: 'x' }, { host, 'sec-fetch-site': 'same-origin', 'x-gitrader-pin': PIN })
  check('S1 无令牌 + 正确 PIN 也批不了提案（PIN 不是身份）', r.status === 401, `${r.status}`)
  r = await raw('GET', '/', { headers: { host } })
  check('S1 不带 launch 访问页面：拿不到引导令牌', r.status === 200 && !/gitrader-bootstrap/.test(r.text))
  r = await raw('POST', '/api/session', { headers: { host }, body: { bootstrap: 'boot_' + 'A'.repeat(52) } })
  check('S1 伪造引导令牌换会话 → 401', r.status === 401, `${r.status}`)
  const shortBoot = await S.run(`return k.auth.mintBootToken(30)`)
  await sleep(120)
  r = await raw('POST', '/api/session', { headers: { host }, body: { bootstrap: shortBoot } })
  check('S1 过期引导令牌换会话 → 401', r.status === 401, `${r.status}`)
  const boot = await S.run(`return k.auth.mintBootToken()`)
  const r1 = await raw('POST', '/api/session', { headers: { host }, body: { bootstrap: boot } })
  const r2 = await raw('POST', '/api/session', { headers: { host }, body: { bootstrap: boot } })
  check('S1 引导令牌一次性：第二次换票 → 401', r1.status === 200 && r2.status === 401, `${r1.status}/${r2.status}`)
  const session = r1.json?.sessionToken
  const page = await raw('GET', `/?launch=${boot}`, { headers: { host } })
  check('S1 已换过票的 launch 链接再打开：不再注入引导令牌', !/gitrader-bootstrap/.test(page.text))
  // WS：跨站 Origin 被拒；不先 auth 被断开
  const wsTry = (headers, first) => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${S.port}/ui`, { headers })
    let out = { opened: false, closeCode: null, error: null, reply: null }
    ws.on('open', () => { out.opened = true; if (first) ws.send(JSON.stringify(first)) })
    ws.on('message', (m) => { out.reply = String(m).slice(0, 160) })
    ws.on('unexpected-response', (_q, resp) => { out.error = resp.statusCode; res(out) })
    ws.on('error', (e) => { out.error = out.error ?? String(e.message) })
    ws.on('close', (c) => { out.closeCode = c; res(out) })
    setTimeout(() => { try { ws.close() } catch { /* */ } res(out) }, 6500)
  })
  let w = await wsTry({ Origin: 'http://evil.example' })
  check('S1 WS 跨站 Origin → 握手 403', w.error === 403, JSON.stringify(w))
  w = await wsTry({}, { jsonrpc: '2.0', id: 1, method: 'query', params: { method: 'status' } })
  check('S1 WS 首帧不是 auth → 报错并断开（4401）', w.closeCode === 4401, JSON.stringify(w))
  w = await wsTry({}, { jsonrpc: '2.0', id: 1, method: 'auth', params: { token: setup.agent } })
  check('S1 WS 用 Agent 钥匙令牌登录人面通道 → 拒绝', w.closeCode === 4401, JSON.stringify(w))

  // ==== S2：Agent / service 令牌拿不到人面动作
  const A = { host, authorization: `Bearer ${setup.agent}` }
  for (const name of ['proposal.approve', 'risk.relax', 'trading_state.resume', 'mandate.update', 'agentkey.create', 'credential.import', 'risk.setLlmLiveEntries', 'engine.bind', 'session.link', 'settings.network.set']) {
    r = await op(name, { id: 'x', patch: {}, deny: false }, { ...A, 'x-gitrader-pin': PIN })
    check(`S2 Agent 钥匙 + 正确 PIN 调 ${name} → 拒绝`, r.status === 401 || r.status === 403, `${r.status} ${r.text.slice(0, 100)}`)
  }
  const V = { host, authorization: `Bearer ${svc}` }
  for (const name of ['proposal.approve', 'credential.import', 'risk.tighten', 'agentkey.revoke', 'ledger.export']) {
    r = await op(name, { id: 'x', label: 'x', secret: secretHex, network: 'testnet', patch: {}, keyId: 'x' }, V)
    check(`S2 service.json 令牌（无会话）调会话专属 ${name} → 拒绝`, r.status === 401 || r.status === 403, `${r.status} ${r.text.slice(0, 100)}`)
  }
  r = await op('session.link', {}, V)
  check('S2 service 令牌无 PIN 要启动链接 → 1010 ATTESTATION_REQUIRED', r.json?.error?.name === 'ATTESTATION_REQUIRED', `${r.status} ${r.text.slice(0, 100)}`)
  r = await op('takeover.halt_new', { reason: 'sec: service token takeover' }, V)
  facts.serviceCanTakeover = r.status
  check('S2（记录）service 令牌可以触发接管（自保方向，不需要 PIN）', r.status === 200, `${r.status}`)
  r = await op('trading_state.resume', { reason: 'sec' }, V)
  check('S2 service 令牌恢复交易要 PIN（1010）', r.json?.error?.name === 'ATTESTATION_REQUIRED', `${r.status} ${r.text.slice(0, 100)}`)
  r = await op('trading_state.resume', { reason: 'sec' }, { ...V, 'x-gitrader-pin': PIN })
  check('S2（记录）service 令牌 + 正确 PIN 能恢复交易（同用户进程读到 service.json 且知道 PIN = T-C 范围）', r.status === 200, `${r.status}`)
  // 秘密字段：普通操作里夹带 privateKey / mnemonic 被拒
  r = await op('note.add', { text: 'x', privateKey: secretHex }, V)
  check('S2 普通操作里夹带 privateKey 字段 → 5006 SECRET_FIELD_REJECTED', r.json?.error?.name === 'SECRET_FIELD_REJECTED', `${r.status} ${r.text.slice(0, 120)}`)

  // ==== S3：PIN 暴力（退避，跨重启持久）
  const times = []
  let lastErr = null
  for (let i = 1; i <= 7; i++) {
    const t0 = Date.now()
    r = await op('keystore.unlock', {}, { ...V, 'x-gitrader-pin': String(100000 + i) })
    times.push({ i, status: r.status, name: r.json?.error?.name, retryAfter: r.headers['retry-after'] ?? null, retryAfterMs: r.json?.error?.retryAfterMs ?? null, ms: Date.now() - t0 })
    lastErr = r.json?.error
  }
  facts.pinBruteforce = times
  const locked = times.filter((t) => t.retryAfterMs)
  check('S3 连续错 PIN：前 3 次照常报错，第 4 次起锁定（retry-after），锁定期内的尝试不再验证', times.slice(0, 3).every((t) => !t.retryAfterMs) && locked.length >= 3 && locked.slice(1).every((t) => t.ms < 50), JSON.stringify(times))
  // 锁到期后再错一次：锁定时长翻倍（2^(n-4) s）
  await sleep((locked[locked.length - 1]?.retryAfterMs ?? 1000) + 100)
  r = await op('keystore.unlock', {}, { ...V, 'x-gitrader-pin': '100099' })
  facts.pinLockAfterExpiry = r.json?.error?.retryAfterMs
  check('S3 锁到期后再错：锁定时长指数增长（1 s → 2 s）', (r.json?.error?.retryAfterMs ?? 0) >= 1900, JSON.stringify(r.json?.error))
  r = await op('keystore.unlock', {}, { ...V, 'x-gitrader-pin': PIN })
  check('S3 锁定期内连正确 PIN 也不放行', r.status !== 200 && /too many/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`)
  await S.stop()
  S = await startStage({ keep, tmp: S.tmp, home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: ENGINE_ENV })
  const svc2 = JSON.parse(readFileSync(join(S.home, 'service.json'), 'utf8')).token
  const V2 = { host: `127.0.0.1:${S.port}`, authorization: `Bearer ${svc2}` }
  r = await op('keystore.unlock', {}, { ...V2, 'x-gitrader-pin': PIN })
  check('S3 重启内核不清零退避（锁定状态持久化）', r.status !== 200 && /too many/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`)
  check('S3 重启后旧 service 令牌失效（每次启动轮换）', svc2 !== svc && (await op('status', {}, { host: `127.0.0.1:${S.port}`, authorization: `Bearer ${svc}` })).status === 401)
  // 解除锁定以便后续测试：等锁到期太久，直接改 pin 文件里的计数——这本身就是 T-C（改文件），记下来
  const pinFile = join(S.home, 'keys', 'pin.json')
  facts.pinFileExists = existsSync(pinFile)
  if (existsSync(pinFile)) { const pf = JSON.parse(readFileSync(pinFile, 'utf8')); facts.pinFileFields = Object.keys(pf); pf.failures = 0; pf.lockedUntil = 0; writeFileSync(pinFile, JSON.stringify(pf)) }
  check('S3（记录）PIN 退避计数存在本地文件里，同用户可改（T-C，不在保证范围）', facts.pinFileExists, pinFile)

  // ==== S4：密钥静态加密、数据目录与日志零明文
  const files = []
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else files.push(p) } }
  walk(S.home)
  const needles = { privateKeyHex: secretHex, pin: PIN, agentToken: setup.agent, session: session ?? 'none-session' }
  const hits = {}
  for (const f of files) { const buf = readFileSync(f); for (const [k, v] of Object.entries(needles)) { if (buf.includes(Buffer.from(v)) || buf.includes(Buffer.from(v, 'utf16le'))) (hits[k] ??= []).push(f.replace(S.home, '<home>')) } }
  facts.dataDirFiles = files.length
  facts.plaintextHits = hits
  check('S4 数据目录（含 sqlite / wal / keys）里没有私钥明文', !hits.privateKeyHex, JSON.stringify(hits.privateKeyHex))
  check('S4 数据目录里没有 PIN 明文', !hits.pin, JSON.stringify(hits.pin))
  check('S4 数据目录里没有 Agent 钥匙令牌明文（只存 scrypt 哈希）', !hits.agentToken, JSON.stringify(hits.agentToken))
  check('S4 数据目录里没有会话令牌（只在内存）', !hits.session, JSON.stringify(hits.session))
  const logText = S.stderr
  check('S4 内核 stderr 不含私钥 / PIN / 令牌', ![secretHex, setup.agent, session ?? 'x-none'].some((v) => logText.includes(v)) && !logText.includes(`"${PIN}"`))
  facts.keyFiles = files.filter((f) => /keys/.test(f)).map((f) => f.replace(S.home, '<home>'))
  const mk = files.find((f) => /master|install/i.test(f))
  facts.masterKeyInDataDir = mk ? mk.replace(S.home, '<home>') : null
  check('S4（记录）主密钥不与密文同目录：主密钥由 PIN 经 scrypt 派生、不落盘', !files.some((f) => /master\.key|\.venue-master/i.test(f)), JSON.stringify(facts.keyFiles))

  // ==== S5：插件拿不到密钥（Node 权限模型：内核给插件进程的参数原样复现）
  const plugDir = join(tmp, 'plug'); mkdirSync(plugDir, { recursive: true })
  writeFileSync(join(plugDir, 'probe.mjs'), `import { readFileSync, readdirSync } from 'node:fs'\nconst out = {}\nfor (const p of process.argv.slice(2)) { try { readFileSync(p); out[p] = 'READ' } catch (e) { out[p] = e.code } }\ntry { readdirSync(process.argv[2].replace(/[^/\\\\]+$/, '')); out.dir = 'LISTED' } catch (e) { out.dir = e.code }\nout.env = Object.keys(process.env)\nprocess.stdout.write(JSON.stringify(out))`)
  const keyFile = files.find((f) => /keys[\\/].*\.json$/.test(f) && !/pin/.test(f)) ?? join(S.home, 'gitrader.json')
  const probe = await new Promise((res) => { const p = spawn(process.execPath, ['--permission', `--allow-fs-read=${plugDir}`, join(plugDir, 'probe.mjs'), keyFile, join(S.home, 'data', 'gitrader.sqlite'), join(S.home, 'service.json')], { cwd: plugDir, env: { GITRADER_GSP_TOKEN: 'x', SystemRoot: process.env.SystemRoot }, windowsHide: true }); let o = ''; p.stdout.on('data', (d) => { o += d }); p.stderr.on('data', (d) => { o += d }); p.on('close', () => res(o)) })
  facts.pluginProbe = probe.slice(0, 2000)
  let pj = {}; try { pj = JSON.parse(probe) } catch { /* */ }
  check('S5 插件进程（内核同款 --permission --allow-fs-read=<插件目录>）读不到钥匙文件 / 数据库 / service.json，环境变量里没有任何 Gitrader 令牌（除 GSP）', Object.entries(pj).filter(([k]) => k !== 'env' && k !== 'dir').every(([, v]) => v === 'ERR_ACCESS_DENIED') && Array.isArray(pj.env) && !pj.env.some((e) => /GITRADER_(AGENT|SERVICE|HOME|PIN)|TOKEN$/i.test(e) && e !== 'GITRADER_GSP_TOKEN'), probe.slice(0, 300))
  facts.pluginEnvExtra = (pj.env ?? []).filter((e) => !/^(GITRADER_GSP_TOKEN|SystemRoot)$/i.test(e))

  // ==== S6：denyLlmLiveEntries 默认开；关闭要 PIN 并入账
  const st = await op('risk.state', {}, V2)
  check('S6 默认风控策略 denyLlmLiveEntries = true', st.json?.result?.denyLlmLiveEntries === true, JSON.stringify(st.json?.result?.denyLlmLiveEntries))
  const ses2 = await S.run(`return k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken`)
  const SS = { host: `127.0.0.1:${S.port}`, authorization: `Bearer ${ses2}` }
  r = await op('risk.setLlmLiveEntries', { deny: false }, SS)
  check('S6 会话关闭"大模型实盘开仓保护"没带 PIN → 1010', r.json?.error?.name === 'ATTESTATION_REQUIRED', `${r.status} ${r.text.slice(0, 120)}`)
  r = await op('risk.setLlmLiveEntries', { deny: false }, { ...SS, 'x-gitrader-pin': PIN })
  const relaxed = await S.run(`return k.ledger.query({ limit: 20 }).filter((e) => /policy/.test(e.type)).map((e) => ({ type: e.type, actorType: e.origin.actorType, payload: JSON.stringify(e.payload).slice(0, 120) }))`)
  check('S6 带 PIN 关闭后入账（policy.* 条目，人来源）', r.status === 200 && relaxed.some((e) => /relax/.test(e.type) && e.actorType === 'human'), JSON.stringify(relaxed).slice(0, 300))
  await op('risk.setLlmLiveEntries', { deny: true }, SS)

  // ==== S7：HALTED 放行面
  r = await op('kill', { reason: 'sec: kill switch' }, SS)
  check('S7 杀开关 → HALTED', (await S.run(`return k.tstate.effective([{ type: 'org', id: 'org_local' }]).state`)) === 'HALTED', `${r.status} ${r.text.slice(0, 120)}`)
  const AG = { host: `127.0.0.1:${S.port}`, authorization: `Bearer ${setup.agent}` }
  const agentCall = (tool, args) => raw('POST', `/api/op/agent.${tool}`, { headers: AG, body: { params: args } })
  r = await agentCall('order', { action: 'place', intent: { accountId: setup.acct, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, reason: 'sec: open while halted' } })
  const openDenied = /TRADING_STATE|HALTED/.test(r.text)
  check('S7 HALTED：Agent 开仓被拒', openDenied, r.text.slice(0, 200))
  r = await agentCall('order', { action: 'cancel_all', accountId: setup.acct })
  check('S7 HALTED：撤单放行', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`)
  r = await agentCall('engines', { action: 'start_strategy', strategyId: 'x', accountId: setup.acct, instruments: ['hyperliquid:BTC'] })
  facts.haltedStrategyStart = r.text.slice(0, 200)
  check('S7 HALTED：Agent 起策略被拒，且理由是 HALTED（不是"没绑定"）', r.status !== 200 && /HALTED|TRADING_STATE/.test(r.text), r.text.slice(0, 200))
  r = await op('agentkey.create', { input: { name: 'x', host: 'other', tier: 'paper', mandate: { accounts: [setup.acct] } } }, { ...SS, 'x-gitrader-pin': PIN })
  check('S7 HALTED：签发新钥匙被拒（先恢复）', r.status !== 200 && /HALT/i.test(r.text), `${r.status} ${r.text.slice(0, 160)}`)
  r = await op('trading_state.resume', { reason: 'sec resume' }, { ...SS, 'x-gitrader-pin': PIN })
  check('S7 恢复：PIN → ACTIVE', r.status === 200 && (await S.run(`return k.tstate.effective([{ type: 'org', id: 'org_local' }]).state`)) === 'ACTIVE', `${r.status}`)

  // ==== S9：账本只认内核时间
  const back = await S.run(`try { k.ledger.append({ type: 'note', ts: k.clock.now() - 120000, origin: { actor: 'user:usr_local', actorType: 'human', tool: 'sec', via: 'cli', requestId: '00000000-0000-4000-8000-0000000000c1' }, subject: { orgId: 'org_local' }, payload: { text: 'backdated' } }); return 'ACCEPTED' } catch (e) { return e.problem?.message ?? String(e) }`)
  check('S9 倒填 120 s 的账本条目被拒（只认内核时钟）', /backdated/.test(back), back)
  r = await op('note.add', { text: 'client ts attempt', ts: 1 }, SS)
  const noteTs = await S.run(`const e = k.ledger.query({ types: ['note'], limit: 1 })[0]; return { ts: e.ts, now: k.clock.now() }`)
  check('S9 客户端传 ts 被忽略（条目时间 = 内核时间）', Math.abs(noteTs.now - noteTs.ts) < 5000, JSON.stringify(noteTs))

  // ==== S8：账本篡改检测（停服 → 删触发器改一字节 → ledger verify 失败）
  await S.stop()
  const dbPath = join(S.home, 'data', 'gitrader.sqlite')
  const db = new DatabaseSync(dbPath)
  let tamper = null
  try {
    let upd = 'blocked'
    try { db.exec(`UPDATE ledger SET entry = entry WHERE seq = 3`); upd = 'allowed' } catch (e) { upd = String(e.message).slice(0, 80) }
    facts.updateWithTriggers = upd
    const trig = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ledger'`).all().map((x) => x.name)
    for (const t of trig) db.exec(`DROP TRIGGER ${t}`)
    const row = db.prepare('SELECT seq, entry FROM ledger WHERE seq = 3').get()
    const i = row.entry.indexOf('"type":"') + 8
    const flipped = row.entry.slice(0, i) + (row.entry[i] === 'a' ? 'b' : 'a') + row.entry.slice(i + 1)
    db.prepare('UPDATE ledger SET entry = ? WHERE seq = 3').run(flipped)
    tamper = { triggers: trig, seq: 3 }
  } finally { db.close() }
  check('S8 账本表有防改触发器（直接 UPDATE 被拒）', facts.updateWithTriggers !== 'allowed', facts.updateWithTriggers)
  const v = await cli(['ledger', 'verify', '--home', S.home])
  check('S8 删掉触发器、改一个字节后 `ledger verify` 失败并指出序号', v.code !== 0 && /BROKEN at seq 3/.test(v.out), v.out + v.err.slice(0, 200))
  facts.tamper = { ...tamper, verify: v.out.trim() }

  // ==== S10：service.json 权限
  const acl = await new Promise((res) => { const q = spawn('icacls', [join(S.home, 'service.json')], { windowsHide: true }); let o = ''; q.stdout.on('data', (d) => { o += d }); q.on('close', () => res(o)) })
  const aclLines = acl.split('\n').slice(0, -2).join('\n')
  facts.serviceAcl = aclLines.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^.*service\.json\s*/, ''))
  check('S10 service.json 的 ACL 只有当前用户（无继承的 Users / Everyone / Authenticated Users）', !/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/i.test(aclLines), JSON.stringify(facts.serviceAcl))
} catch (e) {
  check('安全审脚本异常', false, String(e?.stack ?? e).slice(0, 600))
} finally {
  try { await S.stop() } catch { /* */ }
  if (!keep) rmSync(tmp, { recursive: true, force: true })
}
const failed = results.filter((x) => !x.ok)
writeFileSync(join(LOGS, 'security.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, facts, results }, null, 2))
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项；reports/H-logs/security.json`)
process.exit(failed.length ? 1 : 0)
