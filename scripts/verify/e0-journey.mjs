// SPDX-License-Identifier: CPAL-1.0
// E0 门禁（E0-12）：便宜模型当 Agent，从零跑「装 → 起 → 设 PIN → 接 Agent → 第一单（带止损）→ 批准 → 看结果」七步。
//
//   node scripts/verify/e0-journey.mjs --tgz <gitrader-x.y.z.tgz> --skill <技能 SKILL.md> --out <临时目录>
//        [--readme <README.md>] [--max-rounds 5] [--budget 5] [--turns 40]
//        [--playwright <playwright-core 目录>] [--edge <msedge.exe>] [--run-claude-flash <脚本路径>]
//
// 角色：Agent = run-claude-flash.sh（DeepSeek Flash，只拿随包技能 + 一句话）；人类 = Playwright 无头 Edge（只设 PIN、点批准）；
// 判据全部由工件算出（judge.mjs 纯函数）。门禁规则：(a)–(f)、(j) 任何一项非零 = 不许发版；(j)=全程用户可见报错 0（CLI error 行、红色规则行、报错 toast、错误页，见 e0/visible-errors.mjs）。脚本不改产品源码；只按自己记录的 PID 收进程。
// 输出：<out>/e0-report.json、<out>/E0-REPORT.md、human-actions.json、rounds/、shots/、transcripts/、logs/。
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { randomInt } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createHuman } from './e0/human.mjs'
import { judge, parseTranscript } from './e0/judge.mjs'
import { costYuan, portReserved } from './e0/patterns.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const need = (k) => { const v = opt(k); if (!v) { console.error(`缺少 --${k}`); process.exit(2) } return v }
const TGZ = resolve(need('tgz')), SKILL = resolve(need('skill')), OUT = resolve(need('out'))
const README = resolve(opt('readme', join(here, '..', '..', 'README.md')))
const MAX_ROUNDS = Number(opt('max-rounds', 5)), BUDGET = Number(opt('budget', 5)), TURNS = opt('turns', '40')
const PLAYWRIGHT = opt('playwright', process.env.GITRADER_PLAYWRIGHT ?? '')
const EDGE = opt('edge', process.env.GITRADER_EDGE ?? '')
const FLASH = opt('run-claude-flash', process.env.E0_AGENT_RUNNER ?? '')
// 便宜模型 Agent 的壳与其会话目录由本机环境给出（仓库里不写本机路径）
const CFG_PROJECTS = opt('agent-projects', process.env.E0_AGENT_PROJECTS ?? '')
for (const [k, v] of Object.entries({ 'playwright (GITRADER_PLAYWRIGHT)': PLAYWRIGHT, 'edge (GITRADER_EDGE)': EDGE, 'run-claude-flash (E0_AGENT_RUNNER)': FLASH, 'agent-projects (E0_AGENT_PROJECTS)': CFG_PROJECTS })) if (!v) { console.error('缺少 --' + k); process.exit(2) }
const ALLOW_UNTAR = argv.includes('--allow-untar-fallback')
const FIRST_PROMPT = '我想用 Gitrader 做纸面交易，帮我装好，并让你自己提一单买一点比特币，我来批准。'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fwd = (p) => p.replace(/\\/g, '/')
const D = { prefix: join(OUT, 'prefix'), shim: join(OUT, 'shim'), home: join(OUT, 'home'), agent: join(OUT, 'agent'), logs: join(OUT, 'logs'), rounds: join(OUT, 'rounds'), shots: join(OUT, 'shots'), tr: join(OUT, 'transcripts') }
for (const d of Object.values(D)) mkdirSync(d, { recursive: true })
const SHIM_LOG = join(D.logs, 'shim.jsonl')
const startMs = Date.now()
const notes = [] // 过程里发现的事实（不进判据，进报告）
const note = (s) => { notes.push(s); console.log('NOTE ' + s) }

// 每次运行随机的测试 PIN（8 位、非连号）：只进浏览器，不进 Agent 提示词、不进报告
const PIN = (() => { for (;;) { const p = String(randomInt(10_000_000, 99_999_999)); if (!/(.)\1{3}/.test(p) && !'0123456789876543210'.includes(p.slice(0, 4))) return p } })()

async function freePort() {
  for (;;) {
    const p = await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
    if (!portReserved(p)) return p
  }
}

// ---- 1. 安装（真「从零」：tgz → 私有前缀）----------------------------------------------------------
const stderrs = []
const install = spawnSync('npm', ['install', '-g', '--prefix', D.prefix, TGZ, '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: OUT, shell: true, encoding: 'utf8', windowsHide: true, timeout: 300_000 })
writeFileSync(join(D.logs, 'install.log'), `exit ${install.status}\n--- stdout\n${install.stdout}\n--- stderr\n${install.stderr}\n`)
if (install.stderr) stderrs.push({ src: 'install', argv: 'install', text: install.stderr })
const REAL = join(D.prefix, 'node_modules', 'gitrader', 'dist', 'bin.js')
let installMode = 'npm'
if ((install.status !== 0 || !existsSync(REAL)) && !ALLOW_UNTAR) { note('npm install 失败（exit ' + install.status + '）：第 1 步判败（基线可加 --allow-untar-fallback 继续量后面几步）'); console.error('E0 门禁不通过：第 1 步（安装）失败，日志 ' + join(D.logs, 'install.log')); process.exit(3) }
if ((install.status !== 0 || !existsSync(REAL)) && ALLOW_UNTAR) {
  // 基线里 tgz 依赖了未发布的 @gitrader/*：npm 装不上。为了仍能量到后面几步，用解包代替，并把这条失败如实记在第 1 步。
  note(`npm install 失败（exit ${install.status}），改用解包 tgz 到 ${D.prefix}/node_modules/gitrader（脚本的兜底，不是用户路径）`)
  const dst = join(D.prefix, 'node_modules', 'gitrader'); mkdirSync(dst, { recursive: true })
  const x = spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-xzf', TGZ, '-C', dst, '--strip-components=1'], { encoding: 'utf8', windowsHide: true }) // 系统自带 bsdtar；Git 的 GNU tar 会把 C: 当远程主机
  if (x.status !== 0 || !existsSync(REAL)) { console.error('解包也失败：' + x.stderr); process.exit(3) }
  installMode = 'untar-fallback'
}
const REAL_MCP = join(D.prefix, 'node_modules', 'gitrader', 'dist', 'gitrader-mcp.js')

// ---- 2. PATH 垫片：让 Agent 直接敲 gitrader / gitrader-mcp，同时把 stderr / stdout 留档 ----------------------
// serve 用 PowerShell Start-Process 起成脱离 Agent 进程树的独立进程（现实里 serve 是常驻服务；这里分多轮 resume，不脱离的话每轮结束就被一起收掉）。
writeFileSync(join(D.shim, 'shim.mjs'), `// 由 e0-journey 生成
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, openSync, readSync, closeSync, statSync, readFileSync, rmSync } from 'node:fs'
const [real, logf, ...args] = process.argv.slice(2)
const rec = (src, text) => appendFileSync(logf, JSON.stringify({ t: Date.now(), src, argv: args.join(' '), text }) + '\\n')
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
if (args[0] === 'serve' && !args.some((x) => x === '--detach' || x === '--help' || x === '-h')) {
  const outf = logf + '.serve.out', errf = logf + '.serve.err'
  const arglist = [real, ...args].map((a) => '"' + a + '"').join(' ')
  try { rmSync(logf + '.pid') } catch { /* 没有旧的 */ }
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', "$p = Start-Process -FilePath " + q(process.execPath) + " -ArgumentList " + q(arglist) + " -RedirectStandardOutput " + q(outf) + " -RedirectStandardError " + q(errf) + " -WindowStyle Hidden -PassThru; Set-Content -Path " + q(logf + '.pid') + " -Value $p.Id"], { stdio: 'ignore', windowsHide: true }) // stdio 必须 ignore：子进程会继承管道，spawnSync 就要等到 serve 退出
  const pid = existsSync(logf + '.pid') ? Number(readFileSync(logf + '.pid', 'utf8').trim()) : 0
  if (!pid) { process.stderr.write('shim: 起不来 serve\\n'); process.exit(1) }
  rec('pid', String(pid))
  const off = { [outf]: 0, [errf]: 0 }
  const pump = (f, w, src) => { if (!existsSync(f)) return; const size = statSync(f).size; if (size <= off[f]) return; const buf = Buffer.alloc(size - off[f]); const fd = openSync(f, 'r'); readSync(fd, buf, 0, buf.length, off[f]); closeSync(fd); off[f] = size; const text = buf.toString('utf8'); w.write(text); rec(src, text) }
  const alive = () => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  const t0 = Date.now()
  for (;;) { pump(outf, process.stdout, 'serve-stdout'); pump(errf, process.stderr, 'serve'); if (!alive()) { pump(outf, process.stdout, 'serve-stdout'); pump(errf, process.stderr, 'serve'); process.exit(Date.now() - t0 < 3000 ? 1 : 0) } await new Promise((r) => setTimeout(r, 200)) }
} else {
  const child = spawn(process.execPath, [real, ...args], { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (d) => { process.stdout.write(d); rec('stdout', d.toString('utf8')) })
  child.stderr.on('data', (d) => { process.stderr.write(d); rec('cli', d.toString('utf8')) })
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill())
  child.on('close', (code) => process.exit(code ?? 1))
}
`)
const NODE = fwd(process.execPath)
writeFileSync(join(D.shim, 'gitrader'), `#!/bin/sh\nexec "${NODE}" "${fwd(join(D.shim, 'shim.mjs'))}" "${fwd(REAL)}" "${fwd(SHIM_LOG)}" "$@"\n`)
writeFileSync(join(D.shim, 'gitrader.cmd'), `@"${process.execPath}" "${join(D.shim, 'shim.mjs')}" "${REAL}" "${SHIM_LOG}" %*\r\n`)
writeFileSync(join(D.shim, 'gitrader-mcp'), `#!/bin/sh\nexec "${NODE}" "${fwd(REAL_MCP)}" "$@"\n`)
writeFileSync(join(D.shim, 'gitrader-mcp.cmd'), `@"${process.execPath}" "${REAL_MCP}" %*\r\n`)

// ---- 3. Agent 工作目录：空项目 + 产品随包技能 ----------------------------------------------------
const skillDir = join(D.agent, '.claude', 'skills', 'gitrader'); mkdirSync(skillDir, { recursive: true })
copyFileSync(SKILL, join(skillDir, 'SKILL.md'))
if (existsSync(README)) copyFileSync(README, join(skillDir, 'README.md'))
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
const ROUND_TIMEOUT = opt('round-timeout', '900') // 每轮 Agent 的壳超时（秒）；超时判「没做完」，不是脚本失败
const AGENT_ENV = { ...process.env, [pathKey]: `${D.shim};${process.env[pathKey]}`, GITRADER_HOME: D.home, WORKER_TIMEOUT: ROUND_TIMEOUT }
const AGENT_PORT = await freePort()
const ENV_NOTE = `环境说明：gitrader 和 gitrader-mcp 命令已经在 PATH 里，GITRADER_HOME 已经设好。这台机器上 47900–49999 的端口被占用了，启动服务请加 --port ${AGENT_PORT}。需要我（人）做的事，请在回复里写清楚；不要问我要 PIN，我会自己在浏览器里设。`

// ---- 工具 -------------------------------------------------------------------------------------
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const shimEntries = () => readJsonl(SHIM_LOG)
function servicePid() { try { return JSON.parse(readFileSync(join(D.home, 'service.json'), 'utf8')) } catch { return null } }
async function serviceLive() {
  const s = servicePid(); if (!s) return null
  try { const r = await fetch(`http://127.0.0.1:${s.port}/api/health`, { signal: AbortSignal.timeout(2000) }); return (await r.json()).ok ? s : null } catch { return null }
}
const latestLink = (port) => { const hits = shimEntries().filter((e) => e.src === 'serve-stdout' || e.src === 'stdout').flatMap((e) => [...e.text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?launch=\S+/g)].map((m) => ({ url: m[0], port: Number(m[1]) }))); return hits.filter((h) => h.port === port).at(-1)?.url ?? null }
/** 壳超时（rc=124）时没有结果 JSON：从会话转录里找回会话号，并按转录里的 usage 累计 token（按消息号去重，取最大值）。 */
function recoverFromTranscripts(sinceMs) {
  const slug = D.agent.replace(/[^A-Za-z0-9]/g, '-')
  const dir = join(CFG_PROJECTS, slug)
  if (!existsSync(dir)) return null
  const f = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs })).filter((x) => x.m >= sinceMs).sort((a, b) => b.m - a.m)[0]
  if (!f) return null
  const byMsg = new Map()
  for (const j of readJsonl(join(dir, f.n))) { const u = j.message?.usage; if (u && j.message?.id) { const p = byMsg.get(j.message.id) ?? {}; for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) p[k] = Math.max(p[k] ?? 0, u[k] ?? 0); byMsg.set(j.message.id, p) } }
  const usage = {}; for (const p of byMsg.values()) for (const k of Object.keys(p)) usage[k] = (usage[k] ?? 0) + p[k]
  return { sid: f.n.replace(/\.jsonl$/, ''), usage }
}
function findTranscript(sid) { for (const d of existsSync(CFG_PROJECTS) ? readdirSync(CFG_PROJECTS) : []) { const f = join(CFG_PROJECTS, d, `${sid}.jsonl`); if (existsSync(f)) return f } return null }

function runAgent(round, prompt, resumeSid) {
  const pf = join(D.rounds, `round-${round}-prompt.md`); writeFileSync(pf, prompt)
  const args = [FLASH, D.agent, pf, 'Read,Write,Edit,Glob,Grep,Bash,mcp__gitrader', TURNS, '--add-dir', D.home, ...(resumeSid ? ['--resume', resumeSid] : [])]
  return new Promise((res) => {
    const t0 = Date.now(); let out = ''
    const p = spawn('bash', args, { env: AGENT_ENV, cwd: D.agent, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    const iv = setInterval(() => { void tick() }, 1500)
    p.on('close', (code) => {
      clearInterval(iv)
      writeFileSync(join(D.rounds, `round-${round}-shell.txt`), out)
      const dir = join(D.agent, '.claude-flash')
      const rf = existsSync(dir) ? readdirSync(dir).filter((f) => /^result-.*\.json$/.test(f)).sort().at(-1) : null
      let j = null; if (rf) { const s = readFileSync(join(dir, rf), 'utf8'); try { j = JSON.parse(s.slice(s.indexOf('{'))) } catch { /* 留空 */ } }
      if (rf) copyFileSync(join(dir, rf), join(D.rounds, `round-${round}-result.json`))
      const rec = j ? null : recoverFromTranscripts(t0 - 5000)
      res({ code, ms: Date.now() - t0, result: j, text: String(j?.result ?? ''), sid: j?.session_id ?? rec?.sid ?? null, usage: j?.usage ?? rec?.usage ?? {}, shell: out })
    })
  })
}

function killMine() {
  const pids = new Set(shimEntries().filter((e) => e.src === 'pid').map((e) => Number(e.text)))
  const s = servicePid(); if (s?.pid) pids.add(s.pid)
  const killed = []
  for (const pid of pids) {
    if (!pid) continue
    const q = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    if (!/node\.exe/i.test(q.stdout)) continue // 只收自己起的 node（核对镜像名，防 PID 复用）
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); killed.push(pid)
  }
  return killed
}

// ---- 4. 回合循环 ------------------------------------------------------------------------------
const human = await createHuman({ playwright: PLAYWRIGHT, edge: EDGE, pin: PIN, shotsDir: D.shots })
const sids = []; const roundLog = []; let cost = 0; let aborted = null; let finalText = []
let approvedAt = null

const humanNotes = [] // 人类已做、还没告诉 Agent 的事
const linksTried = new Set(); let ticking = false
/** 人类一直盯着（真人看得见 serve 的输出和浏览器）：看到新链接就打开并设 PIN，看到待批卡就批准。链接 2 分钟失效，所以不能等 Agent 一轮结束才动。 */
async function tick({ approveWaitMs = 0 } = {}) {
  // 巡视进行中时等它结束再做这一次（否则轮间这次检查会被静默跳过）
  while (ticking) await new Promise((r) => setTimeout(r, 200))
  ticking = true
  try {
    const svc = await serviceLive(); if (!svc) return
    if (!human.isOpen) {
      const link = latestLink(svc.port)
      if (!link) { if (!linksTried.has('none')) { linksTried.add('none'); note(`人类：服务已在跑（端口 ${svc.port}）但还没有可用链接`) } return }
      if (linksTried.has(link)) return
      linksTried.add(link)
      try { await human.open(link) } catch (e) { note(`人类：链接打不开：${String(e.message).slice(0, 120)}`); await human.reset(); return }
    }
    if (!existsSync(join(D.home, 'keys', 'pin.json'))) {
      const r = await human.setPin()
      if (r === 'set') humanNotes.push('我在浏览器里设好 PIN 了')
      else { note(`人类：设 PIN 失败（${r}）：打开链接后页面里没有设置 PIN 的入口（多半是链接已失效）`); await human.reset(); await human.sweep(); return }
      await human.sweep()
    }
    if (await human.approveRequest()) { humanNotes.push('我在工作台批准了接入请求'); await human.sweep() }
    if (await human.approve({ waitMs: approveWaitMs })) { humanNotes.push('我在浏览器里批准了'); approvedAt = Date.now(); await human.sweep() }
  } catch (e) { note(`人类模拟器异常：${String(e.message).slice(0, 160)}`) } finally { ticking = false }
}

/** Agent 是否在等人确认下单金额（ADR-44）。只认「金额 / 多少」类提问，不把普通的「回我一声」当成问金额。 */
function asksAmount(text) {
  const t = String(text ?? '')
  return /(金额|多少钱|买多少|多少 ?USDC|按 ?\d[\d,.]* ?USDC)/.test(t) && /(可以吗|行吗|确认|回我|告诉我|定一下|你定|给个)/.test(t)
}

try {
  let prompt = `${FIRST_PROMPT}\n\n${ENV_NOTE}`; let sid = null
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await runAgent(round, prompt, sid)
    sid = r.sid ?? sid; if (r.sid && !sids.includes(r.sid)) sids.push(r.sid)
    const c = costYuan(r.usage); cost += c
    finalText.push(r.text)
    roundLog.push({ round, rc: r.code, ms: r.ms, turns: r.result?.num_turns ?? null, subtype: r.result?.subtype ?? null, costYuan: Number(c.toFixed(3)), sid: r.sid })
    console.log(`ROUND ${round} rc=${r.code} turns=${r.result?.num_turns} ¥${c.toFixed(2)} (累计 ¥${cost.toFixed(2)})`)
    if (!r.result) { note(`第 ${round} 轮 Agent 没有给出结果 JSON（rc=${r.code}）；会话号${r.sid ? '已从转录找回' : '找不到'}`); if (!r.sid) break }
    if (cost > BUDGET) { aborted = `成本 ¥${cost.toFixed(2)} 超过上限 ¥${BUDGET}，中止`; break }
    if (r.code === 124) note(`第 ${round} 轮 Agent 超时（rc=124）`)
    if (round === MAX_ROUNDS || approvedAt) break
    await tick({ approveWaitMs: 6000 })
    const parts = humanNotes.splice(0)
    // ADR-44：技能要求下单前先问金额（ADR-43）。新手只会照 Agent 的建议答应，不自己编数；没问就不答。
    if (!approvedAt && asksAmount(r.text)) parts.push('金额就按你建议的，可以')
    if (!parts.length) { note(`第 ${round} 轮后人类无事可做（没有要设的 PIN、没有待批卡）：旅程在此停住`); break }
    prompt = `${parts.join('，')}，继续。`
  }
  if (approvedAt && !aborted && cost <= BUDGET) {
    // 批准后再叫 Agent 走完「看结果」
    const r = await runAgent(roundLog.length + 1, '我批准了，继续。', sid)
    cost += costYuan(r.usage); finalText.push(r.text)
    roundLog.push({ round: roundLog.length + 1, rc: r.code, ms: r.ms, turns: r.result?.num_turns ?? null, subtype: r.result?.subtype ?? null, costYuan: Number(costYuan(r.usage).toFixed(3)), sid: r.sid })
    if (r.sid && !sids.includes(r.sid)) sids.push(r.sid)
  }
  await human.sweep()
} finally {
  await human.close()
}
const endMs = Date.now()

// ---- 5. 收尾：只按自己记录的 PID 收进程，再导出账本 ---------------------------------------------------
const killed = killMine(); await sleep(1500)
// B3：ledger export 的 --out 只收 <home>/exports 下的相对路径（受限导出）
const LEDGER_EXPORT = join(D.home, 'exports', 'e0-ledger-export')
const exp = spawnSync(process.execPath, [REAL, 'ledger', 'export', '--home', D.home, '--out', 'e0-ledger-export'], { env: { ...process.env, GITRADER_HOME: D.home }, encoding: 'utf8', windowsHide: true })
writeFileSync(join(D.logs, 'ledger-export.log'), `exit ${exp.status}\n${exp.stdout}\n${exp.stderr}`)
const ledger = readJsonl(join(LEDGER_EXPORT, 'ledger.jsonl'))
if (!ledger.length) note('账本导出为空或失败（见 logs/ledger-export.log）：f/d 项将按「没有首单」判')

// ---- 6. 转录 -> 工件 -> 判决 ------------------------------------------------------------------
const transcript = []; const agentText = [...finalText]
for (const sid of sids) {
  const f = findTranscript(sid); if (!f) { note(`找不到会话转录 ${sid}.jsonl`); continue }
  copyFileSync(f, join(D.tr, `${sid}.jsonl`))
  const t = parseTranscript(readFileSync(f, 'utf8'))
  for (const c of t.transcript) if (!transcript.some((x) => x.id === c.id)) transcript.push(c)
  agentText.push(...t.agentText)
}
const shimStd = shimEntries().filter((e) => e.src === 'cli' || e.src === 'serve')
// serve --detach 的后台服务把输出写在 <home>/logs/serve-*.log：一并交给判据（b）
const detachedLogs = existsSync(join(D.home, 'logs')) ? readdirSync(join(D.home, 'logs')).filter((n) => n.startsWith('serve-') && n.endsWith('.log')).map((n) => ({ src: 'serve', argv: 'serve --detach (' + n + ')', text: readFileSync(join(D.home, 'logs', n), 'utf8') })) : []
shimStd.push(...detachedLogs)
// 判据 j：CLI / serve 的 stdout 里的 error: 行也是用户看得到的
const cliOut = shimEntries().filter((e) => e.src === 'stdout' || e.src === 'serve-stdout').map((e) => ({ src: e.src, argv: e.argv, text: e.text }))
const artifact = {
  transcript, agentText, stderr: [...stderrs, ...shimStd.map((e) => ({ src: e.src, argv: e.argv, text: e.text }))], cliOut,
  browser: human.browserEvidence(), ledger, humanActions: human.actions(), pin: PIN, costYuan: cost, budgetYuan: BUDGET, startMs,
}
// 判据输入原样落盘（去掉测试 PIN），方便复核与改判据后重判
writeFileSync(join(OUT, 'artifact.json'), JSON.stringify({ ...artifact, pin: undefined }, null, 1))
const verdict = judge(artifact)
const humanActions = human.actions()
writeFileSync(join(OUT, 'human-actions.json'), JSON.stringify(humanActions, null, 2))

const report = {
  pass: verdict.pass && !aborted, aborted, firstErrorStep: verdict.firstErrorStep, firstErrorStepName: verdict.firstErrorStepName, firstError: verdict.firstError,
  items: verdict.items, manualReview: verdict.manual ?? [], rounds: roundLog, costYuan: Number(cost.toFixed(3)), elapsedMs: endMs - startMs, installMode,
  firstFillMs: (() => { const f = ledger.find((e) => e.type === 'fill'); return f ? f.ts - startMs : null })(),
  toolCalls: transcript.length, notes, killedPids: killed, humanActions: humanActions.map((h) => h.kind), tgz: basename(TGZ), skill: SKILL,
}
writeFileSync(join(OUT, 'e0-report.json'), JSON.stringify(report, null, 2))

const cmdOf = (c) => String(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? '').replace(/\s+/g, ' ').slice(0, 140)
const md = []
md.push(`# E0 门禁报告`, '', `- 结论：**${report.pass ? '通过' : '不通过（本版不许发）'}**${aborted ? `（${aborted}）` : ''}`,
  `- 第一个报错出现在七步中的第几步：${verdict.firstErrorStep ? `**第 ${verdict.firstErrorStep} 步（${verdict.firstErrorStepName}）**——${verdict.firstError}` : '无'}`,
  `- 轮数 ${roundLog.length}，Agent 工具调用 ${transcript.length} 次，耗时 ${Math.round((endMs - startMs) / 1000)} s，成本约 ¥${cost.toFixed(2)}（估算价，上限 ¥${BUDGET}），安装方式 ${installMode}`,
  `- 人类动作：${humanActions.map((h) => h.kind).join('、') || '无'}`, '', '## 逐项', '', '| 项 | 判据 | 结果 | 数 |', '|---|---|---|---|')
for (const it of verdict.items) md.push(`| ${it.id} | ${it.label} | ${it.pass ? '通过' : it.soft ? '未达（软）' : '**失败**'} | ${it.count} |`)
md.push('', '## 失败明细（每项最多 12 条）', '')
for (const it of verdict.items) if (it.details.length && !(it.pass && it.soft)) { md.push(`### ${it.id} ${it.label}`); for (const d of it.details) md.push(`- ${d}`); md.push('') }
md.push('## j 项：探测性调用（--help 等）的报错，请人工看，不判败', '', ...(verdict.manual?.length ? verdict.manual.map((t) => `- ${t}`) : ['- 无']), '')
md.push('## 屏上英文整句 / toast 原文（软提示，不进判据）', '', ...(artifact.browser.englishLines?.length ? artifact.browser.englishLines.map((t) => `- ${t}`) : ['- 无']), '')
md.push('## Agent 命令序列（节选，✘ = 该调用判失败）', '')
for (const c of transcript.slice(0, 80)) md.push(`- ${c.isError || /Exit code [1-9]/.test(c.output) ? '✘' : '·'} ${c.name}: ${cmdOf(c)}`)
md.push('', '## 过程记录', '', ...(notes.length ? notes.map((n) => `- ${n}`) : ['- 无']), '', '## 工件路径', '',
  `- 报告 JSON：${join(OUT, 'e0-report.json')}`, `- 转录：${D.tr}`, `- 每轮提示词 / 结果：${D.rounds}`, `- 人类动作：${join(OUT, 'human-actions.json')}`, `- 截图：${D.shots}`, `- 垫片日志（CLI / serve 输出）：${SHIM_LOG}`, `- 账本导出：${LEDGER_EXPORT}`, `- 安装日志：${join(D.logs, 'install.log')}`, '',
  '## Agent 每轮最后一句话', '', ...finalText.map((t, i) => `**第 ${i + 1} 轮**\n\n${String(t).slice(0, 1200).split(/\r?\n/).map((l) => '> ' + l).join('\n')}\n`))
writeFileSync(join(OUT, 'E0-REPORT.md'), md.join('\n'))
console.log(`${report.pass ? 'PASS' : 'FAIL'}  firstErrorStep=${verdict.firstErrorStep}  report: ${join(OUT, 'E0-REPORT.md')}`)
process.exit(report.pass ? 0 : 1)
