// SPDX-License-Identifier: Apache-2.0
import { normalizeForScan } from './manifest'

export const SECRET_SOLICIT_KEY_PHRASES = [
  'private key', 'privatekey', 'secret', 'secrets', 'mnemonic', 'seed phrase', 'seedphrase', 'seed words', 'recovery phrase',
  'passphrase', 'password', 'passwd', 'pwd', 'api secret', 'apisecret', 'api key', 'apikey', 'signing key', 'wallet key',
  'keystore', 'pin', 'pincode', 'pin code', 'access token', 'auth token', 'refresh token', 'bearer token', 'credential',
  'credentials', 'seed',
] as const

export const SECRET_SOLICIT_HANDLE_SUFFIXES = ['ref', 'id', 'handle', 'hash', 'fingerprint', 'digest', 'name'] as const

export const SECRET_SOLICIT_TEXT_PATTERNS = [
  'private key', 'secret key', 'seed phrase', 'recovery phrase', 'mnemonic', 'passphrase', 'password', 'api secret', 'api key',
  'signing key', 'wallet key', 'keystore', 'access token', 'auth token', 'bearer token', 'credentials',
  '私钥', '助记词', '种子短语', '种子词', '密码', '口令', '密钥', '通行短语', '凭证', 'pin码', 'pin 码',
] as const

export interface SecretSolicitation {
  path: string
  hit: string
  where: 'key' | 'text'
}

type Frame = {
  schema: unknown
  path: string
  propertyName?: string
  kind?: 'property' | 'required'
  requiredParent?: SchemaObject
  /** 所属对象 schema 自身的属性名（仅当它本身是 properties 的子项）。 */
  parent?: string
  exit?: boolean
}
type SchemaObject = Record<string, unknown>

const KEY_PHRASES = new Set(SECRET_SOLICIT_KEY_PHRASES.map((phrase) => phrase.replace(/\s+/g, '').toLowerCase()))
const MAX_KEY_PHRASE_LENGTH = Math.max(...[...KEY_PHRASES].map((phrase) => phrase.length))
const KEY_SUFFIXES = new Set<string>(SECRET_SOLICIT_HANDLE_SUFFIXES)
const TEXT_KEY_PHRASES = SECRET_SOLICIT_TEXT_PATTERNS.filter((phrase) => /[㐀-鿿]/u.test(phrase))
const CJK_CHARACTER = /[㐀-鿿]/u
const SKIPPED_SCHEMA_VALUES = new Set(['enum', 'const'])

function isSchemaObject(value: unknown): value is SchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pointerChild(path: string, segment: string): string {
  return `${path}/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

function normalizeBoundaries(value: string): string {
  return value.normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

function keyHit(key: string): boolean {
  const normalized = normalizeBoundaries(key)
  const words = normalized.split(/[\s_.:\-\p{N}]+/u).filter(Boolean).map((word) => word.toLowerCase())
  const last = words[words.length - 1]
  if (last !== undefined && (KEY_SUFFIXES.has(last) || (last.endsWith('s') && (KEY_SUFFIXES.has(last.slice(0, -1)) ||
    (last.endsWith('es') && KEY_SUFFIXES.has(last.slice(0, -2))))))) return false

  for (let start = 0; start < words.length; start++) {
    let joined = ''
    for (let index = start; index < words.length; index++) {
      const word = words[index]!
      if (joined.length + word.length > MAX_KEY_PHRASE_LENGTH + 1) break
      joined += word
      if (KEY_PHRASES.has(joined) || (joined.endsWith('s') && KEY_PHRASES.has(joined.slice(0, -1)))) return true
    }
  }

  if (CJK_CHARACTER.test(normalized)) {
    const normalizedText = normalizeForScan(normalized).s
    if (TEXT_KEY_PHRASES.some((phrase) => normalizedText.includes(phrase))) return true
  }
  return false
}

function textHit(value: string): string | null {
  const prepared = normalizeBoundaries(value).replace(/[-_]+/g, ' ')
  const normalized = normalizeForScan(prepared).s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const phrase of SECRET_SOLICIT_TEXT_PATTERNS) {
    if (/^[a-z ]+$/i.test(phrase)) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(normalized)) return phrase
    } else if (normalized.includes(phrase)) return phrase
  }
  return null
}

/** 遍历工具入参 JSON Schema，返回所有密钥索要位置。 */
export function findSecretSolicitation(schema: unknown, basePointer: string): SecretSolicitation[] {
  const hits: SecretSolicitation[] = []
  const active = new WeakSet<object>()
  const stack: Frame[] = [{ schema, path: basePointer }]

  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.exit) {
      if (frame.schema !== null && typeof frame.schema === 'object') active.delete(frame.schema)
      continue
    }

    const object = isSchemaObject(frame.schema) ? frame.schema : null
    const container = frame.schema !== null && typeof frame.schema === 'object' ? frame.schema : null
    if (container !== null && active.has(container)) continue
    // 与内核运行时一致：只放行 spec.seed（packages/kernel/src/api/errors.ts）。
    const propertySeedException = frame.propertyName === 'seed' && frame.kind === 'property' && frame.parent === 'spec' &&
      isSchemaObject(frame.schema) && (frame.schema['type'] === 'number' || frame.schema['type'] === 'integer')
    const requiredSeedException = frame.propertyName === 'seed' && frame.kind === 'required' && frame.parent === 'spec' &&
      frame.requiredParent !== undefined && isSchemaObject(frame.requiredParent['properties']) &&
      isSchemaObject(frame.requiredParent['properties']['seed']) &&
      (frame.requiredParent['properties']['seed']['type'] === 'number' || frame.requiredParent['properties']['seed']['type'] === 'integer')
    const propertyHit = frame.propertyName !== undefined && !propertySeedException && !requiredSeedException && keyHit(frame.propertyName)
    const title = object?.['title']
    const description = object?.['description']
    const titleHit = !propertyHit && typeof title === 'string' ? textHit(title) : null
    const descriptionHit = !propertyHit && titleHit === null && typeof description === 'string' ? textHit(description) : null
    if (propertyHit && frame.propertyName !== undefined) hits.push({ path: frame.path, hit: frame.propertyName, where: 'key' })
    else if (titleHit !== null) hits.push({ path: pointerChild(frame.path, 'title'), hit: titleHit, where: 'text' })
    else if (descriptionHit !== null) hits.push({ path: pointerChild(frame.path, 'description'), hit: descriptionHit, where: 'text' })

    if (container === null) continue
    active.add(container)
    stack.push({ ...frame, exit: true })

    const children: Frame[] = []
    const parent = frame.kind === 'property' && frame.propertyName !== undefined ? { parent: frame.propertyName } : {}
    const requiredFrames = (names: unknown[], path: string): Frame[] => names.map((requiredName, index) => ({
      schema: requiredName,
      path: pointerChild(path, String(index)),
      ...(typeof requiredName === 'string' ? { propertyName: requiredName, kind: 'required' as const, requiredParent: object!, ...parent } : {}),
    }))
    if (Array.isArray(frame.schema)) {
      frame.schema.forEach((child, index) => children.push({ schema: child, path: pointerChild(frame.path, String(index)) }))
    } else if (object !== null) {
      for (const [name, child] of Object.entries(object)) {
        const path = pointerChild(frame.path, name)
        if (name === 'properties' && isSchemaObject(child)) {
          for (const [propertyName, propertySchema] of Object.entries(child)) {
            children.push({ schema: propertySchema, path: pointerChild(path, propertyName), propertyName, kind: 'property', ...parent })
          }
          continue
        }
        if (name === 'patternProperties' || name === '$defs' || name === 'definitions' || name === 'dependentSchemas') {
          if (isSchemaObject(child)) {
            for (const [mappingName, mappedSchema] of Object.entries(child)) {
              children.push({ schema: mappedSchema, path: pointerChild(path, mappingName) })
            }
          } else children.push({ schema: child, path })
          continue
        }
        if (name === 'required' && Array.isArray(child)) {
          children.push(...requiredFrames(child, path))
          continue
        }
        if (name === 'dependentRequired' && isSchemaObject(child)) {
          for (const [mappingName, names] of Object.entries(child)) {
            const mappingPath = pointerChild(path, mappingName)
            if (Array.isArray(names)) children.push(...requiredFrames(names, mappingPath))
            else children.push({ schema: names, path: mappingPath })
          }
          continue
        }
        if (SKIPPED_SCHEMA_VALUES.has(name)) continue
        // default / examples：只跳过标量；对象或数组照常遍历，堵住 $ref 指向其中的绕过。
        if ((name === 'default' || name === 'examples') && (child === null || typeof child !== 'object')) continue
        children.push({ schema: child, path })
      }
    }

    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!)
  }

  return hits
}
