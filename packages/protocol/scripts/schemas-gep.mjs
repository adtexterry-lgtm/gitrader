// SPDX-License-Identifier: Apache-2.0
// 引擎协议 GEP（契约 §2）的 JSON Schema 定义：describe、绑定、事件、回测、JSON-RPC 信封，以及每个方法的 params / result。
import { anyObj, arr, b, c, enm, i, konst, m, n, ne, obj, rec, ref, s, when, propIs } from './lib.mjs'

const g = (name) => ref('gep', name)
const prim = { type: ['number', 'boolean', 'string'] }

export function gepSchemas(K) {
  const out = {}
  const add = (name, schema) => { out[`gep:${name}`] = { domain: 'gep', name, title: name, schema } }
  const jsonRpcId = { type: ['string', 'integer'] }

  // ---- JSON-RPC 信封 ---------------------------------------------------------------------
  add('JsonRpcRequest', obj({ jsonrpc: konst('2.0'), id: jsonRpcId, method: ne(), params: { type: ['object', 'array'] } }, ['jsonrpc', 'id', 'method']))
  add('JsonRpcNotification', {
    ...obj({ jsonrpc: konst('2.0'), method: ne(), params: { type: ['object', 'array'] } }, ['jsonrpc', 'method']),
    not: { required: ['id'] },
  })
  add('JsonRpcResponse', {
    oneOf: [
      obj({ jsonrpc: konst('2.0'), id: jsonRpcId, result: {} }, ['jsonrpc', 'id', 'result']),
      obj({
        jsonrpc: konst('2.0'), id: { type: ['string', 'integer', 'null'] },
        error: obj({ code: i(), message: s(), data: m('Problem') }, ['code', 'message']),
      }, ['jsonrpc', 'id', 'error']),
    ],
  })

  // ---- 引擎启动配置（v0.1.2，语言无关）----
  add('EngineLaunch', {
    oneOf: [
      obj({ command: ne(), args: arr(s()), env: rec(s()), cwd: s() }, ['command']),
      obj({
        url: s({ pattern: '^wss?://' }),
        auth: {
          oneOf: [
            obj({ method: konst('token'), tokenRef: ne() }, ['method', 'tokenRef']),
            obj({ method: konst('mtls'), clientCertRef: ne(), caCertRef: s() }, ['method', 'clientCertRef']),
          ],
        },
      }, ['url', 'auth']),
    ],
  })

  // ---- hello ------------------------------------------------------------------------------
  add('GepHelloParams', obj({
    protocol: konst('gep'), versions: arr(ne(), { minItems: 1 }), host: obj({ name: ne(), version: ne() }, ['name', 'version']),
    auth: obj({ token: ne(), mtls: konst(true) }, [], { anyOf: [{ required: ['token'] }, { required: ['mtls'] }] }), resume: obj({ sessionId: ne(), lastSeq: i({ minimum: 0 }) }, ['sessionId', 'lastSeq']),
  }, ['protocol', 'versions', 'host', 'auth']))
  add('GepHelloResult', obj({
    version: ne(), sessionId: ne(), resumed: b(), fromSeq: i({ minimum: 0 }), engine: obj({ id: ne(), version: ne() }, ['id', 'version']),
  }, ['version', 'sessionId', 'resumed', 'engine']))

  // ---- describe ---------------------------------------------------------------------------
  const boolCap = (k) => [k, b()]
  const capProps = Object.fromEntries([
    ...['execution.modeA', 'execution.modeB', 'market.useHost', 'market.own', 'strategy', 'strategy.hotUpdate', 'backtest', 'replay', 'events.resume', 'risk.cooperative', 'builder.attach', 'decision.log'].map(boolCap),
    ['backtest.fillModels', arr(ne())],
    ['events.retention', obj({ minEvents: i({ minimum: 0 }), minMs: i({ minimum: 0 }) }, ['minEvents', 'minMs'])],
    ['halt.levels', arr(enm(K.TAKEOVER_LEVELS), { contains: { const: 'halt_new' } })],
  ])
  const capOn = (k) => ({ required: [k], properties: { [k]: konst(true) } })
  add('EngineDescribe', obj({
    engine: obj({
      id: ne(), name: ne(), version: ne(),
      vendor: obj({ id: ne(), name: ne(), kind: enm(K.VENDOR_KINDS), verified: b(), url: { type: ['string', 'null'] } }, ['id', 'name', 'kind', 'verified']),
      license: ne(), runtime: ne(),
    }, ['id', 'name', 'version', 'vendor', 'license', 'runtime']),
    protocol: obj({ version: ne(), transports: arr(enm(K.GEP_TRANSPORTS), { minItems: 1 }) }, ['version', 'transports']),
    capabilities: {
      type: 'object',
      properties: capProps,
      propertyNames: { anyOf: [{ enum: [...K.GEP_CAPABILITY_KEYS] }, { pattern: '^x-' }] },
      // 至少声明一个行情来源
      anyOf: [capOn('market.useHost'), capOn('market.own')],
    },
    venues: arr(m('VenueCapabilities')),
    data: obj({ intervals: arr(ne()), maxHistoryBars: i({ minimum: 1 }) }, ['intervals', 'maxHistoryBars']),
    strategies: arr(obj({ id: ne(), name: ne(), version: ne(), kind: ne(), paramsSchemaRef: s() }, ['id', 'name', 'version', 'kind'])),
    limits: obj({ maxConcurrentBacktests: i({ minimum: 0 }), maxStrategyInstances: i({ minimum: 0 }) }),
    assumptions: obj({ backtest: anyObj() }),
    deprecated: arr(s()),
  }, ['engine', 'protocol', 'capabilities']))

  // ---- bind -------------------------------------------------------------------------------
  const binding = obj({
    bindingId: c('BindId'),
    accounts: arr(obj({
      accountId: c('AcctId'), mode: enm('A', 'B'), mandateId: c('MdtId'),
      signer: obj({ address: s(), fingerprint: s() }, [], { anyOf: [{ required: ['address'] }, { required: ['fingerprint'] }] }),
    }, ['accountId', 'mode', 'mandateId']), { minItems: 1 }),
    data: obj({ source: enm('host', 'engine'), instruments: arr(c('InstrumentId')) }, ['source', 'instruments']),
    policies: arr(obj({ policyId: c('PolId'), version: i({ minimum: 1 }), digest: c('Sha256') }, ['policyId', 'version', 'digest'])),
    builder: obj({ attachedBy: enm('host', 'engine') }, ['attachedBy']),
    heartbeatMs: i({ minimum: 100 }),
  }, ['bindingId', 'accounts', 'data', 'policies', 'heartbeatMs'])
  // 模式 B 账户必须声明签名者
  binding.properties.accounts.items.allOf = [when(propIs('mode', 'B'), { required: ['signer'] })]
  add('Binding', binding)
  add('BindResult', obj({ bindingId: c('BindId'), effective: g('Binding'), warnings: arr(s()) }, ['bindingId', 'effective', 'warnings']))

  // ---- 事件 -------------------------------------------------------------------------------
  const event = obj({
    seq: i({ minimum: 0 }), eventId: ne(), stream: enm(K.GEP_STREAM_NAMES), type: s({ pattern: '^[a-z]+(\\.[a-z_]+)*$' }), ts: c('Ms'),
    recvTs: c('Ms'), tsNs: s({ pattern: '^[0-9]+$' }), accountId: c('AcctId'), instrumentId: c('InstrumentId'), data: anyObj(),
    origin: m('Origin'), causation: obj({}), conflated: i({ minimum: 1 }),
  }, ['seq', 'eventId', 'stream', 'type', 'ts', 'data'])
  add('GepEvent', event)
  add('EventsPushParams', obj({ sessionId: ne(), events: arr(g('GepEvent')) }, ['sessionId', 'events']))

  // ---- 回测 -------------------------------------------------------------------------------
  add('BacktestSpec', obj({
    subject: obj({
      strategy: obj({ id: ne(), version: ne(), params: rec(prim) }, ['id', 'version', 'params']),
      workflow: obj({ id: ne(), version: { type: ['integer', 'string'] }, json: {} }, ['id', 'version']),
    }, [], { minProperties: 1 }),
    instruments: arr(c('InstrumentId'), { minItems: 1 }), interval: ne(), from: c('Ms'), to: c('Ms'),
    data: obj({
      source: enm('host', 'engine', 'files'),
      files: arr(obj({ path: ne(), sha256: c('Sha256'), format: enm('parquet', 'csv', 'json'), kind: enm('candles', 'funding') }, ['path', 'sha256', 'format'])),
    }, ['source']),
    account: obj({ initialBalance: c('Decimal'), ccy: ne(), leverage: n({ exclusiveMinimum: 0 }), maintenanceMarginRatio: n({ minimum: 0 }) }, ['initialBalance', 'ccy']),
    assumptions: m('BacktestAssumptions'), seed: i(),
  }, ['subject', 'instruments', 'interval', 'from', 'to', 'data', 'account', 'assumptions', 'seed']))

  const bias = enm('pass', 'fail', 'not_run')
  add('BacktestResult', obj({
    jobId: ne(), specDigest: c('Sha256'), assumptions: m('BacktestAssumptions'),
    stats: obj({
      totalReturnRatio: n(), annualizedRatio: n(), maxDrawdownRatio: n(), sharpe: n(), sortino: n(), winRatio: n(),
      profitFactor: { type: ['number', 'null'] }, trades: i({ minimum: 0 }), fills: i({ minimum: 0 }), avgHoldBars: n(), spanDays: n(), finalEquity: n(),
      fundingPaid: n(), feesPaid: n(), liquidations: i({ minimum: 0 }), unfilledShare: n({ minimum: 0, maximum: 1 }),
    }, ['totalReturnRatio', 'annualizedRatio', 'maxDrawdownRatio', 'sharpe', 'winRatio', 'profitFactor', 'trades', 'fills', 'avgHoldBars', 'spanDays', 'finalEquity']),
    equity: arr(obj({ t: c('Ms'), v: n() }, ['t', 'v'])),
    trades: arr(obj({ t: c('Ms'), side: enm('buy', 'sell'), price: n(), size: n(), pnl: n(), fee: n(), reason: s() }, ['t', 'side', 'price', 'size', 'pnl', 'fee', 'reason'])),
    openPosition: { type: ['object', 'null'] },
    biasChecks: obj({ lookahead: bias, recursive: bias, trialCount: i({ minimum: 0 }) }, ['lookahead', 'recursive', 'trialCount']),
    trialCount: i({ minimum: 0 }),
    artifacts: arr(obj({ artifactId: ne(), kind: ne() }, ['artifactId', 'kind'])),
    warnings: arr(s()),
    engine: obj({ id: ne(), version: ne() }, ['id', 'version']),
    dataDigest: c('Sha256'),
    pack: m('EvidencePackDraft'), strategySha256: c('Sha256'),
    funding: arr(obj({ t: c('Ms'), rate: n(), notional: n(), paid: n() }, ['t', 'rate', 'notional', 'paid'])),
  }, ['jobId', 'specDigest', 'assumptions', 'stats', 'equity', 'trades', 'openPosition', 'artifacts', 'warnings', 'engine', 'dataDigest']))

  add('OrderResult', obj({
    orderId: c('OrdId'), clientOrderId: c('ClientOrderId'), status: enm(K.ORDER_STATUSES), order: m('Order'), precheck: m('PrecheckResult'), problem: m('Problem'),
  }, ['orderId', 'clientOrderId', 'status']))

  // ---- 每个方法的 params / result ----------------------------------------------------------
  const L = (name) => ({ $ref: `#/$defs/${name}` })
  const empty = { type: 'object', additionalProperties: false }
  const okTrue = obj({ ok: konst(true) }, ['ok'])
  const instanceStatus = enm('running', 'stopped', 'error', 'starting')
  const paramsRec = rec(prim)
  const takeoverScope = obj({ accountIds: arr(c('AcctId')), strategyIds: arr(s()), instrumentIds: arr(c('InstrumentId')) })
  const orderRef = obj({ orderId: c('OrdId'), clientOrderId: c('ClientOrderId') }, [], { anyOf: [{ required: ['orderId'] }, { required: ['clientOrderId'] }] })
  const channelType = enm('quote', 'book', 'trades', 'candles', 'context')
  const marketChannel = obj({ type: channelType, instrumentId: c('InstrumentId'), interval: s(), depth: i({ minimum: 1 }) }, ['type', 'instrumentId'])
  const marketSnapshotParams = obj({ type: channelType, instrumentId: c('InstrumentId'), depth: i({ minimum: 1 }) }, ['type', 'instrumentId'])
  const historyParams = obj({ instrumentId: c('InstrumentId'), interval: ne(), from: c('Ms'), to: c('Ms'), limit: i({ minimum: 1, maximum: K.GEP_LIMITS.maxHistoryLimit }) }, ['instrumentId', 'interval'])
  const historyResult = obj({ candles: arr(m('Candle')), source: ne(), complete: b() }, ['candles', 'source', 'complete'])
  const hostOrderPlace = obj({
    accountId: c('AcctId'), intent: m('OrderIntent'), clientOrderId: c('ClientOrderId'), strategyId: s(), instanceId: c('InstanceId'),
  }, ['accountId', 'intent', 'clientOrderId'])
  const stream = enm(K.GEP_STREAM_NAMES)

  const defs = {
    Empty: empty,
    Ok: okTrue,
    AccountSnapshot: obj({
      balances: arr(m('Balance')), margin: m('MarginSnapshot'), positions: arr(m('Position')), openOrders: arr(m('Order')), ts: c('Ms'),
      attestation: enm('engine-reported', 'kernel-observed'),
    }, ['balances', 'margin', 'positions', 'openOrders', 'ts', 'attestation']),
    StrategyInstance: obj({
      instanceId: c('InstanceId'), strategyId: ne(), status: instanceStatus, accountId: c('AcctId'), instruments: arr(c('InstrumentId')),
      interval: s(), params: paramsRec, mandateId: c('MdtId'), startedAt: c('Ms'), error: m('Problem'),
    }, ['instanceId', 'strategyId', 'status', 'accountId', 'instruments', 'params', 'mandateId']),
    TakeoverScope: takeoverScope,
    EngineOrderParams: obj({
      accountId: c('AcctId'), intent: m('OrderIntent'), orderRef, clientOrderId: c('ClientOrderId'), takeoverId: c('TkoId'), origin: m('Origin'),
    }, ['accountId', 'origin']),
    MarketChannel: marketChannel,
    MarketSubscribeParams: obj({ channels: arr(marketChannel, { minItems: 1 }), maxHz: n({ exclusiveMinimum: 0 }) }, ['channels']),
    MarketSnapshotParams: marketSnapshotParams,
    MarketSnapshotResult: { anyOf: [m('Quote'), m('Book'), obj({ candles: arr(m('Candle')) }, ['candles']), obj({ trades: arr(m('Trade')) }, ['trades']), m('MarketContext')] },
    MarketHistoryParams: historyParams,
    MarketHistoryResult: historyResult,
    HostOrderPlaceParams: { ...hostOrderPlace, properties: { ...hostOrderPlace.properties, origin: L('OriginHint') } },
    HostOrderRef: orderRef,
    StrategySizing: obj({
      allocRatio: n({ exclusiveMinimum: 0, maximum: 1 }), allocCapNotional: n({ exclusiveMinimum: 0 }), leverage: n({ minimum: 1, maximum: 50 }),
      maxSlippageBps: n({ minimum: 0 }), minStepNotional: n({ minimum: 0 }),
    }),
    OriginHint: obj({ tool: ne(), causation: obj({}) }, ['tool']),
    MarketCandleData: obj({ interval: ne(), candle: m('Candle'), closed: b() }, ['interval', 'candle']),
    MarketCandlesData: obj({ interval: ne(), candles: arr(m('Candle')), closed: b() }, ['interval', 'candles']),
    ReplayState: obj({ replayId: ne(), state: enm('running', 'paused', 'done', 'stopped'), clock: c('Ms') }, ['replayId', 'state', 'clock']),
    BacktestState: enm('queued', 'running', 'done', 'failed', 'cancelled'),
  }

  const methods = {
    'gep.hello': [g('GepHelloParams'), g('GepHelloResult')],
    'engine.describe': [L('Empty'), g('EngineDescribe')],
    'engine.bind': [g('Binding'), g('BindResult')],
    'engine.health': [L('Empty'), obj({ status: enm('ok', 'degraded', 'down'), metrics: rec(n()), ts: c('Ms') }, ['status', 'metrics', 'ts'])],
    'engine.snapshot': [obj({ accountIds: arr(c('AcctId')) }), obj({
      seq: i({ minimum: 0 }), strategies: arr(L('StrategyInstance')), orders: arr(m('Order')), positions: arr(m('Position')), accounts: arr(L('AccountSnapshot')),
    }, ['seq', 'strategies', 'orders'])],
    'engine.halt': [obj({ takeoverId: c('TkoId'), level: enm(K.TAKEOVER_LEVELS), scope: takeoverScope, reason: ne(), deadlineMs: i({ minimum: 0 }) }, ['takeoverId', 'level', 'scope', 'reason', 'deadlineMs']), obj({ ack: konst(true), appliedAt: c('Ms') }, ['ack', 'appliedAt'])],
    'engine.resume': [obj({ takeoverId: c('TkoId'), scope: takeoverScope, approvedBy: ne() }, ['takeoverId', 'scope', 'approvedBy']), obj({ resumedAt: c('Ms') }, ['resumedAt'])],
    'engine.shutdown': [obj({ graceMs: i({ minimum: 0 }) }, ['graceMs']), okTrue],
    'events.subscribe': [obj({ streams: arr(stream, { minItems: 1 }), accountIds: arr(c('AcctId')), fromSeq: i({ minimum: 0 }) }, ['streams']), obj({ subscriptionId: ne(), fromSeq: i({ minimum: 0 }) }, ['subscriptionId', 'fromSeq'])],
    'events.unsubscribe': [obj({ subscriptionId: ne() }, ['subscriptionId']), okTrue],
    'risk.policy.push': [obj({ policies: arr(m('RiskPolicy'), { minItems: 1 }), effectiveAt: c('Ms') }, ['policies', 'effectiveAt']), obj({ acceptedVersions: arr(i({ minimum: 1 })) }, ['acceptedVersions'])],
    'strategy.list': [L('Empty'), obj({ strategies: arr(obj({ id: ne(), name: ne(), version: ne(), kind: ne(), paramsSchemaRef: s(), sha256: c('Sha256') }, ['id', 'name', 'version', 'kind'])) }, ['strategies'])],
    'strategy.params': [obj({ strategyId: ne() }, ['strategyId']), obj({ schema: anyObj(), defaults: anyObj() }, ['schema', 'defaults'])],
    'strategy.start': [obj({
      strategyId: ne(), instanceId: c('InstanceId'), accountId: c('AcctId'), instruments: arr(c('InstrumentId'), { minItems: 1 }), interval: s(), params: paramsRec, mandateId: c('MdtId'),
      sizing: L('StrategySizing'),
    }, ['strategyId', 'accountId', 'instruments', 'params', 'mandateId']), obj({ instanceId: c('InstanceId'), status: instanceStatus }, ['instanceId', 'status'])],
    'strategy.stop': [obj({ instanceId: c('InstanceId'), flatten: konst(false) }, ['instanceId']), obj({ status: instanceStatus }, ['status'])],
    'strategy.update': [obj({ instanceId: c('InstanceId'), params: paramsRec }, ['instanceId', 'params']), obj({ status: instanceStatus, appliedAt: c('Ms') }, ['status', 'appliedAt'])],
    'strategy.status': [obj({ instanceId: c('InstanceId') }), obj({ instances: arr(L('StrategyInstance')) }, ['instances'])],
    'backtest.run': [obj({ spec: g('BacktestSpec') }, ['spec']), obj({ jobId: ne() }, ['jobId'])],
    'backtest.status': [obj({ jobId: ne() }, ['jobId']), obj({ state: L('BacktestState'), progress: n({ minimum: 0, maximum: 1 }) }, ['state', 'progress'])],
    'backtest.result': [obj({ jobId: ne() }, ['jobId']), g('BacktestResult')],
    'backtest.cancel': [obj({ jobId: ne() }, ['jobId']), obj({ state: L('BacktestState') }, ['state'])],
    'replay.start': [obj({ spec: g('BacktestSpec') }, ['spec']), obj({ replayId: ne() }, ['replayId'])],
    'replay.stop': [obj({ replayId: ne() }, ['replayId']), obj({ state: enm('running', 'paused', 'done', 'stopped') }, ['state'])],
    'replay.status': [obj({ replayId: ne() }, ['replayId']), L('ReplayState')],
    'order.place': [L('EngineOrderParams'), g('OrderResult')],
    'order.amend': [L('EngineOrderParams'), g('OrderResult')],
    'order.cancel': [L('EngineOrderParams'), g('OrderResult')],
    'order.cancelAll': [L('EngineOrderParams'), g('OrderResult')],
    'account.snapshot': [obj({ accountId: c('AcctId') }, ['accountId']), L('AccountSnapshot')],
    'market.subscribe': [L('MarketSubscribeParams'), obj({ subscriptionId: ne() }, ['subscriptionId'])],
    'market.snapshot': [L('MarketSnapshotParams'), L('MarketSnapshotResult')],
    'market.history': [L('MarketHistoryParams'), L('MarketHistoryResult')],

    'host.describe': [L('Empty'), obj({
      host: obj({ name: ne(), version: ne() }, ['name', 'version']), venues: arr(m('VenueCapabilities')),
      accounts: arr(obj({ accountId: c('AcctId'), alias: ne(), venue: c('VenueId'), environment: enm('mainnet', 'testnet'), mode: enm('live', 'paper', 'shadow') }, ['accountId', 'alias', 'venue', 'environment', 'mode'])),
    }, ['host', 'venues', 'accounts'])],
    'host.instruments': [obj({ venue: c('VenueId'), ids: arr(c('InstrumentId')) }), obj({ instruments: arr(m('Instrument')) }, ['instruments'])],
    'host.market.subscribe': [L('MarketSubscribeParams'), obj({ subscriptionId: ne() }, ['subscriptionId'])],
    'host.market.unsubscribe': [obj({ subscriptionId: ne() }, ['subscriptionId']), okTrue],
    'host.market.snapshot': [L('MarketSnapshotParams'), L('MarketSnapshotResult')],
    'host.market.history': [L('MarketHistoryParams'), L('MarketHistoryResult')],
    'host.account.snapshot': [obj({ accountId: c('AcctId') }, ['accountId']), L('AccountSnapshot')],
    'host.order.place': [L('HostOrderPlaceParams'), g('OrderResult')],
    'host.order.amend': [obj({ orderId: c('OrdId'), clientOrderId: c('ClientOrderId'), price: c('Decimal'), size: c('Decimal'), triggerPrice: c('Decimal') }, [], { anyOf: [{ required: ['orderId'] }, { required: ['clientOrderId'] }] }), g('OrderResult')],
    'host.order.cancel': [L('HostOrderRef'), g('OrderResult')],
    'host.order.cancelAll': [obj({ accountId: c('AcctId'), instrumentId: c('InstrumentId'), keepProtective: b() }, ['accountId', 'keepProtective']), obj({ cancelled: i({ minimum: 0 }) }, ['cancelled'])],
    'host.order.batch': [obj({ orders: arr(L('HostOrderPlaceParams'), { minItems: 1 }) }, ['orders']), obj({ results: arr(g('OrderResult')) }, ['results'])],
    'host.order.status': [L('HostOrderRef'), m('Order')],
    'host.proposal.create': [obj({
      accountId: c('AcctId'), intents: arr(m('OrderIntent'), { minItems: 1, maxItems: 10 }), reason: s({ minLength: 1, maxLength: 2000 }),
      evidence: arr(m('EvidenceRef')), strategyId: s(), instanceId: c('InstanceId'), origin: L('OriginHint'),
    }, ['accountId', 'intents', 'reason']), obj({
      proposalId: ne(), ticket: c('Ticket'), status: enm('pending', 'denied'), precheck: m('PrecheckResult'), problem: m('Problem'), expiresAt: c('Ms'),
    }, ['proposalId', 'ticket', 'status', 'precheck', 'expiresAt'])],
    'host.risk.precheck': [obj({ accountId: c('AcctId'), intent: m('OrderIntent') }, ['accountId', 'intent']), m('PrecheckResult')],
    'host.events.subscribe': [obj({ streams: arr(stream, { minItems: 1 }), accountIds: arr(c('AcctId')) }, ['streams', 'accountIds']), obj({ subscriptionId: ne() }, ['subscriptionId'])],
    'host.ledger.append': [obj({ entries: arr(obj({ type: enm('signal', 'decision', 'note', 'log'), data: anyObj() }, ['type', 'data']), { minItems: 1 }) }, ['entries']), obj({ seqs: arr(i({ minimum: 0 })) }, ['seqs'])],
    'host.artifact.put': [obj({ path: ne(), sha256: c('Sha256'), mediaType: ne(), sizeBytes: i({ minimum: 0 }), kind: enm('tearsheet', 'trades', 'equity') }, ['path', 'sha256', 'mediaType', 'sizeBytes', 'kind']), obj({ artifactId: ne() }, ['artifactId'])],
    'host.market.fundingHistory': [
      obj({ instrumentId: c('InstrumentId'), from: c('Ms'), to: c('Ms') }, ['instrumentId', 'from']),
      obj({ points: arr(m('FundingRatePoint')), complete: b() }, ['points', 'complete']),
    ],
    'paper.replay.start': [m('PaperReplayStart'), obj({ runId: ne() }, ['runId'])],
    'paper.replay.status': [L('Empty'), m('PaperReplayStatus')],
    'paper.replay.stop': [obj({ runId: ne() }, ['runId']), m('PaperReplayStatus')],
  }

  // 通知只有 params
  const notifications = {
    'events.push': g('EventsPushParams'),
    'gep.heartbeat': obj({ ts: c('Ms'), seq: i({ minimum: 0 }) }),
    'events.ack': obj({ upToSeq: i({ minimum: 0 }) }, ['upToSeq']),
    'gep.overflow': obj({ stream, dropped: i({ minimum: 0 }), ts: c('Ms') }),
    'host.events.ack': obj({ upToSeq: i({ minimum: 0 }) }, ['upToSeq']),
  }

  const all = { ...defs }
  for (const [name, [p, r]] of Object.entries(methods)) { all[`${name}:params`] = p; all[`${name}:result`] = r }
  for (const [name, p] of Object.entries(notifications)) all[`${name}:params`] = p
  add('Methods', { $defs: all })
  return out
}
