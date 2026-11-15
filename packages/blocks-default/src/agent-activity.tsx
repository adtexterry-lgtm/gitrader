// SPDX-License-Identifier: CPAL-1.0
// Agent 块（视觉轮 r4 拆成三张卡，按 config.view 选：pending 待批卡 / keys Agent 卡 / feed 活动卡；缺省或认不出 = 旧的全量视图，三段叠在一块里，旧预设与插件不变）。
// 每个视图只调自己要的钩子（feed 才订 ledger.entry；pending 才订 proposal.* 与持仓；keys 只要钥匙 / 授权书 / 风控态；三者都可调 useKeys 取名字）。
// 待批：最急的一张 + 卡底队列（按 proposalId 锚定，换卡 500 ms 死区）+ 卡头下引信；批准走壳的 PIN 层，结果三分（已执行 / 已批准但执行失败 / 没批成）。
// Agent：每把钥匙一行（形状 + 名字 + LLM · 最后活动 · 档位件），改档位是人面动作，走 PIN。活动：时间 · 执行方 · 做了什么 + 结果字 · 撞了哪条规则，来源页签带计数。
// 大模型来源的动作永远带 LLM 标记、永远可筛。
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useSubscribe } from '@gitrader/blocks-sdk/preact'
import type { AgentPermissionTier } from '@gitrader/protocol/types'
import { ACTOR_FILTERS, Button, EmptyState, F, Icon, Menu, ScrollArea, Segmented, Skeleton, SkeletonSlow, copyText, enter, leave, toast, useMedia } from '@gitrader/workbench/ui'
import type { RefObject } from 'preact'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { approveProposal, rejectProposal, setKeyTier } from './actions'
import { Q, T } from './api'
import { approvalRule, visibleResult } from './display'
import { useAccountsData, useActivity, useFocusCard, useKeys, useNow, useOffline, usePending, useRes, type AccountsData } from './hooks'
import { TIER_LABEL } from './labels'
import { activityCounts, agoText, decisionOutcome, filterActivity, fuseRatio, netPosText, originActorTypeOf, parseView, positionAfter, queueView, ruleLine, tidyActivity, type ActivityItem, type ActorFilterId, type DecisionOutcome, type KeyTier, type PendingCard } from './model-activity'
import type { AccountLite } from './model-positions'
import { normalizeRisk } from './model-risk'
import { Actor, CardHead, ErrorState } from './shared'
import { formatCountdown, fmtLoose, symbolOf } from './util'
import { t as tr } from '@gitrader/workbench/i18n'

/** 全量视图里待批段的卡头就地渲染（不往壳的卡头槽里放）。 */
const NO_SLOT: RefObject<HTMLElement | null> = { current: null }

// ---- 档位 ------------------------------------------------------------------------

/** 菜单里只有三档单选；「限额自动…」灰着、标「需授权单」（IXD F4-1：自动档 = 人签发的授权单，不是一键升档）。 */
const TIER_MENU: AgentPermissionTier[] = ['read_only', 'paper', 'confirm']
const ymd = (ts: number) => { const d = new Date(ts); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

function TierRow({ k, halted, offline, now, onChanged }: { k: KeyTier; halted: boolean; offline: boolean; now: number; onChanged(): void }) {
  const bridge = useBridge()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 能预判的失败先挡（IXD F4-4）：已停止 / 钥匙暂停 / 授权书已到期 / 离线时不让打开菜单，免得白输一次 PIN（到期的授权书重签会被内核拒，C7）
  const blocked = offline ? tr('离线') : k.status !== 'active' ? tr('钥匙已暂停') : halted ? tr('已停止交易：恢复后可改档') : k.note === '已到期' ? tr('授权书已到期') : null
  const pick = async (tier: AgentPermissionTier) => {
    setOpen(false)
    if (tier === k.tier || blocked || busy) return
    setBusy(true)
    setErr(null)
    const r = await setKeyTier(bridge, k, tier)
    setBusy(false)
    if (r.ok) { toast.ok(tr('「{0}」已改为{1}', k.name, TIER_LABEL[tier])); onChanged() } else if (!r.cancelled) { setErr(r.message); toast.err(r.message) }
  }
  const label = k.status !== 'active' ? tr('已暂停') : busy ? tr('改档中') : TIER_LABEL[k.tier] + (k.note ? ` · ${k.note}` : '')
  const trigger = (
    <button type="button" className={'gb-tierbtn' + (busy ? ' is-busy' : '')} aria-disabled={blocked ? 'true' : undefined} title={blocked ?? undefined} aria-label={tr('{0} 的权限：{1}{2}', k.name, label, blocked ? tr('（{0}）', blocked) : '')}>
      <span>{label}</span>{blocked || busy ? null : <Icon name="chevron-down" size={12} />}
    </button>
  )
  return (
    <li className="gb-tier" data-key={k.keyId}>
      {/* r4：一行 = 形状 + 名字 + LLM · 最后活动 · 右侧档位件（填充家族，不再套 ButtonGroup 外框，T08） */}
      <div className="gb-tier__row">
        <span className="gb-tier__who"><Actor origin={{ actor: `agent:${k.keyId}`, actorType: 'llm-agent', tool: '', requestId: '', via: 'mcp' }} names={{ [`agent:${k.keyId}`]: k.name }} /></span>
        <span className="gb-tier__ago" title={k.lastSeenAt ? F.mdhm(k.lastSeenAt) : undefined}>{agoText(k.lastSeenAt, now)}</span>
        <Menu trigger={trigger} open={open} onOpenChange={(v: boolean) => setOpen(v && !blocked && !busy)} label={tr('权限档位')} align="end" value={k.tier} onValueChange={(id: string) => { void pick(id as AgentPermissionTier) }}
          header={k.notAfter ? <>{tr('授权到期 ')}<span className="gr-num">{ymd(k.notAfter)}</span></> : undefined}
          items={[...TIER_MENU.map((t) => ({ id: t, label: TIER_LABEL[t] })), { id: 'sep', label: '', kind: 'separator' as const }, { id: 'auto_limited', label: tr('限额自动…'), kind: 'item' as const, disabled: true, hint: tr('需授权单') }]} />
      </div>
      {err ? <div className="gb-tier__err" role="alert" title={err}>{err}</div> : null}
    </li>
  )
}

// ---- 待批 ------------------------------------------------------------------------

type Outcome = DecisionOutcome | { kind: 'error'; message: string }
interface Held { card: PendingCard; act: 'approve' | 'reject'; outcome?: Outcome }
const RESULT_TEXT: Record<Outcome['kind'], string> = { executed: tr('已批准 · 已执行'), approved: tr('已批准'), rejected: tr('已拒绝'), failed: tr('已批准 · 执行失败'), error: tr('没有批成') }
const DEAD_ZONE = 500
const HOLD_MS = 1200
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))
/** 退场（A 的 leave，停在末帧）：从开始起就不接指针——透明的卡不能被点到（审稿 C2-2）。 */
const fade = (el: HTMLElement | null, opts?: { dy?: number; dur?: number }): Promise<void> => { if (el) el.style.pointerEvents = 'none'; return leave(el, opts) }
const spoken = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? tr('{0} 分 {1} 秒', Math.floor(s / 60), s % 60) : tr('{0} 秒', s) }

/** 手机待批视图的断点（与壳同一条：视口宽 < 600 或高 < 480，IXD F1-8）。 */
const NARROW = '(max-width: 599px), (max-height: 479px)'
/** 窄块里单号写短号（IXD 手机线框「T-…0008」），悬停看全号。 */
const shortTicket = (t: string) => (t.length > 8 ? `T-…${t.slice(-4)}` : t)

interface CardAct { c: PendingCard; now: number; offline: boolean; held: Held | null; guard: boolean; onAct(c: PendingCard, kind: 'approve' | 'reject'): void; onAck(): void }

/**
 * 动作行：[拒绝]（无底）[批准]（全屏唯一实心橙；预检 deny 时降为填充）；有结果时换成结果行（✓ 已批准 · 已执行 / ⚠ 已批准 · 执行失败 + 原文 + 知道了）。
 * 桌面在卡内底部、右对齐、上面一条分隔线；手机（bar）渲染在卡外的吸底条里，带倒计时（同一时刻只有一份）。
 */
function PendActions({ c, now, offline, held, guard, onAct, onAck, bar = false }: CardAct & { bar?: boolean }) {
  const left = c.expiresAt - now
  const expired = left <= 0
  const busy = held && !held.outcome ? held.act : null
  const out = held?.outcome
  const lock = offline || expired || busy !== null
  const msg = out && (out.kind === 'failed' || out.kind === 'error') ? out.message : null
  const box = useRef<HTMLDivElement | null>(null)
  // 结局②（批准了但执行失败）停在结果态：焦点落到「知道了」（原来按的钮已经不在了，别让焦点掉到页面上）
  useLayoutEffect(() => {
    if (!msg || (document.activeElement && document.activeElement !== document.body)) return
    box.current?.querySelector<HTMLElement>('[data-act="ack"]')?.focus()
  }, [msg])
  return (
    <div ref={box} className={bar ? 'gb-pend__bar' : 'gb-pend__act'}>
      {out ? (
        <>
          <span className="gb-pend__res" data-tone={msg ? 'err' : 'ok'} role="status"><Icon name={msg ? 'alert' : 'check'} size={14} />{RESULT_TEXT[out.kind]}</span>
          {msg ? <><span className="gb-pend__err" role="alert" title={msg}>{msg}</span><Button size="sm" data-act="ack" onClick={onAck}>{tr('知道了')}</Button></> : null}
        </>
      ) : (
        <>
          {bar ? <span className={'gb-pend__bt gr-num' + (expired ? ' gr-down' : offline ? ' gr-muted' : left < 60000 ? ' gr-warn' : ' gr-dim')} aria-hidden="true">{formatCountdown(left)}</span> : null}
          {/* 离线：两钮禁用并就地写「离线」（G5） */}
          {offline && !bar ? <span className="gb-offline">{tr('离线')}</span> : null}
          <Button size={bar ? 'sm' : 'md'} variant="ghost" busy={busy === 'reject'} disabled={lock && busy !== 'reject'} aria-disabled={guard ? 'true' : undefined} title={offline ? tr('离线') : undefined} data-act="reject" onClick={() => onAct(c, 'reject')}>{busy === 'reject' ? tr('拒绝中…') : tr('拒绝')}</Button>
          {/* 预检 deny 时批准降为次级（IXD F1-4）：批准仍可点（内核会重新预检），只是不再用醒目样式推人去点 */}
          <Button size={bar ? 'sm' : 'md'} variant={c.verdict === 'deny' ? 'secondary' : 'primary'} busy={busy === 'approve'} disabled={lock && busy !== 'approve'} aria-disabled={guard ? 'true' : undefined} title={offline ? tr('离线') : undefined} data-act="approve" onClick={() => onAct(c, 'approve')}>{busy === 'approve' ? tr('批准中…') : tr('批准')}</Button>
        </>
      )}
    </div>
  )
}

/** 批后仓位（IA §2.3）：「批后 ETH　空 1.2 → 空 3.2」。 */
interface After { sym: string; from: string; to: string }

/**
 * 当前一张（r4，直接坐在待批卡里，不再另起一层面）：① 单号 · 执行方（LLM 标）· 倒计时 16 ② 做什么 20/300 ③ 账户 + 实盘 / 纸面（字，不加框）+ 名义
 * ④ 批后仓位（control 类不画）⑤ 撞到的规则（常显）⑥ 理由两行截断（按钮，点开全文）⑦ 预演一行定义式（强平价 / 滑点 / 保证金；control 类不画）⑧ 动作行（右对齐）。
 */
function PendCard({ c, now, names, accounts, after, offline, held, guard, err, narrow, onAct, onAck }: CardAct & { names: Record<string, string>; accounts: AccountLite[]; after: After | null; err?: string; narrow: boolean }) {
  const [why, setWhy] = useState(false)
  const left = c.expiresAt - now
  const expired = left <= 0
  const acct = c.accountId ? accounts.find((a) => a.accountId === c.accountId) : undefined
  const out = held?.outcome
  const tone = expired ? ' gr-down' : offline ? ' gr-muted' : left < 60000 ? ' gr-warn' : ''
  return (
    <div className="gb-pend" data-ticket={c.ticket} data-result={out?.kind} aria-label={tr('提案 {0}', c.ticket)}>
      <div className="gb-pend__top" title={c.ticket}>
        <span className="gb-pend__ticket gr-num"><span className="gb-tk">{c.ticket}</span><span className="gb-tk-s" aria-hidden="true">{shortTicket(c.ticket)}</span></span>
        <Actor origin={c.origin} names={names} />
        <span className={'gb-pend__t gr-num' + tone} title={tr('到期 {0}', F.hms(c.expiresAt))}>{formatCountdown(left)}</span>
      </div>
      <div className="gb-pend__what">{c.control ? <span>{c.control}</span> : c.legs.map((l, i) => <span key={i}>{l.text}</span>)}</div>
      {acct || c.notional !== null ? (
        <div className="gb-pend__acct">
          {acct ? <><span className="gb-pend__alias">{acct.alias}</span><span className="gb-mode" data-mode={acct.mode === 'live' ? 'live' : 'paper'}>{acct.mode === 'live' ? tr('实盘') : tr('纸面')}</span></> : null}
          {c.notional !== null ? <span className="gr-num">{tr('名义 ')}{fmtLoose(c.notional)}</span> : null}
        </div>
      ) : null}
      {c.priceBounds ? <div className="gb-pend__acct gr-num">{tr('参考价 {0} · 批准时偏离超过 {1} bp 作废', c.priceBounds.referencePrice, c.priceBounds.maxDriftBps)}</div> : null}
      {after ? (
        <div className="gb-pend__after">
          <span>{tr('批后 ')}{after.sym}</span><span className="gr-num">{after.from}</span><Icon name="arrow-right" size={12} /><span className="gr-sr">{tr('变为')}</span><span className="gb-pend__to gr-num">{after.to}</span>
        </div>
      ) : null}
      {c.rules.map((r, i) => <div key={i} className="gb-rule" data-approval={approvalRule(r) ? "" : undefined}><Icon name={approvalRule(r) ? "clock" : "block"} size={12} /><span>{ruleLine(r)}</span></div>)}
      {c.notes?.map((n, i) => <div key={`n${i}`} className="gb-rule" data-note=""><span>{n}</span></div>)}
      {c.reason ? <button type="button" className={'gb-pend__why' + (why ? ' is-open' : '')} aria-expanded={why} onClick={() => setWhy(!why)}>{c.reason}</button> : null}
      {/* control 类（启动策略、安装插件）没有强平价 / 滑点 / 保证金，不画预演（IXD F1-3） */}
      {c.control ? null : (
        <dl className="gb-pend__pre">
          <div><dt>{tr('强平价')}</dt><dd className="gr-num">{c.liquidationPrice === null ? tr('无') : F.price(c.liquidationPrice)}</dd></div>
          <div><dt>{tr('滑点上限')}</dt><dd className="gr-num">{c.slippageBps === null ? '—' : `${fmtLoose(c.slippageBps)} bp`}</dd></div>
          <div><dt>{tr('保证金')}</dt><dd className="gr-num">{c.marginRequired === null ? '—' : F.usd(c.marginRequired)}</dd></div>
        </dl>
      )}
      {err && !out ? <div className="gb-pend__err" role="alert" title={err}>{err}</div> : null}
      {narrow ? null : <PendActions c={c} now={now} offline={offline} held={held} guard={guard} onAct={onAct} onAck={onAck} />}
    </div>
  )
}

/**
 * 待批卡（IXD 流程 1，r4）：最急的一张 + 卡底队列（一行一张，点哪行看哪张；超过 3 行末行「另 N 张」）。可见卡按 proposalId 锚定——新提案只进队列、只改计数，
 * 不替换正在看的卡；可见卡被替换（决定、过期、换卡）后 500 ms 内两钮不响应（G7）。卡头下 1 px 引信 = 剩余 / 时限，换卡时从 0 重新点亮。
 * 自己按的那张卡在本地暂存到结果播完（HOLD_MS 1.2 s；执行失败停在结果态等人点「知道了」），不随 proposal.decided 事件立刻消失（F1-5）；
 * 成功 = VISUAL §5 D 三拍：换字 → 当前单退场 → 队列行退场 → 下一张落位（引信重新点亮、卡头计数滚一位）。
 * 过了到期时间一秒内核还没发 expired 事件就先拿掉（每秒一跳，所以「已过期」停留 1–2 s；内核是准的，事件到了会对齐）。读屏只在新提案、剩 60 秒、过期、换卡时各播一次（F1-7）。
 * root = 视图根（接 gitrader:focus 时找卡标题）；headRef = CardHead 找壳卡头槽用的根（全量视图传 NO_SLOT，卡头就地渲染）。
 */
function PendingSection({ cards, names, accounts, offline, loading, onDone, root, headRef }: { cards: PendingCard[]; names: Record<string, string>; accounts: AccountsData; offline: boolean; loading: boolean; onDone(): void; root: RefObject<HTMLElement | null>; headRef: RefObject<HTMLElement | null> }) {
  const bridge = useBridge()
  const now = useNow(1000)
  const narrow = useMedia(NARROW)
  /** 本卡已经决定掉的提案（批准 / 拒绝成功并播完退场）：提案列表或事件比 1.2 s 慢时也不再回到可见位（审稿 C2-2：透明但能点的卡）。 */
  const done = useRef<Set<string>>(new Set())
  const live = cards.filter((c) => c.expiresAt > now - 1000 && !done.current.has(c.proposalId))
  const [sel, setSel] = useState<string | null>(null)
  const [held, setHeld] = useState<Held | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [guard, setGuard] = useState(false)
  const [say, setSay] = useState('')
  const lastIdx = useRef(0)
  const shown = useRef<string | null>(null)
  const swapAt = useRef(0)
  const kbd = useRef(false)
  const sec = useRef<HTMLElement | null>(null)
  const fuse = useRef<HTMLElement | null>(null)
  /** 下一张卡的入场方式：批准后从下 12 px 落位（280 ms）；点队列换卡只淡入（180 ms，VISUAL §5 D′）。 */
  const entry = useRef<{ dy: number; dur: number } | null>(null)
  const liveRef = useRef<PendingCard[]>([])
  liveRef.current = live
  const liveIds = useRef<string[]>([])
  liveIds.current = live.map((c) => c.proposalId)

  const list = held && !live.some((c) => c.proposalId === held.card.proposalId) ? [...live.slice(0, lastIdx.current), held.card, ...live.slice(lastIdx.current)] : live
  const want = held?.card.proposalId ?? sel
  const at = list.findIndex((c) => c.proposalId === want)
  const idx = at >= 0 ? at : Math.max(0, Math.min(lastIdx.current, list.length - 1))
  const card = list[idx] ?? null
  const { rows: queue, more } = queueView(list, card?.proposalId ?? null)
  const q = (s: string): HTMLElement | null => sec.current?.querySelector<HTMLElement>(s) ?? null

  // 总览条「待批」/ 持仓卡「有待批」跳过来：有指定的那张就选中它，焦点给卡标题（hooks.useFocusCard）
  useFocusCard('pending', root, (d) => { if (d.proposalId && liveRef.current.some((c) => c.proposalId === d.proposalId)) { entry.current = { dy: 0, dur: 180 }; setSel(d.proposalId) } })

  // 锚定 + 换卡死区 + 键盘用户的就近移焦（被聚焦的钮随旧卡消失时，焦点落到新卡第一个可聚焦件；鼠标操作不移焦）
  useLayoutEffect(() => { lastIdx.current = idx })
  useLayoutEffect(() => {
    const id = card?.proposalId ?? null
    if (id && id !== sel) setSel(id)
    if (id === shown.current) return undefined
    const replaced = shown.current !== null && id !== null
    shown.current = id
    // 没有换卡（首张出现 / 列表变空）：死区复位——换卡后 500 ms 内列表变空时，上一轮的复位定时器已被清掉，不复位就会一直灰着（C2）
    if (!replaced) { setGuard(false); return undefined }
    swapAt.current = performance.now()
    setGuard(true)
    const how = entry.current ?? { dy: 12, dur: 280 }
    entry.current = null
    void enter(q('.gb-pend'), how)
    if (kbd.current && (!document.activeElement || document.activeElement === document.body)) sec.current?.querySelector<HTMLElement>('.gb-pend button:not([disabled])')?.focus()
    const t = setTimeout(() => setGuard(false), DEAD_ZONE)
    return () => clearTimeout(t)
  }, [card?.proposalId])

  // 读屏：新提案到达、可见卡剩 60 秒、过期（倒计时本身不进 live region）
  const prevLive = useRef<string[] | null>(null)
  const liveKey = liveIds.current.join()
  useLayoutEffect(() => {
    const prev = prevLive.current
    prevLive.current = liveIds.current
    const fresh = prev ? live.find((c) => !prev.includes(c.proposalId)) : undefined
    if (fresh) setSay(tr('新提案 {0}，{1}后过期', fresh.ticket, spoken(fresh.expiresAt - Date.now())))
  }, [liveKey])
  const zone = !card ? '' : card.expiresAt <= now ? 'expired' : card.expiresAt - now <= 60000 ? 'soon' : ''
  useLayoutEffect(() => { if (card && zone) setSay(zone === 'soon' ? tr('{0} 还剩 1 分钟', card.ticket) : tr('{0} 已过期', card.ticket)) }, [card?.proposalId, zone])

  const act = async (c: PendingCard, kind: 'approve' | 'reject') => {
    if (held || offline || performance.now() - swapAt.current < DEAD_ZONE || c.expiresAt <= Date.now()) return
    setHeld({ card: c, act: kind })
    setErrs((m) => { const n = { ...m }; delete n[c.proposalId]; return n })
    const r = kind === 'approve' ? await approveProposal(bridge, c.proposalId) : await rejectProposal(bridge, c.proposalId)
    if (!r.ok) {
      if (r.cancelled) { setHeld(null); return } // PIN 层取消 = 什么都没发生
      toast.err(r.message) // 回声；原文就地常驻（G4）
      // 结局③没批成：卡还在待批就回到待批、原文挂在动作行下；卡已经不在了（比如别处已批）就停在结果态给原文
      if (liveIds.current.includes(c.proposalId)) { setHeld(null); setErrs((m) => ({ ...m, [c.proposalId]: r.message })) } else setHeld({ card: c, act: kind, outcome: { kind: 'error', message: r.message } })
      return
    }
    const out = decisionOutcome(kind, r.value)
    setHeld({ card: c, act: kind, outcome: out })
    if (out.kind === 'failed') return // 已批准但执行失败：不出成功提示，停在结果态（F1-1）
    toast.ok(out.kind === 'rejected' ? tr('已拒绝 {0}', c.ticket) : out.kind === 'executed' ? tr('已批准 {0} · 已执行', c.ticket) : tr('已批准 {0}', c.ticket))
    // VISUAL §5 D：先确认（结果字停 ~0.9 s）→ 当前单上移淡出（200）→ 将要补位的那张的队列行退场 → 退场播完（且满 1.2 s）才换下一张（布局效果里 enter）。
    // 退场中的元素不接指针；换卡前把这张记进 done，列表晚到也不会让透明的旧卡回到可见位。
    const t0 = performance.now()
    await wait(HOLD_MS - 300)
    const rest = liveRef.current.filter((x) => x.proposalId !== c.proposalId)
    const next = rest[Math.min(lastIdx.current, rest.length - 1)]
    await Promise.all([fade(q(`.gb-pend[data-ticket="${c.ticket}"]`)), wait(100).then(() => (next ? fade(q(`.gb-queue li[data-ticket="${next.ticket}"]`)) : undefined))])
    await wait(HOLD_MS - (performance.now() - t0))
    done.current.add(c.proposalId)
    entry.current = { dy: 12, dur: 280 }
    setHeld((h) => (h && h.card.proposalId === c.proposalId ? null : h))
    onDone()
  }

  /** 点队列行换卡（D′）：当前单淡出 120 → 新单淡入 180；换上来之后 500 ms 死区照旧。 */
  const pick = async (c: PendingCard) => {
    if (held || c.proposalId === card?.proposalId) return
    const el = q('.gb-pend')
    await fade(el, { dy: 0, dur: 120 }) // 退场播完才切（退场中不接指针）
    if (!liveRef.current.some((x) => x.proposalId === c.proposalId)) { if (el) el.style.pointerEvents = ''; void enter(el, { dy: 0, dur: 180 }); return } // 这 120 ms 里那张没了：原卡淡回来
    entry.current = { dy: 0, dur: 180 }
    setSel(c.proposalId)
    const i = list.findIndex((x) => x.proposalId === c.proposalId)
    setSay(tr('第 {0} 张，共 {1} 张', i + 1, list.length))
  }
  // 指针在卡上时引信流光加速（与 motion.installFlow 对主按钮的做法一致：只改播放速率，不重启动画）
  const flow = (rate: number) => { for (const a of fuse.current?.getAnimations?.() ?? []) if ((a as CSSAnimation).animationName === 'gr-flow') a.updatePlaybackRate(rate) }

  const cardHeld = card && held && held.card.proposalId === card.proposalId ? held : null
  const onAct = (c: PendingCard, k: 'approve' | 'reject') => { void act(c, k) }
  const onAck = () => { setHeld(null); onDone() }
  const after = card ? afterOf(card, accounts) : null
  return (
    <section ref={sec} className="gb-agent__pend" aria-label={tr('待批')} onKeyDown={() => { kbd.current = true }} onPointerDown={() => { kbd.current = false }} onPointerEnter={() => flow(4)} onPointerLeave={() => flow(1)}>
      {/* 0 张时卡收成卡头一行「待批 0」（不消失，右列下面两张卡不跳位） */}
      <CardHead title={tr('待批')} count={loading && !list.length ? null : list.length} rootRef={headRef} />
      {card ? (
        <>
          <div className="gb-fuse" aria-hidden="true"><i key={card.proposalId} ref={fuse} style={{ '--fuse': String(fuseRatio(card, now)) }} /></div>
          <div className="gb-pend__wrap">
            <PendCard key={card.proposalId} c={card} now={now} names={names} accounts={accounts.accounts} after={after} offline={offline} held={cardHeld} guard={guard} narrow={narrow}
              {...(errs[card.proposalId] ? { err: errs[card.proposalId] } : {})} onAct={onAct} onAck={onAck} />
          </div>
          {queue.length ? (
            <ul className="gb-queue" aria-label={tr('其余待批')}>
              {queue.map((x) => (
                <li key={x.proposalId} data-ticket={x.ticket}>
                  <button type="button" className="gb-queue__btn" data-act="queue-pick" title={x.ticket} onClick={() => { void pick(x) }}>
                    <span className="gb-queue__tk gr-num">{shortTicket(x.ticket)}</span>
                    <span className="gb-queue__w"><span>{x.control ?? x.legs.map((l) => l.text).join(tr('；'))}</span></span>
                    {x.rules[0] ? <span className="gb-queue__r"><span>{ruleLine(x.rules[0])}</span></span> : null}
                    <span className="gb-queue__t gr-num">{formatCountdown(x.expiresAt - now)}</span>
                  </button>
                </li>
              ))}
              {more ? <li className="gb-queue__more">{tr('另 {0} 张', more)}</li> : null}
            </ul>
          ) : null}
          {narrow && offline ? <span className="gb-offline">{tr('离线')}</span> : null}
          {/* 手机：吸底动作条在卡外（倒计时 + 两钮等宽 44 高），卡本身保持完整 */}
          {narrow ? <PendActions key={card.proposalId} bar c={card} now={now} offline={offline} held={cardHeld} guard={guard} onAct={onAct} onAck={onAck} /> : null}
        </>
      ) : null}
      <span className="gr-sr" aria-live="polite">{say}</span>
    </section>
  )
}

/** 批后仓位：下单类、腿都在同一标的、持仓已读到时才算（control 类不画；读不到持仓时不猜）。 */
function afterOf(c: PendingCard, acct: AccountsData): After | null {
  if (c.control || acct.phase !== 'ready' || !c.accountId || !c.legs.length) return null
  const inst = c.legs[0]!.instrumentId
  if (!inst || c.legs.some((l) => l.instrumentId !== inst || !l.side || l.size == null)) return null
  const row = acct.rows.find((r) => r.accountId === c.accountId && r.instrumentId === inst)
  const cur = row ? { side: row.side, size: row.size } : null
  return { sym: symbolOf(inst), from: netPosText(cur), to: netPosText(positionAfter(cur, c.legs)) }
}

/** 待批卡的读取失败与正常态（全量视图与待批视图共用）。 */
function PendBody({ pend, names, acct, offline, root, headRef }: { pend: ReturnType<typeof usePending>; names: Record<string, string>; acct: AccountsData; offline: boolean; root: RefObject<HTMLElement | null>; headRef: RefObject<HTMLElement | null> }) {
  if (pend.phase === 'error' && !pend.cards.length) return <section className="gb-agent__pend" aria-label={tr('待批')}><CardHead title={tr('待批')} rootRef={headRef} /><ErrorState error={pend.error} onRetry={pend.reload} /></section>
  return <PendingSection cards={pend.cards} names={names} accounts={acct} offline={offline} loading={pend.phase === 'loading'} onDone={pend.reload} root={root} headRef={headRef} />
}

// ---- 活动流 ------------------------------------------------------------------------

const EMPTY_FEED: Record<ActorFilterId, string> = { all: tr('还没有动作'), human: tr('你还没有操作'), engine: tr('引擎还没有动作'), 'llm-agent': tr('大模型还没有发起动作'), system: tr('系统还没有记录') }

function EventRow({ it, names, fresh }: { it: ActivityItem; names: Record<string, string>; fresh: boolean }) {
  const [open, setOpen] = useState(false)
  const result = visibleResult(it.what, it.result)
  const llm = originActorTypeOf(it.origin) === 'llm-agent'
  const more = !!(it.why || it.upstream)
  // r4：网格 时间 64 · 执行方 168 · 做什么（1200：60 / 136）；结果字跟在做什么后、间距 12，不成列（§10 F04）
  const head = (
    <>
      <time className="gb-ev__time gr-num">{F.hms(it.ts)}</time>
      <span className="gb-ev__who"><Actor origin={it.origin} names={names} /></span>
      <span className="gb-ev__wc">
        <span className="gb-ev__what">{it.what}</span>
        {result ? <span className={'gb-ev__res gb-tone-' + result.tone} data-pend={result.label === tr('待批') ? '' : undefined}>{result.label}</span> : null}
      </span>
    </>
  )
  return (
    <li className={'gb-ev' + (it.rules.length ? ' has-rule' : '') + (open ? ' is-open' : '') + (fresh ? ' is-new' : '')} data-llm={llm ? '1' : undefined} data-type={it.type} data-seq={it.seq}>
      {/* 有理由或上游原文的条目是按钮（IXD F5-1）；没有可展开内容的不可聚焦 */}
      {more ? <button type="button" className="gb-ev__head" aria-expanded={open} onClick={() => setOpen(!open)}>{head}</button> : <div className="gb-ev__head">{head}</div>}
      {/* 撞了哪条规则：始终可见 */}
      {it.rules.map((r, i) => <div key={i} className="gb-rule" data-approval={approvalRule(r) ? "" : undefined}><Icon name={approvalRule(r) ? "clock" : "block"} size={12} /><span>{ruleLine(r)}</span></div>)}
      {it.notes?.map((n, i) => <div key={`n${i}`} className="gb-rule" data-note=""><span>{n}</span></div>)}
      {/* 理由与上游原文点开才显示：收起时整块不渲染（里面的「复制原文」不能被 Tab 到，也不会被挤成一条「胶囊」）；展开时行高 0fr → 1fr 揭示 */}
      {more && open ? (
        <div className="gb-ev__more">
          <div className="gb-ev__morein">
            {it.why ? <div className="gb-ev__why">{it.why}</div> : null}
            {it.upstream ? <div className="gb-ev__up">{it.upstream}</div> : null}
            {it.upstream ? <Button size="xs" variant="ghost" icon="copy" onClick={() => { void copyText(it.upstream as string).then((ok) => (ok ? toast.ok(tr('已复制原文')) : toast.err(tr('复制失败')))) }}>{tr('复制原文')}</Button> : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * 静止态整行裁切（VISUAL §10.2 / AUDIT F02）：没往下滚时，列表可视高度向下取整到最后一条完整条目的底边，末条不画下沿线；不用遮罩。滚动后照常。
 * ResizeObserver 量 .gb-feed（可用高度）与列表（条目展开 / 新条目），量完直接改 ScrollArea 的 max-height 与末条的 data-cut（不经状态，不多渲一轮）。
 */
function useRowClip(box: RefObject<HTMLElement | null>, still: boolean, deps: unknown[]): void {
  useLayoutEffect(() => {
    const feed = box.current
    const area = feed?.querySelector<HTMLElement>('.gb-agent__feed')
    const inner = area?.querySelector<HTMLElement>('.gr-scrollarea__in')
    if (!feed || !area || !inner) return undefined
    const fit = () => {
      feed.querySelector('.gb-ev[data-cut]')?.removeAttribute('data-cut')
      area.style.maxHeight = ''
      const list = inner.querySelector('.gb-feed__list')
      if (!still || inner.scrollTop > 0 || !list) return
      const avail = feed.clientHeight
      const top = inner.getBoundingClientRect().top
      let cut = 0
      let last: Element | null = null
      for (const li of Array.from(list.children)) { const b = li.getBoundingClientRect().bottom - top; if (b > avail + 0.5) break; cut = b; last = li }
      if (!last || last === list.lastElementChild) return // 全放得下，或一条都放不下：不裁
      area.style.maxHeight = `${Math.min(Math.ceil(cut), Math.floor(avail))}px`
      last.setAttribute('data-cut', '')
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(feed)
    const list = inner.querySelector('.gb-feed__list')
    if (list) ro.observe(list)
    // 字体晚到 / 卡入场动画结束后再量一次（行高变了但列表总高没变时 ResizeObserver 不报）
    let dead = false
    void document.fonts?.ready.then(() => { if (!dead) fit() })
    const t = setTimeout(fit, 400)
    return () => { dead = true; clearTimeout(t); ro.disconnect(); area.style.maxHeight = '' }
  }, [still, ...deps])
}

/** 活动流：在顶部时新条目滑入；已向下滚动时不顶跑阅读位置（冻结在当时最新的那条），顶部出「新动作 N ↑」整行（IXD F5-2）。 */
function Feed({ items, names, phase, error, filter, onRetry }: { items: ActivityItem[]; names: Record<string, string>; phase: string; error: Error | null; filter: ActorFilterId; onRetry(): void }) {
  const box = useRef<HTMLDivElement | null>(null)
  const [pin, setPin] = useState<number | null>(null)
  const base = useRef<number | null>(null)
  const top = items.reduce((m, x) => Math.max(m, x.seq), 0)
  if (base.current === null && phase === 'ready') base.current = top
  const shown = pin === null ? items : items.filter((x) => x.seq <= pin)
  const fresh = items.length - shown.length
  const onScroll = (e: Event) => {
    const y = (e.currentTarget as HTMLElement).scrollTop
    if (y > 4 && pin === null) setPin(top)
    else if (y <= 4 && pin !== null) setPin(null)
  }
  const toTop = () => { const s = box.current?.querySelector<HTMLElement>('.gr-scrollarea__in'); if (s) s.scrollTop = 0; setPin(null) }
  let body
  if (phase === 'error') body = <ErrorState error={error} onRetry={onRetry} />
  else if (phase === 'loading') body = <div className="gb-feed__skel" aria-busy="true" aria-label={tr('加载中')}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={12} w={i % 2 ? '70%' : '92%'} />)}<SkeletonSlow onRetry={onRetry} /></div>
  else if (!shown.length) body = <EmptyState compact art="no-signals" title={EMPTY_FEED[filter]} />
  else body = <ul className="gb-feed__list">{shown.map((it) => <EventRow key={it.id} it={it} names={names} fresh={base.current !== null && it.seq > base.current} />)}</ul>
  useRowClip(box, pin === null, [shown.length, phase, filter])
  return (
    <div ref={box} className="gb-feed">
      {fresh > 0 ? <button type="button" className="gb-feed__new" data-act="feed-new" onClick={toTop}>{tr('新动作 ')}{fresh}<Icon name="chevron-up" size={12} /></button> : null}
      <ScrollArea className="gb-agent__feed" onScroll={onScroll}>{body}</ScrollArea>
    </div>
  )
}

// ---- 块 ------------------------------------------------------------------------

/** Agent 卡的钥匙列表（读取失败 = 内核原文的错误态，每卡最多一个）。 */
function KeysBody({ keys, halted, offline }: { keys: ReturnType<typeof useKeys>; halted: boolean; offline: boolean }) {
  const now = useNow(60_000) // 最后活动每分钟刷新
  if (keys.phase === 'error') return <ErrorState error={keys.error} onRetry={keys.reload} />
  return (
    <div className="gb-agent__keys">
      {keys.keys.length ? <ul className="gb-tiers">{keys.keys.map((k) => <TierRow key={k.keyId} k={k} halted={halted} offline={offline} now={now} onChanged={keys.reload} />)}</ul>
        : keys.phase === 'loading' ? <Skeleton h={28} w="60%" /> : <div className="gb-agent__none">{tr('还没有 Agent 接入')}</div>}
      {/* 离线时档位件禁用：原因就地写出来（G1 / G5，C6） */}
      {offline && keys.keys.length ? <span className="gb-offline">{tr('离线')}</span> : null}
    </div>
  )
}

/** 活动卡的来源页签（带计数）+ 列表。 */
function FeedBody({ act, names, filter, onFilter }: { act: ReturnType<typeof useActivity>; names: Record<string, string>; filter: ActorFilterId; onFilter(f: ActorFilterId): void }) {
  const items = tidyActivity(act.items)
  const counts = activityCounts(items)
  return (
    <>
      <div className="gb-agent__filter">
        <Segmented size="sm" label={tr('来源')} value={filter} onChange={(v: string) => onFilter(v as ActorFilterId)}
          options={ACTOR_FILTERS.map((f) => ({ id: f.id, label: <span className="gb-fchip" data-zero={counts[f.id as ActorFilterId] ? undefined : '1'}>{f.label}<span className="gb-fchip__n gr-num">{counts[f.id as ActorFilterId]}</span></span> }))} />
      </div>
      <Feed items={filterActivity(items, filter)} names={names} phase={act.phase} error={act.error} filter={filter} onRetry={act.reload} />
    </>
  )
}

/** 待批卡（config.view = 'pending'）：提案 + 名字 + 账户与持仓（批后仓位）。 */
function PendingView() {
  const root = useRef<HTMLDivElement | null>(null)
  const keys = useKeys()
  const pend = usePending()
  const acct = useAccountsData(false)
  const offline = useOffline(() => { keys.reload(); pend.reload(); acct.reload() })
  return (
    <div ref={root} className="gb gb-agent" data-view="pending" data-offline={offline ? '1' : undefined}>
      <PendBody pend={pend} names={keys.names} acct={acct} offline={offline} root={root} headRef={root} />
    </div>
  )
}

/** Agent 卡（config.view = 'keys'）：钥匙 + 授权书 + 风控态（已停止时先挡改档）。 */
function KeysView() {
  const root = useRef<HTMLDivElement | null>(null)
  const keys = useKeys()
  const riskQ = useRes<unknown>(Q.riskState)
  useSubscribe(T.risk, () => riskQ.reload())
  const offline = useOffline(() => { keys.reload(); riskQ.reload() })
  const risk = normalizeRisk(riskQ.data)
  return (
    <div ref={root} className="gb gb-agent" data-view="keys" data-offline={offline ? '1' : undefined}>
      <CardHead title="Agent" count={keys.phase === 'ready' ? keys.keys.length : null} rootRef={root} />
      <KeysBody keys={keys} halted={risk.known && risk.state === 'HALTED'} offline={offline} />
    </div>
  )
}

/** 活动卡（config.view = 'feed'）：账本动作流 + 名字。卡头只有「活动」。 */
function FeedView() {
  const root = useRef<HTMLDivElement | null>(null)
  const keys = useKeys()
  const act = useActivity()
  const offline = useOffline(() => { keys.reload(); act.reload() })
  const [filter, setFilter] = useState<ActorFilterId>('all')
  return (
    <div ref={root} className="gb gb-agent" data-view="feed" data-offline={offline ? '1' : undefined}>
      <CardHead title={tr('活动')} rootRef={root} />
      <FeedBody act={act} names={keys.names} filter={filter} onFilter={setFilter} />
    </div>
  )
}

/** 全量视图（没有 config.view：旧预设、插件测试）：钥匙 + 待批 + 活动叠在一块里，三段都就地渲染卡头。 */
function FullView() {
  const root = useRef<HTMLDivElement | null>(null)
  const keys = useKeys()
  const pend = usePending()
  const act = useActivity()
  const acct = useAccountsData(false)
  const riskQ = useRes<unknown>(Q.riskState)
  useSubscribe(T.risk, () => riskQ.reload())
  const offline = useOffline(() => { keys.reload(); pend.reload(); act.reload(); acct.reload(); riskQ.reload() })
  const [filter, setFilter] = useState<ActorFilterId>('all')
  const risk = normalizeRisk(riskQ.data)

  // 三路都读不到就是内核那头的问题：只说一次，不重复三遍。
  if (act.phase === 'error' && pend.phase === 'error' && keys.phase === 'error') {
    return <div className="gb gb-agent"><ErrorState error={act.error} onRetry={() => { act.reload(); pend.reload(); keys.reload() }} /></div>
  }
  return (
    <div ref={root} className="gb gb-agent" data-offline={offline ? '1' : undefined}>
      <KeysBody keys={keys} halted={risk.known && risk.state === 'HALTED'} offline={offline} />
      {/* 待批段一直挂着（0 张时只剩「待批 0」）：刚批完最后一张时，暂存的那张卡要在这里播完结果 */}
      <PendBody pend={pend} names={keys.names} acct={acct} offline={offline} root={root} headRef={NO_SLOT} />
      <FeedBody act={act} names={keys.names} filter={filter} onFilter={setFilter} />
    </div>
  )
}

function AgentBlock(props: BlockProps) {
  const view = parseView(props.config)
  return view === 'pending' ? <PendingView /> : view === 'keys' ? <KeysView /> : view === 'feed' ? <FeedView /> : <FullView />
}

export const agentActivityBlock = defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.agent-activity',
    name: tr('Agent 活动与待批'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './agent-activity.js', element: 'gr-agent-activity' },
    isolation: 'inline',
    size: { minW: 6, minH: 6, defaultW: 9, defaultH: 10 },
    inputs: {
      events: [
        { topic: 'ledger.entry', maxHz: 5 },
        { topic: 'proposal.*' },
        { topic: 'mandate.changed' },
        { topic: 'risk.state' },
        // r4 待批卡的批后仓位：持仓随事件更新（useAccountsData 的四个主题）
        { topic: 'account.positions', maxHz: 2 },
        { topic: 'account.summary', maxHz: 1 },
        { topic: 'account.fills', maxHz: 2 },
        { topic: 'account.orders', maxHz: 2 },
      ],
      // account.list：卡上写「账户 · 实盘 / 纸面」（IXD F1-3）；risk.state：已停止时先挡改档（F4-2 / F4-4）；
      // account.positions / summary：r4 待批卡的「批后仓位」（IA §2.3）。都在 account.read 里，不加权限。
      queries: ['ledger.query', 'proposal.list', 'agentkey.list', 'mandate.list', 'account.list', 'risk.state', 'account.summary', 'account.positions'],
    },
    // 批准 / 拒绝只有一方签名块能发；改档位 = 用新级别重签授权书（人面动作，内核要 PIN）。
    actions: ['proposal.approve', 'proposal.reject', 'mandate.update'],
    permissions: ['account.read', 'ledger.read'],
    pinned: true,
    linkGroups: [{ group: 'account', mode: 'read' }],
    fixtures: ['./fixtures/agent-activity.json'],
  },
  component: AgentBlock,
})
