// SPDX-License-Identifier: CPAL-1.0
import { defineBlock } from '@gitrader/blocks-sdk'
import { RecordsPage } from '../views/records'
import { t } from '@gitrader/workbench/i18n'

/** 记录页（沿用 audit 占位 id）：config.tab = fills | orders | funding；只读查询 + 一条会话级命令 ledger.export。 */
export const recordsBlocks = [defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.audit',
    name: t('记录'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-audit' },
    isolation: 'inline',
    size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
    inputs: { queries: ['records.query', 'risk.denials', 'ledger.trace', 'ledger.query', 'account.list', 'agentkey.list', 'proposal.list'] },
    permissions: ['account.read', 'ledger.read'],
    actions: ['ledger.export'],
    linkGroups: [{ group: 'account', mode: 'readwrite' }, { group: 'symbol', mode: 'readwrite' }, { group: 'timeRange', mode: 'readwrite' }],
    fixtures: ['./fixtures/records.ts'],
  },
  component: RecordsPage,
})]
