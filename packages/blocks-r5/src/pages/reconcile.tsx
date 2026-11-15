// SPDX-License-Identifier: CPAL-1.0
import { defineBlock } from '@gitrader/blocks-sdk'
import { ReconcileView } from '../views/reconcile'
import { t } from '@gitrader/workbench/i18n'

export const reconcileBlocks = [defineBlock({
  manifest: {
    schema: 'gitrader-block/1', id: 'block.gitrader.reconcile', name: t('对账'), version: '0.1.0',
    vendor: { name: 'gitrader' }, license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-reconcile' }, isolation: 'inline',
    size: { minW: 1, minH: 1, defaultW: 24, defaultH: 12 },
    inputs: { events: [{ topic: 'reconciliation.updated' }], queries: ['account.list', 'reconcile.status'] },
    permissions: ['account.read', 'takeover.trigger'], actions: ['reconcile.refresh', 'reconcile.resolve'],
    fixtures: ['./fixtures/overview.ts'],
  },
  component: ReconcileView,
})]
