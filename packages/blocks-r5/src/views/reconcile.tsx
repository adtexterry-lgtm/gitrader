// SPDX-License-Identifier: CPAL-1.0
import { useCallback, useEffect, useState } from 'preact/hooks'
import { useBridge, useSubscribe } from '@gitrader/blocks-sdk/preact'
import type { ReconcileAccountView, ReconcileReviewItem } from '@gitrader/protocol/types'
import { runCommand } from '../../../blocks-default/src/actions'
import { queryRetry, useOffline } from '../../../blocks-default/src/hooks'
import { isRec } from '../../../blocks-default/src/util'
import { Card, CardHead } from '../kit'
import { Msg, Sk } from './ovkit'
import './reconcile.css'
import { t } from '@gitrader/workbench/i18n'

type AccountLite = { accountId: string; alias: string }
type PageData = { accounts: AccountLite[]; views: ReconcileAccountView[] }
type ActiveItem = { view: ReconcileAccountView; item: ReconcileReviewItem }

function rowsOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  if (isRec(value) && Array.isArray(value[key])) return value[key] as unknown[]
  return []
}

function normalizeAccounts(value: unknown): AccountLite[] {
  return rowsOf(value, 'accounts').filter(isRec).flatMap((row) => {
    if (typeof row.accountId !== 'string') return []
    return [{ accountId: row.accountId, alias: typeof row.alias === 'string' && row.alias ? row.alias : row.accountId }]
  })
}

function activeItems(views: ReconcileAccountView[]): ActiveItem[] {
  return views.flatMap((view) => (view.reviews ?? [])
    .filter((item) => item.blocking && item.resolution === undefined && item.confirmedFillId === undefined)
    .map((item) => ({ view, item })))
}

function reasonOf(item: ReconcileReviewItem): string {
  if (item.kind === 'inferred_fill') return t('发现尚未入账的成交推断，需核对后决定是否接受。')
  if (item.kind === 'confirmation_effects') return t('已确认成交的后续处理需要人工复核。')
  if (item.kind === 'late_real_fill') return t('确认推断后又收到实际成交，需要单独核对。')
  const code = item.finding?.code
  if (code === 'identity_mismatch') return t('本地记录与场所返回的身份信息不一致。')
  if (code === 'position_side_mismatch') return t('本地持仓方向与场所记录不一致。')
  if (code === 'position_difference') return t('本地持仓与场所记录存在差异。')
  if (code === 'local_open_venue_filled') return t('场所显示订单已成交，但本地成交记录不完整。')
  return t('发现需要人工核对的对账差异。')
}

function evidenceOf(item: ReconcileReviewItem): string {
  const evidence = item.finding?.evidence ?? []
  if (evidence.length) return evidence.slice(0, 3).map((entry) => t('{0}：{1}', entry.field, entry.value)).join(' · ')
  if (item.suggestion) return t('标的 {0} · {1} {2} @ {3}', item.suggestion.instrumentId, item.suggestion.side === 'buy' ? t('买入') : t('卖出'), item.suggestion.size, item.suggestion.price)
  if (item.fill) return t('标的 {0} · {1} {2} @ {3}', item.fill.instrumentId, item.fill.side === 'buy' ? t('买入') : t('卖出'), item.fill.size, item.fill.price)
  if (item.confirmation) return t('成交编号 {0} · 确认时间 {1}', item.confirmation.fillId, item.confirmation.confirmedAt)
  return t('证据已留存；刷新核对当前场所记录。')
}

function nextId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `resolve-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function SkeletonRows() {
  return <div className="g5-rbody g5-rec-body" aria-busy="true" aria-label={t('加载中')}>
    {[0, 1].map((i) => <div className="g5-rec-row" key={i}>
      <Sk w="32%" /><Sk w="68%" /><div className="g5-rec-skel"><Sk w="100%" /><Sk w={108} h={32} /></div>
    </div>)}
  </div>
}

export function ReconcileView() {
  const bridge = useBridge()
  const [data, setData] = useState<PageData>({ accounts: [], views: [] })
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const offline = useOffline()

  const reload = useCallback(async () => {
    setPhase('loading')
    setError('')
    try {
      const [accountData, statusData] = await Promise.all([
        queryRetry<unknown>(bridge, 'account.list'), queryRetry<unknown>(bridge, 'reconcile.status'),
      ])
      const accounts = normalizeAccounts(accountData)
      const views = rowsOf(statusData, 'accounts').filter(isRec) as unknown as ReconcileAccountView[]
      setData({ accounts, views })
      setPhase('ready')
    } catch {
      setError(t('对账状态读取失败，请刷新后重试。'))
      setPhase('error')
    }
  }, [bridge])

  useEffect(() => { void reload() }, [reload])
  useSubscribe('reconciliation.updated', () => { void reload() })

  const refresh = async (accountId: string) => {
    const key = `refresh:${accountId}`
    if (busy || offline) return
    setBusy(key)
    setError('')
    try {
      const result = await runCommand(bridge, 'reconcile.refresh', { accountId })
      if (result.ok) await reload()
      else if (!result.cancelled) setError(t('刷新失败，请核对连接状态后重试。'))
    } finally { setBusy(null) }
  }

  const refreshAll = async () => {
    if (busy || offline) return
    setBusy('refresh:all')
    setError('')
    try {
      const latest = normalizeAccounts(await queryRetry<unknown>(bridge, 'account.list'))
      for (const account of latest) {
        const result = await runCommand(bridge, 'reconcile.refresh', { accountId: account.accountId })
        if (!result.ok) {
          if (!result.cancelled) setError(t('刷新失败，请核对连接状态后重试。'))
          return
        }
      }
      await reload()
    } catch {
      setError(t('刷新失败，请核对连接状态后重试。'))
    } finally { setBusy(null) }
  }

  const resolve = async (item: ReconcileReviewItem) => {
    const key = item.itemId
    const reason = (reasons[key] ?? '').trim()
    if (busy || offline || reason.length < 1 || reason.length > 500) return
    setBusy(key)
    setRowErrors((current) => ({ ...current, [key]: '' }))
    try {
      const result = await runCommand(bridge, 'reconcile.resolve', { accountId: item.accountId,
        itemId: item.itemId, evidenceDigest: item.evidenceDigest,
        action: item.kind === 'inferred_fill' ? 'reject' : 'acknowledge', reason, requestId: nextId() })
      if (result.ok) {
        setReasons((current) => ({ ...current, [key]: '' }))
        await reload()
      } else if (!result.cancelled) {
        setRowErrors((current) => ({ ...current, [key]: t('处理失败，请刷新对账后重试。') }))
      }
    } finally { setBusy(null) }
  }

  const accounts = new Map(data.accounts.map((account) => [account.accountId, account.alias]))
  const items = activeItems(data.views)
  const unmatched = data.views.flatMap((view) => {
    const activeForAccount = items.filter((entry) => entry.view.accountId === view.accountId).map((entry) => entry.item)
    const representedFindings = new Set(activeForAccount.map((item) => item.finding?.id).filter((id): id is string => !!id))
    const safetyKinds = new Set(activeForAccount.map((item) => item.kind))
    const hasActiveInference = safetyKinds.has('inferred_fill')
    return view.findings
      .filter((finding) => finding.severity === 'blocker' && !representedFindings.has(finding.id)
        && !(finding.code === 'CONFIRMATION_EFFECTS_PENDING' && safetyKinds.has('confirmation_effects'))
        && !(finding.code === 'LATE_REAL_FILL_REVIEW_REQUIRED' && safetyKinds.has('late_real_fill'))
        && !(finding.code === 'fill_missing_inferred' && hasActiveInference))
      .map((finding) => ({ view, finding }))
  })

  const unavailable = data.views.some((view) => view.state === 'unavailable' || !!view.problem)
  const idle = data.views.some((view) => view.state === 'idle')
  const noCurrentEvidence = unavailable || idle

  const head = <CardHead title={t('对账')} right={<>
    <button type="button" className="g5-btn g5-btn-ghost" onClick={() => { location.hash = '#/workbench' }}>{t('返回风险')}</button>
    <button type="button" className="g5-btn g5-btn-ghost" disabled={!!busy || offline || phase === 'loading'} onClick={() => { void refreshAll() }}>{t('刷新')}</button>
  </>} />

  let body
  if (phase === 'loading') body = <SkeletonRows />
  else if (phase === 'error') body = <div className="g5-rbody g5-rec-body"><Msg error={new Error(error)} onRetry={() => { void reload() }} /></div>
  else if (!items.length && !unmatched.length) body = <div className="g5-rbody g5-rec-empty">
    {noCurrentEvidence ? <><div className="g5o-msg">{t('无待处理对账项 · 状态待刷新')}</div>
      <button type="button" className="g5-btn g5-btn-ghost" disabled={!!busy || offline} onClick={() => { void refreshAll() }}>{t('刷新核对')}</button></>
      : <><div className="g5o-msg">{t('对账待处理项已清零')}</div>
        <button type="button" className="g5-btn g5-btn-ghost" onClick={() => { location.hash = '#/workbench' }}>{t('返回风险')}</button></>}
  </div>
  else body = <div className="g5-rbody g5-rec-body">
    {items.map(({ view, item }) => {
      const key = item.itemId
      const reason = reasons[key] ?? ''
      const allowed = item.kind === 'inferred_fill' ? t('拒绝推断') : t('确认差异')
      return <section className="g5-rec-row" key={key} data-review={item.kind}>
        <div className="g5-rec-title">{accounts.get(view.accountId) ?? t('账户')} · {reasonOf(item)}</div>
        <div className="g5-rec-evidence">{evidenceOf(item)}</div>
        <div className="g5-rec-controls">
          <label className="g5-inp g5-l"><input aria-label={t('处理理由')} maxLength={500} placeholder={t('填写处理理由')} value={reason}
            disabled={!!busy || offline} onInput={(event) => setReasons((current) => ({ ...current, [key]: (event.currentTarget as HTMLInputElement).value }))} /></label>
          <span className="g5-rec-action">{allowed}</span>
          <button type="button" className="g5-btn g5-btn-fill" data-act="reconcile-resolve" disabled={!!busy || offline || !reason.trim() || reason.trim().length > 500}
            onClick={() => { void resolve(item) }}>{busy === key ? t('处理中…') : t('标记已处理')}</button>
          <button type="button" className="g5-btn g5-btn-ghost" disabled={!!busy || offline} onClick={() => { void refresh(view.accountId) }}>{t('刷新核对')}</button>
        </div>
        {rowErrors[key] ? <div className="g5-rec-error" role="alert">{rowErrors[key]}</div> : null}
      </section>
    })}
    {unmatched.map(({ view, finding }) => <section className="g5-rec-row" key={`${view.accountId}:${finding.id}`} data-review="unmatched">
      <div className="g5-rec-title">{accounts.get(view.accountId) ?? t('账户')} · {reasonOf({ kind: 'known_difference', finding } as ReconcileReviewItem)}</div>
      <div className="g5-rec-evidence">{evidenceOf({ kind: 'known_difference', finding } as ReconcileReviewItem)}</div>
      <div className="g5-rec-controls"><span className="g5-rec-readonly">{t('此项尚无可处理记录')}</span>
        <button type="button" className="g5-btn g5-btn-ghost" disabled={!!busy || offline} onClick={() => { void refresh(view.accountId) }}>{t('刷新核对')}</button></div>
    </section>)}
  </div>

  return <Card head={head} className="g5-rec-card" data-g5-page="reconcile" data-view="reconcile" aria-label={t('对账')}>
    {phase === 'ready' && error ? <div className="g5-rec-error" role="alert">{error}</div> : null}{body}
  </Card>
}
