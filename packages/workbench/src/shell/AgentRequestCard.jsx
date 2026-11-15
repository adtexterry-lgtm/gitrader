// SPDX-License-Identifier: CPAL-1.0
import { useEffect, useRef, useState } from 'preact/hooks'
import { toast } from '../ui/components/overlay.jsx'
import { useShell } from './ctx.js'
import { t, tk } from '../ui/lib/i18n.js'

const TIERS = { read_only: t('只读 · AI 只能看'), paper: t('纸面直通 · AI 的纸面单直接成交'), confirm: t('需确认 · 每笔开仓等你批'), auto_limited: t('限额自动 · 限额内自动成交') }
const asList = (value) => Array.isArray(value) ? value : []
const listText = (value) => asList(value).join(t('、')) || t('未指定')
const message = (error, prefix) => /[一-龥]/.test(error?.message || '') ? tk(error.message) : t('{0}：{1}', prefix, error?.message || t('请重试'))

// K4：账户一律显示「别名 + 纸面/实盘」；账户资料没取到才退回 id 的后 6 位
const accountText = (id, accounts) => {
  const a = accounts.find((x) => x.accountId === id)
  return a && a.alias ? `${a.alias} · ${a.mode === 'paper' ? t('纸面') : t('实盘')}` : String(id).slice(-6)
}

/** 完整授权摘要；只读元数据，不读取或展示令牌。ctx（可选）：{ accounts: account.list 的账户, unit: 额度单位 }；不给就保持旧输出（id 原样、额度不带单位）。 */
export function requestRows(req, now, ctx) {
  const input = req.input || {}
  const m = input.mandate || {}
  const limits = m.limits || {}
  const remaining = Math.max(0, Math.ceil((req.expiresAt - now) / 1000))
  const instruments = asList(m.instrumentAllowlist).map((id) => String(id).includes(':') ? id : `${m.venueAllowlist?.[0] || 'hyperliquid'}:${id}`)
  const days = input.expiresInDays ?? (m.notAfter ? Math.max(0, Math.ceil((m.notAfter - (m.notBefore ?? req.createdAt)) / 86400000)) : 30)
  const accountsText = ctx && Array.isArray(ctx.accounts) ? (asList(m.accounts).map((id) => accountText(id, ctx.accounts)).join(t('、')) || t('未指定')) : listText(m.accounts)
  const rows = [
    [t('宿主'), input.host || t('其它')], [t('档位'), TIERS[input.tier] || t('未知档位')], [t('账户'), accountsText], [t('场所'), listText(m.venueAllowlist)],
    [t('标的'), listText(instruments)], [ctx && ctx.unit ? t('单笔 / 日额（{0}）', ctx.unit) : t('单笔 / 日额'), `${limits.maxOrderNotional ?? t('未指定')} / ${limits.maxDailyNotional ?? t('未指定')}`], [t('有效期'), t('{0} 天', days)],
  ]
  const labels = { maxDailyLoss: t('日亏上限'), maxPositionNotional: t('持仓上限'), maxLeverage: t('杠杆上限'), autoMaxOrderNotional: t('自动单笔上限'), maxOrdersPerMinute: t('每分钟笔数'), maxOrdersPerDay: t('每日笔数') }
  for (const [key, value] of Object.entries(limits)) if (!['maxOrderNotional', 'maxDailyNotional'].includes(key)) rows.push([labels[key] || t('限额 {0}', key), String(value)])
  if (m.heartbeat) rows.push([t('心跳'), t('间隔 {0} 秒 / 超时 {1} 秒', m.heartbeat.intervalSec, m.heartbeat.timeoutSec)])
  if (m.approval) rows.push([t('审批设置'), JSON.stringify(m.approval)])
  if (m.denyLlmLiveEntries !== undefined) rows.push([t('实盘开仓保护'), m.denyLlmLiveEntries ? t('开启') : t('关闭')])
  rows.push([t('剩余时间'), `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`])
  return { rows, remaining, expired: !Number.isFinite(remaining) || remaining <= 0 || req.state !== 'pending' }
}

export function AgentRequestCard() {
  const sh = useShell()
  const kernel = sh.api.kernel
  const enabled = sh.ui === 'r5' && !!sh.boot?.online && !sh.dead && !sh.standaloneState?.peer
  const [requests, setRequests] = useState([])
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [accounts, setAccounts] = useState(null) // account.list：把授权书里的账户 id 换成别名
  const asked = useRef(false)
  const settled = useRef(new Set())
  const refresh = useRef(() => {})
  useEffect(() => {
    if (!enabled) { setRequests([]); return undefined }
    let alive = true, reading = false
    const read = async () => {
      if (document.hidden || reading || !alive) return
      reading = true
      try {
        const result = await kernel.query('agentkey.request.list')
        if (alive && !asked.current) { asked.current = true; kernel.query('account.list').then((r) => { if (alive) setAccounts(asList(Array.isArray(r) ? r : r?.accounts)) }, () => {}) }
        if (alive) { setRequests(asList(result?.requests).filter((r) => !settled.current.has(r.requestId))); setReadError('') }
      } catch (e) { if (alive) setReadError(message(e, t('读取失败'))) }
      finally { reading = false }
    }
    refresh.current = read
    let poll = null, tick = null
    const visibility = () => {
      clearInterval(poll); clearInterval(tick)
      if (document.hidden) return
      setNow(Date.now()); void read()
      poll = setInterval(read, 3000)
      tick = setInterval(() => setNow(Date.now()), 1000)
    }
    let off
    try { off = kernel.subscribe('agentkey.request.changed', read) } catch { /* 无事件能力时由轮询补齐。 */ }
    document.addEventListener('visibilitychange', visibility)
    visibility()
    return () => { alive = false; clearInterval(poll); clearInterval(tick); off?.(); document.removeEventListener('visibilitychange', visibility); refresh.current = () => {} }
  }, [kernel, enabled])
  const pending = requests.filter((r) => !settled.current.has(r.requestId) && !requestRows(r, now).expired).sort((a, b) => a.createdAt - b.createdAt)
  const req = pending[0]
  // 状态条的「待批」要把接入请求算进去：条数挂在 <html data-agent-requests>，块（blocks-default useAgentRequests）读它
  const reqCount = enabled ? pending.length : 0
  useEffect(() => {
    document.documentElement.dataset.agentRequests = String(reqCount)
    window.dispatchEvent(new CustomEvent('gitrader:agent-requests', { detail: { count: reqCount } }))
  }, [reqCount])
  useEffect(() => { setError('') }, [req?.requestId])
  const decide = async (approve) => {
    if (!req || busy || sh.offline || requestRows(req, Date.now()).expired) return
    setBusy(true); setError('')
    try {
      const action = approve ? 'agentkey.request.approve' : 'agentkey.request.reject'
      const result = await kernel.command(action, { requestId: req.requestId }, { tool: `ui:${action}` })
      settled.current.add(req.requestId)
      setRequests((items) => items.filter((r) => r.requestId !== req.requestId))
      if (approve) toast.ok(t('已批准：{0}', result?.name || req.input.name))
      void refresh.current()
    } catch (e) { if (!e?.cancelled) setError(message(e, t('保存失败'))) }
    finally { setBusy(false) }
  }
  // 没有待批准的请求就什么都不画：读失败（例如老内核没有这个接口）也不弹卡挡住页面，下次轮询再试
  if (!enabled || !req) return null
  return <section className="g5-glass g5-agent-request" role="region" aria-label={t('Agent 接入请求')} aria-busy={busy}>
    <style>{`.g5-agent-request{position:fixed;z-index:35;top:144px;right:20px;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 160px);overflow:auto;padding:20px;border-radius:var(--gr-r-ctl);color:var(--gr-text-body)}
      .g5-agent-request h2{font-size:14px;line-height:20px;font-weight:500;margin:0 0 16px;overflow-wrap:anywhere}
      .g5-agent-request dl{display:grid;grid-template-columns:80px minmax(0,1fr);gap:8px 12px;margin:0 0 16px;font-size:13px;line-height:20px}
      .g5-agent-request dt{color:var(--gr-text-3)}.g5-agent-request dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
      .g5-agent-request footer{display:flex;gap:8px;flex-wrap:wrap}.g5-agent-request [role=alert]{color:var(--gr-danger);font-size:12px;line-height:16px;margin:8px 0;overflow-wrap:anywhere}
      @media(max-width:599px){.g5-agent-request{right:16px;top:104px;max-height:calc(100dvh - 120px)}}`}</style>
    {req ? <><h2>{t('Agent 请求接入：')}{req.input.name}</h2>
      <dl>{requestRows(req, now, { accounts: accounts ?? [], unit: 'USDC' }).rows.map(([label, value]) => <><dt key={`${label}-label`}>{label}</dt><dd key={label}>{value}</dd></>)}</dl>
      {pending.length > 1 ? <div className="g5-s12 g5-t3" style={{ marginBottom: 12 }}>{t('还有 {0} 个', pending.length - 1)}</div> : null}
    </> : <h2>{t('接入请求读取失败')}</h2>}
    {error || readError ? <div role="alert">{error || readError}</div> : null}
    <footer>{req ? <>
      <button type="button" className="g5-btn g5-btn-primary" data-act="agent-request-approve" disabled={busy || sh.offline} onClick={() => { void decide(true) }}>{busy ? t('处理中…') : t('批准（输入 PIN）')}</button>
      <button type="button" className="g5-btn g5-btn-ghost" data-act="agent-request-reject" disabled={busy || sh.offline} onClick={() => { void decide(false) }}>{t('拒绝')}</button>
    </> : null}{readError ? <button type="button" className="g5-btn g5-btn-fill" disabled={busy || sh.offline} onClick={() => { void refresh.current() }}>{t('重试')}</button> : null}</footer>
  </section>
}
