// SPDX-License-Identifier: CPAL-1.0
// R5 / GQ-59-B：钥匙库被改后无告警
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('GQ-59-B 钥匙库被改后无告警', () => {
  it('PIN 对、check 记录被改 → STATE_FILE_CORRUPT（不是 AUTH_FAILED），钥匙库进入 corrupt，health 变红', async () => {
    h = await makeHarness()
    const pin = await h.pinProof()
    h.k.keystore.generate(pin, { name: 'w1' })
    h.k.keystore.lock()
    const proof = await h.k.auth.pinProof(h.session, TEST_PIN)                    // 先拿证明，锁存之后 PIN 证明会被拦
    const f = join(h.home, 'keys', 'keystore.json')
    const j = JSON.parse(readFileSync(f, 'utf8')) as { check: { ct: string } }
    j.check.ct = (j.check.ct[0] === 'A' ? 'B' : 'A') + j.check.ct.slice(1)
    writeFileSync(f, JSON.stringify(j))
    expect(() => h!.k.keystore.unlock(proof)).toThrowError(/integrity check/)
    expect(() => h!.k.keystore.unlock(proof)).toThrowError(expect.objectContaining({ problem: expect.objectContaining({ name: 'STATE_FILE_CORRUPT' }) }))
    const files = h.k.securityStateHealth().files
    expect(files.find((x) => x.kind === 'keystore')?.state).toBe('corrupt')
    expect(h.k.healthSnapshot().degraded).toBe(true)
  })

  it('对照：没被改的钥匙库 + 对的 PIN 能解锁、能签名；错的 PIN 仍在 PIN 层被拒', async () => {
    h = await makeHarness()
    const pin = await h.pinProof()
    h.k.keystore.generate(pin, { name: 'w1' })
    h.k.keystore.lock()
    h.k.keystore.unlock(await h.k.auth.pinProof(h.session, TEST_PIN))
    expect(h.k.keystore.isUnlocked()).toBe(true)
    await expect(h.k.auth.pinProof(h.session, 'wrong-pin-xx')).rejects.toBeTruthy()
  })

  it('钱包记录里的密文被改：签名时报 STATE_FILE_CORRUPT 中英说明，不是 Node 原始 GCM 错误', async () => {
    h = await makeHarness()
    const pin = await h.pinProof()
    h.k.keystore.generate(pin, { name: 'w1' })
    const f = join(h.home, 'keys', 'keystore.json')
    const j = JSON.parse(readFileSync(f, 'utf8')) as { wallets: Array<{ enc: { ct: string } }> }
    j.wallets[0]!.enc.ct = (j.wallets[0]!.enc.ct[0] === 'A' ? 'B' : 'A') + j.wallets[0]!.enc.ct.slice(1)
    writeFileSync(f, JSON.stringify(j))
    const signer = h.k.keystore.getSigner('w1')
    const td = { domain: { name: 'test', version: '1', chainId: 1 }, types: { Test: [{ name: 'value', type: 'uint256' }] }, primaryType: 'Test', message: { value: 42 } }
    await expect(signer.signTypedData(td)).rejects.toThrow(/integrity check/)
    await expect(signer.signTypedData(td)).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
  })
})
