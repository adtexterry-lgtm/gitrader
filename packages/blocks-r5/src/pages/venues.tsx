// SPDX-License-Identifier: CPAL-1.0
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { StubBlockView } from '../kit'
import { AccountsCard, CatalogCard, DetailCard, VenuesCard } from '../views/venues'
import { t } from '@gitrader/workbench/i18n'

const VIEWS = { venues: VenuesCard, accounts: AccountsCard, catalog: CatalogCard, detail: DetailCard } as const
function VenuesBlock(props: BlockProps) {
  const view = typeof props.config?.view === 'string' ? props.config.view : ''
  const View = Object.hasOwn(VIEWS, view) ? VIEWS[view as keyof typeof VIEWS] : undefined
  // 没配 view = 这个块位还没接通（桩）；config.view 缺字段 / 接口不存在由各卡自己显示「未接通」
  return View ? <View /> : <StubBlockView page="venues" title={t('交易所')} />
}

export const venuesBlocks = [defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.venues',
    name: t('交易所'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-venues' },
    isolation: 'inline',
    size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
    inputs: { queries: ['config.view', 'venue.status'] },
    actions: ['config.venues.set', 'venue.reconnect'],
    permissions: [],
    fixtures: ['./fixtures/venues.ts'],
  },
  component: VenuesBlock,
})]
