// SPDX-License-Identifier: CPAL-1.0
// 技术指标库共用类型：K 线最小字段与「对齐输入、预热期为 null」的序列约定。因果：第 i 项只用 ≤ i 的数据。
export interface Bar { t?: number; o: number; h: number; l: number; c: number; v: number }
/** 与输入等长；指标尚未可算的位置为 null。 */
export type Series = Array<number | null>
