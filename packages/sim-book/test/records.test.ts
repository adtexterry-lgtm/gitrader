// SPDX-License-Identifier: CPAL-1.0
// 记录序列化与 JSONL / .gz 读写的往返测试。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  formatJsonl,
  formatRecord,
  parseJsonLine,
  readJsonlText,
  writeJsonlFile,
} from '../src'
import type { MarketRecord } from '../src'

const dir = mkdtempSync(join(tmpdir(), 'sim-book-records-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const snapshot: MarketRecord = {
  type: 'book_snapshot',
  ts: 1000,
  seq: 1,
  instrument: 'BTCUSDT',
  bids: [['100.5', '2'], ['100', '3']],
  asks: [['101', '1.5']],
}

const delta: MarketRecord = { type: 'book_delta', ts: 1001, seq: 2, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '101.5', size: '0.5' }

const trade: MarketRecord = { type: 'trade', ts: 1002, seq: 3, instrument: 'BTCUSDT', price: '101', size: '0.25', aggressor: 'buy', tradeId: 't-1' }

describe('formatRecord', () => {
  it('快照按固定键顺序序列化（type, ts, seq, instrument, bids, asks）', () => {
    expect(formatRecord(snapshot)).toBe(
      '{"type":"book_snapshot","ts":1000,"seq":1,"instrument":"BTCUSDT","bids":[["100.5","2"],["100","3"]],"asks":[["101","1.5"]]}',
    )
  })

  it('clear 增量不带 price / size', () => {
    expect(formatRecord({ type: 'book_delta', ts: 1003, instrument: 'BTCUSDT', side: 'bid', action: 'clear' })).toBe(
      '{"type":"book_delta","ts":1003,"instrument":"BTCUSDT","side":"bid","action":"clear"}',
    )
  })

  it('delete 增量只带 price', () => {
    expect(formatRecord({ type: 'book_delta', ts: 1004, instrument: 'BTCUSDT', side: 'bid', action: 'delete', price: '100' })).toBe(
      '{"type":"book_delta","ts":1004,"instrument":"BTCUSDT","side":"bid","action":"delete","price":"100"}',
    )
  })

  it('逐笔成交带主动方向与成交号', () => {
    expect(formatRecord(trade)).toBe(
      '{"type":"trade","ts":1002,"seq":3,"instrument":"BTCUSDT","price":"101","size":"0.25","aggressor":"buy","tradeId":"t-1"}',
    )
  })

  it('没有 seq 的记录不写 seq 键', () => {
    const text = formatRecord({ type: 'trade', ts: 1, instrument: 'X', price: '1', size: '1' })
    expect(text.includes('seq')).toBe(false)
    expect(JSON.parse(text)).toEqual({ type: 'trade', ts: 1, instrument: 'X', price: '1', size: '1' })
  })
})

describe('formatJsonl / parseJsonLine', () => {
  it('多条记录一行一条，末尾带换行', () => {
    const text = formatJsonl([snapshot, delta, trade])
    expect(text.split('\n')).toHaveLength(4)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('空数组得到空串', () => {
    expect(formatJsonl([])).toBe('')
  })

  it('序列化后再解析得到同一条记录（往返一致）', () => {
    for (const record of [snapshot, delta, trade]) {
      expect(parseJsonLine(formatRecord(record))).toEqual(record)
    }
  })

  it('坏 JSON 抛 SyntaxError 且带原文片段', () => {
    expect(() => parseJsonLine('{"type":')).toThrow(SyntaxError)
    expect(() => parseJsonLine('{"type":')).toThrow(/"type"/)
  })
})

describe('文件读写', () => {
  it('.jsonl 写读往返', () => {
    const path = join(dir, 'book.jsonl')
    const bytes = writeJsonlFile(path, [snapshot, delta, trade])
    expect(bytes).toBeGreaterThan(0)
    expect(readJsonlText(path)).toBe(formatJsonl([snapshot, delta, trade]))
  })

  it('.gz 写出的文件带 gzip 魔数，读回是原文', () => {
    const path = join(dir, 'book.jsonl.gz')
    writeJsonlFile(path, [snapshot, delta, trade])
    const head = readFileSync(path)
    expect(head[0]).toBe(0x1f)
    expect(head[1]).toBe(0x8b)
    expect(readJsonlText(path)).toBe(formatJsonl([snapshot, delta, trade]))
  })

  it('读回的文本能被 parseJsonLine 逐行解析成三条记录', () => {
    const path = join(dir, 'round.jsonl.gz')
    writeJsonlFile(path, [snapshot, delta, trade])
    const lines = readJsonlText(path).trimEnd().split('\n')
    expect(lines.map((line) => parseJsonLine(line))).toEqual([snapshot, delta, trade])
  })
})
