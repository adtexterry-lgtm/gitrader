// SPDX-License-Identifier: CPAL-1.0
// E0-8：忘了 PIN 的重置。重置后人只能重设 PIN；账本、历史与安装签名身份保留。
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Kernel, fileProvider, mkOrigin, resetPin } from '../src/index'
import { FAST_SCRYPT } from './helpers/harness'

const OLD_PIN = '482916'
const NEW_PIN = '539104'
const homes: string[] = []

interface Prepared {
  home: string
  token: string
  keyId: string
  mandateId: string
  installKey: string
  entries: number
}

/** 临时 home：设 PIN + 建一只钱包（产生 keystore.json）+ 建一把 agent 钥匙；返回前关内核。 */
async function prepare(): Promise<Prepared> {
  const home = mkdtempSync(join(tmpdir(), 'gitrader-e0-8-'))
  homes.push(home)
  const k = await Kernel.create({ home, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false })
  try {
    const pin = await k.auth.setupPinLocalTerminal(OLD_PIN)
    k.keystore.unlock(pin)
    k.keystore.generate(pin, { name: 'w1' })
    const paper = k.accounts.find('paper')!
    const { token, key, mandate } = k.agents.createKey(
      { name: 'bot', host: 'claude-code', tier: 'read_only', mandate: { accounts: [paper.accountId] } },
      pin,
      mkOrigin('user:usr_local', 'agentkey.create', 'cli'),
    )
    const install = readFileSync(join(home, 'keys', 'install-key.json'), 'utf8')
    return { home, token, keyId: key.keyId, mandateId: mandate.mandateId, installKey: install, entries: k.ledger.count() }
  } finally {
    await k.stop()
  }
}

/** 重置后重新打开内核做检查，结束关掉。 */
async function inspect<T>(home: string, fn: (k: Kernel) => Promise<T> | T): Promise<T> {
  const k = await Kernel.create({ home, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false })
  try {
    return await fn(k)
  } finally {
    await k.stop()
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

describe('gitrader pin reset（内核）', () => {
  it('install key and ledger survive reset', async () => {
    const p = await prepare()
    await inspect(p.home, (k) => {
      expect(k.ledger.query({ types: ['key.revoked', 'mandate.revoked'], limit: 1000 })).toHaveLength(0)
    })
    const r = await resetPin(p.home)
    expect(r.movedFiles.sort()).toEqual(['device.key.json', 'keystore.json', 'pin.json'])
    expect(existsSync(join(p.home, 'keys', 'install-key.json'))).toBe(true)
    expect(readFileSync(join(p.home, 'keys', 'install-key.json'), 'utf8')).toBe(p.installKey)
    await inspect(p.home, (k) => {
      expect(k.ledger.verify().ok).toBe(true)
      const revoked = k.ledger.query({ types: ['key.revoked', 'mandate.revoked'], limit: 1000 }).length
      expect(k.ledger.count()).toBe(p.entries + revoked + 1)
    })
  })

  it('old PIN no longer works, new PIN works', async () => {
    const p = await prepare()
    await resetPin(p.home)
    await inspect(p.home, async (k) => {
      expect(k.pin.isSet()).toBe(false)
      const proof = await k.auth.setupPinLocalTerminal(NEW_PIN)
      expect(proof.presence).toBe('pin')
      await expect(k.pin.verify(OLD_PIN)).rejects.toThrow(/invalid PIN/)
      expect((await k.pin.verify(NEW_PIN)).length).toBe(32)
    })
  })

  it('agent keys and sessions revoked', async () => {
    const p = await prepare()
    const r = await resetPin(p.home)
    expect(r.revokedKeys).toBe(1)
    await inspect(p.home, (k) => {
      expect(k.agents.listKeys()).toHaveLength(1)
      expect(k.agents.getKey(p.keyId)?.status).toBe('revoked')
      expect(k.agents.getMandate(p.mandateId)?.status).toBe('revoked')
      // 旧令牌（Agent 的"会话"）不再认得出主体
      expect(k.auth.authenticateToken(p.token)).toBeNull()
    })
  })

  it('keystore archived not deleted', async () => {
    const p = await prepare()
    const r = await resetPin(p.home)
    expect(existsSync(join(p.home, 'keys', 'pin.json'))).toBe(false)
    expect(existsSync(join(p.home, 'keys', 'keystore.json'))).toBe(false)
    expect(basename(r.backupDir)).toMatch(/^keys\.bak-\d{8}-\d{6}(-\d+)?$/)
    const archived = JSON.parse(readFileSync(join(r.backupDir, 'keystore.json'), 'utf8')) as { wallets: unknown[] }
    expect(archived.wallets).toHaveLength(1)
    expect(existsSync(join(r.backupDir, 'pin.json'))).toBe(true)
    expect(readdirSync(join(p.home, 'keys')).sort()).toEqual(['install-key.json'])
    expect(existsSync(join(r.backupDir, 'device.key.json'))).toBe(true)
  })

  it('writes pin.reset ledger entry', async () => {
    const p = await prepare()
    const r = await resetPin(p.home)
    await inspect(p.home, (k) => {
      const entry = k.ledger.query({ limit: 1000 })
        .find((e) => e.type === ('pin.reset' as string) || (e.payload as { action?: string } | undefined)?.action === 'pin.reset')
      expect(entry).toBeDefined()
      expect(entry!.origin.actor).toBe('user:usr_local')
      expect(entry!.origin.tool).toBe('cli:pin.reset')
      expect(entry!.origin.via).toBe('cli')
      expect(entry!.attestation).toBe('user-asserted')
      const payload = entry!.payload as { backupDir: string; revokedKeys: number }
      expect(payload.backupDir).toBe(basename(r.backupDir))
      expect(payload.revokedKeys).toBe(1)
    })
  })

  it('refuses while service is running', async () => {
    const p = await prepare()
    writeFileSync(join(p.home, 'service.json'), JSON.stringify({ port: 47900, pid: process.pid, token: 'svc_test', startedAt: Date.now(), version: 'test' }))
    // fix-r4: 文案改为引导 gitrader stop（后台模式没有 serve 窗口）
    await expect(resetPin(p.home)).rejects.toThrow('服务还在运行。先运行 gitrader stop 停掉它，再重置 PIN。')
    expect(existsSync(join(p.home, 'keys', 'pin.json'))).toBe(true)
    expect(existsSync(join(p.home, 'keys', 'keystore.json'))).toBe(true)
    expect(readdirSync(p.home).some((name) => name.startsWith('keys.bak-'))).toBe(false)
  })
})
