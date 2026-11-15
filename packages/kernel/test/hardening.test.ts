// SPDX-License-Identifier: CPAL-1.0
// H 安全审的内核项：口令 KDF 加强 + 设备密钥（DPAPI）、8–64 位口令、iframe 嵌入、刷新后会话丢失的提示、clientOrderId 幂等与 order.lookup。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scryptSync } from 'node:crypto'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { tx } from '../src/db'
import { DeviceKey, dpapiProvider, fileProvider } from '../src/device-key'
import { DEFAULT_SCRYPT, PinStore, isAcceptablePin, pinHint } from '../src/pin'
import { validateConfig, defaultConfig } from '../src/config'
import { FakeClock } from '../src/util/clock'
import { BTC } from './helpers/fake-connector'
import { FAST_SCRYPT, TEST_PIN, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'gitrader-hard-'))

describe('KDF 加强 + 设备密钥', () => {
  it('默认 scrypt 参数是 N=2^17, r=8, p=1；真参数下设置 / 校验可用（一次约零点几秒）', async () => {
    expect(DEFAULT_SCRYPT).toEqual({ N: 131072, r: 8, p: 1 })
    const dir = tmp()
    try {
      const dk = new DeviceKey(join(dir, 'device.key.json'), fileProvider)
      const ps = new PinStore(join(dir, 'pin.json'), new FakeClock(), DEFAULT_SCRYPT, dk)
      const t0 = Date.now()
      const key = await ps.setup('482916')
      const setupMs = Date.now() - t0
      expect((await ps.verify('482916')).equals(key)).toBe(true)
      expect(setupMs).toBeLessThan(10_000)
      expect(JSON.parse(readFileSync(join(dir, 'pin.json'), 'utf8'))).toMatchObject({ version: 2, kdf: { N: 131072, r: 8, p: 1 } })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)

  it('主密钥 = HKDF(scrypt(口令), 设备密钥)：只拷走 pin.json + keystore.json、没有设备密钥文件，就验不了口令、也派生不出主密钥（离线穷举失效）', async () => {
    const dir = tmp()
    const clock = new FakeClock()
    try {
      const ps = new PinStore(join(dir, 'pin.json'), clock, FAST_SCRYPT, new DeviceKey(join(dir, 'device.key.json'), fileProvider))
      const key = await ps.setup('482916')
      // 攻击者的离线穷举：只有 pin.json —— 用正确口令算 scrypt，得到的值与校验值对不上
      const f = JSON.parse(readFileSync(join(dir, 'pin.json'), 'utf8'))
      const pinOnly = scryptSync('482916', Buffer.from(f.kdf.salt, 'base64'), 32, { N: f.kdf.N, r: f.kdf.r, p: f.kdf.p })
      expect(pinOnly.equals(key)).toBe(false)
      // 拷走文件到“别处”（没有设备密钥文件）：正确口令也过不了，错误信息指向设备密钥，且不计入失败退避
      const copy = new PinStore(join(dir, 'pin.json'), clock, FAST_SCRYPT, new DeviceKey(join(dir, 'elsewhere', 'device.key.json'), fileProvider))
      await expect(copy.verify('482916')).rejects.toThrow(/device key/)
      expect(copy.status().failures).toBe(0)
      // 原机原用户：正常
      const home = new PinStore(join(dir, 'pin.json'), clock, FAST_SCRYPT, new DeviceKey(join(dir, 'device.key.json'), fileProvider))
      expect((await home.verify('482916')).equals(key)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('密钥库：用拷走的文件 + 正确口令也解不开私钥；有设备密钥才行；改口令后换钥', async () => {
    const h = await makeHarness()
    try {
      const pin = await h.pinProof()
      const w = h.k.keystore.generate(pin, { name: 'w-1' })
      h.k.keystore.lock()
      const stolen = tmp()
      mkdirSync(join(stolen, 'keys'), { recursive: true })
      for (const f of ['pin.json', 'keystore.json']) copyFileSync(join(h.home, 'keys', f), join(stolen, 'keys', f))
      expect(existsSync(join(stolen, 'keys', 'device.key.json'))).toBe(false)
      const ps = new PinStore(join(stolen, 'keys', 'pin.json'), new FakeClock(), FAST_SCRYPT, new DeviceKey(join(stolen, 'keys', 'device.key.json'), fileProvider))
      await expect(ps.verify(TEST_PIN)).rejects.toThrow(/device key/)
      rmSync(stolen, { recursive: true, force: true })
      // 本机：正常解锁并签名
      h.k.keystore.unlock(await h.k.auth.pinProof(h.session, TEST_PIN))
      expect(h.k.keystore.getSigner(w.name).address).toBe(w.address)
    } finally { await h.cleanup() }
  })

  it.runIf(process.platform === 'win32')('Windows DPAPI（CurrentUser）：设备密钥文件里是密文，不是原文；解得回；同进程内只走一次子进程（缓存）', async () => {
    const dir = tmp()
    try {
      const path = join(dir, 'device.key.json')
      const dk = new DeviceKey(path, dpapiProvider)
      const raw = (await dk.get(true))!
      expect(raw.length).toBe(32)
      const f = JSON.parse(readFileSync(path, 'utf8'))
      expect(f.provider).toBe('dpapi-currentuser')
      expect(Buffer.from(f.blob, 'base64').equals(raw)).toBe(false)
      expect(f.blob).not.toContain(raw.toString('base64'))
      const fresh = new DeviceKey(path, dpapiProvider)
      expect((await fresh.get(false))!.equals(raw)).toBe(true)
      const t0 = Date.now()
      await fresh.get(false)
      expect(Date.now() - t0).toBeLessThan(50) // 缓存：不再起子进程
      // 用文件方式打开 DPAPI 写的文件会被拒绝（防止降级）
      await expect(new DeviceKey(path, fileProvider).get(false)).rejects.toThrow(/written by dpapi/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})

describe('口令格式：6–12 位数字，或 8–64 位任意字符；提示更长更安全', () => {
  it('接受 / 拒绝', () => {
    for (const ok of ['482916', '123456789012', '1234567890123', 'correct horse battery', 'Aa1!Aa1!', 'x'.repeat(64)]) expect(isAcceptablePin(ok), ok).toBe(true)
    for (const bad of ['12345', 'abcdefg', 'x'.repeat(65), '', 12345 as never]) expect(isAcceptablePin(bad), String(bad)).toBe(false)
    expect(pinHint('482916')).toMatch(/longer PIN is safer/)
    expect(pinHint('correct horse battery')).toBeUndefined()
    expect(pinHint('1234567890')).toBeUndefined()
  })

  it('pin.set 接受口令并解锁；纯数字短 PIN 回 hint；退避曲线不变（3 次免费，第 4 次起 1 s、2 s …）', async () => {
    const h = await makeHarness()
    try {
      const op = (name: string, params: Record<string, unknown>, pin?: string): Promise<any> => h.k.ops.call(h.k, name, { principal: h.session, params, transport: 'ws', ...(pin ? { pin } : {}) }) // eslint-disable-line @typescript-eslint/no-explicit-any
      await expect(op('pin.set', { pin: 'short' })).rejects.toMatchObject({ problem: { code: -32602 } })
      const r = await op('pin.set', { pin: 'correct horse battery' })
      expect(r).toMatchObject({ ok: true, changed: false })
      expect(r.hint).toBeUndefined()
      expect(h.k.keystore.isUnlocked()).toBe(true)
      const bad = (): Promise<unknown> => op('keystore.unlock', {}, 'wrong passphrase!')
      for (let i = 0; i < 3; i++) await expect(bad()).rejects.toMatchObject({ problem: { code: 5003 } })
      await expect(bad()).rejects.toMatchObject({ problem: { retryAfterMs: 1000 } })
      h.clock.advance(1100)
      await expect(bad()).rejects.toMatchObject({ problem: { retryAfterMs: 2000 } })
      h.clock.advance(2100)
      await op('keystore.unlock', {}, 'correct horse battery')
      // 改成纯数字短 PIN：允许，但带提示
      const ch = await op('pin.set', { pin: '135790' }, 'correct horse battery')
      expect(ch).toMatchObject({ changed: true })
      expect(ch.hint).toMatch(/longer PIN is safer/)
    } finally { await h.cleanup() }
  })
})

describe('iframe 嵌入（embed.allowedOrigins）', () => {
  let h: Harness
  let port = 0
  let stat = ''
  const html = '<!doctype html><html><head><title>wb</title></head><body><div id="app"></div></body></html>'
  async function boot(origins?: string[]): Promise<void> {
    h = await makeHarness({ configure: (c) => { if (origins) c.embed = { allowedOrigins: origins } } })
    stat = join(h.home, 'static')
    mkdirSync(stat)
    writeFileSync(join(stat, 'index.html'), html)
    port = (await h.k.start({ port: 0, staticDir: stat })).port
  }
  afterEach(async () => { await h?.cleanup() })
  // 不用 fetch：undici 会改写 sec-fetch-* 头；这里要原样发浏览器 iframe 导航的头
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: { get(k: string): string | null }; text(): Promise<string> }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { body += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] ?? null : v ?? null } }, text: async () => body }))
      })
      req.on('error', reject)
      req.end()
    })
  const iframeNav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' }

  it('默认空 = 禁止被嵌：CSP frame-ancestors none，iframe 导航（跨站）被拒', async () => {
    await boot()
    expect(h.k.config.embed?.allowedOrigins ?? []).toEqual([])
    const same = await get('/')
    expect(same.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect((await get('/', iframeNav)).status).toBe(403)
  })

  it('配置了允许源：响应 frame-ancestors 列表；iframe 导航放行；launch 链接换票在 iframe 内也能工作；API 仍要令牌', async () => {
    await boot(['https://app.unigit.example', 'http://localhost:5173'])
    const launch = h.k.auth.mintBootToken()
    const r = await get(`/?launch=${launch}`, iframeNav)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).toContain('frame-ancestors https://app.unigit.example http://localhost:5173;')
    const text = await r.text()
    expect(text).toContain(`<meta name="gitrader-bootstrap" content="${launch}">`)
    expect(text).not.toContain('gitrader-relink-hint')
    // iframe 内的页面脚本换票：同源请求（Origin 是服务自己的源）
    const ex = await fetch(`http://127.0.0.1:${port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ bootstrap: launch }) })
    expect(ex.status).toBe(200)
    expect(((await ex.json()) as { sessionToken: string }).sessionToken).toMatch(/^ses_/)
    // 跨站的 API 请求、跨站的非 iframe 导航、POST 仍然被拒
    expect((await get('/api/op/status', iframeNav, 'POST')).status).toBe(403)
    expect((await get('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' })).status).toBe(403)
    expect((await get('/api/health', iframeNav)).status).toBe(403)
  })

  it('配置校验：只接受 scheme://host[:port] 的源，不许通配符 / 路径', () => {
    const c = defaultConfig() as any // eslint-disable-line @typescript-eslint/no-explicit-any
    c.embed = { allowedOrigins: ['https://ok.example', 'http://localhost:5173'] }
    expect(validateConfig(c)).toEqual([])
    for (const bad of ['*', 'https://*.example', 'https://x.example/path', 'ftp://x', 'x.example']) {
      c.embed = { allowedOrigins: [bad] }
      expect(validateConfig(c).join(), bad).toMatch(/embed\.allowedOrigins\[0\]/)
    }
    delete c.embed // 旧配置没有这一项：当作空
    expect(validateConfig(c)).toEqual([])
  })
})

describe('刷新页面后会话丢失：引导页明确提示拿新链接（令牌只在内存，刷新即丢，这是设计）', () => {
  let h: Harness
  afterEach(async () => { await h?.cleanup() })
  it('没有有效启动令牌（没带 / 过期 / 已用过）的页面带提示且不含令牌；有效令牌的页面不带提示', async () => {
    h = await makeHarness()
    const stat = join(h.home, 'static')
    mkdirSync(stat)
    writeFileSync(join(stat, 'index.html'), '<!doctype html><html><head></head><body class="x"><div id="app"></div></body></html>')
    const { port } = await h.k.start({ port: 0, staticDir: stat })
    const page = async (q = ''): Promise<string> => (await fetch(`http://127.0.0.1:${port}/${q}`)).text()
    const launch = h.k.auth.mintBootToken()
    const good = await page(`?launch=${launch}`)
    expect(good).toContain('gitrader-bootstrap')
    expect(good).not.toContain('gitrader-relink-hint')
    // 页面里的脚本换票（消耗令牌）；用户刷新页面 → 同一个链接再来：令牌已作废
    await fetch(`http://127.0.0.1:${port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: launch }) })
    for (const again of [await page(`?launch=${launch}`), await page(''), await page('?launch=boot_forged')]) {
      expect(again).toContain('id="gitrader-relink-hint"')
      expect(again).toContain('<code>gitrader open</code>') // fix-r1 裁决 7：失效提示改为可走通的两步（serve 窗口按 Enter / gitrader open）
      expect(again).not.toContain('gitrader-bootstrap')
      expect(again).toMatch(/<body class="x"><div id="gitrader-relink-hint"/)
    }
    // 过期
    const short = h.k.auth.mintBootToken(1000)
    h.clock.advance(2000)
    expect(await page(`?launch=${short}`)).toContain('gitrader-relink-hint')
  })
})

describe('clientOrderId 幂等 + order.lookup（MCP 超时后查而不是重发）', () => {
  let h: Harness
  beforeEach(async () => { h = await makeHarness() })
  afterEach(async () => { await h.cleanup() })
  const mk = (o: Record<string, unknown> = {}): any => ({ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01', leverage: 2, reason: 'x', ...o }) // eslint-disable-line @typescript-eslint/no-explicit-any
  const lookup = (ctx: { principal: any }, params: Record<string, unknown>): Promise<any> => h.k.ops.call(h.k, 'order.lookup', { principal: ctx.principal, params, transport: 'http' }) // eslint-disable-line @typescript-eslint/no-explicit-any

  it('超时重发同一个 clientOrderId：返回原订单、场所只收到一次；order.lookup 按 clientOrderId 查到状态与账本链', async () => {
    const a = await makeAgent(h, 'paper')
    const cloid = 'ab'.repeat(16)
    const first = await h.k.trading.place({ intent: mk({ clientOrderId: cloid }) }, a.ctx())
    const again = await h.k.trading.place({ intent: mk({ clientOrderId: cloid }) }, a.ctx())
    expect(again.order?.orderId).toBe(first.order?.orderId)
    expect(h.sim.submitted.length).toBe(1)
    const l = await lookup(a, { clientOrderId: cloid })
    expect(l).toMatchObject({ found: true, order: { orderId: first.order!.orderId, status: 'filled' } })
    expect(l.trail).toEqual(['order.intent', 'order.submitted', 'order.accepted', 'fill'])
    expect((await lookup(a, { orderId: first.order!.orderId })).found).toBe(true)
    expect(await lookup(a, { clientOrderId: 'cd'.repeat(16) })).toEqual({ found: false })
  })

  it('结果未知（3006）的单：lookup 向场所查一次并补记，不重发', async () => {
    h.sim.script = ['unknown']
    h.sim.queryFinds = true
    const cloid = 'ef'.repeat(16)
    const r = await h.k.trading.place({ intent: mk({ clientOrderId: cloid, reason: undefined }) }, h.human())
    // 假连接器 queryFinds=true 时，内核在下单路径里就会补记；这里再造一个“当时没查到、事后查得到”的场景
    expect(['open', 'submitted']).toContain(r.order?.status)
    h.sim.script = ['unknown']
    h.sim.queryFinds = false
    h.clock.advance(11_000)
    const cloid2 = '12'.repeat(16)
    const r2 = await h.k.trading.place({ intent: mk({ clientOrderId: cloid2, size: '0.012', reason: undefined }) }, h.human())
    expect(r2.order?.status).toBe('submitted')
    const submitted = h.sim.submitted.length
    h.sim.queryFinds = true // 场所事后查得到
    const l = await h.k.ops.call(h.k, 'order.lookup', { principal: h.session, params: { clientOrderId: cloid2 }, transport: 'ws' }) as any // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(l).toMatchObject({ found: true, refreshedFromVenue: true, order: { status: 'open' } })
    expect(h.sim.submitted.length).toBe(submitted) // 没有重发
  })

  it('授权主体只查得到自己授权书覆盖账户里的单；转提案的单 lookup 返回票号；close 也接受 clientOrderId 幂等键', async () => {
    const paperOnly = await makeAgent(h, 'paper', { accounts: [h.paper.accountId as never] })
    const other = await makeAgent(h, 'paper', { accounts: [h.liveAcct.accountId as never] })
    const cloid = '34'.repeat(16)
    await h.k.trading.place({ intent: mk({ clientOrderId: cloid }) }, paperOnly.ctx())
    expect((await lookup(paperOnly, { clientOrderId: cloid })).found).toBe(true)
    expect(await lookup(other, { clientOrderId: cloid })).toEqual({ found: false }) // 不泄露别的账户有没有
    // 转提案：L2 钥匙对实盘下直接单 → 被拒；这里直接用 propose 造一张含该 clientOrderId 的票
    const { enableLive } = await import('./helpers/harness')
    await enableLive(h)
    const l2 = await makeAgent(h, 'confirm')
    const cloid3 = '56'.repeat(16)
    const p = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [mk({ accountId: h.liveAcct.accountId, clientOrderId: cloid3, size: '0.003', reason: 'funding' })], reason: 'r' }, l2.ctx('propose'))
    expect(await lookup(l2, { clientOrderId: cloid3 })).toEqual({ found: false, proposal: { ticket: p.ticket, status: 'pending', proposalId: p.proposalId } })
    // close：同一个 clientOrderId 重发 → 同一张单
    const c1 = await h.k.trading.closePosition({ accountId: h.paper.accountId, instrumentId: BTC, clientOrderId: '78'.repeat(16) }, h.human())
    expect(c1.order?.clientOrderId).toBe('78'.repeat(16))
    const n = h.sim.submitted.length
    h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'long', size: '0.01' as never, entryPrice: '80000' as never, markPrice: '80000' as never, notional: '800' as never, unrealizedPnl: '0' as never, realizedPnl: '0' as never, leverage: 2, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: '0' as never, openedAt: 0, updatedAt: 0 }])
    const c2 = await h.k.trading.closePosition({ accountId: h.paper.accountId, instrumentId: BTC, clientOrderId: '78'.repeat(16) }, h.human())
    expect(c2.order?.orderId).toBe(c1.order?.orderId)
    expect(h.sim.submitted.length).toBe(n)
  })
})

describe('下单路径的事务并包（7 次 fsync → 2 次，耐久性不降）', () => {
  let h: Harness
  beforeEach(async () => { h = await makeHarness() })
  afterEach(async () => { await h.cleanup() })

  it('稳态每笔纸面单只有 2 次提交：发往场所前一个（幂等键 + 意图账本 + 订单 + 提交账本），回执后一个（订单 + 结果账本 + 成交）；顺序仍是先落意图再调连接器', async () => {
    const a = await makeAgent(h, 'paper')
    const intent = (): any => ({ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001', leverage: 2, reason: 'x' }) // eslint-disable-line @typescript-eslint/no-explicit-any
    await h.k.trading.place({ intent: intent() }, a.ctx()) // 第一笔会写当日基线文档
    h.clock.advance(11_000)
    const proto = DatabaseSync.prototype as any // eslint-disable-line @typescript-eslint/no-explicit-any
    const origExec = proto.exec
    const log: string[] = []
    proto.exec = function (sql: string) { if (/^COMMIT/.test(sql)) log.push('commit'); return origExec.call(this, sql) }
    const origSubmit = h.sim.submit.bind(h.sim)
    h.sim.submit = (async (...args: Parameters<typeof origSubmit>) => { log.push('submit'); return origSubmit(...args) }) as never
    try { await h.k.trading.place({ intent: intent() }, a.ctx()) } finally { proto.exec = origExec }
    expect(log.filter((x) => x === 'commit').length).toBe(2)
    expect(log.indexOf('commit')).toBeLessThan(log.indexOf('submit')) // 意图已提交（落盘）才调连接器
    expect(h.k.ledger.verify().ok).toBe(true)
  })

  it('可重入事务：里层账本追加并入外层，外层回滚则一并消失；外层提交才可见', async () => {
    const before = h.k.ledger.query({ limit: 1000 }).length
    const o = h.human().origin
    expect(() => tx(h.k.db, () => {
      h.k.ledger.append({ type: 'annotation', origin: o, subject: { orgId: 'org_local' }, payload: { a: 1 } } as never)
      throw new Error('boom')
    })).toThrow('boom')
    expect(h.k.ledger.query({ limit: 1000 }).length).toBe(before)
    tx(h.k.db, () => { h.k.ledger.append({ type: 'annotation', origin: o, subject: { orgId: 'org_local' }, payload: { a: 2 } } as never) })
    expect(h.k.ledger.query({ limit: 1000 }).length).toBe(before + 1)
    // 回滚之后事务深度复位：下一次仍能开新事务
    expect(tx(h.k.db, () => 7)).toBe(7)
    expect(h.k.ledger.verify().ok).toBe(true)
  })
})
