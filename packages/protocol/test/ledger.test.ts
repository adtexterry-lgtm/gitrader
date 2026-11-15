// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CanonicalizeError, GENESIS_PREV_HASH, LEDGER_ENTRY_TYPE_LIST, LEDGER_ENTRY_TYPES, canonicalize, computeEntryHash, computePayloadHash, entryHashInput,
  findForbiddenLedgerKeys, payloadHashInput, validateLedgerEntry, formatIssues,
} from '../src'
import { PKG_ROOT } from './helpers'
import { buildChain, sha256Hex } from './ledger-chain'

const VECTORS = join(PKG_ROOT, 'test', 'vectors', 'ledger-chain.json')

describe('canonicalize（RFC 8785 JCS）', () => {
  it('RFC 8785 §3.2.4 的完整示例', () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    }
    const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`
    expect(canonicalize(input)).toBe(expected)
  })
  it('RFC 8785 §3.2.3：键按 UTF-16 码元序排序', () => {
    const o: Record<string, string> = {
      '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '😀': 'Emoji: Grinning Face', '\u0080': 'Control',
      'ö': 'Latin Small Letter O With Diaeresis',
    }
    const out = canonicalize(o)
    const order = ['"\\r"', '"1"', '"\u0080"', '"ö"', '"€"', '"😀"', '"דּ"'].map((k) => out.indexOf(`${k}:`))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
  it('数字格式：-0 → 0，整数不带小数点，大小指数与 JS 一致', () => {
    expect(canonicalize([-0, 0, 1, 1.5, 100, 1e21, 1e-7, 123456789012345680000])).toBe('[0,0,1,1.5,100,1e+21,1e-7,123456789012345680000]')
  })
  it('无空白、嵌套、空容器、转义', () => {
    expect(canonicalize({ b: [], a: {}, c: { z: 1, y: [1, { b: 2, a: 1 }] } })).toBe('{"a":{},"b":[],"c":{"y":[1,{"a":1,"b":2}],"z":1}}')
    expect(canonicalize('a"b\\c\u0001\u007f')).toBe('"a\\"b\\\\c\\u0001\u007f"')
  })
  it('键的顺序不影响结果', () => {
    expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalize({ b: { d: 3, c: 2 }, a: 1 }))
  })
  it('非 JSON 数据一律抛错，不悄悄丢字段', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalizeError)
    expect(() => canonicalize(NaN)).toThrow(CanonicalizeError)
    expect(() => canonicalize(Infinity)).toThrow(CanonicalizeError)
    expect(() => canonicalize(10n)).toThrow(CanonicalizeError)
    expect(() => canonicalize(() => 1)).toThrow(CanonicalizeError)
    expect(() => canonicalize(new Date())).toThrow(CanonicalizeError)
  })
})

describe('哈希链（§6.3）', () => {
  it('创世 prevHash 是 sha256: 加 64 个 0', () => {
    expect(GENESIS_PREV_HASH).toBe(`sha256:${'0'.repeat(64)}`)
  })
  it('payloadHash 的输入是 JCS(payload)，无载荷时是空对象', () => {
    expect(payloadHashInput({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(payloadHashInput(undefined)).toBe('{}')
    expect(computePayloadHash(undefined, sha256Hex)).toBe(`sha256:${sha256Hex('{}')}`)
    expect(sha256Hex('{}')).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
  })
  it('条目哈希的输入去掉 hash 与 payload，头部（含 payloadHash、precheck、ruleHits、prevHash）入链', () => {
    const [genesis] = buildChain()
    const input = JSON.parse(entryHashInput(genesis!)) as Record<string, unknown>
    expect(input).not.toHaveProperty('hash')
    expect(input).not.toHaveProperty('payload')
    expect(input).toHaveProperty('payloadHash')
    expect(input).toHaveProperty('prevHash')
    expect(entryHashInput(genesis!)).toBe(canonicalize(input))
  })
  it('载荷脱敏后链仍可验：去掉 payload 不改变条目哈希', () => {
    const chain = buildChain()
    for (const e of chain) {
      const { payload: _p, ...redacted } = e
      expect(computeEntryHash(redacted as typeof e, sha256Hex)).toBe(e.hash)
    }
  })
  it('三条链全部通过 schema，prevHash 连续，seq 无缺口，哈希可重算', () => {
    const chain = buildChain()
    expect(chain.map((e) => e.seq)).toEqual([0, 1, 2])
    chain.forEach((e, i) => {
      const r = validateLedgerEntry(e)
      expect(r.ok, `seq ${e.seq}: ${r.ok ? '' : formatIssues(r.issues)}`).toBe(true)
      expect(e.prevHash).toBe(i === 0 ? GENESIS_PREV_HASH : chain[i - 1]!.hash)
      expect(computeEntryHash(e, sha256Hex)).toBe(e.hash)
      expect(computePayloadHash(e.payload, sha256Hex)).toBe(e.payloadHash)
    })
  })
  it('任何字段被改，哈希都对不上（篡改可检出）', () => {
    const chain = buildChain()
    const tampered = structuredClone(chain[1]!)
    tampered.ruleHits![0]!.actual = '2' as never
    expect(computeEntryHash(tampered, sha256Hex)).not.toBe(chain[1]!.hash)
    const t2 = structuredClone(chain[1]!)
    t2.payload!['intent'] = { side: 'buy' }
    expect(computePayloadHash(t2.payload, sha256Hex)).not.toBe(chain[1]!.payloadHash)
  })
  it('测试向量（已提交的期望哈希）：算法被改动会立刻露馅', () => {
    const chain = buildChain()
    const current = chain.map((e) => ({ seq: e.seq, payloadHash: e.payloadHash, prevHash: e.prevHash, hash: e.hash }))
    if (process.env['UPDATE_VECTORS'] === '1') writeFileSync(VECTORS, `${JSON.stringify({ _comment: '由 test/ledger-chain.ts 构造；UPDATE_VECTORS=1 重新生成。任何变动都意味着哈希链算法变了——先在 CHANGELOG 登记。', entries: current }, null, 2)}\n`)
    const committed = JSON.parse(readFileSync(VECTORS, 'utf8')) as { entries: typeof current }
    expect(current).toEqual(committed.entries)
  })
})

describe('条目类型与禁写字段（§6.1、§6.2）', () => {
  it('类型表：组与总数', () => {
    expect(LEDGER_ENTRY_TYPES.orderAndExecution.length).toBe(15)
    expect(LEDGER_ENTRY_TYPES.proposal.length).toBe(6)
    expect(LEDGER_ENTRY_TYPES.authorizationAndRisk.length).toBe(10)
    expect(LEDGER_ENTRY_TYPES.takeover.length).toBe(4)
    expect(LEDGER_ENTRY_TYPES.enginesAndPlugins.length).toBe(8)
    expect(LEDGER_ENTRY_TYPES.lab.length).toBe(8)
    expect(LEDGER_ENTRY_TYPES.system.length).toBe(10)
    expect(new Set(LEDGER_ENTRY_TYPE_LIST).size).toBe(LEDGER_ENTRY_TYPE_LIST.length)
    expect(LEDGER_ENTRY_TYPE_LIST).toContain('signer.signed')
  })
  it('供应商私有字段不许进账本载荷', () => {
    expect(findForbiddenLedgerKeys({ a: { tool_use_id: 'x' }, b: [{ thinking: 'y' }, { reasoning_content: 'z' }], ok: 1 })).toEqual(['$.a.tool_use_id', '$.b[0].thinking', '$.b[1].reasoning_content'])
    expect(findForbiddenLedgerKeys({ intent: { side: 'buy' } })).toEqual([])
  })
  it('规则命中放在头部：risk.denied 的 ruleHits 在哈希输入里', () => {
    const chain = buildChain()
    expect(entryHashInput(chain[1]!)).toContain('"ruleHits"')
    expect(entryHashInput(chain[1]!)).not.toContain('"payload"')
  })
})
