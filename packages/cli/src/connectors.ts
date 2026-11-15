// SPDX-License-Identifier: CPAL-1.0
// 第一方连接器注册表：`config.venues` 里的 venue id → 工厂。
// 新增一家 = 在 CONNECTOR_FACTORIES 里加一个条目（以及 cli/package.json 的工作区依赖）；装配逻辑不再按 id 分支。
import type { Kernel } from '@gitrader/kernel'
import { asDecimal } from '@gitrader/protocol'
import type { CandleInterval, Instrument, InstrumentId, Ms, VenueCatalogEntry } from '@gitrader/protocol'
import type { BookSnapshot, SubscriptionSpec, Unsubscribe, VenueConnector, VenueEvent } from '@gitrader/protocol/connector'
import { HyperliquidConnector } from '@gitrader/connector-hyperliquid'
import { BinanceDataConnector } from '@gitrader/connector-binance-data'
import { OkxDataConnector } from '@gitrader/connector-okx-data'
import { KrakenDataConnector } from '@gitrader/connector-kraken-data'
import { CoinbaseDataConnector } from '@gitrader/connector-coinbase-data'
import { BybitDataConnector } from '@gitrader/connector-bybit-data'
import { BitgetDataConnector } from '@gitrader/connector-bitget-data'
import { GateioDataConnector } from '@gitrader/connector-gateio-data'
import { BinanceTradeConnector } from '@gitrader/connector-binance-trade'
import { OkxTradeConnector } from '@gitrader/connector-okx-trade'
import { BybitTradeConnector } from '@gitrader/connector-bybit-trade'
import { BitgetTradeConnector } from '@gitrader/connector-bitget-trade'
import { GateioTradeConnector } from '@gitrader/connector-gateio-trade'
import { KucoinDataConnector } from '@gitrader/connector-kucoin-data'
import { DydxDataConnector } from '@gitrader/connector-dydx-data'
import { DeribitDataConnector } from '@gitrader/connector-deribit-data'
import { AlpacaDataConnector } from '@gitrader/connector-alpaca-data'
import { AlpacaTradeConnector } from '@gitrader/connector-alpaca-trade'
import { IbkrTradeConnector } from '@gitrader/connector-ibkr-trade'
import { PaperVenue } from '@gitrader/venue-paper'
import type { PaperMarket } from '@gitrader/venue-paper'
import type { CliIo } from './index'

export interface ConnectorFactoryContext {
  k: Kernel
  io: CliIo
  environment: 'mainnet' | 'testnet'
}

export interface ConnectorFactory {
  id: string
  kind: 'trading' | 'data'
  catalogKind: VenueCatalogEntry['kind']
  verified: boolean
  credentials: readonly string[]
  create(ctx: ConnectorFactoryContext): {
    connector: VenueConnector
    start?: () => Promise<void>
    kind?: 'trading' | 'data'
    registration?: { unverified: boolean; pollOrders: boolean; deadman: boolean }
    marketSource?: VenueConnector
    marketOnly?: boolean
  }
}

type AssembledMarketSource = { id: string; connector: VenueConnector; tradeConnector?: VenueConnector; kind: ConnectorFactory['kind'] }

function createPaperMarket(sources: readonly AssembledMarketSource[], preferred: AssembledMarketSource, k: Kernel, io: CliIo): PaperMarket {
  const normalizeInstrument = (instrument: Instrument): Instrument => instrument.venueSizeUnit === 'base'
    ? { ...instrument, contractSize: asDecimal('1') }
    : instrument
  const sourceFor = (instrumentId: InstrumentId): AssembledMarketSource | undefined => {
    const separator = instrumentId.indexOf(':')
    return separator > 0 ? sources.find((source) => source.id === instrumentId.slice(0, separator)) : undefined
  }
  const unknownInstrument = (instrumentId: InstrumentId): Error => new Error(`no assembled market source for ${instrumentId}`)
  return {
    venue: preferred.connector.venue,
    environment: preferred.connector.environment,
    describe: () => preferred.connector.describe(),
    status: () => preferred.connector.status(),
    listInstruments: (options) => {
      const combined: Instrument[] = []
      let successes = 0
      for (const source of sources) {
        try {
          combined.push(...(source.tradeConnector ?? source.connector).listInstruments(options).map(normalizeInstrument))
          successes++
        } catch {
          io.err(`[gitrader] warning: paper market instrument listing failed for ${source.id}\n`)
        }
      }
      if (successes === 0) throw new Error('no assembled market source could list instruments')
      return combined
    },
    getInstrument: (instrumentId) => {
      const source = sourceFor(instrumentId)
      const instrument = source?.tradeConnector?.getInstrument(instrumentId) ?? source?.connector.getInstrument(instrumentId)
      return instrument ? normalizeInstrument(instrument) : undefined
    },
    quote: (instrumentId) => sourceFor(instrumentId)?.connector.quote(instrumentId),
    book: async (instrumentId, depth) => {
      const source = sourceFor(instrumentId)
      if (!source) throw unknownInstrument(instrumentId)
      return source.connector.book(instrumentId, depth)
    },
    candles: async (instrumentId, interval: CandleInterval, options?: { n?: number; from?: Ms; to?: Ms }) => {
      const source = sourceFor(instrumentId)
      if (!source) throw unknownInstrument(instrumentId)
      return source.connector.candles(instrumentId, interval, options)
    },
    context: async (instrumentId) => {
      const source = sourceFor(instrumentId)
      if (!source) throw unknownInstrument(instrumentId)
      return source.connector.context(instrumentId)
    },
    bookSnapshot: (instrumentId): BookSnapshot | undefined => sourceFor(instrumentId)?.connector.bookSnapshot?.(instrumentId),
    refreshBook: async (instrumentId, options) => {
      const source = sourceFor(instrumentId)
      if (!source) return undefined
      if (source.connector.refreshBook) return source.connector.refreshBook(instrumentId, options)
      try {
        const snapshot = await source.connector.book(instrumentId)
        return { book: snapshot, asOf: snapshot.ts, stale: k.clock.now() - snapshot.ts > 5_000 }
      } catch {
        return undefined
      }
    },
    subscribe: (spec: SubscriptionSpec, callback: (event: VenueEvent) => void): Unsubscribe => {
      if (spec.channel === 'userFills' || spec.channel === 'orderUpdates') throw new Error('paper market does not forward private account subscriptions')
      if ('instrumentId' in spec) {
        const source = sourceFor(spec.instrumentId)
        if (!source) throw unknownInstrument(spec.instrumentId)
        return source.connector.subscribe(spec, callback)
      }
      if (spec.channel !== 'mids' && spec.channel !== 'instruments') throw new Error('paper market subscription requires an instrument')
      const unsubscribe: Unsubscribe[] = []
      for (const source of sources) {
        try { unsubscribe.push(source.connector.subscribe(spec, callback)) } catch { /* try the remaining public market sources */ }
      }
      if (unsubscribe.length === 0) throw new Error('no assembled market source supports this subscription')
      return () => {
        let firstError: unknown
        let hasError = false
        for (const stop of unsubscribe) {
          try { stop() } catch (error) {
            if (!hasError) { firstError = error; hasError = true }
          }
        }
        if (hasError) throw firstError
      }
    },
  }
}

interface TradeAccount {
  venue: string
  environment: 'mainnet' | 'testnet'
  mode: string
  credentials?: Record<string, string>
}

const TRADE_CONNECTORS_VERIFIED = false

function tradeFallback(ctx: ConnectorFactoryContext, id: string, required: readonly string[], makeData: () => { connector: VenueConnector; start?: () => Promise<void> }, makeTrade: (values: Record<string, string>, onWarn: (message: string) => void) => VenueConnector & { start?: () => Promise<void> }): ReturnType<ConnectorFactory['create']> {
  const accounts = (ctx.k.config as typeof ctx.k.config & { accounts?: TradeAccount[] }).accounts ?? []
  if (accounts.some((a) => a.venue === id && a.mode === 'live' && a.environment === 'mainnet')) {
    ctx.io.err(`[gitrader] warning: ${id} trade connector is unavailable for a venue with a mainnet live account; using data connector\n`)
    return { ...makeData(), kind: 'data' }
  }
  const account = ctx.environment === 'testnet'
    ? accounts.find((a) => a.venue === id && a.mode === 'live' && a.environment === 'testnet')
    : undefined
  if (!account) return { ...makeData(), kind: 'data' }
  const handles = account.credentials ?? {}
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const key of required) {
    const handle = handles[key]
    const variable = typeof handle === 'string' && handle.startsWith('env:') && handle.length > 4 ? handle.slice(4) : undefined
    if (!variable) { missing.push(key); continue }
    try {
      const value = ctx.k.opts?.resolveSecret?.(`env:${variable}`)
      if (value) values[key] = value
      else missing.push(variable)
    } catch {
      missing.push(variable)
    }
  }
  if (missing.length) {
    ctx.io.err(`[gitrader] warning: ${id} trade connector is unavailable; unresolved credentials: ${[...new Set(missing)].join(', ')}; using data connector\n`)
    return { ...makeData(), kind: 'data' }
  }
  const onWarn = (_message: string): void => { ctx.io.err(`[gitrader] warning: ${id} connector reported a background warning\n`) }
  try {
    const connector = makeTrade(values, onWarn)
    return {
      connector,
      ...(connector.start ? { start: () => connector.start!() } : {}),
      kind: 'trading',
      registration: { unverified: !TRADE_CONNECTORS_VERIFIED, pollOrders: true, deadman: false },
    }
  } catch {
    ctx.io.err(`[gitrader] warning: ${id} trade connector could not be created; using data connector\n`)
    return { ...makeData(), kind: 'data' }
  }
}

/** 第一方连接器工厂表；新增一家 = 加一个条目（以及 cli/package.json 的工作区依赖）。 */
export const CONNECTOR_FACTORIES: readonly ConnectorFactory[] = [
  {
    id: 'ibkr',
    kind: 'trading',
    catalogKind: 'trading', verified: false, credentials: [],
    create: (ctx) => {
      const { k, io } = ctx
      const venue = k.config.venues.find((item) => item.id === 'ibkr')
      const accounts = k.config.accounts.filter((item) => item.venue === 'ibkr')
      const liveAccounts = accounts.filter((item) => item.mode === 'live')
      if (liveAccounts.some((item) => item.environment === 'mainnet')) throw new Error('IBKR mainnet live trading is unavailable')
      const liveAccount = liveAccounts[0]
      const marketOnly = liveAccount === undefined
      const refs = [...new Set(accounts.map((item) => item.owner?.accountRef?.trim()).filter((value): value is string => !!value))]
      if (marketOnly && refs.length > 1) throw new Error('IBKR owner.accountRef configuration is ambiguous')
      const account = liveAccount?.owner?.accountRef?.trim() || (marketOnly ? refs[0] : undefined)
      const symbols = venue?.symbols ? [...venue.symbols] : []
      if (symbols.length === 0) throw new Error('IBKR requires configured symbols')
      const connector = new IbkrTradeConnector({
        mode: 'paper',
        clientId: 7,
        ...(account ? { account } : {}),
        symbols,
        clock: () => k.clock.now(),
        onWarn: () => io.err('[gitrader] warning: IBKR connector warning\n'),
      })
      const originalContext = connector.context.bind(connector)
      connector.context = async (id) => {
        try { await connector.refreshQuote(id) } catch { /* preserve the connector's existing cached quote semantics */ }
        return originalContext(id)
      }
      const start = async (): Promise<void> => {
        try {
          await connector.start()
        } catch (error) {
          const name = (error as { problem?: { name?: string } } | null)?.problem?.name
          if (name === 'INVALID_PARAMS' && account === undefined) {
            throw new Error('IBKR session needs owner.accountRef when multiple accounts are available')
          }
          throw new Error('IBKR connector unavailable: VENUE_UNAVAILABLE')
        }
        const instruments = new Set(connector.listInstruments().map((item) => item.instrumentId))
        const qualified = symbols.filter((symbol) => instruments.has(`ibkr:${symbol}` as never))
        const missing = symbols.filter((symbol) => !qualified.includes(symbol))
        if (missing.length) io.err(`[gitrader] warning: IBKR contract qualification failed for: ${missing.join(', ')}\n`)
        if (qualified.length === 0) throw new Error('IBKR connector unavailable: DATA_UNAVAILABLE')
        let freshQuotes = 0
        const missingQuotes: string[] = []
        for (const symbol of qualified) {
          const id = `ibkr:${symbol}`
          try {
            if (await connector.refreshQuote(id as never)) freshQuotes++
            else missingQuotes.push(symbol)
          } catch {
            missingQuotes.push(symbol)
          }
        }
        if (missingQuotes.length) io.err(`[gitrader] warning: IBKR market data unavailable for: ${missingQuotes.join(', ')}\n`)
        if (freshQuotes === 0) throw new Error('IBKR connector unavailable: DATA_UNAVAILABLE')
      }
      return {
        connector,
        start,
        kind: marketOnly ? 'data' : 'trading',
        ...(marketOnly ? { marketOnly: true } : {}),
        registration: { unverified: true, pollOrders: !marketOnly, deadman: false },
      }
    },
  },
  {
    id: 'hyperliquid',
    kind: 'trading',
    catalogKind: 'trading', verified: true, credentials: [],
    create: ({ k, environment }) => {
      const hl = new HyperliquidConnector({ environment, budget: k.bus.budgetFor('hyperliquid') as never, supportDeveloper: k.config.supportDeveloper === true, clock: () => k.clock.now() })
      return { connector: hl, start: () => hl.start() }
    },
  },
  {
    id: 'binance',
    kind: 'data',
    catalogKind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret'],
    create: (ctx) => {
      const { k } = ctx
      // 同场所测试环境实盘账户具备所需凭据时可选 trade；其余按 tradeFallback 规则退回只读 data，主网仍硬拒 trade。
      return tradeFallback(ctx, 'binance', ['apiKey', 'apiSecret'],
        () => { const binance = new BinanceDataConnector({ budget: k.bus.budgetFor('binance') as never, clock: () => k.clock.now() }); return { connector: binance, start: () => binance.start() } },
        (v, onWarn) => new BinanceTradeConnector({ environment: ctx.environment, apiKey: v.apiKey!, apiSecret: v.apiSecret!, clock: () => k.clock.now(), onWarn }))
    },
  },
  {
    id: 'okx',
    kind: 'data',
    catalogKind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret', 'passphrase'],
    create: (ctx) => {
      const { k } = ctx
      // 同场所测试环境实盘账户具备所需凭据时可选 trade；其余按 tradeFallback 规则退回只读 data，主网仍硬拒 trade。
      return tradeFallback(ctx, 'okx', ['apiKey', 'apiSecret', 'passphrase'],
        () => { const okx = new OkxDataConnector({ budget: k.bus.budgetFor('okx') as never, clock: () => k.clock.now() }); return { connector: okx, start: () => okx.start() } },
        (v, onWarn) => new OkxTradeConnector({ environment: ctx.environment, apiKey: v.apiKey!, apiSecret: v.apiSecret!, passphrase: v.passphrase!, clock: () => k.clock.now(), onWarn }))
    },
  },
  {
    id: 'kraken',
    kind: 'data',
    catalogKind: 'data', verified: false, credentials: [],
    create: ({ k }) => {
      // Kraken 数据连接器只提供行情（mainnet 公共接口，无密钥）；交易能力全部声明为 none。
      const kraken = new KrakenDataConnector({ budget: k.bus.budgetFor('kraken') as never, clock: () => k.clock.now() })
      return { connector: kraken, start: () => kraken.start() }
    },
  },
  {
    id: 'coinbase',
    kind: 'data',
    catalogKind: 'data', verified: false, credentials: [],
    create: ({ k }) => {
      // Coinbase 数据连接器只提供行情（mainnet 公共接口，无密钥）；交易能力全部声明为 none。
      const coinbase = new CoinbaseDataConnector({ budget: k.bus.budgetFor('coinbase') as never, clock: () => k.clock.now() })
      return { connector: coinbase, start: () => coinbase.start() }
    },
  },
  {
    id: 'bybit',
    kind: 'data',
    catalogKind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret'],
    create: (ctx) => {
      const { k } = ctx
      // 同场所测试环境实盘账户具备所需凭据时可选 trade；其余按 tradeFallback 规则退回只读 data，主网仍硬拒 trade。
      return tradeFallback(ctx, 'bybit', ['apiKey', 'apiSecret'],
        () => { const bybit = new BybitDataConnector({ budget: k.bus.budgetFor('bybit') as never, clock: () => k.clock.now() }); return { connector: bybit, start: () => bybit.start() } },
        (v, onWarn) => new BybitTradeConnector({ environment: ctx.environment, apiKey: v.apiKey!, apiSecret: v.apiSecret!, clock: () => k.clock.now(), onWarn }))
    },
  },
  {
    id: 'bitget',
    kind: 'data',
    catalogKind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret', 'passphrase'],
    create: (ctx) => {
      const { k } = ctx
      // 同场所测试环境实盘账户具备所需凭据时可选 trade；其余按 tradeFallback 规则退回只读 data，主网仍硬拒 trade。
      return tradeFallback(ctx, 'bitget', ['apiKey', 'apiSecret', 'passphrase'],
        () => { const bitget = new BitgetDataConnector({ budget: k.bus.budgetFor('bitget') as never, clock: () => k.clock.now() }); return { connector: bitget, start: () => bitget.start() } },
        (v, onWarn) => new BitgetTradeConnector({ environment: ctx.environment, simulated: ctx.environment === 'testnet', apiKey: v.apiKey!, apiSecret: v.apiSecret!, passphrase: v.passphrase!, clock: () => k.clock.now(), onWarn }))
    },
  },
  {
    id: 'gateio',
    kind: 'data',
    catalogKind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret'],
    create: (ctx) => {
      const { k } = ctx
      // 同场所测试环境实盘账户具备所需凭据时可选 trade；其余按 tradeFallback 规则退回只读 data，主网仍硬拒 trade。
      return tradeFallback(ctx, 'gateio', ['apiKey', 'apiSecret'],
        () => { const gateio = new GateioDataConnector({ budget: k.bus.budgetFor('gateio') as never, clock: () => k.clock.now() }); return { connector: gateio, start: () => gateio.start() } },
        (v, onWarn) => new GateioTradeConnector({ environment: ctx.environment, apiKey: v.apiKey!, apiSecret: v.apiSecret!, clock: () => k.clock.now(), onWarn }))
    },
  },
  {
    id: 'kucoin',
    kind: 'data',
    catalogKind: 'data', verified: false, credentials: [],
    create: ({ k }) => {
      // KuCoin 数据连接器只提供行情（mainnet 公共接口，无密钥）；交易能力全部声明为 none。
      const kucoin = new KucoinDataConnector({ budget: k.bus.budgetFor('kucoin') as never, clock: () => k.clock.now() })
      return { connector: kucoin, start: () => kucoin.start() }
    },
  },
  {
    id: 'dydx',
    kind: 'data',
    catalogKind: 'data', verified: false, credentials: [],
    create: ({ k }) => {
      // dYdX 数据连接器只提供行情（mainnet 公共接口，无密钥）；交易能力全部声明为 none。
      const dydx = new DydxDataConnector({ budget: k.bus.budgetFor('dydx') as never, clock: () => k.clock.now() })
      return { connector: dydx, start: () => dydx.start() }
    },
  },
  {
    id: 'deribit',
    kind: 'data',
    catalogKind: 'data', verified: false, credentials: [],
    create: ({ k }) => {
      // Deribit 数据连接器只提供行情（mainnet 公共接口，无密钥）；交易能力全部声明为 none。
      const deribit = new DeribitDataConnector({ budget: k.bus.budgetFor('deribit') as never, clock: () => k.clock.now() })
      return { connector: deribit, start: () => deribit.start() }
    },
  },
  {
    id: 'alpaca',
    kind: 'trading', catalogKind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret'],
    create: (ctx) => {
      const accounts = (ctx.k.config as typeof ctx.k.config & { accounts?: TradeAccount[] }).accounts ?? []
      const sameEnv = accounts.filter((a) => a.venue === 'alpaca' && a.environment === ctx.environment)
      const liveTestnet = ctx.environment === 'testnet'
        ? sameEnv.find((a) => a.mode === 'live')
        : undefined
      const mainnetLive = ctx.environment === 'mainnet' && sameEnv.find((a) => a.mode === 'live')
      const credentialsOf = (account: TradeAccount | undefined): [string, string] | undefined => {
        const credentials = account?.credentials
        const key = credentials?.apiKey
        const secret = credentials?.apiSecret
        if (typeof key !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof secret !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) return undefined
        return [key, secret]
      }
      const resolvePair = (pair: [string, string] | undefined): { apiKey: string; apiSecret: string } => {
        if (!pair) throw new Error('Alpaca connector unavailable: configured credentials are missing or ambiguous')
        try {
          const apiKey = ctx.k.opts?.resolveSecret?.(pair[0])
          const apiSecret = ctx.k.opts?.resolveSecret?.(pair[1])
          if (typeof apiKey !== 'string' || apiKey.length === 0 || typeof apiSecret !== 'string' || apiSecret.length === 0) throw new Error()
          return { apiKey, apiSecret }
        } catch {
          throw new Error('Alpaca connector unavailable: configured credentials are missing or ambiguous')
        }
      }
      let pair: [string, string] | undefined
      if (liveTestnet) {
        pair = credentialsOf(liveTestnet)
      } else {
        const eligible = sameEnv.filter((a) => a.mode === 'paper' || a.mode === 'shadow' || (mainnetLive && a.mode === 'live'))
          .map(credentialsOf).filter((value): value is [string, string] => value !== undefined)
        const unique = new Map(eligible.map((value) => [`${value[0]}\u0000${value[1]}`, value]))
        if (unique.size === 1) pair = [...unique.values()][0]
        else throw new Error('Alpaca connector unavailable: configured credentials are missing or ambiguous')
      }
      const values = resolvePair(pair)
      const budget = ctx.k.bus.budgetFor('alpaca') as never
      const marketSource = new AlpacaDataConnector({
        environment: ctx.environment === 'testnet' ? 'paper' : 'live',
        keyId: values.apiKey, secretKey: values.apiSecret, env: {}, budget, clock: () => ctx.k.clock.now(),
      })
      if (!liveTestnet || mainnetLive) {
        if (mainnetLive) ctx.io.err('[gitrader] warning: Alpaca trade connector is unavailable for a mainnet live account; using read-only market data\n')
        return {
          connector: marketSource, start: () => marketSource.start(), kind: 'data', marketOnly: true,
          registration: { unverified: true, pollOrders: false, deadman: false },
        }
      }
      const trade = new AlpacaTradeConnector({
        mode: 'paper', apiKey: values.apiKey, apiSecret: values.apiSecret, budget,
        clock: () => ctx.k.clock.now(), onWarn: () => ctx.io.err('[gitrader] warning: Alpaca connector warning\n'),
      })
      const start = async (): Promise<void> => {
        await trade.start()
        await trade.warmAssets()
        if (trade.stream.state !== 'connected') {
          trade.stream.close()
          try { await trade.stream.connect() } catch {
            trade.stream.close()
            throw new Error('Alpaca connector unavailable: VENUE_UNAVAILABLE')
          }
        }
        await marketSource.start()
      }
      return {
        connector: trade, marketSource, start, kind: 'trading',
        registration: { unverified: true, pollOrders: false, deadman: false },
      }
    },
  },
]

/** R3-20：观察账户的只读数据源——观察账户所在的网与交易场所连的网不一致（或场所没连）时，内核经它按地址读公开账户状态。
 *  只暴露 accountState / openOrders / close：不带签名器，不登记进总线（下单路由永远拿不到它）；速率预算与交易连接共用同一份。
 *  不 start、不连 WS、不起定时器；首次读做最轻的 dex 发现（perpDexs 一次），允许列出 builder dex 持仓（HIP-3）。 */
export function hyperliquidWatchSource(k: Kernel, environment: 'mainnet' | 'testnet'): Pick<VenueConnector, 'accountState' | 'openOrders'> & { close(): Promise<void> } {
  const hl = new HyperliquidConnector({ environment, budget: k.bus.budgetFor('hyperliquid') as never, clock: () => k.clock.now(), useWs: false, discoveryIntervalMs: 0, accounts: { stream: false } })
  let discovered = false
  const ensureDiscovery = async (): Promise<void> => {
    if (discovered) return
    try {
      await hl.discoverDexNames()
      discovered = true
    } catch {
      // 发现失败时至少能读主 dex；下次重试
    }
  }
  const waitReady = async (ref: Parameters<typeof hl.accountState>[0]): Promise<void> => {
    const accounts = hl['accounts'] as any
    if (!accounts?.tracked) return
    const t = accounts.tracked.get(ref.address.toLowerCase())
    if (t?.restFlight?.promise) await t.restFlight.promise
  }
  return {
    accountState: async (ref) => {
      await ensureDiscovery()
      const first = await hl.accountState(ref)
      if (first.stale) {
        await waitReady(ref)
        return hl.accountState(ref)
      }
      return first
    },
    openOrders: async (ref) => {
      await ensureDiscovery()
      return hl.openOrders(ref)
    },
    close: () => hl.close(),
  }
}

export function factoryFor(id: string): ConnectorFactory | undefined {
  return CONNECTOR_FACTORIES.find((f) => f.id === id)
}

/** 按 `config.venues` 装配：`enabled !== false` 的逐个查表 → create → `k.registerConnector` → 有 start 就 `k.connectInBackground`。
 *  未知 id 与单个失败都只跳过并提示一行；随后用行情源建 PaperVenue（kernel-sim）：优先 hyperliquid，
 *  否则第一个装配成功的 trading，再否则第一个 data（只读行情，提示一行）；都没有就不建。
 *  只做同步装配 + 把“连行情”丢到后台：不等网络，工作台与 MCP 立刻可用。 */
export function assembleConnectors(ctx: Omit<ConnectorFactoryContext, 'environment'>): { id: string; ok: boolean; error?: string }[] {
  const { k, io } = ctx
  k.connectorCatalog = CONNECTOR_FACTORIES.map((factory) => ({
    venue: factory.id, kind: factory.catalogKind, verified: factory.verified, credentials: [...factory.credentials],
  }))
  const results: { id: string; ok: boolean; error?: string }[] = []
  const assembled: AssembledMarketSource[] = []
  k.bus.setWatchSourceFactory?.((venue, environment) => (venue === 'hyperliquid' ? hyperliquidWatchSource(k, environment) : undefined)) // 测试桩的 bus 可能没有这个方法
  for (const v of k.config.venues) {
    if (v.enabled === false) continue
    const factory = factoryFor(v.id)
    if (!factory) {
      io.err(`[gitrader] unknown venue in config: ${v.id} (skipped)\n`)
      results.push({ id: v.id, ok: false, error: 'unknown venue' })
      continue
    }
    try {
      const { connector, start, kind, registration, marketSource, marketOnly } = factory.create({ k, io, environment: v.environment })
      if (marketOnly) k.bus.registerMarketSource(connector as never, registration)
      else k.registerConnector(connector as never, registration)
      if (marketSource) k.bus.registerMarketSource(marketSource as never, registration)
      if (start) k.connectInBackground(v.id, start)
      assembled.push({ id: v.id, connector: marketSource ?? connector, ...(marketSource ? { tradeConnector: connector } : {}), kind: kind ?? factory.kind })
      results.push({ id: v.id, ok: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      io.err(`[gitrader] could not set up the ${v.id} connector: ${message}\n`)
      results.push({ id: v.id, ok: false, error: message })
    }
  }
  const market =
    assembled.find((a) => a.id === 'hyperliquid') ??
    assembled.find((a) => a.kind === 'trading') ??
    assembled.find((a) => a.kind === 'data')
  if (!market) {
    io.err('[gitrader] no venue connector could be set up, so PaperVenue (kernel-sim) is not available\n')
    return results
  }
  if (market.id !== 'hyperliquid') {
    io.err(
      market.kind === 'data'
        ? `[gitrader] PaperVenue (kernel-sim) uses ${market.id} market data, a data-only (只读) feed, because no hyperliquid venue is configured\n`
        : `[gitrader] PaperVenue (kernel-sim) uses ${market.id} market data because no hyperliquid venue is configured\n`,
    )
  }
  const paper = new PaperVenue({
    market: createPaperMarket(assembled, market, k, io),
    clock: () => k.clock.now(),
    onWarn: (message) => io.err(`[gitrader] warning: ${message}\n`),
  })
  k.registerConnector(paper as never)
  paper.start()
  return results
}

/** Register the replay-backed paper venue without starting its wall-clock polling timer. */
export function assembleReplayPaper(ctx: { k: Kernel; market: PaperMarket; clock: () => number; io: CliIo }): PaperVenue {
  const paper = new PaperVenue({
    market: ctx.market,
    clock: ctx.clock,
    onWarn: (message) => ctx.io.err(`[gitrader] warning: ${message}\n`),
  })
  ctx.k.registerConnector(paper as never)
  return paper
}

/** --offline：不连任何行情，但纸面场所 kernel-sim 仍要在，账户 / 持仓 / 余额读取才不报 ACCOUNT_NOT_BOUND。
 *  行情桩恒为「没有标的、没有报价」，所以纸面撮合不会成交（文档 10 §离线）。不调 paper.start()：没有行情，不开轮询定时器。 */
export function assembleOfflinePaper(ctx: { k: Kernel; io: CliIo }): PaperVenue {
  const venue = ctx.k.config.venues[0]
  const id = venue?.id ?? 'hyperliquid'
  const environment = venue?.environment ?? 'testnet'
  const offline = (what: string): Error => new Error(`offline: ${what} is not available without market data`)
  const market = {
    venue: id,
    environment,
    describe: () => ({ venue: id, environments: [environment], instrumentKinds: ['perp'], orderTypes: {}, tif: [], triggerPriceTypes: [] }),
    status: () => ({ venue: id, environment, ts: ctx.k.clock.now(), wsState: 'disconnected' as const }),
    listInstruments: () => [],
    getInstrument: () => undefined,
    quote: () => undefined,
    book: async () => { throw offline('order book') },
    candles: async () => { throw offline('candles') },
    context: async () => { throw offline('market context') },
    subscribe: () => () => undefined,
  } as unknown as PaperMarket
  const paper = new PaperVenue({ market, clock: () => ctx.k.clock.now(), onWarn: (message) => ctx.io.err(`[gitrader] warning: ${message}\n`) })
  ctx.k.registerConnector(paper as never)
  return paper
}
