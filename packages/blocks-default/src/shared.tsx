// SPDX-License-Identifier: CPAL-1.0
// 几个块共用的小件：来源标、读取失败态、命令执行。样式在 blocks.css（类名 gb-*，只引用 theme.css 的令牌）。弹出卡用组件库的 PopoverPanel（Radix）。
import type { BlockBridge } from '@gitrader/blocks-sdk'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import type { Origin } from '@gitrader/protocol/types'
import { ActorMark, Button, EmptyState, RollingNumber, toast } from '@gitrader/workbench/ui'
import type { ComponentChildren, RefObject, VNode } from 'preact'
import { createPortal } from 'preact/compat'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { CmdResult } from './actions'
import { originActorTypeOf } from './model-activity'
import { t as tr } from '@gitrader/workbench/i18n'

/**
 * 来源小标。LLM Agent 一律带「LLM」标记（固定标记，不依赖颜色；PLAN ⑧）：视觉上是名字后面一枚 Mono 小标（blocks.css 的 ::after），
 * 文本与读屏仍是「LLM · 名字」——前缀放在字号为 0 的隐藏段里，innerText / textContent 不变（检阅面按这串字找 LLM 来源）。
 */
export function Actor({ origin, names }: { origin: Origin | null; names?: Record<string, string> }) {
  if (!origin) return <span className="gr-muted">—</span>
  const t = originActorTypeOf(origin)
  const key = String(origin.actor)
  const id = key.slice(key.indexOf(':') + 1)
  if (t === 'llm-agent') {
    const nm = names?.[key]
    return <ActorMark origin={origin} name={<span className="gb-who" data-llm="">{nm ? <><span className="gb-who__pre">LLM · </span>{nm}</> : <><span className="gb-who__pre">LLM </span>Agent</>}</span>} />
  }
  const name = t === 'engine' ? (id && id !== key ? id : tr('引擎')) : undefined
  return <ActorMark origin={origin} {...(name ? { name } : {})} />
}

/** 读取失败：内核原文原样（Mono 12，两行截断，悬停看全文）+ 重试；重试中「重试中…」，新的失败原文到了就复原。 */
export function ErrorState({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => { setBusy(false) }, [error])
  return (
    <EmptyState compact art="offline" title={tr('读取失败')} desc={error ? error.message : undefined} className="gb-err">
      {onRetry ? <Button size="sm" busy={busy} data-act="read-retry" onClick={() => { setBusy(true); onRetry() }}>{busy ? tr('重试中…') : tr('重试')}</Button> : null}
    </EmptyState>
  )
}

/**
 * 卡头计数与右侧状态（r4）：在壳里 portal 进本卡的 .gr-tile-p__slot；没有壳（预览 / 舞台）就自己渲染「标题 计数 右侧」。只放不可交互的内容。
 * rootRef = 块根元素；每次渲染后现找一次槽，不缓存首次的节点（块根在加载 / 错误态之间换元素、壳在手机 ↔ 桌面切换时重建卡头槽都跟得上；
 * 卡头重建时本块不一定重渲，所以再挂一个 MutationObserver 只看卡本身与卡头的直接子节点）。找到的槽不变就不重渲。
 */
export function CardHead({ title, count, right, rootRef }: { title: string; count?: number | string | null; right?: ComponentChildren; rootRef: RefObject<HTMLElement | null> }): VNode | null {
  const [slot, setSlot] = useState<HTMLElement | null | undefined>(undefined)
  const find = (): HTMLElement | null => rootRef.current?.closest('.gr-tile-p')?.querySelector<HTMLElement>('.gr-tile-p__slot') ?? null
  useLayoutEffect(() => { setSlot(find()) })
  useEffect(() => {
    const tile = rootRef.current?.closest('.gr-tile-p')
    if (!tile || typeof MutationObserver === 'undefined') return undefined
    const mo = new MutationObserver(() => setSlot(find()))
    mo.observe(tile, { childList: true })
    if (slot?.parentElement) mo.observe(slot.parentElement, { childList: true })
    return () => mo.disconnect()
  }, [slot])
  // 计数变化时只滚变化的那一位（VISUAL §5 D「卡头计数 2 → 1 滚一位」）
  const body = <>{count != null ? <span className="gb-head__n gr-num">{typeof count === 'number' ? <RollingNumber value={count} /> : count}</span> : null}{right != null ? <span className="gb-head__r">{right}</span> : null}</>
  if (slot) return createPortal(body, slot)
  if (slot === undefined) return null
  return <div className="gb-head"><span className="gb-head__t" tabIndex={-1}>{title}</span>{body}</div>
}

/** 执行一条命令并用 toast 回报；PIN 层被用户取消时不打扰。返回是否成功。 */
export function useRunner(): { run(fn: (b: BlockBridge) => Promise<CmdResult>, okText: string | ((v: unknown) => string)): Promise<boolean>; busy: boolean } {
  const bridge = useBridge()
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const run = useCallback(async (fn: (b: BlockBridge) => Promise<CmdResult>, okText: string | ((v: unknown) => string)) => {
    setBusy(true)
    try {
      const r = await fn(bridge)
      if (r.ok) { toast.ok(typeof okText === 'function' ? okText(r.value) : okText); return true }
      if (!r.cancelled) toast.err(r.message)
      return false
    } finally { if (alive.current) setBusy(false) }
  }, [bridge])
  return { run, busy }
}
