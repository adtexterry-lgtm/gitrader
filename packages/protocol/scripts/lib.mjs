// SPDX-License-Identifier: Apache-2.0
// JSON Schema 的编写辅助：schemas/*.json 由 scripts/build-schemas.mjs 从这些定义生成（workflow.json 是契约 §5.9 原文，手工维护，不由生成器产出）。
// 约定：未知字段一律放行（契约 §2.9 / §7.1：实现必须忽略未知字段），只有契约明确写了必填 / 枚举 / 格式的地方才收紧。

export const BASE = 'urn:gitrader:schema:'
export const NS = {
  model: 'model:0.1',
  'risk-gate': 'risk-gate:1',
  agent: 'agent:0.1',
  gep: 'gep:0.1',
  plugin: 'plugin:1',
  block: 'block:1',
  workspace: 'workspace:1',
  ledger: 'ledger:1',
  ui: 'ui:0.1',
}
export const LAYER_COMMENT = (spec, version) => `SPDX-License-Identifier: Apache-2.0 | Spec: ${spec} | Version: ${version} | Status: draft`

/** 单实体规范（plugin / block / workspace / ledger）的 $id 不带名字。 */
export const SINGLE = new Set(['plugin', 'block', 'workspace', 'ledger', 'risk-gate'])
export const idOf = (domain, name) => (SINGLE.has(domain) ? `${BASE}${NS[domain]}` : `${BASE}${NS[domain]}:${name}`)

export const ref = (domain, name) => ({ $ref: idOf(domain, name) })
/** 引用 Common 里的 $defs。 */
export const c = (name) => ({ $ref: `${BASE}${NS.model}:Common#/$defs/${name}` })
export const m = (name) => ref('model', name)
export const a = (name) => ref('agent', name)

export const s = (extra = {}) => ({ type: 'string', ...extra })
export const ne = (extra = {}) => ({ type: 'string', minLength: 1, ...extra })
export const i = (extra = {}) => ({ type: 'integer', ...extra })
export const n = (extra = {}) => ({ type: 'number', ...extra })
export const b = (extra = {}) => ({ type: 'boolean', ...extra })
export const enm = (...values) => ({ enum: values.flat() })
export const konst = (value) => ({ const: value })
export const arr = (items, extra = {}) => ({ type: 'array', items, ...extra })
export const obj = (properties, required = [], extra = {}) => ({ type: 'object', properties, ...(required.length ? { required } : {}), ...extra })
export const rec = (valueSchema, extra = {}) => ({ type: 'object', additionalProperties: valueSchema, ...extra })
export const nullable = (schema) => ({ oneOf: [schema, { type: 'null' }] })
export const anyObj = () => ({ type: 'object' })
/** if / then 条件必填。 */
export const when = (ifSchema, thenSchema) => ({ if: ifSchema, then: thenSchema })
export const propIs = (prop, value) => ({ properties: { [prop]: Array.isArray(value) ? { enum: value } : { const: value } }, required: [prop] })
export const needs = (...props) => ({ required: props })
