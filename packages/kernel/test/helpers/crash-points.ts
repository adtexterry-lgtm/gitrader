// SPDX-License-Identifier: CPAL-1.0
// K0 崩溃点测试台：同一个 GITRADER_HOME 上，在指定次序点「杀掉」内核（不优雅关闭、不冲刷纸面状态），再用同一个 home 重新 Kernel.create。
// 「杀」= 立刻关掉旧内核的数据库连接（之后旧实例的任何账本 / 订单写入都会失败，未提交的事务随之回滚）+ 禁止旧实例再写纸面状态文件 + 丢弃旧的纸面场所。
// 不改产品源码：只包装旧实例上的 bus.submit / docs.put / ledger.append / savePaperState。不依赖墙钟毫秒（时钟 = TestMarket.now）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../../src/kernel'
import type { KernelOptions } from '../../src/kernel'
import { fileProvider } from '../../src/device-key'
import { mkOrigin } from '../../src/util/origin'
import type { ActorCtx } from '../../src/trading'
import type { HumanProof } from '../../src/auth'
import type { OrderIntent } from '../../src/proto'
import { PaperVenue } from '../../../venue-paper/src/venue'
import { BTC, TestMarket } from '../../../venue-paper/test/helpers/test-market'
import { FakeConnector } from './fake-connector'

export { BTC }
export const CRASH_PIN = '482916'

export class CrashError extends Error {
  constructor(readonly point: CrashPoint) { super(`simulated kernel crash at ${point}`); this.name = 'CrashError' }
}

export type CrashPoint =
  | 'afterOrderSubmittedTx' // startPreparedOrder 第一个事务提交后、bus.submit 之前
  | 'afterVenueEvent' // 纸面场所第 n 次状态落盘之后
  | 'beforeRecordChildren' // bus.submit 返回后、recordChildren 之前
  | 'afterProposalApprovedSaved' // approve 内 saveProposal(approved) 之后
  | 'afterProposalDecidedLedger' // approve 内 ledger(proposal.decided) 之后

export interface CrashWorld {
  k: Kernel
  paper: PaperVenue
  source: FakeConnector
  human: ActorCtx
  dead: boolean
  sessionProof(): HumanProof
}

export interface CrashHarness {
  home: string
  market: TestMarket
  world: CrashWorld
  /** 在当前内核上装崩溃点：第 n 次（缺省 1）到达时杀掉内核。返回的 promise 在杀掉那一刻 resolve。 */
  arm(point: CrashPoint, n?: number): Promise<void>
  /** 不优雅地杀掉当前内核（已死则什么都不做）。 */
  kill(): void
  /** 杀掉（若还活着）并在同一个 home 上重新启动、跑启动对账。extra = 传给 Kernel.create 的额外参数（如 { resetPaperState: true }，对应命令行参数）。 */
  restart(extra?: Partial<KernelOptions>): Promise<CrashWorld>
  paperAccountId(): string
  cleanup(): Promise<void>
}

async function boot(home: string, market: TestMarket, configure?: (k: Kernel) => void, extra: Partial<KernelOptions> = {}): Promise<CrashWorld> {
  const clock = { now: () => market.now }
  const k = await Kernel.create({ home, clock, deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false, sleep: async () => undefined, ...extra })
  configure?.(k)
  const source = new FakeConnector({ id: 'hyperliquid', clock })
  source.quote = market.quote.bind(market)
  source.context = market.context.bind(market)
  const paper = new PaperVenue({ market, clock: () => market.now })
  k.registerConnector(source)
  k.registerConnector(paper)
  const session = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!
  const world: CrashWorld = { k, paper, source, human: { principal: session, origin: mkOrigin('user:usr_local', 'order', 'ui') }, dead: false, sessionProof: () => k.auth.sessionProof(session) }
  await k.startupReconcile(5_000)
  return world
}

function killWorld(w: CrashWorld): void {
  if (w.dead) return
  w.dead = true
  const k = w.k as unknown as Record<string, unknown> & { db: { close(): void }; paperUnsubscribe?: () => void; haltWatcher?: { close(): void } }
  k.savePaperState = () => undefined // 死进程不会再写文件
  try { k.paperUnsubscribe?.() } catch { /* ignore */ }
  try { k.haltWatcher?.close() } catch { /* ignore */ }
  try { k.db.close() } catch { /* ignore */ }
  void w.paper.close().catch(() => undefined)
}

export async function makeCrashHarness(opts: { configure?: (k: Kernel) => void } = {}): Promise<CrashHarness> {
  const home = mkdtempSync(join(tmpdir(), 'gitrader-k0-'))
  const market = new TestMarket()
  const h: CrashHarness = {
    home, market,
    world: await boot(home, market, opts.configure),
    arm(point, n = 1) {
      const w = h.world
      let count = 0
      return new Promise<void>((resolve) => {
        const die = (): never => { killWorld(w); resolve(); throw new CrashError(point) }
        const hit = (): boolean => ++count === n
        const k = w.k as unknown as { bus: { submit: (...a: unknown[]) => Promise<unknown> }; docs: { put: (...a: unknown[]) => void }; ledger: { append: (...a: unknown[]) => unknown }; savePaperState: () => void }
        if (point === 'afterOrderSubmittedTx' || point === 'beforeRecordChildren') {
          const real = k.bus.submit.bind(k.bus)
          k.bus.submit = async (...a: unknown[]) => {
            if (w.dead) throw new CrashError(point)
            if (point === 'afterOrderSubmittedTx' && hit()) die()
            const r = await real(...a)
            if (point === 'beforeRecordChildren' && hit()) die()
            return r
          }
        } else if (point === 'afterVenueEvent') {
          const real = (k.savePaperState as () => void).bind(k)
          k.savePaperState = () => { if (w.dead) return; real(); if (hit()) { killWorld(w); resolve() } }
        } else if (point === 'afterProposalApprovedSaved') {
          const real = k.docs.put.bind(k.docs)
          k.docs.put = (...a: unknown[]) => {
            real(...a)
            const [coll, , doc] = a as [string, string, { status?: string }]
            if (coll === 'proposal' && doc?.status === 'approved' && hit()) die()
          }
        } else if (point === 'afterProposalDecidedLedger') {
          const real = k.ledger.append.bind(k.ledger)
          k.ledger.append = (...a: unknown[]) => {
            const e = real(...a)
            if ((a[0] as { type?: string }).type === 'proposal.decided' && hit()) die()
            return e
          }
        }
      })
    },
    kill() { killWorld(h.world) },
    async restart(extra) {
      killWorld(h.world)
      // 让旧实例里已排队的微任务 / 挂起的 promise 跑完并在关掉的库上失败，避免与新实例交错。
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
      h.world = await boot(home, market, opts.configure, extra)
      return h.world
    },
    paperAccountId: () => h.world.k.accounts.find('paper')!.accountId,
    async cleanup() {
      if (!h.world.dead) await h.world.k.stop().catch(() => undefined)
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
      rmSync(home, { recursive: true, force: true })
    },
  }
  return h
}

/** 人工直下的市价开仓（带止损）。 */
export function stopIntent(accountId: string, extra: Partial<OrderIntent> = {}): OrderIntent {
  return {
    accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001', reason: 'k0 crash fixture',
    tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' } }, ...extra,
  } as OrderIntent
}

/** 让一个 promise 的拒绝不变成未处理拒绝；返回 settle 结果。 */
export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await p } } catch (error) { return { ok: false, error } }
}
