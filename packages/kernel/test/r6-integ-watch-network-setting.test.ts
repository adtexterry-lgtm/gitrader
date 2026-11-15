// SPDX-License-Identifier: CPAL-1.0
// R3-20 跟进（集成项）：观察账户跟「网络开关 / 配置保存」解绑。
// 观察账户（mode 'watch'，只读、无钥匙）保持自己的 environment：settings.network.set 不翻它，
// 配置保存（config.venues.set / config.notify.set）不再要求它的 environment 等于场所当前连的网。交易账户行为不变。
import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigAccount } from '../src/config'
import { loadConfig } from '../src/config'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const MAIN_ID = 'acct_WATCH000000000000000000011'
const TEST_ID = 'acct_WATCH000000000000000000012'
const addr = (n: string) => `0x${n.repeat(20)}`
const watchEntry = (alias: string, accountId: string, environment: 'mainnet' | 'testnet', address: string): ConfigAccount =>
  ({ alias, venue: 'hyperliquid', environment, mode: 'watch', watch: { address }, accountId }) as unknown as ConfigAccount

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

// harness 的场所默认连测试网；两个观察账户：一个主网、一个测试网
const setup = async (): Promise<Harness> => {
  h = await makeHarness({ configure: (c) => { c.accounts.push(watchEntry('obs-main', MAIN_ID, 'mainnet', addr('ab')), watchEntry('obs-test', TEST_ID, 'testnet', addr('cd'))) } })
  return h
}
const call = (name: string, params: Record<string, unknown>): Promise<unknown> => h!.k.ops.call(h!.k, name, { principal: h!.session, params, transport: 'ws' })
const envOf = (alias: string): string | undefined => h!.k.config.accounts.find((a) => a.alias === alias)?.environment
const venueEnv = (): string | undefined => h!.k.config.venues.find((v) => v.id === 'hyperliquid')?.environment
const onDisk = (alias: string): string | undefined => loadConfig(h!.home).accounts.find((a) => a.alias === alias)?.environment

describe('settings.network.set：观察账户不跟网络开关走', () => {
  it('切到主网：场所与交易账户翻到主网，两个观察账户（主网 / 测试网）各保持自己的 environment', async () => {
    await setup()
    const pin = await h!.pinProof()
    h!.k.keystore.generate(pin, { name: 'main-w', network: 'mainnet' }) // 主网默认关闭：先要有一只主网 API 钱包
    expect(await call('settings.network.set', { network: 'mainnet' })).toEqual({ network: 'mainnet', restartRequired: true })
    expect(venueEnv()).toBe('mainnet')
    expect(envOf('paper')).toBe('mainnet') // 交易账户照旧跟着翻
    expect(envOf('live')).toBe('mainnet')
    expect(envOf('obs-test')).toBe('testnet') // 观察账户没被翻
    expect(envOf('obs-main')).toBe('mainnet')
    expect(onDisk('obs-test')).toBe('testnet') // 落盘的也一样
    expect(onDisk('obs-main')).toBe('mainnet')
    expect(onDisk('paper')).toBe('mainnet')
  })

  it('切回测试网：主网观察账户不被翻成测试网', async () => {
    await setup()
    const pin = await h!.pinProof()
    h!.k.keystore.generate(pin, { name: 'main-w', network: 'mainnet' })
    await call('settings.network.set', { network: 'mainnet' })
    await call('settings.network.set', { network: 'testnet' })
    expect(venueEnv()).toBe('testnet')
    expect(envOf('paper')).toBe('testnet')
    expect(envOf('live')).toBe('testnet')
    expect(envOf('obs-main')).toBe('mainnet') // 修复前这里会变成 testnet
    expect(envOf('obs-test')).toBe('testnet')
    expect(onDisk('obs-main')).toBe('mainnet')
  })
})

describe('配置保存：观察账户的 environment 不必等于场所当前连的网', () => {
  it('config.notify.set 在「场所测试网、观察账户主网」时照常保存（修复前 INVALID_PARAMS）', async () => {
    await setup()
    expect(venueEnv()).toBe('testnet')
    expect(envOf('obs-main')).toBe('mainnet')
    const r = await call('config.notify.set', { channels: [] }) as { restartRequired: boolean }
    expect(r.restartRequired).toBe(true)
    expect(onDisk('obs-main')).toBe('mainnet') // 观察账户原样保留
  })

  it('config.venues.set 只改场所（enabled）时照常保存，观察账户原样保留', async () => {
    await setup()
    const venues = structuredClone(h!.k.config.venues) as unknown as Record<string, unknown>[]
    venues[0]!.enabled = false
    await call('config.venues.set', { patch: { venues } })
    expect(h!.k.config.venues[0]!.enabled).toBe(false)
    expect(envOf('obs-main')).toBe('mainnet')
    expect(envOf('obs-test')).toBe('testnet')
  })

  it('交易账户仍须等于场所的网：纸面账户写主网（场所测试网）照旧被拒', async () => {
    await setup()
    const accounts = (structuredClone(h!.k.config.accounts) as unknown as Record<string, unknown>[]).filter((a) => a.alias === 'paper')
    accounts[0]!.environment = 'mainnet'
    await expect(call('config.venues.set', { patch: { accounts } })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(envOf('paper')).toBe('testnet')
  })
})
