// SPDX-License-Identifier: CPAL-1.0
// 风险卡（视觉轮 r4）：卡头右侧只有状态字（正常交易 / 只减仓 / 已停止，无方点，§10 F05）；非正常时状态行 7% 底 + 原因原文 + [恢复交易]；接管三钮自然宽度一排
// （就地确认 G2，走 PIN）；没平完的常驻红条；限额五行（标签 · 2 px 已用段在 1 px 轨上 · 已用 / 上限，数字与细条同源 toneOf）；「保护器 N　触发 M 次 ⌄」
// （待批为 0 时自动展开）；「大模型实盘开仓保护」开关与放宽限额入口均走人面 PIN。限额始终由内核强制。
import { defineBlock, type BlockBridge, type BlockProps } from '@gitrader/blocks-sdk'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import type { TakeoverLevel } from '@gitrader/protocol/types'
import { Button, Field, Select, TextInput, F, Icon, InlineConfirm, ScrollArea, Skeleton, SkeletonSlow, Switch, toast } from '@gitrader/workbench/ui'
import { useEffect, useRef, useState } from 'preact/hooks'
import { resumeTrading, runCommand, setLlmLiveGuard, takeover } from './actions'
import { useFocusCard, useHtmlFlag, useOffline, usePending, useRisk } from './hooks'
import { STATE_LABEL, TAKEOVER_LEVELS } from './labels'
import { ruleLine } from './model-activity'
import { leftoverOfEntry, isAtOrBelowBase, limitRows, stateReasonText, stateRows, takeoverOutcome, triggerRows, type Leftover, type LimitRow, type RiskView } from './model-risk'
import { CardHead, ErrorState, useRunner } from './shared'
import { fmtLoose, symbolOf } from './util'
import { t as tr } from '@gitrader/workbench/i18n'

// ---- 接管：风险块与状态条卡是两个块实例，共用这一份状态（IXD F3-5：执行中三入口同时禁用；F3-1：没平完常驻红条，不出成功提示）-------------
// ponytail: 模块级单例——一页只连一个内核，够用。tk.busy 只记本块发起的是哪一档（那一档转圈）；别的入口（命令面板、状态条卡）发起的接管
// 由壳挂在 <html data-takeover-busy> 上（M4 / C8），三个入口都读它禁用。
const tk: { busy: TakeoverLevel | null; left: Leftover[] | null } = { busy: null, left: null }
const tkSubs = new Set<() => void>()
function tkSet(patch: Partial<typeof tk>): void { Object.assign(tk, patch); for (const f of tkSubs) f() }
function useTakeover(): typeof tk {
  const [, bump] = useState(0)
  useEffect(() => { const f = () => bump((x) => x + 1); tkSubs.add(f); return () => { tkSubs.delete(f) } }, [])
  return tk
}
/** 壳的「有接管在跑」标（任何入口发起的都算）。 */
const TK_FLAG = 'data-takeover-busy'
/** 有接管在执行（本块或任何别的入口）：状态条的「接管」钮禁用。 */
export function useTakeoverBusy(): boolean { const st = useTakeover(); const shell = useHtmlFlag(TK_FLAG); return st.busy !== null || shell }
/** 账本里的接管条目（命令面板、Agent 发起的也算）落到常驻红条上。 */
export function noteTakeoverEntry(e: unknown): void {
  const l = leftoverOfEntry((e ?? {}) as { type?: unknown; payload?: unknown })
  if (l === 'clear') { if (tk.left) tkSet({ left: null }) } else if (l) tkSet({ left: l })
}

/** 发一次接管并读结果（G3）。返回 'keep' = 就地确认保持武装（失败，原文在 error 里）；undefined = 收起（成功、没平完、PIN 取消）。 */
async function runTakeover(bridge: BlockBridge, level: TakeoverLevel, onErr: (m: string | null) => void, onDone?: () => void): Promise<'keep' | undefined> {
  if (tk.busy) return 'keep'
  tkSet({ busy: level })
  onErr(null)
  try {
    const r = await takeover(bridge, level)
    if (!r.ok) {
      if (r.cancelled) return undefined // PIN 层取消 = 什么都没发生
      onErr(r.message)
      toast.err(r.message) // 回声；原文挂在按钮组旁（G2-6）
      return 'keep'
    }
    const out = takeoverOutcome(level, r.value)
    if (out.ok) { if (level === 'flatten_all') tkSet({ left: null }); toast.ok(out.text); onDone?.() } else tkSet({ left: out.remaining })
    return undefined
  } finally { tkSet({ busy: null }) }
}

/**
 * 接管三档（r4）：自然宽度一排、间距 8、填充家族（停止新开仓 / 撤销挂单 body 字，全部平仓 down 字），不再套 ButtonGroup；接管卡里（vertical）三档竖排。
 * 点一下原地换成 [取消][确认动词]（A 的 InlineConfirm，G2 七条）；全部平仓武装时确认条前带后果「4 个持仓，实盘 3」。
 */
export function TakeoverButtons({ vertical = false, offline, consequence, onDone }: { vertical?: boolean; offline: boolean; consequence?: string; onDone?: () => void }) {
  const bridge = useBridge()
  const st = useTakeover()
  const running = useTakeoverBusy() // 本块或任何别的入口的接管在跑
  const [armed, setArmed] = useState<TakeoverLevel | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className={'gb-takeover' + (vertical ? ' gb-takeover--v' : '')} role="group" aria-label={tr('接管')} data-armed={armed ?? undefined}>
      {TAKEOVER_LEVELS.map((t) => (
        <span key={t.level} className="gb-takeover__it" data-level={t.level}>
          {armed === t.level && t.level === 'flatten_all' && consequence ? <span className="gb-takeover__hint">{consequence}</span> : null}
          <InlineConfirm label={t.label} confirmLabel={t.confirm} busyLabel={t.busy} size="md" variant="secondary" confirmVariant="kill"
            dataAct={`takeover-${t.level}`} busy={st.busy === t.level} disabled={offline || (running && st.busy !== t.level)} reason={offline ? tr('离线') : running ? tr('接管执行中') : undefined}
            onArmedChange={(a: boolean) => { setArmed((cur) => (a ? t.level : cur === t.level ? null : cur)); if (!a) setErr(null) }}
            onConfirm={() => runTakeover(bridge, t.level, setErr, onDone)} />
        </span>
      ))}
      {err ? <div className="gb-takeover__err" role="alert" title={err}>{err}</div> : null}
    </div>
  )
}

/** 没平完：常驻红条（不靠 toast，G4）——剩几个、哪些标的、多少，+ 再次平仓（同样走 G2）。 */
function LeftoverAlert({ left, offline }: { left: Leftover[]; offline: boolean }) {
  const bridge = useBridge()
  const st = useTakeover()
  const running = useTakeoverBusy()
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="gb-risk__alert" role="alert">
      <Icon name="alert" size={14} />
      <span className="gb-risk__alert-t">{tr('平仓未完成')}{left.length ? tr(' · 剩 {0} 个持仓', left.length) : ''}</span>
      {left.length ? <span className="gb-risk__alert-l gr-num" title={left.map((x) => `${x.instrumentId} ${x.size}`).join(tr('；'))}>{left.map((x) => `${symbolOf(x.instrumentId)} ${fmtLoose(x.size)}`).join(' · ')}</span> : null}
      <InlineConfirm label={tr('再次平仓')} confirmLabel={tr('确认平仓')} busyLabel={tr('平仓中…')} size="sm" variant="veto" confirmVariant="kill" dataAct="takeover-retry"
        busy={st.busy === 'flatten_all'} disabled={offline || (running && st.busy !== 'flatten_all')} reason={offline ? tr('离线') : running ? tr('接管执行中') : undefined}
        onConfirm={() => runTakeover(bridge, 'flatten_all', setErr)} />
      {err ? <div className="gb-risk__alert-err" title={err}>{err}</div> : null}
    </div>
  )
}

/** 限额一行（行高 --gr-lim）：标签 56 · 细条（2 px 已用段落在 1 px 轨上，变化用 scaleX 400 ms）· 值 112（已用 + 「/ 上限」text-3）。
 *  语气 r.tone（≥ 85% warn、≥ 100% down，裁决 4）同时给数字与已用段（同源，C5）；超限再加 ⊘ 形状（IXD 12.6 色盲补救）。 */
function LimitCell({ r }: { r: LimitRow }) {
  const tone = r.tone === 'down' ? 'gr-down' : r.tone === 'warn' ? 'gr-warn' : ''
  return (
    <li className="gb-limit" data-limit={r.id} data-tone={r.tone}>
      <span className="gb-limit__k">{r.label}</span>
      <span className="gb-limit__bar" aria-hidden="true">{r.ratio === null ? null : <i style={{ '--lim': String(Math.max(0, Math.min(1, r.ratio))) }} />}</span>
      <span className="gb-limit__v gr-num"><span className={tone}>{r.used}</span><span className="gb-limit__max"> / {r.limit}</span>{r.tone === 'down' ? <Icon name="block" size={12} className="gr-down" /> : null}</span>
    </li>
  )
}

/** 沿用风险卡行、表单与按钮；放宽必须走壳的 PIN 回路。 */
function RelaxLimits({ limits, base, relax, offline, reload }: { limits: Record<string, unknown>; base: Record<string, unknown>; relax: RiskView['relax']; offline: boolean; reload: () => void }) {
  const bridge = useBridge()
  const [open, setOpen] = useState(false)
  const [field, setField] = useState('maxOrderNotional')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = [
    { value: 'maxOrderNotional', label: tr('单笔名义金额') }, { value: 'maxDailyLossRatio', label: tr('日亏比例（0–1）') },
    { value: 'maxTotalNotionalRatio', label: tr('总敞口 / 权益') }, { value: 'maxLeverage', label: tr('杠杆倍数') }, { value: 'maxDailyOrders', label: tr('每日订单数') },
  ]
  const numeric = field === 'maxLeverage' || field === 'maxDailyOrders'
  const valid = /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && (!numeric || Number.isSafeInteger(Number(value)))
  const patchLimits = { [field]: numeric ? Number(value) : value }
  const tightening = valid && isAtOrBelowBase(patchLimits, base) // 按基线比（policy.limits），与 r5 同口径
  const submit = async () => {
    if (busy || !valid || offline) return
    setBusy(true); setError('')
    try {
      // 修复轮 4 · C1：放宽默认是临时的（4 小时后内核自动收回）；永久放宽只留 CLI（--permanent）与 r5 的二次确认。
      const result = tightening ? await runCommand(bridge, 'risk.tighten', { patch: { limits: patchLimits } })
        : await runCommand(bridge, 'risk.temporaryRelax', { fields: { ...relax?.values, ...patchLimits }, until: Date.now() + 4 * 3600_000 })
      if (result.ok) { setOpen(false); setValue(''); reload(); toast.ok(tightening ? tr('限额已收紧') : tr('已临时放宽 4 小时')) }
      else if (!result.cancelled) setError(result.message)
    } finally { setBusy(false) }
  }
  return <div className="gb-risk__rows">
    <button type="button" className="gb-risk__prot" data-act="risk-relax" aria-expanded={open} disabled={offline || busy} onClick={() => { setOpen(!open); setError('') }}>{tr('放宽限额')}</button>
    {open ? <div>
      <Field label={tr('限额项目')}><Select label={tr('限额项目')} value={field} options={options} disabled={busy} onChange={(v: string) => { setField(v); setValue(''); setError('') }} /></Field>
      <Field label={tr('新上限（当前 {0}）', String(limits[field] ?? tr('未设置')))} error={error || undefined}>
        <TextInput value={value} aria-label={tr('新上限')} disabled={busy} onChange={setValue} onEnter={submit} inputMode="decimal" />
      </Field>
      <Button size="sm" disabled={busy} onClick={() => setOpen(false)}>{tr('取消')}</Button>
      <Button size="sm" busy={busy} disabled={!valid || offline || busy} onClick={submit}>{tightening ? tr('确认收紧') : tr('确认临时放宽 4 小时')}</Button>
    </div> : null}
  </div>
}

function RiskBlock(_props: BlockProps) {
  const root = useRef<HTMLDivElement | null>(null)
  const d = useRisk(noteTakeoverEntry)
  const pend = usePending()
  const bridge = useBridge()
  const offline = useOffline(() => { d.reload(); pend.reload() })
  const st = useTakeover()
  const { run, busy } = useRunner()
  /** 保护器列表：null = 跟着待批走（待批为 0 张时右列空出来的高度给这张卡，列表自动展开，IA §2.6）；点过 ⌄ 就按人的选择。 */
  const [open, setOpen] = useState<boolean | null>(null)
  useFocusCard('risk', root) // 总览条点「风险」跳过来：焦点给卡标题
  const r = d.risk
  const limits = limitRows(r.limits, r.usage)
  const triggers = triggerRows(d.triggers)
  const rows = d.accounts.rows
  const consequence = rows.length ? tr('{0} 个持仓，实盘 {1}', rows.length, rows.filter((x) => x.mode === 'live').length) : undefined
  const shown = open ?? (pend.phase === 'ready' && pend.cards.length === 0)

  if (d.phase === 'error') return <div ref={root} className="gb gb-risk"><CardHead title={tr('风险')} rootRef={root} /><ErrorState error={d.error} onRetry={d.reload} /></div>
  if (d.phase === 'loading') {
    return (
      <div ref={root} className="gb gb-risk" aria-busy="true" aria-label={tr('加载中')}>
        <CardHead title={tr('风险')} rootRef={root} />
        <div className="gb-risk__skel"><Skeleton h={28} w="60%" /><div className="gb-risk__skelrow">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} h={12} />)}</div><SkeletonSlow onRetry={d.reload} /></div>
      </div>
    )
  }

  const scoped = stateRows({ ...(typeof d.raw === 'object' && d.raw !== null ? d.raw : {}), accounts: d.accounts.accounts, mandateNames: d.mandateNames })
  const statusRows = scoped.length ? scoped : r.state !== 'ACTIVE' ? [{ scope: { type: 'org' as const }, label: tr('全局'), state: r.state, reason: r.reasons.join(tr('；')) }] : []
  const known = r.known ? r.state : null
  const label = known ? STATE_LABEL[known] : tr('未知')
  return (
    <div ref={root} className="gb gb-risk" data-state={r.state} data-offline={offline ? '1' : undefined}>
      {/* 卡头右侧只有状态字（无方点）；只减仓 / 已停止着 warn / down */}
      <CardHead title={tr('风险')} rootRef={root} right={<span className={'gb-state gb-state--' + (known ?? 'UNKNOWN')} role="status" aria-label={tr('交易状态：{0}', label)}>{label}</span>} />
      <div className="gb-risk__head">
        {statusRows.map((row) => (
          // 状态行：7% 底 + 内核给的原因原文 + [恢复交易]（放宽方向，不用流光主钮，IXD F3-9）。钮用无底 text 变体：状态行已有一层底，
          // 再用填充钮就是卡 → 状态行 → 钮三层底套底（D 体检 halted 场景 nestDepth3）
          <div className="gb-risk__status" key={row.label} data-state={row.state} data-scope={row.scope.type === 'org' ? 'org' : row.scope.id}>
            <span className="gb-risk__reason gr-ellipsis" title={r.reasons.join(tr('；'))}>{stateReasonText(r.reasons[0] ?? '')}</span>
            <InlineConfirm label={tr('恢复交易')} confirmLabel={tr('确认恢复')} busyLabel={tr('恢复中…')} size="sm" variant="text" confirmVariant="text" dataAct="resume" disabled={offline} reason={offline ? tr('离线') : undefined}
              onConfirm={async () => { const x = await resumeTrading(bridge, row.scope); if (x.ok) { toast.ok(tr('已恢复交易')); d.reload(); return undefined } if (x.cancelled) return undefined; toast.err(x.message); throw new Error(x.message) }} />
          </div>
        ))}
        <TakeoverButtons offline={offline} {...(consequence ? { consequence } : {})} onDone={d.reload} />
        {/* 离线时接管 / 恢复 / 开关都禁用：原因就地写出来，不只靠悬停（G1 / G5，C6） */}
        {offline ? <span className="gb-offline">{tr('离线')}</span> : null}
      </div>
      {st.left ? <LeftoverAlert left={st.left} offline={offline} /> : null}
      {!r.integrityOk ? <div className="gb-risk__bad">{tr('风控策略校验没有通过，交易已停止。')}</div> : null}
      {limits.length ? <ul className="gb-limits" data-n={limits.length}>{limits.map((l) => <LimitCell key={l.id} r={l} />)}</ul> : <div className="gb-risk__none">{tr('还没有设置限额')}</div>}
      <RelaxLimits limits={r.limits} base={r.baseLimits} relax={r.relax} offline={offline} reload={d.reload} />
      <div className="gb-risk__rows">
        <button type="button" className="gb-risk__prot" data-act="protectors" aria-expanded={shown} onClick={() => setOpen(!shown)}>
          <span>{tr('保护器 ')}<span className="gr-num">{r.protectors.length}</span></span>
          <span className="gb-risk__trig">{tr('触发 ')}<span className="gr-num">{triggers.length}</span>{tr(' 次')}</span>
          <Icon name="chevron-down" size={14} className="gb-risk__chev" />
        </button>
        <div className="gb-guard">
          <Switch checked={r.denyLlmLiveEntries} disabled={busy || offline} label={tr('大模型实盘开仓保护')} title={offline ? tr('离线') : undefined}
            onChange={(next: boolean) => { void run((b) => setLlmLiveGuard(b, next), next ? tr('已打开大模型实盘开仓保护') : tr('已关闭大模型实盘开仓保护')).then((ok) => { if (ok) d.reload() }) }} />
        </div>
      </div>
      {shown ? (
        <ScrollArea className="gb-risk__scroll">
          <ul className="gb-plist">
            {r.protectors.length ? r.protectors.map((p) => <li key={p.id}><b>{p.label}</b><span className="gb-plist__t gr-ellipsis" title={p.text}>{p.text}</span></li>) : <li className="gb-plist__none">{tr('没有启用保护器')}</li>}
            {triggers.map((t) => <li key={t.id} data-kind="trigger"><b>{t.label}</b><span className="gb-plist__t gr-ellipsis" title={ruleLine(t.text)}>{ruleLine(t.text)}</span><time className="gr-num">{F.hms(t.ts)}</time></li>)}
          </ul>
        </ScrollArea>
      ) : null}
    </div>
  )
}

export const riskBlock = defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.risk',
    name: tr('风险状态'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './risk.js', element: 'gr-risk' },
    isolation: 'inline',
    size: { minW: 6, minH: 5, defaultW: 9, defaultH: 7 },
    inputs: {
      events: [
        { topic: 'risk.state' },
        { topic: 'ledger.entry', maxHz: 5 },
        { topic: 'account.positions', maxHz: 2 },
        { topic: 'account.summary', maxHz: 1 },
        { topic: 'account.fills', maxHz: 2 },
        { topic: 'account.orders', maxHz: 2 },
        // r4：待批为 0 张时保护器列表自动展开（读待批张数）
        { topic: 'proposal.*' },
      ],
      queries: ['risk.state', 'ledger.query', 'account.list', 'account.summary', 'account.positions', 'proposal.list', 'agentkey.list'],
    },
    actions: ['takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all', 'trading_state.resume', 'risk.setLlmLiveEntries', 'risk.tighten', 'risk.temporaryRelax', 'risk.relax'],
    permissions: ['account.read', 'ledger.read', 'takeover.trigger'],
    pinned: true,
    linkGroups: [{ group: 'account', mode: 'read' }],
    fixtures: ['./fixtures/risk.json'],
  },
  component: RiskBlock,
})
