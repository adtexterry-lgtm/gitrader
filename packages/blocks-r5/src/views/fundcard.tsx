// SPDX-License-Identifier: CPAL-1.0
// 资金卡（r5，全站常驻、88 高液态玻璃）：实盘权益 · 今日 · 纸面 · 风险 · 网络 · 待批 N · 接管。实盘与纸面分开、不相加；没有实盘账户时主数是纸面权益。
// 出口：实盘权益 → #/funds；风险 → 风险卡取焦点；网络 → #/settings/venues；待批 N → 打开待批浮层（不跳页）；接管 → 弹出卡（三档，点哪档哪档就地武装，走壳的 PIN 层）。
// 待批浮层的三态（<html data-pend>）由这里持有：每秒推进一次 nextPend；浮层与持仓卡「有待批」通过事件找它。内核离线：整条降灰、去涨跌色、正负号保留。
import { useEffect, useRef, useState } from 'preact/hooks'
import { F } from '@gitrader/workbench/ui'
import { FOCUS_EVENT, focusCard, useAccountsData, useNow, useOffline, usePending, useStatus, useAgentRequests, type FocusDetail } from '../../../blocks-default/src/hooks'
import { soonest } from '../../../blocks-default/src/model-activity'
import { nearLiq } from '../../../blocks-default/src/model-positions'
import { budgetLevel, totalsByMode } from '../../../blocks-default/src/model-risk'
import { fmtLoose, formatCountdown } from '../../../blocks-default/src/util'
import { Amount, wireState } from '../kit'
import { Ic, Pop, Sk, TakeoverControls, amountTone, go, useTakeoverBusy } from './ovkit'
import { INITIAL_PEND, PEND_EVENT, nextPend, setPend, togglePend, type PendMachine } from './pending'
import { Term } from '../../../blocks-default/src/term'
import './overview.css'
import { t as tr } from '@gitrader/workbench/i18n'

/** 权益：整数部分 + 小数部分（小数降 text-3），「USDC」跟在后面。 */
function Equity({ v }: { v: number | null }) {
  const s = v === null ? '—' : F.usd(v)
  const i = s.lastIndexOf('.')
  return <span className="g5-eq" data-n="equity">{i < 0 ? s : s.slice(0, i)}{i < 0 ? null : <span className="g5-dec">{s.slice(i)}</span>}</span>
}

export function FundCardView() {
  const { view, error, reload } = useStatus()
  const acct = useAccountsData(false)
  const pend = usePending()
  const reqN = useAgentRequests()
  const now = useNow(1000)
  const offline = useOffline(() => { reload(); acct.reload(); pend.reload() }, true)
  const tkBusy = useTakeoverBusy()
  const tkBtn = useRef<HTMLButtonElement | null>(null)
  const [tkOpen, setTkOpen] = useState(false)
  const [m, setM] = useState<PendMachine>(INITIAL_PEND)

  // 待批三态：状态机在这里，写到 <html data-pend>（样式与浮层都读它）
  const ready = pend.phase === 'ready'
  useEffect(() => { if (ready) setM((prev) => nextPend(prev, { cards: pend.cards, now })) }, [ready, pend.cards, now])
  useEffect(() => {
    if (ready) document.documentElement.setAttribute('data-pend', m.state)
    else document.documentElement.removeAttribute('data-pend')
  }, [ready, m.state])
  useEffect(() => () => document.documentElement.removeAttribute('data-pend'), [])
  useEffect(() => {
    const onPend = (e: Event) => {
      const a = (e as CustomEvent<{ action?: string }>).detail?.action
      if (a === 'collapse') setM((p) => setPend(p, 'collapsed'))
      else if (a === 'open') setM((p) => setPend(p, 'open'))
      else if (a === 'toggle') setM(togglePend)
    }
    const onFocus = (e: Event) => { const d = (e as CustomEvent<FocusDetail>).detail; if (d?.card === 'pending') setM((p) => setPend(p, 'open')) }
    window.addEventListener(PEND_EVENT, onPend)
    window.addEventListener(FOCUS_EVENT, onFocus)
    return () => { window.removeEventListener(PEND_EVENT, onPend); window.removeEventListener(FOCUS_EVENT, onFocus) }
  }, [])

  const kernelDown = offline
  const readErr = !kernelDown && error ? error.message : null
  const p = view.primary
  const t = totalsByMode(acct.accounts, acct.summaries)
  const main = t.main === 'live' ? t.live : t.main === 'paper' ? t.paper : null
  const paper = t.main === 'live' ? t.paper : null
  const left = kernelDown ? null : view.budgetLeft
  const level = budgetLevel(left)
  const live = pend.cards.filter((c) => c.expiresAt > now)
  const urgent = soonest(live, now)
  const rows = acct.rows
  const consequence = rows.length ? tr('{0} 个持仓，实盘 {1}', rows.length, rows.filter((x) => x.mode === 'live').length) : undefined
  // 接管按钮平时中性；暂停 / 停止新开仓 / 有持仓近强平时才亮琥珀（release-r1 P1-3）
  const alert = (view.state !== null && view.state !== 'ACTIVE') || rows.some(nearLiq)
  const stateCls = view.state === 'HALTED' ? 'g5-down' : view.state === 'REDUCING' ? 'g5-warn' : 'g5-tb'
  const wsCls = kernelDown ? 'g5-danger' : p?.ws === 'err' ? 'g5-danger' : p?.ws === 'pending' ? 'g5-warn' : 'g5-tb'
  const toggle = (e: Event) => { e.stopPropagation(); setM(togglePend) }

  return <section className="g5-fund" aria-label={tr('资金')} data-g5="fund" data-g5-page="overview" data-state={kernelDown ? 'offline' : undefined}>
    <div className="g5-frow">
      <button type="button" className="g5-fs" data-act="to-funds" aria-label={tr('{0}权益，打开资金页', t.main === 'paper' ? tr('纸面') : tr('实盘'))} onClick={() => go('#/funds')}>
        <span className="g5-k">{t.main === 'paper' ? tr('纸面权益') : tr('实盘权益')}</span>
        <span className="g5-val">{acct.phase === 'loading' ? <Sk w={160} h={20} /> : <><Equity v={main?.equity ?? null} /><span className="g5-u11">USDC</span></>}</span>
      </button>
      {main && main.today !== null ? <div className="g5-fs" data-seg="today">
        <span className="g5-k">{tr('今日')}</span>
        <span className="g5-val"><span className="g5-v16" data-n="today"><Amount value={F.signed(main.today)} tone={amountTone(main.today, kernelDown)} /></span>{main.pct !== null ? <span className="g5-v12 g5-t2">{F.signedPct(main.pct)}</span> : null}</span>
      </div> : null}
      {paper && paper.equity !== null ? <div className="g5-fs" data-seg="paper">
        <span className="g5-k">{tr('纸面')}</span>
        <span className="g5-val"><span className="g5-v16 g5-tb">{F.usd(paper.equity)}</span>{paper.today !== null ? <><span className="g5-v12 g5-t3">{tr('今日')}</span><span className="g5-v12" data-n="paper-today"><Amount value={F.signed(paper.today)} tone={amountTone(paper.today, kernelDown)} /></span></> : null}</span>
      </div> : null}
      <button type="button" className="g5-fs" data-act="strip-risk" onClick={() => focusCard('risk')}>
        <span className="g5-k">{tr('风险')}</span>
        <span className="g5-val"><span className={`g5-v13 ${stateCls}`} data-state-text={kernelDown ? '' : view.state ?? ''}>{kernelDown ? '—' : view.stateLabel}</span></span>
      </button>
      <button type="button" className="g5-fs" data-act="network" onClick={() => go('#/settings/venues')} title={readErr ?? undefined}>
        <span className="g5-k">{kernelDown || readErr ? tr('网络') : view.network}</span>
        <span className="g5-val">{kernelDown
          ? <span className="g5-v13 g5-danger">{tr('内核未连接')}</span>
          : readErr ? (wireState(error) === 'off' ? <span className="g5-v13 g5-t3" data-wire="off">{tr('未接通')}</span> : <span className="g5-v13 g5-danger g5o-neterr">{readErr}</span>)
            : <><span className={`g5-v13 ${wsCls}`}>{p?.wsText ?? tr('未连接')}</span>{view.latency === null ? null : <span className="g5-v12 g5-t3">{fmtLoose(view.latency)} ms</span>}
              {p?.unverified ? <span className="g5-unv">{tr('未验证')}</span> : null}
              {level ? <span className={`g5-v12 ${level === 'low' ? 'g5-down' : 'g5-warn'}`} title={tr('场所速率预算剩余')}>{tr('预算 {0}%', Math.round(left as number))}</span> : null}</>}</span>
      </button>
      <button type="button" className="g5-fs g5-fpend" data-p="1" data-act="pending" data-pend-toggle aria-expanded={m.state === 'open'} aria-controls="g5-pendpop" onClick={toggle}>
        <span className="g5-k">{tr('待批')}</span>
        <span className="g5-val">{ready ? <span className="g5-v16 g5-n" data-n="pending">{live.length + reqN}</span> : pend.phase === 'loading' ? <Sk w={16} h={16} /> : <span className="g5-v16 g5-t3">—</span>}{ready && urgent ? <span className="g5-v12 g5-t2">{tr('最急 ')}{formatCountdown(urgent.expiresAt - now)}</span> : null}{ready ? <Ic n="chev" className="g5-chev" /> : null}</span>
      </button>
      <div className="g5-fs" data-p="0"><span className="g5-k">{tr('待批')}</span><span className="g5-val"><span className="g5-v16 g5-tb">{reqN}</span></span></div>
      <div className="g5-fs" data-seg="takeover">
        <span className="g5-k" aria-hidden="true">{' '}</span>
        <span className="g5-tkrow">{kernelDown
          ? <span title={tr('内核未连接')}><button type="button" className="g5-btn-takeover" data-act="takeover" disabled><Ic n="shield" s={16} /><Term name="接管" focusable={false} /></button></span>
          : <button ref={tkBtn} type="button" className="g5-btn-takeover" data-act="takeover" aria-haspopup="menu" aria-expanded={tkOpen} disabled={tkBusy && !tkOpen} title={tkBusy && !tkOpen ? tr('接管执行中') : undefined} onClick={() => setTkOpen(!tkOpen)} data-alert={alert ? '' : undefined}><Ic n="shield" s={16} /><Term name="接管" focusable={false} /></button>}</span>
      </div>
    </div>
    <Pop anchor={tkBtn} open={tkOpen} onClose={() => setTkOpen(false)} label={tr('接管')} width={280}>
      <div className="g5-ph">{tr('接管')}</div>
      <TakeoverControls layout="menu" offline={kernelDown} {...(consequence ? { consequence } : {})} onDone={() => { setTkOpen(false); reload() }} />
    </Pop>
  </section>
}
