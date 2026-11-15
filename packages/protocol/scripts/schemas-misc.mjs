// SPDX-License-Identifier: Apache-2.0
// 插件清单 gitrader-plugin/1（§3）、块清单 gitrader-block/1（§4.1）、工作区 gitrader-workspace/1（§4.4）的 JSON Schema 定义。
import { anyObj, arr, b, c, enm, i, konst, m, n, ne, obj, rec, s, when } from './lib.mjs'

const SEMVER = '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$'
const hostPattern = '^(\\*\\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'

export function miscSchemas(K) {
  const out = {}
  const add = (domain, name, schema) => { out[`${domain}:${name}`] = { domain, name, title: name, schema } }

  const vendor = obj({
    id: ne(), name: ne(), kind: enm(K.VENDOR_KINDS), verified: b(), url: { type: ['string', 'null'] },
  }, ['id', 'name', 'kind', 'verified'])

  const redistribute = enm(K.PLUGIN_REDISTRIBUTE)
  const sha = c('Sha256')
  const hasPerm = (p) => ({ properties: { permissions: { contains: { const: p } } }, required: ['permissions'] })
  const kindIn = (...kinds) => ({ properties: { kind: { enum: kinds.flat() } }, required: ['kind'] })

  add('plugin', 'PluginManifest', {
    ...obj({
      schema: konst(K.PLUGIN_SCHEMA),
      id: s({ pattern: '^[a-z0-9-]+(\\.[a-z0-9-]+){2,}$' }),
      package: enm(K.PLUGIN_PACKAGES), kind: enm(K.PLUGIN_KINDS), name: ne({ maxLength: 80 }), desc: ne({ maxLength: 400 }), tags: arr(s()),
      version: s({ pattern: SEMVER }), vendor,
      source: obj({ repo: ne(), commit: s({ pattern: '^[0-9a-f]{40}$' }), sha256: sha, fetchedAt: c('Ms'), inspiredBy: s() }, ['repo', 'commit', 'sha256', 'fetchedAt']),
      license: obj({
        spdx: ne(), redistribute, notice: s(), commercialUse: b(), attribution: s(), weightsLicense: s(),
        dependencies: arr(obj({ name: ne(), spdx: ne(), redistribute }, ['name', 'spdx', 'redistribute'])),
      }, ['spdx', 'redistribute', 'notice', 'commercialUse']),
      runtime: obj({
        type: enm(K.PLUGIN_RUNTIME_TYPES), node: s(), python: s({ pattern: '^\\d+\\.\\d+$' }), native: b(), diskMB: n({ minimum: 0 }),
        download: arr(obj({ name: ne(), source: ne(), sizeMB: n({ minimum: 0 }), sha256: sha, consent: konst('required') }, ['name', 'source', 'sizeMB', 'sha256', 'consent'])),
      }, ['type', 'native', 'diskMB']),
      entry: obj({
        module: s(), export: s(), element: s(), command: arr(s(), { minItems: 1 }), transport: enm(K.GEP_TRANSPORTS), url: s(),
      }),
      install: obj({ by: enm(K.PLUGIN_INSTALL_BY), detect: s(), lockfile: s(), requireHashes: konst(true) }, ['by', 'requireHashes']),
      permissions: arr(enm(K.PLUGIN_PERMISSIONS), { uniqueItems: true }),
      net: obj({ hosts: arr(s({ pattern: hostPattern })) }, ['hosts']),
      secrets: arr(s()), config: anyObj(),
      privacy: obj({ hosted: b(), sends: arr(enm('watchlist', 'positions', 'addresses', 'orders')) }, ['hosted', 'sends']),
      tos: obj({ commercial: b(), redistribute: b(), attribution: s() }, ['commercial', 'redistribute', 'attribution']),
      mcp: obj({
        transport: ne(), url: s(), command: arr(s()),
        tools: obj({ allow: arr(s()), deny: arr(s()) }, ['allow', 'deny']),
      }, ['transport', 'tools']),
      provides: anyObj(),
      tools: arr(obj({
        name: s({ pattern: K.PLUGIN_TOOL_NAME_RE.source }), desc: ne({ maxLength: 200 }), tags: arr(s()),
        input: anyObj(), output: anyObj(), permissions: arr(enm(K.PLUGIN_PERMISSIONS)),
      }, ['name', 'desc', 'tags', 'input'])),
      instances: obj({ multiple: b(), ordered: b(), max: i({ minimum: 1 }) }, ['multiple', 'ordered']),
      ui: obj({ blocks: arr({ oneOf: [anyObj(), s()] }) }, ['blocks']),
      engine: obj({
        gep: obj({ versions: arr(s(), { minItems: 1 }), transports: arr(enm(K.GEP_TRANSPORTS), { minItems: 1 }), modes: arr(enm('A', 'B'), { minItems: 1 }) }, ['versions', 'transports', 'modes']),
        launch: { $ref: 'urn:gitrader:schema:gep:0.1:EngineLaunch' },
      }, ['gep']),
      evidence: obj({
        claims: arr(obj({
          metric: ne(), value: c('Decimal'), basis: enm(K.EVIDENCE_BASES),
          window: obj({ from: c('Ms'), to: c('Ms') }, ['from', 'to']), ref: s(), assumptions: arr(s()),
        }, ['metric', 'value', 'basis', 'window'])),
        notes: s(),
      }, ['claims']),
      protector: obj({
        rules: arr({ anyOf: [m('Protector'), obj({ kind: { type: 'string', not: { enum: K.PROTECTOR_KINDS } } }, ['kind'])] }),
        pre: b(), budgetMs: n(),
      }),
      fixtures: obj({ offline: arr(s()), smoke: arr(s()) }, ['offline', 'smoke']),
      risk: obj({ disclosure: ne(), worstCase: ne(), builderAttribution: konst('off') }, ['disclosure', 'worstCase', 'builderAttribution']),
      requires: arr(obj({ kind: enm('plugin', 'pypi', 'npm', 'binary'), name: ne(), version: s({ pattern: SEMVER }), sha256: sha }, ['kind', 'name', 'version', 'sha256'])),
      compat: obj({ gitrader: ne(), gep: s(), pluginSchema: ne() }, ['gitrader', 'pluginSchema']),
      signature: obj({ alg: konst('ed25519'), keyId: ne(), digest: sha, sig: ne() }, ['alg', 'keyId', 'digest', 'sig']),
    }, ['schema', 'id', 'package', 'kind', 'name', 'desc', 'tags', 'version', 'vendor', 'source', 'license', 'runtime', 'install', 'permissions', 'privacy', 'provides', 'fixtures', 'compat']),
    allOf: [
      when(kindIn('engine'), { required: ['engine'] }),
      when(kindIn('datasource'), { required: ['tos'] }),
      when(kindIn('strategy', 'factor', 'decision-model'), { required: ['evidence'] }),
      when(kindIn('strategy', 'executor'), { required: ['risk'] }),
      when(hasPerm('net.fetch'), { required: ['net'] }),
      when({ properties: { runtime: { properties: { type: { enum: ['stdio-mcp', 'remote-mcp'] } }, required: ['type'] } }, required: ['runtime'] }, { required: ['mcp'] }),
    ],
  })

  // ---- 块 ------------------------------------------------------------------------------------
  const blockRef = '^block\\.[a-z0-9-]+\\.[a-z0-9-]+$'
  add('block', 'BlockManifest', {
    ...obj({
      schema: konst(K.BLOCK_SCHEMA), id: s({ pattern: blockRef }), name: ne(), version: s({ pattern: SEMVER }),
      vendor: obj({ name: ne(), url: { type: ['string', 'null'] } }, ['name']),
      license: ne(),
      entry: obj({ module: ne(), element: ne() }, ['module', 'element']),
      isolation: enm(K.BLOCK_ISOLATION),
      size: obj({ minW: i({ minimum: 1 }), minH: i({ minimum: 1 }), defaultW: i({ minimum: 1 }), defaultH: i({ minimum: 1 }), maxW: i({ minimum: 1 }), maxH: i({ minimum: 1 }) }, ['minW', 'minH', 'defaultW', 'defaultH']),
      inputs: obj({
        events: arr(obj({ topic: ne(), filter: anyObj(), maxHz: n({ exclusiveMinimum: 0 }) }, ['topic'])),
        queries: arr(s()),
      }),
      actions: arr(s()),
      permissions: arr(enm(K.BLOCK_PERMISSIONS), { uniqueItems: true }),
      linkGroups: arr(obj({ group: enm(K.LINK_GROUPS), mode: enm('read', 'readwrite') }, ['group', 'mode'])),
      pinned: b(),
      fixtures: arr(s(), { minItems: 1 }),
    }, ['schema', 'id', 'name', 'version', 'vendor', 'license', 'entry', 'isolation', 'size', 'permissions', 'fixtures']),
  })

  // ---- 工作区 ----------------------------------------------------------------------------------
  const blockAt = s({ pattern: '^block\\.[a-z0-9-]+\\.[a-z0-9-]+@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' })
  const link = obj({ symbol: c('InstrumentId'), account: c('AcctId'), timeRange: obj({ from: c('Ms'), to: c('Ms') }, ['from', 'to']), strategy: s(), experiment: s() })
  add('workspace', 'Workspace', obj({
    schema: konst(K.WORKSPACE_SCHEMA), id: ne(), name: ne(),
    grid: obj({ cols: i({ minimum: 1 }), rowHeight: i({ minimum: 1 }) }, ['cols', 'rowHeight']),
    channels: rec(link),
    items: arr(obj({
      instanceId: ne(), block: blockAt, x: i({ minimum: 0 }), y: i({ minimum: 0 }), w: i({ minimum: 1 }), h: i({ minimum: 1 }),
      channel: s(), stack: s(), active: b(), pinned: b(), config: anyObj(),
    }, ['instanceId', 'block', 'x', 'y', 'w', 'h', 'config'])),
    statusBar: obj({ block: blockAt, pinned: konst(true), takeover: arr(enm(K.TAKEOVER_LEVELS)) }, ['block', 'pinned', 'takeover']),
    popouts: arr(obj({ instanceId: ne() }, ['instanceId'])),
    savedBy: obj({ actor: ne(), at: c('Ms') }, ['actor', 'at']),
  }, ['schema', 'id', 'name', 'grid', 'channels', 'items', 'statusBar', 'popouts', 'savedBy']))

  return out
}
