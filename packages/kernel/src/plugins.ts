// SPDX-License-Identifier: CPAL-1.0
// 插件宿主（契约 §3）：清单校验 → 钉版本 + 哈希 → 权限默认拒绝 → Node 插件子进程 + 消息通道（GSP，NDJSON）→ 生命周期。
//
// 目录约定：<home>/plugins/<目录名>/gitrader-plugin.json（丢进去就是安装），或 <home>/plugins/<id>/<version>/gitrader-plugin.json（契约 §3.5 落盘形态）。
// 哈希钉死：清单 source.sha256 = sha256(JCS(制品清单))；制品清单 = 包内除清单外每个文件的 {path, sha256}，按路径排序。
// 签名摘要（§3.4）：digest = sha256( JCS(清单去掉 signature) ‖ JCS(制品清单) )，Ed25519 签名；信任根 = 内置 + 开发者模式里手动加入的密钥。
// 强制程度如实写明：权限在内核 API 层强制（插件只能经内核拿数据）；进程层 Node 权限模型限制文件读写与子进程（尽力而为，网络限制不由 Node 22 强制）。
import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GEP_LIMITS, GSP_VERSION, NEVER_GRANTABLE_PERMISSIONS, PLUGIN_HEALTH, PLUGIN_PERMISSIONS, canonicalize, checkPluginCompat, checkPluginManifestIssues, compileSchema, formatIssues, makeProblem, validatePluginManifest, compareVersions, parseVersion,
} from './proto'
import type { PluginIssue, PluginManifest, PluginPermission, PluginState, PluginTool, Problem, ValidationResult } from './proto'
import { assertProof } from './auth'
import type { HumanProof } from './auth'
import type { Docs } from './db'
import type { EventBus } from './events'
import { InstallKey } from './install-key'
import type { Ledger } from './ledger'
import { KernelError, findSecretKeys } from './util/errors'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'
import { pluginLaunch, RemotePluginTransport } from './plugin-transport'
import { pluginSecretEnv, containsPluginSecret } from './plugin-secrets'
import { minimalSystemEnv } from './util/system-env'

/** In-process capability; generic Agent and human plugin calls cannot supply it. */
export const NOTIFICATION_CALL = Symbol('notification outlet')

export const MANIFEST_FILE = 'gitrader-plugin.json'
/** 工具结果上限（JSON 文本字节数）。 */
const TOOL_RESULT_MAX_BYTES = 1024 * 1024
/** 内置信任根（Gitrader 发布密钥、UNIGIT 商店密钥）。TODO: 发布时填入真实公钥；现在为空 = 只认配置里手动加入的密钥。 */
export const BUILTIN_TRUST_ROOTS: { keyId: string; publicKey: string }[] = []

const sha = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex')
const fail = (name: Parameters<typeof makeProblem>[0], m: string): KernelError => new KernelError(makeProblem(name, m))

/** 被拒插件的报错文案：前 3 条问题码 + 余数；含哈希不符时提示重新钉版本。 */
function failedValidation(rec: PluginRecord, tail = ''): string {
  const top = rec.problems.slice(0, 3).map((p) => `[${p.code}] ${p.message}`).join('; ')
  const more = rec.problems.length > 3 ? ` (+${rec.problems.length - 3} more)` : ''
  const pin = rec.problems.some((p) => p.code === 'HASH_MISMATCH') ? ' (run: gitrader plugins pin <dir>)' : ''
  return `plugin ${rec.id} failed validation${tail}: ${top}${more}${pin}`
}

export interface Artifact { path: string; sha256: string }

/** 包内每个文件（不含清单本身）的 {path, sha256}，路径用 / 分隔，按路径排序。 */
export function artifactList(dir: string): Artifact[] {
  const out: Artifact[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' && d === dir) continue
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (!(d === dir && name === MANIFEST_FILE)) out.push({ path: relative(dir, p).split(sep).join('/'), sha256: sha(readFileSync(p)) })
    }
  }
  walk(dir)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** 清单 source.sha256 应有的值。 */
export const pinOf = (artifacts: Artifact[]): string => `sha256:${sha(canonicalize(artifacts))}`
/** 签名摘要（§3.4）。 */
export function signingDigest(manifest: PluginManifest, artifacts: Artifact[]): string {
  const { signature: _s, ...rest } = manifest
  return `sha256:${sha(canonicalize(rest) + canonicalize(artifacts))}`
}

// ---- R2-REL-10：随包插件内容哈希清单（不引入签名私钥）-------------------------------------------------
// 信任 = 插件的 id、version、内容 pin、清单摘要全都和产品自己发布的清单对得上。清单在构建时生成（packages/cli/build.mjs），
// 随产品发布在 dist/plugins-bundled/BUNDLED-HASHES.json；内核只从产品目录读，不认 GITRADER_HOME / 配置 / 环境变量里的同名文件。
export const BUNDLED_HASHES_FILE = 'BUNDLED-HASHES.json'
export const BUNDLED_HASHES_SCHEMA = 'gitrader-bundled-hashes/1'
export interface BundledHash { dir: string; id: string; version: string; pin: string; manifest: string }

/** 清单摘要：去掉签名、source.sha256 换成内容 pin 之后的规范化 JSON 的 sha256。pin 不含清单文件本身，所以清单（权限 / 启动命令）要单独绑定。 */
export function bundledManifestDigest(m: PluginManifest, pin: string): string {
  const { signature: _s, ...rest } = m
  return `sha256:${sha(canonicalize({ ...rest, source: { ...rest.source, sha256: pin } }))}`
}

/** 构建时用：扫描 <root>/<目录>/gitrader-plugin.json，生成清单内容。 */
export function bundledHashManifest(root: string): { schema: string; plugins: BundledHash[] } {
  const plugins: BundledHash[] = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, d.name)
    if (!d.isDirectory() || !existsSync(join(dir, MANIFEST_FILE))) continue
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as PluginManifest
    const pin = pinOf(artifactList(dir))
    plugins.push({ dir: d.name, id: m.id, version: m.version, pin, manifest: bundledManifestDigest(m, pin) })
  }
  plugins.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  return { schema: BUNDLED_HASHES_SCHEMA, plugins }
}

/** 读一份清单文件；读不出 / schema 不对 / 条目不合法的一律当没有（= 没有随包信任，未签名插件照旧要开发者模式）。 */
export function readBundledHashes(file: string): BundledHash[] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { schema?: unknown; plugins?: unknown }
    if (j.schema !== BUNDLED_HASHES_SCHEMA || !Array.isArray(j.plugins)) return []
    const digest = /^sha256:[0-9a-f]{64}$/
    return j.plugins.filter((e): e is BundledHash => !!e && typeof e === 'object' && typeof e.dir === 'string' && typeof e.id === 'string' && typeof e.version === 'string' && digest.test(e.pin) && digest.test(e.manifest))
  } catch { return [] }
}

let productHashes: BundledHash[] | undefined
/** 产品自己的清单：bin.js 所在目录的 plugins-bundled/（单文件打包时那里就是 dist/）；在源码树里跑时退到 packages/cli/dist。 */
export function productBundledHashes(): BundledHash[] {
  if (productHashes) return productHashes
  let here = ''
  try { here = dirname(fileURLToPath(import.meta.url)) } catch { /* 没有 import.meta.url：没有产品目录 */ }
  const candidates = here ? [join(here, 'plugins-bundled', BUNDLED_HASHES_FILE)] : []
  if (here && basename(here) === 'src' && basename(dirname(here)) === 'kernel') candidates.push(join(here, '..', '..', 'cli', 'dist', 'plugins-bundled', BUNDLED_HASHES_FILE))
  productHashes = []
  for (const file of candidates) { const list = readBundledHashes(file); if (list.length) { productHashes = list; break } }
  return productHashes
}

/** 'trusted' = id、version、内容 pin、清单摘要都对得上；'mismatch' = id 和 version 是随包的但内容被改过；'none' = 不是随包插件。 */
function bundledVerdict(m: PluginManifest, pin: string, list: readonly BundledHash[] | undefined): 'trusted' | 'mismatch' | 'none' {
  const same = (list ?? []).filter((e) => e.id === m.id && e.version === m.version)
  if (same.length === 0) return 'none'
  const digest = bundledManifestDigest(m, pin)
  return same.some((e) => e.pin === pin && e.manifest === digest) ? 'trusted' : 'mismatch'
}

/** 计算并写回 source.sha256（给插件作者的钉版本工具，CLI: gitrader plugins pin <dir>）。 */
export function pinPluginDir(dir: string): { sha256: string; files: number } {
  const file = join(dir, MANIFEST_FILE)
  const m = JSON.parse(readFileSync(file, 'utf8')) as PluginManifest
  const arts = artifactList(dir)
  m.source = { ...m.source, sha256: pinOf(arts) as never }
  writeFileSync(file, JSON.stringify(m, null, 2) + '\n', 'utf8')
  return { sha256: m.source.sha256, files: arts.length }
}

/** 只认清单里写的 id；清单读不出或 id 不是字符串 = undefined（认不出这个目录是哪个插件）。 */
function manifestIdOf(dir: string): string | undefined {
  try { const id = (JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as { id?: unknown }).id; return typeof id === 'string' ? id : undefined } catch { return undefined }
}

export interface PluginRecord {
  id: string
  version: string
  dir: string
  ok: boolean
  /** 校验没过的原因（人读）：`[CODE] message`，由 problems 派生。 */
  issues: string[]
  /** 结构化问题（r2）：code / path / message / hint?。 */
  problems: PluginIssue[]
  /** Existing protocol Problem for launch rejection; manifest issue codes remain frozen. */
  problem?: Problem
  warnings?: string[]
  manifest?: PluginManifest
  pin?: string
  /** sha256(JCS(清单去掉 signature))：清单本身变了也算升级。 */
  manifestHash?: string
  signed: boolean
  trusted: boolean
  /** 清单声明的权限里，用户已同意的。默认全部拒绝。 */
  granted: PluginPermission[]
  pending: PluginPermission[]
  /** 用户至少授权（含空授权）过一次 = 启用；没启用的插件不能被调用。 */
  enabled: boolean
  /** 清单声明的工具（没写进来的工具内核不转发）。 */
  tools: PluginTool[]
  state: PluginState
  blocks: { id: string; name?: string; entry?: unknown }[]
  /** GQ-56：上次真正读盘校验（reload / verify）的内核时间戳；list() 默认只给缓存结果，不保证现在磁盘上的文件还一致。 */
  lastVerifiedAt?: number
}

export interface InspectOptions {
  developerMode: boolean
  trustRoots: { keyId: string; publicKey: string }[]
  /** 内核版本；空串 = 不做兼容检查（只给没有内核上下文的最小宿主用）。 */
  kernelVersion: string
  /** R2-REL-10：产品发布的随包插件哈希清单。不给 = 没有随包信任（纯函数不读磁盘）。 */
  bundledHashes?: readonly BundledHash[]
}

/** 校验一个插件目录（纯函数，只读文件系统）；不抛错，问题写进 problems / issues（"拒绝"= ok:false）。 */
export function inspectPluginDir(dir: string, opts: InspectOptions, probe?: { idKnown: boolean }): PluginRecord {
  const problems: PluginIssue[] = []
  const rec: PluginRecord = { id: dir.split(sep).pop() ?? dir, version: '', dir, ok: false, issues: [], problems, signed: false, trusted: false, granted: [], pending: [], enabled: false, tools: [], state: 'installed', blocks: [] }
  const add = (code: PluginIssue['code'], path: string, message: string, hint?: string): void => { problems.push(hint === undefined ? { code, path, message } : { code, path, message, hint }) }
  const done = (): PluginRecord => { rec.ok = problems.length === 0; rec.issues = problems.map((p) => `[${p.code}] ${p.message}`); return rec }
  let m: PluginManifest
  try { m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as PluginManifest } catch (e) {
    add('MANIFEST_UNREADABLE', '/', `cannot read ${MANIFEST_FILE}: ${e instanceof Error ? e.message : String(e)}`)
    return done()
  }
  if (probe) probe.idKnown = typeof m.id === 'string' // 本次读盘是否认得出这个目录是哪个插件（reload 判「状态不明」只认这一次，不再读第二遍）
  rec.id = typeof m.id === 'string' ? m.id : rec.id
  rec.version = typeof m.version === 'string' ? m.version : ''
  const v = validatePluginManifest(m)
  if (!v.ok) {
    if (v.issues.some((i) => i.keyword !== 'semantic')) {
      // schema 层失败：权限枚举里没有的值（永不可授予的 / 拼错的）单独点名，比 enum 报错好懂，并去掉同位置的枚举噪声
      const never = new Set<string>()
      if (Array.isArray(m.permissions)) m.permissions.forEach((p, i) => {
        const path = `/permissions/${i}`
        if ((NEVER_GRANTABLE_PERMISSIONS as readonly string[]).includes(p as string)) { never.add(path); add('PERMISSION_NEVER_GRANTABLE', path, `permission ${String(p)} can never be granted`) }
        else if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(p as string)) { never.add(path); add('PERMISSION_UNKNOWN', path, `unknown permission ${String(p)}`, `valid permissions: ${PLUGIN_PERMISSIONS.join(', ')}`) }
      })
      for (const i of v.issues) if (!never.has(i.path)) add((i.code ?? 'SCHEMA') as PluginIssue['code'], i.path, `${i.path} ${i.message}`)
      return done()
    }
    problems.push(...checkPluginManifestIssues(m)) // 语义问题：带 hint 的原始形态；继续往下查，一次报全
  }
  rec.manifest = m
  rec.manifestHash = sha(canonicalize((({ signature: _s, ...rest }) => rest)(m)))
  rec.tools = Array.isArray(m.tools) ? m.tools : []
  const arts = artifactList(dir)
  rec.pin = pinOf(arts)
  if (m.source.sha256 !== rec.pin) add('HASH_MISMATCH', '/source/sha256', `hash mismatch: manifest source.sha256 is ${m.source.sha256}, package contents hash to ${rec.pin} (run: gitrader plugins pin <dir>)`)
  if (m.signature) {
    rec.signed = true
    const root = [...BUILTIN_TRUST_ROOTS, ...opts.trustRoots].find((r) => r.keyId === m.signature!.keyId)
    if (!root) add('SIGNATURE_KEY_UNTRUSTED', '/signature/keyId', `signature key ${m.signature.keyId} is not a trusted root`)
    else {
      const digest = signingDigest(m, arts)
      if (digest !== m.signature.digest) add('SIGNATURE_DIGEST_MISMATCH', '/signature/digest', 'signature digest does not match package contents')
      else if (!InstallKey.verify(root.publicKey, digest, m.signature.sig)) add('SIGNATURE_INVALID', '/signature/sig', 'signature verification failed')
      else rec.trusted = true
    }
  } else if (!opts.developerMode) {
    // 未签名只能在开发者模式安装；不得申请 trade.live / venue.credentials（语义检查已查）。随包插件例外：内容和产品清单逐项对得上就按内置信任放行。
    const verdict = bundledVerdict(m, rec.pin, opts.bundledHashes)
    if (verdict === 'trusted') rec.trusted = true
    else if (verdict === 'mismatch') add('UNSIGNED_NOT_ALLOWED', '/signature', 'unsigned plugin: its id and version are a bundled plugin but its contents differ from the hash list shipped with this release (modified after install); reinstall it with: gitrader plugins install <name> --force')
    else add('UNSIGNED_NOT_ALLOWED', '/signature', 'unsigned plugin: enable plugins.developerMode in gitrader.json to load it')
  }
  {
    const mod = m.entry?.module
    if (m.runtime.type === 'node' && !mod) add('ENTRY_MISSING', '/entry/module', 'node plugin requires entry.module')
    if (mod && !existsSync(resolve(dir, mod))) add('ENTRY_NOT_FOUND', '/entry/module', `entry.module not found: ${mod}`)
    if (mod && !resolve(dir, mod).startsWith(resolve(dir) + sep)) add('ENTRY_ESCAPES', '/entry/module', 'entry.module escapes the plugin directory')
  }
  const remote = m.entry?.transport === 'ws' || m.entry?.transport === 'wss'
  const extension = (m as unknown as Record<string, unknown>)['x-launch']
  const auth = extension && typeof extension === 'object' ? (extension as { auth?: unknown }).auth : undefined
  if (auth && typeof auth === 'object' && 'tokenRef' in auth) {
    rec.warnings = ['manifest tokenRef ignored; the host derives the plugin credential reference']
  }
  if (remote) {
    rec.problem = makeProblem('CAPABILITY_UNSUPPORTED', 'remote plugins arrive with S3-C')
    add('SCHEMA', '/entry/transport', `[${rec.problem.code}] ${rec.problem.message}`)
  } else if (m.runtime.type === 'sidecar' || m.runtime.type === 'python-sidecar') {
    try {
      const launch = pluginLaunch(m)
      if (launch && 'command' in launch && launch.cwd) {
        const cwd = resolve(dir, launch.cwd)
        if (cwd !== resolve(dir) && !cwd.startsWith(resolve(dir) + sep)) {
          add('ENTRY_ESCAPES', '/x-launch/cwd', 'x-launch.cwd escapes the plugin directory')
        }
      }
    } catch (e) {
      if (!(e instanceof KernelError)) throw e
      rec.problem = e.problem
      add('SCHEMA', '/x-launch', `[${e.problem.code}] ${e.problem.message}`)
    }
  }
  if (opts.kernelVersion) problems.push(...checkPluginCompat(m, opts.kernelVersion))
  // 未受信者不得自称已验证（只改内存里的副本，不改磁盘）
  if (!rec.trusted && m.vendor.verified) rec.manifest = { ...m, vendor: { ...m.vendor, verified: false } }
  rec.blocks = (m.ui?.blocks ?? []).map((b) => (typeof b === 'string' ? { id: b } : { id: String((b as { id?: string }).id ?? ''), name: (b as { name?: string }).name, entry: (b as { entry?: unknown }).entry }))
  return done()
}

export interface PluginHostOptions {
  home: string
  pluginsDir: string
  docs: Docs
  ledger: Ledger
  events: EventBus
  clock: Clock
  developerMode: () => boolean
  trustRoots: () => { keyId: string; publicKey: string }[]
  /** 随包插件哈希清单；缺省 = 产品目录里的 BUNDLED-HASHES.json（测试可注入）。 */
  bundledHashes?: () => readonly BundledHash[]
  /** 内核版本，用于 compat.gitrader 检查；缺省 = 不检查。 */
  kernelVersion?: string
  backoffMinMs?: number
  backoffMaxMs?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  shutdownGraceMs?: number
  /** Maximum stdio drain after process exit; inherited handles are destroyed after 2 s by default. */
  stdioCloseGraceMs?: number
  /** Remote GSP channel credential handle; absence fails closed like remote engines. */
  resolveSecret?: (ref: string) => string | undefined
  secretHandles?: () => Record<string, Record<string, string>>
  log?: (message: string) => void
  /** 已知集合（docs 里 pluginknown）当前的全部 id；对账靠它发现「账上有、磁盘上没了」的插件。缺省 = 只认本进程扫描到过的。 */
  knownIds?: () => string[]
}

interface Proc {
  child?: ChildProcess
  remote?: RemotePluginTransport
  send?: (text: string) => boolean
  buf: string
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>
  nextId: number
  token: string
  failures: number
  crashes: number[]
  restarts: number
  health?: ReturnType<typeof setInterval>
  retry?: ReturnType<typeof setTimeout>
  wantRun: boolean
  secretValues?: string[]
}

export class PluginHost {
  private recs = new Map<string, PluginRecord>()
  private procs = new Map<string, Proc>()
  /** 工具入参 / 出参校验函数缓存，key = `${id}\n${tool}` / `${id}\n${tool}\nout`；reload 后清空。 */
  /** 用户显式 stop 过的插件：不自动拉起，直到再次 start。 */
  private stoppedByUser = new Set<string>()
  /** 进行中的拉起（含崩溃后的退避重启）：并发调用等同一个 promise。 */
  private starting = new Map<string, Promise<void>>()
  private retries = new Map<string, { timer: ReturnType<typeof setTimeout>; crashes: number[]; restarts: number }>()
  private validators = new Map<string, (data: unknown) => ValidationResult<unknown>>()
  private secretProblems = new Map<string, KernelError>()

  constructor(private o: PluginHostOptions) {}

  list(): PluginRecord[] { return [...this.recs.values()] }
  /**
   * GQ-56：重新读盘校验一个已登记的插件（哈希 / 清单 / 签名），把结果写回登记项并更新 lastVerifiedAt；
   * 校验由过变不过（运行中被改文件）时顺手停掉它的进程，之后 callTool 因 ok:false 拒绝。授权、启用、工具表不动。返回 undefined = 没有这个 id。
   */
  async verify(id: string): Promise<PluginRecord | undefined> {
    const rec = this.recs.get(id)
    if (!rec) return undefined
    const fresh = this.inspect(rec.dir)
    const wasOk = rec.ok
    rec.ok = fresh.ok; rec.issues = fresh.issues; rec.problems = fresh.problems
    if (fresh.pin !== undefined) rec.pin = fresh.pin
    rec.lastVerifiedAt = this.o.clock.now()
    if (wasOk && !fresh.ok) { this.validators.clear(); await this.haltProc(id) }
    return rec
  }
  /** 重新校验全部已登记插件（工作台「刷新」用）。 */
  async verifyAll(): Promise<PluginRecord[]> {
    for (const id of [...this.recs.keys()]) await this.verify(id)
    return this.list()
  }
  get(id: string): PluginRecord | undefined { return this.recs.get(id) }

  // ---- 校验 ----------------------------------------------------------------------
  /** 校验一个插件目录（委托 inspectPluginDir）。 */
  inspect(dir: string, probe?: { idKnown: boolean }): PluginRecord {
    return inspectPluginDir(dir, { developerMode: this.o.developerMode(), trustRoots: this.o.trustRoots(), kernelVersion: this.o.kernelVersion ?? '', bundledHashes: this.o.bundledHashes ? this.o.bundledHashes() : productBundledHashes() }, probe)
  }

  private grantDoc(id: string): { granted: PluginPermission[]; enabledAt?: number } | undefined { return this.o.docs.get<{ granted: PluginPermission[]; enabledAt?: number }>('plugingrant', id) }
  private grantsOf(id: string): PluginPermission[] { return this.grantDoc(id)?.granted ?? [] }
  /** 启用 = 用户至少授权（含空授权）过一次。 */
  enabled(id: string): boolean { return this.grantDoc(id) !== undefined }

  private candidates(): string[] {
    const root = this.o.pluginsDir
    if (!existsSync(root)) return []
    const out: string[] = []
    for (const a of readdirSync(root)) {
      const p = join(root, a)
      if (!statSync(p).isDirectory()) continue
      if (existsSync(join(p, MANIFEST_FILE))) out.push(p)
      else for (const b of readdirSync(p)) { const q = join(p, b); if (statSync(q).isDirectory() && existsSync(join(q, MANIFEST_FILE))) out.push(q) }
    }
    return out
  }

  /** 重载：扫描目录 → 校验 → 登记（新增 / 升级 / 移除入账）。已运行的插件若哈希变了会被停掉。 */
  async reload(): Promise<{ added: string[]; updated: string[]; removed: string[]; rejected: { id: string; issues: string[]; problems: PluginIssue[] }[] }> {
    const seen = new Set<string>()
    this.validators.clear()
    const res = { added: [] as string[], updated: [] as string[], removed: [] as string[], rejected: [] as { id: string; issues: string[]; problems: PluginIssue[] }[] }
    const sys = mkOrigin('system:plugins', 'plugins:reload', 'internal')
    // 同 id 多个目录：version 最高者胜；版本相同取已装的（pin 与 pluginknown 一致）；再相同取路径靠前的。其余拒绝 DUPLICATE_ID。
    let unsure = false // 有目录认不出它是哪个插件（清单读不出 / id 不是字符串）：只认这一次 inspect 的读盘结果
    const scanned = this.candidates().map((dir, order) => { const probe = { idKnown: false }; const rec = this.inspect(dir, probe); if (!probe.idKnown) unsure = true; return { dir, order, rec } })
    type Scanned = (typeof scanned)[number]
    const rank = (v: string, w: string): number => (parseVersion(v) && parseVersion(w) ? compareVersions(v, w) : parseVersion(v) ? 1 : parseVersion(w) ? -1 : 0)
    const better = (a: Scanned, b: Scanned): { win: boolean; reason: string } => {
      if (a.rec.ok !== b.rec.ok) return { win: a.rec.ok, reason: 'passes validation' }
      const c = rank(a.rec.version, b.rec.version)
      if (c !== 0) return { win: c > 0, reason: 'higher version' }
      const known = this.o.docs.get<{ pin: string }>('pluginknown', a.rec.id)?.pin
      if (known && (a.rec.pin === known) !== (b.rec.pin === known)) return { win: a.rec.pin === known, reason: 'already installed' }
      return { win: a.order < b.order, reason: 'listed first' }
    }
    const best = new Map<string, Scanned>()
    for (const e of scanned) { const cur = best.get(e.rec.id); if (!cur || better(e, cur).win) best.set(e.rec.id, e) }
    for (const { dir, rec } of scanned) {
      const w = best.get(rec.id)!
      if (w.dir !== dir && !rec.ok) { res.rejected.push({ id: rec.id, issues: rec.issues, problems: rec.problems }); continue } // 败者自己也没过：报它自己的问题，别用 DUPLICATE_ID 盖掉
      if (w.dir !== dir) {
        const problem: PluginIssue = { code: 'DUPLICATE_ID', path: '/id', message: `duplicate id ${rec.id}: ${w.dir} wins (${better(w, { dir, order: 0, rec }).reason}); remove this directory` }
        res.rejected.push({ id: rec.id, issues: [`[${problem.code}] ${problem.message}`], problems: [problem] })
        continue
      }
      // 授权只留清单仍声明的权限（升级后不再声明的不保留）
      const declared = rec.manifest?.permissions
      const granted = this.grantsOf(rec.id).filter((p) => !declared || declared.includes(p))
      rec.granted = granted
      rec.pending = (rec.manifest?.permissions ?? []).filter((p) => !granted.includes(p))
      rec.enabled = this.enabled(rec.id)
      rec.lastVerifiedAt = this.o.clock.now()
      seen.add(rec.id)
      const prev = this.recs.get(rec.id)
      if (prev && prev.pin !== rec.pin && this.procs.has(rec.id)) await this.haltProc(rec.id)
      if (prev && this.procs.has(rec.id)) rec.state = prev.state
      this.recs.set(rec.id, rec)
      if (!rec.ok) { res.rejected.push({ id: rec.id, issues: rec.issues, problems: rec.problems }); continue }
      const known = this.o.docs.get<{ version: string; pin: string; manifestHash?: string }>('pluginknown', rec.id)
      const changed: string[] = []
      if (known && known.pin !== rec.pin) changed.push('pin')
      if (known && known.manifestHash !== undefined && known.manifestHash !== rec.manifestHash) changed.push('manifest') // 旧记录没有 manifestHash：只补记，不算变化
      if (!known || changed.length || known.manifestHash === undefined) this.o.docs.put('pluginknown', rec.id, { version: rec.version, pin: rec.pin, manifestHash: rec.manifestHash })
      if (!known || changed.length) {
        ;(known ? res.updated : res.added).push(rec.id)
        this.o.ledger.append({ type: known ? 'plugin.updated' : 'plugin.installed', origin: sys, subject: { pluginId: rec.id }, payload: { version: rec.version, contentHash: rec.pin, signed: rec.signed, trusted: rec.trusted, permissions: rec.manifest?.permissions ?? [], kind: rec.manifest?.kind, ...(known ? { changed } : {}) } })
      }
    }
    // 本进程见过的 + 已知集合里的（服务停着时被卸载的插件，本进程根本没见过它）：不在磁盘上的都按移除入账。
    // 本轮有任何一个目录认不出它是哪个插件（清单读不出 / id 不是字符串，只看开头 inspect 那一次读盘）= 状态不明，和 reconcileRemoved 同口径：
    // 只看本进程见过的，不并入已知集合；没见到的 id 照旧停进程、移出 recs，但不入账、不动已知集合（目录若真没了，下次状态清楚的 reload / reconcileRemoved 记一次）。
    for (const id of new Set([...this.recs.keys(), ...(unsure ? [] : (this.o.knownIds?.() ?? []))])) {
      if (seen.has(id)) continue
      await this.haltProc(id)
      this.stoppedByUser.delete(id)
      this.recs.delete(id)
      this.secretProblems.delete(id)
      if (!unsure && this.forgetKnown(id, sys)) res.removed.push(id)
    }
    this.o.events.publish('plugin.state', { reload: true, ...res })
    return res
  }

  /** 已知集合里有、就补记一条 plugin.removed（沿用已有账本类型）并移出已知集合，下次不再重复记。先入账再删：中途失败宁可下次重记也不丢。 */
  private forgetKnown(id: string, origin: ReturnType<typeof mkOrigin>): boolean {
    if (!this.o.docs.get('pluginknown', id)) return false
    this.o.ledger.append({ type: 'plugin.removed', origin, subject: { pluginId: id }, payload: {} })
    this.o.docs.delete('pluginknown', id)
    return true
  }

  /**
   * 内核每次打开时的轻量对账（不校验、不起进程）：已知集合里的插件，磁盘上已经没有目录了 -> 补记 plugin.removed。
   * 服务停着时被卸载的插件靠它入账；plugins reload / list 走 reload() 里同一套对比。
   * 插件目录本身读不到、或有一个插件的清单读不出（认不出它是哪个 id）时状态不明，什么都不记。
   */
  reconcileRemoved(): string[] {
    try {
      const known = this.o.knownIds?.() ?? []
      if (!known.length || !existsSync(this.o.pluginsDir)) return []
      const onDisk = new Set<string>()
      for (const dir of this.candidates()) {
        const id = manifestIdOf(dir)
        if (id === undefined) return [] // 认不出这个目录是哪个插件：可能就是某个已知插件，不下结论
        onDisk.add(id)
      }
      const sys = mkOrigin('system:plugins', 'plugins:startup', 'internal')
      return known.filter((id) => !onDisk.has(id) && this.forgetKnown(id, sys))
    } catch (e) {
      this.o.log?.(`plugin reconcile skipped: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  /** 授予权限（同时启用插件）：人面 + 会话 + 逐项确认。永不可授予的权限直接拒绝；permissions 为 [] = 只启用。 */
  grant(id: string, permissions: PluginPermission[], proof: HumanProof, origin = mkOrigin('user:usr_local', 'ui:plugin.grant', 'ui')): PluginRecord {
    assertProof(proof, 'session')
    const rec = this.recs.get(id)
    if (!rec) throw fail('INVALID_PARAMS', `no such plugin: ${id}`)
    if (!rec.ok || !rec.manifest) throw fail('INVALID_PARAMS', failedValidation(rec, ' and cannot be granted anything'))
    for (const p of permissions) {
      if ((NEVER_GRANTABLE_PERMISSIONS as readonly string[]).includes(p)) throw fail('MANDATE_LIMIT', `permission ${p} can never be granted`)
      if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(p) || !rec.manifest.permissions.includes(p)) throw fail('INVALID_PARAMS', `permission ${p} is not declared by the manifest`)
    }
    const granted = [...new Set([...rec.granted, ...permissions])]
    // permissions 可以是 []：只启用，不授予任何权限
    this.o.docs.put('plugingrant', id, { granted, enabledAt: this.grantDoc(id)?.enabledAt ?? this.o.clock.now() })
    rec.enabled = true
    rec.granted = granted
    rec.pending = rec.manifest.permissions.filter((p) => !granted.includes(p))
    this.o.ledger.append({ type: 'plugin.permission_granted', origin, subject: { pluginId: id }, payload: { granted: permissions } })
    return rec
  }

  /** 内核 API 层权限检查：默认拒绝。 */
  allowed(id: string, perm: PluginPermission): boolean { return this.recs.get(id)?.ok === true && this.recs.get(id)!.granted.includes(perm) }

  /** 块插件的文件读取（路径限制在插件目录内）。 */
  readFile(id: string, rel: string): Buffer {
    const rec = this.recs.get(id)
    if (!rec?.ok) throw fail('INVALID_PARAMS', `plugin ${id} is not available`)
    const p = resolve(rec.dir, rel)
    if (!p.startsWith(resolve(rec.dir) + sep)) throw fail('INVALID_PARAMS', 'path escapes the plugin directory')
    return readFileSync(p)
  }

  // ---- 生命周期（Node 插件）-----------------------------------------------------
  private setState(id: string, st: PluginState, detail?: string): void {
    const rec = this.recs.get(id)
    if (!rec) return
    rec.state = st
    this.o.events.publish('plugin.state', { id, state: st, detail })
  }

  async start(id: string): Promise<void> {
    const rec = this.recs.get(id)
    if (rec?.manifest?.entry?.transport === 'ws' || rec?.manifest?.entry?.transport === 'wss') {
      throw fail('CAPABILITY_UNSUPPORTED', 'remote plugins arrive with S3-C')
    }
    if (rec?.problem) throw new KernelError(rec.problem)
    if (!rec?.manifest || !rec.ok) throw fail('INVALID_PARAMS', `plugin ${id} is not valid`)
    pluginLaunch(rec.manifest)
    this.stoppedByUser.delete(id)
    const inflight = this.starting.get(id)
    if (inflight) return inflight
    if (this.procs.has(id)) return
    await this.spawnProc(id, true)
  }

  private spawnProc(id: string, wantRun: boolean): Promise<void> {
    const pr: Promise<void> = this.doSpawn(id, wantRun).finally(() => { if (this.starting.get(id) === pr) this.starting.delete(id) })
    this.starting.set(id, pr)
    return pr
  }

  private async doSpawn(id: string, wantRun: boolean): Promise<void> {
    const rec = this.recs.get(id)
    const previous = this.retries.get(id)
    clearTimeout(previous?.timer)
    this.retries.delete(id)
    const transport = rec?.manifest?.entry?.transport
    if (transport === 'ws' || transport === 'wss') {
      this.setState(id, 'failed', 'remote plugins arrive with S3-C')
      throw fail('CAPABILITY_UNSUPPORTED', 'remote plugins arrive with S3-C')
    }
    // 退避等待期间清单可能被改坏（cwd 越界、哈希 / 签名不符）：reload / inspect 只登记拒绝、不替换进程，
    // 所以拉起前必须按 id 复核最新记录，绝不按新清单在插件目录外拉起。detail 只带校验问题码，不带路径值。
    if (!rec || !rec.ok || !rec.manifest) {
      const codes = [...new Set((rec?.problems ?? []).map((p) => p.code))]
      const detail = `manifest failed validation on restart${codes.length ? ` [${codes.join('] [')}]` : ''}`
      this.setState(id, 'failed', detail)
      this.o.events.publish('plugin.state', { id, state: 'failed', detail, notifyUser: true })
      throw fail('INVALID_PARAMS', `plugin ${id} ${detail}`)
    }
    const m = rec.manifest
    const launch = pluginLaunch(m)
    this.setState(id, 'starting')
    const token = randomBytes(24).toString('base64url')
    if (launch && 'url' in launch) {
      const p: Proc = { buf: '', pending: new Map(), nextId: 1, token, failures: 0, crashes: previous?.crashes ?? [], restarts: previous?.restarts ?? 0, wantRun }
      this.procs.set(id, p)
      await new Promise<void>(finish => {
        p.remote = new RemotePluginTransport(id, launch, {
          clock: this.o.clock, ledger: this.o.ledger, resolveSecret: this.o.resolveSecret,
          backoffMinMs: this.o.backoffMinMs ?? PLUGIN_HEALTH.backoffMinMs,
          backoffMaxMs: this.o.backoffMaxMs ?? PLUGIN_HEALTH.backoffMaxMs,
          connected: (handle, channelToken) => {
            if (!p.wantRun || this.procs.get(id) !== p || handle.kind !== 'ws') return
            p.token = channelToken
            p.send = handle.send
            p.buf = ''
            p.failures = 0
            handle.onMessage(text => this.onData(p, text.endsWith('\n') ? text : `${text}\n`))
            void this.hello(id, p).finally(finish)
          },
          disconnected: () => {
            if (this.procs.get(id) !== p || !p.wantRun) { finish(); return }
            p.send = undefined
            this.onExit(id, p)
            void p.remote?.stop(id)
            finish()
          },
          state: (state, detail) => {
            if (this.procs.get(id) !== p || !p.wantRun) return
            if (state === 'starting' || state === 'degraded') this.setState(id, state, detail)
            if (state === 'failed') {
              this.setState(id, 'failed', detail)
              p.wantRun = false
              this.procs.delete(id)
              void p.remote?.stop(id)
              finish()
            }
          },
        })
        p.remote.start(id)
      })
      return
    }
    // 不继承宿主环境变量；工作目录 = 插件目录；Node 权限模型限制文件读写与子进程（尽力而为）。
    const systemEnv = minimalSystemEnv()
    const env: Record<string, string> = launch
      ? { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...systemEnv, ...launch.env, GITRADER_GSP_TOKEN: token }
      : { GITRADER_GSP_TOKEN: token, ...systemEnv }
    let injected: Record<string, string>
    this.secretProblems.delete(id)
    try {
      injected = pluginSecretEnv(m, this.o.secretHandles?.()[id], this.o.resolveSecret, message => {
        rec.warnings = [...new Set([...(rec.warnings ?? []), message])]
        this.o.log?.(`warning: ${message}`)
      })
    } catch (e) {
      if (e instanceof KernelError && /^missing secret handle: [A-Za-z_][A-Za-z0-9_]*$/.test(e.problem.message)) this.secretProblems.set(id, e)
      this.setState(id, 'failed', e instanceof KernelError ? e.problem.message : 'plugin secret resolution failed')
      throw e
    }
    Object.assign(env, injected)
    let child: ChildProcess
    try {
      child = spawn(launch?.command ?? process.execPath,
        launch ? launch.args ?? [] : ['--permission', `--allow-fs-read=${resolve(rec.dir)}`, resolve(rec.dir, m.entry!.module!)],
        { cwd: launch?.cwd ? resolve(rec.dir, launch.cwd) : rec.dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'
      const error = fail('INTERNAL', `plugin spawn failed (${code})`)
      this.setState(id, 'failed', error.problem.message)
      throw error
    }
    const p: Proc = {
      child, buf: '', pending: new Map(), nextId: 1, token, failures: 0,
      crashes: previous?.crashes ?? [], restarts: previous?.restarts ?? 0, wantRun,
      send: text => { if (!child.stdin!.writable) return false; child.stdin!.write(text + '\n'); return true },
    }
    this.procs.set(id, p)
    p.secretValues = Object.values(injected)
    child.stdout!.setEncoding('utf8').on('data', (c: string) => this.onData(p, c))
    child.stderr!.on('data', () => undefined)
    child.stdin!.on('error', () => undefined)
    child.once('exit', () => this.onExit(id, p))
    child.once('error', () => this.onExit(id, p))
    await this.hello(id, p)
  }

  private async hello(id: string, p: Proc): Promise<void> {
    const rec = this.recs.get(id)!
    const send = p.send
    try {
      await this.rpc(id, 'plugin.hello', { gsp: GSP_VERSION, token: p.token, plugin: { id, version: rec.version }, permissions: rec.granted, config: {} }, 5000)
      if (!p.wantRun || this.procs.get(id) !== p || !send || p.send !== send) return
      this.setState(id, 'ready')
      clearInterval(p.health)
      p.health = setInterval(() => { void this.healthCheck(id) }, this.o.healthIntervalMs ?? PLUGIN_HEALTH.intervalMs)
      p.health.unref?.()
    } catch (e) {
      if (p.wantRun && this.procs.get(id) === p && send && p.send === send) {
        this.setState(id, 'degraded', e instanceof Error ? e.message : String(e))
        this.killProc(id, p)
      }
    }
  }

  private onData(p: Proc, chunk: string): void {
    p.buf += chunk
    let i: number
    while ((i = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, i).trim()
      p.buf = p.buf.slice(i + 1)
      if (!line) continue
      let frame: unknown
      try { frame = JSON.parse(line) } catch { continue }
      for (const item of Array.isArray(frame) ? frame : [frame]) {
        if (!item || typeof item !== 'object') continue
        const msg = item as { id?: number; result?: unknown; error?: unknown }
        // S1：插件返回任何名为 privateKey / secret / mnemonic … 的字段一律拒收（5006），不回显
        if (findSecretKeys(msg).length || containsPluginSecret(msg, p.secretValues)) {
          const w = msg.id !== undefined ? p.pending.get(msg.id) : undefined
          if (w && msg.id !== undefined) { clearTimeout(w.timer); p.pending.delete(msg.id); w.reject(new KernelError(makeProblem('SECRET_FIELD_REJECTED', 'plugin message contained a secret-like field and was dropped'))) }
          continue
        }
        const w = msg.id !== undefined ? p.pending.get(msg.id) : undefined
        if (!w || msg.id === undefined) continue
        clearTimeout(w.timer)
        p.pending.delete(msg.id)
        if (msg.error) {
          // 插件自己报的 JSON-RPC 错误：-32602 / -32601 对应内核同名问题，其余按内部错误；消息原样透传
          const e = msg.error as { code?: unknown; message?: unknown }
          w.reject(new KernelError(makeProblem(e.code === -32602 ? 'INVALID_PARAMS' : e.code === -32601 ? 'CAPABILITY_UNSUPPORTED' : 'INTERNAL', typeof e.message === 'string' ? e.message : 'plugin error')))
        }
        else w.resolve(msg.result)
      }
    }
    // 一行超过上限还没换行：丢缓冲、拒掉所有等待中的调用（5007），杀掉插件（退避重启照旧）
    if (p.buf.length > GEP_LIMITS.maxStdioLineBytes) {
      p.buf = ''
      for (const w of p.pending.values()) { clearTimeout(w.timer); w.reject(fail('PAYLOAD_TOO_LARGE', `plugin output line exceeds ${GEP_LIMITS.maxStdioLineBytes} bytes`)) }
      p.pending.clear()
      const id = [...this.procs].find(([, proc]) => proc === p)?.[0]
      if (id) this.killProc(id, p)
    }
  }

  /** JSON-RPC 2.0 over stdio NDJSON。 */
  rpc(id: string, method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const p = this.procs.get(id)
    if (!p?.send) return Promise.reject(fail('VENUE_UNAVAILABLE', `plugin ${id} is not running`))
    const n = p.nextId++
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => { p.pending.delete(n); reject(new KernelError(makeProblem('BUSY', `plugin ${id}: ${method} timed out after ${timeoutMs} ms`))) }, timeoutMs)
      timer.unref?.()
      p.pending.set(n, { resolve: resolve_, reject, timer })
      try {
        if (!p.send!(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))) throw fail('VENUE_UNAVAILABLE', `plugin ${id} is not running`)
      } catch (e) { clearTimeout(timer); p.pending.delete(n); reject(e) }
    })
  }

  /** 编译并缓存 schema 校验函数（key 含 id+tool，reload 清空）。 */
  private validator(key: string, schema: Record<string, unknown>): (data: unknown) => ValidationResult<unknown> {
    let fn = this.validators.get(key)
    if (!fn) { fn = compileSchema(schema); this.validators.set(key, fn) }
    return fn
  }

  /**
   * 插件命名空间工具调用（MCP `plugins.call` 转发）。四道检查依次：启用 → 工具已声明 → 入参合 input → 工具权限已授予；
   * 调用后若声明了 output，结果不合则 5009 且不返回结果。
   */
  async callTool(id: string, tool: string, args: unknown, caller?: symbol): Promise<unknown> {
    if (tool === 'notify_send' && caller !== NOTIFICATION_CALL) throw fail('MANDATE_LIMIT', 'notify_send is restricted to the notification outlet')
    const rec = this.recs.get(id)
    if (!rec) throw fail('INVALID_PARAMS', `no such plugin: ${id}`)
    if (!rec.ok) throw fail('INVALID_PARAMS', failedValidation(rec))
    if (!rec.enabled) throw fail('MANDATE_LIMIT', `plugin ${id} is not enabled: grant it at least once`)
    const t = rec.tools.find((x) => x.name === tool)
    if (!t) throw fail('PLUGIN_TOOL_UNKNOWN', `plugin ${id} does not declare tool ${tool}`)
    const checked = this.validator(`${id}\n${tool}`, t.input)(args ?? {})
    if (!checked.ok) throw fail('INVALID_PARAMS', `tool ${tool}: ${formatIssues(checked.issues)}`)
    for (const p of t.permissions ?? []) if (!rec.granted.includes(p)) throw fail('MANDATE_LIMIT', `tool ${tool} needs permission ${p} (not granted)`)
    // 启用后第一次调用自动拉起；不支持的运行时由 start 抛 5002；failed 不自动复活。
    if (this.stoppedByUser.has(id)) throw fail('VENUE_UNAVAILABLE', `plugin ${id} was stopped; start it again`)
    if (rec.state === 'failed' && this.secretProblems.has(id)) throw this.secretProblems.get(id)!
    if (this.starting.has(id) || (!this.procs.has(id) && rec.state !== 'failed')) await this.start(id)
    const result = await this.rpc(id, 'tool.call', { tool, args: args ?? {} })
    if (Buffer.byteLength(JSON.stringify(result ?? null), 'utf8') > TOOL_RESULT_MAX_BYTES) throw fail('PAYLOAD_TOO_LARGE', `plugin ${id} tool ${tool} returned more than ${TOOL_RESULT_MAX_BYTES} bytes`)
    if (t.output) {
      const out = this.validator(`${id}\n${tool}\nout`, t.output)(result)
      if (!out.ok) throw fail('PLUGIN_RESULT_INVALID', `plugin ${id} tool ${tool} returned a result that does not match its output schema: ${formatIssues(out.issues)}`)
    }
    return result
  }

  private async healthCheck(id: string): Promise<void> {
    const p = this.procs.get(id)
    if (!p) return
    const send = p.send
    try {
      await this.rpc(id, 'plugin.health', {}, this.o.healthTimeoutMs ?? PLUGIN_HEALTH.timeoutMs)
      if (!p.wantRun || this.procs.get(id) !== p || p.send !== send) return
      p.failures = 0
      if (this.recs.get(id)?.state === 'degraded') this.setState(id, 'ready')
    } catch {
      if (!p.wantRun || this.procs.get(id) !== p || p.send !== send) return
      p.failures++
      this.setState(id, 'degraded', `health check failed (${p.failures})`)
      if (p.failures >= PLUGIN_HEALTH.failuresBeforeRestart) this.killProc(id, p)
    }
  }

  private rejectPending(id: string, p: Proc): void {
    for (const w of p.pending.values()) { clearTimeout(w.timer); w.reject(fail('VENUE_UNAVAILABLE', `plugin ${id} exited`)) }
    p.pending.clear()
  }

  private killProc(id: string, p: Proc): void {
    if (p.remote) {
      p.send = undefined
      void p.remote.stop(id).then(() => this.onExit(id, p))
    } else if (p.child) this.killTree(p.child)
  }

  private onExit(id: string, p: Proc): void {
    if (this.procs.get(id) !== p) return
    clearInterval(p.health)
    this.rejectPending(id, p)
    this.procs.delete(id)
    if (!p.wantRun) { this.setState(id, 'stopped'); return }
    const now = this.o.clock.now()
    const crashes = [...p.crashes.filter((t) => now - t < PLUGIN_HEALTH.crashWindowMs), now]
    if (crashes.length >= PLUGIN_HEALTH.crashLimit) { this.setState(id, 'failed', `${crashes.length} crashes within 10 minutes`); this.o.events.publish('plugin.state', { id, state: 'failed', notifyUser: true }); return }
    this.setState(id, 'degraded', 'process exited; restarting')
    const delay = Math.min((this.o.backoffMinMs ?? PLUGIN_HEALTH.backoffMinMs) * 2 ** (crashes.length - 1), this.o.backoffMaxMs ?? PLUGIN_HEALTH.backoffMaxMs)
    const keep = { crashes, restarts: p.restarts + 1 }
    const t = setTimeout(() => {
      // doSpawn 进入时复核记录校验结果：退避期间清单被改坏就不再拉起，直接 failed。
      if (this.recs.has(id) && !this.procs.has(id) && !this.stoppedByUser.has(id)) void this.spawnProc(id, true).catch(() => { /* doSpawn recorded the launch failure */ })
    }, delay)
    this.retries.set(id, { ...keep, timer: t })
    t.unref?.()
  }

  /** 用户显式停止：之后 callTool 不再自动拉起，直到再次 start。 */
  async stop(id: string): Promise<void> {
    this.stoppedByUser.add(id)
    await this.haltProc(id)
  }

  /** 内部停进程（reload / 卸载 / 关机用），不记"用户停过"。 */
  private async haltProc(id: string): Promise<void> {
    const retry = this.retries.get(id)
    clearTimeout(retry?.timer)
    this.retries.delete(id)
    const p = this.procs.get(id)
    if (!p) { if (retry) this.setState(id, 'stopped'); return }
    p.wantRun = false
    clearInterval(p.health)
    this.setState(id, 'stopping')
    if (p.remote) {
      try { if (p.send) await this.rpc(id, 'plugin.shutdown', {}, 1000) } catch { /* close after grace */ }
      await p.remote.stop(id)
      this.onExit(id, p)
      return
    }
    const child = p.child!
    const exited = new Promise<void>((res) => { if (child.exitCode !== null || child.signalCode !== null) res(); else child.once('exit', () => res()) })
    let closed = false
    let onClose: () => void
    const drained = new Promise<void>((res) => {
      onClose = () => { closed = true; res() }
      child.once('close', onClose)
    })
    try { await this.rpc(id, 'plugin.shutdown', {}, 1000) } catch { /* 宽限期内没回应也继续 */ }
    try { child.stdin!.end() } catch { /* 已关 */ }
    const t = setTimeout(() => this.killTree(child), this.o.shutdownGraceMs ?? PLUGIN_HEALTH.shutdownGraceMs)
    await exited
    clearTimeout(t)
    if (!closed) {
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([drained, new Promise<void>((res) => {
          drainTimer = setTimeout(res, this.o.stdioCloseGraceMs ?? 2000)
        })])
        if (!closed) for (const stream of child.stdio) stream?.destroy()
      } finally {
        clearTimeout(drainTimer)
        child.removeListener('close', onClose!)
      }
    }
    this.setState(id, 'stopped')
  }

  async stopAll(): Promise<void> { await Promise.all([...new Set([...this.procs.keys(), ...this.retries.keys()])].map((id) => this.haltProc(id))) }

  /** 卸载：stop → 删除插件目录 → 账本记录永不删除。 */
  async uninstall(id: string, proof: HumanProof): Promise<void> {
    assertProof(proof, 'session')
    const rec = this.recs.get(id)
    if (!rec) throw fail('INVALID_PARAMS', `no such plugin: ${id}`)
    await this.haltProc(id)
    this.stoppedByUser.delete(id)
    const root = resolve(this.o.pluginsDir)
    if (!resolve(rec.dir).startsWith(root + sep)) throw fail('INVALID_PARAMS', 'refusing to delete outside the plugins directory')
    rmSync(rec.dir, { recursive: true, force: true })
    this.o.docs.delete('plugingrant', id)
    await this.reload()
  }

  /** 只对自己持有的、还没退出的子进程句柄动手（PID 复用教训）。 */
  private killTree(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    else child.kill('SIGKILL')
  }
}

export type { Problem }
