// SPDX-License-Identifier: CPAL-1.0
// 持仓卡（视觉轮 r4）：按账户分组的持仓表（实盘组在上、纸面组在下，小计不跨组相加），每行常显 平仓 / 止损 / ⌄；展开区三栏 = 明细 · 事件链 · 部分平仓与止损表单。
// 权益 / 今日盈亏移到总览条（statusbar 块）。数据经桥（查询取快照，account.* / proposal.* 事件收增量）。
// 写命令只有三条人面命令，都要人点击触发：position.close（平仓 / 部分平仓）、order.place（stop_market + reduceOnly 止损单）、order.cancel（撤旧止损）。
// 改止损不原子：先挂新单、再撤旧单（两张都是 reduceOnly，重叠期间不增加敞口；原子改价记内核工单 K-r4-1）。
// 内核离线（G5）期间数字照旧可看、去涨跌色（正负号保留，IXD F9-1），行内动作禁用并就地写「离线」。
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useLink, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { Button, F, InlineConfirm, Skeleton, SkeletonSlow, TextInput, toast } from '@gitrader/workbench/ui'
import type { RefObject } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { cancelOrder, closePosition, placeStop } from './actions'
import { Q, T } from './api'
import { useAccountsData, useFeedState, useNow, useOffline, usePositionLedger, useRes } from './hooks'
import { actorNames, keyTiers, normalizeProposals } from './model-activity'
import { buildPositionChain, checkStopPrice, groupRows, isNew, liqDistancePct, nearLiq, partialSize, pendingOf, roePct, stopIntent, type ChainStep, type PositionRow } from './model-positions'
import { MarkFreshness } from './feed'
import { Actor, CardHead, ErrorState } from './shared'
import { fmtLoose } from './util'
import { t as tr } from '@gitrader/workbench/i18n'

type Tone = 'up' | 'down' | 'flat'
type RowState = 'armed' | 'closing' | 'closed' | 'stop-updating'
/** 平掉的行「已平」至少停留这么久，且持仓事件到了才收起。 */
const CLOSED_HOLD_MS = 1200
/** 「已平」最多停这么久：持仓事件一直没把行拿走就撤掉「已平」，回到正常行（不让假的成功常驻）。 */
const CLOSED_MAX_MS = 5000

const CHAIN_LABEL: Record<ChainStep['kind'], string> = { position: tr('持仓'), fill: tr('成交'), proposal: tr('提案'), origin: tr('来源') }
const pct1 = (v: number) => `${v.toFixed(1)}%`
const clean = (t: string) => t.replace(/,/g, '').trim()

/** 事件链：网格 64 / 1fr（时间 · 事件），每条单行、超长省略，悬停 title 看全文；结果字跟在事件后（§10 F04），不成列。成交 / 提案的标题自带动词，不再前缀类别字。 */
function Chain({ row, names }: { row: PositionRow; names: Record<string, string> }) {
  const led = usePositionLedger(row)
  if (led.phase === 'loading') return <div className="gb-chain gb-chain--wait" aria-busy="true"><Skeleton h={10} w="60%" /><Skeleton h={10} w="80%" /><Skeleton h={10} w="50%" /></div>
  if (led.phase === 'error') return <div className="gb-chain gb-pos__err" title={led.error?.message}>{led.error?.message}</div>
  const steps = buildPositionChain(row, led.entries, led.proposals)
  return (
    <ol className="gb-chain" aria-label={tr('事件链')}>
      {steps.map((s) => (
        <li key={s.id} className={'gb-chain__step is-' + s.kind + (s.tone ? ' gb-chain__step--' + s.tone : '')}>
          <span className="gb-chain__t gr-num">{s.ts ? F.hms(s.ts) : ''}</span>
          <span className="gb-chain__v" onMouseEnter={(e) => { e.currentTarget.title = e.currentTarget.innerText }}>
            {s.kind === 'position' || s.kind === 'origin' ? <span className="gb-chain__k">{CHAIN_LABEL[s.kind]}</span> : null}
            {s.origin ? <Actor origin={s.origin} names={names} /> : null}
            {s.kind === 'origin' ? null : <span>{s.title}</span>}
            {s.detail ? <span className="gb-chain__r">{s.kind === 'origin' ? '· ' : ''}{s.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

interface Ctl {
  offline: boolean
  state: RowState | null
  err: string | null
  focusStop: boolean
  onArmed(armed: boolean): void
  onClose(size?: string): Promise<unknown>
  onSaveStop(text: string): Promise<boolean>
  onClearStop(): void
  onLocalErr(msg: string | null): void
}

/** 展开区：左 明细（定义列表）· 中 事件链 · 右 部分平仓 + 止损表单。和行同一块 3.5% 底（行的首末格只做上圆角、展开格只做下圆角），不另起卡。 */
function Detail({ row, names, ctl }: { row: PositionRow; names: Record<string, string>; ctl: Ctl }) {
  const full = String(row.position.size ?? row.size)
  const [qty, setQty] = useState(full)
  const [pick, setPick] = useState<number | null>(100)
  const [stop, setStop] = useState('')
  const stopRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { if (ctl.focusStop) stopRef.current?.focus() }, [ctl.focusStop])
  const q = clean(qty)
  const qtyOk = /^\d+(\.\d+)?$/.test(q) && Number(q) > 0 && Number(q) <= Math.abs(row.size)
  const chk = stop.trim() === '' ? null : checkStopPrice(row, stop)
  const busy = ctl.state === 'stop-updating'
  // 返工 S-2：持仓太小、按比例截到 0 时比例钮置灰并就地说明
  const noPct = !partialSize(row, 25) || !partialSize(row, 50)
  const margin = row.leverage ? row.notional / row.leverage : null
  const save = async () => { if (chk && chk.ok && !busy && !ctl.offline && (await ctl.onSaveStop(stop))) setStop('') }
  let hint
  if (ctl.offline) hint = <span className="gb-stop__hint">{tr('离线')}</span>
  else if (chk && !chk.ok) hint = <span className="gb-stop__hint" data-bad="">{chk.message}</span>
  else if (chk && chk.ok && row.markPrice !== null) hint = <span className="gb-stop__hint">{tr('距标记价 ')}{pct1((Math.abs(row.markPrice - Number(chk.price)) / row.markPrice) * 100)}</span>
  else hint = <span className="gb-stop__hint">{tr('距标记价')}</span>
  return (
    <div className="gb-detail__grid">
      <dl className="gb-detail__kv">
        <dt>{tr('账户')}</dt><dd title={row.accountAlias}>{row.accountAlias} {row.mode === 'live' ? tr('实盘') : tr('纸面')}</dd>
        <dt className="gb-detail__entry">{tr('开仓价')}</dt><dd className="gb-detail__entry gr-num">{F.price(row.entryPrice)}</dd>
        <dt>{tr('名义')}</dt><dd className="gr-num">{F.usd(row.notional)}</dd>
        {margin !== null ? <><dt>{tr('保证金')}</dt><dd className="gr-num">{F.usd(margin)}</dd></> : null}
        {row.funding !== null ? <><dt>{tr('资金费')}</dt><dd className={'gr-num gr-' + (ctl.offline ? 'flat' : F.tone(row.funding))}>{F.signed(row.funding)}</dd></> : null}
        {row.openedAt !== null ? <><dt>{tr('开仓')}</dt><dd className="gr-num">{F.hm(row.openedAt)}</dd></> : null}
      </dl>
      <Chain row={row} names={names} />
      <div className="gb-detail__form">
        <div className="gb-detail__row">
          <span className="gb-detail__lab">{tr('平仓数量')}</span>
          <TextInput size="sm" className="gb-detail__inp" value={qty} aria-label={tr('平仓数量')} invalid={!qtyOk} onChange={(v: string) => { setQty(v); setPick(null) }} />
          <span className="gb-detail__pct">
            {[25, 50, 100].map((p) => (
              <Button key={p} variant="text" size="sm" className={pick === p ? 'is-on' : undefined} aria-pressed={pick === p} data-pct={p} disabled={!partialSize(row, p)}
                onClick={() => { const v = partialSize(row, p); if (v) { setQty(v); setPick(p) } }}>{p === 100 ? tr('全部') : `${p}%`}</Button>
            ))}
          </span>
        </div>
        <div className="gb-detail__row">
          <span className="gb-detail__lab" />
          <InlineConfirm dataAct="pos-partial" label={tr('按市价平仓')} confirmLabel={tr('确认平仓')} confirmVariant="kill" busyLabel={tr('平仓中…')} variant="secondary" size="sm" disabled={ctl.offline || !qtyOk}
            onConfirm={() => ctl.onClose(q === full ? undefined : q)} />
          {noPct ? <span className="gb-stop__hint" data-pct-none="">{tr('无法按比例平仓')}</span> : null}
        </div>
        <div className="gb-detail__row">
          <span className="gb-detail__lab">{tr('止损触发价')}</span>
          <TextInput size="sm" className="gb-detail__inp" value={stop} placeholder={tr('触发价')} aria-label={tr('止损触发价')} inputRef={stopRef} invalid={!!(chk && !chk.ok)}
            onChange={(v: string) => { setStop(v); ctl.onLocalErr(null) }} onEnter={() => { void save() }} />
          {hint}
        </div>
        <div className="gb-detail__row">
          <span className="gb-detail__lab" />
          <Button size="sm" data-act="stop-save" busy={busy} disabled={ctl.offline || !chk || !chk.ok} onClick={() => { void save() }}>{busy ? tr('更新中…') : tr('保存止损')}</Button>
          {row.stop ? <Button variant="text" size="sm" data-act="stop-clear" disabled={ctl.offline || busy} onClick={ctl.onClearStop}>{tr('清除')}</Button> : null}
        </div>
        {ctl.err ? <div className="gb-pos__err" role="alert" title={ctl.err}>{ctl.err}</div> : null}
      </div>
    </div>
  )
}

function Row({ row, open, names, tone, now, pend, ctl, onToggle, onStop, onGoPending }: {
  row: PositionRow; open: boolean; names: Record<string, string>; tone(v: number): Tone; now: number; pend: string | null; ctl: Ctl
  onToggle(): void; onStop(): void; onGoPending(id: string): void
}) {
  const roe = roePct(row)
  const dist = liqDistancePct(row)
  const st = ctl.state
  const armed = st === 'armed' || st === 'closing'
  return (
    <>
      <tr className={'is-click' + (open ? ' is-open' : '') + (row.mode !== 'live' ? ' is-paper' : '')} tabIndex={0} data-row={row.key} data-state={st ?? undefined} aria-expanded={open}
        onClick={(e) => { if (!(e.target as Element).closest('button, input, label, a')) onToggle() }}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle() } }}>
        <td data-col="sym" className="gr-td-l">
          <span className="gb-sym">
            <span className="gb-sym__code">{row.symbol}</span>
            <span className="gb-sym__d">{F.posSideWord(row.side)}{row.leverage ? ` ${row.leverage}×` : ''}</span>
            {isNew(row, now) ? <span className="gb-sym__flag" data-flag="new">{tr('新')}</span> : null}
            {nearLiq(row) ? <span className="gb-sym__flag gr-warn" data-flag="near-liq">{tr('近强平')}</span> : null}
            {pend ? <button type="button" className="gb-sym__pend" data-act="pos-goto-pending" onClick={() => onGoPending(pend)}>{tr('有待批')}</button> : null}
          </span>
        </td>
        <td data-col="size">{fmtLoose(row.size)}</td>
        <td data-col="entry">{F.price(row.entryPrice)}</td>
        <td data-col="mark">{F.price(row.markPrice)}<MarkFreshness markTs={row.position.markTs} /></td>
        <td data-col="upnl" className={'gr-' + tone(row.unrealizedPnl)}><span className="gb-pos__v">{F.signed(row.unrealizedPnl)}</span>{roe !== null ? <span className="gb-pos__s">{F.signedPct(roe)}</span> : null}</td>
        <td data-col="liq">{row.liquidationPrice === null ? <span className="gb-pos__v">{tr('无')}</span> : <><span className="gb-pos__v">{row.estimated ? '≈ ' : ''}{F.price(row.liquidationPrice)}</span>{dist !== null ? <span className="gb-pos__s"><span className="gb-pos__cjk">{tr('距')}</span> <span className="gr-num">{pct1(dist)}</span></span> : null}</>}</td>
        <td data-col="sl" className="gr-td-l">{st === 'stop-updating' ? tr('更新中…') : row.stop?.triggerPrice != null ? <span className="gb-stop__v">{F.price(row.stop.triggerPrice)}</span> : tr('未设')}</td>
        <td data-col="opener" className="gr-td-l"><Actor origin={row.executor} names={names} /></td>
        <td data-col="act">
          {st === 'closed' ? <span className="gb-pos__done">{tr('已平')}</span> : (
            <span className="gb-pos__acts">
              {armed ? <span className="gb-pos__what">{tr('市价平掉 {0} ', fmtLoose(row.size))} {row.symbol}</span> : ctl.offline ? <span className="gb-pos__off">{tr('离线')}</span> : null}
              <InlineConfirm dataAct="pos-close" label={tr('平仓')} confirmLabel={tr('确认平仓')} confirmVariant="kill" busyLabel={tr('平仓中…')} variant="text" size="sm" disabled={ctl.offline || st === 'stop-updating'}
                onArmedChange={ctl.onArmed} onConfirm={() => ctl.onClose()} />
              {armed ? null : <>
                <Button variant="text" size="sm" data-act="pos-stop" disabled={ctl.offline} onClick={onStop}>{tr('止损')}</Button>
                <Button variant="text" size="sm" iconOnly icon={open ? 'chevron-up' : 'chevron-down'} data-act="pos-expand" aria-expanded={open} aria-label={open ? tr('收起') : tr('展开')} onClick={onToggle} />
              </>}
            </span>
          )}
        </td>
      </tr>
      {open ? <tr className="gb-detail"><td colSpan={9}><div className="gb-detail__in"><div><Detail row={row} names={names} ctl={ctl} /></div></div></td></tr> : null}
    </>
  )
}

function PositionsBlock(_props: BlockProps) {
  const bridge = useBridge()
  const d = useAccountsData()
  const offline = useOffline(d.reload)
  const feed = useFeedState()
  const [account] = useLink<string>('account')
  const [, setSymbol] = useLink<string>('symbol')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [focusStop, setFocusStop] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, RowState>>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [ghosts, setGhosts] = useState<Record<string, { row: PositionRow; at: number }>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const keysRes = useRes<unknown>(Q.keys)
  const pendRes = useRes<unknown>(Q.proposals, { status: 'pending', limit: 50 })
  useSubscribe(T.proposals, () => pendRes.reload())
  const proposals = normalizeProposals(pendRes.data)
  const names = actorNames(keyTiers(keysRes.data, null))
  const now = useNow(30000)
  const live = account ? d.rows.filter((r) => r.accountId === account) : d.rows
  // 平掉的行：「已平」停 ≥ 1.2 s，且持仓事件已把它从数据里拿走后才收起
  const liveKeys = new Set(live.map((r) => r.key))
  const shown = [...live, ...Object.values(ghosts).filter((g) => !liveKeys.has(g.row.key)).map((g) => g.row)]
  // 返工 B-2：「已平」只是等持仓事件的过渡态——到期后行已不在 = 收起；行还在且数量变了（事件到了、没平完）或等满 CLOSED_MAX_MS = 撤掉「已平」回到正常行。
  // 只排一个到下一个截止点的定时器，不轮询。
  useEffect(() => {
    const ks = Object.keys(ghosts)
    if (!ks.length) return undefined
    const t0 = Date.now()
    const age = (k: string) => t0 - ghosts[k]!.at
    const done = ks.filter((k) => {
      if (age(k) < CLOSED_HOLD_MS) return false
      const cur = live.find((r) => r.key === k)
      return !cur || cur.size !== ghosts[k]!.row.size || age(k) >= CLOSED_MAX_MS
    })
    if (done.length) {
      setGhosts((g) => { const n = { ...g }; for (const k of done) delete n[k]; return n })
      setStates((s) => { const n = { ...s }; for (const k of done) if (n[k] === 'closed') delete n[k]; return n })
      if (openKey && done.includes(openKey) && !liveKeys.has(openKey)) setOpenKey(null)
      return undefined
    }
    const next = Math.min(...ks.map((k) => (age(k) < CLOSED_HOLD_MS ? CLOSED_HOLD_MS : CLOSED_MAX_MS) - age(k)))
    const t = setTimeout(() => setGhosts((g) => ({ ...g })), Math.max(20, next + 20))
    return () => clearTimeout(t)
  })
  // 陈旧（离线）期间去掉涨跌色：数字降到 text-2，正负号保留（IXD F9-1）
  const tone = (v: number): Tone => (offline || feed !== 'live' ? 'flat' : (F.tone(v) as Tone))
  const setState = (k: string, v: RowState | null, only?: RowState[]) => setStates((s) => {
    if (only && !only.includes(s[k] as RowState)) return s
    const n = { ...s }
    if (v) n[k] = v
    else delete n[k]
    return n
  })
  const setErr = (k: string, v: string | null) => setErrs((e) => { const n = { ...e }; if (v) n[k] = v; else delete n[k]; return n })

  const ctlOf = (r: PositionRow): Ctl => ({
    offline, state: states[r.key] ?? null, err: errs[r.key] ?? null, focusStop: focusStop === r.key,
    onArmed: (a) => setState(r.key, a ? 'armed' : null, a ? undefined : ['armed', 'closing']),
    onLocalErr: (m) => setErr(r.key, m),
    // 平仓 / 部分平仓：失败抛出原文（InlineConfirm 留在武装态、原文就地显示、可重试）+ toast.err 原文（与批准 / 接管一致，G4）；PIN 被取消 = 什么都没发生
    async onClose(size) {
      const whole = !size
      if (whole) setState(r.key, 'closing')
      const res = await closePosition(bridge, { accountId: r.accountId, instrumentId: r.instrumentId, ...(size ? { size } : {}) })
      if (res.ok) {
        if (whole) { setGhosts((g) => ({ ...g, [r.key]: { row: r, at: Date.now() } })); setState(r.key, 'closed') }
        return undefined
      }
      if (whole) setState(r.key, res.cancelled ? null : 'armed', ['closing'])
      if (res.cancelled) return undefined
      toast.err(res.message)
      throw new Error(res.message)
    },
    // 止损：先挂新单、成功后再撤旧单（同一次点击的处理链里连续发出，不加定时器）
    async onSaveStop(text) {
      const chk = checkStopPrice(r, text)
      if (!chk.ok) { setErr(r.key, chk.message); return false }
      const old = r.stop
      setErr(r.key, null)
      setState(r.key, 'stop-updating')
      try {
        const placed = await placeStop(bridge, stopIntent(r, chk.price))
        if (!placed.ok) { if (!placed.cancelled) setErr(r.key, placed.message); return false }
        if (old?.orderId) {
          const c = await cancelOrder(bridge, r.accountId, old.orderId)
          if (!c.ok && !c.cancelled) { setErr(r.key, c.message); toast.err(tr('新止损已挂上，旧止损没有撤销：{0}', c.message)) }
        }
        return true
      } finally { setState(r.key, null, ['stop-updating']) }
    },
    onClearStop() {
      const old = r.stop
      if (!old?.orderId) return
      setErr(r.key, null)
      setState(r.key, 'stop-updating')
      void cancelOrder(bridge, r.accountId, old.orderId).then((c) => { if (!c.ok && !c.cancelled) setErr(r.key, c.message) }).finally(() => setState(r.key, null, ['stop-updating']))
    },
  })

  const toggle = (r: PositionRow) => {
    const next = openKey === r.key ? null : r.key
    setOpenKey(next)
    setFocusStop(null)
    if (next) { try { setSymbol(r.instrumentId) } catch { /* 没声明联动写权限时只展开 */ } }
  }
  const goPending = (id: string) => { window.dispatchEvent(new CustomEvent('gitrader:focus', { detail: { card: 'pending', proposalId: id } })) }

  let body
  if (d.phase === 'error') body = <ErrorState error={d.error} onRetry={d.reload} />
  else if (d.phase === 'loading') body = <div className="gb-pos__skel" aria-busy="true" aria-label={tr('加载中')}>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} h={12} w={i % 2 ? '86%' : '100%'} />)}<SkeletonSlow onRetry={d.reload} /></div>
  // 空态一行字、不画图标格（VISUAL §4）；「还没有账户」不配说明句，给动作（IXD F9-5）
  else if (!d.accounts.length) body = <div className="gb-pos__empty">{tr('还没有账户')}<Button variant="text" size="sm" data-act="open-settings" onClick={() => { location.hash = '#/settings/keys' }}>{tr('打开设置')}</Button></div>
  else if (!shown.length) body = <div className="gb-pos__empty">{tr('当前没有持仓')}</div>
  else {
    body = (
      <div className="gr-tablewrap gb-pos__table">
        <table className="gr-table gb-table">
          <thead>
            <tr>
              <th data-col="sym" className="gr-th-l">{tr('标的')}</th>
              <th data-col="size">{tr('数量')}</th>
              <th data-col="entry">{tr('开仓价')}</th>
              <th data-col="mark">{tr('标记价')}</th>
              <th data-col="upnl">{tr('未实现')}</th>
              <th data-col="liq">{tr('强平价')}</th>
              <th data-col="sl" className="gr-th-l">{tr('止损')}</th>
              <th data-col="opener" className="gr-th-l">{tr('开仓方')}</th>
              <th data-col="act" aria-label={tr('动作')} />
            </tr>
          </thead>
          <tbody>
            {groupRows(shown).map((g) => [
              <tr key={'g' + g.accountId} className="gb-grp" data-acct={g.accountId}>
                <td data-col="sym" className="gr-td-l">{g.alias}<span className="gb-grp__n">{g.mode === 'live' ? tr('实盘') : tr('纸面')} {g.rows.length}</span></td>
                <td data-col="size" /><td data-col="entry" /><td data-col="mark" />
                <td data-col="upnl" className={'gr-' + tone(g.subtotal)}>{F.signed(g.subtotal)}</td>
                <td data-col="liq" /><td data-col="sl" /><td data-col="opener" /><td data-col="act" />
              </tr>,
              ...g.rows.map((r) => (
                <Row key={r.key} row={r} open={openKey === r.key} names={names} tone={tone} now={now} pend={pendingOf(r, proposals)} ctl={ctlOf(r)}
                  onToggle={() => toggle(r)} onStop={() => { if (openKey !== r.key) toggle(r); setFocusStop(r.key) }} onGoPending={goPending} />
              )),
            ])}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <div ref={rootRef} className="gb gb-pos" data-feed={feed} data-offline={offline ? '1' : undefined}>
      <CardHead title={tr('持仓')} count={live.length} rootRef={rootRef as RefObject<HTMLElement>} />
      {body}
    </div>
  )
}

export const positionsBlock = defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.positions',
    name: tr('持仓与盈亏'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './positions.js', element: 'gr-positions' },
    isolation: 'inline',
    size: { minW: 8, minH: 5, defaultW: 15, defaultH: 9 },
    inputs: {
      events: [
        { topic: 'account.positions', maxHz: 4 },
        { topic: 'account.summary', maxHz: 2 },
        { topic: 'account.fills', maxHz: 4 },
        { topic: 'account.orders', maxHz: 4 },
        { topic: 'proposal.*' },
      ],
      queries: ['account.list', 'account.summary', 'account.positions', 'account.fills', 'account.orders', 'ledger.query', 'agentkey.list', 'proposal.list'],
    },
    permissions: ['account.read', 'ledger.read'],
    actions: ['position.close', 'order.place', 'order.cancel'],
    linkGroups: [{ group: 'symbol', mode: 'readwrite' }, { group: 'account', mode: 'read' }],
    fixtures: ['./fixtures/positions.json'],
  },
  component: PositionsBlock,
})
