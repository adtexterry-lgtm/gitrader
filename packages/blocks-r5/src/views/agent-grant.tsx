// SPDX-License-Identifier: CPAL-1.0
import { useEffect, useRef, useState } from 'preact/hooks'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import type { AgentPermissionTier } from '@gitrader/protocol/types'
import { DialogShell, toast } from '@gitrader/workbench/ui'
import { runCommand } from '../../../blocks-default/src/actions'
import { Q } from '../../../blocks-default/src/api'
import { useOffline } from '../../../blocks-default/src/hooks'
import { TERM_HELP } from '../../../blocks-default/src/display'
import { Term } from '../../../blocks-default/src/term'
// 表单控件的 label 里的 Term 不可聚焦（focusable={false}）：悬停仍显示说明，键盘 Tab 路径不多出停点；说明另挂在单选框 title 上
import { LEVEL_OF_TIER } from '../../../blocks-default/src/labels'
import type { KeyTier } from '../../../blocks-default/src/model-activity'
import { normalizeAccounts, type AccountLite } from '../../../blocks-default/src/model-positions'
import { normalizeRisk } from '../../../blocks-default/src/model-risk'
import { listOf } from '../../../blocks-default/src/util'
import { t, tk } from '@gitrader/workbench/i18n'
import { getLauncher, launcherIsWindows } from '@gitrader/workbench/launcher'

const TIERS: Array<[AgentPermissionTier, string, string]> = [['read_only', t('只读'), t('AI 能看、能做研究，不能交易')], ['paper', t('纸面直通'), t('AI 的纸面单直接成交')], ['confirm', t('需确认'), t('每笔开仓等你批')], ['auto_limited', t('限额自动'), t('限额内自动成交')]]
const HOSTS = ['claude-code', 'codex', 'hermes', 'unigit', 'other']
const DAY = 86400000
const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const positive = (value: unknown): value is string => typeof value === 'string' && decimal.test(value) && /[1-9]/.test(value)
// 额度不经二进制浮点转换；默认值与全局上限按十进制字符串比较。
function capped(cap: string, global: unknown): string {
  if (typeof global !== 'string' || !decimal.test(global)) return cap
  const [a = '', af = ''] = global.split('.'), [b = '', bf = ''] = cap.split('.')
  const smaller = a.length !== b.length ? a.length < b.length : a !== b ? a < b : af.padEnd(Math.max(af.length, bf.length), '0') < bf.padEnd(Math.max(af.length, bf.length), '0')
  return smaller ? global : cap
}
const instrument = (value: string) => value.trim().includes(':') ? value.trim() : `hyperliquid:${value.trim().toUpperCase()}`
const errorText = (message: string) => /[一-龥]/.test(message) ? tk(message) : t('保存失败：{0}', message)

/**
 * 令牌文件落盘后给人复制的一句配置提示（UX-08）。宿主「其它」在 CLI 里叫 generic（mcp snippet other 会报错）；
 * 启动器是 Windows 批处理（便携包的 gitrader.cmd）时路径用双引号（单引号 cmd 不认，会悄悄生成错路径）；默认（全局 gitrader）保持单引号，PowerShell / bash 通用，既有断言也钉着它。
 */
// 规格变更（总控批准）：win32 上一律双引号（cmd 与 PowerShell 都认），POSIX 保持单引号。win32 = 浏览器所在系统（与命令要粘进的终端同机）。
const isWin32 = (): boolean => typeof navigator !== 'undefined' && /^win/i.test(String(navigator.platform || navigator.userAgent))
export function tokenInstruction(host: string, path: string, win = launcherIsWindows() || isWin32()): string {
  const quoted = win ? `"${path.replace(/"/g, '')}"` : `'${path.replace(/'/g, /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? "''" : "'\\''")}'`
  return t('请运行 {0} mcp snippet {1} --token-file {2} 并按输出配置', getLauncher(), host === 'other' ? 'generic' : host, quoted)
}

export function grantGaps(key: KeyTier, tier: AgentPermissionTier): string[] {
  const m = key.mandate
  if (!m) return ['accounts', 'instruments', 'maxOrderNotional', 'maxDailyNotional']
  if (tier !== 'confirm' && tier !== 'auto_limited') return []
  return [!m.accounts.length && 'accounts', (!m.venueAllowlist?.length || !m.instrumentAllowlist?.length) && 'instruments', !positive(m.limits.maxOrderNotional) && 'maxOrderNotional', !positive(m.limits.maxDailyNotional) && 'maxDailyNotional', tier === 'auto_limited' && !positive(m.limits.maxDailyLoss) && 'maxDailyLoss', tier === 'auto_limited' && !positive(m.limits.autoMaxOrderNotional) && 'autoMaxOrderNotional'].filter(Boolean) as string[]
}

export function AgentGrant({ agent, targetTier, missing = [], onClose, onSaved }: { agent?: KeyTier; targetTier?: AgentPermissionTier; missing?: string[]; onClose(): void; onSaved(): void }) {
  const bridge = useBridge()
  const offline = useOffline()
  const m = agent?.mandate
  const [name, setName] = useState(agent?.name ?? '')
  const [host, setHost] = useState(agent?.host ?? 'claude-code')
  const [tier, setTier] = useState<AgentPermissionTier>(targetTier ?? agent?.tier ?? 'confirm')
  const [accounts, setAccounts] = useState<AccountLite[]>([])
  const [selected, setSelected] = useState<string[]>(m?.accounts ?? [])
  const [instruments, setInstruments] = useState<string[]>(m?.instrumentAllowlist?.map(instrument) ?? [])
  const [draft, setDraft] = useState('')
  const [order, setOrder] = useState(m?.limits.maxOrderNotional ?? '')
  const [daily, setDaily] = useState(m?.limits.maxDailyNotional ?? '')
  const [dailyLoss, setDailyLoss] = useState(m?.limits.maxDailyLoss ?? '')
  const [autoOrder, setAutoOrder] = useState(m?.limits.autoMaxOrderNotional ?? '')
  const [days, setDays] = useState(String(m?.notAfter ? Math.max(1, Math.ceil((m.notAfter - Date.now()) / DAY)) : 30))
  const [expiryChanged, setExpiryChanged] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [path, setPath] = useState('')
  const [copied, setCopied] = useState(false)
  const [gaps, setGaps] = useState(missing)
  const first = useRef<HTMLInputElement>(null)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  useEffect(() => {
    let alive = true
    setLoading(true); setLoadError('')
    void (async () => {
      try {
        const [rawAccounts, risk] = await Promise.all([bridge.query(Q.accounts), bridge.query(Q.riskState)])
        const accts = normalizeAccounts(rawAccounts)
        const positions = await Promise.all(accts.map((a) => bridge.query(Q.positions, { accountId: a.accountId })))
        if (!alive) return
        const limits = normalizeRisk(risk).limits
        setAccounts(accts)
        setSelected((old) => old.length ? old : accts.filter((a) => a.mode === 'paper').slice(0, 1).map((a) => a.accountId))
        setInstruments((old) => old.length ? old : [...new Set([...positions.flatMap((p) => listOf(p, 'positions').map((x: any) => x?.instrumentId).filter((x): x is string => typeof x === 'string' && x.length > 0)).map(instrument), 'hyperliquid:BTC', 'hyperliquid:ETH'])])
        setOrder((old) => old || capped('200', limits.maxOrderNotional))
        setDaily((old) => old || capped('1000', limits.maxDailyNotional))
      } catch (e) { if (alive) setLoadError(errorText(String((e as Error)?.message || e))) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [bridge, reload])
  const clearGap = (key: string) => setGaps((old) => old.filter((x) => x !== key))
  const add = () => {
    const id = instrument(draft)
    if (!draft.trim() || !/^[^\s:]+:[^\s:]+$/.test(id)) { setError(t('请输入有效标的')); return }
    setInstruments((old) => [...new Set([...old, id])]); setDraft(''); clearGap('instruments'); setError('')
  }
  const save = async (event: Event) => {
    event.preventDefault()
    if (busy || loading || loadError || offline) return
    const invalid = [(!name.trim() || name.trim().length > 60) && 'name', !selected.length && 'accounts', !instruments.length && 'instruments', !positive(order) && 'maxOrderNotional', !positive(daily) && 'maxDailyNotional', tier === 'auto_limited' && !positive(dailyLoss) && 'maxDailyLoss', tier === 'auto_limited' && !positive(autoOrder) && 'autoMaxOrderNotional', (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > (tier === 'auto_limited' ? 90 : 365)) && 'days'].filter(Boolean) as string[]
    if (invalid.length) { setGaps(invalid); setError(t('请补齐高亮字段，限额需大于零')); return }
    if (agent && !m) { setError(t('找不到现有授权书，请重新接入 Agent')); return }
    setBusy(true); setError('')
    const venues = [...new Set(instruments.map((id) => id.split(':')[0]!))]
    const scope = { accounts: selected, venueAllowlist: m?.venueAllowlist?.length ? [...new Set([...m.venueAllowlist, ...venues])] : venues, instrumentAllowlist: instruments, limits: { ...m?.limits, maxOrderNotional: order, maxDailyNotional: daily, ...(tier === 'auto_limited' ? { maxDailyLoss: dailyLoss, autoMaxOrderNotional: autoOrder } : {}) } }
    const result = m
      ? await runCommand(bridge, 'mandate.update', { mandateId: m.mandateId, input: { ...scope, subject: m.subject, level: LEVEL_OF_TIER[tier], notAfter: expiryChanged ? Date.now() + Number(days) * DAY : m.notAfter, heartbeat: m.heartbeat, approval: m.approval, denyLlmLiveEntries: m.denyLlmLiveEntries } })
      : await runCommand<{ tokenFilePath?: string }>(bridge, 'agentkey.create', { input: { name: name.trim(), host, tier, mandate: scope, expiresInDays: Number(days) }, tokenFile: true })
    if (!live.current) return
    setBusy(false)
    if (!result.ok) { if (!result.cancelled) setError(errorText(result.message)); return }
    onSaved()
    if (m) { toast.ok(t('授权已更新')); onClose(); return }
    const savedPath = (result.value as { tokenFilePath?: string })?.tokenFilePath
    if (typeof savedPath !== 'string' || !savedPath) { setError(t('钥匙已创建，但未返回令牌文件路径；请到钥匙列表核对，勿重复创建')); setPath('missing'); return }
    setPath(savedPath)
  }
  const instruction = path && path !== 'missing' ? tokenInstruction(host, path) : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(instruction); setCopied(true) }
    catch { setError(t('复制失败：请手动选中配置提示')) }
  }
  const input = (label: string, id: string, value: string, change: (v: string) => void, extra: Record<string, unknown> = {}) => <label className="g5-grant-field" data-missing={gaps.includes(id) || undefined}><span>{label}</span><span className="g5-inp g5-l"><input aria-label={label} value={value} onInput={(e) => { change(e.currentTarget.value); clearGap(id) }} {...extra} /></span></label>
  return <DialogShell open={!busy} onOpenChange={(open: boolean) => { if (!open) onClose() }} title={agent ? t('编辑授权') : t('接入 Agent')} level="drawer" placement="center" width="min(560px, calc(100vw - 32px))" className="g5-grant" onOpenAutoFocus={(e: Event) => { e.preventDefault(); first.current?.focus() }}>
    <style>{`.g5-grant{max-height:calc(100dvh - 32px);overflow:auto;padding:24px;color:var(--gr-text-body)}.g5-grant form{display:flex;flex-direction:column;gap:16px;margin-top:16px}.g5-grant .g5-grant-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;line-height:16px;color:var(--gr-text-2)}
      .g5-grant .g5-grant-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.g5-grant select{width:100%;min-height:32px;padding:0 12px;border-radius:var(--gr-r-ctl);background:var(--gr-fill-1);color:var(--gr-text);box-shadow:inset 0 0 0 1px var(--gr-line)}.g5-grant select option{background:var(--gr-bg);color:var(--gr-text)}
      .g5-grant fieldset{border:0;padding:0;margin:0;min-width:0}.g5-grant legend{font-size:12px;line-height:16px;color:var(--gr-text-2);margin-bottom:8px}.g5-grant .g5-grant-tier{display:flex;align-items:center;gap:12px;min-height:36px;padding:4px 8px;border-radius:var(--gr-r-ctl);font-size:13px;line-height:20px;cursor:pointer}.g5-grant .g5-grant-tier:hover{background:var(--gr-fill-2)}.g5-grant .g5-grant-tier:has(input:checked){background:var(--gr-fill-2)}.g5-grant input[type=radio]{appearance:auto;accent-color:var(--gr-accent);width:16px;height:16px}.g5-grant input:read-only,.g5-grant select:disabled{color:var(--gr-text-dis)}
      .g5-grant [data-missing=true]{outline:1px solid var(--gr-warn);outline-offset:4px;border-radius:var(--gr-r-ctl)}.g5-grant .g5-grant-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}.g5-grant .g5-grant-chip{max-width:100%;height:auto;min-height:28px;overflow-wrap:anywhere;white-space:normal}.g5-grant .g5-grant-add{display:flex;gap:8px}.g5-grant .g5-grant-add .g5-inp{flex:1}.g5-grant footer{display:flex;justify-content:flex-end;gap:8px}.g5-grant [role=alert]{font-size:12px;line-height:16px;color:var(--gr-danger);overflow-wrap:anywhere}.g5-grant .g5-grant-path{overflow-wrap:anywhere;user-select:text;margin:16px 0;white-space:pre-wrap}.g5-grant .g5-grant-copy{font-size:13px;line-height:20px;user-select:text;overflow-wrap:anywhere;margin:16px 0}.g5-grant :focus-visible{outline:2px solid var(--gr-focus);outline-offset:2px}
      @media(max-width:599px){.g5-grant{padding:20px}.g5-grant .g5-grant-grid{grid-template-columns:1fr}.g5-grant .g5-grant-tier{align-items:flex-start}}`}</style>
    {path ? <>
      {path !== 'missing' ? <><div className="g5-grant-path" role="status">{t('令牌已存到 ')}<code>{path}</code></div><div className="g5-grant-copy">{instruction}</div></> : null}
      {error ? <div role="alert">{error}</div> : null}
      <footer>{instruction ? <button type="button" className="g5-btn g5-btn-fill" onClick={() => { void copy() }}>{copied ? t('已复制') : t('复制配置提示')}</button> : null}<button type="button" className="g5-btn g5-btn-primary" onClick={onClose}>{t('完成')}</button></footer>
    </> : <form onSubmit={(e) => { void save(e) }}>
      <div className="g5-grant-grid">
        {input(t('名字'), 'name', name, setName, { ref: first, readOnly: !!agent, maxLength: 60 })}
        <label className="g5-grant-field"><span>{t('宿主')}</span><select aria-label={t('宿主')} value={host} disabled={!!agent} onChange={(e) => setHost(e.currentTarget.value)}>{HOSTS.map((h) => <option key={h} value={h}>{h === 'other' ? t('其它') : h}</option>)}</select></label>
      </div>
      <fieldset><legend>{t('权限档位')}</legend>{TIERS.map(([value, label, text]) => <label key={value} className="g5-grant-tier"><input type="radio" name="agent-grant-tier" value={value} title={TERM_HELP[LEVEL_OF_TIER[value]]} checked={tier === value} onChange={() => setTier(value)} /><span><Term name={LEVEL_OF_TIER[value]} focusable={false}>{label}</Term> · {text}</span></label>)}</fieldset>
      <label className="g5-grant-field" data-missing={gaps.includes('accounts') || undefined}><span>{t('账户')}</span><select aria-label={t('账户')} multiple={!!m && m.accounts.length > 1} value={m && m.accounts.length > 1 ? undefined : selected[0] ?? ''} disabled={loading} onChange={(e) => { setSelected(Array.from(e.currentTarget.selectedOptions, (o) => o.value).filter(Boolean)); clearGap('accounts') }}>
        <option value="" disabled>{t('请选择账户')}</option>{accounts.map((a) => <option key={a.accountId} value={a.accountId} selected={selected.includes(a.accountId)}>{a.alias}{a.mode === 'paper' ? t(' · 纸面账户') : ''}</option>)}{selected.filter((id) => !accounts.some((a) => a.accountId === id)).map((id) => <option key={id} value={id} selected>{id}</option>)}
      </select></label>
      <fieldset data-missing={gaps.includes('instruments') || undefined}><legend>{t('允许的标的')}</legend><div className="g5-grant-chips">{instruments.map((id) => <button key={id} type="button" className="g5-btn g5-btn-fill g5-grant-chip" aria-label={t('移除 {0}', id)} onClick={() => setInstruments((old) => old.filter((x) => x !== id))}>{id} ×</button>)}</div>
        <div className="g5-grant-add"><span className="g5-inp g5-l"><input aria-label={t('添加标的')} placeholder={t('BTC 或 hyperliquid:BTC')} value={draft} onInput={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} /></span><button type="button" className="g5-btn g5-btn-fill" disabled={!draft.trim()} onClick={add}>{t('添加')}</button></div>
      </fieldset>
      <div className="g5-grant-grid">{input(t('单笔上限'), 'maxOrderNotional', order, setOrder, { inputMode: 'decimal' })}{input(t('每日上限'), 'maxDailyNotional', daily, setDaily, { inputMode: 'decimal' })}</div>
      {tier === 'auto_limited' ? <div className="g5-grant-grid">{input(t('日亏上限'), 'maxDailyLoss', dailyLoss, setDailyLoss, { inputMode: 'decimal' })}{input(t('自动单笔上限'), 'autoMaxOrderNotional', autoOrder, setAutoOrder, { inputMode: 'decimal' })}</div> : null}
      {input(t('有效期（天）'), 'days', days, (value) => { setDays(value); setExpiryChanged(true) }, { inputMode: 'numeric' })}
      {loading ? <div role="status" className="g5-t3 g5-s12">{t('正在读取授权默认值…')}</div> : null}
      {loadError ? <div role="alert">{loadError} <button type="button" className="g5-btn g5-btn-ghost" onClick={() => setReload((n) => n + 1)}>{t('重试')}</button></div> : null}
      {error ? <div role="alert">{error}</div> : null}
      <footer><button type="button" className="g5-btn g5-btn-ghost" onClick={onClose}>{t('取消')}</button><button type="submit" className="g5-btn g5-btn-primary" disabled={loading || !!loadError || offline}>{agent ? t('保存授权') : t('创建钥匙')}</button></footer>
    </form>}
  </DialogShell>
}
