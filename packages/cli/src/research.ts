// SPDX-License-Identifier: CPAL-1.0
// gitrader research <optimize|walk-forward|factors|report|portfolio|search|status|result|cancel>（第六轮 C 包）：
// 装好的产品里的研究入口，形态照 Freqtrade 的 hyperopt / lookahead-analysis 子命令——一条命令起作业、默认等它跑完、--json 给机器读。
// 走内核的 research.call（与 MCP 的 research 工具同一份实现）；优先用已登录的会话（gitrader session login），没登录就用本机 service 令牌，不强制登录。
// 研究只读：不下单、不写交易类账本。退出码：0 成功；1 作业失败 / 找不到 / 服务没起；2 用法错误。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { callOp as realCallOp, flag, liveService as realLiveService } from './index'
import type { Args, CliIo, LiveServiceInfo } from './index'

export const RESEARCH_USAGE = `gitrader research <子命令>
  gitrader research optimize --strategy <id> --space <@文件|JSON> --validation <holdout:<根数>|wf:<训练>:<测试>[:<步长>]> [--instrument <id>] [--interval <iv>]
                             [--from <毫秒|ISO>] [--to <毫秒|ISO>] [--data <csv 路径>] [--search grid|random:<n>|evolution] [--seed N] [--fee <taker>] [--slippage <bps>] [--no-wait] [--json]
  gitrader research walk-forward ...   同 optimize，但 --validation 必须是 wf:…
  gitrader research factors --instrument <id> --interval <iv> --from <毫秒|ISO> --to <毫秒|ISO> [--data <csv 路径>] [--horizon N] [--window N] [--json]
  gitrader research report <回测作业 id> [--format md|json] [--out <文件>]
  gitrader research portfolio [--account <id>] [--json]
  gitrader research search <词> [--limit N] [--json]
  gitrader research status <作业 id> [--json]
  gitrader research result <作业 id> [--part trials|folds|factors] [--limit N] [--cursor C] [--json]
  gitrader research cancel <作业 id>
`

export interface ResearchDeps {
  liveService?: (home: string) => Promise<LiveServiceInfo | null>
  callOp?: (home: string, s: LiveServiceInfo, name: string, access: 'read' | 'write', params: Record<string, unknown>) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
}

class UsageError extends Error {}
const usage = (m: string): never => { throw new UsageError(m) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 毫秒数或 ISO 时间 → 毫秒。 */
export function parseTime(raw: string, name: string): number {
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
  if (!Number.isFinite(ms)) usage(`${name} must be epoch milliseconds or an ISO time (got ${JSON.stringify(raw)})`)
  return ms
}

/** --validation holdout:300 | wf:600:200[:100] */
export function parseValidation(raw: string): Record<string, unknown> {
  const p = raw.split(':')
  const num = (s: string | undefined, what: string): number => {
    const n = Number(s)
    if (!Number.isInteger(n) || n < 1) usage(`--validation ${what} must be a positive integer (got ${JSON.stringify(s)})`)
    return n
  }
  if (p[0] === 'holdout' && p.length === 2) return { kind: 'holdout', holdoutBars: num(p[1], 'holdout bars') }
  if ((p[0] === 'wf' || p[0] === 'walk-forward') && (p.length === 3 || p.length === 4)) return { kind: 'walk-forward', trainBars: num(p[1], 'train bars'), testBars: num(p[2], 'test bars'), ...(p.length === 4 ? { step: num(p[3], 'step') } : {}) }
  return usage('--validation must be holdout:<bars> or wf:<train>:<test>[:<step>]')
}

/** --search grid | random:<n> | evolution */
export function parseSearch(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === 'grid') return { kind: 'grid' }
  if (raw === 'evolution') return { kind: 'evolution' }
  const m = /^random:(\d+)$/.exec(raw)
  if (m && Number(m[1]) >= 1) return { kind: 'random', trials: Number(m[1]) }
  return usage('--search must be grid, random:<n> or evolution')
}

/** --space @文件 或内联 JSON。 */
export function parseSpace(raw: string): Record<string, unknown> {
  let text = raw
  if (raw.startsWith('@')) {
    try { text = readFileSync(resolve(raw.slice(1)), 'utf8') } catch { return usage(`cannot read the --space file ${raw.slice(1)}`) }
  }
  let v: unknown
  try { v = JSON.parse(text) } catch { return usage('--space must be a JSON object like {"fast":{"type":"integer","min":5,"max":15,"step":5}} or @file.json') }
  if (!isObj(v)) usage('--space must be a JSON object')
  return v as Record<string, unknown>
}

/** --data <csv|json 路径> → files 数据源（sha256 由这里算）；同时给出文件里的时间范围，--from/--to 缺省时用。 */
export function dataFromFile(path: string): { data: Record<string, unknown>; first?: number; last?: number } {
  const abs = resolve(path)
  let buf: Buffer
  try { buf = readFileSync(abs) } catch { return usage(`cannot read the --data file ${path}`) }
  const format = extname(abs).toLowerCase() === '.json' ? 'json' : 'csv'
  const data = { source: 'files', files: [{ path: abs, sha256: `sha256:${createHash('sha256').update(buf).digest('hex')}`, format }] }
  if (format !== 'csv') return { data }
  const ts = buf.toString('utf8').split(/\r?\n/).map((l) => Number(l.split(',')[0])).filter((t) => Number.isFinite(t) && t > 0)
  return ts.length > 0 ? { data, first: Math.min(...ts), last: Math.max(...ts) } : { data }
}

const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000 }

/** 数据源 + 时间范围：给了 --data 就用文件（--from/--to 缺省取文件的首尾），否则 --from/--to 必填，数据走宿主行情。 */
function dataAndWindow(a: Args, interval: string): { data: Record<string, unknown>; from: number; to: number } {
  const file = flag(a, 'data')
  const f = file === undefined ? null : dataFromFile(file)
  const fromRaw = flag(a, 'from')
  const toRaw = flag(a, 'to')
  const from = fromRaw !== undefined ? parseTime(fromRaw, '--from') : f?.first
  const to = toRaw !== undefined ? parseTime(toRaw, '--to') : f?.last !== undefined ? f.last + (INTERVAL_MS[interval] ?? 3_600_000) : undefined
  if (from === undefined || to === undefined) return usage('--from and --to are required (epoch milliseconds or ISO time) unless --data points at a csv file')
  return { data: f?.data ?? { source: 'host' }, from, to }
}

export function buildOptimizeSpec(a: Args, kind: 'optimize' | 'walk-forward'): Record<string, unknown> {
  const strategy = flag(a, 'strategy')
  if (!strategy) usage('--strategy <id> is required')
  const spaceRaw = flag(a, 'space')
  if (!spaceRaw) usage('--space <@file|JSON> is required')
  const validationRaw = flag(a, 'validation')
  if (!validationRaw) usage('--validation is required (holdout:<bars> or wf:<train>:<test>[:<step>])')
  const validation = parseValidation(validationRaw!)
  if (kind === 'walk-forward' && validation.kind !== 'walk-forward') usage('research walk-forward needs --validation wf:<train>:<test>[:<step>]')
  const interval = flag(a, 'interval') ?? '1h'
  const win = dataAndWindow(a, interval)
  const taker = flag(a, 'fee') ?? '0.0005'
  const slippage = flag(a, 'slippage') === undefined ? 3 : Number(flag(a, 'slippage'))
  const seed = flag(a, 'seed') === undefined ? 42 : Number(flag(a, 'seed'))
  if (!Number.isFinite(slippage) || !Number.isInteger(seed)) usage('--slippage must be a number and --seed an integer')
  return {
    subject: { strategy: { id: strategy, version: flag(a, 'strategy-version') ?? '0.1.0', params: {} } },
    instruments: [flag(a, 'instrument') ?? 'hyperliquid:BTC'], interval, from: win.from, to: win.to, data: win.data,
    account: { initialBalance: flag(a, 'balance') ?? '10000', ccy: 'USDC', leverage: flag(a, 'leverage') === undefined ? 1 : Number(flag(a, 'leverage')) },
    assumptions: { fees: { maker: '0.0002', taker }, slippageBps: slippage, fillModel: 'next-bar-open', funding: false, liquidation: false },
    seed, space: parseSpace(spaceRaw!), search: parseSearch(flag(a, 'search')), validation,
  }
}

export function buildFactorSpec(a: Args): Record<string, unknown> {
  const instrument = flag(a, 'instrument')
  const interval = flag(a, 'interval')
  if (!instrument || !interval) usage('--instrument <id> and --interval <iv> are required')
  const win = dataAndWindow(a, interval!)
  const n = (k: string): { [k: string]: number } => { const v = flag(a, k); if (v === undefined) return {}; const x = Number(v); if (!Number.isInteger(x) || x < 1) usage(`--${k} must be a positive integer`); return { [k]: x } }
  return { instruments: [instrument], interval, from: win.from, to: win.to, data: win.data, ...n('horizon'), ...n('window'), ...n('quantiles'), ...n('top') }
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function humanOptimize(s: Record<string, unknown>): string {
  const best = isObj(s.best) ? s.best : null
  const of = isObj(s.overfit) ? s.overfit : {}
  const v = isObj(s.validation) ? s.validation : {}
  const lines = [
    ...(typeof s.banner === 'string' ? [s.banner] : []),
    `job ${String(s.jobId)}  ${isObj(s.strategy) ? String(s.strategy.id) : ''}  ${String(s.instrumentId)} ${String(s.interval)}  ${String(s.bars)} bars  ${String(s.searchKind)} ${String(s.trialCount)} trials`,
    `best params: ${best ? JSON.stringify(best.params) : 'none'}  in-sample score ${best ? String(best.score) : '-'}`,
    `overfit: PBO ${String(of.pbo)}  DSR ${String(of.dsr)}  trials ${String(of.trials)}`,
    `validation: ${String(v.kind)}  out-of-sample score ${String(v.oosScore)}  folds ${String(v.folds)}`,
    ...(Array.isArray(s.warnings) ? (s.warnings as unknown[]).slice(0, 5).map((w) => `warning: ${String(w)}`) : []),
    `details: gitrader research result ${String(s.jobId)} --part trials|folds`,
  ]
  return `${lines.join('\n')}\n`
}

export async function cmdResearch(home: string, a: Args, io: CliIo, deps: ResearchDeps = {}): Promise<number> {
  const sub = a.cmd[1]
  const json = a.flags.json === true
  const print = (v: unknown): void => io.out(`${JSON.stringify(v, null, json ? undefined : 2)}\n`)
  try {
    if (sub === undefined || sub === 'help') { io.out(RESEARCH_USAGE); return sub === undefined ? 2 : 0 }
    // 先把参数校验完（用法错误不需要服务）
    let call: { action: string; args: Record<string, unknown> }
    const need = (i: number, what: string): string => a.cmd[i] ?? usage(`${what} is required`)
    switch (sub) {
      case 'optimize': call = { action: 'optimize', args: { spec: buildOptimizeSpec(a, 'optimize') } }; break
      case 'walk-forward': call = { action: 'walk_forward', args: { spec: buildOptimizeSpec(a, 'walk-forward') } }; break
      case 'factors': call = { action: 'factor_report', args: { spec: buildFactorSpec(a) } }; break
      case 'report': call = { action: 'backtest_report', args: { jobId: need(2, 'the backtest job id'), format: flag(a, 'format') ?? 'md' } }; break
      case 'portfolio': call = { action: 'portfolio', args: flag(a, 'account') ? { accountId: flag(a, 'account') } : {} }; break
      case 'search': call = { action: 'search', args: { query: need(2, 'the search words'), ...(flag(a, 'limit') ? { limit: Number(flag(a, 'limit')) } : {}) } }; break
      case 'status': call = { action: 'status', args: { jobId: need(2, 'the job id') } }; break
      case 'cancel': call = { action: 'cancel', args: { jobId: need(2, 'the job id') } }; break
      case 'result': call = { action: 'result', args: { jobId: need(2, 'the job id'), ...(flag(a, 'part') ? { part: flag(a, 'part') } : {}), ...(flag(a, 'limit') ? { limit: Number(flag(a, 'limit')) } : {}), ...(flag(a, 'cursor') ? { cursor: flag(a, 'cursor') } : {}) } }; break
      default: return usage(`unknown research subcommand: ${sub}`)
    }

    const live = await (deps.liveService ?? realLiveService)(home)
    if (!live) { io.err('No running Gitrader service for this home. Start it with: gitrader serve\n'); return 1 }
    const op = (c: { action: string; args: Record<string, unknown> }): Promise<any> => (deps.callOp ?? realCallOp)(home, live, 'research.call', 'write', { action: c.action, ...c.args }) // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await op(call)

    if (sub === 'optimize' || sub === 'walk-forward' || sub === 'factors') {
      if (a.flags['no-wait'] === true) { print(r); return 0 }
      const sleep = deps.sleep ?? defaultSleep
      const jobId = String(r.jobId)
      let state = String(r.state)
      for (let waited = 0; !TERMINAL.has(state) && waited < 30 * 60_000; waited += 500) {
        await sleep(500)
        const st = await op({ action: 'status', args: { jobId } })
        state = String(st.state)
        if (!json && st.progress?.total) io.err(`\r${state} ${st.progress.done}/${st.progress.total}   `)
      }
      if (!json) io.err('\n')
      if (state !== 'done') {
        if (state === 'cancelled') io.err(`job ${jobId} was cancelled\n`)
        else { try { await op({ action: 'result', args: { jobId } }) } catch (e) { io.err(`job ${jobId} failed: ${e instanceof Error ? e.message : String(e)}\n`); return 1 } io.err(`job ${jobId} did not finish (state ${state})\n`) }
        return 1
      }
      const summary = await op({ action: 'result', args: { jobId } })
      if (json) print(summary)
      else io.out(sub === 'factors' ? `${JSON.stringify(summary, null, 2)}\n` : humanOptimize(summary))
      return 0
    }
    if (sub === 'report') {
      const text: string = flag(a, 'format') === 'json' ? JSON.stringify(r, null, 2) : String(r.markdown ?? '')
      const out = flag(a, 'out')
      if (out) { writeFileSync(resolve(out), text.endsWith('\n') ? text : `${text}\n`, 'utf8'); io.out(`${resolve(out)}\n`) } else io.out(text.endsWith('\n') ? text : `${text}\n`)
      return 0
    }
    print(r)
    return 0
  } catch (e) {
    if (e instanceof UsageError) { io.err(`${e.message}\n${RESEARCH_USAGE}`); return 2 }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}
