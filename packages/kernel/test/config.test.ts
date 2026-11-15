// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultConfig, initHome, resolveHome, validateConfig, homePaths, RESERVED_PORTS, DEFAULT_PORT_START } from '../src/config'
import { AccountRegistry } from '../src/accounts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'gitrader-cfg-'))

describe('配置与目录', () => {
  it('init 生成 gitrader.json 与四个目录，重复 init 幂等（字节不变）', () => {
    const home = tmp()
    try {
      const r1 = initHome(home)
      const p = homePaths(home)
      for (const d of [p.plugins, p.engines, p.workspaces, p.lab]) expect(existsSync(d)).toBe(true)
      expect(r1.created).toContain(p.config)
      const before = readFileSync(p.config, 'utf8')
      const r2 = initHome(home)
      expect(r2.created).toEqual([])
      expect(readFileSync(p.config, 'utf8')).toBe(before)
      expect(r2.config.accounts[0]!.accountId).toBe(r1.config.accounts[0]!.accountId)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('默认值：测试网、supportDeveloper 默认关、默认只读+纸面档、主网默认不开', () => {
    const c = defaultConfig()
    expect(c.supportDeveloper).toBe(false)
    expect(c.venues.every((v) => v.environment === 'testnet')).toBe(true)
    expect(c.keys.defaultTier).toBe('paper')
    expect(c.risk.denyLlmLiveEntries ?? true).toBe(true)
    expect(validateConfig(c)).toEqual([])
  })

  it('GITRADER_HOME 覆盖主目录；参数优先于环境变量', () => {
    expect(resolveHome(undefined, { GITRADER_HOME: 'D:/x/y' })).toBe(resolve('D:/x/y'))
    expect(resolveHome('D:/arg', { GITRADER_HOME: 'D:/env' })).toBe(resolve('D:/arg'))
  })

  it('配置校验：非法值被指出，不做静默修正', () => {
    const c = defaultConfig() as any
    c.venues[0].environment = 'devnet'
    c.risk.limits.maxOrderNotional = '1e3'
    c.supportDeveloper = 'yes'
    c.keys.defaultTier = 'auto_limited'
    const p = validateConfig(c).join('|')
    expect(p).toMatch(/environment/)
    expect(p).toMatch(/maxOrderNotional/)
    expect(p).toMatch(/supportDeveloper/)
    expect(p).toMatch(/auto_limited/)
  })

  it('无效 venues 对象保留类型问题，不抛出异常', () => {
    const c = defaultConfig() as any
    c.venues = {}
    let problems: string[] | undefined
    expect(() => { problems = validateConfig(c) }).not.toThrow()
    expect(problems).toContain('venues must be an array')
  })

  it('无效 venues 空条目保留条目问题，不抛出异常', () => {
    const c = defaultConfig() as any
    c.venues = [null]
    let problems: string[] | undefined
    expect(() => { problems = validateConfig(c) }).not.toThrow()
    expect(problems).toContain('venues[0].id invalid')
  })

  it('实盘 credentials 只接受非空 env 句柄，错误不回显明文字面值', () => {
    for (const credentials of [
      {},
      [],
      { apiKey: 'literal-canary-not-a-secret' },
      { apiKey: 'env:' },
    ]) {
      const c = defaultConfig() as any
      c.venues.push({ id: 'binance', environment: 'testnet', enabled: true })
      c.accounts.push({ alias: 'api-live', venue: 'binance', environment: 'testnet', mode: 'live', signerRef: 'wallet-placeholder', credentials })
      const problems = validateConfig(c).join('|')
      expect(problems.length).toBeGreaterThan(0)
      expect(problems).not.toContain('literal-canary-not-a-secret')
    }
  })

  it('合法 credentials 句柄允许实盘，纸面账户不占五家场所名额', () => {
    const c = defaultConfig() as any
    c.venues.push({ id: 'binance', environment: 'testnet', enabled: true })
    c.accounts.push(
      { alias: 'api-live', venue: 'binance', environment: 'testnet', mode: 'live', credentials: { apiKey: 'env:TEST_API_KEY', apiSecret: 'env:TEST_API_SECRET' } },
      { alias: 'paper-two', venue: 'binance', environment: 'testnet', mode: 'paper', paper: { initialBalance: '1000', ccy: 'USDT' } },
    )
    expect(validateConfig(c)).toEqual([])
  })

  it('五家场所不允许第二个实盘账户，且账户环境必须匹配已配置场所', () => {
    const duplicate = defaultConfig() as any
    duplicate.venues.push({ id: 'binance', environment: 'testnet', enabled: true })
    duplicate.accounts.push(
      { alias: 'api-live-1', venue: 'binance', environment: 'testnet', mode: 'live', credentials: { apiKey: 'env:TEST_KEY_ONE' } },
      { alias: 'api-live-2', venue: 'binance', environment: 'testnet', mode: 'live', credentials: { apiKey: 'env:TEST_KEY_TWO' } },
    )
    expect(validateConfig(duplicate).some((p) => /only one live account/i.test(p))).toBe(true)

    const mismatch = defaultConfig() as any
    mismatch.venues.push({ id: 'binance', environment: 'testnet', enabled: true })
    mismatch.accounts.push({ alias: 'api-live', venue: 'binance', environment: 'mainnet', mode: 'live', signerRef: 'wallet-placeholder', credentials: { apiKey: 'env:TEST_API_KEY' } })
    expect(validateConfig(mismatch).join('|')).toMatch(/environment/)
  })

  it('Hyperliquid 既有多个实盘 signerRef 配置不受五家唯一性规则影响', () => {
    const c = defaultConfig()
    c.accounts.push(
      { alias: 'hl-live-1', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'wallet-one' },
      { alias: 'hl-live-2', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'wallet-two' },
    )
    expect(validateConfig(c)).toEqual([])
  })

  it('AccountRegistry 只标记 credential 句柄，不解析或保存环境变量值', () => {
    const c = defaultConfig() as any
    c.accounts[0].accountId = 'acct_PAPER000000000000000000000001'
    c.venues.push({ id: 'binance', environment: 'testnet', enabled: true })
    c.accounts.push({ alias: 'api-live', accountId: 'acct_API000000000000000000000001', venue: 'binance', environment: 'testnet', mode: 'live', credentials: { apiKey: 'env:TEST_API_KEY' } })
    const account = new AccountRegistry(c).get('api-live')
    expect(account.signer).toMatchObject({ type: 'api-key', credentialRef: 'config' })
    expect(JSON.stringify(account.signer)).not.toContain('env:TEST_API_KEY')
  })

  it('引擎项：任意语言子进程 {command,args,env,cwd} 与远程 {url,auth} 合法；缺启动配置 / 明文令牌在 URL 里被拒', () => {
    const c = defaultConfig()
    c.engines.push({ id: 'my-rust-engine', enabled: true, launch: { command: './engine', args: ['--stdio'], env: { A: '1' }, cwd: '.' } })
    c.engines.push({ id: 'remote-1', enabled: true, launch: { url: 'wss://engine.example.test/gep', auth: { method: 'token', tokenRef: 'ref-1' } } })
    expect(validateConfig(c)).toEqual([])
    const bad = defaultConfig()
    const badLaunchIndex = bad.engines.length
    bad.engines.push({ id: 'x', enabled: true })
    bad.engines.push({ id: 'y', enabled: true, launch: { url: 'wss://e.test/gep?token=abc', auth: { method: 'token', tokenRef: 'r' } } })
    bad.engines.push({ id: 'z', enabled: true, launch: { url: 'ws://remote.example.test/gep', auth: { method: 'token', tokenRef: 'r' } } })
    const p = validateConfig(bad).join('|')
    expect(p).toContain(`engines[${badLaunchIndex}] needs launch`)
    expect(p).toMatch(/credentials must not be placed in the URL/)
    expect(p).toMatch(/non-loopback engines must use wss/)
  })

  it('默认端口探测起点 47900，避开保留端口', () => {
    expect(DEFAULT_PORT_START).toBe(47900)
    for (const p of [8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831]) expect(RESERVED_PORTS).toContain(p)
  })
})
