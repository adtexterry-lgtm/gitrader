// SPDX-License-Identifier: CPAL-1.0
// JSONL 记录的形状与读写：一行一条记录，.gz 后缀自动压缩 / 解压。这是本包唯一碰 I/O 的模块（撮合核心不碰）。
//
// 设计参照：nautilus_trader crates/model/src/data/order.rs@55c0e820（BookAction 的 add / update / delete / clear
// 与增量记录的字段语义）、crates/model/src/data/trade.rs@55c0e820（逐笔成交的 price / size / aggressor_side /
// trade_id / ts_event）。字段名与嵌套形状是本包自己的：扁平的 type 判别 + [价格, 数量] 档位二元组，未照抄参照的结构体。
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { MarketRecord } from './types'

/** 一条记录序列化成一行（键顺序固定：type, ts, seq, instrument, 其余按类型）。 */
export function formatRecord(record: MarketRecord): string {
  switch (record.type) {
    case 'book_snapshot':
      return JSON.stringify({
        type: record.type,
        ts: record.ts,
        ...(record.seq === undefined ? {} : { seq: record.seq }),
        instrument: record.instrument,
        bids: record.bids,
        asks: record.asks,
      })
    case 'book_delta':
      return JSON.stringify({
        type: record.type,
        ts: record.ts,
        ...(record.seq === undefined ? {} : { seq: record.seq }),
        instrument: record.instrument,
        side: record.side,
        action: record.action,
        ...(record.price === undefined ? {} : { price: record.price }),
        ...(record.size === undefined ? {} : { size: record.size }),
      })
    case 'trade':
      return JSON.stringify({
        type: record.type,
        ts: record.ts,
        ...(record.seq === undefined ? {} : { seq: record.seq }),
        instrument: record.instrument,
        price: record.price,
        size: record.size,
        ...(record.aggressor === undefined ? {} : { aggressor: record.aggressor }),
        ...(record.tradeId === undefined ? {} : { tradeId: record.tradeId }),
      })
  }
}

/** 整串 JSONL：每条一行，末尾带换行（空数组得到空串）。 */
export function formatJsonl(records: readonly MarketRecord[]): string {
  if (records.length === 0) return ''
  return `${records.map((record) => formatRecord(record)).join('\n')}\n`
}

/** 单行解析。语法错误抛 SyntaxError（带原始行片段）。 */
export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new SyntaxError(`JSON 解析失败：${reason}；原文：${line.slice(0, 120)}`)
  }
}

/** 读 JSONL 文本；路径以 .gz 结尾时先解压。 */
export function readJsonlText(path: string): string {
  const buffer = readFileSync(path)
  return path.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8')
}

/** 写 JSONL；路径以 .gz 结尾时压缩后写。返回写入字节数。 */
export function writeJsonlFile(path: string, records: readonly MarketRecord[]): number {
  const text = formatJsonl(records)
  const buffer = path.endsWith('.gz') ? gzipSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8')
  writeFileSync(path, buffer)
  return buffer.length
}
