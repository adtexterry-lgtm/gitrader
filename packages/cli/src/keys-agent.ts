// SPDX-License-Identifier: CPAL-1.0
// `gitrader keys new agent`：智能默认值、令牌文件、浏览器批准流与终端 PIN 流。
//
// 顺序很重要：先把名字 / 宿主 / 档位 / 标的 / 限额全部整理并校验完，再要 PIN 或向服务发创建请求。
// 浏览器批准流只在非交互终端（或显式 --approve-in-browser）且本地服务在跑时启用；令牌只落盘，不打印。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_PERMISSION_TIER_LABELS, DEFAULT_LEVEL_OF_TIER, MANDATE_DEFAULTS } from '@gitrader/protocol'
import type { AgentPermissionTier } from '@gitrader/protocol'
import { loadConfig, mkOrigin } from '@gitrader/kernel'
import type { Kernel } from '@gitrader/kernel'
import { HOSTS, callOp, serviceOp, flag, liveService, needPin, openKernel } from './index'
import type { Args, CliIo, ServiceInfo } from './index'
import { checkMandateInput, mandateGaps, normalizeInstrumentAllowlist } from '../../kernel/src/agents'
import { writeTokenFile } from '../../kernel/src/token-file'
import { writeSecretFile } from '../../kernel/src/util/fsperm'
import { snippetFor } from './snippets'
import { fmtLocal } from './lang'

const DAY = 86_400_000
const TIERS = ['read_only', 'paper', 'confirm', 'auto_limited'] as const
const DEFAULT_VENUE = 'hyperliquid'
const STARTER_VENUES = ['hyperliquid']
const STARTER_INSTRUMENTS = ['BTC', 'ETH']
const STARTER_DAYS = 30
const DEFAULT_MAX_ORDER = 200
const DEFAULT_MAX_DAILY = 1000
const DEFAULT_MAX_DAILY_LOSS = 100
const DEFAULT_AUTO_MAX = 50
const APPROVAL_TIMEOUT_MS = 10 * 60_000 + 30_000
const POLL_MS = 2_000

const USAGE = `usage: gitrader keys new agent <名字> --host <claude-code|codex|hermes|unigit> [--tier <read_only|paper|confirm|auto_limited>]
                              [--preset starter] [--token-file [路径]] [--inline-token]
                              [--venues v] [--instruments i,j] [--max-order N] [--max-daily N] [--max-daily-loss N] [--auto-max N] [--heartbeat-timeout SEC] [--days N] [--accounts a,b]
`

const TIER_ZH: Record<AgentPermissionTier, string> = {
  read_only: '只读 + 研究（AI 能看、能写笔记 / 建实验 / 提回测，不能下单）',
  paper: '纸面（纸面单直接成交，不经你批准）',
  confirm: '需确认（每笔开仓等你批准）',
  auto_limited: '限额自动（额度内自动，超出仍等你批准）',
}

type LineReader = CliIo & { readLine?: (prompt: string) => Promise<string> }

export interface KeysAgentDeps {
  liveService(home: string): Promise<ServiceInfo | null>
  callOp(service: ServiceInfo, name: string, params?: Record<string, unknown>): Promise<unknown>
  openKernel(home: string, io: CliIo): Promise<Kernel>
  needPin(kernel: Kernel, io: CliIo): Promise<Awaited<ReturnType<Kernel['auth']['pinProofLocalTerminal']>>>
  writeTokenFile(home: string, name: string, token: string, onLoose?: (path: string) => void): string
  /** 返回 false = 文件写了但权限没收紧成功（调用方必须告警）。 */
  writeTokenAt(path: string, token: string): boolean | void
  /** 撤回还没处理的接入请求，避免工作台留下重复待批卡。内核没有 service 令牌可用的取消 op，只能借已登录的会话调 agentkey.request.reject；做不到返回 false。 */
  cancelRequest(home: string, service: ServiceInfo, requestId: string): Promise<boolean>
  now(): number
  sleep(ms: number): Promise<void>
}

const defaultDeps = (): KeysAgentDeps => ({
  liveService: (home) => liveService(home),
  callOp: (service, name, params) => serviceOp(service, name, params ?? {}),
  openKernel: (home, io) => openKernel(home, io),
  needPin: (kernel, io) => needPin(kernel, io),
  writeTokenFile: (home, name, token, onLoose) => writeTokenFile(home, name, token, onLoose),
  writeTokenAt: (path, token) => writeSecretFile(path, `${token}\n`),
  cancelRequest: async (home, service, requestId) => {
    try {
      await callOp(home, { ...service, baseUrl: `http://127.0.0.1:${service.port}` }, 'agentkey.request.reject', 'write', { requestId, note: '命令行已取消' })
      return true
    } catch { return false }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
})

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined)
const csv = (a: Args, key: string): string[] | undefined => {
  const raw = flag(a, key)
  return raw === undefined ? undefined : raw.split(',').map((x) => x.trim()).filter(Boolean)
}
const finiteNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
const lowerCap = (base: number, cap: unknown): number => {
  const n = finiteNumber(cap)
  return n !== undefined && n > 0 ? Math.min(base, n) : base
}

interface AccountRow { accountId?: unknown; alias?: unknown; mode?: unknown }

/** 账户：显式 --accounts 原样使用；否则从服务或本地配置取账户 ID（拿不到时退化到 paper 别名）。 */
async function resolveAccounts(home: string, svc: ServiceInfo | null, explicit: string[] | undefined, d: KeysAgentDeps): Promise<{ ids: string[]; labels: string[] }> {
  let rows: AccountRow[] = []
  if (svc) {
    try {
      const v = await d.callOp(svc, 'account.list')
      if (Array.isArray(v)) rows = v as AccountRow[]
    } catch { /* 服务查询失败就退回本地配置 */ }
  }
  if (rows.length === 0) {
    try { rows = loadConfig(home).accounts as AccountRow[] } catch { /* 还没 init 时没有账户可用 */ }
  }
  const usable = rows.filter((r) => typeof r.accountId === 'string' || typeof r.alias === 'string')
  const mapOne = (raw: string): { id: string; label: string } => {
    const hit = usable.find((r) => r.accountId === raw || r.alias === raw)
    return { id: typeof hit?.accountId === 'string' ? hit.accountId : raw, label: typeof hit?.alias === 'string' ? hit.alias : raw }
  }
  if (explicit && explicit.length) {
    const mapped = explicit.map(mapOne)
    return { ids: mapped.map((x) => x.id), labels: mapped.map((x) => x.label) }
  }
  if (usable.length === 0) return { ids: ['paper'], labels: ['paper'] }
  const mapped = usable.map((r) => mapOne(typeof r.accountId === 'string' ? r.accountId : String(r.alias)))
  return { ids: mapped.map((x) => x.id), labels: mapped.map((x) => x.label) }
}

/** 非 TTY：解释两档区别，并给出两条完整命令。 */
function explainTiers(io: CliIo, name: string, host: string): void {
  io.err([
    '还没选档位：AI 的单要不要等你批准？',
    `  --tier confirm  需确认：AI 每笔开仓都等你批准（推荐）`,
    `  --tier paper    纸面：纸面单直接成交，不经你批准`,
    '两条完整命令示例：',
    `  gitrader keys new agent ${name} --host ${host} --tier confirm --token-file`,
    `  gitrader keys new agent ${name} --host ${host} --preset starter`,
    '',
  ].join('\n'))
}

/** TTY：用大白话问一句，1 → confirm，2 → paper。 */
async function askTier(io: CliIo): Promise<AgentPermissionTier | null> {
  const prompt = 'AI 的单要等你批准吗？ 1) 要，每笔开仓等我批（推荐）  2) 不用，纸面里直接成交\n> '
  const reader = (io as LineReader).readLine
  const answer = (reader ? await reader(prompt) : await io.readSecret(prompt)).trim()
  if (answer === '1') return 'confirm'
  if (answer === '2') return 'paper'
  return null
}

interface Prepared {
  name: string
  host: string
  tier: AgentPermissionTier
  accounts: string[]
  accountLabels: string[],
  venues: string[]
  instruments: string[]
  limits: { maxOrderNotional?: string; maxDailyNotional?: string; maxDailyLoss?: string; autoMaxOrderNotional?: string }
  days: number | undefined
  tokenFileMode: boolean
  tokenFileTarget: string | undefined
}

/** 成功摘要：名字 / 档位大白话 / 账户 / 标的 / 单笔与日额 / 到期日 / 令牌文件 / 下一步。 */
/** 令牌文件写了但权限没收紧（R2-REL-04）：不许静默，点名文件和办法。 */
function warnLoose(io: CliIo, path: string | undefined): void {
  if (path) io.err(`警告：没能把令牌文件的权限收紧到只有当前用户可读：${path}。同机其他用户可能读到它；把文件放到更短的目录（或缩短 GITRADER_HOME）后重新生成，并考虑撤销这把钥匙。\n`)
}

function printSuccess(io: CliIo, p: Prepared, tokenPath: string, notAfter: number): void {
  const order = p.limits.maxOrderNotional ?? '不限'
  const daily = p.limits.maxDailyNotional ?? '不限'
  const dailyLoss = p.limits.maxDailyLoss ?? '不限'
  const autoMax = p.limits.autoMaxOrderNotional ?? '不限'
  const limitsLine = p.tier === 'auto_limited' 
    ? `  单笔上限：${order} · 每日上限：${daily} · 每日亏损上限：${dailyLoss} · 自动执行上限：${autoMax}`
    : `  单笔上限：${order} · 每日上限：${daily}`
  io.out([
    `已创建 Agent 钥匙「${p.name}」`,
    `  档位：${TIER_ZH[p.tier]}`,
    `  账户：${p.accountLabels.join('、') || '默认账户'}`,
    `  标的：${p.instruments.join('、') || '未限定'}`,
    limitsLine,
    `  到期日：${fmtLocal(notAfter)}`,
    `令牌已写入：${tokenPath}（只有你本机能读）`,
    `下一步：gitrader mcp snippet ${p.host} --token-file ${tokenPath}`,
    '',
  ].join('\n'))
  if (p.tier === 'paper') io.out('注意：纸面档下 AI 的纸面单直接成交、不经你批准；要逐单批准请用 --tier confirm\n')
}

async function waitForApproval(home: string, svc: ServiceInfo, requestId: string, d: KeysAgentDeps, interrupted: () => boolean): Promise<Record<string, unknown>> {
  const deadline = d.now() + APPROVAL_TIMEOUT_MS
  while (true) {
    if (interrupted()) return { state: 'interrupted' }
    const view = asRecord(await d.callOp(svc, 'agentkey.request.status', { requestId }))
    if (!view) throw new Error('接入请求状态读不出来')
    const state = typeof view.state === 'string' ? view.state : 'pending'
    if (state !== 'pending') return view
    if (d.now() >= deadline) throw new Error(`接入请求在 10 分钟内没有处理（${home}）`)
    await d.sleep(POLL_MS)
  }
}

async function withdraw(io: CliIo, home: string, svc: ServiceInfo, requestId: string, d: KeysAgentDeps): Promise<void> {
  if (!(await d.cancelRequest(home, svc, requestId))) io.err('没能撤回这条接入请求（没有登录会话）；它会在工作台里停留到过期，可在工作台点「拒绝」\n')
}

export async function cmdKeysNewAgent(home: string, a: Args, io: CliIo, overrides: Partial<KeysAgentDeps> = {}): Promise<number> {
  const d: KeysAgentDeps = { ...defaultDeps(), ...overrides }

  // ---- 1. 参数整理（全部在要 PIN / 发请求之前） ------------------------------------
  const name = typeof a.cmd[3] === 'string' ? a.cmd[3].trim() : ''
  const host = flag(a, 'host')?.trim()
  if (!name || !host) {
    io.err(USAGE)
    return 2
  }
  if (!(HOSTS as readonly string[]).includes(host)) {
    io.err(`--host 只支持 ${HOSTS.join(' / ')}（收到：${host}）\n`)
    return 2
  }

  const preset = flag(a, 'preset')
  if (preset !== undefined && preset !== 'starter') {
    io.err('--preset 目前只支持 starter\n')
    return 2
  }
  const starter = preset === 'starter'

  const explicitTier = flag(a, 'tier')
  if (explicitTier !== undefined && !(TIERS as readonly string[]).includes(explicitTier)) {
    io.err(`--tier 只支持 ${TIERS.join(' / ')}（收到：${explicitTier}）\n`)
    return 2
  }

  let tier: AgentPermissionTier
  if (explicitTier !== undefined) tier = explicitTier as AgentPermissionTier
  else if (starter) tier = 'confirm'
  else if (io.interactive) {
    const picked = await askTier(io)
    if (!picked) { explainTiers(io, name, host); return 2 }
    tier = picked
  } else {
    explainTiers(io, name, host)
    return 2
  }

  const svc = await d.liveService(home)

  // 全局风控上限只用于 starter 的缺省值；服务没在跑就直接用 200 / 1000。
  let globalOrder: number | undefined
  let globalDaily: number | undefined
  if (starter && svc) {
    try {
      const st = asRecord(await d.callOp(svc, 'risk.state'))
      const limits = asRecord(st?.limits)
      globalOrder = finiteNumber(limits?.maxOrderNotional)
      globalDaily = finiteNumber(limits?.maxDailyNotional)
    } catch { /* 读不到就用默认值 */ }
  }

  const venues = csv(a, 'venues') ?? (starter ? [...STARTER_VENUES] : [])
  const userInstruments = csv(a, 'instruments') // UX-36：只有用户自己写的标的才提示“已补全”，预设默认值不提示
  const rawInstruments = userInstruments ?? (starter ? [...STARTER_INSTRUMENTS] : [])
  let instruments = rawInstruments
  if (rawInstruments.length) {
    if (svc) {
      try {
        const rows = await d.callOp(svc, 'market.instruments', { limit: 1000 })
        const catalog = (Array.isArray(rows) ? rows : [])
          .map((x) => asRecord(x))
          .filter((x): x is Record<string, unknown> => !!x && typeof x.instrumentId === 'string')
          .map((x) => ({ instrumentId: x.instrumentId as string, ...(typeof x.marketGroup === 'string' || x.marketGroup === null ? { marketGroup: x.marketGroup } : {}) }))
        const normalized = normalizeInstrumentAllowlist(rawInstruments, catalog)
        if (userInstruments) for (const note of normalized.notes) io.out(`${note}\n`)
        if (normalized.unknown.length) {
          io.err(`不认识的标的：${normalized.unknown.map((u) => `${u.input}（最接近：${u.nearest.join('、') || '无'}）`).join('；')}\n`)
          return 2
        }
        instruments = normalized.list
      } catch { /* 目录取不到时按裸符号补全 */ }
    }
    if (instruments === rawInstruments) {
      instruments = rawInstruments.map((s) => (s.includes(':') ? s : `${DEFAULT_VENUE}:${s}`))
      if (userInstruments) for (const s of rawInstruments) if (!s.includes(':')) io.out(`已补全为 ${DEFAULT_VENUE}:${s}\n`)
    }
  }

  const explicitOrder = flag(a, 'max-order')
  const explicitDaily = flag(a, 'max-daily')
  const explicitDailyLoss = flag(a, 'max-daily-loss')
  const explicitAutoMax = flag(a, 'auto-max')
  const limits: Prepared['limits'] = {}
  if (explicitOrder !== undefined) {
    const n = finiteNumber(explicitOrder)
    if (n === undefined || n <= 0) { io.err('--max-order 必须是正数\n'); return 2 }
    limits.maxOrderNotional = String(n)
  } else if (starter) limits.maxOrderNotional = String(lowerCap(DEFAULT_MAX_ORDER, globalOrder))
  if (explicitDaily !== undefined) {
    const n = finiteNumber(explicitDaily)
    if (n === undefined || n <= 0) { io.err('--max-daily 必须是正数\n'); return 2 }
    limits.maxDailyNotional = String(n)
  } else if (starter) limits.maxDailyNotional = String(lowerCap(DEFAULT_MAX_DAILY, globalDaily))
  if (explicitDailyLoss !== undefined) {
    const n = finiteNumber(explicitDailyLoss)
    if (n === undefined || n <= 0) { io.err('--max-daily-loss 必须是正数\n'); return 2 }
    limits.maxDailyLoss = String(n)
  } else if (starter && tier === 'auto_limited') limits.maxDailyLoss = String(lowerCap(DEFAULT_MAX_DAILY_LOSS, Number(limits.maxDailyNotional ?? DEFAULT_MAX_DAILY)))
  if (explicitAutoMax !== undefined) {
    const n = finiteNumber(explicitAutoMax)
    if (n === undefined || n <= 0) { io.err('--auto-max 必须是正数\n'); return 2 }
    limits.autoMaxOrderNotional = String(n)
  } else if (starter && tier === 'auto_limited') limits.autoMaxOrderNotional = String(lowerCap(DEFAULT_AUTO_MAX, Number(limits.maxOrderNotional ?? DEFAULT_MAX_ORDER)))

  // 校验：auto-max 不能大于 max-order
  if (limits.autoMaxOrderNotional && limits.maxOrderNotional && Number(limits.autoMaxOrderNotional) > Number(limits.maxOrderNotional)) {
    io.err('--auto-max 不能大于 --max-order（超过 auto-max 的单会转提案，高于单笔上限没有意义）\n')
    return 2
  }
  // 校验：max-daily-loss 不能大于 max-daily
  if (limits.maxDailyLoss && limits.maxDailyNotional && Number(limits.maxDailyLoss) > Number(limits.maxDailyNotional)) {
    io.err('--max-daily-loss 不能大于 --max-daily\n')
    return 2
  }

  const daysRaw = flag(a, 'days')
  const days = daysRaw !== undefined ? Number(daysRaw) : starter ? STARTER_DAYS : undefined
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    io.err('--days 必须是正整数\n')
    return 2
  }

  const accounts = await resolveAccounts(home, svc, csv(a, 'accounts'), d)

  const tokenFileMode = starter || a.flags['token-file'] !== undefined
  const tokenFileTarget = typeof a.flags['token-file'] === 'string' ? a.flags['token-file'].trim() : undefined

  // 心跳配置
  const heartbeatTimeoutRaw = flag(a, 'heartbeat-timeout')
  let heartbeat: typeof MANDATE_DEFAULTS.heartbeat | undefined
  if (tier === 'auto_limited') {
    if (heartbeatTimeoutRaw !== undefined) {
      const timeoutSec = finiteNumber(heartbeatTimeoutRaw)
      if (timeoutSec === undefined || timeoutSec <= 10) {
        io.err('--heartbeat-timeout 必须大于 10 秒\n')
        return 2
      }
      const intervalSec = Math.max(10, Math.floor(timeoutSec / 3))
      heartbeat = { intervalSec, timeoutSec, onTimeout: MANDATE_DEFAULTS.heartbeat.onTimeout }
    } else {
      heartbeat = MANDATE_DEFAULTS.heartbeat
    }
  }

  const mandate = {
    accounts: accounts.ids,
    ...(venues.length ? { venueAllowlist: venues } : {}),
    ...(instruments.length ? { instrumentAllowlist: instruments } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(heartbeat ? { heartbeat } : {}),
  }
  const level = DEFAULT_LEVEL_OF_TIER[tier]
  const now = d.now()
  const notAfter = now + (days ?? STARTER_DAYS) * DAY
  const draft = { ...mandate, subject: { type: 'agentKey', id: 'ak_pending' }, level, notAfter } as never
  const gaps = mandateGaps(draft, now)
  if (gaps.length) {
    // 原文保留在括号里（上游报错不改写）；退出码沿用旧口径 1
    io.err(`「${AGENT_PERMISSION_TIER_LABELS[tier]}」档还需要：${gaps.map((g) => g.zh).join('、')}。可以这样一条命令建好：gitrader keys new agent <名> --host <宿主> --tier auto_limited --preset starter（需要自己定额度时加 --max-order N --max-daily N --max-daily-loss N --auto-max N）（原文：invalid mandate: ${checkMandateInput(draft, now).join('; ')}）\n`)
    return 1
  }

  const prepared: Prepared = {
    name, host, tier, accounts: accounts.ids, accountLabels: accounts.labels,
    venues, instruments, limits, days, tokenFileMode, tokenFileTarget,
  }
  const input = { name, host, tier, mandate, ...(days !== undefined ? { expiresInDays: days } : {}) }
  const origin = mkOrigin('user:usr_local', 'cli:keys.new', 'cli')

  // ---- 2. 创建路径 -----------------------------------------------------------------
  if (!io.interactive && !svc) {
    io.err('请先运行 gitrader serve（后台运行也可以），再执行本命令\n')
    return 2
  }

  if ((!io.interactive || a.flags['approve-in-browser'] !== undefined) && svc) {
    const req = asRecord(await d.callOp(svc, 'agentkey.request', { input }))
    const requestId = typeof req?.requestId === 'string' ? req.requestId : ''
    if (!requestId) throw new Error('服务没有返回接入请求编号')
    io.out(`已在工作台发起接入请求「${name}」：请在浏览器里核对内容并输入 PIN 批准（10 分钟内有效）。\n`)
    io.out('去工作台批准这个接入请求（等待中，Ctrl+C 取消）\n')
    // Ctrl+C / 超时：撤回这条请求，免得工作台留下重复的“Agent 请求接入”待批卡
    let interrupted = false
    const onSigint = (): void => { interrupted = true }
    process.once('SIGINT', onSigint)
    let view: Record<string, unknown>
    try {
      view = await waitForApproval(home, svc, requestId, d, () => interrupted)
    } catch (e) {
      await withdraw(io, home, svc, requestId, d)
      throw e
    } finally {
      process.removeListener('SIGINT', onSigint)
    }
    if (view.state === 'interrupted') {
      await withdraw(io, home, svc, requestId, d)
      io.err('已取消接入请求\n')
      return 130
    }
    const state = typeof view.state === 'string' ? view.state : ''
    if (state === 'approved') {
      const tokenPath = typeof view.tokenFilePath === 'string' ? view.tokenFilePath : ''
      if (!tokenPath) throw new Error('服务没有返回令牌文件路径')
      const target = typeof prepared.tokenFileTarget === 'string' ? prepared.tokenFileTarget : ''
      if (target) {
        // 内核写在默认位置；再按 --token-file 的写法另存一份，令牌不打印。
        const resolved = resolve(target)
        try {
          const token = readFileSync(tokenPath, 'utf8').trim()
          warnLoose(io, d.writeTokenAt(resolved, token) === false ? resolved : undefined)
          printSuccess(io, prepared, resolved, notAfter)
          io.out(`（工作台批准时另存了一份在 ${tokenPath}；只需保留一份时可自行删除）\n`)
          return 0
        } catch (e) {
          const r = asRecord(e)
          const reason = typeof r?.code === 'string' ? r.code : e instanceof Error ? e.message : String(e)
          io.err(`没能写到 --token-file 指定的位置（${resolved}）：${reason}；令牌仍在 ${tokenPath}\n`)
          printSuccess(io, prepared, tokenPath, notAfter)
          return 0
        }
      }
      printSuccess(io, prepared, tokenPath, notAfter)
      return 0
    }
    if (state === 'rejected') {
      io.err(`接入请求已被拒绝${typeof view.note === 'string' && view.note ? `：${view.note}` : ''}。可以在工作台重新发起。\n`)
      return 1
    }
    io.err('接入请求已过期。请重新执行本命令，并在 10 分钟内到浏览器里批准。\n')
    return 1
  }

  // 终端 PIN 流：保持原有做法（打开内核 → 要 PIN → createKey）。
  const k = await d.openKernel(home, io)
  try {
    const proof = await d.needPin(k, io)
    const r = k.agents.createKey({ name, host: host as never, tier, mandate: mandate as never, ...(days !== undefined ? { expiresInDays: days } : {}) }, proof, origin)
    if (tokenFileMode) {
      const tokenPath = tokenFileTarget ? (warnLoose(io, d.writeTokenAt(resolve(tokenFileTarget), r.token) === false ? resolve(tokenFileTarget) : undefined), resolve(tokenFileTarget)) : d.writeTokenFile(home, r.key.name, r.token, (p) => warnLoose(io, p))
      printSuccess(io, prepared, tokenPath, r.mandate.notAfter)
      return 0
    }
    io.out(`Created agent key ${r.key.name} (${r.key.keyId}), level ${r.mandate.level}, valid until ${fmtLocal(r.key.expiresAt)}.\n`)
    io.out(`Token (shown once — copy it now):\n  ${r.token}\n\n`)
    if ((HOSTS as readonly string[]).includes(host)) io.out(`Paste this into your ${host} config, with the token above as the environment variable GITRADER_AGENT_TOKEN:\n\n${snippetFor(host as (typeof HOSTS)[number], home, { inlineToken: true })}`)
    if (tier === 'paper') io.out('注意：纸面档下 AI 的纸面单直接成交、不经你批准；要逐单批准请用 --tier confirm\n')
    return 0
  } finally {
    await k.stop()
  }
}
