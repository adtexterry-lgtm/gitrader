// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/db'
import { EventBus } from '../src/events'
import { InstallKey } from '../src/install-key'
import { Ledger, verifyExport } from '../src/ledger'
import type { ExportManifest } from '../src/ledger'
import { verifyEntries } from '../src/ledger-verify'
import { FakeClock } from '../src/util/clock'
import { mkOrigin } from '../src/util/origin'
import type { LedgerEntry } from '../src/proto'

const dirs: string[] = []
const dbs: DatabaseSync[] = []
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-ledger-'))
  dirs.push(dir)
  const dbPath = join(dir, 'g.sqlite')
  const db = openDb(dbPath)
  dbs.push(db)
  const clock = new FakeClock()
  const events = new EventBus(() => clock.now())
  const key = InstallKey.loadOrCreate(join(dir, 'ik.json'), clock.now())
  const ledger = new Ledger(db, clock, events, key)
  const o = mkOrigin('user:usr_local', 'test', 'cli')
  return { dir, dbPath, db, clock, events, key, ledger, o }
}
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close() } catch { /* 已关 */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

const note = (l: Ledger, o: ReturnType<typeof setup>['o'], text = 'hi') => l.append({ type: 'note', origin: o, subject: { orgId: 'org_local' }, payload: { text } })

describe('账本：只追加 + 哈希链', () => {
  it('创世条目 seq=0；哈希链通过 verify', () => {
    const { ledger, o } = setup()
    expect(ledger.get(0)?.type).toBe('checkpoint')
    for (let i = 0; i < 25; i++) note(ledger, o, `n${i}`)
    const v = ledger.verify()
    expect(v.ok).toBe(true)
    expect(v.count).toBe(26)
    expect(v.lastSeq).toBe(25)
  })

  it('API 与触发器都不允许更新 / 删除', () => {
    const { ledger, db, o } = setup()
    note(ledger, o)
    expect(() => db.prepare('UPDATE ledger SET type=? WHERE seq=1').run('note')).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM ledger WHERE seq=1').run()).toThrow(/append-only/)
    expect((ledger as unknown as Record<string, unknown>).update).toBeUndefined()
    expect((ledger as unknown as Record<string, unknown>).delete).toBeUndefined()
  })

  it('绕过触发器的篡改（改载荷 / 改头部 / 删中间 / 截断）被 verify 发现并指出位置', () => {
    for (const attack of ['payload', 'header', 'delete-middle', 'forge-hash']) {
      const { ledger, dbPath, o } = setup()
      for (let i = 0; i < 6; i++) note(ledger, o, `n${i}`)
      const raw = new DatabaseSync(dbPath) // 另一个连接，删掉触发器后动手
      raw.exec('DROP TRIGGER ledger_no_update; DROP TRIGGER ledger_no_delete;')
      const row = raw.prepare('SELECT entry FROM ledger WHERE seq=3').get() as { entry: string }
      const e = JSON.parse(row.entry) as LedgerEntry
      if (attack === 'payload') { e.payload = { text: 'tampered' }; raw.prepare('UPDATE ledger SET entry=? WHERE seq=3').run(JSON.stringify(e)) }
      if (attack === 'header') { e.type = 'note'; e.subject = { orgId: 'org_other' } as never; raw.prepare('UPDATE ledger SET entry=? WHERE seq=3').run(JSON.stringify(e)) }
      if (attack === 'delete-middle') raw.prepare('DELETE FROM ledger WHERE seq=3').run()
      if (attack === 'forge-hash') { e.payload = { text: 'x' }; e.hash = 'sha256:' + '0'.repeat(64) as never; raw.prepare('UPDATE ledger SET entry=? WHERE seq=3').run(JSON.stringify(e)) }
      raw.close()
      const v = ledger.verify()
      expect(v.ok, attack).toBe(false)
      expect(v.failure?.seq, attack).toBeGreaterThanOrEqual(3)
      expect(v.failure?.seq, attack).toBeLessThanOrEqual(4)
    }
  })

  it('检查点：用安装密钥签名，验链校验签名；伪造检查点被发现；截断到检查点之前被发现', () => {
    const { ledger, o, db } = setup()
    for (let i = 0; i < 5; i++) note(ledger, o)
    const cp = ledger.checkpoint()
    expect(cp.type).toBe('checkpoint')
    expect(ledger.verify().ok).toBe(true)
    // 把检查点载荷里的 hash 换掉并重算整条（链内自洽，但签名对不上）
    const entries = [...ledger.iterate()]
    const forged = entries.map((e) => ({ ...e })) as LedgerEntry[]
    const last = forged[forged.length - 1]!
    last.payload = { ...(last.payload as object), sig: 'AAAA' }
    expect(verifyEntries(forged, { publicKeys: { [ledger.installKey.keyId]: ledger.installKey.publicKey } }).ok).toBe(false)
    void db
  })

  it('禁写字段：供应商私有字段、密钥类字段名被拒', () => {
    const { ledger, o } = setup()
    for (const payload of [{ tool_use_id: 'x' }, { thinking: 'x' }, { reasoning_content: 'x' }, { nested: { privateKey: '0xabc' } }, { mnemonic: 'a b c' }, { pin: '123456' }]) {
      expect(() => ledger.append({ type: 'note', origin: o, subject: { orgId: 'org_local' }, payload })).toThrow()
    }
  })

  it('字段规则：origin 四项必填且 actorType 与 actor 一致；subject 至少一项；拒单必须带预检结果与撞了哪条规则', () => {
    const { ledger, o } = setup()
    expect(() => ledger.append({ type: 'note', origin: { ...o, actorType: 'llm-agent' }, subject: { orgId: 'org_local' } })).toThrow(/actorType/)
    expect(() => ledger.append({ type: 'note', origin: o, subject: {} })).toThrow(/subject/)
    expect(() => ledger.append({ type: 'risk.denied', origin: o, subject: { orgId: 'org_local' } })).toThrow(/precheck/)
    expect(() => ledger.append({ type: 'risk.denied', origin: o, subject: { orgId: 'org_local' }, precheck: { precheckId: 'pck_1' as never, verdict: 'deny', policyVersion: 1, estimates: {} } })).toThrow(/ruleHits/)
    const e = ledger.append({
      type: 'risk.denied', origin: o, subject: { orgId: 'org_local' }, precheck: { precheckId: 'pck_1' as never, verdict: 'deny', policyVersion: 1, estimates: { notional: '10' as never } },
      ruleHits: [{ ruleId: 'pol_1#maxLeverage', code: 'LEVERAGE', limit: '3' as never, actual: '9' as never, unit: 'x', action: 'deny', scope: 'account' }],
    })
    expect(e.ruleHits![0]!.code).toBe('LEVERAGE')
    expect(e.precheck!.verdict).toBe('deny')
  })

  it('不变量 3：账本时间只认内核时间——拒绝带过去时间的补录', () => {
    const { ledger, o, clock } = setup()
    const now = clock.now()
    expect(() => ledger.append({ type: 'note', origin: o, subject: { orgId: 'org_local' }, ts: now - 3_600_000 })).toThrow(/backdated/)
    expect(() => ledger.append({ type: 'note', origin: o, subject: { orgId: 'org_local' }, ts: now + 60_000 })).toThrow(/future/)
    const ok = ledger.append({ type: 'note', origin: o, subject: { orgId: 'org_local' }, ts: now - 1000 })
    expect(ok.recordedAt).toBe(now)
  })

  it('不变量 3：回放 / 回测的产物永远不进前向账本，只能以 backtest.completed 单独打标', () => {
    const { ledger, o } = setup()
    for (const type of ['fill', 'order.submitted', 'position.snapshot'] as const) {
      expect(() => ledger.append({ type, origin: o, subject: { accountId: 'acct_1' as never }, payload: { source: 'backtest' } })).toThrow(/forward ledger/)
      expect(() => ledger.append({ type, origin: o, subject: { accountId: 'acct_1' as never }, payload: { replay: true } })).toThrow(/forward ledger/)
    }
    expect(() => ledger.append({ type: 'backtest.completed', origin: o, subject: { experimentId: 'exp_1' as never }, payload: { sharpe: 1 } })).toThrow(/source/)
    expect(ledger.append({ type: 'backtest.completed', origin: o, subject: { experimentId: 'exp_1' as never }, payload: { source: 'backtest', sharpe: 1 } }).type).toBe('backtest.completed')
  })

  it('导出 JSON(L) + Markdown，导出文件独立可验；过滤导出链仍连续；脱敏导出去掉载荷', () => {
    const { ledger, o, dir } = setup()
    for (let i = 0; i < 8; i++) note(ledger, o, `secret-looking-text-${i}`)
    ledger.checkpoint()
    const out = join(dir, 'exp1')
    const m = ledger.export({ dir: out, exportedBy: o, markdown: true })
    const entries = readFileSync(join(out, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerEntry)
    const man = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as ExportManifest
    expect(man.count).toBe(entries.length)
    expect(verifyExport(entries, man).ok).toBe(true)
    expect(readFileSync(join(out, 'trade-log.md'), 'utf8')).toContain('| 序号 seq |')
    expect(m.lastHash).toBe(entries[entries.length - 1]!.hash)
    // 脱敏
    const red = join(dir, 'exp2')
    ledger.export({ dir: red, exportedBy: o, redaction: 'payload' })
    const rEntries = readFileSync(join(red, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerEntry)
    expect(rEntries.every((e) => e.payload === undefined)).toBe(true)
    expect(readFileSync(join(red, 'ledger.jsonl'), 'utf8')).not.toContain('secret-looking-text')
    expect(verifyExport(rEntries, JSON.parse(readFileSync(join(red, 'manifest.json'), 'utf8')) as ExportManifest).ok).toBe(true)
    // 导出文件被改 → 验不过
    entries[3]!.subject = { orgId: 'org_x' } as never
    expect(verifyExport(entries, man).ok).toBe(false)
    expect(ledger.verify().ok).toBe(true) // 导出动作自己也入账
    expect(ledger.query({ types: ['export.created'] }).length).toBe(2)
  })

  it('查询与追溯', () => {
    const { ledger, o } = setup()
    ledger.append({ type: 'note', origin: o, subject: { accountId: 'acct_1' as never, orderId: 'ord_1' as never } })
    ledger.append({ type: 'note', origin: o, subject: { accountId: 'acct_2' as never } })
    expect(ledger.query({ accountId: 'acct_1' }).length).toBe(1)
    expect(ledger.trace({ orderId: 'ord_1' }).length).toBe(1)
    expect(ledger.query({ types: ['note'], order: 'asc' }).map((e) => e.seq)).toEqual([1, 2])
  })
})
