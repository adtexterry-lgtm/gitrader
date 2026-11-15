// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Keystore } from '../src/keystore'
import { addressOf, hashTypedData, recoverAddress } from '../src/eip712'
import { TEST_PIN, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const PK = bytesToHex(keccak_256(new TextEncoder().encode('gitrader-test-api-wallet')))
const td = { domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' }, types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, primaryType: 'Agent', message: { source: 'a', connectionId: '0x' + '22'.repeat(32) } }

describe('密钥库', () => {
  it('静态加密：私钥明文（hex / base64）不出现在磁盘上；列表只有名称 / 地址 / 到期 / 撤销', async () => {
    const pin = await h.pinProof()
    const w = h.k.keystore.import(pin, { name: 'hl-api-1', privateKey: PK })
    const file = join(h.home, 'keys', 'keystore.json')
    expect(Keystore.fileLeaks(file, PK)).toBe(false)
    expect(readFileSync(file, 'utf8')).not.toContain(PK)
    expect(Object.keys(h.k.keystore.list()[0]!).sort()).toEqual(['address', 'createdAt', 'expiresInDays', 'expiringSoon', 'kind', 'name', 'network', 'notAfter', 'revokedAt', 'status', 'venue', 'walletId'])
    expect(w.address).toBe(addressOf(Uint8Array.from(Buffer.from(PK, 'hex'))))
    expect(w.status).toBe('active')
    expect(w.expiresInDays).toBeLessThanOrEqual(180)
    expect(w.expiresInDays).toBeGreaterThan(170)
  })

  it('签名器句柄：signTypedData 形状，签名可恢复出钱包地址；每次签名把载荷摘要写进账本，账本里没有密钥', async () => {
    const pin = await h.pinProof()
    const w = h.k.keystore.import(pin, { name: 'hl-api-1', privateKey: PK })
    const signer = h.k.keystore.getSigner('hl-api-1')
    const sig = await signer.signTypedData(td)
    expect(recoverAddress(hashTypedData(td), sig)).toBe(w.address)
    const entry = h.k.ledger.query({ types: ['signer.signed'], limit: 1 })[0]!
    expect(JSON.stringify(entry)).not.toContain(PK)
    expect((entry.payload as any).digest).toMatch(/^0x[0-9a-f]{64}$/)
    expect(Object.keys(signer).sort()).toEqual(['address', 'signTypedData', 'walletId'])
  })

  it('锁定 → 不能签名；错误 PIN 解不开；重启后要重新用 PIN 解锁', async () => {
    const pin = await h.pinProof()
    h.k.keystore.import(pin, { name: 'hl-api-1', privateKey: PK })
    h.k.keystore.lock()
    await expect(h.k.keystore.getSigner('hl-api-1').signTypedData(td)).rejects.toMatchObject({ problem: { code: 5003 } })
    await expect(h.k.auth.pinProof(h.session, 'wrong-pin-xx')).rejects.toBeTruthy()
    h.k.keystore.unlock(await h.k.auth.pinProof(h.session, TEST_PIN))
    await expect(h.k.keystore.getSigner('hl-api-1').signTypedData(td)).resolves.toMatch(/^0x/)
  })

  it('撤销只需会话且立刻生效；到期的钱包不能签名；地址不复用；名称不重复', async () => {
    const pin = await h.pinProof()
    h.k.keystore.import(pin, { name: 'hl-api-1', privateKey: PK })
    expect(() => h.k.keystore.import(pin, { name: 'other', privateKey: PK })).toThrow(/already in the keystore/)
    expect(() => h.k.keystore.generate(pin, { name: 'hl-api-1' })).toThrow(/already used/)
    const s = h.k.keystore.getSigner('hl-api-1')
    h.k.keystore.revoke(h.sessionProof(), 'hl-api-1')
    await expect(s.signTypedData(td)).rejects.toThrow(/revoked/)
    const g = h.k.keystore.generate(pin, { name: 'gen-1', validityDays: 30 })
    expect(JSON.stringify(g)).not.toMatch(/priv|secret/i)
    h.clock.advance(31 * 86_400_000)
    expect(h.k.keystore.list().find((x) => x.name === 'gen-1')!.status).toBe('expired')
    expect(() => h.k.keystore.getSigner('gen-1')).toThrow(/expired/)
    expect(() => h.k.keystore.getSigner('hl-api-1')).toThrow(/revoked/)
  })

  it('≤180 天到期提醒字段；超过 180 天的有效期被拒；非法私钥被拒', async () => {
    const pin = await h.pinProof()
    h.k.keystore.generate(pin, { name: 'soon', validityDays: 10 })
    expect(h.k.keystore.list()[0]!.expiringSoon).toBe(true)
    expect(() => h.k.keystore.import(pin, { name: 'long', privateKey: PK, notAfter: h.clock.now() + 200 * 86_400_000 })).toThrow(/within 180 days/)
    expect(() => h.k.keystore.import(pin, { name: 'bad1', privateKey: 'zz' })).toThrow(/32 bytes/)
    expect(() => h.k.keystore.import(pin, { name: 'bad2', privateKey: '00'.repeat(32) })).toThrow(/valid secp256k1/)
  })

  it('导入 / 生成只要会话有效且密钥库已解锁（契约 §5.1：会话即可，不逐次弹 PIN）；密钥库锁着则不行', async () => {
    await h.pinProof() // 设置 PIN 并解锁
    expect(h.k.keystore.generate(h.sessionProof(), { name: 'x' }).name).toBe('x')
    h.k.keystore.lock()
    expect(() => h.k.keystore.generate(h.sessionProof(), { name: 'y' })).toThrow(/locked/)
  })
})
