// SPDX-License-Identifier: CPAL-1.0
// 记录校验器：字段齐全与类型、十进制文本、数量必须为正、档位排序与去重、盘口不许交叉、时间戳单调、
// 序号一致且单调，最后把整串记录真跑一遍盘口（增量必须命中已有档位）。
//
// 设计参照：nautilus_trader crates/model/src/data/order.rs@55c0e820（增量四种动作各自的字段要求）与
// crates/model/src/orderbook/book.rs@55c0e820（档位按价格排序、买一必须低于卖一）。检查清单是本包按自己的
// JSONL 形状列的，没有移植参照的校验器代码。
import { ZERO, type Fx } from '@gitrader/protocol/decimal'
import { MarketBook } from './book'
import { isDecimalText, parseDecimal } from './num'
import { parseJsonLine } from './records'
import type { AggressorSide, BookSide, DeltaAction, LevelTuple, MarketRecord } from './types'

export type IssueCode =
  | 'bad_json'
  | 'bad_record'
  | 'bad_field'
  | 'bad_decimal'
  | 'non_positive_size'
  | 'unsorted_levels'
  | 'duplicate_price'
  | 'crossed_book'
  | 'ts_not_monotonic'
  | 'seq_inconsistent'
  | 'seq_not_monotonic'
  | 'level_conflict'

export interface ValidationIssue {
  line: number
  code: IssueCode
  message: string
  field?: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationIssue[]
  records: MarketRecord[]
}

export interface ValidateOptions {
  /** 默认 true：结构检查通过后把记录真跑一遍盘口，抓交叉盘口与增量命中不存在的档位。 */
  strictBook?: boolean
}

const SIDES: readonly BookSide[] = ['bid', 'ask']
const ACTIONS: readonly DeltaAction[] = ['add', 'update', 'delete', 'clear']
const AGGRESSORS: readonly AggressorSide[] = ['buy', 'sell', 'unknown']

interface ParsedLine {
  record: MarketRecord
  line: number
}

/** 校验一整串 JSONL 文本（空行跳过，不算错误）。 */
export function validateJsonl(text: string, options: ValidateOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = []
  const parsed: ParsedLine[] = []
  const rawLines = text.split(/\r?\n/)

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? ''
    const line = index + 1
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = parseJsonLine(raw.trim())
    } catch (error) {
      errors.push({ line, code: 'bad_json', message: messageOf(error) })
      continue
    }
    const record = validateRecord(value, line, errors)
    if (record !== null) parsed.push({ record, line })
  }

  return finish(parsed, errors, options)
}

/** 校验已经解析好的记录数组（line 从 1 起，对应数组下标）。 */
export function validateRecords(values: readonly unknown[], options: ValidateOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = []
  const parsed: ParsedLine[] = []
  for (let index = 0; index < values.length; index += 1) {
    const record = validateRecord(values[index], index + 1, errors)
    if (record !== null) parsed.push({ record, line: index + 1 })
  }
  return finish(parsed, errors, options)
}

function finish(parsed: readonly ParsedLine[], errors: ValidationIssue[], options: ValidateOptions): ValidationResult {
  checkStream(parsed, errors)
  if (options.strictBook !== false && errors.length === 0) replayBook(parsed, errors)
  return { ok: errors.length === 0, errors, records: parsed.map((entry) => entry.record) }
}

/** 流级检查：ts 非递减；seq 一旦出现就必须全流都有且非递减。 */
function checkStream(parsed: readonly ParsedLine[], errors: ValidationIssue[]): void {
  let previousTs: number | undefined
  let previousSeq: number | undefined
  let seqCount = 0

  for (const { record, line } of parsed) {
    if (previousTs !== undefined && record.ts < previousTs) {
      errors.push({ line, code: 'ts_not_monotonic', field: 'ts', message: `ts ${record.ts} 小于上一条 ${previousTs}` })
    }
    previousTs = record.ts
    if (record.seq !== undefined) seqCount += 1
  }

  if (seqCount === 0) return
  if (seqCount !== parsed.length) {
    const missing = parsed.find((entry) => entry.record.seq === undefined)
    errors.push({
      line: missing?.line ?? 1,
      code: 'seq_inconsistent',
      field: 'seq',
      message: 'seq 一旦出现就必须每条记录都带',
    })
    return
  }
  for (const { record, line } of parsed) {
    if (record.seq === undefined) continue
    if (previousSeq !== undefined && record.seq < previousSeq) {
      errors.push({ line, code: 'seq_not_monotonic', field: 'seq', message: `seq ${record.seq} 小于上一条 ${previousSeq}` })
    }
    previousSeq = record.seq
  }
}

/** 把记录真跑一遍盘口：增量命中不存在的档位、交叉盘口都会在这里暴露。 */
function replayBook(parsed: readonly ParsedLine[], errors: ValidationIssue[]): void {
  const book = new MarketBook()
  for (const { record, line } of parsed) {
    try {
      book.apply(record)
    } catch (error) {
      const message = messageOf(error)
      errors.push({ line, code: message.includes('交叉') ? 'crossed_book' : 'level_conflict', message })
      return // 盘口已经跑不下去，后续记录不再回放，避免连锁报错
    }
  }
}

// ---- 单条记录 --------------------------------------------------------------------------------

function validateRecord(value: unknown, line: number, errors: ValidationIssue[]): MarketRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push({ line, code: 'bad_record', message: '记录必须是 JSON 对象' })
    return null
  }
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (type !== 'book_snapshot' && type !== 'book_delta' && type !== 'trade') {
    errors.push({ line, code: 'bad_field', field: 'type', message: `未知记录类型：${String(type)}` })
    return null
  }

  const ts = checkInteger(obj, 'ts', line, errors)
  const instrument = checkString(obj, 'instrument', line, errors)
  let seq: number | undefined
  if (obj.seq !== undefined) {
    const parsedSeq = checkInteger(obj, 'seq', line, errors)
    if (parsedSeq === null) return null
    seq = parsedSeq
  }
  if (ts === null || instrument === null) return null
  const base: { ts: number; instrument: string; seq?: number } =
    seq === undefined ? { ts, instrument } : { ts, seq, instrument }

  if (type === 'book_snapshot') {
    const bids = checkLevels(obj.bids, 'bids', 'bid', line, errors)
    const asks = checkLevels(obj.asks, 'asks', 'ask', line, errors)
    if (bids === null || asks === null) return null
    const bestBid = bids[0]
    const bestAsk = asks[0]
    if (bestBid !== undefined && bestAsk !== undefined) {
      const bid = parseDecimal(bestBid[0], 'bids[0][0]')
      const ask = parseDecimal(bestAsk[0], 'asks[0][0]')
      if (bid >= ask) {
        errors.push({ line, code: 'crossed_book', message: `盘口交叉：买一 ${bestBid[0]} ≥ 卖一 ${bestAsk[0]}` })
        return null
      }
    }
    return { type, ...base, bids, asks }
  }

  if (type === 'book_delta') {
    const side = obj.side
    if (!SIDES.includes(side as BookSide)) {
      errors.push({ line, code: 'bad_field', field: 'side', message: `未知档位方向：${String(side)}` })
      return null
    }
    const action = obj.action
    if (!ACTIONS.includes(action as DeltaAction)) {
      errors.push({ line, code: 'bad_field', field: 'action', message: `未知增量动作：${String(action)}` })
      return null
    }
    const act = action as DeltaAction
    const needsPrice = act !== 'clear'
    const needsSize = act === 'add' || act === 'update'

    let price: string | undefined
    if (needsPrice) {
      price = checkDecimal(obj, 'price', line, errors, 'positive')
      if (price === undefined) return null
    } else if (obj.price !== undefined) {
      errors.push({ line, code: 'bad_field', field: 'price', message: 'clear 不许带 price' })
      return null
    }

    let size: string | undefined
    if (needsSize) {
      size = checkDecimal(obj, 'size', line, errors, 'positive')
      if (size === undefined) return null
    } else if (obj.size !== undefined) {
      errors.push({ line, code: 'bad_field', field: 'size', message: `${act} 不许带 size` })
      return null
    }

    return {
      type,
      ...base,
      side: side as BookSide,
      action: act,
      ...(price === undefined ? {} : { price }),
      ...(size === undefined ? {} : { size }),
    }
  }

  const price = checkDecimal(obj, 'price', line, errors, 'positive')
  const size = checkDecimal(obj, 'size', line, errors, 'positive')
  if (price === undefined || size === undefined) return null

  let aggressor: AggressorSide | undefined
  if (obj.aggressor !== undefined) {
    if (!AGGRESSORS.includes(obj.aggressor as AggressorSide)) {
      errors.push({ line, code: 'bad_field', field: 'aggressor', message: `未知主动方向：${String(obj.aggressor)}` })
      return null
    }
    aggressor = obj.aggressor as AggressorSide
  }
  const tradeId = obj.tradeId === undefined ? undefined : checkString(obj, 'tradeId', line, errors)
  if (obj.tradeId !== undefined && tradeId === null) return null

  return {
    type,
    ...base,
    price,
    size,
    ...(aggressor === undefined ? {} : { aggressor }),
    ...(tradeId === undefined || tradeId === null ? {} : { tradeId }),
  }
}

function checkLevels(
  value: unknown,
  field: string,
  side: BookSide,
  line: number,
  errors: ValidationIssue[],
): LevelTuple[] | null {
  if (!Array.isArray(value)) {
    errors.push({ line, code: 'bad_field', field, message: `${field} 必须是档位数组` })
    return null
  }
  const out: LevelTuple[] = []
  const seen = new Set<string>()
  let previousPrice: Fx | undefined
  let broken = false

  for (let index = 0; index < value.length; index += 1) {
    const tuple = value[index]
    if (!Array.isArray(tuple) || tuple.length !== 2) {
      errors.push({ line, code: 'bad_field', field: `${field}[${index}]`, message: '档位必须是 [price, size] 二元组' })
      broken = true
      continue
    }
    const rawPrice = tuple[0]
    const rawSize = tuple[1]
    if (typeof rawPrice !== 'string' || !isDecimalText(rawPrice)) {
      errors.push({ line, code: 'bad_decimal', field: `${field}[${index}][0]`, message: `价格不是十进制文本：${JSON.stringify(rawPrice)}` })
      broken = true
      continue
    }
    if (typeof rawSize !== 'string' || !isDecimalText(rawSize)) {
      errors.push({ line, code: 'bad_decimal', field: `${field}[${index}][1]`, message: `数量不是十进制文本：${JSON.stringify(rawSize)}` })
      broken = true
      continue
    }
    const price = parseDecimal(rawPrice, 'price')
    const size = parseDecimal(rawSize, 'size')
    if (price <= ZERO) {
      errors.push({ line, code: 'bad_decimal', field: `${field}[${index}][0]`, message: `价格必须为正：${rawPrice}` })
      broken = true
      continue
    }
    if (size <= ZERO) {
      errors.push({ line, code: 'non_positive_size', field: `${field}[${index}][1]`, message: `数量必须为正：${rawSize}` })
      broken = true
      continue
    }
    const key = price.toString()
    if (seen.has(key)) {
      errors.push({ line, code: 'duplicate_price', field, message: `${field} 有重复档位：${rawPrice}` })
      broken = true
      continue
    }
    seen.add(key)
    if (previousPrice !== undefined) {
      const ordered = side === 'bid' ? previousPrice > price : previousPrice < price
      if (!ordered) {
        errors.push({ line, code: 'unsorted_levels', field, message: `${field} 档位顺序不对：${rawPrice} 跟在 ${previousPrice.toString()} 之后` })
        broken = true
      }
    }
    previousPrice = price
    out.push([rawPrice, rawSize])
  }

  return broken ? null : out
}

function checkInteger(obj: Record<string, unknown>, field: string, line: number, errors: ValidationIssue[]): number | null {
  const value = obj[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push({ line, code: 'bad_field', field, message: `${field} 必须是非负整数：${JSON.stringify(value)}` })
    return null
  }
  return value
}

function checkString(obj: Record<string, unknown>, field: string, line: number, errors: ValidationIssue[]): string | null {
  const value = obj[field]
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ line, code: 'bad_field', field, message: `${field} 必须是非空字符串：${JSON.stringify(value)}` })
    return null
  }
  return value
}

function checkDecimal(
  obj: Record<string, unknown>,
  field: string,
  line: number,
  errors: ValidationIssue[],
  requirement: 'positive',
): string | undefined {
  const value = obj[field]
  if (typeof value !== 'string' || !isDecimalText(value)) {
    errors.push({ line, code: 'bad_decimal', field, message: `${field} 必须是十进制文本：${JSON.stringify(value)}` })
    return undefined
  }
  const parsed = parseDecimal(value, field)
  if (requirement === 'positive' && parsed <= ZERO) {
    // 数量为 0 / 负数是「量」的问题；价格非正则归到十进制字段问题。
    const code: IssueCode = field === 'size' ? 'non_positive_size' : 'bad_decimal'
    errors.push({ line, code, field, message: `${field} 必须为正：${value}` })
    return undefined
  }
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
