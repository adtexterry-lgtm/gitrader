// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { addressOf, hashTypedData, recoverAddress, signTypedDataWithKey } from '../src/eip712'

// EIP-712 规范自带的 Mail 示例（私钥 = keccak256("cow")）。
const mail = {
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  types: {
    Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
    Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
  },
  primaryType: 'Mail',
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
}
const cow = keccak_256(new TextEncoder().encode('cow'))

describe('EIP-712 对拍规范向量', () => {
  it('摘要与规范一致', () => {
    expect(`0x${bytesToHex(hashTypedData(mail))}`).toBe('0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2')
  })
  it('地址与签名与规范一致，且能恢复出签名者', () => {
    expect(addressOf(cow)).toBe('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826')
    const { signature, digest } = signTypedDataWithKey(mail, cow)
    expect(signature).toBe('0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c')
    expect(recoverAddress(Uint8Array.from(Buffer.from(digest.slice(2), 'hex')), signature)).toBe(addressOf(cow))
  })
})
