// SPDX-License-Identifier: CPAL-1.0
// 壳的夹具内核：在真内核（packages/kernel）就绪前，用假内核（SDK 的 testing 子路径）说壳要用的全部 [约定] 接口。
// 工作区落到临时目录的 *.json（模拟 ~/.gitrader/workspaces/），设置 / 钥匙 / PIN 放内存。绝不碰真密钥、真数据、真网络。
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import type { Workspace, WorkspaceMeta } from '@gitrader/blocks-sdk'
import { startFakeKernel, type FakeKernel, type FakeKernelOptions } from '@gitrader/blocks-sdk/testing'
import { presetWorkspace } from '../src/core/presets'
import type { KeyInfo, SettingsSnapshot } from '../src/core/host-api'

export interface FixtureKernel extends FakeKernel {
  workspacesDir: string
  settings: SettingsSnapshot
  state: { tradingState: 'ACTIVE' | 'REDUCING' | 'HALTED'; revision: number; current: Workspace }
  /**
   * 测试开关：attestFlatten = 全部平仓要求在场证明（真内核里接管不要求，这里用来在浏览器里走通 PIN 弹层）；
   * silentPlugin = 插件区多一个永远不握手的插件块（验「插件没有响应」）；badPlugin = 多一个清单不合格的插件块（验「N 个未加载」）。缺省都关。
   */
  flags: { attestFlatten: boolean; silentPlugin: boolean; badPlugin: boolean }
  /** 模拟 Agent 经 MCP 改了布局：写入并广播 workspace.changed。 */
  agentChangeLayout(ws: Workspace, agentKeyId?: string): void
}

/** 内核 Problem 形状的错误（extra 并进 data，例如 PIN 锁定的 retryAfterMs）。 */
export const problem = (name: string, code: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { code, data: { code, name, message, category: 'PROTOCOL', retryable: false, ...extra } })
/** 与内核 pin.ts 同一规则：6–12 位数字，或 8–64 位任意字符的口令。 */
const pinOk = (pin: string) => /^\d{6,12}$/.test(pin) || (pin.length >= 8 && pin.length <= 64)
/** 永远不握手的插件块（只在 flags.silentPlugin 时出现）：清单合格，入口模块什么都不做。 */
const SILENT_BLOCK = {
  pluginId: 'block.fixture.silent', moduleUrl: '/plugins/__silent/block.js',
  manifest: { schema: 'gitrader-block/1', id: 'block.fixture.silent', name: '无响应插件', version: '0.1.0', vendor: { name: 'fixture' }, license: 'Apache-2.0', entry: { module: './block.js', element: 'gr-fixture-silent' }, isolation: 'iframe', size: { minW: 5, minH: 3, defaultW: 6, defaultH: 4 }, permissions: [], linkGroups: [], fixtures: ['./fixtures/none.json'] },
}
const hashPin = (pin: string) => createHash('sha256').update('gr-fixture:' + pin).digest('hex')

const here = dirname(fileURLToPath(import.meta.url))
/** 插件示例目录：每个子目录是一个插件（gitrader-plugin.json + block.json + block.js）。可用 GITRADER_PLUGINS_DIR 覆盖。 */
export const DEFAULT_PLUGINS_DIR = process.env.GITRADER_PLUGINS_DIR ?? resolve(here, '../../plugin-template/example')

interface PluginBlock { pluginId: string; manifest: unknown; moduleUrl: string }

/** 读插件目录，生成 plugin.blocks 的返回（[约定]，TODO(protocol)）：{blocks:[{pluginId, manifest, moduleUrl}]}。 */
function pluginBlocks(dir: string): PluginBlock[] {
  if (!existsSync(dir)) return []
  const out: PluginBlock[] = []
  for (const name of readdirSync(dir)) {
    const pj = join(dir, name, 'gitrader-plugin.json')
    if (!existsSync(pj)) continue
    const plugin = JSON.parse(readFileSync(pj, 'utf8')) as { id: string; ui?: { blocks?: Array<{ manifest: string }> } }
    for (const b of plugin.ui?.blocks ?? []) {
      const manifest = JSON.parse(readFileSync(join(dir, name, b.manifest), 'utf8')) as { entry: { module: string } }
      out.push({ pluginId: plugin.id, manifest, moduleUrl: `/plugins/${name}/${manifest.entry.module.replace(/^\.\//, '')}` })
    }
  }
  return out
}

const MIME_PLUGIN: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }

export async function startFixtureKernel(opts: FakeKernelOptions & { workspacesDir: string; pluginsDir?: string }): Promise<FixtureKernel> {
  const pluginsDir = opts.pluginsDir ?? DEFAULT_PLUGINS_DIR
  const k = (await startFakeKernel({
    ...opts,
    // 插件文件：第三方块在 sandbox（无 allow-same-origin）里加载，源是 null，模块脚本要 CORS → 必须带 ACAO（真内核同样需要）。
    extraRoutes: async (req, res, url) => {
      if (url.pathname === SILENT_BLOCK.moduleUrl) { res.writeHead(200, { 'content-type': MIME_PLUGIN['.js']!, 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end('// 故意不握手\n'); return true }
      const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url.pathname)
      if (!m) return opts.extraRoutes ? opts.extraRoutes(req, res, url) : false
      const root = resolve(pluginsDir, decodeURIComponent(m[1]!))
      const file = normalize(join(root, decodeURIComponent(m[2]!)))
      if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return true }
      res.writeHead(200, { 'content-type': MIME_PLUGIN[extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
      res.end(readFileSync(file))
      return true
    },
  })) as FixtureKernel
  mkdirSync(opts.workspacesDir, { recursive: true })
  k.workspacesDir = opts.workspacesDir
  const file = (name: string) => join(opts.workspacesDir, `${name.replace(/[^\w一-龥-]+/g, '_')}.json`)
  let pinHash: string | null = null
  let humanSaved: Workspace = { ...presetWorkspace('trade'), id: 'ws_default', name: '交易' }
  const state = { tradingState: 'ACTIVE' as 'ACTIVE' | 'REDUCING' | 'HALTED', revision: 1, current: structuredClone(humanSaved) }
  k.state = state
  k.settings = { network: 'testnet', pinSet: false, agentLayout: false, keys: [] }
  k.flags = { attestFlatten: false, silentPlugin: false, badPlugin: false }

  k.onQuery('plugin.blocks', () => ({
    blocks: [
      ...pluginBlocks(pluginsDir),
      ...(k.flags.silentPlugin ? [SILENT_BLOCK] : []),
      ...(k.flags.badPlugin ? [{ pluginId: 'block.fixture.bad', moduleUrl: '/plugins/__bad/block.js', manifest: { id: 'block.fixture.bad', name: '坏清单' } }] : []),
    ],
  }))
  // 插件示例的历史 K 线：取它自带夹具里的 queries
  const candleFx = join(pluginsDir, 'ema-reading/fixtures/candles.json')
  if (existsSync(candleFx)) { const fx = JSON.parse(readFileSync(candleFx, 'utf8')) as { queries?: Record<string, unknown> }; if (fx.queries?.['market.candles']) k.onQuery('market.candles', () => fx.queries!['market.candles']) }
  // 待批提案：两张卡（带规则命中、较长的理由），用来验「批准」按钮在任何视口高度下都在块内可视区
  const pend = (n: number) => ({
    proposalId: `prop_fx${n}`, ticket: `T-20261010-000${n}`, status: 'pending', kind: 'order', expiresAt: Date.now() + 9 * 60_000, reason: '突破前高后回踩确认，按计划分两笔建仓，止损放在回踩低点下方，预计持有一到两天。',
    origin: { actor: 'agent:ak_fixture', actorType: 'llm-agent', tool: 'propose', requestId: `r${n}`, via: 'mcp' },
    intents: [{ side: 'buy', size: '0.5', price: '65000', instrumentId: 'hyperliquid:BTC', type: 'limit' }],
    precheck: { verdict: 'review', estimates: { liquidationPrice: '41200', slippageBps: '3', marginRequired: '3250', notional: '32500' }, ruleHits: [{ ruleId: 'mdt_1#autoMaxOrderNotional', code: 'NEEDS_APPROVAL', limit: '10000', actual: '32500', unit: 'USDC', action: 'review', scope: 'mandate' }] },
  })
  k.onQuery('proposal.list', () => ({ proposals: [pend(1), pend(2)] }))
  k.onQuery('workspace.current', () => ({ workspace: state.current, revision: state.revision }))
  k.onQuery('workspace.list', () => {
    const files = readdirSync(opts.workspacesDir).filter((f) => f.endsWith('.json'))
    const workspaces: WorkspaceMeta[] = files.map((f) => {
      const ws = JSON.parse(readFileSync(join(opts.workspacesDir, f), 'utf8')) as Workspace
      return { id: ws.id, name: ws.name, ...(ws.savedBy ? { savedBy: ws.savedBy } : {}) }
    })
    return { workspaces }
  })
  k.onCommand('workspace.update', (p) => {
    const ws = (p as { workspace: Workspace }).workspace
    state.current = ws
    state.revision += 1
    return { workspace: ws, revision: state.revision }
  })
  k.onCommand('workspace.save', (p) => {
    const { name, workspace } = p as { name: string; workspace: Workspace }
    const ws = { ...workspace, name }
    writeFileSync(file(name), JSON.stringify(ws, null, 2))
    humanSaved = structuredClone(ws)
    return { meta: { id: ws.id, name, ...(ws.savedBy ? { savedBy: ws.savedBy } : {}) } }
  })
  k.onCommand('workspace.load', (p) => {
    const { name } = p as { name: string }
    if (!existsSync(file(name))) throw problem('NOT_FOUND', 1010, `没有名为「${name}」的工作区`)
    const ws = JSON.parse(readFileSync(file(name), 'utf8')) as Workspace
    state.current = ws
    state.revision += 1
    return { workspace: ws }
  })
  k.onCommand('workspace.revert', () => {
    state.current = structuredClone(humanSaved)
    state.revision += 1
    return { workspace: state.current, revision: state.revision }
  })

  k.onQuery('settings.get', () => k.settings)
  // 与真内核一致：没有主网钥匙不许切主网；只改配置并回 restartRequired（重启后才真正换网）
  k.onCommand('settings.network.set', (p) => {
    const n = (p as { network: 'mainnet' | 'testnet' }).network
    if (n === 'mainnet' && !k.settings.keys.some((x) => x.network === 'mainnet')) throw problem('VENUE_AUTH', 4001, 'mainnet stays off until an active mainnet API wallet is imported or generated')
    k.settings.network = n
    return { network: n, restartRequired: true }
  })
  k.onCommand('settings.agent_layout.set', (p) => { k.settings.agentLayout = !!(p as { enabled: boolean }).enabled; return { ok: true } })
  k.onCommand('pin.set', (p, ctx) => {
    const { pin } = p as { pin: string }
    // 与真内核 pin.ts / ops.ts 同口径：格式错 INVALID_PARAMS；修改时当前 PIN 缺 → ATTESTATION_REQUIRED、错 → AUTH_FAILED；短数字 PIN 回 hint（只提示不阻止）
    if (!pinOk(pin)) throw problem('INVALID_PARAMS', -32602, 'PIN must be 6-12 digits, or a passphrase of 8-64 characters')
    const changed = pinHash !== null
    if (pinHash) {
      const att = ctx.attestation as { method?: string; pin?: string } | undefined
      if (!att || att.method !== 'pin') throw problem('ATTESTATION_REQUIRED', 2010, 'changing the PIN requires the current PIN')
      if (hashPin(att.pin ?? '') !== pinHash) throw problem('AUTH_FAILED', 5003, 'invalid PIN')
    }
    pinHash = hashPin(pin)
    k.settings.pinSet = true
    const hint = /^[0-9]+$/.test(pin) && pin.length < 10 ? 'A longer PIN is safer: use 10+ digits or a passphrase of 8-64 characters.' : undefined
    return { ok: true, changed, ...(hint ? { hint } : {}) }
  })
  const mkKey = (label: string, network: 'mainnet' | 'testnet'): KeyInfo => ({
    id: `key_${randomBytes(4).toString('hex')}`, label, address: '0x' + randomBytes(20).toString('hex'), venue: 'hyperliquid', network, createdAt: Date.now(), expiresAt: Date.now() + 180 * 86400_000,
  })
  k.onCommand('credential.import', (p) => {
    const { secret, label, network } = p as { secret: string; label: string; network: 'mainnet' | 'testnet' }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(secret)) throw problem('INVALID_PARAMS', -32602, '私钥格式不对：需要 64 位十六进制')
    const key = mkKey(label, network)
    k.settings.keys.push(key)
    return { key }
  })
  k.onCommand('credential.generate', (p) => {
    const { label, network } = p as { label: string; network: 'mainnet' | 'testnet' }
    const key = mkKey(label, network)
    k.settings.keys.push(key)
    return { key }
  })
  k.onCommand('credential.revoke', (p) => { const id = (p as { id: string }).id; k.settings.keys = k.settings.keys.filter((x) => x.id !== id); return { ok: true } })

  for (const level of ['halt_new', 'cancel_all', 'flatten_all'] as const) {
    k.onCommand(`takeover.${level}`, (_p, ctx) => {
      if (level === 'flatten_all' && k.flags.attestFlatten) {
        const att = ctx.attestation as { method?: string; pin?: string } | undefined
        if (!att) throw problem('ATTESTATION_REQUIRED', 2010, '需要在场证明')
        if (!pinHash || att.method !== 'pin' || hashPin(att.pin ?? '') !== pinHash) throw problem('AUTH_FAILED', 5003, 'PIN 不对')
      }
      state.tradingState = level === 'flatten_all' ? 'HALTED' : 'REDUCING'; k.publish('risk.state', { state: state.tradingState }); return { ok: true, state: state.tradingState }
    })
  }
  k.onCommand('trading_state.resume', (_p, ctx) => {
    const att = ctx.attestation as { method?: string; pin?: string } | undefined
    if (!att) throw problem('ATTESTATION_REQUIRED', 2010, '恢复交易需要在场证明')
    if (!pinHash || att.method !== 'pin' || hashPin(att.pin ?? '') !== pinHash) throw problem('AUTH_FAILED', 5003, 'PIN 不对')
    state.tradingState = 'ACTIVE'
    k.publish('risk.state', { state: 'ACTIVE' })
    return { ok: true, state: 'ACTIVE' }
  })
  k.onQuery('instruments.search', (p) => {
    const q = String((p as { q?: string })?.q ?? '').toLowerCase()
    const all = [['BTC', '比特币'], ['ETH', '以太坊'], ['SOL', 'Solana'], ['HYPE', 'Hyperliquid'], ['xyz:TSLA', '特斯拉']] as const
    return { hits: all.filter(([s, n]) => `${s} ${n}`.toLowerCase().includes(q)).map(([s, n]) => ({ id: `hyperliquid:${s}`, name: n })) }
  })

  k.agentChangeLayout = (ws, agentKeyId = 'ak_fixture') => {
    state.current = ws
    state.revision += 1
    k.publish('workspace.changed', { workspace: ws, by: `agent:${agentKeyId}`, revision: state.revision, reason: '调整了布局' })
  }
  return k
}
