// SPDX-License-Identifier: CPAL-1.0
// E0-4：令牌文件（只落盘、文件名安全化、同名不覆盖）与 agentkey.create 的 tokenFile 参数。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tokenFilePath, writeTokenFile } from '../src/token-file'
import { makeHarness, TEST_PIN } from './helpers/harness'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-token-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('E0-4 令牌文件', () => {
  it('token file contains only the token', () => {
    const path = writeTokenFile(home, 'bot', 'gtk_ONLYTHETOKEN')
    expect(path).toBe(join(home, 'agent-tokens', 'bot.token'))
    expect(readFileSync(path, 'utf8')).toBe('gtk_ONLYTHETOKEN\n')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('name is sanitised and never overwrites', () => {
    const first = writeTokenFile(home, '交易 bot/1', 'gtk_ONE')
    expect(first).toBe(join(home, 'agent-tokens', '交易-bot-1.token'))
    const second = writeTokenFile(home, '交易 bot/1', 'gtk_TWO')
    expect(second).toBe(join(home, 'agent-tokens', '交易-bot-1-2.token'))
    expect(readFileSync(first, 'utf8')).toBe('gtk_ONE\n')
    expect(readFileSync(second, 'utf8')).toBe('gtk_TWO\n')
    expect(tokenFilePath(home, '交易 bot/1')).toBe(join(home, 'agent-tokens', '交易-bot-1-3.token'))
    // 空名字用 agent
    expect(writeTokenFile(home, '', 'gtk_EMPTY')).toBe(join(home, 'agent-tokens', 'agent.token'))
  })

  it('agentkey.create with tokenFile returns path not token', async () => {
    const h = await makeHarness()
    try {
      await h.pinProof()
      const base = { name: 'bot', host: 'claude-code', tier: 'paper', mandate: { accounts: [h.paper.accountId] } }
      const r = await h.k.ops.call(h.k, 'agentkey.create', { principal: h.session, params: { ...base, tokenFile: true }, transport: 'http', pin: TEST_PIN }) as Record<string, unknown>
      expect(r.token).toBeUndefined()
      expect(r.tokenFilePath).toBe(join(h.home, 'agent-tokens', 'bot.token'))
      const content = readFileSync(String(r.tokenFilePath), 'utf8')
      expect(content.startsWith('gtk_')).toBe(true)
      expect(content.trim().split('\n')).toHaveLength(1)
      const token = content.trim()
      expect(JSON.stringify(r)).not.toContain(token)
      // tokenFile 不为 true 时行为不变：仍只在返回值里给一次令牌
      const plain = await h.k.ops.call(h.k, 'agentkey.create', { principal: h.session, params: base, transport: 'http', pin: TEST_PIN }) as Record<string, unknown>
      expect(typeof plain.token).toBe('string')
      expect(plain.tokenFilePath).toBeUndefined()
    } finally { await h.cleanup() }
  })
})
