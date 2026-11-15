// SPDX-License-Identifier: CPAL-1.0
// 本地 API 的鉴权中间件与路由注册钩子（B 建；E 在 api/index.ts 里注册 Agent 面路由，不用改这个文件）。
//
// 两种注册方式，都走同一套鉴权：
//   ops    传输无关的"操作"（query / command）。同一个操作既可以经 HTTP `POST /api/op/<name>` 调，也可以经工作台 WebSocket 桥调。
//   routes 原始 HTTP 路由（Agent 面 / MCP 服务器用，路径与响应形状自定）。
// 鉴权规则：没有令牌就是没有身份；Origin / Sec-Fetch-Site 只用来额外拒绝，永远不用来放行。
import { PROBLEM_CODES, makeProblem } from '../proto'
import type { Origin, OriginVia } from '../proto'
import type { HumanProof, Principal } from '../auth'
import type { Kernel } from '../kernel'
import type { ActorCtx } from '../trading'
import { KernelError, findSecretKeys, toProblem } from '../util/errors'
import { newRequestId } from '../util/ids'

/** human = 会话或 service 主体（人面 / 本机工具）；session = 仅工作台会话；service = 仅 service 令牌；agent = 仅 Agent 钥匙；any = 任何已认证主体。 */
export type OpAuth = 'human' | 'session' | 'service' | 'agent' | 'any'
export interface OpSpec {
  auth: OpAuth
  /** 需要的在场证明：session = 会话主体；pin = PIN（请求头 x-gitrader-pin / WS 信封 pin 字段，永不进日志）。 */
  presence?: 'session' | 'pin' | 'session-or-pin'
  /** 默认拒收名为 privateKey / secret / pin … 的字段（5006）。只有导入钱包这类人面入口放行。 */
  allowSecretFields?: boolean | string[]
  kind?: 'query' | 'command'
}
export interface OpContext {
  kernel: Kernel
  principal: Principal
  /** 由服务端按已认证身份盖章（行为人不能自报）。 */
  origin: Origin
  proof?: HumanProof
  /** 请求里带的 PIN（x-gitrader-pin / WS 信封 pin）。处理函数需要按需升级在场证明时用 kernel.auth.pinProof(principal, ctx.pin)；永不记录。 */
  pin?: string
  /** 交易服务要的上下文。 */
  actor: ActorCtx
  transport: 'http' | 'ws'
}
export type OpParams = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export type OpHandler = (ctx: OpContext, params: OpParams) => unknown | Promise<unknown>

const authOk = (auth: OpAuth, p: Principal): boolean =>
  auth === 'any' || (auth === 'human' && (p.kind === 'session' || p.kind === 'service')) || auth === p.kind

export function viaOf(p: Principal): OriginVia {
  return p.kind === 'session' ? 'ui' : p.kind === 'agent' ? 'mcp' : p.kind === 'engine' ? 'gep' : 'cli'
}

export class OpRegistry {
  private ops = new Map<string, { spec: OpSpec; handler: OpHandler }>()

  register(name: string, spec: OpSpec, handler: OpHandler): void {
    if (this.ops.has(name)) throw new Error(`op already registered: ${name}`)
    this.ops.set(name, { spec, handler })
  }
  has(name: string): boolean { return this.ops.has(name) }
  spec(name: string): OpSpec | undefined { return this.ops.get(name)?.spec }
  list(): { name: string; spec: OpSpec }[] { return [...this.ops].map(([name, v]) => ({ name, spec: v.spec })) }

  /** 鉴权 + 秘密字段拒收 + 在场证明 + 盖章 origin → OpContext。ops 与原始路由共用。 */
  async prepare(kernel: Kernel, name: string, spec: OpSpec, a: { principal: Principal | null; params?: unknown; pin?: string; transport: 'http' | 'ws'; requestId?: string; tool?: string }): Promise<OpContext> {
    if (!a.principal) throw new KernelError(makeProblem('AUTH_FAILED', 'authentication required'))
    if (!authOk(spec.auth, a.principal)) throw new KernelError(makeProblem('AUTH_FAILED', `${name} is not available to ${a.principal.kind} principals`))
    kernel.consumeOperationRate(a.principal, name, a.params)
    if (spec.allowSecretFields !== true) {
      const allow = Array.isArray(spec.allowSecretFields) ? spec.allowSecretFields.map((k) => `$.${k}`) : []
      const hits = findSecretKeys(a.params).filter((h) => !allow.includes(h))
      if (hits.length) {
        const seedHint = hits.some((h) => h.endsWith('.seed')) ? ' (BacktestSpec.seed must be an integer inside "spec"; any other key named seed is treated as a secret)' : ''
        throw new KernelError(makeProblem('SECRET_FIELD_REJECTED', `secret-like fields are not accepted here: ${hits.join(', ')}${seedHint}`))
      }
    }
    const via = viaOf(a.principal)
    let proof: HumanProof | undefined
    if (spec.presence === 'session') proof = kernel.auth.sessionProof(a.principal, via)
    else if (spec.presence === 'session-or-pin') proof = a.pin ? await kernel.auth.pinProof(a.principal, a.pin, via) : kernel.auth.sessionProof(a.principal, via)
    else if (spec.presence === 'pin') proof = await kernel.auth.pinProof(a.principal, a.pin, via)
    const origin = kernel.auth.originFor(a.principal, a.tool ?? (name.startsWith('route:') ? name : `op:${name}`), via, a.requestId ?? newRequestId())
    return { kernel, principal: a.principal, origin, ...(proof ? { proof } : {}), ...(a.pin ? { pin: a.pin } : {}), actor: { principal: a.principal, origin, ...(proof ? { proof } : {}) }, transport: a.transport }
  }

  async call(kernel: Kernel, name: string, a: { principal: Principal | null; params?: OpParams; pin?: string; transport: 'http' | 'ws'; requestId?: string; kind?: 'query' | 'command'; tool?: string }): Promise<unknown> {
    const op = this.ops.get(name)
    if (!op) {
      if (a.principal) kernel.consumeOperationRate(a.principal, name, a.params)
      throw new KernelError(makeProblem('METHOD_NOT_FOUND', `unknown operation ${name}`))
    }
    const ctx = await this.prepare(kernel, name, op.spec, a)
    if (a.kind && (op.spec.kind ?? 'command') !== a.kind) throw new KernelError(makeProblem('INVALID_REQUEST', `${name} is a ${op.spec.kind ?? 'command'}, not a ${a.kind}`))
    return op.handler(ctx, a.params ?? {})
  }
}

// ---- 原始 HTTP 路由（Agent 面）----------------------------------------------------
export interface RawRequest {
  method: string
  path: string
  /** 路径参数（`/api/x/:id`）。 */
  params: Record<string, string>
  query: Record<string, string>
  body: unknown
  headers: Record<string, string | string[] | undefined>
}
export interface RawResponse { status?: number; body: unknown; headers?: Record<string, string> }
export type RawHandler = (req: RawRequest, ctx: OpContext) => RawResponse | Promise<RawResponse>

interface RawRoute { method: string; segs: string[]; spec: OpSpec; handler: RawHandler }

export class RouteRegistry {
  private routes: RawRoute[] = []
  register(method: string, pattern: string, spec: OpSpec, handler: RawHandler): void {
    this.routes.push({ method: method.toUpperCase(), segs: pattern.split('/').filter(Boolean), spec, handler })
  }
  match(method: string, path: string): { route: RawRoute; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean)
    for (const r of this.routes) {
      if (r.method !== method.toUpperCase()) continue
      const params: Record<string, string> = {}
      let ok = true
      let wild = false
      for (let i = 0; i < r.segs.length; i++) {
        const s = r.segs[i] as string
        if (s.startsWith('*')) { params[s.slice(1) || 'rest'] = parts.slice(i).map(decodeURIComponent).join('/'); wild = true; break }
        if (i >= parts.length) { ok = false; break }
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i] as string)
        else if (s !== parts[i]) { ok = false; break }
      }
      if (ok && (wild || parts.length === r.segs.length)) return { route: r, params }
    }
    return null
  }
}

/** HTTP 状态码映射（Problem → status）。 */
export function statusOf(code: number): number {
  if (code === PROBLEM_CODES.RATE_BUDGET.code) return 429
  if (code === 5010) return 409
  if (code === 5003 || code === 1010) return 401
  if (code === -32601) return 404
  if (code === -32602 || code === -32600 || code === -32700 || (code >= 1000 && code < 2000) || code === 5006 || code === 5007) return 400
  if (code >= 2000 && code < 3000) return 403
  if (code >= 3000 && code < 4000) return 502
  return 500
}
export const errorBody = (e: unknown): { ok: false; error: ReturnType<typeof toProblem> } => ({ ok: false, error: toProblem(e) })
