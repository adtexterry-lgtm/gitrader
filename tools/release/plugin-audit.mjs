// SPDX-License-Identifier: CPAL-1.0
// 插件完备性体检（CI 与首发前都跑，只用 Node 标准库，不联网、不写仓库）：
//   node tools/release/plugin-audit.mjs [--root DIR] [--json] [--strict]
// 规则（逐包判定，只查插件候选包）：
//   0. 判定口径：工具名正则 / 永不可授予权限 / schema 的权限枚举、id・version pattern、required 全部从
//      packages/protocol 读；任何一项取不到都记仓库级 protocol-source 失败，退出码 1（不回退内置常量）。
//   1. 清单完整：name / version / type / 入口（main，缺省时接受 exports）；带 gitrader-plugin.json 的还要
//      schema、id、version、license、entry.module（文件必须真实存在）、runtime。
//   2. 权限最小化：清单 permissions 必须是非空数组、每个值都在协议枚举里、不碰 NEVER_GRANTABLE_PERMISSIONS；
//      声明 net.fetch 就必须写 net.hosts。没有清单或没有 permissions 字段的记「未声明权限」警告。
//   3. secrets 一致：清单 secrets[] 声明 vs 包内源码真实读取的 process.env.X（含 process.env['X']、
//      `const { X } = process.env`、以及 `const TOKEN_ENV = 'X'` 这种间接引用）；
//      读了敏感形状的变量却未声明 → 失败；声明了却在源码里找不到引用 → 警告（可能由内核注入 params）。
//   4. 工具名：tools[].name 必须匹配 packages/protocol 里的 PLUGIN_TOOL_NAME_RE，且不允许重名。
//   5. SPDX：package.json license 必须是 SPDX 标识，LICENSE 文件必须在且像全文，清单 license.spdx 必须一致。
//   6. README 首行存在且非空。
//   7. 测试存在：test/ 下有文件，或 package.json 有 scripts.test。
//   8. 通知契约单一事实源：docs/notifications.md 的「工具契约」JSON 是 notify_send 的唯一真源；
//      声明了 notify_send 的清单逐项比对（required / notice.required / notice 允许字段 / level 枚举 /
//      additionalProperties / output 必含 ok）。文档读不到或解析不了记仓库级 notify-contract-source 失败。
// 退出码：0 = 全过（可以有警告）；1 = 有失败项；2 = 运行错误（参数错、仓库结构不对）。
// --strict：把警告也当失败（首发前用）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadJson, loadWorkspaces, parseArgs, readText, toPosix } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const PROTOCOL_MANIFEST_TS = 'packages/protocol/src/plugin/manifest.ts'
const PROTOCOL_SCHEMA_JSON = 'packages/protocol/schemas/plugin.json'
const MANIFEST_SCHEMA = 'gitrader-plugin/1'

const SOURCE_EXT = /\.(mjs|cjs|js|mts|cts|ts|tsx|jsx)$/
/** 源码扫描跳过的目录：依赖、构建产物、测试夹具、测试代码（测试里的 env 是夹具，不算插件读取面）。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.cache', '.gitrader', 'test', 'tests', '__tests__', 'fixtures'])
/** 内核注入的运行期变量：不是插件自己的 secret，不要求在 secrets[] 里声明。 */
const RESERVED_ENV = new Set([
  'NODE_ENV', 'GITRADER_GSP_TOKEN', 'GITRADER_PLUGIN_FAKE_FETCH', 'GITRADER_OFFLINE', 'GITRADER_HOST',
  'GITRADER_HOME', 'GITRADER_LOG_FORMAT', 'GITRADER_DEBUG', 'GITRADER_ALLOW_INSECURE_HOSTS',
])
/** 名字像密钥的环境变量：读了却没在 secrets[] 声明就是失败（其余形状只记警告）。 */
const SECRET_SHAPED = /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|MNEMONIC|PASSPHRASE|SEED|PRIVATE|CREDENTIAL|WEBHOOK|_URL|DSN|COOKIE|_PASS\b|_KEY\b)/i
const KNOWN_SPDX = new Set([
  'CPAL-1.0', 'Apache-2.0', 'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', 'AGPL-3.0-only',
  'AGPL-3.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'Unlicense', 'CC0-1.0',
])

const USAGE = `插件完备性体检（只看插件候选包）

  node tools/release/plugin-audit.mjs [--root DIR] [--json] [--strict]

  --root DIR   仓库根（缺省：本脚本上两级）
  --json       只输出机器可读 JSON（人类可读报告走 stderr 的进度行都不打印）
  --strict     警告也算失败（首发前用；CI 默认不严）
  --help       打这份说明

退出码：0 全过（可有警告）；1 有失败项；2 运行错误。`

/** 插件候选包：名字含 plugin-/notify-，或带 gitrader-plugin.json，或 package.json 有 gitrader 插件字段。 */
const PLUGIN_NAME_RE = /(^|[/@])plugin-|(^|[/@])notify-/

// ---------------------------------------------------------------------------------------------
// 协议契约：工具名正则、清单必填枚举都从 packages/protocol 里读，不在这里抄一份
// ---------------------------------------------------------------------------------------------

/** 工具名正则的内置参考值：只写进「真源取不到」的错误消息，不参与任何判定。 */
const TOOL_NAME_RE_REFERENCE = '/^[A-Za-z0-9_-]{1,64}$/'

/** 从协议源码/JSON schema 里取判定口径；任何一项取不到都记进 problems，由调用方记仓库级失败。 */
export function loadProtocol(root) {
  const problems = []
  const ts = readText(join(root, PROTOCOL_MANIFEST_TS))
  const schema = loadJson(join(root, PROTOCOL_SCHEMA_JSON))
  const props = schema?.properties ?? {}

  let toolNameRe = null
  let neverGrantable = []
  if (ts === null) {
    problems.push(`${PROTOCOL_MANIFEST_TS}: 读不到这个文件，工具名正则与永不可授予权限表都没有判定口径（工具名正则的参考值 ${TOOL_NAME_RE_REFERENCE}，仅供参考，不参与判定）`)
  } else {
    const m = ts.match(/export const PLUGIN_TOOL_NAME_RE\s*=\s*\/(.+)\/([gimsuy]*)/)
    if (!m) problems.push(`${PROTOCOL_MANIFEST_TS}: 没找到 export const PLUGIN_TOOL_NAME_RE = /…/ 这种写法，工具名正则取不到（参考值 ${TOOL_NAME_RE_REFERENCE}，仅供参考）`)
    else {
      try { toolNameRe = new RegExp(m[1], m[2]) }
      catch { problems.push(`${PROTOCOL_MANIFEST_TS}: PLUGIN_TOOL_NAME_RE 的源码 /${m[1]}/${m[2]} 解析不成正则，工具名正则取不到`) }
    }
    const block = ts.match(/export const NEVER_GRANTABLE_PERMISSIONS\s*=\s*\[([\s\S]*?)\]\s*as const(?:\s+satisfies\s+[^\n]*)?/)
    if (!block) problems.push(`${PROTOCOL_MANIFEST_TS}: 没找到 export const NEVER_GRANTABLE_PERMISSIONS = [...] as const 这种写法，永不可授予权限表取不到`)
    else {
      for (const q of block[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
        const name = q[1] ?? q[2]
        if (name) neverGrantable.push(name)
      }
      if (neverGrantable.length === 0) problems.push(`${PROTOCOL_MANIFEST_TS}: NEVER_GRANTABLE_PERMISSIONS 里解析不出任何权限名，永不可授予权限检查没有判定口径`)
    }
  }

  const permissions = props.permissions?.items?.enum ?? []
  const idPattern = props.id?.pattern ?? null
  const versionPattern = props.version?.pattern ?? null
  if (permissions.length === 0) problems.push(`${PROTOCOL_SCHEMA_JSON}: 取不到 properties.permissions.items.enum（权限枚举），权限值校验没有判定口径`)
  if (!idPattern) problems.push(`${PROTOCOL_SCHEMA_JSON}: 取不到 properties.id.pattern，清单 id 校验没有判定口径`)
  if (!versionPattern) problems.push(`${PROTOCOL_SCHEMA_JSON}: 取不到 properties.version.pattern，清单 version 校验没有判定口径`)
  if (!Array.isArray(schema?.required) || schema.required.length === 0) problems.push(`${PROTOCOL_SCHEMA_JSON}: 取不到 required（协议必填字段表），必填字段校验没有判定口径`)

  let idRe = null
  if (idPattern) {
    try { idRe = new RegExp(idPattern) }
    catch { problems.push(`${PROTOCOL_SCHEMA_JSON}: id.pattern ${JSON.stringify(idPattern)} 解析不成正则，清单 id 校验没有判定口径`) }
  }
  let versionRe = null
  if (versionPattern) {
    try { versionRe = new RegExp(versionPattern) }
    catch { problems.push(`${PROTOCOL_SCHEMA_JSON}: version.pattern ${JSON.stringify(versionPattern)} 解析不成正则，清单 version 校验没有判定口径`) }
  }

  return {
    toolNameRe,
    toolNamePattern: toolNameRe ? toolNameRe.source : null,
    permissions: new Set(permissions),
    permissionList: permissions,
    neverGrantable: new Set(neverGrantable),
    idRe,
    versionRe,
    manifestSchema: props.schema?.const ?? MANIFEST_SCHEMA,
    requiredFields: Array.isArray(schema?.required) ? schema.required : [],
    kinds: props.kind?.enum ?? [],
    runtimeTypes: props.runtime?.properties?.type?.enum ?? [],
    problems,
    source: { manifest: PROTOCOL_MANIFEST_TS, schema: PROTOCOL_SCHEMA_JSON },
  }
}

// ---------------------------------------------------------------------------------------------
// 通知契约单一事实源（批 11 主题二 ⑤）
// ---------------------------------------------------------------------------------------------

const NOTIFY_DOC = 'docs/notifications.md'

/**
 * 从 docs/notifications.md 的「工具契约」一节读 `notify_send` 的 input / output schema。
 * 文档是唯一真源：读不到、解析不了，都记仓库级失败（不回退内置常量，否则文档与清单谁也没约束谁）。
 */
export function loadNotifyContract(root) {
  const problems = []
  const text = readText(join(root, NOTIFY_DOC))
  if (text === null) {
    return { contract: null, problems: [`${NOTIFY_DOC}: 读不到通知契约文档（通知工具契约的唯一真源）`] }
  }
  const section = /##[^\n]*工具契约[\s\S]*?```json\r?\n([\s\S]*?)```/.exec(text)
  if (!section) return { contract: null, problems: [`${NOTIFY_DOC}: 没找到「工具契约」小节里的 json 契约块（契约真源取不到）`] }
  let contract
  try { contract = JSON.parse(section[1]) } catch (e) {
    return { contract: null, problems: [`${NOTIFY_DOC}: 工具契约 JSON 解析失败（${e.message}），契约真源取不到`] }
  }
  const input = contract?.input
  const notice = input?.properties?.notice
  const ok = Array.isArray(input?.required) && input.required.includes('notice') && input.required.includes('params')
    && input?.properties?.params?.type === 'object'
    && Array.isArray(notice?.required) && notice.required.length > 0
    && notice?.properties && typeof notice.properties === 'object'
    && Array.isArray(notice?.properties?.level?.enum) && notice.properties.level.enum.length > 0
    && Array.isArray(contract?.output?.required) && contract.output.required.includes('ok')
  if (!ok) {
    problems.push(`${NOTIFY_DOC}: 工具契约 JSON 缺要素（input.required 需含 notice/params、params 需 type object、notice.required 非空、notice.level.enum 非空、output.required 需含 ok）`)
    return { contract: null, problems }
  }
  return { contract, problems }
}

/** 清单里的 notify_send 与本契约逐项比对；对不上就记失败（细节写清「文档要什么 / 清单是什么」）。 */
function auditNotifyContract(tool, contract, label, rec) {
  const cInput = contract.input
  const cNotice = cInput.properties.notice
  const input = tool?.input ?? {}
  const notice = input?.properties?.notice ?? {}
  const diffs = []
  const same = (a, b) => [...a].sort().join('\u0000') === [...b].sort().join('\u0000')

  const wantTop = cInput.required
  const gotTop = Array.isArray(input.required) ? input.required : []
  if (!same(wantTop, gotTop)) diffs.push(`input.required 文档 ${JSON.stringify(wantTop)} / 清单 ${JSON.stringify(gotTop)}`)

  const wantNotice = cNotice.required
  const gotNotice = Array.isArray(notice.required) ? notice.required : []
  if (!same(wantNotice, gotNotice)) diffs.push(`notice.required 文档 ${JSON.stringify(wantNotice)} / 清单 ${JSON.stringify(gotNotice)}`)

  const wantProps = Object.keys(cNotice.properties)
  const gotProps = Object.keys(notice.properties ?? {})
  if (!same(wantProps, gotProps)) diffs.push(`notice 允许字段 文档 ${JSON.stringify(wantProps)} / 清单 ${JSON.stringify(gotProps)}`)

  const wantLevels = cNotice.properties.level.enum
  const gotLevels = notice?.properties?.level?.enum ?? []
  if (!same(wantLevels, gotLevels)) diffs.push(`level 枚举 文档 ${JSON.stringify(wantLevels)} / 清单 ${JSON.stringify(gotLevels)}`)

  if (input?.properties?.params === undefined) diffs.push('input.properties 缺 params')

  if (cInput.additionalProperties === false && input.additionalProperties !== false) {
    diffs.push('input.additionalProperties 必须是 false（文档契约）')
  }
  if (cNotice.additionalProperties === false && notice.additionalProperties !== false) {
    diffs.push('notice.additionalProperties 必须是 false（文档契约：notice 只允许契约里的字段）')
  }

  const outRequired = Array.isArray(tool?.output?.required) ? tool.output.required : []
  if (!outRequired.includes('ok')) diffs.push(`output.required 必须含 ok（清单 ${JSON.stringify(outRequired)}）`)

  if (diffs.length === 0) rec.ok('notify-contract', `${label}: notify_send 与 ${NOTIFY_DOC} 一致`)
  else rec.fail('notify-contract', `${label}: notify_send 与 ${NOTIFY_DOC} 不一致 —— ${diffs.join('；')}`)
}

// ---------------------------------------------------------------------------------------------
// 包内源码扫描
// ---------------------------------------------------------------------------------------------

/** 列一个包的生产源码（跳过 test/fixtures/dist/node_modules），返回 [{rel, text}]。 */
function listSource(absPkg) {
  const out = []
  const walk = (dir) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(abs); continue }
      if (!SOURCE_EXT.test(name)) continue
      const text = readText(abs)
      if (text === null) continue
      out.push({ rel: toPosix(abs.slice(absPkg.length + 1)), text })
    }
  }
  walk(absPkg)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** 包内源码真实读了哪些环境变量（含字符串下标、解构、常量间接引用）。 */
export function collectEnvReads(sources) {
  const dotted = new Set()
  const consts = new Map() // 常量名 -> 环境变量名，解决 `process.env[TOKEN_ENV]` 这种写法
  for (const { text } of sources) {
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*'([A-Z][A-Z0-9_]*)'/g)) consts.set(m[1], m[2])
  }
  for (const { text } of sources) {
    for (const m of text.matchAll(/process\.env\.([A-Za-z_$][\w$]*)/g)) dotted.add(m[1])
    for (const m of text.matchAll(/process\.env\[\s*'([A-Za-z_$][\w$]*)'\s*\]/g)) dotted.add(m[1])
    for (const m of text.matchAll(/process\.env\[\s*"([A-Za-z_$][\w$]*)"\s*\]/g)) dotted.add(m[1])
    for (const m of text.matchAll(/process\.env\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
      const resolved = consts.get(m[1])
      if (resolved) dotted.add(resolved)
    }
    for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split('=')[0].split(':').pop().trim().replace(/^\.\.\./, '')
        if (name) dotted.add(name)
      }
    }
  }
  return dotted
}

// ---------------------------------------------------------------------------------------------
// 单包判定
// ---------------------------------------------------------------------------------------------

function recorder() {
  const checks = []
  return {
    checks,
    /** 通过项。 */
    ok: (id, detail) => checks.push({ id, ok: true, severity: 'fail', detail }),
    /** 失败项（退出码 1）。 */
    fail: (id, detail) => checks.push({ id, ok: false, severity: 'fail', detail }),
    /** 警告项（--strict 下算失败）。 */
    warn: (id, detail) => checks.push({ id, ok: false, severity: 'warn', detail }),
    /** 信息项：永远通过，只是把「没查的东西」说清楚。 */
    info: (id, detail) => checks.push({ id, ok: true, severity: 'warn', detail, info: true }),
  }
}

/** package.json 里内联的插件清单：只认 `gitrader.plugin` 对象或 `gitrader.schema === 'gitrader-plugin/1'`；
 *  `gitrader.build`（构建提示）之类的字段不算插件声明。 */
function inlinePluginField(pkg) {
  const g = pkg?.gitrader
  if (!g || typeof g !== 'object') return null
  if (g.plugin && typeof g.plugin === 'object') return g.plugin
  if (g.schema === MANIFEST_SCHEMA) return g
  return null
}

/** 找包里的清单：根目录优先；找不到就往下两层的子目录里找（模板包把示例插件放在 example/<name>/）。 */
function findManifests(absPkg, pkg) {
  const found = []
  const rootManifest = join(absPkg, 'gitrader-plugin.json')
  if (existsSync(rootManifest)) return [{ where: 'gitrader-plugin.json', file: rootManifest, dir: absPkg }]
  const walk = (dir, depth, prefix) => {
    let names = []
    try { names = readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (!st.isDirectory()) continue
      const rel = prefix ? `${prefix}/${name}` : name
      const cand = join(abs, 'gitrader-plugin.json')
      if (existsSync(cand)) { found.push({ where: `${rel}/gitrader-plugin.json`, file: cand, dir: abs }); continue }
      if (depth > 1) walk(abs, depth - 1, rel)
    }
  }
  walk(absPkg, 2, '')
  const inline = inlinePluginField(pkg)
  if (found.length === 0 && inline) found.push({ where: 'package.json#gitrader.plugin', file: null, dir: absPkg, inline })
  return found
}

export function auditPackage({ root, ws, protocol, notify }) {
  const abs = ws.abs
  const pkg = ws.pkg
  const dir = toPosix(ws.dir)
  const rec = recorder()
  const sources = listSource(abs)
  const envReads = collectEnvReads(sources)
  const manifests = findManifests(abs, pkg)
  const nameIsPlugin = PLUGIN_NAME_RE.test(pkg.name ?? '')

  // ---- 1. 包清单字段 ----
  if (!pkg.name) rec.fail('pkg-name', 'package.json 缺 name')
  else rec.ok('pkg-name', pkg.name)
  if (!pkg.version) rec.fail('pkg-version', 'package.json 缺 version')
  else rec.ok('pkg-version', pkg.version)
  if (pkg.type !== 'module') rec.fail('pkg-type', `package.json type 必须是 "module"（现在 ${JSON.stringify(pkg.type ?? null)}）`)
  else rec.ok('pkg-type', 'type: module')
  const hasMain = typeof pkg.main === 'string' && pkg.main.length > 0
  const hasExports = pkg.exports !== undefined && pkg.exports !== null
  if (hasMain) rec.ok('pkg-entry', `main: ${pkg.main}`)
  else if (hasExports) rec.warn('pkg-entry', 'package.json 没有 main，入口由 exports 提供（仓库约定；若要发独立插件包请补 main 或确认工具链只认 exports）')
  else rec.fail('pkg-entry', 'package.json 既没有 main 也没有 exports')

  // ---- 2. SPDX / LICENSE ----
  const spdx = typeof pkg.license === 'string' ? pkg.license : ''
  if (!spdx) rec.fail('spdx-field', 'package.json 缺 license 字段')
  else if (!KNOWN_SPDX.has(spdx)) rec.warn('spdx-field', `license ${spdx} 不在已知 SPDX 标识短名单里`)
  else rec.ok('spdx-field', `license: ${spdx}`)
  const licenseFile = join(abs, 'LICENSE')
  const licenseText = readText(licenseFile)
  if (licenseText === null) rec.fail('license-file', '缺 LICENSE 文件（包的许可证原文）')
  else if (licenseText.length < 500) rec.fail('license-file', `LICENSE 只有 ${licenseText.length} 字节，不像许可证全文`)
  else rec.ok('license-file', `LICENSE ${licenseText.length} 字节`)

  // ---- 3. README 首行 ----
  const readme = readText(join(abs, 'README.md'))
  if (readme === null) rec.fail('readme-first-line', '缺 README.md')
  else {
    const first = (readme.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim()
    if (first.length < 4) rec.fail('readme-first-line', 'README.md 首行（首个非空行）为空或太短')
    else rec.ok('readme-first-line', first.slice(0, 120))
  }

  // ---- 4. 测试存在 ----
  const testDirs = ['test', 'tests', '__tests__'].filter((d) => {
    const p = join(abs, d)
    if (!existsSync(p)) return false
    try { return readdirSync(p).length > 0 } catch { return false }
  })
  const testScript = pkg.scripts?.test
  if (testDirs.length > 0) rec.ok('tests-present', `${testDirs.join('/')} 下有用例${testScript ? `，scripts.test: ${testScript}` : '（无 scripts.test）'}`)
  else if (typeof testScript === 'string' && testScript.trim().length > 0) rec.ok('tests-present', `scripts.test: ${testScript}`)
  else rec.fail('tests-present', '既没有 test/ 目录也没有 package.json 的 scripts.test')

  // ---- 5. secrets 声明 vs 实际读取 ----
  const declared = new Set()
  for (const man of manifests) {
    const json = man.inline ?? loadJson(man.file)
    if (!json) continue
    if (Array.isArray(json.secrets)) for (const s of json.secrets) if (typeof s === 'string') declared.add(s)
  }
  const nonReserved = [...envReads].filter((v) => !RESERVED_ENV.has(v)).sort()
  if (manifests.length === 0) {
    if (nonReserved.length === 0) rec.info('secrets-declared', '无清单、源码不读 process.env，记「未声明权限/未声明 secrets」')
    else rec.warn('secrets-declared', `无清单却读 process.env：${nonReserved.join(', ')}——记「未声明 secrets」`)
  } else if (declared.size === 0) rec.warn('secrets-declared', '清单没有 secrets[] 声明（若插件不碰密钥可以忽略；否则补上）')
  else rec.ok('secrets-declared', `secrets: ${[...declared].sort().join(', ')}`)

  const undeclaredSensitive = nonReserved.filter((v) => !declared.has(v) && SECRET_SHAPED.test(v))
  const undeclaredPlain = nonReserved.filter((v) => !declared.has(v) && !SECRET_SHAPED.test(v))
  if (undeclaredSensitive.length > 0) {
    rec.fail('secrets-env-match', `源码读了敏感环境变量但清单 secrets 未声明：${undeclaredSensitive.join(', ')}`)
  } else if (undeclaredPlain.length > 0) {
    rec.warn('secrets-env-match', `源码读了未声明的普通环境变量（非密钥形状，只提醒）：${undeclaredPlain.join(', ')}`)
  }
  const allText = sources.map((s) => s.text).join('\n')
  const unusedSecrets = [...declared].filter((s) => !envReads.has(s) && !new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(allText))
  if (manifestosHaveSecrets(manifests) && unusedSecrets.length > 0) {
    rec.warn('secrets-unused', `清单声明了但源码里找不到引用：${unusedSecrets.join(', ')}（可能由内核按声明注入 params；确认一下）`)
  } else if (declared.size > 0) {
    rec.ok('secrets-env-match', `声明与读取一致：${[...declared].sort().join(', ')}`)
  }

  // ---- 6. 清单本体 ----
  if (manifests.length === 0) {
    if (nameIsPlugin) {
      rec.warn('manifest-present', '名字像插件包但没有 gitrader-plugin.json：按库包处理，记「未声明权限」')
      rec.info('manifest-scope', '没有清单就没有 tools[]，工具名 / 权限 / 净白名单三项跳过')
    }
  }
  const toolNames = []
  for (const man of manifests) {
    const label = man.where
    const json = man.inline ?? loadJson(man.file)
    if (!json) { rec.fail('manifest-json', `${label}: 不是合法 JSON`); continue }
    if (json.schema !== protocol.manifestSchema) rec.fail('manifest-schema', `${label}: schema 应为 ${protocol.manifestSchema}（现在 ${JSON.stringify(json.schema ?? null)}）`)
    else rec.ok('manifest-schema', `${label}: ${json.schema}`)

    if (protocol.idRe) {
      if (typeof json.id !== 'string' || !protocol.idRe.test(json.id)) rec.fail('manifest-id', `${label}: id ${JSON.stringify(json.id ?? null)} 不匹配 ${protocol.idRe.source}`)
      else rec.ok('manifest-id', json.id)
    }
    if (protocol.versionRe) {
      if (typeof json.version !== 'string' || !protocol.versionRe.test(json.version)) rec.fail('manifest-version', `${label}: version ${JSON.stringify(json.version ?? null)} 不是 semver`)
      else if (pkg.version && json.version !== pkg.version) rec.warn('manifest-version', `${label}: version ${json.version} 与 package.json ${pkg.version} 不一致`)
      else rec.ok('manifest-version', json.version)
    }
    if (protocol.kinds.length > 0 && !protocol.kinds.includes(json.kind)) rec.fail('manifest-kind', `${label}: kind ${JSON.stringify(json.kind ?? null)} 不在协议枚举里`)
    if (!json.name || !json.desc) rec.fail('manifest-text', `${label}: name / desc 必填`)
    if (protocol.requiredFields.length > 0) {
      const missing = protocol.requiredFields.filter((f) => json[f] === undefined)
      if (missing.length > 0) rec.fail('manifest-required-fields', `${label}: 缺协议必填字段 ${missing.join(' / ')}`)
      else rec.ok('manifest-required-fields', `${label}: 协议必填字段 ${protocol.requiredFields.length} 项齐全`)
    }

    // 许可证
    const mspdx = json.license?.spdx
    if (!mspdx) rec.fail('manifest-license', `${label}: license.spdx 必填`)
    else if (!spdx) rec.warn('manifest-license', `${label}: license.spdx ${mspdx}，但 package.json 没有 license 可比对`)
    else if (mspdx !== spdx) rec.fail('manifest-license', `${label}: license.spdx ${mspdx} 与 package.json license ${spdx} 不一致`)
    else rec.ok('manifest-license', `${mspdx}（与 package.json 一致）`)
    const missingLicenseFields = ['redistribute', 'notice', 'commercialUse'].filter((f) => json.license?.[f] === undefined)
    if (missingLicenseFields.length > 0) rec.fail('manifest-license-fields', `${label}: license 缺必填字段 ${missingLicenseFields.join(' / ')}（schema 要求）`)
    else rec.ok('manifest-license-fields', `${label}: license 四个必填字段齐全`)

    // 运行期
    if (protocol.runtimeTypes.length > 0 && !protocol.runtimeTypes.includes(json.runtime?.type)) rec.fail('manifest-runtime', `${label}: runtime.type ${JSON.stringify(json.runtime?.type ?? null)} 不在协议枚举里`)
    else if (typeof json.runtime?.native !== 'boolean' || typeof json.runtime?.diskMB !== 'number') rec.fail('manifest-runtime', `${label}: runtime.native / runtime.diskMB 必填（schema 要求）`)
    else rec.ok('manifest-runtime', `runtime: ${json.runtime.type} / diskMB ${json.runtime.diskMB}`)

    // 入口文件真实存在
    if (typeof json.entry?.module === 'string') {
      const entryAbs = join(man.dir, json.entry.module)
      if (!existsSync(entryAbs)) rec.fail('manifest-entry', `${label}: entry.module ${json.entry.module} 文件不存在`)
      else rec.ok('manifest-entry', `entry.module ${json.entry.module}`)
    } else if (typeof json.entry?.element === 'string' || Array.isArray(json.entry?.command) || typeof json.entry?.url === 'string') {
      rec.ok('manifest-entry', `entry: ${json.entry.element ?? json.entry.url ?? json.entry.command?.join(' ')}`)
    } else rec.fail('manifest-entry', `${label}: entry 既没有 module/element/command/url`)

    // 权限
    const perms = json.permissions
    if (!Array.isArray(perms)) rec.warn('permissions-declared', `${label}: 未声明权限（清单没有 permissions 字段）`)
    else {
      const unknown = perms.filter((p) => protocol.permissions.size > 0 && !protocol.permissions.has(p))
      const forbidden = perms.filter((p) => protocol.neverGrantable.has(p))
      if (forbidden.length > 0) rec.fail('permissions-forbidden', `${label}: 申请了永不可授予的权限：${forbidden.join(', ')}`)
      else if (unknown.length > 0) rec.fail('permissions-known', `${label}: 权限不在协议枚举里：${unknown.join(', ')}`)
      else rec.ok('permissions-declared', `${label}: [${perms.join(', ')}]${perms.length === 0 ? '（空数组）' : ''}`)
      if (perms.includes('net.fetch')) {
        const hosts = json.net?.hosts
        if (!Array.isArray(hosts) || hosts.length === 0) rec.fail('permissions-net-hosts', `${label}: 声明 net.fetch 却没有 net.hosts（出网面不可见）`)
        else rec.ok('permissions-net-hosts', `net.hosts: ${hosts.join(', ')}`)
      }
    }

    // 工具名
    if (Array.isArray(json.tools)) {
      if (json.tools.length === 0) {
        rec.warn('tools-names', `${label}: tools[] 为空（block/preset 类只挂 UI 元素时可接受，其他 kind 请确认）`)
      } else {
        const bad = protocol.toolNameRe
          ? json.tools.filter((t) => typeof t?.name !== 'string' || !protocol.toolNameRe.test(t.name)).map((t) => t?.name ?? '(无名)')
          : []
        const names = json.tools.map((t) => t?.name)
        const dups = names.filter((n, i) => names.indexOf(n) !== i)
        toolNames.push(...names.filter((n) => typeof n === 'string'))
        if (!protocol.toolNameRe) { /* 口径缺失已在仓库级记 protocol-source 失败，这里不重复判 */ }
        else if (bad.length > 0) rec.fail('tools-names', `${label}: 工具名不匹配 ${protocol.toolNamePattern}：${bad.join(', ')}`)
        else rec.ok('tools-names', `${label}: ${names.join(', ')} 都匹配 ${protocol.toolNamePattern}`)
        if (dups.length > 0) rec.fail('tools-dupes', `${label}: 工具重名：${[...new Set(dups)].join(', ')}`)
        const noSchema = json.tools.filter((t) => !t?.input || !t?.output).map((t) => t?.name ?? '(无名)')
        if (noSchema.length > 0) rec.warn('tools-schemas', `${label}: 工具缺 input/output schema：${noSchema.join(', ')}`)
        const noPerm = json.tools.filter((t) => !Array.isArray(t?.permissions)).map((t) => t?.name ?? '(无名)')
        if (noPerm.length > 0) rec.warn('tools-permissions', `${label}: 工具没有逐工具权限声明：${noPerm.join(', ')}`)
        // 协议规则：tools[].permissions 必须是清单 permissions 的子集，且 input 必须是 type: "object"
        const manifestPerms = new Set(Array.isArray(json.permissions) ? json.permissions : [])
        for (const t of json.tools) {
          for (const p of Array.isArray(t?.permissions) ? t.permissions : []) {
            if (!manifestPerms.has(p)) rec.fail('tools-perms-subset', `${label}: 工具 ${t?.name} 申请了清单没声明的权限 ${p}（协议要求是清单 permissions 的子集）`)
          }
        }
        const badInput = json.tools.filter((t) => t?.input?.type !== 'object').map((t) => t?.name ?? '(无名)')
        if (badInput.length > 0) rec.fail('tools-input-object', `${label}: 工具 input 必须是 type "object"：${badInput.join(', ')}`)
        else rec.ok('tools-input-object', `${label}: ${json.tools.length} 个工具的 input 都是 type "object"`)
        // 通知契约单一事实源：文档取不到时已在仓库级记失败，这里只在拿到契约时逐项核对。
        if (notify?.contract) {
          for (const t of json.tools) if (t?.name === 'notify_send') auditNotifyContract(t, notify.contract, label, rec)
        }
      }
    } else if (json.kind === 'block' || json.kind === 'layout-preset') rec.warn('tools-names', `${label}: 没有 tools[]（kind ${json.kind} 挂 UI 元素，可接受）`)
    else rec.warn('tools-names', `${label}: 没有 tools[]（schema 不强制；确认这个插件确实不对外提供工具）`)
  }

  // 跨清单重名（同一包里 example 多份清单时）
  if (manifests.length > 1) {
    const dupAcross = toolNames.filter((n, i) => toolNames.indexOf(n) !== i)
    if (dupAcross.length > 0) rec.fail('tools-dupes-across', `包内多份清单工具重名：${[...new Set(dupAcross)].join(', ')}`)
  }

  const issues = rec.checks.filter((c) => !c.ok)
  return {
    dir,
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    license: pkg.license ?? null,
    surface: manifests.some((m) => m.where === 'gitrader-plugin.json') ? 'installable' : manifests.length > 0 ? 'example-only' : nameIsPlugin ? 'library' : 'unknown',
    manifests: manifests.map((m) => m.where),
    tools: [...new Set(toolNames)],
    permissions: [...new Set(manifests.flatMap((m) => (m.inline ?? loadJson(m.file))?.permissions ?? []))],
    secrets: [...declared].sort(),
    envReads: nonReserved,
    sourceFiles: sources.map((s) => s.rel),
    checks: rec.checks,
    failed: issues.filter((c) => c.severity === 'fail').length,
    warned: issues.filter((c) => c.severity === 'warn').length,
  }
}

function manifestosHaveSecrets(manifests) {
  return manifests.some((m) => Array.isArray((m.inline ?? loadJson(m.file))?.secrets))
}

// ---------------------------------------------------------------------------------------------
// 全仓
// ---------------------------------------------------------------------------------------------

export function auditRepo(root, { strict = false } = {}) {
  const protocol = loadProtocol(root)
  const notify = loadNotifyContract(root)
  // 判定口径取不到 = 显式失败：不回退内置常量，也不跳过检查后退出 0。
  const repoChecks = [
    ...protocol.problems.map((detail) => ({ id: 'protocol-source', ok: false, severity: 'fail', detail })),
    ...notify.problems.map((detail) => ({ id: 'notify-contract-source', ok: false, severity: 'fail', detail })),
  ]
  const { workspaces } = loadWorkspaces(root)
  if (!workspaces || workspaces.size === 0) throw new Error('没找到工作区包（packages/*）：--root 指对了吗？')
  const candidates = []
  for (const ws of [...workspaces.values()].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const hasManifest = findManifests(ws.abs, ws.pkg).length > 0
    const nameMatch = PLUGIN_NAME_RE.test(ws.pkg.name ?? '')
    const gitraderField = Boolean(inlinePluginField(ws.pkg))
    if (!hasManifest && !nameMatch && !gitraderField) continue
    candidates.push(auditPackage({ root, ws, protocol, notify }))
  }
  // 仓库级：同一个工具名被多个插件包声明（内核装多个就会撞车，至少要人看一眼）
  const byTool = new Map()
  for (const p of candidates) for (const t of p.tools) {
    if (!byTool.has(t)) byTool.set(t, [])
    byTool.get(t).push(p.dir)
  }
  const collisions = [...byTool.entries()].filter(([, dirs]) => dirs.length > 1).sort((a, b) => a[0].localeCompare(b[0]))
  for (const [tool, dirs] of collisions) {
    repoChecks.push({ id: 'repo-tool-collision', ok: false, severity: 'warn', detail: `工具名 ${tool} 被 ${dirs.length} 个包声明（${dirs.join(', ')}）：同时装会撞名，确认内核只允许其一` })
  }
  const checks = candidates.flatMap((p) => p.checks)
  const all = [...repoChecks, ...checks]
  const failures = all.filter((c) => !c.ok && c.severity === 'fail')
  const warnings = all.filter((c) => !c.ok && c.severity === 'warn')
  const installable = candidates.filter((p) => p.surface === 'installable')
  return {
    tool: 'plugin-audit',
    schema: 'hermes-audit/1',
    generatedAt: new Date().toISOString(),
    root,
    strict,
    protocol: {
      manifest: protocol.source.manifest,
      schema: protocol.source.schema,
      toolNamePattern: protocol.toolNamePattern,
      idPattern: protocol.idRe ? protocol.idRe.source : null,
      manifestSchema: protocol.manifestSchema,
      requiredFields: protocol.requiredFields,
      permissions: protocol.permissionList,
      neverGrantable: [...protocol.neverGrantable],
      notes: protocol.problems,
    },
    notifyContract: {
      source: NOTIFY_DOC,
      parsed: notify.contract !== null,
      notes: notify.problems,
      inputRequired: notify.contract?.input?.required ?? null,
      noticeRequired: notify.contract?.input?.properties?.notice?.required ?? null,
      levelEnum: notify.contract?.input?.properties?.notice?.properties?.level?.enum ?? null,
    },
    summary: {
      workspaces: workspaces.size,
      candidates: candidates.length,
      installable: installable.length,
      libraryOnly: candidates.length - installable.length,
      manifestFiles: candidates.reduce((n, p) => n + p.manifests.length, 0),
      packagesWithTools: candidates.filter((p) => p.tools.length > 0).length,
      checks: all.length,
      passed: all.length - failures.length - warnings.length,
      failed: failures.length,
      warned: warnings.length,
      sourceFilesScanned: candidates.reduce((n, p) => n + p.sourceFiles.length, 0),
      envVarsRead: [...new Set(candidates.flatMap((p) => p.envReads))].length,
      declaredSecrets: [...new Set(candidates.flatMap((p) => p.secrets))].length,
    },
    repoChecks,
    packages: candidates,
    failures: failures.map((c) => c.detail),
    warnings: warnings.map((c) => c.detail),
    exitCode: failures.length > 0 || (strict && warnings.length > 0) ? 1 : 0,
  }
}

// ---------------------------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------------------------

function printHuman(r) {
  const s = r.summary
  console.log('plugin-audit · 插件完备性体检')
  console.log(`仓库：${toPosix(r.root)}`)
  console.log(`契约口径：${r.protocol.manifest} + ${r.protocol.schema}`)
  console.log(`  工具名正则 ${r.protocol.toolNamePattern ?? '(取不到)'} · 清单 schema ${r.protocol.manifestSchema} · 权限枚举 ${r.protocol.permissions.length} 项 · 永不可授予 ${r.protocol.neverGrantable.length} 项`)
  console.log(`工作区包 ${s.workspaces} 个，插件候选 ${s.candidates} 个（可安装 ${s.installable} / 仅库包 ${s.libraryOnly}），清单文件 ${s.manifestFiles} 份`)
  console.log('')
  for (const p of r.packages) {
    const tag = p.failed > 0 ? 'FAIL' : p.warned > 0 ? 'warn' : 'ok'
    console.log(`${tag.padEnd(4)}  ${p.dir}  ${p.name} @${p.version}  [${p.surface}]`)
    for (const c of p.checks) {
      const mark = c.ok ? (c.info ? 'note' : 'ok') : c.severity === 'fail' ? 'FAIL' : 'warn'
      console.log(`      ${mark.padEnd(4)}  ${c.id}: ${c.detail}`)
    }
  }
  if (r.repoChecks && r.repoChecks.length > 0) {
    console.log('')
    console.log('仓库级')
    for (const c of r.repoChecks) console.log(`      ${(c.ok ? 'ok' : c.severity === 'fail' ? 'FAIL' : 'warn').padEnd(4)}  ${c.id}: ${c.detail}`)
  }
  console.log('')
  console.log(`合计：${s.candidates} 个包 / ${s.checks} 项检查 · 通过 ${s.passed} · 警告 ${s.warned} · 失败 ${s.failed}`)
  console.log(`扫描源码 ${s.sourceFilesScanned} 个文件 · 读到 ${s.envVarsRead} 个非内核环境变量 · 声明 ${s.declaredSecrets} 个 secret`)
  if (s.failed > 0) console.error(`\n${s.failed} 项失败${r.strict ? '（--strict）' : ''}`)
  else if (s.warned > 0) console.log(`\n${s.warned} 项警告（不算失败${r.strict ? '，但 --strict 下算' : ''}）`)
  else console.log('\n全部通过')
}

// ---------------------------------------------------------------------------------------------

function main(argv) {
  const FLAGS = new Set(['--json', '--strict', '--help', '-h'])
  const flags = new Set(argv.filter((a) => FLAGS.has(a)))
  const keyed = argv.filter((a) => !FLAGS.has(a))
  let args
  try { args = parseArgs(keyed, ['root']) } catch (err) { console.error(`参数错误：${err.message}\n\n${USAGE}`); return 2 }
  if (args.help || flags.has('--help') || flags.has('-h')) { console.log(USAGE); return 0 }
  const jsonOnly = flags.has('--json')
  const strict = flags.has('--strict')
  const root = resolve(args.root ?? DEFAULT_ROOT)
  let report
  try {
    report = auditRepo(root, { strict })
  } catch (err) {
    if (jsonOnly) console.log(JSON.stringify({ tool: 'plugin-audit', error: err instanceof Error ? err.message : String(err) }, null, 2))
    else console.error(`运行错误：${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
  if (jsonOnly) console.log(JSON.stringify(report, null, 2))
  else printHuman(report)
  return report.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
