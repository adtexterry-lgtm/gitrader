// SPDX-License-Identifier: CPAL-1.0
// R3-20：gitrader accounts watch <0x地址>——只写一条只读观察账户；非法输入一个字节都不改配置；观察账户的网络与交易场所连的网无关。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider, loadConfig } from '@gitrader/kernel'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let out: string[]
let err: string[]
const io = (): CliIo => ({ out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider, readSecret: async () => { throw new Error('unexpected secret prompt') } })
const run = (argv: string[]): Promise<number> => main(argv, io())
const cfgText = (): string => readFileSync(join(home, 'gitrader.json'), 'utf8')
const ADDR = `0x${'ab'.repeat(20)}`

beforeEach(async () => { home = mkdtempSync(join(tmpdir(), 'gitrader-watch-')); out = []; err = []; expect(await run(['init', '--no-pin'])).toBe(0); out = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader accounts watch', () => {
  it('写入一条 watch 账户：别名缺省 watch-<前 6 位>，有 accountId，不带 signerRef / credentials / paper，提示重启或下次启动', async () => {
    expect(await run(['accounts', 'watch', ADDR, '--network', 'testnet'])).toBe(0)
    const acc = loadConfig(home).accounts.find((a) => (a.mode as string) === 'watch')!
    expect(acc).toMatchObject({ alias: 'watch-abababa'.slice(0, 12), venue: 'hyperliquid', environment: 'testnet', watch: { address: ADDR } })
    expect(acc.accountId).toMatch(/^acct_/)
    expect(acc).not.toHaveProperty('signerRef')
    expect(acc).not.toHaveProperty('credentials')
    expect(acc).not.toHaveProperty('paper')
    expect(out.join('')).toMatch(/serve|重启|restart/i)
  })

  it('--alias 指定名字；同一地址同一网络再加一次是无操作', async () => {
    expect(await run(['accounts', 'watch', ADDR, '--alias', 'qa-watch', '--network', 'testnet'])).toBe(0)
    const once = cfgText()
    expect(await run(['accounts', 'watch', ADDR.toUpperCase().replace('0X', '0x'), '--alias', 'another', '--network', 'testnet'])).toBe(0)
    expect(cfgText()).toBe(once)
  })

  it('非法地址 / 非法网络 / 重名：退出码非 0，gitrader.json 一个字节都不改', async () => {
    const before = cfgText()
    for (const argv of [
      ['accounts', 'watch', '0x123'],
      ['accounts', 'watch', ADDR.slice(0, -1)],
      ['accounts', 'watch', `0x${'zz'.repeat(20)}`],
      ['accounts', 'watch', ADDR, '--network', 'devnet'],
      ['accounts', 'watch', ADDR, '--alias', 'paper', '--network', 'testnet'],
      ['accounts', 'watch'],
      ['accounts', 'nope', ADDR],
    ]) {
      err = []
      expect(await run(argv), argv.join(' ')).not.toBe(0)
      expect(err.join('')).not.toBe('')
      expect(cfgText()).toBe(before)
    }
  })

  it('缺省 --network 是 mainnet，而默认的 hyperliquid 场所连测试网：照样加上，观察账户在主网（r3-20 跟进）', async () => {
    expect(await run(['accounts', 'watch', ADDR])).toBe(0)
    expect(err.join('')).toBe('')
    expect(loadConfig(home).accounts.find((a) => (a.mode as string) === 'watch')).toMatchObject({ environment: 'mainnet', venue: 'hyperliquid', watch: { address: ADDR } })
    expect(loadConfig(home).venues.find((v) => v.id === 'hyperliquid')!.environment).toBe('testnet') // 交易场所没动
  })
})
