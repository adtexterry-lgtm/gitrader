// SPDX-License-Identifier: CPAL-1.0
// 总览条（视觉轮 r4：原底部状态条搬到顶部槽里，排版照 comps/r4.css .strip）：从左到右 实盘权益数字组（权益 36 + 今日盈亏）· 纸面 · 风险 · 待批 N 最急 mm:ss
// · 网络 · [接管]。实盘与纸面分开、不相加（IA §2.1）；没有实盘账户时主数是纸面权益。点「待批」/「风险」派发 gitrader:focus 把焦点交给对应的卡；
// 点网络出网络卡（连接方式 / 延迟 / 预算 / 各场所健康 / 重连），点接管出接管卡（三档竖排，同样走就地确认）——两张卡都向下展开（PopoverPanel，Radix）。
// 离线：整条降 text-3、去涨跌色、正负号保留（工单裁决 1 = IXD F9-1）；数字刷新只滚变化位（RollingNumber）。
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { Button, F, Icon, InfoTip, PopoverPanel, RollingNumber } from '@gitrader/workbench/ui'
import { useState } from 'preact/hooks'
import { reconnectVenue } from './actions'
import { FeedNotice } from './feed'
import { focusCard, useAccountsData, useFeedState, useNow, useOffline, usePending, useStatus } from './hooks'
import { soonest } from './model-activity'
import { budgetLevel, totalsByMode, type ModeTotal, type VenueHealth } from './model-risk'
import { TakeoverButtons, useTakeoverBusy } from './risk'
import { useRunner } from './shared'
import { fmtLoose, formatCountdown } from './util'
import { t as tr } from '@gitrader/workbench/i18n'

const keepOpen = (e: Event) => e.preventDefault() // 卡里的动作会弹 PIN：焦点离开卡时别把卡关了
/** 涨跌色：离线时不着色（正负号保留，F9-1）；两位小数显示为 0.00 的不着色。 */
const toneCls = (v: number | null | undefined, off: boolean): string => { if (off || v == null) return ''; const t = F.tone(v); return t === 'up' ? ' gr-up' : t === 'down' ? ' gr-down' : '' }

/** 权益：整数部分 + 小数部分（小数与「USDC」降 text-3），两段都只滚变化的那几位（VISUAL §5 F）。 */
function Equity({ v }: { v: number | null }) {
  const s = v === null ? '' : F.usd(v)
  const i = s.lastIndexOf('.')
  return <><RollingNumber value={i < 0 ? s : s.slice(0, i)} />{i < 0 ? null : <span className="gb-sb__dec"><RollingNumber value={s.slice(i)} /></span>}</>
}

/** 实盘（或只有纸面时的纸面）数字组：「实盘权益 12,480.20 USDC」+「今日 +128.40 +1.04%」。 */
function Lead({ mode, t, off }: { mode: 'live' | 'paper'; t: ModeTotal; off: boolean }) {
  return (
    <div className="gb-sb__lead">
      <div className="gb-sb__g gb-sb__eq" data-mode={mode}>
        <span className="gb-sb__lab">{mode === 'live' ? tr('实盘权益') : tr('纸面权益')}</span>
        <span className="gb-sb__hero gr-num"><Equity v={t.equity} /></span>
        <span className="gb-sb__unit">USDC</span>
      </div>
      {t.today === null ? null : (
        <div className="gb-sb__g gb-sb__today">
          <span className="gb-sb__lab">{tr('今日')}</span>
          <span className={'gb-sb__mid gr-num' + toneCls(t.today, off)}><RollingNumber value={F.signed(t.today)} /></span>
          {t.pct === null ? null : <span className="gb-sb__aux gr-num">{F.signedPct(t.pct)}</span>}
        </div>
      )}
    </div>
  )
}

function VenueLine({ v, kernelDown }: { v: VenueHealth; kernelDown: boolean }) {
  const { run, busy } = useRunner()
  return (
    <li className="gb-venue" data-venue={v.id}>
      <span className="gb-venue__n">{v.name}{v.unverified ? <> <span className="gr-warn gr-small" title={tr('未经真网验证，仅限测试网 / 模拟盘')}>{tr('未验证')}</span></> : null}</span>
      <span className="gr-muted">{v.wsText}</span>
      <span className="gb-venue__lat gr-num gr-muted">{v.p50 === null ? '' : `${fmtLoose(v.p50)} ms`}</span>
      {v.isSim ? null : <Button size="xs" variant="ghost" icon="refresh" busy={busy} disabled={kernelDown} data-act="reconnect" onClick={() => void run((b) => reconnectVenue(b, v.id), tr('已请求重连 {0}', v.name))}>{tr('重连')}</Button>}
    </li>
  )
}

function NetworkCard({ venues, primary, kernelDown, readErr }: { venues: VenueHealth[]; primary: VenueHealth | null; kernelDown: boolean; readErr: string | null }) {
  const way = kernelDown || readErr ? '—' : !primary ? tr('未连接') : primary.isSim ? tr('内置模拟场所') : tr('WebSocket 直连')
  return (
    <>
      <dl className="gb-kv">
        <div><dt>{tr('连接方式')}</dt><dd>{way}</dd></div>
        <div><dt>{tr('延迟')}</dt><dd className="gr-num">{kernelDown || primary?.p50 == null ? '—' : `${fmtLoose(primary.p50)} ms`}{!kernelDown && primary?.p95 != null ? <span className="gr-muted"> · p95 {fmtLoose(primary.p95)} ms</span> : null}</dd></div>
        {/* r4：预算正常时不上总览条，剩余百分比在这里（IXD 8-2：只有偏低才上条） */}
        <div><dt>{tr('预算')}</dt><dd className="gr-num">{kernelDown || primary?.used == null || primary.limit == null ? '—' : <>{primary.leftPct === null ? null : <>{tr('剩 {0}%　', Math.round(primary.leftPct))}</>}<span className="gr-muted">{tr('已用 {0} / ', fmtLoose(primary.used))} {fmtLoose(primary.limit)}{primary.windowMs ? tr(' · 每 {0} 秒', Math.round(primary.windowMs / 1000)) : ''}</span></>}</dd></div>
      </dl>
      {kernelDown ? <div className="gr-down gr-small">{tr('内核未连接')}</div> : readErr ? <div className="gr-down gr-small gb-sb__errfull">{readErr}</div> : venues.length ? <ul className="gb-venues">{venues.map((v) => <VenueLine key={v.id} v={v} kernelDown={kernelDown} />)}</ul> : <div className="gr-muted gr-small">{tr('场所未连接')}</div>}
    </>
  )
}

function StatusBar(_props: BlockProps) {
  const { view, venues, error, reload } = useStatus()
  const acct = useAccountsData(false)
  const pend = usePending()
  const now = useNow(1000)
  const offline = useOffline(() => { reload(); acct.reload(); pend.reload() }, true)
  const tkBusy = useTakeoverBusy()
  const [net, setNet] = useState(false)
  const [tk, setTk] = useState(false)
  // 「内核未连接」与「场所未连接」分开说（IXD F8-1）：只有壳判定离线（<html data-offline>，或会话已关）才算内核未连接、才禁用接管；
  // 内核在线、只是场所状态读不到时，首项照内核原文显示（截断、悬停全文），接管照常可点（C1：不改写上游原文，接管入口不能因为读取失败消失）
  const feed = useFeedState()
  const stale = offline || feed !== 'live'
  const kernelDown = offline
  const readErr = !kernelDown && error ? error.message : null
  const p = view.primary
  const left = kernelDown ? null : view.budgetLeft
  const level = budgetLevel(left)
  const isMain = !kernelDown && !!p && !p.isSim && p.environment === 'mainnet'
  const budgetTitle = !kernelDown && p?.used != null && p.limit != null ? tr('已用 {0} / {1}{2}', fmtLoose(p.used), fmtLoose(p.limit), p.windowMs ? tr(' · 每 {0} 秒', Math.round(p.windowMs / 1000)) : '') : tr('场所速率预算剩余')
  // 实盘与纸面分开（IA §2.1）；有实盘账户时纸面降一级成第二组，只有纸面时主数就是纸面
  const t = totalsByMode(acct.accounts, acct.summaries)
  const main = t.main === 'live' ? t.live : t.main === 'paper' ? t.paper : null
  const paper = t.main === 'live' ? t.paper : null
  const markTimes = acct.rows.map((r) => r.position.markTs)
  const markTs = markTimes.length && markTimes.every((ts) => typeof ts === 'number' && Number.isFinite(ts) && ts > 0)
    ? Math.min(...markTimes.map((ts) => ts as number)) : undefined
  const live = pend.cards.filter((c) => c.expiresAt > now)
  const urgent = soonest(live, now)
  return (
    <div className="gb-sb" data-feed={feed} data-online={kernelDown ? '0' : '1'}>
      {main && t.main ? <Lead mode={t.main} t={main} off={stale} /> : null}
      {feed !== 'live' ? <FeedNotice markTs={markTs} feed={feed} now={now} /> : null}
      {paper && paper.equity !== null ? (
        <div className="gb-sb__g gb-sb__eq" data-mode="paper">
          <span className="gb-sb__lab">{tr('纸面')}</span>
          <span className="gb-sb__lo gr-num"><RollingNumber value={F.usd(paper.equity)} /></span>
          {paper.today === null ? null : <span className="gb-sb__aux gb-sb__today gr-num">{tr('今日 ')}<span className={toneCls(paper.today, stale).trim()}>{F.signed(paper.today)}</span></span>}
        </div>
      ) : null}
      <button type="button" className="gb-sb__g gb-sb__risk" data-act="strip-risk" onClick={() => focusCard('risk')}>
        <span className="gb-sb__lab">{tr('风险')}</span><span className="gb-sb__state" data-state={view.state ?? ''}>{view.stateLabel}</span>
      </button>
      <button type="button" className="gb-sb__pend" data-act="strip-pending" onClick={() => focusCard('pending')}>
        <span>{tr('待批')}{pend.phase === 'ready' ? <> <b className="gb-sb__pn gr-num">{live.length}</b></> : null}</span>
        {urgent ? <span className="gb-sb__aux gr-num">{tr('最急 ')}{formatCountdown(urgent.expiresAt - now)}</span> : null}
      </button>
      {/* 预算正常时不上条（在网络卡里）；偏低时出 ⊘ + 数字（IXD 8-2） */}
      {level ? <span className="gb-sb__g gb-sb__budget" data-level={level} title={budgetTitle}><span className="gb-sb__lab">{tr('预算')}</span><b className={'gr-num' + (level === 'low' ? ' gr-down' : ' gr-warn')}>{`${Math.round(left as number)}%`}</b>{level === 'low' ? <Icon name="block" size={12} className="gr-down" /> : null}</span> : null}
      <div className="gb-sb__right">
        {/* 「内核未连接」与「场所未连接」分开说（IXD F8-1）：内核在线、只是场所状态读不到时，网络项是内核原文（截断、悬停全文），接管照常可点（r2 C1） */}
        <PopoverPanel side="bottom" align="end" open={net} onOpenChange={(v: boolean) => { setNet(v); if (v) setTk(false) }} label={tr('网络')} width="320px" className="gb-float gb-netcard"
          trigger={<button type="button" className="gb-sb__net" data-act="network" data-net={isMain ? 'mainnet' : undefined} data-down={kernelDown || readErr ? '1' : undefined} title={readErr ?? undefined}>
            <b className="gb-sb__netn">{kernelDown ? tr('内核未连接') : readErr ?? view.network}</b>
            {kernelDown || readErr || !p ? null : <><span className="gb-sb__netx">{p.wsText}</span>{view.latency === null ? null : <span className="gb-sb__netx gr-num">{fmtLoose(view.latency)} ms</span>}</>}
          </button>}>
          <NetworkCard venues={venues} primary={p} kernelDown={kernelDown} readErr={readErr} />
        </PopoverPanel>
        {kernelDown ? (
          // 内核断开时接管禁用并给原因（IXD F8-2）：命令发不出去，点了没反应不如直接说
          <span className="gb-sb__tkoff" title={tr('内核未连接')}><Button variant="secondary" disabled data-act="takeover">{tr('接管')}</Button></span>
        ) : (
          <PopoverPanel side="bottom" align="end" open={tk} onOpenChange={(v: boolean) => { setTk(v); if (v) setNet(false) }} label={tr('接管')} width="300px" className="gb-float gb-tkcard" onFocusOutside={keepOpen}
            trigger={<Button variant="secondary" data-act="takeover" disabled={tkBusy && !tk} title={tkBusy && !tk ? tr('接管执行中') : undefined}>{tr('接管')}</Button>}>
            <div className="gb-lab"><span>{tr('接管')}</span><InfoTip text={tr('停止新开仓只拦新单，不会平掉已有持仓；要平仓用「全部平仓」。恢复交易只能由你在风险状态里完成。')} placement="bottom" /></div>
            <TakeoverButtons vertical offline={kernelDown} onDone={() => { setTk(false); reload() }} />
          </PopoverPanel>
        )}
      </div>
    </div>
  )
}

export const statusBarBlock = defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.statusbar',
    name: tr('状态条'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './statusbar.js', element: 'gr-statusbar' },
    isolation: 'inline',
    size: { minW: 24, minH: 1, defaultW: 24, defaultH: 1 },
    inputs: {
      // r4 总览条：实盘 / 纸面权益与今日（account.*）、待批张数与最急（proposal.*）；权限 account.read 已有
      events: [
        { topic: 'venue.status', maxHz: 1 }, { topic: 'risk.state' },
        { topic: 'account.summary', maxHz: 1 }, { topic: 'account.positions', maxHz: 2 }, { topic: 'account.fills', maxHz: 2 }, { topic: 'account.orders', maxHz: 2 },
        { topic: 'proposal.*' },
      ],
      queries: ['venue.status', 'risk.state', 'account.list', 'account.summary', 'account.positions', 'proposal.list', 'agentkey.list'],
    },
    actions: ['takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all', 'venue.reconnect'],
    permissions: ['account.read', 'takeover.trigger'],
    pinned: true,
    linkGroups: [],
    fixtures: ['./fixtures/statusbar.json'],
  },
  component: StatusBar,
})
