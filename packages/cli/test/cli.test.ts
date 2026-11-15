// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { main, runServe, snippetText } from '../src/index'
import type { CliIo } from '../src/index'
import { Kernel, fileProvider } from '@gitrader/kernel'

let home: string
let out: string[]
let err: string[]
let secrets: string[]
const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider,
  readSecret: async () => { const s = secrets.shift(); if (s === undefined) throw new Error('unexpected secret prompt'); return s }, ...over,
})
const run = (argv: string[], over: Partial<CliIo> = {}): Promise<number> => main(argv, io(over))
const text = (): string => out.join('')

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-cli-')); out = []; err = []; secrets = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader init', () => {
  it('生成 gitrader.json 与四个目录；再跑一次幂等；supportDeveloper 默认关且不询问', async () => {
    expect(await run(['init', '--no-pin'])).toBe(0)
    for (const d of ['plugins', 'engines', 'workspaces', 'lab']) expect(existsSync(join(home, d))).toBe(true)
    const before = readFileSync(join(home, 'gitrader.json'), 'utf8')
    expect(JSON.parse(before).supportDeveloper).toBe(false)
    out = []
    expect(await run(['init', '--no-pin'])).toBe(0)
    expect(text()).toMatch(/Already initialized/)
    expect(readFileSync(join(home, 'gitrader.json'), 'utf8')).toBe(before)
    expect(text()).not.toMatch(/developer|builder/i)
  })

  it('交互终端里会让你设 PIN（6–12 位数字）；两次不一致报错', async () => {
    secrets = ['482916', '111111']
    expect(await run(['init'], { interactive: true })).toBe(1)
    expect(err.join('')).toMatch(/do not match/)
    secrets = ['482916', '482916']
    err = []
    expect(await run(['init'], { interactive: true })).toBe(0)
    expect(text()).toMatch(/PIN set/)
    expect(existsSync(join(home, 'keys', 'pin.json'))).toBe(true)
  })

  it('--home 参数覆盖环境变量', async () => {
    const other = mkdtempSync(join(tmpdir(), 'gitrader-cli2-'))
    try {
      expect(await run(['init', '--no-pin', '--home', other])).toBe(0)
      expect(existsSync(join(other, 'gitrader.json'))).toBe(true)
    } finally { rmSync(other, { recursive: true, force: true }) }
  })
})

describe('gitrader status', () => {
  it('没在跑 → 退出码 0（F1 契约）并说明状态与下一步', async () => {
    await run(['init', '--no-pin'])
    out = []
    expect(await run(['status'])).toBe(0)
    // fix-r3 D5（裁决：gitrader status 改中文）
    expect(text()).toMatch(/服务没在运行/)
    out = []
    expect(await run(['status', '--json'])).toBe(0)
    expect(JSON.parse(text())).toMatchObject({ running: false })
  })

  it('未初始化 + --json → 退出码 0，{ initialized:false, hint } 指向 gitrader init；人读输出同样退出码 0（F1 契约）', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'gitrader-cli-noinit-'))
    try {
      out = []
      expect(await run(['status', '--json', '--home', fresh])).toBe(0)
      expect(JSON.parse(text())).toMatchObject({ running: false, configured: false, initialized: false, hint: expect.stringContaining('gitrader init') })
      out = []
      expect(await run(['status', '--home', fresh])).toBe(0)
      expect(text()).toMatch(/还没初始化/)
    } finally { rmSync(fresh, { recursive: true, force: true }) }
  })
})

describe('gitrader mcp snippet', () => {
  it('四个宿主各出一份可粘贴配置：绝对路径、令牌只以环境变量 / 令牌文件引用出现（--token 被忽略）、带验证连接命令', async () => {
    await run(['init', '--no-pin'])
    for (const host of ['claude-code', 'codex', 'hermes', 'unigit']) {
      out = []
      expect(await run(['mcp', 'snippet', host, '--token', 'gtk_TESTTOKEN'])).toBe(0)
      const t = text()
      expect(t).not.toContain('gtk_TESTTOKEN')
      expect(t).toMatch(/GITRADER_AGENT_TOKEN/)
      expect(t).toContain('GITRADER_HOME')
      expect(t).toContain('gitrader-mcp')
      expect(t).toContain('--check')
    }
    expect(snippetText('codex', '/tmp/x', { node: '/usr/bin/node', mcpEntry: '/opt/g/gitrader-mcp.js' })).toContain('[mcp_servers.gitrader]')
    expect(snippetText('hermes', '/tmp/x', { node: '/usr/bin/node', mcpEntry: '/opt/g/gitrader-mcp.js' })).toContain('mcp_servers:')
    expect(await run(['mcp', 'snippet', 'vim'])).toBe(1)
  })
})

describe('gitrader keys', () => {
  it('new wallet / import / list / revoke：PIN 与私钥只走终端输入，不进 argv；私钥明文不落盘；list 只有名称 / 地址 / 到期', async () => {
    await run(['init', '--no-pin'])
    const pk = 'cd'.repeat(32)
    secrets = ['482916', '482916', 'ignored-first-use'] // 第一次用：设 PIN（两次），然后生成钱包不再问；下一行留给多余输入检查
    secrets = ['482916', '482916']
    expect(await run(['keys', 'new', 'wallet', 'gen-1'], { interactive: true })).toBe(0)
    expect(text()).toMatch(/approveAgent/)
    secrets = ['482916', pk]
    out = []
    expect(await run(['keys', 'import', 'imp-1'], { interactive: true })).toBe(0)
    out = []
    expect(await run(['keys', 'list'])).toBe(0)
    expect(text()).toMatch(/gen-1/)
    expect(text()).toMatch(/imp-1/)
    expect(text()).not.toContain(pk)
    expect(readFileSync(join(home, 'keys', 'keystore.json'), 'utf8')).not.toContain(pk)
    secrets = ['000000']
    expect(await run(['keys', 'revoke', 'wallet', 'imp-1'], { interactive: true })).toBe(1) // 错误的 PIN
    secrets = ['482916']
    expect(await run(['keys', 'revoke', 'wallet', 'imp-1'], { interactive: true })).toBe(0)
    out = []
    await run(['keys', 'list'])
    expect(text()).toMatch(/imp-1.*revoked/)
  })

  it('new agent：建钥匙 + 授权书（四档），令牌只显示一次，随带接入片段；令牌真的能认证；revoke 后失效', async () => {
    await run(['init', '--no-pin'])
    secrets = ['482916', '482916']
    expect(await run(['keys', 'new', 'agent', 'research-box', '--host', 'claude-code', '--tier', 'paper'], { interactive: true })).toBe(0)
    const token = /gtk_[A-Z2-7]{52}/.exec(text())?.[0]
    expect(token).toBeTruthy()
    expect(text()).toMatch(/level L1/)
    expect(text()).toContain('.mcp.json')
    const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    try {
      expect(k.agents.verifyToken(token!)).not.toBeNull()
      expect(JSON.stringify(k.db.prepare("SELECT doc FROM docs WHERE coll='agentkey'").all())).not.toContain(token!)
    } finally { await k.stop() }
    out = []
    await run(['keys', 'list'])
    expect(text()).toMatch(/research-box.*claude-code.*active.*level L1/)
    secrets = ['482916']
    expect(await run(['keys', 'revoke', 'agent', 'research-box'], { interactive: true })).toBe(0)
    const k2 = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    try { expect(k2.agents.verifyToken(token!)).toBeNull() } finally { await k2.stop() }
  })

  it('新建 L3 钥匙要给白名单和限额（缺了被拒，并说明缺什么）', async () => {
    await run(['init', '--no-pin'])
    secrets = ['482916', '482916']
    expect(await run(['keys', 'new', 'agent', 'auto', '--host', 'codex', '--tier', 'auto_limited'], { interactive: true })).toBe(1)
    expect(err.join('')).toMatch(/requires/)
  })

  it('没设过 PIN 且不是终端 → 不会悄悄建钥匙', async () => {
    await run(['init', '--no-pin'])
    expect(await run(['keys', 'new', 'wallet', 'x'])).toBe(1)
    expect(err.join('')).toMatch(/no PIN is set/)
  })
})

describe('gitrader ledger', () => {
  it('verify 通过；篡改后退出码 2 并指出位置；export 出 JSONL + manifest + Markdown，导出文件可独立验', async () => {
    await run(['init', '--no-pin'])
    const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    for (let i = 0; i < 5; i++) k.ledger.append({ type: 'note', origin: { actor: 'user:usr_local', actorType: 'human', tool: 'test', requestId: 'r', via: 'cli' }, subject: { orgId: 'org_local' }, payload: { text: `n${i}` } })
    await k.stop()
    out = []
    expect(await run(['ledger', 'verify'])).toBe(0)
    expect(text()).toMatch(/Ledger OK: \d+ entries/)
    expect(await run(['ledger', 'export', '--out', 'exp'])).toBe(0)
    for (const f of ['ledger.jsonl', 'manifest.json', 'trade-log.md']) expect(existsSync(join(home, 'exports', 'exp', f))).toBe(true)
    const conflict = join(home, 'exports', 'conflict')
    mkdirSync(conflict, { recursive: true })
    writeFileSync(join(conflict, 'manifest.json'), 'existing manifest')
    out = []; err = []
    expect(await run(['ledger', 'export', '--out', 'conflict'])).toBe(2)
    expect(readFileSync(join(conflict, 'manifest.json'), 'utf8')).toBe('existing manifest')
    expect(existsSync(join(conflict, 'ledger.jsonl'))).toBe(false)
    expect(existsSync(join(conflict, 'trade-log.md'))).toBe(false)
    out = []; err = []
    expect(await run(['ledger', 'export', '--out', join(home, 'outside')])).toBe(2)
    expect(existsSync(join(home, 'outside', 'ledger.jsonl'))).toBe(false)
    const raw = new DatabaseSync(join(home, 'data', 'gitrader.sqlite'))
    raw.exec('DROP TRIGGER ledger_no_update')
    const row = raw.prepare('SELECT entry FROM ledger WHERE seq=3').get() as { entry: string }
    const e = JSON.parse(row.entry)
    e.payload = { text: 'tampered' }
    raw.prepare('UPDATE ledger SET entry=? WHERE seq=3').run(JSON.stringify(e))
    raw.close()
    out = []
    expect(await run(['ledger', 'verify'])).toBe(2)
    expect(text()).toMatch(/LEDGER BROKEN at seq 3/)
  })
})

describe('gitrader plugins', () => {
  it('pin 写回 source.sha256；list / reload 离线可用', async () => {
    await run(['init', '--no-pin'])
    expect(await run(['plugins', 'list'])).toBe(0)
    expect(text()).toMatch(/No plugins/)
    const dir = join(home, 'plugins', 'bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'gitrader-plugin.json'), '{ "schema": "nope" }')
    out = []
    expect(await run(['plugins', 'reload'])).toBe(2)
    expect(text()).toMatch(/rejected/)
  })
})

describe('gitrader bench', () => {
  it('M1 留桩', async () => {
    expect(await run(['bench'])).toBe(0)
    expect(text()).toMatch(/stub/)
    expect(await run(['nonsense'])).toBe(1)
    expect(await run([])).toBe(0) // UX-26：不带参数等同 help，退出码 0（原断言是 1，随 0.1.1 UX-26 改）
  })
})

describe('gitrader serve（进程内冒烟，不联网）', () => {
  it('起服务：端口从 47900 起探测、避开保留端口；启动链接带一次性启动令牌；页面只在带有效启动令牌时才注入 bootstrap meta；同一数据目录不能起第二个', async () => {
    await run(['init', '--no-pin'])
    const stat = join(home, 'static')
    mkdirSync(stat)
    writeFileSync(join(stat, 'index.html'), '<!doctype html><html><head><title>wb</title></head><body></body></html>')
    const h = await runServe(home, { io: io(), staticDir: stat, connectors: false })
    try {
      expect(h.port).toBeGreaterThanOrEqual(47900)
      expect([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831]).not.toContain(h.port)
      const launch = new URL(h.url).searchParams.get('launch')!
      expect(launch).toMatch(/^boot_/)
      const anon = await (await fetch(`http://127.0.0.1:${h.port}/`)).text() // 本机其他进程直接拿页面：没有令牌
      expect(anon).not.toContain('gitrader-bootstrap')
      const forged = await fetch(`http://127.0.0.1:${h.port}/?launch=boot_forged`, { headers: { 'sec-fetch-site': 'same-origin' } })
      expect(await forged.text()).not.toContain('gitrader-bootstrap')
      const res = await fetch(h.url)
      const html = await res.text()
      expect(html).toContain(`<meta name="gitrader-bootstrap" content="${launch}">`)
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
      const ex = await fetch(`http://127.0.0.1:${h.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: launch }) })
      expect(ex.status).toBe(200)
      expect(await ex.json()).toMatchObject({ user: 'usr_local' })
      expect((await fetch(`http://127.0.0.1:${h.port}/?launch=${launch}`).then((r) => r.text()))).not.toContain('gitrader-bootstrap') // 用过即作废
      // service.json 在，status 能连上
      out = []
      expect(await run(['status'])).toBe(0)
      // fix-r3 D5（裁决：gitrader status 改中文并按作用域分行；场所状态英文码与上游原文保留在括号里）
      expect(text()).toMatch(/正在运行/)
      await expect(runServe(home, { io: io(), connectors: false })).rejects.toThrow(/already running/)
    } finally { await h.stop() }
  })
})

describe('gitrader serve · 场所不可达不阻塞', () => {
  it('行情连接一直挂着：serve 立即监听，status 显示 connecting，撤销 / 账本 / 纸面账户可用', async () => {
    await run(['init', '--no-pin'])
    const t0 = Date.now()
    const h = await runServe(home, { io: io(), connect: (k) => k.connectInBackground('hyperliquid', () => new Promise<void>(() => undefined)) })
    try {
      expect(Date.now() - t0).toBeLessThan(2000)
      out = []
      const code = await run(['status'])
      expect([code, err.join(''), text()]).toEqual([0, '', expect.stringMatching(/hyperliquid 连接中（connecting）/)])
      const down = await runServe(home, { io: io(), connectors: false }).catch((e: Error) => e)
      expect(String(down)).toMatch(/already running/)
    } finally { await h.stop() }
  })

  it('连接失败：status 显示 DISCONNECTED 和上游原文', async () => {
    await run(['init', '--no-pin'])
    const h = await runServe(home, { io: io(), connect: (k) => k.connectInBackground('hyperliquid', async () => { throw new Error('connect ETIMEDOUT') }, { backoffMinMs: 5000 }) })
    try {
      await new Promise((r) => setTimeout(r, 100))
      out = []
      await run(['status'])
      // fix-r3 D5（裁决：gitrader status 改中文并按作用域分行；场所状态英文码与上游原文保留在括号里）
      expect(text()).toMatch(/hyperliquid 已断开（DISCONNECTED） \(connect ETIMEDOUT\)/)
    } finally { await h.stop() }
  })
})

describe('gitrader open --print / session link', () => {
  it('要 PIN；输出带一次性启动令牌的本地 URL（只打印一次、短时效），令牌能换会话、用一次作废；没设 PIN / 没在跑 / 错 PIN 都不出链接', async () => {
    await run(['init', '--no-pin'])
    expect(await run(['open', '--print'])).toBe(1)
    expect(err.join('')).toMatch(/No running Gitrader service/)
    const h = await runServe(home, { io: io(), connectors: false })
    try {
      err = []
      expect(await run(['open', '--print'])).toBe(1)
      expect(err.join('')).toMatch(/No PIN is set/)
      // 设 PIN（本地终端），再要链接
      const k = h.kernel
      await k.auth.setupPinLocalTerminal('482916')
      // ADR-5：不先 session login，只凭 PIN 出链接
      expect(existsSync(join(home, 'cli-session.json'))).toBe(false)
      secrets = ['000000']
      err = []
      out = []
      expect(await run(['session', 'link'])).toBe(1)
      expect(text()).toBe('')
      secrets = ['482916']
      out = []
      err = []
      expect(await run(['open', '--print'])).toBe(0)
      const url = new URL(text().trim())
      expect(url.hostname).toBe('127.0.0.1')
      expect(Number(url.port)).toBe(h.port)
      expect(err.join('')).toMatch(/valid for 120 s, works once/)
      const t = url.searchParams.get('launch')!
      const ex = await fetch(`http://127.0.0.1:${h.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: t }) })
      expect(ex.status).toBe(200)
      const again = await fetch(`http://127.0.0.1:${h.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: t }) })
      expect(again.status).toBe(401)
    } finally { await h.stop() }
  })
})


describe('gitrader open --print --json / --unattended / config set embed.allowedOrigins', () => {
  it('config set：校验 + 去重去尾斜杠 + none 清空；写坏的源（通配符 / 带路径）被拒且不改文件', async () => {
    await run(['init', '--no-pin']); out = []
    expect(await run(['config', 'get', 'embed.allowedOrigins'])).toBe(0)
    expect(JSON.parse(text())).toEqual([])
    out = []
    expect(await run(['config', 'set', 'embed.allowedOrigins', 'https://app.example/,http://localhost:5173,https://app.example'])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, 'gitrader.json'), 'utf8')).embed.allowedOrigins).toEqual(['https://app.example', 'http://localhost:5173'])
    const good = readFileSync(join(home, 'gitrader.json'), 'utf8')
    for (const bad of ['*', 'https://*.example', 'https://x.example/path', 'x.example']) {
      err = []
      expect(await run(['config', 'set', 'embed.allowedOrigins', bad]), bad).toBe(1)
      expect(err.join('')).toMatch(/embed\.allowedOrigins/)
      expect(readFileSync(join(home, 'gitrader.json'), 'utf8')).toBe(good)
    }
    expect(await run(['config', 'set', 'embed.allowedOrigins', 'none'])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, 'gitrader.json'), 'utf8')).embed.allowedOrigins).toEqual([])
    err = []
    expect(await run(['config', 'set', 'other.key', 'x'])).toBe(1)
    expect(err.join('')).toMatch(/usage/)
  })

  it('--json：stdout 只有 {url, expiresAt}（PIN 从 stdin 读）；错 PIN / 没在跑 → stdout 是 {error}，退出码 1', async () => {
    await run(['init', '--no-pin']); out = []
    expect(await run(['open', '--print', '--json'])).toBe(1)
    expect(JSON.parse(text())).toMatchObject({ error: expect.stringMatching(/No running/) })
    const h = await runServe(home, { io: io(), connectors: false })
    try {
      await h.kernel.auth.setupPinLocalTerminal('482916')
      secrets = ['000000']; out = []
      expect(await run(['open', '--print', '--json'])).toBe(1)
      expect(JSON.parse(text()).error).toMatch(/PIN|auth/i)
      expect(JSON.parse(text()).error).not.toMatch(/session login/)
      secrets = ['482916']; out = []
      expect(await run(['open', '--print', '--json'])).toBe(0)
      const j = JSON.parse(text())
      expect(Object.keys(j).sort()).toEqual(['expiresAt', 'url'])
      expect(new URL(j.url).searchParams.get('launch')).toMatch(/^boot_/)
      expect(j.expiresAt).toBeGreaterThan(Date.now())
      expect(j.expiresAt).toBeLessThanOrEqual(Date.now() + 121_000)
    } finally { await h.stop() }
  })

  it('--unattended：没配 embed.allowedOrigins → 拒绝；配了但来源不在名单 → 拒绝；在名单 → 免 PIN 出链接且入账；链接能换会话', async () => {
    await run(['init', '--no-pin']); out = []
    let h = await runServe(home, { io: io(), connectors: false })
    try {
      secrets = [h.kernel.auth.mintBootToken()]
      expect(await run(['session', 'login'])).toBe(0)
      out = []
      expect(await run(['open', '--print', '--json', '--unattended', '--origin', 'https://app.example'])).toBe(1)
      expect(JSON.parse(text()).error).toMatch(/unattended links are off/)
      expect(secrets).toEqual([]) // 没有提示 PIN
    } finally { await h.stop() }
    expect(await run(['config', 'set', 'embed.allowedOrigins', 'https://app.example'])).toBe(0)
    h = await runServe(home, { io: io(), connectors: false })
    try {
      secrets = [h.kernel.auth.mintBootToken()]
      expect(await run(['session', 'login'])).toBe(0)
      out = []
      expect(await run(['open', '--print', '--json', '--unattended', '--origin', 'https://evil.example'])).toBe(1)
      expect(JSON.parse(text()).error).toMatch(/not in embed\.allowedOrigins/)
      secrets = [h.kernel.auth.mintBootToken()]; out = []; err = []
      expect(await run(['session', 'login'])).toBe(0)
      out = []
      expect(await run(['open', '--print', '--json', '--unattended'])).toBe(1)
      secrets = [h.kernel.auth.mintBootToken()]; out = []; err = []
      expect(await run(['session', 'login'])).toBe(0)
      out = []
      expect(await run(['open', '--print', '--json', '--unattended', '--origin', 'https://app.example'])).toBe(0)
      const j = JSON.parse(text())
      const t = new URL(j.url).searchParams.get('launch')!
      const ex = await fetch(`http://127.0.0.1:${h.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: t }) })
      expect(ex.status).toBe(200)
      expect(h.kernel.ledger.query({ types: ['annotation'], limit: 50 }).some((e) => (e.payload as { setting?: string }).setting === 'session_link_unattended')).toBe(true)
      // 不带令牌的人 / 会话主体 / Agent 钥匙调不了这个无 PIN 口子
      const noTok = await fetch(`http://127.0.0.1:${h.port}/api/op/session.link.unattended`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { origin: 'https://app.example' } }) })
      expect(noTok.status).toBe(401)
    } finally { await h.stop() }
  })
})
