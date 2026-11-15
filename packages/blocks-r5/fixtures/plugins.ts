// SPDX-License-Identifier: CPAL-1.0
// 插件页夹具：plugin.list 的回包（形状同 kernel/src/ops.ts:256，但**没有 dir**——K-r5-0，本机路径不进夹具）。
// normal = 内核补上 K-r5-3 之后的形状（source / audit / health / net.hosts / secrets / files 齐）；
// unwired = 今天内核的真实形状（这几项都没有）；数据取自 reports/visual-r5/plugins/index.html 的 13 项。
// fail = 该查询由测试注入内核错误（stage-entry 只认 queries / commands）。
type Rec = Record<string, unknown>

const base = (id: string, name: string, kind: string | undefined, version: string, extra: Rec = {}): Rec => ({
  id, name, kind, version, ok: true, issues: [], problems: [], signed: true, trusted: true,
  granted: [], pending: [], enabled: true, tools: [], state: 'ready', blocks: [], permissions: [], ...extra,
})

const check = (id: string, ok = true, severity = 'fail', detail = ''): Rec => ({ id, ok, severity, detail })
const PASS: Rec[] = [
  check('manifest-schema'), check('permissions-known'), check('secrets-declared'), check('tools-names'),
  check('spdx-field'), check('readme-first-line'), check('tests-present'),
]
const audit = (...extra: Rec[]): Rec => ({ ok: extra.every((c) => c.ok === true || c.severity === 'warn'), findings: [...PASS, ...extra] })

/** 今天的内核回包里没有这些字段（K-r5-3 与清单里的权限明细）。 */
const MISSING_TODAY = ['source', 'audit', 'health', 'net', 'secrets', 'files']

const LIVE = ['venue.credentials', 'net.fetch', 'trade.live', 'trade.paper']
const NORMAL: Rec[] = [
  base('connector.gitrader.hyperliquid', 'Hyperliquid', 'connector', '0.1.0', {
    permissions: LIVE, granted: LIVE, source: 'official', net: { hosts: ['api.hyperliquid.xyz', 'api.hyperliquid-testnet.xyz'] },
    secrets: ['HL_AGENT_KEY'], files: [], health: { latencyMs: 42 }, audit: audit(),
  }),
  base('connector.gitrader.binance-trade', 'Binance', 'connector', '0.1.0', {
    permissions: LIVE, granted: LIVE, source: 'official', net: { hosts: ['fapi.binance.com', 'demo-fapi.binance.com', 'fstream.binance.com'] },
    secrets: ['BN_API_KEY', 'BN_API_SECRET'], files: [], health: { latencyMs: 118 }, audit: audit(),
  }),
  base('connector.tradekit.bybit', 'Bybit', 'connector', '0.3.1', {
    permissions: LIVE, pending: LIVE, enabled: false, state: 'stopped', source: 'community',
    net: { hosts: ['api.bybit.com', 'api-testnet.bybit.com', 'stream-testnet.bybit.com'] },
    secrets: ['BYBIT_API_KEY', 'BYBIT_API_SECRET'], files: [], health: {},
    audit: audit(check('secrets-unused', false, 'warn', 'BYBIT_API_SECRET 已声明，源码里找不到引用')),
  }),
  base('connector.gitrader.binance-data', 'Binance', 'connector', '0.1.0', {
    permissions: ['net.fetch', 'market.read'], granted: ['net.fetch', 'market.read'], source: 'official',
    net: { hosts: ['fapi.binance.com'] }, secrets: [], files: [], health: { latencyMs: 64 }, audit: audit(),
  }),
  base('datasource.gitrader.alphavantage', 'Alpha Vantage', 'datasource', '0.1.0', {
    permissions: ['net.fetch', 'market.read'], granted: ['net.fetch', 'market.read'], state: 'degraded', source: 'official',
    net: { hosts: ['www.alphavantage.co'] }, secrets: ['ALPHAVANTAGE_API_KEY'], files: [], health: { detail: 'HTTP 429' }, audit: audit(),
  }),
  base('engine.gitrader.core', 'engine-core', 'engine', '0.1.0', {
    permissions: ['fs.read.user', 'trade.paper'], granted: ['fs.read.user', 'trade.paper'], source: 'official',
    net: { hosts: [] }, secrets: [], files: ['~/Gitrader/strategies'], health: { detail: '策略 2' }, audit: audit(),
  }),
  // 校验没过的包：内核回包没有 kind / name / permissions（清单读不出来），id 前缀是唯一线索
  base('engine.local.py-lab', '', undefined, '0.0.3', {
    ok: false, issues: ['[SCHEMA] entry.command: required for runtime sidecar'], enabled: false, state: 'installed', signed: false, trusted: false,
    source: 'local', net: { hosts: [] }, secrets: [], files: ['~/quant/strategies'], health: {},
  }),
  base('connector.gitrader.notify-telegram', 'Telegram', 'connector', '0.1.0', {
    permissions: ['net.fetch'], granted: ['net.fetch'], tools: [{ name: 'notify_send', desc: '', tags: [], input: {} }], source: 'official',
    net: { hosts: ['api.telegram.org'] }, secrets: ['TG_BOT_TOKEN'], files: [], health: { detail: '送达 21:10' }, audit: audit(),
  }),
  base('connector.gitrader.notify-email', '邮件', 'connector', '0.1.0', {
    permissions: ['net.fetch'], pending: ['net.fetch'], enabled: false, state: 'installed', tools: [{ name: 'notify_send', desc: '', tags: [], input: {} }],
    source: 'official', net: { hosts: [] }, secrets: ['SMTP_PASSWORD'], files: [], health: { detail: '未配置' }, audit: audit(),
  }),
  base('block.gitrader.default', '默认块', 'block', '0.1.0', {
    permissions: ['ui.block'], granted: ['ui.block'], blocks: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `b${n}` })), source: 'official',
    net: { hosts: [] }, secrets: [], files: [], health: { detail: '块 6' }, audit: audit(),
  }),
  base('block.fundlab.funding-heat', '资金费热力', 'block', '0.2.0', {
    permissions: ['ui.block', 'market.read'], granted: ['ui.block', 'market.read'], blocks: [{ id: 'b1' }], source: 'community',
    net: { hosts: [] }, secrets: [], files: [], health: { detail: '块 1' }, audit: audit(),
  }),
  base('skill.gitrader.report', '报告', 'skill', '0.1.0', {
    permissions: ['fs.read.user', 'ledger.read'], granted: ['fs.read.user', 'ledger.read'], source: 'official',
    net: { hosts: [] }, secrets: [], files: ['~/Gitrader/reports'], health: {}, audit: audit(),
  }),
  base('skill.gitrader.symbol-search', '标的搜索', 'skill', '0.1.0', {
    permissions: ['market.read'], granted: ['market.read'], source: 'official',
    net: { hosts: [] }, secrets: [], files: [], health: {}, audit: audit(),
  }),
]

const UNWIRED: Rec[] = NORMAL.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !MISSING_TODAY.includes(k))))

const VENUES = [
  { venue: 'hyperliquid', connection: 'connected', unverified: false },
  { venue: 'binance', connection: 'connected', unverified: true },
  { venue: 'bybit', connection: 'disconnected', unverified: true },
]
const COMMANDS = { 'plugin.grant': { ok: true }, 'plugin.start': { ok: true }, 'plugin.stop': { ok: true }, 'plugin.reload': { added: [], removed: [], changed: [] } }

export const pluginsFixtures = {
  normal: { queries: { 'plugin.list': NORMAL, 'venue.status': VENUES }, commands: COMMANDS },
  empty: { queries: { 'plugin.list': [], 'venue.status': [] }, commands: COMMANDS },
  loading: { queries: { 'plugin.list': NORMAL, 'venue.status': VENUES }, commands: COMMANDS },
  error: { queries: { 'venue.status': [] }, fail: { 'plugin.list': { code: -32603, message: 'plugin host is not ready: scan failed', name: 'INTERNAL' } } },
  offline: { queries: { 'plugin.list': NORMAL, 'venue.status': VENUES }, commands: COMMANDS },
  unwired: { queries: { 'plugin.list': UNWIRED, 'venue.status': VENUES }, commands: COMMANDS },
}
