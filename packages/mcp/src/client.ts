// SPDX-License-Identifier: CPAL-1.0
// 内核客户端：MCP 服务器经本机 HTTP 调内核的 `POST /api/op/<名>`，带 Agent 钥匙令牌（Bearer gtk_…）。
// 令牌只来自环境变量，不进日志、不进错误信息；错误原样透传内核的 Problem（含 ruleHits、上游 venue.message 原文）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Problem } from '@gitrader/protocol'
import { kernelFetch } from './local-fetch'

export interface KernelClientOptions {
  /** 固定地址，或每次调用时解析（内核可能晚于宿主启动；端口从 service.json 读）。 */
  baseUrl: string | (() => string)
  /** 令牌；用函数形式时每次调用现取（令牌文件可以晚于宿主创建、可以轮换）。 */
  token: string | (() => string)
  timeoutMs?: number
  fetch?: typeof fetch
}

/**
 * 失败回复的三种本地语义（ADR-20）：
 *   notSent        请求没发出（连不上 / 地址或 service.json 解析失败）：可原样重试。
 *   outcomeUnknown 请求已发出（或不能证明没发出），连接中途断开 / 响应读到一半 / 超时：结果未知，不可当失败重试。
 *   timedOut       outcomeUnknown 的一种：内核在时限内没有回应（超时同时置 outcomeUnknown）。
 */
export type KernelReply = { ok: true; result: unknown } | { ok: false; error: Problem; status: number; timedOut?: true; outcomeUnknown?: true; notSent?: true }

/** 上游原文：error.message 加 cause.message（undici 的 "fetch failed" 把真原因藏在 cause 里）。 */
function whyOf(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  const c = (cause as { cause?: unknown }).cause
  const inner = c instanceof Error ? c.message : ''
  return inner && inner !== cause.message ? `${cause.message} (${inner})` : cause.message
}

/** 连不上内核时本地合成的 Problem（沿用码表里的 INTERNAL，不自造错误码）。 */
export function unreachable(baseUrl: string, cause: unknown): Problem {
  return { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: true, message: `cannot reach the Gitrader kernel at ${baseUrl}: ${whyOf(cause)}. Is "gitrader serve" running?` }
}

/** 这些系统错误码 = 连接根本没建立，请求不可能被处理。 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EADDRNOTAVAIL', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_INVALID_URL'])

/** 能证明请求没发出才返回 true；其余一律按"可能已发出"处理（宁可多报未知）。 */
function provablyNotSent(e: unknown): boolean {
  const c = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | null)?.cause
  const codes = [c?.code, (e as { code?: unknown } | null)?.code, ...(c?.errors ?? []).map((x) => x?.code)].filter((x): x is string => typeof x === 'string')
  if (codes.length && codes.every((x) => NOT_SENT_CODES.has(x))) return true
  if (!(e instanceof Error)) return false
  if (/Failed to parse URL|Invalid URL/i.test(e.message)) return true
  // ponytail: undici 的网络错误必带 cause；完全没有 cause 的 "fetch failed" 只可能在碰网络之前失败（测试桩也这么抛）。
  return e instanceof TypeError && e.message === 'fetch failed' && !('cause' in e)
}

const timeoutReply = (sec: number, status: number): KernelReply => ({ ok: false, status, timedOut: true, outcomeUnknown: true, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: true, message: `the kernel did not answer within ${sec}s (it may be busy); the request may still have been processed` } })

/** 已发出后断开 / 读到一半断开：结果未知（3006，不可重试），上游原文放进 message 与 venue.message。 */
function lostReply(baseUrl: string, e: unknown, status: number, where: 'sending the request' | 'reading the reply'): KernelReply {
  const why = whyOf(e)
  return { ok: false, status, outcomeUnknown: true, error: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', category: 'VENUE', retryable: false, message: `the connection to the Gitrader kernel at ${baseUrl} was lost while ${where}: ${why}. The request may already have been processed.`, venue: { id: 'gitrader-kernel', message: why } } }
}

const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

export const DEFAULT_TIMEOUT_MS = 30_000

export class KernelClient {
  private readonly doFetch: typeof fetch
  constructor(private readonly o: KernelClientOptions) { this.doFetch = o.fetch ?? kernelFetch } // R1-PERF-06：默认走 keep-alive + 关 Nagle 的本机连接

  async call(op: string, params: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<KernelReply> {
    let res: Response
    let baseUrl = ''
    let token: string
    try { token = typeof this.o.token === 'function' ? this.o.token() : this.o.token } catch (e) {
      return { ok: false, status: 0, error: { code: 5003, name: 'AUTH_FAILED', category: 'PROTOCOL', retryable: false, message: e instanceof Error ? e.message : String(e) } }
    }
    try { baseUrl = typeof this.o.baseUrl === 'function' ? this.o.baseUrl() : this.o.baseUrl } catch (e) {
      return { ok: false, status: 0, notSent: true, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: true, message: `${e instanceof Error ? e.message : String(e)}. Is "gitrader serve" running?` } }
    }
    const sec = Math.round((opts.timeoutMs ?? this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)
    try {
      res = await this.doFetch(`${baseUrl}/api/op/${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (e) {
      if (isTimeout(e)) return timeoutReply(sec, 0)
      if (provablyNotSent(e)) return { ok: false, status: 0, notSent: true, error: unreachable(baseUrl, e) }
      return lostReply(baseUrl, e, 0, 'sending the request')
    }
    let text: string
    try { text = await res.text() } catch (e) {
      // 响应头到了、响应体读到一半断开：内核多半已处理，结果未知
      return isTimeout(e) ? timeoutReply(sec, res.status) : lostReply(baseUrl, e, res.status, 'reading the reply')
    }
    let body: { ok?: boolean; result?: unknown; error?: Problem } | undefined
    try { body = JSON.parse(text) as typeof body } catch { body = undefined }
    if (body?.ok === true) return { ok: true, result: body.result }
    if (body?.error && typeof body.error === 'object') return { ok: false, status: res.status, error: body.error }
    return { ok: false, status: res.status, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: false, message: `unexpected reply from the kernel (HTTP ${res.status})` } }
  }
}

export interface ResolvedConfig { baseUrl: () => string; token: () => string }

const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const TOKEN_RE = /^gtk_[A-Z2-7]{52}$/
/** K1：启动器名（便携包设 GITRADER_LAUNCHER；路径含空格加引号）。 */
const launcher = (env: Record<string, string | undefined>): string => { const l = (env.GITRADER_LAUNCHER ?? '').trim(); return !l ? 'gitrader' : /\s/.test(l) ? `"${l}"` : l }

/**
 * 解析连接配置（地址和令牌都在调用时现取：内核可以晚于宿主启动，钥匙可以在宿主启动之后才创建 / 轮换）：
 *   GITRADER_AGENT_TOKEN       令牌（`gitrader keys new agent` 只显示一次）。
 *   GITRADER_AGENT_TOKEN_FILE  令牌文件（只放令牌一行）；没有环境变量时用它。UNIGIT 这类不方便传环境变量的宿主走这条。
 *   GITRADER_API_URL           可选；没有就读 <GITRADER_HOME 或 ~/.gitrader>/service.json 的端口（只读端口，不读里面的令牌）。
 * 令牌永远不进日志、不进错误信息。
 */
export function resolveConfig(env: Record<string, string | undefined>): ResolvedConfig {
  const fixed = (env.GITRADER_API_URL ?? '').trim().replace(/\/+$/, '')
  if (fixed && !LOCAL_URL.test(fixed)) throw new Error('GITRADER_API_URL must point at the local kernel (http://127.0.0.1:<port>)')
  const baseUrl = (): string => {
    if (fixed) return fixed
    const home = env.GITRADER_HOME?.trim() || join(homedir(), '.gitrader')
    const f = join(home, 'service.json')
    let port: number | undefined
    if (existsSync(f)) {
      try { const j = JSON.parse(readFileSync(f, 'utf8')) as { port?: unknown }; if (Number.isInteger(j.port)) port = j.port as number } catch { /* 读不到就走下面的报错 */ }
    }
    if (!port) throw new Error(`no running Gitrader service found at ${f}`)
    return `http://127.0.0.1:${port}`
  }
  const token = (): string => {
    let t = (env.GITRADER_AGENT_TOKEN ?? '').trim()
    const file = (env.GITRADER_AGENT_TOKEN_FILE ?? '').trim()
    const cmd = launcher(env)
    const mk = `${cmd} keys new agent <名字> --host claude-code --preset starter --token-file`
    if (!t && file) {
      try { t = readFileSync(file, 'utf8').trim() } catch { throw new Error(`还没有 Agent 钥匙（no agent key yet）：令牌文件不存在。先运行 ${mk} 创建钥匙，令牌会存进文件。 / The token file does not exist: create a key with \`${mk}\`.`) }
    }
    if (!t) {
      // 与 `gitrader agent …` 一致：<home>/agent-tokens/ 里恰好一个 .token 文件就用它
      const dir = join(env.GITRADER_HOME?.trim() || join(homedir(), '.gitrader'), 'agent-tokens')
      let names: string[] = []
      try { names = readdirSync(dir).filter((n) => n.endsWith('.token')) } catch { /* 没有目录 = 还没有钥匙 */ }
      if (names.length === 1) { try { t = readFileSync(join(dir, names[0] as string), 'utf8').trim() } catch { /* 读不了按没有处理 */ } }
      else if (names.length > 1) throw new Error(`找到 ${names.length} 个令牌文件（multiple token files in ${dir}）：请把 GITRADER_AGENT_TOKEN_FILE 设成要用的那个文件。`)
    }
    if (!t) throw new Error(`没有配置 Agent 钥匙（no agent key configured）：先运行 ${mk} 创建钥匙；或把 GITRADER_AGENT_TOKEN / GITRADER_AGENT_TOKEN_FILE 设成令牌或令牌文件。`)
    if (!TOKEN_RE.test(t)) throw new Error('令牌格式不对（the agent token is malformed）：应为 gtk_ 加 52 个 base32 字符。')
    return t
  }
  return { baseUrl, token }
}
