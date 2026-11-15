// SPDX-License-Identifier: CPAL-1.0
// 审计账本 gitrader-ledger/1：只追加、哈希链、检查点、导出（契约 §6）。
// 只追加由三层保证：API 里没有更新 / 删除；SQLite 触发器拒绝 UPDATE / DELETE；verify() 重算哈希链能发现绕过触发器的篡改。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GENESIS_PREV_HASH, LEDGER_ENTRY_TYPE_LIST, LEDGER_SCHEMA, ORIGIN_VIA, computeEntryHash, deriveOriginActorType, computePayloadHash, findForbiddenLedgerKeys,
} from './proto'
import type {
  LedgerAttestation, LedgerEngineRef, LedgerEntry, LedgerEntryType, LedgerPrecheck, LedgerSubject, LedgerVenueRef, Origin, RuleHit,
} from './proto'
import { metaGet, metaSet, tx } from './db'
import { makeProblem } from './proto'
import { KernelError } from './util/errors'
import type { Db } from './db'
import type { EventBus } from './events'
import { InstallKey } from './install-key'
import { checkpointSigningData, exportSigningData, verifyEntries } from './ledger-verify'
import type { VerifyResult } from './ledger-verify'
import { findSecretKeys, fail } from './util/errors'
import { sha256Hex, digestOf } from './util/hash'
import { newId } from './util/ids'
import { systemOrigin } from './util/origin'
import { writeFileAtomic } from './util/fsperm'
import type { Clock } from './util/clock'

export interface AppendInput {
  type: LedgerEntryType
  origin: Origin
  subject: LedgerSubject
  ts?: number
  precheck?: LedgerPrecheck
  ruleHits?: RuleHit[]
  payload?: Record<string, unknown>
  attestation?: LedgerAttestation
  venueRef?: LedgerVenueRef
  engineRef?: LedgerEngineRef
}

/** Local publication buffer owned only by TradingService's confirmed-fill transaction. */
export interface LedgerDeferredEffects {
  entries: LedgerEntry[]
  checkpointCursor: { seq: number; ts: number }
}

export interface LedgerQuery {
  types?: string[]
  accountId?: string
  instrumentId?: string
  orderId?: string
  proposalId?: string
  mandateId?: string
  ticket?: string
  takeoverId?: string
  actor?: string
  fromSeq?: number
  toSeq?: number
  afterSeq?: number
  beforeSeq?: number
  sinceTs?: number
  untilTs?: number
  limit?: number
  order?: 'asc' | 'desc'
}

const TYPES = new Set<string>(LEDGER_ENTRY_TYPE_LIST)
const ACTOR_RE = /^(user|agent|engine|workflow|strategy|plugin|system|mandate|venue):.+$/
const NEEDS_PRECHECK = new Set<string>(['order.intent', 'risk.precheck', 'risk.denied'])
const NEEDS_RULEHITS = new Set<string>(['protector.triggered', 'takeover.requested', 'takeover.applied', 'takeover.completed', 'takeover.failed'])
/** 条目 ts 只认内核时间：调用方给的 ts 不得早于内核时钟超过这个容差（拒绝带过去时间的补录），也不得在未来超过 5 s。 */
export const LEDGER_TS_PAST_TOLERANCE_MS = 60_000
export const LEDGER_TS_FUTURE_TOLERANCE_MS = 5_000
/** 回放 / 回测的产物永远不混进前向账本：这些类型只允许 backtest.completed 与实验类条目（带 source 标记）。 */
const REPLAY_SOURCES = new Set(['replay', 'backtest'])
const REPLAY_ALLOWED_TYPES = new Set<string>(['backtest.completed', 'experiment.created', 'experiment.updated', 'experiment.stage_changed', 'note', 'annotation'])
const CHECKPOINT_EVERY = 1000
const CHECKPOINT_EVERY_MS = 3_600_000

const SYSTEM_ORIGIN = (tool: string): Origin => systemOrigin(tool)

export interface ExportOptions {
  dir: string
  exportedBy: Origin
  fromSeq?: number
  toSeq?: number
  /** 'payload' = 去掉所有载荷，只留 payloadHash。 */
  redaction?: 'none' | 'payload'
  /** 过滤导出：范围内全部条目的头部 + 选中类型的载荷——链仍连续可验。 */
  payloadTypes?: string[]
  markdown?: boolean
}

/** 本机本地时间 YYYY-MM-DD HH:mm:ss（给人看的账单 / 交易记录用；账本里的时间戳仍是 UTC 毫秒）。 */
export function localTime(ms: number): string {
  const t = new Date(ms)
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`
}
/** 本地时间戳 YYYYMMDD-HHmm（seconds=true 时 YYYYMMDD-HHmmss），用于导出目录 / 账单文件名。 */
export function localStamp(ms: number, seconds = false): string {
  const t = new Date(ms)
  return `${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}-${pad2(t.getHours())}${pad2(t.getMinutes())}${seconds ? pad2(t.getSeconds()) : ''}`
}
/** 磁盘上的 账单.csv 带 BOM（Excel 双击不乱码）；inline 回包里的字符串不带，前端自己补。 */
export const BOM = String.fromCharCode(0xfeff)
const pad2 = (n: number): string => String(n).padStart(2, '0')
const tzLabel = (ms: number): string => {
  const off = -new Date(ms).getTimezoneOffset()
  const a = Math.abs(off)
  return `UTC${off < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
}
const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
/** 文本列防公式注入：以 = + - @ 开头的非数字文本前加一个单引号。 */
const csvText = (v: string): string => csvCell(/^[=+\-@]/.test(v) ? `'${v}` : v)

export interface ExportManifest {
  schema: 'gitrader-ledger-export/1' | 'gitrader-ledger-export/2'
  fromSeq: number
  toSeq: number
  count: number
  firstPrevHash: string
  lastHash: string
  checkpoints: { seq: number; hash: string; keyId: string; sig: string }[]
  filters: { payloadTypes: string[] | null }
  redaction: 'none' | 'payload'
  installKey: { keyId: string; publicKey: string }
  exportedAt: number
  exportedBy: Origin
  paperReplay?: { source: 'replay'; fixtureDigest: string }
  /** /2：导出时内核链头（取在写 export.created 之前）。 */
  chainHead?: { seq: number; hash: string }
  /** /2：fromSeq 为 0 且 toSeq 到达导出时的链头。 */
  complete?: boolean
  /** /2：安装签名身份对 digestOf(去掉 signature 的 manifest) 的签名。 */
  signature?: { keyId: string; alg: 'ed25519'; sig: string }
}

export class Ledger {
  private gateRenewalReceipts = new Map<string, { entryId: string; accountId: string; aggregate: { count: number; lastAt: number; timing: { assembleUs: number; decideUs: number; protectorUs: number } } }>()
  private lastCheckpoint = { seq: 0, ts: 0 }
  private gateRenewals = new Map<string, { count: number; lastAt: number; timing: { assembleUs: number; decideUs: number; protectorUs: number } }>()

  constructor(private db: Db, private clock: Clock, private events: EventBus, readonly installKey: InstallKey, readonly replay?: { replayFixtureDigest: string }) {
    const savedReplayDigest = metaGet(db, 'paper_replay_fixture_digest')
    if (savedReplayDigest && !replay) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'historical paper replay ledger cannot be opened in normal mode'))
    if (savedReplayDigest && replay && savedReplayDigest !== replay.replayFixtureDigest) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'historical paper replay fixture identity does not match this home'))
    if (!savedReplayDigest && replay) {
      const economicRows = (db.prepare("SELECT COUNT(*) c FROM ledger WHERE type IN ('order.intent','order.placed','order.cancelled','order.expired','order.triggered','fill','funding','liquidation','position.snapshot')").get() as { c: number }).c
      const experimentDocs = (db.prepare("SELECT COUNT(*) c FROM docs WHERE coll LIKE '%experiment%'").get() as { c: number }).c
      if (economicRows > 0 || experimentDocs > 0) throw new KernelError(makeProblem('INVALID_PARAMS', 'paper replay cannot activate on a home with forward trading or experiment history'))
      if (!installKey.isAvailable()) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'historical replay identity cannot be initialized while the install signer is unavailable'))
      tx(db, () => { this.ensureGenesis(); metaSet(db, 'paper_replay_fixture_digest', replay.replayFixtureDigest) })
    } else {
      this.ensureGenesis()
    }
  }

  private ensureGenesis(): void {
    const n = (this.db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c
    const savedKeyId = metaGet(this.db, 'install_key_id')
    const savedPublicKey = metaGet(this.db, 'install_key_pub')
    if ((savedKeyId && !savedPublicKey) || (!savedKeyId && savedPublicKey)
      || (n > 0 && !savedKeyId && !savedPublicKey)
      || (savedKeyId && savedKeyId !== this.installKey.keyId)
      || (savedPublicKey && savedPublicKey !== this.installKey.publicKey)) {
      throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
    }
    if (n === 0 && this.installKey.isAvailable()) {
      let installId = metaGet(this.db, 'install_id')
      if (!installId) { installId = newId('ses'); metaSet(this.db, 'install_id', installId) }
      this.write({
        type: 'checkpoint', origin: SYSTEM_ORIGIN('ledger:genesis'), subject: { orgId: 'org_local' },
        payload: { installId, createdAt: this.clock.now() },
      })
    }
    if (n === 0 && this.installKey.isAvailable() && !savedKeyId && !savedPublicKey) {
      metaSet(this.db, 'install_key_id', this.installKey.keyId)
      metaSet(this.db, 'install_key_pub', this.installKey.publicKey)
    }
    const cp = this.db.prepare(`SELECT seq, ts FROM ledger WHERE type='checkpoint' ORDER BY seq DESC LIMIT 1`).get() as { seq: number; ts: number } | undefined
    if (cp) this.lastCheckpoint = cp
  }

  /** 账户显示名（别名；由内核装配时接上）。账单.csv 的「账户」列用它。 */
  accountLabel?: (accountId: string) => string | undefined

  /** 全账本的 Agent 钥匙名（key.created），被吊销的（key.revoked）加「（已撤销）」。 */
  private agentNames(): Map<string, string> {
    const names = new Map<string, string>()
    const revoked = new Set<string>()
    for (const r of this.db.prepare(`SELECT entry FROM ledger WHERE type IN ('key.created','key.revoked') ORDER BY seq`).all() as { entry: string }[]) {
      const e = JSON.parse(r.entry) as LedgerEntry
      const p = e.payload as { keyId?: string; name?: string } | undefined
      if (!p?.keyId) continue
      if (e.type === 'key.revoked') revoked.add(p.keyId)
      else if (p.name) names.set(p.keyId, p.name)
    }
    for (const id of revoked) if (names.has(id)) names.set(id, `${names.get(id)}（已撤销）`)
    return names
  }

  head(): { seq: number; hash: string } {
    return this.db.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string }
  }

  createDeferredEffects(): LedgerDeferredEffects {
    return { entries: [], checkpointCursor: { ...this.lastCheckpoint } }
  }

  publishDeferredEffects(effects: LedgerDeferredEffects): void {
    for (const entry of effects.entries) {
      if (entry.type === 'checkpoint') this.lastCheckpoint = { seq: entry.seq, ts: entry.ts }
      this.events.publish('ledger.entry', entry)
    }
    effects.entries.length = 0
  }

  restoreGateRenewalsAfterRollback(): void {
    this.settleGateRenewalReceipts()
  }

  append(input: AppendInput, deferred?: LedgerDeferredEffects): LedgerEntry {
    this.settleGateRenewalReceipts()
    const accountId = input.subject.accountId
    const pending = accountId ? this.gateRenewals.get(accountId) : undefined
    const writeInput = pending ? { ...input, payload: { ...(input.payload ?? {}), gateRenewals: structuredClone(pending) } } : input
    const e = this.write(writeInput)
    if (pending && accountId && this.gateRenewals.get(accountId) === pending) {
      this.gateRenewals.delete(accountId)
      if ((this.db as Db & { isTransaction?: boolean }).isTransaction) this.gateRenewalReceipts.set(e.id, { entryId: e.id, accountId, aggregate: structuredClone(pending) })
    }
    if (deferred) deferred.entries.push(e)
    else this.events.publish('ledger.entry', e)
    this.maybeCheckpoint(e, deferred)
    return e
  }

  recordGateRenewal(accountId: string, timing: { assembleUs: number; decideUs: number; protectorUs: number }): void {
    this.settleGateRenewalReceipts()
    const prior = this.gateRenewals.get(accountId)
    const now = this.clock.now()
    this.gateRenewals.set(accountId, {
      count: (prior?.count ?? 0) + 1, lastAt: now,
      timing: {
        assembleUs: (prior?.timing.assembleUs ?? 0) + timing.assembleUs,
        decideUs: (prior?.timing.decideUs ?? 0) + timing.decideUs,
        protectorUs: (prior?.timing.protectorUs ?? 0) + timing.protectorUs,
      },
    })
  }

  private settleGateRenewalReceipts(): void {
    const inTransaction = !!(this.db as Db & { isTransaction?: boolean }).isTransaction
    for (const [id, receipt] of this.gateRenewalReceipts) {
      if (this.getById(receipt.entryId)) {
        if (!inTransaction) this.gateRenewalReceipts.delete(id)
        continue
      }
      const prior = this.gateRenewals.get(receipt.accountId)
      this.gateRenewals.set(receipt.accountId, {
        count: receipt.aggregate.count + (prior?.count ?? 0), lastAt: Math.max(receipt.aggregate.lastAt, prior?.lastAt ?? 0),
        timing: {
          assembleUs: receipt.aggregate.timing.assembleUs + (prior?.timing.assembleUs ?? 0),
          decideUs: receipt.aggregate.timing.decideUs + (prior?.timing.decideUs ?? 0),
          protectorUs: receipt.aggregate.timing.protectorUs + (prior?.timing.protectorUs ?? 0),
        },
      })
      this.gateRenewalReceipts.delete(id)
    }
  }

  private validate(input: AppendInput): void {
    if (!TYPES.has(input.type)) fail('INVALID_PARAMS', `unknown ledger entry type ${String(input.type)}`)
    const o = input.origin
    if (!o || !ACTOR_RE.test(String(o.actor)) || !o.tool || !o.requestId || !(ORIGIN_VIA as readonly string[]).includes(o.via)) {
      fail('INVALID_PARAMS', 'ledger entry requires origin{actor,actorType,tool,requestId,via}')
    }
    if (o.actorType !== deriveOriginActorType(o.actor)) fail('INVALID_PARAMS', `origin.actorType ${String(o.actorType)} does not match actor ${o.actor}`)
    if (!input.subject || Object.keys(input.subject).length === 0) fail('INVALID_PARAMS', 'ledger entry requires at least one subject key')
    if (NEEDS_PRECHECK.has(input.type) && !input.precheck) fail('INVALID_PARAMS', `${input.type} requires precheck`)
    if (input.precheck && input.precheck.verdict !== 'allow' && !(input.ruleHits && input.ruleHits.length > 0)) fail('INVALID_PARAMS', 'verdict != allow requires ruleHits')
    if (NEEDS_RULEHITS.has(input.type) && !Array.isArray(input.ruleHits)) fail('INVALID_PARAMS', `${input.type} requires ruleHits (may be empty)`)
    if (input.ts !== undefined) {
      const now = this.clock.now()
      if (input.ts < now - LEDGER_TS_PAST_TOLERANCE_MS) fail('INVALID_PARAMS', `backdated ledger entry refused: ts ${input.ts} is older than the kernel clock by more than ${LEDGER_TS_PAST_TOLERANCE_MS} ms`)
      if (input.ts > now + LEDGER_TS_FUTURE_TOLERANCE_MS) fail('INVALID_PARAMS', 'ledger entry ts is in the future')
    }
    const pl = input.payload as { source?: unknown; replay?: unknown; mode?: unknown } | undefined
    const replayTagged = !!pl && (pl.replay === true || (typeof pl.source === 'string' && REPLAY_SOURCES.has(pl.source)) || (typeof pl.mode === 'string' && REPLAY_SOURCES.has(pl.mode)))
    if (!this.replay && replayTagged && !REPLAY_ALLOWED_TYPES.has(input.type)) fail('INVALID_PARAMS', `replay/backtest data must never enter the forward ledger (${input.type})`)
    if (REPLAY_ALLOWED_TYPES.has(input.type) && input.type === 'backtest.completed' && !(pl && typeof pl.source === 'string' && REPLAY_SOURCES.has(pl.source))) fail('INVALID_PARAMS', 'backtest.completed must carry payload.source = "backtest" | "replay"')
    const bad = [...findForbiddenLedgerKeys(input.payload), ...findSecretKeys(input.payload), ...findSecretKeys(input.subject)]
    if (bad.length) fail('SECRET_FIELD_REJECTED', `ledger payload must not contain secret or vendor-private fields: ${bad.join(', ')}`)
  }

  private write(input: AppendInput): LedgerEntry {
    const effectiveInput: AppendInput = this.replay ? {
      ...input, payload: { ...(input.payload ?? {}), source: 'replay', fixtureDigest: this.replay.replayFixtureDigest },
    } : input
    this.validate(effectiveInput)
    return tx(this.db, () => {
      const last = this.db.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined
      const seq = last ? last.seq + 1 : 0
      const now = this.clock.now()
      const base = {
        schema: LEDGER_SCHEMA,
        seq,
        id: newId('led', now),
        ts: effectiveInput.ts ?? now,
        recordedAt: now,
        type: effectiveInput.type,
        origin: effectiveInput.origin,
        subject: effectiveInput.subject,
        ...(effectiveInput.precheck ? { precheck: effectiveInput.precheck } : {}),
        ...(effectiveInput.ruleHits ? { ruleHits: effectiveInput.ruleHits } : {}),
        ...(effectiveInput.payload ? { payload: effectiveInput.payload } : {}),
        payloadHash: computePayloadHash(effectiveInput.payload, sha256Hex),
        attestation: effectiveInput.attestation ?? 'kernel-observed',
        ...(effectiveInput.venueRef ? { venueRef: effectiveInput.venueRef } : {}),
        ...(effectiveInput.engineRef ? { engineRef: effectiveInput.engineRef } : {}),
        prevHash: last ? (last.hash as `sha256:${string}`) : GENESIS_PREV_HASH,
      } as Omit<LedgerEntry, 'hash'>
      const entry = { ...base, hash: computeEntryHash(base, sha256Hex) } as LedgerEntry
      const s = entry.subject
      this.db.prepare(
        `INSERT INTO ledger(seq,id,ts,recorded_at,type,actor,account_id,instrument_id,order_id,proposal_id,mandate_id,ticket,takeover_id,entry,hash)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(entry.seq, entry.id, entry.ts, entry.recordedAt, entry.type, entry.origin.actor, s.accountId ?? null, s.instrumentId ?? null,
        s.orderId ?? null, s.proposalId ?? null, s.mandateId ?? null, s.ticket ?? null, s.takeoverId ?? null, JSON.stringify(entry), entry.hash)
      return entry
    })
  }

  private maybeCheckpoint(e: LedgerEntry, deferred?: LedgerDeferredEffects): void {
    if (e.type === 'checkpoint') {
      if (deferred) deferred.checkpointCursor = { seq: e.seq, ts: e.ts }
      else this.lastCheckpoint = { seq: e.seq, ts: e.ts }
      return
    }
    if (!this.installKey.isAvailable()) return
    const cursor = deferred?.checkpointCursor ?? this.lastCheckpoint
    if (e.seq - cursor.seq >= CHECKPOINT_EVERY || e.ts - cursor.ts >= CHECKPOINT_EVERY_MS) this.checkpoint(deferred)
  }

  /** 写一条检查点：用本机安装密钥给"最后一条的哈希"签名。可交给第三方或公开发布做外部锚定。 */
  checkpoint(deferred?: LedgerDeferredEffects): LedgerEntry {
    const h = this.head()
    const sig = this.installKey.sign(checkpointSigningData(h.seq, h.hash))
    const e = this.write({
      type: 'checkpoint', origin: SYSTEM_ORIGIN('ledger:checkpoint'), subject: { orgId: 'org_local' },
      payload: { upToSeq: h.seq, hash: h.hash, keyId: this.installKey.keyId, sig },
    })
    if (deferred) {
      deferred.entries.push(e)
      deferred.checkpointCursor = { seq: e.seq, ts: e.ts }
    } else {
      this.lastCheckpoint = { seq: e.seq, ts: e.ts }
      this.events.publish('ledger.entry', e)
    }
    return e
  }

  get(seq: number): LedgerEntry | undefined {
    const r = this.db.prepare('SELECT entry FROM ledger WHERE seq=?').get(seq) as { entry: string } | undefined
    return r ? (JSON.parse(r.entry) as LedgerEntry) : undefined
  }
  getById(id: string): LedgerEntry | undefined {
    const r = this.db.prepare('SELECT entry FROM ledger WHERE id=?').get(id) as { entry: string } | undefined
    return r ? (JSON.parse(r.entry) as LedgerEntry) : undefined
  }

  /** Find the first full gate payload for a precheck, retaining a header-only fallback. */
  findGate(precheckId: string): LedgerEntry | undefined {
    let headerOnly: LedgerEntry | undefined
    for (const entry of this.iterate()) {
      const subjectPrecheckId = (entry.subject as { precheckId?: string } | undefined)?.precheckId
      if (entry.precheck?.precheckId !== precheckId && subjectPrecheckId !== precheckId) continue
      const payload = (entry as LedgerEntry & { payload?: unknown }).payload
      if (payload !== null && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'gate')) return entry
      headerOnly ??= entry
    }
    return headerOnly
  }

  query(q: LedgerQuery = {}): LedgerEntry[] {
    const where: string[] = []
    const args: (string | number)[] = []
    const eqs: [string, string | undefined][] = [
      ['account_id', q.accountId], ['instrument_id', q.instrumentId], ['order_id', q.orderId], ['proposal_id', q.proposalId],
      ['mandate_id', q.mandateId], ['ticket', q.ticket], ['takeover_id', q.takeoverId], ['actor', q.actor],
    ]
    for (const [col, v] of eqs) if (v !== undefined) { where.push(`${col}=?`); args.push(v) }
    if (q.types?.length) { where.push(`type IN (${q.types.map(() => '?').join(',')})`); args.push(...q.types) }
    const cmps: [string, string, number | undefined][] = [
      ['seq', '>=', q.fromSeq], ['seq', '<=', q.toSeq], ['seq', '>', q.afterSeq], ['seq', '<', q.beforeSeq], ['ts', '>=', q.sinceTs], ['ts', '<=', q.untilTs],
    ]
    for (const [col, op, v] of cmps) if (v !== undefined) { where.push(`${col}${op}?`); args.push(v) }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000)
    const sql = `SELECT entry FROM ledger ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${limit}`
    return (this.db.prepare(sql).all(...args) as { entry: string }[]).map((r) => JSON.parse(r.entry) as LedgerEntry)
  }

  /** 追溯：订单 / 提案 / 票号 / clientOrderId 的全链条目（升序）。 */
  trace(by: { orderId?: string; proposalId?: string; ticket?: string; clientOrderId?: string }): LedgerEntry[] {
    const cloid = by.clientOrderId && /^[0-9a-f]{32}$/.test(by.clientOrderId) ? `%"clientOrderId":"${by.clientOrderId}"%` : '\u0000'
    const rows = this.db.prepare('SELECT entry FROM ledger WHERE order_id=? OR proposal_id=? OR ticket=? OR entry LIKE ? ORDER BY seq ASC LIMIT 1000')
      .all(by.orderId ?? '\u0000', by.proposalId ?? '\u0000', by.ticket ?? '\u0000', cloid) as { entry: string }[]
    return rows.map((r) => JSON.parse(r.entry) as LedgerEntry)
  }

  count(): number { return (this.db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c }

  *iterate(fromSeq = 0, toSeq = Number.MAX_SAFE_INTEGER): Generator<LedgerEntry> {
    const stmt = this.db.prepare('SELECT entry FROM ledger WHERE seq>=? AND seq<=? ORDER BY seq')
    for (const r of stmt.iterate(fromSeq, toSeq) as Iterable<{ entry: string }>) yield JSON.parse(r.entry) as LedgerEntry
  }

  verify(): VerifyResult {
    return verifyEntries(this.iterate(), { publicKeys: { [this.installKey.keyId]: this.installKey.publicKey } })
  }

  export(opts: ExportOptions): ExportManifest {
    // 无签名的导出件挡不住"删尾行再改 manifest"，所以签名身份不可用就拒绝导出。
    if (!this.installKey.isAvailable()) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'ledger export requires the install signing key, which is unavailable'))
    // 链头晚于最后一枚检查点时先补一枚：导出尾部永远带一条刚签的检查点。
    if (this.head().seq > this.lastCheckpoint.seq) this.checkpoint()
    const head = this.head()
    const fromSeq = opts.fromSeq ?? 0
    const toSeq = Math.min(opts.toSeq ?? head.seq, head.seq)
    const redaction = opts.redaction ?? 'none'
    const keep = opts.payloadTypes ? new Set(opts.payloadTypes) : null
    mkdirSync(opts.dir, { recursive: true })
    const lines: string[] = []
    const keyNames = new Map<string, string>()
    if (opts.markdown && redaction !== 'payload' && (!keep || keep.has('key.created'))) {
      for (const e of this.iterate(fromSeq, toSeq)) {
        if (e.type !== 'key.created') continue
        const p = e.payload as { keyId?: string; name?: string } | undefined
        if (p?.keyId && p.name) keyNames.set(p.keyId, p.name)
      }
    }
    const actorCell = (actor: string): string => actor.startsWith('agent:') ? keyNames.get(actor.slice('agent:'.length)) ?? actor : actor
    const subjectCell = (e: LedgerEntry): string => {
      const p = e.payload as { decision?: string; note?: string; ticket?: string; side?: string; size?: string; price?: string; realizedPnl?: string | null } | undefined
      if (e.type === 'proposal.decided') {
        const verb = p?.decision === 'rejected' ? '拒绝' : '批准'
        const ticket = e.subject.ticket ?? p?.ticket
        const base = ticket ? `${verb} ${ticket}` : verb
        return p?.note ? `${base} 理由：${p.note}` : base
      }
      if (e.type === 'fill') {
        const rawSide = p?.side?.toLowerCase()
        const side = rawSide === 'sell' ? '卖出' : rawSide === 'buy' ? '买入' : p?.side ?? ''
        const base = `${side} ${p?.size ?? ''} @ ${p?.price ?? ''}`.trim()
        return p?.realizedPnl !== undefined && p.realizedPnl !== null && p.realizedPnl !== '' ? `${base} 盈亏 ${p.realizedPnl}` : base
      }
      return Object.entries(e.subject).map(([k, v]) => `${k}=${String(v)}`).join(' ')
    }
    const title = this.replay
      ? ['# Gitrader 历史纸面回放交易记录（historical paper replay trade log）', '', `夹具摘要（fixture digest）：${this.replay.replayFixtureDigest}`]
      : ['# Gitrader 交易记录（trade log）']
    const exportedAt = this.clock.now()
    const md: string[] = [...title, '', '检查点：每 1000 条或每 1 小时一个（seq 0 为创世）', '', `| 序号 seq | 时间（本地，${tzLabel(exportedAt)}） | 类型 | 执行方 | 对象 | 命中规则 |`, '|---|---|---|---|---|---|']
    const withBill = !!opts.markdown && redaction !== 'payload' && (!keep || keep.has('fill'))
    const bill: string[] = ['时间,账户,标的,方向,数量,价格,手续费,已实现盈亏,执行方']
    // 执行方 = 该成交所属订单的下单主体（成交条目自己的 origin 多半是场所）：人=你，Agent=钥匙名（吊销的加「（已撤销）」），其余=系统
    let billNames: Map<string, string> | undefined
    const orderActor = new Map<string, string>()
    const actorOfFill = (e: LedgerEntry): string => {
      if (/^(user|agent):/.test(e.origin.actor)) return e.origin.actor
      const oid = e.subject.orderId
      if (!oid) return e.origin.actor
      if (!orderActor.has(oid)) {
        const r = this.db.prepare(`SELECT entry FROM ledger WHERE order_id=? AND type='order.intent' ORDER BY seq LIMIT 1`).get(oid) as { entry: string } | undefined
        orderActor.set(oid, r ? (JSON.parse(r.entry) as LedgerEntry).origin.actor : e.origin.actor)
      }
      return orderActor.get(oid)!
    }
    const executorCell = (e: LedgerEntry): string => {
      const actor = actorOfFill(e)
      if (actor.startsWith('user:')) return '你'
      if (!actor.startsWith('agent:')) return '系统'
      billNames ??= this.agentNames()
      return billNames.get(actor.slice('agent:'.length)) ?? actor
    }
    const checkpoints: ExportManifest['checkpoints'] = []
    let count = 0
    let firstPrev = ''
    let lastHash = ''
    for (const e of this.iterate(fromSeq, toSeq)) {
      const out: LedgerEntry = { ...e }
      if (redaction === 'payload' || (keep && !keep.has(e.type))) delete out.payload
      lines.push(JSON.stringify(out))
      if (count === 0) firstPrev = e.prevHash
      lastHash = e.hash
      count++
      if (e.type === 'checkpoint' && e.seq > 0 && e.payload) {
        const p = e.payload as { keyId: string; sig: string }
        checkpoints.push({ seq: e.seq, hash: e.hash, keyId: p.keyId, sig: p.sig })
      }
      if (opts.markdown) {
        const subj = subjectCell(out).replace(/\|/g, '/')
        const codes = (e.ruleHits ?? []).map((h) => h.code).join(', ')
        md.push(`| ${e.seq} | ${localTime(e.ts)} | ${e.type} | ${actorCell(e.origin.actor)} | ${subj} | ${codes} |`)
      }
      if (withBill && e.type === 'fill' && out.payload) {
        const p = out.payload as { side?: string; size?: string; price?: string; fee?: string; realizedPnl?: string | null }
        const side = p.side?.toLowerCase() === 'sell' ? '卖出' : p.side?.toLowerCase() === 'buy' ? '买入' : p.side ?? ''
        bill.push([localTime(e.ts), csvText(e.subject.accountId ? this.accountLabel?.(e.subject.accountId) ?? e.subject.accountId : ''), csvText(e.subject.instrumentId ?? ''), side, p.size ?? '', p.price ?? '', p.fee ?? '', p.realizedPnl ?? '', csvText(executorCell(e))].join(','))
      }
    }
    if (opts.markdown && checkpoints.length === 0) md.push('', '本段尚无检查点')
    const body: Omit<ExportManifest, 'signature'> = {
      schema: 'gitrader-ledger-export/2', fromSeq, toSeq, count, firstPrevHash: firstPrev, lastHash, checkpoints,
      chainHead: { seq: head.seq, hash: head.hash }, complete: fromSeq === 0 && toSeq === head.seq,
      filters: { payloadTypes: opts.payloadTypes ?? null }, redaction,
      installKey: { keyId: this.installKey.keyId, publicKey: this.installKey.publicKey },
      exportedAt, exportedBy: opts.exportedBy,
      ...(this.replay ? { paperReplay: { source: 'replay' as const, fixtureDigest: this.replay.replayFixtureDigest } } : {}),
    }
    const bodyDigest = digestOf(body)
    const manifest: ExportManifest = { ...body, signature: { keyId: this.installKey.keyId, alg: 'ed25519', sig: this.installKey.sign(exportSigningData(bodyDigest)) } }
    writeFileSync(join(opts.dir, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf8')
    writeFileAtomic(join(opts.dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    if (opts.markdown) writeFileSync(join(opts.dir, 'trade-log.md'), md.join('\n') + '\n', 'utf8')
    if (withBill) writeFileSync(join(opts.dir, '账单.csv'), BOM + bill.join('\n') + '\n', 'utf8')
    this.append({
      type: 'export.created', origin: opts.exportedBy, subject: { ledgerRef: `seq:${fromSeq}-${toSeq}` },
      payload: { fromSeq, toSeq, count, redaction, manifestDigest: bodyDigest },
    })
    return manifest
  }
}

export interface VerifyExportOptions {
  /** 本机库里的安装密钥：给了就要求导出件由同一把密钥签名。 */
  trustedKey?: { keyId: string; publicKey: string }
  /** 本机库适配器：给了就把导出件和库逐点比对。 */
  ledger?: { head(): { seq: number; hash: string }; hashAt(seq: number): string | undefined }
}

/** 验导出（entries = ledger.jsonl 逐行解析）：/2 先验 manifest 签名，再验链、条数、首尾，最后（可选）与本机库比对。 */
export function verifyExport(entries: LedgerEntry[], manifest: ExportManifest, opts: VerifyExportOptions = {}): VerifyResult {
  const blank: VerifyResult = { ok: false, count: 0, firstSeq: null, lastSeq: null, lastHash: null, checkpoints: 0 }
  const reject = (r: VerifyResult, seq: number, reason: string, db?: VerifyResult['db']): VerifyResult => ({ ...r, ok: false, failure: { seq, reason }, ...(db ? { db } : {}) })
  const v2 = manifest.schema === 'gitrader-ledger-export/2'
  if (!v2 && manifest.schema !== 'gitrader-ledger-export/1') return reject(blank, -1, `unsupported export schema ${String(manifest.schema)}`)
  const warnings: string[] = []
  let signer: string | undefined
  if (v2) {
    const { signature, ...body } = manifest
    if (!signature || signature.alg !== 'ed25519' || signature.keyId !== manifest.installKey.keyId
      || !InstallKey.verify(manifest.installKey.publicKey, exportSigningData(digestOf(body)), signature.sig)) return reject(blank, -1, 'manifest signature invalid')
    signer = signature.keyId
  } else {
    warnings.push('旧版导出件，无签名，无法发现尾部被删')
  }
  // /1 与 /2 都要和本机库的安装密钥对得上（/1 无签名，但 manifest.installKey 仍不能和本机不一致）
  if (opts.trustedKey && (opts.trustedKey.keyId !== manifest.installKey.keyId || opts.trustedKey.publicKey !== manifest.installKey.publicKey)) return reject(blank, -1, 'export signed by a different install key')
  const r = verifyEntries(entries, { publicKeys: { [manifest.installKey.keyId]: manifest.installKey.publicKey }, fromSeq: manifest.fromSeq })
  if (!r.ok) return r
  if (r.count !== manifest.count || r.lastHash !== manifest.lastHash || r.lastSeq !== manifest.toSeq || entries[0]?.prevHash !== manifest.firstPrevHash) {
    return reject(r, r.lastSeq ?? -1, 'export does not match manifest')
  }
  let db: VerifyResult['db']
  if (opts.ledger) {
    const lg = opts.ledger
    const anchor = v2 && manifest.chainHead ? manifest.chainHead : { seq: manifest.toSeq, hash: manifest.lastHash }
    const badSeq = lg.hashAt(manifest.toSeq) !== manifest.lastHash ? manifest.toSeq : lg.hashAt(anchor.seq) !== anchor.hash ? anchor.seq : undefined
    if (badSeq !== undefined) {
      const mismatch = `export does not match this machine's ledger at seq ${badSeq}`
      return reject(r, -1, mismatch, { compared: true, mismatch })
    }
    db = { compared: true, newerEntries: Math.max(0, lg.head().seq - anchor.seq) }
  }
  return { ...r, ...(warnings.length ? { warnings } : {}), ...(signer ? { signer } : {}), ...(db ? { db } : {}) }
}
