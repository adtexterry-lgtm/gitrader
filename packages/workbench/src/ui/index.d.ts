// SPDX-License-Identifier: CPAL-1.0
// 组件库的宽松类型（组件本体是 JSX；属性见 packages/workbench/README.md 的组件表）。块作者（blocks-default / 插件）用。
import type { ComponentChildren, ComponentType } from 'preact'
import './r5/components.css'
type C = ComponentType<any>
export const Icon: C, Ico: C, StarFilled: C
export const ICON_PATHS: Record<string, string>
export const Page: C, Grid: C, Col: C, Card: C, PanelHead: C, Panel: C, Section: C, ScrollArea: C, IconOrb: C, Orb: C, AnimatedNumber: C, Stat: C, ProgressBar: C, EmptyState: C, Skeleton: C, SkeletonLines: C, Badge: C, Tag: C, SideTag: C, Kbd: C, Dot: C, Pill: C, Button: C, ConfirmButton: C, Segmented: C, Tabs: C, Flash: C
export const Table: C
export { t, tk, getLang, setLang, pickLang, intlLocale } from './lib/i18n.js'
export function useSort(...a: any[]): any
export function sortRows(...a: any[]): any
export const Field: C, TextInput: C, NumberInput: C, PasswordInput: C, Slider: C, Switch: C, Select: C
export const InfoTip: C, Tooltip: C, Popover: C, MenuItem: C, MenuDivider: C, Drawer: C, ToastHost: C

// ---- r2 新增（接口说明见 reports/visual-r2/A-API.md）----
type ButtonVariant = 'primary' | 'veto' | 'kill' | 'secondary' | 'ghost' | 'text' | 'link'
type Size = 'lg' | 'md' | 'sm' | 'xs'
/** G2 就地确认：取消在前、动词确认、焦点落取消、600 ms 死区、悬停暂停 5 s、执行中隐藏取消、失败重给 5 s + 就地原文。 */
export const InlineConfirm: ComponentType<{ label: ComponentChildren; confirmLabel?: string; onConfirm?: () => unknown; variant?: ButtonVariant; confirmVariant?: ButtonVariant; size?: Size; icon?: string; busy?: boolean; busyLabel?: string; disabled?: boolean; reason?: string; timeout?: number; deadZone?: number; error?: string | null; className?: string; cancelLabel?: string; dataAct?: string; onArmedChange?: (armed: boolean) => void }>
export const ErrText: ComponentType<{ text: string; bare?: boolean }>
export const ErrDetail: ComponentType<{ detail: string }>
/** 骨架超时提示：after（8000）毫秒后出「仍在读取」+ 重试。 */
export const SkeletonSlow: ComponentType<{ onRetry?: () => unknown; after?: number; className?: string }>
export const ButtonGroup: ComponentType<{ children?: ComponentChildren; label?: string; vertical?: boolean; className?: string }>
/** 里程表数字：value 是已格式化文本；textContent / innerText 只有一份完整文本。 */
export const RollingNumber: ComponentType<{ value: string | number | null | undefined; duration?: number; stagger?: number; className?: string }>
/** ‹ 1 / 3 ›，count ≤ 1 不渲染。index 从 0 起。 */
export const Pager: ComponentType<{ index: number; count: number; onChange: (index: number) => void; label?: string; className?: string }>
export const ItemList: ComponentType<{ children?: ComponentChildren; label?: string; className?: string }>
export const Item: ComponentType<{ icon?: string; title: ComponentChildren; meta?: ComponentChildren; right?: ComponentChildren; onClick?: (e: MouseEvent) => void; expanded?: boolean; children?: ComponentChildren; className?: string; [data: string]: unknown }>
export interface MenuItemSpec { id: string; label: ComponentChildren; hint?: ComponentChildren; disabled?: boolean; danger?: boolean; kind?: 'radio' | 'item' | 'separator' | 'label'; onSelect?: () => void }
/** Radix DropdownMenu 包装。trigger 走 asChild（原元素的类名 / data 钩子保留）；给 value 即单选菜单（menuitemradio）。 */
export const Menu: ComponentType<{ trigger: ComponentChildren; items: MenuItemSpec[]; value?: string; onValueChange?: (id: string) => void; onSelect?: (id: string) => void; header?: ComponentChildren; label?: string; align?: 'start' | 'center' | 'end'; side?: 'top' | 'right' | 'bottom' | 'left'; sideOffset?: number; open?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean; width?: string; className?: string }>
/** Radix Popover 包装。className 落在内容元素上；其余属性透传给 Radix Content。 */
export const PopoverPanel: ComponentType<{ trigger: ComponentChildren; children?: ComponentChildren; open?: boolean; onOpenChange?: (open: boolean) => void; side?: 'top' | 'right' | 'bottom' | 'left'; align?: 'start' | 'center' | 'end'; sideOffset?: number; width?: string; label?: string; className?: string; [radix: string]: unknown }>
/** Radix Dialog 包装（受控）。title 必给；placement: top（距顶 14vh）| center | right（抽屉）。 */
export const DialogShell: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void; title: ComponentChildren; hideTitle?: boolean; description?: ComponentChildren; children?: ComponentChildren; level?: EscLevel | number; closeOnOverlay?: boolean; placement?: 'top' | 'center' | 'right'; width?: string; className?: string; overlayClassName?: string; [radix: string]: unknown }>
/** PIN / 口令输入：任意字符、上限 64、不剥字符；纯数字且 ≤ 12 位画点阵，否则「已输入 N 位」。 */
export const PinField: ComponentType<{ value: string; onChange: (v: string) => void; onEnter?: (e: KeyboardEvent) => void; minLength?: number; maxLength?: number; disabled?: boolean; invalid?: boolean; autoFocus?: boolean; inputRef?: { current: HTMLInputElement | null }; label?: string; shakeKey?: unknown; describedBy?: string; className?: string }>
export type EscLevel = 'confirm' | 'menu' | 'popover' | 'drawer' | 'palette' | 'pin'
export const ESC_LEVEL: Record<EscLevel, number>
/** G6：登记一层，Esc 只落到最上一层（级别高的先；同级后登记的先）。 */
export function useEscLayer(level: EscLevel | number, onEsc: (e: KeyboardEvent) => void, active?: boolean): void
export function useMedia(query: string): boolean
export function toastOut(el: Element | null): Animation | null
export function shake(el: Element | null): Animation | null
export const toast: { ok(text: string, ms?: number, action?: any): number; err(text: string, ms?: number, action?: any): number; info(text: string, ms?: number, action?: any): number; dismiss(id: number): void }
export const Sparkline: C, AreaChart: C, Chips: C, Notice: C, Tile: C
/** 「谁做的」小标。actor 是契约 §1.6 的 `<类型>:<id>`。 */
export const ActorMark: C, ActorFilter: C
export const ACTOR_FILTERS: ReadonlyArray<{ id: string; label: string }>
export function matchesActorFilter(origin: { actor?: string | null; actorType?: string | null } | null | undefined, filter: string): boolean
export function originActorType(origin: { actor?: string | null; actorType?: string | null } | null | undefined): 'human' | 'engine' | 'llm-agent' | 'system'
export function actorKind(origin: any): 'host' | 'unit' | 'user' | 'system'
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, opts?: { mod?: boolean; allowInInput?: boolean }): void
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void]
export function useClickAway(ref: any, onAway: (e: Event) => void, active?: boolean): void
export function useSize(ref: any): { w: number; h: number }
export function copyText(text: string): Promise<boolean>
export const F: Record<string, any>
export function useLayout(): { theme: string; nav: string; density: 'comfortable' | 'compact'; densityPref: string }
export function pageEnter(...a: any[]): any
export function cardHover(...a: any[]): any
export function counter(...a: any[]): any
export function pulse(...a: any[]): any
export function popIn(...a: any[]): any
export function toastIn(...a: any[]): any
export function chartDrawIn(...a: any[]): any
export function reduced(): boolean

// ---- r4 新增（接口说明见 reports/visual-r4/A-API.md）----
/** 退场：上移 |dy| 淡出（缺省 -8 px / 200 ms），停在隐藏态；减少动效时 120 ms 只淡出。播完 / 被打断都 resolve。 */
export function leave(el: Element | null | undefined, opts?: { dy?: number; dur?: number }): Promise<void>
/** 入场：从下 dy 落位（缺省 12 px / 280 ms，delay 0）；减少动效时 120 ms 只淡入。对刚 leave 过的同一元素会先撤掉退场末帧。 */
export function enter(el: Element | null | undefined, opts?: { dy?: number; dur?: number; delay?: number }): Promise<void>
