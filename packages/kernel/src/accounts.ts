// SPDX-License-Identifier: CPAL-1.0
// 账户注册表：由 gitrader.json 的 accounts 生成统一模型 Account（契约 §1.4.3）。多账户第一天就有：任何读写都带 accountId，没有隐式"当前账户"。
import { makeProblem } from './proto'
import type { Account } from './proto'
import type { GitraderConfig } from './config'
import { KernelError } from './util/errors'
import * as d from './util/dec'

export class AccountRegistry {
  private byId = new Map<string, Account>()

  constructor(cfg: GitraderConfig) { this.load(cfg) }

  load(cfg: GitraderConfig): void {
    this.byId.clear()
    for (const a of cfg.accounts) {
      if (!a.accountId) throw new KernelError(makeProblem('INVALID_PARAMS', `account ${a.alias} has no accountId (run gitrader init)`))
      const venueCfg = cfg.venues.find((v) => v.id === a.venue)
      const acct: Account = {
        accountId: a.accountId as Account['accountId'], alias: a.alias, orgId: 'org_local', groupIds: [],
        // 'watch' 是内核本地的模式（协议 AccountMode 里没有）：此处的断言是唯一的类型出口，所有下单路径都靠 isWatchAccount 拒绝
        venue: a.venue, environment: a.environment, mode: a.mode as Account['mode'],
        owner: (a.mode as string) === 'watch' ? { address: a.watch?.address ?? '' } : { ...(a.owner?.address ? { address: a.owner.address } : {}), ...(a.owner?.accountRef ? { accountRef: a.owner.accountRef } : {}) },
        accountModel: 'standard',
        signer: a.mode === 'live'
          ? a.venue === 'ibkr'
            ? { type: 'gateway-session', credentialRef: 'gateway-session', permissions: { trade: true, withdraw: false } }
            : a.credentials !== undefined
              ? { type: 'api-key', credentialRef: 'config', permissions: { trade: true, withdraw: false } }
              : { type: 'api-wallet', credentialRef: a.signerRef ?? '', permissions: { trade: true, withdraw: false } } // HL API 钱包天然无提现权限
          : { type: 'none', credentialRef: '', permissions: { trade: false, withdraw: false } },
        ...(a.paper ? { paper: { initialBalance: d.str(d.D(a.paper.initialBalance)), ccy: a.paper.ccy } } : {}),
        // 场所在配置里被关掉 → 只读。观察账户的状态保持 active：接管 / 对账会遍历所有账户，非 active 会让全局全撤报错；
        // 它的"只读"由三层保证：总线没有下单路由（routeFor 抛错）、交易侧永远是空账户、Agent 的下单 / 提案 / 起策略入口直接拒绝
        status: venueCfg && !venueCfg.enabled ? 'read_only' : 'active',
      }
      this.byId.set(acct.accountId, acct)
    }
  }

  list(): Account[] { return [...this.byId.values()] }
  find(id: string): Account | undefined { return this.byId.get(id) ?? this.list().find((a) => a.alias === id) }
  get(id: string): Account {
    const a = this.find(id)
    if (!a) throw new KernelError(makeProblem('ACCOUNT_NOT_BOUND', `no such account: ${id}`))
    return a
  }
}
