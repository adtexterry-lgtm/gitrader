// SPDX-License-Identifier: CPAL-1.0
// 账本验链（纯函数，库内与导出文件共用）：逐条重算 JCS 哈希、prevHash 连续、seq 无缺口、检查点签名。
import { GENESIS_PREV_HASH, LEDGER_SCHEMA, computeEntryHash, computePayloadHash } from './proto'
import type { LedgerEntry } from './proto'
import { sha256Hex } from './util/hash'
import { InstallKey } from './install-key'

export interface VerifyFailure { seq: number; reason: string }
export interface VerifyResult {
  ok: boolean
  count: number
  firstSeq: number | null
  lastSeq: number | null
  lastHash: string | null
  checkpoints: number
  failure?: VerifyFailure
  /** 导出件校验附带：不致命的提示（例如 /1 旧件无签名）。 */
  warnings?: string[]
  /** 导出件校验附带：已核对签名的安装密钥 ID。 */
  signer?: string
  /** 导出件校验附带：与本机库比对的结果（compared=false 表示没比）。 */
  db?: { compared: boolean; newerEntries?: number; mismatch?: string }
}
export interface VerifyOptions {
  /** keyId → SPDX DER base64 公钥。缺省时跳过检查点签名校验（并在结果里体现为 checkpoints 计数不含签名校验）。 */
  publicKeys?: Record<string, string>
  /** 部分导出：期望第一条的 seq（缺省 0，且要求创世条目）。 */
  fromSeq?: number
}

/** 检查点签名的被签数据。 */
export const checkpointSigningData = (upToSeq: number, hash: string): string => `gitrader-ledger-checkpoint/1:${upToSeq}:${hash}`

/** 导出件 manifest 签名的被签数据（digest = digestOf(去掉 signature 的 manifest)）。 */
export const EXPORT_SIGNING_PREFIX = 'gitrader-ledger-export/2:'
export const exportSigningData = (digest: string): string => `${EXPORT_SIGNING_PREFIX}${digest}`

export function verifyEntries(entries: Iterable<LedgerEntry>, opts: VerifyOptions = {}): VerifyResult {
  const res: VerifyResult = { ok: true, count: 0, firstSeq: null, lastSeq: null, lastHash: null, checkpoints: 0 }
  const hashes = new Map<number, string>()
  const pendingCheckpoints: { seq: number; upToSeq: number; hash: string }[] = []
  const bad = (seq: number, reason: string): VerifyResult => { res.ok = false; res.failure = { seq, reason }; return res }
  let prev: LedgerEntry | undefined
  for (const e of entries) {
    if (e.schema !== LEDGER_SCHEMA) return bad(e.seq, `unexpected schema ${String(e.schema)}`)
    if (prev === undefined) {
      const first = opts.fromSeq ?? 0
      if (e.seq !== first) return bad(e.seq, `chain starts at seq ${e.seq}, expected ${first}`)
      if (e.seq === 0 && (e.type !== 'checkpoint' || e.prevHash !== GENESIS_PREV_HASH)) return bad(e.seq, 'invalid genesis entry')
      res.firstSeq = e.seq
    } else {
      if (e.seq !== prev.seq + 1) return bad(e.seq, `seq gap: ${prev.seq} -> ${e.seq}`)
      if (e.prevHash !== prev.hash) return bad(e.seq, 'prevHash does not match previous entry hash')
    }
    if (e.payload !== undefined && computePayloadHash(e.payload, sha256Hex) !== e.payloadHash) return bad(e.seq, 'payloadHash mismatch')
    if (computeEntryHash(e, sha256Hex) !== e.hash) return bad(e.seq, 'entry hash mismatch')
    hashes.set(e.seq, e.hash)
    if (e.type === 'checkpoint' && e.seq > 0) {
      res.checkpoints++
      const p = e.payload as { upToSeq?: number; hash?: string; keyId?: string; sig?: string } | undefined
      if (p && typeof p.upToSeq === 'number' && typeof p.hash === 'string') {
        if (p.upToSeq >= e.seq) return bad(e.seq, 'checkpoint points forward')
        pendingCheckpoints.push({ seq: e.seq, upToSeq: p.upToSeq, hash: p.hash })
        const known = hashes.get(p.upToSeq)
        if (known !== undefined && known !== p.hash) return bad(e.seq, `checkpoint hash does not match entry ${p.upToSeq}`)
        const pub = p.keyId ? opts.publicKeys?.[p.keyId] : undefined
        if (opts.publicKeys && !pub) return bad(e.seq, `checkpoint signed by unknown key ${String(p.keyId)}`)
        if (pub && !(typeof p.sig === 'string' && InstallKey.verify(pub, checkpointSigningData(p.upToSeq, p.hash), p.sig))) return bad(e.seq, 'checkpoint signature invalid')
      }
    }
    prev = e
    res.count++
    res.lastSeq = e.seq
    res.lastHash = e.hash
  }
  return res
}
