// SPDX-License-Identifier: CPAL-1.0
// `gitrader agent <工具> [<动作>]`：MCP 还没加载时，Agent 用命令行调用同一套内核工具。
// 令牌、地址、op 名（agent.<工具>）与 gitrader-mcp 完全一致，不新增任何权限；风控闸门、档位、审批都在内核。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MCP_TOOLS, getMcpTool, humanizeProblem, mcpUsageLine, resolveMcpTool, suggestMcpNames } from '@gitrader/protocol'
import type { Problem } from '@gitrader/protocol'
import { KernelClient, resolveConfig } from '../../mcp/src/client'
import type { Args, CliIo } from './index'

/** 与 index.ts 的 flag 同规则：只取字符串形式的旗标值。 */
const flag = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined)

/** 测试注入点：假 fetch；结果未知后用 order.lookup 回查的次数与间隔。 */
export interface AgentCallDeps {
  fetch?: typeof fetch
  recoverAttempts?: number
  recoverEveryMs?: number
}

/** 与 mcp/src/server.ts 的 WRITE_ACTIONS 同表：这些动作发出后断开 / 超时 = 结果未知。 */
const WRITE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  order: ['place', 'amend', 'cancel', 'cancel_all', 'close'],
  propose: ['order', 'control'],
}

/** 结果未知后按 clientOrderId 回查内核（order.lookup）；查到 = 内核其实处理了，返回当前状态。内核没起来 / 查不到返回 null。 */
async function recover(client: KernelClient, tool: string, cloids: string[], deps: AgentCallDeps): Promise<Json | null> {
  for (let i = 0; i < (deps.recoverAttempts ?? 4); i++) {
    if (i > 0) await new Promise((res) => setTimeout(res, deps.recoverEveryMs ?? 1_500))
    for (const id of cloids) {
      const r = await client.call('order.lookup', { clientOrderId: id }, { timeoutMs: 5_000 })
      if (!r.ok) continue
      const v = r.result as { found?: boolean; order?: unknown; trail?: unknown; proposal?: unknown } | null
      if (v?.found && v.order) return { order: v.order, ...(v.trail ? { trail: v.trail } : {}), recoveredAfterTimeout: true, note: '内核当时没及时回应，但请求已被处理；这是它当前的状态。' }
      if (tool === 'propose' && v?.proposal) return { proposal: v.proposal, recoveredAfterTimeout: true, note: '内核当时没及时回应，但提案已创建；这是它当前的状态。' }
    }
  }
  return null
}

const HELP = `gitrader agent <工具> [<动作>] [--args '<JSON 对象>'] [--token-file <路径>]

  用与 gitrader-mcp 相同的 Agent 令牌、走同一个内核 Agent 接口（agent.<工具>）：
  MCP 工具还没出现在宿主里时，也能先完成「人只输 PIN、点批准」的流程。
  风险规则、档位、审批与 MCP 完全一样；本命令不新增任何权限。

  令牌来源（按顺序取第一个）：
    GITRADER_AGENT_TOKEN        环境变量
    GITRADER_AGENT_TOKEN_FILE   令牌文件
    --token-file <路径>         令牌文件（命令行指定）
    <home>/agent-tokens/        恰好一个 .token 文件

  例子：
    gitrader agent market quote --args '{"instrumentId":"hyperliquid:BTC"}'
    gitrader agent account summary
    gitrader agent propose order --args '{"accountId":"…","intents":[…],"reason":"…"}'

  选项：
    --args <JSON>       其余入参（必须是一个 JSON 对象）
    --token-file <路径> 令牌文件（只放令牌一行）
    --home DIR          指定主目录（或 GITRADER_HOME）
`

/** 「工具与动作」一节：按 MCP_TOOLS 顺序，每个工具一行（工具名、动作名、工具 description）。 */
function toolsAndActions(): string {
  const lines = MCP_TOOLS.map((t) => `  ${t.name}  ${t.actions.map((x) => x.name).join(' | ')}  — ${t.description}`)
  return `工具与动作：\n${lines.join('\n')}\n\n  每个工具的参数示例：gitrader agent <工具> --help\n`
}

/**
 * 帮助文本。无参数 = 总览（令牌来源、选项 + 工具与动作）；给了工具正名 = 该工具每个动作一行 --args 示例。
 * 只读常量，不读令牌、不连内核。
 */
export function agentHelp(tool?: string): string {
  if (tool === undefined) return `${HELP}\n${toolsAndActions()}`
  const def = getMcpTool(tool)
  if (!def) return agentHelp()
  const actions = def.actions.map((x) => `  ${mcpUsageLine(def.name, x.name)}`)
  return `gitrader agent ${def.name} <动作> --args '<JSON>'  — ${def.description}\n\n  动作：\n${actions.join('\n')}\n`
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** 毫秒时间戳下限（约 2001-09）；低于它的整数当普通数字。 */
const MS_MIN = 1e12
/** 需要旁附 ISO 的键名：以 At / Ts / ts 结尾。 */
const MS_KEY = /(?:At|Ts|ts)$/
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MS_MIN

function withIso(value: unknown, depth: number): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => withIso(v, depth + 1))
  if (!isObj(value)) return value
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) return value // 只处理普通对象（Date / Map 等原样返回）
  const out: Json = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = withIso(v, depth + 1)
    if (MS_KEY.test(k) && isMs(v)) out[`${k}Iso`] = new Date(v).toISOString()
  }
  return out
}

/** 与 mcp/src/server.ts 的 withIsoTimes 同规则：给毫秒时间戳字段旁附 `<键名>Iso`（不改原对象，深度 ≤ 6）。 */
export function withIsoTimes(value: unknown): unknown {
  return withIso(value, 0)
}

const newClientOrderId = (): string => randomBytes(16).toString('hex')

/**
 * 与 mcp/src/server.ts 的 withClientOrderIds 同规则：下单意图没带 clientOrderId 就补一个（带了原样用）。
 * 命令行每次都是一次性进程，没有跨调用记忆，所以 confirmToken → clientOrderId 的表是空的。
 */
function withClientOrderIds(tool: string, action: string, args: Json, tokens: Map<string, string>): { args: Json; cloids: string[] } {
  const cloids: string[] = []
  const stamp = (i: unknown): unknown => {
    if (!isObj(i)) return i
    const id = typeof i.clientOrderId === 'string' && i.clientOrderId ? i.clientOrderId : newClientOrderId()
    cloids.push(id)
    return { ...i, clientOrderId: id }
  }
  if (tool === 'order' && (action === 'preview' || action === 'place') && isObj(args.intent)) return { args: { ...args, intent: stamp(args.intent) }, cloids }
  if (tool === 'order' && action === 'place' && typeof args.confirmToken === 'string') {
    const id = tokens.get(args.confirmToken)
    return { args, cloids: id ? [id] : [] }
  }
  if (tool === 'order' && action === 'cancel' && typeof args.clientOrderId === 'string') return { args, cloids: [args.clientOrderId] }
  if (tool === 'propose' && action === 'order' && Array.isArray(args.intents)) return { args: { ...args, intents: args.intents.map(stamp) }, cloids }
  return { args, cloids }
}

const NO_KEY = '<home>/agent-tokens/ 里没有令牌文件。如果你用 --token-file 把令牌存到了别处，请用 --token-file <路径> 指给我；如果从没建过钥匙（还没有 Agent 钥匙：先运行 gitrader keys new agent <名字> --host claude-code --preset starter）。'

type TokenResult = { ok: true; token: string } | { ok: false; message: string }
type TokenFileLookup = { ok: true; path: string } | { ok: false; message: string }

/** <home>/agent-tokens/ 里唯一的 .token 文件：只返回路径，不读令牌内容。 */
export function findSingleTokenFile(home: string): TokenFileLookup {
  const dir = join(home, 'agent-tokens')
  let names: string[] = []
  try { names = readdirSync(dir).filter((n) => n.endsWith('.token')).sort() } catch { /* 目录不存在 = 还没有钥匙 */ }
  const files = names.filter((n) => {
    try { return statSync(join(dir, n)).isFile() } catch { return false }
  })
  if (files.length === 0) return { ok: false, message: NO_KEY }
  if (files.length > 1) return { ok: false, message: `找到 ${files.length} 个令牌文件：${files.join('、')}。请用 --token-file 选一个。` }
  return { ok: true, path: join(dir, files[0] as string) }
}

function readTokenFile(file: string): TokenResult {
  if (!existsSync(file)) return { ok: false, message: `令牌文件不存在：${file}。${NO_KEY}` }
  try {
    const token = readFileSync(file, 'utf8').trim()
    if (!token) return { ok: false, message: `令牌文件是空的：${file}。${NO_KEY}` }
    return { ok: true, token }
  } catch {
    return { ok: false, message: `读不了令牌文件：${file}` }
  }
}

/** 令牌来源顺序：环境变量 → 环境变量指向的文件 → --token-file → home 下恰好一个 .token 文件。令牌永不打印。 */
function resolveToken(home: string, a: Args, io: CliIo): TokenResult {
  const fromEnv = (io.env.GITRADER_AGENT_TOKEN ?? '').trim()
  if (fromEnv) return { ok: true, token: fromEnv }
  const envFile = (io.env.GITRADER_AGENT_TOKEN_FILE ?? '').trim()
  if (envFile) return readTokenFile(envFile)
  const flagFile = flag(a, 'token-file')
  if (flagFile) return readTokenFile(flagFile)

  const found = findSingleTokenFile(home)
  return found.ok ? readTokenFile(found.path) : found
}

function parseArgs(a: Args): { ok: true; value: Json } | { ok: false; message: string } {
  const text = flag(a, 'args')
  if (text === undefined) {
    if (a.flags.args === true) return { ok: false, message: '--args 必须是 JSON 对象（例如 \'{"instrumentId":"hyperliquid:BTC"}\'）' }
    return { ok: true, value: {} }
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, message: '--args 必须是 JSON 对象（例如 \'{"instrumentId":"hyperliquid:BTC"}\'）' } }
  if (!isObj(parsed)) return { ok: false, message: '--args 必须是 JSON 对象（例如 \'{"instrumentId":"hyperliquid:BTC"}\'）' }
  return { ok: true, value: parsed }
}

/** 调用成功 / 内核返回错误的唯一出口：一行 JSON；毫秒时间戳旁附 ISO。 */
const printJson = (io: CliIo, value: unknown): void => { io.out(`${JSON.stringify(value)}\n`) }

export async function cmdAgent(home: string, a: Args, io: CliIo, deps: AgentCallDeps = {}): Promise<number> {
  if (a.flags.help !== undefined || a.cmd.includes('-h') || a.cmd.includes('--help')) {
    // 帮助不读令牌、不连内核：有工具名就给这个工具的动作示例，否则给总览。
    const first = a.cmd[1]
    const hit = first === undefined ? null : resolveMcpTool(first)
    io.out(hit ? agentHelp(hit.tool) : agentHelp())
    return 0
  }

  const toolName = a.cmd[1]
  const resolved = toolName === undefined ? null : resolveMcpTool(toolName)
  const tool = resolved ? getMcpTool(resolved.tool) : undefined
  if (!tool) {
    const names = MCP_TOOLS.map((t) => t.name)
    const suggests = toolName === undefined ? [] : suggestMcpNames(toolName, names, 2)
    io.err(`未知工具：${toolName ?? '（没给）'}。${suggests.length ? `是不是想用：${suggests.join('、')}？` : ''}可用工具：${names.join(', ')}\n运行 gitrader agent --help 查看每个工具的动作。\n`)
    return 2
  }

  const parsed = parseArgs(a)
  if (!parsed.ok) { io.err(`${parsed.message}\n`); return 2 }

  const action = typeof a.cmd[2] === 'string' ? (a.cmd[2] as string) : (typeof parsed.value.action === 'string' ? parsed.value.action : '')
  // 动作别名不在这里解析（内核会解析并对未知动作给出提示）；但没给动作时先把该工具的用法打出来，不连内核。
  if (!action) { io.err(agentHelp(tool.name)); return 2 }

  const token = resolveToken(home, a, io)
  if (!token.ok) { io.err(`${token.message}\n`); return 2 }

  const raw: Json = { ...parsed.value, ...(action ? { action } : {}) }
  const orderLike = tool.name === 'order' || tool.name === 'propose'
  const prep = orderLike ? withClientOrderIds(tool.name, action, raw, new Map<string, string>()) : { args: raw, cloids: [] as string[] }
  // requestId 由这里生成（与 mcp/src/server.ts 同规则）：Agent 自带的同名字段一律覆盖。
  const params: Json = { ...prep.args, requestId: randomUUID() }

  const cfg = resolveConfig({ ...io.env, GITRADER_HOME: home })
  const client = new KernelClient({ baseUrl: cfg.baseUrl, token: token.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  const r = await client.call(`agent.${tool.name}`, params)

  if (r.ok) {
    const env = r.result as { data?: unknown } | null
    printJson(io, withIsoTimes(env?.data ?? null))
    return 0
  }

  if (r.timedOut || r.outcomeUnknown) {
    const timedOut = r.timedOut === true
    if (!(WRITE_ACTIONS[tool.name] ?? []).includes(action)) {
      // 只读 / 预览没有副作用：断开或超时就直接重试
      printJson(io, { error: r.error })
      io.err(`${timedOut ? '内核在时限内没有回应' : '连接中途断开'}（只读调用，没有副作用，可以直接重试）。\n`)
      return 1
    }
    const rec = prep.cloids.length ? await recover(client, tool.name, prep.cloids, deps) : null
    if (rec) { printJson(io, withIsoTimes(rec)); return 0 }
    const problem: Problem = { ...r.error, code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', category: 'VENUE', retryable: false, ...(prep.cloids.length ? { clientOrderIds: prep.cloids } : {}) }
    printJson(io, { error: problem })
    const how = prep.cloids.length
      ? `先用 gitrader agent ledger trace --args '{"id":"<clientOrderId>"}' 查清楚；要重试必须用同一个 clientOrderId（内核按它幂等）。\n本次的 clientOrderId：${prep.cloids.join('、')}`
      : '这次调用没有 clientOrderId 可查：先查持仓和挂单（gitrader agent account positions / orders）再决定。'
    io.err(`结果未知：请求已经发出，但${timedOut ? '内核在时限内没有回应（超时）' : '连接中途断开'}，这笔可能已经成交。${how}\n`)
    return 1
  }

  if (r.notSent) {
    printJson(io, { error: r.error })
    io.err('内核没在运行（连不上）：先运行 gitrader serve，再重试。\n')
    return 1
  }

  // 内核的 Problem 原样透传（含 ruleHits、venue.message 原文），只在 stderr 加一句中文概括。
  printJson(io, { error: orderLike && prep.cloids.length && !r.error.clientOrderIds ? { ...r.error, clientOrderIds: prep.cloids } : r.error })
  const text = humanizeProblem(r.error as Problem, { surface: 'agent' })
  const next = (r.error as { next?: unknown }).next
  io.err(`调用被拒：${text.zh}\n${typeof next === 'string' && next ? `下一步（正确调用示例）：${next}\n` : ''}`)
  return 1
}
