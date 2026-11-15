// SPDX-License-Identifier: Apache-2.0
// Preact 绑定（子路径 @gitrader/blocks-sdk/preact）。块组件里用这些钩子，不直接碰客户端。
// preact 是对等依赖，不进 SDK 主入口。
import { createContext } from 'preact'
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks'
import type { EventEnvelope } from './client'
import type { BlockBridge, SubscribeOptions } from './bridge'
import type { LinkGroup } from './manifest'

export const BridgeContext = createContext<BlockBridge | null>(null)

export function useBridge(): BlockBridge {
  const b = useContext(BridgeContext)
  if (!b) throw new Error('useBridge 必须在块内使用（宿主会提供 BridgeContext）')
  return b
}

/** 订阅一个主题，每个事件调 handler。handler 用最新引用，不触发重订。 */
export function useSubscribe(topic: string, handler: (e: EventEnvelope) => void, opts?: SubscribeOptions): void {
  const bridge = useBridge()
  const h = useRef(handler)
  h.current = handler
  const key = JSON.stringify(opts ?? null)
  useEffect(() => {
    try { return bridge.subscribe(topic, (e) => h.current(e), opts) } catch (err) { console.error('[gitrader]', (err as Error).message); return undefined }
  }, [bridge, topic, key])
}

/** 最近一条事件的数据；没收到过为 undefined。 */
export function useTopic<T = unknown>(topic: string, opts?: SubscribeOptions): T | undefined {
  const [v, setV] = useState<T | undefined>(undefined)
  useSubscribe(topic, (e) => setV(e.data as T), opts)
  return v
}

export interface QueryState<T> { data: T | undefined; error: Error | null; loading: boolean; reload(): void }

/** 只读查询；deps 变了重查。失败保留上一次数据，error 给上游原文。 */
export function useQuery<T = unknown>(method: string, params?: unknown, deps: unknown[] = []): QueryState<T> {
  const bridge = useBridge()
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [n, setN] = useState(0)
  const key = JSON.stringify(params ?? null)
  useEffect(() => {
    let stop = false
    setState((s) => ({ ...s, loading: true }))
    bridge.query<T>(method, params).then(
      (data) => { if (!stop) setState({ data, error: null, loading: false }) },
      (error: Error) => { if (!stop) setState((s) => ({ data: s.data, error, loading: false })) },
    )
    return () => { stop = true }
  }, [bridge, method, key, n, ...deps])
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) }
}

/** 联动组：[当前值, 设置]。块没有声明该组时设置会抛 BridgeError。 */
export function useLink<T = unknown>(group: LinkGroup): [T | undefined, (v: T) => void] {
  const bridge = useBridge()
  const [v, setV] = useState<T | undefined>(() => bridge.link.get(group) as T | undefined)
  useEffect(() => {
    setV(bridge.link.get(group) as T | undefined)
    return bridge.link.subscribe(group, (x) => setV(x as T))
  }, [bridge, group])
  return [v, useCallback((x: T) => bridge.link.set(group, x), [bridge, group])]
}

export interface CommandState { run<T = unknown>(action: string, params?: unknown): Promise<T>; busy: boolean; error: Error | null }

/** 发命令（须在点击处理函数里调用）。busy / error 供按钮显示。 */
export function useCommand(): CommandState {
  const bridge = useBridge()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const run = useCallback(async <T,>(action: string, params?: unknown): Promise<T> => {
    setBusy(true)
    setError(null)
    try { return await bridge.command<T>(action, params) } catch (e) { setError(e as Error); throw e } finally { setBusy(false) }
  }, [bridge])
  return { run, busy, error }
}
