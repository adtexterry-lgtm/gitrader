// SPDX-License-Identifier: Apache-2.0
// 统一交易模型（契约 §1）的 JSON Schema 定义。K = 从 src/ 打包出来的常量（枚举等），保证与 TS 类型同源。
import { anyObj, arr, b, c, enm, i, konst, m, n, ne, nullable, obj, propIs, rec, ref, s, when } from './lib.mjs'

const MS_ID_PREFIXES = ['org', 'usr', 'grp', 'acct', 'ord', 'fill', 'fund', 'pol', 'prot', 'mdt', 'ak', 'prop', 'pck', 'tko', 'exp', 'sig', 'dec', 'led', 'bind', 'job', 'evt', 'ses']
const idName = (p) => p.charAt(0).toUpperCase() + p.slice(1) + 'Id'

export function modelSchemas(K) {
  const out = {}
  const add = (name, schema, title = name) => { out[name] = { domain: 'model', name, title, schema } }

  add('OperationRateLimitConfig', obj({
    capacity: i({ minimum: 1, maximum: 10000 }),
    refillPerSecond: n({ minimum: 0.1, maximum: 10000 }),
    session: obj({
      capacity: i({ minimum: 1, maximum: 10000 }),
      refillPerSecond: n({ minimum: 0.1, maximum: 10000 }),
    }),
  }))
  add('ServerSecurityConfig', obj({
    operationRateLimit: m('OperationRateLimitConfig'),
    maxWsSubscriptions: i({ minimum: 1, maximum: 1024 }),
  }))

  // ---- Common ---------------------------------------------------------------------
  const idDefs = Object.fromEntries(MS_ID_PREFIXES.map((p) => [idName(p), s({ pattern: `^${p}_[0-9A-Za-z]{3,26}$` })]))
  add('Common', {
    $defs: {
      Decimal: {
        type: 'string',
        description: '规范十进制字符串（契约 §1.3）：无指数、无前导 +、无尾随 0、零写 "0"、不写 "-0"；有效数字 ≤ 30。',
        allOf: [{ pattern: K.DECIMAL_PATTERN }, { not: { pattern: `^-?0*\\.?0*[1-9](?:\\.?[0-9]){${K.DECIMAL_SIGDIGITS_MAX}}` } }],
      },
      Ms: i({ minimum: 0, description: 'Unix 毫秒整数' }),
      Id: s({ pattern: K.ID_PATTERN, description: '<前缀>_<ULID>；契约示例里有缩写，按缩写也放行' }),
      ...idDefs,
      InstanceId: s({ pattern: '^inst_[0-9A-Za-z]{3,26}$' }),
      EventId: s({ pattern: '^evt_[0-9A-Za-z]{3,26}$' }),
      VenueId: s({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
      InstrumentId: s({ pattern: K.INSTRUMENT_ID_PATTERN, description: '<venue>:<场所原生符号>，按第一个冒号切分' }),
      ClientOrderId: s({ pattern: K.CLIENT_ORDER_ID_PATTERN }),
      Ticket: s({ pattern: K.TICKET_PATTERN }),
      Sha256: s({ pattern: K.SHA256_PATTERN }),
      Actor: s({ pattern: `^(${K.ACTOR_TYPES.join('|')}):.+$` }),
      UserActor: s({ pattern: '^user:.+$' }),
      Interval: s({ minLength: 1 }),
      Currency: s({ minLength: 1 }),
    },
  }, 'Common definitions')

  // ---- Origin / Problem / RuleHit -----------------------------------------------------
  add('Origin', {
    ...obj({
    actor: c('Actor'),
    actorType: enm(K.ORIGIN_ACTOR_TYPES),
    tool: ne(),
    requestId: s({ format: 'uuid' }),
    via: enm(K.ORIGIN_VIA),
    onBehalfOf: c('UserActor'),
    causation: obj({
      proposalId: c('PropId'), signalId: c('SigId'), decisionId: c('DecId'), workflowId: s(), nodeId: s(), strategyId: s(),
      instanceId: c('InstanceId'), engineId: s(), mandateId: c('MdtId'), precheckId: c('PckId'), parentEventId: c('EventId'),
      legId: s(), exitPlanId: s(),
    }),
    inferred: b(),
    }, ['actor', 'actorType', 'tool', 'requestId', 'via']),
    // actor 前缀与 actorType 必须一致（actor 由内核盖章，不能自报）
    allOf: Object.entries(K.ORIGIN_ACTOR_TYPE_OF_PREFIX).map(([prefix, t]) =>
      when({ properties: { actor: s({ pattern: `^${prefix}:` }) }, required: ['actor'] }, { properties: { actorType: konst(t) } })),
  })

  add('RuleHit', obj({
    ruleId: ne(), code: enm(K.RULE_CODES), message: s(), limit: c('Decimal'), actual: c('Decimal'), unit: s(),
    action: enm(K.RULE_HIT_ACTIONS), scope: ne(),
  }, ['ruleId', 'code', 'limit', 'actual', 'unit', 'action', 'scope']))

  add('Problem', {
    ...obj({
      code: i(), name: ne(), category: enm(K.PROBLEM_CATEGORIES), message: s(), retryable: b(), retryAfterMs: i({ minimum: 0 }),
      ruleHits: arr(m('RuleHit')), precheckId: c('PckId'),
      venue: obj({ id: ne(), code: { type: ['string', 'integer'] }, message: s() }, ['id', 'message']),
      correlationId: s(),
      clientOrderIds: arr(s()),
    }, ['code', 'name', 'category', 'message', 'retryable']),
    allOf: [
      when(propIs('category', 'RISK'), { required: ['ruleHits', 'precheckId'] }),
      when(propIs('category', 'VENUE'), { required: ['venue'] }),
      ...Object.values(K.PROBLEM_CODES)
        .filter((info) => info.name.startsWith('EXPERIMENT_'))
        .map((info) => when(propIs('code', info.code), {
          properties: { name: konst(info.name), category: konst(info.category), retryable: konst(info.retryable) },
        })),
    ],
  })

  // ---- Instrument / 能力声明 / 行情 ------------------------------------------------------
  add('Instrument', {
    ...obj({
      instrumentId: c('InstrumentId'), venue: c('VenueId'), symbol: ne(), displaySymbol: ne(), kind: enm(K.INSTRUMENT_KINDS),
      base: ne(), quote: ne(), settle: ne(), settlement: enm('linear', 'inverse'), contractSize: c('Decimal'),
      venueSizeUnit: enm('base', 'contract'), assetClass: enm(K.ASSET_CLASSES), marketGroup: { type: ['string', 'null'] },
      underlying: obj({ description: s(), synthetic: b() }, ['description', 'synthetic']),
      status: enm(K.INSTRUMENT_STATUSES),
      price: { ...obj({ tick: c('Decimal'), sigFigs: i({ minimum: 1 }), maxDecimals: i({ minimum: 0 }) }), anyOf: [{ required: ['tick'] }, { required: ['sigFigs'] }] },
      size: obj({ step: c('Decimal'), decimals: i({ minimum: 0 }), min: c('Decimal') }, ['step', 'decimals', 'min']),
      minNotional: c('Decimal'), maxLeverage: n({ exclusiveMinimum: 0 }), marginModes: arr(enm(K.MARGIN_MODES)),
      orderTypes: arr(enm(K.ORDER_TYPES)), tif: arr(enm(K.TIME_IN_FORCE)), triggerPriceTypes: arr(enm(K.TRIGGER_PRICE_TYPES)),
      fundingIntervalMs: i({ minimum: 1 }),
      sessions: obj({
        tz: ne(),
        windows: arr(obj({
          days: arr(i({ minimum: 0, maximum: 6 }), { minItems: 1 }), from: s({ pattern: '^[0-9]{2}:[0-9]{2}$' }), to: s({ pattern: '^[0-9]{2}:[0-9]{2}$' }),
          quality: enm(K.SESSION_QUALITIES), typicalSpreadBps: n({ minimum: 0 }),
        }, ['days', 'from', 'to', 'quality'])),
      }, ['tz', 'windows']),
      typicalSpreadBps: n({ minimum: 0 }),
      fees: obj({ maker: c('Decimal'), taker: c('Decimal'), source: enm('venue', 'tier', 'assumed') }, ['maker', 'taker', 'source']),
      updatedAt: c('Ms'),
    }, ['instrumentId', 'venue', 'symbol', 'displaySymbol', 'kind', 'base', 'quote', 'settle', 'settlement', 'contractSize', 'venueSizeUnit', 'assetClass', 'status', 'price', 'size', 'orderTypes', 'tif', 'triggerPriceTypes', 'updatedAt']),
    allOf: [when(propIs('kind', 'perp'), { required: ['fundingIntervalMs'] })],
  })

  const support = enm('native', 'emulated', 'none')
  add('VenueCapabilities', obj({
    venue: c('VenueId'),
    environments: arr(enm('mainnet', 'testnet'), { minItems: 1 }),
    instrumentKinds: arr(enm(K.INSTRUMENT_KINDS)),
    orderTypes: obj(Object.fromEntries(K.ORDER_TYPES.map((t) => [t, support]))),
    rules: obj({
      maxOpenOrders: obj({ cap: n({ minimum: 0 }) }, ['cap']),
      marketPriceBandBps: n({ minimum: 0 }), minOrderNotional: c('Decimal'),
    }),
    marketEmulation: obj({ method: ne() }, ['method']),
    tif: arr(enm(K.TIME_IN_FORCE)),
    triggerPriceTypes: arr(enm(K.TRIGGER_PRICE_TYPES)),
    tpsl: obj({ attachToOrder: b(), positionLevel: b(), parentPartialCancel: s() }, ['attachToOrder', 'positionLevel', 'parentPartialCancel']),
    batch: obj({ maxOrders: { type: ['integer', 'null'] }, atomic: b() }, ['maxOrders', 'atomic']),
    amend: support,
    cancelAll: support,
    deadman: obj({ method: ne(), minDelaySec: n(), maxTriggersPerDay: i() }, ['method', 'minDelaySec', 'maxTriggersPerDay']),
    positionMode: arr(enm('oneWay', 'hedge')),
    marginModes: arr(enm(K.MARGIN_MODES)),
    accountModels: arr(s()),
    signers: obj({
      type: s(), perAccount: obj({ unnamed: i(), named: i() }), perSubaccountNamed: i(), maxValidityDays: i(), withdrawCapable: b(), noncePerSigner: b(),
    }, ['type', 'withdrawCapable']),
    rateLimits: arr(obj({ scope: ne(), model: ne(), limit: n(), windowMs: i(), note: s() }, ['scope', 'model'])),
    wsLimits: obj({ maxConnections: i(), newPerMinute: i(), maxSubscriptions: i(), maxDistinctUsersInUserSubs: i() }),
    clientOrderId: obj({ format: ne() }, ['format']),
    builderFee: obj({
      supported: b(), perpMaxTenthBps: i(), spotMaxTenthBps: i(), spotChargedSide: enm(K.ORDER_SIDES), maxApprovalsPerUser: i(),
      collectorAccountModel: s(), collectorMinValue: c('Decimal'),
    }, ['supported']),
    history: obj({ maxCandles: i(), pageLimit: i() }, ['maxCandles', 'pageLimit']),
    withdrawPermissionCheck: enm('not_applicable', 'supported', 'unknown'),
    bookSnapshot: obj({ snapshot: b(), refresh: b(), staleAfterMs: i({ minimum: 0 }) }, ['snapshot', 'refresh']),
  }, ['venue', 'environments', 'instrumentKinds', 'orderTypes', 'tif', 'triggerPriceTypes']))

  add('SimVenueDeclaration', obj({
    connector: konst('kernel-sim'),
    modes: arr(enm('paper', 'shadow'), { minItems: 1 }),
    mirrors: arr(c('VenueId')),
    fillModel: obj({
      market: s(), bookShortfall: s(), noBook: s(), limit: s(), queuePosition: b(), latencyMs: n(), funding: s(), liquidation: s(),
      positionMode: s(), marginMode: s(),
    }, ['market', 'bookShortfall', 'noBook', 'limit', 'queuePosition', 'latencyMs', 'funding', 'liquidation', 'positionMode', 'marginMode']),
    knownGaps: arr(s()),
  }, ['connector', 'modes', 'mirrors', 'fillModel', 'knownGaps']))

  add('Candle', obj({ t: c('Ms'), o: n(), h: n(), l: n(), c: n(), v: n(), vwap: n() }, ['t', 'o', 'h', 'l', 'c', 'v']))
  const replayInterval = enm(K.CANDLE_INTERVALS)
  const replayPair = { type: 'array', prefixItems: [c('Decimal'), c('Decimal')], items: false, minItems: 2, maxItems: 2 }
  const replayBook = obj({ bids: arr(replayPair, { minItems: 1 }), asks: arr(replayPair, { minItems: 1 }) }, ['bids', 'asks'])
  add('PaperReplayConfig', obj({ fixture: s() }, ['fixture']))
  add('PaperReplayCandle', obj({
    instrumentId: c('InstrumentId'), interval: replayInterval, t: c('Ms'), closedAt: c('Ms'),
    o: c('Decimal'), h: c('Decimal'), l: c('Decimal'), c: c('Decimal'), v: c('Decimal'),
  }, ['instrumentId', 'interval', 't', 'closedAt', 'o', 'h', 'l', 'c', 'v']))
  add('PaperReplayFrame', obj({
    ts: c('Ms'),
    marks: rec(c('Decimal'), { minProperties: 1, propertyNames: c('InstrumentId') }),
    books: rec(replayBook, { minProperties: 1, propertyNames: c('InstrumentId') }),
    funding: rec(c('Decimal'), { propertyNames: c('InstrumentId') }),
    candles: arr(m('PaperReplayCandle')),
  }, ['ts', 'marks', 'books', 'candles']))
  add('PaperReplayFixture', obj({
    schema: konst('gitrader-paper-replay/1'), venue: c('VenueId'), instruments: arr(m('Instrument'), { minItems: 1, maxItems: 100 }),
    interval: replayInterval, frames: arr(m('PaperReplayFrame'), { minItems: 1, maxItems: 100000 }),
  }, ['schema', 'venue', 'instruments', 'interval', 'frames']))
  add('PaperReplayStart', obj({
    engineId: ne(), accountId: c('AcctId'), strategyId: ne(), instrumentId: c('InstrumentId'), interval: replayInterval,
    params: rec({ type: ['number', 'boolean', 'string'] }), sizing: ref('gep', 'Methods#/$defs/StrategySizing'),
  }, ['engineId', 'accountId', 'strategyId', 'instrumentId', 'interval'], { additionalProperties: false }))
  add('PaperReplayProvenance', obj({
    source: konst('replay'), fixtureDigest: c('Sha256'), runId: ne(),
  }, ['source', 'fixtureDigest'], { additionalProperties: false }))
  add('PaperReplayStatus', obj({
    state: enm('idle', 'running', 'stopping', 'completed', 'cancelled', 'failed'), runId: ne(), accountId: c('AcctId'),
    frameIndex: i({ minimum: -1 }), totalFrames: i({ minimum: 0 }), clock: c('Ms'), startedAt: c('Ms'), finishedAt: c('Ms'),
    artifact: s({ minLength: 1, pattern: '^(?!\\.{1,2}$)[^/\\\\:]+$' }), problem: m('Problem'), provenance: m('PaperReplayProvenance'),
  }, ['state', 'frameIndex', 'totalFrames', 'clock']))
  add('FundingRatePoint', obj({ instrumentId: c('InstrumentId'), t: c('Ms'), rate: c('Decimal'), premium: c('Decimal') }, ['instrumentId', 't', 'rate']))
  const level = obj({ price: n(), size: n(), count: i() }, ['price', 'size'])
  add('Book', obj({ instrumentId: c('InstrumentId'), ts: c('Ms'), bids: arr(level), asks: arr(level) }, ['instrumentId', 'ts', 'bids', 'asks']))
  add('BookSnapshot', obj({ book: m('Book'), asOf: c('Ms'), stale: b() }, ['book', 'asOf', 'stale']))
  add('Quote', obj({ instrumentId: c('InstrumentId'), ts: c('Ms'), bid: n(), ask: n(), last: n() }, ['instrumentId', 'ts', 'bid', 'ask']))
  add('Trade', obj({ instrumentId: c('InstrumentId'), ts: c('Ms'), price: n(), size: n(), side: enm(K.ORDER_SIDES) }, ['instrumentId', 'ts', 'price', 'size', 'side']))
  add('MarketContext', obj({
    instrumentId: c('InstrumentId'), ts: c('Ms'), markPrice: n(), oraclePrice: n(), midPrice: n(), fundingRate: n(), fundingIntervalMs: i(),
    openInterest: n(), dayNotionalVolume: n(), prevDayPrice: n(),
  }, ['instrumentId', 'ts', 'markPrice']))
  add('VenueStatus', obj({
    venue: c('VenueId'), environment: enm('mainnet', 'testnet'), ts: c('Ms'), wsState: enm('connected', 'connecting', 'disconnected'),
    latencyMs: obj({ p50: n(), p95: n() }, ['p50', 'p95']),
    rateBudget: obj({ used: n(), limit: n(), windowMs: i() }, ['used', 'limit', 'windowMs']),
  }, ['venue', 'environment', 'ts', 'wsState']))

  // ---- Org / Group / Account / Balance / Margin ---------------------------------------------
  add('Org', obj({
    orgId: c('OrgId'), name: ne(),
    identity: obj({ provider: enm('local', 'unigit'), externalId: s() }, ['provider']),
    members: arr(obj({ userId: c('UsrId'), roles: arr(enm(K.MEMBER_ROLES)) }, ['userId', 'roles'])),
    settings: obj({ twoPersonAboveNotional: c('Decimal') }),
  }, ['orgId', 'name', 'identity', 'members']))

  add('AccountGroup', obj({
    groupId: c('GrpId'), orgId: c('OrgId'), name: ne(), accountIds: arr(c('AcctId')), policyIds: arr(c('PolId')), bindingIds: arr(c('BindId')),
  }, ['groupId', 'orgId', 'name', 'accountIds']))

  add('Account', {
    ...obj({
      accountId: c('AcctId'), alias: ne(), orgId: c('OrgId'), groupIds: arr(c('GrpId')), venue: c('VenueId'),
      environment: enm('mainnet', 'testnet'), mode: enm('live', 'paper', 'shadow'),
      owner: obj({ address: s(), accountRef: s() }),
      subaccount: obj({ address: s(), name: s() }), vault: obj({ address: ne() }, ['address']),
      accountModel: ne(),
      signer: obj({
        type: enm('api-wallet', 'api-key', 'none', 'gateway-session'), credentialRef: ne(), address: s(), fingerprint: s(), notAfter: c('Ms'),
        permissions: obj({ trade: b(), withdraw: { enum: [false, 'unknown'] } }, ['trade', 'withdraw']),
      }, ['type', 'credentialRef', 'permissions']),
      builder: obj({ status: enm('approved', 'not_approved', 'unknown'), maxFeeTenthBps: i() }, ['status']),
      paper: obj({ initialBalance: c('Decimal'), ccy: c('Currency') }, ['initialBalance', 'ccy']),
      status: enm('active', 'read_only', 'disabled'),
    }, ['accountId', 'alias', 'orgId', 'groupIds', 'venue', 'environment', 'mode', 'owner', 'accountModel', 'signer', 'status']),
    allOf: [when(propIs('mode', 'paper'), { required: ['paper'] })],
  })

  add('Balance', obj({
    accountId: c('AcctId'), asset: ne(), total: c('Decimal'), available: c('Decimal'), hold: c('Decimal'), borrowed: c('Decimal'), ts: c('Ms'),
  }, ['accountId', 'asset', 'total', 'available', 'hold', 'ts']))

  add('MarginSnapshot', obj({
    accountId: c('AcctId'), model: ne(), valuationCcy: ne(), equity: c('Decimal'), initialMargin: c('Decimal'), maintenanceMargin: c('Decimal'),
    available: c('Decimal'), marginRatio: c('Decimal'), leverage: n(), ts: c('Ms'),
  }, ['accountId', 'model', 'valuationCcy', 'equity', 'initialMargin', 'maintenanceMargin', 'available', 'marginRatio', 'leverage', 'ts']))

  // ---- 订单 / 成交 / 持仓 ------------------------------------------------------------------
  const tpSlLeg = obj({ triggerPrice: c('Decimal'), price: c('Decimal') }, ['triggerPrice'])
  const trailing = obj({
    callbackRatio: { ...c('Decimal'), pattern: '^(?!-|0$)' },
    activationPrice: c('Decimal'), activationRatio: c('Decimal'),
  }, ['callbackRatio'])
  add('OrderIntent', {
    ...obj({
      accountId: c('AcctId'), instrumentId: c('InstrumentId'), side: enm(K.ORDER_SIDES), type: enm(K.ORDER_TYPES),
      size: c('Decimal'), notional: c('Decimal'), price: c('Decimal'), triggerPrice: c('Decimal'), triggerType: enm(K.TRIGGER_PRICE_TYPES),
      tif: enm(K.TIME_IN_FORCE), reduceOnly: b(), postOnly: b(), leverage: n({ exclusiveMinimum: 0 }), marginMode: enm(K.MARGIN_MODES),
      maxSlippageBps: n({ minimum: 0 }),
      tpsl: obj({ takeProfit: tpSlLeg, stopLoss: tpSlLeg, grouping: enm('order', 'position') }, ['grouping']),
      expiresAt: c('Ms'), clientOrderId: c('ClientOrderId'), rounding: enm('reject', 'passive'), reason: s({ minLength: 1, maxLength: 2000 }),
      legId: s(), exitPlanId: s(), ocoGroupId: s(), allowAdjust: arr(enm(K.ORDER_ADJUST_FIELDS)), trailing,
    }, ['accountId', 'instrumentId', 'side', 'type']),
    allOf: [
      { anyOf: [{ required: ['size'] }, { required: ['notional'] }] },
      when(propIs('type', ['limit', 'stop_limit', 'take_limit']), { required: ['price'] }),
      when(propIs('type', ['stop_market', 'stop_limit', 'take_market', 'take_limit']), { required: ['triggerPrice'] }),
    ],
  })

  add('Order', {
    ...obj({
      orderId: c('OrdId'), clientOrderId: c('ClientOrderId'), venueOrderId: { type: ['string', 'null'] }, accountId: c('AcctId'),
      instrumentId: c('InstrumentId'), side: enm(K.ORDER_SIDES), type: enm(K.ORDER_TYPES), tif: enm(K.TIME_IN_FORCE),
      size: c('Decimal'), filledSize: c('Decimal'),
      price: nullable(c('Decimal')), triggerPrice: nullable(c('Decimal')), avgFillPrice: nullable(c('Decimal')),
      reduceOnly: b(), postOnly: b(), leverage: n(), status: enm(K.ORDER_STATUSES), problem: m('Problem'), fee: c('Decimal'),
      builder: obj({ attached: b(), feeTenthBps: i() }, ['attached']),
      parentOrderId: c('OrdId'), tpslRole: enm('tp', 'sl'), proposalId: c('PropId'), mandateId: c('MdtId'), precheckId: c('PckId'),
      legId: s(), exitPlanId: s(), ocoGroupId: s(),
      origin: m('Origin'), createdAt: c('Ms'), updatedAt: c('Ms'), submittedAt: c('Ms'), closedAt: c('Ms'),
      trailing: { ...trailing, readOnly: true },
    }, ['orderId', 'clientOrderId', 'accountId', 'instrumentId', 'side', 'type', 'tif', 'size', 'filledSize', 'status', 'fee', 'origin', 'createdAt', 'updatedAt']),
    allOf: [when(propIs('status', ['denied', 'rejected']), { required: ['problem'] })],
  })

  add('Fill', obj({
    fillId: c('FillId'), orderId: c('OrdId'), clientOrderId: c('ClientOrderId'), venueFillId: ne(), accountId: c('AcctId'),
    instrumentId: c('InstrumentId'), side: enm(K.ORDER_SIDES), price: c('Decimal'), size: c('Decimal'), fee: c('Decimal'), feeCcy: ne(),
    builderFee: c('Decimal'), liquidity: enm('maker', 'taker'), realizedPnl: c('Decimal'), liquidation: b(), legId: s(), exitPlanId: s(), ts: c('Ms'),
    inferred: obj({
      suggestionId: ne(), reportId: ne(), confirmedAt: c('Ms'), confirmedBy: ne(),
      priceSource: enm('venue_avg_fill_price', 'local_last_fill_price'), basisDigest: s({ pattern: K.SHA256_PATTERN }),
    }, ['suggestionId', 'reportId', 'confirmedAt', 'confirmedBy', 'priceSource', 'basisDigest']),
  }, ['fillId', 'orderId', 'clientOrderId', 'venueFillId', 'accountId', 'instrumentId', 'side', 'price', 'size', 'fee', 'feeCcy', 'liquidity', 'realizedPnl', 'ts']))

  add('ReconcileEvidence', obj({ report: ne(), id: ne(), field: ne(), value: s() }, ['report', 'id', 'field', 'value']))
  add('ReconcileFindingView', obj({
    id: ne(), code: ne(), severity: enm('blocker', 'warn', 'info'), detail: s(),
    advice: obj({ action: ne(), requiresHuman: b(), why: s() }, ['action', 'requiresHuman', 'why']),
    evidence: arr(m('ReconcileEvidence')),
  }, ['id', 'code', 'severity', 'detail', 'advice', 'evidence']))
  add('ReconcileSuggestion', obj({
    id: ne(), orderId: c('OrdId'), venueOrderId: ne(), clientOrderId: c('ClientOrderId'), instrumentId: c('InstrumentId'),
    side: enm(K.ORDER_SIDES), size: c('Decimal'), price: c('Decimal'), ts: c('Ms'),
    priceSource: enm('venue_avg_fill_price', 'local_last_fill_price'), basis: arr(s()), inferred: konst(true),
  }, ['id', 'orderId', 'venueOrderId', 'clientOrderId', 'instrumentId', 'side', 'size', 'price', 'ts', 'priceSource', 'basis', 'inferred']))
  const reconcileDigest = s({ pattern: '^sha256:[a-f0-9]{64}$' })
  add('ReconcileResolutionInput', obj({
    accountId: c('AcctId'), itemId: ne(), evidenceDigest: reconcileDigest, action: enm('reject', 'acknowledge'),
    reason: s({ minLength: 1, maxLength: 500 }), requestId: ne({ maxLength: 128 }),
  }, ['accountId', 'itemId', 'evidenceDigest', 'action', 'reason', 'requestId'], { additionalProperties: false }))
  add('ReconcileResolutionReceipt', obj({
    resolutionId: ne(), input: m('ReconcileResolutionInput'), resolvedAt: c('Ms'), resolvedBy: ne(),
  }, ['resolutionId', 'input', 'resolvedAt', 'resolvedBy'], { additionalProperties: false }))
  add('ReconcileResolveResult', obj({
    receipt: m('ReconcileResolutionReceipt'), alreadyRecorded: b(),
  }, ['receipt', 'alreadyRecorded'], { additionalProperties: false }))
  add('ReconcileReviewItem', obj({
    itemId: ne(), accountId: c('AcctId'), kind: enm('inferred_fill', 'known_difference', 'late_real_fill', 'confirmation_effects'),
    evidenceDigest: reconcileDigest, observedAt: c('Ms'), summary: s(), blocking: b(),
    finding: m('ReconcileFindingView'), suggestion: m('ReconcileSuggestion'), localFillsDigest: reconcileDigest,
    fill: m('Fill'), confirmation: m('ReconcileConfirmationReceipt'), resolution: m('ReconcileResolutionReceipt'), confirmedFillId: ne(),
  }, ['itemId', 'accountId', 'kind', 'evidenceDigest', 'observedAt', 'summary', 'blocking'], { additionalProperties: false }))
  add('ReconcileAccountView', obj({
    accountId: c('AcctId'), offerId: ne(), state: enm('idle', 'running', 'ready', 'unavailable'), lastAttemptAt: c('Ms'), lastSuccessAt: c('Ms'),
    reportId: ne(), generatedAt: c('Ms'), verdict: enm('clean', 'attention', 'blocked'),
    findings: arr(m('ReconcileFindingView')), suggestions: arr(m('ReconcileSuggestion')), reviews: arr(m('ReconcileReviewItem')),
    coverage: obj({ asOf: c('Ms'), truncated: b(), unavailable: arr(s()), historyChecked: i({ minimum: 0 }), historyTotal: i({ minimum: 0 }) }, ['asOf', 'truncated', 'unavailable', 'historyChecked', 'historyTotal']),
    problem: m('Problem'),
  }, ['accountId', 'state', 'findings', 'suggestions']))
  add('ReconcileConfirmInput', obj({
    accountId: c('AcctId'), offerId: ne(), reportId: ne(), suggestionId: ne(), fee: c('Decimal'), feeCcy: ne(),
    liquidity: enm('maker', 'taker'), realizedPnl: c('Decimal'),
  }, ['accountId', 'offerId', 'reportId', 'suggestionId', 'fee', 'feeCcy', 'liquidity', 'realizedPnl']))
  add('ReconcileConfirmationReceipt', obj({
    input: m('ReconcileConfirmInput'), fillId: ne(), confirmedAt: c('Ms'), confirmedBy: ne(),
    effectsState: enm('pending', 'complete', 'failed'),
  }, ['input', 'fillId', 'confirmedAt', 'confirmedBy', 'effectsState']))
  add('ReconcileNoticeData', obj({
    noticeId: ne(), accountId: c('AcctId'), accountAlias: ne(), findingId: ne(), code: ne(),
    severity: enm('blocker', 'warn', 'info'), summary: ne(), why: ne(),
  }, ['noticeId', 'accountId', 'accountAlias', 'findingId', 'code', 'severity', 'summary', 'why']))
  add('ReconcileConfirmResult', obj({ fillId: ne(), alreadyRecorded: b() }, ['fillId', 'alreadyRecorded']))

  add('Position', obj({
    accountId: c('AcctId'), instrumentId: c('InstrumentId'), side: enm('long', 'short'), size: c('Decimal'), entryPrice: c('Decimal'),
    markPrice: c('Decimal'), markTs: c('Ms'), notional: c('Decimal'), unrealizedPnl: c('Decimal'), realizedPnl: c('Decimal'), leverage: n(),
    marginMode: enm(K.MARGIN_MODES), initialMargin: c('Decimal'), maintenanceMargin: c('Decimal'), liquidationPrice: nullable(c('Decimal')),
    estimated: b(), fundingSinceOpen: c('Decimal'), openedAt: c('Ms'), updatedAt: c('Ms'),
    legs: arr(obj({ legId: ne(), exitPlanId: s(), size: c('Decimal'), entryPrice: c('Decimal') }, ['legId', 'size'])),
  }, ['accountId', 'instrumentId', 'side', 'size', 'entryPrice', 'markPrice', 'notional', 'unrealizedPnl', 'realizedPnl', 'leverage', 'marginMode', 'liquidationPrice', 'fundingSinceOpen', 'openedAt', 'updatedAt']))

  // 连接器读到的账户快照（v0.1.7 追加 asOf / stale / source，均可选）
  add('ConnectorAccountSnapshot', obj({
    accountModel: enm('standard', 'unified', 'portfolio'), balances: arr(m('Balance')), margin: m('MarginSnapshot'), positions: arr(m('Position')), ts: c('Ms'),
    asOf: c('Ms'), confirmedAt: c('Ms'), stale: b(), source: enm(K.ACCOUNT_SNAPSHOT_SOURCES),
    availableDeductsOpenOrders: b(),
    openOrders: arr(obj({ instrumentId: c('InstrumentId'), side: enm(K.ORDER_SIDES), notional: c('Decimal'), count: i({ minimum: 0 }) }, ['instrumentId', 'side', 'notional', 'count'])),
    stopLossOrderIds: arr(s()),
    rules: obj({
      maxOpenOrders: obj({ cap: n({ minimum: 0 }), current: n({ minimum: 0 }) }, ['cap', 'current']),
      marketPriceBandBps: n({ minimum: 0 }), minOrderNotional: c('Decimal'),
    }),
  }, ['accountModel', 'balances', 'margin', 'positions', 'ts']))

  add('FundingPayment', obj({
    fundingId: c('FundId'), accountId: c('AcctId'), instrumentId: c('InstrumentId'), ts: c('Ms'), rate: c('Decimal'), intervalMs: i({ minimum: 1 }),
    positionSize: c('Decimal'), amount: c('Decimal'), asset: ne(), venueRef: s(),
  }, ['fundingId', 'accountId', 'instrumentId', 'ts', 'rate', 'intervalMs', 'positionSize', 'amount', 'asset']))

  // ---- 风控 --------------------------------------------------------------------------------
  add('Attestation', obj({
    method: enm(K.ATTESTATION_METHODS), by: ne(), at: c('Ms'), digest: c('Sha256'), sig: ne(),
  }, ['method', 'by', 'at', 'digest', 'sig']))

  const limits = obj({
    maxLeverage: n({ exclusiveMinimum: 0 }), maxOrderNotional: c('Decimal'), maxPositionNotionalRatio: c('Decimal'),
    maxTotalNotionalRatio: c('Decimal'), maxOpenPositions: i({ minimum: 0 }), maxDailyLossRatio: c('Decimal'), maxDailyNotional: c('Decimal'),
    maxSlippageBps: n({ minimum: 0 }), maxOrdersPerMinute: i({ minimum: 1 }),
    maxDailyOrders: i({ minimum: 1 }), maxCancelsPerMinute: i({ minimum: 1 }), duplicateIntentWindowSec: n({ minimum: 0 }),
    instrumentAllowlist: arr(c('InstrumentId')), venueAllowlist: arr(c('VenueId')),
  }, ['maxSlippageBps'])
  add('RiskLimits', limits)

  const prot = (kind, props, required) => obj({
    kind: konst(kind), protectorId: c('ProtId'), order: i({ minimum: 0 }), mode: enm(K.PROTECTOR_MODES),
    source: { oneOf: [konst('builtin'), obj({ pluginId: ne(), version: ne() }, ['pluginId', 'version'])] },
    ...props,
  }, ['kind', ...required])
  add('Protector', {
    oneOf: [
      prot('cooldown', { afterOpenSec: n({ minimum: 0 }) }, ['afterOpenSec']),
      prot('stoploss_guard', { windowMin: n(), maxStoplosses: i(), pauseMin: n(), scope: enm('instrument', 'account') }, ['windowMin', 'maxStoplosses', 'pauseMin', 'scope']),
      prot('drawdown_pause', { windowHours: n(), maxDrawdownRatio: c('Decimal'), pauseMin: n() }, ['windowHours', 'maxDrawdownRatio', 'pauseMin']),
      prot('low_profit_lock', { windowHours: n(), minProfitRatio: c('Decimal'), lockMin: n() }, ['windowHours', 'minProfitRatio', 'lockMin']),
      prot('max_consecutive_failures', { count: i({ minimum: 1 }), pauseMin: n() }, ['count', 'pauseMin']),
      prot('plugin', { pluginId: ne(), params: anyObj() }, ['pluginId']),
    ],
  })

  add('TemporaryRelax', obj({
    fields: anyObj(), from: c('Ms'), until: c('Ms'), revertToVersion: i({ minimum: 0 }),
  }, ['fields', 'from', 'until', 'revertToVersion']))

  add('RiskPolicy', obj({
    policyId: c('PolId'), version: i({ minimum: 1 }),
    scope: obj({ type: enm(K.POLICY_SCOPE_TYPES), id: ne() }, ['type', 'id']),
    limits: m('RiskLimits'), protectors: arr(m('Protector')),
    limitMode: obj({ size: b(), leverage: b(), maxSlippageBps: b() }),
    killSwitch: obj({ file: b(), onTrip: obj({ cancelAll: b(), keepStopLoss: b(), closeAll: b() }, ['cancelAll', 'keepStopLoss', 'closeAll']) }),
    failClosed: obj({ stalePriceMs: i({ minimum: 0 }), staleAccountMs: i({ minimum: 0 }), onMissingPrice: konst('deny') }, ['stalePriceMs', 'onMissingPrice']),
    denyLlmLiveEntries: b({ default: true, description: '缺省 = true；LLM 来源的实盘开仓一律拒绝' }),
    temporaryRelax: nullable(m('TemporaryRelax')),
    dailyResetAt: s({ pattern: '^\\d{2}:\\d{2}Z$' }), valuationCcy: ne(), attestation: m('Attestation'),
  }, ['policyId', 'version', 'scope', 'limits', 'failClosed', 'dailyResetAt', 'valuationCcy', 'attestation']))

  add('RiskPreset', obj({
    id: s({ pattern: '^p-lev\\d+-o\\d+-d\\d+$' }), maxLeverage: n(), maxOrderNotional: c('Decimal'), maxPositionNotionalRatio: c('Decimal'),
    maxTotalNotionalRatio: c('Decimal'), maxOpenPositions: i(), maxDailyLossRatio: c('Decimal'), cooldownSec: n({ minimum: 0 }), display: ne(),
  }, ['id', 'maxLeverage', 'maxOrderNotional', 'maxPositionNotionalRatio', 'maxTotalNotionalRatio', 'maxOpenPositions', 'maxDailyLossRatio', 'cooldownSec', 'display']))

  add('TradingState', enm(K.TRADING_STATES))
  add('TradingScope', obj({ type: enm(K.TRADING_STATE_SCOPE_TYPES), id: ne() }, ['type', 'id']))

  const estimates = obj({
    notional: c('Decimal'), marginRequired: c('Decimal'), liquidationPrice: nullable(c('Decimal')), slippageBps: n(), feeEstimate: c('Decimal'),
    positionNotionalRatioAfter: c('Decimal'), totalNotionalRatioAfter: c('Decimal'), rateBudgetRemaining: i(),
  })
  add('PrecheckResult', obj({
    precheckId: c('PckId'), verdict: enm(K.PRECHECK_VERDICTS), policyVersion: i({ minimum: 0 }), ruleHits: arr(m('RuleHit')),
    estimates,
    priceRef: obj({ markPrice: c('Decimal'), ts: c('Ms') }, ['markPrice', 'ts']),
    expiresAt: c('Ms'),
  }, ['precheckId', 'verdict', 'policyVersion', 'ruleHits', 'estimates']))
  add('PrecheckEstimates', estimates)

  // ---- Signal / Experiment / Decision ---------------------------------------------------------
  const evidence = obj({ type: enm('signal', 'decision', 'note', 'backtest', 'experiment'), id: ne() }, ['type', 'id'])
  add('EvidenceRef', evidence)
  add('Signal', {
    ...obj({
      signalId: c('SigId'), ts: c('Ms'), instrumentId: c('InstrumentId'), kind: enm(K.SIGNAL_KINDS), target: n({ minimum: -1, maximum: 1 }),
      strength: n({ minimum: 0, maximum: 1 }), confidence: n({ minimum: 0, maximum: 1 }), method: s(), expiresAt: c('Ms'), reason: ne(),
      evidence: arr(evidence), origin: m('Origin'),
    }, ['signalId', 'ts', 'instrumentId', 'kind', 'expiresAt', 'reason', 'origin']),
    allOf: [
      when(propIs('kind', 'target'), { required: ['target'] }),
      // strength / confidence 只有声明了评分方法（method）才允许出现
      when({ anyOf: [{ required: ['strength'] }, { required: ['confidence'] }] }, { required: ['method'] }),
    ],
  })

  const pin = obj({ kind: ne(), id: ne(), version: ne(), sha256: c('Sha256') }, ['kind', 'id', 'version', 'sha256'])
  add('Pin', pin)
  add('BacktestAssumptions', obj({
    fees: { oneOf: [obj({ maker: c('Decimal'), taker: c('Decimal') }, ['maker', 'taker']), konst('venue')] },
    slippageBps: n({ minimum: 0 }), fillModel: ne(), funding: b(), liquidation: b(), latencyMs: n({ minimum: 0 }),
    maxVolumeShare: n({ minimum: 0, maximum: 1 }), liquidationPenaltyRatio: n({ minimum: 0 }),
  }, ['fees', 'slippageBps', 'fillModel', 'funding', 'liquidation']))
  const bias = enm('pass', 'fail', 'not_run')
  const prim = { type: ['number', 'boolean', 'string'] }
  add('LossAttribution', obj({
    totalLoss: c('Decimal'), earlyExit: c('Decimal'), lateExit: c('Decimal'), violation: c('Decimal'), overtrading: c('Decimal'), residual: c('Decimal'),
    method: ne(), basis: obj({ fromSeq: i({ minimum: 0 }), toSeq: i({ minimum: 0 }) }, ['fromSeq', 'toSeq']),
  }, ['totalLoss', 'earlyExit', 'lateExit', 'violation', 'overtrading', 'residual', 'method', 'basis']))
  // 三级口径之一：自由形状，只有 lossAttribution 有约定（v0.1.3）
  add('ExperimentMetrics', obj({ lossAttribution: m('LossAttribution') }))
  const amendedValues = obj({ price: nullable(c('Decimal')), size: c('Decimal'), triggerPrice: nullable(c('Decimal')) })
  add('OrderAmendedPayload', obj({ orderId: c('OrdId'), before: amendedValues, after: amendedValues }, ['orderId', 'before', 'after']))
  add('OrderStatusUnknownPayload', obj({ venue: c('VenueId'), rawStatus: s(), orderId: c('OrdId') }, ['venue', 'rawStatus', 'orderId']))
  add('PluginHealthChangedPayload', obj({ pluginId: s(), from: s(), to: s(), reason: s() }, ['pluginId', 'from', 'to']))
  add('ModelTrainedPayload', obj({
    modelId: ne(), modelVersion: ne(), modelSha256: c('Sha256'), trainWindow: obj({ from: c('Ms'), to: c('Ms') }, ['from', 'to']),
    labelMaturityMs: i({ minimum: 0 }), sampleCount: i({ minimum: 0 }), metrics: rec(n()),
  }, ['modelId', 'modelVersion', 'modelSha256', 'trainWindow', 'labelMaturityMs', 'sampleCount']))
  const experimentWindow = obj({ from: c('Ms'), to: c('Ms') }, ['from', 'to'])
  const experimentExecutor = {
    oneOf: [
      obj({ kind: konst('engine'), engineId: ne(), instanceId: c('InstanceId'), codeDigest: nullable(c('Sha256')) }, ['kind', 'engineId', 'instanceId', 'codeDigest']),
      obj({ kind: konst('agent'), mandateId: c('MdtId') }, ['kind', 'mandateId']),
    ],
  }
  const experimentOwner = obj({ actorType: enm(K.ORIGIN_ACTOR_TYPES), mandateId: c('MdtId'), userId: s() }, ['actorType'])
  const experimentLlm = obj({
    involved: b(), derivedFrom: enm('creator', 'workflow', 'declared'),
    models: arr(obj({ id: ne(), trainingCutoff: c('Ms'), source: enm('kernel-table', 'declared') }, ['id', 'source'])),
  }, ['involved', 'derivedFrom', 'models'])
  const forwardStats = obj({
    tier: enm('forward_paper', 'forward_live'), runIds: arr(s()), accountIds: arr(c('AcctId')), window: m('Window'),
    ledgerRange: obj({ fromSeq: i({ minimum: 0 }), toSeq: i({ minimum: 0 }) }, ['fromSeq', 'toSeq']),
    sample: obj({ trades: i({ minimum: 0 }), fills: i({ minimum: 0 }), roundTrips: i({ minimum: 0 }), spanDays: n({ minimum: 0 }), activeDays: i({ minimum: 0 }), snapshotDays: i({ minimum: 0 }) }, ['trades', 'fills', 'roundTrips', 'spanDays', 'activeDays', 'snapshotDays']),
    valuationCcy: ne(), realizedPnl: c('Decimal'), unrealizedPnlEnd: c('Decimal'), fees: c('Decimal'), funding: c('Decimal'),
    returnRatio: n(), maxDrawdownRatio: n(), sharpe: nullable(n()), sortino: nullable(n()), winRatio: nullable(n({ minimum: 0, maximum: 1 })),
    periodsPerYear: n(), includesUnrealized: konst(true),
    vsBaseline: obj({ baselineId: ne(), excessReturnRatio: n() }, ['baselineId', 'excessReturnRatio']),
    provisional: b(), computedAt: c('Ms'), computedBy: konst('kernel'), digest: c('Sha256'),
  }, ['tier', 'runIds', 'accountIds', 'window', 'ledgerRange', 'sample', 'valuationCcy', 'realizedPnl', 'unrealizedPnlEnd', 'fees', 'funding', 'returnRatio', 'maxDrawdownRatio', 'sharpe', 'sortino', 'winRatio', 'periodsPerYear', 'includesUnrealized', 'provisional', 'computedAt', 'computedBy', 'digest'], {
    allOf: [when(propIs('tier', 'forward_paper'), { properties: { funding: konst('0') } })],
  })
  const packAttestation = obj({ alg: konst('ed25519'), keyId: ne(), digest: c('Sha256'), sig: ne() }, ['alg', 'keyId', 'digest', 'sig'])
  const packBaseProps = {
    schema: konst('gitrader-experiment/1'), packId: ne(), experimentId: c('ExpId'), runId: ne(), subjectKey: nullable(c('Sha256')),
    window: m('Window'),
  }
  const packRequired = ['schema', 'packId', 'experimentId', 'runId', 'subjectKey', 'window']
  add('Window', experimentWindow)
  add('ExperimentExecutor', experimentExecutor)
  add('ExperimentOwner', experimentOwner)
  add('ExperimentLlm', experimentLlm)
  add('EvidencePackRef', obj({ packId: ne(), kind: enm(K.EVIDENCE_PACK_KINDS), tier: enm(K.EVIDENCE_TIERS), digest: c('Sha256'), at: c('Ms'), runId: s() }, ['packId', 'kind', 'tier', 'digest', 'at']))
  add('ForwardStats', forwardStats)
  add('BaselineRef', obj({
    baselineId: ne(), kind: enm('buy_and_hold', 'cash'), instruments: arr(obj({ instrumentId: c('InstrumentId'), weight: n() }, ['instrumentId', 'weight'])),
    window: m('Window'), prices: arr(obj({ instrumentId: c('InstrumentId'), startMark: c('Decimal'), endMark: c('Decimal') }, ['instrumentId', 'startMark', 'endMark'])),
  }, ['baselineId', 'kind', 'instruments', 'window', 'prices']))
  add('EvidencePackBase', obj({
    ...packBaseProps, at: c('Ms'), trialCount: i({ minimum: 0 }),
    trialStats: arr(obj({ runId: ne(), specDigest: c('Sha256'), sharpe: nullable(n()), nObs: i({ minimum: 0 }) }, ['runId', 'specDigest', 'sharpe', 'nObs'])),
    provenance: obj({ kernelVersion: ne(), protocolVersion: ne() }, ['kernelVersion', 'protocolVersion']), attestation: packAttestation,
  }, [...packRequired, 'at', 'trialCount', 'trialStats', 'provenance', 'attestation']))
  const artifact = obj({ artifactId: ne(), sha256: c('Sha256'), kind: enm('trades', 'equity'), sizeBytes: i({ minimum: 0 }), mediaType: ne() }, ['artifactId', 'sha256', 'kind', 'sizeBytes', 'mediaType'])
  const artifacts = arr(artifact, { allOf: [{ contains: obj({ kind: konst('trades') }, ['kind']) }, { contains: obj({ kind: konst('equity') }, ['kind']) }] })
  const backtestPackProps = {
    ...packBaseProps, at: c('Ms'), trialCount: i({ minimum: 0 }),
    trialStats: arr(obj({ runId: ne(), specDigest: c('Sha256'), sharpe: nullable(n()), nObs: i({ minimum: 0 }) }, ['runId', 'specDigest', 'sharpe', 'nObs'])),
    provenance: obj({ kernelVersion: ne(), protocolVersion: ne() }, ['kernelVersion', 'protocolVersion']), attestation: packAttestation,
    kind: enm('backtest', 'holdout'), tier: konst('hypothetical'),
    spec: { $ref: 'urn:gitrader:schema:gep:0.1:BacktestSpec' }, specDigest: c('Sha256'), assumptions: m('BacktestAssumptions'), seed: i(),
    data: obj({
      source: enm('host', 'engine', 'files'), pointInTime: enm(true, false, 'unknown'),
      candlesDigest: { ...c('Sha256'), deprecated: true },
      candlesDigests: arr(obj({ instrumentId: c('InstrumentId'), digest: c('Sha256') }, ['instrumentId', 'digest']), { minItems: 1 }),
      candlesDigestMethod: konst(K.CANDLES_DIGEST_METHOD), timezone: konst('UTC'), alignment: konst('open-time'),
    }, ['source', 'pointInTime', 'candlesDigests', 'candlesDigestMethod', 'timezone', 'alignment']),
    instrumentMeta: arr(m('Instrument')),
    stats: obj({ totalReturnRatio: n(), annualizedRatio: n(), maxDrawdownRatio: n(), sharpe: n(), sortino: n(), winRatio: n(), profitFactor: nullable(n()), trades: i({ minimum: 0 }), fills: i({ minimum: 0 }), avgHoldBars: n(), spanDays: n(), finalEquity: n() }, ['totalReturnRatio', 'annualizedRatio', 'maxDrawdownRatio', 'sharpe', 'winRatio', 'profitFactor', 'trades', 'fills', 'avgHoldBars', 'spanDays', 'finalEquity']),
    biasChecks: obj({ lookahead: bias, recursive: bias }, ['lookahead', 'recursive']),
    partitions: arr(obj({ kind: enm('train', 'validation', 'holdout'), window: m('Window'), embargoMs: c('Ms'), purgeMs: c('Ms') }, ['kind', 'window'])),
    artifacts, returnsArtifact: obj({ artifactId: ne(), sha256: c('Sha256') }, ['artifactId', 'sha256']),
    llm: obj({ involved: b(), derivedFrom: enm('creator', 'workflow', 'declared'), models: arr(obj({ id: ne(), trainingCutoff: c('Ms'), source: enm('kernel-table', 'declared') }, ['id', 'source'])), contaminated: enm(K.LLM_CONTAMINATION_STATES), leakFreeFrom: nullable(c('Ms')) }, ['involved', 'derivedFrom', 'models', 'contaminated', 'leakFreeFrom']),
  }
  const backtestRequired = [...packRequired, 'at', 'trialCount', 'trialStats', 'provenance', 'attestation', 'kind', 'tier', 'spec', 'specDigest', 'assumptions', 'seed', 'data', 'instrumentMeta', 'stats', 'biasChecks', 'artifacts', 'llm']
  add('BacktestEvidencePack', obj(backtestPackProps, backtestRequired))
  const draftPackProps = { ...backtestPackProps }
  const kernelPackFields = ['packId', 'experimentId', 'runId', 'at', 'trialCount', 'trialStats', 'provenance', 'attestation']
  for (const omitted of kernelPackFields) delete draftPackProps[omitted]
  const draftRequired = backtestRequired.filter((field) => !kernelPackFields.includes(field))
  add('EvidencePackDraft', obj(draftPackProps, draftRequired, { additionalProperties: false }))
  add('ExperimentPackInput', obj({ runId: ne(), note: s() }, ['runId'], { additionalProperties: false }))
  const forwardPackCore = { ...packBaseProps, at: c('Ms'), trialCount: i({ minimum: 0 }), trialStats: arr(obj({ runId: ne(), specDigest: c('Sha256'), sharpe: nullable(n()), nObs: i({ minimum: 0 }) }, ['runId', 'specDigest', 'sharpe', 'nObs'])), provenance: obj({ kernelVersion: ne(), protocolVersion: ne() }, ['kernelVersion', 'protocolVersion']), attestation: packAttestation, kind: konst('forward') }
  const forwardPack = (tier) => ({
    allOf: [
      obj({ ...forwardPackCore, tier: konst(tier), forward: m('ForwardStats') }, [...packRequired, 'at', 'trialCount', 'trialStats', 'provenance', 'attestation', 'kind', 'tier', 'forward']),
      { properties: { forward: { properties: { tier: konst(tier) }, required: ['tier'] } } },
    ],
  })
  add('ForwardEvidencePack', { oneOf: [forwardPack('forward_paper'), forwardPack('forward_live')] })
  add('EvidencePack', { oneOf: [m('BacktestEvidencePack'), m('ForwardEvidencePack')] })
  add('ExperimentRun', obj({
    stage: enm(K.EXPERIMENT_STAGES), jobId: c('JobId'), accountId: c('AcctId'), mandateId: c('MdtId'), runId: s(), attachedAt: c('Ms'),
    executor: m('ExperimentExecutor'), from: c('Ms'), to: nullable(c('Ms')),
    ledgerRange: obj({ fromSeq: i({ minimum: 0 }), toSeq: i({ minimum: 0 }) }, ['fromSeq', 'toSeq']),
  }, ['stage', 'from', 'to']))
  add('LabRun', obj({
    runId: ne(), kind: enm('backtest', 'replay'), experimentId: c('ExpId'), executor: m('ExperimentExecutor'), subjectKey: nullable(c('Sha256')),
    specDigest: c('Sha256'), instruments: arr(c('InstrumentId')), window: m('Window'),
    partitions: arr(obj({ kind: enm('train', 'validation', 'holdout'), window: m('Window'), embargoMs: c('Ms'), purgeMs: c('Ms') }, ['kind', 'window'])),
    startedAt: c('Ms'), status: enm(K.BACKTEST_STATES), resultDigest: c('Sha256'), stats: obj({ sharpe: nullable(n()), nObs: i({ minimum: 0 }) }, ['sharpe', 'nObs']),
    returnsArtifact: obj({ artifactId: ne(), sha256: c('Sha256') }, ['artifactId', 'sha256']), packId: ne(),
  }, ['runId', 'kind', 'executor', 'subjectKey', 'specDigest', 'instruments', 'window', 'startedAt', 'status']))
  add('ExperimentTransitionEvidence', obj({
    actor: obj({ actorType: enm(K.ORIGIN_ACTOR_TYPES), mandateId: c('MdtId'), userId: s(), via: enm(K.ORIGIN_VIA) }, ['actorType', 'via']),
    packs: arr(m('EvidencePack')), labRuns: arr(m('LabRun')), accounts: arr(obj({ accountId: c('AcctId'), mode: enm('paper', 'shadow', 'live') }, ['accountId', 'mode'])),
    backtestEnteredAt: c('Ms'),
    authorizationValid: b(), riskPolicyValid: b(), parallelExperimentsDisclosed: b(), presence: obj({ verified: b(), forwardPackDigest: c('Sha256') }, ['verified', 'forwardPackDigest']),
  }, ['actor', 'packs', 'labRuns', 'accounts']))
  add('ForwardRunInput', obj({ runId: ne(), accountId: c('AcctId'), executor: m('ExperimentExecutor'), attachedAt: c('Ms'), to: nullable(c('Ms')) }, ['runId', 'accountId', 'executor', 'attachedAt', 'to']))
  add('ForwardFillSlice', obj({
    sliceId: ne(), fillId: c('FillId'), orderId: c('OrdId'), runId: ne(), accountId: c('AcctId'), instrumentId: c('InstrumentId'), positionKey: ne(),
    seq: i({ minimum: 0 }), ts: c('Ms'), recordedAt: c('Ms'), attestation: enm(K.LEDGER_ATTESTATIONS), origin: m('Origin'),
    positionBefore: c('Decimal'), positionAfter: c('Decimal'), realizedPnl: c('Decimal'), fee: c('Decimal'), valuationCcy: ne(),
  }, ['sliceId', 'fillId', 'orderId', 'runId', 'accountId', 'instrumentId', 'positionKey', 'seq', 'ts', 'recordedAt', 'attestation', 'origin', 'positionBefore', 'positionAfter', 'realizedPnl', 'fee', 'valuationCcy']))
  add('ForwardSnapshot', obj({ seq: i({ minimum: 0 }), accountId: c('AcctId'), at: c('Ms'), recordedAt: c('Ms'), attestation: enm(K.LEDGER_ATTESTATIONS), kind: enm('daily', 'stage'), equity: c('Decimal'), unrealizedPnl: c('Decimal'), valuationCcy: ne() }, ['seq', 'accountId', 'at', 'recordedAt', 'attestation', 'kind', 'equity', 'unrealizedPnl', 'valuationCcy']))
  add('ForwardStatsInput', obj({
    tier: konst('forward_paper'), window: m('Window'), stageEnteredAt: c('Ms'), runs: arr(m('ForwardRunInput')),
    initialEquity: arr(obj({ accountId: c('AcctId'), at: c('Ms'), equity: c('Decimal'), unrealizedPnl: c('Decimal') }, ['accountId', 'at', 'equity', 'unrealizedPnl'])),
    fills: arr(m('ForwardFillSlice')), snapshots: arr(m('ForwardSnapshot')), valuationCcy: ne(), periodsPerYear: n(), finalized: b(), computedAt: c('Ms'),
    baseline: obj({ baselineId: ne(), window: m('Window'), returnRatio: n() }, ['baselineId', 'window', 'returnRatio']),
  }, ['tier', 'window', 'stageEnteredAt', 'runs', 'initialEquity', 'fills', 'snapshots', 'valuationCcy', 'periodsPerYear', 'finalized', 'computedAt']))
  add('ExperimentConformanceCase', {
    oneOf: [
      obj({
        id: ne(), kind: konst('transition'),
        input: obj({ experiment: m('Experiment'), to: enm(K.EXPERIMENT_STAGES), evidence: m('ExperimentTransitionEvidence'), now: c('Ms') }, ['experiment', 'to', 'evidence', 'now']),
        expect: obj({ ok: b(), missing: arr(s()) }, ['ok', 'missing']),
        then: arr(obj({ to: enm(K.EXPERIMENT_STAGES), now: c('Ms'), expect: obj({ ok: b(), missing: arr(s()) }, ['ok', 'missing']) }, ['to', 'now', 'expect'])),
      }, ['id', 'kind', 'input', 'expect']),
      obj({ id: ne(), kind: konst('readonly'), input: obj({ patch: { type: 'object' } }, ['patch']), expect: obj({ paths: arr(s()) }, ['paths']) }, ['id', 'kind', 'input', 'expect']),
      obj({ id: ne(), kind: konst('append-only'), input: obj({ current: m('Experiment'), next: m('Experiment') }, ['current', 'next']), expect: obj({ paths: arr(s()) }, ['paths']) }, ['id', 'kind', 'input', 'expect']),
      obj({
        id: ne(), kind: konst('schema'),
        input: obj({ schema: ne(), value: {} }, ['schema', 'value']),
        expect: obj({ ok: b(), readonlyPaths: arr(s()) }, ['ok']),
      }, ['id', 'kind', 'input', 'expect']),
      obj({
        id: ne(), kind: konst('candles-digest'),
        streams: arr(obj({
          instrumentId: c('InstrumentId'), candles: arr(m('Candle')),
          variants: arr(arr(m('Candle'))), digest: c('Sha256'),
        }, ['instrumentId', 'candles', 'variants', 'digest']), { minItems: 1 }),
      }, ['id', 'kind', 'streams']),
      obj({
        id: ne(), kind: konst('kernel-contract'), rule: enm('frozen', 'trial-count', 'holdout', 'llm-attribution', 'lifecycle'),
        steps: arr(obj({ operation: ne(), given: { type: 'object' }, expect: { type: 'object' } }, ['operation', 'given', 'expect'])),
      }, ['id', 'kind', 'rule', 'steps']),
    ],
  })
  add('ForwardConformanceCase', obj({
    id: ne(), input: m('ForwardStatsInput'),
    expect: obj({
      sample: obj({ trades: i({ minimum: 0 }), fills: i({ minimum: 0 }), roundTrips: i({ minimum: 0 }), spanDays: n({ minimum: 0 }), activeDays: i({ minimum: 0 }), snapshotDays: i({ minimum: 0 }) }, ['trades', 'fills', 'roundTrips', 'spanDays', 'activeDays', 'snapshotDays']),
      realizedPnl: c('Decimal'), unrealizedPnlEnd: c('Decimal'), fees: c('Decimal'), funding: c('Decimal'), returnRatio: n(), maxDrawdownRatio: n(),
      sharpe: nullable(n()), sortino: nullable(n()), winRatio: nullable(n({ minimum: 0, maximum: 1 })),
    }, ['sample', 'realizedPnl', 'unrealizedPnlEnd', 'fees', 'funding', 'returnRatio', 'maxDrawdownRatio', 'sharpe', 'sortino', 'winRatio']),
    tolerance: n({ minimum: 0 }),
  }, ['id', 'input', 'expect', 'tolerance']))
  add('ExperimentCreatePatch', obj({ title: ne(), hypothesis: ne(), params: rec(prim) }, ['title', 'hypothesis']))
  const readonlyRoots = K.EXPERIMENT_READONLY_FIELDS.join('|')
  const patchConclusion = { anyOf: [s(), obj({ text: s(), origin: m('Origin'), at: c('Ms') }, ['text', 'origin', 'at'])] }
  const experimentLlmPatch = obj({
    models: arr(obj({ id: ne(), trainingCutoff: c('Ms'), source: enm('kernel-table', 'declared') }, ['id', 'source'])),
    derivedFrom: enm('creator', 'workflow', 'declared'), involved: konst(true),
  }, [], { additionalProperties: false, patternProperties: { '^x-': {} } })
  add('ExperimentPatch', obj({
    title: ne(), hypothesis: ne(), subject: obj({ strategy: m('Pin'), workflow: m('Pin'), params: rec(prim) }, ['params']),
    params: rec(prim), assumptions: m('BacktestAssumptions'), data: arr(obj({ source: ne(), range: ne(), sha256: c('Sha256') }, ['source', 'range', 'sha256'])),
    conclusion: patchConclusion,
    conclusions: arr(obj({ text: s(), origin: m('Origin'), at: c('Ms'), version: i({ minimum: 0 }) }, ['text', 'origin', 'at', 'version'])),
    notes: arr(obj({ text: s(), origin: m('Origin'), at: c('Ms') }, ['text', 'origin', 'at'])),
    llm: experimentLlmPatch,
    lineage: obj({ parentExperimentId: c('ExpId'), reason: s() }), holdoutWindow: nullable(m('Window')),
  }, [], {
    additionalProperties: false,
    patternProperties: { '^x-': {} },
    propertyNames: { not: { pattern: `^(?:${readonlyRoots})(?:$|\\.|\\[)` } },
  }))
  add('ExperimentAttach', obj({
    run: obj({
      executor: m('ExperimentExecutor'), accountId: c('AcctId'), from: { ...c('Ms'), description: '旧输入字段；内核忽略' },
      stage: enm(K.EXPERIMENT_STAGES), to: nullable(c('Ms')),
    }, ['executor', 'accountId']),
  }, ['run']))
  const experimentTool = K.MCP_TOOLS.find((tool) => tool.name === 'experiment')
  if (!experimentTool) throw new Error('ExperimentToolInput: missing experiment tool')
  const experimentActions = experimentTool.actions.map((action) => action.name)
  add('ExperimentToolInput', {
    ...obj({
      action: enm(experimentActions), experimentId: c('ExpId'),
      patch: anyObj(), attach: m('ExperimentAttach'), to: enm(K.EXPERIMENT_STAGES), pack: m('ExperimentPackInput'), holdoutWindow: m('Window'),
    }, ['action']),
    allOf: [
      ...['get', 'update', 'attach', 'stage', 'pack', 'export'].map((action) => when(propIs('action', action), { required: ['experimentId'] })),
      when(propIs('action', 'update'), { required: ['patch'], properties: { patch: m('ExperimentPatch') } }),
      when(propIs('action', 'create'), { required: ['patch'], properties: { patch: m('ExperimentCreatePatch') } }),
      when(propIs('action', 'attach'), { required: ['attach'] }),
      when(propIs('action', 'stage'), { required: ['to'] }),
      when(propIs('action', 'pack'), { required: ['pack'] }),
    ],
  })
  add('Experiment', {
    ...obj({
      experimentId: c('ExpId'), title: ne(), hypothesis: ne(), stage: enm(K.EXPERIMENT_STAGES),
      subject: obj({ strategy: pin, workflow: pin, params: rec(prim) }, ['params']),
      data: arr(obj({ source: ne(), range: ne(), sha256: c('Sha256') }, ['source', 'range', 'sha256'])),
      assumptions: m('BacktestAssumptions'),
      biasChecks: obj({ lookahead: bias, recursive: bias, trialCount: i({ minimum: 0 }) }, ['lookahead', 'recursive', 'trialCount']),
      runs: arr(m('ExperimentRun')),
      metrics: obj({ backtest: m('ExperimentMetrics'), paper: m('ExperimentMetrics'), live: m('ExperimentMetrics') }),
      conclusion: obj({ text: s(), origin: m('Origin'), at: c('Ms') }, ['text', 'origin', 'at']),
      version: i({ minimum: 0 }), owner: m('ExperimentOwner'), subjectKey: nullable(c('Sha256')), executorKind: { enum: ['engine', 'agent', null] },
      frozen: obj({ hypothesis: b(), subject: b(), holdout: b() }, ['hypothesis', 'subject', 'holdout']),
      holdoutWindow: nullable(m('Window')), holdoutRunId: nullable(s()), packs: arr(m('EvidencePackRef')),
      forward: nullable(m('ForwardStats')), baseline: nullable(m('BaselineRef')), llm: m('ExperimentLlm'), stageEnteredAt: c('Ms'),
      reviewFrom: nullable(enm(K.EXPERIMENT_STAGES)),
      conclusions: arr(obj({ text: s(), origin: m('Origin'), at: c('Ms'), version: i({ minimum: 0 }) }, ['text', 'origin', 'at', 'version'])),
      lineage: obj({ parentExperimentId: c('ExpId'), reason: s() }),
      notes: arr(obj({ text: s(), origin: m('Origin'), at: c('Ms') }, ['text', 'origin', 'at'])),
      origin: m('Origin'), createdAt: c('Ms'), updatedAt: c('Ms'),
    }, ['experimentId', 'title', 'hypothesis', 'stage', 'subject', 'origin', 'createdAt', 'updatedAt']),
    allOf: [when(propIs('stage', 'backtest'), { required: ['assumptions'] })],
  })

  add('DecisionRecord', obj({
    decisionId: c('DecId'), ts: c('Ms'),
    plugin: obj({ id: ne(), version: ne(), sha256: c('Sha256') }, ['id', 'version', 'sha256']),
    endpoint: obj({ configId: ne(), host: ne() }, ['configId', 'host']),
    primitive: ne(),
    input: obj({ digest: c('Sha256'), refs: arr(s()) }, ['digest', 'refs']),
    output: obj({ choice: s(), probabilities: rec(n({ minimum: 0, maximum: 1 })), score: n(), confidence: n({ minimum: 0, maximum: 1 }) }),
    modelVersion: ne(),
    latencyMs: n({ minimum: 0 }), latencyBudgetMs: n({ minimum: 0 }), withinBudget: b(), status: enm('ok', 'timeout', 'error'),
    cost: obj({ amount: c('Decimal'), ccy: ne() }, ['amount', 'ccy']),
    outcome: obj({ resolvedAt: c('Ms'), label: s(), realizedReturnRatio: c('Decimal'), used: b() }, ['resolvedAt', 'used']),
    origin: m('Origin'),
  }, ['decisionId', 'ts', 'plugin', 'endpoint', 'primitive', 'input', 'output', 'latencyMs', 'latencyBudgetMs', 'withinBudget', 'status', 'origin']))

  return out
}
