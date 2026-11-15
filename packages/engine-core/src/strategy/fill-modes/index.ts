// SPDX-License-Identifier: CPAL-1.0
// 成交模式的对外入口。回测（simulator.ts / backtest.ts）只从这里取类型与 'book' 模式的实现。
//
// 'bar' 模式没有单独的模块：它就是 simulator.ts 里原有的那段 next-bar-open 撮合，
// 缺省路径一个字节都不改（金标夹具 test/fixtures/fill-mode-golden.bar.json 逐字节比对守这条线）。
export { BookFiller } from './book'
export type { BookFillerOptions } from './book'
export { toDecimalText } from './num'
export { FILL_MODES, FillModeError } from './types'
// 盘口记录的形状由 sim-book 定义，这里转出去，调用方不必直接依赖 sim-book 的内部路径
export type { MarketRecord, SnapshotRecord, DeltaRecord, TradeRecord, OrderReport } from '../../../../sim-book/src/index'
export type { BookExecution, BookFeed, FillMode, FillModeErrorCode } from './types'
