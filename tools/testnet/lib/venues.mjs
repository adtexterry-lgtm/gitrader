// SPDX-License-Identifier: CPAL-1.0
// 各交易场所的测试网 / 模拟盘参数表（基址与开关以各包 README 与 QD 当前实现为准）。
// 密钥环境变量名一律带 TESTNET / DEMO：主网密钥的变量名（*_API_KEY）不会被本目录任何脚本读取。
// VENUES 是走 lib/cli.mjs 的五个场所；Hyperliquid 单独一项（HYPERLIQUID），理由见该项上面的注释。

export const VENUES = {
  binance: {
    venue: 'binance',
    label: 'Binance USDⓈ-M 永续',
    environment: 'testnet',
    mode: '测试网（demo）',
    baseUrl: 'https://demo-fapi.binance.com',
    hosts: ['demo-fapi.binance.com'],
    defaultAccountId: 'acct_01TESTNET',
    defaultInstrumentId: 'binance:BTCUSDT',
    defaultSize: '0.002',
    credentials: [
      { env: 'BINANCE_TESTNET_API_KEY', field: 'apiKey' },
      { env: 'BINANCE_TESTNET_API_SECRET', field: 'apiSecret' },
    ],
    baseUrlSource: 'QD live_trading/binance.py:40（demo-fapi）；包 README「基址」节',
  },
  okx: {
    venue: 'okx',
    label: 'OKX USDT 永续',
    environment: 'testnet',
    mode: '模拟盘（x-simulated-trading: 1，同一主机）',
    baseUrl: 'https://www.okx.com',
    hosts: ['www.okx.com'],
    defaultAccountId: 'acct_01TESTNET',
    defaultInstrumentId: 'okx:BTC-USDT-SWAP',
    defaultSize: '0.002',
    credentials: [
      { env: 'OKX_DEMO_API_KEY', field: 'apiKey' },
      { env: 'OKX_DEMO_API_SECRET', field: 'apiSecret' },
      { env: 'OKX_DEMO_PASSPHRASE', field: 'passphrase' },
    ],
    baseUrlSource: '包内 rest.ts:27-28（mainnet/testnet 同主机）+ README「rest.ts」行的模拟盘头',
  },
  bybit: {
    venue: 'bybit',
    label: 'Bybit v5 USDT 线性永续',
    environment: 'testnet',
    mode: '测试网',
    baseUrl: 'https://api-testnet.bybit.com',
    hosts: ['api-testnet.bybit.com'],
    defaultAccountId: 'acct_01TESTNET',
    defaultInstrumentId: 'bybit:BTCUSDT',
    defaultSize: '0.002',
    credentials: [
      { env: 'BYBIT_TESTNET_API_KEY', field: 'apiKey' },
      { env: 'BYBIT_TESTNET_API_SECRET', field: 'apiSecret' },
    ],
    baseUrlSource: '包内 rest.ts:24-25',
  },
  bitget: {
    venue: 'bitget',
    label: 'Bitget USDT 本位永续',
    environment: 'testnet',
    mode: '模拟盘（PAPTRADING: 1）',
    baseUrl: 'https://api.bitget.com',
    hosts: ['api.bitget.com'],
    defaultAccountId: 'acct_01TESTNET',
    defaultInstrumentId: 'bitget:BTCUSDT',
    defaultSize: '0.002',
    credentials: [
      { env: 'BITGET_DEMO_API_KEY', field: 'apiKey' },
      { env: 'BITGET_DEMO_API_SECRET', field: 'apiSecret' },
      { env: 'BITGET_DEMO_PASSPHRASE', field: 'passphrase' },
    ],
    baseUrlSource: '包内 connector.ts:26 + rest.ts（testnet = 打开 PAPTRADING: 1，主机不变）',
  },
  gateio: {
    venue: 'gateio',
    label: 'Gate.io USDT 永续',
    environment: 'testnet',
    mode: '测试网',
    baseUrl: 'https://api-testnet.gateapi.io',
    hosts: ['api-testnet.gateapi.io'],
    defaultAccountId: 'acct_01TESTNET',
    defaultInstrumentId: 'gateio:BTC_USDT',
    defaultSize: '0.002',
    credentials: [
      { env: 'GATE_TESTNET_API_KEY', field: 'apiKey' },
      { env: 'GATE_TESTNET_API_SECRET', field: 'apiSecret' },
    ],
    baseUrlSource: '包内 rest.ts:26（QD factory.py:327）',
  },
}

/**
 * Hyperliquid（`packages/connector-hyperliquid`）的测试网参数。
 * 为什么不在 VENUES 里：`test/journey-lib.test.mjs` 的「场所参数表：五所齐全」把 Object.keys(VENUES)
 * 硬编码成五个场所，`test/venues-testnet.test.mjs` 的基址守卫同样遍历 Object.values(VENUES)；那两个文件
 * 不在本标段的拥有清单里，把 hyperliquid 并进 VENUES 会让 `node tools/testnet/test/index.mjs` 变红。
 * venueSpec() 两张表都查，所以 journey-hyperliquid.mjs 与它的测试拿到的是同一份参数。
 * 基址出处：packages/connector-hyperliquid/src/rest.ts:12（HL_ENDPOINTS.testnet.http）。
 * defaultSize 依据：连接器把官方最小名义额 `10` USDC 写进 instrument.minNotional（src/parse.ts:13），
 * 数量按 meta 的 szDecimals 截断（BTC 的 step 是 1e-5）；0.001 BTC 在 BTC 价格高于 10,000 USDC 时
 * 名义额就过线，旅程引擎还会在不足时按 2 倍递增抬到门槛。
 */
export const HYPERLIQUID = {
  venue: 'hyperliquid',
  label: 'Hyperliquid 永续',
  environment: 'testnet',
  mode: '测试网',
  baseUrl: 'https://api.hyperliquid-testnet.xyz',
  hosts: ['api.hyperliquid-testnet.xyz'],
  defaultAccountId: 'acct_01TESTNET',
  defaultInstrumentId: 'hyperliquid:BTC',
  defaultSize: '0.001',
  credentials: [
    { env: 'HL_TESTNET_MAIN_ADDRESS', field: 'mainAddress' },
    { env: 'HL_TESTNET_API_WALLET_KEY', field: 'apiWalletKey' },
  ],
  baseUrlSource: 'packages/connector-hyperliquid/src/rest.ts:12（HL_ENDPOINTS.testnet.http）',
}

/** 取一份场所参数；未知场所直接抛（入口脚本只用自己的那份，正常不会走到）。 */
export function venueSpec(venue) {
  const spec = VENUES[venue] ?? (venue === HYPERLIQUID.venue ? HYPERLIQUID : undefined)
  if (!spec) throw new Error(`unknown venue: ${venue}`)
  return spec
}

/** 从协议标的 id 里取场所原生符号（binance:BTCUSDT → BTCUSDT）。 */
export function nativeSymbolOf(instrumentId) {
  const index = String(instrumentId).indexOf(':')
  return index < 0 ? String(instrumentId) : String(instrumentId).slice(index + 1)
}
