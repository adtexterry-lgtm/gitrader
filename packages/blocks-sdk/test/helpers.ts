// SPDX-License-Identifier: Apache-2.0
import type { BlockManifest } from '../src'

export const good = (over: Partial<BlockManifest> = {}): BlockManifest => ({
  schema: 'gitrader-block/1',
  id: 'block.gitrader.chart',
  name: '图表',
  version: '0.1.0',
  vendor: { name: 'gitrader' },
  license: 'Apache-2.0',
  entry: { module: './chart.js', element: 'gr-chart' },
  isolation: 'inline',
  size: { minW: 6, minH: 6, defaultW: 15, defaultH: 17 },
  inputs: { events: [{ topic: 'market.candles', maxHz: 4 }, { topic: 'market.quote', maxHz: 10 }], queries: ['market.candles'] },
  actions: ['order.place', 'workspace.*'],
  permissions: ['market.read', 'workspace.control'],
  linkGroups: [{ group: 'symbol', mode: 'readwrite' }],
  fixtures: ['./fixtures/chart.json'],
  ...over,
})

