// SPDX-License-Identifier: CPAL-1.0
// fix-r2 S3：doctor 说真话。全部用 DoctorDeps 注入假数据，不起真内核。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome } from '@gitrader/kernel'
import { cmdDoctor, doctorDeps, runChecks } from '../src/doctor'
import type { DoctorCheck, DoctorDeps } from '../src/doctor'
import type { CliIo, ServiceInfo } from '../src/index'

const DAY = 86_400_000
const baseDeps = { ...doctorDeps }
const fakeService: ServiceInfo = { port: 43123, pid: process.pid, token: 'test-token', startedAt: 1, version: 'test' }
const okLedger = { ok: true, mode: 'full', checkedFrom: 0, checkedTo: 3, count: 4, at: 1, durationMs: 1, projection: { checked: 1, ok: true } }
let home: string

function healthy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    stateFiles: [{ kind: 'pin', state: 'ok' }, { kind: 'paper-state', state: 'ok' }],
    paperState: { state: 'ok', dirty: false },
    ledgerVerify: okLedger,
    ...extra,
  }
}

/** 一整套“健康服务在跑”的注入；每个用例只改一处。 */
function deps(o: { health?: Record<string, unknown>; status?: Record<string, unknown>; audit?: unknown } & Omit<Partial<DoctorDeps>, 'health'> = {}): Partial<DoctorDeps> {
  const { health, status, audit, ...rest } = o
  return {
    liveService: async () => fakeService,
    callOp: async (_svc, op) => {
      if (op === 'status') return { tradingState: 'ACTIVE', stateReasons: [], ...status }
      if (op === 'market.quote') return { price: '101', ts: Date.now() }
      if (op === 'account.list') return [{ mode: 'paper' }]
      if (op === 'agentkey.list') return [{ name: 'A', tier: 'paper', expiresAt: Date.now() + 30 * DAY }]
      if (op === 'paper.audit') return audit ?? { paperState: { state: 'ok', dirty: false }, accounts: [] }
      return null
    },
    health: async () => health ?? healthy(),
    staticDir: () => home,
    mcpEntry: () => ({ path: join(home, 'mcp.js'), built: true }),
    verifyLedgerOffline: () => okLedger,
    probeWrite: () => undefined,
    ...rest,
  }
}

const byId = (checks: DoctorCheck[], id: string): DoctorCheck => {
  const c = checks.find((x) => x.id === id)
  if (!c) throw new Error(`no check ${id}`)
  return c
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gr-s3-doctor-'))
  initHome(home)
  writeFileSync(join(home, 'keys', 'pin.json'), '{}\n')
  writeFileSync(join(home, 'mcp.js'), '// stub\n')
  Object.assign(doctorDeps, baseDeps)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  Object.assign(doctorDeps, baseDeps)
})

describe('S3 doctor tells the truth', () => {
  it('clean home stays all green', async () => {
    const checks = await runChecks(home, deps())
    expect(checks.filter((c) => c.level !== 'ok')).toEqual([])
    for (const id of ['trading', 'ledger', 'paper', 'datadir', 'config']) expect(byId(checks, id).level).toBe('ok')
  })

  it('HALTED trading state is a block with reason', async () => {
    const status = { tradingState: 'HALTED', stateReasons: [{ scope: { type: 'org', id: 'org_local' }, state: 'REDUCING', reason: '保护单没挂上' }, { scope: { type: 'org', id: 'org_local' }, state: 'HALTED', reason: '有对账待处理' }] }
    const checks = await runChecks(home, deps({ status }))
    const c = byId(checks, 'trading')
    expect(c.level).toBe('block')
    expect(c.zh).toContain('有对账待处理') // 最严的那条
    expect(c.next).toContain('输 PIN 恢复交易')

    // 退出码沿用现有逻辑：有 block = 2
    Object.assign(doctorDeps, deps({ status }))
    const out: string[] = []
    const io: CliIo = { out: (s) => { out.push(s) }, err: () => undefined, env: { GITRADER_HOME: home }, interactive: false, readSecret: async () => '' }
    expect(await cmdDoctor(home, { cmd: ['doctor'], flags: {} }, io)).toBe(2)
    expect(out.join('')).toContain('交易已全部暂停：有对账待处理')
  })

  it('REDUCING is a warn, and paper reasons point at the paper next step', async () => {
    const status = { tradingState: 'REDUCING', stateReasons: [{ scope: {}, state: 'REDUCING', reason: '纸面状态和账本对不上' }] }
    const c = byId(await runChecks(home, deps({ status })), 'trading')
    expect(c.level).toBe('warn')
    expect(c.next).toContain('paper rebuild-from-ledger')
  })

  it('C7: global ACTIVE but a mandate is REDUCING -> warn naming the key, never "交易状态正常"', async () => {
    const keys = [{ name: 'research-bot', mandateId: 'mdt_x', status: 'active', tier: 'paper', expiresAt: Date.now() + 30 * DAY }]
    const scopedStates = [
      { scope: { type: 'mandate', id: 'mdt_x' }, state: 'REDUCING', reason: 'agent heartbeat timeout' },
      { scope: { type: 'mandate', id: 'mdt_unknown' }, state: 'HALTED', reason: 'stopped' },
    ]
    const d = deps({ status: { scopedStates } })
    const callOp = d.callOp!
    d.callOp = async (svc, op, params) => (op === 'agentkey.list' ? keys : callOp(svc, op, params))
    const c = byId(await runChecks(home, d), 'trading')
    expect(c.level).toBe('warn')
    expect(c.zh).toContain('Agent「research-bot」只允许减仓：agent heartbeat timeout')
    expect(c.zh).toContain('Agent「某 Agent」已停止：stopped')
    expect(c.zh).not.toContain('交易状态正常')
  })

  it('C7: ACTIVE scopes only (no restricted scope) stays green', async () => {
    const c = byId(await runChecks(home, deps({ status: { scopedStates: [] } })), 'trading')
    expect(c.level).toBe('ok')
  })

  it('keys show their tier from the mandate (no "未知"), and restricted agents change the summary line', async () => {
    const keys = [
      { name: 'ro-bot', mandateId: 'mdt_ro', status: 'active', expiresAt: Date.now() + 30 * DAY },
      { name: 'ok-bot', mandateId: 'mdt_ok', status: 'active', expiresAt: Date.now() + 30 * DAY },
      { name: 'old-bot', mandateId: 'mdt_old', status: 'revoked', expiresAt: Date.now() + 30 * DAY },
      { name: 'late-bot', mandateId: 'mdt_late', status: 'active', expiresAt: Date.now() - DAY },
    ]
    const mandates = [{ mandateId: 'mdt_ro', level: 'L0', status: 'active' }, { mandateId: 'mdt_ok', level: 'L2', status: 'active' }]
    const d = deps()
    const callOp = d.callOp!
    d.callOp = async (s, op, params) => (op === 'agentkey.list' ? keys : op === 'mandate.list' ? mandates : callOp(s, op, params))
    const k = byId(await runChecks(home, d), 'agentKey')
    expect(k.zh).toContain('ro-bot · 只读 · 30 天后到期')
    expect(k.zh).toContain('ok-bot · 需确认 · 30 天后到期')
    expect(k.zh).toContain('late-bot · 已到期')
    expect(k.zh).not.toContain('未知')
    expect(k.restricted).toEqual(expect.arrayContaining(['ro-bot（只读）', 'old-bot（已吊销）']))

    Object.assign(doctorDeps, d)
    const lines: string[] = []
    const io: CliIo = { out: (s) => { lines.push(s) }, err: () => undefined, env: {}, interactive: false, readSecret: async () => '' }
    const code = await cmdDoctor(home, { cmd: ['doctor'], flags: {} }, io)
    const tail = lines.join('').trim().split('\n').pop()!
    expect(code).toBe(0) // 受限 Agent 不算 warn
    expect(tail).toBe('环境正常；2 个 Agent 受限：ro-bot（只读）、old-bot（已吊销），见上')
  })

  it('C7: revoked keys are listed apart and not counted as expiring; their token files warn', async () => {
    mkdirSync(join(home, 'agent-tokens'), { recursive: true })
    writeFileSync(join(home, 'agent-tokens', 'old-bot.token'), 'tok\n')
    writeFileSync(join(home, 'agent-tokens', 'live-bot.token'), 'tok\n')
    writeFileSync(join(home, 'agent-tokens', 'ghost.token'), 'tok\n')
    const keys = [
      { name: 'old-bot', status: 'revoked', tier: 'paper', expiresAt: Date.now() + 1 * DAY },
      { name: 'live-bot', status: 'active', tier: 'paper', expiresAt: Date.now() + 30 * DAY },
    ]
    const d = deps()
    const callOp = d.callOp!
    d.callOp = async (svc, op, params) => (op === 'agentkey.list' ? keys : callOp(svc, op, params))
    const checks = await runChecks(home, d)
    const k = byId(checks, 'agentKey')
    expect(k.level).toBe('ok') // 已吊销的 1 天后到期不算“7 天内到期”
    expect(k.zh).toContain('已吊销（不再可用）：old-bot')
    expect(k.zh).not.toContain('old-bot · ')
    const t = byId(checks, 'tokenFile')
    expect(t.level).toBe('warn')
    expect(t.zh).toContain('令牌文件对应的钥匙已吊销：old-bot.token')
    expect(t.zh).toContain('令牌文件找不到对应的钥匙：ghost.token')
    expect(t.zh).not.toContain('live-bot.token')
    expect(t.next).toContain('删除')
  })

  it('C7: token files of live keys stay green (also the -2 suffix form)', async () => {
    mkdirSync(join(home, 'agent-tokens'), { recursive: true })
    writeFileSync(join(home, 'agent-tokens', 'A.token'), 'tok\n')
    writeFileSync(join(home, 'agent-tokens', 'A-2.token'), 'tok\n')
    expect(byId(await runChecks(home, deps()), 'tokenFile').level).toBe('ok')
  })

  it('broken ledger chain is a block', async () => {
    const health = healthy({ ledgerVerify: { ...okLedger, ok: false, failure: { seq: 7, reason: 'hash mismatch' } } })
    const c = byId(await runChecks(home, deps({ health })), 'ledger')
    expect(c.level).toBe('block')
    expect(c.zh).toContain('账本哈希链在 seq 7 断开')
    expect(c.zh).toContain('hash mismatch')
    expect(c.next).toContain('从备份还原 data/gitrader.sqlite')
    expect(c.next).toContain('docs/user/09-安全.md')
  })

  it('projection mismatch is a block', async () => {
    const health = healthy({ ledgerVerify: { ...okLedger, ok: false, failure: { seq: 9, reason: 'fill projection does not match the ledger: f1 differs' }, projection: { checked: 2, ok: false } } })
    const c = byId(await runChecks(home, deps({ health })), 'ledger')
    expect(c.level).toBe('block')
    expect(c.zh).toContain('成交投影与账本不一致（seq 9）')
    expect(c.next).toContain('从备份还原')
  })

  it('ledger verify still null warns instead of claiming green', async () => {
    const c = byId(await runChecks(home, deps({ health: healthy({ ledgerVerify: null }) })), 'ledger')
    expect(c.level).toBe('warn')
    expect(c.zh).toContain('还没跑完')
  })

  it('paper-state corrupt is a block', async () => {
    const health = healthy({ paperState: { state: 'corrupt', reason: '纸面状态被截断，和账本对不上', dirty: false } })
    const checks = await runChecks(home, deps({ health }))
    const c = byId(checks, 'paper')
    expect(c.level).toBe('block')
    expect(c.zh).toBe('纸面状态被截断，和账本对不上')
    expect(c.next).toContain('paper-state.json.prev')
    expect(c.next).toContain('gitrader paper rebuild-from-ledger')
    // paper-state 损坏不能被 security 检查报成 pin reset
    expect(byId(checks, 'security').level).toBe('ok')
  })

  it('paper-state missing is a block', async () => {
    const health = healthy({ paperState: { state: 'missing', dirty: false } })
    const c = byId(await runChecks(home, deps({ health })), 'paper')
    expect(c.level).toBe('block')
    expect(c.zh).toContain('纸面状态文件和账本对不上')
  })

  it('paper dirty warns and paper.audit diffs are named', async () => {
    const dirty = byId(await runChecks(home, deps({ health: healthy({ paperState: { state: 'ok', dirty: true } }) })), 'paper')
    expect(dirty.level).toBe('warn')
    expect(dirty.zh).toContain('没写进磁盘')

    const audit = { paperState: { state: 'ok', dirty: false }, accounts: [{ accountId: 'acct_1', alias: '纸面一号', ok: false, cash: { state: '90', ledger: '100' }, diffs: ['现金差 10'] }] }
    const bad = byId(await runChecks(home, deps({ audit })), 'paper')
    expect(bad.level).toBe('warn')
    expect(bad.zh).toContain('纸面一号')
    expect(bad.zh).toContain('现金差 10')
  })

  it('service down: unreadable paper-state.json is a block', async () => {
    writeFileSync(join(home, 'paper-state.json'), '{broken')
    const c = byId(await runChecks(home, deps({ liveService: async () => null })), 'paper')
    expect(c.level).toBe('block')
    expect(c.next).toContain('paper-state.json.prev')
  })

  it('read-only data dir is a block, EPERM not reported as bad JSON', async () => {
    const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    const checks = await runChecks(home, deps({
      probeWrite: () => { throw eperm },
      readFile: () => { throw eperm },
    }))
    const data = byId(checks, 'datadir')
    expect(data.level).toBe('block')
    expect(data.zh).toContain('数据目录不能写')
    expect(data.zh).toContain('没有权限')
    expect(data.next).toContain('ACL')
    const config = byId(checks, 'config')
    expect(config.level).toBe('block')
    expect(config.zh).toContain('没有权限读')
    expect(config.zh).not.toContain('JSON')
  })

  it('config failures are classified by error.code / SyntaxError', async () => {
    writeFileSync(join(home, 'gitrader.json'), '{broken')
    expect(byId(await runChecks(home, deps()), 'config').zh).toContain('不是合法的 JSON')
    const enoent = Object.assign(new Error('gone'), { code: 'ENOENT' })
    // GQ-07（r5-WP-E1）：有使用痕迹的 home 里配置不见了 → fail-closed 提示（不再静默当新目录）
    expect(byId(await runChecks(home, deps({ readFile: () => { throw enoent } })), 'config').zh).toContain('配置文件不见了')
    // 干净的空 home（无任何使用痕迹）→ 仍是「文件不存在」
    const emptyBase = process.env.GITRADER_HOME ?? tmpdir()
    mkdirSync(emptyBase, { recursive: true })
    const empty = mkdtempSync(join(emptyBase, 's3-empty-'))
    expect(byId(await runChecks(empty, deps({ readFile: () => { throw enoent } })), 'config').zh).toContain('文件不存在')
  })

  it('GQ-59-A: 带 UTF-8 BOM 的合法配置能读，不被报成「不是合法的 JSON」', async () => {
    const raw = readFileSync(join(home, 'gitrader.json'), 'utf8')
    writeFileSync(join(home, 'gitrader.json'), '\uFEFF' + raw)
    expect(byId(await runChecks(home, deps()), 'config').level).toBe('ok')
  })

  it('GQ-59-B: stateFiles 里 keystore corrupt → security 报「钥匙库损坏」并给 pin reset 路径', async () => {
    const health = healthy({ stateFiles: [{ kind: 'pin', state: 'ok' }, { kind: 'keystore', state: 'corrupt' }] })
    const c = byId(await runChecks(home, deps({ health })), 'security')
    expect(c.level).toBe('block')
    expect(c.zh).toContain('钥匙库损坏')
    expect(c.next).toContain('pin reset')
  })

  it('datadir probe really writes and removes a file', async () => {
    const c = byId(await runChecks(home, { ...deps(), probeWrite: doctorDeps.probeWrite! }), 'datadir')
    expect(c.level).toBe('ok')
  })

  it('offline ledger missing is a block', async () => {
    writeFileSync(join(home, 'keys', 'install-key.json'), '{}\n') // 用过的家目录：有安装签名钥，库却不见了
    const offline = deps({ liveService: async () => null, verifyLedgerOffline: () => ({ ok: false, error: 'ledger database is missing', missing: true }) })
    const c = byId(await runChecks(home, offline), 'ledger')
    expect(c.level).toBe('block')
    expect(c.zh).toContain('账本数据库不见了')
    expect(c.next).toContain('--accept-new-ledger')
    expect(byId(await runChecks(home, offline), 'trading').zh).toContain('跳过')
  })

  it('offline ledger on a never-served home is not an alarm', async () => {
    const fresh = deps({ liveService: async () => null, verifyLedgerOffline: () => ({ ok: false, error: 'ledger database is missing', missing: true }) })
    expect(byId(await runChecks(home, fresh), 'ledger').level).toBe('ok')
  })

  it('offline ledger that cannot be opened is a block, offline chain break too', async () => {
    const open = byId(await runChecks(home, deps({ liveService: async () => null, verifyLedgerOffline: () => ({ ok: false, error: 'unable to open database file' }) })), 'ledger')
    expect(open.level).toBe('block')
    expect(open.zh).toContain('账本数据库打不开')
    expect(open.next).toContain('data/ 目录权限')
    const broken = byId(await runChecks(home, deps({ liveService: async () => null, verifyLedgerOffline: () => ({ ...okLedger, ok: false, failure: { seq: 3, reason: 'prevHash mismatch' } }) })), 'ledger')
    expect(broken.zh).toContain('seq 3 断开')
  })
})
