// SPDX-License-Identifier: CPAL-1.0
// 签名对拍。
//   1) EIP-712 规范里的 Mail 示例（已知哈希 / 签名）→ 校验测试签名器本身没写错；
//   2) 官方 Python SDK tests/signing_test.py 里的 L1 动作向量（已知 r / s / v）→ 校验 @nktkas/hyperliquid 的 L1 签名与官方一致；
//   3) 同一载荷两次签名一致 + 地址恢复一致；
//   4) approveAgent / approveBuilderFee：我们生成的待签载荷，签出来的结果与 SDK 自己的 signUserSignedAction 逐字节一致。
// 注意：向量 2 用的是官方 SDK 公开的测试密钥（不是任何真实密钥），按重复图案现拼，源码里不出现 64 位十六进制字面量。
import { signL1Action, signUserSignedAction } from '@nktkas/hyperliquid/signing'
import { ApproveAgentTypes, ApproveBuilderFeeTypes } from '@nktkas/hyperliquid/api/exchange'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { buildApproveAgent, buildApproveBuilderFee, splitSignature, toExchangePayload } from '../src/approvals'
import { hashTypedData, makeTestSigner } from './helpers/test-signer'

const sdkVectorKey = () => hexToBytes(('0123456789'.repeat(7)).slice(0, 64))

describe('test signer self-check (EIP-712 spec example)', () => {
  it('matches the published Mail example: hash, address and signature', async () => {
    const types = {
      Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
      Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
    }
    const params = {
      domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
      types,
      primaryType: 'Mail',
      message: {
        from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
        to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
        contents: 'Hello, Bob!',
      },
    }
    expect(bytesToHex(hashTypedData(params))).toBe('be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2')
    const signer = makeTestSigner(keccak_256(utf8ToBytes('cow')))
    expect(signer.address.toLowerCase()).toBe('0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826')
    const sig = await signer.signTypedData(params as never)
    expect(sig).toBe(
      '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c',
    )
    expect(signer.recover(params, sig)).toBe(signer.address)
  })
})

describe('L1 action signing vs the official SDK vector', () => {
  const pad = (h: string) => `0x${h.replace(/^0x/, '').padStart(64, '0')}`
  const action = { type: 'dummy', num: 100000000000 } // 官方向量：float_to_int_for_hashing(1000) = 1000 × 1e8

  it('mainnet signature equals the official Python SDK test vector', async () => {
    const signer = makeTestSigner(sdkVectorKey())
    const sig = await signL1Action({ wallet: signer as never, action, nonce: 0, isTestnet: false })
    expect(sig.r).toBe(pad('53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298'))
    expect(sig.s).toBe(pad('755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8'))
    expect(sig.v).toBe(27)
  })

  it('testnet signs a different message (source "b" vs "a")', async () => {
    const signer = makeTestSigner(sdkVectorKey())
    const main = await signL1Action({ wallet: signer as never, action, nonce: 0, isTestnet: false })
    const test = await signL1Action({ wallet: signer as never, action, nonce: 0, isTestnet: true })
    expect(test.r).not.toBe(main.r)
  })

  it('same payload signed twice is identical, and the signature recovers to the signer address', async () => {
    const signer = makeTestSigner()
    const a = await signL1Action({ wallet: signer as never, action: { type: 'cancel', cancels: [{ a: 0, o: 12345 }] }, nonce: 1791483435048 })
    const b = await signL1Action({ wallet: signer as never, action: { type: 'cancel', cancels: [{ a: 0, o: 12345 }] }, nonce: 1791483435048 })
    expect(a).toEqual(b)
    const typed = signer.seen[0]!
    const sigHex = `${a.r}${a.s.slice(2)}${a.v.toString(16)}`
    expect(signer.recover(typed, sigHex)).toBe(signer.address)
    // 换一个 nonce 签名必须不同
    const c = await signL1Action({ wallet: signer as never, action: { type: 'cancel', cancels: [{ a: 0, o: 12345 }] }, nonce: 1791483435049 })
    expect(c.r).not.toBe(a.r)
  })
})

describe('user-signed payloads (main wallet, outside the connector)', () => {
  const agent = '0x1111111111111111111111111111111111111111'

  it('approveAgent: our typed data signs to exactly what the SDK signs, and recovers to the main wallet', async () => {
    const main = makeTestSigner()
    const req = buildApproveAgent({ environment: 'testnet', agentAddress: agent, nonce: 1791483435048, now: 1791483435048 })
    expect(req.signWith).toBe('main-wallet')
    expect(req.action).toMatchObject({ type: 'approveAgent', hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', agentName: 'gitrader', agentAddress: agent })
    const mine = await main.signTypedData(req.typedData as never)
    const sdk = await signUserSignedAction({ wallet: main as never, action: req.action as never, types: ApproveAgentTypes })
    expect(splitSignature(mine as `0x${string}`)).toEqual(sdk)
    expect(main.recover(req.typedData as never, mine)).toBe(main.address)
    expect(toExchangePayload(req, mine as `0x${string}`)).toEqual({ action: req.action, nonce: 1791483435048, signature: sdk })
  })

  it('approveAgent: validity is capped at 180 days and appended with the official syntax', () => {
    const now = 1791483435048
    const ok = buildApproveAgent({ environment: 'mainnet', agentAddress: agent, validUntilMs: now + 30 * 86_400_000, nonce: 1, now })
    expect(ok.action.agentName).toBe(`gitrader valid_until ${now + 30 * 86_400_000}`)
    expect(() => buildApproveAgent({ environment: 'mainnet', agentAddress: agent, validUntilMs: now + 181 * 86_400_000, nonce: 1, now })).toThrow(/180 days/)
    expect(() => buildApproveAgent({ environment: 'mainnet', agentAddress: 'nope', nonce: 1, now })).toThrow()
  })

  it('approveBuilderFee: 1 bp is 0.01%, lowercase builder, SDK-identical signature', async () => {
    const main = makeTestSigner()
    const builder = '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd'
    const req = buildApproveBuilderFee({ environment: 'mainnet', builderAddress: builder, nonce: 1791483435048, supportDeveloper: true })
    expect(req.action).toMatchObject({ type: 'approveBuilderFee', hyperliquidChain: 'Mainnet', maxFeeRate: '0.01%', builder: builder.toLowerCase() })
    const mine = await main.signTypedData(req.typedData as never)
    const sdk = await signUserSignedAction({ wallet: main as never, action: req.action as never, types: ApproveBuilderFeeTypes })
    expect(splitSignature(mine as `0x${string}`)).toEqual(sdk)
    expect(() => buildApproveBuilderFee({ environment: 'mainnet', builderAddress: builder, tenthBps: 50, nonce: 1, supportDeveloper: true })).toThrow(/fixed/)
    // 产品默认免费：没有显式打开「支持开发者」就不生成授权载荷
    expect(() => buildApproveBuilderFee({ environment: 'mainnet', builderAddress: builder, nonce: 1, supportDeveloper: false })).toThrow(/supportDeveloper is off/)
  })
})
