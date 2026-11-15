// SPDX-License-Identifier: CPAL-1.0
// 参数解析与校验：只用纯函数，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTsShim } from '../lib/ts-shim.mjs'

await registerTsShim()
const { parseFetchArgs, instrumentIdOf, toMs, UsageError, DEFAULT_MAX_PAGES } = await import('../lib/options.mjs')
const { stepMs, INTERVALS } = await import('../lib/intervals.mjs')

const base = ['--venue', 'binance', '--instrument', 'BTCUSDT', '--interval', '1h', '--out', 'out/btc-1h.json']

test('解析必填参数：ISO 日期转毫秒，to 缺省取 now()', () => {
  const now = Date.parse('2024-02-01T00:00:00Z')
  const opts = parseFetchArgs([...base, '--from', '2024-01-01T00:00:00Z'], { now: () => now })
  assert.equal(opts.venue, 'binance')
  assert.equal(opts.instrumentId, 'binance:BTCUSDT')
  assert.equal(opts.interval, '1h')
  assert.equal(opts.from, Date.parse('2024-01-01T00:00:00Z'))
  assert.equal(opts.to, now)
  assert.equal(opts.maxPages, DEFAULT_MAX_PAGES)
  assert.equal(opts.out, 'out/btc-1h.json')
})

test('--key=value 写法与毫秒整数都接受', () => {
  const opts = parseFetchArgs([
    '--venue=okx', '--instrument=BTC-USDT-SWAP', '--interval=15m', '--from=1000', '--to=1000000', '--out=o.json', '--max-pages=7',
  ])
  assert.deepEqual([opts.from, opts.to, opts.maxPages], [1000, 1_000_000, 7])
  assert.equal(opts.instrumentId, 'okx:BTC-USDT-SWAP')
})

test('未知场所 / 未知周期 / 倒置区间 / 扩展名不对都拒', () => {
  const cases = [
    [['--venue', 'nope', '--instrument', 'X', '--interval', '1h', '--from', '1', '--out', 'a.json'], /unknown venue/],
    [['--venue', 'binance', '--instrument', 'X', '--interval', '7h', '--from', '1', '--out', 'a.json'], /unknown interval/],
    [['--venue', 'binance', '--instrument', 'X', '--interval', '1h', '--from', '10', '--to', '9', '--out', 'a.json'], /must be earlier/],
    [['--venue', 'binance', '--instrument', 'X', '--interval', '1h', '--from', '1', '--out', 'a.csv'], /must end with \.json/],
    [['--venue', 'binance', '--instrument', 'X', '--interval', '1h', '--from', '1', '--out', 'a.json', '--max-pages', '0'], /positive integer/],
  ]
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseFetchArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '))
  }
})

test('from 与 to 同一时刻（单根窗口）不拒', () => {
  const opts = parseFetchArgs([
    '--venue', 'binance', '--instrument', 'BTCUSDT', '--interval', '1h',
    '--from', '2024-02-01T00:00:00Z', '--to', '2024-02-01T00:00:00Z', '--out', 'out/btc-1h.json',
  ])
  assert.equal(opts.from, Date.parse('2024-02-01T00:00:00Z'))
  assert.equal(opts.to, opts.from)
})

test('少给必填项 / 多给位置参数 / 选项没值都算用法错误', () => {
  assert.throws(() => parseFetchArgs(['--venue', 'binance']), /--instrument is required/)
  assert.throws(() => parseFetchArgs([...base, '--from', '1', 'stray']), /unexpected positional argument/)
  assert.throws(() => parseFetchArgs([...base, '--from']), /--from needs a value/)
  assert.throws(() => parseFetchArgs([...base, '--from', '1', '--bogus', '2']), /unknown option: --bogus/)
})

test('instrument id：裸符号补场所前缀，别家前缀拒绝', () => {
  assert.equal(instrumentIdOf('binance', 'BTCUSDT'), 'binance:BTCUSDT')
  assert.equal(instrumentIdOf('gateio', 'BTC_USDT'), 'gateio:BTC_USDT')
  assert.equal(instrumentIdOf('binance', 'binance:ETHUSDT'), 'binance:ETHUSDT')
  assert.throws(() => instrumentIdOf('binance', 'okx:BTC-USDT-SWAP'), /belongs to "okx"/)
  assert.throws(() => instrumentIdOf('binance', 'binance:'), /empty symbol/)
})

test('toMs：毫秒整数与 ISO 都认，垃圾输入抛用法错误', () => {
  assert.equal(toMs('1700000000000', 'from'), 1_700_000_000_000)
  assert.equal(toMs('2024-01-01', 'from'), Date.parse('2024-01-01'))
  assert.throws(() => toMs('yesterday', 'from'), /neither Unix milliseconds nor a date/)
  assert.throws(() => toMs('', 'to'), /is empty/)
})

test('周期表：14 个协议周期都有毫秒，未知周期没有', () => {
  assert.equal(INTERVALS.length, 14)
  for (const interval of INTERVALS) assert.ok((stepMs(interval) ?? 0) > 0, interval)
  assert.equal(stepMs('1h'), 3_600_000)
  assert.equal(stepMs('nope'), undefined)
})
