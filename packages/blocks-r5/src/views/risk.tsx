// SPDX-License-Identifier: CPAL-1.0
// 总览 · 风险卡（r5）：卡头右侧只有状态字；接管三钮（点哪个哪个就地武装，确认动词同 r4，走壳的 PIN 层）；没平完常驻红条；限额条（标签 · 2px 已用段 · 已用 / 上限，
// 数字与细条同源）；保护器列表（名称 · 触发状态 · 阈值与当前）。限额始终由内核强制，这里只显示。
// 命令与 r4 相同：takeover.halt_new / cancel_all / flatten_all、trading_state.resume、risk.setLlmLiveEntries；放宽限额默认走 risk.temporaryRelax（1/4/12/24 小时自动收回），
// 永久改 risk.relax 只在二次确认里；收紧走 risk.tighten。错误原文原样显示。
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import { F, toast } from '@gitrader/workbench/ui'
import { resumeTrading, runCommand, setLlmLiveGuard } from '../../../blocks-default/src/actions'
import { Q } from '../../../blocks-default/src/api'
import { FOCUS_EVENT, queryRetry, useNow, useOffline, useRisk, type FocusDetail } from '../../../blocks-default/src/hooks'
import { STATE_LABEL } from '../../../blocks-default/src/labels'
import { ruleLine } from '../../../blocks-default/src/model-activity'
import { LIMIT_FIELD, isAtOrBelowBase, limitRows, relaxLeftText, stateReasonText, stateRows, triggerRows, type LimitRow, type RiskView as RiskModel } from '../../../blocks-default/src/model-risk'
import { isRec } from '../../../blocks-default/src/util'
import { Term } from '../../../blocks-default/src/term'
import type { ReconcileAccountView } from '@gitrader/protocol/types'
import { Card } from '../kit'
import { ArmedRow, Ic, LeftoverAlert, Msg, Pop, Sk, TakeoverControls, cardClass, noteTakeoverEntry, stateAttr, useOfflineClock, useTakeover } from './ovkit'
import './overview.css'
import { t as tr } from '@gitrader/workbench/i18n'

const RELAX_FIELDS = [
  { id: 'maxOrderNotional', label: tr('单笔') }, { id: 'maxDailyLossRatio', label: tr('日亏') }, { id: 'maxTotalNotionalRatio', label: tr('总敞口') },
  { id: 'maxLeverage', label: tr('杠杆') }, { id: 'maxDailyOrders', label: tr('日订单数') },
] as const

const barPct = (r: number | null): number => (r === null ? 0 : Math.round(Math.min(1, Math.max(0, r)) * 10000) / 100)

/** 一行限额：标签 · 细条 · 已用 · / 上限。≥ 85% 转琥珀（图标 ⚠），≥ 100% 转危险色（图标 ⊘）。 */
export function LimitLine({ r, used, of: ofText, relaxed }: { r: Pick<LimitRow, 'label' | 'ratio' | 'tone'>; used?: string; of?: string; /** 这一项正处在临时放宽中。 */ relaxed?: boolean }) {
  const over = r.tone === 'down'
  const warn = r.tone === 'warn'
  return <div className={`g5-lim${over ? ' g5-over' : ''}`} data-limit={r.label} data-tone={r.tone} data-relaxed={relaxed ? '1' : undefined}>
    <span className="g5-k g5-al"><Term name={r.label} /></span>
    <span className="g5-bar" aria-hidden="true">{r.ratio === null ? null : <i className={warn ? 'g5-w' : undefined} style={{ width: `${barPct(r.ratio)}%` }} />}</span>
    <span className={`g5-v${warn ? ' g5-warn' : ''}`} data-n="used">{warn ? <Ic n="warn" s={12} label={tr('接近上限')} /> : over ? <Ic n="block" s={12} label={tr('已超限')} /> : null}{used}</span>
    <span className="g5-of">/ {ofText}{relaxed ? <em className="g5o-rx" title={tr('临时放宽中，到期自动收回')}>{tr('临时')}</em> : null}</span>
  </div>
}

const RELAX_HOURS = [1, 4, 12, 24] as const
const HOUR_MS = 3600_000
/** 临时放宽的到期时刻：内核要求 ≤ 24 小时，选 24 小时时让出 1 分钟，免得 PIN 往返后超线。 */
const untilOf = (hours: number): number => Date.now() + Math.min(hours * HOUR_MS, 24 * HOUR_MS - 60_000)

function Relax({ limits, base, relax, offline, reload }: { limits: Record<string, unknown>; base: Record<string, unknown>; relax: RiskModel['relax']; offline: boolean; reload(): void }) {
  const bridge = useBridge()
  const btn = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [field, setField] = useState<(typeof RELAX_FIELDS)[number]['id']>('maxOrderNotional')
  const [value, setValue] = useState('')
  const [hours, setHours] = useState<(typeof RELAX_HOURS)[number]>(4)
  const [perm, setPerm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const numeric = field === 'maxLeverage' || field === 'maxDailyOrders'
  const valid = /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && (!numeric || Number.isSafeInteger(Number(value)))
  const patchLimits = { [field]: numeric ? Number(value) : value }
  // 收紧 / 放宽按基线（policy.limits）比，不按含临时放宽的生效值：新值 ≤ 基线 = 收紧（内核会把被收紧的键从临时放宽里去掉），> 基线 = 临时放宽
  const tightening = valid && isAtOrBelowBase(patchLimits, base)
  const close = () => { setOpen(false); setPerm(false) }
  const submit = async (kind: 'temp' | 'perm') => {
    if (busy || !valid || offline) return
    setBusy(true); setErr('')
    const until = untilOf(hours)
    try {
      const result = tightening ? await runCommand(bridge, 'risk.tighten', { patch: { limits: patchLimits } })
        : kind === 'perm' ? await runCommand(bridge, 'risk.relax', { patch: { limits: patchLimits } })
          // 内核的临时放宽是整块替换：把现有的临时放宽并进来（同键以本次为准），到期时间统一用本次所选
          : await runCommand(bridge, 'risk.temporaryRelax', { fields: { ...relax?.values, ...patchLimits }, until })
      if (result.ok) { close(); setValue(''); reload(); toast.ok(tightening ? tr('限额已收紧') : kind === 'perm' ? tr('限额已永久修改') : tr('已临时放宽至 {0}', F.hm(until))) } else if (!result.cancelled) { setPerm(false); setErr(result.message) }
    } finally { setBusy(false) }
  }
  const current = `${String(limits[field] ?? tr('未设置'))}${relax?.fields.includes(field) ? tr('（临时，至 {0}；基线 {1}）', F.hm(relax.until), String(base[field] ?? tr('未设置'))) : ''}`
  return <>
    <button ref={btn} type="button" className="g5-btn g5-btn-ghost" data-act="risk-relax" aria-haspopup="dialog" aria-expanded={open} disabled={offline || busy} onClick={() => { if (open) close(); else setOpen(true); setErr('') }}>{tr('放宽限额')}</button>
    <Pop anchor={btn} open={open} onClose={close} label={tr('放宽限额')} width={320}>
      <div className="g5o-relax">
        <div className="g5-tabs g5o-relax-f" role="radiogroup" aria-label={tr('限额项目')}>{RELAX_FIELDS.map((f) => <button key={f.id} type="button" role="radio" aria-checked={field === f.id} className="g5-tab" data-field={f.id} aria-selected={field === f.id} disabled={busy} onClick={() => { setField(f.id); setValue(''); setErr(''); setPerm(false) }}>{f.label}</button>)}</div>
        <label className={`g5-inp${err ? ' g5-bad' : ''}`}><input aria-label={tr('新上限')} inputMode="decimal" placeholder={tr('新上限（当前 {0}）', current)} disabled={busy} value={value} onInput={(e) => { setValue((e.target as HTMLInputElement).value); setPerm(false) }} onKeyDown={(e) => { if (e.key === 'Enter' && !perm) void submit('temp') }} /></label>
        {tightening ? null : <div className="g5-tabs g5o-relax-f" role="radiogroup" aria-label={tr('放宽时长')}>{RELAX_HOURS.map((h) => <button key={h} type="button" role="radio" aria-checked={hours === h} className="g5-tab" data-hours={h} aria-selected={hours === h} disabled={busy} onClick={() => setHours(h)}>{h}{tr(' 小时')}</button>)}</div>}
        {relax && !tightening && !perm ? <div className="g5-s12 g5-t2" data-act="risk-relax-unify">{tr('会把现有临时放宽的到期时间统一改为 {0}', F.hm(untilOf(hours)))}</div> : null}
        {err ? <div className="g5o-ferr" role="alert" title={err}>{err}</div> : null}
        {perm
          ? <><div className="g5-s12 g5-t2" role="alert" data-act="risk-relax-perm-ask">{tr('永久修改风控上限，不会自动收回')}</div>
            <div className="g5-ffoot"><button type="button" className="g5-btn g5-btn-ghost" disabled={busy} onClick={() => setPerm(false)}>{tr('返回')}</button><button type="button" className="g5-btn g5-btn-fill" data-act="risk-relax-permanent-confirm" disabled={!valid || offline || busy} onClick={() => { void submit('perm') }}>{busy ? tr('处理中…') : tr('确认永久修改')}</button></div></>
          : <><div className="g5-ffoot"><button type="button" className="g5-btn g5-btn-ghost" disabled={busy} onClick={close}>{tr('取消')}</button><button type="button" className="g5-btn g5-btn-fill" data-act="risk-relax-confirm" disabled={!valid || offline || busy} onClick={() => { void submit('temp') }}>{busy ? tr('处理中…') : tightening ? tr('确认收紧') : tr('确认临时放宽至 {0}', F.hm(untilOf(hours)))}</button></div>
            {tightening ? null : <button type="button" className="g5-btn g5-btn-ghost g5-lnk g5o-perm" data-act="risk-relax-permanent" disabled={!valid || offline || busy} onClick={() => setPerm(true)}>{tr('改为永久上限…')}</button>}</>}
      </div>
    </Pop>
  </>
}

type StatusItem = ReturnType<typeof stateRows>[number]

function reconcileBlockerCount(value: unknown): number {
  const views = Array.isArray(value) ? value : []
  return views.filter(isRec).reduce((total, raw) => {
    const reviews = Array.isArray(raw.reviews) ? raw.reviews.filter(isRec) : []
    const pending = reviews.filter((item) => item.blocking === true && !item.resolution && !item.confirmedFillId)
    const findingIds = new Set(pending.map((item) => isRec(item.finding) ? item.finding.id : undefined).filter((id) => typeof id === 'string'))
    const kinds = new Set(pending.map((item) => item.kind))
    const findings = Array.isArray(raw.findings) ? raw.findings.filter(isRec) : []
    const unmatched = findings.filter((finding) => finding.severity === 'blocker' && !(typeof finding.id === 'string' && findingIds.has(finding.id))
      && !(finding.code === 'CONFIRMATION_EFFECTS_PENDING' && kinds.has('confirmation_effects'))
      && !(finding.code === 'LATE_REAL_FILL_REVIEW_REQUIRED' && kinds.has('late_real_fill'))
      && !(finding.code === 'fill_missing_inferred' && kinds.has('inferred_fill'))).length
    return total + pending.length + unmatched
  }, 0)
}

/** 恢复被对账挡住的持久行文案（N 取不到就不写数字）。 */
const recBlockedText = (n: number): string => tr('恢复被挡住：有对账待处理{0}', n > 0 ? tr('（{0} 笔）', n) : '')
/** 内核因对账没清而拒绝恢复：TRADING_STATE + 原文含 reconciliation，或 BUSY + confirmation（K-b 不改这两句英文原文前缀）。 */
const blockedByReconcile = (x: { problem?: string; upstream?: string }): boolean =>
  (!!x.problem?.startsWith('TRADING_STATE') && /reconciliation/i.test(x.upstream ?? '')) || (x.problem === 'BUSY' && /confirmation/i.test(x.upstream ?? ''))

/** 一行停机作用域：作用域 + 原因原文的中文化 + 恢复（两步确认，要在场证明）；点了恢复就整行换成武装行。 */
function StatusLine({ row, offline, reload }: { row: StatusItem; offline: boolean; reload(): void }) {
  const bridge = useBridge()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reconcileCount, setReconcileCount] = useState<number | null>(null)
  if (armed) return <ArmedRow what={tr('恢复 {0}', row.label)} confirm={tr('确认恢复')} busyLabel={tr('恢复中…')} busy={busy} kill={false} err={err} onCancel={() => { setArmed(false); setErr(null) }}
    onConfirm={() => {
      setBusy(true); setErr(null)
      void resumeTrading(bridge, row.scope).then(async (x) => {
        if (x.ok) {
          let still: StatusItem[] | null = null
          try { still = stateRows(await queryRetry(bridge, Q.riskState)) } catch { still = null }
          if (still && still.length) toast.ok(tr('已恢复 {0}；仍有 {1} 项停机：{2}', row.label, still.length, still.map((r) => r.label).join(tr('、'))))
          else toast.ok(tr('已恢复交易'))
          reload(); setArmed(false)
        } else if (x.cancelled) setArmed(false); else {
          let count = 0
          try {
            const params = row.scope.type === 'account' ? { accountId: row.scope.id } : undefined
            const views = await queryRetry<ReconcileAccountView[]>(bridge, 'reconcile.status', params)
            count = reconcileBlockerCount(views)
          } catch { count = 0 }
          if (count > 0 || blockedByReconcile(x)) { setReconcileCount(count); setArmed(false); setErr(null); toast.err(recBlockedText(count)) }
          else { toast.err(x.message); setErr(x.message) }
        }
      }).finally(() => setBusy(false))
    }} />
  return <div className="g5o-status" data-state={row.state} data-scope={row.scope.type === 'org' ? 'org' : row.scope.id}>
    <span className="g5-blocked" title={row.reason}><Ic n="block" s={12} />{row.reason ? tr('{0}：{1}', row.label, stateReasonText(row.reason)) : row.label}</span>
    {reconcileCount !== null ? <><span className="g5-rec-blocked" role="status" data-act="rec-blocked"><Ic n="warn" s={12} />{recBlockedText(reconcileCount)}</span>
      <button type="button" className="g5-btn g5-btn-ghost g5-lnk" data-act="reconcile-entry" onClick={() => { location.hash = '#/reconcile' }}>{tr('进入对账')}</button></> : null}
    <button type="button" className="g5-btn g5-btn-ghost" data-act="resume" disabled={offline} title={offline ? tr('离线') : undefined} onClick={() => { setReconcileCount(null); setArmed(true) }}>{tr('恢复交易')}</button>
  </div>
}

/** 非「正常交易」时的状态行：每个非 ACTIVE 作用域各一行，逐行恢复。 */
function StatusRow({ rows, offline, reload }: { rows: StatusItem[]; offline: boolean; reload(): void }) {
  return <>{rows.map((row) => <StatusLine key={row.scope.type === 'org' ? 'org' : `${row.scope.type}:${row.scope.id}`} row={row} offline={offline} reload={reload} />)}</>
}

export function RiskView() {
  const d = useRisk(noteTakeoverEntry)
  const bridge = useBridge()
  const offline = useOffline(() => { d.reload() })
  const clock = useOfflineClock(offline)
  const st = useTakeover()
  const nowMin = useNow(60_000) // 临时放宽的「剩 X 小时 Y 分」每分钟本地刷新一次
  const [open, setOpen] = useState(true)
  const [guardBusy, setGuardBusy] = useState(false)
  // 总览条点「风险」跳过来：焦点给卡标题
  useEffect(() => {
    const on = (e: Event) => { const x = (e as CustomEvent<FocusDetail>).detail; if (x?.card === 'risk') document.querySelector<HTMLElement>('[data-view="risk"] h2')?.focus() }
    window.addEventListener(FOCUS_EVENT, on)
    return () => window.removeEventListener(FOCUS_EVENT, on)
  }, [])
  const r = d.risk
  const rows = d.accounts.rows
  // 到期那一刻重查一次（内核到期写 policy.reverted 并推 risk.state；事件没到也不让界面停在旧限额上）
  useEffect(() => {
    if (!r.relax) return undefined
    const t = setTimeout(d.reload, Math.max(1000, r.relax.until - Date.now() + 500))
    return () => clearTimeout(t)
  }, [r.relax?.until, d.reload])
  const scoped = stateRows(isRec(d.raw) ? { ...d.raw, accounts: d.accounts.accounts, mandateNames: d.mandateNames } : d.raw)
  // 内核没给分作用域的原因时（老形状 / 夹具），退回一行全局状态 + 原因原文，恢复照旧走全局
  const statusRows: StatusItem[] = scoped.length || !d.risk.known || d.risk.state === 'ACTIVE' ? scoped
    : [{ scope: { type: 'org' }, label: tr('全局'), state: d.risk.state === 'HALTED' ? 'HALTED' : 'REDUCING', reason: d.risk.reasons.join(tr('；')) }]
  const reloadStatus = d.reload
  const consequence = rows.length ? tr('{0} 个持仓，实盘 {1}', rows.length, rows.filter((x) => x.mode === 'live').length) : undefined
  const lims = limitRows(r.limits, r.usage)
  const relaxed = new Set(r.relax?.fields ?? [])
  const trig = triggerRows(d.triggers)
  const known = r.known ? r.state : null
  const stateLabel = offline ? '—' : known ? STATE_LABEL[known] : tr('未知') // UX-09：服务断开时不沿用旧的「正常交易」，与顶栏风险格一致写「—」
  const stateCls = offline ? 'g5-tb' : known === 'HALTED' ? 'g5-down' : known === 'REDUCING' ? 'g5-warn' : 'g5-tb'

  const setGuard = async (next: boolean) => {
    setGuardBusy(true)
    try {
      const x = await setLlmLiveGuard(bridge, next)
      if (x.ok) { toast.ok(next ? tr('已打开大模型实盘开仓保护') : tr('已关闭大模型实盘开仓保护')); d.reload() } else if (!x.cancelled) toast.err(x.message)
    } finally { setGuardBusy(false) }
  }

  const head = <header className="g5-hd">
    <h2 className="g5-al" tabIndex={-1}>{tr('风险')}</h2>
    <div className="g5-r">
      {clock ? <span className="g5-s12 g5-t3">{clock}</span> : null}
      {d.phase === 'ready' ? <>{r.relax ? <span className="g5-s12 g5-warn g5o-relaxing" data-act="relax-active" data-until={r.relax.until} title={tr('临时放宽 · 至 {0}（{1}）', F.hm(r.relax.until), relaxLeftText(r.relax.until, nowMin))}>{tr('临时放宽 · 至 {0}（{1}）', F.hm(r.relax.until), relaxLeftText(r.relax.until, nowMin))}</span> : null}<Relax limits={r.limits} base={r.baseLimits} relax={r.relax} offline={offline} reload={d.reload} /><span className={stateCls} role="status" aria-label={tr('交易状态：{0}', stateLabel)} data-state-text={known ?? 'UNKNOWN'}>{stateLabel}</span></> : null}
    </div>
  </header>

  let body: ComponentChildren
  if (d.phase === 'error') body = <Msg error={d.error} onRetry={d.reload} />
  else if (d.phase === 'loading') {
    body = <div className="g5-rbody" aria-busy="true" aria-label={tr('加载中')}>
      <div className="g5-racts"><span className="g5-sk" style={{ width: 96, height: 32 }} /><span className="g5-sk" style={{ width: 80, height: 32 }} /><span className="g5-sk" style={{ width: 80, height: 32 }} /></div>
      <div className="g5-lims">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="g5-lim"><Sk w={32} /><Sk /><Sk w={56} /><Sk w={40} /></div>)}</div>
    </div>
  } else {
    const protectors = r.protectors.map((p) => {
      const mine = trig.filter((t) => t.label === p.label)
      return { id: p.id, label: p.label, text: p.text, n: mine.length, last: mine[0]?.ts ?? null }
    })
    const orphan = trig.filter((t) => !r.protectors.some((p) => p.label === t.label))
    body = <div className="g5-rbody">
      <TakeoverControls layout="bar" offline={offline} {...(consequence ? { consequence } : {})} onDone={d.reload} />
      {statusRows.length ? <StatusRow rows={statusRows} offline={offline} reload={reloadStatus} /> : null}
      {st.left ? <LeftoverAlert left={st.left} offline={offline} /> : null}
      {!r.integrityOk ? <div className="g5-blocked g5o-bad" role="alert"><Ic n="block" s={12} />{tr('风控策略校验没有通过，交易已停止。')}</div> : null}
      {lims.length ? <div className="g5-lims">{lims.map((l) => <LimitLine key={l.id} r={l} used={l.used} of={l.limit} relaxed={relaxed.has(LIMIT_FIELD[l.id])} />)}</div> : <div className="g5o-msg"><span className="g5-al">{tr('还没有设置限额')}</span></div>}
      <div className="g5-prot">
        <div className="g5-ph">
          <span className="g5-tb g5-al"><Term name="保护器" /> {r.protectors.length}</span>
          <span className="g5-s12 g5-t3">{tr('触发 {0} 次', trig.length)}</span>
          <span className="g5o-guard"><button type="button" role="switch" aria-checked={r.denyLlmLiveEntries} aria-label={tr('大模型实盘开仓保护')} className={`g5-sw${r.denyLlmLiveEntries ? ' g5-on' : ''}`} data-act="llm-guard"
            disabled={guardBusy || offline} title={offline ? tr('离线') : undefined} onClick={() => { void setGuard(!r.denyLlmLiveEntries) }} /><span className="g5-s12 g5-t2">{tr('大模型实盘开仓保护')}</span></span>
          <button type="button" className="g5-btn g5-btn-ghost g5-btn-icon" data-act="protectors" aria-label={open ? tr('收起保护器') : tr('展开保护器')} aria-expanded={open} onClick={() => setOpen(!open)}><Ic n="chev" style={open ? { transform: 'rotate(180deg)' } : undefined} /></button>
        </div>
        {open ? <>
          {protectors.length ? protectors.map((p) => <div key={p.id} className="g5-pr" data-protector={p.id}>
            <span className="g5-tb g5-al"><Term name={p.label} /></span>
            <span className={`g5-s12 ${p.n ? 'g5-t2' : 'g5-t3'}`}>{p.n ? tr('触发 {0} 次　{1}', p.n, F.hm(p.last)) : tr('未触发')}</span>
            <span className="g5-d" title={p.text}>{p.text}</span>
          </div>) : <div className="g5-pr"><span className="g5-t3 g5-al">{tr('没有启用保护器')}</span></div>}
          {orphan.map((t) => <div key={t.id} className="g5-pr" data-kind="trigger">
            <span className="g5-tb g5-al">{t.label}</span><span className="g5-s12 g5-t2">{tr('触发　{0}', F.hm(t.ts))}</span><span className="g5-d" title={ruleLine(t.text)}>{ruleLine(t.text)}</span>
          </div>)}
        </> : null}
      </div>
    </div>
  }
  return <Card head={head} className={cardClass(false, offline)} {...stateAttr(offline)} data-g5-page="overview" data-view="risk" data-risk-state={r.state} id="risk" aria-label={tr('风险')}>{body}</Card>
}
