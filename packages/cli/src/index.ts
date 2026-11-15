// SPDX-License-Identifier: CPAL-1.0
// gitrader 命令行：init | serve | status | open | config | session link | mcp snippet | keys | plugins | engines | ledger | risk | paper reset | bench
//
// 设计：能离线做的事（init / keys / ledger / plugins pin）直接用内核库，不要求服务在跑；需要服务在跑的（status / plugins reload）走本地 HTTP + service.json 令牌。
// 密钥与 PIN 永远不走命令行参数（argv 会进 shell 历史和进程列表），只从终端隐藏输入或 stdin 读。
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  Kernel, KERNEL_VERSION, revokeAgentKeyFully, inspectPluginDir, homePaths, resolveHome, resolveConfinedPath, loadConfig, saveConfig, pinPluginDir, mkOrigin, KernelError, verifyEntries, verifyExport, DEFAULT_PORT_START, formatJsonLog, sqlitePath,
} from '@gitrader/kernel'
import type { LedgerEntry, PaperReplayStart, ReconcileAccountView, ReconcileResolutionInput } from '@gitrader/protocol'
import { asDecimal, dec, humanizeProblem, mcpToolsForLevel, validateReconcileResolutionInput } from '@gitrader/protocol'
import type { DeviceKeyProvider, ExportManifest } from '@gitrader/kernel'
import { ALL_SNIPPET_HOSTS, locateMcpEntry, renderSnippet } from './snippets'
import type { SnippetHostName } from './snippets'
import { assembleConnectors, assembleOfflinePaper } from './connectors'
import { assembleReplay } from './replay'
import { invalidateCachedSession, loginSession, logoutSession, readCachedSession, SessionRequiredError } from './session'
import type { SessionFileOps } from './session'
import { initHomeWithDefaults } from './new-home'
import { cmdDoctor } from './doctor'
import { cmdPinReset } from './pin-reset'
import { cmdStop } from './stop'
import { cmdPaperRebuild } from './paper-rebuild'
import { cmdAgent, findSingleTokenFile } from './agent-call'
import { cmdResearch } from './research'
import { cmdServeDetach } from './serve-detach'
import { cmdKeysNewAgent } from './keys-agent'
import { cmdKeysRotate } from './keys-rotate'
import { cmdSkill } from './skills'
import { LabExport } from '../../kernel/src/lab/export'
import { cmdAccounts } from './accounts'
import { snippetFor } from './snippets'
import { formatRiskStats } from './risk-stats'
import { writeClaudeCodeMcp } from './mcp-write'
import { isWeakPin, pinHint, validatePinShape } from '../../kernel/src/pin'
import { cmdPluginsInstall, cmdExamples } from './bundled'
import { kernelFetch } from '../../mcp/src/local-fetch'
import { applyLauncher, cmdName, fmtLocal, fmtLocalDate, isPinRequired, langOf, pinNeedsHuman, resolveLang, tr } from './lang'
import type { Lang, LangIo } from './lang'

export interface CliIo {
  out(s: string): void
  err(s: string): void
  env: Record<string, string | undefined>
  /** 隐藏输入一行（PIN / 私钥）。测试里注入。 */
  readSecret(prompt: string): Promise<string>
  /** 终端交互？非交互时 init 不问 PIN。 */
  interactive: boolean
  /** stdin 是终端？serve 按 Enter 出新链接只看它（stdout 被管道接走时 interactive 为 false，但 Enter 仍可用）。缺省跟 interactive。 */
  stdinTty?: boolean
  /** `plugins call <id> <tool> -` 读到的 stdin 全文（缺省读 process.stdin）。测试里注入。 */
  readStdin?: () => Promise<string>
  /** 设备密钥的包裹方式（缺省：Windows = DPAPI；其他 = 文件权限）。测试里注入 fileProvider。 */
  deviceKey?: DeviceKeyProvider
  sessionFileOps?: SessionFileOps
  /** 输出语言（main 按 --lang / GITRADER_LANG / 系统 locale 填；没填时各处自己按同一规则取）。 */
  lang?: Lang
  /** 打开浏览器（serve --open 用）。测试里注入；缺省按平台起系统打开命令。 */
  openUrl?: (url: string) => void
}

export const HOSTS = ['claude-code', 'codex', 'hermes', 'unigit'] as const
export type SnippetHost = SnippetHostName

export interface Args { cmd: string[]; flags: Record<string, string | true> }
function parse(argv: string[]): Args {
  const cmd: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith('--')) flags[a.slice(2)] = argv[++i] as string
      else flags[a.slice(2)] = true
    } else cmd.push(a)
  }
  return { cmd, flags }
}
export const flag = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined)

const HELP_BODY = `
  【日常使用 / Everyday】
  gitrader init [--rebuild-config] [--account-id ID]  create ~/.gitrader (gitrader.json + plugins/ engines/ workspaces/ lab/); safe to run again
  gitrader serve [--port N] [--host HOST] [--static DIR] [--offline]
                 [--log-format text|json]
                                                start the local kernel + workbench (default port from ${DEFAULT_PORT_START}; host defaults to loopback; GITRADER_HOST is supported); --offline = no market data connections (also GITRADER_OFFLINE=1)
  gitrader serve --detach [--open]             在后台起服务，打印 2 分钟有效的登录链接后立即返回（日志在 <home>/logs/）；--open 同时自动打开浏览器
  gitrader serve --accept-new-ledger [--reset-paper-state]
                                                账本库不见了、确定从空账本重来；paper-state.json 里还有持仓 / 资金变动时默认拒绝，加 --reset-paper-state 把旧状态移进 backups/ 并按初始资金重来
  gitrader stop                                 停止本机 gitrader 服务（先优雅关闭，15 秒不退才强制结束）
  gitrader doctor [--json]                    新手自检：每项给出下一步命令；退出码 0 全绿 / 1 仅警告 / 2 有阻塞
  gitrader open [--print] [--json]              get a fresh one-time workbench link from the running service (needs your PIN); --print only prints it;
                                                --json prints {"url","expiresAt"} (for hosts / recipes; the PIN can be piped on stdin)
  gitrader open --print --json --unattended --origin <host-origin>
                                                uses the current cached human session; only if embed.allowedOrigins lists <host-origin> can it omit the repeated PIN
                                                (sign in with gitrader session login; PIN-gated actions still require the PIN)
  gitrader session link                         same as: open --print
  gitrader session login                        exchange a one-time boot token for this service session; enter the token when prompted
  gitrader session logout                       revoke this CLI session and remove its local cache
  Login once per service session. Get a one-time boot token from the serve output or press Enter in the running serve terminal.
  Expiry, revocation, or service restart requires a fresh boot token and another login.
  gitrader status [--json]                      查看服务、交易状态（含账户 / 授权书级停机）与账本头
  gitrader config get|set embed.allowedOrigins [origin,origin,...]
                                                origins allowed to embed the workbench in an iframe (https://host[:port]); empty / none = nobody; restart to apply

  【接入 AI / Connect an agent】
  gitrader agent <工具> [<动作>] [--args JSON] [--token-file F]   用 Agent 钥匙调用与 MCP 相同的工具（MCP 还没加载时用）
  gitrader mcp snippet <claude-code|codex|hermes|unigit|cursor|generic> [--token-file F] [--write]   paste-ready MCP config (cursor / generic = the mcpServers JSON; --write merges it into ./.mcp.json for claude-code) (absolute paths; the token is never written into it)
  gitrader skill install <claude-code|codex|hermes|unigit> [--global]   install the onboarding skill where the host reads it (claude-code: .claude/skills, --global = your user dir; codex: $CODEX_HOME/skills, default ~/.codex/skills)
  gitrader keys list                            列出 API 钱包和 Agent 钥匙（名字 / 状态 / 到期日）
  gitrader keys rotate agent <名字或 id> [--token-file F]    换令牌（需 PIN），旧令牌立即失效
  gitrader keys import <name> [--network testnet|mainnet]    import an API wallet (private key read from the terminal, never argv)
  gitrader keys new wallet <name> [--days N] [--network ...] generate an API wallet (prints the address; the key never leaves the keystore)
  gitrader keys new agent <name> --host <h> [--preset starter | --tier <read_only|paper|confirm|auto_limited>] [--token-file [F]] [--accounts a,b] [--venues v] [--instruments i,j]
                                [--max-order N] [--max-daily N] [--max-daily-loss N] [--auto-max N]
  gitrader keys revoke <wallet|agent> <名字或 id>         吊销一把 API 钱包或 Agent 钥匙（需 PIN）

  【对账与账本 / Reconcile & ledger】
  gitrader reconcile status [--account <alias|id>] [--json]  查看对账待处理项（默认中文；服务需运行）
  gitrader reconcile refresh --account <alias|id>            刷新一个账户的对账证据（需登录）
  gitrader reconcile confirm <@file|json>                    用 PIN 确认已核对的成交建议
  gitrader reconcile resolve --item <id> --action <reject|acknowledge> --reason <理由> [--account <alias|id>]
                                                处理当前待审项；旧的六字段 JSON 入参仍兼容（需登录 + PIN）
  gitrader reconcile resolve <@file|json>        兼容旧的六字段 JSON 输入
  gitrader reconcile resume --account <alias|id> --reason <text>  单独恢复一个账户（需登录 + PIN）
  gitrader ledger verify [--json]               recompute the hash chain
  gitrader ledger export [--out 名字] [--redact]          导出 JSONL + 清单 + Markdown 交易记录（写到 <数据目录>/exports/<名字>；名字只能是相对名字）

  【研究与实验 / Research】
  gitrader research optimize --strategy <id> --space <@文件|JSON> --validation <holdout:N|wf:训练:测试[:步长]> [--instrument <id>] [--interval <iv>] [--from <毫秒|ISO>] [--to <毫秒|ISO>] [--data <csv>] [--search grid|random:N|evolution] [--seed N] [--fee <taker>] [--slippage <bps>] [--no-wait] [--json]
                                                参数寻优（只读研究，不下单）：默认等作业跑完；--json 只打印一个 JSON（含 jobId）；--no-wait 只打印 {jobId, kind, state}
  gitrader research walk-forward ...            同 research optimize，--validation 必须是 wf:…（滚动样本外验证）
  gitrader research factors --instrument <id> --interval <iv> [--from <毫秒|ISO> --to <毫秒|ISO> | --data <csv>] [--horizon N] [--window N] [--json]   因子报告（t 值用 Newey-West）
  gitrader research report <回测作业 id> [--format md|json] [--out <文件>]   回测报告（指标 + Markdown）
  gitrader research portfolio [--account <id>] [--json]                      组合分析（估值 / 敞口 / 集中度）
  gitrader research search <词> [--limit N] [--json]                          标的搜索
  gitrader research status <作业 id> [--json]   |   gitrader research result <作业 id> [--part trials|folds|factors] [--limit N] [--cursor C] [--json]   |   gitrader research cancel <作业 id>
  gitrader lab export <id> [--out FILE] | verify <file>   export a local experiment bundle (stdout, or FILE = any path) / verify one (a relative path is read from <home>/lab; an absolute path can be anywhere)
  gitrader lab pack <experimentId> --run <runId> [--holdout <fromMs>,<toMs>] [--note <text>] | attach <experimentId> --engine <engineId> --instance <instanceId> --account <alias|id>   freeze the holdout / attach a live engine run (running service required)
  gitrader examples list | copy <名>           list or copy bundled example strategies

  【其它 / More】
  gitrader pin reset                            忘了 PIN：备份并停用钥匙库、吊销全部 AI 钥匙，保留账本与签名身份（只能在本机终端由本人操作）
  gitrader plugins list | reload | pin <dir> | check <dir> [--strict] [--json] | grant <id> [perm...] | call <id> <tool> [json] | install [<名>]
  gitrader notify test <channelId>             send a fixed info diagnostic to a configured notification channel
  gitrader engines list | bind <engine-id> [--account <alias|id>]   bind an engine to an account (paper by default; PIN)
  gitrader accounts watch <0xaddress> [--alias NAME] [--network mainnet|testnet]   add a read-only watch account: positions and balances of a public address, no key, can never trade
  gitrader paper reset [--account <alias|id>]   reset a paper account explicitly (PIN; running service required)
  gitrader paper rebuild-from-ledger [--yes]    rebuild paper-state.json from the ledger (service must be stopped)
  gitrader risk verify [precheckId] | replay <precheckId> | stats | policy export
  gitrader risk relax <@file|json> [--hours N | --permanent]
                                                临时放宽限额（PIN）：默认 4 小时，最长 24 小时，到期自动收回；--permanent 才永久修改上限

  global: --home DIR   (or GITRADER_HOME)
`

const HELP_QUICK = `gitrader ${KERNEL_VERSION}

快速开始（首次使用依次运行）：
  gitrader init                                 初始化数据目录
  gitrader serve --detach --open                后台启动服务并自动打开浏览器（也可去掉 --open，改用打印出的登录链接）
  gitrader doctor                               自检；每一项都给出下一步
  gitrader keys new agent <名字> --host claude-code --preset starter --token-file   给 AI 建一把钥匙
`

const HELP_BODY_EN = `
  [Everyday]
  gitrader init [--rebuild-config] [--account-id ID]   create the data directory (default ~/.gitrader); safe to run again
  gitrader serve [--port N] [--host HOST] [--static DIR] [--offline] [--log-format text|json]
                                                start the local kernel + workbench (default port from ${DEFAULT_PORT_START}; loopback only unless --host; GITRADER_HOST works too);
                                                --offline = no market-data connections (also GITRADER_OFFLINE=1)
  gitrader serve --detach [--open]              start in the background, print a 2-minute login link and return (logs in <home>/logs/); --open also opens the browser
  gitrader serve --accept-new-ledger [--reset-paper-state]
                                                the ledger database is gone and you really want a fresh one; if paper-state.json still holds positions / fund moves
                                                this refuses unless --reset-paper-state is added (the old state is moved to backups/ and paper restarts from the initial balance)
  gitrader stop                                 stop the local service (graceful first, forced after 15 s)
  gitrader doctor [--json]                      health check with a next step for every item; exit 0 = all good / 1 = warnings / 2 = blocking
  gitrader open [--print] [--json]              get a fresh one-time workbench link from the running service (needs your PIN); --print only prints it;
                                                --json prints {"url","expiresAt"} (the PIN can be piped on stdin)
  gitrader open --print --json --unattended --origin <host-origin>
                                                uses the current cached human session; only if embed.allowedOrigins lists <host-origin> can it omit the repeated PIN
  gitrader config get|set embed.allowedOrigins [origin,origin,...]
                                                origins allowed to embed the workbench in an iframe (https://host[:port]); empty / none = nobody; restart to apply
  gitrader session link                         same as: open --print
  gitrader session login                        exchange a one-time boot token (or the whole launch link) for a CLI session
  gitrader session logout                       revoke this CLI session and remove its local cache
  gitrader status [--json]                      service, trading state (incl. account / mandate level halts) and ledger head

  [Connect an agent]
  gitrader agent <tool> [<action>] [--args JSON] [--token-file F]   call the same tools as MCP with an agent key (use it before MCP is loaded)
  gitrader mcp snippet <claude-code|codex|hermes|unigit|cursor|generic> [--token-file F] [--write]
                                                paste-ready MCP config with absolute paths (the token is never written into it); --write merges it into ./.mcp.json for claude-code
  gitrader skill install <claude-code|codex|hermes|unigit> [--global]   install the onboarding skill where the host reads it
  gitrader keys list                            list API wallets and agent keys (name / status / expiry)
  gitrader keys new agent <name> --host <h> [--preset starter | --tier <read_only|paper|confirm|auto_limited>] [--token-file [F]] [--accounts a,b] [--venues v] [--instruments i,j]
                                [--max-order N] [--max-daily N] [--max-daily-loss N] [--auto-max N]
  gitrader keys rotate agent <name|id> [--token-file F]   replace the token (PIN); the old one stops working at once
  gitrader keys revoke <wallet|agent> <name|id>           revoke an API wallet or an agent key (PIN)
  gitrader keys import <name> [--network testnet|mainnet]    import an API wallet (private key read from the terminal, never argv)
  gitrader keys new wallet <name> [--days N] [--network ...] generate an API wallet (prints the address; the key never leaves the keystore)

  [Reconcile & ledger]
  gitrader reconcile status [--account <alias|id>] [--json]  show pending reconciliation items (running service needed)
  gitrader reconcile refresh --account <alias|id>            refresh the reconciliation evidence of one account (login needed)
  gitrader reconcile confirm <@file|json>                    confirm a reviewed fill suggestion with your PIN
  gitrader reconcile resolve --item <id> --action <reject|acknowledge> --reason <reason> [--account <alias|id>]
                                                resolve the current pending item (login + PIN)
  gitrader reconcile resolve <@file|json>        legacy six-field JSON input
  gitrader reconcile resume --account <alias|id> --reason <text>  resume one account on its own (login + PIN)
  gitrader ledger verify [--json]               recompute the hash chain
  gitrader ledger export [--out NAME] [--redact]          export JSONL + manifest + Markdown records to <home>/exports/<NAME> (relative names only)

  [Research & experiments]
  gitrader research optimize --strategy <id> --space <@file|JSON> --validation <holdout:N|wf:train:test[:step]> [--instrument <id>] [--interval <iv>] [--from <ms|ISO>] [--to <ms|ISO>] [--data <csv>] [--search grid|random:N|evolution] [--seed N] [--fee <taker>] [--slippage <bps>] [--no-wait] [--json]
                                                parameter search (read-only research, never trades); waits for the job unless --no-wait
  gitrader research walk-forward ...            same as research optimize, --validation must be wf:...
  gitrader research factors --instrument <id> --interval <iv> [--from <ms|ISO> --to <ms|ISO> | --data <csv>] [--horizon N] [--window N] [--json]
  gitrader research report <backtest-job-id> [--format md|json] [--out <file>]
  gitrader research portfolio [--account <id>] [--json]
  gitrader research search <text> [--limit N] [--json]
  gitrader research status <job-id> [--json]   |   gitrader research result <job-id> [--part trials|folds|factors] [--limit N] [--cursor C] [--json]   |   gitrader research cancel <job-id>
  gitrader lab export <id> [--out FILE] | verify <file>   export a local experiment bundle / verify one
  gitrader lab pack <experimentId> --run <runId> [--holdout <fromMs>,<toMs>] [--note <text>] | attach <experimentId> --engine <engineId> --instance <instanceId> --account <alias|id>   (running service required)
  gitrader examples list | copy <name>          list or copy bundled example strategies

  [More]
  gitrader pin reset                            forgot your PIN: back up and disable the keystore, revoke every agent key, keep the ledger (local terminal only)
  gitrader plugins list | reload | pin <dir> | check <dir> [--strict] [--json] | grant <id> [perm...] | call <id> <tool> [json] | install [<name>]
  gitrader notify test <channelId>             send a fixed diagnostic message to a configured notification channel
  gitrader engines list | bind <engine-id> [--account <alias|id>]   bind an engine to an account (paper by default; PIN)
  gitrader accounts watch <0xaddress> [--alias NAME] [--network mainnet|testnet]   add a read-only watch account (no key, can never trade)
  gitrader paper reset [--account <alias|id>]   reset a paper account explicitly (PIN; running service required)
  gitrader paper rebuild-from-ledger [--yes]    rebuild paper-state.json from the ledger (service must be stopped)
  gitrader risk verify [precheckId] | replay <precheckId> | stats | policy export
  gitrader risk relax <@file|json> [--hours N | --permanent]   temporarily relax limits (PIN): 4 h by default, 24 h at most; --permanent changes the limit for good

  global: --home DIR (or GITRADER_HOME)   --lang zh|en (or GITRADER_LANG)
`

const HELP_QUICK_EN = `gitrader ${KERNEL_VERSION}

Quick start (run these in order the first time):
  gitrader init                                 create the data directory
  gitrader serve --detach --open                start in the background and open the browser (drop --open to use the printed login link)
  gitrader doctor                               health check; every item comes with a next step
  gitrader keys new agent <name> --host claude-code --preset starter --token-file   create a key for your AI
`

const helpFor = (io: LangIo): { quick: string; body: string } => (langOf(io) === 'en' ? { quick: HELP_QUICK_EN, body: HELP_BODY_EN } : { quick: HELP_QUICK, body: HELP_BODY })
/** 取出和命令词匹配的帮助块（首行 + 它的续行）；词越多越精确，匹配不到就退一个词。 */
function helpLinesFor(body: string, words: string[]): string[] {
  const lines = body.split('\n')
  for (let n = words.length; n >= 1; n--) {
    const pattern = new RegExp(`(^|\\s)gitrader ${words.slice(0, n).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ')}(\\s|$)`)
    const out: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (!/^ {2}gitrader /.test(lines[i]!) || !pattern.test(lines[i]!)) continue
      out.push(lines[i]!)
      while (i + 1 < lines.length && /^ {3,}\S/.test(lines[i + 1]!)) out.push(lines[++i]!)
    }
    if (out.length) return out
  }
  return []
}
const helpText = (io: LangIo): string => { const h = helpFor(io); return `${h.quick}${h.body}` }

/** 没有在运行的服务（中文后括号英文，保持原有双语报错的写法）。 */
const noServiceMsg = (io: LangIo): string => tr(io, '没有在运行的服务（No running Gitrader service for this home）。先运行：gitrader serve', 'No running Gitrader service for this home. Start it with: gitrader serve')

/** 设了 GITRADER_LAUNCHER（便携包）时，把输出里的「gitrader <子命令>」换成启动器名；JSON 输出不动。 */
function launcherIo(io: CliIo): CliIo {
  const l = cmdName(io.env)
  if (l === 'gitrader') return io
  const fix = (s: string): string => (/^\s*[[{]/.test(s) ? s : applyLauncher(io.env, s))
  return { ...io, out: (s) => io.out(fix(s)), err: (s) => io.err(fix(s)) }
}

/** 用系统默认方式打开链接（serve --open / open 共用）。 */
function openBrowser(io: CliIo, url: string): void {
  if (io.openUrl) { io.openUrl(url); return }
  void import('node:child_process').then(({ spawn }) => {
    // GITRADER_OPEN_COMMAND：自定义“打开链接”的命令行（链接会作为最后一个参数追加，加了双引号）；也用于验证时不真拉起浏览器
    const custom = io.env.GITRADER_OPEN_COMMAND
    const [c, args] = custom ? [`${custom} "${url}"`, []] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
    // 打不开（没有 xdg-open 等）不能拖垮 serve：链接已经打印在上面，用户可以手动粘贴
    spawn(c as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true, shell: !!custom }).on('error', () => undefined).unref()
  }, () => io.out(`${url}\n`))
}

// ---- 服务发现 ----------------------------------------------------------------------
export interface ServiceInfo { port: number; pid: number; token: string; startedAt: number; version: string }
export interface LiveServiceInfo extends ServiceInfo { baseUrl: string }
export function readService(home: string): ServiceInfo | null {
  try { const j = JSON.parse(readFileSync(homePaths(home).service, 'utf8')) as ServiceInfo; return j && Number.isInteger(j.port) && typeof j.token === 'string' ? j : null } catch { return null }
}
export function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
export async function liveService(home: string): Promise<LiveServiceInfo | null> {
  const s = readService(home)
  if (!s || !pidAlive(s.pid)) return null
  const baseUrl = `http://127.0.0.1:${s.port}`
  for (let i = 0; i < 2; i++) { // 同一进程里复用过旧连接时第一次可能被重置，重试一次
    try {
      const r = await kernelFetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) })
      const j = (await r.json()) as { ok?: boolean; startedAt?: number }
      return j.ok && (s.startedAt === undefined || j.startedAt === s.startedAt) ? { ...s, baseUrl } : null
    } catch { /* retry */ }
  }
  return null
}
type ServiceAccess = 'read' | 'write'
function cachedWriteSession(home: string, service: LiveServiceInfo) {
  return readCachedSession(home, { baseUrl: service.baseUrl, startedAt: service.startedAt })
}
export async function callOp(home: string, s: LiveServiceInfo, name: string, access: ServiceAccess, params: Record<string, unknown> = {}, pin?: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const session = access === 'write' ? cachedWriteSession(home, s) : undefined
  const token = session?.sessionToken ?? s.token
  const r = await kernelFetch(`http://127.0.0.1:${s.port}/api/op/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(pin ? { 'x-gitrader-pin': pin } : {}) }, body: JSON.stringify({ params }), signal: AbortSignal.timeout(name === 'notify.test' ? 30_000 : 15_000) })
  if (r.status === 401 && session) {
    invalidateCachedSession(home, session.sessionToken)
    throw new SessionRequiredError('invalid')
  }
  const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { message: string; code: number } }
  if (!j.ok) throw Object.assign(new Error(`${name}: ${j.error?.message ?? r.status} (${j.error?.code ?? ''})`), { problem: j.error })
  return j.result
}
/** service 令牌直调（只读查询，以及 ADR-13 接入请求的发起 / 查状态）：doctor、keys new agent 用。写操作走 callOp(home, …, 'write')。 */
export function serviceOp(s: ServiceInfo, name: string, params: Record<string, unknown> = {}, pin?: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return callOp('', { ...s, baseUrl: `http://127.0.0.1:${s.port}` }, name, 'read', params, pin)
}

type ReconcileAccountRef = { accountId: string; alias: string }
const RECONCILE_CONFIRM_FIELDS = ['accountId', 'offerId', 'reportId', 'suggestionId', 'fee', 'feeCcy', 'liquidity', 'realizedPnl'] as const
const RECONCILE_RESOLUTION_FIELDS = ['accountId', 'itemId', 'evidenceDigest', 'action', 'reason', 'requestId'] as const

function checkReconcileFlags(a: Args, allowed: readonly string[], booleanFlags: readonly string[] = []): void {
  for (const [name, value] of Object.entries(a.flags)) {
    if (!allowed.includes(name)) throw new Error(`unknown flag --${name}`)
    if (value === true) {
      if (booleanFlags.includes(name)) continue
      throw new Error(`--${name} requires a value`)
    }
    if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} requires a value`)
  }
}

async function resolveReconcileAccount(home: string, service: LiveServiceInfo, wanted: string): Promise<ReconcileAccountRef> {
  const accounts = await callOp(home, service, 'account.list', 'read') as ReconcileAccountRef[]
  const matches = accounts.filter((account) => account.accountId === wanted || account.alias === wanted)
  if (matches.length === 0) throw new Error(`unknown account: ${wanted}`)
  if (matches.length > 1) throw new Error(`ambiguous account: ${wanted}`)
  return matches[0]!
}

function parseReconcileConfirmInput(raw: string): Record<(typeof RECONCILE_CONFIRM_FIELDS)[number], string> {
  let source = raw
  if (source.startsWith('@')) {
    try { source = readFileSync(resolve(source.slice(1)), 'utf8') }
    catch { throw new Error('cannot read confirmation JSON input') }
  }
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch { throw new Error('confirmation input must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('confirmation input must be a JSON object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== RECONCILE_CONFIRM_FIELDS.length || RECONCILE_CONFIRM_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error('confirmation input must contain exactly the eight documented fields')
  }
  for (const key of ['accountId', 'offerId', 'reportId', 'suggestionId'] as const) {
    if (typeof record[key] !== 'string' || record[key].trim().length === 0) throw new Error(`${key} must be a non-empty string`)
  }
  let fee: string
  let realizedPnl: string
  try {
    fee = asDecimal(record.fee as string)
    realizedPnl = asDecimal(record.realizedPnl as string)
  } catch { throw new Error('fee and realizedPnl must be canonical decimal strings') }
  if (dec.cmpDec(fee, '0') < 0) throw new Error('fee must be non-negative')
  if (typeof record.feeCcy !== 'string' || !/^[A-Z0-9]{1,20}$/.test(record.feeCcy)) throw new Error('feeCcy must be 1-20 uppercase letters or digits')
  if (record.liquidity !== 'maker' && record.liquidity !== 'taker') throw new Error('liquidity must be maker or taker')
  return {
    accountId: record.accountId as string,
    offerId: record.offerId as string,
    reportId: record.reportId as string,
    suggestionId: record.suggestionId as string,
    fee,
    feeCcy: record.feeCcy,
    liquidity: record.liquidity,
    realizedPnl,
  }
}

function parseReconcileResolutionInput(raw: string): ReconcileResolutionInput {
  let source = raw
  if (source.startsWith('@')) {
    try { source = readFileSync(resolve(source.slice(1)), 'utf8') }
    catch { throw new Error('cannot read reconciliation resolution JSON input') }
  }
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch { throw new Error('reconciliation resolution input must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reconciliation resolution input must be a JSON object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== RECONCILE_RESOLUTION_FIELDS.length || RECONCILE_RESOLUTION_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error('reconciliation resolution input must contain exactly the six documented fields')
  }
  const checked = validateReconcileResolutionInput(record)
  if (!checked.ok || checked.value.reason.trim().length === 0) throw new Error('reconciliation resolution input is invalid')
  return checked.value
}

async function statusReviews(home: string, service: LiveServiceInfo, accountId: string): Promise<ReconcileAccountView> {
  const views = await callOp(home, service, 'reconcile.status', 'write', { accountId }) as ReconcileAccountView[]
  const view = views.find((candidate) => candidate.accountId === accountId)
  if (!view) throw new Error('reconciliation status is unavailable for the requested account')
  return view
}

function currentBlockingReviews(view: ReconcileAccountView): NonNullable<ReconcileAccountView['reviews']> {
  return (view.reviews ?? []).filter((item) => item.blocking && item.resolution === undefined && item.confirmedFillId === undefined)
}

function reconcileActions(kind: NonNullable<ReconcileAccountView['reviews']>[number]['kind']): Array<'reject' | 'acknowledge'> {
  return kind === 'inferred_fill' ? ['reject'] : ['acknowledge']
}

function reconcileProblemLabel(code: string | undefined, kind?: string): string {
  const labels: Record<string, string> = {
    inferred_fill: '待确认的推断成交', known_difference: '已记录的对账差异', late_real_fill: '发现较晚到达的真实成交',
    confirmation_effects: '成交确认后的影响待检查', fill_missing_inferred: '场所成交尚未记入本地账本',
    position_size_mismatch: '持仓数量不一致', position_missing_at_venue: '场所未返回本地持仓',
    position_missing_locally: '场所持仓未记入本地', position_side_mismatch: '持仓方向不一致',
    order_venue_id_conflict: '订单与场所单号冲突', fill_conflict: '成交记录冲突', fill_duplicate: '发现重复成交',
    fill_orphan: '成交未关联订单', fill_missing_unexplained: '成交数量差异无法解释', venue_report_unavailable: '场所报告不可用',
    snapshot_stale: '场所快照已过期', venue_fills_truncated: '场所成交记录不完整',
  }
  if (code && labels[code]) return labels[code]!
  if (kind && labels[kind]) return labels[kind]!
  return code ? `对账差异（${code}）` : '对账差异'
}

function renderReconcileStatus(views: ReconcileAccountView[], aliases: Map<string, string>): string {
  const lines: string[] = []
  for (const view of views) {
    const alias = aliases.get(view.accountId) ?? view.accountId
    lines.push(`账户：${alias}（${view.accountId}）`)
    const pending = currentBlockingReviews(view)
    if (pending.length > 0) lines.push('待处理对账项：')
    const representedFindings = new Set((view.reviews ?? []).map((item) => item.finding?.id).filter((id): id is string => Boolean(id)))
    for (const item of pending) {
      const actions = reconcileActions(item.kind)
      const evidence = item.finding?.evidence?.map((entry) => `${entry.report}.${entry.field}=${entry.value}`).join('；')
        || item.suggestion?.basis?.join('；') || item.summary
      const actionText = actions.map((action) => action === 'reject' ? '拒绝推断成交（reject）' : '标记已处理（acknowledge）').join(' / ')
      const reason = '<填写处理理由>'
      lines.push(`- ${reconcileProblemLabel(item.finding?.code, item.kind)}；项目：${item.itemId}`)
      lines.push(`  证据：${evidence}`)
      lines.push(`  可选动作：${actionText}`)
      lines.push(`  下一步：gitrader reconcile resolve --item ${item.itemId} --action ${actions[0]} --reason "${reason}"`)
      representedFindings.add(item.finding?.id ?? '')
    }
    const unmanaged = view.findings.filter((finding) => finding.severity === 'blocker' && !representedFindings.has(finding.id))
    for (const finding of unmanaged) {
      const evidence = finding.evidence.map((entry) => `${entry.report}.${entry.field}=${entry.value}`).join('；') || finding.detail
      lines.push(`- ${reconcileProblemLabel(finding.code)}；未关联可处理项目`)
      lines.push(`  证据：${evidence}`)
      lines.push(`  下一步：gitrader reconcile refresh --account ${alias}，再运行 gitrader reconcile status。`)
    }
    if (pending.length === 0 && unmanaged.length === 0) lines.push('  无待处理对账项。')
    if (view.state === 'unavailable') lines.push(`  当前状态：对账数据不可用${view.problem?.message ? `（${view.problem.message}）` : ''}；先运行 gitrader reconcile refresh。`)
  }
  return `${lines.join('\n')}\n`
}

function actionableReviewChoices(views: ReconcileAccountView[], aliases: Map<string, string>): string {
  const choices = views.flatMap((view) => (view.reviews ?? []).filter((item) => item.resolution === undefined && item.confirmedFillId === undefined).flatMap((item) => {
    const ids = item.finding?.id && item.finding.id !== item.itemId ? [item.itemId, item.finding.id] : [item.itemId]
    return ids.map((id) => `${id}（${aliases.get(view.accountId) ?? view.accountId}：${reconcileActions(item.kind).join('/')}）`)
  }))
  return choices.length ? choices.join('、') : '无可处理项目'
}

async function cmdReconcile(home: string, a: Args, io: CliIo): Promise<number> {
  const sub = a.cmd[1]
  if (sub === 'status') {
    if (a.cmd.length !== 2) throw new Error('用法：gitrader reconcile status [--account <别名|账户ID>] [--json]')
    checkReconcileFlags(a, ['home', 'account', 'json'], ['json'])
    if (a.flags.json !== undefined && a.flags.json !== true) throw new Error('--json 是不带值的开关')
    const service = await liveService(home)
    if (!service) throw new Error('查看对账状态前，请先启动本机服务')
    const wanted = flag(a, 'account')
    const account = wanted === undefined ? undefined : await resolveReconcileAccount(home, service, wanted)
    const result = await callOp(home, service, 'reconcile.status', 'read', account ? { accountId: account.accountId } : {}) as ReconcileAccountView[]
    if (a.flags.json === true) io.out(`${JSON.stringify(result, null, 2)}\n`)
    else {
      const accounts = await callOp(home, service, 'account.list', 'read') as ReconcileAccountRef[]
      io.out(renderReconcileStatus(result, new Map(accounts.map((item) => [item.accountId, item.alias]))))
    }
    return 0
  }
  if (sub === 'refresh') {
    if (a.cmd.length !== 2) throw new Error('usage: gitrader reconcile refresh --account <alias|id>')
    checkReconcileFlags(a, ['home', 'account'])
    const wanted = flag(a, 'account')
    if (!wanted) throw new Error('reconcile refresh requires --account <alias|id>')
    const service = await liveService(home)
    if (!service) throw new Error('start the local service before refreshing reconciliation evidence')
    cachedWriteSession(home, service)
    const account = await resolveReconcileAccount(home, service, wanted)
    const result = await callOp(home, service, 'reconcile.refresh', 'write', { accountId: account.accountId })
    io.out(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  if (sub === 'confirm') {
    if (a.cmd.length !== 3 || !a.cmd[2]) throw new Error('usage: gitrader reconcile confirm <@file|json>')
    checkReconcileFlags(a, ['home'])
    const input = parseReconcileConfirmInput(a.cmd[2])
    const service = await liveService(home)
    if (!service) throw new Error('start the local service before confirming reconciliation')
    cachedWriteSession(home, service)
    io.out(`${JSON.stringify(input, null, 2)}\n`)
    const pin = await io.readSecret('PIN: ')
    const result = await callOp(home, service, 'reconcile.confirm', 'write', input, pin)
    io.out(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  if (sub === 'resolve') {
    if (a.cmd.length !== 2 && (a.cmd.length !== 3 || !a.cmd[2])) throw new Error('用法：gitrader reconcile resolve --item <项目ID> --action <reject|acknowledge> --reason <理由> [--account <别名|账户ID>]，或传入旧的六字段 JSON')
    let legacyInput: ReconcileResolutionInput | undefined
    let itemId: string
    let action: 'reject' | 'acknowledge'
    let reason: string
    let wantedAccount: string | undefined
    if (a.cmd.length === 3) {
      checkReconcileFlags(a, ['home'])
      legacyInput = parseReconcileResolutionInput(a.cmd[2]!)
      itemId = legacyInput.itemId; action = legacyInput.action; reason = legacyInput.reason
    } else {
      checkReconcileFlags(a, ['home', 'item', 'action', 'reason', 'account'])
      itemId = flag(a, 'item') ?? ''
      const selectedAction = flag(a, 'action')
      reason = flag(a, 'reason') ?? ''
      wantedAccount = flag(a, 'account')
      if (!itemId || !selectedAction || !reason.trim() || reason.length > 500) throw new Error('请提供 --item、--action 和 1 至 500 个非空白字符的 --reason')
      if (selectedAction !== 'reject' && selectedAction !== 'acknowledge') throw new Error('--action 只能是 reject 或 acknowledge；请从当前待处理项目及允许动作中选择')
      action = selectedAction
    }
    const service = await liveService(home)
    if (!service) throw new Error('处理对账项目之前，请先启动本机服务')
    cachedWriteSession(home, service)
    let views = await callOp(home, service, 'reconcile.status', 'write', wantedAccount ? { accountId: (await resolveReconcileAccount(home, service, wantedAccount)).accountId } : {}) as ReconcileAccountView[]
    if (legacyInput) views = views.filter((view) => view.accountId === legacyInput!.accountId)
    const aliases = new Map((await callOp(home, service, 'account.list', 'read') as ReconcileAccountRef[]).map((account) => [account.accountId, account.alias]))
    const matches = views.flatMap((view) => (view.reviews ?? []).filter((item) => {
      if (legacyInput) return item.itemId === itemId
      return item.resolution === undefined && item.confirmedFillId === undefined && (item.itemId === itemId || item.finding?.id === itemId)
    }).map((item) => ({ view, item })))
    const choiceText = actionableReviewChoices(views, aliases)
    if (matches.length !== 1) throw new Error(`没有找到唯一的当前待处理项目“${itemId}”。可处理项目及动作：${choiceText}`)
    const { view, item } = matches[0]!
    const actions = reconcileActions(item.kind)
    if (!actions.includes(action)) {
      throw new Error(`项目“${itemId}”不允许动作“${action}”。可处理项目及动作：${choiceText}`)
    }
    const input: ReconcileResolutionInput = legacyInput ?? { accountId: view.accountId, itemId: item.itemId,
      evidenceDigest: item.evidenceDigest, action, reason, requestId: randomUUID() }
    if (legacyInput && item.evidenceDigest !== legacyInput.evidenceDigest) throw new Error(`项目证据已变化，请重新查看。可处理项目及动作：${choiceText}`)
    io.out(`${JSON.stringify({ review: item, decision: input }, null, 2)}\n`)
    const pin = await io.readSecret('PIN: ')
    const result = await callOp(home, service, 'reconcile.resolve', 'write', input as unknown as Record<string, unknown>, pin)
    io.out(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  if (sub === 'resume') {
    if (a.cmd.length !== 2) throw new Error('usage: gitrader reconcile resume --account <alias|id> --reason <text>')
    checkReconcileFlags(a, ['home', 'account', 'reason'])
    const wanted = flag(a, 'account')
    const reason = flag(a, 'reason')
    if (!wanted || !reason?.trim() || reason.length > 500) throw new Error('reconcile resume requires a nonblank --account and a 1-500 character --reason')
    const service = await liveService(home)
    if (!service) throw new Error('start the local service before resuming trading')
    cachedWriteSession(home, service)
    const account = await resolveReconcileAccount(home, service, wanted)
    const view = await statusReviews(home, service, account.accountId)
    io.out(`${JSON.stringify({ accountId: account.accountId, alias: account.alias, reason,
      state: view.state, findings: view.findings, reviews: view.reviews ?? [] }, null, 2)}\n`)
    const pin = await io.readSecret('PIN: ')
    const result = await callOp(home, service, 'trading_state.resume', 'write', {
      scope: { type: 'account', id: account.accountId }, reason,
    }, pin)
    io.out(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  throw new Error('用法：gitrader reconcile status [--account <别名|账户ID>] [--json] | refresh --account <别名|账户ID> | confirm <@file|json> | resolve --item <项目ID> --action <reject|acknowledge> --reason <理由> | resume --account <别名|账户ID> --reason <理由>')
}

// ---- 离线打开内核 ---------------------------------------------------------------------
export async function openKernel(home: string, io: CliIo): Promise<Kernel> {
  return Kernel.create({ home, log: (m) => io.err(m), timers: false, resolveSecret: ref => ref.startsWith('env:') ? io.env[ref.slice(4)] || undefined : undefined, ...(io.deviceKey ? { deviceKeyProvider: io.deviceKey } : {}) })
}

const PIN_SETUP_PROMPT = '设置 PIN（6–12 位数字，或 8–64 位口令；越长越安全）：'
const PIN_REPEAT_PROMPT = '再输一遍：'
const PIN_WEAK_PROMPT = '这个 PIN 容易被猜到，仍要使用吗？(y/N) '
const PIN_LONGER_HINT = '更长的 PIN 更安全：建议 10 位以上数字或 8–64 位口令'

async function readAllStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  return text
}

export async function needPin(k: Kernel, io: CliIo): Promise<Awaited<ReturnType<Kernel['auth']['pinProofLocalTerminal']>>> {
  let proof: Awaited<ReturnType<Kernel['auth']['pinProofLocalTerminal']>>
  if (!k.pin.isSet()) {
    if (!io.interactive && !io.env.GITRADER_PIN_STDIN) throw new Error(tr(io, '还没有设置 PIN（no PIN is set yet）。请在终端运行 gitrader init 设置 PIN。', 'No PIN is set yet. Run `gitrader init` in a terminal to set one.'))
    // PIN_STDIN：整块读 stdin 再按行取，避免非 TTY 下第二次 readSecret 读不到。
    const lines = io.env.GITRADER_PIN_STDIN ? (io.readStdin ? await io.readStdin() : await readAllStdin()).split(/\r?\n/) : undefined
    let nextLine = 0
    const readPin = async (prompt: string): Promise<string> => (lines ? lines[nextLine++] ?? '' : await io.readSecret(prompt))
    const readAnswer = async (prompt: string): Promise<string> => {
      const reader = (io as CliIo & { readLine?: (prompt: string) => Promise<string> }).readLine
      return reader ? await reader(prompt) : await io.readSecret(prompt)
    }
    let first = ''
    let accepted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      first = await readPin(PIN_SETUP_PROMPT)
      const reason = validatePinShape(first)
      if (reason) { io.err(`${reason}\n`); continue }
      if (isWeakPin(first) && !/^y$/i.test((await readAnswer(PIN_WEAK_PROMPT)).trim())) continue
      accepted = true
      break
    }
    if (!accepted) throw new Error('PIN 设置未完成：连续 3 次格式不对。')
    let matched = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const second = await readPin(PIN_REPEAT_PROMPT)
      if (second === first) { matched = true; break }
      io.err('两次输入不一致，请重输第二遍（PINs do not match）\n')
    }
    if (!matched) throw new Error('PIN 设置未完成：连续 3 次输入不一致。')
    proof = await k.auth.setupPinLocalTerminal(first)
    io.out('PIN 已设置 (PIN set)。\n')
    if (pinHint(first)) io.out(`${PIN_LONGER_HINT}\n`)
  } else proof = await k.auth.pinProofLocalTerminal(await io.readSecret('PIN：'))
  k.keystore.unlock(proof) // 密钥库解锁本身走 PIN；解锁后导入 / 生成凭据只要会话
  return proof
}

const INIT_HELP = `gitrader init

  创建 ~/.gitrader 目录（gitrader.json + plugins/ engines/ workspaces/ lab/）；可重复运行，已存在的文件不动。

  选项：
    --no-pin            不在这里设 PIN，稍后在浏览器里设
    --rebuild-config    配置整份不见但目录已用过时，明确同意用默认配置重建（沿用账本里已有的纸面账户 id）
    --account-id ID     重建时有多个候选账户 id，指定沿用哪一个
    --home DIR          指定主目录（或 GITRADER_HOME）
`

// ---- 命令 ---------------------------------------------------------------------------
export async function main(argv: string[], io: CliIo): Promise<number> {
  const a = parse(argv)
  const lang = resolveLang(a.flags.lang, io.env) // K3：--lang → GITRADER_LANG → 系统 locale
  delete a.flags.lang
  io = launcherIo({ ...io, lang })
  const home = resolveHome(flag(a, 'home'), io.env)
  const [c0, c1, c2] = a.cmd
  try {
    // --version / -v / version：只打印版本，不建目录（安装后第一条自检命令）
    if (a.flags.version === true || (a.cmd.length === 1 && (c0 === 'version' || c0 === '-v'))) { io.out(`gitrader ${KERNEL_VERSION}\n`); return 0 }
    // 任何子命令的 --help / -h：只打印帮助，返回 0，不建目录、不起服务。
    if (a.flags.help !== undefined || a.cmd.includes('-h') || a.cmd.includes('--help')) {
      const words = a.cmd.filter((x) => !x.startsWith('-'))
      const name = words[0]
      if (!name) { io.out(helpText(io)); return 0 }
      // agent 自己会按工具列出动作（ADR-22）：把帮助交给 cmdAgent，不要截成 HELP 的一行。
      if (name === 'agent') return await cmdAgent(home, a, io)
      if (name === 'init') { io.out(INIT_HELP); return 0 }
      const lines = helpLinesFor(helpFor(io).body, words.slice(0, 3))
      io.out(lines.length ? `${lines.join('\n')}\n` : helpText(io))
      return 0
    }
    switch (c0) {
      case undefined:
      case 'help': io.out(helpText(io)); return 0 // UX-26：不带参数等同 help，退出码 0
      case 'init': return await cmdInit(home, a, io)
      case 'serve': if (a.flags.detach === true) return await cmdServeDetach(home, a, io); io = serveLogIo(io, a.flags['log-format']); return await cmdServe(home, a, io)
      case 'doctor': return await cmdDoctor(home, a, io)
      case 'stop': return await cmdStop(home, a, io)
      case 'pin': if (c1 === 'reset') return await cmdPinReset(home, a, io); break
      case 'agent': return await cmdAgent(home, a, io)
      case 'research': return await cmdResearch(home, a, io)
      case 'skill': return await cmdSkill(home, a, io)
      case 'status': return await cmdStatus(home, a, io)
      case 'mcp': if (c1 === 'snippet') return await cmdSnippet(home, a, io, c2); break
      case 'open': return await cmdOpen(home, a, io)
      case 'config': return await cmdConfig(home, a, io)
      case 'engines': return await cmdEngines(home, a, io)
      case 'examples': return await cmdExamples(home, a, io)
      case 'session': {
        if (c1 === 'link') { a.flags.print = true; return await cmdOpen(home, a, io) }
        if (c1 === 'login') return await cmdSessionLogin(home, io)
        if (c1 === 'logout') return await cmdSessionLogout(home, io)
        throw new Error('usage: gitrader session login|logout|link')
      }
      case 'keys': return await cmdKeys(home, a, io)
      case 'plugins': return await cmdPlugins(home, a, io)
      case 'notify': return await cmdNotify(home, a, io)
      case 'ledger': return await cmdLedger(home, a, io)
      case 'lab': return await cmdLab(home, a, io)
      case 'accounts': return await cmdAccounts(home, a, io)
      case 'risk': return await cmdRisk(home, a, io)
      case 'reconcile': return await cmdReconcile(home, a, io)
      case 'paper': {
        if (c1 === 'replay') return await cmdPaperReplay(home, a, io)
        if (c1 === 'rebuild-from-ledger') return await cmdPaperRebuild(home, a, io)
        if (c1 !== 'reset') throw new Error('usage: gitrader paper reset [--account <alias|id>]')
        const service = await liveService(home)
        if (!service) throw new Error('start the local service before resetting a paper account')
        const result = await callOp(home, service, 'paper.reset', 'write', { accountId: flag(a, 'account') ?? 'paper' }, await io.readSecret('PIN: '))
        io.out(JSON.stringify(result) + '\n')
        return 0
      }
      case 'bench': io.out('gitrader bench: not implemented in M1 (stub). Numbers are published in docs/perf-baseline.md by the release process.\n'); return 0
      default: break
    }
    io.err(`${tr(io, '未知命令（unknown command）', 'unknown command')}: ${a.cmd.join(' ')}\n${helpText(io)}`)
    return 1
  } catch (e) {
    const p = problemOf(e)
    // plugins 子命令的错误带码（与 plugins call 一致）：<code> <name>: <message>
    io.err(c0 === 'plugins' && p ? `${p.code} ${p.name}: ${p.message}\n` : `error: ${e instanceof KernelError ? e.problem.message : e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

type ProblemLike = { code: number; name: string; message: string }
/** 内核抛的 KernelError，或经服务返回、挂在 error.problem 上的 Problem。 */
const problemOf = (e: unknown): ProblemLike | undefined => (e instanceof KernelError ? e.problem : (e as { problem?: ProblemLike }).problem)

const serveLogFormats = new WeakMap<CliIo, 'text' | 'json'>()

function serveLogIo(io: CliIo, requested?: string | true): CliIo {
  if (serveLogFormats.has(io)) return io
  const raw = requested ?? io.env.GITRADER_LOG_FORMAT ?? 'text'
  if (raw === true) throw new Error('--log-format requires a value')
  if (raw === '' || (raw !== 'text' && raw !== 'json')) throw new Error('--log-format must be text or json')
  const wrapped: CliIo = {
    ...io,
    out: (s) => io.out(s),
    err: raw === 'json' ? (s) => {
      for (const line of s.split(/\r\n|\n|\r/)) {
        if (!line) continue
        const trimmed = line.trimStart()
        const level = /^(?:\[gitrader\]\s*)?error\b/i.test(trimmed) ? 'error' : /warning/i.test(line) ? 'warn' : 'info'
        io.err(`${formatJsonLog({ level, msg: line })}\n`)
      }
    } : (s) => io.err(s),
    readSecret: (prompt) => io.readSecret(prompt),
    ...(io.readStdin ? { readStdin: () => io.readStdin!() } : {}),
  }
  serveLogFormats.set(wrapped, raw)
  return wrapped
}

async function cmdNotify(home: string, a: Args, io: CliIo): Promise<number> {
  const [, sub, channelId] = a.cmd
  if (sub !== 'test' || !channelId || a.cmd.length !== 3) throw new Error('usage: gitrader notify test <channelId>')
  const service = await liveService(home)
  let result: { results: { ok: boolean }[] }
  if (service) result = await callOp(home, service, 'notify.test', 'write', { channelId })
  else {
    const k = await openKernel(home, io)
    let principal: ReturnType<Kernel['auth']['authenticateToken']> = null
    try {
      await k.plugins.reload()
      const exchange = k.auth.exchangeBoot(k.auth.mintBootToken())
      principal = k.auth.authenticateToken(exchange.sessionToken)
      if (!principal) throw new Error('The local kernel could not create a notification session')
      result = await k.ops.call(k, 'notify.test', { principal, params: { channelId }, transport: 'http', kind: 'command' }) as typeof result
    } finally { if (principal) k.auth.revokeSession(principal); await k.stop() }
  }
  io.out(JSON.stringify(result, null, 2) + '\n')
  return result.results.length > 0 && result.results.every(channel => channel.ok) ? 0 : 1
}

async function cmdLab(home: string, a: Args, io: CliIo): Promise<number> {
  const [, sub, arg] = a.cmd
  if (a.cmd.length !== 3 || !['export', 'verify', 'pack', 'attach'].includes(sub || '') || !arg) {
    io.err('usage: gitrader lab export <id> [--out FILE] | verify <file> | pack <experimentId> --run <runId> [--holdout <fromMs>,<toMs>] [--note <text>] | attach <experimentId> --engine <engineId> --instance <instanceId> --account <alias|id>\n')
    return 1
  }
  
  // Handle pack and attach commands
  if (sub === 'pack' || sub === 'attach') {
    const service = await liveService(home)
    if (!service) {
      io.err('error: lab pack/attach requires a running service. Start one with: gitrader serve\n')
      return 1
    }
    
    if (sub === 'pack') {
      const runIdRaw = a.flags.run
      const runId = typeof runIdRaw === 'string' ? runIdRaw : Array.isArray(runIdRaw) ? runIdRaw[0] : undefined
      if (!runId) {
        io.err('error: lab pack requires --run <runId>\n')
        return 1
      }
      const params: Record<string, unknown> = { experimentId: arg, runId }
      const noteRaw = a.flags.note
      const note = typeof noteRaw === 'string' ? noteRaw : Array.isArray(noteRaw) ? noteRaw[0] : undefined
      if (note) params.note = note
      const holdoutRaw = a.flags.holdout
      const holdout = typeof holdoutRaw === 'string' ? holdoutRaw : Array.isArray(holdoutRaw) ? holdoutRaw[0] : undefined
      if (holdout) {
        const [from, to] = holdout.split(',').map((s: string) => parseInt(s.trim(), 10))
        if (isNaN(from) || isNaN(to)) {
          io.err('error: --holdout must be <fromMs>,<toMs>\n')
          return 1
        }
        params.holdoutWindow = { from, to }
      }
      try {
        const result = await callOp(home, service, 'lab.pack', 'write', params)
        io.out(JSON.stringify(result, null, 2) + '\n')
        return 0
      } catch (e) {
        const p = problemOf(e)
        io.err(`error: lab pack failed${p ? ` (${p.code} ${p.name})` : ''}\n`)
        return 1
      }
    }
    
    if (sub === 'attach') {
      const engineIdRaw = a.flags.engine
      const engineId = typeof engineIdRaw === 'string' ? engineIdRaw : Array.isArray(engineIdRaw) ? engineIdRaw[0] : undefined
      const instanceIdRaw = a.flags.instance
      const instanceId = typeof instanceIdRaw === 'string' ? instanceIdRaw : Array.isArray(instanceIdRaw) ? instanceIdRaw[0] : undefined
      const accountInputRaw = a.flags.account
      const accountInput = typeof accountInputRaw === 'string' ? accountInputRaw : Array.isArray(accountInputRaw) ? accountInputRaw[0] : undefined
      if (!engineId || !instanceId || !accountInput) {
        io.err('error: lab attach requires --engine <engineId> --instance <instanceId> --account <alias|id>\n')
        return 1
      }
      try {
        // Resolve account alias to id
        const accounts = await callOp(home, service, 'account.list', 'read', {}) as { items: { accountId: string; alias?: string }[] }
        const account = accounts.items.find(a => a.accountId === accountInput || a.alias === accountInput)
        if (!account) {
          io.err(`error: account "${accountInput}" not found\n`)
          return 1
        }
        const params = { experimentId: arg, attach: { run: { accountId: account.accountId, executor: { kind: 'engine', engineId, instanceId, codeDigest: null } } } }
        const result = await callOp(home, service, 'lab.attach', 'write', params)
        io.out(JSON.stringify(result, null, 2) + '\n')
        return 0
      } catch (e) {
        const p = problemOf(e)
        io.err(`error: lab attach failed${p ? ` (${p.code} ${p.name})` : ''}\n`)
        return 1
      }
    }
    
    // Should not reach here for pack/attach
    throw new Error('unreachable')
  }
  
  // Original export/verify logic
  const op = `lab.${sub}`
  const out = flag(a, 'out')
  if (a.flags.out !== undefined && (out === undefined || sub !== 'export')) { io.err('usage: gitrader lab export <id> --out FILE\n'); return 1 }
  const params: Record<string, unknown> = sub === 'export' ? { experimentId: arg } : { file: arg }
  if (sub === 'verify') {
    if (isAbsolute(arg)) {
      // R3-13：绝对路径是只读核验，文件可以在任何位置（相对路径仍只认 <home>/lab）。核验是纯函数（只看包本身和包里的安装公钥），
      // 所以这里直接在本进程里做：不开内核、不经服务的入参过滤（包里的 seed 之类字段会被那一层当成密钥拒收），也不往 home 里写任何东西。报错不回显路径和文件内容
      let bundle: unknown
      try {
        const st = statSync(arg)
        if (!st.isFile() || st.size > 8 * 1024 * 1024) throw new Error('invalid file')
        bundle = JSON.parse(readFileSync(arg, 'utf8'))
      } catch {
        io.err('error: lab verify failed (the file is missing, too large or not JSON)\n')
        return 1
      }
      try {
        const verdict = await new LabExport(undefined as never).verify(bundle)
        io.out(JSON.stringify(verdict, null, 2) + '\n')
        return verdict.status === 'identical' ? 0 : 1
      } catch {
        io.err('error: lab verify failed\n')
        return 1
      }
    } else resolveConfinedPath(join(home, 'lab'), arg, { anchorRoot: home, mustExist: true })
  }
  try {
    const service = await liveService(home)
    let result: unknown
    if (service) result = await callOp(home, service, op, 'read', params)
    else {
      const k = await openKernel(home, io)
      try { result = await k.ops.call(k, op, { principal: { kind: 'service' }, params, transport: 'http', kind: 'query' }) }
      finally { await k.stop() }
    }
    if (sub === 'export' && out !== undefined) {
      // R3-13：--out 把包写到指定文件（绝对路径，或相对当前目录），并打印写出的路径；不带 --out 仍是 JSON 打到 stdout
      const file = resolve(out)
      writeFileSync(file, JSON.stringify(result, null, 2) + '\n', 'utf8')
      io.out(`已写出：${file}\n`)
      return 0
    }
    io.out(JSON.stringify(result, null, 2) + '\n')
    return sub === 'verify' && (result as { status?: string } | null)?.status !== 'identical' ? 1 : 0
  } catch (e) {
    const p = problemOf(e)
    io.err(`error: lab ${sub} failed${p ? ` (${p.code} ${p.name})` : ''}\n`)
    return 1
  }
}

async function cmdInit(home: string, a: Args, io: CliIo): Promise<number> {
  const rebuildConfig = a.flags['rebuild-config'] !== undefined
  const accountId = flag(a, 'account-id')
  const r = initHomeWithDefaults(home, { ...(rebuildConfig ? { rebuildConfig: true } : {}), ...(accountId ? { accountId } : {}) })
  const pinFile = join(homePaths(home).keys, 'pin.json')
  if (r.created.length) {
    io.out(tr(io, `已创建 Gitrader 目录：${home}\n`, `Created the Gitrader directory: ${home}\n`))
    if (rebuildConfig && r.created.includes(r.paths.config)) {
      const recoveredId = r.config.accounts.find((a) => a.alias === 'paper')?.accountId
      io.out(tr(io, `已按默认配置重建（1 个纸面账户 paper，场所 hyperliquid 测试网）${recoveredId ? `、沿用的账户 id：${recoveredId}` : ''}。风控 / 通知 / 插件 / 实盘账户等自定义项没有恢复，需要重新配置。账本与签名身份没动。\n`,
        `Rebuilt from the default config (one paper account "paper", venue hyperliquid testnet)${recoveredId ? `, reusing account id ${recoveredId}` : ''}. Custom risk / notification / plugin / live-account settings were not restored; set them up again. The ledger and signing identity were not touched.\n`))
    }
  } else {
    const pinSet = existsSync(pinFile)
    // UX-18：已经在跑就别再让人 serve，直接说 open；去掉重复行
    const running = await liveService(home)
    const next = running ? 'gitrader open' : pinSet ? 'gitrader serve' : 'gitrader serve'
    io.out(tr(io, `已经初始化过：${home}。PIN：${pinSet ? '已设置' : '未设置'}。下一步：${running ? `${next}（服务已经在跑，用它取新的登录链接）` : pinSet ? next : `${next}，然后在浏览器里设 PIN`}（Already initialized）\n`,
      `Already initialized: ${home}. PIN: ${pinSet ? 'set' : 'not set'}. Next: ${running ? `${next} (the service is already running; it prints a fresh login link)` : pinSet ? next : `${next}, then set a PIN in the browser`}\n`))
    if (a.flags['no-pin'] || (!io.interactive && !io.env.GITRADER_PIN_STDIN)) return 0 // 上一句已含下一步，不再重复
  }
  // supportDeveloper 默认关，init 不询问
  if (a.flags['no-pin']) io.out(tr(io, '稍后在浏览器里设 PIN（运行 gitrader serve 后打开链接即可）\n', 'Set a PIN later in the browser (run `gitrader serve`, then open the link).\n'))
  else if (io.interactive || io.env.GITRADER_PIN_STDIN) {
    const k = await openKernel(home, io)
    try { if (!k.pin.isSet()) await needPin(k, io) } finally { await k.stop() }
  }
  if (!io.interactive && !a.flags['no-pin'] && !existsSync(pinFile)) io.out(tr(io, 'PIN 未设置：当前不是交互终端。可以先 gitrader serve，在浏览器里设 PIN；或在交互终端运行 gitrader init\n', 'No PIN yet: this is not an interactive terminal. Run `gitrader serve` and set a PIN in the browser, or run `gitrader init` in an interactive terminal.\n'))
  io.out(tr(io, '下一步：gitrader serve\n', 'Next: gitrader serve\n'))
  return 0
}

export interface ServeHandle { port: number; url: string; kernel: Kernel; stop(): Promise<void> }

const DEFAULT_SERVE_HOST = '127.0.0.1'
const WILDCARD_SERVE_HOSTS = ['0.0.0.0', '::'] as const
const WILDCARD_WARNING = '[gitrader] warning: listening on all network interfaces; only expose this service on a trusted network\n'

function validateServeHost(host: string | undefined): string {
  const selected = host ?? DEFAULT_SERVE_HOST
  if (selected !== DEFAULT_SERVE_HOST && !(WILDCARD_SERVE_HOSTS as readonly string[]).includes(selected)) {
    throw new Error('host must be an allowed loopback or wildcard binding')
  }
  return selected
}

/** 起内核 + 工作台。返回句柄，CLI 的 serve 命令在其上等信号。 */
export async function runServe(home: string, o: { port?: number; host?: string; staticDir?: string; io: CliIo; /** fix-r2 S2：账本库不见了时显式同意从空账本重来。 */ acceptNewLedger?: boolean; /** R2-REL-11：新账本遇到非空 paper-state.json 时，同意把旧状态移进 backups/ 并按初始资金重来（要和 acceptNewLedger 一起）。 */ resetPaperState?: boolean; /** 测试用：不起 Hyperliquid 连接器 / 模拟场所（不联网）。 */ connectors?: boolean; /** 测试用：替换连接器装配。 */ connect?: (k: Kernel) => void }): Promise<ServeHandle> {
  const io = serveLogIo(o.io)
  const host = validateServeHost(o.host)
  const live = await liveService(home)
  if (live) throw new Error(`a Gitrader service is already running for ${home} (port ${live.port}, pid ${live.pid})`)
  // 集成修补（H）：远程引擎的令牌 / 证书在配置里只写句柄；serve 认 `env:<变量名>` 句柄（从启动 serve 的环境里取），其他句柄照旧报"无法解析"。
  const resolveSecret = (ref: string): string | undefined => (ref.startsWith('env:') ? io.env[ref.slice(4)] || undefined : undefined)
  const k = await Kernel.create({ home, log: (m) => io.err(`[gitrader] ${m}\n`), resolveSecret, ...(io.deviceKey ? { deviceKeyProvider: io.deviceKey } : {}), ...(o.acceptNewLedger ? { acceptNewLedger: true } : {}), ...(o.resetPaperState ? { resetPaperState: true } : {}) })
  try {
    if (k.replayFixture && o.connect) throw new Error('custom connector setup cannot be combined with configured historical replay')
    if (o.connect) o.connect(k)
    else if (k.replayFixture || o.connectors !== false) await loadConnectors(k, io)
    else assembleOfflinePaper({ k, io })          // --offline：只有纸面场所，没有任何行情连接器
  } catch (error) {
    await k.stop().catch(() => undefined)
    throw error
  }
  const staticDir = o.staticDir ?? io.env.GITRADER_STATIC ?? defaultStaticDir()
  const wildcard = (WILDCARD_SERVE_HOSTS as readonly string[]).includes(host)
  if (wildcard) io.err(WILDCARD_WARNING)
  let port: number
  let bootToken: string
  try {
    ({ port, bootToken } = await k.start({ ...(o.port !== undefined ? { port: o.port } : {}), host, ...(staticDir ? { staticDir } : {}), builtinEngine: !k.replayFixture && o.connectors !== false && !o.connect }))
  } catch (error) {
    await k.stop().catch(() => undefined)
    throw error
  }
  for (const w of k.warnings) io.err(`[gitrader] warning: ${w}\n`)
  // fix-r2 S1/S2：纸面状态 / 账本不可信时启动输出里说人话（服务照样起来，方便看 doctor 与工作台）
  const paper = k.paperStateHealth()
  if (paper.state === 'corrupt' || paper.state === 'missing') io.err(`[gitrader] 纸面状态文件不可信：${paper.reason ?? '原因不明'}。纸面账户已停止交易，原文件没动；运行 gitrader doctor 看下一步\n`)
  const lv = k.healthSnapshot().ledgerVerify
  if (lv && !lv.ok) io.err(`[gitrader] 账本校验没过（seq ${lv.failure?.seq}：${lv.failure?.reason}），交易已全部停止；运行 gitrader doctor 看下一步\n`)
  return {
    port, kernel: k,
    // 启动令牌一次性、120 秒内有效：带着它请求页面，内核才会在 index.html 里注入 <meta name="gitrader-bootstrap">；页面用它换会话令牌（POST /api/session {bootstrap}）。
    url: `http://127.0.0.1:${port}/?launch=${bootToken}`,
    stop: () => k.stop(),
  }
}

function defaultStaticDir(): string | undefined {
  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    for (const p of [join(here, '..', '..', 'workbench', 'dist'), join(here, '..', 'workbench'), join(here, 'workbench')]) if (existsSync(join(p, 'index.html'))) return p
  } catch { /* 找不到就用占位页 */ }
  return undefined
}

/** 第一方连接器按 `config.venues` 装配：工厂表在 ./connectors（交易工厂 = 行情 + 交易，数据工厂 = 只读行情），再建内核模拟场所（各标的按 instrumentId 前缀选择行情源）。
 *  只做同步装配 + 把“连行情”丢到后台（带退避重连）：不等网络，工作台与 MCP 立刻可用；状态在 status / 状态条里显示 连接中 / 已连 / 断开。
 *  速率预算由内核创建、两边共用；supportDeveloper 默认关，打开才带 Builder 费。
 *  PaperVenue 的描述 / 状态 / 环境元数据保留 Hyperliquid → 首个 trading → 首个 data 的兼容优先级。 */
export function loadConnectors(k: Kernel, io: CliIo): void | Promise<void> {
  if (k.replayFixture) {
    return (async () => {
      const replay = assembleReplay(k, io)
      await replay.ready
      k.attachReplayDriver(replay.driver)
    })()
  }
  try {
    assembleConnectors({ k, io })
  } catch (e) {
    // fix-r2 S1：状态文件损坏不吞成一行日志——拒绝使用并把原因带出去（其他连接器异常行为不变）
    if (e instanceof KernelError && e.problem.name === 'STATE_FILE_CORRUPT') throw new Error(`拒绝使用纸面场所：纸面状态文件和这个数据目录对不上（${e.problem.message}）。见 gitrader doctor`)
    io.err(`[gitrader] could not set up the connectors: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

async function cmdPaperReplay(home: string, a: Args, io: CliIo): Promise<number> {
  // fix-r6 R3-06：历史回放只存在于专用的回放主目录（gitrader.json 里配了 paperReplay，见 docs/kernel-security.md），不在普通主目录的帮助和用户文档里。
  // 普通主目录直接说清楚，不再绕一圈拿到「内核没配置」的内部错误码。
  let configured = false
  try { configured = loadConfig(home).paperReplay !== undefined } catch { configured = true /* 读不了配置：交给内核按原样回答，不替它下结论 */ }
  if (!configured) throw new Error('paper replay is not available in this home: it only runs in a dedicated historical-replay home (paperReplay in gitrader.json, see docs/kernel-security.md). For historical research use the backtest tool (gitrader agent backtest run)')
  const sub = a.cmd[2]
  const live = await liveService(home)
  if (!live) throw new Error('start the local service before using paper replay')
  if (sub === 'status') {
    const status = await callOp(home, live, 'paper.replay.status', 'read')
    io.out(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }
  if (sub === 'stop') {
    const runId = a.cmd[3]
    if (!runId) throw new Error('usage: gitrader paper replay stop <runId>')
    const status = await callOp(home, live, 'paper.replay.stop', 'write', { runId })
    io.out(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }
  if (sub !== 'start') throw new Error('usage: gitrader paper replay start <strategy> --account <alias|id> --instrument <id> --interval <interval> [--params <json>] [--sizing <json>] | status | stop <runId>')
  const strategyId = a.cmd[3]
  const wantedAccount = flag(a, 'account')
  const instrumentId = flag(a, 'instrument')
  const interval = flag(a, 'interval')
  if (!strategyId || !wantedAccount || !instrumentId || !interval) throw new Error('usage: gitrader paper replay start <strategy> --account <alias|id> --instrument <id> --interval <interval> [--params <json>] [--sizing <json>]')
  const accounts = await callOp(home, live, 'account.list', 'read') as Array<{ accountId: string; alias: string; mode: string }>
  const account = accounts.find((entry) => entry.accountId === wantedAccount || entry.alias === wantedAccount)
  if (!account || account.mode !== 'paper') throw new Error('paper replay requires a configured paper account')
  const objectFlag = (name: 'params' | 'sizing'): Record<string, unknown> | undefined => {
    const raw = flag(a, name)
    if (raw === undefined) return undefined
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new Error(`--${name} must be a JSON object`) }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`--${name} must be a JSON object`)
    return value as Record<string, unknown>
  }
  const params = objectFlag('params')
  const sizing = objectFlag('sizing')
  const input: PaperReplayStart & { engineId: string } = {
    engineId: 'gitrader-core', accountId: account.accountId as PaperReplayStart['accountId'], strategyId,
    instrumentId: instrumentId as PaperReplayStart['instrumentId'], interval: interval as PaperReplayStart['interval'],
    ...(params ? { params: params as PaperReplayStart['params'] } : {}),
    ...(sizing ? { sizing: sizing as PaperReplayStart['sizing'] } : {}),
  }
  const status = await callOp(home, live, 'paper.replay.start', 'write', input as unknown as Record<string, unknown>)
  io.out(`${JSON.stringify(status, null, 2)}\n`)
  return 0
}

/** serve 停止流程用到的最小 stdin 面：只摘 data 监听、暂停、尽量 unref。 */
export interface StopperStdin {
  on(event: 'data', listener: () => void): unknown
  off(event: 'data', listener: () => void): unknown
  pause(): unknown
  unref?(): unknown
}
export interface StopperDeps {
  /** 真正停服务（内核 h.stop()）。 */
  stop(): Promise<unknown>
  stdin: StopperStdin
  /** 停止没完成又收到信号时立刻退出。 */
  exit(code: number): void
}
export interface Stopper {
  /** 绑上 stdin 的 data 监听（交互时按 Enter 出新链接）；已经在停止就不绑。 */
  listen(onData: () => void): void
  /** 摘 stdin 监听 → pause → unref → stop()；stop 完成后 resolve。stop 没完成时再调 → exit(130)。 */
  stop(): Promise<void>
  /** stdin 监听还在吗。 */
  listening(): boolean
}

/** Ctrl+C 的停止顺序：先把 stdin 的 data 监听摘掉（不然它会让进程挂着），再暂停 / unref stdin，最后才停服务。
 *  抽成纯函数：Windows 上没法可靠投递 SIGINT，停止流程本身靠这个测。 */
export function makeStopper(deps: StopperDeps): Stopper {
  let listener: (() => void) | undefined
  let pending: Promise<void> | undefined
  const detach = (): void => {
    const l = listener
    listener = undefined
    if (l) deps.stdin.off('data', l)
    deps.stdin.pause()
    deps.stdin.unref?.()
  }
  return {
    listen: (onData) => { if (pending) return; listener = onData; deps.stdin.on('data', onData) },
    listening: () => listener !== undefined,
    stop: () => {
      if (pending) { deps.exit(130); return pending }
      detach()
      let started: Promise<unknown>
      try { started = deps.stop() } catch { started = Promise.resolve() }
      pending = started.then(() => undefined, () => undefined)
      return pending
    },
  }
}

/** serve 起来后的提示（含 UX-13 的 --open：自动打开浏览器）。 */
export function announceServe(io: CliIo, h: { port: number; url: string }, open: boolean): void {
  io.out(tr(io, `Gitrader ${KERNEL_VERSION} 已在 127.0.0.1:${h.port} 运行\n打开工作台（链接 2 分钟内有效，只能用一次）：\n  ${h.url}\n`, `Gitrader ${KERNEL_VERSION} is running on 127.0.0.1:${h.port}\nOpen the workbench (link valid for 2 minutes, one use):\n  ${h.url}\n`))
  io.out(io.stdinTty ?? io.interactive
    ? tr(io, '想再拿登录链接：在这个窗口按 Enter。停止：Ctrl+C，或在另一个窗口运行 gitrader stop。\n', 'Press Enter in this terminal for a fresh link. Stop with Ctrl+C, or run `gitrader stop` in another window.\n')
    : tr(io, '想再拿登录链接：在终端运行 gitrader open（会要 PIN）；还没设 PIN 的话，关掉这个窗口、重新运行启动脚本（或 gitrader serve）。\n', 'For a fresh login link run `gitrader open` in a terminal (it asks for your PIN); if no PIN is set yet, close this window and run the start script (or `gitrader serve`) again.\n'))
  if (open) openBrowser(io, h.url) // UX-13：--open 自动打开浏览器
}

async function cmdServe(home: string, a: Args, io: CliIo): Promise<number> {
  if (a.flags.host === true) throw new Error('--host requires a value')
  initHomeWithDefaults(home)
  const port = flag(a, 'port') !== undefined ? Number(flag(a, 'port')) : undefined
  const host = flag(a, 'host') ?? io.env.GITRADER_HOST
  const h = await runServe(home, { ...(a.flags['accept-new-ledger'] === true ? { acceptNewLedger: true } : {}), ...(a.flags['reset-paper-state'] === true ? { resetPaperState: true } : {}), ...(port !== undefined ? { port } : {}), ...(host !== undefined ? { host } : {}), ...(flag(a, 'static') ? { staticDir: resolve(flag(a, 'static')!) } : {}), io, connectors: io.env.GITRADER_OFFLINE !== '1' && !a.flags['offline'] })
  announceServe(io, h, a.flags.open === true)
  const stopper = makeStopper({ stop: () => h.stop(), stdin: process.stdin, exit: (code) => process.exit(code) })
  h.kernel.onShutdownRequest = () => { process.emit('SIGTERM') } // gitrader stop 走现有优雅关闭；Windows 上也有效（进程内触发）
  await new Promise<void>((done) => {
    const stop = (): void => {
      // 再挂一次：停止还没完成时又按 Ctrl+C，stopper 会立刻 process.exit(130)。
      process.once('SIGINT', () => { void stopper.stop() })
      process.once('SIGTERM', () => { void stopper.stop() })
      void stopper.stop().then(done)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    if (io.stdinTty ?? io.interactive) stopper.listen(() => io.out(`  http://127.0.0.1:${h.port}/?launch=${h.kernel.auth.mintBootToken()}\n`))
  })
  return 0
}

/** 给已经在跑的实例要一条一次性启动链接（120 秒内有效、只显示一次）。要 PIN 在场：本机其他进程拿到 service.json 也换不到会话。 */
async function cmdSessionLogin(home: string, io: CliIo): Promise<number> {
  const service = await liveService(home)
  if (!service) throw new Error(tr(io, '没有在运行的服务：先运行 gitrader serve（Start the local service first with: gitrader serve）', 'Start the local service first with: gitrader serve'))
  const session = await loginSession(home, { baseUrl: service.baseUrl, startedAt: service.startedAt }, io.readSecret, io.sessionFileOps, langOf(io))
  io.out(tr(io, `已登录本机服务会话（Signed in for this service session）；有效至 ${fmtLocal(session.expiresAt)}\n`, `Signed in for this service session; valid until ${fmtLocal(session.expiresAt)}\n`))
  return 0
}

async function cmdSessionLogout(home: string, io: CliIo): Promise<number> {
  const service = await liveService(home)
  const outcome = await logoutSession(home, service ? { baseUrl: service.baseUrl, startedAt: service.startedAt } : null, io.sessionFileOps)
  if (outcome === 'remote') io.out(tr(io, '会话已吊销，本地缓存已删除（Session revoked and local cache removed）。\n', 'Session revoked and local cache removed.\n'))
  else if (outcome === 'local') io.out(tr(io, '本地会话缓存已删除；服务端可能没有同步吊销（Local session cache removed; remote revocation may not have occurred）。\n', 'Local session cache removed; remote revocation may not have occurred.\n'))
  else if (outcome === 'unconfirmed') io.out(tr(io, '本地会话缓存已删除；服务端是否吊销没能确认（Local session cache removed; remote revocation could not be confirmed）。\n', 'Local session cache removed; remote revocation could not be confirmed.\n'))
  else { io.err(tr(io, '本地有一份更新的会话缓存，已保留（A newer session cache was preserved）。再运行一次 gitrader session logout 才会删除它。\n', 'A newer session cache was preserved. Run `gitrader session logout` again to remove it.\n')); return 1 }
  return 0
}

async function cmdOpen(home: string, a: Args, io: CliIo): Promise<number> {
  const json = a.flags.json === true
  const fail = (msg: string): number => { if (json) io.out(JSON.stringify({ error: msg }) + '\n'); else io.err(msg + '\n'); return 1 }
  const live = await liveService(home)
  if (!live) return fail(noServiceMsg(io))
  const unattended = a.flags.unattended === true
  if (unattended && !json && !a.flags.print) return fail(tr(io, '--unattended 只能和 --print 一起用，它从不打开浏览器（--unattended only works with --print）', '--unattended only works with --print (it never opens a browser)'))
  if (!unattended && !existsSync(homePaths(home).pin)) return fail(tr(io, '还没有设置 PIN（No PIN is set yet），运行中的服务没法生成登录链接。请用 gitrader serve 打印的链接进浏览器设 PIN，或在终端运行 gitrader init；也可以关掉启动窗口、重新运行启动脚本，会给新链接。', 'No PIN is set yet, so a link cannot be minted for a running service. Use the link printed by `gitrader serve`, or set a PIN with `gitrader init`; or close the start-up window and run the start script again for a fresh link.'))
  // ADR-5：普通 open 只要 PIN（service 令牌 + PIN 头）；只有 --unattended（免 PIN）才要当前缓存的人类会话。
  let session: ReturnType<typeof cachedWriteSession> | undefined
  if (unattended) {
    try { session = cachedWriteSession(home, live) } catch (e) { return fail(e instanceof Error ? e.message : tr(io, '需要先登录本机会话：运行 gitrader session login（A local session is required）', 'A local session is required. Run `gitrader session login`.')) }
  }
  const pin = unattended ? undefined : await io.readSecret('PIN: ')
  const op = unattended ? 'session.link.unattended' : 'session.link'
  const r = await fetch(`http://127.0.0.1:${live.port}/api/op/${op}`, { method: 'POST', headers: { authorization: `Bearer ${session?.sessionToken ?? live.token}`, 'content-type': 'application/json', ...(pin ? { 'x-gitrader-pin': pin } : {}) }, body: JSON.stringify({ params: unattended ? { origin: flag(a, 'origin') ?? '' } : {} }), signal: AbortSignal.timeout(15_000) })
  const j = (await r.json()) as { ok: boolean; result?: { url: string; ttlSec: number; expiresAt: number }; error?: { message: string; retryAfterMs?: number } }
  if (r.status === 401 && session) invalidateCachedSession(home, session.sessionToken)
  if (!j.ok || !j.result) {
    // UX-07：中文界面下把错误说成人话（错 PIN / 没输入 / 锁定），英文原文留给英文界面
    const pr = j.error as { name?: string; message: string; code?: number; retryAfterMs?: number } | undefined
    const noTty = !io.interactive && pr && isPinRequired(pr) ? pinNeedsHuman(langOf(io), io.env) : undefined
    if (noTty) return fail(langOf(io) === 'en' ? `error: ${noTty.text}; ${noTty.next}` : `${noTty.text}。下一步：${noTty.next}`)
    const human = langOf(io) === 'zh' && pr?.name && /^(invalid PIN|a presence proof|too many failed PIN|pin not set|PIN must)/i.test(pr.message) ? humanizeProblem({ code: pr.code ?? 0, name: pr.name, message: pr.message, ...(pr.retryAfterMs !== undefined ? { retryAfterMs: pr.retryAfterMs } : {}) } as never, { surface: 'cli' }) : undefined
    const base = human ? `${human.zh}${human.next ? `。下一步：${human.next}` : ''}` : `error: ${j.error?.message ?? r.status}`
    return fail(`${base}${r.status === 401 && session ? tr(io, '；本机会话过期的话，运行 gitrader session login', '; run gitrader session login if the local session expired') : ''}${j.error?.retryAfterMs && !human ? ` (retry in ${Math.ceil(j.error.retryAfterMs / 1000)} s)` : ''}`)
  }
  if (json) { io.out(JSON.stringify({ url: j.result.url, expiresAt: j.result.expiresAt }) + '\n'); return 0 }
  if (a.flags.print) { io.out(`${j.result.url}\n`); io.err(tr(io, `（链接 ${j.result.ttlSec} 秒内有效、只能用一次 / valid for ${j.result.ttlSec} s, works once）\n`, `(valid for ${j.result.ttlSec} s, works once)\n`)); return 0 }
  io.out(tr(io, `正在打开工作台（链接 ${j.result.ttlSec} 秒内有效、只能用一次）\n`, `Opening the workbench (link valid for ${j.result.ttlSec} s, works once)\n`))
  try { openBrowser(io, j.result.url) } catch { io.out(`${j.result.url}\n`) }
  return 0
}

/** 命令行设置（只开放有明确用途的键）。直接改 gitrader.json（校验后写回），不需要服务在跑；服务在跑时要重启才生效。 */
async function cmdConfig(home: string, a: Args, io: CliIo): Promise<number> {
  const [, sub, key, value] = a.cmd
  const KEYS = ['embed.allowedOrigins']
  if ((sub !== 'get' && sub !== 'set') || !key || !KEYS.includes(key) || (sub === 'set' && value === undefined)) {
    io.err(`usage: gitrader config get <key> | set <key> <value>\n  keys: ${KEYS.join(', ')}\n  embed.allowedOrigins takes origins like https://app.example[:port], comma separated; "none" clears it\n`)
    return 1
  }
  initHomeWithDefaults(home)
  const cfg = loadConfig(home)
  if (sub === 'get') { io.out(JSON.stringify(cfg.embed?.allowedOrigins ?? []) + '\n'); return 0 }
  const list = value === 'none' || value === '' ? [] : String(value).split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean)
  const origins = [...new Set(list)]
  try { saveConfig(home, { ...cfg, embed: { allowedOrigins: origins } }) } catch (e) { io.err(`error: ${e instanceof KernelError ? e.problem.message : e instanceof Error ? e.message : String(e)}\n`); return 1 }
  io.out(`embed.allowedOrigins = ${JSON.stringify(origins)}\n${(await liveService(home)) ? '(a service is running: restart it for this to take effect)\n' : ''}`)
  return 0
}

async function cmdStatus(home: string, a: Args, io: CliIo): Promise<number> {
  const service = await liveService(home)
  if (!service) {
    // F1 契约：只要查得出状态（没 init / 服务没起）就退出 0，并写明状态与下一步命令；数据目录读不了才是「查不出」，非 0。
    try { if (!statSync(home).isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(tr(io, `读不了数据目录（${home}）：${(e as Error).message}`, `Cannot read the data directory (${home}): ${(e as Error).message}`)) }
    const configured = existsSync(homePaths(home).config)
    const next = `${cmdName(io.env)} ${configured ? 'serve --detach' : 'init'}`
    const data = { running: false, home, configured, ...(configured ? {} : { initialized: false }), state: configured ? 'stopped' : 'not_initialized', next, hint: configured ? `服务没在运行：先运行 ${next}` : `还没初始化：先运行 ${next}` }
    io.out(a.flags.json ? JSON.stringify(data) + '\n' : tr(io, `${configured ? '服务没在运行' : '还没初始化'}（数据目录：${home}）。下一步：${next}\n`, `${configured ? 'The service is not running' : 'Not initialized yet'} (data directory: ${home}). Next: ${next}\n`))
    return 0
  }
  const st = await callOp(home, service, 'status', 'read')
  if (a.flags.json) { io.out(JSON.stringify({ running: true, state: 'running', next: `${cmdName(io.env)} open`, ...st }, null, 2) + '\n'); return 0 }
  const risk = await callOp(home, service, 'risk.state', 'read')
  // fix-r3 D5：中文；按全部作用域取最严状态，账户 / 授权书级停机各占一行；场所的上游原文（detail）原样放在括号里
  const labels: Record<string, string> = langOf(io) === 'en' ? { ACTIVE: 'Trading normally', REDUCING: 'Reduce-only', HALTED: 'Halted' } : { ACTIVE: '正常交易', REDUCING: '只减仓', HALTED: '已停止' }
  const severity: Record<string, number> = { ACTIVE: 0, REDUCING: 1, HALTED: 2 }
  const scoped = new Map<string, { label: string; state: string; reason: string }>()
  // 授权书不露编号：用钥匙名映射（mandateId -> name），查不到写「某 Agent」
  const keyNameOf = new Map<string, string>()
  try { for (const k of await callOp(home, service, 'agentkey.list', 'read') as Array<{ mandateId?: string; name?: string }>) if (k.mandateId && k.name) keyNameOf.set(k.mandateId, k.name) } catch { /* 查不到就写某 Agent */ }
  for (const row of [...(risk.reasons ?? []), ...(risk.sticky ?? []), ...(risk.pauses ?? []).map((x: Record<string, unknown>) => ({ ...x, state: 'REDUCING' }))]) {
    const scope = row.scope
    if (!scope || !['org', 'account', 'mandate', 'group', 'instrument'].includes(scope.type) || !labels[row.state]) continue
    const id = scope.type === 'org' ? 'org' : String(scope.id ?? '')
    if (!id) continue
    const alias = scope.type === 'account' ? st.accounts.find((account: { accountId: string }) => account.accountId === id)?.alias : undefined
    const label = scope.type === 'org' ? '全局' : scope.type === 'mandate' ? `Agent「${keyNameOf.get(id) ?? '某 Agent'}」` : ({ account: '账户', group: '账户组', instrument: '标的' } as Record<string, string>)[scope.type] + ' ' + (alias ?? id.slice(-6))
    const labelEn = scope.type === 'org' ? 'Global' : scope.type === 'mandate' ? `Agent "${keyNameOf.get(id) ?? 'an Agent'}"` : ({ account: 'Account', group: 'Account group', instrument: 'Instrument' } as Record<string, string>)[scope.type] + ' ' + (alias ?? id.slice(-6))
    const key = scope.type + ':' + id
    const previous = scoped.get(key)
    if (!previous || severity[row.state]! >= severity[previous.state]!) scoped.set(key, { label: langOf(io) === 'en' ? labelEn : label, state: row.state, reason: String(row.reason ?? '') })
  }
  let effective = String(risk.tradingState ?? st.tradingState ?? 'ACTIVE')
  for (const row of scoped.values()) if (severity[row.state]! > (severity[effective] ?? 0)) effective = row.state
  const global = scoped.get('org:org')?.state ?? String(st.tradingState ?? 'ACTIVE')
  const unverified = new Set((st.connectors ?? []).filter((x: { id: string; status?: { unverified?: boolean } }) => x.status?.unverified === true).map((x: { id: string }) => x.id))
  const en = langOf(io) === 'en'
  const detailText = (d: string): string => (/circuit open/i.test(d) ? (en ? 'network unreachable: cannot reach the exchange, retrying automatically' : '网络不通：连不上交易所，会自动重试') : d)
  const connWord: Record<string, string> = en ? { connecting: 'connecting', connected: 'connected', disconnected: 'disconnected' } : { connecting: '连接中', connected: '已连接', disconnected: '已断开' }
  const reasons = st.stateReasons?.length ? `（${st.stateReasons.map((r: { reason: string }) => r.reason).join('；')}）` : ''
  if (en) {
    io.out([
      `Gitrader ${st.version} is running (pid ${st.pid}, 127.0.0.1:${st.port})`,
      `Trading state: ${labels[effective] ?? effective} (${effective})${st.stateReasons?.length ? ` (${st.stateReasons.map((r: { reason: string }) => r.reason).join('; ')})` : ''}`,
      `Global: ${labels[global] ?? global}`,
      ...[...scoped.entries()].filter(([key]) => key !== 'org:org').map(([, row]) => `${row.label}: ${labels[row.state]}${row.reason ? ` (${row.reason})` : ''}`),
      `Risk policy: v${st.policy?.version ?? '-'} · integrity ${st.policyIntegrity?.ok ? 'passed' : 'FAILED'} · LLM live entries ${st.policy?.denyLlmLiveEntries ? 'denied' : 'allowed'}`,
      `Ledger: seq ${st.ledger.seq} (${st.ledger.count} entries)`,
      `Accounts: ${st.accounts.map((x: { alias: string; mode: string; environment: string }) => `${x.alias}[${x.mode}/${x.environment}]`).join(', ') || 'none'}`,
      `Venues: ${(st.connections ?? []).map((x: { venue: string; state: string; detail?: string }) => `${x.venue} ${connWord[x.state] ?? x.state}${unverified.has(x.venue) ? ' [not verified on the real network]' : ''}${x.detail ? ` (${detailText(x.detail)})` : ''}`).join(', ') || 'none'}`,
      `Connectors: ${st.connectors.map((x: { id: string }) => x.id).join(', ') || 'none'} · Engines: ${st.engines.map((x: { id: string; state: string }) => `${x.id}(${x.state})`).join(', ') || 'none'} · Plugins: ${st.plugins.length}`,
      `PIN: ${st.pinSet ? 'set' : 'not set'} · Keystore: ${st.keystoreUnlocked ? 'unlocked' : 'locked'}`,
      ...(st.warnings.length ? [`Warnings:\n${st.warnings.map((w: string) => `  - ${w}`).join('\n')}`] : []),
    ].join('\n') + '\n')
    return 0
  }
  io.out([
    `Gitrader ${st.version} 正在运行（进程 ${st.pid}，127.0.0.1:${st.port}）`,
    `交易状态：${labels[effective] ?? effective}（${effective}）${reasons}`,
    `全局：${labels[global] ?? global}`,
    ...[...scoped.entries()].filter(([key]) => key !== 'org:org').map(([, row]) => `${row.label}：${labels[row.state]}${row.reason ? `（${row.reason}）` : ''}`),
    `风控策略：v${st.policy?.version ?? '-'} · 完整性${st.policyIntegrity?.ok ? '通过' : '不通过（FAILED）'} · LLM 实盘开仓${st.policy?.denyLlmLiveEntries ? '禁止' : '允许（ALLOWED）'}`,
    `账本：seq ${st.ledger.seq}（共 ${st.ledger.count} 条）`,
    `账户：${st.accounts.map((x: { alias: string; mode: string; environment: string }) => `${x.alias}[${x.mode}/${x.environment}]`).join('、') || '无'}`,
    `场所：${(st.connections ?? []).map((x: { venue: string; state: string; detail?: string }) => `${x.venue} ${connWord[x.state] ?? x.state}（${x.state === 'disconnected' ? 'DISCONNECTED' : x.state}）${unverified.has(x.venue) ? ' [未经真网验证]' : ''}${x.detail ? ` (${detailText(x.detail)})` : ''}`).join('、') || '无'}`,
    `连接器：${st.connectors.map((x: { id: string }) => x.id).join('、') || '无'} · 引擎：${st.engines.map((x: { id: string; state: string }) => `${x.id}(${x.state})`).join('、') || '无'} · 插件：${st.plugins.length}`,
    `PIN：${st.pinSet ? '已设置' : '未设置'} · 钥匙库：${st.keystoreUnlocked ? '已解锁' : '已锁定'}`,
    ...(st.warnings.length ? [`提醒：\n${st.warnings.map((w: string) => `  - ${w}`).join('\n')}`] : []),
  ].join('\n') + '\n')
  return 0
}

// ---- MCP 接入片段 ---------------------------------------------------------------------
// 文本生成在 ./snippets（E）：绝对路径、令牌不落明文（环境变量 / 令牌文件）、端口由 MCP 服务器现读 service.json。
/** R3-02：片段末尾的工具数从协议的加载表算出来（不写死：以后加 / 删工具，数字自己跟着变）。 */
export function toolCountLine(): string {
  const readOnly = mcpToolsForLevel('L0').length
  const paper = mcpToolsForLevel('L1').length
  const layout = mcpToolsForLevel('L1', { allowAgentLayout: true }).length - paper
  return `Tools you will see depend on the key: read-only ${readOnly}, paper / confirm / auto ${paper} (+${layout} when you allow layout changes).`
}

export function snippetText(host: SnippetHost, home: string, over: { node?: string; mcpEntry?: string } = {}): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const found = over.mcpEntry ? { path: over.mcpEntry, built: true } : locateMcpEntry(here)
  return renderSnippet({ host, node: over.node ?? process.execPath, mcpEntry: found.path, home: resolve(home), mcpBuilt: found.built })
}

async function cmdSnippet(home: string, a: Args, io: CliIo, hostArg: string | undefined): Promise<number> {
  let host = hostArg
  if (host === 'other') host = 'generic' // 工作台旧文案里「其它」曾写成 other
  if (!host || !(ALL_SNIPPET_HOSTS as readonly string[]).includes(host)) { io.err(`usage: gitrader mcp snippet <${ALL_SNIPPET_HOSTS.join('|')}>\n`); return 1 }
  // UX-08：令牌文件所在目录都不存在（常见于路径带了引号 / 抄错）会生成指向空气的配置，直接报错；只是文件还没建就提醒一句
  const wantedTokenFile = flag(a, 'token-file')
  if (wantedTokenFile) {
    const abs = resolve(wantedTokenFile)
    if (/['"]/.test(wantedTokenFile) || !existsSync(dirname(abs))) {
      io.err(tr(io, `令牌文件路径不对：${wantedTokenFile}（所在目录不存在，或路径里带了引号）。cmd 里请用双引号，并先用 gitrader keys new agent <名字> --host ${host} --preset starter --token-file 创建钥匙。\n`, `The token file path looks wrong: ${wantedTokenFile} (its directory does not exist, or the path contains quote characters). In cmd use double quotes, and create the key first with gitrader keys new agent <name> --host ${host} --preset starter --token-file.\n`))
      return 1
    }
    if (!existsSync(abs)) io.err(tr(io, `提醒：令牌文件还不存在：${abs}。先用 gitrader keys new agent <名字> --host ${host} --preset starter --token-file 创建钥匙，令牌会写进去。\n`, `Note: the token file does not exist yet: ${abs}. Create the key first with gitrader keys new agent <name> --host ${host} --preset starter --token-file; the token is written there.\n`))
  }
  if (a.flags.token !== undefined) io.err('note: --token is ignored. Tokens are never written into snippets; set GITRADER_AGENT_TOKEN (or use a token file) instead.\n')
  if (a.flags.write === true) {
    // Agent 一条命令接好宿主：只支持 Claude Code 的项目级 .mcp.json；令牌只以文件路径出现
    if (host !== 'claude-code') { io.err('--write 目前只支持 claude-code；其它宿主请按下面的片段放到宿主的配置里\n') }
    else {
      // 没给 --token-file 就用 <home>/agent-tokens/ 里唯一的那把钥匙；输出写明用的是哪个文件
      const found = flag(a, 'token-file') ? { ok: true as const, path: flag(a, 'token-file') as string } : findSingleTokenFile(home)
      if (!found.ok) { io.err(`${found.message}\n`); return 1 }
      const tokenFile = resolve(found.path)
      const path = writeClaudeCodeMcp({ cwd: process.cwd(), home, tokenFile })
      io.out(`已写入 ${path}（gitrader 一项；其它服务器未动）。令牌文件：${tokenFile}。下次打开 Claude Code 会话就能用 Gitrader 工具；本次会话可先用 gitrader agent …\n`)
      return 0
    }
  }
  io.out(flag(a, 'token-file') || a.flags['inline-token'] === true ? snippetFor(host as SnippetHost, home, { ...(flag(a, 'token-file') ? { tokenFile: resolve(flag(a, 'token-file')!) } : {}), ...(a.flags['inline-token'] === true ? { inlineToken: true } : {}) }) : snippetText(host as SnippetHost, home))
  io.out(`\n${toolCountLine()} ${tr(io, '钥匙档位在创建钥匙时由 --preset / --tier 决定；批准、改限额、恢复交易这些大动作始终由你本人在工作台操作。', 'The key level is chosen when the key is created (--preset / --tier); big actions always stay with you in the workbench: approvals, limits, resuming trading.')}\n`)
  return 0
}

// ---- 钥匙 ---------------------------------------------------------------------------
async function cmdKeys(home: string, a: Args, io: CliIo): Promise<number> {
  const [, sub, sub2, sub3] = a.cmd
  // E0-4：Agent 钥匙走新流程（智能默认 / 令牌文件 / 非终端时在工作台批准）；不在这里先开第二个内核进程
  if (sub === 'new' && sub2 === 'agent') return await cmdKeysNewAgent(home, a, io)
  initHomeWithDefaults(home)
  if (sub === 'rotate' && sub2 === 'agent') return await cmdKeysRotate(home, a, io)
  const k = await openKernel(home, io)
  try {
    if (sub === 'list') {
      const w = k.keystore.list()
      const none = tr(io, '  （无）', '  none')
      io.out(tr(io, `API 钱包（${w.length}）\n`, `API wallets (${w.length})\n`) + (w.map((x) => `  ${x.name}  ${x.address}  ${x.status}${x.status === 'active' ? tr(io, ` · 到期 ${fmtLocalDate(x.notAfter)}（剩 ${x.expiresInDays} 天）${x.expiringSoon ? ' · 请尽快轮换' : ''}`, ` · expires ${fmtLocalDate(x.notAfter)} (${x.expiresInDays} d)${x.expiringSoon ? ' · ROTATE SOON' : ''}`) : ''}`).join('\n') || none) + '\n')
      const ak = k.agents.listKeys()
      io.out(tr(io, `Agent 钥匙（${ak.length}）\n`, `Agent keys (${ak.length})\n`) + (ak.map((x) => { const m = k.agents.effective(x.mandateId); return `  ${x.name}  ${x.keyId}  ${x.host}  ${x.status}  level ${m?.level ?? '?'}  ${tr(io, '到期', 'expires')} ${fmtLocalDate(x.expiresAt)}${m && fmtLocalDate(m.notAfter) !== fmtLocalDate(x.expiresAt) ? ` · ${tr(io, '授权到期', 'mandate expires')} ${fmtLocalDate(m.notAfter)}` : ''}` }).join('\n') || none) + '\n')
      return 0
    }
    if (sub === 'import') {
      const name = sub2
      if (!name) throw new Error('usage: gitrader keys import <name> [--venue hyperliquid]')
      const proof = await needPin(k, io)
      const pk = await io.readSecret('API wallet private key (hex, input is hidden): ')
      const w = k.keystore.import(proof, { name, privateKey: pk, network: (flag(a, 'network') as 'mainnet' | 'testnet' | undefined) ?? k.config.venues[0]?.environment ?? 'testnet', ...(flag(a, 'venue') ? { venue: flag(a, 'venue')! } : {}) })
      k.keystore.lock()
      k.ledger.append({ type: 'key.created', origin: mkOrigin('user:usr_local', 'cli:keys.import', 'cli'), subject: { orgId: 'org_local' }, payload: { walletId: w.walletId, address: w.address, name: w.name, kind: 'api-wallet' } })
      io.out(`Imported ${w.name}: ${w.address} (valid until ${fmtLocalDate(w.notAfter)}). Use an API wallet with no withdraw permission.\n`)
      return 0
    }
    if (sub === 'new' && sub2 === 'wallet') {
      const name = sub3
      if (!name) throw new Error('usage: gitrader keys new wallet <name> [--days N]')
      const proof = await needPin(k, io)
      const w = k.keystore.generate(proof, { name, network: (flag(a, 'network') as 'mainnet' | 'testnet' | undefined) ?? k.config.venues[0]?.environment ?? 'testnet', ...(flag(a, 'days') ? { validityDays: Number(flag(a, 'days')) } : {}) })
      k.ledger.append({ type: 'key.created', origin: mkOrigin('user:usr_local', 'cli:keys.new', 'cli'), subject: { orgId: 'org_local' }, payload: { walletId: w.walletId, address: w.address, name: w.name, kind: 'api-wallet' } })
      io.out(`Created API wallet ${w.name}: ${w.address}\nApprove this address as an agent wallet from your main wallet (approveAgent) in your own browser wallet. The private key never leaves the keystore.\n`)
      return 0
    }
    if (sub === 'revoke') {
      const kind = sub2, id = sub3
      if (!id || (kind !== 'wallet' && kind !== 'agent')) throw new Error('用法：gitrader keys revoke <wallet|agent> <名字或 id>')
      const proof = await needPin(k, io)
      const origin = mkOrigin('user:usr_local', 'cli:keys.revoke', 'cli')
      if (kind === 'wallet') { const w = k.keystore.revoke(proof, id); k.ledger.append({ type: 'key.revoked', origin, subject: { orgId: 'org_local' }, payload: { walletId: w.walletId, address: w.address } }); io.out(`已吊销 API 钱包「${w.name}」。\n`) }
      else {
        const key = k.agents.listKeys().find((x) => x.keyId === id || x.name === id)
        if (!key) throw new Error(`没有这把 Agent 钥匙：${id}（用 gitrader keys list 查看名字）`)
        const r = revokeAgentKeyFully(k, key.keyId, proof, origin)
        io.out(`已吊销 Agent 钥匙「${key.name}」。\n`)
        // P1-6：名下待批自动作废；仓位与挂单不自动处理，只提示
        if (r.withdrawn.length) io.out(`已作废它的待批提案：${r.withdrawn.join('、')}\n`)
        if (r.openPositions || r.openOrders) io.out(`名下还有 ${r.openPositions} 个持仓、${r.openOrders} 张挂单未自动处理（需要时在工作台处理）\n`)
      }
      return 0
    }
    io.err('usage: gitrader keys list | import <name> | new wallet <name> | new agent <name> ... | rotate agent <名字或 id> [--token-file F] | revoke <wallet|agent> <id>\n')
    return 1
  } finally { await k.stop() }
}

// ---- 引擎（集成修补 H）-----------------------------------------------------------------
// bind：把引擎绑到账户（默认纸面账户）。纸面账户由内核用这次的 PIN 给引擎签一份 L1（纸面）授权书；实盘账户不走这里。
async function cmdEngines(home: string, a: Args, io: CliIo): Promise<number> {
  const sub = a.cmd[1]
  const live = await liveService(home)
  if (!live) { io.err(`${noServiceMsg(io)}\n`); return 1 }
  if (sub === 'list') {
    const rows = (await callOp(home, live, 'engine.list', 'read')) as Array<{ id: string; state: string; transport: string; gep: { state: string; bound: boolean; accounts: string[] } | null }>
    // R3-03：绑定的账户写别名（paper），不是 acct_… 编号——文档里「bound: 后面是纸面账户」才看得懂；查不到别名就退回编号
    const aliasOf = new Map<string, string>()
    try { for (const x of await callOp(home, live, 'account.list', 'read') as Array<{ accountId: string; alias: string }>) aliasOf.set(x.accountId, x.alias) } catch { /* 查不到就写编号 */ }
    io.out(rows.map((e) => `${e.id}  ${e.state}  ${e.transport}  gep:${e.gep?.state ?? '-'}  bound:${e.gep?.bound ? e.gep.accounts.map((id) => aliasOf.get(id) ?? id).join(',') : 'no'}`).join('\n') + '\n')
    return 0
  }
  if (sub === 'bind') {
    const id = a.cmd[2]
    if (!id) throw new Error('usage: gitrader engines bind <engine-id> [--account <alias|id>]')
    const accts = (await callOp(home, live, 'account.list', 'read')) as Array<{ accountId: string; alias: string; mode: string }>
    const want = flag(a, 'account')
    const acct = want ? accts.find((x) => x.accountId === want || x.alias === want) : accts.find((x) => x.mode === 'paper')
    if (!acct) throw new Error(want ? `no such account: ${want}` : 'no paper account found')
    cachedWriteSession(home, live) // UX-05：先查会话再问 PIN，别让人输完 PIN 才发现没登录
    const pin = await io.readSecret('PIN: ')
    const r = await callOp(home, live, 'engine.bind', 'write', { id, accounts: [acct.accountId] }, pin)
    io.out(tr(io, `已把引擎 ${id} 绑定到账户 ${acct.alias}（${acct.mode}）。`, `Bound ${id} to ${acct.alias} (${acct.mode}).`) + `${r.warnings?.length ? ` ${r.warnings.join('; ')}` : ''}\n`)
    return 0
  }
  io.err('usage: gitrader engines list | bind <engine-id> [--account <alias|id>]\n')
  return 1
}

// ---- 插件 ---------------------------------------------------------------------------
async function cmdRisk(home: string, a: Args, io: CliIo): Promise<number> {
  const [, sub, arg] = a.cmd
  const op = sub === 'verify' ? 'risk.verify' : sub === 'replay' && arg ? 'risk.replay' : sub === 'stats' ? 'risk.stats' : sub === 'policy' && arg === 'export' ? 'risk.policy.export' : sub === 'relax' && arg ? (a.flags.permanent !== undefined ? 'risk.relax' : 'risk.temporaryRelax') : null
  if (!op) throw new Error('usage: gitrader risk verify | replay <precheckId> | stats | policy export | relax <@file|json> [--hours N | --permanent]')
  let params: Record<string, unknown> = sub === 'replay' || sub === 'verify' && arg ? { precheckId: arg } : {}
  let until = 0
  if (sub === 'relax') {
    const raw = arg!.startsWith('@') ? readFileSync(resolve(arg!.slice(1)), 'utf8') : arg!
    params.patch = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (op === 'risk.temporaryRelax') {
      // C1\uFF1A\u9ED8\u8BA4\u4E34\u65F6\u653E\u5BBD\uFF08\u6700\u957F 24 \u5C0F\u65F6\uFF0C\u5230\u671F\u5185\u6838\u81EA\u52A8\u6536\u56DE\uFF09\uFF1B\u6C38\u4E45\u6539\u4E0A\u9650\u5FC5\u987B\u663E\u5F0F --permanent
      const hours = a.flags.hours === undefined ? 4 : Number(flag(a, 'hours'))
      if (!(hours > 0) || hours > 24) throw new Error('\u4E34\u65F6\u653E\u5BBD\u6700\u957F 24 \u5C0F\u65F6\uFF1A--hours \u8981\u5927\u4E8E 0 \u4E14\u4E0D\u8D85\u8FC7 24\uFF1B\u8981\u6C38\u4E45\u4FEE\u6539\u4E0A\u9650\u8BF7\u52A0 --permanent')
      const patch = params.patch as { limits?: unknown }
      if (!patch || typeof patch.limits !== 'object' || patch.limits === null || Object.keys(patch).some((key) => key !== 'limits')) throw new Error('\u4E34\u65F6\u653E\u5BBD\u53EA\u80FD\u6539 limits \u91CC\u7684\u9650\u989D\uFF0C\u4F8B\u5982 {"limits":{"maxOrderNotional":"3000"}}\uFF1B\u6539\u5176\u4ED6\u9879\u8BF7\u52A0 --permanent')
      until = Date.now() + Math.round(hours * 3_600_000)
      params = { fields: patch.limits, until }
    }
  }
  const live = await liveService(home)
  let result: unknown
  if (live) result = await callOp(home, live, op, sub === 'relax' ? 'write' : 'read', params, sub === 'relax' ? await io.readSecret('PIN: ') : undefined)
  else {
    const k = await openKernel(home, io)
    try {
      if (sub === 'verify') result = arg ? k.risk.replay(arg) : k.risk.verify()
      else if (sub === 'replay') result = k.risk.replay(arg!)
      else if (sub === 'stats') result = k.risk.stats()
      else if (sub === 'policy') result = k.risk.exportPolicy()
      else if (op === 'risk.temporaryRelax') result = k.risk.temporaryRelax(params.fields as never, until, await needPin(k, io), mkOrigin('user:usr_local', 'risk.temporaryRelax', 'cli'))
      else result = k.risk.relax(params.patch as never, await needPin(k, io), mkOrigin('user:usr_local', 'risk.relax', 'cli'))
    } finally { await k.stop() }
  }
  const by = flag(a, 'by')
  if (sub === 'stats' && (by === 'actor' || by === 'rule')) {
    // P1-10：按人 / 按规则的中文表；钥匙 id 换成名字（吊销的也保留名字）
    const keys = (live ? await callOp(home, live, 'agentkey.list', 'read') : await (async () => { const k = await openKernel(home, io); try { return k.agents.listKeys() } finally { await k.stop() } })()) as Array<{ keyId: string; name: string }>
    io.out(formatRiskStats(result as never, by, Object.fromEntries(keys.map((x) => [`agent:${x.keyId}`, x.name]))) + '\n')
    return 0
  }
  if (sub === 'relax' && (result as { ok?: boolean }).ok !== false) {
    const d = new Date(until)
    const p2 = (n: number): string => String(n).padStart(2, '0')
    io.out(op === 'risk.relax' ? '已永久修改上限（不会自动收回）\n' : `临时放宽至 ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}，到期自动收回\n`)
  }
  io.out(JSON.stringify(result, null, 2) + '\n')
  const r = result as { ok?: boolean; status?: string }
  return r.ok === false || r.status === 'diff' ? 1 : 0
}

async function cmdPlugins(home: string, a: Args, io: CliIo): Promise<number> {
  const sub = a.cmd[1]
  if (sub === 'install') return await cmdPluginsInstall(home, a, io)
  if (sub === 'pin') {
    const dir = a.cmd[2]
    if (!dir) throw new Error('usage: gitrader plugins pin <dir>')
    const r = pinPluginDir(resolve(dir))
    io.out(`Pinned ${r.files} files: source.sha256 = ${r.sha256}\n`)
    return 0
  }
  if (sub === 'reload') {
    const live = await liveService(home)
    if (live) {
      const r = await callOp(home, live, 'plugin.reload', 'write')
      io.out(`Reloaded (running service): +${r.added.length} ~${r.updated.length} -${r.removed.length}, rejected ${r.rejected.length}\n`)
      for (const x of r.rejected) io.out(`  rejected ${x.id}: ${x.issues.join('; ')}\n`)
      return r.rejected.length ? 2 : 0
    }
    const k = await openKernel(home, io)
    try {
      const r = await k.plugins.reload()
      io.out(`Reloaded: +${r.added.length} ~${r.updated.length} -${r.removed.length}, rejected ${r.rejected.length}\n`)
      for (const x of r.rejected) io.out(`  rejected ${x.id}: ${x.issues.join('; ')}\n`)
      return r.rejected.length ? 2 : 0
    } finally { await k.stop() }
  }
  if (sub === 'list') {
    const live = await liveService(home)
    const rows = live ? ((await callOp(home, live, 'plugin.list', 'read')) as any[]) : await (async () => { const k = await openKernel(home, io); try { await k.plugins.reload(); return k.plugins.list().map((p) => ({ ...p, name: p.manifest?.name, kind: p.manifest?.kind })) } finally { await k.stop() } })() // eslint-disable-line @typescript-eslint/no-explicit-any
    io.out(rows.length ? rows.map((p) => `${p.ok ? 'ok      ' : 'REJECTED'}  ${p.id}  ${p.version}  ${p.kind ?? ''}  granted:[${(p.granted ?? []).join(',')}] pending:[${(p.pending ?? []).join(',')}]${p.ok ? ` enabled:${p.enabled ? 'yes' : 'no'}` : `  ${p.issues.join('; ')}`}`).join('\n') + '\n' : `No plugins in ${homePaths(home).plugins}\n`)
    return 0
  }
  if (sub === 'check') {
    // --strict / --json 是布尔开关；parse 会把紧跟其后的词当成它的值，这里把它还给目录参数。
    const dir = [a.cmd[2], flag(a, 'strict'), flag(a, 'json')].find((x) => x !== undefined)
    if (!dir) throw new Error('usage: gitrader plugins check <dir> [--strict] [--json]')
    let trustRoots: { keyId: string; publicKey: string }[] = []
    try { trustRoots = loadConfig(home).plugins.trustRoots } catch { /* 没有 home / 没有配置：按没有受信根检查 */ }
    const r = inspectPluginDir(resolve(dir), { developerMode: a.flags.strict === undefined, trustRoots, kernelVersion: KERNEL_VERSION })
    if (a.flags.json !== undefined) {
      io.out(JSON.stringify({ ok: r.ok, id: r.id, version: r.version, problems: r.problems, pin: r.pin, signed: r.signed, trusted: r.trusted }, null, 2) + '\n')
    } else {
      for (const p of r.problems) io.out(`${p.code}  ${p.path}  ${p.message}\n${p.hint ? `    ${p.hint}\n` : ''}`)
      io.out(r.ok ? `ok ${r.id}@${r.version}\n` : `REJECTED ${r.problems.length} problem(s)\n`)
    }
    return r.ok ? 0 : 2
  }
  if (sub === 'grant') {
    const [, , id, ...perms] = a.cmd
    if (!id) throw new Error('usage: gitrader plugins grant <id> [perm ...]')
    // 当前授权入口是离线 CLI grant（本地 PIN）；先停止服务，避免同时写权限。
    if (await liveService(home)) { io.err('service is running: stop it (Ctrl+C in the `gitrader serve` terminal), then run `gitrader plugins grant` again with local PIN presence\n'); return 1 }
    const k = await openKernel(home, io)
    let granted: string[]
    try { await k.plugins.reload(); granted = k.plugins.grant(id, perms as never, await needPin(k, io)).granted } finally { await k.stop() }
    io.out(granted.length ? `granted ${id}: [${granted.join(',')}]\n` : `enabled ${id}\n`)
    return 0
  }
  if (sub === 'call') {
    const [, , id, tool, raw] = a.cmd
    if (!id || !tool) throw new Error('usage: gitrader plugins call <id> <tool> [json]')
    let args: unknown
    // 入参三种写法：字面 JSON / @文件路径 / -（stdin）。Windows 的 .cmd 垫片会吃掉内层双引号，推荐 @文件。
    let src = raw ?? '{}'
    try {
      if (src === '-') src = await (io.readStdin ?? (async () => { let s = ''; for await (const c of process.stdin) s += c; return s }))()
      else if (src.startsWith('@')) src = readFileSync(resolve(src.slice(1)), 'utf8')
    } catch (e) { throw new Error(`cannot read args from ${raw}: ${e instanceof Error ? e.message : String(e)}`) }
    try { args = JSON.parse(src.replace(/^﻿/, '') || '{}') } catch (e) { throw new Error(`args is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
    // 内核先查启用 / 声明 / 入参 / 权限，之后才发给插件进程；所以只在"插件还没起"（3003）时才拉起进程再试一次，没启用的插件不会被 call 拉起。
    const withStart = async (call: () => Promise<unknown>, start: () => Promise<unknown>): Promise<unknown> => {
      try { return await call() } catch (e) { if (problemOf(e)?.code !== 3003) throw e; await start(); return await call() }
    }
    try {
      const live = await liveService(home)
      let result: unknown
      if (live) result = await withStart(() => callOp(home, live, 'plugin.call', 'write', { id, tool, args }), () => callOp(home, live, 'plugin.start', 'write', { id }))
      else {
        const k = await openKernel(home, io)
        try { await k.plugins.reload(); result = await withStart(() => k.plugins.callTool(id, tool, args), () => k.plugins.start(id)) } finally { await k.plugins.stopAll(); await k.stop() }
      }
      io.out(JSON.stringify(result) + '\n')
      return 0
    } catch (e) {
      const p = problemOf(e)
      if (!p) throw e
      io.err(`${p.code} ${p.name}: ${p.message}\n`)
      return 1
    }
  }
  io.err('usage: gitrader plugins list | reload | pin <dir> | check <dir> [--strict] [--json] | grant <id> [perm...] | call <id> <tool> [json] | install [<名>]\n')
  return 1
}

// ---- 账本 ---------------------------------------------------------------------------
/** `ledger verify <文件或目录>`：目录 → 里面的 ledger.jsonl + manifest.json；直接给 ledger.jsonl 时到同目录找 manifest。 */
function verifyExportPath(target: string, a: Args, io: CliIo, dbPath: string): number {
  const json = a.flags.json === true
  const path = resolve(target)
  const jsonl = existsSync(path) && statSync(path).isDirectory() ? join(path, 'ledger.jsonl') : path
  const manifestPath = join(dirname(jsonl), 'manifest.json')
  let entries: LedgerEntry[]
  let manifest: ExportManifest
  try {
    entries = readFileSync(jsonl, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as LedgerEntry)
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest
  } catch (e) {
    const why = `读不出导出件：${jsonl}（同目录还需要 manifest.json）`
    if (json) io.out(JSON.stringify({ ok: false, error: why }) + '\n')
    else io.err(`${why}\n  ${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  // fix-r4 C2：本机库可读就用库里的安装密钥当受信公钥，并与库逐点比对；读不到就只验导出件自身。
  let local: { opts: Parameters<typeof verifyExport>[2]; close: () => void } | undefined
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(sqlitePath(dbPath), { readOnly: true })
      const meta = (k: string): string | undefined => (db.prepare('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | undefined)?.value
      const keyId = meta('install_key_id'), publicKey = meta('install_key_pub')
      const head = db.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1')
      const at = db.prepare('SELECT hash FROM ledger WHERE seq=?')
      local = {
        close: () => db.close(),
        opts: {
          ...(keyId && publicKey ? { trustedKey: { keyId, publicKey } } : {}),
          ledger: { head: () => head.get() as { seq: number; hash: string }, hashAt: (seq) => (at.get(seq) as { hash: string } | undefined)?.hash },
        },
      }
    } catch { local = undefined }
  }
  let res: ReturnType<typeof verifyExport>
  try { res = verifyExport(entries, manifest, local?.opts) } finally { local?.close() }
  if (json) io.out(JSON.stringify(res) + '\n')
  else if (res.ok) {
    const head = (res.lastHash ?? '').replace(/^sha256:/, '').slice(0, 12)
    if (res.signer) {
      const cmp = res.db?.compared ? `已与本机库比对${res.db.newerEntries ? `（库里在导出之后又新增 ${res.db.newerEntries} 条）` : ''}` : '未与本机库比对'
      io.out(`导出件完好：${res.count} 条，链头 ${head}；已核对签名（${res.signer}）；${cmp}\n`)
    } else {
      // 旧版（/1）无签名件：删尾 + 改 manifest 也能自洽，所以绝不写「完好」
      io.out(`链内自洽，但这是旧版无签名导出件，无法证明末尾没有被删（${res.count} 条，链头 ${head}）；${res.db?.compared ? '已与本机库比对' : '未与本机库比对'}\n`)
      if (res.db?.newerEntries) io.out(`库里在这之后还有 ${res.db.newerEntries} 条（可能是导出后新增，也可能是导出件被截断；旧版件无法区分）\n`)
    }
    for (const w of res.warnings ?? []) io.out(`提示：${w}\n`)
  } else {
    const seq = res.failure?.seq ?? -1
    const reason = res.failure?.reason ?? 'unknown'
    io.out(seq < 0 ? `导出件被改动：${reason}\n` : `导出件被改动：第 ${seq} 条起对不上（LEDGER BROKEN at seq ${seq}: ${reason}）\n`)
  }
  return res.ok ? 0 : 2
}

/** fix-r4 C3：默认导出目录 gitrader-ledger-YYYYMMDD-HHmmss（本地时间，与内核 ledger.export 同口径），重名加 -2、-3…。 */
function defaultExportName(exportRoot: string): string {
  const t = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const base = `gitrader-ledger-${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`
  let name = base
  for (let n = 2; existsSync(join(exportRoot, name)); n++) name = `${base}-${n}`
  return name
}

async function cmdLedger(home: string, a: Args, io: CliIo): Promise<number> {
  const sub = a.cmd[1]
  const p = homePaths(home)
  if (sub === 'verify') {
    const target = a.cmd[2]
    if (target !== undefined) return verifyExportPath(target, a, io, p.db)
    if (!existsSync(p.db)) throw new Error(`no ledger at ${p.db} (run gitrader init / serve first)`)
    const db = new DatabaseSync(sqlitePath(p.db), { readOnly: true })
    try {
      const meta = (k: string): string | undefined => (db.prepare('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | undefined)?.value
      const keyId = meta('install_key_id'), pub = meta('install_key_pub')
      const iter = function* (): Generator<LedgerEntry> { for (const r of db.prepare('SELECT entry FROM ledger ORDER BY seq').iterate() as Iterable<{ entry: string }>) yield JSON.parse(r.entry) as LedgerEntry }
      const res = verifyEntries(iter(), keyId && pub ? { publicKeys: { [keyId]: pub } } : {})
      if (a.flags.json) io.out(JSON.stringify(res) + '\n')
      else io.out(res.ok ? tr(io, `账本校验通过（Ledger OK: ${res.count} entries, seq 0..${res.lastSeq}, ${res.checkpoints} checkpoints, head ${res.lastHash}）\n`, `Ledger OK: ${res.count} entries, seq 0..${res.lastSeq}, ${res.checkpoints} checkpoints, head ${res.lastHash}\n`) : tr(io, `账本被破坏（LEDGER BROKEN at seq ${res.failure?.seq}）：${res.failure?.reason}\n`, `LEDGER BROKEN at seq ${res.failure?.seq}: ${res.failure?.reason}\n`))
      return res.ok ? 0 : 2
    } finally { db.close() }
  }
  if (sub === 'export') {
    const k = await openKernel(home, io)
    try {
      const exportRoot = join(home, 'exports')
      const relativeOut = flag(a, 'out') ?? defaultExportName(exportRoot)
      let out: string
      try { out = resolveConfinedPath(exportRoot, relativeOut, { anchorRoot: home }) } catch (e) {
        if (e instanceof Error && e.message === 'invalid workspace path') { io.err('--out 只接受 exports 目录下的相对名字（例如 --out 2026-10）：不能是绝对路径、带盘符、以 . 或 .. 开头。导出会写到 ' + exportRoot + ' 下面。\n'); return 2 }
        throw e
      }
      const targets = ['ledger.jsonl', 'manifest.json', 'trade-log.md', '账单.csv'].map((name) => resolveConfinedPath(out, name, { anchorRoot: exportRoot }))
      if (targets.some(existsSync)) { io.err('导出目标已经存在：' + out + '。换一个 --out 名字再试。\n'); return 2 }
      const m = k.ledger.export({ dir: out, exportedBy: mkOrigin('user:usr_local', 'cli:ledger.export', 'cli'), markdown: true, ...(a.flags.redact ? { redaction: 'payload' as const } : {}) })
      io.out('已导出 ' + m.count + ' 条（seq ' + m.fromSeq + '..' + m.toSeq + '）到 ' + out + '\n  ledger.jsonl  manifest.json  trade-log.md' + (a.flags.redact ? '（已去掉载荷，不含账单.csv）' : '  账单.csv') + '\n')
      return 0
    } finally { await k.stop() }
  }
  io.err('usage: gitrader ledger verify [<file-or-dir>] [--json] | export [--out DIR] [--redact]\n')
  return 1
}

