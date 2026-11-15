// SPDX-License-Identifier: CPAL-1.0
// 回测一侧端到端：起仓库自带的真引擎（packages/engine-core/dist），用 fixtures 里的合成 K 线跑 backtest.run，
// 断言规范形产出。全程离线；引擎 dist 不存在时跳过（不构建、不改源码）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBacktestLeg, readCandleFile, enginePaths } from '../lib/backtest-leg.mjs'
import { validateArtifact } from '../lib/artifact.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const CANDLES = join(HERE, '../fixtures/klines-1h-240.json')
const { engineBin } = enginePaths(REPO)
const skip = !existsSync(engineBin) ? 'engine dist not built (node packages/engine-core/build.mjs)' : false

test('readCandleFile：sha256 用协议形态 sha256:<hex>，起止时间正确', () => {
  const d = readCandleFile(CANDLES)
  assert.equal(d.candles.length, 240)
  assert.match(d.sha256, /^sha256:[0-9a-f]{64}$/)
  assert.ok(d.last > d.first)
})

test('runBacktestLeg：真引擎跑 ema-cross，产出规范形（成交 > 0、最终权益有限、订单能力 false）', { skip }, async () => {
  const { artifact, result } = await runBacktestLeg({
    repoRoot: REPO,
    candlesFile: CANDLES,
    strategyId: 'ema-cross',
    instrument: 'hyperliquid:BTC',
    interval: '1h',
  })
  assert.deepEqual(validateArtifact(artifact), { ok: true, errors: [] })
  assert.equal(artifact.side, 'backtest')
  assert.ok(artifact.fills.length > 0, 'ema-cross on 240 synthetic bars should trade')
  assert.ok(Number.isFinite(artifact.finalEquity))
  assert.equal(artifact.capabilities.orders, false)
  assert.equal(artifact.clock.mode, 'event-time')
  assert.ok(artifact.clock.start >= 1_760_000_000_000)
  assert.equal(result.stats.fills, artifact.fills.length)
  assert.ok(artifact.fills.every((f) => f.fillId.startsWith('bt-')))
})

test('runBacktestLeg：同一份数据跑两次，成交序列逐笔一致（确定性）', { skip }, async () => {
  const run = () => runBacktestLeg({
    repoRoot: REPO, candlesFile: CANDLES, strategyId: 'ema-cross', instrument: 'hyperliquid:BTC', interval: '1h',
  })
  const [a, b] = await Promise.all([run(), run()])
  const strip = (r) => r.artifact.fills.map((f) => [f.ts, f.side, f.price, f.size])
  assert.deepEqual(strip(a), strip(b))
  assert.equal(a.artifact.finalEquity, b.artifact.finalEquity)
})

test('runBacktestLeg：未知策略 id 如实报失败（不伪造结果）', { skip }, async () => {
  await assert.rejects(
    runBacktestLeg({ repoRoot: REPO, candlesFile: CANDLES, strategyId: 'no-such-strategy', instrument: 'hyperliquid:BTC', interval: '1h' }),
    (e) => /unknown strategy id/.test(e.message),
  )
})

test('enginePaths：默认指向仓库自带 dist 与示例策略目录', () => {
  const p = enginePaths(REPO)
  assert.ok(p.engineBin.endsWith(join('packages', 'engine-core', 'dist', 'engine-core.mjs')))
  assert.ok(p.strategiesDir.endsWith(join('packages', 'engine-core', 'examples', 'strategies')))
})
