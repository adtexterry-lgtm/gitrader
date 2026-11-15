// SPDX-License-Identifier: CPAL-1.0
// Agent 面（E）：MCP 服务器经 HTTP `POST /api/op/agent.<工具名>`（Bearer gtk_…）调用内核。
//
// 设计要点
//   - 17 个工具各一个操作（agent.takeover … agent.workspace）+ `agent.session`（查级别，MCP 据此动态加载工具组）。
//   - 鉴权只认 Agent 钥匙令牌（OpSpec.auth = 'agent'）；人面专属动作（批准 / 放宽 / 授权书签发 / 恢复）一个也没有——工具面上根本没有入口。
//   - origin 由内核盖章：actor = agent:<keyId>、actorType = llm-agent、via = mcp、tool = 工具名；requestId 取 MCP 进程生成的 UUID
//     （契约 §1.6），没有或格式不对就用内核生成的。行为人不能自报 actor。
//   - 工具组 / 动作的最低级别再在服务端查一遍（注解只是提示，真正的放行在服务端；契约 §5.7）。
//   - 每次返回 { data, session }：session 带当前级别，MCP 服务器据此决定要不要发 tools/list_changed，不必另行轮询
//     （轮询会算作心跳，死人开关就形同虚设）。
//   - 错误原样走内核的 Problem（含 ruleHits、venue.message 上游原文），本层不改写。
import { effectiveDenyLlmLiveEntries, estimateToolDefTokens, getMcpTool, levelAtLeast, makeProblem, mcpToolsForLevel, mcpUsageLine, MCP_TOOLS, ORDER_INTENT_GUIDE, EXPERIMENT_GUIDE, RESEARCH_GUIDE, resolveMcpAction, suggestMcpNames, tierOfLevel } from '../proto'
import type { LedgerEntry, Mandate, MandateLevel, McpToolDef, OrderIntent, TakeoverLevel, TradingScope } from '../proto'
import type { Kernel } from '../kernel'
import type { ActorCtx } from '../trading'
import { dayStartTs } from '../risk-policy'
import { buildIndex, searchSymbols } from '@gitrader/symbol-search'
import { filterSearchHits } from '../ops'
import { ORG_SCOPE } from '../trading-state'
import { decorateOut, zhHits, zhNote } from './agent-out'
import { runAs, type InstanceCtx, type InstanceRow } from '../strategy-instances'
import * as d from '../util/dec'
import { KernelError } from '../util/errors'
import { mkOrigin } from '../util/origin'
import { isWatchAccount } from '../watch'
import type { OpContext, OpParams, OpRegistry } from './router'
import { checkToolArgs, checkIntent, checkExperimentArgs } from './agent-args'
import { backtestResultPart, loadBacktestResult } from './backtest-page'
import { pickDefaultEngine } from '../util/default-engine'
import { researchAction } from '../research'
import { registerResearchOps } from '../research/ops'

type Args = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200

const err = (name: Parameters<typeof makeProblem>[0], message: string): KernelError => new KernelError(makeProblem(name, message))
const bad = (m: string): KernelError => err('INVALID_PARAMS', m)
const need = <T>(v: T | undefined | null, name: string): T => { if (v === undefined || v === null || v === '') throw bad(`${name} is required`); return v }
const unsupported = (what: string, why: string): KernelError => err('CAPABILITY_UNSUPPORTED', `${what}: ${why}`)

const limitOf = (a: Args): number => { const n = Math.trunc(Number(a.limit ?? DEFAULT_LIST_LIMIT)); return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT }
/** 偏移游标分页：默认 20 条 + next。 */
function paged<T>(all: readonly T[], a: Args): { items: T[]; next?: string } {
  const off = Math.max(0, Math.trunc(Number(a.cursor ?? 0)) || 0)
  const lim = limitOf(a)
  return { items: all.slice(off, off + lim), ...(off + lim < all.length ? { next: String(off + lim) } : {}) }
}

interface Call {
  k: Kernel
  tool: string
  action: string
  args: Args
  actor: ActorCtx
  keyId: string
  mandate: Mandate
  level: MandateLevel
}

const sessionOf = (k: Kernel, keyId: string, mandate: Mandate | undefined): Record<string, unknown> => {
  const level = mandate?.level ?? 'L0'
  const allowAgentLayout = k.settings.agentLayout()
  return {
    keyId, mandateId: mandate?.mandateId ?? null, level, tier: tierOfLevel(level), status: mandate?.status ?? 'revoked', allowAgentLayout,
    tools: mcpToolsForLevel(level, { allowAgentLayout }).map((t) => t.name),
  }
}

// ---- 作用域 ---------------------------------------------------------------------------
/** 账户必须在授权书覆盖范围内；只有一个账户时 accountId 可省略。 */
function accountOf(c: Call, id: unknown): ReturnType<Kernel['accounts']['get']> {
  const given = typeof id === 'string' && id ? id : undefined
  if (!given) {
    // 只有一个账户时缺省用它；观察账户不算数——纸面账户 + 观察账户的钥匙，缺省仍是那个纸面账户（观察账户要显式写 accountId）
    const tradable = c.mandate.accounts.filter((id) => { const x = c.k.accounts.find(id); return !x || !isWatchAccount(x) })
    const only = c.mandate.accounts.length === 1 ? c.mandate.accounts[0] : tradable.length === 1 ? tradable[0] : undefined
    if (!only) throw bad(`accountId is required (this mandate covers ${c.mandate.accounts.length} accounts; use account.list)`)
    return c.k.accounts.get(only)
  }
  const a = c.k.accounts.get(given)
  if (!c.mandate.accounts.includes(a.accountId as never)) throw err('MANDATE_LIMIT', `account ${a.alias} is not covered by this mandate`)
  return a
}
/** 这把钥匙自己看到的交易状态作用域：org + 账户 + 自己的授权书 + 分组（与闸门取的集合一致，只读）。 */
const stateOf = (c: Call): ReturnType<Kernel['tstate']['effective']> => {
  const accounts = mandateAccounts(c)
  return c.k.tstate.effective(
    [ORG_SCOPE, ...accounts.map((x) => ({ type: 'account' as const, id: x.accountId })), { type: 'mandate' as const, id: c.mandate.mandateId }],
    [...new Set(accounts.flatMap((a) => a.groupIds))],
  )
}
const mandateAccounts = (c: Call): ReturnType<Kernel['accounts']['list']> => c.k.accounts.list().filter((a) => c.mandate.accounts.includes(a.accountId as never))

function scopeOf(c: Call): TradingScope {
  const s = (c.args.scope ?? { type: 'mandate', id: c.mandate.mandateId }) as { type?: string; id?: string }
  if (!s.type) throw bad('scope.type is required')
  const id = s.id ?? (s.type === 'org' ? ORG_SCOPE.id : s.type === 'mandate' ? c.mandate.mandateId : undefined)
  if (!id) throw bad(`scope.id is required for ${s.type}`)
  return { type: s.type as TradingScope['type'], id }
}

const sourceOf = (c: Call, instrumentId: string): ReturnType<Kernel['bus']['marketSource']> & object => {
  const i = instrumentId.indexOf(':')
  if (i <= 0) throw bad(`instrumentId must look like venue:SYMBOL (got ${JSON.stringify(instrumentId)})`)
  const venue = instrumentId.slice(0, i)
  const src = c.k.bus.marketSource(venue)
  if (!src) throw err('INSTRUMENT_UNKNOWN', `no market source for ${instrumentId}`)
  // R3-09：没配置的场所不能悄悄退回模拟场所（那样 candles 报 INTERNAL_ERROR、quote 回「等几秒再试」）；点名场所并告诉用户去哪配
  if (!c.k.bus.list().some((v) => v.venue === venue) && !c.k.bus.instrument(instrumentId as never)) {
    const configured = c.k.bus.list().map((v) => v.venue).filter((v) => v !== 'kernel-sim')
    throw err('INSTRUMENT_UNKNOWN', `venue ${venue} is not configured on this instance (configured: ${configured.join(', ') || 'none'}); add it under venues in gitrader.json, see docs/user/02-配置参考.md`)
  }
  return src
}

/** R3-20：观察账户只读——任何会动钱 / 动单 / 起策略的动作遇到它一律拒绝（CAPABILITY_UNSUPPORTED），读失败也不会走到下单路径。 */
const denyWatch = (acct: { alias: string; mode: string }, what: string): void => {
  if (isWatchAccount(acct)) throw unsupported(what, `account ${acct.alias} is a read-only watch account: it can be read, never traded`)
}

/** 观察账户的读：按地址读场所公开状态（不需要钥匙）；orders / fills 没有（本机从没替它下过单）。 */
async function readWatchAccount(c: Call, acct: ReturnType<Kernel['accounts']['get']>): Promise<unknown> {
  if (c.action === 'orders' || c.action === 'fills') return paged([], c.args)
  const { state, openOrders } = await c.k.bus.readWatch(acct)
  switch (c.action) {
    case 'summary': return { accountId: acct.accountId, mode: acct.mode, ts: state.ts, equity: state.margin.equity, available: state.margin.available, positions: state.positions.length, openOrders: openOrders.length }
    case 'positions': return paged(state.positions, c.args)
    case 'balances': return { accountId: acct.accountId, balances: state.balances }
    case 'margin': return { accountId: acct.accountId, margin: state.margin }
  }
  throw bad(`unknown action ${c.action}`)
}

/** 账本条目精简：去掉哈希链字段，Agent 不需要它们（结果同样占上下文）。 */
/** 引擎选择（GQ-21）：给了 engineId 用它；否则用默认引擎（gitrader-core 优先，不在线时若只有一个别的就用它，多个报错）。 */
const engineOf = (c: Call): string => {
  if (typeof c.args.engineId === 'string' && c.args.engineId) return c.args.engineId
  const choice = pickDefaultEngine(c.k.gep.status())
  if (!choice.ok) throw err('VENUE_UNAVAILABLE', choice.message)
  return choice.engineId
}
/** Agent 发起的引擎控制入账（engine.event，origin = 这把 Agent 钥匙），检阅面据此显示"谁让引擎做了什么"。 */
const engineNote = (c: Call, engineId: string, payload: Record<string, unknown>): void => {
  try { c.k.ledger.append({ type: 'engine.event', origin: c.actor.origin, subject: { engineId, ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId as never } : {}) }, payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown> }) } catch { /* 入账失败不挡控制动作 */ }
}

const STOP_OTHERS_MIN_LEVEL: MandateLevel = 'L2'
const agentCtx = (c: Call): InstanceCtx => ({ owner: { kind: 'agent', keyId: c.keyId, mandateId: c.mandate.mandateId }, origin: c.actor.origin })
/** 实例所在账户：先问引擎现场，问不到用登记表。 */
async function instanceAccount(c: Call, engineId: string, instanceId: string, row: InstanceRow | undefined): Promise<string | undefined> {
  try {
    const st = await c.k.gep.callEngine(engineId, 'strategy.status', { instanceId }) as { instances?: { instanceId: string; accountId?: string }[] }
    const hit = st.instances?.find((i) => i.instanceId === instanceId)
    if (hit?.accountId) return hit.accountId
  } catch { /* 引擎不认识这个实例：用登记表，再没有就让引擎自己报 unknown instanceId */ }
  return row?.accountId
}

/**
 * R2-REL-09：start_strategy 带 instanceId = 重启这个实例，沿用同一个 id（登记表的 needsRestart 和状态警告随之清掉）。
 * 正在跑 / 不存在 / strategyId、accountId 对不上都报 INVALID_PARAMS，什么也不启动。问不到引擎现场就不猜，也不启动。
 */
async function reusableInstance(c: Call, engineId: string, raw: unknown, strategyId: string, accountId: string): Promise<string> {
  const instanceId = typeof raw === 'string' ? raw : ''
  if (!instanceId || instanceId.trim() !== instanceId) throw bad('instanceId must be a non-empty string without surrounding spaces')
  const st = await c.k.gep.callEngine(engineId, 'strategy.status', {}) as { instances?: { instanceId: string; status?: string }[] } | null
  if (!Array.isArray(st?.instances)) throw err('VENUE_UNAVAILABLE', `engine ${engineId} did not report its instances; not starting ${instanceId}`)
  if (st.instances.some((i) => i.instanceId === instanceId && i.status === 'running')) throw bad(`instance ${instanceId} is already running`)
  const row = c.k.gep.instances.get(instanceId)
  if (!row) throw bad(`unknown instanceId ${instanceId}`)
  if (row.engineId !== engineId) throw bad(`engineId does not match instance ${instanceId} (it belongs to engine ${row.engineId})`)
  if (row.strategyId !== strategyId) throw bad(`strategyId does not match instance ${instanceId} (it runs ${row.strategyId})`)
  if (row.accountId !== accountId) throw bad(`accountId does not match instance ${instanceId} (it belongs to another account)`)
  return instanceId
}

const brief = (e: LedgerEntry): Record<string, unknown> => ({
  seq: e.seq, ts: e.ts, type: e.type, origin: e.origin, subject: e.subject,
  ...(e.precheck ? { precheck: e.precheck } : {}), ...(e.ruleHits ? { ruleHits: e.ruleHits } : {}), ...(e.payload ? { payload: e.payload } : {}),
})
const visible = (c: Call, entries: LedgerEntry[]): LedgerEntry[] =>
  entries.filter((e) => !e.subject.accountId || c.mandate.accounts.includes(e.subject.accountId as never))

// ---- 工具实现 ---------------------------------------------------------------------------
type Impl = (c: Call) => unknown | Promise<unknown>

const TOOLS: Record<string, Impl> = {
  // ---- S 自保 ----
  takeover: async (c) => c.k.takeover.execute({ level: c.action as TakeoverLevel, scope: scopeOf(c), reason: String(need(c.args.reason, 'reason')) }, c.actor),

  mandate: (c) => {
    const m = c.mandate
    switch (c.action) {
      case 'status': {
        const eff2 = stateOf(c)
        const eff = effectiveDenyLlmLiveEntries([c.k.risk.current()?.denyLlmLiveEntries, m.denyLlmLiveEntries])
        return {
          keyId: c.keyId, mandateId: m.mandateId, version: m.version, level: m.level, tier: tierOfLevel(m.level), status: m.status, accounts: m.accounts,
          venueAllowlist: m.venueAllowlist, instrumentAllowlist: m.instrumentAllowlist, limits: m.limits, notBefore: m.notBefore, notAfter: m.notAfter,
          heartbeat: m.heartbeat ?? null, approval: m.approval ?? null, promotion: m.promotion ?? null, denyLlmLiveEntries: eff,
          tradingState: eff2.state, stateReasons: eff2.reasons,
        }
      }
      case 'heartbeat': return { ...c.k.agents.heartbeat(m.mandateId), ...(m.heartbeat ? { timeoutSec: m.heartbeat.timeoutSec } : {}) }
      case 'downgrade': {
        const to = String(need(c.args.level, 'level')) as MandateLevel
        if (!['L0', 'L1', 'L2', 'L3'].includes(to)) throw bad('level must be one of L0-L3')
        // 自降级后授权书仍然有效（只是更严）；status 取 active，否则 effective() 会把任何非 active 状态一律看成 L0。
        const next = c.k.agents.downgrade(m.mandateId, to, String(c.args.reason ?? 'agent self-downgrade'), c.actor.origin, 'active')
        return { mandateId: next.mandateId, level: next.level, version: next.version }
      }
      case 'request_promotion': {
        // 晋级由人决定；这里只留一条记录让人在账本里看到申请。TODO(protocol): ControlIntent.controlKind = request_promotion 的提案化。
        const reason = String(need(c.args.reason, 'reason')).slice(0, 2000)
        c.k.ledger.append({ type: 'annotation', origin: c.actor.origin, subject: { orgId: 'org_local', mandateId: m.mandateId }, payload: { kind: 'promotion_request', fromLevel: m.level, reason } })
        return { recorded: true, note: 'Promotion is decided by the user in the workbench; nothing changed.' }
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  // ---- R 只读 ----
  discover: (c) => {
    const allowAgentLayout = c.k.settings.agentLayout()
    const loaded = new Set(mcpToolsForLevel(c.level, { allowAgentLayout }).map((t) => t.name))
    switch (c.action) {
      case 'groups': {
        const groups: Record<string, { tool: string; loaded: boolean }[]> = {}
        for (const t of MCP_TOOLS) (groups[t.group] ??= []).push({ tool: t.name, loaded: loaded.has(t.name) })
        return { level: c.level, tier: tierOfLevel(c.level), groups, hint: 'Tools that are not loaded need a higher permission set by the user in the workbench (Agent permissions).' }
      }
      case 'tool_help': {
        const t = getMcpTool(String(need(c.args.tool, 'tool')))
        if (!t) throw bad(`unknown tool ${String(c.args.tool)}`)
        return { name: t.name, group: t.group, loaded: loaded.has(t.name), description: t.description, annotations: t.annotations, actions: t.actions, load: t.load, definitionTokens: estimateToolDefTokens(t), inputSchema: t.inputSchema, ...(t.name === 'propose' || t.name === 'order' ? { guide: ORDER_INTENT_GUIDE } : t.name === 'experiment' ? { guide: EXPERIMENT_GUIDE } : t.name === 'research' ? { guide: RESEARCH_GUIDE } : {}) }
      }
      case 'capabilities': {
        return {
          level: c.level, tier: tierOfLevel(c.level),
          accounts: mandateAccounts(c).map((a) => ({ accountId: a.accountId, alias: a.alias, mode: a.mode, venue: a.venue, environment: a.environment, status: a.status })),
          venues: c.k.bus.list().map((v) => v.describe()),
          limits: c.mandate.limits, tradingState: stateOf(c).state,
          denyLlmLiveEntries: effectiveDenyLlmLiveEntries([c.k.risk.current()?.denyLlmLiveEntries, c.mandate.denyLlmLiveEntries]),
          engines: c.k.engines.status().map((e) => ({ id: e.id, state: e.state })), allowAgentLayout,
        }
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  market: async (c) => {
    const a = c.args
    switch (c.action) {
      case 'search': {
        // 排序 / 归一化走 @gitrader/symbol-search（btc/usdt → btc；空查询不再返回全表）；先主市场，零命中才放宽到 builder dex
        const q = String(a.query ?? '').trim()
        if (!q) return { items: [], hint: 'query is required, e.g. {"action":"search","query":"BTC"}; symbols are matched by code, name and alias' }
        const live = filterSearchHits(c.k.bus.instruments(), c.k.clock.now())
        const byId = new Map(live.map((i) => [i.instrumentId, i]))
        const main = live.filter((i) => !(typeof i.marketGroup === 'string' && i.marketGroup.trim() !== ''))
        const pick = (pool: typeof live, text: string) => searchSymbols(buildIndex({ instruments: pool }), text, { limit: 1000 })
        let hits = pick(main, q)
        if (!hits.length && /[/\-_ ]/.test(q)) hits = pick(main, q.split(/[/\-_ ]/)[0]!)
        if (!hits.length) hits = pick(live, q)
        const p = paged(hits, a)
        return { ...p, items: p.items.map((m) => { const i = byId.get(m.record.instrumentId); return { instrumentId: m.record.instrumentId, name: m.record.displaySymbol, venue: m.record.venue, kind: m.record.kind, status: m.record.status, matchKind: m.matchKind, minNotional: i?.minNotional, maxLeverage: i?.maxLeverage } }) }
      }
      case 'quote': { const id = String(need(a.instrumentId, 'instrumentId')); return sourceOf(c, id).quote(id) ?? { quote: null, reason: 'no_feed', hint: '行情暂时没有数据，等几秒再试；持续没有就运行 gitrader doctor' } }
      case 'book': { const id = String(need(a.instrumentId, 'instrumentId')); return sourceOf(c, id).book(id, Math.min(Number(a.depth ?? 10) || 10, 50)) }
      case 'candles': {
        const id = String(need(a.instrumentId, 'instrumentId'))
        const candles = await sourceOf(c, id).candles(id, String(a.interval ?? '15m') as never, { n: limitOf(a), ...(a.from !== undefined ? { from: Number(a.from) } : {}), ...(a.to !== undefined ? { to: Number(a.to) } : {}) })
        return { instrumentId: id, interval: a.interval ?? '15m', candles }
      }
      case 'context': { const id = String(need(a.instrumentId, 'instrumentId')); return sourceOf(c, id).context(id) }
      case 'funding': {
        const id = String(need(a.instrumentId, 'instrumentId'))
        const ctx = await sourceOf(c, id).context(id)
        return { instrumentId: id, ts: ctx.ts, fundingRate: (ctx as { fundingRate?: number }).fundingRate ?? null, fundingIntervalMs: (ctx as { fundingIntervalMs?: number }).fundingIntervalMs ?? null }
      }
      case 'venue_status': {
        // 内核模拟场所（kernel-sim）借用行情源的状态，venue 字段与真实场所相同：按 venue 去重，留先出现的一条（R3-18）。
        // 每个场所多两个字段：connection / readiness，与 status.connections[] 同一口径（k.venueConnection，按状态里的 venue 取，去重后留下的是真实场所的连接）。
        const seen = new Set<string>()
        return c.k.bus.list().map((v) => c.k.bus.readStatus(v.venue)).filter((s): s is NonNullable<typeof s> => s !== undefined && !seen.has(s.venue) && !!seen.add(s.venue))
          .map((s) => { const conn = c.k.venueConnection(s.venue); return { ...s, connection: conn.state, readiness: conn.readiness } })
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  account: async (c) => {
    const a = c.args
    if (c.action === 'list') return mandateAccounts(c).map((x) => ({ accountId: x.accountId, alias: x.alias, mode: x.mode, venue: x.venue, environment: x.environment, status: x.status }))
    const acct = accountOf(c, a.accountId)
    if (isWatchAccount(acct)) return readWatchAccount(c, acct)
    switch (c.action) {
      case 'summary': { const s = await c.k.bus.snapshot(acct, { maxAgeMs: 3000 }); return { accountId: acct.accountId, mode: acct.mode, ts: s.ts, equity: s.equity, available: s.available, positions: s.positions.length, openOrders: s.openOrders.length } }
      case 'positions': { const s = await c.k.bus.snapshot(acct, { maxAgeMs: 3000 }); return paged(s.positions, a) }
      case 'orders': { const off = Math.max(0, Math.trunc(Number(a.cursor ?? 0)) || 0); return paged(c.k.orders.list({ accountId: acct.accountId, limit: off + limitOf(a) + 1 }), a) }
      case 'fills': { const off = Math.max(0, Math.trunc(Number(a.cursor ?? 0)) || 0); return paged(c.k.orders.fills({ accountId: acct.accountId, limit: off + limitOf(a) + 1 }), a) }
      case 'balances': { const s = await c.k.bus.routeFor(acct).accountState(c.k.bus.accountRef(acct)); return { accountId: acct.accountId, balances: s.balances } }
      case 'margin': { const s = await c.k.bus.routeFor(acct).accountState(c.k.bus.accountRef(acct)); return { accountId: acct.accountId, margin: s.margin } }
    }
    throw bad(`unknown action ${c.action}`)
  },

  risk_status: (c) => {
    const k = c.k
    const pol = k.risk.current()
    switch (c.action) {
      case 'state': {
        const eff = stateOf(c)
        return {
          tradingState: eff.state, reasons: eff.reasons, policy: pol ? { policyId: pol.policyId, version: pol.version } : null, integrity: k.risk.integrity,
          denyLlmLiveEntries: effectiveDenyLlmLiveEntries([pol?.denyLlmLiveEntries, c.mandate.denyLlmLiveEntries]),
        }
      }
      case 'usage': {
        const now = k.clock.now()
        const ds = dayStartTs(now, pol?.dailyResetAt ?? '00:00Z')
        return {
          since: ds,
          accounts: mandateAccounts(c).map((x) => ({
            accountId: x.accountId, notionalToday: d.str(k.orders.notionalSince(x.accountId, ds, c.mandate.mandateId)),
            ordersToday: k.orders.countSince(x.accountId, ds, c.mandate.mandateId), ordersLastMinute: k.orders.countSince(x.accountId, now - 60_000, c.mandate.mandateId),
          })),
          mandateLimits: c.mandate.limits,
        }
      }
      case 'rules': return { limits: k.risk.effectiveLimits(), mandateLimits: c.mandate.limits, protectors: pol?.protectors ?? [], denyLlmLiveEntries: effectiveDenyLlmLiveEntries([pol?.denyLlmLiveEntries, c.mandate.denyLlmLiveEntries]) }
      case 'denials': {
        const hits = visible(c, k.ledger.query({ types: ['risk.denied'], limit: limitOf(c.args) }))
        return { items: hits.map(brief) }
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  ledger: (c) => {
    const a = c.args
    const k = c.k
    switch (c.action) {
      case 'query': {
        const f = (a.filter ?? {}) as Args
        const actorType = f['origin.actorType'] ?? f.actorType
        const lim = limitOf(a)
        const beforeSeq = a.cursor !== undefined ? Number(a.cursor) : f.beforeSeq
        const rows = k.ledger.query({
          ...(Array.isArray(f.types) ? { types: f.types.map(String) } : f.type ? { types: [String(f.type)] } : {}),
          ...(f.accountId ? { accountId: String(f.accountId) } : {}), ...(f.instrumentId ? { instrumentId: String(f.instrumentId) } : {}), ...(f.orderId ? { orderId: String(f.orderId) } : {}),
          ...(f.proposalId ? { proposalId: String(f.proposalId) } : {}), ...(f.ticket ? { ticket: String(f.ticket) } : {}), ...(f.takeoverId ? { takeoverId: String(f.takeoverId) } : {}),
          ...(f.actor ? { actor: String(f.actor) } : {}), ...(f.sinceTs !== undefined ? { sinceTs: Number(f.sinceTs) } : {}), ...(f.untilTs !== undefined ? { untilTs: Number(f.untilTs) } : {}),
          ...(beforeSeq !== undefined ? { beforeSeq: Number(beforeSeq) } : {}), limit: lim,
        })
        const items = visible(c, rows).filter((e) => !actorType || e.origin.actorType === actorType)
        return { items: items.map(brief), ...(rows.length === lim && rows.length ? { next: String(rows[rows.length - 1]!.seq) } : {}) }
      }
      case 'trace': {
        const id = String(need(a.id, 'id'))
        const by = id.startsWith('ord_') ? { orderId: id } : id.startsWith('prop_') ? { proposalId: id } : id.startsWith('T-') ? { ticket: id } : { clientOrderId: id }
        return { items: visible(c, k.ledger.trace(by)).slice(0, 200).map(brief) }
      }
      case 'stats': {
        const since = a.filter?.sinceTs !== undefined ? Number(a.filter.sinceTs) : k.clock.now() - 24 * 3600_000
        const rows = visible(c, k.ledger.query({ sinceTs: since, limit: 1000 }))
        const byType: Record<string, number> = {}
        const byActorType: Record<string, number> = {}
        for (const e of rows) { byType[e.type] = (byType[e.type] ?? 0) + 1; byActorType[e.origin.actorType] = (byActorType[e.origin.actorType] ?? 0) + 1 }
        return { since, sampled: rows.length, truncated: rows.length >= 1000, byType, byActorType, head: k.ledger.head() }
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  // ---- P 提案与培养皿 ----
  engines: async (c) => {
    switch (c.action) {
      case 'list':
      case 'status': {
        const all = c.k.engines.status()
        return c.args.engineId ? all.filter((e) => e.id === c.args.engineId) : all
      }
    }
    // 集成修补（H）：转给内核 GEP 宿主。只开纸面 / 影子（实盘启动要人批准的提案，callEngine 自己会拒）；引擎必须先由人绑定到该账户（engine.bind，PIN）。
    const engineId = engineOf(c)
    switch (c.action) {
      case 'strategies': return c.k.gep.callEngine(engineId, 'strategy.list', {})
      case 'start_strategy': {
        c.k.assertNotHalted('starting a strategy')
        const acct = accountOf(c, c.args.accountId)
        denyWatch(acct, 'engines.start_strategy')
        if (acct.mode === 'live') throw err('MANDATE_LEVEL', 'starting a strategy on a live account needs a human-approved proposal; use propose (control) or ask the user')
        const instruments = Array.isArray(c.args.instruments) ? c.args.instruments.map(String) : []
        if (!instruments.length) throw bad('instruments is required (instrumentId list)')
        const strategyId = String(need(c.args.strategyId, 'strategyId'))
        const reuseId = c.args.instanceId === undefined || c.args.instanceId === null ? undefined : await reusableInstance(c, engineId, c.args.instanceId, strategyId, acct.accountId)
        const r = await runAs(agentCtx(c), () => c.k.gep.callEngine(engineId, 'strategy.start', { ...(reuseId ? { instanceId: reuseId } : {}), strategyId, accountId: acct.accountId, instruments, interval: String(c.args.interval ?? '1m'), params: (c.args.params ?? {}) as Args, ...(c.args.sizing ? { sizing: c.args.sizing } : {}) }))
        engineNote(c, engineId, { action: 'strategy.start', ...(reuseId ? { instanceId: reuseId } : {}), strategyId: c.args.strategyId, accountId: acct.accountId, instruments, interval: c.args.interval ?? '1m', result: r })
        return r
      }
      case 'update_strategy': {
        c.k.assertNotHalted('updating a strategy')
        const r = await runAs(agentCtx(c), () => c.k.gep.callEngine(engineId, 'strategy.update', { instanceId: String(need(c.args.instanceId, 'instanceId')), params: (c.args.params ?? {}) as Args }))
        engineNote(c, engineId, { action: 'strategy.update', instanceId: c.args.instanceId, params: c.args.params ?? {} })
        return r
      }
      case 'stop_strategy': {
        const instanceId = String(need(c.args.instanceId, 'instanceId'))
        const row = c.k.gep.instances.get(instanceId)
        const acctId = await instanceAccount(c, engineId, instanceId, row)
        if (acctId && !c.mandate.accounts.includes(acctId as never)) throw err('MANDATE_LIMIT', `instance ${instanceId} runs on an account this key does not cover`)
        const own = row?.owner.kind === 'agent' && row.owner.keyId === c.keyId
        if (!own && !levelAtLeast(c.level, STOP_OTHERS_MIN_LEVEL)) throw err('MANDATE_LEVEL', `stop_strategy: instance ${instanceId} was not started by this key; stopping another party's instance needs level ${STOP_OTHERS_MIN_LEVEL} or higher (ask the user to stop it in the workbench)`)
        const r = await runAs(agentCtx(c), () => c.k.gep.callEngine(engineId, 'strategy.stop', { instanceId }))
        engineNote(c, engineId, { action: 'strategy.stop', instanceId, ...(r && typeof r === 'object' && 'unmanagedPositions' in r ? { unmanagedPositions: (r as any).unmanagedPositions } : {}) })
        return r
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  propose: async (c) => {
    if (c.action === 'control') throw unsupported('propose.control', 'control proposals (live strategy start, workflow run, promotion) are not supported by this kernel build yet')
    const acct = accountOf(c, c.args.accountId)
    denyWatch(acct, 'propose')
    if (acct.mode === 'live' && !levelAtLeast(c.level, 'L2')) throw err('MANDATE_LEVEL', `live proposals need level L2 or higher (this key is ${c.level})`)
    const intents = (Array.isArray(c.args.intents) ? c.args.intents : [])
    if (intents.length > 10) throw bad('propose.intents: max 10 intents per proposal')
    intents.forEach((i: any, n: number) => checkIntent(i, `intents[${n}]`))
    const checkedIntents = intents.map((i: OrderIntent) => ({ ...i, accountId: i.accountId ?? acct.accountId }))
    return c.k.trading.propose({ accountId: acct.accountId, intents: checkedIntents, reason: String(need(c.args.reason, 'reason')), ...(c.args.evidence ? { evidence: c.args.evidence } : {}) }, c.actor)
  },

  proposals: (c) => {
    const own = (id: string) => {
      const p = c.k.trading.getProposal(id)
      if (!p || p.mandateId !== c.mandate.mandateId) throw bad(`no such proposal: ${id}`)
      return p
    }
    switch (c.action) {
      case 'get': return own(String(need(c.args.proposalId ?? c.args.ticket, 'proposalId or ticket')))
      case 'list': return paged(c.k.trading.listProposals({ mandateId: c.mandate.mandateId, ...(c.args.status ? { status: String(c.args.status) } : {}), limit: 1000 }), c.args)
      case 'withdraw': { own(String(need(c.args.proposalId ?? c.args.ticket, 'proposalId or ticket'))); return c.k.trading.withdraw(String(c.args.proposalId ?? c.args.ticket), c.actor) }
    }
    throw bad(`unknown action ${c.action}`)
  },

  note: (c) => {
    if (c.action === 'add') {
      const text = String(need(c.args.text, 'text')).slice(0, 4000)
      const e = c.k.ledger.append({ type: 'note', origin: c.actor.origin, subject: { orgId: 'org_local' }, payload: { text, ...(Array.isArray(c.args.tags) ? { tags: c.args.tags.map(String).slice(0, 10) } : {}), ...(Array.isArray(c.args.refs) ? { refs: c.args.refs.map(String).slice(0, 10) } : {}) } })
      return { seq: e.seq }
    }
    if (c.action === 'list') {
      const lim = limitOf(c.args)
      const rows = c.k.ledger.query({ types: ['note'], limit: lim, ...(c.args.cursor !== undefined ? { beforeSeq: Number(c.args.cursor) } : {}) })
      return { items: rows.map(brief), ...(rows.length === lim ? { next: String(rows[rows.length - 1]!.seq) } : {}) }
    }
    throw bad(`unknown action ${c.action}`)
  },

  backtest: async (c) => {
    // 集成修补（H）：回测在引擎里跑（GEP backtest.*）；回测产物不进前向账本（内核不变量 3），这里只转发。
    const engineId = engineOf(c)
    switch (c.action) {
      case 'run': return { ...(await c.k.lab.forward(engineId, 'backtest.run', { spec: need(c.args.spec, 'spec') as Args }, c.actor)), engineId }
      case 'status': case 'cancel': return c.k.lab.forward(engineId, `backtest.${c.action}`, { jobId: String(need(c.args.jobId, 'jobId')) }, c.actor)
      case 'result': {
        // R1-PERF-02：默认只回摘要（stats / biasChecks / 假设 / counts…），equity / trades / funding 按 part + cursor + limit 分页（backtest-page.ts）
        const jobId = String(need(c.args.jobId, 'jobId'))
        const entry = await loadBacktestResult(c.k, `${c.mandate.mandateId}|${engineId}|${jobId}`, () => c.k.lab.forward(engineId, 'backtest.result', { jobId }, c.actor))
        return backtestResultPart(entry, c.args, c.k.lab.artifacts)
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  // 研究（第六轮 C 包）：只读；寻优 / 因子报告在引擎里异步跑，报告 / 组合 / 搜索在内核里同步算（见 ../research）
  research: (c) => {
    const sessionKey = c.k.auth.operationRateKey(c.actor.principal) ?? ''
    return researchAction({ k: c.k, actor: c.actor, accountIds: c.mandate.accounts as string[], sessionKey }, c.action, c.args)
  },

  workflow: (c) => {
    // GEP 宿主已接入；workflow 工具的独立接线仍未实现，当前继续明确拒绝。
    throw unsupported(`workflow.${c.action}`, 'workflow tool routing is not implemented in this build')
  },

  experiment: (c) => {
    checkExperimentArgs(c.args)
    return c.k.lab.handle(c.action, c.args, c.actor)
  },

  plugins: async (c) => {
    const k = c.k
    switch (c.action) {
      case 'list': return k.plugins.list().map((p) => ({ id: p.id, version: p.version, ok: p.ok, state: p.state, kind: p.manifest?.kind, name: p.manifest?.name }))
      case 'describe': {
        const p = k.plugins.get(String(need(c.args.pluginId, 'pluginId')))
        if (!p) throw bad(`no such plugin: ${String(c.args.pluginId)}`)
        return { id: p.id, version: p.version, ok: p.ok, state: p.state, granted: p.granted, enabled: p.enabled, tools: p.tools, problems: p.problems, manifest: p.manifest ?? null }
      }
      case 'call': {
        k.assertNotHalted('plugin tool call')
        return k.plugins.callTool(String(need(c.args.pluginId, 'pluginId')), String(need(c.args.tool, 'tool')), c.args.args)
      }
    }
    throw bad(`unknown action ${c.action}`)
  },

  // ---- E 执行 ----
  order: async (c) => {
    const a = c.args
    const k = c.k
    // place 只收 confirmToken：账户 / 意图都绑在令牌里，内核重新校验授权书、风控版本与价格漂移（令牌只能由预览它的那把钥匙使用）
    if (c.action === 'place' && a.confirmToken !== undefined) return k.trading.place({ confirmToken: String(a.confirmToken) }, c.actor)
    const acctId = a.intent?.accountId ?? a.accountId
    const acct = accountOf(c, acctId)
    denyWatch(acct, `order.${c.action}`)
    // 实盘动作的最低级别（L3）：纸面 / 影子 L1 起。具体的放行（额度、LLM 实盘开仓保护、转提案）仍由内核风控闸做。
    if (acct.mode === 'live' && !levelAtLeast(c.level, 'L3')) throw err('MANDATE_LEVEL', `live order actions need level L3 or higher (this key is ${c.level}); use propose for live orders`)
    switch (c.action) {
      case 'preview': {
        if (a.intent === undefined && a.intents !== undefined) throw bad('intent is required: order.preview takes one "intent" object; to submit a list for approval use propose.order with "intents"')
        checkIntent(a.intent, 'intent')
        const intent = { ...(need(a.intent, 'intent') as OrderIntent), accountId: acct.accountId } as OrderIntent
        return k.trading.preview(intent, c.actor)
      }
      case 'place': {
        if (!a.intent) throw bad('place needs confirmToken (live) or intent (paper/shadow)')
        checkIntent(a.intent, 'intent')
        return k.trading.place({ intent: { ...(a.intent as OrderIntent), accountId: acct.accountId } }, c.actor)
      }
      case 'cancel': return k.trading.cancel({ accountId: acct.accountId, ...(a.orderId ? { orderId: String(a.orderId) } : {}), ...(a.clientOrderId ? { clientOrderId: String(a.clientOrderId) } : {}) }, c.actor)
      case 'cancel_all': return k.trading.cancelAll({ accountId: acct.accountId, ...(a.instrumentId ? { instrumentId: String(a.instrumentId) } : {}) }, c.actor)
      case 'close': return k.trading.closePosition({ accountId: acct.accountId, instrumentId: String(need(a.instrumentId, 'instrumentId')), ...(a.size ? { size: String(a.size) } : {}), ...(a.reason ? { reason: String(a.reason) } : {}) }, c.actor)
      case 'amend': return k.trading.amend(c.actor, {
        accountId: acct.accountId, ...(a.orderId ? { orderId: String(a.orderId) } : {}), ...(a.clientOrderId ? { clientOrderId: String(a.clientOrderId) } : {}),
        ...(a.price === undefined ? {} : { price: a.price }), ...(a.size === undefined ? {} : { size: a.size }), ...(a.triggerPrice === undefined ? {} : { triggerPrice: a.triggerPrice }),
      })
    }
    throw bad(`unknown action ${c.action}`)
  },

  // ---- W 工作区 ----
  workspace: (c) => {
    const k = c.k
    switch (c.action) {
      case 'list': return { workspaces: k.workspaces.list(), current: k.workspaces.current() ? { revision: k.workspaces.current()!.revision } : null }
      case 'load': { const ws = k.workspaces.load(String(need(c.args.name, 'name'))); return k.workspaces.update(ws.workspace, c.actor.origin.actor) }
      case 'save': {
        const cur = k.workspaces.current()
        if (!cur) throw bad('there is no current workspace to save')
        return k.workspaces.save(String(need(c.args.name, 'name')), cur.workspace, c.actor.origin.actor, false)
      }
    }
    // TODO(F): add/remove/arrange/popout/focus 要按块清单与布局引擎（契约 §4.5）改工作区 JSON，由工作台壳实现；内核只存取。
    throw unsupported(`workspace.${c.action}`, 'layout edits are applied by the workbench shell; the kernel only lists, loads and saves workspaces')
  },
}

// ---- 注册 -----------------------------------------------------------------------------
function prepareCall(k: Kernel, ctx: OpContext, tool: McpToolDef, params: OpParams): Call {
  if (ctx.principal.kind !== 'agent') throw err('AUTH_FAILED', 'agent tools need an agent key')
  const { requestId, ...args } = params as Args
  // origin：工具名 + via=mcp；requestId 用 MCP 进程生成的 UUID（契约 §1.6）。actor / actorType 一律来自已认证身份。
  const origin = mkOrigin(ctx.origin.actor, tool.name, 'mcp', { requestId: typeof requestId === 'string' && UUID.test(requestId) ? requestId : ctx.origin.requestId })
  const mandate = k.agents.effective(ctx.principal.mandateId)
  if (!mandate) throw err('MANDATE_EXPIRED', 'this key has no effective mandate')
  const level = mandate.level
  // 动作别名（ADR-22）：便宜模型常把 account summary 写成 get / status，先把误写解析成正名再查级别与实现。
  // 别名只可能落到只读动作（协议表保证），级别检查对正名照常执行。
  const rawAction = typeof args.action === 'string' ? args.action : ''
  const actionNames = tool.actions.map((x) => x.name)
  const names = actionNames.join(', ')
  const first = actionNames[0] ?? ''
  const r = rawAction ? resolveMcpAction(tool.name, rawAction) : null
  if (!r) {
    if (!rawAction) throw bad(`missing action for ${tool.name} (valid: ${names}). Example: ${mcpUsageLine(tool.name, first)}`)
    const s = suggestMcpNames(rawAction, actionNames)
    const hint = s.length > 0 ? `. Did you mean: ${s[0]} → ${mcpUsageLine(tool.name, s[0]!)}` : `. Example: ${mcpUsageLine(tool.name, first)}`
    throw bad(`unknown action ${JSON.stringify(rawAction)} for ${tool.name} (valid: ${names})${hint}`)
  }
  const action = r.action
  const spec = tool.actions.find((x) => x.name === action)
  if (!spec) throw bad(`unknown action ${JSON.stringify(rawAction)} for ${tool.name} (valid: ${names})`)
  // 传给实现的 args.action 也换成正名（args 是解构出来的新对象，可以复制改字段）
  const callArgs: Args = { ...checkToolArgs(tool, action, args), action }
  // 服务端再查一遍工具加载条件与动作的最低级别（注解只是提示，放行在服务端）
  const allowAgentLayout = k.settings.agentLayout()
  if (!mcpToolsForLevel(level, { allowAgentLayout }).some((t) => t.name === tool.name)) {
    if (tool.load.kind === 'toggle') throw err('MANDATE_LEVEL', `${tool.name} is off: the user has to enable "allow Agent to adjust layout" in the workbench`)
    throw err('MANDATE_LEVEL', `${tool.name} needs level ${tool.load.kind === 'level' ? tool.load.min : 'L1'} or higher (this key is ${level})`)
  }
  if (spec.minLevel && !spec.selfProtect && !levelAtLeast(level, spec.minLevel)) throw err('MANDATE_LEVEL', `${tool.name}.${action} needs level ${spec.minLevel} or higher (this key is ${level})`)
  const actor: ActorCtx = { principal: ctx.principal, origin }
  return { k, tool: tool.name, action, args: callArgs, actor, keyId: ctx.principal.keyId, mandate, level }
}

export function registerAgentOps(k: Kernel, ops: OpRegistry): void {
  // 查级别（MCP 服务器启动时一次，之后每次调用的返回里都带 session，不再轮询）
  ops.register('agent.session', { auth: 'agent', kind: 'query' }, (ctx) => {
    if (ctx.principal.kind !== 'agent') throw err('AUTH_FAILED', 'agent key required')
    return sessionOf(k, ctx.principal.keyId, k.agents.effective(ctx.principal.mandateId))
  })
  for (const tool of MCP_TOOLS as readonly McpToolDef[]) {
    const impl = TOOLS[tool.name]
    if (!impl) throw new Error(`no kernel implementation for MCP tool ${tool.name}`)
    const handle = async (ctx: OpContext, params: OpParams): Promise<{ data: unknown; session: Record<string, unknown> }> => {
      const call = prepareCall(k, ctx, tool, params)
      let data: unknown
      try {
        data = await impl(call)
      } catch (e) {
        if (e instanceof KernelError) {                          // 场所上游原文、风控 ruleHits 原样放行（只并列加中文 zh / note）
          const hs = e.problem.ruleHits
          if (hs?.length) throw new KernelError({ ...e.problem, ruleHits: zhHits(hs as never) as never, ...({ note: zhNote(hs as never) } as object) })
          throw e
        }
        k.log(`agent.${tool.name}.${call.action} internal error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`) // Kernel.log（kernel.ts:222）；完整堆栈只进内核日志
        throw err('INTERNAL_ERROR', `internal error while handling ${tool.name}.${call.action}; check the arguments against discover tool_help {"tool":"${tool.name}"}`)
      }
      if ((tool.name === 'order' && (call.action === 'preview' || call.action === 'place')) || (tool.name === 'propose' && call.action === 'order')) {
        data = decorateOut(data, call.action === 'place' || call.action === 'preview' ? (call.args.intent ? [call.args.intent] : []) : (Array.isArray(call.args.intents) ? call.args.intents : []))
      }
      return { data: data ?? null, session: sessionOf(k, call.keyId, k.agents.effective(call.mandate.mandateId)) }
    }
    ops.register(`agent.${tool.name}`, { auth: 'agent', kind: 'command' }, async (ctx, params) => {
      const keyId = ctx.principal.kind === 'agent' ? ctx.principal.keyId : ''
      const rawAction = typeof (params as Args).action === 'string' ? ((params as Args).action as string) : ''
      try {
        const out = await handle(ctx, params)
        if (keyId) k.agentTrouble.ok(keyId) // K5：成功一次清零
        return out
      } catch (e) {
        if (!(e instanceof KernelError)) throw e
        const actionNames = tool.actions.map((x) => x.name)
        const action = resolveMcpAction(tool.name, rawAction)?.action ?? suggestMcpNames(rawAction, actionNames)[0] ?? actionNames[0] ?? ''
        k.agentTrouble.fail(keyId, e.problem.name, tool.name, action)
        // 第 1 层：参数被拒时 next 附该工具该动作的正确调用示例（取协议里现成样例；不改校验、不收别名）
        if (e.problem.name === 'INVALID_PARAMS' && !('next' in e.problem)) throw new KernelError({ ...e.problem, ...({ next: mcpUsageLine(tool.name, action) } as object) })
        throw e
      }
    })
  }
  registerResearchOps(k, ops) // 人面入口 research.call（CLI gitrader research …）
}
