// SPDX-License-Identifier: CPAL-1.0
// 下单票据（positions 块的 {view:'ticket'}）：人手下单 = 账户 / 方向 / 类型 / 价格 / 数量 / 仅减仓；提交前 G2 武装行写后果，确认后发 order.place。
// 实盘账户且钥匙库锁着时内核回 ATTESTATION_REQUIRED，壳的 PIN 弹层接手并带证明重发；被拒时键上方写一行人话原因（原文留在括号里），
// 回包说 retryable:false 的拒绝把确认键置灰，数量 / 价格 / 方向 / 类型任一输入变了才恢复。
// 成交 / 挂单推送 → 重查一次「可用」（节流 ≥ 1 秒）；本单部分成交写一行「部分成交 x / y」。
// Agent 只能提议：本卡只有「人」的下单，没有替 Agent 执行的入口。
import type { BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useSubscribe } from '@gitrader/blocks-sdk/preact'
import type { InstrumentPriceRule, PrecheckEstimates } from '@gitrader/protocol/types'
import { Menu, toast } from '@gitrader/workbench/ui'
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { placeStop as placeOrder } from '../../../blocks-default/src/actions'
import { formatPrice } from '../../../blocks-default/src/display'
import { queryRetry, useOffline } from '../../../blocks-default/src/hooks'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import { usePriceDisplay } from '../../../blocks-default/src/price-display'
import { normalizeAccounts, type AccountLite } from '../../../blocks-default/src/model-positions'
import { isRec, toNum } from '../../../blocks-default/src/util'
import { Card, Empty, ErrorText, Unwired, VenueIcon, wireState } from '../kit'
import {
  TICKET_TYPES, cleanDec, defaultAccount, quotePrice, sizeByPct, ticketFee, ticketIntent, ticketNotional, ticketSummary,
  type TicketForm, type TicketSide, type TicketType,
} from '../model-chart'
import { fmtMoney } from '../model-records'
import {
  afterInput, confirmLocked, fillProgressOf, forAccount, inputSignature, liqEstimateLine, partialFillLine, previewEstimates,
  refreshWait, rejectionLine, rejectionOf, sameOrder, ticketStatus, type FillProgress, type TicketStatus,
} from '../model-ticket'
import { ArmedBar, PausedFor, useInstrumentId, useInstruments, useOfflineSince } from './symbol-positions'
import './chart.css'
import { t as tr } from '@gitrader/workbench/i18n'

const Chev = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>
const TRI_UP = 'M4 .5L7.5 7h-7z'
const TRI_DOWN = 'M4 7.5L.5 1h7z'
const errOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
const modeWord = (a: Pick<AccountLite, 'mode'>): string => (a.mode === 'live' ? tr('实盘') : tr('纸面'))

/** 价格目录还没到时的退回规则：HL 系价格最多 5 位有效数字。 */
const FALLBACK_PRICE_RULE: InstrumentPriceRule = { sigFigs: 5 }
/** 预填价：参考价按标的价格规则截断（formatPrice，与记录页同一套），去千分位，能直接提交。 */
export const prefillPrice = (ref: string, rule?: InstrumentPriceRule): string => formatPrice(ref, rule ?? FALLBACK_PRICE_RULE).replace(/,/g, '')
/** 精度被拒的那一行补上规则：`价格或数量精度不对：BTC 价格最多 5 位有效数字，例如 77316（内核原文）`。 */
export function withPriceRule(line: string | null, base: string, rule: InstrumentPriceRule | undefined, ref: string | null): string | null {
  const head = tr('价格或数量精度不对')
  if (!line?.startsWith(head) || !rule?.sigFigs) return line
  const example = ref ? tr('，例如 {0}', prefillPrice(ref, rule)) : ''
  return tr('{0}：{1} 价格最多 {2} 位有效数字{3}{4}', head, base || tr('该标的'), rule.sigFigs, example, line.slice(head.length))
}

interface Arm { busy: boolean; error: string | null }

/** 账户列表 + 所选账户的可用额 + 参考价（最新价）。读不到的补充项只让对应数字留空。 */
function useTicketData(instrumentId: string | null, accountId: string) {
  const bridge = useBridge()
  const [accounts, setAccounts] = useState<{ phase: 'loading' | 'ready' | 'error'; list: AccountLite[]; error: Error | null }>({ phase: 'loading', list: [], error: null })
  const [available, setAvailable] = useState<number | null>(null)
  const [ref, setRef] = useState<string | null>(null)
  const [n, setN] = useState(0)
  const [a, setA] = useState(0)
  const pokeAt = useRef(0)
  const pokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 账户成交 / 挂单推送 → 稍后重查一次「可用」；同一秒内连推多次只查一次（节流 ≥ 1 秒），内核不推也无妨
  const poke = useCallback(() => {
    if (pokeTimer.current) return
    pokeTimer.current = setTimeout(() => {
      pokeTimer.current = null
      pokeAt.current = Date.now()
      setA((x) => x + 1)
    }, refreshWait(pokeAt.current, Date.now()))
  }, [])
  useEffect(() => () => { if (pokeTimer.current) clearTimeout(pokeTimer.current) }, [])
  useSubscribe('account.fills', (e) => { if (forAccount(e.data, accountId)) poke() })
  useSubscribe('account.orders', (e) => { if (forAccount(e.data, accountId)) poke() })
  useSubscribe('market.quote', (e) => {
    const d = e.data as { instrumentId?: string }
    const p = quotePrice(e.data)
    if (d?.instrumentId === instrumentId && p !== null) setRef(String(p))
  })
  useEffect(() => {
    let dead = false
    queryRetry<unknown>(bridge, 'account.list', undefined, () => !dead).then(
      (raw) => { if (!dead) setAccounts({ phase: 'ready', list: normalizeAccounts(raw), error: null }) },
      (e: unknown) => { if (!dead) setAccounts({ phase: 'error', list: [], error: errOf(e) }) },
    )
    return () => { dead = true }
  }, [bridge, n])
  useEffect(() => {
    if (!accountId) { setAvailable(null); return undefined }
    let dead = false
    queryRetry<unknown>(bridge, 'account.summary', { accountId }, () => !dead).then(
      (raw) => { if (!dead) setAvailable(isRec(raw) ? toNum(raw.available) : null) },
      () => { if (!dead) setAvailable(null) },
    )
    return () => { dead = true }
  }, [bridge, accountId, a])
  useEffect(() => {
    if (!instrumentId) { setRef(null); return undefined }
    let dead = false
    setRef(null)
    queryRetry<unknown>(bridge, 'market.quote', { instrumentId }, () => !dead).then(
      (raw) => { const p = quotePrice(raw); if (!dead && p !== null) setRef(isRec(raw) && typeof raw.price === 'string' ? raw.price : String(p)) },
      () => { /* 参考价只是补充 */ },
    )
    return () => { dead = true }
  }, [bridge, instrumentId])
  return { accounts, available, ref, reload: () => setN((x) => x + 1) }
}

export function TicketView({ config }: BlockProps) {
  const bridge = useBridge()
  const off = useOffline()
  const since = useOfflineSince(off)
  const instrumentId = useInstrumentId(config)
  const [pickedAccount, setPickedAccount] = useState('')
  const [side, setSide] = useState<TicketSide>('buy')
  const [type, setType] = useState<TicketType>('limit')
  const [price, setPrice] = useState('')
  const [size, setSize] = useState('')
  const [reduceOnly, setReduceOnly] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const [arm, setArm] = useState<Arm | null>(null)
  const [status, setStatus] = useState<TicketStatus>({ rejection: null, signature: '' })
  const [live, setLive] = useState<FillProgress | null>(null)
  const [estimates, setEstimates] = useState<PrecheckEstimates | null>(null)
  const priced = useRef(false)

  const data = useTicketData(instrumentId, pickedAccount)
  const instruments = useInstruments()
  const prices = usePriceDisplay()
  const meta = instrumentId ? instruments.info.get(instrumentId) ?? null : null
  const units = meta?.base && meta.quote ? { base: meta.base, quote: meta.quote } : null
  const account = data.accounts.list.find((a) => a.accountId === pickedAccount) ?? defaultAccount(data.accounts.list, instrumentId)
  const accountId = account?.accountId ?? ''
  // 所选账户变了 → 可用额重查（useTicketData 看的是 pickedAccount；缺省账户也要）
  useEffect(() => { if (!pickedAccount && accountId) setPickedAccount(accountId) }, [accountId])
  // 换标的：价格清零重新带入参考价，武装解除；上一标的的成交进度 / 强平估算跟着作废
  useEffect(() => { priced.current = false; setPrice(''); setSize(''); setPct(null); setArm(null); setLive(null); setEstimates(null) }, [instrumentId])
  // 预填价按标的价格规则截断（与记录页同一个 formatPrice；HL 价格 ≤ 5 位有效数字），否则原始中间价会被内核按精度拒绝（release-r1 P0-3）。
  // 目录没到时先按 5 位有效数字填；规则晚到且用户没改过价格，就按真规则再截一次。
  const rule = prices.rule(instrumentId ?? undefined)
  const prefilled = useRef('')
  useEffect(() => {
    if (!priced.current && data.ref) {
      priced.current = true
      prefilled.current = prefillPrice(data.ref, rule)
      setPrice((p) => p || prefilled.current)
    }
  }, [data.ref, instrumentId])
  useEffect(() => {
    if (rule && prefilled.current) setPrice((p) => (p === prefilled.current ? (prefilled.current = prefillPrice(p, rule)) : p))
  }, [rule])
  // 任一输入变了 → 上一次的拒绝作废（确认键恢复可点）
  const signature = inputSignature({ accountId, instrumentId: instrumentId ?? '', side, type, price, size, reduceOnly })
  useEffect(() => { setStatus((s) => afterInput(s, signature)) }, [signature])
  // 本单的成交进度：推送里同一单的更新覆盖回执里的旧值
  useSubscribe('account.orders', (e) => setLive((cur) => { const p = fillProgressOf(e.data); return sameOrder(cur, p) ? p : cur }))

  const form: TicketForm = { accountId, instrumentId: instrumentId ?? '', side, type, price, size, reduceOnly }
  const check = useMemo(() => ticketIntent(form), [accountId, instrumentId, side, type, price, size, reduceOnly])
  const notional = ticketNotional(form, data.ref)
  const fee = ticketFee(notional, meta?.fees)
  const sym = instrumentId ? instruments.nameOf(instrumentId) : ''
  const refForPct = type === 'market' ? data.ref : price
  const sizeUnit = units?.base ?? sym.split('-')[0] ?? ''

  const pickPct = (p: number) => {
    const s = sizeByPct(data.available, refForPct, p)
    if (s === null) return
    setSize(s)
    setPct(p)
  }
  const submit = async () => {
    if (!check.ok || confirmLocked(status)) return
    setArm({ busy: true, error: null })
    const r = await placeOrder(bridge, check.intent)
    if (r.ok) {
      setArm(null)
      setStatus(ticketStatus(null, signature))
      setLive(fillProgressOf(r.value))
      setEstimates(previewEstimates(r.value))
      setSize('')
      setPct(null)
      toast.ok(tr('订单已提交'))
      return
    }
    if (r.cancelled) { setArm(null); return }
    // 被拒：武装行里先显示内核原文（不改写）；收起武装行后，原因（人话 + 括号里的原文）留在确认键上方；retryable:false 的连确认键一起置灰
    setArm({ busy: false, error: r.message })
    setStatus(ticketStatus(rejectionOf({ message: r.message, problem: r.problem }), signature))
  }
  // 精度被拒时在人话后面补上规则和一个合法例子；括号里的内核原文照旧保留（release-r1 P0-3）
  const rejectLine = withPriceRule(rejectionLine(status), sizeUnit, rule, data.ref)
  const locked = confirmLocked(status)
  const filledLine = partialFillLine(live)
  const liqLine = liqEstimateLine(estimates)

  const head = <header className="g5-hd" data-geo="ticket.head"><h2 className="g5-al">{tr('下单')}</h2>
    <div className="g5-r">
      {off ? <PausedFor since={since} /> : null}
      {account ? <Menu label={tr('账户')} value={accountId} onValueChange={setPickedAccount} disabled={off || !!arm} className="g5-menu g5-glass" items={data.accounts.list.map((a) => ({ id: a.accountId, label: <>{a.alias}<span className="g5-s12 g5-t3">{tr('　')}　{modeWord(a)}</span></> }))}
        trigger={<button type="button" className="g5-dd" data-menu="account" disabled={off || !!arm}>{account.alias}{tr('　')}{modeWord(account)}<Chev /></button>} /> : null}
      {account && account.mode === 'live' && account.venue ? <VenueIcon venue={account.venue} label={VENUE_NAME[account.venue] ?? account.venue} size="lg" /> : null}
    </div>
  </header>
  const shell = (children: ComponentChildren) => <Card head={head} data-page="chart" data-g5-page="chart-ticket" data-geo="ticket.card">{children}</Card>

  if (data.accounts.phase === 'error' && data.accounts.error) {
    return shell(<div className="g5-pstate">{wireState(data.accounts.error) === 'off'
      ? <Unwired message={data.accounts.error.message} />
      : <><span className="g5-al">{tr('读取失败')}</span><ErrorText bare message={data.accounts.error.message} /><button type="button" className="g5-btn g5-btn-fill" data-act="retry" onClick={data.reload}>{tr('重试')}</button></>}</div>)
  }
  if (data.accounts.phase === 'loading') return shell(<div className="g5-ob" aria-busy="true"><span className="g5-sk g5-sk-seg" /><span className="g5-sk g5-sk-line" /></div>)
  if (!data.accounts.list.length) return shell(<Empty message={tr('还没有账户')} />)
  if (!instrumentId) return shell(<Empty message={tr('还没有选定标的')} />)

  const typeLabel = type === 'stop_market' ? tr('触发价') : tr('价格')
  const buttonText = `${side === 'buy' ? tr('买入') : tr('卖出')}${cleanDec(size) ? ` ${cleanDec(size)}` : ''} ${sym}`
  const body = <div className="g5-ob" data-ticket="" data-geo="ticket.body">
    <div className="g5-seg g5-al" role="group" aria-label={tr('方向')}>
      <button type="button" aria-pressed={side === 'buy'} data-side="buy" disabled={off || !!arm} onClick={() => setSide('buy')}><svg viewBox="0 0 8 8" aria-hidden="true"><path d={TRI_UP} /></svg>{tr('买入')}</button>
      <button type="button" aria-pressed={side === 'sell'} data-side="sell" disabled={off || !!arm} onClick={() => setSide('sell')}><svg viewBox="0 0 8 8" aria-hidden="true"><path d={TRI_DOWN} /></svg>{tr('卖出')}</button>
    </div>
    <div className="g5-trow">
      <div className="g5-tabs" role="tablist" aria-label={tr('类型')}>
        {TICKET_TYPES.map((t) => <button key={t.id} type="button" className="g5-tab" role="tab" data-type={t.id} aria-selected={type === t.id} disabled={off || !!arm} onClick={() => setType(t.id)}>{t.label}</button>)}
      </div>
      <button type="button" className="g5-cb" role="checkbox" aria-checked={reduceOnly} data-act="reduce-only" disabled={off || !!arm} onClick={() => setReduceOnly(!reduceOnly)}><i />{tr('只减仓')}</button>
    </div>
    <div className="g5-fgrid">
      <span className="g5-k g5-al">{typeLabel}</span>
      <label className="g5-inp"><input value={type === 'market' ? '' : price} placeholder={type === 'market' ? tr('市价') : ''} disabled={off || !!arm || type === 'market'} aria-label={typeLabel} data-field="price" inputMode="decimal"
        onInput={(e) => { setPrice((e.target as HTMLInputElement).value); setPct(null) }} />{units ? <span className="g5-u">{units.quote}</span> : null}</label>
      <span className="g5-k g5-al">{tr('数量')}</span>
      <label className="g5-inp"><input value={size} disabled={off || !!arm} aria-label={tr('数量')} data-field="size" inputMode="decimal" onInput={(e) => { setSize((e.target as HTMLInputElement).value); setPct(null) }} /><span className="g5-u">{sizeUnit}</span></label>
      <div className="g5-pct" role="group" aria-label={tr('按可用比例')}>
        {[25, 50, 100].map((p) => <button key={p} type="button" className="g5-chip" data-pct={p} aria-pressed={pct === p} disabled={off || !!arm || data.available === null || !cleanDec(refForPct ?? '')} onClick={() => pickPct(p)}>{p}%</button>)}
      </div>
    </div>
    <div className="g5-prev">
      <div><span className="g5-k g5-al">{tr('名义')}{notional?.approx ? tr(' 约') : ''}</span><span className="g5-v" data-n="pv1" data-field="notional">{notional ? fmtMoney(notional.value) : tr('未设')}</span></div>
      <div><span className="g5-k">{tr('可用')}</span><span className="g5-v" data-n="pv2">{data.available === null ? tr('未设') : fmtMoney(String(data.available))}</span></div>
      <div><span className="g5-k g5-al">{tr('手续费 约')}</span><span className="g5-v" data-n="pv1" data-field="fee">{fee === null ? tr('未设') : fmtMoney(fee)}</span></div>
      {liqLine ? <div><span className="g5-k">{tr('强平价')}</span><span className="g5-v" data-n="pv2" data-field="liq" data-est="">{liqLine}</span></div> : null}
      {filledLine ? <div style={{ gridColumn: '1 / -1' }}><span className="g5-k">{tr('本单')}</span><span className="g5-v" data-n="pv1" data-partial="" role="status">{filledLine}</span></div> : null}
    </div>
    {arm && check.ok ? <ArmedBar act="order" what={ticketSummary(form, data.ref, sym)} confirm={side === 'buy' ? tr('确认买入') : tr('确认卖出')} tone="primary" busyLabel={tr('提交中…')} busy={arm.busy} error={arm.error} onConfirm={() => { void submit() }} onCancel={() => setArm(null)} />
      : <div className="g5-oacts">
        {rejectLine ? <span className="g5-blocked g5-al" role="alert" data-blocked=""><svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></svg>{rejectLine}</span>
                    : !check.ok && size !== '' ? <span className="g5-blocked g5-al" data-hint="">{check.message}</span> : null}
        <button type="button" className="g5-btn g5-btn-primary" data-solid="" data-act="order-submit" disabled={off || !check.ok || locked} onClick={() => { setStatus(ticketStatus(null, signature)); setArm({ busy: false, error: null }) }}>{buttonText}</button>
      </div>}
  </div>
  return shell(<div className={`g5-pbody${off ? ' g5-off' : ''}`} data-state={off ? 'offline' : undefined}>{body}</div>)
}

