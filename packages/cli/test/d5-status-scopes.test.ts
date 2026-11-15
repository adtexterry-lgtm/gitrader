// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeConnector } from '../../kernel/test/helpers/fake-connector'
import { fileProvider } from '../../kernel/src/device-key'
import { main, runServe, type CliIo, type ServeHandle } from '../src/index'

let home = ''
let service: ServeHandle | undefined
const output: string[] = []
const io = (): CliIo => ({ out: (s) => output.push(s), err: (s) => output.push(s), env: { GITRADER_HOME: home }, deviceKey: fileProvider, readSecret: async () => '482916', interactive: true })
describe('D5 Chinese status scopes', () => {
  beforeAll(async () => {
    if (!process.env.GITRADER_HOME) throw new Error('isolated GITRADER_HOME required')
    home = mkdtempSync(join(process.env.GITRADER_HOME, 'd5-cli-'))
    expect(await main(['init'], io())).toBe(0)
    service = await runServe(home, { port: 51081, io: io(), connectors: false, connect: (k) => { k.registerConnector(new FakeConnector({ id: 'kernel-sim', clock: k.clock })) } })
  })
  afterAll(async () => {
    await service?.stop()
    if (home && resolve(home).startsWith(resolve(process.env.GITRADER_HOME!) + sep)) rmSync(home, { recursive: true, force: true })
  })
  it('reads real account and mandate stops and retains raw JSON mode', async () => {
    const k = service!.kernel
    const account = k.accounts.find('paper')!
    const origin = { actor: 'user:usr_local', actorType: 'human', tool: 'test', via: 'internal', requestId: 'd5000000-0000-4000-8000-000000000001' } as const
    k.tstate.set({ type: 'account', id: account.accountId }, 'REDUCING', '账户测试停机', origin)
    k.tstate.set({ type: 'mandate', id: 'mdt_fixture' } as never, 'HALTED', '授权测试停机', origin)
    output.length = 0
    expect(await main(['status'], io())).toBe(0)
    const text = output.join('')
    expect(text).toContain('交易状态：已停止')
    expect(text).toContain('账户 ' + account.alias + '：只减仓')
    // fix-r4: status 不再露授权书 6 位编号，改写钥匙名（此处授权书没有对应钥匙，写「某 Agent」）
    expect(text).toContain('Agent「某 Agent」：已停止')
    expect(text).not.toContain('ixture')
    output.length = 0
    expect(await main(['status', '--json'], io())).toBe(0)
    expect(JSON.parse(output.join('')).running).toBe(true)
  })
})
