// SPDX-License-Identifier: CPAL-1.0
// 默认八块 + 审计 / 资金曲线的占位清单。内容由 blocks-default（G）提供；G 的块按同 id 注册后会覆盖这里的占位。
// 占位块的作用：让壳在 G 的块落地前就能完整摆出默认预设、验证布局与钉住规则，并给出各块的尺寸约束假设。
import type { BlockManifest } from '@gitrader/blocks-sdk'
import { BLOCK } from './presets'
import { t } from '../ui/lib/i18n.js'

const m = (id: string, name: string, size: BlockManifest['size'], extra: Partial<BlockManifest> = {}): BlockManifest => ({
  schema: 'gitrader-block/1',
  id: `block.gitrader.${id}`,
  name,
  version: '0.1.0',
  vendor: { name: 'gitrader' },
  license: 'CPAL-1.0',
  entry: { module: `./${id}.js`, element: `gr-${id}` },
  isolation: 'inline',
  size,
  permissions: [],
  linkGroups: [{ group: 'symbol', mode: 'readwrite' }],
  fixtures: [`./fixtures/${id}.json`],
  ...extra,
})

/** 尺寸约束是本包的假设（G 的真实清单为准）；预设按这些下限排布。 */
export const PLACEHOLDER_MANIFESTS: readonly BlockManifest[] = [
  m('chart', t('图表'), { minW: 8, minH: 8, defaultW: 15, defaultH: 17 }),
  m('positions', t('持仓与盈亏'), { minW: 8, minH: 5, defaultW: 15, defaultH: 9 }),
  m('orderbook', t('盘口'), { minW: 5, minH: 5, defaultW: 8, defaultH: 12 }),
  m('audit', t('记录'), { minW: 8, minH: 5, defaultW: 15, defaultH: 9 }),
  m('equity', t('资金'), { minW: 6, minH: 5, defaultW: 15, defaultH: 9 }),
  m('agent-activity', 'Agent', { minW: 6, minH: 6, defaultW: 9, defaultH: 10 }, { pinned: true }),
  m('risk', t('风险'), { minW: 6, minH: 5, defaultW: 9, defaultH: 7 }, { pinned: true }),
  m('symbols', t('标的'), { minW: 5, minH: 5, defaultW: 9, defaultH: 9 }),
  m('authorizations', t('钥匙'), { minW: 6, minH: 5, defaultW: 9, defaultH: 9 }),
  m('statusbar', t('状态条'), { minW: 24, minH: 1, defaultW: 24, defaultH: 1 }, { pinned: true, linkGroups: [] }),
  m('lab', t('实验'), { minW: 6, minH: 5, defaultW: 15, defaultH: 9 }),
  m('strategies', t('策略'), { minW: 6, minH: 5, defaultW: 15, defaultH: 9 }),
  m('venues', t('交易所'), { minW: 6, minH: 5, defaultW: 15, defaultH: 9 }),
  m('notify', t('通知'), { minW: 6, minH: 5, defaultW: 15, defaultH: 9 }),
  m('plugins', t('插件'), { minW: 6, minH: 5, defaultW: 15, defaultH: 9 }),
]

/** 默认预设里出现过的块引用（测试用）。 */
export const DEFAULT_BLOCK_REFS: readonly string[] = Object.values(BLOCK)
