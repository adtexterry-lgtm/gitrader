// SPDX-License-Identifier: CPAL-1.0
// 校验器：字段、十进制语法、正数量、档位排序与去重、盘口交叉、时间戳 / 序号单调，逐条造坏记录断言原因码。
import { describe, expect, it } from 'vitest'
import { validateJsonl, validateRecords } from '../src'

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

const SNAPSHOT = {
  type: 'book_snapshot',
  ts: 1000,
  instrument: 'BTCUSDT',
  bids: [['100', '2']],
  asks: [['101', '2']],
}

function snapshotWith(over: Record<string, unknown>): string {
  return line({ ...SNAPSHOT, ...over })
}

describe('validateJsonl 正常路径', () => {
  it('快照 + 增量 + 成交三条记录全部通过', () => {
    const text = [
      snapshotWith({}),
      line({ type: 'book_delta', ts: 1001, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '102', size: '1' }),
      line({ type: 'trade', ts: 1002, instrument: 'BTCUSDT', price: '101', size: '0.5', aggressor: 'buy' }),
    ].join('\n')
    const result = validateJsonl(text)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.records).toHaveLength(3)
  })

  it('空行跳过，不算错误', () => {
    const result = validateJsonl(`\n${snapshotWith({})}\n\n`)
    expect(result.ok).toBe(true)
    expect(result.records).toHaveLength(1)
  })

  it('ts 相同不算倒退（同一时刻多条记录合法）', () => {
    const text = [snapshotWith({}), line({ type: 'trade', ts: 1000, instrument: 'BTCUSDT', price: '101', size: '1' })].join('\n')
    expect(validateJsonl(text).ok).toBe(true)
  })

  it('序号一致且非递减时通过', () => {
    const text = [
      snapshotWith({ seq: 1 }),
      line({ type: 'trade', ts: 1001, seq: 1, instrument: 'BTCUSDT', price: '101', size: '1' }),
    ].join('\n')
    expect(validateJsonl(text).ok).toBe(true)
  })

  it('返回的记录已按类型收窄（可直接喂盘口）', () => {
    const result = validateJsonl(snapshotWith({}))
    const record = result.records[0]
    expect(record?.type).toBe('book_snapshot')
    if (record?.type === 'book_snapshot') expect(record.bids).toEqual([['100', '2']])
  })
})

describe('validateJsonl 结构与语法', () => {
  it('坏 JSON 报 bad_json，行号指向坏行', () => {
    const result = validateJsonl([snapshotWith({}), '{"type":'].join('\n'))
    expect(result.errors[0]?.code).toBe('bad_json')
    expect(result.errors[0]?.line).toBe(2)
  })

  it('未知记录类型报 bad_field', () => {
    const result = validateJsonl(line({ type: 'tick', ts: 1, instrument: 'X' }))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('type')
  })

  it('记录不是对象时报 bad_record', () => {
    expect(validateJsonl('[1,2,3]').errors[0]?.code).toBe('bad_record')
  })

  it('缺 instrument 报 bad_field', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, price: '1', size: '1' }))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('instrument')
  })

  it('ts 为负数报 bad_field', () => {
    expect(validateJsonl(snapshotWith({ ts: -1 })).errors[0]?.code).toBe('bad_field')
  })

  it('ts 不是整数报 bad_field', () => {
    expect(validateJsonl(snapshotWith({ ts: 1.5 })).errors[0]?.code).toBe('bad_field')
  })

  it('数量为负报 non_positive_size', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'X', price: '1', size: '-0.5' }))
    expect(result.errors[0]?.code).toBe('non_positive_size')
  })

  it('数量为 0 报 non_positive_size', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'X', price: '1', size: '0' }))
    expect(result.errors[0]?.code).toBe('non_positive_size')
  })

  it('价格为 0 报 bad_decimal', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'X', price: '0', size: '1' }))
    expect(result.errors[0]?.code).toBe('bad_decimal')
  })

  it('价格写成指数形式报 bad_decimal', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'X', price: '1e-8', size: '1' }))
    expect(result.errors[0]?.code).toBe('bad_decimal')
  })

  it('价格写成 JSON 数字（不是文本）报 bad_decimal', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'X', price: 1, size: '1' }))
    expect(result.errors[0]?.code).toBe('bad_decimal')
  })

  it('档位不是二元组报 bad_field', () => {
    const result = validateJsonl(snapshotWith({ bids: [['100', '1', 'extra']] }))
    expect(result.errors[0]?.code).toBe('bad_field')
  })

  it('买档升序报 unsorted_levels', () => {
    const result = validateJsonl(snapshotWith({ bids: [['100', '1'], ['101', '1']] }))
    expect(result.errors[0]?.code).toBe('unsorted_levels')
  })

  it('卖档降序报 unsorted_levels', () => {
    const result = validateJsonl(snapshotWith({ asks: [['102', '1'], ['101', '1']] }))
    expect(result.errors[0]?.code).toBe('unsorted_levels')
  })

  it('重复档位报 duplicate_price', () => {
    const result = validateJsonl(snapshotWith({ bids: [['100', '1'], ['100.0', '1']] }))
    expect(result.errors[0]?.code).toBe('duplicate_price')
  })

  it('盘口交叉报 crossed_book', () => {
    const result = validateJsonl(snapshotWith({ bids: [['101', '1']], asks: [['101', '1']] }))
    expect(result.errors[0]?.code).toBe('crossed_book')
  })
})

describe('validateJsonl 流级检查', () => {
  it('ts 倒退报 ts_not_monotonic', () => {
    const text = [snapshotWith({ ts: 1000 }), line({ type: 'trade', ts: 999, instrument: 'BTCUSDT', price: '101', size: '1' })].join('\n')
    const result = validateJsonl(text)
    expect(result.errors[0]?.code).toBe('ts_not_monotonic')
    expect(result.errors[0]?.line).toBe(2)
  })

  it('seq 条数不一致报 seq_inconsistent', () => {
    const text = [snapshotWith({ seq: 1 }), line({ type: 'trade', ts: 1001, instrument: 'BTCUSDT', price: '101', size: '1' })].join('\n')
    expect(validateJsonl(text).errors[0]?.code).toBe('seq_inconsistent')
  })

  it('seq 倒退报 seq_not_monotonic', () => {
    const text = [
      snapshotWith({ seq: 5 }),
      line({ type: 'trade', ts: 1001, seq: 4, instrument: 'BTCUSDT', price: '101', size: '1' }),
    ].join('\n')
    expect(validateJsonl(text).errors[0]?.code).toBe('seq_not_monotonic')
  })
})

describe('validateJsonl 增量字段要求', () => {
  it('delete 带 size 报 bad_field', () => {
    const result = validateJsonl([
      snapshotWith({}),
      line({ type: 'book_delta', ts: 1001, instrument: 'BTCUSDT', side: 'bid', action: 'delete', price: '100', size: '1' }),
    ].join('\n'))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('size')
  })

  it('clear 带 price 报 bad_field', () => {
    const result = validateJsonl([
      snapshotWith({}),
      line({ type: 'book_delta', ts: 1001, instrument: 'BTCUSDT', side: 'bid', action: 'clear', price: '100' }),
    ].join('\n'))
    expect(result.errors[0]?.code).toBe('bad_field')
  })

  it('update 不存在的档位报 level_conflict（真跑一遍盘口）', () => {
    const result = validateJsonl([
      snapshotWith({}),
      line({ type: 'book_delta', ts: 1001, instrument: 'BTCUSDT', side: 'bid', action: 'update', price: '99', size: '1' }),
    ].join('\n'))
    expect(result.errors[0]?.code).toBe('level_conflict')
  })

  it('strictBook: false 时只做结构校验', () => {
    const text = [
      snapshotWith({}),
      line({ type: 'book_delta', ts: 1001, instrument: 'BTCUSDT', side: 'bid', action: 'update', price: '99', size: '1' }),
    ].join('\n')
    expect(validateJsonl(text, { strictBook: false }).ok).toBe(true)
  })

  it('合法的 add / update / delete 序列通过', () => {
    const text = [
      snapshotWith({}),
      line({ type: 'book_delta', ts: 1001, instrument: 'BTCUSDT', side: 'bid', action: 'add', price: '99', size: '1' }),
      line({ type: 'book_delta', ts: 1002, instrument: 'BTCUSDT', side: 'bid', action: 'update', price: '99', size: '2' }),
      line({ type: 'book_delta', ts: 1003, instrument: 'BTCUSDT', side: 'bid', action: 'delete', price: '99' }),
    ].join('\n')
    const result = validateJsonl(text)
    expect(result.errors).toEqual([])
    expect(result.records).toHaveLength(4)
  })

  it('未知主动方向报 bad_field', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'X', price: '1', size: '1', aggressor: 'both' }))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('aggressor')
  })
})

describe('validateJsonl 坏记录（每类一条）', () => {
  it('缺 ts 报 bad_field', () => {
    const result = validateJsonl(line({ type: 'book_snapshot', instrument: 'BTCUSDT', bids: [['100', '2']], asks: [['101', '2']] }))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('ts')
  })

  it('快照缺 bids 报 bad_field', () => {
    const result = validateJsonl(line({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', asks: [['101', '2']] }))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('bids')
  })

  it('快照缺 asks 报 bad_field', () => {
    const result = validateJsonl(line({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', bids: [['100', '2']] }))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('asks')
  })

  it('增量缺 side 报 bad_field', () => {
    const result = validateJsonl(
      line({ type: 'book_delta', ts: 1, instrument: 'BTCUSDT', action: 'add', price: '100', size: '1' }),
    )
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('side')
  })

  it('增量缺 action 报 bad_field', () => {
    const result = validateJsonl(line({ type: 'book_delta', ts: 1, instrument: 'BTCUSDT', side: 'bid', price: '100', size: '1' }))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('action')
  })

  it('成交缺 price 报 bad_decimal', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'BTCUSDT', size: '1' }))
    expect(result.errors[0]?.code).toBe('bad_decimal')
    expect(result.errors[0]?.field).toBe('price')
  })

  it('成交缺 size 报 bad_decimal', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'BTCUSDT', price: '101' }))
    expect(result.errors[0]?.code).toBe('bad_decimal')
    expect(result.errors[0]?.field).toBe('size')
  })

  it('clear 带 size 报 bad_field', () => {
    const result = validateJsonl([
      snapshotWith({}),
      line({ type: 'book_delta', ts: 1001, instrument: 'BTCUSDT', side: 'bid', action: 'clear', size: '1' }),
    ].join('\n'))
    expect(result.errors[0]?.code).toBe('bad_field')
    expect(result.errors[0]?.field).toBe('size')
  })

  it('数量带正号（+1）报 bad_decimal', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'BTCUSDT', price: '101', size: '+1' }))
    expect(result.errors[0]?.code).toBe('bad_decimal')
    expect(result.errors[0]?.field).toBe('size')
  })

  it('数量带前导零（01）报 bad_decimal', () => {
    const result = validateJsonl(line({ type: 'trade', ts: 1, instrument: 'BTCUSDT', price: '101', size: '01' }))
    expect(result.errors[0]?.code).toBe('bad_decimal')
    expect(result.errors[0]?.field).toBe('size')
  })

  it('档位数量为 0 报 non_positive_size', () => {
    const result = validateJsonl(snapshotWith({ asks: [['101', '0']] }))
    expect(result.errors[0]?.code).toBe('non_positive_size')
    expect(result.errors[0]?.field).toBe('asks[0][1]')
  })

  it('交叉快照（买一 > 卖一）报 crossed_book', () => {
    const result = validateJsonl(snapshotWith({ bids: [['102', '1']], asks: [['101', '1']] }))
    expect(result.errors[0]?.code).toBe('crossed_book')
  })
})

describe('validateRecords', () => {
  it('已解析的数组按 1 起行号报错', () => {
    const result = validateRecords([SNAPSHOT, { type: 'trade', ts: 1001, instrument: 'BTCUSDT', price: '101', size: '1' }])
    expect(result.ok).toBe(true)
    expect(result.records).toHaveLength(2)
  })

  it('数组里出现坏对象时报 bad_record 且行号对应下标 +1', () => {
    const result = validateRecords([SNAPSHOT, 'oops'])
    expect(result.errors[0]?.code).toBe('bad_record')
    expect(result.errors[0]?.line).toBe(2)
  })
})
