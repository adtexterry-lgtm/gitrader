// SPDX-License-Identifier: Apache-2.0
// 账本哈希链测试向量的构造（测试与向量生成脚本共用）。
import { createHash } from 'node:crypto'
import { GENESIS_PREV_HASH, computeEntryHash, computePayloadHash, type LedgerEntry } from '../src'
import { contract } from './helpers'

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** 构造三条链：创世 checkpoint → 契约 §6.6 的风控拒单 → 契约 §6.6 的接管。载荷哈希与条目哈希都由协议包的函数重算。 */
export function buildChain(): LedgerEntry[] {
  const genesis: Omit<LedgerEntry, 'hash'> = {
    schema: 'gitrader-ledger/1',
    seq: 0,
    id: 'led_01JABE0GENESIS000000000000',
    ts: 1791549000000,
    recordedAt: 1791549000002,
    type: 'checkpoint',
    origin: { actor: 'system:kernel', actorType: 'system', tool: 'kernel:init', requestId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', via: 'internal' },
    subject: { ledgerRef: 'genesis' },
    payload: { installId: 'install-test-0001', createdAt: 1791549000000 },
    payloadHash: `sha256:${'0'.repeat(64)}`,
    attestation: 'kernel-observed',
    prevHash: GENESIS_PREV_HASH,
  }
  const entries: LedgerEntry[] = []
  const seal = (e: Omit<LedgerEntry, 'hash' | 'payloadHash' | 'prevHash'> & { payloadHash?: string; prevHash?: string }): void => {
    const prev = entries.at(-1)
    const withLinks = {
      ...e,
      prevHash: prev ? prev.hash : GENESIS_PREV_HASH,
      payloadHash: computePayloadHash(e.payload, sha256Hex),
    } as Omit<LedgerEntry, 'hash'>
    entries.push({ ...withLinks, hash: computeEntryHash(withLinks, sha256Hex) })
  }
  seal(genesis)
  const a = contract('ledger-risk-denied') as LedgerEntry
  seal({ ...a, seq: 1 })
  const b = contract('ledger-takeover-applied') as LedgerEntry
  seal({ ...b, seq: 2 })
  return entries
}
