// SPDX-License-Identifier: Apache-2.0
// ADR-22：便宜模型常猜错工具名与动作名（如 gitrader agent account get）。这里给出「误写 → 正名」表、
// 每个动作一行的 --args 示例，以及名称解析 / 模糊建议；不改 tools.ts（MCP_TOOLS 是契约本体）。
import { MCP_TOOLS } from './tools'

/** 工具名误写 → 工具正名。 */
export const MCP_TOOL_ALIASES: Readonly<Record<string, string>> = {
  accounts: 'account', acct: 'account', proposal: 'proposals', engine: 'engines', risk: 'risk_status',
  riskstatus: 'risk_status', plugin: 'plugins', notes: 'note', experiments: 'experiment',
  backtests: 'backtest', mandates: 'mandate', markets: 'market', ledgers: 'ledger', help: 'discover',
}

/** 动作名误写 → 该工具的动作正名（外层键 = 工具正名）。 */
export const MCP_ACTION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  account: {
    get: 'summary', info: 'summary', detail: 'summary', details: 'summary', overview: 'summary', status: 'summary',
    balance: 'balances', position: 'positions', order: 'orders', open_orders: 'orders', openorders: 'orders',
    trades: 'fills', fill: 'fills', accounts: 'list', ls: 'list',
  },
  proposals: { status: 'get', show: 'get', detail: 'get', check: 'get', view: 'get', ls: 'list', all: 'list' },
  market: {
    price: 'quote', ticker: 'quote', quotes: 'quote', last: 'quote', orderbook: 'book', depth: 'book',
    klines: 'candles', kline: 'candles', ohlcv: 'candles', bars: 'candles', find: 'search', lookup: 'search',
    instruments: 'search', status: 'venue_status',
  },
  risk_status: { get: 'state', status: 'state', limits: 'usage', usage_status: 'usage' },
  ledger: { list: 'query', get: 'trace', search: 'query', history: 'query' },
  engines: { get: 'status', ls: 'list' },
  discover: { help: 'tool_help', tools: 'groups', list: 'groups', caps: 'capabilities' },
  mandate: { get: 'status', info: 'status' },
  backtest: { get: 'result', results: 'result' },
  research: { hyperopt: 'optimize', optimise: 'optimize', factors: 'factor_report', report: 'backtest_report', find: 'search', lookup: 'search', get: 'result', results: 'result' },
  plugins: { ls: 'list', info: 'describe', get: 'describe' },
}

/** 下单意图示例（字段与 ORDER_INTENT_GUIDE 一致，开仓带 tpsl.stopLoss）。 */
const INTENT_JSON =
  '{"accountId":"<accountId>","instrumentId":"hyperliquid:BTC","side":"buy","type":"market","size":"0.001","reason":"<下单理由>","tpsl":{"grouping":"order","stopLoss":{"triggerPrice":"<参考价下方约 1%>"}}}'

/** BacktestSpec 的最小示例；subject 随用途不同。 */
const specJson = (subject: string): string =>
  `{"subject":${subject},"instruments":["hyperliquid:BTC"],"interval":"15m","from":1700000000000,"to":1730000000000,"data":{"source":"engine"},"account":{"initialBalance":"10000","ccy":"USDT"},"assumptions":{"fees":"venue","slippageBps":2,"fillModel":"next-bar-open","funding":true,"liquidation":true},"seed":1}`

const STRATEGY_SPEC_JSON = specJson('{"strategy":{"id":"<strategyId>","version":"<版本>","params":{}}}')
/** research.optimize / walk_forward 的最小示例：BacktestSpec + space / search / validation（validation 必填：holdout 或 walk-forward）。 */
const optimizeSpecJson = (validation: string): string =>
  `{"subject":{"strategy":{"id":"<strategyId>","version":"<版本>","params":{}}},"instruments":["hyperliquid:BTC"],"interval":"1h","from":1700000000000,"to":1730000000000,"data":{"source":"host"},"account":{"initialBalance":"10000","ccy":"USDC"},"assumptions":{"fees":"venue","slippageBps":2,"fillModel":"next-bar-open","funding":false,"liquidation":false},"seed":1,"space":{"<参数名>":{"type":"integer","min":5,"max":20,"step":5}},"search":{"kind":"grid"},"validation":${validation}}`

/** 每个工具每个动作的 --args 示例（JSON 字符串）。入参名对照内核 agent.ts 与 tools.ts inputSchema。 */
export const MCP_ACTION_USAGE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  takeover: {
    halt_new: '{"reason":"<接管理由>","scope":{"type":"mandate","id":"<mandateId>"}}',
    cancel_all: '{"reason":"<接管理由>","scope":{"type":"mandate","id":"<mandateId>"}}',
    flatten_all: '{"reason":"<接管理由>","scope":{"type":"mandate","id":"<mandateId>"}}',
  },
  mandate: {
    status: '{}',
    heartbeat: '{}',
    downgrade: '{"level":"L2","reason":"<降级理由>"}',
    request_promotion: '{"reason":"<晋级理由>"}',
  },
  discover: {
    groups: '{}',
    tool_help: '{"tool":"propose"}',
    capabilities: '{}',
  },
  market: {
    search: '{"query":"BTC"}',
    quote: '{"instrumentId":"hyperliquid:BTC"}',
    book: '{"instrumentId":"hyperliquid:BTC","depth":10}',
    candles: '{"instrumentId":"hyperliquid:BTC","interval":"15m"}',
    context: '{"instrumentId":"hyperliquid:BTC"}',
    funding: '{"instrumentId":"hyperliquid:BTC"}',
    venue_status: '{}',
  },
  account: {
    list: '{}',
    summary: '{"accountId":"<accountId>"}',
    positions: '{"accountId":"<accountId>"}',
    orders: '{"accountId":"<accountId>"}',
    fills: '{"accountId":"<accountId>"}',
    balances: '{"accountId":"<accountId>"}',
    margin: '{"accountId":"<accountId>"}',
  },
  risk_status: {
    state: '{}',
    usage: '{}',
    rules: '{}',
    denials: '{}',
  },
  ledger: {
    query: '{"filter":{"accountId":"<accountId>"}}',
    trace: '{"id":"<票号或订单 id，如 T-20261026-0001>"}',
    stats: '{}',
  },
  engines: {
    list: '{}',
    status: '{}',
    strategies: '{}',
    start_strategy: '{"strategyId":"<strategyId>","accountId":"<accountId>","instruments":["hyperliquid:BTC"],"interval":"1m"}',
    update_strategy: '{"instanceId":"<instanceId>","params":{}}',
    stop_strategy: '{"instanceId":"<instanceId>"}',
  },
  propose: {
    order: `{"accountId":"<accountId>","reason":"<理由>","intents":[${INTENT_JSON}]}`,
    control: '{"accountId":"<accountId>","control":{"controlKind":"start_strategy","params":{"strategyId":"<strategyId>","accountId":"<accountId>"}},"reason":"<理由>"}',
  },
  proposals: {
    get: '{"ticket":"<票号，如 T-20261026-0001>"}',
    list: '{"status":"pending"}',
    withdraw: '{"ticket":"<票号，如 T-20261026-0001>"}',
  },
  note: {
    add: '{"text":"<笔记内容>"}',
    list: '{}',
  },
  backtest: {
    run: `{"spec":${STRATEGY_SPEC_JSON}}`,
    status: '{"jobId":"<jobId>"}',
    result: '{"jobId":"<jobId>"}',
    cancel: '{"jobId":"<jobId>"}',
  },
  research: {
    optimize: `{"spec":${optimizeSpecJson('{"kind":"holdout","holdoutBars":300}')}}`,
    walk_forward: `{"spec":${optimizeSpecJson('{"kind":"walk-forward","trainBars":600,"testBars":200}')}}`,
    factor_report: '{"spec":{"instruments":["hyperliquid:BTC"],"interval":"1h","from":1700000000000,"to":1730000000000,"data":{"source":"host"},"horizon":5,"window":60}}',
    backtest_report: '{"jobId":"<回测作业 id>","format":"md"}',
    portfolio: '{"accountId":"<accountId>"}',
    search: '{"query":"BTC","limit":5}',
    status: '{"jobId":"<jobId>"}',
    result: '{"jobId":"<jobId>","part":"trials","limit":50}',
    cancel: '{"jobId":"<jobId>"}',
  },
  experiment: {
    create: '{"patch":{"title":"<实验标题>","hypothesis":"<假设>"}}',
    get: '{"experimentId":"<experimentId>"}',
    list: '{}',
    update: '{"experimentId":"<experimentId>","patch":{"hypothesis":"<新假设>"}}',
    attach: '{"experimentId":"<experimentId>","attach":{"run":{"accountId":"<accountId>","executor":{"kind":"agent","mandateId":"<mandateId>"}}}}',
    stage: '{"experimentId":"<experimentId>","to":"backtest"}',
    pack: '{"experimentId":"<experimentId>","pack":{"runId":"<runId>"}}',
    export: '{"experimentId":"<experimentId>"}',
  },
  plugins: {
    list: '{}',
    describe: '{"pluginId":"<pluginId>"}',
    call: '{"pluginId":"<pluginId>","tool":"<tool>","args":{}}',
  },
  order: {
    preview: `{"intent":${INTENT_JSON}}`,
    place: '{"confirmToken":"<preview 返回的令牌>"}',
    amend: '{"orderId":"<orderId>","price":"<价格>"}',
    cancel: '{"orderId":"<orderId>"}',
    cancel_all: '{"accountId":"<accountId>"}',
    close: '{"instrumentId":"hyperliquid:BTC"}',
  },
  workspace: {
    list: '{}',
    add: '{"block":"<块 id@版本>"}',
    remove: '{"instanceId":"<instanceId>"}',
    arrange: '{"instanceId":"<instanceId>","at":{}}',
    save: '{"name":"<工作区名>"}',
    load: '{"name":"<工作区名>"}',
    popout: '{"instanceId":"<instanceId>"}',
    focus: '{"instanceId":"<instanceId>"}',
  },
}

/** 工具正名 → 动作正名清单。 */
const TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  MCP_TOOLS.map((t) => [t.name, t.actions.map((a) => a.name)]),
)

/** 名称比对前的规范化：去空白、转小写、`-` 换成 `_`。 */
const normalize = (s: string): string => s.trim().toLowerCase().replace(/-/g, '_')

/** 工具名解析：先认正名，再查别名表；都没有返回 null。 */
export function resolveMcpTool(name: string): { tool: string; alias?: string } | null {
  if (TOOL_ACTIONS[name] !== undefined) return { tool: name }
  const hit = MCP_TOOL_ALIASES[normalize(name)]
  return hit === undefined ? null : { tool: hit, alias: name }
}

/** 动作名解析：tool 必须是正名；先认动作正名，再查别名表；否则 null。 */
export function resolveMcpAction(tool: string, action: string): { action: string; alias?: string } | null {
  const actions = TOOL_ACTIONS[tool]
  if (actions === undefined) return null
  if (actions.includes(action)) return { action }
  const key = normalize(action)
  if (actions.includes(key)) return { action: key }
  const hit = MCP_ACTION_ALIASES[tool]?.[key]
  return hit === undefined ? null : { action: hit, alias: action }
}

/** Levenshtein 编辑距离（不引依赖）。 */
function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + cost)
      diag = up
    }
  }
  return prev[b.length] ?? 0
}

/** 最接近的候选名：先放包含关系的，再按编辑距离升序补足。 */
export function suggestMcpNames(input: string, candidates: readonly string[], max = 3): string[] {
  const needle = input.trim().toLowerCase()
  if (!needle) return []
  const limit = Math.max(0, Math.trunc(max))
  const unique: string[] = []
  for (const c of candidates) if (!unique.includes(c)) unique.push(c)
  const contained: string[] = []
  const others: string[] = []
  for (const c of unique) {
    const hay = c.toLowerCase()
    if (hay.startsWith(needle) || hay.includes(needle) || needle.includes(hay)) contained.push(c)
    else others.push(c)
  }
  const near = others
    .map((c, index) => ({ c, index, distance: levenshtein(needle, c.toLowerCase()) }))
    .filter((x) => x.distance <= Math.max(2, Math.floor(x.c.length / 2)))
    .sort((x, y) => x.distance - y.distance || x.index - y.index)
    .map((x) => x.c)
  return [...contained, ...near].slice(0, limit)
}

/** 一行用法：gitrader agent <tool> <action> --args '<JSON>'。 */
export function mcpUsageLine(tool: string, action: string): string {
  const args = MCP_ACTION_USAGE[tool]?.[action] ?? '{}'
  return `gitrader agent ${tool} ${action} --args '${args}'`
}
