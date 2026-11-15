// SPDX-License-Identifier: CPAL-1.0
// Gitrader 默认块（M1 最小检阅版的三块 + 状态条）。壳按同 id 覆盖自带的占位块；块只经桥收发，不直连内核。
import type { BlockDefinition } from '@gitrader/blocks-sdk'
import './blocks.css'
import { agentActivityBlock } from './agent-activity'
import { positionsBlock } from './positions'
import { riskBlock } from './risk'
import { statusBarBlock } from './statusbar'

export { positionsBlock, agentActivityBlock, riskBlock, statusBarBlock }

/** 壳加载的默认块清单（registry.jsx 读取这个名字）。 */
export const defaultBlocks: BlockDefinition[] = [positionsBlock, agentActivityBlock, riskBlock, statusBarBlock]
