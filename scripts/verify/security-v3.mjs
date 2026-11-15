// SPDX-License-Identifier: CPAL-1.0
// 安全复测（H，v3）：只测第三轮改动面——无人值守启动链接（免 PIN）的白名单与入账、`open --print --json`、插件文件路由不出目录。
//   node scripts/verify/security-v3.mjs   → reports/H-logs/v3/security-v3.json
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, startStage, bundleHost, checker } from './stage-lib.mjs'

const CLI = join(root, 'packages', 'cli', 'dist', 'bin.js')
const PIN = '48291357'
const HOST_ORIGIN = 'http://127.0.0.1:61234'
const { results, check } = checker()
const facts = {}
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hsec3-'))
const ENV = { GITRADER_STAGE_NO_ENGINE: '1' }
let S
const raw = (path, headers = {}, method = 'GET', body) => new Promise((res) => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const q = request({ host: '127.0.0.1', port: S.port, path, method, headers: { host: `127.0.0.1:${S.port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (r) => { let t = ''; r.on('data', (c) => { t += c }); r.on('end', () => { let j = null; try { j = JSON.parse(t) } catch { /* */ } res({ status: r.statusCode, text: t, json: j, headers: r.headers }) }) })
  q.on('error', (e) => res({ status: 0, text: String(e) }))
  if (data) q.write(data)
  q.end()
})
const cli = (args, stdin) => new Promise((res) => { const p = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.stdin.end(stdin ?? ''); p.on('close', (code) => res({ code, out, err })) })
try {
  S = await startStage({ tmp: join(tmp, 's'), hostFile: await bundleHost(tmp), env: ENV })
  const prep = await S.run(`
    const p = await k.auth.setupPinLocalTerminal(${JSON.stringify(PIN)})
    const acct = k.accounts.list().find((a) => a.mode === 'paper').accountId
    const key = k.agents.createKey({ name: 'sec3', host: 'claude-code', tier: 'paper', mandate: { accounts: [acct] } }, p, { actor: 'user:usr_local', actorType: 'human', tool: 'sec3', via: 'cli', requestId: '00000000-0000-4000-8000-0000000000f1' })
    return { agent: key.token, session: k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken }`)
  const svc = () => JSON.parse(readFileSync(join(S.home, 'service.json'), 'utf8')).token
  const una = (token, origin) => raw('/api/op/session.link.unattended', token ? { authorization: `Bearer ${token}` } : {}, 'POST', { params: origin === undefined ? {} : { origin } })

  // ---- 1. 无人值守链接：名单为空时关闭
  let r = await una(svc(), HOST_ORIGIN)
  check('无人值守链接：embed.allowedOrigins 为空时关闭（即使 service 令牌）', r.status === 401 && /unattended links are off/.test(r.text), `${r.status} ${r.text.slice(0, 160)}`)
  const c1 = await cli(['config', 'set', 'embed.allowedOrigins', HOST_ORIGIN, '--home', S.home])
  facts.configSet = (c1.out + c1.err).trim().slice(0, 300)
  const cg = await cli(['config', 'get', 'embed.allowedOrigins', '--home', S.home])
  check('`gitrader config set / get embed.allowedOrigins` 可用', cg.out.includes(HOST_ORIGIN), (cg.out + cg.err).slice(0, 200))
  const needRestart = !(await S.run(`return (k.config.embed?.allowedOrigins ?? []).includes(${JSON.stringify(HOST_ORIGIN)})`))
  facts.configSetNeedsRestart = needRestart
  if (needRestart) { await S.stop(); S = await startStage({ tmp: S.tmp, home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: ENV }) }
  // ---- 2. 白名单校验
  const before = await S.run(`return k.ledger.query({ types: ['annotation'], limit: 200 }).filter((e) => e.payload?.setting === 'session_link_unattended').length`)
  r = await una(svc(), HOST_ORIGIN)
  const url = r.json?.result?.url
  check('名单内的宿主来源 + service 令牌：拿到一次性链接（不要 PIN）', r.status === 200 && /\?launch=boot_/.test(url ?? ''), `${r.status} ${r.text.slice(0, 160)}`)
  const ann = await S.run(`return k.ledger.query({ types: ['annotation'], limit: 200 }).filter((e) => e.payload?.setting === 'session_link_unattended').map((e) => ({ origin: e.payload.origin, actor: e.origin.actor, actorType: e.origin.actorType, via: e.origin.via }))`)
  check('每次签发都入账（来源、签发主体）', ann.length === before + 1 && ann[ann.length - 1].origin === HOST_ORIGIN, JSON.stringify(ann.slice(-1)))
  if (url) { const html = await (await fetch(url)).text(); check('链接可用：页面注入引导令牌', /gitrader-bootstrap/.test(html)) }
  for (const [label, o] of [['名单外来源', 'http://127.0.0.1:61235'], ['带路径的来源', HOST_ORIGIN + '/x'], ['大小写变体', HOST_ORIGIN.toUpperCase()], ['空来源', ''], ['不给来源', undefined], ['https 变体', 'https://127.0.0.1:61234']]) {
    r = await una(svc(), o)
    check(`无人值守链接：${label} → 拒绝`, r.status === 401, `${r.status} ${r.text.slice(0, 120)}`)
  }
  for (const [label, tok] of [['无令牌', null], ['Agent 钥匙令牌', prep.agent], ['会话令牌', prep.session], ['伪造 service 令牌', 'svc_' + 'A'.repeat(52)]]) {
    r = await una(tok, HOST_ORIGIN)
    check(`无人值守链接：${label} → 拒绝`, r.status === 401, `${r.status} ${r.text.slice(0, 120)}`)
  }
  r = await raw('/api/op/session.link.unattended', { authorization: `Bearer ${svc()}`, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }, 'POST', { params: { origin: HOST_ORIGIN } })
  check('无人值守链接：浏览器跨站请求（即使带有效令牌）→ 403', r.status === 403, `${r.status}`)
  const after = await S.run(`return k.ledger.query({ types: ['annotation'], limit: 200 }).filter((e) => e.payload?.setting === 'session_link_unattended').length`)
  check('被拒的请求不入账、不铸链接（只有成功那一次）', after === before + 1, `${before} → ${after}`)
  // 免 PIN 换到的会话能做什么：PIN 动作仍要 PIN
  const ses = await raw('/api/session', {}, 'POST', { bootstrap: new URL(url).searchParams.get('launch') }).then((x) => x.json?.sessionToken).catch(() => null)
  const relax = await raw('/api/op/risk.relax', { authorization: `Bearer ${ses}` }, 'POST', { params: { patch: { limits: { maxOrderNotional: '9999' } } } })
  check('免 PIN 换到的会话放宽风控仍要 PIN（1010）', relax.json?.error?.name === 'ATTESTATION_REQUIRED', `${relax.status} ${relax.text.slice(0, 120)}`)
  const unlock = await raw('/api/op/keystore.unlock', { authorization: `Bearer ${ses}` }, 'POST', { params: {} })
  check('免 PIN 换到的会话解锁钥匙库仍要 PIN（1010）', unlock.json?.error?.name === 'ATTESTATION_REQUIRED', `${unlock.status}`)
  // CLI
  const un = await cli(['open', '--print', '--json', '--unattended', '--origin', HOST_ORIGIN, '--home', S.home])
  let uj = null; try { uj = JSON.parse(un.out) } catch { /* */ }
  check('`gitrader open --print --json --unattended --origin` 输出 JSON 链接', un.code === 0 && /\?launch=/.test(uj?.url ?? ''), (un.out + un.err).slice(0, 200))
  const unBad = await cli(['open', '--print', '--json', '--unattended', '--origin', 'http://127.0.0.1:61235', '--home', S.home])
  check('CLI 无人值守 + 名单外来源 → 失败退出', unBad.code !== 0, (unBad.out + unBad.err).slice(0, 160))
  const pj = await cli(['open', '--print', '--json', '--home', S.home], PIN + '\n')
  let pjj = null; try { pjj = JSON.parse(pj.out) } catch { /* */ }
  check('`gitrader open --print --json`（PIN 走 stdin）输出 JSON 链接', pj.code === 0 && /\?launch=/.test(pjj?.url ?? ''), (pj.out + pj.err).slice(0, 200))
  const pjBad = await cli(['open', '--print', '--json', '--home', S.home], '00000000\n')
  check('错 PIN → 失败退出，不给链接', pjBad.code !== 0 && !/launch=/.test(pjBad.out), (pjBad.out + pjBad.err).slice(0, 160))
  facts.cliStdoutIsPureJson = (() => { try { JSON.parse(pj.out); return true } catch { return false } })()

  // ---- 3. 插件文件路由不出目录
  await S.stop()
  const src = join(root, 'packages', 'plugin-template', 'example', 'ema-reading'), dst = join(S.home, 'plugins', 'ema-reading')
  for (const f of readdirSync(src, { recursive: true })) { const p = join(src, f); if (statSync(p).isFile()) { mkdirSync(join(dst, f, '..'), { recursive: true }); copyFileSync(p, join(dst, f)) } }
  const cfgPath = join(S.home, 'gitrader.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); cfg.plugins.developerMode = true; writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  // 一个被拒的插件（哈希不符）也放进去
  const bad = join(S.home, 'plugins', 'bad'); mkdirSync(bad, { recursive: true }); for (const f of readdirSync(dst)) { const p = join(dst, f); if (statSync(p).isFile()) copyFileSync(p, join(bad, f)) }
  const bj = JSON.parse(readFileSync(join(bad, 'gitrader-plugin.json'), 'utf8')); bj.id = 'block.example.bad'; writeFileSync(join(bad, 'gitrader-plugin.json'), JSON.stringify(bj))
  S = await startStage({ tmp: S.tmp, home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: ENV })
  await S.run('await k.plugins.reload(); return true')
  writeFileSync(join(dst, '.secret'), 'dotfile') // 装载后才放进去的点文件
  const ok = await raw('/plugins/block.example.ema-reading/block.js', { origin: 'null', 'sec-fetch-site': 'cross-site' })
  check('插件文件路由：合法文件 200（沙箱 null 源）', ok.status === 200 && ok.headers['access-control-allow-origin'] === '*', `${ok.status}`)
  const id = 'block.example.ema-reading'
  const probes = [
    ['../ 逃逸到数据目录', `/plugins/${id}/../../gitrader.json`],
    ['%2e%2e%2f 编码逃逸', `/plugins/${id}/%2e%2e%2f%2e%2e%2fgitrader.json`],
    ['..%2f 混合编码', `/plugins/${id}/..%2f..%2fkeys%2fpin.json`],
    ['反斜杠 ..%5c', `/plugins/${id}/..%5c..%5ckeys%5cpin.json`],
    ['反斜杠原文', `/plugins/${id}/..\\..\\keys\\pin.json`],
    ['双重编码', `/plugins/${id}/%252e%252e%252fgitrader.json`],
    ['绝对路径（盘符）', `/plugins/${id}/C:%5cWindows%5cwin.ini`],
    ['id 位置逃逸', `/plugins/..%2fkeys/pin.json`],
    ['点文件', `/plugins/${id}/.secret`],
    ['插件目录本身', `/plugins/${id}/`],
    ['插件清单之外的被拒插件', `/plugins/block.example.bad/block.js`],
    ['不存在的插件', `/plugins/nope/block.js`],
    ['NUL 字节', `/plugins/${id}/block.js%00.json`],
  ]
  const leaks = []
  for (const [label, p] of probes) {
    const x = await raw(p, { origin: 'null', 'sec-fetch-site': 'cross-site' })
    const leaked = x.status === 200 && (/"verifier"|"kdf"|"accounts"|\[fonts\]|dotfile/.test(x.text) || p.includes('bad'))
    if (x.status === 200) leaks.push({ label, status: x.status, head: x.text.slice(0, 60) })
    check(`插件文件路由：${label} → 不泄露`, !leaked && x.status !== 200, `${x.status} ${x.text.slice(0, 80)}`)
  }
  facts.pluginRouteNon404 = leaks
  // API 不因插件路由放宽：带 null 源调 API 仍 403
  const api = await raw('/api/op/status', { origin: 'null', authorization: `Bearer ${svc()}` }, 'POST', { params: {} })
  check('插件路由的放宽不波及 API（null 源调 API → 403）', api.status === 403, `${api.status}`)
} catch (e) {
  check('安全复测 v3 异常', false, String(e?.stack ?? e).slice(0, 800))
} finally {
  try { await S?.stop() } catch { /* */ }
  rmSync(tmp, { recursive: true, force: true })
}
mkdirSync(join(root, 'reports', 'H-logs', 'v3'), { recursive: true })
writeFileSync(join(root, 'reports', 'H-logs', 'v3', 'security-v3.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: results.filter((r) => !r.ok).length, facts, results }, null, 2))
process.exit(results.some((r) => !r.ok) ? 1 : 0)
