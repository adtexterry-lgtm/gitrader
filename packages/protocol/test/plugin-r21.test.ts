// SPDX-License-Identifier: Apache-2.0
// 插件协议 r2.1：工具参数密钥索要扫描契约。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_ISSUE_CODES, checkPluginManifest, checkPluginManifestIssues,
  type PluginManifest, type PluginTool,
} from '../src'
import { findSecretSolicitation } from '../src/plugin/secret-solicit'

const CODE = 'TOOL_SOLICITS_SECRET'
const HEX64 = `sha256:${'a'.repeat(64)}`

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

function withInputs(inputs: unknown[], over: Partial<PluginManifest> = {}): PluginManifest {
  const tools = inputs.map((input, i) => ({ name: `probe_${i}`, desc: 'Probe.', tags: ['utility'], input })) as PluginTool[]
  return base({ tools, ...over })
}

function secretIssues(m: PluginManifest) {
  return checkPluginManifestIssues(m).filter((issue) => String(issue.code) === CODE)
}

function paths(m: PluginManifest): string[] {
  return secretIssues(m).map((issue) => issue.path)
}

describe('工具入参密钥索要扫描', () => {
  it('T1：顶层属性命中并指向属性名', () => {
    const m = withInputs([{ type: 'object', properties: { privateKey: { type: 'string' } } }])
    expect(secretIssues(m)).toEqual([{
      code: CODE,
      path: '/tools/0/input/properties/privateKey',
      message: 'tool probe_0: parameter "privateKey" asks for a secret; tool arguments must never carry keys, mnemonics, passwords or API secrets',
      hint: 'remove the parameter or reword the description; secrets stay in the kernel keystore and are never passed through tool arguments',
    }])
  })

  it('T2：嵌套属性命中', () => {
    const m = withInputs([{ type: 'object', properties: { wallet: { type: 'object', properties: { seed_phrase: { type: 'string' } } } } }])
    expect(paths(m)).toEqual(['/tools/0/input/properties/wallet/properties/seed_phrase'])
  })

  it('T3：items 对象与数组、prefixItems 都递归扫描', () => {
    const m = withInputs([
      { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { mnemonic: { type: 'string' } } } } } },
      { type: 'object', properties: { list: { type: 'array', items: [{ type: 'object', properties: { password: { type: 'string' } } }] } } },
      { type: 'object', properties: { list: { type: 'array', prefixItems: [{ type: 'object', properties: { passphrase: { type: 'string' } } }] } } },
    ])
    expect(paths(m)).toEqual([
      '/tools/0/input/properties/list/items/properties/mnemonic',
      '/tools/1/input/properties/list/items/0/properties/password',
      '/tools/2/input/properties/list/prefixItems/0/properties/passphrase',
    ])
  })

  it('T4：组合、条件、定义与依赖 schema 槽位都递归扫描', () => {
    const branches = [
      ['oneOf', [{ type: 'object', properties: { api_secret: { type: 'string' } } }]],
      ['anyOf', [{ type: 'object', properties: { privateKey: { type: 'string' } } }]],
      ['allOf', [{ type: 'object', properties: { password: { type: 'string' } } }]],
      ['not', { type: 'object', properties: { secret: { type: 'string' } } }],
      ['if', { type: 'object', properties: { apiKey: { type: 'string' } } }],
      ['then', { type: 'object', properties: { mnemonic: { type: 'string' } } }],
      ['else', { type: 'object', properties: { passphrase: { type: 'string' } } }],
      ['$defs', { input: { type: 'object', properties: { seedPhrase: { type: 'string' } } } }],
      ['definitions', { input: { type: 'object', properties: { pinCode: { type: 'string' } } } }],
      ['dependentSchemas', { choice: { type: 'object', properties: { credential: { type: 'string' } } } }],
    ] as const
    const inputs = branches.map(([slot, value]) => ({ type: 'object', [slot]: value }))
    const m = withInputs(inputs)
    expect(paths(m)).toEqual([
      '/tools/0/input/oneOf/0/properties/api_secret',
      '/tools/1/input/anyOf/0/properties/privateKey',
      '/tools/2/input/allOf/0/properties/password',
      '/tools/3/input/not/properties/secret',
      '/tools/4/input/if/properties/apiKey',
      '/tools/5/input/then/properties/mnemonic',
      '/tools/6/input/else/properties/passphrase',
      '/tools/7/input/$defs/input/properties/seedPhrase',
      '/tools/8/input/definitions/input/properties/pinCode',
      '/tools/9/input/dependentSchemas/choice/properties/credential',
    ])
  })

  it('T5：安全属性名的 description 命中并指向文本字段', () => {
    const m = withInputs([{ type: 'object', properties: { payload: { type: 'string', description: 'paste your wallet private key' } } }])
    expect(paths(m)).toEqual(['/tools/0/input/properties/payload/description'])
  })

  it('T6：中文、零宽字符和全角英文文本都命中', () => {
    const m = withInputs([
      { type: 'object', properties: { note: { type: 'string', description: '请输入助记词' } } },
      { type: 'object', properties: { note: { type: 'string', description: '请提交私\u200b钥' } } },
      { type: 'object', properties: { note: { type: 'string', description: 'ＰＲＩＶＡＴＥ　ＫＥＹ' } } },
    ])
    expect(paths(m)).toEqual([
      '/tools/0/input/properties/note/description',
      '/tools/1/input/properties/note/description',
      '/tools/2/input/properties/note/description',
    ])
  })

  it('T7：大小写和分隔变体均命中，包括 passWord', () => {
    const names = ['PrivateKey', 'PRIVATE_KEY', 'private-key', 'apiKey', 'ApiSecret', 'passWord', 'PIN']
    const properties = Object.fromEntries(names.map((name) => [name, { type: 'string' }]))
    expect(paths(withInputs([{ type: 'object', properties }]))).toEqual(names.map((name) => `/tools/0/input/properties/${name}`))
  })

  it('NFKC 归一化后全角键名命中', () => {
    const m = withInputs([{ type: 'object', properties: { 'ＡＰＩ＿ＫＥＹ': { type: 'string' } } }])
    expect(paths(m)).toEqual(['/tools/0/input/properties/ＡＰＩ＿ＫＥＹ'])
  })

  it('T8：句柄和普通 token、key 字段放行', () => {
    const names = ['publicKey', 'address', 'keyId', 'secretRef', 'apiKeyId', 'passwordHash', 'pinned', 'token', 'tokenSymbol', 'key']
    const properties = Object.fromEntries(names.map((name) => [name, { type: 'string' }]))
    expect(paths(withInputs([{ type: 'object', properties }]))).toEqual([])
  })

  it('T9：output 与清单 config 不扫描，enum/default/examples 值不扫描', () => {
    const m = base({
      config: { privateKey: 'ignored' } as never,
      tools: [{
        name: 'probe', desc: 'Probe.', tags: ['utility'],
        input: { type: 'object', properties: { choice: { type: 'string', enum: ['privateKey'], default: 'password', examples: ['mnemonic'] } } },
        output: { type: 'object', properties: { privateKey: { type: 'string' } } },
      } as never],
    })
    expect(paths(m)).toEqual([])
  })

  it('T10：问题码登记且旧字符串接口包含新增消息', () => {
    const m = withInputs([{ type: 'object', properties: { password: { type: 'string' } } }])
    expect(PLUGIN_ISSUE_CODES).toContain(CODE)
    expect(PLUGIN_ISSUE_CODES).toHaveLength(37)
    expect(checkPluginManifest(m).some((message) => message.includes('asks for a secret'))).toBe(true)
  })

  it('T11：同一节点按属性名、title、description 优先级只报一次；不同字段和子 schema 可分别报告', () => {
    const m = withInputs([{
      type: 'object', properties: {
        privateKey: { type: 'object', title: 'Password', description: 'API secret', properties: { mnemonic: { type: 'string' } } },
        safe: { type: 'string', title: 'Private key', description: 'Password' },
        note: { type: 'string', description: 'API secret' },
        nested: { type: 'object', properties: { mnemonic: { type: 'string' } } },
      },
    }])
    expect(paths(m)).toEqual([
      '/tools/0/input/properties/privateKey',
      '/tools/0/input/properties/privateKey/properties/mnemonic',
      '/tools/0/input/properties/safe/title',
      '/tools/0/input/properties/note/description',
      '/tools/0/input/properties/nested/properties/mnemonic',
    ])
  })

  it('T12：仓库位置计算模板清单不误报', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', 'plugin-template', 'example', 'position-size', 'gitrader-plugin.json'), 'utf8')) as PluginManifest
    expect(secretIssues(fixture)).toEqual([])
  })

  it('patternProperties 正则键不扫描，但其子 schema 仍扫描', () => {
    const m = withInputs([{ type: 'object', patternProperties: { '^secret-[a-z]+$': { type: 'string', title: 'Mnemonic' } } }])
    expect(paths(m)).toEqual(['/tools/0/input/patternProperties/^secret-[a-z]+$/title'])
  })

  it('additionalProperties 对象子 schema 递归扫描', () => {
    const m = withInputs([{ type: 'object', additionalProperties: { type: 'object', properties: { password: { type: 'string' } } } }])
    expect(paths(m)).toEqual(['/tools/0/input/additionalProperties/properties/password'])
  })

  it('JSON Pointer 对属性名中的斜线和波浪线转义', () => {
    const m = withInputs([{ type: 'object', properties: { 'privateKey.a/b~c': { type: 'string' } } }])
    expect(paths(m)).toEqual(['/tools/0/input/properties/privateKey.a~1b~0c'])
  })

  it('句柄后缀只放行最后词元，说明文字按英文词界匹配且否定句仍命中', () => {
    const m = withInputs([
      { type: 'object', properties: { secretRef: { type: 'string' }, secretRefNote: { type: 'string' }, description: { type: 'string', title: 'The tokenSymbol is safe' } } },
      { type: 'object', properties: { value: { type: 'string', description: 'not a private key; do not paste it' } } },
      { type: 'object', properties: { value: { type: 'string', description: 'passwordless mnemonicish credentialss' } } },
      { type: 'object', properties: { value: { type: 'string', description: 'privatekeyholder is not a key phrase' } } },
    ])
    expect(paths(m)).toEqual([
      '/tools/0/input/properties/secretRefNote',
      '/tools/1/input/properties/value/description',
    ])
  })

  it('仅 spec.seed 且本地声明数值类型时在属性或 required 中放行', () => {
    const m = withInputs([
      { type: 'object', properties: { spec: { type: 'object', properties: { seed: { type: 'number' } } } } },
      { type: 'object', properties: { wallet: { type: 'object', properties: { seed: { type: 'integer' } } } } },
      { type: 'object', properties: { seed: { type: 'string' } } },
      { type: 'object', properties: { seed: {} } },
      { type: 'object', properties: { seed: { type: ['number', 'integer'] } } },
      { type: 'object', properties: { seedPhrase: { type: 'number' } } },
      { type: 'object', properties: { spec: { type: 'object', properties: { seed: { type: 'integer' } }, required: ['seed'] } } },
      { type: 'object', properties: { seed: { type: 'string' } }, required: ['seed'] },
      { type: 'object', required: ['seed'] },
      { type: 'object', properties: { mnemonic: { type: 'string' } }, required: ['mnemonic'] },
      { type: 'object', properties: { seed_words: { type: 'number' } } },
    ])
    expect(paths(m)).toEqual([
      '/tools/1/input/properties/wallet/properties/seed',
      '/tools/2/input/properties/seed',
      '/tools/3/input/properties/seed',
      '/tools/4/input/properties/seed',
      '/tools/5/input/properties/seedPhrase',
      '/tools/7/input/properties/seed',
      '/tools/7/input/required/0',
      '/tools/8/input/required/0',
      '/tools/9/input/properties/mnemonic',
      '/tools/9/input/required/0',
      '/tools/10/input/properties/seed_words',
    ])
  })

  it('数值 seed 与句柄字段仍扫描说明文字', () => {
    const m = withInputs([
      { type: 'object', properties: { spec: { type: 'object', properties: { seed: { type: 'number', description: 'provide a seed phrase' } } } } },
      { type: 'object', properties: { apiKeyHandle: { type: 'string', description: 'provide the API key handle' } } },
    ])
    expect(paths(m)).toEqual([
      '/tools/0/input/properties/spec/properties/seed/description',
      '/tools/1/input/properties/apiKeyHandle/description',
    ])
  })

  it('R2：完整键名词表逐项命中', () => {
    const names = [
      'private key', 'privatekey', 'secret', 'secrets', 'mnemonic', 'seed phrase', 'seedphrase', 'seed words', 'recovery phrase',
      'passphrase', 'password', 'passwd', 'pwd', 'api secret', 'apisecret', 'api key', 'apikey', 'signing key', 'wallet key',
      'keystore', 'pin', 'pincode', 'pin code', 'access token', 'auth token', 'refresh token', 'bearer token', 'credential',
      'credentials', 'seed', 'pass word',
    ]
    const properties = Object.fromEntries(names.map((name) => [name, { type: 'string' }]))
    expect(paths(withInputs([{ type: 'object', properties }]))).toEqual(names.map((name) => `/tools/0/input/properties/${name}`))
  })

  it('R2：七种最后词元后缀全部放行', () => {
    const names = ['secretRef', 'privateKeyId', 'apiKeyHandle', 'passwordHash', 'mnemonicFingerprint', 'seedDigest', 'walletKeyName']
    const properties = Object.fromEntries(names.map((name) => [name, { type: 'string' }]))
    expect(paths(withInputs([{ type: 'object', properties }]))).toEqual([])
  })

  it('R3：英文与中文说明词表逐项命中', () => {
    const phrases = [
      'private key', 'secret key', 'seed phrase', 'recovery phrase', 'mnemonic', 'passphrase', 'password', 'api secret', 'api key',
      'signing key', 'wallet key', 'keystore', 'access token', 'auth token', 'bearer token', 'credentials',
      '私钥', '助记词', '种子短语', '种子词', '密码', '口令', '密钥', '通行短语', '凭证', 'pin码', 'pin 码',
    ]
    const inputs = phrases.map((phrase) => ({ type: 'object', properties: { payload: { type: 'string', description: `provide ${phrase}` } } }))
    expect(paths(withInputs(inputs))).toEqual(phrases.map((_, index) => `/tools/${index}/input/properties/payload/description`))
  })

  it('null、boolean、数组和畸形子节点安全返回', () => {
    for (const input of [null, true, [], { type: 'object', properties: null }, { type: 'object', items: [null, false] }]) {
      expect(() => secretIssues(withInputs([input]))).not.toThrow()
    }
  })

  it('共享 schema 对象在两个路径各自报告', () => {
    const shared = { type: 'string', title: 'Private key' }
    const m = withInputs([{ type: 'object', properties: { first: shared, second: shared } }])
    expect(paths(m)).toEqual([
      '/tools/0/input/properties/first/title',
      '/tools/0/input/properties/second/title',
    ])
  })

  it('扫描不修改输入对象', () => {
    const input = Object.freeze({ type: 'object', properties: Object.freeze({ password: Object.freeze({ type: 'string' }) }) })
    const before = JSON.stringify(input)
    secretIssues(withInputs([input]))
    expect(JSON.stringify(input)).toBe(before)
  })

  it('纯函数对循环 schema 安全，并扫描其敏感子属性', () => {
    const cycle: { type: string; properties: Record<string, unknown> } = { type: 'object', properties: {} }
    cycle.properties['self'] = cycle
    cycle.properties['mnemonic'] = true
    expect(findSecretSolicitation(cycle, '/tools/0/input')).toEqual([
      { path: '/tools/0/input/properties/mnemonic', hit: 'mnemonic', where: 'key' },
    ])
  })

  it('纯函数对 null、boolean 与数组 schema 安全返回空列表', () => {
    for (const schema of [null, true, false, []]) expect(findSecretSolicitation(schema, '/tools/0/input')).toEqual([])
  })

  it('纯函数返回键名与文本命中的完整结构', () => {
    expect(findSecretSolicitation({ type: 'object', properties: { privateKey: { type: 'string' } } }, '/tools/0/input')).toEqual([
      { path: '/tools/0/input/properties/privateKey', hit: 'privateKey', where: 'key' },
    ])
    expect(findSecretSolicitation({ type: 'object', properties: { payload: { type: 'string', description: 'paste private key' } } }, '/tools/0/input')).toEqual([
      { path: '/tools/0/input/properties/payload/description', hit: 'private key', where: 'text' },
    ])
  })

  it('R2-A：补齐键名变体、零宽字符和中文词项', () => {
    const names = [
      'passPhrase', 'pass_phrase', 'keyStore', 'privateKeys', 'mnemonics', 'passwords', 'apiKeys', 'privateKey1', 'mnemonic2',
      'private\u200bKey', '私钥', '助记词', '密码', 'private:key',
    ]
    const properties = Object.fromEntries(names.map((name) => [name, { type: 'string' }]))
    expect(paths(withInputs([{ type: 'object', properties }]))).toEqual(names.map((name) => `/tools/0/input/properties/${name}`))
  })

  it('R2-A：文本 camelCase、连字符、下划线与繁体变体均命中', () => {
    const phrases = ['private-key', 'private_key', 'privateKey', 'seed-phrase', 'API-KEY', '請輸入私鑰', '助記詞', '密碼', '憑證', '種子短語', '通行短語', '種子詞']
    const inputs = phrases.map((phrase) => ({ type: 'object', properties: { note: { type: 'string', description: phrase } } }))
    expect(paths(withInputs(inputs))).toEqual(phrases.map((_, index) => `/tools/${index}/input/properties/note/description`))
  })

  it('R2-A：required、contains、unevaluated 与未知关键字遍历，映射名不当作 schema 值跳过', () => {
    const m = withInputs([
      { type: 'object', required: ['mnemonic'] },
      { type: 'object', contains: { properties: { privateKey: { type: 'string' } } } },
      { type: 'object', unevaluatedProperties: { properties: { password: { type: 'string' } } } },
      { type: 'object', unevaluatedItems: { properties: { apiKey: { type: 'string' } } } },
      { type: 'object', $ref: '#/x-hidden', 'x-hidden': { properties: { privateKey: { type: 'string' } } } },
      { type: 'object', properties: { enum: { type: 'string', title: 'Private key' } } },
    ])
    expect(paths(m)).toEqual([
      '/tools/0/input/required/0',
      '/tools/1/input/contains/properties/privateKey',
      '/tools/2/input/unevaluatedProperties/properties/password',
      '/tools/3/input/unevaluatedItems/properties/apiKey',
      '/tools/4/input/x-hidden/properties/privateKey',
      '/tools/5/input/properties/enum/title',
    ])
  })

  it('R2-A：超长大写键名扫描低于 500ms', () => {
    const schema = { type: 'object', properties: { ['A'.repeat(64 * 1024)]: { type: 'string' } } }
    const started = performance.now()
    const hits = findSecretSolicitation(schema, '/tools/0/input')
    const elapsed = performance.now() - started
    expect(hits).toEqual([])
    expect(elapsed).toBeLessThan(500)
  })

  it('R2-B：spec.seed 为 number 放行', () => {
    expect(paths(withInputs([{ type: 'object', properties: { spec: { type: 'object', properties: { seed: { type: 'number' } } } } }]))).toEqual([])
  })

  it('R2-B：顶层 seed 为 number 命中', () => {
    expect(paths(withInputs([{ type: 'object', properties: { seed: { type: 'number' } } }]))).toEqual(['/tools/0/input/properties/seed'])
  })

  it('R2-B：$ref 指向 #/default 下的 privateKey 命中', () => {
    const input = { type: 'object', $ref: '#/default', default: { properties: { privateKey: { type: 'string' } } } }
    expect(paths(withInputs([input]))).toEqual(['/tools/0/input/default/properties/privateKey'])
  })

  it('R2-B：$ref 指向 #/examples/0 下的 mnemonic 命中', () => {
    const input = { type: 'object', $ref: '#/examples/0', examples: [{ properties: { mnemonic: { type: 'string' } } }] }
    expect(paths(withInputs([input]))).toEqual(['/tools/0/input/examples/0/properties/mnemonic'])
  })

  it('R2-B：复数句柄 apiKeyIds 放行', () => {
    expect(paths(withInputs([{ type: 'object', properties: { apiKeyIds: { type: 'array' } } }]))).toEqual([])
  })

  it('R2-B：dependentRequired 里的名字按键名判定', () => {
    expect(paths(withInputs([{ type: 'object', dependentRequired: { a: ['privateKey'] } }]))).toEqual(['/tools/0/input/dependentRequired/a/0'])
  })

  it('R2-A：超限 input 只报 schema-invalid，不运行密钥扫描', () => {
    const longProperty = 'x'.repeat(65 * 1024)
    const m = withInputs([{ type: 'object', properties: { privateKey: { type: 'string' }, [longProperty]: { type: 'string' } } }])
    const issues = checkPluginManifestIssues(m)
    expect(issues.some((issue) => String(issue.code) === 'TOOL_SCHEMA_INVALID')).toBe(true)
    expect(issues.some((issue) => String(issue.code) === CODE)).toBe(false)
  })
})
