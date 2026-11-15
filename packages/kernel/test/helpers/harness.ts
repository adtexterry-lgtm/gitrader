// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../../src/kernel'
import type { KernelOptions } from '../../src/kernel'
import { FakeClock } from '../../src/util/clock'
import { fileProvider } from '../../src/device-key'
import type { HumanProof, Principal } from '../../src/auth'
import type { ActorCtx } from '../../src/trading'
import { mkOrigin } from '../../src/util/origin'
import type { GitraderConfig } from '../../src/config'
import { FakeConnector, LIVE_ADDR } from './fake-connector'
import type { Account } from '../../src/proto'

export const TEST_PIN = '482916'
export const FAST_SCRYPT = { N: 1 << 10, r: 8, p: 1 }

export interface Harness {
  k: Kernel
  clock: FakeClock
  home: string
  sim: FakeConnector
  live: FakeConnector
  paper: Account
  liveAcct: Account
  session: Principal
  pinProof(): Promise<HumanProof>
  sessionProof(): HumanProof
  human(tool?: string): ActorCtx
  cleanup(): Promise<void>
}

/** 临时 GITRADER_HOME + 假时钟 + 低成本 scrypt + 不起定时器。纸面账户 paper；实盘账户 live（需要钱包 w1）。 */
export async function makeHarness(opts: { configure?: (c: GitraderConfig) => void; registerLive?: boolean; kernel?: Partial<KernelOptions> } = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'gitrader-test-'))
  const clock = new FakeClock()
  // 先 init 一次，改配置（加实盘账户），再创建内核
  const first = await Kernel.create({ home, clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false })
  await first.stop()
  const cfgPath = join(home, 'gitrader.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as GitraderConfig
  cfg.accounts.push({ alias: 'live', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'w1', accountId: 'acct_LIVE0000000000000000000001', owner: { address: LIVE_ADDR } })
  opts.configure?.(cfg)
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  const k = await Kernel.create({ home, clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined, ...(opts.kernel ?? {}) })
  const sim = new FakeConnector({ id: 'kernel-sim', clock })
  const live = new FakeConnector({ id: 'hyperliquid', clock })
  k.registerConnector(sim)
  if (opts.registerLive !== false) k.registerConnector(live)
  const paper = k.accounts.find('paper')!
  const liveAcct = k.accounts.find('live')!
  const boot = k.auth.mintBootToken()
  const s = k.auth.exchangeBoot(boot)
  const session = k.auth.authenticateToken(s.sessionToken)!
  return {
    k, clock, home, sim, live, paper, liveAcct, session,
    pinProof: async () => {
      if (!k.pin.isSet()) { const p = await k.auth.setupPin(session, TEST_PIN); k.keystore.unlock(p); return p }
      return k.auth.pinProof(session, TEST_PIN)
    },
    sessionProof: () => k.auth.sessionProof(session),
    human: (tool = 'test') => ({ principal: session, origin: mkOrigin('user:usr_local', tool, 'ui') }),
    cleanup: async () => { await k.stop().catch(() => undefined); rmSync(home, { recursive: true, force: true }) },
  }
}

// ---- 测试用 Agent ----------------------------------------------------------------
import type { Mandate } from '../../src/proto'
import type { IssueMandateInput } from '../../src/agents'
import { BTC, ETH } from './fake-connector'
import { newRequestId } from '../../src/util/ids'

export interface TestAgent { token: string; principal: Principal; keyId: string; mandate: Mandate; ctx(tool?: string): ActorCtx }

/** 建一把 Agent 钥匙（四档之一）。auto_limited 默认给一份合法的 L3 授权书（实盘白名单 BTC / ETH，自动阈值 300）。 */
export async function makeAgent(h: Harness, tier: 'read_only' | 'paper' | 'confirm' | 'auto_limited', over: Partial<Omit<IssueMandateInput, 'subject' | 'level'>> = {}): Promise<TestAgent> {
  const pin = await h.pinProof()
  const accounts = tier === 'read_only' || tier === 'paper' ? [h.paper.accountId, h.liveAcct.accountId] : [h.paper.accountId, h.liveAcct.accountId]
  const base: Omit<IssueMandateInput, 'subject' | 'level'> = { accounts: accounts as never }
  if (tier === 'confirm' || tier === 'auto_limited') Object.assign(base, { venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC, ETH], limits: { maxOrderNotional: '500', maxDailyNotional: '2000', ...(tier === 'auto_limited' ? { maxDailyLoss: '100', autoMaxOrderNotional: '300' } : {}) } })
  const { key, mandate, token } = h.k.agents.createKey({ name: `bot-${tier}`, host: 'claude-code', tier, mandate: { ...base, ...over } as never }, pin, h.human('agentkey.create').origin)
  const principal = h.k.auth.authenticateToken(token)!
  return { token, principal, keyId: key.keyId, mandate, ctx: (tool = 'order') => ({ principal, origin: h.k.auth.originFor(principal, tool, 'mcp', newRequestId()) }) }
}

/** 钱包 w1 + 解锁：让实盘账户能签名。 */
export async function enableLive(h: Harness): Promise<void> {
  const pin = await h.pinProof()
  if (!h.k.keystore.list().some((w) => w.name === 'w1')) h.k.keystore.generate(pin, { name: 'w1' })
  if (!h.k.keystore.isUnlocked()) h.k.keystore.unlock(pin)
}
