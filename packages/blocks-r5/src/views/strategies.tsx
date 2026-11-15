// SPDX-License-Identifier: CPAL-1.0
// 策略页（P6）三张卡：策略列表 / 引擎 / 引擎事件。块只经桥收发；数据规整在 model-strategies.ts。
// 内核没有的东西（回包缺字段、方法不存在）显示「未接通」+ 内核原文，不重试、不猜；错误一律显示内核原文，不改写。
import { Fragment, type ComponentChildren } from 'preact'
import { createPortal } from 'preact/compat'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useBridge, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { ErrText, Menu, copyText, enter, toast, useClickAway } from '@gitrader/workbench/ui'
import { failureNotice, runCommand } from '../../../blocks-default/src/actions'
import { useNow, useOffline, useRes } from '../../../blocks-default/src/hooks'
import { Actor, Card, ErrorText, Unwired, VenueIcon, wireState } from '../kit'
import {
  EVENT_TYPES, FILTERS, INTERVAL_OPTIONS, STATE_TEXT, bindCmd, bindPlan, clockText, eventsOfStrategy, filterCounts, filterRows, heartbeatAge, isStartInterval, mergeEvent,
  normalizeAccounts, normalizeCatalog, normalizeEngines, normalizeEvents, normalizeExperiments, normalizeStrategies, paperAccounts, paramEntries, paramSeed, parseParamEdit, readFail, readParams, readStartForm, recentOf,
  rowAction, stageLabel, startAccounts, startEngineCmd, startFormSeed, startNewCmd, startStrategyCmd, stopEngineCmd, stopEngineText, stopStrategyCmd, stopStrategyText, toEventRow, updateParamsCmd, editText,
  DEFAULT_START_INTERVAL, type AccountLite, type AccountView, type CatalogEntry, type Cmd, type EngineRow, type EventRow, type FilterId, type ParamField, type StartInterval, type StrategyRow,
} from '../model-strategies'
import './strategies.css'
import { t as tr, tk } from '@gitrader/workbench/i18n'
import { cli } from '@gitrader/workbench/launcher'

// ---- 小件 -----------------------------------------------------------------------------

const ICONS = {
  chev: <path d="M7 10l5 5 5-5" />,
  block: <><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  check: <path d="M5.5 12.5l4 4 9-9" />,
}
function Ic({ n, s = 14, className = '' }: { n: keyof typeof ICONS; s?: 12 | 14 | 16; className?: string }) {
  return <svg className={['g5-i', s === 12 ? 'g5-i12' : s === 16 ? 'g5-i16' : '', className].filter(Boolean).join(' ')} viewBox="0 0 24 24" aria-hidden="true">{ICONS[n]}</svg>
}

const SK_WIDTHS = [88, 88, 152, 28, 144, 112]
function SkeletonRows({ n = 4, widths = SK_WIDTHS, fill = widths.length - 2 }: { n?: number; widths?: readonly number[]; fill?: number }) {
  const last = widths.length - 1
  return <>{Array.from({ length: n }, (_, i) => (
    <tr key={i} className="g5-row">{widths.map((w, c) => <td key={c} className={c === last ? 'g5-n' : c === fill ? 'g5-fill' : undefined}><span className="g5-sk" style={{ width: w }} /></td>)}</tr>
  ))}</>
}

function Notice({ error, fail, onRetry }: { error: Error | null; fail: string | null; onRetry(): void }) {
  if (error && wireState(error) === 'off') return <div className="g5-sx-msg" data-state="unwired"><Unwired message={error.message} /></div>
  return (
    <div className="g5-sx-msg" data-state="error" role="alert">
      <span className="g5-al">{tr('读取失败')}</span><ErrorText bare message={error ? error.message : (fail ?? '')} />
      <button type="button" className="g5-btn g5-btn-fill" data-act="read-retry" onClick={onRetry}>{tr('重试')}</button>
    </div>
  )
}

/** 左栏是策略列表、右栏是引擎列表，两边空的原因不同，文案不能混用。 */
export const EMPTY_LABEL = { strategies: tr('还没有策略'), engines: tr('没有已连接的引擎') } as const
/** CLI 只有 `engines list`，没有策略列表命令：策略空时不给命令和复制钮。 */
const EMPTY_CMD: Record<string, string | undefined> = { [EMPTY_LABEL.engines]: 'gitrader engines list' }

function EmptyEngines({ label }: { label: string }) {
  const [copied, setCopied] = useState(false)
  const raw = EMPTY_CMD[label]
  const cmd = raw ? cli(raw) : raw // UX-04：便携包里没有全局 gitrader，用内核告知的启动器
  return (
    <div className="g5-sx-msg" data-state="empty">
      <span className="g5-al">{label}</span>{cmd ? <span className="g5-sx-cmd">{cmd}</span> : null}
      {cmd ? <button type="button" className="g5-btn g5-btn-ghost" data-act="copy" onClick={() => { void copyText(cmd).then(() => setCopied(true)) }}><Ic n={copied ? 'check' : 'copy'} />{copied ? tr('已复制') : tr('复制')}</button> : null}
    </div>
  )
}

/** 离线起点（HH:MM）：内核断开时卡头右侧写「已暂停更新 · HH:MM」。 */
function useOfflineStamp(off: boolean): string | null {
  const at = useRef<number | null>(null)
  if (off && at.current === null) at.current = Date.now()
  if (!off) at.current = null
  if (at.current === null) return null
  const t = new Date(at.current)
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
}
const OfflineNote = ({ stamp }: { stamp: string | null }) => (stamp ? <span className="g5-s12 g5-t3">{tr('已暂停更新 · ')}{stamp}</span> : null)

/**
 * 两步确认条：后果写在前；焦点落「取消」；Esc / 取消 / 5 秒无操作解除；600 ms 内的确认点击不算数；执行中隐藏取消；失败原文就地显示、可重试。
 * （kit 的 ArmRow 触发钮常驻在红底里，这里需要「后果 + 取消 + 确认」一条受控的条，所以本页自带。）
 */
function ArmedBar({ what, confirm, busyLabel, busy, error, onConfirm, onCancel, act }: { what: string; confirm: string; busyLabel: string; busy: boolean; error: string | null; onConfirm(): void; onCancel(): void; act: string }) {
  const born = useRef(performance.now())
  const cancelBtn = useRef<HTMLButtonElement>(null)
  const hover = useRef(false)
  const timer = useRef(0)
  const idle = useCallback(() => {
    clearTimeout(timer.current)
    if (!hover.current && !busy) timer.current = window.setTimeout(onCancel, 5000)
  }, [busy, onCancel])
  useLayoutEffect(() => { cancelBtn.current?.focus() }, [])
  useEffect(() => { idle(); return () => clearTimeout(timer.current) }, [idle, error])
  return (
    <div className="g5-armed" role="group" aria-label={what} data-armed="" onPointerEnter={() => { hover.current = true; clearTimeout(timer.current) }} onPointerLeave={() => { hover.current = false; idle() }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onCancel() } else idle() }}>
      <span className="g5-what g5-al">{what}</span>
      {error ? <span className="g5-msg g5-danger" role="alert"><ErrText text={error} /></span> : null}
      {busy ? null : <button ref={cancelBtn} type="button" className="g5-btn g5-btn-ghost" data-act={`${act}-cancel`} onClick={onCancel}>{tr('取消')}</button>}
      <button type="button" className="g5-btn g5-btn-kill" data-act={`${act}-confirm`} disabled={busy}
        onClick={() => { if (!busy && performance.now() - born.current >= 600) onConfirm() }}>{busy ? busyLabel : confirm}</button>
    </div>
  )
}

function Venue({ a }: { a: AccountView }) {
  return a.mode === 'paper' ? <span className="g5-papermk" title={tr('纸面账户')} /> : <VenueIcon name={a.venueLabel} venue={a.venue} label={a.venueLabel} />
}
function Acct({ a, id }: { a: AccountView | null; id: string }) {
  if (!a) return <span className="g5-acct"><span className="g5-t3">{id}</span></span>
  return <span className="g5-acct"><span className="g5-tb">{a.alias}</span><span className="g5-t3">{a.modeText}</span><Venue a={a} /></span>
}

// ---- 数据钩子 -------------------------------------------------------------------------

const EVENT_QUERY = { types: [...EVENT_TYPES], order: 'desc', limit: 100 }

/** model 在 payload 里找不到任何文字时兜底写「引擎事件」；这种行没有可读内容。 */
export const hasContent = (r: Pick<EventRow, 'text' | 'bad' | 'note'>): boolean => !(r.text === '引擎事件' && !r.bad && !r.note)

/** 引擎事件：先查一次快照，再接 ledger.entry 实时追加；账户别名用来把「绑定」写成人话。 */
function useEngineEvents(accounts: readonly AccountLite[]) {
  const q = useRes<unknown>('ledger.query', EVENT_QUERY)
  const [live, setLive] = useState<EventRow[]>([])
  const base = useMemo(() => normalizeEvents(q.data, accounts), [q.data, accounts])
  useEffect(() => { setLive([]) }, [q.data])
  useSubscribe('ledger.entry', (e) => {
    const row = toEventRow(e.data, accounts)
    if (row) setLive((l) => mergeEvent(l, row))
  })
  // 无内容的事件（model 兜底文案「引擎事件」、没有原文和补充）不画空行
  const events = useMemo(() => live.reduce<EventRow[]>((acc, r) => mergeEvent(acc, r), base).filter(hasContent), [base, live])
  return { events, error: q.error, loading: q.loading && !q.data, fail: readFail(q.data), reload: q.reload }
}

/** 本页各卡共用的账户 / 策略 / 实验快照。引擎状态、策略状态一变就重读。 */
function useStrategiesSnapshot() {
  const accountsQ = useRes<unknown>('account.list')
  const stratQ = useRes<unknown>('engine.strategies')
  const labQ = useRes<unknown>('lab.list')
  const accounts = useMemo(() => normalizeAccounts(accountsQ.data), [accountsQ.data])
  const stages = useMemo(() => normalizeExperiments(labQ.data), [labQ.data])
  const model = useMemo(() => normalizeStrategies(stratQ.data, accounts, stages), [stratQ.data, accounts, stages])
  const reloadStrategies = stratQ.reload
  useSubscribe('strategy.status', () => reloadStrategies())
  useSubscribe('engine.health', () => reloadStrategies())
  return { accounts, model, stratQ, reload: reloadStrategies }
}

// ---- 策略列表 -------------------------------------------------------------------------

type Arm = { key: string; busy: boolean; error: string | null }
type Edit = { key: string; texts: Record<string, string>; busy: boolean; error: string | null }
/** 行内启动表单：标的文本 + 周期，确认后发 strategy.start。 */
type Start = { key: string; text: string; interval: StartInterval; busy: boolean; error: string | null }

export function StrategyListView() {
  const bridge = useBridge()
  const off = useOffline()
  const stamp = useOfflineStamp(off)
  const now = useNow(30_000)
  const { accounts, model, stratQ, reload } = useStrategiesSnapshot()
  const ev = useEngineEvents(accounts)
  const [filter, setFilter] = useState<FilterId>('all')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [arm, setArm] = useState<Arm | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [start, setStart] = useState<Start | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const catQ = useRes<unknown>('engine.catalog')
  const enginesQ = useRes<unknown>('engine.list')
  const cat = useMemo(() => normalizeCatalog(catQ.data), [catQ.data])
  const engines = useMemo(() => normalizeEngines(enginesQ.data, model.rows, accounts), [enginesQ.data, model.rows, accounts])
  useSubscribe('engine.health', () => { catQ.reload(); enginesQ.reload() })
  useSubscribe('strategy.status', () => catQ.reload())
  // 还没有任何实例、但引擎已加载策略：首屏落「可用」一次（之后由人切换）
  const autoTab = useRef(false)
  useEffect(() => {
    if (autoTab.current || !stratQ.data || !catQ.data) return
    autoTab.current = true
    if (!model.rows.length && cat.entries.length) setFilter('catalog')
  }, [stratQ.data, catQ.data, model.rows.length, cat.entries.length])

  const counts = { ...filterCounts(model.rows), catalog: cat.entries.length }
  const rows = filterRows(model.rows, filter)
  const run = (cmd: Cmd) => runCommand(bridge, cmd.action, cmd.params)

  const doStop = async (r: StrategyRow) => {
    setArm({ key: r.key, busy: true, error: null })
    const res = await run(stopStrategyCmd(r))
    if (res.ok) { setArm(null); reload() } else if (res.cancelled) setArm({ key: r.key, busy: false, error: null }); else setArm({ key: r.key, busy: false, error: res.message })
  }
  const doStart = async (r: StrategyRow) => {
    if (!start || start.key !== r.key) return
    const form = readStartForm(start.text, start.interval)
    if (!form.ok) { setStart({ ...start, error: form.message }); return }
    setStart({ ...start, busy: true, error: null })
    setPending(r.key)
    const res = await run(startStrategyCmd(r, form.pick))
    setPending(null)
    if (res.ok) { setStart(null); reload() } else if (res.cancelled) setStart({ ...start, busy: false, error: null }); else setStart({ ...start, busy: false, error: res.upstream ?? res.message })
  }
  const doSave = async (r: StrategyRow) => {
    if (!edit || edit.key !== r.key) return
    const parsed = parseParamEdit(r.params, edit.texts)
    if (!parsed.ok) { setEdit({ ...edit, error: parsed.message }); return }
    if (!Object.keys(parsed.changed).length) { setEdit(null); return }
    setEdit({ ...edit, busy: true, error: null })
    const res = await run(updateParamsCmd(r, parsed.changed))
    if (res.ok) { setEdit(null); reload() } else if (res.cancelled) setEdit({ ...edit, busy: false, error: null }); else setEdit({ ...edit, busy: false, error: res.message })
  }

  const title = (
    <header className="g5-hd">
      <h2 className="g5-al">{tr('策略')}</h2>{stratQ.data && !model.fail ? <span className="g5-ct">{model.rows.length}</span> : null}
      <div className="g5-r g5-tabs g5-gh" role="tablist">
        {off ? <OfflineNote stamp={stamp} /> : model.rows.length || cat.entries.length ? FILTERS.map((f) => (
          <button key={f.id} type="button" className="g5-tab" role="tab" aria-selected={filter === f.id} data-filter={f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="g5-c">{counts[f.id]}</span></button>
        )) : null}
      </div>
    </header>
  )

  let body: ComponentChildren
  const loading = stratQ.loading && !stratQ.data
  if (filter === 'catalog') body = (
    <CatalogList cat={cat} error={catQ.error} loading={catQ.loading && !catQ.data} engines={engines} accounts={accounts} off={off} onRetry={catQ.reload}
      onStarted={() => { reload(); setFilter('all') }} />
  )
  else if (stratQ.error && !stratQ.data) body = <Notice error={stratQ.error} fail={null} onRetry={reload} />
  else if (model.fail) body = <Notice error={null} fail={model.fail} onRetry={reload} />
  else if (!loading && !model.rows.length && !model.failures.length) body = <EmptyEngines label={EMPTY_LABEL.strategies} />
  else body = (
    <div className="g5-sx-tw g5-scroll">
      <table className="g5-tbl">
        <thead><tr><th className="g5-al">{tr('策略')}</th><th>{tr('引擎')}</th><th>{tr('绑定账户')}</th><th>{tr('状态')}</th><th className="g5-fill">{tr('近况')}</th><th /></tr></thead>
        <tbody>
          {loading ? <SkeletonRows /> : null}
          {!loading ? rows.map((r) => {
            const isOpen = openKey === r.key
            const act = rowAction(r)
            const rec = recentOf(r, now)
            const armed = arm?.key === r.key
            const mine = isOpen ? eventsOfStrategy(ev.events, r) : []
            const editing = edit?.key === r.key ? edit : null
            const live = r.account?.mode === 'live'
            return [
              armed ? (
                <tr key={r.key} className="g5-row g5-sx-armrow"><td colSpan={6}><ArmedBar what={stopStrategyText(r)} confirm={tr('确认停止')} busyLabel={tr('停止中…')} busy={arm!.busy} error={arm!.error} act="stop-strategy" onConfirm={() => { void doStop(r) }} onCancel={() => setArm(null)} /></td></tr>
              ) : (
                <tr key={r.key} className={['g5-row', isOpen ? 'g5-open' : ''].filter(Boolean).join(' ')} data-strategy={r.strategyId} data-state={r.state}>
                  <td>
                    <span className="g5-sl g5-al"><span className="g5-sym">{r.strategyId}</span><span className="g5-s12 g5-t3">{r.version}</span></span>
                    {r.experimentId ? <span className="g5-l2"><a className="g5-lk g5-t2" href={`#/lab/${r.experimentId}`}>{r.experimentId}{r.stage ? ` ${stageLabel(r.stage)}` : ''}</a></span> : null}
                  </td>
                  <td><Actor kind="engine" name={r.engineId} /></td>
                  <td><Acct a={r.account} id={r.accountId} /></td>
                  <td className={r.state === 'error' ? 'g5-danger' : r.state === 'stopped' ? 'g5-t3' : 'g5-tb'}>{STATE_TEXT[r.state]}</td>
                  <td className="g5-fill"><span className="g5-tb">{rec.l1}</span>{rec.bad ? <span className="g5-l2"><span className="g5-bad"><Ic n="block" s={12} />{rec.bad}</span></span> : null}</td>
                  <td className="g5-n">
                    <span className="g5-acts">
                      {act.kind === 'stop' ? <button type="button" className="g5-btn g5-btn-ghost" data-act="stop-strategy" disabled={off} onClick={() => setArm({ key: r.key, busy: false, error: null })}>{tr('停止')}</button> : null}
                      {act.kind === 'start' ? (
                        <button type="button" className="g5-btn g5-btn-ghost" data-act="start-strategy" aria-expanded={start?.key === r.key} disabled={off || pending === r.key} onClick={() => setStart(start?.key === r.key ? null : { key: r.key, ...startFormSeed(r), busy: false, error: null })}>{tr('启动')}</button>
                      ) : null}
                      {act.kind === 'promote' && act.href ? <a className="g5-btn g5-btn-ghost g5-lnk" href={act.href} data-act="promote">{tr('去晋级')}</a> : null}
                      <button type="button" className="g5-btn g5-btn-ghost g5-btn-icon" aria-label={isOpen ? tr('收起') : tr('展开')} aria-expanded={isOpen} data-act="expand" onClick={() => setOpenKey(isOpen ? null : r.key)}><Ic n="chev" className="g5-chev" /></button>
                    </span>
                  </td>
                </tr>
              ),
              start?.key === r.key && !armed ? (
                <tr key={`${r.key}:start`} className="g5-row g5-sx-armrow" data-form="start-strategy"><td colSpan={6}>
                  <div className="g5-pf">
                    <label className="g5-k g5-al" htmlFor={`sf-${r.key}-ins`}>{tr('标的')}</label>
                    <span className="g5-inp g5-s g5-l"><input id={`sf-${r.key}-ins`} aria-label={tr('标的（逗号分隔）')} placeholder="hyperliquid:BTC, hyperliquid:ETH" value={start.text} disabled={start.busy}
                      onInput={(e) => setStart({ ...start, text: (e.currentTarget as HTMLInputElement).value, error: null })} /></span>
                    <span className="g5-k g5-al">{tr('周期')}</span>
                    <span className="g5-l">
                      <Menu trigger={<button type="button" className="g5-dd" data-act="start-interval">{start.interval}<Ic n="chev" s={12} /></button>} value={start.interval}
                        onValueChange={(id) => { if (isStartInterval(id)) setStart({ ...start, interval: id }) }} items={INTERVAL_OPTIONS.map((i) => ({ id: i, label: i }))} label={tr('选择周期')} align="start" />
                    </span>
                  </div>
                  {start.error ? <div className="g5-sx-err" role="alert">{start.error}</div> : null}
                  <div className="g5-xacts">
                    <button type="button" className="g5-btn g5-btn-ghost" data-act="start-cancel" disabled={start.busy} onClick={() => setStart(null)}>{tr('取消')}</button>
                    <button type="button" className="g5-btn g5-btn-fill" data-act="start-confirm" disabled={start.busy} onClick={() => { void doStart(r) }}>{start.busy ? tr('启动中…') : tr('确认')}</button>
                  </div>
                </td></tr>
              ) : null,
              isOpen && !armed ? (
                <tr key={`${r.key}:x`} className="g5-xrow"><td colSpan={6}>
                  <div className="g5-xp">
                    <div className="g5-xpar">
                      <div className="g5-xh"><span className="g5-al">{tr('参数')}</span><span>{Object.keys(r.params).length}</span>
                        <div className="g5-r">{editing ? null : <button type="button" className="g5-btn g5-btn-ghost g5-tl" data-act="edit-params" disabled={off || !Object.keys(r.params).length} onClick={() => setEdit({ key: r.key, texts: Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, editText(v)])), busy: false, error: null })}>{live ? <Ic n="lock" s={12} /> : null}{tr('编辑')}</button>}</div>
                      </div>
                      {editing ? (
                        <>
                          <div className="g5-pf">{Object.keys(r.params).map((k) => (
                            <Fragment key={k}><label className="g5-k g5-al" htmlFor={`pf-${r.key}-${k}`}>{k}</label><span className="g5-inp g5-s"><input id={`pf-${r.key}-${k}`} aria-label={k} value={editing.texts[k] ?? ''} disabled={editing.busy}
                              onInput={(e) => setEdit({ ...editing, texts: { ...editing.texts, [k]: (e.currentTarget as HTMLInputElement).value }, error: null })} /></span></Fragment>
                          ))}</div>
                          {editing.error ? <div className="g5-sx-err" role="alert">{editing.error}</div> : null}
                          <div className="g5-xacts">
                            <button type="button" className="g5-btn g5-btn-ghost" data-act="edit-cancel" disabled={editing.busy} onClick={() => setEdit(null)}>{tr('取消')}</button>
                            <button type="button" className="g5-btn g5-btn-fill" data-act="edit-save" disabled={editing.busy} onClick={() => { void doSave(r) }}>{live ? <Ic n="lock" s={12} /> : null}{editing.busy ? tr('保存中…') : tr('保存')}</button>
                          </div>
                        </>
                      ) : (
                        <div className="g5-pv">{paramEntries(r.params).map((p) => <Fragment key={p.key}><span className="g5-k g5-al">{p.key}</span><span className="g5-v"><span data-n="pv">{p.text}</span></span></Fragment>)}</div>
                      )}
                    </div>
                    <div className="g5-xev">
                      <div className="g5-xh"><span>{tr('事件')}</span><span>{mine.length}</span><div className="g5-r"><a className="g5-lnk g5-lk g5-tl" href="#/records">{tr('全部记录')}</a></div></div>
                      {mine.length ? <EventList events={mine} now={now} wide /> : <div className="g5-sx-quiet">{tr('暂无事件')}</div>}
                    </div>
                  </div>
                </td></tr>
              ) : null,
            ]
          }) : null}
          {!loading ? model.failures.map((f) => (
            <tr key={f.key} className="g5-row" data-failure={f.engineId}>
              <td colSpan={5}>
                <span className="g5-sl g5-al"><Actor kind="engine" name={f.engineId} /><span className="g5-danger">{tr('不可用')}</span></span>
                <span className="g5-l2"><span className="g5-bad"><Ic n="block" s={12} />{[f.name, f.message].filter(Boolean).join(' ')}</span></span>
              </td>
              <td className="g5-n"><span className="g5-acts"><button type="button" className="g5-btn g5-btn-ghost" data-act="read-retry" onClick={reload}>{tr('重试')}</button></span></td>
            </tr>
          )) : null}
        </tbody>
      </table>
    </div>
  )
  return <Card head={title} className={['g5-sx-root', 'g5-grow', off ? 'g5-off' : ''].filter(Boolean).join(' ')} data-page="strategies" data-g5-page="strategies" data-block="strategies" data-view="list">{body}</Card>
}

// ---- 可用策略（engine.catalog）→ 新建并启动 ------------------------------------------------

type NewStart = { key: string; accountId: string; text: string; interval: StartInterval; values: Record<string, string>; busy: boolean; error: string | null; bad: string | null }
/** 标签只取括号前的短名（全文与说明在 title 里）。 */
const shortLabel = (f: ParamField): string => tk(f.label).split(/[（(]/)[0]!.trim() || f.key

function ParamInput({ f, value, bad, busy, onChange }: { f: ParamField; value: string; bad: boolean; busy: boolean; onChange(v: string): void }) {
  const id = `np-${f.key}`
  if (f.type === 'boolean') {
    const on = value === 'true'
    return <button type="button" id={id} role="switch" aria-checked={on} aria-label={f.key} aria-invalid={bad || undefined} className="g5-swb" data-param={f.key} disabled={busy} onClick={() => onChange(on ? 'false' : 'true')}><span className={'g5-sw' + (on ? ' g5-on' : '')} /></button>
  }
  if (f.type === 'select') {
    const items = (f.options ?? []).map((o) => ({ id: o, label: o }))
    const label = items.find((i) => i.id === value)?.label ?? '—'
    return <Menu trigger={<button type="button" id={id} className="g5-dd" data-param={f.key} aria-invalid={bad || undefined} disabled={busy}>{label}<Ic n="chev" s={12} /></button>} value={value} onValueChange={onChange} items={items} label={f.label} align="start" />
  }
  return (
    <span className={['g5-inp', 'g5-s', bad ? 'g5-bad' : ''].filter(Boolean).join(' ')}>
      <input id={id} data-param={f.key} aria-label={f.key} aria-invalid={bad || undefined} inputMode="decimal" value={value} disabled={busy}
        placeholder={f.type === 'text' ? '—' : undefined} onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)} />
    </span>
  )
}

function CatalogList({ cat, error, loading, engines, accounts, off, onRetry, onStarted }: {
  cat: ReturnType<typeof normalizeCatalog>; error: Error | null; loading: boolean; engines: readonly EngineRow[]; accounts: readonly AccountLite[]; off: boolean; onRetry(): void; onStarted(): void
}) {
  const bridge = useBridge()
  const [form, setForm] = useState<NewStart | null>(null)
  if (error && !cat.entries.length) return <Notice error={error} fail={null} onRetry={onRetry} />
  if (cat.fail) return <Notice error={null} fail={cat.fail} onRetry={onRetry} />
  if (!loading && !cat.entries.length && !cat.failures.length) return <EmptyEngines label={EMPTY_LABEL.strategies} />

  const open = (e: CatalogEntry) => {
    if (form?.key === e.key) { setForm(null); return }
    const acc = startAccounts(engines.find((x) => x.id === e.engineId), accounts)
    setForm({ key: e.key, accountId: acc[0]?.accountId ?? '', text: '', interval: DEFAULT_START_INTERVAL, values: paramSeed(e.params), busy: false, error: null, bad: null })
  }
  const doStart = async (e: CatalogEntry) => {
    if (!form) return
    const pick = readStartForm(form.text, form.interval)
    if (!pick.ok) { setForm({ ...form, error: pick.message, bad: 'instruments' }); return }
    const parsed = readParams(e.params, form.values)
    if (!parsed.ok) { setForm({ ...form, error: parsed.message, bad: parsed.key }); return }
    setForm({ ...form, busy: true, error: null, bad: null })
    const cmd = startNewCmd(e, { accountId: form.accountId, ...pick.pick }, parsed.params)
    const res = await runCommand(bridge, cmd.action, cmd.params)
    if (res.ok) { setForm(null); toast.ok(tr('已启动 {0}', e.name)); onStarted() } else if (res.cancelled) setForm({ ...form, busy: false }); else setForm({ ...form, busy: false, error: res.upstream ?? res.message })
  }

  return (
    <div className="g5-sx-tw g5-scroll">
      <table className="g5-tbl" data-table="catalog">
        <thead><tr><th className="g5-al g5-fill">{tr('策略')}</th><th>{tr('引擎')}</th><th /></tr></thead>
        <tbody>
          {loading ? <SkeletonRows n={3} widths={[200, 88, 48]} fill={0} /> : null}
          {!loading ? cat.entries.map((e) => {
            const f = form?.key === e.key ? form : null
            const acc = f ? startAccounts(engines.find((x) => x.id === e.engineId), accounts) : []
            const set = (patch: Partial<NewStart>) => f && setForm({ ...f, error: null, bad: null, ...patch })
            return [
              <tr key={e.key} className={['g5-row', f ? 'g5-open' : ''].filter(Boolean).join(' ')} data-catalog={e.id} data-engine={e.engineId} title={e.desc || undefined} data-params={e.params.map((p) => p.key).join(',')}>
                <td className="g5-fill">
                  <span className="g5-sl g5-al"><span className="g5-sym">{e.name}</span><span className="g5-s12 g5-t3">{e.name === e.id ? e.version : `${e.id} ${e.version}`}</span></span>
                  {e.desc ? <span className="g5-l2 g5-sx-desc">{e.desc}</span> : null}
                </td>
                <td><Actor kind="engine" name={e.engineId} /></td>
                <td className="g5-n"><span className="g5-acts"><button type="button" className="g5-btn g5-btn-ghost" data-act="catalog-start" aria-expanded={!!f} disabled={off} onClick={() => open(e)}>{tr('启动')}</button></span></td>
              </tr>,
              f ? (
                <tr key={`${e.key}:new`} className="g5-xrow" data-form="start-new"><td colSpan={3}>
                  <div className="g5-sx-ng">
                    <div className="g5-sx-nf"><span className="g5-k g5-al">{tr('账户')}</span>
                      {acc.length ? <Menu trigger={<button type="button" className="g5-dd" data-act="new-account" disabled={f.busy}>{acc.find((a) => a.accountId === f.accountId)?.alias ?? f.accountId}<Ic n="chev" s={12} /></button>} value={f.accountId}
                        onValueChange={(id) => set({ accountId: id })} items={acc.map((a) => ({ id: a.accountId, label: a.alias }))} label={tr('选择账户')} align="start" />
                        : <span className="g5-t3 g5-sx-none" data-state="no-account">{tr('无已绑定纸面账户')}</span>}
                    </div>
                    <div className="g5-sx-nf g5-sx-wide"><label className="g5-k g5-al" htmlFor="np-instruments">{tr('标的')}</label>
                      <span className={['g5-inp', 'g5-s', 'g5-l', f.bad === 'instruments' ? 'g5-bad' : ''].filter(Boolean).join(' ')}><input id="np-instruments" aria-label={tr('标的（逗号分隔）')} aria-invalid={f.bad === 'instruments' || undefined} placeholder="hyperliquid:BTC" value={f.text} disabled={f.busy}
                        onInput={(ev) => set({ text: (ev.currentTarget as HTMLInputElement).value })} /></span>
                    </div>
                    <div className="g5-sx-nf"><span className="g5-k g5-al">{tr('周期')}</span>
                      <Menu trigger={<button type="button" className="g5-dd" data-act="new-interval" disabled={f.busy}>{f.interval}<Ic n="chev" s={12} /></button>} value={f.interval}
                        onValueChange={(id) => { if (isStartInterval(id)) set({ interval: id }) }} items={INTERVAL_OPTIONS.map((i) => ({ id: i, label: i }))} label={tr('选择周期')} align="start" />
                    </div>
                    {e.params.map((p) => (
                      <div key={p.key} className="g5-sx-nf" title={[tk(p.label), tk(p.help ?? '')].filter(Boolean).join(' · ')}>
                        <label className="g5-k g5-al" htmlFor={`np-${p.key}`}>{shortLabel(p)}{shortLabel(p) !== p.key ? <span className="g5-t3"> {p.key}</span> : null}</label>
                        <ParamInput f={p} value={f.values[p.key] ?? ''} bad={f.bad === p.key} busy={f.busy} onChange={(v) => set({ values: { ...f.values, [p.key]: v } })} />
                      </div>
                    ))}
                  </div>
                  {f.error ? <div className="g5-sx-err" role="alert">{f.error}</div> : null}
                  <div className="g5-xacts">
                    <button type="button" className="g5-btn g5-btn-ghost" data-act="new-cancel" disabled={f.busy} onClick={() => setForm(null)}>{tr('取消')}</button>
                    <button type="button" className="g5-btn g5-btn-fill" data-act="new-confirm" disabled={f.busy || off || !acc.length} onClick={() => { void doStart(e) }}>{f.busy ? tr('启动中…') : tr('启动')}</button>
                  </div>
                </td></tr>
              ) : null,
            ]
          }) : null}
          {!loading ? cat.failures.map((x) => (
            <tr key={x.key} className="g5-row" data-failure={x.engineId}>
              <td colSpan={2}>
                <span className="g5-sl g5-al"><Actor kind="engine" name={x.engineId} /><span className="g5-danger">{tr('不可用')}</span></span>
                <span className="g5-l2"><span className="g5-bad"><Ic n="block" s={12} />{[x.name, x.message].filter(Boolean).join(' ')}</span></span>
              </td>
              <td className="g5-n"><span className="g5-acts"><button type="button" className="g5-btn g5-btn-ghost" data-act="read-retry" onClick={onRetry}>{tr('重试')}</button></span></td>
            </tr>
          )) : null}
        </tbody>
      </table>
    </div>
  )
}

// ---- 事件列表（引擎事件卡与展开区共用） ------------------------------------------------------

function EventList({ events, now, wide, align }: { events: readonly EventRow[]; now: number; wide?: boolean; align?: boolean }) {
  return (
    <div className={['g5-alist', wide ? 'g5-wide' : ''].filter(Boolean).join(' ')}>
      {events.map((e) => (
        <div key={e.key} className="g5-ar" data-key={e.key}>
          <span className={align ? 'g5-tm g5-al' : 'g5-tm'}>{clockText(e.ts, now)}</span>
          <Actor kind={e.actor.kind} name={e.actor.name} />
          <span className="g5-tx"><span className="g5-l1">{e.text}</span>{e.bad ? <span className="g5-l2"><span className="g5-bad"><Ic n="block" s={12} />{e.bad}</span></span> : e.note ? <span className="g5-l2">{e.note}</span> : null}</span>
        </div>
      ))}
    </div>
  )
}

export function EngineEventsView() {
  const off = useOffline()
  const stamp = useOfflineStamp(off)
  const now = useNow(30_000)
  const accountsQ = useRes<unknown>('account.list')
  const accounts = useMemo(() => normalizeAccounts(accountsQ.data), [accountsQ.data])
  const ev = useEngineEvents(accounts)
  const list = useRef<HTMLDivElement>(null)
  const last = useRef<{ first: string; height: number; keys: Set<string> }>({ first: '', height: 0, keys: new Set() })
  // 新事件在顶部滑入；人已经往下翻（scrollTop > 0）时补回新增高度，读到的那一行不动
  useLayoutEffect(() => {
    const el = list.current
    const first = ev.events[0]?.key ?? ''
    if (el) {
      const prev = last.current
      if (prev.first && first && first !== prev.first) {
        if (el.scrollTop > 0) el.scrollTop += el.scrollHeight - prev.height
        else for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-key]'))) if (!prev.keys.has(row.dataset.key ?? '')) void enter(row, { dy: -12, dur: 200 })
      }
      last.current = { first, height: el.scrollHeight, keys: new Set(ev.events.map((e) => e.key)) }
    }
  }, [ev.events])

  const head = (
    <header className="g5-hd"><h2 className="g5-al">{tr('引擎事件')}</h2>{!ev.loading && !ev.error && !ev.fail ? <span className="g5-ct">{ev.events.length}</span> : null}{off ? <div className="g5-r"><OfflineNote stamp={stamp} /></div> : null}</header>
  )
  let body: ComponentChildren
  if (ev.loading) body = <div className="g5-alist" aria-busy="true">{[56, 72, 96, 56].map((w, i) => <div key={i} className="g5-ar"><span className="g5-tm"><span className="g5-sk" style={{ width: 56 }} /></span><span><span className="g5-sk" style={{ width: w }} /></span><span><span className="g5-sk" style={{ width: 160 }} /></span></div>)}</div>
  else if (ev.error && !ev.events.length) body = <Notice error={ev.error} fail={null} onRetry={ev.reload} />
  else if (ev.fail) body = <Notice error={null} fail={ev.fail} onRetry={ev.reload} />
  else if (!ev.events.length) body = <div className="g5-sx-msg" data-state="empty"><span className="g5-al">{tr('还没有引擎事件')}</span></div>
  else body = <div ref={list} className="g5-sx-evs g5-scroll"><EventList events={ev.events} now={now} wide align /></div>
  return <Card head={head} className={['g5-sx-root', 'g5-grow', off ? 'g5-off' : ''].filter(Boolean).join(' ')} data-page="strategies" data-g5-page="strategies" data-block="strategies" data-view="events">{body}</Card>
}

// ---- 引擎 -----------------------------------------------------------------------------

export function EnginesView() {
  const bridge = useBridge()
  const off = useOffline()
  const stamp = useOfflineStamp(off)
  const now = useNow(30_000)
  const { accounts, model, stratQ, reload: reloadStrategies } = useStrategiesSnapshot()
  const enginesQ = useRes<unknown>('engine.list')
  useSubscribe('engine.health', () => enginesQ.reload())
  const reload = () => { enginesQ.reload(); reloadStrategies() }
  const engines = useMemo(() => normalizeEngines(enginesQ.data, model.rows, accounts), [enginesQ.data, model.rows, accounts])
  const fail = readFail(enginesQ.data)
  const loading = (enginesQ.loading && !enginesQ.data) || (stratQ.loading && !stratQ.data)
  const [arm, setArm] = useState<Arm | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [popOpen, setPopOpen] = useState(false)
  const bindBtn = useRef<HTMLButtonElement>(null)
  const run = (cmd: Cmd) => runCommand(bridge, cmd.action, cmd.params)

  const doStop = async (e: EngineRow) => {
    setArm({ key: e.id, busy: true, error: null })
    const res = await run(stopEngineCmd(e.id))
    if (res.ok) { setArm(null); reload() } else if (res.cancelled) setArm({ key: e.id, busy: false, error: null }); else setArm({ key: e.id, busy: false, error: res.message })
  }
  const doStart = async (e: EngineRow) => {
    setBusyId(e.id)
    const res = await run(startEngineCmd(e.id))
    setBusyId(null)
    if (res.ok) reload(); else if (!res.cancelled) toast.err(failureNotice(res)) // 原先失败时静默
  }

  const head = (
    <header className="g5-hd">
      <h2 className="g5-al">{tr('引擎')}</h2>{!loading && !fail && enginesQ.data ? <span className="g5-ct">{engines.length}</span> : null}
      <div className="g5-r g5-gh">
        {off ? <OfflineNote stamp={stamp} /> : engines.length ? <button type="button" ref={bindBtn} className="g5-btn g5-btn-ghost" data-act="bind-open" aria-expanded={popOpen} aria-haspopup="dialog" onClick={() => setPopOpen(!popOpen)}><Ic n="lock" s={12} />{tr('绑定账户')}</button> : null}
      </div>
    </header>
  )
  let body: ComponentChildren
  if (loading) body = [0, 1].map((i) => <div key={i} className="g5-krow"><div className="g5-top"><span className="g5-sk" style={{ width: 120 + i * 16 }} /></div><span className="g5-sk" style={{ width: 48, height: 28 }} /><div className="g5-sub"><span className="g5-sk" style={{ width: 160 - i * 48 }} /></div><div className="g5-sub"><span className="g5-sk" style={{ width: 200 - i * 16 }} /></div></div>)
  else if (enginesQ.error && !enginesQ.data) body = <Notice error={enginesQ.error} fail={null} onRetry={reload} />
  else if (fail) body = <Notice error={null} fail={fail} onRetry={reload} />
  else if (!engines.length) body = <EmptyEngines label={EMPTY_LABEL.engines} />
  else body = engines.map((e) => {
    const hb = heartbeatAge(e.lastHeartbeatAt, now)
    return arm?.key === e.id ? (
    <div key={e.id} className="g5-krow g5-sx-krow-armed"><ArmedBar what={stopEngineText(e)} confirm={tr('确认停止')} busyLabel={tr('停止中…')} busy={arm.busy} error={arm.error} act="stop-engine" onConfirm={() => { void doStop(e) }} onCancel={() => setArm(null)} /></div>
  ) : (
    <div key={e.id} className="g5-krow" data-engine={e.id} data-state={e.state}>
      <div className="g5-top"><span className="g5-al"><Actor kind="engine" name={e.id} /></span>{e.version ? <span className="g5-s11 g5-t3">{e.version}</span> : null}<span className={e.tone === 'bad' ? 'g5-danger' : e.tone === 'warn' ? 'g5-warn' : e.tone === 'dim' ? 'g5-t3' : 'g5-tb'}>{e.stateText}</span></div>
      {e.canStop
        ? <button type="button" className="g5-btn g5-btn-ghost" data-act="stop-engine" disabled={off} onClick={() => setArm({ key: e.id, busy: false, error: null })}>{tr('停止')}</button>
        : <button type="button" className="g5-btn g5-btn-ghost" data-act="start-engine" disabled={off || e.busy || busyId === e.id} onClick={() => { void doStart(e) }}>{tr('启动')}</button>}
      <div className="g5-sub"><span>{tr('绑定 ')}<b>{e.bound.length}</b></span>{e.bound.map((n) => <span key={n}><b>{n}</b></span>)}<span>{tr('心跳 ')}<b className={hb.stale ? 'g5-warn' : undefined}>{hb.text}</b></span></div>
      {e.detail && !e.canStop ? <div className="g5-sub"><span><span className="g5-bad"><Ic n="block" s={12} />{e.detail}</span></span></div>
        : <div className="g5-sub"><span>{tr('策略 ')}<b>{e.strategies}</b></span><span>{tr('运行 ')}<b>{e.running}</b></span>{e.errors ? <span>{tr('出错 ')}<b className="g5-danger">{e.errors}</b></span> : null}</div>}
    </div>
  )})
  return (
    <Card head={head} className={['g5-sx-root', off ? 'g5-off' : ''].filter(Boolean).join(' ')} data-page="strategies" data-g5-page="strategies" data-block="strategies" data-view="engines">
      {body}
      {popOpen ? <BindPopover anchor={bindBtn} engines={engines} accounts={accounts} onClose={() => setPopOpen(false)} onDone={() => { setPopOpen(false); reload() }} /> : null}
    </Card>
  )
}

function BindPopover({ anchor, engines, accounts, onClose, onDone }: { anchor: { current: HTMLElement | null }; engines: readonly EngineRow[]; accounts: readonly AccountLite[]; onClose(): void; onDone(): void }) {
  const bridge = useBridge()
  const root = useRef<HTMLElement>(null)
  const paper = useMemo(() => paperAccounts(accounts), [accounts])
  const [engineId, setEngineId] = useState(engines[0]?.id ?? '')
  const [pick, setPick] = useState(paper[0]?.accountId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number } | null>(null)
  // 弹出卡挂在 body 上（不被卡片 / 瓦片裁切、不算卡内元素）：右缘对齐所在卡片，尖角对准触发钮
  useLayoutEffect(() => {
    const place = () => {
      const btn = anchor.current
      const pop = root.current
      const card = btn?.closest('[data-g5="card"]')
      if (!btn || !pop || !card) return
      const b = btn.getBoundingClientRect()
      const w = pop.offsetWidth
      const left = Math.max(8, Math.min(card.getBoundingClientRect().right - w, window.innerWidth - w - 8))
      setPos({ left, top: b.bottom + 8, arrow: b.left + b.width / 2 - left })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])
  useClickAway(root, (e: Event) => { if (!anchor.current?.contains(e.target as Node)) onClose() }, true)
  useLayoutEffect(() => { if (pos) root.current?.querySelector<HTMLElement>('[role="option"], button')?.focus() }, [pos === null])
  const engine = engines.find((e) => e.id === engineId)
  const plan = engine && pick ? bindPlan(engine, pick, accounts) : null
  const doBind = async () => {
    if (!engine || !plan?.ok) return
    setBusy(true)
    setError(null)
    const cmd = bindCmd(engine.id, plan.accounts)
    const res = await runCommand(bridge, cmd.action, cmd.params)
    setBusy(false)
    if (res.ok) onDone()
    else if (!res.cancelled) setError(res.upstream ?? res.message)
  }
  return createPortal(
    <section ref={root} className="g5-apop g5-glass" data-g5="float" role="dialog" aria-label={tr('绑定账户')} style={pos ? { left: pos.left, top: pos.top, '--arrow-x': `${pos.arrow}px` } : { visibility: 'hidden' }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
      <header className="g5-hd">
        <h2 className="g5-al">{tr('绑定账户')}</h2>
        <div className="g5-r">
          <Menu trigger={<button type="button" className="g5-dd" data-act="bind-engine">{engineId}<Ic n="chev" s={12} /></button>} value={engineId} onValueChange={setEngineId}
            items={engines.map((e) => ({ id: e.id, label: e.id }))} label={tr('选择引擎')} align="end" />
        </div>
      </header>
      <div className="g5-pb">
        {paper.map((a) => (
          <div key={a.accountId} className="g5-opt" role="option" tabIndex={0} aria-selected={pick === a.accountId} data-account={a.accountId}
            onClick={() => setPick(a.accountId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPick(a.accountId) } }}>
            <span className="g5-acct g5-al"><span className="g5-t1">{a.alias}</span><span className="g5-t3">{tr('纸面')}</span><span className="g5-papermk" title={tr('纸面账户')} /></span>
            <span className="g5-r">{pick === a.accountId ? <Ic n="check" /> : null}</span>
          </div>
        ))}
        {paper.length ? null : <div className="g5-fact g5-al">{tr('没有纸面账户')}</div>}
        <div className="g5-fact g5-al" data-state={plan && !plan.ok ? 'blocked' : undefined}><Ic n="lock" s={12} />{plan && !plan.ok ? plan.reason : tr('实盘账户另签授权书后绑定')}</div>
        {error ? <div className="g5-sx-err" role="alert">{error}</div> : null}
        <div className="g5-pacts">
          <button type="button" className="g5-btn g5-btn-ghost" data-act="bind-cancel" onClick={onClose}>{tr('取消')}</button>
          <button type="button" className="g5-btn g5-btn-primary" data-act="bind-confirm" disabled={busy || !plan?.ok} onClick={() => { void doBind() }}><Ic n="lock" />{busy ? tr('绑定中…') : tr('绑定')}</button>
        </div>
      </div>
    </section>,
    document.body,
  )
}
