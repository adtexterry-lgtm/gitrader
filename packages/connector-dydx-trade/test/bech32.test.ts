// SPDX-License-Identifier: CPAL-1.0
// bech32 向量取自 BIP-173 官方测试集；dydx 地址部分只验证编码/解码互逆与 hrp 隔离（地址口径的官方向量在 keys.test.ts）。
import { describe, expect, it } from 'vitest'
import { bech32Decode, bech32Encode, fromWords, toWords } from '../src/bech32'
import { fromHex, toHex } from '../src/keys'

describe('BIP-173 官方向量', () => {
  it('A12UEL5L 解出 hrp=a、空数据', () => {
    const d = bech32Decode('A12UEL5L')
    expect(d).not.toBeNull()
    expect(d!.hrp).toBe('a')
    expect(d!.bytes).toHaveLength(0)
  })

  it('a12uel5l 小写同样有效', () => {
    expect(bech32Decode('a12uel5l')?.hrp).toBe('a')
  })

  it('an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs 有效', () => {
    const s = 'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs'
    expect(bech32Decode(s)?.hrp).toBe('an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio')
  })

  it('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw 有效，数据 20 字节', () => {
    const d = bech32Decode('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw')
    expect(d?.hrp).toBe('abcdef')
    expect(d!.bytes).toHaveLength(20)
  })

  it('90 字符上限：恰好在界内可解码，越界编码抛错', () => {
    const bytes = new Uint8Array(50).fill(0x11) // 1 + 1 + 80 + 6 = 88 字符
    const s = bech32Encode('a', bytes)
    expect(s.length).toBeLessThanOrEqual(90)
    expect(bech32Decode(s)?.hrp).toBe('a')
    expect(() => bech32Encode('a', new Uint8Array(52))).toThrow(TypeError)
  })

  it('校验和错的串被拒（split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w 改一位）', () => {
    expect(bech32Decode('split1checkupstagehandshakeupstreamerranterredcaperred2y9e3x')).toBeNull()
  })

  it('大小写混用被拒', () => {
    expect(bech32Decode('A12uEL5L')).toBeNull()
  })

  it('没有分隔符 / 分隔符太靠后 / 字符不在字符集里都被拒', () => {
    expect(bech32Decode('1qzzfhee')).toBeNull()
    expect(bech32Decode('pzry9x0s0muk')).toBeNull()
    expect(bech32Decode('A1G7SGD8')).toBeNull()
  })
})

describe('convertbits', () => {
  it('8→5→8 往返保持不变', () => {
    for (const hex of ['', '00', 'ff', 'deadbeef', '00112233445566778899aabbccddeeff']) {
      const bytes = fromHex(hex)
      expect(toHex(fromWords(toWords(bytes))!)).toBe(hex)
    }
  })

  it('填充位非零的字序列被拒', () => {
    expect(fromWords([1])).toBeNull()
  })
})

describe('dydx 地址编码', () => {
  const addressBytes = fromHex('7e5f4552091a69125d5dfcb7b8c2659029395bdf')

  it('编码以 dydx1 开头且总长 43（20 字节地址 + 6 位校验和）', () => {
    const addr = bech32Encode('dydx', addressBytes)
    expect(addr.startsWith('dydx1')).toBe(true)
    expect(addr).toHaveLength(43)
  })

  it('解码回到同样的 20 字节，hrp 为 dydx', () => {
    const addr = bech32Encode('dydx', addressBytes)
    const d = bech32Decode(addr)
    expect(d?.hrp).toBe('dydx')
    expect(toHex(d!.bytes)).toBe('7e5f4552091a69125d5dfcb7b8c2659029395bdf')
  })

  it('同字节不同 hrp 产生不同串，且不能互相解码成同一 hrp', () => {
    const dydx = bech32Encode('dydx', addressBytes)
    const cosmos = bech32Encode('cosmos', addressBytes)
    expect(dydx).not.toBe(cosmos)
    expect(bech32Decode(cosmos)?.hrp).toBe('cosmos')
  })

  it('非法 hrp（含大写以外的符号）被拒', () => {
    expect(() => bech32Encode('dydx!', addressBytes)).toThrow(TypeError)
  })

  it('超过 90 字符输出被拒', () => {
    expect(() => bech32Encode('d', new Uint8Array(80))).toThrow(TypeError)
  })
})
