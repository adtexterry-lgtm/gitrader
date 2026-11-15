// SPDX-License-Identifier: CPAL-1.0
// 回测一侧：经公开接口 GEP `backtest.run` 跑一次真回测，产出规范形运行记录。
// 数据走 spec.data.source='files'（协议支持：packages/protocol/src/gep/backtest.ts:27），
// 所以离线、可复现、不依赖任何交易所连接器；引擎进程用仓库自带 dist（node packages/engine-core/build.mjs 产物）。
//
// 不碰内核、不碰 engine-core 源码：只当宿主，说话照 GEP。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { openEngine } from './gep-stdio.mjs'
import { fromBacktestResult } from './artifact.mjs'

const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

export function enginePaths(repoRoot) {
  return {
    engineBin: join(repoRoot, 'packages/engine-core/dist/engine-core.mjs'),
    strategiesDir: join(repoRoot, 'packages/engine-core/examples/strategies'),
  }
}

/** 读 K 线文件（JSON 数组 / {candles:[]}），返回 {candles, sha256, first, last}。与引擎的 parseJson 同口径。 */
export function readCandleFile(path) {
  const buf = readFileSync(path)
  // 引擎的 Sha256Digest 形态是 `sha256:<hex>`（packages/engine-core/src/util/hash.ts:6，协议 model/ids.ts:48）
  const sha256 = `sha256:${createHash('sha256').update(buf).digest('hex')}`
  let j
  try { j = JSON.parse(buf.toString('utf8')) } catch { throw new Error(`candle file is not valid JSON: ${path}`) }
  const arr = Array.isArray(j) ? j : Array.isArray(j?.candles) ? j.candles : null
  if (!arr) throw new Error('candle file must be an array of candles or { "candles": [...] }')
  const candles = arr.map((x) => {
    if (Array.isArray(x)) return { t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] ?? 0 }
    return { t: x?.t, o: x?.o, h: x?.h, l: x?.l, c: x?.c, v: x?.v ?? 0 }
  }).filter((c) => [c.t, c.o, c.h, c.l, c.c].every((y) => typeof y === 'number' && Number.isFinite(y)))
    .sort((a, b) => a.t - b.t)
  if (candles.length === 0) throw new Error('candle file has no usable candles')
  return { candles, sha256, first: candles[0].t, last: candles[candles.length - 1].t }
}

/**
 * 跑回测一侧。
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.candlesFile 本地 K 线 JSON 路径
 * @param {string} opts.strategyId  策略 id（引擎策略文件夹里的 id）
 * @param {string} opts.instrument  instrumentId（如 hyperliquid:BTC）
 * @param {string} [opts.interval='1h']
 * @param {object} [opts.params]    策略参数
 * @param {string} [opts.initialBalance='10000']
 * @param {string} [opts.ccy='USDC']
 * @param {number} [opts.leverage=1]
 * @param {number} [opts.slippageBps=0]
 * @param {{maker:string,taker:string}} [opts.fees]
 * @param {number} [opts.seed=7]
 * @param {string} [opts.engineBin] / [opts.strategiesDir] 覆盖默认路径（测试用）
 * @param {number} [opts.timeoutMs=120000]
 * @returns {Promise<{artifact:object, result:object, spec:object, hostCalls:object[]}>}
 */
export async function runBacktestLeg(opts) {
  const repoRoot = opts.repoRoot ?? process.cwd()
  const paths = enginePaths(repoRoot)
  const engineBin = opts.engineBin ?? paths.engineBin
  const strategiesDir = opts.strategiesDir ?? paths.strategiesDir
  if (!existsSync(engineBin)) {
    throw new Error(`engine build not found: ${engineBin}\n先跑 node packages/engine-core/build.mjs（本测试台不构建、不改源码）`)
  }
  if (!existsSync(strategiesDir)) throw new Error(`strategies folder not found: ${strategiesDir}`)

  const interval = opts.interval ?? '1h'
  const intervalMs = INTERVAL_MS[interval]
  if (!intervalMs) throw new Error(`unknown interval ${interval}; expected one of ${Object.keys(INTERVAL_MS).join(', ')}`)
  const file = isAbsolute(opts.candlesFile) ? opts.candlesFile : resolve(opts.candlesFile)
  const data = readCandleFile(file)

  const spec = {
    subject: { strategy: { id: opts.strategyId, params: opts.params ?? {} } },
    instruments: [opts.instrument],
    interval,
    from: data.first,
    to: data.last + intervalMs,
    data: { source: 'files', files: [{ path: file, sha256: data.sha256, format: 'json', kind: 'candles' }] },
    account: { initialBalance: opts.initialBalance ?? '10000', ccy: opts.ccy ?? 'USDC', ...(opts.leverage ? { leverage: opts.leverage } : {}) },
    assumptions: {
      fees: opts.fees ?? { maker: '0.00015', taker: '0.00045' },
      slippageBps: opts.slippageBps ?? 0,
      fillModel: 'next-bar-open',
      funding: false,
      liquidation: false,
    },
    seed: opts.seed ?? 7,
  }

  const eng = await openEngine({
    command: process.execPath,
    args: [engineBin, '--stdio', '--strategies', strategiesDir],
    cwd: repoRoot,
    timeoutMs: 30_000,
  })
  try {
    const { jobId } = await eng.call('backtest.run', { spec })
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
    let status
    for (;;) {
      status = await eng.call('backtest.status', { jobId })
      if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') break
      if (Date.now() > deadline) {
        await eng.call('backtest.cancel', { jobId }).catch(() => {})
        throw new Error(`backtest ${jobId} did not finish within ${opts.timeoutMs ?? 120_000} ms (state ${status.state})`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (status.state === 'failed') {
      // 失败原因在 backtest.result 的错误里（packages/engine-core/src/runtime/backtest-jobs.ts:127）
      let detail = ''
      try { await eng.call('backtest.result', { jobId }) } catch (e) {
        const gep = e?.gepError
        detail = gep ? `${gep.message}${gep.data?.code ? ` (${gep.data.code})` : ''}` : (e instanceof Error ? e.message : String(e))
      }
      throw new Error(`backtest ${jobId} failed: ${detail || 'no error detail'}${eng.stderr() ? `\nengine stderr: ${eng.stderr().slice(0, 800)}` : ''}`)
    }
    if (status.state !== 'done') throw new Error(`backtest ${jobId} ended in state ${status.state}`)
    const result = await eng.call('backtest.result', { jobId })
    const artifact = fromBacktestResult(result, { instrument: opts.instrument, interval, runId: jobId })
    return { artifact, result, spec, hostCalls: eng.hostCalls }
  } finally {
    await eng.close()
  }
}
