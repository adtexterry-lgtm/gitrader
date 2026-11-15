// SPDX-License-Identifier: CPAL-1.0
// 应用壳：顶栏（字标 + 工作台 / 设置 / 关于 + 命令入口）+ 总览条（状态条块，r4 起在顶栏下）+ 内容 + ⌘K + PIN 弹层（排队）+ toast。
// 桌面：视口即容器（.gr-app 100dvh），页面级没有纵向滚动条。手机视图（< 600 或高 < 480，含横屏）：单列、内容区内部纵向滚动、状态条移到顶栏下（IXD F1-8）。
// 模态纪律（IXD G6）：同一时刻一个模态，PIN > 命令面板；PIN 打开时 Ctrl/⌘+K 无效、背景 inert；第二个 PIN 请求排队，不覆盖（F2-6）。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { setConfig } from '../core/workspace'
import { pageWorkspace } from '../core/presets'
import { Icon } from '../ui/components/Icon.jsx'
import { Button, Skeleton } from '../ui/components/core.jsx'
import { copyText } from '../ui/lib/clip.js'
import { toast, ToastHost } from '../ui/components/overlay.jsx'
import { useHotkey, useMedia } from '../ui/lib/hooks.js'
import { useLayout } from '../ui/lib/layout.js'
import { About } from './About.jsx'
import { AgentRequestCard } from './AgentRequestCard.jsx'
import { Attribution } from './Attribution.jsx'
import { BlockHost } from './BlockHost.jsx'
import { Brand, GlyphMark } from './brand.jsx'
import { CommandPalette } from './CommandPalette.jsx'
import { ShellCtx, useShell } from './ctx.js'
import { go, restoreFocus, useConnection, useRoute } from './hooks.js'
import { PinDialog, pinTitle } from './PinDialog.jsx'
import { Settings } from './Settings.jsx'
import { Workbench } from './Workbench.jsx'
import { readModeLabel } from './standalone.js'
import { deriveFeedState } from '../core/feed-state.ts'
import { createRestartWatcher, readStartedAt } from '../core/kernel-restart.ts'
import { readHealth } from '../core/health'
import { cli, setLauncher } from '../core/launcher'
import { agentTroubleOf, agentTroubleText } from '../core/agent-trouble.ts'
import { t } from '../ui/lib/i18n.js'

// 壳内自带两件小东西，不反向依赖块包源码：「未接通」位 + 块间聚焦事件名（与块包约定同名）。
const FOCUS_EVENT = 'gitrader:focus'
const KERNEL_RESTART_EVENT = 'gitrader:kernel-restarted' // 与块包（blocks-default model-activity）约定同名
function Unwired({ message = '' }) {
  return <div data-wire="off"><span className="g5-t3">{t('未接通')}</span><span className="g5-msg">{message}</span></div>
}

const NAV = [{ id: 'workbench', label: t('工作台') }, { id: 'settings', label: t('设置') }, { id: 'about', label: t('关于') }]
const CONN = { open: ['ok', t('已连接')], connecting: ['pending', t('连接中')], reconnecting: ['pending', t('重连中')], idle: ['unknown', t('未连接')], closed: ['err', t('未连接')] }
const FEED_WORD = { live: t('实时'), stale: t('陈旧'), down: t('中断') }
const FEED_TONE = { live: 'ok', stale: 'warn', down: 'err' }
const MOBILE = '(max-width: 599px), (max-height: 479px)'
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')

const R5_NAV = [
  ['overview', t('总览'), 'overview'], ['chart', t('图表'), 'trade'], ['records', t('记录'), 'journal'],
  ['funds', t('资金'), 'wallet'], ['strategies', t('策略'), 'strategies'], ['lab', t('实验'), 'research'], ['plugins', t('插件'), 'store'],
]

const R5_MODE_PATHS = {
  frame: 'M10.5 4.5h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4',
  popout: 'M14 4.5h5.5V10',
  popin: 'M11.5 7v5.5H17',
  link: 'M19.5 4.5l-8 8',
}

function SettingsGlyph() {
  return <svg className="g5-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.11 4.95 L10.27 2.66 L13.73 2.66 L13.89 4.95 L15.65 5.68 L17.38 4.17 L19.83 6.62 L18.32 8.35 L19.05 10.11 L21.34 10.27 L21.34 13.73 L19.05 13.89 L18.32 15.65 L19.83 17.38 L17.38 19.83 L15.65 18.32 L13.89 19.05 L13.73 21.34 L10.27 21.34 L10.11 19.05 L8.35 18.32 L6.62 19.83 L4.17 17.38 L5.68 15.65 L4.95 13.89 L2.66 13.73 L2.66 10.27 L4.95 10.11 L5.68 8.35 L4.17 6.62 L6.62 4.17 L8.35 5.68Z"/><circle cx="12" cy="12" r="3"/></svg>
}

function ModeGlyph({ active }) {
  return <>
    <svg className="g5-pri" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={R5_MODE_PATHS.frame}/><path d={R5_MODE_PATHS.popout}/><path d={R5_MODE_PATHS.link}/></svg>
    <svg className="g5-alt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={R5_MODE_PATHS.frame}/><path d={R5_MODE_PATHS.popin}/><path d={R5_MODE_PATHS.link}/></svg>
  </>
}

function ModeControl({ placement = 'top' }) {
  const sh = useShell()
  const mode = sh.standaloneState
  const active = mode.mode === 'standalone' || mode.peer
  const enabled = mode.available && (mode.mode !== 'standalone' || mode.hostAvailable)
  const buttonClass = placement === 'rail' ? 'g5-ri' : 'g5-tbi'
  return <>
    <button type="button" className={buttonClass} data-act="standalone" data-mode={active ? 'on' : 'off'} aria-pressed={String(active)} aria-label={sh.standalone.label} title={sh.standalone.label} disabled={!enabled} onClick={sh.standalone.run}>
      <ModeGlyph active={active}/><span className="g5-tip g5-glass" />
    </button>
    {mode.mode === 'standalone' && !mode.hostAvailable ? <span className="g5-host-unavailable" data-host-unavailable>{t('宿主侧栏未打开')}</span> : null}
  </>
}

function FeedIndicators({ status, feed, r5 = false, compact = false, signedOut = false }) {
  const [kernelTone, kernelWord] = signedOut ? ['err', t('未登录')] : (CONN[status] || CONN.idle) // UX-29：会话失效时是没登录，不是内核没了
  const feedWord = FEED_WORD[feed] || FEED_WORD.stale
  const feedTone = FEED_TONE[feed] || FEED_TONE.stale
  // compact（手机宽度）：只留两个状态点，文字进 title / aria-label；否则两行文字把设置齿轮挤到接管钮下面
  return <div className={(r5 ? 'g5-feed-state' : 'gr-feed-state') + (compact ? ' is-compact' : '')} aria-label={t('内核{0}，行情{1}', kernelWord, feedWord)}>
    <span title={t('内核{0}', kernelWord)}><i className={'gr-dot gr-dot--' + kernelTone} aria-hidden="true" />{compact ? null : t('内核 {0}', kernelWord)}</span>
    <span title={t('行情{0}', feedWord)}><i className={'gr-dot gr-dot--' + feedTone} aria-hidden="true" />{compact ? null : t('行情 {0}', feedWord)}</span>
  </div>
}

function R5TopBar({ routeId, onSearch, blocked, copied, onCopyBlocked }) {
  const sh = useShell()
  const narrow = useMedia('(max-width: 599px)')
  const [pagesOpen, setPagesOpen] = useState(false)
  const pagesRef = useRef(null)
  const pagesButton = useRef(null)
  useEffect(() => { setPagesOpen(false) }, [routeId, narrow])
  useEffect(() => {
    if (!pagesOpen) return undefined
    const outside = (event) => { if (!pagesRef.current?.contains(event.target)) setPagesOpen(false) }
    const escape = (event) => {
      if (event.key === 'Escape') { setPagesOpen(false); pagesButton.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true) // 捕获阶段：别的全局键处理器停止冒泡时也能收起
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [pagesOpen])
  return (
    <header className="g5-topbar">
      <Brand onClick={() => go('workbench', undefined, 'r5')} />
      {narrow ? <div className="g5-pages" ref={pagesRef} onKeyDown={(event) => { if (event.key === 'Escape' && pagesOpen) { event.stopPropagation(); setPagesOpen(false); pagesButton.current?.focus() } }}>
        <button ref={pagesButton} type="button" className="g5-pages-button" data-act="pages" aria-expanded={pagesOpen} aria-controls="g5-pages-menu" onClick={() => setPagesOpen(!pagesOpen)}>{t('页面')}<Icon name="chevron-right" size={12} /></button>
        {pagesOpen ? <nav id="g5-pages-menu" className="g5-pages-menu g5-glass" aria-label={t('主导航')}>
          {R5_NAV.map(([id, label]) => {
            const active = (id === 'overview' ? 'workbench' : id) === routeId || (id === 'lab' && routeId === 'lab-detail')
            return <a key={id} href={'#/' + id} aria-current={active ? 'page' : undefined} data-page={id} onClick={() => setPagesOpen(false)}>{label}</a>
          })}
        </nav> : null}
      </div> : <nav className="g5-nav" aria-label={t('主导航')}>
        {R5_NAV.map(([id, label]) => {
          const active = (id === 'overview' ? 'workbench' : id) === routeId || (id === 'lab' && routeId === 'lab-detail')
          return <a key={id} className={id === 'strategies' ? 'g5-g2' : undefined} href={'#/' + id} aria-current={active ? 'page' : undefined} data-page={id}>{label}</a>
        })}
      </nav>}
      <div className="g5-tr g5-topbar__actions">
        <FeedIndicators status={sh.status} feed={sh.feed} r5 compact={narrow} signedOut={sh.dead === 'session'} />
        <button type="button" className="g5-cmdk" data-act="palette" aria-label={t('搜索命令')} aria-keyshortcuts={MAC ? 'Meta+K' : 'Control+K'} onClick={onSearch}>
          <Icon name="search" size={20} /><span>{t('搜索命令')}</span><span className="g5-k">{MAC ? '⌘K' : 'Ctrl K'}</span>
        </button>
        {sh.standalone?.available ? <ModeControl /> : null}
        {blocked ? <BlockedNotice copied={copied} onCopy={onCopyBlocked}/> : null}
        <a className="g5-tbi" onClick={navTipDismiss} onPointerOut={navTipReset} onFocusOut={navTipReset} data-act="settings" aria-label={t('设置')} title={t('设置')} href="#/settings/connect" aria-current={routeId === 'settings' ? 'page' : undefined}><SettingsGlyph /><span className="g5-tip g5-glass">{t('设置')}</span></a>
      </div>
    </header>
  )
}

function R5Rail({ routeId, onSearch, blocked, copied, onCopyBlocked }) {
  const sh = useShell()
  const active = (id) => (id === 'overview' ? 'workbench' : id) === routeId || (id === 'lab' && routeId === 'lab-detail')
  return (
    <nav className="g5-rail" aria-label={t('主导航')} onClick={navTipDismiss} onPointerOut={navTipReset} onFocusOut={navTipReset}>
      {/* 侧栏标志：G 字形原件 src/ui/brand/g-glyph-32.svg（favicon 同源），经 GlyphMark 原样使用 */}
      <span className="g5-mark" aria-label="Gitrader"><GlyphMark size={28} /></span>
      {R5_NAV.slice(0, 4).map(([id, label, icon]) => <a key={id} className="g5-ri" href={'#/' + id} aria-label={label} aria-current={active(id) ? 'page' : undefined} data-page={id}><Icon name={icon} size={20} /><span className="g5-tip g5-glass">{label}</span></a>)}
      <span className="g5-sepr" />
      {R5_NAV.slice(4).map(([id, label, icon]) => <a key={id} className="g5-ri" href={'#/' + id} aria-label={label} aria-current={active(id) ? 'page' : undefined} data-page={id}><Icon name={icon} size={20} /><span className="g5-tip g5-glass">{label}</span></a>)}
      <div className="g5-foot">
        <button type="button" className="g5-ri" data-act="palette" aria-label={t('搜索命令')} onClick={onSearch}><Icon name="search" size={20} /><span className="g5-tip g5-glass">{t('搜索命令')}</span></button>
        {sh.standalone?.available ? <ModeControl placement="rail" /> : null}
        {blocked ? <BlockedNotice copied={copied} onCopy={onCopyBlocked}/> : null}
        <a className="g5-ri" data-act="settings" aria-label={t('设置')} href="#/settings/connect" aria-current={routeId === 'settings' ? 'page' : undefined}><SettingsGlyph /><span className="g5-tip g5-glass">{t('设置')}</span></a>
      </div>
    </nav>
  )
}

function BlockedNotice({ copied, onCopy }) {
  return <div className="g5-blocked-notice g5-glass" role="status">
    <Unwired message={t('宿主不允许打开新窗口')}/>
    <Button size="sm" variant="ghost" icon={copied ? 'check' : 'copy'} data-act="copy-relink" onClick={onCopy}>{copied ? t('已复制') : t('复制命令')}</Button>
  </div>
}

function navTipDismiss(e) {
  const el = e.target.closest?.('.g5-ri, .g5-tbi')
  if (el) el.dataset.tipDismissed = '1'
}
function navTipReset(e) {
  const el = e.target.closest?.('.g5-ri, .g5-tbi')
  if (el && !el.contains(e.relatedTarget)) delete el.dataset.tipDismissed
}

function R5Surface({ route, onSearch, boot, dead }) {
  const sh = useShell()
  const peer = sh.standaloneState.peer
  const blocked = sh.standaloneState.blocked
  const [copied, setCopied] = useState(false)
  const [pendingFallbackOpen, setPendingFallbackOpen] = useState(false)
  // UX-13：刚设好 PIN 给一条「下一步」（沿用 PIN 提示的横幅位；点一下去总览并收起）
  const [steps, setSteps] = useState(false)
  const prevPin = useRef(sh.pinSet)
  useEffect(() => { if (prevPin.current === false && sh.pinSet === true) setSteps(true); prevPin.current = sh.pinSet }, [sh.pinSet])
  const pending = (sh.runtimeWorkspace || sh.workspace).items.find((item) => item.instanceId === 'bi_agent_1')
  const pendingDef = pending?.block ? sh.registry.resolve(pending.block) : null
  const pendingReal = !!pendingDef && !pendingDef.placeholder
  useEffect(() => {
    if (pendingReal) {
      setPendingFallbackOpen(false)
      return undefined
    }
    const onFocus = (event) => { if (event.detail?.card === 'pending') setPendingFallbackOpen(true) }
    window.addEventListener(FOCUS_EVENT, onFocus)
    return () => window.removeEventListener(FOCUS_EVENT, onFocus)
  }, [pendingReal])
  const copyBlocked = async () => {
    if (await copyText(cli(RELINK_CMD))) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    else toast.err(t('复制失败：请手动选中命令'))
  }
  const frame = (children) => <div className="g5-frame" data-g5-route={route.id}>
    <R5TopBar routeId={route.id} onSearch={onSearch} blocked={blocked && !dead} copied={copied} onCopyBlocked={copyBlocked}/>
    <R5Rail routeId={route.id} onSearch={onSearch} blocked={blocked && !dead} copied={copied} onCopyBlocked={copyBlocked}/>{children}
  </div>
  if (peer) return frame(
    <div className="g5-ws g5-one g5-peer-workspace"><div className="g5-col"><section className="g5-card g5-peer-card" data-standalone-peer="on">
      <div className="g5-peer-row"><div className="g5-peer-message">{t('已在独立窗口打开 · ')}</div><ModeControl/><span className="g5-peer-dock-label" aria-hidden="true"/></div>
    </section></div></div>,
  )
  if (boot === null && !dead) return frame(
    <div className="g5-ws g5-one"><div className="g5-col"><section className="g5-card g5-boot-skeleton" aria-busy="true" aria-label={t('正在连接')}><Skeleton w="100%" h={120}/></section><Attribution /></div></div>,
  )
  const pendingItem = pending && pendingReal ? { ...pending, config: { ...pending.config, view: 'pending' } } : null
  const statusRef = sh.workspace.statusBar?.block
  const statusDef = statusRef ? sh.registry.resolve(statusRef) : null
  const statusReal = !!statusDef && !statusDef.placeholder
  const statusItem = statusRef ? { instanceId: 'bi_statusbar_1', block: statusRef, channel: 'A', config: {} } : null
  const main = dead
    ? <div key="r5-main" className="g5-main"><main className="g5-shell-content"><DeadCard kind={dead} mobile={sh.mobile}/></main></div>
    : <div key="r5-main" className="g5-main"><main className="g5-shell-content">{route.id === 'settings' ? <Settings group={route.param} /> : <Workbench />}</main></div>
  const connected = !!boot?.online && !dead
  return frame(<>
    {connected ? <div className="g5-status-slot" data-slot="statusbar">{statusItem && statusReal ? <BlockHost item={statusItem} def={statusDef} grid={{ w: 24, h: 1 }} /> : <Unwired message={statusRef ? t('状态栏组件定义缺失') : t('缺少 statusBar.block 字段')} />}</div> : null}
    {connected && sh.pinSet === false && route.id !== 'settings' ? <a className="g5-pinhint" href="#/settings/keys" data-act="pin-hint"><span className="gr-dot gr-dot--warn" aria-hidden="true" />{t('先设置 PIN：批准、恢复交易都要用它 · 去设置')}</a> : null}
    {connected && steps ? <a className="g5-pinhint" href="#/overview" data-act="next-steps" onClick={() => setSteps(false)}><span className="gr-dot gr-dot--ok" aria-hidden="true" />{t('PIN 已设好 · 下一步：① 在总览的 Agent 卡接入 Agent ② 批准它的请求 ③ 回总览看活动')}</a> : null}
    {connected && !sh.offline && sh.agentTrouble ? <div className="g5-agenthint" role="status" data-act="agent-trouble" title={agentTroubleText(sh.agentTrouble)}><span className="gr-dot gr-dot--warn" aria-hidden="true" />{agentTroubleText(sh.agentTrouble)}</div> : null}
    {connected && sh.offline ? <div className="g5-pinhint g5-downhint" role="alert" data-act="service-down"><span className="gr-dot gr-dot--err" aria-hidden="true" />{t('本机服务已停止：纸面止损和风控都不会执行 · 重新运行 {0} 后自动恢复', cli('gitrader serve'))}</div> : null}
    {main}
    {connected ? pendingItem ? <div className="g5-pending-slot" data-slot="pending"><R5TileHost item={pendingItem} def={pendingDef}/></div> : <div className="g5-pending-slot" data-slot="pending" data-wire="off"><div className="g5-pending-fallback" hidden={!pendingFallbackOpen}><Unwired message={pending ? t('待批卡组件定义缺失') : t('缺少待批卡配置')} /></div></div> : null}
  </>)
}

function R5TileHost({ item, def }) {
  return <BlockHost item={item} def={def} grid={{ w: item.w || 8, h: item.h || 8 }} />
}

/**
 * 顶栏（r4，40 高）：字标原件（图高 14）· 三页切换 · 命令入口。当前页只换字色（text，其余 text-3），无下划线、无滑块（T12）；
 * 命令入口 = 图标 +「搜索命令」+「Ctrl K」拉丁小字，无框、无键帽（T11），悬停 6% 底。
 */
function TopBar({ routeId, onSearch }) {
  const sh = useShell()
  return (
    <header className="gr-top">
      <Brand onClick={() => go('workbench')} />
      <nav className="gr-nav" aria-label={t('主导航')}>
        {NAV.map((n) => {
          const active = n.id === routeId
          return (
            <a key={n.id} className={'gr-nav__item' + (active ? ' is-active' : '')} href={n.id === 'workbench' ? '#/' : '#/' + n.id} aria-current={active ? 'page' : undefined} data-nav={n.id}>
              <span className="gr-nav__t">{n.label}</span>
            </a>
          )
        })}
      </nav>
      <FeedIndicators status={sh.status} feed={sh.feed} signedOut={sh.dead === 'session'} />
      <button type="button" className="gr-searchbtn" onClick={onSearch} aria-label={t('打开命令面板')} aria-keyshortcuts={MAC ? 'Meta+K' : 'Control+K'} data-act="palette">
        <Icon name="search" size={14} />
        <span className="gr-searchbtn__t">{t('搜索命令')}</span>
        <span className="gr-searchbtn__k">{MAC ? '⌘K' : 'Ctrl K'}</span>
      </button>
    </header>
  )
}

const RELINK_CMD = 'gitrader open'

/**
 * 会话失效 / 连不上内核（PLAN ⑤）：取代内容区的一张竖排卡——图标格 → 状态与可走的步骤 → 等宽命令 → 动作。
 * 会话留在本标签页的 sessionStorage（关页即清），刷新应当不掉；掉到这里就是链接真失效了，所以要告诉人两条都走得通的路。
 * 手机上不要求在终端运行命令（IXD 390 规则 6）：只给「重新连接」。
 */
function DeadCard({ kind, mobile }) {
  const session = kind !== 'network'
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (await copyText(cli(RELINK_CMD))) { setCopied(true); setTimeout(() => setCopied(false), 1500) } else toast.err(t('复制失败：请手动选中命令'))
  }
  return (
    <div className="gr-dead" role="alert" data-state={session ? 'session' : 'network'}>
      <div className="gr-dead__card">
        <h2 className="gr-dead__t">{session ? t('会话已失效') : t('无法连接内核')}</h2>
        {session && !mobile ? <p className="gr-dead__d">{t('登录已过期。在终端运行 ')}<code className="gr-dead__cmd">{cli(RELINK_CMD)}</code>{t('（输入 PIN）会自动打开新页面；如果 ')}<code className="gr-dead__cmd">{cli('gitrader serve')}</code>{t(' 开在前台窗口，也可以在那个窗口按 Enter。')}</p> : null}
        {!session ? <p className="gr-dead__d">{t('确认 gitrader 正在运行后重试')}</p> : null}
        <div className="gr-dead__act">
          {session && !mobile ? <Button size="sm" variant="primary" icon={copied ? 'check' : 'copy'} data-act="copy-relink" onClick={copy}><span key={copied ? 'y' : 'n'} className="gr-swap">{copied ? t('已复制') : t('复制命令')}</span></Button> : null}
          <Button size="sm" variant={session && !mobile ? undefined : 'primary'} data-act="retry" onClick={() => location.reload()}>{session && mobile ? t('重新连接') : t('重试')}</Button>
        </div>
        <Attribution />
      </div>
    </div>
  )
}

/** 总览条槽（r4：状态条搬到顶栏下、内容上方，钉住）：内容是 statusBar.block（块包的状态条；没装就是壳自带的占位）。条内排版归块。 */
function StatusSlot() {
  const sh = useShell()
  const ref = sh.workspace.statusBar.block
  const def = sh.registry.resolve(ref)
  const item = useMemo(() => ({ instanceId: 'bi_statusbar_1', block: ref, channel: 'A', config: {} }), [ref])
  const real = def && !def.placeholder
  const [tone, word] = CONN[sh.status] || CONN.idle
  return (
    <section className="gr-status" role="region" aria-label={t('总览')} data-slot="statusbar" data-card="overview">
      {real ? <BlockHost item={item} def={def} grid={{ w: 24, h: 1 }} /> : (
        <span className="gr-status__fallback"><i className={'gr-dot gr-dot--' + tone} />{word}</span>
      )}
    </section>
  )
}

/**
 * PIN 请求队列（IXD 流程 2）：KernelClient 的 attestor（开了 SDK 重试回路）→ 一次一个弹层，后来的排队。
 * 同一条命令的重试（req.params 是同一个对象、带 error）落回原弹层：显示内核原文，不关；带证明重发落定（SDK onSettled，按 params 对象认命令）才关。
 * ponytail: params 不是对象的命令（目前没有要 PIN 的）认不出是哪条，回退成「提交即关」。
 */
function usePinQueue(runtime, beforeOpen, fallbackOpener) {
  const [item, setItem] = useState(null)
  const q = useRef({ cur: null, queue: [], gone: new WeakSet(), seq: 0 }).current
  const show = (it) => { q.cur = it; setItem(it) }
  const next = () => {
    q.cur = null
    setItem(null)
    setTimeout(() => { if (!q.cur && q.queue.length) show(q.queue.shift()) }, 200) // 前一个关完再开下一个
  }
  const lock = (req) => (req.retryAfterMs ? Date.now() + req.retryAfterMs : 0)
  const isPeer = () => {
    if (runtime.ui !== 'r5' || !runtime.standalone) return false
    try { return runtime.standalone.getSnapshot().peer === true } catch { return false }
  }
  useEffect(() => runtime.kernel.onSettled((c) => { const cur = q.cur; if (cur && cur.track && cur.req.params === c.params) next() }), [runtime])
  useEffect(() => {
    const k = runtime.kernel
    k.setAttestor(async (req, ctx = {}) => {
      if (isPeer()) return null
      const key = req.params && typeof req.params === 'object' ? req.params : null
      if (req.error !== undefined && key) {
        if (q.gone.has(key)) return null // 人在「验证中…」时已经放弃等待：后面的重试不再问
        const c = q.cur
        if (c && c.req.params === key) return new Promise((resolve) => show({ ...c, req, resolve, busy: false, round: c.round + 1, lockUntil: lock(req) }))
      }
      const at = document.activeElement
      const opener = at && at !== document.body && !at.closest('[role="dialog"]') ? at : fallbackOpener()
      // 插件块发起的 PIN 标出来源：按宿主填的 blockId 判（插件自己写的标题不算数，F2-4）
      const plugin = ctx.blockId && !runtime.firstParty.has(ctx.blockId) ? ctx.blockId : null
      const def = plugin ? runtime.registry.resolve(plugin) : null
      const title = (!ctx.blockId && ctx.title) || (await pinTitle(k, req))
      if (isPeer()) return null
      const base = {
        id: ++q.seq, req, title, busy: false, round: 0, lockUntil: lock(req), opener, tile: opener && opener.closest ? opener.closest('.gr-tile-p') : null,
        from: plugin ? t('来自 插件 · {0}', (def && def.manifest.name) || plugin) : '',
        track: !!key,
      }
      beforeOpen()
      return new Promise((resolve) => { const it = { ...base, resolve }; if (q.cur) q.queue.push(it); else show(it) })
    }, { retry: true, keepLocked: true })
    return () => k.setAttestor(null)
  }, [runtime])
  const submit = (pin) => {
    const c = q.cur
    if (!c || c.busy) return
    show({ ...c, busy: true })
    c.resolve({ method: 'pin', pin })
    if (!c.track) next() // 认不出是哪条命令：提交即关（r1 行为）
  }
  const cancel = () => {
    const c = q.cur
    if (!c) return
    if (!c.busy) c.resolve(null) // 命令没有发生（块与面板都当取消处理，不报错）
    else if (c.req.params && typeof c.req.params === 'object') q.gone.add(c.req.params)
    next()
  }
  const cancelAll = () => {
    const pending = [q.cur, ...q.queue].filter(Boolean)
    for (const entry of pending) {
      if (entry.busy) {
        if (entry.req.params && typeof entry.req.params === 'object') q.gone.add(entry.req.params)
      } else entry.resolve(null)
    }
    q.queue.length = 0
    q.cur = null
    setItem(null)
  }
  // 锁定期间的免 PIN 出口（F2-2）：停止新开仓永远不要 PIN；成功后原动作当取消
  const haltNew = async () => {
    await runtime.api.takeover('halt_new', t('PIN 锁定时改为停止新开仓'))
    cancel()
    toast.ok(t('已停止新开仓'))
  }
  return { item, submit, cancel, cancelAll, haltNew, isOpen: () => !!q.cur }
}

export function Shell({ runtime }) {
  const L = useLayout()
  const route = useRoute(runtime.ui)
  const mobile = useMedia(MOBILE)
  const conn = useConnection(runtime.kernel)
  const [feed, setFeed] = useState('stale')
  // K5（ux-fix2）：某把 Agent 钥匙连续调用失败（内核 status.agentTrouble）；内容没变就沿用旧对象，不重画
  const [agentTrouble, setAgentTrouble] = useState(null)
  const [palette, setPalette] = useState(false)
  const [pinSet, setPinSet] = useState(null)
  const [workspace, setWorkspace] = useState(runtime.workspace)
  const [boot, setBoot] = useState(null)
  const [standaloneState, setStandaloneState] = useState(() => {
    try { return runtime.ui === 'r5' && runtime.standalone ? runtime.standalone.getSnapshot() : { mode: 'docked', available: false, peer: false, hostAvailable: false, blocked: false } }
    catch { return { mode: 'docked', available: false, peer: false, hostAvailable: false, blocked: false } }
  })
  const opener = useRef(null) // 打开命令面板前的焦点（面板关掉后还给它）
  const pin = usePinQueue(runtime, () => setPalette(false), () => opener.current)
  useEffect(() => {
    const controller = runtime.ui === 'r5' ? runtime.standalone : null
    if (!controller) return undefined
    const plain = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      try { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null } catch { return false }
    }
    controller.setHandlers({
      getPayload: () => ({ route: window.location.hash, blockCfg: runtime.prefs.get().blockCfg }),
      onDock: (payload) => {
        if (!plain(payload)) return
        const patch = {}
        if (typeof payload.route === 'string' && payload.route.startsWith('#/')) {
          history.replaceState(history.state, '', payload.route)
          window.dispatchEvent(new HashChangeEvent('hashchange'))
        }
        if (plain(payload.blockCfg)) {
          const current = runtime.prefs.get().blockCfg
          patch.blockCfg = { ...(plain(current) ? current : {}), ...payload.blockCfg }
        }
        if (Object.keys(patch).length) runtime.prefs.set(patch)
      },
    })
    return controller.subscribe((snapshot) => setStandaloneState(snapshot))
  }, [runtime])
  // Feed freshness belongs to the shell: one status poll, coalesced events, and no overlapping requests.
  useEffect(() => {
    let dead = false
    let running = false
    let again = false
    const forcedAccounts = new Set()
    const snapshots = new Map()
    const refresh = (forceAccountId) => {
      if (forceAccountId) forcedAccounts.add(forceAccountId)
      if (running) { again = true; return }
      running = true
      void (async () => {
        do {
          again = false
          let status
          try { status = await runtime.kernel.query('status') }
          catch { if (!dead) { setFeed('down'); document.documentElement.dataset.feed = 'down' }; break }
          if (typeof status?.launcher === 'string' && status.launcher) setLauncher(status.launcher) // 没带就不动（别把 /api/health 读到的值冲掉）
          const trouble = agentTroubleOf(status)
          setAgentTrouble((prev) => (prev && trouble && prev.key === trouble.key && prev.count === trouble.count && prev.lastError === trouble.lastError) || prev === trouble ? prev : trouble)
          const accounts = Array.isArray(status?.accounts) ? status.accounts.filter((a) => a && a.status === 'active' && typeof a.accountId === 'string') : []
          const active = new Set(accounts.map((a) => a.accountId))
          for (const id of snapshots.keys()) if (!active.has(id)) snapshots.delete(id)
          const ids = new Set([...accounts.map((a) => a.accountId), ...forcedAccounts])
          forcedAccounts.clear()
          await Promise.all([...ids].filter((id) => active.has(id)).map(async (accountId) => {
            try { snapshots.set(accountId, { positions: await runtime.kernel.query('account.positions', { accountId }) }) }
            catch { snapshots.set(accountId, { positions: [], stale: true }) }
          }))
          if (dead) break
          const next = deriveFeedState(status, [...snapshots.values()], Date.now())
          setFeed(next)
          document.documentElement.dataset.feed = next
        } while (again && !dead)
        running = false
      })()
    }
    const offVenue = runtime.kernel.subscribe('venue.status', () => refresh())
    const offPositions = runtime.kernel.subscribe('account.positions', (event) => {
      const accountId = event?.data?.accountId
      if (typeof accountId === 'string') refresh(accountId)
    })
    refresh()
    const timer = setInterval(() => refresh(), 2000)
    return () => {
      dead = true
      clearInterval(timer)
      offVenue()
      offPositions()
      delete document.documentElement.dataset.feed
    }
    // 连上内核（open）时重跑：首次 status 常在连接建立前发出而失败，否则要等 2 s 一轮才从「中断」恢复
  }, [runtime, conn.status === 'open'])
  // P2-6：会话内发现 /api/health 的 startedAt 变了 = 内核重启过；通知活动流插一条只存在于本页内存的「内核已重启」行（不落盘、不写内核账本）。
  useEffect(() => {
    const check = createRestartWatcher(() => readStartedAt(), (startedAt) => window.dispatchEvent(new CustomEvent(KERNEL_RESTART_EVENT, { detail: { startedAt, ts: Date.now() } })))
    void check()
    const timer = setInterval(() => { if (!document.hidden) void check() }, 5000)
    return () => clearInterval(timer)
  }, [runtime])
  useEffect(() => { runtime.ready.then(setBoot) }, [runtime])
  // K1：内核告知的启动器名（便携包是 bin\gitrader.cmd）；读到后重画一次，让已经画出的命令文案换成它
  const [, bumpLauncher] = useState(0)
  useEffect(() => { let on = true; readHealth().then((h) => { if (on && h.launcher) { setLauncher(h.launcher); bumpLauncher((n) => n + 1) } }, () => {}); return () => { on = false } }, [runtime])
  // 启动失败，或曾经连上后被内核关了（WS 鉴权失败 = 会话过期 / 内核重启，客户端不再重连）
  const dead = boot ? (!boot.online ? boot.kind : conn.status === 'closed' ? 'session' : null) : null
  const peer = runtime.ui === 'r5' && standaloneState.peer === true
  const standalone = useMemo(() => {
    if (runtime.ui !== 'r5' || !runtime.standalone) return runtime.standalone
    const active = standaloneState.mode === 'standalone' || standaloneState.peer === true
    const canRun = standaloneState.available === true && (standaloneState.mode !== 'standalone' || standaloneState.hostAvailable === true)
    return {
      available: standaloneState.available === true,
      label: readModeLabel(document, active),
      run: () => {
        if (!canRun) return false
        return active ? runtime.standalone.dock() : runtime.standalone.detach()
      },
    }
  }, [runtime, standaloneState])
  useEffect(() => {
    const el = document.documentElement
    if (runtime.ui === 'r5' && standaloneState.mode) el.dataset.mode = standaloneState.mode
    else delete el.dataset.mode
  }, [runtime.ui, standaloneState.mode])
  useEffect(() => {
    if (!peer) return
    setPalette(false)
    pin.cancelAll()
  }, [peer])
  // 启动时读一次 pinSet（F2-8：工作台上 PIN 弹层的「去设置 PIN」出口要用；以前只有进过设置页才知道）
  useEffect(() => { if (boot && boot.online) runtime.api.settings().then((s) => setPinSet(!!(s && s.pinSet)), () => {}) }, [boot, runtime])

  const page = route.id === 'settings' && (route.param === 'venues' || route.param === 'notify')
    ? route.param
    : route.id === 'lab' && route.param ? 'lab-detail'
      : route.id === 'workbench' ? 'workbench' : route.id
  useEffect(() => {
    if (runtime.ui !== 'r5' || (route.id !== 'chart' && route.id !== 'lab')) return undefined
    const group = route.id === 'chart' ? 'symbol' : 'experiment'
    const off = runtime.hub.subscribe('A', group, (value, source) => {
      if (source === 'shell-route' || typeof value !== 'string' || !value) return
      const nextHash = `#/${route.id}/${encodeURIComponent(value)}`
      if (location.hash === nextHash) return
      history.replaceState(history.state, '', nextHash)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    if (route.param) runtime.hub.set('A', group, route.param, 'shell-route')
    return off
  }, [runtime, route.id, route.param])
  const r5Workspace = useMemo(() => {
    const base = pageWorkspace(page)
    const blockCfg = runtime.prefs?.get?.()?.blockCfg || {}
    return { ...base, items: base.items.map((item) => ({ ...item, config: { ...item.config, ...(blockCfg[item.instanceId] || {}) } })) }
  }, [runtime, page, boot, L.blockCfg])

  const openPalette = () => { if (pin.isOpen()) return; opener.current = document.activeElement; setPalette(true) }
  useHotkey('k', (e) => { e.preventDefault(); if (pin.isOpen() || peer) return; if (palette) setPalette(false); else openPalette() }, { mod: true, allowInInput: true })
  useEffect(() => { document.title = 'Gitrader' }, [])
  useEffect(() => {
    const el = document.documentElement
    el.dataset.theme = L.theme
    el.dataset.density = L.density
    if (runtime.ui === 'r5') el.dataset.ui = 'r5'
    else delete el.dataset.ui
    if (runtime.ui === 'r5') {
      el.dataset.nav = L.navForm
      el.dataset.updown = L.updown
    } else {
      delete el.dataset.nav
      delete el.dataset.updown
    }
  }, [L.theme, L.density, L.navForm, L.updown, runtime.ui])
  // 接管跟踪（M4 / C8）：本页任何入口（风险块、状态条卡、命令面板、PIN 锁定时的「改为停止新开仓」）发出的接管命令，从发出到落定都算「在跑」。
  // ponytail: 只数本页发出的命令（SDK onCommand / onSettled）；Agent 经 MCP 发起的接管不经过这里，要靠不限频的接管事件另做（r2.1）。
  const [tkBusy, setTkBusy] = useState(false)
  useEffect(() => {
    let n = 0
    const isTk = (c) => c.action.startsWith('takeover.')
    const offA = runtime.kernel.onCommand((c) => { if (isTk(c)) { n += 1; setTkBusy(true) } })
    const offB = runtime.kernel.onSettled((c) => { if (isTk(c)) { n = Math.max(0, n - 1); setTkBusy(n > 0) } })
    return () => { offA(); offB() }
  }, [runtime])
  // 连接态挂在 <html> 上：data-kernel = 状态；data-offline = 离线（G5：曾连上、断开 > 2 s）；data-takeover-busy = 有接管在跑（上面的跟踪器）。
  // 一方块可据此禁用命令 / 去涨跌色（B/C 共享契约，A-API 附录），CSS 也能直接用
  useEffect(() => {
    const el = document.documentElement
    el.dataset.kernel = conn.status
    if (conn.offline) el.dataset.offline = ''
    else delete el.dataset.offline
    if (tkBusy) el.dataset.takeoverBusy = ''
    else delete el.dataset.takeoverBusy
  }, [conn.status, conn.offline, tkBusy])

  const ctx = useMemo(() => ({
    ...runtime, standalone, standaloneState, boot, dead, workspace: runtime.ui === 'r5' ? r5Workspace : workspace, runtimeWorkspace: runtime.workspace, pinSet, setPinSet, mobile, status: conn.status, feed, offline: conn.offline, syncing: conn.syncing, takeoverBusy: tkBusy, agentTrouble,
    ui: runtime.ui || 'r4', page,
    go: (id, param) => go(id, param, runtime.ui || 'r4'),
    setConfig: (id, patch) => {
      if (runtime.ui === 'r5') runtime.prefs.setBlockConfig(id, patch)
      else setWorkspace((w) => { const r = setConfig(w, id, patch); return r.ok ? r.ws : w })
    },
  }), [runtime, standalone, standaloneState, boot, dead, workspace, r5Workspace, pinSet, mobile, conn.status, feed, conn.offline, conn.syncing, tkBusy, page, agentTrouble])

  return (
    <ShellCtx.Provider value={ctx}>
      <div className="gr-app" data-route={route.id} data-mobile={mobile ? '' : undefined} inert={pin.item ? true : undefined}>
        <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
          <filter id="gr-deboss" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
            <feOffset in="SourceAlpha" dy="0.7" result="down" />
            <feComposite in="SourceAlpha" in2="down" operator="out" result="topEdge" />
            <feGaussianBlur in="topEdge" stdDeviation="0.25" result="topEdgeBlur" />
            <feFlood flood-color="black" flood-opacity="0.34" />
            <feComposite in2="topEdgeBlur" operator="in" result="innerShadow" />
            <feComposite in="down" in2="SourceAlpha" operator="out" result="bottomRim" />
            <feFlood flood-color="white" flood-opacity="0.22" />
            <feComposite in2="bottomRim" operator="in" result="rimLight" />
            <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="innerShadow" /><feMergeNode in="rimLight" /></feMerge>
          </filter>
        </defs></svg>
        {runtime.ui === 'r5' ? <R5Surface route={route} onSearch={openPalette} boot={boot} dead={dead} /> : <>
          <TopBar routeId={route.id} onSearch={openPalette} />
          <StatusSlot />
          <main className="gr-content" id="gr-content">
            {dead ? <DeadCard kind={dead} mobile={mobile} /> : route.id === 'settings' ? <Settings group={route.param} /> : route.id === 'about' ? <About /> : <Workbench />}
          </main>
          <ToastHost />
        </>}
        <AgentRequestCard />
      </div>
      {runtime.ui === 'r5' && !peer ? <ToastHost /> : null}
      {runtime.ui === 'r5' && peer ? null : <CommandPalette open={palette} onClose={() => setPalette(false)} onRestore={() => { if (!pin.isOpen()) restoreFocus(opener.current) }} />}
      {runtime.ui === 'r5' && peer ? null : <PinDialog item={pin.item} pinSet={pinSet} offline={conn.offline} onSubmit={pin.submit} onCancel={pin.cancel} onHaltNew={pin.haltNew}
        onSettings={() => { pin.cancel(); go('settings', 'keys') }} onRestore={(it) => restoreFocus(it && it.opener, it && it.tile)} />}
    </ShellCtx.Provider>
  )
}
