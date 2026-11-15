// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C2：账本导出 /2 —— manifest 签名、链头、完整性标记；verifyExport 的签名 / 受信公钥 / 库比对 / /1 老件告警。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { mkOrigin } from '../src/util/origin'
import { verifyExport } from '../src/ledger'
import type { ExportManifest } from '../src/ledger'
import { EXPORT_SIGNING_PREFIX, exportSigningData } from '../src/ledger-verify'
import type { LedgerEntry } from '../src/proto'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  for (let i = 0; i < 5; i++) {
    h.k.ledger.append({ type: 'note', origin: mkOrigin('user:usr_local', 'test', 'internal'), subject: { orgId: 'org_local' }, payload: { text: `n${i}` } })
  }
})
afterEach(async () => { await h.cleanup() })

function doExport(name: string): { entries: LedgerEntry[]; manifest: ExportManifest } {
  const dir = join(h.home, name)
  h.k.ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), markdown: false })
  return {
    entries: readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerEntry),
    manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExportManifest,
  }
}
const dbOf = (): NonNullable<Parameters<typeof verifyExport>[2]>['ledger'] => ({ head: () => h.k.ledger.head(), hashAt: (seq) => h.k.ledger.get(seq)?.hash })

describe('导出 /2', () => {
  it('manifest 带 schema /2、chainHead（写 export.created 之前的链头）、complete、签名；尾部是刚补的检查点', () => {
    const headBefore = h.k.ledger.head()
    const { entries, manifest } = doExport('e1')
    expect(manifest.schema).toBe('gitrader-ledger-export/2')
    expect(manifest.signature).toMatchObject({ keyId: h.k.ledger.installKey.keyId, alg: 'ed25519' })
    expect(manifest.complete).toBe(true)
    expect(manifest.chainHead!.seq).toBe(headBefore.seq + 1) // 补了一枚检查点
    expect(entries.at(-1)!.type).toBe('checkpoint')
    expect(entries.at(-1)!.seq).toBe(manifest.chainHead!.seq)
    expect(manifest.toSeq).toBe(manifest.chainHead!.seq)
    expect(exportSigningData('sha256:x')).toBe(`${EXPORT_SIGNING_PREFIX}sha256:x`)
    const r = verifyExport(entries, manifest)
    expect(r.ok).toBe(true)
    expect(r.signer).toBe(h.k.ledger.installKey.keyId)
    expect(r.warnings).toBeUndefined()
  })

  it('部分导出（toSeq 小于链头）complete=false，签名仍成立', () => {
    const dir = join(h.home, 'e-part')
    const m = h.k.ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), toSeq: 3 })
    expect(m.complete).toBe(false)
    expect(m.toSeq).toBe(3)
    const entries = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerEntry)
    expect(verifyExport(entries, m).ok).toBe(true)
  })

  it('签名不可用 → 拒绝导出，不产出无签名件', () => {
    const key = h.k.ledger.installKey
    const orig = key.isAvailable.bind(key)
    key.isAvailable = () => false
    try {
      expect(() => h.k.ledger.export({ dir: join(h.home, 'e-nosig'), exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal') })).toThrow(/install signing key/)
    } finally { key.isAvailable = orig }
  })
})

describe('verifyExport /2', () => {
  it('删尾行 + 同步改 manifest 的 toSeq / count / lastHash → 签名对不上', () => {
    const { entries, manifest } = doExport('e2')
    const cut = entries.slice(0, -1)
    const last = cut.at(-1)!
    const forged: ExportManifest = { ...manifest, toSeq: last.seq, count: cut.length, lastHash: last.hash }
    const r = verifyExport(cut, forged)
    expect(r.ok).toBe(false)
    expect(r.failure?.reason).toBe('manifest signature invalid')
  })

  it('只删尾行不改 manifest → 条数对不上', () => {
    const { entries, manifest } = doExport('e3')
    const r = verifyExport(entries.slice(0, -1), manifest)
    expect(r.ok).toBe(false)
    expect(r.failure?.reason).toBe('export does not match manifest')
  })

  it('签名本身被改（一个字符）→ 签名无效', () => {
    const { entries, manifest } = doExport('e4')
    const sig = manifest.signature!.sig
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    const r = verifyExport(entries, { ...manifest, signature: { ...manifest.signature!, sig: flipped } })
    expect(r.ok).toBe(false)
    expect(r.failure?.reason).toBe('manifest signature invalid')
  })

  it('去掉 signature 字段 → 签名无效（不能把 /2 降成无签名）', () => {
    const { entries, manifest } = doExport('e5')
    const { signature: _drop, ...rest } = manifest
    void _drop
    const r = verifyExport(entries, rest as ExportManifest)
    expect(r.ok).toBe(false)
    expect(r.failure?.reason).toBe('manifest signature invalid')
  })

  it('给了受信公钥而 manifest 的公钥不同 → 拒绝（别的安装密钥签的）', () => {
    const { entries, manifest } = doExport('e6')
    const other = { keyId: 'install-other', publicKey: manifest.installKey.publicKey }
    const r = verifyExport(entries, manifest, { trustedKey: other })
    expect(r.ok).toBe(false)
    expect(r.failure?.reason).toBe('export signed by a different install key')
    const same = verifyExport(entries, manifest, { trustedKey: manifest.installKey })
    expect(same.ok).toBe(true)
  })

  it('库比对：导出后又新增的条数；库里 toSeq 的哈希对不上 → 失败', () => {
    const { entries, manifest } = doExport('e7')
    const base = verifyExport(entries, manifest, { ledger: dbOf() })
    expect(base.ok).toBe(true)
    expect(base.db).toEqual({ compared: true, newerEntries: 1 }) // 只有 export.created 自己
    h.k.ledger.append({ type: 'note', origin: mkOrigin('user:usr_local', 'test', 'internal'), subject: { orgId: 'org_local' }, payload: { text: 'later' } })
    expect(verifyExport(entries, manifest, { ledger: dbOf() }).db?.newerEntries).toBe(2)
    const wrong = verifyExport(entries, manifest, { ledger: { head: () => h.k.ledger.head(), hashAt: () => 'sha256:ffff' } })
    expect(wrong.ok).toBe(false)
    expect(wrong.db?.compared).toBe(true)
    expect(wrong.failure?.reason).toMatch(/does not match this machine's ledger/)
    const shorter = verifyExport(entries, manifest, { ledger: { head: () => ({ seq: 0, hash: 'x' }), hashAt: () => undefined } })
    expect(shorter.ok).toBe(false)
  })
})

describe('verifyExport /1 老件', () => {
  it('仍然通过，但带「无签名，无法发现尾部被删」告警', () => {
    const { entries, manifest } = doExport('e8')
    const { signature: _s, chainHead: _c, complete: _k, ...rest } = manifest
    void _s; void _c; void _k
    const old = { ...rest, schema: 'gitrader-ledger-export/1' as const }
    const r = verifyExport(entries, old)
    expect(r.ok).toBe(true)
    expect(r.signer).toBeUndefined()
    expect(r.warnings).toEqual(['旧版导出件，无签名，无法发现尾部被删'])
  })

  it('降级攻击：删尾行 + 改 manifest + schema 降成 /1 → 链内自洽，但库比对能看出库里之后还有条目；本机密钥不一致仍被拒', () => {
    const { entries, manifest } = doExport('e8b')
    const cut = entries.slice(0, -1)
    const last = cut.at(-1)!
    const { signature: _s, chainHead: _c, complete: _k, ...rest } = manifest
    void _s; void _c; void _k
    const forged = { ...rest, schema: 'gitrader-ledger-export/1' as const, toSeq: last.seq, count: cut.length, lastHash: last.hash }
    const r = verifyExport(cut, forged, { ledger: dbOf() })
    expect(r.ok).toBe(true)
    expect(r.signer).toBeUndefined()
    expect(r.db?.newerEntries).toBeGreaterThan(0)
    const other = verifyExport(cut, forged, { trustedKey: { keyId: 'install-other', publicKey: manifest.installKey.publicKey } })
    expect(other.ok).toBe(false)
    expect(other.failure?.reason).toBe('export signed by a different install key')
  })

  it('未知 schema 拒绝', () => {
    const { entries, manifest } = doExport('e9')
    const r = verifyExport(entries, { ...manifest, schema: 'gitrader-ledger-export/9' as never })
    expect(r.ok).toBe(false)
    expect(r.failure?.reason).toMatch(/unsupported export schema/)
  })
})
