// SPDX-License-Identifier: CPAL-1.0
// 图标：Opus 的 Gitrader 图标集（src/icons/，74 个，24 网格 1.5 描边，currentColor）；旧名经 GR_ICON_ALIASES 自动映射，
// 集里没有的旧名回落到下面的 ICON_PATHS（兜底，页面迁完后删）。不下载图标库。
import { resolveIcon } from '../icons/index.js'

export const ICON_PATHS = {
  // 业务/活动
  order: 'M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3-3m-3 3 3 3',
  fill: 'M5 12.5l4.5 4.5L19 7.5',
  reject: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  signal: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  strategy: 'M4 18l5-6 4 3 7-9M16 6h4v4',
  note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6',
  system: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  liquidation: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  chart: 'M4 19V5M4 19h16M7.5 14.5l3.5-4 3 2.5 4.5-6',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M3 13l2.2-7.2A2 2 0 0 1 7.1 4.4h9.8a2 2 0 0 1 1.9 1.4L21 13M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
  offline: 'M3 3l18 18M8.5 8.8A9.5 9.5 0 0 0 4 12.5M5.6 16A6 6 0 0 1 9 13.3M12.7 6.1A9.6 9.6 0 0 1 20 12.5M15.5 11.7A6 6 0 0 1 18.4 14.5M12 18.5h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01',
  // 导航
  overview: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  markets: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9S14.5 18.5 12 21c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z',
  trade: 'M7 3v3M7 18v3M17 5v2M17 16v3M5 6h4v12H5zM15 7h4v9h-4z',
  deck: 'M7 3h10v9H7zM12 12v3M4 15h16v5H4z',
  strategies: 'M6 3v12.5M6 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18 8.5c0 5-12 3-12 7',
  agents: 'M12 4v4M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9.5 13h.01M14.5 13h.01M10 16.5h4M3 12v3M21 12v3',
  accounts: 'M4 7a2 2 0 0 1 2-2h11v3M4 7v10a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H6a2 2 0 0 1-2-1zM16.5 13.5h.01',
  risk: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6zM9 12l2.2 2.2L15.5 10',
  journal: 'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10M9 8h5',
  store: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  signals: 'M3 10h3l2-5 3.5 10 2.5-7 1.5 2H21M7 19h10',
  opportunities: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12h.01',
  research: 'M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14',
  lessons: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  orchestration: 'M5 3.5h4.5v4.5H5zM14.5 3.5H19v4.5h-4.5zM9.75 16H14.25v4.5H9.75zM7.25 8v3.5h9.5V8M12 11.5V16',
  wallet: 'M5 6.5h11a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2zM3 9.5V6.5A2.5 2.5 0 0 1 5.5 4H15M14.5 13h6v4h-6a2 2 0 0 1 0-4zM16.8 15h.01',
  pipeline: 'M3.5 9.5h4v5h-4zM10 9.5h4v5h-4zM16.5 9.5h4v5h-4zM7.5 12H10M14 12h2.5',
  // 并入自 G 的页面局部图标
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9',
  chip: 'M8 8h8v8H8zM10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3',
  wave: 'M3 15.5l3.5-5 3 3 4-8 3 5 4-3',
  data: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5',
  'arrow-down': 'M12 4v14m0 0l-6-6m6 6l6-6',
  eject: 'M12 5l7 8H5l7-8zM5 18h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3M7.5 15h9',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 3v3M12 18v3M3 12h3M18 12h3',
  loop: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
  swap: 'M7 17V7m0 0L4 10m3-3l3 3M17 7v10m0 0l3-3m-3 3l-3-3',
  layers: 'M12 4l9 5-9 5-9-5 9-5zM3 14l9 5 9-5',
  send: 'M20 4L3 11l6.5 2.5L12 20l3-6.5L20 4zM9.5 13.5L20 4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  'arrow-right': 'M5 12h14m0 0l-5-5m5 5l-5 5',
  gauge: 'M4 16a8 8 0 1 1 16 0M12 16l4-5M7 16h.01M17 16h.01',
  pulse: 'M3 12h4l2-5 4 10 2-5h6',
  book: 'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  // 通用
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z',
  'chevron-left': 'M14 6l-6 6 6 6',
  'chevron-right': 'M10 6l6 6-6 6',
  'chevron-down': 'M6 10l6 6 6-6',
  'chevron-up': 'M6 14l6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  refresh: 'M20 12a8 8 0 1 1-2.5-5.8M20 4v4.5h-4.5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  pencil: 'M4 20l4.5-1L19 8.5 15.5 5 5 15.5zM13.5 7l3.5 3.5',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
  'arrow-up-right': 'M7 17L17 7M9 7h8v8',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  sparkle: 'M12 4l1.8 4.6L18.5 10l-4.7 1.4L12 16l-1.8-4.6L5.5 10l4.7-1.4zM18 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  copy: 'M9 9h10v11H9zM5 15V4h10',
}

export function Icon({ name, size = 16, className = '', title }) {
  return (
    <svg className={'gr-icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={resolveIcon(name) || ICON_PATHS[name] || resolveIcon('system')} />
    </svg>
  )
}

/** 实心星（自选已选中）。 */
export function StarFilled({ size = 14, className = '' }) {
  return (
    <svg className={'gr-icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
      <path d={resolveIcon('star') || ICON_PATHS.star} />
    </svg>
  )
}
