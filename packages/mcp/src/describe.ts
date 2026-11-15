// SPDX-License-Identifier: CPAL-1.0
// 工具描述 = 协议包的描述 + 本包追加的一句（下单类：结果未知时不要重发）。
// TODO(protocol)：把这一句并入协议包 `MCP_TOOLS` 的 order / propose 描述后，删掉本文件的追加表。总长仍须 ≤ 60 字（BUDGET 自检按追加后的长度算）。
import type { McpToolDef } from '@gitrader/protocol'

const ADDENDA: Readonly<Record<string, string>> = {
  order: '结果未知勿重发，先查单。',
  propose: '结果未知勿重发，先查单。',
}

export const toolDescription = (t: Pick<McpToolDef, 'name' | 'description'>): string => t.description + (ADDENDA[t.name] ?? '')
