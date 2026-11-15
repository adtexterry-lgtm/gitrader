// SPDX-License-Identifier: CPAL-1.0
// Esc 分层（IXD G6 / F12-6）：一次 Esc 只关最上一层。层级 PIN > 命令面板 > 抽屉 > 菜单 / 弹出卡 > 就地确认；同级后开的先关。
// 只有一个 window 捕获阶段监听：有登记的层才接管这次 Esc（preventDefault + stopImmediatePropagation），没有就放行给别人。
// 就地确认（InlineConfirm）不登记：它只在焦点位于组内时响应 Esc（组上的 onKeyDown），焦点不可能同时在更上层的模态里。
import { useLayoutEffect, useRef } from 'preact/hooks'

export const ESC_LEVEL = { confirm: 1, menu: 2, popover: 2, drawer: 3, palette: 4, pin: 5 }
const stack = []
let seq = 0
let installed = false

function onKey(e) {
  if (e.key !== 'Escape' || !stack.length) return
  let top = stack[0]
  for (const s of stack) if (s.level > top.level || (s.level === top.level && s.seq > top.seq)) top = s
  e.preventDefault()
  e.stopImmediatePropagation()
  top.fn(e)
}

/** 当前登记的层（测试 / 调试用）：[{ level, seq }]，按登记顺序。 */
export const escLayers = () => stack.map(({ level, seq: n }) => ({ level, seq: n }))

/**
 * 登记一层：active 为真时，这一层在栈里；Esc 落到它时调 onEsc(e)。level 是 ESC_LEVEL 的名字或数字。
 * 用布局效果登记（提交 DOM 时同步生效）：弹层一出现 Esc 就有效，不会丢「打开瞬间按的 Esc」（r1 修过的竞态）。
 */
export function useEscLayer(level, onEsc, active = true) {
  const fn = useRef(onEsc)
  fn.current = onEsc
  const lv = typeof level === 'number' ? level : (ESC_LEVEL[level] ?? 1)
  useLayoutEffect(() => {
    if (!active) return undefined
    if (!installed && typeof window !== 'undefined') { window.addEventListener('keydown', onKey, true); installed = true }
    const entry = { level: lv, seq: ++seq, fn: (e) => fn.current && fn.current(e) }
    stack.push(entry)
    return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1) }
  }, [active, lv])
}
