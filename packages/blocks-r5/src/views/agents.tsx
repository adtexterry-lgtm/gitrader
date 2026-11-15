// SPDX-License-Identifier: CPAL-1.0
// 总览 · Agent 卡（r5）：每把钥匙一行（厂商小标 + 名字 + LLM · 最后活动 · 档位件 + 今日提议 / 拦截 + 授权范围）。
// 改档位 = 用新级别重签它的授权书（人面动作，内核要 PIN，走壳的 PIN 层），命令与 r4 相同：mandate.update。已停止 / 钥匙暂停 / 授权书到期 / 离线时先挡，免得白输一次 PIN。
// 取数复用 blocks-default 的 useKeys / useRes；今日提议 / 拦截取 risk.stats（与账本同源），动作仍数活动流窗口。
// 档位菜单里「撤销此 Agent…」：确认框写明后果，确认后 agentkey.revoke（内核要 PIN，壳弹层）；撤权是收紧，钥匙暂停 / 已停止 / 离线时菜单照开，只有改档项禁用。
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { useBridge, useSubscribe } from '@gitrader/blocks-sdk/preact'
import type { AgentPermissionTier } from '@gitrader/protocol/types'
import { toast } from '@gitrader/workbench/ui'
import { runCommand, setKeyTier } from '../../../blocks-default/src/actions'
import { Q, T } from '../../../blocks-default/src/api'
import { useKeys, useNow, useOffline, useRes } from '../../../blocks-default/src/hooks'
import { TIER_LABEL } from '../../../blocks-default/src/labels'
import { agoText, type KeyTier } from '../../../blocks-default/src/model-activity'
import { normalizeAccounts } from '../../../blocks-default/src/model-positions'
import { normalizeRisk } from '../../../blocks-default/src/model-risk'
import { fmtLoose, isRec, listOf, symbolOf, toNum } from '../../../blocks-default/src/util'
import { Actor, Card } from '../kit'
import { agentCardCounts, fmtAgentCount, localDayStart, stableKeyOrder } from '../model-agent-card'
import { useFeed } from './activity'
import { AgentGrant, grantGaps } from './agent-grant'
import { Head, Ic, Msg, Pop, Sk, cardClass, stateAttr, useOfflineClock } from './ovkit'
import './overview.css'
import { t as tr, tk } from '@gitrader/workbench/i18n'

const TIER_MENU: readonly AgentPermissionTier[] = ['read_only', 'paper', 'confirm', 'auto_limited']
const STATS_POLL_MS = 15_000
const ymd = (ts: number) => { const d = new Date(ts); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
const md = (ts: number): string => ymd(ts).slice(5)
const expiryText = (keyAt: number | null, mandateAt: number | null): string | null => {
  if (keyAt === null) return mandateAt === null ? null : tr('授权到期 {0}', md(mandateAt))
  if (mandateAt === null) return tr('钥匙到期 {0}', md(keyAt))
  return md(keyAt) === md(mandateAt) ? tr('到期 {0}', md(keyAt)) : tr('钥匙到期 {0} · 授权到期 {1}', md(keyAt), md(mandateAt))
}

function KeyRow({ k, aliases, halted, offline, now, today, keyExpiresAt, onChanged, onEdit }: {
  k: KeyTier; aliases: Record<string, string>; halted: boolean; offline: boolean; now: number; today: { proposals: number | null; blocked: number | null; actions: number }; keyExpiresAt: number | null; onChanged(): void; onEdit(tier?: AgentPermissionTier, missing?: string[]): void
}) {
  const bridge = useBridge()
  const btn = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)
  // 能预判的失败先挡：离线 / 钥匙暂停 / 已停止 / 授权书已到期
  const blocked = offline ? tr('离线') : k.status !== 'active' ? tr('钥匙已暂停') : halted ? tr('已停止交易：恢复后可改档') : k.note === '已到期' ? tr('授权书已到期') : null
  const pick = async (tier: AgentPermissionTier) => {
    setOpen(false)
    if (tier === k.tier || blocked || busy) return
    const missing = grantGaps(k, tier)
    if (missing.length) { setErr(null); onEdit(tier, missing); return }
    setBusy(true); setErr(null)
    const r = await setKeyTier(bridge, k, tier)
    setBusy(false)
    if (r.ok) { toast.ok(tr('「{0}」已改为{1}', k.name, TIER_LABEL[tier])); onChanged() } else if (!r.cancelled) { const message = /[一-龥]/.test(r.message) ? tk(r.message) : tr('保存失败：{0}', r.message); setErr(message); toast.err(message) }
  }
  const revoke = async () => {
    if (revoking) return
    setRevoking(true); setErr(null)
    const r = await runCommand<unknown>(bridge, 'agentkey.revoke', { keyId: k.keyId })
    setRevoking(false); setRevokeOpen(false)
    if (r.ok) {
      const v = isRec(r.value) ? r.value : {}
      const cnt = (x: unknown): number => (Array.isArray(x) ? x.length : toNum(x) ?? 0)
      const pos = cnt(v.openPositions)
      const ord = cnt(v.openOrders)
      toast.ok(tr('已撤销「{0}」{1}', k.name, pos || ord ? tr('；它名下还有 {0} 个持仓、{1} 张挂单，需要你自己处理', pos, ord) : ''))
      onChanged()
    } else if (!r.cancelled) { const message = /[一-龥]/.test(r.message) ? tk(r.message) : tr('撤销失败：{0}', r.message); setErr(message); toast.err(message) }
  }
  const label = k.status !== 'active' ? tr('已暂停') : busy ? tr('改档中') : TIER_LABEL[k.tier] + (k.note ? ` · ${k.note}` : '')
  const m = k.mandate
  const accounts = m ? m.accounts.map((id) => aliases[id] ?? id).join(' ') : ''
  const insts = m?.instrumentAllowlist?.length ? m.instrumentAllowlist.slice(0, 3).map(symbolOf).join(' ') + (m.instrumentAllowlist.length > 3 ? tr(' 等') : '') : ''
  const cap = toNum(m?.limits.maxOrderNotional)
  const expires = expiryText(keyExpiresAt, k.notAfter)
  return <div className="g5-krow" data-key={k.keyId}>
    <div className="g5-top">
      <span className="g5o-lg"><Actor kind="agent" name={k.name} /></span>
      <span className="g5-s11 g5-t3">LLM</span>
      <span className="g5-s12 g5-t3" title={k.lastSeenAt ? new Date(k.lastSeenAt).toLocaleString('zh-CN') : undefined}>{agoText(k.lastSeenAt, now)}</span>
    </div>
    <button ref={btn} type="button" className="g5-dd" data-act="tier" aria-haspopup="menu" aria-expanded={open} disabled={busy}
      title={blocked ?? undefined} aria-label={tr('{0} 的权限：{1}{2}', k.name, label, blocked ? tr('（{0}）', blocked) : '')} onClick={() => setOpen(!open)}>{label}{busy ? null : <Ic n="chev" s={12} />}</button>
    <Pop anchor={btn} open={open} onClose={() => setOpen(false)} label={tr('权限档位')} width={280}>
      {blocked ? <div className="g5-ph">{blocked}{tr('（改档暂不可用，仍可撤销）')}</div> : expires ? <div className="g5-ph">{expires}</div> : null}
      {TIER_MENU.map((t) => <button key={t} type="button" role="menuitemradio" aria-checked={k.tier === t} className="g5-mi" data-tier={t} disabled={!!blocked} style={{ width: '100%' }} onClick={() => { void pick(t) }}>{TIER_LABEL[t]}{k.tier === t ? <span className="g5-r"><Ic n="check" /></span> : null}</button>)}
      <button type="button" role="menuitem" className="g5-mi" disabled={!!blocked} style={{ width: '100%' }} onClick={() => { setOpen(false); setErr(null); onEdit() }}>{tr('编辑授权…')}</button>
      <button type="button" role="menuitem" className="g5-mi" data-act="revoke-agent" style={{ width: '100%' }} onClick={() => { setOpen(false); setErr(null); setRevokeOpen(true) }}>{tr('撤销此 Agent…')}</button>
    </Pop>
    <Pop anchor={btn} open={revokeOpen} onClose={() => setRevokeOpen(false)} label={tr('撤销 Agent')} width={300}>
      <div className="g5o-relax">
        <div className="g5-s12 g5-t2" role="alert" data-act="revoke-agent-ask">{tr('撤销「{0}」后，它立刻不能下单，待批的提案作废；已有持仓和挂单不会自动处理。', k.name)}</div>
        <div className="g5-ffoot"><button type="button" className="g5-btn g5-btn-ghost" disabled={revoking} onClick={() => setRevokeOpen(false)}>{tr('取消')}</button><button type="button" className="g5-btn g5-btn-kill" data-act="revoke-agent-confirm" disabled={revoking} onClick={() => { void revoke() }}>{revoking ? tr('撤销中…') : tr('确认撤销')}</button></div>
      </div>
    </Pop>
    <div className="g5-sub">{k.tier === 'read_only'
      ? <span>{tr('近 150 条内动作 ')}<b>{today.actions}</b></span>
      : <><span>{tr('今日提议 ')}<b>{fmtAgentCount(today.proposals)}</b></span><span>{tr('拦截 ')}<b>{fmtAgentCount(today.blocked)}</b></span></>}</div>
    <div className="g5-sub">{m
      ? (k.tier === 'read_only'
        ? <><span><b>{accounts || tr('全部账户')}</b></span><span>{tr('只读，不能提议')}</span></>
        : <>{accounts ? <span><b>{accounts}</b></span> : null}{insts ? <span><b>{insts}</b></span> : null}{cap !== null ? <span>{tr('单笔 ≤ ')}<b>{fmtLoose(cap)}</b></span> : null}</>)
      : <span>{tr('未授权')}</span>}</div>
    {err ? <div className="g5o-ferr g5o-keyerr" role="alert" title={err}>{err}</div> : null}
  </div>
}

export function AgentsView() {
  const [grant, setGrant] = useState<{ agent?: KeyTier; targetTier?: AgentPermissionTier; missing?: string[] } | null>(null)
  const [showRevoked, setShowRevoked] = useState(false)
  const keys = useKeys()
  const rawKeys = useRes<unknown>(Q.keys)
  const risk = useRes<unknown>(Q.riskState)
  const accts = useRes<unknown>(Q.accounts)
  const feed = useFeed()
  const now = useNow(60_000) // 日界（localDayStart）用；「N 秒前」另用 5 s 节拍
  const tick = useNow(5000)
  const stats = useRes<unknown>('risk.stats', { sinceTs: localDayStart(now) })
  useSubscribe(T.risk, () => risk.reload())
  // 刚提议 / 被拦完不等 15 s 轮询：提案类与 risk.denied 账本条目 1 s 去抖后重查 risk.stats
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statsSoon = useCallback(() => {
    if (statsTimer.current) clearTimeout(statsTimer.current)
    statsTimer.current = setTimeout(() => { statsTimer.current = null; stats.reload() }, 1000)
  }, [stats.reload])
  useEffect(() => () => { if (statsTimer.current) clearTimeout(statsTimer.current) }, [])
  useSubscribe(T.ledger, (e) => { const t = isRec(e.data) ? e.data.type : undefined; if (typeof t === 'string' && (t.startsWith('proposal.') || t === 'risk.denied')) statsSoon() })
  useSubscribe(T.proposals, statsSoon)
  const offline = useOffline(() => { keys.reload(); risk.reload(); accts.reload(); feed.reload(); stats.reload() })
  const clock = useOfflineClock(offline)
  // 与钥匙轮询同一节奏（15 s）：页面可见时重查一次今日计数，隐藏时不查。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const visible = () => document.visibilityState === 'visible'
    const t = setInterval(() => { if (visible()) stats.reload() }, STATS_POLL_MS)
    const onVisible = () => { if (visible()) stats.reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [stats.reload])
  const halted = (() => { const r = normalizeRisk(risk.data); return r.known && r.state === 'HALTED' })()
  const aliases = Object.fromEntries(normalizeAccounts(accts.data).map((a) => [a.accountId, a.alias]))
  const keyExpiry = new Map<string, number>()
  const keyCreatedAt = new Map<string, number>()
  for (const x of listOf(rawKeys.data, 'keys')) {
    const rec = x && typeof x === 'object' ? x as Record<string, unknown> : null
    const keyId = typeof rec?.keyId === 'string' ? rec.keyId : null
    const at = toNum(rec?.expiresAt)
    if (keyId !== null && at !== null) keyExpiry.set(keyId, at)
    const createdAt = toNum(rec?.createdAt)
    if (keyId !== null && createdAt !== null) keyCreatedAt.set(keyId, createdAt)
  }
  // 已撤销的钥匙不进主列表（R-50）：下方一行「已撤销 (N)」可展开，名字照旧，撤销时间有才写。
  const revoked = listOf(rawKeys.data, 'keys').flatMap((x) => {
    const rec = x && typeof x === 'object' ? x as Record<string, unknown> : null
    if (rec?.status !== 'revoked' || typeof rec.keyId !== 'string') return []
    return [{ keyId: rec.keyId, name: typeof rec.name === 'string' && rec.name ? rec.name : rec.keyId, at: toNum(rec.revokedAt) }]
  })
  // 今日提议 / 拦截来自 risk.stats（与账本同源，不受活动流窗口影响）；失败时显示 —。
  const statsData = stats.error ? undefined : stats.data
  const todayOf = (keyId: string) => ({
    ...agentCardCounts(statsData, keyId),
    // 动作仍数活动流（该卡原有来源），标签已改成口径对应的短标签。
    actions: feed.items.filter((x) => String(x.origin.actor) === `agent:${keyId}`).length,
  })
  // 顺序按钥匙创建时间固定，同一会话内不再随动作跳位（R-52）。
  const orderedKeys = stableKeyOrder(keys.keys, (keyId) => keyCreatedAt.get(keyId) ?? null)
  const changed = () => { keys.reload(); rawKeys.reload() }
  const revokedRows = revoked.length ? <>
    <div className="g5-krow">
      <div className="g5-top"><button type="button" className="g5-btn g5-btn-ghost g5o-lnk" data-act="revoked-keys" aria-expanded={showRevoked} onClick={() => setShowRevoked(!showRevoked)}>{tr('已撤销 ({0})', revoked.length)}</button></div>
    </div>
    {showRevoked ? revoked.map((r) => <div key={r.keyId} className="g5-krow" data-key={r.keyId} data-revoked="1">
      <div className="g5-sub"><span>{r.name}{r.at !== null ? tr(' · 撤销于 {0}', md(r.at)) : ''}</span></div>
    </div>) : null}
  </> : null
  const right = <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{clock ? <span className="g5-s12 g5-t3">{clock}</span> : null}<button type="button" className="g5-btn g5-btn-ghost" disabled={offline || halted} onClick={() => setGrant({})}>{tr('接入 Agent')}</button></span>
  let body: ComponentChildren
  if (keys.phase === 'error') body = <Msg error={keys.error} onRetry={keys.reload} />
  else if (keys.phase === 'loading') body = <>{[[120, 64], [104, 56]].map((w, i) => <div key={i} className="g5-krow"><div className="g5-top"><Sk w={w[0]!} /></div><span className="g5-sk" style={{ width: w[1], height: 28 }} /><div className="g5-sub"><Sk w={160 - i * 32} /></div></div>)}</>
  else if (!keys.keys.length) body = <><Msg>{tr('还没有 Agent 接入')}</Msg>{revokedRows}</>
  else body = <>{orderedKeys.map((k) => <KeyRow key={k.keyId} k={k} aliases={aliases} halted={halted} offline={offline} now={tick} today={todayOf(k.keyId)} keyExpiresAt={keyExpiry.get(k.keyId) ?? null} onChanged={changed} onEdit={(targetTier, missing) => setGrant({ agent: k, targetTier, missing })} />)}{revokedRows}</>
  return <><Card head={<Head title="Agent" count={keys.phase === 'ready' ? keys.keys.length : null} right={right} />} className={cardClass(true, offline)} {...stateAttr(offline)} data-g5-page="overview" data-view="keys" id="agent" aria-label="Agent">{body}</Card>{grant ? <AgentGrant {...grant} onClose={() => setGrant(null)} onSaved={changed} /> : null}</>
}
