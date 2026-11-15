// SPDX-License-Identifier: CPAL-1.0
// 实验详情的数据钩子：认实验号（配置 > 联动组 experiment）、取 lab.get（同一时刻多块只问内核一次）、取 lab.run。
import type { BlockBridge } from '@gitrader/blocks-sdk'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { queryRetry, useOffline } from '../../../../blocks-default/src/hooks'
import { promotionRequest, readDetail, type LabDetail, type PromotionRequest } from '../../model-lab'

export type Load<T> = { phase: 'loading' } | { phase: 'ready'; value: T } | { phase: 'error'; error: Error }
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

const idOf = (v: unknown): string | null => {
  if (typeof v === 'string' && v) return v
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    const id = o.experimentId ?? o.id
    if (typeof id === 'string' && id) return id
  }
  return null
}

/** 实验号：块配置里写了就用配置；否则读联动组 experiment（壳把 #/lab/<id> 写进去；清单没声明该组时桥会抛，当作没有）。 */
export function useExperimentId(config: Record<string, unknown> | undefined): string | null {
  const bridge = useBridge()
  const fixed = idOf(config?.experimentId)
  const [linked, setLinked] = useState<string | null>(() => { try { return idOf(bridge.link.get('experiment')) } catch { return null } })
  useEffect(() => {
    try { return bridge.link.subscribe('experiment', (v) => setLinked(idOf(v))) } catch { return undefined }
  }, [bridge])
  return fixed ?? linked
}

// 一页的五七张卡各问一次 lab.get，内核每次要扫整本账；同一实验号 300 ms 内共用一次请求（只共用在途的，不缓存结果）。
const flights = new Map<string, { at: number; p: Promise<unknown>; done: boolean }>()
const SHARE_MS = 300
function getShared(bridge: BlockBridge, id: string): Promise<unknown> {
  const hit = flights.get(id)
  // 只共用在途的：已落定的不复用（命令成功后的重读必须真去问内核，哪怕距上次不到 300 ms）
  if (hit && !hit.done && Date.now() - hit.at < SHARE_MS) return hit.p
  const entry = { at: Date.now(), p: queryRetry(bridge, 'lab.get', { experimentId: id }), done: false }
  const settle = () => { entry.done = true }
  entry.p.then(settle, settle)
  flights.set(id, entry)
  return entry.p
}
/** 测试用：换夹具桥之前清掉共用的在途请求。 */
export const resetShared = (): void => flights.clear()

export interface DetailState { load: Load<LabDetail>; reload(): void; offline: boolean }
export function useDetail(id: string | null): DetailState {
  const bridge = useBridge()
  const [load, setLoad] = useState<Load<LabDetail>>({ phase: 'loading' })
  const [n, setN] = useState(0)
  const reload = useCallback(() => setN((x) => x + 1), [])
  const offline = useOffline(reload)
  useEffect(() => {
    if (!id) return undefined
    let dead = false
    setLoad((l) => (l.phase === 'ready' && l.value.experimentId === id ? l : { phase: 'loading' }))
    getShared(bridge, id).then(
      (raw) => { if (dead) return; try { setLoad({ phase: 'ready', value: readDetail(raw) }) } catch (e) { setLoad({ phase: 'error', error: asError(e) }) } },
      (e: unknown) => { if (!dead) setLoad({ phase: 'error', error: asError(e) }) },
    )
    return () => { dead = true }
  }, [bridge, id, n])
  return { load, reload, offline }
}

/** 一次回测 / 保留期的完整结果（lab.run）；runId 变了重取。 */
export function useRun(experimentId: string, runId: string | null): { load: Load<unknown>; reload(): void } {
  const bridge = useBridge()
  const [load, setLoad] = useState<Load<unknown>>({ phase: 'loading' })
  const [n, setN] = useState(0)
  const reload = useCallback(() => setN((x) => x + 1), [])
  useEffect(() => {
    if (!runId) return undefined
    let dead = false
    setLoad({ phase: 'loading' })
    queryRetry(bridge, 'lab.run', { experimentId, runId }, () => !dead).then(
      (raw) => { if (!dead) setLoad({ phase: 'ready', value: raw }) },
      (e: unknown) => { if (!dead) setLoad({ phase: 'error', error: asError(e) }) },
    )
    return () => { dead = true }
  }, [bridge, experimentId, runId, n])
  return { load, reload }
}

/** 本实验最新的 Agent 晋级申请（K-r5-2 落地前从 ledger.query 取 annotation 后块内筛）：取不到（没权限 / 方法不在 / 回包不对）就是 null，界面不出这一行。 */
export function useRequest(detail: LabDetail | null): PromotionRequest | null {
  const bridge = useBridge()
  const [req, setReq] = useState<PromotionRequest | null>(null)
  const id = detail?.experimentId
  const stage = detail?.stage
  useEffect(() => {
    if (!id || !stage) return undefined
    let dead = false
    queryRetry(bridge, 'ledger.query', { types: ['annotation'], order: 'desc', limit: 200 }, () => !dead).then(
      (raw) => { if (!dead) setReq(promotionRequest(raw, { experimentId: id, stage })) },
      () => { if (!dead) setReq(null) },
    )
    return () => { dead = true }
  }, [bridge, id, stage])
  return req
}
