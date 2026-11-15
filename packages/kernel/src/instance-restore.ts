// SPDX-License-Identifier: CPAL-1.0
// GQ-22：引擎握手后策略实例恢复（只对纸面账户生效；实盘 / 影子 / 状态不明一律只标记 needsRestart，绝不下单、撤单、重挂止损）
// R2-REL-01：标的没到齐就先等——握手（约 0.5 s）早于场所标的目录就绪（约 3.5 s），可重试的失败按退避重试，不计入崩溃保护次数。
import type { StrategyInstances } from './strategy-instances'
import { KernelError } from './util/errors'

interface ConnLike {
  rpc: { call(method: string, params: unknown, timeout?: number): Promise<unknown> }
}

interface RestoreView {
  instances: StrategyInstances
  now(): number
  bindingOf(engineId: string): { accounts: { accountId: string }[] } | undefined
  callEngine(engineId: string, method: string, params: unknown): Promise<unknown>
  /** 查不到（账户已被删）返回 undefined，不抛。 */
  getAccount(accountId: string): { mode: 'paper' | 'live' | 'shadow' } | undefined
  getTradingState(accountId: string): { state: string }
  /** 标的现在认得吗：该场所主标的已就绪，或 instrument() 查得到。 */
  instrumentKnown(instrumentId: string): boolean
  recordRestore(engineId: string, e: { instanceId: string; strategyId: string; accountId: string }): void
}

export interface RestoreOptions {
  /** 可重试失败的退避：minMs 起翻倍，封顶 maxMs（默认 2 s → 30 s）。 */
  backoffMinMs?: number
  backoffMaxMs?: number
  /** 从握手算起最多等这么久（默认 10 分钟），过了就 needsRestart（restore timed out）。 */
  deadlineMs?: number
  /** 引擎断开 / 重新握手时中止还在等的重试。 */
  signal?: AbortSignal
}

/** 10 分钟窗口内最多试 3 次（第 4 次起只标记，防引擎崩溃循环）。 */
const MAX_RESTORE_ATTEMPTS = 3
/** 这几类失败是「还没准备好」，不是「恢复不了」：按退避重试。 */
const RETRYABLE = new Set(['INSTRUMENT_UNKNOWN', 'VENUE_UNAVAILABLE', 'BUSY'])
const isRetryable = (e: unknown): boolean => e instanceof KernelError && RETRYABLE.has(e.problem.name)

interface Waiting { instanceId: string; why: string }

export async function restoreInstances(host: RestoreView, conn: ConnLike, engineId: string, opts: RestoreOptions = {}): Promise<void> {
  const min = opts.backoffMinMs ?? 2000
  const max = opts.backoffMaxMs ?? 30_000
  const deadlineMs = opts.deadlineMs ?? 600_000
  const startedAt = host.now()
  let only: Set<string> | undefined
  let delay = min
  for (;;) {
    const waiting = await restorePass(host, conn, engineId, only)
    if (waiting.length === 0) return
    if (host.now() - startedAt >= deadlineMs) {
      for (const w of waiting) host.instances.markNeedsRestart(w.instanceId, `restore timed out: ${w.why}`)
      return
    }
    if (!(await sleep(delay, opts.signal))) return
    delay = Math.min(delay * 2, max)
    only = new Set(waiting.map((w) => w.instanceId))
  }
}

/** 等 ms；被中止返回 false（定时器不拦进程退出）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const done = (ok: boolean): void => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); resolve(ok) }
    const onAbort = (): void => done(false)
    const t = setTimeout(() => done(true), ms)
    t.unref?.()
    signal?.addEventListener('abort', onAbort)
  })
}

/** 一轮：对每个还没在跑的实例做条件检查并尝试 start。返回「标的还没到 / 可重试失败」要等下一轮的那些。 */
async function restorePass(host: RestoreView, conn: ConnLike, engineId: string, only?: Set<string>): Promise<Waiting[]> {
  const rows = host.instances.list({ engineId, desired: 'running' }).filter((r) => !only || only.has(r.instanceId))
  if (rows.length === 0) return []

  // 读失败 / 回得不成样子 = 引擎现场状态不明：只标记，一个 start 都不发
  let list: Array<{ instanceId: string; status: string }> | undefined
  try {
    const st = await conn.rpc.call('strategy.status', {}, 5000) as { instances?: unknown } | null
    if (Array.isArray(st?.instances)) list = st.instances as Array<{ instanceId: string; status: string }>
  } catch { /* 下面统一处理 */ }
  if (!list) {
    for (const row of rows) host.instances.markNeedsRestart(row.instanceId, 'engine did not answer strategy.status')
    return []
  }

  const alive = new Set(list.filter((i) => i.status === 'running').map((i) => i.instanceId))
  const binding = host.bindingOf(engineId)
  const waiting: Waiting[] = []

  for (const row of rows) {
    if (alive.has(row.instanceId)) continue

    // 自动恢复条件检查：每一行独立，一行不满足只标记这一行，后面的行照常处理
    const account = host.getAccount(row.accountId)
    if (!account) {
      host.instances.markNeedsRestart(row.instanceId, `account ${row.accountId} not found`)
      continue
    }
    if (account.mode === 'live') {
      // 实盘一律不自动恢复：不排重试，也不会发 strategy.start
      host.instances.markNeedsRestart(row.instanceId, '实盘账户的策略不自动恢复，需要人批准后重新启动（live account: manual restart only）')
      continue
    }
    if (account.mode !== 'paper') {
      host.instances.markNeedsRestart(row.instanceId, `${account.mode} 账户的策略不自动恢复，需要人重新启动`)
      continue
    }
    if (!binding || !binding.accounts.some((a) => a.accountId === row.accountId)) {
      host.instances.markNeedsRestart(row.instanceId, `account ${row.accountId} is not bound to this engine`)
      continue
    }
    const effective = host.getTradingState(row.accountId)
    if (effective.state !== 'ACTIVE') {
      // 交易状态不是 ACTIVE：标记一次，不排重试、不起策略（恢复交易是人的事）
      host.instances.markNeedsRestart(row.instanceId, `交易状态是 ${effective.state}，恢复交易后再启动`)
      continue
    }
    const unknown = row.instruments.filter((i) => !host.instrumentKnown(i))
    if (unknown.length > 0) { waiting.push({ instanceId: row.instanceId, why: `instrument not known yet: ${unknown.join(', ')}` }); continue }
    if (host.instances.restoreAttempts(row.instanceId, host.now()) >= MAX_RESTORE_ATTEMPTS) {
      host.instances.markNeedsRestart(row.instanceId, 'restore failed 3 times in the last 10 minutes')
      continue
    }

    // 尝试恢复
    try {
      await host.callEngine(engineId, 'strategy.start', {
        instanceId: row.instanceId,
        strategyId: row.strategyId,
        accountId: row.accountId,
        instruments: row.instruments,
        ...(row.interval ? { interval: row.interval } : {}),
        params: row.params,
        ...(row.sizing ? { sizing: row.sizing } : {}),
        mandateId: row.mandateId,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isRetryable(e)) { waiting.push({ instanceId: row.instanceId, why: msg }); continue } // 不计入崩溃保护次数
      host.instances.noteRestore(row.instanceId, host.now())
      host.instances.markNeedsRestart(row.instanceId, `restore failed: ${msg}`)
      continue
    }
    host.instances.noteRestore(row.instanceId, host.now())
    host.instances.clearNeedsRestart(row.instanceId)
    // 写账本：本单唯一新增的账本写入点，发生在握手之后；写不进去不影响恢复
    try { host.recordRestore(engineId, { instanceId: row.instanceId, strategyId: row.strategyId, accountId: row.accountId }) } catch { /* ignore */ }
  }
  return waiting
}
