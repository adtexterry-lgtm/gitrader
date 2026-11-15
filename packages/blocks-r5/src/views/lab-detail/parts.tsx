// SPDX-License-Identifier: CPAL-1.0
// 实验详情各视图共用的小件：外框、状态行、图标、离线小标、定义表行。
import '../lab-detail.css'
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import { useNow } from '../../../../blocks-default/src/hooks'
import { Card, Unwired, wireState } from '../../kit'
import type { DefRow } from '../../model-lab'
import { t } from '@gitrader/workbench/i18n'

type IconName = 'chev' | 'down' | 'lock' | 'warn' | 'block' | 'copy'
const BODY: Record<IconName, ComponentChildren> = {
  chev: <path d="M7 10l5 5 5-5" />,
  down: <><path d="M12 5v14" /><path d="M6.5 13.5L12 19l5.5-5.5" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  warn: <><path d="M12 4.5l8.5 15h-17L12 4.5z" /><path d="M12 10.5v4" /><path d="M12 17.25v.01" /></>,
  block: <><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
}
export function Ic({ n, s = 14, rotate }: { n: IconName; s?: 12 | 14; rotate?: number }) {
  return <svg className={s === 12 ? 'g5-i g5-i12' : 'g5-i'} viewBox="0 0 24 24" aria-hidden="true" style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}>{BODY[n]}</svg>
}

const mmss = (ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
/** 离线卡头小标：从离线那一刻起计时（挂载即离线开始）。 */
export function PausedTag() {
  const since = useRef(Date.now())
  const now = useNow(1000)
  return <span className="g5-s12 g5-t3" data-stale="paused">{t('已暂停更新 · ')}{mmss(now - since.current)}</span>
}

export const Msg = ({ children }: { children: ComponentChildren }) => <div className="lab-msg">{children}</div>

/** 读取失败：内核原文原样显示；未接通（-32601 / 回包缺字段）灰字 + 原文、不给重试。 */
export function ErrorMsg({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return <Msg>{wireState(error) === 'off'
    ? <Unwired message={error.message} />
    : <><span className="g5-al">{t('读取失败')}</span><span className="g5-msg">{error.message}</span>{onRetry ? <button type="button" className="g5-btn g5-btn-fill" data-act="retry" onClick={onRetry}>{t('重试')}</button> : null}</>}</Msg>
}

export interface FrameProps {
  view: 'head' | 'tier' | 'assumptions' | 'bias' | 'data'
  head: ComponentChildren
  className?: string
  grow?: boolean
  busy?: boolean
  offline?: boolean
  tier?: string
  children?: ComponentChildren
}
/** 一张卡：每个视图都是一块独立的卡，根节点带 data-page / data-g5-page（几何探针与注册表测试靠它）。 */
export function Frame({ view, head, className = '', grow, busy, offline, tier, children }: FrameProps) {
  const extra: Record<string, unknown> = { 'data-page': 'lab-detail', 'data-g5-page': 'lab-detail', 'data-view': view }
  if (tier) extra['data-tier'] = tier
  if (busy) extra['aria-busy'] = 'true'
  if (offline) extra['data-state'] = 'offline'
  return <Card className={[grow ? 'g5-grow' : '', offline ? 'g5-off' : '', className].filter(Boolean).join(' ')} head={head} {...extra}>{children}</Card>
}

export const Head = ({ title, count, children }: { title: ComponentChildren; count?: number; children?: ComponentChildren }) =>
  <header className="g5-hd"><h2 className="g5-al">{title}</h2>{count !== undefined ? <span className="g5-ct">{count}</span> : null}{children}</header>

/** 两列定义表的一行；data-n 按列分组，右缘共线由探针检查。 */
export function Def({ row, col, group }: { row: DefRow; col: number; group: string }) {
  const tone = row.tone === 'warn' ? 'lab-warn' : row.tone === 'bad' ? 'lab-bad' : row.tone === 'muted' ? 'lab-muted' : ''
  const value = row.href ? <a className="lab-lk" href={row.href}>{row.value}</a> : row.value
  return <div>
    <span className={col === 0 ? "g5-k g5-al" : "g5-k"}>{row.key}</span>
    {row.copy
      ? <span className="g5-v"><span>{row.value}</span><CopyButton text={row.copy} label={t('复制{0}', row.key)} /></span>
      : <span className={['g5-v', tone].filter(Boolean).join(' ')} data-n={`${group}${col}`}>{row.tone === 'warn' ? <Ic n="warn" s={12} /> : row.tone === 'bad' ? <Ic n="block" s={12} /> : null}{value}</span>}
  </div>
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return <button type="button" className="g5-btn g5-btn-ghost g5-btn-icon lab-cp" aria-label={label} data-act="copy" onClick={() => { void navigator.clipboard?.writeText(text).catch(() => undefined) }}><Ic n="copy" /></button>
}

export function Skeleton({ widths }: { widths: readonly number[] }) {
  return <>{widths.map((w, i) => <span className="g5-sk" style={{ width: `${w}px` }} key={i} />)}</>
}
