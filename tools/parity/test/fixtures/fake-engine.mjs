// SPDX-License-Identifier: CPAL-1.0
// 假引擎：只说 NDJSON 的 GEP 子进程，用来在不起真引擎时验 gep-stdio 的握手、请求、host.* 请求回绝。
// 完全按 packages/engine-core/src/gep/server.ts:49 的 stdio 形态（一行一帧，读到 EOF 退出）。
import { createInterface } from 'node:readline'

const token = process.env.GITRADER_GEP_TOKEN
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

let hostAsked = false

rl.on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return
  const { id, method, params } = msg
  if (method === 'gep.hello') {
    if (!token) return out({ jsonrpc: '2.0', id, error: { code: 5003, message: 'no token' } })
    const ok = params?.auth?.token === token && token !== 'bad'
    if (!ok) return out({ jsonrpc: '2.0', id, error: { code: 5003, message: 'authentication failed' } })
    // 握手后向宿主发一个 host.* 请求：测试台应当回 -32601，不能假装有行情
    hostAsked = true
    out({ jsonrpc: '2.0', id: 9001, method: 'host.instruments', params: { ids: ['hyperliquid:BTC'] } })
    return out({ jsonrpc: '2.0', id, result: { version: '0.1', sessionId: 'sess_fake', resumed: false, engine: { id: 'fake-engine', version: '0.0.1' } } })
  }
  if (method === 'backtest.run') {
    return out({ jsonrpc: '2.0', id, result: { jobId: 'job_fake' } })
  }
  if (method === 'backtest.status') {
    return out({ jsonrpc: '2.0', id, result: { state: 'done', progress: 1 } })
  }
  if (method === 'backtest.result') {
    return out({
      jsonrpc: '2.0', id,
      result: {
        jobId: 'job_fake',
        specDigest: 'sha256:abc',
        dataDigest: 'sha256:def',
        assumptions: { fillModel: 'next-bar-open', slippageBps: 0, funding: false, liquidation: false, fees: { maker: '0.00015', taker: '0.00045' } },
        stats: { finalEquity: 10_005, trades: 1, fills: 1 },
        equity: [{ t: 1_760_000_000_000, v: 10_000 }, { t: 1_760_003_600_000, v: 10_005 }],
        trades: [{ t: 1_760_003_600_000, side: 'buy', price: 100, size: 0.5, pnl: 0, fee: 0.02, reason: 'entry' }],
        openPosition: null,
        artifacts: [],
        warnings: [],
        engine: { id: 'fake-engine', version: '0.0.1' },
      },
    })
  }
  if (method === 'engine.shutdown') {
    out({ jsonrpc: '2.0', id, result: { ok: true } })
    process.stderr.write(`hostAsked=${hostAsked}\n`)
    return setTimeout(() => process.exit(0), 10)
  }
  out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
})
