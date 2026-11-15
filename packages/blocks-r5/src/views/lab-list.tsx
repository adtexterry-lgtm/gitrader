// SPDX-License-Identifier: CPAL-1.0
// 实验列表：lab.list 一次取全（游标翻完），阶段页签与创建方筛选在本地做，页签计数和点进去看到的行数一致。
// 列表不放任何收益数；结果数只在实验详情里看。
import './lab.css'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import { ACTOR_FILTERS, Menu } from '@gitrader/workbench/ui'
import { Q } from '../../../blocks-default/src/api'
import { queryRetry, useNow, useOffline, useRes } from '../../../blocks-default/src/hooks'
import { actorNames } from '../../../blocks-default/src/model-activity'
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Actor, Card, Empty, Offline, Unwired, wireState } from '../kit'
import { LAB_TABS, filterRows, filterByCreator, readPage, rowsOf, stageCounts, stamp, type CreatorFilter, type LabRow, type StageFilter } from '../model-lab'
import { t as tr } from '@gitrader/workbench/i18n'

const MAX_PAGES = 20

type Load = { phase: 'loading' } | { phase: 'ready'; rows: LabRow[] } | { phase: 'error'; error: Error }

function useLabRows(): { load: Load; reload(): void; offline: boolean } {
  const bridge = useBridge()
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [n, setN] = useState(0)
  const reload = useCallback(() => setN((x) => x + 1), [])
  const offline = useOffline(reload)
  useEffect(() => {
    let dead = false
    ;(async () => {
      const items: unknown[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const got = readPage(await queryRetry(bridge, 'lab.list', { limit: 500, ...(cursor ? { cursor } : {}) }, () => !dead))
        items.push(...got.items)
        if (!got.next) break
        cursor = got.next
      }
      return items
    })().then(
      (items) => { if (!dead) setLoad({ phase: 'ready', rows: rowsOf(items) }) },
      (e: unknown) => { if (!dead) setLoad({ phase: 'error', error: e instanceof Error ? e : new Error(String(e)) }) },
    )
    return () => { dead = true }
  }, [bridge, n])
  return { load, reload, offline }
}

// ---- 小件 ---------------------------------------------------------------------------------

const Chev = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>
const WarnIcon = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5l8.5 15h-17L12 4.5z" /><path d="M12 10.5v4" /><path d="M12 17.25v.01" /></svg>
const BlockIcon = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></svg>

const mmss = (ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
/** 离线卡头小标：从离线那一刻起计时（挂载即离线开始）。 */
function PausedTag() {
  const since = useRef(Date.now())
  const now = useNow(1000)
  return <span className="g5-s12 g5-t3" data-stale="paused">{tr('已暂停更新 · ')}{mmss(now - since.current)}</span>
}

function Head({ count, right }: { count?: number; right?: ComponentChildren }) {
  return <header className="g5-hd">
    <h2>{tr('实验')}</h2>
    {count !== undefined ? <span className="g5-ct">{count}</span> : null}
    {right}
  </header>
}

function Msg({ children }: { children: ComponentChildren }) {
  return <div className="lab-msg">{children}</div>
}

const SKELETON_COLS = [56, 144, 28, 72, 32, 20, 16, 60, 160, 88] as const
function Skeletons() {
  return <div className="g5-tw g5-scroll lab-tw"><table className="g5-tbl">{header()}<tbody>
    {Array.from({ length: 5 }, (_, i) => <tr className="g5-row g5-h40" key={i}>
      {SKELETON_COLS.map((w, c) => <td className={c >= 4 && c <= 6 ? 'g5-n' : c === 8 ? 'g5-fill' : undefined} key={c}><span className="g5-sk" style={{ width: `${w}px` }} /></td>)}
      <td />
    </tr>)}
  </tbody></table></div>
}

function header() {
  return <thead><tr>
    <th>{tr('名称')}</th><th>{tr('阶段')}</th><th>{tr('登记')}</th>
    <th className="g5-n" data-n="fd">{tr('前向天数')}</th><th className="g5-n" data-n="ft">{tr('前向交易')}</th><th className="g5-n" data-n="tr">{tr('试验')}</th>
    <th>{tr('偏差检查')}</th><th className="g5-fill">{tr('最近动作')}</th><th>{tr('创建方')}</th><th>{tr('编号')}</th><th />
  </tr></thead>
}

function BiasCell({ row }: { row: LabRow }) {
  const b = row.bias
  switch (b.kind) {
    case 'unrun': return <span className="g5-t3">{tr('未跑')}</span>
    case 'pass': return <span className="g5-tb">{tr('通过 {0} / ', b.passed)}{b.total}</span>
    case 'lookahead_fail': return <span className="g5-bad"><BlockIcon />{tr('前视未通过')}</span>
    case 'recursive_fail': return <span className="g5-bad"><BlockIcon />{tr('递归未通过')}</span>
    case 'cutoff': return <span className="g5-miss"><WarnIcon />{tr('训练截止存疑')}</span>
  }
}

function LastCell({ row, offline }: { row: LabRow; offline: boolean }) {
  const last = row.last
  if (!last) return <span className="g5-t3" data-wire="off" title="lastAction">—</span>
  if (last.running) return <span className="g5-runc">
    {offline ? null : <span className="g5-fuse" role="progressbar" aria-label={tr('{0} 运行中', row.id)}><i style={{ width: '100%' }} /></span>}
    <span className="g5-tb">{last.text}</span><span className="g5-t2">{tr('运行中')}</span>
  </span>
  return <><span className="g5-t3">{stamp(last.at)}</span>{tr('　')}{last.text}</>
}

// Agent 创建的实验显示钥匙名（qa），不显示钥匙编号 ak_…（release-r1 P2-5；名称映射与持仓表 OriginActor 同源）
function CreatorCell({ row, names }: { row: LabRow; names: Record<string, string> }) {
  const kind = row.creatorType === 'human' ? 'human' : row.creatorType === 'engine' ? 'engine' : row.creatorType === 'llm-agent' ? 'agent' : 'system'
  const actor = <Actor kind={kind} name={kind === 'agent' ? names[`agent:${row.creatorName}`] ?? row.creatorName : row.creatorName} />
  return row.creatorType === 'human' ? <span className="lab-me">{actor}</span> : actor
}

const open = (id: string): void => { window.location.hash = `#/lab/${encodeURIComponent(id)}` }

function Row({ row, offline, names }: { row: LabRow; offline: boolean; names: Record<string, string> }) {
  return <tr className="g5-row g5-h40" data-id={row.id} onClick={(e) => { if (!(e.target as Element).closest('a')) open(row.id) }}>
    <td><a className="lab-link" href={`#/lab/${encodeURIComponent(row.id)}`}>{row.title}</a></td>
    <td>{row.stageLabel}</td>
    <td className="g5-t2">{stamp(row.createdAt)}</td>
    <td className={row.forwardDays === null ? 'g5-n g5-t3' : 'g5-n'} data-n="fd">{row.forwardDays === null ? tr('无') : tr('{0} 天', row.forwardDays)}</td>
    <td className={row.forwardTrades === null ? 'g5-n g5-t3' : 'g5-n'} data-n="ft">{row.forwardTrades === null ? tr('无') : row.forwardTrades}</td>
    <td className="g5-n" data-n="tr">{row.trials}</td>
    <td><BiasCell row={row} /></td>
    <td className="g5-fill"><LastCell row={row} offline={offline} /></td>
    <td><CreatorCell row={row} names={names} /></td>
    <td><span className="g5-t3" style={{ fontFamily: 'var(--gr-font-mono)' }}>{row.id.slice(0, 8)}</span></td>
    <td className="g5-n"><svg className="g5-i lab-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg></td>
  </tr>
}

function Table({ rows, offline, names }: { rows: LabRow[]; offline: boolean; names: Record<string, string> }) {
  const table = <div className="g5-tw g5-scroll lab-tw"><table className="g5-tbl">{header()}<tbody>{rows.map((r) => <Row row={r} offline={offline} names={names} key={r.id} />)}</tbody></table></div>
  return offline ? <Offline>{table}</Offline> : table
}

// ---- 主视图 -------------------------------------------------------------------------------

export function LabList() {
  const { load, reload, offline } = useLabRows()
  const [stage, setStage] = useState<StageFilter>('all')
  const [creator, setCreator] = useState<CreatorFilter>('all')
  // ponytail: 实验页清单（pages/lab.tsx inputs.queries）还没声明 agentkey.list，桥会拒、这里退回钥匙 ID；清单补上这一项后名称（qa）才显示。
  const keysRes = useRes<unknown>(Q.keys)
  const names = useMemo(() => actorNames(keysRes.data), [keysRes.data])

  if (load.phase === 'loading') return <Card className="g5-grow" data-page="lab" data-g5-page="lab" aria-busy="true" head={<Head />}><Skeletons /></Card>

  if (load.phase === 'error') {
    const e = load.error
    return <Card className="g5-grow" data-page="lab" data-g5-page="lab" head={<Head />}>
      <Msg>{wireState(e) === 'off'
        ? <Unwired message={e.message} />
        : <><span>{tr('读取失败')}</span><span className="g5-msg">{e.message}</span><button type="button" className="g5-btn g5-btn-ghost" onClick={reload}>{tr('重试')}</button></>}</Msg>
    </Card>
  }

  const scoped = filterByCreator(load.rows, creator)
  const counts = stageCounts(scoped)
  const rows = filterRows(load.rows, stage, creator)
  const creatorLabel = ACTOR_FILTERS.find((f) => f.id === creator)?.label ?? tr('全部')
  const right = <div className="g5-r g5-gh">
    {offline ? <PausedTag /> : null}
    <div className="g5-tabs" role="tablist">
      {[{ id: 'all' as const, label: tr('全部') }, ...LAB_TABS].map((t) => <button type="button" className="g5-tab" role="tab" aria-selected={stage === t.id} key={t.id} onClick={() => setStage(t.id)}>{t.label}<span className="g5-c">{counts[t.id]}</span></button>)}
    </div>
    <Menu
      label={tr('创建方')} align="end" value={creator} onValueChange={(id: string) => setCreator(id as CreatorFilter)}
      items={ACTOR_FILTERS.map((f) => ({ id: f.id, label: f.label }))}
      trigger={<button type="button" className="g5-dd" aria-label={tr('创建方筛选')}>{tr('创建方 ')}{creatorLabel}<Chev /></button>}
    />
  </div>

  return <Card className="g5-grow" data-page="lab" data-g5-page="lab" head={load.rows.length === 0 ? <Head count={0} /> : <Head count={rows.length} right={right} />}>
    {load.rows.length === 0 ? <Empty message={tr('还没有实验')} />
      : rows.length === 0 ? <Empty message={tr('没有符合筛选的实验')} />
        : <Table rows={rows} offline={offline} names={names} />}
  </Card>
}
