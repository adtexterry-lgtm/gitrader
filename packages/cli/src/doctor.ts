// SPDX-License-Identifier: CPAL-1.0
// `gitrader doctor`：新手自检。所有检查都可离线完成；只有行情 / 账户 / 钥匙三项需要服务在跑。
// 输出全中文；--json 给自动化读。任何单项异常都被这一项自己吃掉，不让英文堆栈冒到终端。
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KERNEL_VERSION, homePaths, homeStateEvidence, judgePaperStateOffline, loadConfig, verifyLedgerOffline, stripBom } from '@gitrader/kernel'
import { AGENT_PERMISSION_TIER_LABELS, TIER_OF_LEVEL } from '@gitrader/protocol'
import type { MandateLevel } from '@gitrader/protocol'
import { serviceOp, liveService } from './index'
import type { Args, CliIo, ServiceInfo } from './index'
import { locateMcpEntry } from './snippets'
import { applyLauncher, langOf } from './lang'

export type CheckLevel = 'block' | 'warn' | 'ok'

export interface DoctorCheck {
  id: string
  ok: boolean
  level: CheckLevel
  zh: string
  next?: string
  /** 英文界面用的文案；没给就退回中文。 */
  en?: string
  nextEn?: string
  /** 只给人读的总结行用：被限制的 Agent（只读 / 暂停 / 已吊销），不算 warn、不改退出码，也不进 --json。 */
  restricted?: string[]
}

export interface DoctorDeps {
  liveService(home: string): Promise<ServiceInfo | null>
  callOp(service: ServiceInfo, opName: string, params?: Record<string, unknown>): Promise<unknown>
  /** 内核 `/api/health`（免鉴权）：带 B3 的 securityStateHealth（stateFiles / degraded）。 */
  health(service: ServiceInfo): Promise<unknown>
  staticDir(): string | undefined
  mcpEntry(): { path: string; built: boolean }
  /** 服务没在跑时的账本离线验链（只读）；测试注入假结果。 */
  verifyLedgerOffline?(home: string): unknown
  /** 在目录下真写一个探针文件再删掉；失败就抛（Windows 上 accessSync 不看 ACL，只能真写）。 */
  probeWrite?(dir: string): void
  /** 读文本文件；测试注入权限错误。 */
  readFile?(path: string): string
  /** 服务没在跑时按内核规则只读判定纸面状态文件（fix-r2 S1）；测试注入假结果。 */
  paperStateOffline?(home: string): unknown
  /** 环境变量表；测试注入。默认 process.env。 */
  env?: Record<string, string | undefined>
}

const DAY = 86_400_000
const PLACEHOLDER_SECRET = /^(changeme|change[-_ ]?me|password|123456|secret|test|your[-_ ]?.*|xxx+|<.*>)$/i
const STALE_QUOTE_MS = 10_000
const QUOTE_TIMEOUT_MS = 5_000
const KEYS_NEW_NEXT = 'gitrader keys new agent <名字> --host claude-code --preset starter'
const KEYS_NEW_NEXT_EN = 'gitrader keys new agent <name> --host claude-code --preset starter'
const PIN_RESET_NEXT = '先停掉 gitrader serve，再运行 gitrader pin reset（忘了 PIN 也走这条）'
const PIN_RESET_NEXT_EN = 'Stop gitrader serve first, then run gitrader pin reset (also the way out if you forgot the PIN)'
const STATE_FILE_ZH: Record<string, string> = { pin: 'PIN 文件', keystore: '钥匙库', 'device-key': '设备密钥', 'install-key': '安装签名钥' }
const LEDGER_NEXT = '不要继续交易；从备份还原 data/gitrader.sqlite 后重启，见 docs/user/09-安全.md'
const LEDGER_NEXT_EN = 'Do not keep trading; restore data/gitrader.sqlite from a backup and restart (see docs/user/en/09-security.md)'
const PAPER_UNVERIFIED_NEXT = '账本库不见了就先把 data/gitrader.sqlite 从备份还原回来；确定要从空账本重来才用 gitrader serve --accept-new-ledger --reset-paper-state（旧纸面状态会移进 backups/ 备份起来）'
const PAPER_UNVERIFIED_NEXT_EN = 'If the ledger database is missing, restore data/gitrader.sqlite from a backup first; only if you really want a fresh ledger use gitrader serve --accept-new-ledger --reset-paper-state (the old paper state is moved into backups/)'
const PAPER_NEXT_EN = 'Rename paper-state.json.prev or a backup to paper-state.json and restart; or stop gitrader serve and run gitrader paper rebuild-from-ledger (rebuilds from the ledger)'
const PAPER_NEXT = '把 paper-state.json.prev 或备份改名为 paper-state.json 后重启；或先停掉 gitrader serve 再运行 gitrader paper rebuild-from-ledger（以账本为准重建）'
const TRADING_NEXT = '在工作台「风险」里输 PIN 恢复交易（恢复前先看原因）'
const TRADING_NEXT_EN = 'Enter your PIN under Risk in the workbench to resume trading (read the reason first)'

const ok = (id: string, zh: string, en?: string): DoctorCheck => ({ id, ok: true, level: 'ok', zh, ...(en ? { en } : {}) })
const warn = (id: string, zh: string, next: string, en?: string, nextEn?: string): DoctorCheck => ({ id, ok: false, level: 'warn', zh, next, ...(en ? { en } : {}), ...(nextEn ? { nextEn } : {}) })
const block = (id: string, zh: string, next: string, en?: string, nextEn?: string): DoctorCheck => ({ id, ok: false, level: 'block', zh, next, ...(en ? { en } : {}), ...(nextEn ? { nextEn } : {}) })

function reasonZh(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return '文件不存在'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限'
  const msg = e instanceof Error ? e.message : ''
  if (/Unexpected|JSON/i.test(msg)) return '内容不是合法的 JSON'
  return '原因不明'
}

function errorCheck(id: string, e: unknown): DoctorCheck {
  return { id, ok: false, level: 'warn', zh: `检查时出错：${reasonZh(e)}`, next: '再运行一次 gitrader doctor' }
}

async function guarded(id: string, run: () => DoctorCheck | Promise<DoctorCheck>): Promise<DoctorCheck> {
  try { return await run() } catch (e) { return errorCheck(id, e) }
}

function nodeVersionOk(version: string): boolean {
  const parts = version.split('.')
  const major = Number(parts[0] ?? '0')
  const minor = Number(parts[1] ?? '0')
  return major > 22 || (major === 22 && minor >= 13)
}

/** 与 index.ts 的 defaultStaticDir 保持一致；那里没有导出，所以复制这段查找逻辑。 */
function defaultStaticDir(): string | undefined {
  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    for (const p of [join(here, '..', '..', 'workbench', 'dist'), join(here, '..', 'workbench'), join(here, 'workbench')]) {
      if (existsSync(join(p, 'index.html'))) return p
    }
  } catch { /* 找不到就让工作台检查报缺文件 */ }
  return undefined
}

export const doctorDeps: DoctorDeps = {
  liveService: (home) => liveService(home),
  callOp: (service, opName, params) => serviceOp(service, opName, params ?? {}),
  health: async (service) => (await fetch(`http://127.0.0.1:${service.port}/api/health`, { signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) })).json(),
  staticDir: () => defaultStaticDir(),
  mcpEntry: () => locateMcpEntry(dirname(fileURLToPath(import.meta.url))),
  verifyLedgerOffline: (home) => verifyLedgerOffline(home),
  probeWrite: (dir) => {
    const probe = join(dir, `.doctor-probe-${randomBytes(6).toString('hex')}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  paperStateOffline: (home) => {
    let ids: string[] = []
    try { ids = loadConfig(home).accounts.filter((a) => a.mode !== 'live' && !!a.paper).map((a) => a.accountId ?? '').filter(Boolean) } catch { /* 配置读不出来由 config 检查报 */ }
    try { return judgePaperStateOffline(home, ids) } catch (e) { return { state: 'corrupt', reason: `打不开账本库来核对纸面状态（${e instanceof Error ? e.message : String(e)}）` } }
  },
}

/** 写探针 / 读文件失败的人话原因：按 error.code 分，不一律说成 JSON 坏了。 */
function ioReasonZh(e: unknown, path: string, verb = '读'): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return '文件不存在'
  if (code === 'EPERM' || code === 'EACCES') return `没有权限${verb} ${path}`
  if (code === 'ENOSPC') return '磁盘空间满了'
  if (code === 'EROFS') return '只读文件系统'
  if (e instanceof SyntaxError) return '不是合法的 JSON'
  return e instanceof Error ? e.message : String(e)
}

function ioReasonEn(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'file does not exist'
  if (code === 'EPERM' || code === 'EACCES') return 'permission denied'
  if (code === 'ENOSPC') return 'disk is full'
  if (code === 'EROFS') return 'read-only file system'
  if (e instanceof SyntaxError) return 'not valid JSON'
  return e instanceof Error ? e.message : String(e)
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function quotePrice(q: unknown): string | null {
  if (!q || typeof q !== 'object') return null
  const row = q as { price?: unknown; ts?: unknown }
  if (typeof row.ts !== 'number' || !Number.isFinite(row.ts)) return null
  if (Date.now() - row.ts >= STALE_QUOTE_MS) return null
  if (row.price === null || row.price === undefined) return null
  const price = String(row.price)
  return price ? price : null
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 令牌文件名规则（与内核 token-file.ts 的 safeName 一致：只留中文、字母数字 . _ -，其余换成 -）。 */
function tokenSafeName(keyName: string): string {
  const s = String(keyName ?? '').replace(/[^\p{Script=Han}A-Za-z0-9._-]/gu, '-')
  return s === '' ? 'agent' : s
}

function keyList(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v
  const items = asRecord(v).items
  return Array.isArray(items) ? items : null
}

export async function runChecks(home: string, overrides: Partial<DoctorDeps> = {}): Promise<DoctorCheck[]> {
  const deps: DoctorDeps = { ...doctorDeps, ...overrides }
  const checks: DoctorCheck[] = []

  checks.push(await guarded('node', () => {
    const v = process.versions.node
    return nodeVersionOk(v)
      ? ok('node', `Node 版本 ${v}`, `Node version ${v}`)
      : block('node', `Node 版本太旧：${v}`, '安装 Node 22.13 或更新版本，或改用便携包', `Node version is too old: ${v}`, 'Install Node 22.13 or newer, or use the portable package')
  }))

  let homeExists = false
  checks.push(await guarded('home', () => {
    if (!existsSync(home)) return block('home', '还没初始化', 'gitrader init', 'Not initialized yet', 'gitrader init')
    // 能不能写交给下面的 datadir 真写探针文件判断（Windows 上 accessSync 不看 ACL）
    homeExists = true
    return ok('home', '主目录可用', 'Data directory exists')
  }))
  if (!homeExists) return checks

  const paths = homePaths(home)

  checks.push(await guarded('config', () => {
    // 先自己读一遍，按 error.code 分类（loadConfig 会把原始错误码折进一句英文里）
    try {
      JSON.parse(stripBom((deps.readFile ?? doctorDeps.readFile!)(paths.config)))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') {
        const evidence = homeStateEvidence(home)
        if (evidence.length > 0) {
          return block('config', `配置文件不见了，但主目录里还有 ${evidence.join('、')}`, `从备份还原 gitrader.json；确定要用默认配置重来：gitrader init --rebuild-config（见 docs/user/09-安全.md）`,
            `The config file is gone, but the data directory still has ${evidence.join(', ')}`, 'Restore gitrader.json from a backup; to start over with the default config: gitrader init --rebuild-config (see docs/user/en/09-security.md)')
        }
        // UX-01：刚装好、还没 init = 目录里没有任何用过的痕迹，这只是「还没初始化」的提醒，不是配置坏了
        return warn('config', '还没初始化（gitrader.json 文件不存在）', 'gitrader init', 'Not initialized yet (gitrader.json does not exist)', 'gitrader init')
      }
      const next = code === 'EPERM' || code === 'EACCES'
        ? `检查 ${paths.config} 的读取权限（Windows 看 ACL：右键→属性→安全）`
        : `用编辑器检查 ${paths.config}；或把它改名留底后运行 gitrader init --rebuild-config`
      return block('config', `配置文件读不出来：${ioReasonZh(e, paths.config)}`, next, `The config file cannot be read: ${ioReasonEn(e)}`, `Check ${paths.config} in an editor; or rename it as a backup and run gitrader init --rebuild-config`)
    }
    try {
      loadConfig(home)
      return ok('config', '配置文件正常', 'Config file is fine')
    } catch {
      return block('config', '配置文件读不出来：内容不符合配置格式', `用编辑器检查 ${paths.config}；或把它改名留底后运行 gitrader init --rebuild-config`, 'The config file cannot be read: its content does not match the config format', `Check ${paths.config} in an editor; or rename it as a backup and run gitrader init --rebuild-config`)
    }
  }))

  // 凭据自查（思路参照 QuantDinger v5.7.4 移除默认数据库凭据）：配置里的 env:VAR 句柄指向的变量没设、或还是示例占位值，
  // 就在这里提示。只报变量名，不读出也不打印值；明文凭据本就被配置校验拒收（见 kernel config.ts），这里不重复。
  checks.push(await guarded('credentials', () => {
    let accounts: Array<{ alias?: string; credentials?: Record<string, string> }> = []
    try { accounts = (loadConfig(home) as { accounts?: typeof accounts }).accounts ?? [] } catch { return ok('credentials', '凭据检查已跳过（配置文件有问题，见上一项）', 'Credential check skipped (the config file has a problem, see above)') }
    const env = deps.env ?? process.env
    const missing: string[] = []
    const placeholder: string[] = []
    for (const a of accounts) {
      for (const handle of Object.values(a.credentials ?? {})) {
        const name = handle.replace(/^env:/, '')
        const v = env[name]
        if (v === undefined || v.trim() === '') missing.push(name)
        else if (PLACEHOLDER_SECRET.test(v.trim())) placeholder.push(name)
      }
    }
    if (missing.length) return warn('credentials', `配置引用的环境变量没设：${[...new Set(missing)].join('、')}`, '在启动 gitrader serve 的环境里设置这些变量，或改用钥匙库（gitrader keys）', `Environment variables referenced by the config are not set: ${[...new Set(missing)].join(', ')}`, 'Set them in the environment that starts gitrader serve, or use the keystore (gitrader keys)')
    if (placeholder.length) return warn('credentials', `环境变量还是示例占位值：${[...new Set(placeholder)].join('、')}`, '换成交易所里生成的真实 API 凭据；占位值不要用于实盘', `Environment variables still hold example placeholder values: ${[...new Set(placeholder)].join(', ')}`, 'Replace them with real API credentials from the exchange; never use placeholders for live trading')
    return ok('credentials', '凭据配置正常', 'Credentials look fine')
  }))

  checks.push(await guarded('datadir', () => {
    if (!existsSync(paths.data)) return ok('datadir', '数据目录还没创建（第一次运行 gitrader serve 时会建）', 'The data directory does not exist yet (it is created the first time you run gitrader serve)')
    try {
      (deps.probeWrite ?? doctorDeps.probeWrite!)(paths.data)
    } catch (e) {
      return block('datadir', `数据目录不能写：${paths.data}（${ioReasonZh(e, paths.data, '写')}）`, '检查该目录的权限（Windows 看 ACL：右键→属性→安全）', `The data directory is not writable: ${paths.data} (${ioReasonEn(e)})`, 'Check the folder permissions (Windows: right-click > Properties > Security)')
    }
    return ok('datadir', '数据目录可写', 'The data directory is writable')
  }))

  checks.push(await guarded('pin', () => {
    // B3：PIN 文件没了、钥匙库或设备密钥还在 = 安全状态损坏（内核拒绝设新 PIN），只能走 pin reset
    if (!existsSync(paths.pin) && (existsSync(paths.keystore) || existsSync(paths.deviceKey))) return block('pin', 'PIN 文件不见了，但钥匙库还在（安全文件损坏）', PIN_RESET_NEXT, 'The PIN file is gone but the keystore is still there (security files are damaged)', PIN_RESET_NEXT_EN)
    if (!existsSync(paths.pin)) return warn('pin', '还没设 PIN', '运行 gitrader serve 后在浏览器里设，或在终端运行 gitrader init', 'No PIN yet', 'Run gitrader serve and set it in the browser, or run gitrader init in a terminal')
    try {
      JSON.parse(readFileSync(paths.pin, 'utf8'))
      return ok('pin', 'PIN 已设置', 'PIN is set')
    } catch {
      return block('pin', 'PIN 文件损坏', PIN_RESET_NEXT, 'The PIN file is damaged', PIN_RESET_NEXT_EN)
    }
  }))

  const state: { service: ServiceInfo | null } = { service: null }
  checks.push(await guarded('service', async () => {
    state.service = await deps.liveService(home)
    const svc = state.service
    return svc ? ok('service', `服务在跑（端口 ${svc.port}）`, `The service is running (port ${svc.port})`) : warn('service', '服务没在跑', 'gitrader serve', 'The service is not running', 'gitrader serve')
  }))

  const svc = state.service
  // 服务在跑时 health / status 各取一次，供 security / trading / ledger / paper 共用；取不到就是 null，各项自己处理
  let healthRec: Record<string, unknown> | null = null
  let statusRec: Record<string, unknown> | null = null
  if (svc) {
    try { healthRec = asRecord(await deps.health(svc)) } catch { /* security 报“检查时出错”，其余项改走离线 */ }
    try {
      const s = await withTimeout(deps.callOp(svc, 'status'), QUOTE_TIMEOUT_MS)
      if (s && typeof s === 'object') statusRec = asRecord(s)
    } catch { /* 读不到交易状态就跳过 */ }
  }
  /** health 优先，其次 status；两边都没有这个字段返回 undefined（null 是有意义的值：验链还没跑完）。 */
  const live = (key: string): unknown => (healthRec && key in healthRec ? healthRec[key] : statusRec && key in statusRec ? statusRec[key] : undefined)
  // UX-12：命令行升级了但服务还是旧进程
  const runningVersion = live('version')
  if (svc && typeof runningVersion === 'string' && runningVersion !== KERNEL_VERSION) {
    checks.push(warn('version', `命令行是 ${KERNEL_VERSION}，但正在运行的服务是 ${runningVersion}（升级后没重启）`, '先运行 gitrader stop，再 gitrader serve --detach 重启服务；浏览器里要重新登录',
      `The command line is ${KERNEL_VERSION} but the running service is ${runningVersion} (not restarted after the upgrade)`, 'Run gitrader stop, then gitrader serve --detach to restart; sign in again in the browser'))
  }
  if (svc) {
    // E0-2：服务在跑时以内核自己的安全状态体检（B3 securityStateHealth，经 /api/health）为准
    checks.push(await guarded('security', async () => {
      if (!healthRec) throw new Error('health unreachable')
      const h = healthRec
      const files = (Array.isArray(h.stateFiles) ? h.stateFiles : []).map(asRecord)
      // paper-state 损坏归 paper 检查管，这里只看 pin / 钥匙库 / 设备密钥 / 安装签名钥，别把它报成 pin reset
      const bad = files.filter((f) => f.state === 'corrupt' && String(f.kind) in STATE_FILE_ZH).map((f) => String(f.kind))
      const degradedWithoutDetail = h.status === 'degraded' && !files.some((f) => f.state === 'corrupt')
      if (!degradedWithoutDetail && bad.length === 0) {
        // R2-REL-04：service.json / 令牌文件的权限没收紧成功时内核在 status.warnings 里留痕，这里不许再报“正常”
        const loose = (Array.isArray(statusRec?.warnings) ? statusRec.warnings : []).filter((w): w is string => typeof w === 'string' && w.includes('could not tighten permissions'))
        if (loose.length) return warn('security', `有文件的权限没收紧到只有当前用户可读：${loose.join('；')}`, '常见原因是数据目录路径过长（接近 Windows 的 260 字符）：把 GITRADER_HOME 换到更短的目录；令牌文件泄露风险较高时撤销并重发对应的 Agent 钥匙',
          `Some files are not restricted to the current user: ${loose.join('; ')}`, 'Usually the data directory path is too long (near the Windows 260-character limit): point GITRADER_HOME at a shorter folder; if a token file may have leaked, revoke and reissue that agent key')
        return ok('security', '安全状态文件正常', 'Security state files are fine')
      }
      const names = bad.map((k) => STATE_FILE_ZH[k] ?? k).join('、') || '安全状态文件'
      // 安装签名钥是账本身份，pin reset 换不了；其余（PIN / 钥匙库 / 设备密钥）走 pin reset
      return bad.includes('install-key')
        ? block('security', `${names}损坏`, '从你的备份恢复 keys/install-key.json 后重启 gitrader serve', `${names} damaged`, 'Restore keys/install-key.json from your backup, then restart gitrader serve')
        : block('security', `${names}损坏`, PIN_RESET_NEXT, `${names} damaged`, PIN_RESET_NEXT_EN)
    }))
    checks.push(await guarded('venue', async () => {
      try {
        const quote = await withTimeout(deps.callOp(svc, 'market.quote', { instrumentId: 'hyperliquid:BTC' }), QUOTE_TIMEOUT_MS)
        const price = quotePrice(quote)
        if (price) return ok('venue', `行情正常：BTC ${price}`, `Market data is fine: BTC ${price}`)
      } catch { /* 取不到就按下一条告警 */ }
      return warn('venue', '行情暂时取不到（离线或网络不通）', '检查网络；离线模式下这条可忽略', 'Market data is unavailable right now (offline or no network)', 'Check your network; ignore this in offline mode')
    }))
  }

  // 交易状态（ADR-16）：被暂停 / 只减仓时点名原因，不让用户对着“下单被拒”猜
  checks.push(await guarded('trading', async () => {
    if (!svc) return ok('trading', '服务没在运行，跳过交易状态检查', 'The service is not running; trading state check skipped')
    const stateRaw = live('tradingState')
    if (stateRaw !== 'HALTED' && stateRaw !== 'REDUCING') {
      if (stateRaw !== 'ACTIVE') return ok('trading', '没读到交易状态，跳过', 'Could not read the trading state; skipped')
      // C7：全局 ACTIVE 不代表没有作用域被限制（授权书只减仓 / 停止、账户被停）；点名钥匙名，不再报“交易状态正常”
      const scoped = (Array.isArray(live('scopedStates')) ? (live('scopedStates') as unknown[]) : []).map(asRecord).filter((r) => r.state === 'HALTED' || r.state === 'REDUCING')
      if (scoped.length === 0) return ok('trading', '交易状态正常', 'Trading state is normal')
      const nameOf = new Map<string, string>()
      try {
        for (const raw of keyList(await withTimeout(deps.callOp(svc, 'agentkey.list'), QUOTE_TIMEOUT_MS)) ?? []) {
          const k = asRecord(raw)
          if (typeof k.mandateId === 'string' && typeof k.name === 'string' && k.name) nameOf.set(k.mandateId, k.name)
        }
      } catch { /* 查不到钥匙名就写“某 Agent” */ }
      const rows = scoped.map((r) => {
        const scope = asRecord(r.scope)
        const id = String(scope.id ?? '')
        const who = scope.type === 'mandate' ? `Agent「${nameOf.get(id) ?? '某 Agent'}」` : scope.type === 'account' ? `账户 ${id}` : `${String(scope.type ?? '某范围')} ${id}`.trim()
        const why = typeof r.reason === 'string' && r.reason ? r.reason : '内核没有给出原因'
        return `${who}${r.state === 'HALTED' ? '已停止' : '只允许减仓'}：${why}`
      })
      return warn('trading', `部分交易受限（全局状态正常）：${rows.join('；')}`, TRADING_NEXT, `Part of trading is restricted (global state is normal): ${rows.join('; ')}`, TRADING_NEXT_EN)
    }
    const rank = (s: unknown): number => (s === 'HALTED' ? 2 : s === 'REDUCING' ? 1 : 0)
    const reasons = (Array.isArray(live('stateReasons')) ? (live('stateReasons') as unknown[]) : []).map(asRecord).sort((a, b) => rank(b.state) - rank(a.state))
    const text = reasons[0]?.reason
    const reason = typeof text === 'string' && text ? text : '内核没有给出原因'
    const next = /纸面|paper/i.test(reason) ? PAPER_NEXT : /账本|哈希|投影|ledger/i.test(reason) ? LEDGER_NEXT : TRADING_NEXT
    const nextEn = next === PAPER_NEXT ? 'Rename paper-state.json.prev (or a backup) to paper-state.json and restart; or stop gitrader serve and run gitrader paper rebuild-from-ledger' : next === LEDGER_NEXT ? LEDGER_NEXT_EN : TRADING_NEXT_EN
    return stateRaw === 'HALTED'
      ? block('trading', `交易已全部暂停：${reason}`, next, `All trading is halted: ${reason}`, nextEn)
      : warn('trading', `交易只允许减仓：${reason}`, next, `Trading is reduce-only: ${reason}`, nextEn)
  }))

  // 账本完整性（ADR-17）：服务在跑读内核启动验链结果；没跑就离线只读验一遍
  checks.push(await guarded('ledger', async () => {
    let v: unknown = svc ? live('ledgerVerify') : undefined
    if (svc && v === null) return warn('ledger', '启动验链还没跑完，稍后再查', '等几秒后再运行 gitrader doctor', 'The startup ledger verification is still running', 'Wait a few seconds and run gitrader doctor again')
    if (v === undefined) v = await (deps.verifyLedgerOffline ?? doctorDeps.verifyLedgerOffline!)(home)
    const r = asRecord(v)
    if (r.ok === true) {
      const count = typeof r.count === 'number' ? `${r.count} 条` : '全部'
      return ok('ledger', `账本验链通过（${count}${r.mode === 'tail' ? '，只验了最近一段' : ''}）`, `Ledger hash chain verified (${typeof r.count === 'number' ? `${r.count} entries` : 'all'}${r.mode === 'tail' ? ', recent part only' : ''})`)
    }
    if (typeof r.error === 'string') {
      if (r.missing === true) {
        // 全新的家目录（还没跑过 serve）本来就没有账本；有安装签名钥或纸面状态 = 用过，库不见了才是事故
        if (!existsSync(paths.installKey) && !existsSync(join(home, 'paper-state.json'))) return ok('ledger', '账本还没创建（第一次运行 gitrader serve 时会建）', 'The ledger does not exist yet (it is created the first time you run gitrader serve)')
        return block('ledger', '账本数据库不见了', '从备份还原 data/gitrader.sqlite；确定要从空账本重来才用 gitrader serve --accept-new-ledger（paper-state.json 里还有持仓时还要加 --reset-paper-state）',
          'The ledger database is gone', 'Restore data/gitrader.sqlite from a backup; only if you really want a fresh ledger use gitrader serve --accept-new-ledger (add --reset-paper-state if paper-state.json still holds positions)')
      }
      return block('ledger', `账本数据库打不开（${r.error}）`, '检查 data/ 目录权限，或从备份还原', `The ledger database cannot be opened (${r.error})`, 'Check the permissions of data/, or restore from a backup')
    }
    const failure = asRecord(r.failure)
    const seq = typeof failure.seq === 'number' ? failure.seq : '未知'
    const reason = typeof failure.reason === 'string' ? failure.reason : '未给出原因'
    if (r.ok === false) {
      return reason.startsWith('fill projection')
        ? block('ledger', `成交投影与账本不一致（seq ${seq}）：${reason}`, LEDGER_NEXT, `The fill projection does not match the ledger (seq ${seq}): ${reason}`, LEDGER_NEXT_EN)
        : block('ledger', `账本哈希链在 seq ${seq} 断开（${reason}）`, LEDGER_NEXT, `The ledger hash chain breaks at seq ${seq} (${reason})`, LEDGER_NEXT_EN)
    }
    return warn('ledger', '账本验链结果读不懂', '再运行一次 gitrader doctor', 'The ledger verification result is not readable', 'Run gitrader doctor again')
  }))

  checks.push(await guarded('workbench', () => {
    const dir = deps.staticDir()
    return dir && existsSync(dir)
      ? ok('workbench', '工作台文件齐全', 'Workbench files are complete')
      : warn('workbench', '工作台文件缺失', '重新安装 Gitrader', 'Workbench files are missing', 'Reinstall Gitrader')
  }))

  checks.push(await guarded('mcp', () => {
    const entry = deps.mcpEntry()
    return entry.built && existsSync(entry.path)
      ? ok('mcp', 'MCP 入口可用', 'The MCP entry is available')
      : warn('mcp', 'MCP 入口不存在', '重新安装 Gitrader', 'The MCP entry is missing', 'Reinstall Gitrader')
  }))

  checks.push(await guarded('paper', async () => {
    if (!svc) {
      // 服务没跑：只能看文件本身在不在、能不能解析
      // fix-r2 S1：离线也按内核启动时的同一套规则判（摘要 / 账本里有没有纸面成交 / 序号），只读
      const off = asRecord((deps.paperStateOffline ?? doctorDeps.paperStateOffline!)(home))
      if (off.state === 'missing' || off.state === 'corrupt') return block('paper', typeof off.reason === 'string' && off.reason ? off.reason : '纸面状态文件和账本对不上', PAPER_NEXT)
      const file = join(home, 'paper-state.json')
      if (!existsSync(file)) return ok('paper', '纸面状态文件还没有（纸面账户第一次运行后生成）', 'No paper state file yet (it is created the first time the paper account runs)')
      try { JSON.parse(readFileSync(file, 'utf8')) } catch { return block('paper', '纸面状态文件读不出来或已损坏', PAPER_NEXT, 'The paper state file cannot be read or is damaged', PAPER_NEXT_EN) }
      // R2-REL-11：账本库不在（或账本里没有这份文件的摘要）时没法核对来历，不许再写”和账本记录的摘要一致”
      if (off.unverifiedFirstUse === true) return warn('paper', '纸面状态文件在，但账本里没有它的摘要（账本库不在，或是旧版本留下的文件），没法核对它的来历', PAPER_UNVERIFIED_NEXT, 'The paper state file exists but the ledger has no digest of it (no ledger database, or a file left by an older version), so its origin cannot be checked', PAPER_UNVERIFIED_NEXT_EN)
      return ok('paper', '纸面状态文件可读，和账本记录的摘要一致', 'The paper state file is readable and matches the digest in the ledger')
    }
    const ps = asRecord(live('paperState'))
    if (ps.state === 'missing' || ps.state === 'corrupt') {
      return block('paper', typeof ps.reason === 'string' && ps.reason ? ps.reason : '纸面状态文件和账本对不上', PAPER_NEXT)
    }
    if (ps.dirty === true) return warn('paper', '纸面状态没写进磁盘，内核在重试', '检查数据目录权限 / 磁盘空间', 'Paper state has not been written to disk; the kernel is retrying', 'Check the data directory permissions and free disk space')
    if (ps.unverifiedFirstUse === true) return warn('paper', '纸面状态文件是内核第一次见到的，账本里没有它的摘要，来历没法核对', PAPER_UNVERIFIED_NEXT, 'The kernel sees this paper state file for the first time and the ledger has no digest of it, so its origin cannot be checked', PAPER_UNVERIFIED_NEXT_EN)
    try {
      const audit = asRecord(await deps.callOp(svc, 'paper.audit'))
      const bad = (Array.isArray(audit.accounts) ? audit.accounts : []).map(asRecord).filter((a) => a.ok === false)
      if (bad.length > 0) {
        const rows = bad.map((a) => {
          const name = typeof a.alias === 'string' && a.alias ? a.alias : String(a.accountId ?? '未命名')
          const diffs = Array.isArray(a.diffs) ? a.diffs.map(String).join('、') : ''
          return diffs ? `${name}（${diffs}）` : name
        })
        return warn('paper', `纸面账户和账本重算对不上：${rows.join('；')}`, '先别把纸面结果当真；停掉 gitrader serve 后运行 gitrader paper rebuild-from-ledger（以账本为准重建）', `Paper accounts do not match the ledger recomputation: ${rows.join('; ')}`, 'Do not trust paper results yet; stop gitrader serve and run gitrader paper rebuild-from-ledger (rebuilds from the ledger)')
      }
    } catch { /* 引擎没有 paper.audit（旧版本）就跳过这一子项 */ }
    try {
      const list = keyList(await deps.callOp(svc, 'account.list'))
      if (list && list.some((a) => asRecord(a).mode === 'paper')) return ok('paper', '纸面账户可用', 'The paper account is available')
    } catch { /* 读不到就按缺纸面账户告警 */ }
    return warn('paper', '没有纸面账户', 'gitrader init', 'There is no paper account', 'gitrader init')
  }))

  if (svc) {
    checks.push(await guarded('mainnetLive', async () => {
      try {
        const list = keyList(await deps.callOp(svc, 'account.list'))
        if (list) {
          const mainnetLive = list.map(asRecord).filter((a) => a.mode === 'live' && a.environment === 'mainnet')
          if (mainnetLive.length > 0) {
            const names = mainnetLive.map((a) => (typeof a.alias === 'string' && a.alias ? a.alias : String(a.accountId ?? '未命名'))).join('、')
            return block('mainnetLive', `0.1.1 不支持主网实盘交易，但配置里有主网 live 账户：${names}`, '删除该账户（在工作台「连接」页面），或切回测试网（gitrader settings network testnet）', `0.1.1 does not support mainnet live trading, but the config has a mainnet live account: ${names}`, 'Delete that account (workbench, Connections page), or switch back to testnet (gitrader settings network testnet)')
          }
        }
      } catch { /* 读不到就跳过 */ }
      return ok('mainnetLive', '无主网 live 账户（0.1.1 不支持主网实盘）', 'No mainnet live account (0.1.1 does not support mainnet live trading)')
    }))
  }

  let keyCount = 0 // 未吊销的钥匙数
  let keysKnown = false
  let keyInfo: Array<{ name: string; status: string; expiresAt: number }> = []
  if (svc) {
    checks.push(await guarded('agentKey', async () => {
      try {
        const list = keyList(await deps.callOp(svc, 'agentkey.list'))
        if (list) {
          keysKnown = true
          keyInfo = list.map(asRecord).map((k) => ({ name: typeof k.name === 'string' ? k.name : '', status: String(k.status ?? ''), expiresAt: typeof k.expiresAt === 'number' ? k.expiresAt : Number.NaN }))
          if (list.length === 0) return warn('agentKey', '还没有 Agent 钥匙', KEYS_NEW_NEXT, 'There is no agent key yet', KEYS_NEW_NEXT_EN)
          const now = Date.now()
          let soon = false
          const rows: string[] = []
          const rowsEn: string[] = []
          const revoked: string[] = [] // 已吊销的单独列，不算“N 天后到期”
          const restricted: string[] = []
          // 档位在授权书上（agentkey.list 不带），按 mandateId 查；查不到就不写档位，不写“未知”
          const mandates = new Map<string, Record<string, unknown>>()
          try { for (const m of keyList(await withTimeout(deps.callOp(svc, 'mandate.list'), QUOTE_TIMEOUT_MS)) ?? []) { const r = asRecord(m); if (typeof r.mandateId === 'string') mandates.set(r.mandateId, r) } } catch { /* 没有授权书信息就不写档位 */ }
          for (const raw of list) {
            const key = asRecord(raw)
            const name = typeof key.name === 'string' && key.name ? key.name : '未命名'
            if (key.status === 'revoked') { revoked.push(name); restricted.push(`${name}（已吊销）`); continue }
            keyCount++
            const mandate = mandates.get(String(key.mandateId ?? ''))
            const level = typeof mandate?.level === 'string' ? TIER_OF_LEVEL[mandate.level as MandateLevel] : undefined
            const tierRaw = level ?? (typeof key.tier === 'string' ? key.tier : typeof key.level === 'string' ? key.level : '')
            const tierZh = tierRaw in AGENT_PERMISSION_TIER_LABELS ? AGENT_PERMISSION_TIER_LABELS[tierRaw as keyof typeof AGENT_PERMISSION_TIER_LABELS] : ''
            const expiresAt = typeof key.expiresAt === 'number' ? key.expiresAt : Number.NaN
            const days = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now) / DAY)) : 0
            const expired = (Number.isFinite(expiresAt) && expiresAt <= now) || mandate?.status === 'expired'
            const suspended = key.status === 'suspended' || mandate?.status === 'suspended'
            if (suspended) restricted.push(`${name}（暂停）`)
            else if (!expired && tierRaw === 'read_only') restricted.push(`${name}（只读）`)
            if (expired) { rows.push(`${name} · 已到期`); rowsEn.push(`${name} · expired`); continue }
            if (Number.isFinite(expiresAt) && expiresAt - now < 7 * DAY) soon = true
            rows.push([name, suspended ? '暂停' : tierZh, `${days} 天后到期`].filter(Boolean).join(' · '))
            rowsEn.push([name, suspended ? 'suspended' : tierRaw, `expires in ${days} d`].filter(Boolean).join(' · '))
          }
          const revokedText = revoked.length ? `已吊销（不再可用）：${revoked.join('、')}` : ''
          if (rows.length === 0) return { ...warn('agentKey', `没有可用的 Agent 钥匙。${revokedText}`, KEYS_NEW_NEXT, `No usable agent key.${revoked.length ? ` Revoked (no longer usable): ${revoked.join(', ')}` : ''}`, KEYS_NEW_NEXT_EN), restricted }
          const text = [rows.join('；'), revokedText].filter(Boolean).join('；')
          const textEn = [rowsEn.join('; '), revoked.length ? `Revoked (no longer usable): ${revoked.join(', ')}` : ''].filter(Boolean).join('; ')
          return soon ? { ...warn('agentKey', `${text}（7 天内到期）`, KEYS_NEW_NEXT, `${textEn} (expires within 7 days)`, KEYS_NEW_NEXT_EN), restricted } : { ...ok('agentKey', text, textEn), restricted }
        }
      } catch { /* 读不到钥匙就按下一条告警 */ }
      return warn('agentKey', 'Agent 钥匙读不出来', KEYS_NEW_NEXT, 'Agent keys cannot be read', KEYS_NEW_NEXT_EN)
    }))
  }

  checks.push(await guarded('tokenFile', () => {
    const dir = join(home, 'agent-tokens')
    let names: string[] = []
    try { names = readdirSync(dir).filter((n) => n.endsWith('.token')) } catch { names = [] }
    if (names.length === 0) {
      return keysKnown && keyCount > 0
        ? ok('tokenFile', '没有令牌文件（可能用环境变量）', 'No token file (you may be using an environment variable)')
        : ok('tokenFile', '没有令牌文件', 'No token file')
    }
    const bad: string[] = []
    const stale: string[] = []
    const now = Date.now()
    for (const name of names) {
      try {
        const text = readFileSync(join(dir, name), 'utf8')
        const lines = text.replace(/\r?\n$/, '').split(/\r\n|\n|\r/)
        if (lines.length !== 1 || (lines[0] ?? '').trim() === '') bad.push(name)
      } catch { bad.push(name) }
      if (keysKnown) {
        // C7：令牌文件对应的钥匙（文件名 = 钥匙名，同名加 -2、-3…）已吊销 / 过期 / 不存在，就别说“正常”
        const base = name.replace(/\.token$/, '').toLowerCase()
        const alt = base.replace(/-\d+$/, '')
        const owners = keyInfo.filter((k) => [base, alt].includes(tokenSafeName(k.name).toLowerCase()))
        if (owners.length === 0) stale.push(`令牌文件找不到对应的钥匙：${name}`)
        else if (!owners.some((k) => k.status !== 'revoked' && k.status !== 'expired' && !(k.expiresAt <= now))) {
          stale.push(`令牌文件对应的钥匙${owners.every((k) => k.status === 'revoked') ? '已吊销' : '已过期'}：${name}`)
        }
      }
    }
    if (stale.length) return warn('tokenFile', [...stale, ...(bad.length ? [`令牌文件有问题：${bad.join('、')}`] : [])].join('；'), '删除这些令牌文件；需要的话重新创建钥匙', `Token files with problems: ${[...stale, ...bad].join(', ')}`, 'Delete these token files; create a new key if you need one')
    return bad.length
      ? warn('tokenFile', `令牌文件有问题：${bad.join('、')}`, '重新创建钥匙', `Token files with problems: ${bad.join(', ')}`, 'Create the key again')
      : ok('tokenFile', `令牌文件正常（${names.length} 个）`, `Token files are fine (${names.length})`)
  }))

  return checks
}

function exitCodeOf(checks: DoctorCheck[]): number {
  if (checks.some((c) => c.level === 'block')) return 2
  if (checks.some((c) => c.level === 'warn')) return 1
  return 0
}

function humanText(checks: DoctorCheck[], en = false): string {
  const lines = checks.map((c) => {
    const text = en ? c.en ?? c.zh : c.zh
    if (c.level === 'ok') return `✔ ${text}`
    const mark = c.level === 'block' ? '✘' : '!'
    return en ? `${mark} ${text}  → Next: ${c.nextEn ?? c.next ?? 'run gitrader doctor again'}` : `${mark} ${text}  → 下一步：${c.next ?? '再运行一次 gitrader doctor'}`
  })
  const pending = checks.filter((c) => c.level !== 'ok').length
  const restricted = checks.flatMap((c) => c.restricted ?? [])
  lines.push(en
    ? (pending > 0 ? `${pending} item${pending === 1 ? '' : 's'} need attention` : restricted.length ? `Environment is fine; ${restricted.length} agent${restricted.length === 1 ? ' is' : 's are'} restricted (see above)` : 'All good, you can start')
    : (pending > 0 ? `有 ${pending} 项需要处理` : restricted.length ? `环境正常；${restricted.length} 个 Agent 受限：${restricted.join('、')}，见上` : '全部正常，可以开始'))
  return `${lines.join('\n')}\n`
}

function jsonText(checks: DoctorCheck[]): string {
  const summary = {
    block: checks.filter((c) => c.level === 'block').length,
    warn: checks.filter((c) => c.level === 'warn').length,
  }
  const rows = checks.map((c) => ({ id: c.id, ok: c.ok, level: c.level, zh: c.zh, ...(c.next !== undefined ? { next: c.next } : {}) }))
  return JSON.stringify({ checks: rows, summary })
}

export async function cmdDoctor(home: string, a: Args, io: CliIo): Promise<number> {
  const checks = await runChecks(home, doctorDeps)
  // --json 给 Agent 读：结论在 summary 里，退出码恒为 0（宿主常把非 0 当工具失败）；人读模式保留 0 / 1 / 2
  if (a.flags.json !== undefined) { io.out(`${applyLauncher(io.env, jsonText(checks), true)}\n`); return 0 }
  io.out(humanText(checks, langOf(io) === 'en'))
  return exitCodeOf(checks)
}
