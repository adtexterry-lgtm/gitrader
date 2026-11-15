// SPDX-License-Identifier: CPAL-1.0
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { FundsBlock } from '../views/funds'
import { t } from '@gitrader/workbench/i18n'

// 资金页：同一个块 block.gitrader.equity，config.view = accounts | curve | assets | margin | changes。
// 点账户行写联动组 account（readwrite），其余四张卡跟随；paper.reset（要在场证明）与 venue.reconnect 只在账户卡里发。
export const fundsBlock = defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.equity',
    name: t('资金'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-equity' },
    isolation: 'inline',
    size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
    inputs: {
      events: [{ topic: 'account.summary', maxHz: 2 }, { topic: 'account.fills', maxHz: 2 }],
      queries: ['account.list', 'account.summary', 'account.assets', 'account.equity_history', 'account.positions', 'account.orders', 'records.query', 'venue.status', 'portfolio.analysis'],
    },
    permissions: ['account.read'],
    actions: ['paper.reset', 'venue.reconnect'],
    linkGroups: [{ group: 'account', mode: 'readwrite' }],
    fixtures: ['./fixtures/funds.ts'],
  },
  component: (props: BlockProps) => <FundsBlock config={props.config} />,
})

export const fundsBlocks = [fundsBlock]
