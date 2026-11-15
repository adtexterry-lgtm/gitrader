// SPDX-License-Identifier: CPAL-1.0
// 既有口径常量：只读 docs/perf-baseline.md（M1 / 2026-10-10 / v3），把要对齐的数字抄成常量，
// 让本脚本的输出能并排展示「既有 v3」与「本次复测」。docs/perf-baseline.md 本身不改。
//
// 出处（docs/perf-baseline.md 行号，2026-10-21 读）：
//  · 第 4 行：除注明外报 p50 / p95；首次与热启分开；全部离线。
//  · 第 9 行：硬件基线 Intel Core Ultra 9 275HX（24 逻辑核）/ 63 GB / Windows 11 / Node 22.23.2。
//  · 第 26 行：回测吞吐（52.56 万根 1m，同步核心）v1 202–439 万根 / 秒；「建议 N = 100 万」。
//    这个区间出自 bench/engine/run.mjs（五策略、anchor 后的参数、含首次的各轮中位数），
//    而本脚本报热启 p50，两边只能同机同代码作参考并排，不是同一个统计量。

export const PERF_BASELINE = Object.freeze({
  doc: 'docs/perf-baseline.md',
  revision: 'M1 v3（2026-10-10）',
  hardware: 'Intel Core Ultra 9 275HX（24 逻辑核）/ 63 GB / Windows 11 / Node 22.23.2',
  /** 第 26 行：v1 实测区间，单位为「根 / 秒」；统计量是 bench/engine 的全轮中位数（含首次），本脚本报热启 p50。 */
  backtestThroughputBarsPerSec: Object.freeze({ min: 2_020_000, max: 4_390_000, bars: 525_600, note: '52.56 万根 1m，同步核心，引擎未改后沿用' }),
  /** 第 26 行结论：建议门槛。 */
  suggestedBarsPerSec: 1_000_000,
  /** 口径提醒，写进 Markdown 抬头，避免被当成营销数字。 */
  caveats: Object.freeze([
    '除注明外报 p50 / p95，不用平均值',
    '首次（首次执行，含 JIT 预热）与热启（其后各轮）分开报',
    '全部离线：合成 K 线，不含网络与场所处理时间',
    '同机同脚本才可比；跨机只比数量级',
    '合成数据上的收益 / 成交数字没有任何意义，只用来量速度',
  ]),
})
