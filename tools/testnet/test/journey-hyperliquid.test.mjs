// SPDX-License-Identifier: CPAL-1.0
// hyperliquid 旅程的离线验收：护栏与凭据口径，不联网、不发请求。
//
// 为什么没有「假服务器上跑完整旅程」这一例：本仓的假 Hyperliquid（packages/connector-hyperliquid/test/helpers/fake-hl.ts）
// 只回答 perpDexs / metaAndAssetCtxs / allMids / l2Book / candleSnapshot，账户快照（clearinghouseState 一类）、
// 订单查询（orderStatus）与 /exchange 的下单回执都要逐条自己捏；旅程引擎给的是哨兵账户地址与不签名的占位句柄，
// 真要跑通整条旅程等于在本文件里重做一遍包的假服务器。这里只做到本标段能核实的那一层：
// 参数表 / 登记表 / 基址常量漂移 / 变量名 / 退出码 / 零请求 / 不回显 / 贴价步长 / 旅程壳的地址与签名器。真跑时按 tools/testnet/README.md 走。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HYPERLIQUID, VENUES, venueSpec } from '../lib/venues.mjs'
import { assertTestnetBaseUrl } from '../lib/cli.mjs'
import { KINDS, entriesFor, hasTestnet, loadRegistry, lookupHost, validateRegistry } from '../lib/venues-testnet.mjs'
import { EXIT } from '../lib/journey.mjs'
import {
  TESTNET_BASE_URL, assertFixedBaseUrl, createConnector, journeyView, main as hyperliquidMain,
  parseApiWalletKey, parseMainAddress, tickFor, venue as hyperliquidVenue,
} from '../journey-hyperliquid.mjs'

const REGISTRY = loadRegistry()
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SPEC = venueSpec('hyperliquid')

const MAIN_ADDRESS = `0x${'11'.repeat(20)}`
const API_WALLET_KEY = `0x${'22'.repeat(32)}`
const CREDENTIALS = { HL_TESTNET_MAIN_ADDRESS: MAIN_ADDRESS, HL_TESTNET_API_WALLET_KEY: API_WALLET_KEY }

/** 跑一遍 HL 旅程的 CLI，收退出码 + 输出 + 请求次数。 */
async function runMain(argv, env) {
  let calls = 0
  const lines = []
  const code = await hyperliquidMain(argv, {
    env,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl: async () => {
      calls += 1
      throw new Error('HL journey test: fetch must not be called')
    },
  })
  return { code, text: lines.join('\n'), calls }
}

test('场所参数：hyperliquid 只在 testnet，缺省基址是连接器的测试网常量，登记表里有这一行', () => {
  assert.equal(hyperliquidVenue, 'hyperliquid')
  assert.equal(SPEC.environment, 'testnet')
  assert.equal(SPEC.baseUrl, TESTNET_BASE_URL)
  assert.equal(SPEC.defaultInstrumentId, 'hyperliquid:BTC')

  // 基址常量与包内常量必须一致（包改常量而脚本没跟 → 这里红）
  const rest = readFileSync(join(REPO_ROOT, 'packages/connector-hyperliquid/src/rest.ts'), 'utf8')
  const testnet = /testnet:\s*\{\s*http:\s*'([^']+)'/.exec(rest)
  assert.ok(testnet, '在 rest.ts 里没找到 HL_ENDPOINTS.testnet.http')
  assert.equal(TESTNET_BASE_URL, testnet[1], '脚本里的测试网基址与 rest.ts 的常量不一致')
  assert.equal(SPEC.baseUrlSource.includes('rest.ts:'), true)

  // 登记表：测试网主机登记为「测试网」，主网主机不在表里
  assert.deepEqual(validateRegistry(REGISTRY).errors, [], '加了 hyperliquid 这一行之后登记表仍然结构合法')
  const rows = entriesFor('hyperliquid', REGISTRY)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].host, 'api.hyperliquid-testnet.xyz')
  assert.equal(rows[0].kind, '测试网')
  assert.ok(KINDS.includes(rows[0].kind))
  assert.ok(rows[0].officialUrl.startsWith('https://'), 'officialUrl 必须是 https 链接')
  assert.equal(hasTestnet('hyperliquid', REGISTRY), true)
  assert.equal(lookupHost('hyperliquid', 'api.hyperliquid.xyz', REGISTRY), null, '主网主机不该登记成测试网')
  assert.doesNotThrow(() => assertTestnetBaseUrl(SPEC.baseUrl, SPEC))
  assert.doesNotThrow(() => assertTestnetBaseUrl(`${SPEC.baseUrl}/`, SPEC))
  assert.throws(() => assertTestnetBaseUrl('https://api.hyperliquid.xyz', SPEC), /不连实盘/)
  assert.throws(() => assertTestnetBaseUrl('https://api.hyperliquid-testnet.xyz.evil.test', SPEC), /不连实盘/)
})

test('变量名：每张场所参数表的凭据都带 TESTNET/DEMO，且都不是主网惯用名', () => {
  // 覆盖 VENUES 的五个场所 + 单独一项的 hyperliquid（lib/venues.mjs）
  const specs = [...Object.values(VENUES), HYPERLIQUID]
  const MAINNET_NAMES = [
    'HL_API_KEY', 'HL_API_SECRET', 'HL_PRIVATE_KEY', 'HYPERLIQUID_API_KEY', 'HYPERLIQUID_API_SECRET',
    'BINANCE_API_KEY', 'BINANCE_API_SECRET', 'OKX_API_KEY', 'OKX_API_SECRET', 'BYBIT_API_KEY', 'BYBIT_API_SECRET',
  ]
  for (const spec of specs) {
    assert.ok(spec.credentials.length >= 2, `${spec.venue} 至少两件凭据`)
    for (const credential of spec.credentials) {
      assert.match(credential.env, /TESTNET|DEMO/, `${spec.venue} 的 ${credential.env} 必须带 TESTNET/DEMO 前缀`)
      assert.ok(!MAINNET_NAMES.includes(credential.env), `${spec.venue} 读了主网惯用名 ${credential.env}`)
      assert.equal(typeof credential.field, 'string')
    }
  }
  assert.deepEqual(SPEC.credentials.map((credential) => credential.env), ['HL_TESTNET_MAIN_ADDRESS', 'HL_TESTNET_API_WALLET_KEY'])
  assert.deepEqual(SPEC.credentials.map((credential) => credential.field), ['mainAddress', 'apiWalletKey'])
  assert.equal(SPEC.mode.includes('测试网'), true)
})

test('没有密钥时退出 3，不发任何请求，也不回显值', async () => {
  const { code, text, calls } = await runMain([], {})
  assert.equal(code, EXIT.NO_CREDENTIALS, text)
  assert.equal(calls, 0, '缺密钥时不应该发任何请求')
  assert.match(text, /缺少密钥环境变量/)
  assert.match(text, /HL_TESTNET_MAIN_ADDRESS/)
  assert.match(text, /HL_TESTNET_API_WALLET_KEY/)
  assert.match(text, /本脚本不发任何请求/)
})

test('只给一半凭据也退出 3，零请求', async () => {
  const { code, text, calls } = await runMain([], { HL_TESTNET_MAIN_ADDRESS: MAIN_ADDRESS })
  assert.equal(code, EXIT.NO_CREDENTIALS, text)
  assert.equal(calls, 0)
  assert.match(text, /HL_TESTNET_API_WALLET_KEY/)
  assert.ok(!text.includes(API_WALLET_KEY))
})

test('--base-url 指向表外主机（主网 / 伪装域名）→ 退出 2、零请求、不回显密钥', async () => {
  for (const live of ['https://api.hyperliquid.xyz', 'https://api.hyperliquid-testnet.xyz.evil.test']) {
    const { code, text, calls } = await runMain(['--base-url', live], CREDENTIALS)
    assert.equal(code, EXIT.USAGE, `${live} → ${text}`)
    assert.equal(calls, 0, '护栏在读密钥、建连接器之前就停')
    assert.match(text, /登记表|不在允许范围内/)
    assert.ok(!text.includes(API_WALLET_KEY) && !text.includes(MAIN_ADDRESS), '输出里不得出现凭据原文')
  }
})

test('--base-url 指向本机回环：登记表放行，但连接器基址写死 → 退出 1、零请求', async () => {
  // HlHttp 的基址固定取 HL_ENDPOINTS[environment].http（rest.ts:95），改不了；这里如实报错，不假装用了它。
  // 登记表按主机名判，不看端口：同一个主机名换端口的写法最后由写死的基址挡（退出 1）。
  for (const loopback of ['http://127.0.0.1:18080', 'http://localhost:18080', 'https://api.hyperliquid-testnet.xyz:8443']) {
    const { code, text, calls } = await runMain(['--base-url', loopback], CREDENTIALS)
    assert.equal(code, EXIT.FAILED, `${loopback} → ${text}`)
    assert.equal(calls, 0)
    assert.match(text, /连接器构造失败/)
    assert.match(text, /基址固定/)
    assert.ok(!text.includes(API_WALLET_KEY) && !text.includes(MAIN_ADDRESS))
  }
})

test('凭据形状不对：首字节校验在建连接器之前，退出 1、零请求、不回显私钥', async () => {
  const cases = [
    { HL_TESTNET_MAIN_ADDRESS: MAIN_ADDRESS, HL_TESTNET_API_WALLET_KEY: 'not-a-key' },
    { HL_TESTNET_MAIN_ADDRESS: MAIN_ADDRESS, HL_TESTNET_API_WALLET_KEY: '0x' + '22'.repeat(31) },
    { HL_TESTNET_MAIN_ADDRESS: '0x1234', HL_TESTNET_API_WALLET_KEY: API_WALLET_KEY },
  ]
  for (const env of cases) {
    const { code, text, calls } = await runMain([], env)
    assert.equal(code, EXIT.FAILED, text)
    assert.equal(calls, 0)
    assert.match(text, /连接器构造失败/)
    assert.ok(!text.includes(env.HL_TESTNET_API_WALLET_KEY) || env.HL_TESTNET_API_WALLET_KEY.length < 8)
    assert.ok(!text.includes(API_WALLET_KEY))
  }
  assert.deepEqual([...parseApiWalletKey(API_WALLET_KEY)].length, 32)
  assert.deepEqual([...parseApiWalletKey('22'.repeat(32))].length, 32, '0x 前缀可有可无')
  assert.equal(parseMainAddress(MAIN_ADDRESS.toUpperCase().replace('0X', '0x')), MAIN_ADDRESS)
  assert.throws(() => assertFixedBaseUrl('https://api.hyperliquid.xyz'), /基址固定/)
  assert.doesNotThrow(() => assertFixedBaseUrl(`${TESTNET_BASE_URL}/`))
})

test('--help 退出 0，列出两个变量名与测试网主机', async () => {
  const { code, text, calls } = await runMain(['--help'], {})
  assert.equal(code, EXIT.OK, text)
  assert.equal(calls, 0)
  assert.match(text, /HL_TESTNET_MAIN_ADDRESS/)
  assert.match(text, /HL_TESTNET_API_WALLET_KEY/)
  assert.match(text, /api\.hyperliquid-testnet\.xyz/)
})

test('构造出的连接器只带 testnet 环境，且构造阶段不发请求', async () => {
  let calls = 0
  const view = await createConnector({
    credentials: { mainAddress: MAIN_ADDRESS, apiWalletKey: API_WALLET_KEY },
    environment: 'testnet',
    baseUrl: TESTNET_BASE_URL,
    fetchImpl: async () => {
      calls += 1
      throw new Error('HL journey test: fetch must not be called')
    },
    clock: () => 1_700_000_000_000,
  })
  assert.equal(view.venue, 'hyperliquid')
  assert.equal(view.environment, 'testnet')
  assert.equal(typeof view.accountState, 'function')
  assert.equal(typeof view.submit, 'function')
  await view.close()
  assert.equal(calls, 0, '构造连接器不该发请求')
  await assert.rejects(
    () => createConnector({ credentials: { mainAddress: MAIN_ADDRESS, apiWalletKey: API_WALLET_KEY }, environment: 'mainnet', baseUrl: TESTNET_BASE_URL }),
    /只跑 testnet/,
  )
})

test('贴价步长：Hyperliquid 的 instrument 没有 tick，按 5 位有效数字 / 小数位上限从参考价算', () => {
  const btc = { price: { sigFigs: 5, maxDecimals: 1 } }
  assert.equal(tickFor(btc, '80957'), '1', '整数价恒合法')
  assert.equal(tickFor(btc, '68813.45'), '1')
  assert.equal(tickFor(btc, '123.45'), '0.1', '小数位上限压住有效数字位数')
  const alt = { price: { sigFigs: 5, maxDecimals: 3 } }
  assert.equal(tickFor(alt, '12.345'), '0.001')
  const micro = { price: { sigFigs: 5, maxDecimals: 6 } }
  assert.equal(tickFor(micro, '0.1023'), '0.00001')
  assert.equal(tickFor(micro, '0.0012345'), '0.000001')
  assert.equal(tickFor({}, '80957'), '1', '缺字段时按包的缺省（≤5 位有效数字 / 6 位小数）算')
  assert.equal(tickFor(null, undefined), '0.00001')

  // 贴完的价必须是场所能收的形状：不超过 5 位有效数字、小数位不超过上限
  const stepped = tickFor(btc, '68813.45')
  const limit = String(Math.floor(68813.45 * 0.85 / Number(stepped)) * Number(stepped))
  assert.equal(limit, '58491')
  assert.ok(limit.split('.')[1] === undefined || limit.split('.')[1].length <= 1)
})

test('旅程壳：账户地址换成主账户公开地址，签名器换成本旅程度装的那一只', async () => {
  const seen = []
  const signer = { address: `0x${'33'.repeat(20)}`, signTypedData: async () => `0x${'44'.repeat(65)}` }
  const instrument = { instrumentId: 'hyperliquid:BTC', price: { sigFigs: 5, maxDecimals: 1 }, size: { step: '0.00001', min: '0.00001' }, minNotional: '10' }
  const connector = {
    environment: 'testnet',
    describe: () => ({ amend: 'native' }),
    start: async () => { seen.push(['start']) },
    getInstrument: () => instrument,
    book: async () => { seen.push(['book']); return { bids: [{ price: '80957' }], asks: [{ price: '80958' }] } },
    accountState: async (ref) => { seen.push(['accountState', ref.address]); return { stale: false, balances: [], positions: [] } },
    submit: async (ctx, intents) => { seen.push(['submit', ctx.account.address, ctx.signer === signer, intents.length]); return { acks: [] } },
    orderStatus: async (ref) => { seen.push(['orderStatus', ref.address]); return { found: false, raw: null } },
    cancel: async (ctx) => { seen.push(['cancel', ctx.account.address, ctx.signer === signer]); return [] },
    amend: async (ctx) => { seen.push(['amend', ctx.account.address, ctx.signer === signer]); return { acks: [] } },
    close: async () => { seen.push(['close']) },
  }
  const view = journeyView({ connector, signer, mainAddress: MAIN_ADDRESS })

  assert.equal(view.venue, 'hyperliquid')
  assert.equal(view.environment, 'testnet')
  assert.equal(view.describe().amend, 'native')

  const ref = { accountId: 'acct_01TESTNET', address: `0x${'00'.repeat(20)}` }
  const ctx = { account: ref, signer: { address: `0x${'00'.repeat(20)}`, signTypedData: async () => '0x00' } }

  // 引擎给的哨兵地址 / 占位签名器一律被换掉
  await view.start()
  await view.accountState(ref)
  const patched = view.getInstrument('hyperliquid:BTC')
  assert.notEqual(patched, instrument, '没有 tick 的标的要返回带 tick 的副本')
  await view.book('hyperliquid:BTC', 5)
  assert.equal(patched.price.tick, '1', 'tick 按刚拿到的参考价算')
  await view.submit(ctx, [{ instrumentId: 'hyperliquid:BTC' }])
  await view.orderStatus(ref, { clientOrderId: 'aa' })
  await view.cancel(ctx, [{ instrumentId: 'hyperliquid:BTC' }])
  await view.amend(ctx, { instrumentId: 'hyperliquid:BTC' })
  await view.close()

  assert.deepEqual(seen, [
    ['start'],
    ['accountState', MAIN_ADDRESS],
    ['book'],
    ['submit', MAIN_ADDRESS, true, 1],
    ['orderStatus', MAIN_ADDRESS],
    ['cancel', MAIN_ADDRESS, true],
    ['amend', MAIN_ADDRESS, true],
    ['close'],
  ])
  assert.equal(ctx.account.address, `0x${'00'.repeat(20)}`, '不得改动引擎给的上下文')
})
