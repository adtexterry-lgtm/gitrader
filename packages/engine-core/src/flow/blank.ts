// SPDX-License-Identifier: CPAL-1.0
// 空白工作流骨架：能通过校验、能回测，但没有任何交易逻辑（信号机的所有条件都没接，目标恒为 0）。
// 给 Agent 当起点：往里加指标 / 条件节点，把条件接到信号机的 enterLong / enterShort / exit 上。
import type { Workflow } from './types'

export const BLANK_WORKFLOW: Workflow = {
  schema: 'gitrader-workflow/2',
  id: 'my-workflow',
  name: 'My workflow',
  desc: 'Blank skeleton: candles -> signal machine -> output signal. Add indicator and condition nodes and wire them into the signal machine inputs.',
  version: 1,
  params: {},
  nodes: [
    { id: 'k', type: 'data.candles', params: {}, label: 'Candles', position: { x: 20, y: 80 } },
    { id: 'sig', type: 'sig.state', params: { mode: 'latch', allowShort: true }, label: 'Signal machine', position: { x: 360, y: 80 } },
    { id: 'out_signal', type: 'act.signal', params: {}, label: 'Output signal', position: { x: 640, y: 80 } },
  ],
  edges: [{ from: { node: 'sig', port: 'signal' }, to: { node: 'out_signal', port: 'signal' } }],
  meta: { source: { author: 'you', license: 'Apache-2.0' }, tags: [] },
}
