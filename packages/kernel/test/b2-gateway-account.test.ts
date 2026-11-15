// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig, validateConfig } from '../src/config'
import { AccountRegistry } from '../src/accounts'
import { FakeConnector } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'

const ibkrConfig = () => {
  const config = defaultConfig()
  config.venues.push({ id: 'ibkr', environment: 'testnet', enabled: true })
  config.accounts[0]!.accountId = 'acct_paper' as never
  config.accounts.push({ alias: 'ibkr-live', accountId: 'acct_ibkr' as never, venue: 'ibkr', environment: 'testnet', mode: 'live', owner: { accountRef: 'local-account-01' } })
  return config
}

describe('B2-08A 本机会话账户', () => {
  it('IBKR live 可不带 credentials/signerRef；重复 live 与其它场所缺凭据仍拒绝', () => {
    const config = ibkrConfig()
    expect(validateConfig(config)).toEqual([])
    config.accounts.push({ alias: 'ibkr-second', venue: 'ibkr', environment: 'testnet', mode: 'live' })
    expect(validateConfig(config).join('|')).toMatch(/only one live account/)
    const other = ibkrConfig()
    other.accounts[1]!.venue = 'hyperliquid'
    expect(validateConfig(other).join('|')).toMatch(/signerRef or valid credentials required/)
  })

  it('IBKR 不能混入 credentials 或 signerRef，且 Alpaca 同样限制单 live 账户', () => {
    const withCredentials = ibkrConfig()
    withCredentials.accounts[1]!.credentials = { apiKey: 'env:IBKR_KEY' }
    expect(validateConfig(withCredentials).join('|')).toMatch(/IBKR.*credentials|credentials.*IBKR/i)
    const withSigner = ibkrConfig()
    withSigner.accounts[1]!.signerRef = 'wallet-ref'
    expect(validateConfig(withSigner).join('|')).toMatch(/IBKR.*signerRef|signerRef.*IBKR/i)
    const alpaca = defaultConfig()
    alpaca.accounts.push({ alias: 'alpaca-first', venue: 'alpaca', environment: 'testnet', mode: 'live', signerRef: 'wallet-ref' })
    alpaca.accounts.push({ alias: 'alpaca-second', venue: 'alpaca', environment: 'testnet', mode: 'live', signerRef: 'wallet-ref-2' })
    expect(validateConfig(alpaca).join('|')).toMatch(/only one live account.*alpaca/)
  })

  it('统一账户保留 owner.accountRef', () => {
    const config = ibkrConfig()
    const registry = new AccountRegistry(config)
    expect(registry.find('ibkr-live')?.owner).toEqual({ accountRef: 'local-account-01' })
  })

  it('session signer 未解锁时拒单，解锁后到达测试连接器且不请求钱包签名；paper signer 仍为 none', async () => {
    const h = await makeHarness({ registerLive: false, configure: (config) => {
      config.venues.push({ id: 'ibkr', environment: 'testnet', enabled: true })
      const live = config.accounts.find((account) => account.alias === 'live')!
      live.venue = 'ibkr'
      live.signerRef = undefined
      live.credentials = undefined
      live.owner = { accountRef: 'local-account-01' }
    } })
    try {
      const connector = new FakeConnector({ id: 'hyperliquid', clock: h.clock })
      Object.defineProperty(connector, 'venue', { value: 'ibkr' })
      for (const instrument of connector.instrumentsList) {
        instrument.venue = 'ibkr'
        instrument.instrumentId = instrument.instrumentId.replace('hyperliquid:', 'ibkr:')
      }
      connector.marks.set('ibkr:BTC', '80000')
      h.k.registerConnector(connector)
      const account = h.k.accounts.find('live')!
      expect(account.signer).toEqual({ type: 'gateway-session', credentialRef: 'gateway-session', permissions: { trade: true, withdraw: false } })
      expect(account.owner).toEqual({ address: account.owner.address, accountRef: 'local-account-01' })
      expect(h.k.accounts.find('paper')?.signer.type).toBe('none')
      const view = await h.k.ops.call(h.k, 'config.view', { principal: h.session, params: {}, transport: 'ws' }) as { accounts: Array<{ alias: string; owner?: { accountRef?: string } }> }
      expect(view.accounts.find((row) => row.alias === 'live')?.owner?.accountRef).toBe('local-account-01')
      const saved = await h.k.ops.call(h.k, 'config.venues.set', { principal: h.session, params: { patch: { accounts: structuredClone(h.k.config.accounts) } }, transport: 'ws' }) as { config: { accounts: Array<{ alias: string; owner?: { accountRef?: string } }> } }
      expect(saved.config.accounts.find((row) => row.alias === 'live')?.owner?.accountRef).toBe('local-account-01')
      expect(new AccountRegistry(loadConfig(h.home)).find('live')?.owner.accountRef).toBe('local-account-01')
      const intent = { accountId: account.accountId, instrumentId: 'ibkr:BTC', side: 'buy', type: 'market', size: '0.003', leverage: 2, reason: 'test' } as never
      expect((await h.k.trading.place({ intent }, h.human())).order?.problem?.name).toBe('VENUE_AUTH')
      expect(connector.submitted).toHaveLength(0)
      await h.pinProof()
      h.clock.advance(11_000)
      expect((await h.k.trading.place({ intent }, h.human())).order?.status).toBe('filled')
      expect(connector.submitted).toHaveLength(1)
      expect(connector.submitted[0]?.signed).toBe(false)
    } finally { await h.cleanup() }
  })
})
