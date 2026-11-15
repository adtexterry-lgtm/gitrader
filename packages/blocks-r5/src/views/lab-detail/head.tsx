// SPDX-License-Identifier: CPAL-1.0
// 通栏头（56，全页唯一例外）：返回 · 编号 · 名称 · 阶段阶梯 · Agent 晋级申请 · 导出证据包 · 晋级。
// 晋级：弹出卡列证据事实 → 取消 / 晋级 → 后果一行 + 确认（600 ms 内的点击不算）→ 内核要 PIN 时壳弹 PIN 层 → 回执；
// 内核拒绝的原文留在弹出卡里，目标阶段不含实盘（live）。
import { toast, PopoverPanel } from '@gitrader/workbench/ui'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { runCommand } from '../../../../blocks-default/src/actions'
import { queryRetry } from '../../../../blocks-default/src/hooks'
import { Actor, Unwired, wireState } from '../../kit'
import { denyText, evidenceRows, exportFileName, ladderOf, promotionConsequence, promotionTarget, stageLabel, stamp, type LabDetail } from '../../model-lab'
import { useDetail, useRequest } from './data'
import { Frame, Ic, PausedTag, Skeleton } from './parts'
import { t } from '@gitrader/workbench/i18n'

/** 浏览器里把一段 JSON 存成文件。 */
function saveJson(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// ---- 晋级弹出卡 ---------------------------------------------------------------------------------

type Step = { name: 'review' } | { name: 'armed' } | { name: 'busy' } | { name: 'denied'; text: string }

function PromoteCard({ detail, to, onClose, onDone, onBusy }: { detail: LabDetail; to: string; onClose(): void; onDone(): void; onBusy(busy: boolean): void }) {
  const bridge = useBridge()
  const [step, setStep] = useState<Step>({ name: 'review' })
  const born = useRef(0)
  const cancel = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { if (step.name === 'armed') { born.current = performance.now(); cancel.current?.focus() } }, [step.name])
  const confirm = async () => {
    if (performance.now() - born.current < 600) return
    setStep({ name: 'busy' })
    onBusy(true)
    const r = await runCommand(bridge, 'lab.stage', { experimentId: detail.experimentId, to })
    onBusy(false)
    if (r.ok) { onDone(); return }
    // 在 PIN 层点了取消 = 命令没发生，回到确认条；其余错误把内核原文留在这张卡里
    setStep(r.cancelled ? { name: 'armed' } : { name: 'denied', text: denyText(r.message, r.problem) })
  }
  return <div className="lab-pop" role="dialog" aria-label={t('晋级')}>
    <header className="g5-hd"><h2 className="g5-al">{t('晋级到 ')}{stageLabel(to)}</h2></header>
    <div className="lab-pb">
      <dl className="lab-dl">{evidenceRows(detail).map((r) => <div key={r.key}><dt className="g5-al">{r.key}</dt><dd data-n="ev">{r.value}</dd></div>)}</dl>
      {step.name === 'review' ? <div className="g5-pacts">
        <button type="button" className="g5-btn g5-btn-ghost" data-act="promote-cancel" onClick={onClose}>{t('取消')}</button>
        <button type="button" className="g5-btn g5-btn-primary" data-act="promote-go" onClick={() => setStep({ name: 'armed' })}><Ic n="lock" s={12} />{t('晋级')}</button>
      </div> : null}
      {step.name === 'armed' || step.name === 'busy' ? <div className="g5-armed" role="group" aria-label={promotionConsequence(detail, to)}>
        <span className="g5-what g5-al">{promotionConsequence(detail, to)}</span>
        {step.name === 'busy' ? null : <button ref={cancel} type="button" className="g5-btn g5-btn-ghost" data-act="promote-back" onClick={() => setStep({ name: 'review' })}>{t('取消')}</button>}
        <button type="button" className="g5-btn g5-btn-kill" data-act="promote-confirm" disabled={step.name === 'busy'} onClick={() => { void confirm() }}>{step.name === 'busy' ? t('晋级中…') : t('确认晋级')}</button>
      </div> : null}
      {step.name === 'denied' ? <>
        <div className="lab-deny" role="alert"><Ic n="block" s={12} /><span>{step.text}</span></div>
        <div className="g5-pacts"><button type="button" className="g5-btn g5-btn-ghost" data-act="promote-close" onClick={onClose}>{t('关闭')}</button></div>
      </> : null}
    </div>
  </div>
}

// ---- 头 -----------------------------------------------------------------------------------------

const Back = () => <a className="g5-btn g5-btn-ghost lab-back" href="#/lab"><Ic n="chev" rotate={90} />{t('实验')}</a>

function HeadReady({ detail, offline, reload }: { detail: LabDetail; offline: boolean; reload(): void }) {
  const bridge = useBridge()
  const request = useRequest(detail)
  const [open, setOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const to = promotionTarget(detail.stage)
  const busyRef = useRef(false)
  const doExport = async () => {
    setExporting(true)
    try {
      saveJson(exportFileName(detail.experimentId), await queryRetry(bridge, 'lab.export', { experimentId: detail.experimentId }))
      toast.ok(t('已导出证据包'))
    } catch (e) { toast.err(e instanceof Error ? e.message : String(e)) } finally { setExporting(false) }
  }
  const close = useCallback(() => setOpen(false), [])
  const promote = <button type="button" className="g5-btn g5-btn-fill" data-act="promote" aria-expanded={open} disabled={offline || to === null} onClick={() => setOpen(true)}><Ic n="lock" s={12} />{t('晋级')}</button>
  return <Frame view="head" className="lab-idc" offline={offline} head={<header className="g5-hd"><div className="lab-hrow">
    <Back />
    <span className="lab-eid">{detail.experimentId}</span><h1 className="lab-ttl">{detail.title}</h1>
    <span className="lab-ladder" aria-label={t('阶段')}>{ladderOf(detail.stage).map((s, i) => <span className="lab-step" key={s.id}>
      {i ? <i aria-hidden="true" /> : null}<span className={s.current ? 'g5-t1 lab-cur' : 'g5-t3'} aria-current={s.current ? 'step' : undefined}>{s.label}</span></span>)}</span>
    {request ? <span className="lab-req" data-req="">
      <Actor kind={request.actor.kind} name={request.actor.name} />
      {request.to && to === request.to
        ? <button type="button" className="lab-lk lab-reqlink" data-act="open-promote" disabled={offline} onClick={() => setOpen(true)}>{t('申请晋级 ')}{stageLabel(request.to)}</button>
        : <span className="lab-reqlink">{t('申请晋级 ')}{request.to ? stageLabel(request.to) : ''}</span>}
      <span className="g5-s12 g5-t3">{stamp(request.at).slice(6)}</span>
    </span> : null}
    <div className="g5-r">
      {offline ? <PausedTag /> : null}
      <button type="button" className="g5-btn g5-btn-ghost" data-act="export" disabled={offline || exporting} onClick={() => { void doExport() }}><Ic n="down" />{t('导出证据包')}</button>
      {to === null ? promote : <PopoverPanel open={open} onOpenChange={(o: boolean) => { if (!o && busyRef.current) return; setOpen(o) }} side="bottom" align="end" sideOffset={6} className="g5-glass lab-apop" label={t('晋级')} trigger={promote}>
        {open ? <PromoteCard detail={detail} to={to} onClose={close} onDone={() => { close(); reload() }} onBusy={(b) => { busyRef.current = b }} /> : null}
      </PopoverPanel>}
    </div>
  </div></header>} />
}

export function HeadView({ experimentId }: { experimentId: string | null }) {
  const { load, reload, offline } = useDetail(experimentId)
  if (!experimentId) return <Frame view="head" className="lab-idc" head={<header className="g5-hd"><div className="lab-hrow"><Back /><span className="g5-al lab-hmsg">{t('没有选中的实验')}</span></div></header>} />
  if (load.phase === 'loading') return <Frame view="head" className="lab-idc" busy head={<header className="g5-hd"><div className="lab-hrow"><Back /><Skeleton widths={[60, 140]} /></div></header>} />
  if (load.phase === 'error') {
    const off = wireState(load.error) === 'off'
    return <Frame view="head" className="lab-idc" head={<header className="g5-hd"><div className="lab-hrow"><Back />
      {off ? <Unwired message={load.error.message} /> : <><span className="g5-al">{t('读取失败')}</span><span className="g5-msg lab-hmsg">{load.error.message}</span><button type="button" className="g5-btn g5-btn-fill" data-act="retry" onClick={reload}>{t('重试')}</button></>}
    </div></header>} />
  }
  return <HeadReady detail={load.value} offline={offline} reload={reload} />
}
