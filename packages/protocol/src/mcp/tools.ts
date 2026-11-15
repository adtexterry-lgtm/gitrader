// SPDX-License-Identifier: Apache-2.0
// 契约 §5.7 MCP 工具分组与预算、§7.4 74 → 17 映射。工具名不加前缀（宿主已按服务器名加命名空间）。
// 描述文本为中文，每条 ≤ 60 字（施工总单口径；契约 §5.7 原文为英文 ≤300 字符，见 OPEN-QUESTIONS）。
import type { MandateLevel, McpToolGroup } from '../agent/mandate'

export interface McpActionSpec {
  name: string
  /** 该动作所需的最低授权书级别（缺省 = 所有级别）。 */
  minLevel?: MandateLevel
  /** 实盘所需的最低级别（缺省 = 同 minLevel）。纸面 / 影子之外的账户适用。 */
  liveMinLevel?: MandateLevel
  /** 实盘动作不满足 liveMinLevel 或超过自动额度时转提案，而不是直接执行。 */
  liveBecomesProposal?: boolean
  /** 自保动作：Agent 在任何级别都可调。 */
  selfProtect?: boolean
}

export interface McpToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean }

export interface McpToolDef {
  name: string
  group: McpToolGroup
  /** 加载条件：always = 所有级别；level = 授权书 ≥ 该级别；toggle = 人在界面打开后。 */
  load: { kind: 'always' } | { kind: 'level'; min: MandateLevel } | { kind: 'toggle'; setting: string }
  description: string
  annotations: McpToolAnnotations
  actions: readonly McpActionSpec[]
  /** MCP 工具入参 schema（内联、扁平，宿主可直接使用）。 */
  inputSchema: McpInputSchema
  /** 出参的模型 schema 引用（urn:gitrader:schema:model:0.1:<名>）；结果不带 *Text 显示字段。 */
  resultSchemaRefs: readonly string[]
}

export interface McpInputSchema {
  type: 'object'
  required: readonly string[]
  properties: Record<string, Record<string, unknown>>
}

const R = (n: string): string => `urn:gitrader:schema:model:0.1:${n}`
const AG = (n: string): string => `urn:gitrader:schema:agent:0.1:${n}`
const GEP = (n: string): string => `urn:gitrader:schema:gep:0.1:${n}`
const SPEC = (n: 'ledger:1' | 'plugin:1' | 'workspace:1' | 'workflow:2'): string => `urn:gitrader:schema:${n}`

const act = (names: readonly string[]): McpActionSpec[] => names.map((name) => ({ name }))
const schema = (actions: readonly string[], props: Record<string, Record<string, unknown>>, extraRequired: readonly string[] = []): McpInputSchema => ({
  type: 'object',
  required: ['action', ...extraRequired],
  properties: { action: { type: 'string', enum: [...actions] }, ...props },
})

const str = (description?: string): Record<string, unknown> => (description ? { type: 'string', description } : { type: 'string' })
const num = (description?: string): Record<string, unknown> => (description ? { type: 'number', description } : { type: 'number' })
const obj = (description?: string): Record<string, unknown> => (description ? { type: 'object', description } : { type: 'object' })
const arr = (description?: string): Record<string, unknown> => (description ? { type: 'array', description } : { type: 'array' })
const page = { limit: num('条数，默认 20'), cursor: str('翻页游标') }
/** OrderIntent 必填字段（入参 schema 只列字段名，守住 MCP_BUDGET.maxSchemaNesting；含义、示例见 ORDER_INTENT_GUIDE，经 discover tool_help 返回）。 */
export const ORDER_INTENT_REQUIRED = ['accountId', 'instrumentId', 'side', 'type', 'reason'] as const
const intentItem = (description: string): Record<string, unknown> => ({ type: 'object', description, required: [...ORDER_INTENT_REQUIRED] })
/** discover tool_help（propose / order）附带的下单意图说明。 */
export const ORDER_INTENT_GUIDE = [
  'OrderIntent：accountId、instrumentId（带场所前缀，如 hyperliquid:BTC）、side（buy|sell）、type（market|limit…）、reason 必填；size 与 notional 二选一；可选 price、reduceOnly、leverage、tpsl。',
  'tpsl 形如 {"grouping":"order","stopLoss":{"triggerPrice":"…"},"takeProfit":{"triggerPrice":"…"}}；买入的止损低于参考价、卖出的止损高于参考价。',
  '需确认档开仓必须带 tpsl.stopLoss，随开仓一起提交，成交后不要单独补挂。',
  '被拒先读 decision.note 与 ruleHits 的中文原因；不换参数盲目重试。',
  '示例：{"accountId":"<账户 id>","instrumentId":"hyperliquid:BTC","side":"buy","type":"market","size":"0.001","reason":"用户要求试单","tpsl":{"grouping":"order","stopLoss":{"triggerPrice":"<参考价下方约 1%>"}}}',
].join(String.fromCharCode(10))

export const EXPERIMENT_GUIDE = [
  'create：{"action":"create","patch":{"title":"…","hypothesis":"…","params":{"period":20}}}（title/hypothesis 必须放在 patch 里）',
  'attach：{"action":"attach","experimentId":"exp_…","attach":{"run":{"executor":{"kind":"agent","mandateId":"mdt_…"},"accountId":"acct_…","stage":"paper"}}}（run.executor 与 run.accountId 必填；executor 也可以是 kind=engine，带 engineId / instanceId / codeDigest；只能挂 paper 账户）',
  'pack：{"action":"pack","experimentId":"exp_…","pack":{"runId":"run_…"}}',
].join(String.fromCharCode(10))

/** discover tool_help（research）附带的用法说明：动作、异步三步、分页、寻优规格。 */
export const RESEARCH_GUIDE = [
  '动作：optimize / walk_forward / factor_report 是异步作业；backtest_report / portfolio / search 同步；status / result / cancel 凭 jobId 查、取、停。研究只读，不下单。',
  '异步三步：起作业回 {jobId, kind, state} → status {jobId} 看 state（queued|running|done|failed|cancelled）与 progress → result {jobId} 取摘要（≤ 8 KB，带 counts；未完成回 BUSY）。',
  '明细分页：result {jobId, part: trials|folds|factors, limit?, cursor?} 回 {items, total, next?}；有 next 就把它当 cursor 取下一页，最后一页没有 next。',
  '寻优 spec = 回测 spec（subject.strategy.params 只放不参与寻优的固定参数，可为 {}）加 space（{参数名:{type:integer|number,min,max,step?}}，参数名须是策略声明过的）、search（{kind:grid|random|evolution}，缺省 grid）、validation（必填：{kind:holdout,holdoutBars} 或 {kind:walk-forward,trainBars,testBars,step?,embargoBars?,blindHoldoutBars?}）、seed（缺省 42）。网格组合数或 random 的 trials 超过 500 回 INVALID_PARAMS。',
  'walk_forward 只收 walk-forward 计划；optimize 两种都收。结果带 PBO / DSR 与样本外得分，均为假设性回测，不是前向证据。',
  'factor_report 的 spec：{instruments:[1 个], interval, from, to, data, horizon?=5, window?=60, quantiles?=5, top?=20}；t 值用 Newey-West（tMethod / tLags 写在摘要里）。',
  'backtest_report {jobId=回测作业 id, format?=md|json}；portfolio {accountId?}（缺省授权书里第一个账户）；search {query, limit?, cursor?}。',
].join(String.fromCharCode(10))

const takeoverActions = ['halt_new', 'cancel_all', 'flatten_all'] as const
const mandateActions = ['status', 'heartbeat', 'downgrade', 'request_promotion'] as const
const discoverActions = ['groups', 'tool_help', 'capabilities'] as const
const marketActions = ['search', 'quote', 'book', 'candles', 'context', 'funding', 'venue_status'] as const
const accountActions = ['list', 'summary', 'positions', 'orders', 'fills', 'balances', 'margin'] as const
const riskActions = ['state', 'usage', 'rules', 'denials'] as const
const ledgerActions = ['query', 'trace', 'stats'] as const
const engineActions = ['list', 'status', 'strategies', 'start_strategy', 'update_strategy', 'stop_strategy'] as const
const proposeActions = ['order', 'control'] as const
const proposalsActions = ['get', 'list', 'withdraw'] as const
const noteActions = ['add', 'list'] as const
const backtestActions = ['run', 'status', 'result', 'cancel'] as const
const researchActions = ['optimize', 'walk_forward', 'factor_report', 'backtest_report', 'portfolio', 'search', 'status', 'result', 'cancel'] as const
const experimentActions = ['create', 'get', 'list', 'update', 'attach', 'stage', 'pack', 'export'] as const
const pluginActions = ['list', 'describe', 'call'] as const
const orderActions = ['preview', 'place', 'amend', 'cancel', 'cancel_all', 'close'] as const
const workspaceActions = ['list', 'add', 'remove', 'arrange', 'save', 'load', 'popout', 'focus'] as const
const experimentInputSchema = {
  ...schema(experimentActions, {
    experimentId: str(), patch: obj(), attach: obj('run'), to: str(), pack: obj('仅引用 runId，可选 note；证据由内核计算'), holdoutWindow: obj(), ...page,
  }),
  allOf: [{ $ref: R('ExperimentToolInput') }],
}

/** 17 个工具，顺序即 §5.7 表的顺序（S 2、R 5、P 8、E 1、W 1）。workflow 在接线实现之前退出暴露（fix-r6 R3-05），research 顶替它的位置（fix-r6 R3-01）。 */
export const MCP_TOOLS = [
  {
    name: 'takeover', group: 'S', load: { kind: 'always' },
    description: '自保：停新开仓/撤挂单/全平，限自身授权书，必填理由。cancel_all 默认保留止损，转述以返回为准，超时勿重发。',
    annotations: { destructiveHint: true },
    actions: takeoverActions.map((name) => ({ name, selfProtect: true })),
    inputSchema: schema(takeoverActions, { reason: str('接管理由'), scope: obj('{type, id}，不得超出授权书账户') }, ['reason', 'scope']),
    resultSchemaRefs: [AG('TakeoverRequest')],
  },
  {
    name: 'mandate', group: 'S', load: { kind: 'always' },
    description: '查看自己的授权书、发心跳、自降级、申请晋级（批准由人完成）。',
    annotations: {},
    actions: [{ name: 'status', selfProtect: true }, { name: 'heartbeat', selfProtect: true }, { name: 'downgrade', selfProtect: true }, { name: 'request_promotion' }],
    inputSchema: schema(mandateActions, { level: str('降到的级别 L0–L3'), reason: str() }),
    resultSchemaRefs: [AG('Mandate')],
  },
  {
    name: 'discover', group: 'R', load: { kind: 'always' },
    description: '了解可用工具组、单个工具的用法与当前能力。',
    annotations: { readOnlyHint: true },
    actions: act(discoverActions),
    inputSchema: schema(discoverActions, { tool: str('工具名') }),
    resultSchemaRefs: [],
  },
  {
    name: 'market', group: 'R', load: { kind: 'always' },
    description: '行情只读：搜索标的、报价、盘口、K 线、上下文、资金费、场所状态。',
    annotations: { readOnlyHint: true },
    actions: act(marketActions),
    inputSchema: schema(marketActions, { query: str('搜索词'), instrumentId: str('如 hyperliquid:BTC'), interval: str('如 15m'), depth: num(), from: num('毫秒'), to: num('毫秒'), ...page }),
    resultSchemaRefs: [R('Instrument'), R('Candle'), R('Book'), R('MarketContext'), R('VenueStatus')],
  },
  {
    name: 'account', group: 'R', load: { kind: 'always' },
    description: '账户只读：列表、汇总、持仓、挂单、成交、余额、保证金。',
    annotations: { readOnlyHint: true },
    actions: act(accountActions),
    inputSchema: schema(accountActions, { accountId: str('账户 id，必须在授权书账户内'), ...page }),
    resultSchemaRefs: [R('Account'), R('Position'), R('Order'), R('Fill'), R('Balance'), R('MarginSnapshot')],
  },
  {
    name: 'risk_status', group: 'R', load: { kind: 'always' },
    description: '风控只读：交易状态、额度占用、规则、拒单记录；不能修改。',
    annotations: { readOnlyHint: true },
    actions: act(riskActions),
    inputSchema: schema(riskActions, { accountId: str(), ...page }),
    resultSchemaRefs: [R('RiskPolicy'), R('RuleHit')],
  },
  {
    name: 'ledger', group: 'R', load: { kind: 'always' },
    description: '账本只读：查询记录、追溯链路、统计。',
    annotations: { readOnlyHint: true },
    actions: act(ledgerActions),
    inputSchema: schema(ledgerActions, { filter: obj('type / accountId / orderId / ticket / origin.actorType 等'), id: str('trace 的起点'), ...page }),
    resultSchemaRefs: [SPEC('ledger:1')],
  },
  {
    name: 'engines', group: 'P', load: { kind: 'always' },
    description: '引擎：列表与状态、策略清单、启动 / 更新 / 停止；实盘启动转提案。',
    annotations: {},
    actions: [
      { name: 'list' }, { name: 'status' }, { name: 'strategies' },
      { name: 'start_strategy', minLevel: 'L1', liveBecomesProposal: true },
      { name: 'update_strategy', minLevel: 'L1', liveBecomesProposal: true },
      { name: 'stop_strategy', selfProtect: true },
    ],
    inputSchema: schema(engineActions, { engineId: str(), strategyId: str(), instanceId: str(), accountId: str(), instruments: arr('instrumentId 列表'), interval: str(), params: obj() }),
    resultSchemaRefs: [],
  },
  {
    name: 'propose', group: 'P', load: { kind: 'level', min: 'L1' },
    description: '提交提案（下单或控制类），必填理由，由人批准后执行。金额须先经用户确认；转述以返回字段为准。',
    annotations: {},
    actions: [{ name: 'order', minLevel: 'L1', liveMinLevel: 'L2' }, { name: 'control', minLevel: 'L1', liveMinLevel: 'L2' }],
    inputSchema: schema(proposeActions, { accountId: str(), intents: arr('OrderIntent≤10条，必填accountId/instrumentId(如hyperliquid:BTC)/side/type/reason，开仓带tpsl.stopLoss'), control: obj('控制类意图'), reason: str('理由，必填'), evidence: arr() }, ['reason']),
    resultSchemaRefs: [AG('Proposal')],
  },
  {
    name: 'proposals', group: 'P', load: { kind: 'level', min: 'L1' },
    description: '查看、列出、撤回自己的提案；没有批准与拒绝。',
    annotations: {},
    actions: [{ name: 'get', minLevel: 'L1' }, { name: 'list', minLevel: 'L1' }, { name: 'withdraw', minLevel: 'L1', selfProtect: true }],
    inputSchema: schema(proposalsActions, { proposalId: str(), ticket: str('T-YYYYMMDD-NNNN'), status: str(), ...page }),
    resultSchemaRefs: [AG('Proposal')],
  },
  {
    name: 'note', group: 'P', load: { kind: 'always' },
    description: '写入与查看研究笔记（带出处）。',
    annotations: {},
    actions: act(noteActions),
    inputSchema: schema(noteActions, { text: str(), tags: arr(), refs: arr(), ...page }),
    resultSchemaRefs: [SPEC('ledger:1')],
  },
  {
    name: 'backtest', group: 'P', load: { kind: 'always' },
    description: '回测：提交、查看进度与结果、取消；假设如实标注。',
    annotations: {},
    actions: [
      { name: 'run', minLevel: 'L1' },
      { name: 'status' },
      { name: 'result' },
      { name: 'cancel' },
    ],
    inputSchema: schema(backtestActions, { spec: obj('BacktestSpec'), jobId: str() }),
    resultSchemaRefs: [GEP('BacktestResult')],
  },
  {
    name: 'research', group: 'P', load: { kind: 'always' },
    description: '研究（只读）：寻优、滚动验证、因子报告、回测报告、组合、标的搜索；长任务异步取结果。',
    annotations: { readOnlyHint: true },
    actions: [
      { name: 'optimize', minLevel: 'L1' },
      { name: 'walk_forward', minLevel: 'L1' },
      { name: 'factor_report', minLevel: 'L1' },
      { name: 'backtest_report' },
      { name: 'portfolio' },
      { name: 'search' },
      { name: 'status' },
      { name: 'result' },
      { name: 'cancel' },
    ],
    inputSchema: {
      ...schema(researchActions, {
        spec: obj('optimize/walk_forward/factor_report 的参数；寻优须带 validation 与 space'), jobId: str('作业 id；backtest_report 用回测作业 id'),
        part: { type: 'string', enum: ['summary', 'trials', 'folds', 'factors'] }, query: str('搜索词'), accountId: str('portfolio 用，须在授权书账户内'),
        format: { type: 'string', enum: ['md', 'json'] }, limit: num('1–1000，默认 500'), cursor: str('翻页游标'),
      }),
    },
    resultSchemaRefs: [],
  },
  {
    name: 'experiment', group: 'P', load: { kind: 'always' },
    description: '实验记录：创建、查看、更新，关联回测与纸面区间。',
    annotations: {},
    actions: act(experimentActions),
    inputSchema: experimentInputSchema,
    resultSchemaRefs: [R('Experiment')],
  },
  {
    name: 'plugins', group: 'P', load: { kind: 'always' },
    description: '列出插件、查看说明、调用插件工具（受插件权限约束）。',
    annotations: {},
    actions: act(pluginActions),
    inputSchema: schema(pluginActions, { pluginId: str(), tool: str(), args: obj() }),
    resultSchemaRefs: [SPEC('plugin:1')],
  },
  {
    name: 'order', group: 'E', load: { kind: 'level', min: 'L1' },
    description: '下单/改单/撤单/全撤/平仓。LLM 实盘开仓默认被策略拒绝。金额须先问用户；转述以返回为准。',
    annotations: { destructiveHint: true },
    actions: orderActions.map((name) => ({ name, minLevel: 'L1' as const, liveMinLevel: 'L3' as const })),
    inputSchema: schema(orderActions, { intent: intentItem('OrderIntent，仅 preview；详见 discover tool_help'), confirmToken: str('preview 返回，place 只收令牌'), orderId: str(), clientOrderId: str(), price: str(), size: str(), accountId: str(), instrumentId: str() }),
    resultSchemaRefs: [R('Order'), R('PrecheckResult')],
  },
  {
    name: 'workspace', group: 'W', load: { kind: 'toggle', setting: 'allowAgentLayout' },
    description: '调整工作台布局：增删块、排布、存取工作区、聚焦；钉住块不可动。',
    annotations: {},
    actions: act(workspaceActions),
    inputSchema: schema(workspaceActions, { instanceId: str(), block: str('id@version'), at: obj(), channel: str(), config: obj(), preset: str(), name: str(), symbol: str(), account: str() }),
    resultSchemaRefs: [SPEC('workspace:1')],
  },
] as const satisfies readonly McpToolDef[]

export type McpToolName = (typeof MCP_TOOLS)[number]['name']
export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name) as readonly McpToolName[]

/** §5.7 预算。 */
export const MCP_BUDGET = {
  /** 工具总数硬上限。 */
  maxTools: 24,
  toolCount: 17,
  /** 默认加载：L0 = 13；L1–L4 = 16；目标 ≤ 20。 */
  defaultLoadL0: 13,
  defaultLoadL1Plus: 16,
  defaultLoadTarget: 20,
  /** 单个工具定义（名称 + 描述 + 输入 schema）≤ 450 tokens。 */
  maxToolDefTokens: 450,
  /** 默认集合定义总量 ≤ 6,000 tokens；发布门禁用分词器实测。 */
  maxDefaultSetTokens: 6000,
  /** 描述：本施工单口径为中文 ≤ 60 字。 */
  maxDescriptionChars: 60,
  maxParamDescriptionChars: 100,
  maxSchemaNesting: 2,
  /** 单次结果默认 ≤ 2,000 tokens；列表默认 20 条 + next 游标。 */
  maxResultTokens: 2000,
  defaultListLimit: 20,
  /** SKILL.md 主文件 ≤ 1,500 tokens。 */
  maxSkillMdTokens: 1500,
} as const

const LEVEL_ORDER: Record<MandateLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 }
export const levelAtLeast = (level: MandateLevel, min: MandateLevel): boolean => LEVEL_ORDER[level] >= LEVEL_ORDER[min]

export interface McpLoadOptions {
  /** 人在界面打开"允许 Agent 调整布局"后才加载 workspace 工具。 */
  allowAgentLayout?: boolean
}

/** 给定授权书级别，MCP 服务器应加载的工具清单。 */
export function mcpToolsForLevel(level: MandateLevel, options: McpLoadOptions = {}): McpToolDef[] {
  return (MCP_TOOLS as readonly McpToolDef[]).filter((t) => {
    switch (t.load.kind) {
      case 'always': return true
      case 'level': return levelAtLeast(level, t.load.min)
      case 'toggle': return options.allowAgentLayout === true
    }
  })
}

export function getMcpTool(name: string): McpToolDef | undefined {
  return (MCP_TOOLS as readonly McpToolDef[]).find((t) => t.name === name)
}

/** 粗略 token 估算（发布门禁应换分词器实测）：CJK 字符按 1.5、其余按 0.3 计。 */
export function estimateTokens(text: string): number {
  let t = 0
  for (const ch of text) t += /[　-鿿＀-￯]/.test(ch) ? 1.5 : 0.3
  return Math.ceil(t)
}

/** 工具定义（名称 + 描述 + 输入 schema）的估算 token。 */
export function estimateToolDefTokens(t: McpToolDef): number {
  return estimateTokens(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

// ---- §7.4：74 → 17 映射 ------------------------------------------------------------------

/** 新工具 → 取代的 Demo 工具。 */
export const DEMO_TO_MCP_MAP: Record<string, readonly string[]> = {
  market: ['market_quote', 'market_book', 'market_candles', 'market_context', 'markets_list', 'instrument_info', 'network_status', 'pipeline_status'],
  account: ['account', 'positions', 'orders', 'accounts_list', 'venues_list', 'venue_account', 'wallet_status', 'wallet_hl_account'],
  risk_status: ['risk_get'],
  ledger: ['journal_stats', 'journal_entries', 'trace_get', 'activity_list', 'signals_list', 'decisions_list', 'decisions_metrics'],
  engines: ['strategies_list', 'strategy_stop', 'strategy_update'],
  propose: ['signal_propose', 'strategy_start'],
  proposals: ['proposals_list'],
  note: ['journal_note', 'lessons_list', 'lessons_add'],
  backtest: ['backtest'],
  plugins: ['store', 'vendors_list', 'opportunities_list'],
  order: ['order_place', 'order_cancel', 'position_close', 'order_preview'],
}
/** 新增（Demo 里没有）。 */
export const NEW_MCP_TOOLS = ['takeover', 'mandate', 'discover', 'experiment', 'workspace'] as const
/** 移到人面（不再是工具）。 */
export const DEMO_TOOLS_MOVED_TO_HUMAN: readonly string[] = [
  'risk_set_preset', 'risk_control', 'proposal_approve', 'proposal_reject', 'accounts_admin', 'sim_reset', 'venue_connect', 'venue_manage',
  'wallet_watch', 'wallet_agent', 'settings', 'lessons_admin', 'deck_set', 'deck_control', 'deck_start', 'orchestration_set', 'unit_toggle',
]
/** 概念取消而删除。 */
export const DEMO_TOOLS_REMOVED: readonly string[] = [
  'deck_get', 'orchestration_get', 'orchestration_load_preset', 'orchestration_runs', 'unit_run', 'research_get', 'research_generate', 'account_switch',
  // fix-r6 R3-05：workflow 工具在接线实现之前退出暴露，原先映射给它的 8 个 Demo 工具随之退出。
  'workflow_list', 'workflow_get', 'workflow_put', 'workflow_validate', 'workflow_backtest', 'workflow_run', 'workflow_stop', 'workflow_runtime',
]
