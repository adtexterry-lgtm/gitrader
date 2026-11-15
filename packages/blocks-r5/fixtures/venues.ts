// SPDX-License-Identifier: CPAL-1.0
// 设置 · 交易所 / 通知两页共用的 config.view 夹具（数据取自设计稿 settings-venues / settings-notify）。密钥只有句柄名；没有任何真值、地址或邮箱。
import { asDecimal, type ConfigView } from '@gitrader/protocol'

const plugin = (name: string) => `connector.gitrader.notify-${name}`
const hdl = (id: string, key: string, handle: string, resolved: boolean) => ({ path: `plugins.secrets.${plugin(id)}.${key}`, handle, resolved })

export const settingsConfig = {
  venues: [
    { id: 'hyperliquid', environment: 'testnet', enabled: true },
    { id: 'binance', environment: 'testnet', enabled: true },
    { id: 'bybit', environment: 'testnet', enabled: false },
  ],
  accounts: [
    { accountId: 'acct_hl_main', alias: 'hl-main', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'hl-api' },
    { accountId: 'acct_paper_1', alias: 'paper-1', venue: 'hyperliquid', environment: 'testnet', mode: 'paper', paper: { initialBalance: asDecimal('10000'), ccy: 'USDC' } },
    { accountId: 'acct_bn_main', alias: 'bn-main', venue: 'binance', environment: 'testnet', mode: 'live', credentials: { apiKey: 'env:BINANCE_TESTNET_API_KEY', apiSecret: 'env:BINANCE_TESTNET_API_SECRET' } },
    { accountId: 'acct_bn_paper', alias: 'bn-paper', venue: 'binance', environment: 'testnet', mode: 'paper', paper: { initialBalance: asDecimal('10000'), ccy: 'USDT' } },
  ],
  notify: {
    channels: [
      { id: 'tg-main', plugin: plugin('telegram'), minLevel: 'warn', params: { chatId: 'ops-desk' } },
      { id: 'mail', plugin: plugin('email'), minLevel: 'critical', params: { host: 'smtp.example.org', port: 465, user: 'alerts', to: 'ops-desk' } },
      { id: 'hook-ops', plugin: plugin('webhook'), minLevel: 'info', params: {} },
      { id: 'dc-desk', plugin: plugin('discord'), minLevel: 'warn', params: {} },
      { id: 'slack-ops', plugin: plugin('slack'), minLevel: 'warn', params: {} },
      { id: 'wecom-ops', plugin: plugin('wecom'), minLevel: 'critical', params: {} },
    ],
    rules: [
      { match: 'takeover.*', level: 'critical', channels: ['tg-main', 'mail', 'wecom-ops'] },
      { match: 'protector.triggered', level: 'critical', channels: ['tg-main', 'mail'] },
      { match: 'risk.denied', level: 'warn', channels: ['tg-main', 'slack-ops'] },
      { match: 'proposal.failed', level: 'warn', channels: ['slack-ops'] },
      { match: 'engine.health', level: 'info', channels: ['hook-ops'] },
    ],
    rateLimit: { perChannelPerMinute: 20, dedupeWindowSec: 300 },
  },
  handles: [
    { path: 'accounts[2].credentials.apiKey', handle: 'env:BINANCE_TESTNET_API_KEY', resolved: true },
    { path: 'accounts[2].credentials.apiSecret', handle: 'env:BINANCE_TESTNET_API_SECRET', resolved: false },
    hdl('telegram', 'token', 'env:TG_BOT_TOKEN', true),
    hdl('email', 'password', 'env:SMTP_PASS', false),
    hdl('webhook', 'token', 'env:HOOK_TOKEN', true),
    hdl('discord', 'webhook', 'env:DISCORD_WEBHOOK', true),
    hdl('slack', 'token', 'env:SLACK_BOT_TOKEN', true),
    hdl('wecom', 'key', 'env:WECOM_KEY', false),
  ],
  catalog: [
    { venue: 'hyperliquid', kind: 'trading', verified: true, credentials: [] },
    { venue: 'binance', kind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret'] },
    { venue: 'bybit', kind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret'] },
    { venue: 'okx', kind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret', 'passphrase'] },
    { venue: 'bitget', kind: 'trading', verified: false, credentials: ['apiKey', 'apiSecret', 'passphrase'] },
    { venue: 'coinbase', kind: 'data', verified: false, credentials: [] },
  ],
} as unknown as ConfigView

export const emptySettingsConfig = { venues: [], accounts: [], notify: { channels: [] }, handles: [], catalog: [] } as unknown as ConfigView

export const venueStatusRows = [
  { venue: 'hyperliquid', wsState: 'connected', connection: 'connected', environment: 'testnet', latencyMs: { p50: 42, p95: 88 } },
  { venue: 'binance', wsState: 'disconnected', connection: 'disconnected', environment: 'testnet', connectionDetail: 'ECONNRESET venue endpoint:443', unverified: true },
]

export const notifyPlugins = ['telegram', 'email', 'webhook', 'discord', 'slack', 'wecom'].map((name) => ({ id: plugin(name), name, state: 'running' }))

const normal = {
  queries: { 'config.view': settingsConfig, 'venue.status': venueStatusRows, 'plugin.list': notifyPlugins },
  commands: { 'config.venues.set': { config: settingsConfig, restartRequired: true }, 'config.notify.set': { notify: settingsConfig.notify, restartRequired: true } },
}
// 状态由 stage-entry 的 viewScenario 决定：error = config.view 回 ok:false；unwired = 方法不存在；offline = 页面上挂 html[data-offline]（测试里设），数据同 normal。
export const venuesFixtures = {
  normal,
  empty: { queries: { 'config.view': emptySettingsConfig, 'venue.status': [], 'plugin.list': [] } },
  loading: normal,
  error: {},
  offline: normal,
  unwired: {},
}
