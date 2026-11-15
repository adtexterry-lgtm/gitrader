// SPDX-License-Identifier: Apache-2.0
// GepClient / GepServer：类型级接口，不含传输实现（契约 §2.1：WS 主传输、stdio 备选，由各实现自备）。
import type { EngineMethods, EngineMethodName, EngineToHostNotifications, HostMethods, HostMethodName, HostToEngineNotifications } from './methods'

type ParamsOf<M, K extends keyof M> = M[K] extends { params: infer P } ? P : never
type ResultOf<M, K extends keyof M> = M[K] extends { result: infer R } ? R : never

export interface CallOptions { timeoutMs?: number }

/** 发起方：调用对端的方法、向对端发通知。 */
export interface GepClient<Methods extends object, OutNotifications extends object> {
  call<K extends keyof Methods & string>(method: K, params: ParamsOf<Methods, K>, options?: CallOptions): Promise<ResultOf<Methods, K>>
  notify<K extends keyof OutNotifications & string>(method: K, params: OutNotifications[K]): void
  close(): Promise<void>
}

/** 宿主调用引擎。 */
export type GepEngineClient = GepClient<EngineMethods, HostToEngineNotifications>
/** 引擎调用宿主（统一前缀 host.*）。 */
export type GepHostClient = GepClient<HostMethods, EngineToHostNotifications>

export interface RequestContext {
  /** 当前会话 id（hello 之后）。 */
  sessionId?: string
  /** JSON-RPC id。 */
  requestId: string | number
}

export type Handler<Methods extends object, K extends keyof Methods> = (params: ParamsOf<Methods, K>, ctx: RequestContext) => Promise<ResultOf<Methods, K>> | ResultOf<Methods, K>

/** 所有引擎必须实现的方法。 */
export type RequiredEngineMethods =
  | 'gep.hello' | 'engine.describe' | 'engine.bind' | 'engine.health' | 'engine.snapshot' | 'engine.halt' | 'engine.resume'
  | 'engine.shutdown' | 'events.subscribe' | 'events.unsubscribe' | 'risk.policy.push'

export type OptionalEngineMethods = Exclude<EngineMethodName, RequiredEngineMethods>

/** 引擎侧服务：必选方法必须提供；可选方法按 describe 里声明的能力位提供（未提供的返回 5002 / -32601）。 */
export type GepEngineHandlers =
  { [K in RequiredEngineMethods]: Handler<EngineMethods, K> } &
  { [K in OptionalEngineMethods]?: Handler<EngineMethods, K> }

/** 宿主侧服务：宿主实现 host.* 方法。必选 / 可选见 GEP_METHODS。 */
export type GepHostHandlers = { [K in HostMethodName]?: Handler<HostMethods, K> }

/** 接收方：注册方法实现与通知回调。 */
export interface GepServer<Handlers, InNotifications extends object> {
  handlers: Handlers
  onNotification<K extends keyof InNotifications & string>(method: K, listener: (params: InNotifications[K]) => void): void
}

export type GepEngineServer = GepServer<GepEngineHandlers, HostToEngineNotifications>
export type GepHostServer = GepServer<GepHostHandlers, EngineToHostNotifications>
