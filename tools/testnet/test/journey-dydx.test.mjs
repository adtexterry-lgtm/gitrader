// SPDX-License-Identifier: CPAL-1.0
// dYdX 旅程的离线验收：真连接器 + 真只读行情源（esbuild 临时 ESM）+ 两个包各自的假服务器
// （connector-dydx-trade 的假链节点 / 假 Indexer + connector-dydx-data 的假公共 Indexer），进程内 fetch，不开端口、不联网。
//
// 假服务器之间的分工：行情类路径（perpetualMarkets / orderbooks / trades / candles）交给 data 包的假 Indexer，
// 其余（链节点广播、auth、Indexer 私有读）交给 trade 包的假链节点。
// 下单 / 撤单之后的「Indexer 里能查到这张单」这一步由本文件的 fetch 钩子按官方 Indexer 响应形状补记，
// 订单 UUID 用本文件里的独立 uuid5 实现现算（不 import src 的 indexerOrderId），并与连接器回报的 venueOrderId 对照。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { loadBundle } from '../lib/load-connector.mjs'
import { EXIT } from '../lib/journey.mjs'
import { STEP_NAMES, parseJsonOutput } from './support/harness.mjs'
import { assertTestnetTarget, main as dydxMain } from '../journey-dydx.mjs'

const TRADE_FAKE = 'packages/connector-dydx-trade/test/helpers/fake-dydx.ts'
const DATA_FAKE = 'packages/connector-dydx-data/test/helpers/fake-dydx.ts'

const PRIVATE_KEY = '11'.repeat(32)
const FEE_ENV = {
  DYDX_TESTNET_PRIVATE_KEY: PRIVATE_KEY,
  DYDX_TESTNET_FEE_DENOM: 'uusdc',
  DYDX_TESTNET_FEE_AMOUNT: '20000000000000000',
  DYDX_TESTNET_FEE_GAS: '200000',
}
const TESTNET_HOSTS = ['indexer.v4testnet.dydx.exchange', 'dydx-testnet-rest.publicnode.com']
const BROADCAST = '/cosmos/tx/v1beta1/txs'

/** 官方 Indexer 订单 UUID：uuid v5（namespace 见 v4-chain indexer/packages/postgres/src/helpers/uuid.ts）。 */
const INDEXER_NS = '0f9da948-a6fb-4c45-9edc-4685c3f3317d'
function uuid5(name, ns) {
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')])).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function indexerOrderId(address, subaccountNumber, clientId, clobPairId, orderFlags) {
  const subaccountId = uuid5(`${address}-${subaccountNumber}`, INDEXER_NS)
  return uuid5(`${subaccountId}-${clientId}-${clobPairId}-${orderFlags}`, INDEXER_NS)
}

/** BTC-USD 的市场参数（与 data 包假 Indexer 的夹具同一口径：tick 1 / step 0.0001）。 */
const BTC_MARKET = {
  clobPairId: 0,
  atomicResolution: -10,
  quantumConversionExponent: -9,
  stepBaseQuantums: 1_000_000,
  subticksPerTick: 100_000,
  oraclePrice: '82385.52',
  tickSize: '1',
  stepSize: '0.0001',
}

/**
 * 假 Indexer 的订单账本：广播成功后按官方 Indexer 的行形状把单记进去，撤单成功后把状态改成 CANCELED。
 * 只做「单号 → 一行」的记账，不改任何客户端字段语义。
 */
function ledgerOf(rows) {
  return (tx) => {
    for (const order of tx.orders) {
      // owner 是假节点从签名公钥独立派生的地址（不是本文件算的），单号据此现算。
      const id = indexerOrderId(order.owner, 0, order.clientId, order.clobPairId, order.orderFlags)
      rows.push({
        id,
        subaccountId: 'subaccount-fixture',
        clientId: String(order.clientId),
        clobPairId: String(order.clobPairId),
        side: order.side,
        size: order.quantums.toString(),
        price: order.subticks.toString(),
        status: order.orderFlags === 32 ? 'UNTRIGGERED' : 'OPEN',
        type: 'LIMIT',
        timeInForce: 'GTT',
        orderFlags: String(order.orderFlags),
        totalFilled: '0',
        reduceOnly: order.reduceOnly,
        market: 'BTC-USD',
        createdAtHeight: '1000',
      })
    }
    // 撤单消息里没有 owner（OrderId 由签名者补全）：按 clientId / clobPairId / flags 三元组认单。
    for (const cancel of tx.cancels) {
      const hit = rows.find((row) => row.clientId === String(cancel.clientId)
        && row.clobPairId === String(cancel.clobPairId)
        && row.orderFlags === String(cancel.orderFlags))
      if (hit !== undefined) hit.status = 'CANCELED'
    }
  }
}

/** 起两个假服务器 + 跑一遍旅程。 */
async function runJourney(options = {}) {
  const { fake: tradeMod, data: dataMod } = await loadBundle({ fake: TRADE_FAKE, data: DATA_FAKE })
  const rows = []
  const trade = new tradeMod.FakeDydx({
    chainId: 'dydx-testnet-4',
    accountNumber: 9,
    height: 1000,
    sequence: 3,
    markets: { 'BTC-USD': BTC_MARKET },
    subaccount: {
      address: 'fixture',
      subaccountNumber: 0,
      equity: '1234.5',
      freeCollateral: '1000',
      assetPositions: { USDC: { symbol: 'USDC', size: '1234.5', side: 'LONG' } },
      openPerpetualPositions: {},
    },
    orders: rows,
    ...(options.trade ?? {}),
  })
  const data = new dataMod.FakeDydx()
  const ledger = ledgerOf(rows)
  const compose = (hook) => async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    if (hook !== undefined) {
      const short = await hook({ url, method })
      if (short !== undefined) return short
    }
    if (dataMod.kindOf(url.pathname) !== 'unknown') return data.fetch(input, init)
    const response = await trade.fetchImpl(input, init)
    if (method === 'POST' && url.pathname === BROADCAST && response.status >= 200 && response.status < 300) {
      const tx = trade.lastTx
      if (tx !== undefined) ledger(tx)
    }
    return response
  }
  const journey = await import('../journey-dydx.mjs')
  const lines = []
  const code = await journey.main(options.argv ?? ['--json'], {
    env: options.env ?? FEE_ENV,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl: compose(options.hook),
  })
  return { code, lines, text: lines.join('\n'), steps: parseJsonOutput(lines), trade, data, rows }
}

const broadcasts = (trade) => trade.requests.filter((request) => request.method === 'POST' && new URL(request.url).pathname === BROADCAST)

test('dydx：假链节点 + 假 Indexer 上跑完整旅程，11 步全过，全部请求只打测试网主机', async () => {
  const { code, text, steps, trade, data, rows } = await runJourney()
  assert.equal(code, EXIT.OK, text)
  assert.equal(steps.ok, true, text)
  assert.deepEqual(steps.steps.map((step) => step.name), STEP_NAMES)
  assert.deepEqual(steps.steps.filter((step) => !step.ok).map((step) => `${step.name}:${step.receipt}`), [])

  // 链上没有改单消息：引擎按 capabilities 跳过 amend，回执里要有「skipped」。
  const amend = steps.steps.find((step) => step.name === 'amend')
  assert.equal(amend.ok, true)
  assert.match(amend.receipt, /^skipped: venue declares amend=none$/)

  // 四笔广播：下 2 张单（限价 + 条件单）、撤 2 张；签名域里的链 id 必须是测试网链。
  const txs = broadcasts(trade)
  assert.equal(txs.length, 4, `应恰好 4 笔广播，实际 ${txs.length}`)
  assert.deepEqual(trade.txs.map((tx) => tx.chainId), ['dydx-testnet-4', 'dydx-testnet-4', 'dydx-testnet-4', 'dydx-testnet-4'])
  assert.equal(trade.txs.filter((tx) => tx.cancels.length > 0).length, 2, '两张单都要撤')
  assert.equal(trade.txs.filter((tx) => tx.orders.length > 0).length, 2, '限价单与条件单各一张')
  // 条件单必须带 flags=32（conditional），限价单是长单 flags=64。
  assert.deepEqual(trade.txs[0].orders.map((order) => order.orderFlags), [64])
  assert.deepEqual(trade.txs[2].orders.map((order) => order.orderFlags), [32])

  // 假节点自己会 collect 失败项（验签 / 价量整数倍 / owner 地址）：一项都不能有。
  assert.deepEqual(trade.failures, [])

  // 单号：本文件独立算出的 uuid5 必须与连接器回报的 venueOrderId 一致（两套实现互相校验，G1）。
  const placed = steps.steps.find((step) => step.name === 'place-limit').receipt
  const venueOrderId = /venueOrderId=([0-9a-f-]{36})/.exec(placed)?.[1]
  assert.ok(venueOrderId !== undefined, placed)
  assert.equal(venueOrderId, rows[0].id, '连接器回报的单号与官方 uuid5 公式算出的不一致')

  // 请求只打两个测试网主机，实盘主机一次都没有。
  const hosts = new Set([...trade.requests, ...data.calls.map((call) => ({ url: call.url }))]
    .map((request) => new URL(request.url).host))
  assert.deepEqual([...hosts].sort(), [...TESTNET_HOSTS].sort())
  assert.ok(!text.includes(PRIVATE_KEY), '输出里不得出现私钥原文')
})

test('dydx：缺私钥或任一手续费变量时退出 3，不发任何请求', async () => {
  for (const drop of Object.keys(FEE_ENV)) {
    const env = { ...FEE_ENV }
    delete env[drop]
    const { code, text, trade, data } = await runJourney({ argv: [], env })
    assert.equal(code, EXIT.NO_CREDENTIALS, `${drop}: ${text}`)
    assert.match(text, /缺少环境变量/)
    assert.match(text, new RegExp(drop))
    assert.match(text, /本脚本不发任何请求/)
    assert.equal(trade.requests.length, 0, `${drop}: 缺变量时不该发任何请求`)
    assert.equal(data.calls.length, 0)
    assert.ok(!text.includes(PRIVATE_KEY))
  }
})

test('dydx：链节点广播失败退出 1，打印脱敏 Problem，后续步骤全 skipped，且不重发', async () => {
  const json = await runJourney({ trade: { failNetwork: true } })
  assert.equal(json.code, EXIT.FAILED, json.text)
  assert.equal(json.steps.failedStep, 'place-limit')
  const place = json.steps.steps.find((step) => step.name === 'place-limit')
  assert.equal(place.ok, false)
  assert.ok(json.steps.steps.slice(json.steps.steps.indexOf(place) + 1).every((step) => step.skipped))
  // 结果未知（断连 / 超时）时只报错：一笔广播就是一笔，不许自动重发（README：3006 先按 clientOrderId 对账）。
  assert.equal(broadcasts(json.trade).length, 1, '失败后不得重发')

  // 人读模式：脱敏 Problem 打在 stderr 上，密钥原文一个字都不出现。
  const readable = await runJourney({ argv: [], trade: { failNetwork: true } })
  assert.equal(readable.code, EXIT.FAILED, readable.text)
  assert.match(readable.text, /Problem: /)
  assert.match(readable.text, /失败于「place-limit」/)
  assert.ok(!readable.text.includes(PRIVATE_KEY), '输出里不得出现私钥原文')
})

test('dydx：护栏——实盘链 id / 实盘主机 / 非白名单主机一律拒，测试网与回环放行', () => {
  const ok = { environment: 'testnet', chainId: 'dydx-testnet-4', indexerBaseUrl: 'https://indexer.v4testnet.dydx.exchange', nodeBaseUrl: 'https://dydx-testnet-rest.publicnode.com' }
  assert.doesNotThrow(() => assertTestnetTarget(ok))
  assert.doesNotThrow(() => assertTestnetTarget({ ...ok, indexerBaseUrl: 'http://127.0.0.1:18080', nodeBaseUrl: 'http://127.0.0.1:18080' }))
  assert.doesNotThrow(() => assertTestnetTarget({ ...ok, indexerBaseUrl: 'http://localhost:18080', nodeBaseUrl: 'http://localhost:18080' }))

  const rejected = [
    [{ ...ok, environment: 'mainnet' }, /environment=mainnet/],
    [{ ...ok, chainId: 'dydx-mainnet-1' }, /实盘链/],
    [{ ...ok, chainId: 'dydx-testnet-5' }, /不是测试网链/],
    [{ ...ok, chainId: '' }, /不是测试网链/],
    [{ ...ok, indexerBaseUrl: 'https://indexer.dydx.trade' }, /实盘主机/],
    [{ ...ok, nodeBaseUrl: 'https://dydx-rest.publicnode.com' }, /实盘主机/],
    [{ ...ok, nodeBaseUrl: 'https://evil.example.com' }, /不在测试网白名单/],
    [{ ...ok, indexerBaseUrl: 'not a url' }, /无法解析/],
    [{ ...ok, indexerBaseUrl: 'https://indexer.v4testnet.dydx.exchange.evil.test' }, /不在测试网白名单/],
  ]
  for (const [target, pattern] of rejected) {
    assert.throws(() => assertTestnetTarget(target), pattern, JSON.stringify(target))
  }
})

test('dydx：--base-url 指向实盘 Indexer 即退出 2，读密钥之前就停，零请求', async () => {
  let calls = 0
  const lines = []
  for (const live of ['https://indexer.dydx.trade', 'https://indexer.dydx.trade/', 'https://dydx-rest.publicnode.com']) {
    calls = 0
    const code = await dydxMain(['--base-url', live], {
      env: FEE_ENV,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
      fetchImpl: async () => {
        calls += 1
        return new Response('{}')
      },
    })
    assert.equal(code, EXIT.USAGE, live)
    assert.equal(calls, 0, '阻断发生在建连接器之前')
  }
  assert.match(lines.join(' | '), /不连实盘|实盘主机/)
  assert.ok(!lines.join(' ').includes(PRIVATE_KEY))
})

test('dydx：读账户失败只报错停——退出 1，一笔广播都不发（G16）', async () => {
  const { code, text, steps, trade } = await runJourney({
    argv: ['--json'],
    hook: async ({ url, method }) => {
      if (method === 'GET' && url.pathname.startsWith('/v4/addresses/')) {
        return { ok: false, status: 500, text: async () => '{"errors":[{"msg":"indexer down"}]}', headers: { get: () => null } }
      }
      return undefined
    },
  })
  assert.equal(code, EXIT.FAILED, text)
  assert.equal(steps.failedStep, 'account')
  // 最高级别：读失败只许报错停，不许拿它去触发下单 / 撤单 / 平仓。
  assert.equal(broadcasts(trade).length, 0, '读账户失败时不应有任何广播')
  assert.equal(trade.txs.length, 0)
  assert.ok(text.includes('FAILED') || text.includes('Problem'))
})
