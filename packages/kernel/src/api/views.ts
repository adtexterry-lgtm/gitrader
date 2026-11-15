// SPDX-License-Identifier: CPAL-1.0
import { EXPERIMENT_STAGES, ORIGIN_ACTOR_TYPES, validateProblem } from '@gitrader/protocol'
import type {
  AccountAssetsView, BacktestResult, Decimal, EngineCatalogParam, EngineCatalogStrategy, EngineCatalogView, EngineStrategiesView, EngineStrategyFailureView, EngineStrategyView,
  EquityHistoryParams, Experiment, Fill, ForwardSnapshot, LabGetView, LabListView, LabRun, LedgerEntry, Order, OriginActorType,
  PortfolioAnalysisResult, RecordsQueryParams, RecordsQueryView, StrategyInstance,
} from '@gitrader/protocol'
import { analyzePortfolio, PortfolioError, staticPriceSource } from '@gitrader/portfolio'
import type { AccountSnapshot } from '@gitrader/protocol/connector'
import { connectorOperationError } from '../connector'
import { queryEquityHistory } from '../equity-history'
import { projectConfigView, registerConfigWriteOps } from './view-config'
import type { Kernel } from '../kernel'
import { makeProblem } from '../proto'
import type { Instrument, Position } from '../proto'
import { KernelError } from '../util/errors'
import { digestOf } from '../util/hash'
import type { OpContext, OpParams, OpRegistry } from './router'

type RecordKind = RecordsQueryParams['kind']
interface Filters { kind: RecordKind; accountId?: string; instrumentId?: string; actorType?: OriginActorType; actor?: string; sinceTs?: number; untilTs?: number }
interface Cursor { v: 1; kind: RecordKind; filters: string; ts: number; key: string | number }
const bad = (message: string): never => { throw new KernelError(makeProblem('INVALID_PARAMS', message)) }
const unavailable = (message: string): never => { throw new KernelError(makeProblem('DATA_UNAVAILABLE', message)) }

function normalizeFilters(p: OpParams): { filters: Filters; limit: number; cursor?: string } {
  if (p.kind !== 'fill' && p.kind !== 'order' && p.kind !== 'funding') bad('kind must be fill, order, or funding')
  const filters: Filters = { kind: p.kind }
  for (const key of ['accountId', 'instrumentId'] as const) {
    const value = p[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim()) bad(`${key} must be a non-empty string`)
    filters[key] = value.trim()
  }
  if (p.actorType !== undefined) {
    if (typeof p.actorType !== 'string' || !(ORIGIN_ACTOR_TYPES as readonly string[]).includes(p.actorType)) bad('actorType is invalid')
    filters.actorType = p.actorType as OriginActorType
  }
  if (p.actor !== undefined) {
    if (typeof p.actor !== 'string' || !p.actor.trim()) bad('actor must be a non-empty string')
    filters.actor = p.actor.trim()
  }
  for (const key of ['sinceTs', 'untilTs'] as const) {
    const value = p[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) bad(`${key} must be a non-negative safe integer`)
    filters[key] = value
  }
  if (filters.sinceTs !== undefined && filters.untilTs !== undefined && filters.sinceTs > filters.untilTs) bad('sinceTs must not exceed untilTs')
  const limit = p.limit === undefined ? 100 : p.limit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) bad('limit must be an integer in 1..500')
  let cursor: string | undefined
  if (p.cursor !== undefined) {
    if (typeof p.cursor !== 'string' || !p.cursor) bad('cursor must be a non-empty string')
    cursor = p.cursor
  }
  return { filters, limit, ...(cursor === undefined ? {} : { cursor }) }
}

function filterDigest(filters: Filters): string {
  return digestOf({
    kind: filters.kind, accountId: filters.accountId ?? null, instrumentId: filters.instrumentId ?? null,
    actorType: filters.actorType ?? null, sinceTs: filters.sinceTs ?? null, untilTs: filters.untilTs ?? null,
  })
}

function decodeCursor(token: string, filters: Filters): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length % 4 === 1) return bad('cursor is malformed')
  let json: string
  let value: Partial<Cursor>
  try {
    json = Buffer.from(token, 'base64url').toString('utf8')
    value = JSON.parse(json) as Partial<Cursor>
  } catch {
    return bad('cursor is malformed')
  }
  if (Buffer.from(json, 'utf8').toString('base64url') !== token) return bad('cursor is not canonical')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('cursor is malformed')
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'filters,key,kind,ts,v' || value.v !== 1 || value.kind !== filters.kind || value.filters !== filterDigest(filters)) return bad('cursor does not match this query')
  if (typeof value.ts !== 'number' || !Number.isSafeInteger(value.ts) || value.ts < 0) return bad('cursor timestamp is invalid')
  if (filters.kind === 'funding') {
    if (typeof value.key !== 'number' || !Number.isSafeInteger(value.key) || value.key < 0) return bad('cursor key is invalid')
  } else if (typeof value.key !== 'string' || !value.key) return bad('cursor key is invalid')
  return value as Cursor
}

function encodeCursor(filters: Filters, ts: number, key: string | number): string {
  const value: Cursor = { v: 1, kind: filters.kind, filters: filterDigest(filters), ts, key }
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function addCommonFilters(where: string[], args: Array<string | number>, filters: Filters, columns: { accountId: string; instrumentId: string; ts: string; actorType?: string; actor?: string }): void {
  if (filters.accountId !== undefined) { where.push(`${columns.accountId}=?`); args.push(filters.accountId) }
  if (filters.instrumentId !== undefined) { where.push(`${columns.instrumentId}=?`); args.push(filters.instrumentId) }
  if (filters.sinceTs !== undefined) { where.push(`${columns.ts}>=?`); args.push(filters.sinceTs) }
  if (filters.untilTs !== undefined) { where.push(`${columns.ts}<?`); args.push(filters.untilTs) }
  if (filters.actorType !== undefined && columns.actorType) { where.push(`${columns.actorType}=?`); args.push(filters.actorType) }
  if (filters.actor !== undefined && columns.actor) { where.push(`${columns.actor}=?`); args.push(filters.actor) }
}

function queryRecords(k: Kernel, filters: Filters, limit: number, token?: string): RecordsQueryView {
  const cursor = token === undefined ? undefined : decodeCursor(token, filters)
  const args: Array<string | number> = []
  const where: string[] = []
  const page: Array<string | number> = []
  const limitPlusOne = limit + 1
  let rows: Array<Record<string, unknown>>

  if (filters.kind === 'fill') {
    addCommonFilters(where, args, filters, { accountId: 'f.account_id', instrumentId: 'f.instrument_id', ts: 'f.ts', actorType: "json_extract(o.doc,'$.origin.actorType')", actor: "json_extract(o.doc,'$.origin.actor')" })
    const total = cursor ? undefined : Number((k.db.prepare(`SELECT COUNT(*) AS n FROM fills f LEFT JOIN orders o ON o.order_id=f.order_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args) as { n: number }).n)
    if (cursor) { where.push('(f.ts < ? OR (f.ts = ? AND f.fill_id < ?))'); page.push(cursor.ts, cursor.ts, cursor.key as string) }
    const sql = `SELECT f.doc AS fill_doc, o.doc AS order_doc,
      (SELECT l.ticket FROM ledger l WHERE l.proposal_id=o.proposal_id AND l.ticket IS NOT NULL
       AND trim(l.ticket,' '||char(9)||char(10)||char(11)||char(12)||char(13))<>''
       ORDER BY l.seq ASC LIMIT 1) AS ticket
      FROM fills f LEFT JOIN orders o ON o.order_id=f.order_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY f.ts DESC, f.fill_id DESC LIMIT ?`
    rows = k.db.prepare(sql).all(...args, ...page, limitPlusOne) as Array<Record<string, unknown>>
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const items = selected.map((row) => {
      const fill = JSON.parse(String(row.fill_doc)) as Fill
      const order = row.order_doc === null ? undefined : JSON.parse(String(row.order_doc)) as Order
      return {
        ...fill,
        origin: order?.origin ?? null,
        ...(order?.proposalId ? { proposalId: order.proposalId } : {}),
        ...(typeof row.ticket === 'string' && row.ticket.trim().length > 0 ? { ticket: row.ticket } : {}),
      }
    })
    const last = items.at(-1)
    return { items, ...(hasMore && last ? { next: encodeCursor(filters, last.ts, String(last.fillId)) } : {}), ...(total === undefined ? {} : { total }) }
  }

  if (filters.kind === 'order') {
    addCommonFilters(where, args, filters, { accountId: 'account_id', instrumentId: 'instrument_id', ts: 'created_at', actorType: "json_extract(doc,'$.origin.actorType')", actor: "json_extract(doc,'$.origin.actor')" })
    const total = cursor ? undefined : Number((k.db.prepare(`SELECT COUNT(*) AS n FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args) as { n: number }).n)
    if (cursor) { where.push('(created_at < ? OR (created_at = ? AND order_id < ?))'); page.push(cursor.ts, cursor.ts, cursor.key as string) }
    const sql = `SELECT doc FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, order_id DESC LIMIT ?`
    rows = k.db.prepare(sql).all(...args, ...page, limitPlusOne) as Array<Record<string, unknown>>
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const items = selected.map((row) => JSON.parse(String(row.doc)) as Order)
    const last = items.at(-1)
    return { items, ...(hasMore && last ? { next: encodeCursor(filters, last.createdAt, last.orderId) } : {}), ...(total === undefined ? {} : { total }) }
  }

  where.push("type='funding'")
  addCommonFilters(where, args, filters, { accountId: 'account_id', instrumentId: 'instrument_id', ts: 'ts', actorType: "json_extract(entry,'$.origin.actorType')", actor: "json_extract(entry,'$.origin.actor')" })
  const total = cursor ? undefined : Number((k.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n)
  if (cursor) { where.push('(ts < ? OR (ts = ? AND seq < ?))'); page.push(cursor.ts, cursor.ts, cursor.key as number) }
  const sql = `SELECT entry, ts, seq FROM ledger WHERE ${where.join(' AND ')} ORDER BY ts DESC, seq DESC LIMIT ?`
  rows = k.db.prepare(sql).all(...args, ...page, limitPlusOne) as Array<Record<string, unknown>>
  const hasMore = rows.length > limit
  const selected = rows.slice(0, limit)
  const items = selected.map((row) => JSON.parse(String(row.entry)) as LedgerEntry)
  const last = selected.at(-1)
  return { items, ...(hasMore && last ? { next: encodeCursor(filters, Number(last.ts), Number(last.seq)) } : {}), ...(total === undefined ? {} : { total }) }
}

interface LabFilters { stage?: Experiment['stage']; ownerType?: OriginActorType }
interface LabCursor { v: 1; filters: string; updatedAt: number; id: string }

function normalizeLabFilters(p: OpParams): { filters: LabFilters; limit: number; cursor?: string } {
  const filters: LabFilters = {}
  if (p.stage !== undefined) {
    if (typeof p.stage !== 'string' || !(EXPERIMENT_STAGES as readonly string[]).includes(p.stage)) bad('stage is invalid')
    filters.stage = p.stage as Experiment['stage']
  }
  if (p.ownerType !== undefined) {
    if (typeof p.ownerType !== 'string' || !(ORIGIN_ACTOR_TYPES as readonly string[]).includes(p.ownerType)) bad('ownerType is invalid')
    filters.ownerType = p.ownerType as OriginActorType
  }
  const limit = p.limit === undefined ? 20 : p.limit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) bad('limit must be an integer in 1..500')
  let cursor: string | undefined
  if (p.cursor !== undefined) {
    if (typeof p.cursor !== 'string' || !p.cursor) bad('cursor must be a non-empty string')
    cursor = p.cursor
  }
  return { filters, limit, ...(cursor === undefined ? {} : { cursor }) }
}

function labFilterDigest(filters: LabFilters): string {
  return digestOf({ method: 'lab.list', stage: filters.stage ?? null, ownerType: filters.ownerType ?? null })
}

function decodeLabCursor(token: string, filters: LabFilters): LabCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length % 4 === 1) return bad('cursor is malformed')
  let json: string
  let value: Partial<LabCursor>
  try {
    json = Buffer.from(token, 'base64url').toString('utf8')
    value = JSON.parse(json) as Partial<LabCursor>
  } catch { return bad('cursor is malformed') }
  if (Buffer.from(json, 'utf8').toString('base64url') !== token || !value || typeof value !== 'object' || Array.isArray(value)) return bad('cursor is malformed')
  if (Object.keys(value).sort().join(',') !== 'filters,id,updatedAt,v' || value.v !== 1 || value.filters !== labFilterDigest(filters)) return bad('cursor does not match this query')
  if (typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || typeof value.id !== 'string' || !value.id) return bad('cursor key is invalid')
  return value as LabCursor
}

function encodeLabCursor(filters: LabFilters, item: Experiment): string {
  const value: LabCursor = { v: 1, filters: labFilterDigest(filters), updatedAt: item.updatedAt, id: item.experimentId }
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function labList(k: Kernel, p: OpParams): LabListView {
  const { filters, limit, cursor: token } = normalizeLabFilters(p)
  const cursor = token === undefined ? undefined : decodeLabCursor(token, filters)
  const all = k.lab.all()
    .filter((item) => (filters.stage === undefined || item.stage === filters.stage) && (filters.ownerType === undefined || item.owner?.actorType === filters.ownerType))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.experimentId < b.experimentId ? 1 : a.experimentId > b.experimentId ? -1 : 0))
  const after = cursor ? all.filter((item) => item.updatedAt < cursor.updatedAt || item.updatedAt === cursor.updatedAt && item.experimentId < cursor.id) : all
  const items = after.slice(0, limit + 1)
  const hasMore = items.length > limit
  const selected = items.slice(0, limit)
  const last = selected.at(-1)
  return { items: selected, ...(hasMore && last ? { next: encodeLabCursor(filters, last) } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function strategyFailure(engineId: string, problem: EngineStrategyFailureView['problem']): EngineStrategyFailureView {
  return { engineId, unavailable: true, problem }
}

function strategyUnavailable(engineId: string, method: string): EngineStrategyFailureView {
  return strategyFailure(engineId, makeProblem('DATA_UNAVAILABLE', `${method} returned incomplete data`))
}

function strategyProblem(engineId: string, method: string, error: unknown): EngineStrategyFailureView {
  if (error instanceof KernelError) return strategyFailure(engineId, error.problem)
  return strategyUnavailable(engineId, method)
}

function reportedStrategyFailure(engineId: string, method: string, value: unknown): EngineStrategyFailureView | undefined {
  if (!isRecord(value) || value.ok !== false) return undefined
  if (validateProblem(value.problem).ok) return strategyFailure(engineId, value.problem as EngineStrategyFailureView['problem'])
  return strategyFailure(engineId, makeProblem('DATA_UNAVAILABLE', `${method} reported failure`))
}

function scalarParams(value: unknown): value is StrategyInstance['params'] {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean')
}

function instanceProblem(value: unknown): StrategyInstance['error'] | undefined {
  if (value === undefined) return undefined
  return validateProblem(value).ok ? value as StrategyInstance['error'] : undefined
}

async function engineStrategies(k: Kernel, p: OpParams): Promise<EngineStrategiesView> {
  let engineIds: string[]
  if (p.engineId !== undefined) {
    if (typeof p.engineId !== 'string' || !p.engineId.trim()) bad('engineId must be a non-empty string')
    const id = p.engineId.trim()
    if (!k.engines.status().some((engine) => engine.id === id) || !k.gep.isReady(id)) throw new KernelError(makeProblem('VENUE_UNAVAILABLE', `engine ${id} is not ready`))
    engineIds = [id]
  } else {
    engineIds = k.engines.status().filter((engine) => engine.enabled && engine.state === 'ready' && k.gep.isReady(engine.id)).map((engine) => engine.id)
  }

  const rows: Array<EngineStrategyView | EngineStrategyFailureView> = []
  for (const engineId of engineIds) {
    let list: unknown
    let status: unknown
    try {
      ;[list, status] = await Promise.all([
        k.gep.callEngine(engineId, 'strategy.list', {}), k.gep.callEngine(engineId, 'strategy.status', {}),
      ])
    } catch (error) {
      rows.push(strategyProblem(engineId, 'strategy.list/status', error))
      continue
    }
    const listFailure = reportedStrategyFailure(engineId, 'strategy.list', list)
    const statusFailure = reportedStrategyFailure(engineId, 'strategy.status', status)
    if (listFailure || statusFailure) { rows.push(listFailure ?? statusFailure!); continue }
    if (!isRecord(list) || !Array.isArray(list.strategies)) { rows.push(strategyUnavailable(engineId, 'strategy.list')); continue }
    if (!isRecord(status) || !Array.isArray(status.instances)) { rows.push(strategyUnavailable(engineId, 'strategy.status')); continue }
    const strategies = list.strategies as unknown[]
    const instances = status.instances as unknown[]
    let failed = false
    const engineRows: EngineStrategyView[] = []
    for (const raw of instances) {
      if (!isRecord(raw) || typeof raw.instanceId !== 'string' || !raw.instanceId || typeof raw.strategyId !== 'string' || !raw.strategyId ||
        typeof raw.accountId !== 'string' || !raw.accountId || !['running', 'stopped', 'error', 'starting'].includes(String(raw.status)) || !scalarParams(raw.params)) {
        failed = true
        break
      }
      const listed = strategies.find((item) => isRecord(item) && item.id === raw.strategyId)
      if (!isRecord(listed) || typeof listed.version !== 'string' || !listed.version) { failed = true; break }
      const problemValue = instanceProblem(raw.error)
      if (raw.error !== undefined && problemValue === undefined) { failed = true; break }
      const lastFill = k.db.prepare(`SELECT MAX(f.ts) AS ts FROM fills f JOIN orders o ON o.order_id=f.order_id
        WHERE json_extract(o.doc,'$.origin.causation.engineId')=? AND json_extract(o.doc,'$.origin.causation.instanceId')=?`).get(engineId, raw.instanceId) as { ts?: number | null }
      const experimentIds = new Set<string>()
      for (const experiment of k.lab.all()) for (const run of experiment.runs ?? []) {
        if (run.executor?.kind === 'engine' && run.executor.engineId === engineId && run.executor.instanceId === raw.instanceId) experimentIds.add(experiment.experimentId)
      }
      engineRows.push({
        engineId, instanceId: raw.instanceId as EngineStrategyView['instanceId'], strategyId: raw.strategyId,
        version: listed.version, accountId: raw.accountId as EngineStrategyView['accountId'], state: raw.status as EngineStrategyView['state'],
        params: raw.params, ...(problemValue ? { problem: problemValue } : {}),
        ...(typeof lastFill.ts === 'number' && Number.isSafeInteger(lastFill.ts) ? { lastFillTs: lastFill.ts } : {}),
        ...(experimentIds.size === 1 ? { experimentId: [...experimentIds][0] as EngineStrategyView['experimentId'] } : {}),
      })
    }
    if (failed) rows.push(strategyUnavailable(engineId, 'strategy.status'))
    else rows.push(...engineRows)
  }
  return rows
}

/** strategy.params 的 JSON Schema → 界面表单字段：按 properties 的键序；x-hidden 的丢掉；size（type:'string'）给 text。 */
function catalogParams(value: unknown): EngineCatalogParam[] {
  const props = isRecord(value) && isRecord(value.schema) && isRecord(value.schema.properties) ? value.schema.properties : {}
  const out: EngineCatalogParam[] = []
  for (const [key, raw] of Object.entries(props)) {
    if (!isRecord(raw) || raw['x-hidden'] === true) continue
    const options = Array.isArray(raw.enum) ? raw.enum.filter((x): x is string => typeof x === 'string') : null
    const type: EngineCatalogParam['type'] = options ? 'select' : raw.type === 'integer' ? 'integer' : raw.type === 'number' ? 'number' : raw.type === 'boolean' ? 'boolean' : 'text'
    const d = raw.default
    const param: EngineCatalogParam = { key, label: typeof raw.title === 'string' && raw.title ? raw.title : key, type, default: typeof d === 'number' || typeof d === 'boolean' || typeof d === 'string' ? d : null }
    if (typeof raw.minimum === 'number') param.min = raw.minimum
    if (typeof raw.maximum === 'number') param.max = raw.maximum
    if (typeof raw['x-step'] === 'number') param.step = raw['x-step']
    if (options) param.options = options
    if (typeof raw.description === 'string' && raw.description) param.help = raw.description
    out.push(param)
  }
  return out
}

const MAX_CATALOG = 40
/** engine.catalog：每个就绪引擎已加载的策略 + 表单用参数。只读；某个策略取不到参数就给空表，不挡列表。 */
async function engineCatalog(k: Kernel): Promise<EngineCatalogView> {
  const rows: EngineCatalogView = []
  const ready = k.engines.status().filter((engine) => engine.enabled && engine.state === 'ready' && k.gep.isReady(engine.id)).map((engine) => engine.id)
  for (const engineId of ready) {
    let list: unknown
    try { list = await k.gep.callEngine(engineId, 'strategy.list', {}) } catch (error) { rows.push(strategyProblem(engineId, 'strategy.list', error)); continue }
    const failure = reportedStrategyFailure(engineId, 'strategy.list', list)
    if (failure) { rows.push(failure); continue }
    if (!isRecord(list) || !Array.isArray(list.strategies)) { rows.push(strategyUnavailable(engineId, 'strategy.list')); continue }
    const strategies: EngineCatalogStrategy[] = []
    for (const s of list.strategies.slice(0, MAX_CATALOG)) {
      if (!isRecord(s) || typeof s.id !== 'string' || !s.id) continue
      let params: EngineCatalogParam[] = []
      try { params = catalogParams(await k.gep.callEngine(engineId, 'strategy.params', { strategyId: s.id })) } catch { /* 参数拿不到 = 空表，不挡列表 */ }
      strategies.push({
        id: s.id, name: typeof s.name === 'string' && s.name ? s.name : s.id, ...(typeof s.nameZh === 'string' && s.nameZh ? { nameZh: s.nameZh } : {}),
        version: typeof s.version === 'string' ? s.version : '', desc: typeof s.desc === 'string' ? s.desc : '',
        tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [], params,
      })
    }
    rows.push({ engineId, strategies })
  }
  return rows
}

/**
 * portfolio.analysis：一个口径（实盘 / 纸面，永不合并）下全部非影子账户的持仓 → 场所 / 策略 / 标的三张表。只读、不写账本。
 * 取不到的（标的元数据、标记价、汇率）列进 missing 并从汇总里剔除，不当 0；一笔都估不了 = unavailable + 原因。
 */
async function portfolioAnalysis(k: Kernel, p: OpParams): Promise<PortfolioAnalysisResult> {
  if (p.scope !== undefined && p.scope !== 'live' && p.scope !== 'paper') bad('scope must be live or paper')
  const all = k.accounts.list().filter((a) => a.mode === 'live' || a.mode === 'paper')
  const scopes = (['live', 'paper'] as const).filter((s) => all.some((a) => a.mode === s))
  const scope = (p.scope as 'live' | 'paper' | undefined) ?? scopes[0] ?? 'paper'
  const accounts = all.filter((a) => a.mode === scope)
  const byId = new Map<string, Instrument>(k.bus.instruments().map((i) => [i.instrumentId, i]))
  const positions: Position[] = []
  const missing: string[] = []
  for (const a of accounts) {
    try { positions.push(...(await k.bus.snapshot(a, { maxAgeMs: 3000 })).positions) } catch { missing.push(`snapshot_unavailable: ${a.alias}`) }
  }
  // 计价币 = 持仓报价币的众数（平手取字典序最小）；没有持仓 = USD
  const votes = new Map<string, number>()
  for (const q of positions) { const quote = byId.get(q.instrumentId)?.quote; if (quote) votes.set(quote, (votes.get(quote) ?? 0) + 1) }
  const ccy = [...votes.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? 'USD'
  const usable: Position[] = []
  const instruments: Instrument[] = []
  for (const q of positions) {
    const ins = byId.get(q.instrumentId)
    if (!ins) { missing.push(`unknown_instrument: ${q.instrumentId}`); continue }
    if (ins.settlement !== 'linear') { missing.push(`unsupported_settlement: ${q.instrumentId}`); continue }
    if (!(Number(q.markPrice) > 0)) { missing.push(`missing_price: ${q.instrumentId}`); continue }
    if (ins.quote !== ccy) { missing.push(`missing_fx: ${ins.quote}/${ccy}`); continue }
    usable.push(q)
    if (!instruments.includes(ins)) instruments.push(ins)
  }
  if (!usable.length && missing.length) return { unavailable: true, details: missing }
  // 策略归因：账户上恰好一个运行中的实例才标给它，否则记 unassigned（不猜）
  const running = new Map<string, Set<string>>()
  if (usable.length) for (const row of await engineStrategies(k, {})) {
    if ('unavailable' in row || row.state !== 'running') continue
    running.set(row.accountId, (running.get(row.accountId) ?? new Set()).add(row.strategyId))
  }
  const strategyTags = Object.fromEntries([...running].filter(([, ids]) => ids.size === 1).map(([id, ids]) => [id, [...ids][0]!]))
  let a: ReturnType<typeof analyzePortfolio>
  try {
    a = analyzePortfolio({ positions: usable, instruments, valuationCcy: ccy, prices: staticPriceSource(Object.fromEntries(usable.map((q) => [q.instrumentId, q.markPrice]))), strategyTags, onMissingPrice: 'skip' })
  } catch (error) {
    if (error instanceof PortfolioError) return { unavailable: true, details: [...error.details, ...missing] }
    throw error
  }
  const share = (b: { key: string; exposure: Decimal; weight: Decimal }) => ({ key: b.key, exposure: b.exposure, weight: b.weight })
  return {
    scope, scopes: [...scopes], valuationCcy: ccy, accounts: accounts.length, gross: a.exposure.totals.gross,
    byVenue: a.concentration.byVenue.buckets.map(share),
    byStrategy: a.attribution.byStrategy.map((b) => ({ key: b.key, realized: b.realized, unrealized: b.unrealized, funding: b.funding, total: b.total })),
    byInstrument: a.concentration.byInstrument.buckets.map(share),
    missing: [...missing, ...a.valuation.unpriced.map((id) => `missing_price: ${id}`)],
  }
}

async function labGet(k: Kernel, ctx: OpContext, p: OpParams): Promise<LabGetView> {
  if (typeof p.experimentId !== 'string' || !p.experimentId.trim()) bad('experimentId is required')
  const experimentId = p.experimentId.trim()
  const experiment = await k.lab.handle('get', { experimentId }, ctx.actor) as Experiment
  const runSummaries = k.lab.runTable.all().filter((run) => run.experimentId === experimentId)
  const intervals = (experiment.runs ?? []).flatMap((run) => run.accountId ? [{
    accountId: run.accountId, from: Math.max(run.from, run.attachedAt ?? run.from), to: run.to ?? k.clock.now(),
  }] : [])
  const bySeq = new Map<number, ForwardSnapshot>()
  for (const entry of k.ledger.iterate()) {
    if (entry.type !== 'position.snapshot' || entry.payload?.lab !== true || entry.payload?.kind !== 'daily') continue
    const accountId = entry.subject.accountId
    const at = entry.payload.at
    if (typeof accountId !== 'string' || typeof at !== 'number' || !Number.isSafeInteger(at) ||
      typeof entry.payload.equity !== 'string' || typeof entry.payload.unrealizedPnl !== 'string' || typeof entry.payload.valuationCcy !== 'string') continue
    if (!intervals.some((run) => run.accountId === accountId && at >= run.from && at <= run.to)) continue
    bySeq.set(entry.seq, { seq: entry.seq, accountId: accountId as ForwardSnapshot['accountId'], at, recordedAt: entry.recordedAt, attestation: entry.attestation, kind: 'daily', equity: entry.payload.equity as never, unrealizedPnl: entry.payload.unrealizedPnl as never, valuationCcy: entry.payload.valuationCcy })
  }
  const forwardSnapshots = [...bySeq.values()].sort((a, b) => a.at - b.at || a.seq - b.seq)
  return { ...experiment, runSummaries, forwardSnapshots }
}

function labRun(k: Kernel, p: OpParams): BacktestResult {
  if (typeof p.experimentId !== 'string' || !p.experimentId.trim() || typeof p.runId !== 'string' || !p.runId.trim()) bad('experimentId and runId are required')
  const experimentId = p.experimentId.trim()
  const runId = p.runId.trim()
  k.lab.load(experimentId)
  const run = k.docs.get<LabRun>('lab-run', runId)
  const detail = k.docs.get<{ result?: BacktestResult }>('lab-run-detail', runId)
  if (!run || run.experimentId !== experimentId || run.status !== 'done' || !detail?.result || !isRecord(detail.result)) {
    throw new KernelError(makeProblem('EXPERIMENT_EVIDENCE_INCOMPLETE', 'Completed result for this experiment run is unavailable'))
  }
  return detail.result
}

export function registerViewOps(k: Kernel, ops: OpRegistry): void {
  ops.register('account.equity_history', { auth: 'human', kind: 'query' }, (_ctx, p) => {
    if (typeof p.accountId !== 'string' || !p.accountId.trim()) bad('accountId is required')
    const accountId = p.accountId.trim()
    k.accounts.get(accountId)
    if (!Number.isSafeInteger(p.from) || (p.from as number) < 0 || !Number.isSafeInteger(p.to) || (p.to as number) < 0 || (p.from as number) >= (p.to as number)) bad('from and to must be non-negative safe integers with from < to')
    if (p.step !== '1m' && p.step !== '1h' && p.step !== '1d') bad('step must be 1m, 1h, or 1d')
    const params: EquityHistoryParams = { accountId: accountId as EquityHistoryParams['accountId'], from: p.from as EquityHistoryParams['from'], to: p.to as EquityHistoryParams['to'], step: p.step }
    return queryEquityHistory(k.db, params.accountId, params.from, params.to, params.step)
  })

  ops.register('account.assets', { auth: 'human', kind: 'query' }, async (_ctx, p) => {
    if (typeof p.accountId !== 'string' || !p.accountId.trim()) bad('accountId is required')
    const account = k.accounts.get(p.accountId.trim())
    try {
      const snapshot = await k.bus.routeFor(account).accountState(k.bus.accountRef(account)) as AccountSnapshot & { truncated?: boolean; ok?: boolean }
      if (!snapshot || snapshot.ok === false || snapshot.stale === true || snapshot.truncated === true || !Array.isArray(snapshot.balances) || typeof snapshot.ts !== 'number' || !Number.isSafeInteger(snapshot.ts)) {
        unavailable('account snapshot is unavailable or incomplete')
      }
      return { accountId: account.accountId, balances: snapshot.balances, margin: snapshot.margin ?? null, ts: snapshot.ts } satisfies AccountAssetsView
    } catch (error) {
      if (error instanceof KernelError) throw error
      const failure = connectorOperationError(error, 'account.assets', account.venue)
      throw new KernelError(failure.problem)
    }
  })

  ops.register('records.query', { auth: 'human', kind: 'query' }, (_ctx, p) => {
    const { filters, limit, cursor } = normalizeFilters(p)
    return queryRecords(k, filters, limit, cursor)
  })

  ops.register('engine.strategies', { auth: 'human', kind: 'query' }, (_ctx, p) => engineStrategies(k, p))
  ops.register('engine.catalog', { auth: 'human', kind: 'query' }, () => engineCatalog(k))
  ops.register('portfolio.analysis', { auth: 'human', kind: 'query' }, (_ctx, p) => portfolioAnalysis(k, p))
  ops.register('lab.list', { auth: 'human', kind: 'query' }, (_ctx, p) => labList(k, p))
  ops.register('lab.get', { auth: 'human', kind: 'query' }, (ctx, p) => labGet(k, ctx, p))
  ops.register('lab.run', { auth: 'human', kind: 'query' }, (_ctx, p) => labRun(k, p))

  ops.register('config.view', { auth: 'session', kind: 'query' }, () => projectConfigView(k))
  registerConfigWriteOps(k, ops)
}
