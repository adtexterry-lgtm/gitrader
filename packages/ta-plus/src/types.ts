// SPDX-License-Identifier: CPAL-1.0
// 共用类型：与 packages/engine-core/src/strategy/ta/types.ts 同形，转发同口径指标时可直接互传（结构等价）。
// 批 9 收尾：同口径同值的 5 个指标改为转发 engine-core 的实现（按相对路径只读引用，不修改 engine-core，
//             也没有把本包并入内核——主会话已裁定保持独立包）。
// 约定：输出与输入等长；指标尚未可算的位置为 null；第 i 项只用 ≤ i 的数据（因果）。
export interface Bar { t?: number; o: number; h: number; l: number; c: number; v: number }
/** 与输入等长；指标尚未可算的位置为 null。 */
export type Series = Array<number | null>
