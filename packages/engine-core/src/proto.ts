// SPDX-License-Identifier: CPAL-1.0
// 对 @gitrader/protocol 的唯一入口：引擎其余文件只从这里取协议类型与常量。
// TODO(protocol): packages/protocol/src/index.ts 目前是 `export {}`；等 A 接线后改成 `export * from '@gitrader/protocol'`。
export * from '../../protocol/src/model/index'
export * from '../../protocol/src/gep/index'
export * from '../../protocol/src/agent/index'
export * from '../../protocol/src/experiment'
export { candlesDigest as protocolCandlesDigest } from '../../protocol/src/experiment/candles-digest'
// L4-04：显式导出同名实现会盖住上面 `export *` 的版本（ESM：显式导出优先于星号导出）。
// 协议包的 checkEventSequence 假定输入已过 schema，对畸形事件会抛 TypeError（FINDINGS-L1 L1-11）；
// 这里换成本包出口处的形状门版本，行为与其文档"返回问题列表"一致。
export { checkEventSequence } from './gep/events'
