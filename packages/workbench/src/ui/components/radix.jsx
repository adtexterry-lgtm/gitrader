// SPDX-License-Identifier: CPAL-1.0
// Portions adapted from shadcn/ui (MIT), Copyright (c) 2023 shadcn
// Radix 三件的薄包装：Menu（DropdownMenu）/ PopoverPanel（Popover）/ DialogShell（Dialog）。外观取 shadcn Mira 配方经令牌桥换成 Gitrader 材质；
// 行为（焦点陷阱、Esc、外点关闭、焦点归还、避让翻转、aria）全交给 Radix。构建时 esbuild 把 react / react-dom 别名到 preact/compat（小试验全过）。
// Esc 一律走 lib/esc.js 的分层栈（G6）：只关最上一层；Radix 自己的 Esc 处理被拦下，避免一次 Esc 关掉好几层。
import * as RMenu from '@radix-ui/react-dropdown-menu'
import * as RPop from '@radix-ui/react-popover'
import * as RDialog from '@radix-ui/react-dialog'
import { useRef, useState } from 'preact/hooks'
import { Icon } from './Icon.jsx'
import { useEscLayer } from '../lib/esc.js'

const cx = (...a) => a.filter(Boolean).join(' ')
const noEsc = (e) => e.preventDefault()

function useOpen(open, onOpenChange) {
  const [inner, setInner] = useState(false)
  const controlled = open !== undefined
  const value = controlled ? !!open : inner
  const set = (v) => { if (!controlled) setInner(v); if (onOpenChange) onOpenChange(v) }
  return [value, set]
}

/**
 * 下拉菜单。trigger = 一个可点元素（Radix asChild：原元素的类名 / data 钩子原样保留，例如 .gb-tierbtn）。
 * items: [{ id, label, hint?, disabled?, danger?, kind?: 'radio' | 'item' | 'separator' | 'label', onSelect? }]。
 * 给了 value 就是单选菜单：kind 缺省为 radio（role=menuitemradio，当前项 aria-checked + 右侧勾），onValueChange(id)；kind:'item' 的项照常是普通项（例如灰掉的「限额自动…」）。
 * header：菜单头（例如到期日）。每项带 data-v={id}。外观：material-glass、r12、内边距 4、项高 32 r8。
 */
export function Menu({ trigger, items = [], value, onValueChange, onSelect, header, label, align = 'start', side = 'bottom', sideOffset = 6, open, onOpenChange, disabled = false, width, className = '' }) {
  const [isOpen, setOpen] = useOpen(open, onOpenChange)
  useEscLayer('menu', () => setOpen(false), isOpen)
  const radio = value !== undefined
  const body = items.map((it, i) => {
    const kind = it.kind || (it.separator ? 'separator' : radio ? 'radio' : 'item')
    if (kind === 'separator') return <RMenu.Separator key={'sep' + i} className="gr-menudiv" />
    if (kind === 'label') return <RMenu.Label key={'lab' + i} className="gr-menu__label">{it.label}</RMenu.Label>
    const inner = (
      <>
        <span className="gr-menuitem__t">{it.label}</span>
        {it.hint != null ? <span className="gr-menuitem__h">{it.hint}</span> : null}
      </>
    )
    const cls = cx('gr-menuitem gr-menu__item', it.danger && 'gr-menuitem--danger')
    if (kind === 'radio') {
      return (
        <RMenu.RadioItem key={it.id} value={it.id} disabled={it.disabled} className={cls} data-v={it.id}>
          {inner}
          <RMenu.ItemIndicator className="gr-menuitem__ck"><Icon name="check" size={14} /></RMenu.ItemIndicator>
        </RMenu.RadioItem>
      )
    }
    return <RMenu.Item key={it.id} disabled={it.disabled} className={cls} data-v={it.id} onSelect={() => { if (it.onSelect) it.onSelect(); else if (onSelect) onSelect(it.id) }}>{inner}</RMenu.Item>
  })
  return (
    <RMenu.Root open={isOpen} onOpenChange={setOpen}>
      <RMenu.Trigger asChild disabled={disabled}>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content className={cx('gr-menu material-glass', className)} align={align} side={side} sideOffset={sideOffset} collisionPadding={8} loop aria-label={label} onEscapeKeyDown={noEsc} style={width ? { width } : undefined}>
          {header ? <div className="gr-menu__head">{header}</div> : null}
          {radio ? <RMenu.RadioGroup value={value} onValueChange={onValueChange}>{body}</RMenu.RadioGroup> : body}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  )
}

/**
 * 弹出卡（状态条的网络卡 / 接管卡）：side 缺省 bottom，可 top；避让翻转、外点关闭、焦点进出由 Radix 负责。
 * className 落在 Radix 的内容元素上（.gb-float / .gb-netcard / .gb-tkcard 钩子放这里）。其余属性透传给 Radix Content（例如 onFocusOutside={(e) => e.preventDefault()}：
 * 卡里的动作要弹 PIN 时别让焦点离开就把卡关了）。
 */
export function PopoverPanel({ trigger, children, open, onOpenChange, side = 'bottom', align = 'center', sideOffset = 8, width, label, className = '', ...rest }) {
  const [isOpen, setOpen] = useOpen(open, onOpenChange)
  useEscLayer('popover', () => setOpen(false), isOpen)
  return (
    <RPop.Root open={isOpen} onOpenChange={setOpen}>
      <RPop.Trigger asChild>{trigger}</RPop.Trigger>
      <RPop.Portal>
        <RPop.Content className={cx('gr-popcard material-glass', className)} side={side} align={align} sideOffset={sideOffset} collisionPadding={8} aria-label={label} onEscapeKeyDown={noEsc} style={width ? { width } : undefined} {...rest}>
          {children}
        </RPop.Content>
      </RPop.Portal>
    </RPop.Root>
  )
}

/**
 * 对话框外壳（命令面板、第三方声明抽屉…）：受控 open / onOpenChange(false)。title 必给（读屏用；hideTitle 只藏不删）。
 * level：Esc 分层的级别（缺省 palette；抽屉给 'drawer'）。closeOnOverlay=false：点遮罩不关（PIN 这类必经步骤）。
 * placement：'top'（距顶 14vh，命令面板）| 'center' | 'right'（右侧抽屉）。width：CSS 长度。className 落在内容元素上，overlayClassName 落在遮罩上。
 * 焦点归还：关闭时缺省还给打开前的元素（没有 Radix Trigger 时 Radix 只会还给空的 trigger、焦点掉到 body）；该元素已不在页面上就不动。
 * 调用方给了 onCloseAutoFocus 且在里面 e.preventDefault()，就完全由调用方自己还（例如还给所在块的标题）。
 */
export function DialogShell({ open, onOpenChange, title, hideTitle = false, description, children, level = 'palette', closeOnOverlay = true, placement = 'top', width, className = '', overlayClassName = '', onCloseAutoFocus, ...rest }) {
  useEscLayer(level, () => onOpenChange && onOpenChange(false), !!open)
  // 打开前的焦点：在渲染里记（子组件的布局效果会在本组件的效果之前把焦点移进弹层，晚了就记成弹层里的元素）
  const opener = useRef(null)
  const was = useRef(false)
  if (open && !was.current && typeof document !== 'undefined') opener.current = document.activeElement
  was.current = !!open
  const back = (e) => {
    if (onCloseAutoFocus) onCloseAutoFocus(e)
    if (e.defaultPrevented) return
    e.preventDefault()
    const el = opener.current
    opener.current = null
    if (el && el !== document.body && el.isConnected && typeof el.focus === 'function') el.focus()
  }
  return (
    <RDialog.Root open={!!open} onOpenChange={(v) => onOpenChange && onOpenChange(v)}>
      <RDialog.Portal>
        <RDialog.Overlay className={cx('gr-dialog__overlay', overlayClassName)} />
        <RDialog.Content className={cx('gr-dialog material-glass', 'gr-dialog--' + placement, className)} style={width ? { width } : undefined}
          onEscapeKeyDown={noEsc} onPointerDownOutside={closeOnOverlay ? undefined : (e) => e.preventDefault()} onCloseAutoFocus={back} {...(description ? {} : { 'aria-describedby': undefined })} {...rest}>
          <RDialog.Title className={cx('gr-dialog__t', hideTitle && 'gr-sr')}>{title}</RDialog.Title>
          {description ? <RDialog.Description className="gr-dialog__d">{description}</RDialog.Description> : null}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
