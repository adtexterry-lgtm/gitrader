// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid 永续 · 测试网旅程入口。只在测试网跑：environment 恒为 testnet，
// 基址用连接器自己的测试网常量（packages/connector-hyperliquid/src/rest.ts:12）。
// 凭据只读 HL_TESTNET_MAIN_ADDRESS（主账户公开地址）与 HL_TESTNET_API_WALLET_KEY（API 钱包私钥）；
// 主网惯用名（HL_API_KEY / HL_API_SECRET）不会被本脚本读取。
//
// 与走 lib/cli.mjs 的五个场所的差别（都在本文件里补，不改 lib/）：
//   1. 构造选项里没有凭据字段：HyperliquidConnector 的签名走内核注入的 signer 句柄（包 README「交易」节），
//      连接器永远拿不到私钥。所以地址与签名器在这里装配（journeyView），与 dYdX 旅程的做法一致。
//   2. 构造选项里也没有 baseUrl：HlHttp 的基址固定取 HL_ENDPOINTS[environment].http（rest.ts:95）。
//      因此 --base-url 不能被连接器兑现，本脚本对任何非测试网基址一律拒绝（外部主机先由登记表挡成退出 2，
//      这里再挡一次回环地址 / 本地镜像这类登记表允许但连接器做不到的写法，退出 1）。
//   3. 账户读：旅程只走 REST（useWs: false + accounts.stream: false），不依赖 WebSocket；
//      账户快照由后台 REST 刷新，journeyView 只读等它落地，不发任何写请求（G16）。
//
// 真跑会访问 api.hyperliquid-testnet.xyz（见 README）；不出网时用 test/journey-hyperliquid.test.mjs 的假 fetch。
import { pathToFileURL } from 'node:url'
import { runCli } from './lib/cli.mjs'
import { loadBundle } from './lib/load-connector.mjs'
import { venueSpec } from './lib/venues.mjs'

export const venue = 'hyperliquid'
export const spec = venueSpec(venue)

/** 交易连接器入口（包的 src/index.ts）。 */
export const CONNECTOR_ENTRY = 'packages/connector-hyperliquid/src/index.ts'
/** 内核的 EIP-712 签名器：连接器只收 signTypedData 句柄，这里用内核同一份实现给旅程装上。 */
export const EIP712_ENTRY = 'packages/kernel/src/eip712.ts'
/** 测试网基址，照抄 packages/connector-hyperliquid/src/rest.ts:12 的 HL_ENDPOINTS.testnet.http。 */
export const TESTNET_BASE_URL = 'https://api.hyperliquid-testnet.xyz'

const API_WALLET_KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function usageError(message) {
  const error = new Error(message)
  error.code = 'USAGE'
  return error
}

/** API 钱包私钥（十六进制，0x 前缀可有可无）→ 32 字节；不合法就抛，报错里不出现密钥原文。 */
export function parseApiWalletKey(raw) {
  const text = String(raw ?? '').trim()
  if (!API_WALLET_KEY_RE.test(text)) throw new Error('HL_TESTNET_API_WALLET_KEY 不是 64 位十六进制私钥（不打印密钥本身）')
  return Uint8Array.from(Buffer.from(text.replace(/^0x/, ''), 'hex'))
}

/** 主账户公开地址 → 小写（连接器按小写比对 WS 推送里的 user 字段）。 */
export function parseMainAddress(raw) {
  const text = String(raw ?? '').trim()
  if (!ADDRESS_RE.test(text)) throw new Error('HL_TESTNET_MAIN_ADDRESS 必须是 0x 开头的 20 字节地址（公开地址，不是密钥）')
  return text.toLowerCase()
}

/**
 * HL 的 instrument 没有 tick：价格规则是「≤ 5 位有效数字，小数位 ≤ 6 − szDecimals」
 * （packages/connector-hyperliquid/src/precision.ts），不是固定 tick。旅程引擎按
 * `snapDown(参考价 × 0.85, tick)` 贴价，拿引擎自带的 1e-6 兜底会被场所按 1002 PRECISION 拒。
 * 所以这里按同一个规则、由参考价算一个合法步长：dp = clamp(sigFigs − 整数位数, 0, maxDecimals)，
 * 参考价 < 1 时改看小数点后紧跟的零（与包的 leadingZerosAfterPoint 同口径）。
 */
export function tickFor(instrument, referencePrice) {
  const price = instrument?.price ?? {}
  const maxDecimals = Number.isInteger(price.maxDecimals) ? price.maxDecimals : 6
  const sigFigs = Number.isInteger(price.sigFigs) ? price.sigFigs : 5
  const text = String(referencePrice ?? '')
  const integer = /^\d+/.exec(text)?.[0]?.replace(/^0+/, '') ?? ''
  const leadingZeros = text.startsWith('0.') ? (/^0\.(0*)/.exec(text)?.[1]?.length ?? 0) : 0
  const dp = integer.length > 0
    ? Math.min(maxDecimals, Math.max(0, sigFigs - integer.length))
    : Math.min(maxDecimals, sigFigs + leadingZeros)
  return dp <= 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`
}

/**
 * 基址守卫：连接器把测试网基址写死在自己的常量里（rest.ts:95），改不了。
 * 登记表允许的本机回环（本地镜像 / 假服务器）在这里按「做不到」拒掉，而不是假装用了它。
 */
export function assertFixedBaseUrl(raw) {
  const text = String(raw ?? '').trim().replace(/\/+$/, '')
  if (text !== TESTNET_BASE_URL) {
    throw usageError(`Hyperliquid 连接器的基址固定在 ${TESTNET_BASE_URL}（rest.ts:95），不接受 ${text || '(空)'}；脚本不连别的地址`)
  }
}

/**
 * 旅程要的连接器壳：换账户地址（旅程引擎给的是哨兵 0x000…0）、换签名器（引擎给的是不签名的占位句柄）。
 * 注意这里没有任何把读失败改写成写请求的分支（G16）：账户 / 盘口读失败一律上抛，由旅程引擎停机。
 */
export function journeyView({ connector, signer, mainAddress, snapshotWaitMs = 3000, snapshotPollMs = 100 }) {
  const asAccount = (ref) => ({ ...(ref ?? {}), address: mainAddress })
  const asCtx = (ctx) => ({ ...(ctx ?? {}), account: asAccount(ctx?.account), signer })
  // 最近一次盘口买价：引擎先拿参考价、再按 tick 贴价；instrument 的 tick 用 getter 现算（见 tickFor）。
  let referencePrice

  return {
    venue,
    environment: connector.environment,
    describe: () => connector.describe(),
    start: () => connector.start(),
    async accountState(ref) {
      // 首次读通常是空的旧缓存（快照由后台 REST 维护）；只读地等它落地，超时就按现状返回。
      const deadline = Date.now() + snapshotWaitMs
      let snapshot = await connector.accountState(asAccount(ref))
      while (snapshot && snapshot.stale !== false && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, snapshotPollMs))
        snapshot = await connector.accountState(asAccount(ref))
      }
      return snapshot
    },
    getInstrument(instrumentId) {
      const instrument = connector.getInstrument(instrumentId)
      if (!instrument || !instrument.price || instrument.price.tick !== undefined) return instrument
      const price = instrument.price
      // getter：引擎在 book() 之后、贴价的时候才读 tick，这时参考价已经上来了。
      return { ...instrument, price: { ...price, get tick() { return tickFor(instrument, referencePrice) } } }
    },
    async book(instrumentId, depth) {
      const book = await connector.book(instrumentId, depth)
      const bid = Array.isArray(book?.bids) && book.bids.length > 0 ? book.bids[0].price : undefined
      const ask = Array.isArray(book?.asks) && book.asks.length > 0 ? book.asks[0].price : undefined
      referencePrice = bid ?? ask ?? referencePrice
      return book
    },
    submit: (ctx, intents) => connector.submit(asCtx(ctx), intents),
    orderStatus: (ref, key) => connector.orderStatus(asAccount(ref), key),
    cancel: (ctx, targets) => connector.cancel(asCtx(ctx), targets),
    amend: (ctx, request) => connector.amend(asCtx(ctx), request),
    close: () => connector.close(),
  }
}

/** 真跑用的连接器工厂：本仓 TS 源码用 esbuild 打成临时 ESM 再实例化（见 lib/load-connector.mjs）。 */
export async function createConnector({ credentials, environment, baseUrl, fetchImpl, clock }) {
  assertFixedBaseUrl(baseUrl)
  if (environment !== 'testnet') throw usageError(`environment=${String(environment)}：本脚本只跑 testnet`)
  const key = parseApiWalletKey(credentials?.apiWalletKey)
  const mainAddress = parseMainAddress(credentials?.mainAddress)

  const bundle = await loadBundle({ connector: CONNECTOR_ENTRY, eip712: EIP712_ENTRY })
  const signer = {
    address: bundle.eip712.addressOf(key),
    async signTypedData(typedData) {
      return bundle.eip712.signTypedDataWithKey(typedData, key).signature
    },
  }
  const connector = new bundle.connector.HyperliquidConnector({
    environment,
    // 旅程只要 REST：不开 WS，账户快照由后台 REST 维护（见文件头第 3 条）。
    useWs: false,
    accounts: { stream: false },
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
    onWarn: () => {},
  })
  return journeyView({ connector, signer, mainAddress })
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli({ spec, argv, createConnector, deps })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
