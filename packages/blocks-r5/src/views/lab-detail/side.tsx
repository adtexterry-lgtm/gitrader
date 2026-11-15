// SPDX-License-Identifier: CPAL-1.0
// 右列三卡：假设（回测假设七项）· 偏差检查（前视 / 递归 / 试验次数 / 训练截止）· 数据与来历（含注记）。
import type { ComponentChildren } from 'preact'
import { Actor } from '../../kit'
import { assumptionRows, biasRows, dataRows, notesOf, originRows, stamp, type DefRow, type LabDetail } from '../../model-lab'
import { useDetail, useRequest } from './data'
import { Def, ErrorMsg, Frame, Head, Msg, PausedTag, Skeleton } from './parts'
import { t } from '@gitrader/workbench/i18n'

type ViewId = 'assumptions' | 'bias' | 'data'

const Defs = ({ rows, group }: { rows: DefRow[]; group: string }) =>
  <div className={['g5-defs', rows.length > 1 && group !== 'd' ? 'g5-two' : ''].filter(Boolean).join(' ')}>{rows.map((r, i) => <Def row={r} col={group === 'd' ? 0 : i % 2} group={group} key={`${r.key}:${i}`} />)}</div>

/** 数据与来历：行数随实验而变，可见区固定 5 整行（卡在固定槽位里，不撑高），其余在区内滚动。 */
const ScrollDefs = ({ rows }: { rows: DefRow[] }) =>
  <div className="g5-defs lab-dscw"><div className="lab-dsc g5-scroll" data-rows={rows.length}>{rows.map((r, i) => <Def row={r} col={0} group="d" key={`${r.key}:${i}`} />)}</div></div>

function SkeletonDefs({ rows, two }: { rows: number; two: boolean }) {
  return <div className={['g5-defs', two ? 'g5-two' : ''].filter(Boolean).join(' ')} aria-hidden="true">
    {Array.from({ length: rows }, (_, i) => <div key={i}><Skeleton widths={[48]} /><Skeleton widths={[64]} /></div>)}
  </div>
}

/** 三张右列卡共用的外壳：解析实验号 → 取 lab.get → 加载 / 错误 / 离线 / 正文。 */
function SideCard({ view, title, experimentId, skeleton, grow, children }: {
  view: ViewId; title: string; experimentId: string | null; skeleton: { rows: number; two: boolean }; grow?: boolean
  children: (detail: LabDetail, offline: boolean) => { count?: number; body: ComponentChildren }
}) {
  const { load, reload, offline } = useDetail(experimentId)
  if (!experimentId) return <Frame view={view} grow={grow} head={<Head title={title} />}><Msg><span className="g5-al">{t('没有选中的实验')}</span></Msg></Frame>
  if (load.phase === 'loading') return <Frame view={view} grow={grow} busy head={<Head title={title} />}><SkeletonDefs {...skeleton} /></Frame>
  if (load.phase === 'error') return <Frame view={view} grow={grow} head={<Head title={title} />}><ErrorMsg error={load.error} onRetry={reload} /></Frame>
  const { count, body } = children(load.value, offline)
  return <Frame view={view} grow={grow} offline={offline} head={<Head title={title} count={count}>{offline ? <div className="g5-r"><PausedTag /></div> : null}</Head>}>{body}</Frame>
}

export const AssumptionsView = ({ experimentId }: { experimentId: string | null }) =>
  <SideCard view="assumptions" title={t('回测假设')} experimentId={experimentId} skeleton={{ rows: 4, two: true }}>
    {(detail) => {
      const rows = assumptionRows(detail.assumptions)
      return rows ? { count: rows.length, body: <Defs rows={rows} group="a" /> } : { body: <Msg><span className="g5-al">{t('没有记录回测假设')}</span></Msg> }
    }}
  </SideCard>

export const BiasView = ({ experimentId }: { experimentId: string | null }) =>
  <SideCard view="bias" title={t('偏差检查')} experimentId={experimentId} skeleton={{ rows: 2, two: true }}>
    {(detail) => ({ body: <Defs rows={biasRows(detail)} group="b" /> })}
  </SideCard>

function DataBody({ detail }: { detail: LabDetail }) {
  const request = useRequest(detail)
  const notes = notesOf(detail, request)
  return <>
    <ScrollDefs rows={[...originRows(detail), ...dataRows(detail)]} />
    <div className="lab-xh"><span className="g5-al">{t('注记')}</span><span>{notes.length}</span></div>
    <div className="g5-alist lab-notes g5-scroll">{notes.map((n, i) => <div className="g5-ar" key={`${n.at}:${i}`}>
      <span className="g5-tm g5-al">{stamp(n.at)}</span>
      <span className={n.actor.kind === 'human' ? 'lab-me' : undefined}><Actor kind={n.actor.kind} name={n.actor.name} /></span>
      <span className="g5-tx"><span className="g5-l1">{n.text}</span></span>
    </div>)}</div>
  </>
}

export const DataView = ({ experimentId }: { experimentId: string | null }) =>
  <SideCard view="data" title={t('数据与来历')} experimentId={experimentId} skeleton={{ rows: 5, two: false }} grow>
    {(detail) => ({ body: <DataBody detail={detail} /> })}
  </SideCard>
