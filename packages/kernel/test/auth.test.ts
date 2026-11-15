// SPDX-License-Identifier: CPAL-1.0
// 鉴权（契约 §5.1 T-A / T-B）：伪造头无法通过；无令牌被拒；人面动作要 PIN；PIN 失败退避。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { PinStore } from '../src/pin'
import { Kernel } from '../src/kernel'
import { FakeClock } from '../src/util/clock'
import { FAST_SCRYPT, TEST_PIN, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let port = 0
let svcToken = ''
let sesToken = ''

beforeEach(async () => {
  h = await makeHarness()
  const r = await h.k.start({ port: 0 })
  port = r.port
  svcToken = (JSON.parse(readFileSync(join(h.home, 'service.json'), 'utf8')) as { token: string }).token
  sesToken = h.k.auth.exchangeBoot(r.bootToken).sessionToken
})
afterEach(async () => { await h.cleanup() })

const url = (p: string): string => `http://127.0.0.1:${port}${p}`
async function api(path: string, o: { token?: string; headers?: Record<string, string>; body?: unknown; method?: string; pin?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) }
  if (o.token) headers.authorization = `Bearer ${o.token}`
  if (o.body !== undefined) headers['content-type'] = 'application/json'
  if (o.pin) headers['x-gitrader-pin'] = o.pin
  const res = await fetch(url(path), { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) })
  return { status: res.status, json: (await res.json().catch(() => null)) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
}
const op = (name: string, o: { token?: string; params?: unknown; headers?: Record<string, string>; pin?: string } = {}) => api(`/api/op/${name}`, { ...o, body: { params: o.params ?? {} } })

describe('T-B：本机其他进程经本地接口', () => {
  it('没有令牌 = 没有身份：伪造 Sec-Fetch-Site / Origin 也进不去（Demo main.mjs:85-89 的洞）', async () => {
    for (const headers of [{} as Record<string, string>, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { origin: `http://127.0.0.1:${port}` }, { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` }]) {
      const r = await op('status', { headers })
      expect(r.status, JSON.stringify(headers)).toBe(401)
      expect(r.json.ok).toBe(false)
      expect(r.json.error.code).toBe(5003)
    }
    expect((await api('/api/op/risk.state', { headers: { 'sec-fetch-site': 'same-origin' }, body: {} })).status).toBe(401)
  })

  it('错误 / 伪造格式的令牌被拒', async () => {
    for (const t of ['ses_AAAA', 'svc_AAAA', 'gtk_' + 'A'.repeat(52), 'boot_xxx', 'Bearer', '']) {
      expect((await op('status', { token: t })).status).toBe(401)
    }
  })

  it('有令牌但声明跨站（Sec-Fetch-Site: cross-site / same-site、外来 Origin、错误 Host）一律拒绝', async () => {
    expect((await op('status', { token: sesToken, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await op('status', { token: sesToken, headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403)
    expect((await op('status', { token: sesToken, headers: { origin: 'http://evil.test' } })).status).toBe(403)
    expect((await op('status', { token: sesToken, headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
    // Host 头（DNS 重绑定）
    const code = await new Promise<number>((res) => {
      const rq = request({ host: '127.0.0.1', port, path: '/api/op/status', method: 'POST', headers: { host: `evil.test:${port}`, authorization: `Bearer ${sesToken}`, 'content-type': 'application/json' } }, (r) => { r.resume(); res(r.statusCode ?? 0) })
      rq.end('{}')
    })
    expect(code).toBe(403)
  })

  it('/api/health 之外没有任何免令牌的数据接口；健康检查不泄露 pid', async () => {
    const r = await api('/api/health')
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.json)).not.toMatch(/pid|token/)
    for (const p of ['/api/status', '/api/ledger', '/api/orders', '/api/op/ledger.query']) expect([401, 404, 405]).toContain((await api(p)).status)
  })

  it('引导令牌一次性、会过期；service 令牌铸造不了会话', async () => {
    const b = h.k.auth.mintBootToken()
    const first = await api('/api/session', { body: { bootstrap: b } })
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ user: 'usr_local' })
    expect(first.json.sessionToken).toMatch(/^ses_/)
    const again = await api('/api/session', { body: { bootstrap: b } })
    expect(again.status).toBe(401)
    expect(again.json.error.name).toBe('AUTH_FAILED')
    const b2 = h.k.auth.mintBootToken(1000)
    h.clock.advance(2000)
    expect((await api('/api/session', { body: { bootstrap: b2 } })).status).toBe(401)
    expect((await api('/api/session', { token: svcToken, body: { bootstrap: svcToken } })).status).toBe(401)
    expect((await op('session.mint', { token: svcToken })).status).toBe(404)
  })

  it('主体边界：service 令牌能读状态但做不了会话专属动作；Agent 令牌什么人面操作都调不了', async () => {
    expect((await op('status', { token: svcToken })).status).toBe(200)
    expect((await op('proposal.approve', { token: svcToken, params: { id: 'x' } })).status).toBe(401)
    expect((await op('order.place', { token: svcToken, params: {} })).status).toBe(401)
    // Agent 钥匙
    const pin = await h.pinProof()
    const k = h.k.agents.createKey({ name: 'bot', host: 'claude-code', tier: 'paper', mandate: { accounts: [h.paper.accountId as never] } }, pin, h.human().origin)
    for (const name of ['status', 'proposal.approve', 'risk.relax', 'takeover.flatten_all', 'agentkey.create', 'trading_state.resume', 'credential.import', 'kill']) {
      const r = await op(name, { token: k.token, params: { id: 'x', reason: 'r' }, pin: TEST_PIN })
      expect(r.status, name).toBe(401)
      expect(r.json.error.code).toBe(5003)
    }
    // 令牌写在配置里本机可读，所以它只代表授权书范围内的能力：旧令牌轮换后立即失效
    const rot = h.k.agents.rotateKey(k.key.keyId, pin, h.human().origin)
    expect(h.k.agents.verifyToken(k.token)).toBeNull()
    expect(h.k.agents.verifyToken(rot.token)).not.toBeNull()
  })

  it('秘密字段在非导入入口被拒（5006）', async () => {
    const r = await op('note.add', { token: sesToken, params: { text: 'x', privateKey: '0x' + 'ab'.repeat(32) } })
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe(5006)
    expect(JSON.stringify(h.k.ledger.query({ limit: 1000 }))).not.toContain('ab'.repeat(32))
  })

  it('service.json：权限收紧，令牌可轮换，旧令牌立即失效', async () => {
    const f = join(h.home, 'service.json')
    if (process.platform === 'win32') {
      const out = execFileSync('icacls', [f], { encoding: 'utf8', windowsHide: true })
      expect(out).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/i)
    } else expect(statSync(f).mode & 0o077).toBe(0)
    expect((await op('status', { token: svcToken })).status).toBe(200)
    const pin = await h.pinProof()
    void pin
    const r = await op('service.rotateToken', { token: sesToken, pin: TEST_PIN })
    expect(r.status).toBe(200)
    expect((await op('status', { token: svcToken })).status).toBe(401)
    const fresh = (JSON.parse(readFileSync(f, 'utf8')) as { token: string }).token
    expect(fresh).not.toBe(svcToken)
    expect((await op('status', { token: fresh })).status).toBe(200)
  })
})

describe('人面动作要 PIN；PIN 失败退避；PIN 不进日志', () => {
  it('需要 PIN 的操作：没带 / 带错 → 拒绝；带对 → 通过；放宽风控是其中之一', async () => {
    await h.pinProof() // 设置 PIN
    const patch = { limits: { maxOrderNotional: '50000' } }
    const noPin = await op('risk.relax', { token: sesToken, params: { patch } })
    expect(noPin.status).toBe(401)
    expect(noPin.json.error).toMatchObject({ code: 1010, name: 'ATTESTATION_REQUIRED', category: 'REJECTED' }) // 缺在场证明：壳弹 PIN 层后重发
    const wrong = await op('risk.relax', { token: sesToken, params: { patch }, pin: '000000' })
    expect(wrong.status).toBe(401)
    expect(wrong.json.error.code).toBe(5003) // 错误的 PIN 回 AUTH_FAILED
    const ok = await op('risk.relax', { token: sesToken, params: { patch }, pin: TEST_PIN })
    expect(ok.status).toBe(200)
    expect(h.k.risk.current()!.limits.maxOrderNotional).toBe('50000')
    expect(h.k.ledger.query({ types: ['policy.relaxed'] }).length).toBe(1)
  })

  it('收紧会话即可（不需要 PIN），但不能借收紧入口放宽', async () => {
    await h.pinProof()
    expect((await op('risk.tighten', { token: sesToken, params: { patch: { limits: { maxOrderNotional: '1000' } } } })).status).toBe(200)
    const r = await op('risk.tighten', { token: sesToken, params: { patch: { limits: { maxOrderNotional: '99999' } } } })
    expect(r.status).toBe(401)
    expect(r.json.error.message).toMatch(/loosens/)
    expect(h.k.risk.current()!.limits.maxOrderNotional).toBe('1000')
  })

  it('PIN 失败退避：3 次免费，之后 1 s、2 s、4 s…；锁定期内连正确 PIN 也不评估；重启不清零', async () => {
    await h.pinProof()
    const bad = () => op('keystore.unlock', { token: sesToken, pin: '000000' })
    for (let i = 0; i < 3; i++) expect((await bad()).status).toBe(401)
    const fourth = await bad()
    expect(fourth.json.error.retryAfterMs).toBe(1000)
    // 锁定期：正确 PIN 也被拒，并告知多久后重试
    const locked = await op('keystore.unlock', { token: sesToken, pin: TEST_PIN })
    expect(locked.status).toBe(401)
    expect(locked.json.error.retryAfterMs).toBeGreaterThan(0)
    // 重启后（新 PinStore 读同一文件）仍在锁定
    const ps = new PinStore(h.k.paths.pin, h.clock, FAST_SCRYPT)
    await expect(ps.verify(TEST_PIN)).rejects.toMatchObject({ problem: { code: 5003 } })
    h.clock.advance(1100)
    expect((await bad()).json.error.retryAfterMs).toBe(2000) // 退避翻倍
    h.clock.advance(2100)
    expect((await op('keystore.unlock', { token: sesToken, pin: TEST_PIN })).status).toBe(200)
    expect(ps.status().failures).toBe(0) // 成功后清零
  })

  it('PIN 不进日志 / 账本 / 数据库 / service.json / 错误信息', async () => {
    await h.pinProof()
    const needle = '987123'
    const r = await op('keystore.unlock', { token: sesToken, pin: needle })
    expect(JSON.stringify(r.json)).not.toContain(needle)
    await op('risk.relax', { token: sesToken, params: { patch: { limits: { maxOrderNotional: '70000' } } }, pin: needle })
    h.k.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const files = [join(h.home, 'service.json'), join(h.home, 'gitrader.json'), join(h.home, 'keys', 'pin.json'), ...readdirSync(join(h.home, 'data')).map((f) => join(h.home, 'data', f))]
    for (const f of files) expect(readFileSync(f).includes(needle), f).toBe(false)
    expect(JSON.stringify(h.k.ledger.query({ limit: 1000 }))).not.toContain(needle)
  })

  it('PIN 以 scrypt 哈希存储，文件里没有 PIN 明文', async () => {
    await h.pinProof()
    const raw = readFileSync(h.k.paths.pin, 'utf8')
    expect(raw).not.toContain(TEST_PIN)
    expect(JSON.parse(raw).kdf.name).toBe('scrypt')
  })

  it('首次设置 PIN 只有会话主体能做（service / 无令牌不行）', async () => {
    expect((await op('pin.set', { token: svcToken, params: { pin: '111111' } })).status).toBe(401)
    expect(h.k.pin.isSet()).toBe(false)
    // fix-r4: 123456 / 654321 是弱 PIN，内核 pin.set 现在要 confirmWeak:true 才放行；这里测的是会话 / 已设置语义，所以带上确认
    expect((await op('pin.set', { token: sesToken, params: { pin: '123456', confirmWeak: true } })).status).toBe(200)
    expect((await op('pin.set', { token: sesToken, params: { pin: '654321', confirmWeak: true } })).status).toBe(401) // 已设置
  })
})

describe('工作台 WebSocket /ui（JSON-RPC 2.0，protocol ui/wire.ts）', () => {
  type Msg = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  function connect(path = '/ui'): Promise<{ ws: WebSocket; msgs: Msg[]; closed: Promise<{ code: number }>; next: (pred: (m: Msg) => boolean, ms?: number) => Promise<Msg>; call: (method: string, params: unknown) => Promise<Msg> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
      const msgs: Msg[] = []
      const waiters: { pred: (m: Msg) => boolean; res: (m: Msg) => void }[] = []
      let id = 0
      const closed = new Promise<{ code: number }>((r) => ws.addEventListener('close', (e) => r({ code: e.code })))
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(String(e.data)) as Msg
        msgs.push(m)
        for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m) }
      })
      const next = (pred: (m: Msg) => boolean, ms = 2000): Promise<Msg> => new Promise((res, rej) => { const f = msgs.find(pred); if (f) return res(f); const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), ms); waiters.push({ pred, res: (m) => { clearTimeout(t); res(m) } }) })
      const call = (method: string, params: unknown): Promise<Msg> => { const my = ++id; ws.send(JSON.stringify({ jsonrpc: '2.0', id: my, method, params })); return next((m) => m.id === my) }
      ws.addEventListener('open', () => resolve({ ws, msgs, closed, next, call }))
      ws.addEventListener('error', () => reject(new Error('ws error')))
    })
  }
  const cmd = (c: Awaited<ReturnType<typeof connect>>, action: string, params: unknown, attestation?: unknown) =>
    c.call('command', { action, params, origin: { tool: `ui:${action}`, via: 'ui' }, ...(attestation ? { attestation } : {}) })

  it('旧路径 /ws 不存在；首帧不是 auth / 坏令牌 / Agent 令牌 → 4401 断开', async () => {
    await expect(connect('/ws')).rejects.toBeTruthy()
    const a = await connect()
    a.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { method: 'status' } }))
    expect((await a.closed).code).toBe(4401)
    const b = await connect()
    b.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: 'ses_forged', client: { name: 'test' } } }))
    expect((await b.next((m) => m.id === 1)).error.code).toBe(5003)
    expect((await b.closed).code).toBe(4401)
    const pin = await h.pinProof()
    const k = h.k.agents.createKey({ name: 'bot', host: 'codex', tier: 'paper', mandate: { accounts: [h.paper.accountId as never] } }, pin, h.human().origin)
    const c = await connect()
    c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: k.token, client: { name: 'agent' } } }))
    expect((await c.closed).code).toBe(4401)
  })

  it('auth → subscribe → command 触发事件，150 ms 内可见；query 只能调 query、command 只能调 command；错误带 Problem', async () => {
    const c = await connect()
    expect((await c.call('auth', { token: sesToken, client: { name: 'workbench' } })).result).toEqual({ ok: true, user: 'usr_local' })
    const sub = await c.call('subscribe', { topic: 'ledger.entry' })
    expect(sub.result.subscriptionId).toMatch(/^sub_/)
    const t0 = Date.now()
    const note = await cmd(c, 'note.add', { text: 'hello from block' })
    expect(note.result.type).toBe('note')
    const ev = await c.next((m) => m.method === 'event' && m.params?.data?.type === 'note')
    expect(Date.now() - t0).toBeLessThan(150)
    expect(ev.params).toMatchObject({ subscriptionId: sub.result.subscriptionId, topic: 'ledger.entry' })
    expect(ev.params.data.payload.text).toBe('hello from block')
    expect(ev.params.data.origin).toMatchObject({ actor: 'user:usr_local', actorType: 'human', via: 'ui', tool: 'ui:note.add' }) // 内核盖章，tool 取自壳给的 origin.tool
    const wrong = await c.call('query', { method: 'note.add', params: { text: 'x' } })
    expect(wrong.error.data.name).toBe('INVALID_REQUEST')
    const rs = await c.call('query', { method: 'risk.state' })
    expect(rs.result.tradingState).toBe('ACTIVE')
    const un = await c.call('unsubscribe', { subscriptionId: sub.result.subscriptionId })
    expect(un.result).toMatchObject({ ok: true })
    const nf = await c.call('nope', {})
    expect(nf.error).toMatchObject({ code: -32601 })
    c.ws.close()
  })

  it('需要在场证明的命令：缺 → 错误 data.name = ATTESTATION_REQUIRED（1010）；带对 PIN 重发 → 通过；错 PIN → 5003', async () => {
    const c = await connect()
    await c.call('auth', { token: sesToken, client: { name: 'workbench' } })
    await h.pinProof()
    const patch = { limits: { maxOrderNotional: '9999' } }
    const first = await cmd(c, 'risk.relax', { patch })
    expect(first.error).toMatchObject({ code: 1010, data: { name: 'ATTESTATION_REQUIRED', category: 'REJECTED' } })
    const wrong = await cmd(c, 'risk.relax', { patch }, { method: 'pin', pin: '000000' })
    expect(wrong.error.code).toBe(5003)
    const ok = await cmd(c, 'risk.relax', { patch }, { method: 'pin', pin: TEST_PIN })
    expect(ok.result.version).toBeGreaterThan(1)
    const unsupported = await cmd(c, 'risk.relax', { patch }, { method: 'passkey', assertion: {} })
    expect(unsupported.error.code).toBe(5002)
    c.ws.close()
  })

  it('maxHz 在服务端合并：高频主题窗口内批量保序且不丢事件', async () => {
    const c = await connect()
    await c.call('auth', { token: sesToken, client: { name: 'workbench' } })
    await c.call('subscribe', { topic: 'market.quote', filter: { instrumentId: 'hyperliquid:BTC' }, maxHz: 5 })
    for (let i = 0; i < 50; i++) h.k.events.publish('market.quote', { instrumentId: 'hyperliquid:BTC', ts: i, bid: 1 + i, ask: 2 + i })
    h.k.events.publish('market.quote', { instrumentId: 'hyperliquid:ETH', ts: 99, bid: 1, ask: 2 }) // 被过滤
    await new Promise((r) => setTimeout(r, 450))
    const evs = c.msgs.filter((m) => m.method === 'event')
    expect(evs.length).toBeGreaterThanOrEqual(1)
    expect(evs.length).toBeLessThanOrEqual(3)
    const data = evs.flatMap((e) => e.params.events ? e.params.events.map((event: any) => event.data) : [e.params.data])
    expect(data[data.length - 1]!.bid).toBe(50)
    expect(data.map((e) => e.bid)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(data.every((e) => e.instrumentId === 'hyperliquid:BTC')).toBe(true)
    c.ws.close()
  })

  it('壳的设置 / 凭据 / 工作区命令（ui/wire.ts UI_COMMANDS）：pin.set、credential.*（会话即可，已解锁不逐次弹 PIN）、settings.*、workspace.*、trading_state.resume', async () => {
    const c = await connect()
    await c.call('auth', { token: sesToken, client: { name: 'workbench' } })
    expect((await c.call('query', { method: 'settings.get' })).result).toMatchObject({ network: 'testnet', pinSet: false, agentLayout: false, keys: [] })
    // pin.set 首次：会话即可；PIN 必须 6–12 位数字
    expect((await cmd(c, 'pin.set', { pin: 'abcdef' })).error.code).toBe(-32602)
    expect((await cmd(c, 'pin.set', { pin: TEST_PIN })).result).toMatchObject({ ok: true, changed: false })
    // 密钥库已解锁（pin.set 顺带解锁）→ 导入 / 生成不再要 PIN
    const gen = await cmd(c, 'credential.generate', { label: 'api-1', network: 'testnet' })
    expect(Object.keys(gen.result.key).sort()).toEqual(['address', 'createdAt', 'expiresAt', 'id', 'label', 'network', 'venue'])
    const imp = await cmd(c, 'credential.import', { secret: '0x' + 'ab'.repeat(32), label: 'api-2', network: 'testnet' })
    expect(imp.result.key.label).toBe('api-2')
    expect(JSON.stringify(h.k.ledger.query({ limit: 1000 }))).not.toContain('ab'.repeat(32))
    expect((await c.call('query', { method: 'settings.get' })).result.keys.length).toBe(2)
    // 锁上之后导入：缺在场证明 → 1010；带 PIN 重发 → 解锁并导入
    h.k.keystore.lock()
    const locked = await cmd(c, 'credential.generate', { label: 'api-3', network: 'testnet' })
    expect(locked.error.code).toBe(1010)
    expect((await cmd(c, 'credential.generate', { label: 'api-3', network: 'testnet' }, { method: 'pin', pin: TEST_PIN })).result.key.label).toBe('api-3')
    // 秘密字段豁免只限 credential.import 的 secret
    expect((await cmd(c, 'credential.generate', { label: 'x', network: 'testnet', secret: 'abc' })).error.code).toBe(5006)
    expect((await cmd(c, 'credential.revoke', { id: gen.result.key.id })).result.key.id).toBe(gen.result.key.id)
    // 主网默认关闭：没有主网 API 钱包不能切
    expect((await cmd(c, 'settings.network.set', { network: 'mainnet' })).error.data.name).toBe('VENUE_AUTH')
    expect((await cmd(c, 'settings.agent_layout.set', { enabled: true })).result).toEqual({ agentLayout: true })
    // 改 PIN：attestation = 旧 PIN，密钥库用新主密钥重新加密，旧钱包仍可签名
    expect((await cmd(c, 'pin.set', { pin: '135790' })).error.code).toBe(1010)
    expect((await cmd(c, 'pin.set', { pin: '135790' }, { method: 'pin', pin: TEST_PIN })).result).toMatchObject({ changed: true })
    h.k.keystore.lock()
    h.k.keystore.unlock(await h.k.auth.pinProof(h.session, '135790'))
    await expect(h.k.keystore.getSigner('api-2').signTypedData({ domain: { name: 'x', version: '1', chainId: 1 }, types: { A: [{ name: 'a', type: 'string' }] }, primaryType: 'A', message: { a: 'b' } })).resolves.toMatch(/^0x/)
    // 工作区
    const ws = JSON.parse(JSON.stringify(JSON.parse(readFileSync(join(__dirname, '..', '..', 'protocol', 'test', 'fixtures', 'contract', 'workspace-default.json'), 'utf8'))))
    expect((await cmd(c, 'workspace.update', { workspace: ws })).result.revision).toBe(1)
    expect((await c.call('query', { method: 'workspace.current' })).result.revision).toBe(1)
    expect((await cmd(c, 'workspace.save', { name: 'main', workspace: ws })).result.meta).toMatchObject({ name: 'main' })
    expect((await c.call('query', { method: 'workspace.list' })).result.workspaces.map((w: { name: string }) => w.name)).toEqual(['main'])
    expect((await cmd(c, 'workspace.load', { name: 'main' })).result.workspace.id).toBe(ws.id)
    await cmd(c, 'workspace.update', { workspace: { ...ws, name: 'Agent edited' } })
    expect((await cmd(c, 'workspace.revert', {})).result.workspace.name).toBe(ws.name) // 一键还原到人最后保存的布局
    // takeover：scope 可以只给 {type:"org"}（id 缺省 = org_local）；恢复要在场证明
    expect((await cmd(c, 'takeover.halt_new', { reason: 'test', scope: { type: 'org' } })).result.stateAfter).toBe('REDUCING')
    expect((await cmd(c, 'trading_state.resume', { scope: { type: 'org' } })).error.code).toBe(1010)
    expect((await cmd(c, 'trading_state.resume', { scope: { type: 'org' } }, { method: 'pin', pin: '135790' })).result).toMatchObject({ to: 'ACTIVE' })
    expect((await c.call('query', { method: 'instruments.search', params: { q: 'btc' } })).result.hits[0]).toMatchObject({ id: 'hyperliquid:BTC', venue: 'hyperliquid' })
    c.ws.close()
  })
})

describe('其他', () => {
  it('伪造头不能绕过：直接构造内核也一样（认证只看令牌）', async () => {
    const k2 = await Kernel.create({ home: h.home + '-b', clock: new FakeClock(), scrypt: FAST_SCRYPT, timers: false })
    expect(k2.auth.authenticate('Bearer ' + sesToken)).toBeNull() // 会话令牌只在创建它的内核内存里
    await k2.stop()
  })
})
