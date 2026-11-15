// SPDX-License-Identifier: Apache-2.0
// 插件协议 r2（v0.1.9）：semver、结构化问题码、承诺用语、兼容检查、compileSchema、错误码 5008 / 5009。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_BASES, ID_PREFIX_OF_KIND, PLUGIN_ISSUE_CODES, PLUGIN_KINDS, PLUGIN_PROMISE_PATTERNS, PLUGIN_TOOL_NAME_RE, PLUGIN_TOOL_TAGS, PROBLEM_CODES,
  PROTOCOL_PACKAGE_VERSION, categoryOfCode, checkPluginCompat, checkPluginManifest, checkPluginManifestIssues, compareVersions, compileSchema,
  findPromiseLanguage, findUnsafePatterns, formatIssues, isValidRange, patternRisk, parseVersion, satisfiesRange, validatePluginManifest,
  type PluginIssueCode, type PluginKind, type PluginManifest, type PluginTool,
} from '../src'
import { PKG_ROOT, clone, contract } from './helpers'

const HEX64 = `sha256:${'a'.repeat(64)}`

/** 一份最小合法清单（技能包，零权限，无工具）。 */
function base(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schema: 'gitrader-plugin/1', id: 'skill.acme.sizer', package: 'skill', kind: 'skill', name: 'Sizer', desc: 'Position sizing helper.', tags: ['utility'], version: '1.0.0',
    vendor: { id: 'acme', name: 'Acme', kind: 'community', verified: false, url: null },
    source: { repo: 'acme/sizer', commit: 'b'.repeat(40), sha256: HEX64 as never, fetchedAt: 1 },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'Apache-2.0', commercialUse: true },
    runtime: { type: 'node', native: false, diskMB: 1 }, entry: { module: './index.mjs' }, install: { by: 'user-install', requireHashes: true },
    permissions: [], privacy: { hosted: false, sends: [] }, provides: {}, fixtures: { offline: [], smoke: [] },
    compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
    ...over,
  } as PluginManifest
}
/** 换 kind 时一并改 id 前缀（package 保持 block 以免触发 PACKAGE_KIND_MISMATCH）。 */
function as(kind: PluginKind, over: Partial<PluginManifest> = {}): PluginManifest {
  return base({ id: `${ID_PREFIX_OF_KIND[kind]}.acme.sizer`, kind, package: kind === 'skill' ? 'skill' : 'block', ...over })
}
const tool = (over: Partial<PluginTool> = {}): PluginTool => ({ name: 'position_size', desc: 'Size a position.', tags: ['risk'], input: { type: 'object', properties: { equity: { type: 'string' } }, required: ['equity'] }, ...over })
const codes = (m: PluginManifest): PluginIssueCode[] => checkPluginManifestIssues(m).map((i) => i.code)
const pick = (m: PluginManifest, code: PluginIssueCode) => checkPluginManifestIssues(m).filter((i) => i.code === code)

describe('semver', () => {
  it('parseVersion / compareVersions', () => {
    expect(parseVersion('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['beta', '1'] })
    expect(parseVersion('1.2.3+build.5')?.pre).toEqual([])
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(() => compareVersions('x', '1.0.0')).toThrow(/invalid version/)
  })
  it('satisfiesRange：比较符、^、~、精确、*、与、或', () => {
    const t: [string, string, boolean][] = [
      ['0.1.5', '>=0.1.0 <0.2.0', true], ['0.2.0', '>=0.1.0 <0.2.0', false], ['0.0.9', '>=0.1.0 <0.2.0', false],
      ['0.1.9', '^0.1.0', true], ['0.2.0', '^0.1.0', false], ['0.0.5', '^0.0.3', false], ['0.0.3', '^0.0.3', true], ['1.9.9', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.2.2', '^1.2.3', false],
      ['0.1.9', '~0.1.0', true], ['0.2.0', '~0.1.0', false], ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false],
      ['9.9.9', '*', true], ['0.1.0', '0.1.0', true], ['0.1.0', '=0.1.0', true], ['0.1.1', '0.1.0', false],
      ['0.1.0', '>0.1.0', false], ['0.1.1', '>0.1.0', true], ['0.1.0', '<=0.1.0', true], ['0.1.1', '<0.1.1', false],
      ['2.0.0', '>=0.1.0 || >=1.0.0', true], ['0.0.1', '<0.1.0 || >=1.0.0', true], ['0.5.0', '<0.1.0 || >=1.0.0', false],
      ['1.0.0-rc.1', '>=1.0.0', false], ['1.0.0-rc.1', '>=1.0.0-rc.0', true], ['1.0.1-rc.1', '>=1.0.0-rc.0', false], ['1.0.0-rc.1', '*', false], ['1.0.0-rc.1', '^1.0.0-rc.0', true],
      ['2.0.0-rc.1', '^1.0.0-rc.0', false], ['1.0.0', '>=1.0.0-rc.0', true],
    ]
    for (const [v, r, want] of t) expect(satisfiesRange(v, r), `${v} in ${r}`).toBe(want)
  })
  it('非法范围 / 非法版本 → 不满足；isValidRange', () => {
    for (const bad of ['latest', '', '  ', '>=', '1.x', '1.2', '>=0.1.0 ||', '|| 1.0.0', '^', 'foo bar', '~>1.0.0', '>= 0.1.0']) expect(isValidRange(bad), JSON.stringify(bad)).toBe(false)
    for (const ok of ['*', '1.0.0', '=1.0.0', '>=0.1.0 <0.2.0', '^0.1.0', '~0.1.0', '<1.0.0-rc.1', '  >=0.1.0   <0.2.0  ', '>=0.1.0 || >=1.0.0']) expect(isValidRange(ok), ok).toBe(true)
    expect(isValidRange('latest')).toBe(false)
    expect(satisfiesRange('0.1.0', 'latest')).toBe(false)
    expect(satisfiesRange('nope', '*')).toBe(false)
  })
})

describe('常量与错误码', () => {
  it('PLUGIN_ISSUE_CODES：37 个、前 35 项保持原序且不重复；工具标签 10 个；证据口径 3 种', () => {
    expect(PLUGIN_ISSUE_CODES.length).toBe(37)
    expect(new Set(PLUGIN_ISSUE_CODES).size).toBe(37); expect(PLUGIN_ISSUE_CODES.slice(0, 35)).toEqual(['MANIFEST_UNREADABLE', 'SCHEMA', 'ID_PREFIX_MISMATCH', 'VENDOR_ID_MISMATCH', 'DUPLICATE_ID', 'PACKAGE_KIND_MISMATCH', 'PERMISSION_NEVER_GRANTABLE', 'PERMISSION_UNKNOWN', 'PERMISSION_KIND_MISMATCH', 'NET_HOSTS_EMPTY', 'FACTOR_HAS_NET', 'UNSIGNED_FORBIDDEN_PERMISSION', 'KIND_REQUIRES_FIELD', 'TOOL_NAME_DUPLICATE', 'TOOL_SCHEMA_INVALID', 'TOOL_PERMISSION_UNDECLARED', 'TOOLS_NOT_CALLABLE', 'EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS', 'EVIDENCE_FORWARD_NEEDS_REF', 'EVIDENCE_WINDOW_INVALID', 'PRIVACY_SENDS_WITHOUT_NET', 'PRIVACY_HOSTED_WITHOUT_NET', 'PROMISE_LANGUAGE', 'REQUIRES_VERSION_INEXACT', 'HASH_MISMATCH', 'UNSIGNED_NOT_ALLOWED', 'SIGNATURE_KEY_UNTRUSTED', 'SIGNATURE_DIGEST_MISMATCH', 'SIGNATURE_INVALID', 'ENTRY_MISSING', 'ENTRY_NOT_FOUND', 'ENTRY_ESCAPES', 'COMPAT_SCHEMA_UNSUPPORTED', 'COMPAT_RANGE_INVALID', 'COMPAT_GITRADER_UNSATISFIED'])
    expect(PLUGIN_TOOL_TAGS.length).toBe(10)
    expect([...EVIDENCE_BASES]).toEqual(['backtest', 'paper', 'live'])
    for (const ok of ['position_size', 'readOutside', 'read_path', 'Position-Size']) expect(PLUGIN_TOOL_NAME_RE.test(ok), ok).toBe(true)
    for (const bad of ['a.b', '', 'a b', 'a'.repeat(65)]) expect(PLUGIN_TOOL_NAME_RE.test(bad), bad).toBe(false)
  })
  it('ID_PREFIX_OF_KIND：全部等于 kind，唯一例外 decision-model → decision', () => {
    for (const k of PLUGIN_KINDS) expect(ID_PREFIX_OF_KIND[k]).toBe(k === 'decision-model' ? 'decision' : k)
  })
  it('PROBLEM_CODES 含 5008 / 5009（PROTOCOL，不可重试）', () => {
    expect(PROBLEM_CODES.PLUGIN_TOOL_UNKNOWN).toEqual({ code: 5008, name: 'PLUGIN_TOOL_UNKNOWN', category: 'PROTOCOL', retryable: false })
    expect(PROBLEM_CODES.PLUGIN_RESULT_INVALID).toEqual({ code: 5009, name: 'PLUGIN_RESULT_INVALID', category: 'PROTOCOL', retryable: false })
    expect(categoryOfCode(5008)).toBe('PROTOCOL')
    const all = Object.values(PROBLEM_CODES).map((c) => c.code)
    expect(new Set(all).size).toBe(all.length)
  })
  it('版本 0.1.14', () => expect(PROTOCOL_PACKAGE_VERSION).toBe('0.1.14'))
})

describe('身份', () => {
  it('ID_PREFIX_MISMATCH：路径 /id；decision-model 用 decision 前缀', () => {
    expect(codes(base())).toEqual([])
    const bad = pick(base({ id: 'strategy.acme.sizer' }), 'ID_PREFIX_MISMATCH')
    expect(bad.length).toBe(1)
    expect(bad[0]!.path).toBe('/id')
    expect(bad[0]!.message).toMatch(/must be "skill"/)
    expect(pick(as('decision-model', { id: 'decision-model.acme.sizer', evidence: { claims: [] } }), 'ID_PREFIX_MISMATCH').length).toBe(1)
    expect(pick(as('decision-model', { evidence: { claims: [] } }), 'ID_PREFIX_MISMATCH')).toEqual([])
  })
  it('VENDOR_ID_MISMATCH：id 第二段 ≠ vendor.id', () => {
    const bad = pick(base({ id: 'skill.other.sizer' }), 'VENDOR_ID_MISMATCH')
    expect(bad.length).toBe(1)
    expect(bad[0]!.path).toBe('/id')
    expect(pick(base(), 'VENDOR_ID_MISMATCH')).toEqual([])
  })
  it('PACKAGE_KIND_MISMATCH：package=skill 但 kind≠skill', () => {
    const bad = pick(as('block', { package: 'skill', ui: { blocks: [] } }), 'PACKAGE_KIND_MISMATCH')
    expect(bad.map((i) => i.path)).toEqual(['/package'])
    expect(bad[0]!.message).toBe('package skill requires kind skill')
    expect(pick(base(), 'PACKAGE_KIND_MISMATCH')).toEqual([])
  })
})

describe('权限', () => {
  it('三种权限问题各带 /permissions/<i> 路径，消息文本不变', () => {
    const m = as('executor', { permissions: ['market.read', 'withdraw', 'bogus.perm', 'venue.credentials'] as never, risk: { disclosure: 'd', worstCase: 'w', builderAttribution: 'off' }, signature: { alg: 'ed25519', keyId: 'k', digest: HEX64 as never, sig: 's' } })
    const issues = checkPluginManifestIssues(m)
    expect(issues.find((i) => i.code === 'PERMISSION_NEVER_GRANTABLE')).toMatchObject({ path: '/permissions/1', message: 'permission withdraw can never be granted' })
    expect(issues.find((i) => i.code === 'PERMISSION_UNKNOWN')).toMatchObject({ path: '/permissions/2', message: 'unknown permission bogus.perm' })
    expect(issues.find((i) => i.code === 'PERMISSION_KIND_MISMATCH')).toMatchObject({ path: '/permissions/3', message: 'kind executor cannot request venue.credentials' })
    expect(codes(as('executor', { permissions: ['market.read'], risk: { disclosure: 'd', worstCase: 'w', builderAttribution: 'off' } }))).toEqual([])
  })
  it('NET_HOSTS_EMPTY：路径 /net/hosts', () => {
    const tos = { commercial: true, redistribute: true, attribution: '' }
    expect(pick(as('datasource', { tos, permissions: ['net.fetch'], net: { hosts: [] } }), 'NET_HOSTS_EMPTY')[0]!.path).toBe('/net/hosts')
    expect(pick(as('datasource', { tos, permissions: ['net.fetch'] }), 'NET_HOSTS_EMPTY').length).toBe(1)
    expect(pick(as('datasource', { tos, permissions: ['net.fetch'], net: { hosts: ['api.example.org'] } }), 'NET_HOSTS_EMPTY')).toEqual([])
  })
  it('FACTOR_HAS_NET', () => {
    const f = as('factor', { evidence: { claims: [] }, net: { hosts: ['api.example.org'] } })
    expect(pick(f, 'FACTOR_HAS_NET').map((i) => i.path)).toEqual(['/net'])
    expect(pick(as('factor', { evidence: { claims: [] } }), 'FACTOR_HAS_NET')).toEqual([])
  })
  it('UNSIGNED_FORBIDDEN_PERMISSION：未签名才报，路径指向该权限', () => {
    const risk = { disclosure: 'd', worstCase: 'w', builderAttribution: 'off' as const }
    const m = as('executor', { permissions: ['market.read', 'trade.live'], risk })
    expect(pick(m, 'UNSIGNED_FORBIDDEN_PERMISSION')).toMatchObject([{ path: '/permissions/1', message: 'unsigned plugin must not request trade.live' }])
    m.signature = { alg: 'ed25519', keyId: 'k', digest: HEX64 as never, sig: 's' }
    expect(pick(m, 'UNSIGNED_FORBIDDEN_PERMISSION')).toEqual([])
  })
  it('REQUIRES_VERSION_INEXACT：路径 /requires/<i>/version', () => {
    const m = base({ requires: [{ kind: 'npm', name: 'a', version: '1.0.0', sha256: HEX64 as never }, { kind: 'npm', name: 'b', version: '^1.0.0', sha256: HEX64 as never }] })
    expect(pick(m, 'REQUIRES_VERSION_INEXACT')).toMatchObject([{ path: '/requires/1/version', message: 'requires b: version must be exact, got ^1.0.0' }])
  })
})

describe('kind 必填项', () => {
  it('KIND_REQUIRES_FIELD：五类 + block 缺 ui.blocks，消息文本不变', () => {
    const cases: [PluginManifest, string, string][] = [
      [as('engine'), '/engine', 'kind engine requires engine.gep'],
      [as('datasource'), '/tos', 'kind datasource requires tos'],
      [as('strategy'), '/evidence', 'kind strategy requires evidence'],
      [as('executor'), '/risk', 'kind executor requires risk'],
      [as('block'), '/ui', 'kind block requires ui.blocks'],
      [base({ runtime: { type: 'stdio-mcp', native: false, diskMB: 1 } }), '/mcp', 'MCP runtime requires mcp'],
    ]
    for (const [m, path, message] of cases) {
      const hit = pick(m, 'KIND_REQUIRES_FIELD').find((i) => i.path === path)
      expect(hit?.message, message).toBe(message)
    }
    expect(pick(as('block', { ui: { blocks: [] } }), 'KIND_REQUIRES_FIELD')).toEqual([])
    expect(pick(as('strategy', { evidence: { claims: [] }, risk: { disclosure: 'd', worstCase: 'w', builderAttribution: 'off' } }), 'KIND_REQUIRES_FIELD')).toEqual([])
  })
})

describe('工具', () => {
  it('合法工具无问题', () => {
    expect(codes(base({ tools: [tool(), tool({ name: 'other', output: { type: 'object' }, permissions: [] })] }))).toEqual([])
  })
  it('TOOL_NAME_DUPLICATE：第二个重名工具，路径 /tools/1/name', () => {
    const hit = pick(base({ tools: [tool(), tool()] }), 'TOOL_NAME_DUPLICATE')
    expect(hit.map((i) => i.path)).toEqual(['/tools/1/name'])
    expect(pick(base({ tools: [tool(), tool({ name: 'b' })] }), 'TOOL_NAME_DUPLICATE')).toEqual([])
  })
  it('TOOL_SCHEMA_INVALID：input 不是 object schema / 编译不过 / output 编译不过 / 名字不合正则', () => {
    expect(pick(base({ tools: [tool({ input: { type: 'string' } })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/input'])
    expect(pick(base({ tools: [tool({ input: {} })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/input'])
    expect(pick(base({ tools: [tool({ input: [] as never })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/input'])
    expect(pick(base({ tools: [tool({ input: { type: 'object', properties: { a: { type: 'strnig' } } } })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/input'])
    expect(pick(base({ tools: [tool({ output: { type: 'object', required: 'x' } })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/output'])
    expect(pick(base({ tools: [tool({ name: 'Bad Name' })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/name'])
    expect(pick(base({ tools: [tool()] }), 'TOOL_SCHEMA_INVALID')).toEqual([])
  })
  it('TOOL_PERMISSION_UNDECLARED：工具权限必须是清单权限的子集', () => {
    const hit = pick(base({ tools: [tool({ permissions: ['market.read', 'ledger.read'] })], permissions: ['market.read'] }), 'TOOL_PERMISSION_UNDECLARED')
    expect(hit.map((i) => i.path)).toEqual(['/tools/0/permissions/1'])
    expect(pick(base({ tools: [tool({ permissions: ['market.read'] })], permissions: ['market.read'] }), 'TOOL_PERMISSION_UNDECLARED')).toEqual([])
  })
  it('TOOLS_NOT_CALLABLE：browser 运行时不能声明工具', () => {
    const browser = { type: 'browser' as const, native: false, diskMB: 1 }
    expect(pick(as('block', { runtime: browser, ui: { blocks: [] }, tools: [tool()] }), 'TOOLS_NOT_CALLABLE').map((i) => i.path)).toEqual(['/tools'])
    expect(pick(as('block', { runtime: browser, ui: { blocks: [] }, tools: [] }), 'TOOLS_NOT_CALLABLE')).toEqual([])
    expect(pick(base({ tools: [tool()] }), 'TOOLS_NOT_CALLABLE')).toEqual([])
  })
})

describe('证据', () => {
  const claim = (over: Record<string, unknown>) => ({ metric: 'sharpe', value: '1.2', basis: 'backtest', window: { from: 1, to: 2 }, assumptions: ['fees 5bp, slippage 2bp, venue candles 2024'], ...over })
  const strat = (claims: unknown[], notes?: string): PluginManifest =>
    as('strategy', { risk: { disclosure: 'd', worstCase: 'w', builderAttribution: 'off' }, evidence: { claims: claims as never, ...(notes ? { notes } : {}) } })
  it('EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS', () => {
    expect(codes(strat([claim({})]))).toEqual([])
    expect(codes(strat([]))).toEqual([])
    expect(pick(strat([claim({}), claim({ assumptions: undefined })]), 'EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS').map((i) => i.path)).toEqual(['/evidence/claims/1'])
    expect(pick(strat([claim({ assumptions: [] })]), 'EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS').length).toBe(1)
    expect(pick(strat([claim({ assumptions: ['  '] })]), 'EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS').length).toBe(1)
  })
  it('EVIDENCE_FORWARD_NEEDS_REF：paper / live 要 ref，backtest 不要', () => {
    expect(pick(strat([claim({ basis: 'paper', assumptions: undefined })]), 'EVIDENCE_FORWARD_NEEDS_REF').map((i) => i.path)).toEqual(['/evidence/claims/0'])
    expect(pick(strat([claim({ basis: 'live', ref: '' })]), 'EVIDENCE_FORWARD_NEEDS_REF').length).toBe(1)
    expect(pick(strat([claim({ basis: 'live', ref: 'led_01JAB' })]), 'EVIDENCE_FORWARD_NEEDS_REF')).toEqual([])
    expect(pick(strat([claim({})]), 'EVIDENCE_FORWARD_NEEDS_REF')).toEqual([])
  })
  it('EVIDENCE_WINDOW_INVALID：from >= to，路径到 window', () => {
    expect(pick(strat([claim({ window: { from: 5, to: 5 } })]), 'EVIDENCE_WINDOW_INVALID').map((i) => i.path)).toEqual(['/evidence/claims/0/window'])
    expect(pick(strat([claim({ window: { from: 9, to: 2 } })]), 'EVIDENCE_WINDOW_INVALID').length).toBe(1)
    expect(pick(strat([claim({ window: { from: 1, to: 2 } })]), 'EVIDENCE_WINDOW_INVALID')).toEqual([])
  })
  it('evidence 缺 claims（旧式自由对象）不让语义层崩溃', () => {
    expect(() => checkPluginManifestIssues(as('strategy', { risk: { disclosure: 'd', worstCase: 'w', builderAttribution: 'off' }, evidence: { foo: 1 } as never }))).not.toThrow()
  })
})

describe('隐私一致性', () => {
  it('PRIVACY_SENDS_WITHOUT_NET', () => {
    expect(pick(base({ privacy: { hosted: false, sends: ['positions'] } }), 'PRIVACY_SENDS_WITHOUT_NET').map((i) => i.path)).toEqual(['/privacy/sends'])
    const net = as('datasource', { tos: { commercial: true, redistribute: true, attribution: '' }, permissions: ['net.fetch'], net: { hosts: ['api.example.org'] } })
    expect(pick({ ...net, privacy: { hosted: false, sends: ['positions'] } }, 'PRIVACY_SENDS_WITHOUT_NET')).toEqual([])
    expect(pick({ ...net, privacy: { hosted: false, sends: [] } }, 'PRIVACY_SENDS_WITHOUT_NET')).toEqual([])
  })
  it('PRIVACY_HOSTED_WITHOUT_NET', () => {
    expect(pick(base({ privacy: { hosted: true, sends: [] } }), 'PRIVACY_HOSTED_WITHOUT_NET').map((i) => i.path)).toEqual(['/privacy/hosted'])
    const net = as('datasource', { tos: { commercial: true, redistribute: true, attribution: '' }, permissions: ['net.fetch'], net: { hosts: ['api.example.org'] } })
    expect(pick({ ...net, privacy: { hosted: true, sends: ['watchlist'] } }, 'PRIVACY_HOSTED_WITHOUT_NET')).toEqual([])
    expect(pick({ ...net, net: { hosts: [] }, privacy: { hosted: true, sends: [] } }, 'PRIVACY_HOSTED_WITHOUT_NET').length).toBe(1)
  })
})

describe('承诺用语', () => {
  // 中文词按字符拼接，避免源码里出现整词
  const wins = ['稳' + '赚', '跑' + '赢']
  it('findPromiseLanguage：中英命中返回原文片段，正常文案不命中', () => {
    for (const w of ['保证收益', '保本', '必胜', '躺赚', '零风险', '无风险', ...wins]) expect(findPromiseLanguage(`这个策略${w}哦`), w).toBe(w)
    expect(findPromiseLanguage('This is Guaranteed Profit!')).toBe('Guaranteed Profit')
    expect(findPromiseLanguage('guaranteed returns for all')).toBe('guaranteed returns')
    expect(findPromiseLanguage('a risk-free trade')).toBe('risk-free')
    expect(findPromiseLanguage('Risk Free')).toBe('Risk Free')
    expect(findPromiseLanguage("you can't lose")).toBe("can't lose")
    expect(findPromiseLanguage('cant lose')).toBe('cant lose')
    expect(findPromiseLanguage('a sure win')).toBe('sure win')
    expect(findPromiseLanguage('按 EMA 计算仓位大小，可能亏损。')).toBeNull()
    expect(findPromiseLanguage('Position sizing helper; past results do not predict returns.')).toBeNull()
    expect(PLUGIN_PROMISE_PATTERNS.every((re) => !re.global)).toBe(true)
  })
  it('PROMISE_LANGUAGE：扫 name / desc / tools[].desc / risk.* / evidence.notes，路径到字段', () => {
    const m = as('strategy', {
      name: '必胜助手', desc: 'risk-free sizing',
      tools: [tool(), tool({ name: 'b', desc: 'guaranteed profit calc' })],
      risk: { disclosure: '无风险。', worstCase: '躺赚', builderAttribution: 'off' },
      evidence: { claims: [], notes: 'sure win' },
    })
    expect(pick(m, 'PROMISE_LANGUAGE').map((i) => i.path)).toEqual(['/name', '/desc', '/tools/1/desc', '/risk/disclosure', '/risk/worstCase', '/evidence/notes'])
    expect(pick(m, 'PROMISE_LANGUAGE')[0]!.message).toBe('promise-like wording: "必胜"')
    expect(pick(base({ tools: [tool()] }), 'PROMISE_LANGUAGE')).toEqual([])
  })
  it('否定词紧邻则放行；承诺本身仍命中', () => {
    for (const ok of ['不保证收益', '并非无风险', '这不是零风险的', '无法保证收益', '没有躺赚这回事'.replace('没有', '没'), 'not risk-free', 'no guaranteed returns', "it isn't risk-free", 'It is never sure win', 'without guaranteed profit', 'this is not  risk-free', '不' + wins[0]!]) {
      expect(findPromiseLanguage(ok), ok).toBeNull()
    }
    for (const hit of ['保证收益', '无风险', 'risk-free returns', 'guaranteed profit', '我们保证收益，但不保本', 'not risk-free but a sure win']) {
      expect(findPromiseLanguage(hit), hit).not.toBeNull()
    }
    expect(findPromiseLanguage('我们保证收益，但不保本')).toBe('保证收益')
    expect(pick(base({ desc: 'This is not risk-free.' }), 'PROMISE_LANGUAGE')).toEqual([])
    expect(pick(base({ desc: '本插件不保证收益，可能亏损。' }), 'PROMISE_LANGUAGE')).toEqual([])
  })
})

describe('checkPluginCompat', () => {
  const withCompat = (gitrader: string, pluginSchema = '1'): PluginManifest => base({ compat: { gitrader, pluginSchema } })
  it('全部满足 → 无问题', () => {
    expect(checkPluginCompat(withCompat('>=0.1.0 <0.2.0'), '0.1.9')).toEqual([])
    expect(checkPluginCompat(withCompat('*'), '9.9.9')).toEqual([])
  })
  it('COMPAT_SCHEMA_UNSUPPORTED：pluginSchema ≠ supportedSchema（默认 "1"）', () => {
    const r = checkPluginCompat(withCompat('*', '2'), '0.1.9')
    expect(r.map((i) => i.code)).toEqual(['COMPAT_SCHEMA_UNSUPPORTED'])
    expect(r[0]!.path).toBe('/compat/pluginSchema')
    expect(r[0]!.message).toContain('this kernel supports plugin schema "1"')
    expect(checkPluginCompat(withCompat('*', '2'), '0.1.9', '2')).toEqual([])
  })
  it('COMPAT_RANGE_INVALID：写不对的范围（不再重复报 UNSATISFIED）', () => {
    const r = checkPluginCompat(withCompat('latest'), '0.1.9')
    expect(r.map((i) => i.code)).toEqual(['COMPAT_RANGE_INVALID'])
    expect(r[0]!.path).toBe('/compat/gitrader')
  })
  it('COMPAT_GITRADER_UNSATISFIED：内核版本不在范围内', () => {
    const r = checkPluginCompat(withCompat('>=9.0.0'), '0.1.9')
    expect(r.map((i) => i.code)).toEqual(['COMPAT_GITRADER_UNSATISFIED'])
    expect(r[0]!.path).toBe('/compat/gitrader')
    expect(checkPluginCompat(withCompat('^0.1.0'), '0.2.0').map((i) => i.code)).toEqual(['COMPAT_GITRADER_UNSATISFIED'])
  })
  it('可同时报两条（schema 不支持 + 范围不满足）', () => {
    expect(checkPluginCompat(withCompat('>=9.0.0', '2'), '0.1.9').map((i) => i.code)).toEqual(['COMPAT_SCHEMA_UNSUPPORTED', 'COMPAT_GITRADER_UNSATISFIED'])
  })
})

/** 规范 §10.2 的坏清单。 */
function bad102(): PluginManifest {
  return {
    schema: 'gitrader-plugin/1', id: 'strategy.acme.moon', package: 'block', kind: 'strategy', name: '月球策略', desc: '保证收益，年化 300%。', tags: [], version: '1.0',
    vendor: { id: 'acme', name: 'Acme', kind: 'community', verified: true, url: null },
    source: { repo: 'acme/moon', commit: '0'.repeat(40), sha256: `sha256:${'0'.repeat(64)}`, fetchedAt: 1 },
    license: { spdx: 'MIT', redistribute: 'bundle', notice: '', commercialUse: true },
    runtime: { type: 'node', native: false, diskMB: 1 }, entry: { module: './index.mjs' }, install: { by: 'user-install', requireHashes: true },
    permissions: ['trade.live', 'withdraw'], privacy: { hosted: true, sends: ['positions'] }, provides: {},
    evidence: { claims: [{ metric: 'sharpe', value: '3.1', basis: 'backtest', window: { from: 1, to: 2 } }] },
    risk: { disclosure: '无风险。', worstCase: '无', builderAttribution: 'off' },
    fixtures: { offline: [], smoke: [] }, compat: { gitrader: '*', pluginSchema: '2' },
  } as unknown as PluginManifest
}

describe('旧行为与整体', () => {
  it('规范 §10.2 的坏清单：checkPluginManifest 的 message 保留既有文本', () => {
    const msgs = checkPluginManifest(bad102())
    const joined = msgs.join('\n')
    expect(joined).toContain('permission withdraw can never be granted')
    expect(joined).toContain('unsigned plugin must not request trade.live')
    expect(joined).toContain('kind strategy cannot request trade.live')
    expect(msgs).toEqual(checkPluginManifestIssues(bad102()).map((i) => i.message))
  })
  it('规范 §10.2 的坏清单：各码与路径', () => {
    const got = new Map(checkPluginManifestIssues(bad102()).map((i) => [i.code, i.path]))
    expect(got.get('PERMISSION_NEVER_GRANTABLE')).toBe('/permissions/1')
    expect(got.get('PERMISSION_KIND_MISMATCH')).toBe('/permissions/0')
    expect(got.get('UNSIGNED_FORBIDDEN_PERMISSION')).toBe('/permissions/0')
    expect(pick(bad102(), 'PROMISE_LANGUAGE').map((i) => i.path)).toEqual(['/desc', '/risk/disclosure'])
    expect(got.get('PRIVACY_HOSTED_WITHOUT_NET')).toBe('/privacy/hosted')
    expect(got.get('EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS')).toBe('/evidence/claims/0')
    expect(checkPluginCompat(bad102(), '0.1.9').map((i) => i.code)).toEqual(['COMPAT_SCHEMA_UNSUPPORTED'])
  })
  it('validatePluginManifest：schema 失败 → 无 code；语义失败 → 带 code 与精确 path', () => {
    const r = validatePluginManifest(bad102())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues.find((i) => i.path === '/version')?.code).toBeUndefined()
    }
    const ok = clone(contract('plugin-nautilus')) as PluginManifest
    ok.desc = 'risk-free engine'
    const r2 = validatePluginManifest(ok)
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.issues).toEqual([{ path: '/desc', message: 'promise-like wording: "risk-free"', keyword: 'semantic', code: 'PROMISE_LANGUAGE' }])
      expect(formatIssues(r2.issues)).toContain('/desc promise-like wording')
    }
  })
  it('schema：name ≤ 80、desc ≤ 400、tools 与 evidence 形状；未知字段仍放行', () => {
    const m = clone(contract('plugin-nautilus')) as PluginManifest
    expect(validatePluginManifest(m).ok).toBe(true)
    expect(validatePluginManifest({ ...m, name: 'x'.repeat(81) }).ok).toBe(false)
    expect(validatePluginManifest({ ...m, name: 'x'.repeat(80) }).ok).toBe(true)
    expect(validatePluginManifest({ ...m, desc: 'x'.repeat(401) }).ok).toBe(false)
    expect(validatePluginManifest({ ...m, 'x-vendor-extra': { a: 1 }, tools: [{ ...tool(), extra: 1 }] }).ok).toBe(true)
    expect(validatePluginManifest({ ...m, tools: [tool({ name: 'a.b' })] }).ok).toBe(false)
    expect(validatePluginManifest({ ...m, tools: [tool({ desc: 'x'.repeat(201) })] }).ok).toBe(false)
    expect(validatePluginManifest({ ...m, tools: [{ ...tool(), input: undefined }] }).ok).toBe(false)
    expect(validatePluginManifest({ ...m, tools: [tool({ permissions: ['nope' as never] })] }).ok).toBe(false)
    const strat = as('strategy', { risk: { disclosure: 'd', worstCase: 'w', builderAttribution: 'off' } })
    expect(validatePluginManifest({ ...strat, evidence: { claims: [] } }).ok).toBe(true)
    expect(validatePluginManifest({ ...strat, evidence: {} }).ok).toBe(false)
    expect(validatePluginManifest({ ...strat, evidence: { claims: [{ metric: 'm', value: 'abc', basis: 'backtest', window: { from: 1, to: 2 }, assumptions: ['x'] }] } }).ok).toBe(false)
    expect(validatePluginManifest({ ...strat, evidence: { claims: [{ metric: 'm', value: '1.5', basis: 'guess', window: { from: 1, to: 2 } }] } }).ok).toBe(false)
    expect(validatePluginManifest({ ...strat, evidence: { claims: [{ metric: 'm', value: '1.5', basis: 'live', window: { from: 1, to: 2 }, ref: 'r' }], notes: 'n' } }).ok).toBe(true)
  })
  it('夹具：模板示例 ema-reading 与契约 nautilus 经语义检查无问题', () => {
    const ema = JSON.parse(readFileSync(join(PKG_ROOT, '..', 'plugin-template', 'example', 'ema-reading', 'gitrader-plugin.json'), 'utf8')) as PluginManifest
    expect(checkPluginManifestIssues(ema)).toEqual([])
    expect(checkPluginCompat(ema, PROTOCOL_PACKAGE_VERSION)).toEqual([])
    const naut = contract('plugin-nautilus') as PluginManifest
    expect(checkPluginManifestIssues(naut)).toEqual([])
    expect(validatePluginManifest(naut).ok).toBe(true)
  })
})

describe('compileSchema', () => {
  const objSchema = { type: 'object', properties: { equity: { type: 'string', pattern: '^\\d+$' }, n: { type: 'integer', minimum: 1 } }, required: ['equity'] }
  it('合法 schema：通过 / 失败带 path 与 message', () => {
    const v = compileSchema(objSchema)
    expect(v({ equity: '100', n: 2 })).toEqual({ ok: true, value: { equity: '100', n: 2 } })
    const miss = v({})
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.issues[0]).toMatchObject({ path: '/', keyword: 'required', message: expect.stringContaining('equity') })
    const wrong = v({ equity: '100', n: 0 })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.issues.map((i) => i.path)).toEqual(['/n'])
    const many = v({ equity: 'x', n: 'y' })
    if (!many.ok) expect(many.issues.map((i) => i.path).sort()).toEqual(['/equity', '/n'])
  })
  it('未知关键字放行（strict:false）；相同 $id 可重复编译（独立实例）', () => {
    const s = { $id: 'urn:test:tool', type: 'object', 'x-note': 'free', properties: { a: { type: 'number' } } }
    expect(compileSchema(s)({ a: 1 }).ok).toBe(true)
    expect(compileSchema(s)({ a: 'no' }).ok).toBe(false)
  })
  it('format 可用（带 formats）', () => {
    const v = compileSchema({ type: 'object', properties: { when: { type: 'string', format: 'date-time' } } })
    expect(v({ when: '2026-10-13T00:00:00Z' }).ok).toBe(true)
    expect(v({ when: 'yesterday' }).ok).toBe(false)
  })
  it('非法 schema 抛错', () => {
    expect(() => compileSchema({ type: 'strnig' })).toThrow()
    expect(() => compileSchema({ type: 'object', required: 'equity' })).toThrow()
    expect(() => compileSchema({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' })).toThrow()
  })
  it('不污染内置注册表：内置 schema 校验照常', () => {
    compileSchema({ $id: 'urn:gitrader:schema:plugin:1', type: 'object' })
    expect(validatePluginManifest({}).ok).toBe(false)
  })
})

describe('审稿修复：$async', () => {
  it('compileSchema 拒绝 $async（根与任意层级），不拒绝普通 schema', () => {
    expect(() => compileSchema({ $async: true, type: 'object' })).toThrow('async schemas are not supported')
    expect(() => compileSchema({ type: 'object', properties: { a: { $async: true, type: 'string' } } })).toThrow('async schemas are not supported')
    expect(compileSchema({ type: 'object' })({}).ok).toBe(true)
  })
  it('清单里 output / input 写 $async → TOOL_SCHEMA_INVALID，validatePluginManifest 拒绝', () => {
    const out = base({ tools: [tool({ output: { $async: true, type: 'object', required: ['qty'] } })] })
    expect(pick(out, 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/output'])
    expect(pick(out, 'TOOL_SCHEMA_INVALID')[0]!.message).toContain('async schemas are not supported')
    expect(validatePluginManifest(out).ok).toBe(false)
    expect(pick(base({ tools: [tool({ input: { $async: true, type: 'object' } })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/input'])
  })
})

describe('审稿修复：pattern 回溯风险', () => {
  it('patternRisk：嵌套量词 / 过长 / 回溯引用拒绝；常见写法放行', () => {
    for (const bad of ['^(a+)+$', '^(a*)*$', '(a|aa)+', '^(\\d+\\.?)+$', '((a+))+', '(?:a+)*', '(.*){2,}']) expect(patternRisk(bad), bad).toMatch(/^quantifier over a group that contains a quantifier or alternation .* \(e\.g\. \^\[a-z-\]\+\$ instead of /)
    expect(patternRisk('(a)\\1')).toBe('backreferences are not supported')
    expect(patternRisk('(?<x>a)\\k<x>')).toBe('backreferences are not supported')
    expect(patternRisk('a'.repeat(256))).toBeNull()
    expect(patternRisk('a'.repeat(257))).toBe('longer than 256 characters')
    const ok = ['^[0-9]+(\\.[0-9]+)?$', '(?:ab)+', '^[a-z][a-z0-9_]{0,63}$', '^(?:abc)$', '^(png|jpg)$', '(a+)?', '(a?)?', '[(+*)]+', '\\(a+\\)+', '^\\d{4}-\\d{2}-\\d{2}$', '(?=a+)b', '(?<n>ab)c+']
    for (const p of ok) expect(patternRisk(p), p).toBeNull()
  })
  it('findUnsafePatterns：pattern 与 patternProperties 的键，任意层级', () => {
    const s = { type: 'object', properties: { a: { type: 'array', items: { type: 'string', pattern: '^(a+)+$' } } }, patternProperties: { '(b*)*': { type: 'string' } } }
    expect(findUnsafePatterns(s).map((u) => u.pattern).sort()).toEqual(['(b*)*', '^(a+)+$'])
    expect(findUnsafePatterns({ type: 'object', properties: { pattern: { type: 'string' } } })).toEqual([])
  })
  it('清单检查：input / output 里的危险 pattern → TOOL_SCHEMA_INVALID；模板常用写法通过', () => {
    const evil = { type: 'object', properties: { x: { type: 'string', pattern: '^(a+)+$' } } }
    const a = pick(base({ tools: [tool({ input: evil })] }), 'TOOL_SCHEMA_INVALID')
    expect(a.map((i) => i.path)).toEqual(['/tools/0/input'])
    expect(a[0]!.message).toContain('pattern "^(a+)+$" is rejected: quantifier over a group that contains a quantifier or alternation can backtrack catastrophically; rewrite without nested quantifiers (e.g. ^[a-z-]+$ instead of ^[a-z]+(-[a-z]+)*$)')
    expect(pick(base({ tools: [tool({ output: evil })] }), 'TOOL_SCHEMA_INVALID').map((i) => i.path)).toEqual(['/tools/0/output'])
    expect(pick(base({ tools: [tool({ input: { type: 'object', patternProperties: { '(a|aa)+': {} } } })] }), 'TOOL_SCHEMA_INVALID').length).toBe(1)
    expect(pick(base({ tools: [tool({ input: { type: 'object', properties: { x: { type: 'string', pattern: 'a'.repeat(257) } } } })] }), 'TOOL_SCHEMA_INVALID')[0]!.message).toMatch(/is rejected: longer than 256 characters/)
    const good = { type: 'object', properties: { x: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' }, y: { type: 'string', pattern: '(?:ab)+' } } }
    expect(codes(base({ tools: [tool({ input: good })] }))).toEqual([])
  })
  it('整份 schema 序列化 > 64 KB → TOOL_SCHEMA_INVALID', () => {
    const big = { type: 'object', description: 'x'.repeat(64 * 1024 + 1) }
    const r = pick(base({ tools: [tool({ input: big })] }), 'TOOL_SCHEMA_INVALID')
    expect(r.map((i) => i.path)).toEqual(['/tools/0/input'])
    expect(r[0]!.message).toContain('larger than 64 KB')
    expect(pick(base({ tools: [tool({ input: { type: 'object', description: 'x'.repeat(60 * 1024) } })] }), 'TOOL_SCHEMA_INVALID')).toEqual([])
  })
})

describe('审稿修复：承诺用语归一化', () => {
  it('全角 / 字间空格 / 零宽 / 繁体 / 连字符变体 / cannot lose 全部命中，返回原文片段', () => {
    const hits: [string, string][] = [
      ['保 证 收 益', '保 证 收 益'], ['保證收益', '保證收益'], ['無風險', '無風險'], ['ｒｉｓｋ－ｆｒｅｅ', 'ｒｉｓｋ－ｆｒｅｅ'], ['risk–free', 'risk–free'],
      ['零​风险', '零​风险'], ['CANNOT LOSE', 'CANNOT LOSE'], ['you can not lose', 'can not lose'], ['we never lose', 'never lose'],
      ['risk‑free', 'risk‑free'], ['risk free', 'risk free'], ['risk  free', 'risk  free'], ['Ｒｉｓｋ Ｆｒｅｅ', 'Ｒｉｓｋ Ｆｒｅｅ'], ['無 風 險', '無 風 險'],
      ['零風險', '零風險'], ['﻿无‍风险', '无‍风险'], ['必勝', '必勝'], ['躺賺', '躺賺'], ['穩' + '賺', '穩' + '賺'], ['跑' + '贏', '跑' + '贏'],
      ['soft­hyphen risk-free', 'risk-free'],
    ]
    for (const [text, frag] of hits) expect(findPromiseLanguage(text), JSON.stringify(text)).toBe(frag)
  })
  it('否定放行在归一化文本上做；英文词界不被吞掉', () => {
    for (const ok of ['不保证收益', '並非無風險', '不 保 證 收 益', 'Not  Risk‑Free', 'NO GUARANTEED RETURNS']) expect(findPromiseLanguage(ok), ok).toBeNull()
    expect(findPromiseLanguage('ensure winners benefit')).toBeNull()
    expect(findPromiseLanguage('a risk - free trade')).toBe('risk - free')
    expect(findPromiseLanguage('a risk -free trade')).toBe('risk -free')
    expect(findPromiseLanguage('a risk- free trade')).toBe('risk- free')
    expect(findPromiseLanguage('you cannotlose')).toBe('cannotlose')
    expect(findPromiseLanguage('a surewin')).toBe('surewin')
    expect(findPromiseLanguage('我们 保 证 收 益')).toBe('保 证 收 益')
  })
  it('PROMISE_LANGUAGE 经归一化也能抓到清单字段', () => {
    expect(pick(base({ desc: '無風險套利' }), 'PROMISE_LANGUAGE').map((i) => i.path)).toEqual(['/desc'])
    expect(pick(base({ tools: [tool({ desc: 'you cannot lose' })] }), 'PROMISE_LANGUAGE').map((i) => i.path)).toEqual(['/tools/0/desc'])
  })
})
