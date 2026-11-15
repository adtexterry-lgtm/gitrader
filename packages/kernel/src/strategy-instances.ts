// SPDX-License-Identifier: CPAL-1.0
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Docs } from './db'
import type { Origin } from './proto'
import type { Clock } from './util/clock'

const COLL = 'stratinst'
export type InstanceOwner =
  | { kind: 'agent'; keyId: string; mandateId: string }
  | { kind: 'human'; actor: string }
  | { kind: 'system'; actor: string }
export const SYSTEM_OWNER: InstanceOwner = { kind: 'system', actor: 'system:kernel' }

export interface InstanceRow {
  instanceId: string; engineId: string; strategyId: string; accountId: string; instruments: string[]
  interval?: string; params: Record<string, unknown>; sizing?: Record<string, unknown>; mandateId: string
  owner: InstanceOwner
  desired: 'running' | 'stopped'
  startedAt: number; stoppedAt?: number; stoppedBy?: InstanceOwner
  needsRestart?: { reason: string; at: number }
  restore?: { attempts: number; lastAt: number }
}
/** 调用方归属：入口（Agent / 工作台）用 runAs 包住 callEngine，登记表从这里取「谁启动 / 谁停」。 */
export interface InstanceCtx { owner: InstanceOwner; origin: Origin }
const als = new AsyncLocalStorage<InstanceCtx>()
export const runAs = <T>(ctx: InstanceCtx, fn: () => T): T => als.run(ctx, fn)
export const currentCtx = (): InstanceCtx | undefined => als.getStore()

export class StrategyInstances {
  constructor(private readonly docs: Docs, private readonly clock: Clock) {}
  get(id: string): InstanceRow | undefined { return this.docs.get<InstanceRow>(COLL, id) }
  list(f: { engineId?: string; desired?: 'running' | 'stopped' } = {}): InstanceRow[] {
    return this.docs.list<InstanceRow>(COLL, { limit: 1000 }).filter((r) => (!f.engineId || r.engineId === f.engineId) && (!f.desired || r.desired === f.desired))
  }
  /** strategy.start 成功后记；同一 instanceId 已有行（恢复 / 重复 start）→ 保留原 owner 与 startedAt。 */
  recordStart(engineId: string, params: Record<string, any>, result: { instanceId?: unknown } | undefined, ctx: InstanceCtx | undefined = currentCtx()): void {
    const id = result?.instanceId
    if (typeof id !== 'string' || !id) return
    const prev = this.get(id)
    this.docs.put<InstanceRow>(COLL, id, {
      instanceId: id, engineId, strategyId: String(params.strategyId), accountId: String(params.accountId), instruments: (Array.isArray(params.instruments) ? params.instruments : []).map(String),
      ...(typeof params.interval === 'string' ? { interval: params.interval } : {}), params: (params.params ?? {}) as Record<string, unknown>,
      ...(params.sizing ? { sizing: params.sizing as Record<string, unknown> } : {}), mandateId: String(params.mandateId ?? ''),
      owner: prev?.owner ?? ctx?.owner ?? SYSTEM_OWNER, desired: 'running', startedAt: prev?.startedAt ?? this.clock.now(),
      ...(prev?.restore ? { restore: prev.restore } : {}),
    })
  }
  recordStop(id: string, ctx: InstanceCtx | undefined = currentCtx()): void {
    const r = this.get(id); if (!r) return
    const { needsRestart: _n, ...rest } = r
    this.docs.put<InstanceRow>(COLL, id, { ...rest, desired: 'stopped', stoppedAt: this.clock.now(), stoppedBy: ctx?.owner ?? SYSTEM_OWNER })
  }
  recordUpdate(id: string, patch: unknown): void {
    const r = this.get(id); if (!r || !patch || typeof patch !== 'object') return
    this.docs.put<InstanceRow>(COLL, id, { ...r, params: { ...r.params, ...(patch as Record<string, unknown>) } })
  }
  markNeedsRestart(id: string, reason: string): void { const r = this.get(id); if (r) this.docs.put<InstanceRow>(COLL, id, { ...r, needsRestart: { reason, at: this.clock.now() } }) }
  clearNeedsRestart(id: string): void { const r = this.get(id); if (r?.needsRestart) { const { needsRestart: _n, ...rest } = r; this.docs.put<InstanceRow>(COLL, id, rest) } }
  needsRestart(engineId?: string): InstanceRow[] { return this.list({ desired: 'running', ...(engineId ? { engineId } : {}) }).filter((r) => r.needsRestart) }
  /** 10 分钟窗口内已记的恢复尝试数（只看不记）。 */
  restoreAttempts(id: string, now: number): number {
    const r = this.get(id)
    return r?.restore && now - r.restore.lastAt < 600_000 ? r.restore.attempts : 0
  }
  /** 恢复尝试计数：10 分钟窗口内累加，超过窗口重新从 1 起。 */
  noteRestore(id: string, now: number): number {
    const r = this.get(id); if (!r) return 0
    const attempts = r.restore && now - r.restore.lastAt < 600_000 ? r.restore.attempts + 1 : 1
    this.docs.put<InstanceRow>(COLL, id, { ...r, restore: { attempts, lastAt: now } })
    return attempts
  }
}

export interface RunningInst { instanceId: string; strategyId: string; accountId: string; instruments: string[]; status: string }
export function findPositionOwner(list: readonly RunningInst[], accountId: string, instruments: readonly string[], selfId?: string): (RunningInst & { shared: string }) | undefined {
  for (const i of list) {
    if (i.status !== 'running' || i.instanceId === selfId || i.accountId !== accountId) continue
    const shared = instruments.find((x) => i.instruments?.includes(x))
    if (shared) return { ...i, shared }
  }
  return undefined
}
