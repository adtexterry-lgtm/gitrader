// SPDX-License-Identifier: CPAL-1.0
// 一次性夹具生成脚本（不进发布物、不被包内测试 import）：用 packages/engine-core 现有的 K 线模拟器跑同一份合成
// K 线，把成交序列落成 test/fixtures/kline-parity.json，给 test/parity.test.ts 做「盘口仿真 vs K 线模拟」对照。
//
// 为什么用相对路径 import engine-core：本包零第三方依赖、也不把 engine-core 写进依赖表；这个脚本只在生成夹具时
// 跑一次，产物（JSON）随包提交。这样「参照」是另一份实现的真实输出，不是我们照着答案写的期望值。
//
// 运行（仓库根，本地 esbuild + node，不联网、不安装任何东西）：
//   npx esbuild packages/sim-book/scripts/gen-kline-parity.mts --bundle --platform=node --format=esm \
//     --outfile="$TMPDIR/gen-kline-parity.mjs" && node "$TMPDIR/gen-kline-parity.mjs"
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Simulator } from '../../engine-core/src/strategy/simulator'

// 输出路径按仓库根解析（脚本用 esbuild 打包后运行，import.meta.url 指向打包产物，不能用它定位）。
const OUT = resolve(process.cwd(), process.env.KLINE_PARITY_OUT ?? 'packages/sim-book/test/fixtures/kline-parity.json')

// 合成 K 线：确定性手写值，开盘价之间有明显跳空，能暴露「下一根开盘价成交」的口径差。
const CANDLES = [
  { t: 1_700_000_000_000, o: 100, h: 101, l: 99, c: 100.5, v: 1000 },
  { t: 1_700_000_060_000, o: 101, h: 102, l: 100, c: 101.5, v: 1000 },
  { t: 1_700_000_120_000, o: 99.5, h: 100, l: 98, c: 98.5, v: 1000 },
  { t: 1_700_000_180_000, o: 103, h: 104, l: 102, c: 103.5, v: 1000 },
  { t: 1_700_000_240_000, o: 100, h: 101, l: 99, c: 100.2, v: 1000 },
  { t: 1_700_000_300_000, o: 102, h: 103, l: 101, c: 102.5, v: 1000 },
]

// 每根 K 线要执行的目标仓位（信号来自上一根收盘；这里直接给死，避免把策略逻辑带进对照里）。
const WANTS = [1, 1, 0, -1, -1, 0]

const FEE_RATE = 0.001

interface TradeOut {
  t: number
  side: 'buy' | 'sell'
  price: number
  size: number
  fee: number
  /** 该成交所在 K 线的开盘价（对照用）。 */
  barOpen: number
}

function run(slippageBps: number): { trades: TradeOut[]; feesPaid: number; finalEquity: number } {
  const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: FEE_RATE, slippageBps })
  for (let i = 0; i < CANDLES.length; i += 1) sim.onBar(i, CANDLES[i]!, WANTS[i]!, 'signal')
  const trades: TradeOut[] = sim.trades.map((trade) => {
    const bar = CANDLES.find((candle) => candle.t === trade.t)
    return { t: trade.t, side: trade.side, price: trade.price, size: trade.size, fee: trade.fee, barOpen: bar?.o ?? Number.NaN }
  })
  return { trades, feesPaid: sim.feesPaid, finalEquity: sim.cash + sim.pos * (CANDLES[CANDLES.length - 1]!.c - sim.entry) }
}

const fixture = {
  source: 'packages/engine-core/src/strategy/simulator.ts（next-bar-open 成交、单档滑点、单一吃单费率）',
  note: '由 scripts/gen-kline-parity.mts 跑真实 engine-core 模拟器生成，不是手写期望值。',
  candles: CANDLES,
  wants: WANTS,
  feeRate: FEE_RATE,
  configs: {
    'no-slip': run(0),
    'slip-25bps': run(25),
  },
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
console.log(`写出 ${OUT}：no-slip ${fixture.configs['no-slip'].trades.length} 笔，slip-25bps ${fixture.configs['slip-25bps'].trades.length} 笔`)
