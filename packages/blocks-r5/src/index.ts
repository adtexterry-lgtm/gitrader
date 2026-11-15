// SPDX-License-Identifier: CPAL-1.0
import type { BlockDefinition } from '@gitrader/blocks-sdk'
import { overviewBlocks } from './pages/overview'
import { chartBlocks } from './pages/chart'
import { recordsBlocks } from './pages/records'
import { fundsBlocks } from './pages/funds'
import { pluginsBlocks } from './pages/plugins'
import { strategiesBlocks } from './pages/strategies'
import { labBlocks } from './pages/lab'
import { labDetailBlocks } from './pages/lab-detail'
import { venuesBlocks } from './pages/venues'
import { notifyBlocks } from './pages/notify'
import { reconcileBlocks } from './pages/reconcile'

export { overviewBlocks, chartBlocks, recordsBlocks, fundsBlocks, pluginsBlocks, strategiesBlocks, labBlocks, labDetailBlocks, venuesBlocks, notifyBlocks, reconcileBlocks }
export const r5Blocks: BlockDefinition[] = [
  ...overviewBlocks, ...chartBlocks, ...recordsBlocks, ...fundsBlocks, ...pluginsBlocks,
  ...strategiesBlocks, ...labBlocks, ...labDetailBlocks, ...venuesBlocks, ...notifyBlocks, ...reconcileBlocks,
]
