// SPDX-License-Identifier: CPAL-1.0
// 组件库入口（壳与默认块共用）：`import { Card, Table, Button, ... } from '@gitrader/workbench/ui'`（块）或相对路径（壳）。
// 容器三级（Card hero / Card / Section）、按钮三档、表格、Chips、Tooltip、Icon、抽屉、ActorMark 都从这里出。
// 令牌在 theme.css；只许 var(--gr-*)，不写颜色字面量。r2 新增：Menu / PopoverPanel / DialogShell（Radix 包装）、InlineConfirm（G2 就地确认）、
// ButtonGroup / RollingNumber / Pager / ItemList / Item、PinField、SkeletonSlow、useEscLayer（G6 Esc 分层）、useMedia。接口说明见 reports/visual-r2/A-API.md。
import './theme.css'
import './r5/components.css'
import './components/components.css'
import './components/shared.css'
export { Icon, Icon as Ico, StarFilled, ICON_PATHS } from './components/Icon.jsx'
export { Page, Grid, Col, Card, PanelHead, Panel, Section, ScrollArea, IconOrb, Orb, AnimatedNumber, Stat, ProgressBar, EmptyState, Skeleton, SkeletonLines, SkeletonSlow, Badge, Tag, SideTag, Kbd, Dot, Pill, Button, ConfirmButton, InlineConfirm, Segmented, Tabs, Flash } from './components/core.jsx'
export { ErrText, ErrDetail } from './components/ErrText.jsx'
export { ButtonGroup, RollingNumber, Pager, ItemList, Item } from './components/kit.jsx'
export { Menu, PopoverPanel, DialogShell } from './components/radix.jsx'
export { Table, useSort, sortRows } from './components/Table.jsx'
export { Field, TextInput, NumberInput, PasswordInput, PinField, Slider, Switch, Select } from './components/forms.jsx'
export { InfoTip } from './components/Tooltip.jsx'
export { toast, ToastHost, Drawer, Tooltip, Popover, MenuItem, MenuDivider } from './components/overlay.jsx'
export { useEscLayer, ESC_LEVEL } from './lib/esc.js'
export { Sparkline, AreaChart } from './components/charts.jsx'
export { Chips, Notice } from './components/Chips.jsx'
export { Tile } from './components/primitives.jsx'
export { ActorMark, ActorFilter } from './components/ActorMark.jsx'
export { ACTOR_FILTERS, matchesActorFilter, originActorType, actorKind } from '../core/actor'
export { useHotkey, useLocalStorage, useClickAway, useSize, useMedia } from './lib/hooks.js'
export { copyText } from './lib/clip.js'
export * as F from './lib/format.js'
export { useLayout } from './lib/layout.js'
export { t, tk, getLang, setLang, pickLang, intlLocale } from './lib/i18n.js'
export { pageEnter, cardHover, counter, pulse, popIn, toastIn, toastOut, shake, chartDrawIn, reduced } from './motion.js'
export { leave, enter } from './motion.js' // r4 新增（接口说明见 reports/visual-r4/A-API.md）
