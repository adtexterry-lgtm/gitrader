// SPDX-License-Identifier: CPAL-1.0
// 官方测试网 / 模拟盘主机登记表（venues-testnet.json）的读取与校验。
//
// 为什么存在：批 8 的 HTX 事故里，api.hbdm.vip 被当成「测试网备用域名」写进脚本，没有任何官方文档出处，
// 一旦 维护者 导出密钥跑一次就直连实盘。所以测试网主机只认登记表：有官方文档出处的才登记，
// 找不到就登记成「无测试网」，脚本对着它必须报错不跑。
//
// 本模块是纯离线件：只读本目录的 JSON，不联网、不读环境变量、不发请求。
// 错误一律用 RegistryError（code 稳定，测试可断言），不做 I/O 之外的副作用。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 登记表的绝对路径（按模块位置解析，不依赖 cwd）。 */
export const REGISTRY_PATH = fileURLToPath(new URL('../venues-testnet.json', import.meta.url))

/** 允许的 kind。无测试网 = 该场所没有经官方文档确认的测试网，脚本必须拒绝。 */
export const KINDS = Object.freeze(['测试网', '模拟盘', '无测试网'])
export const NO_TESTNET = '无测试网'

/** 错误码（稳定字符串，测试与调用方都靠它分支）。 */
export const REGISTRY_ERROR = Object.freeze({
  NO_TESTNET: 'NO_TESTNET',
  NOT_REGISTERED: 'NOT_REGISTERED',
  UNREADABLE: 'UNREADABLE',
})

export class RegistryError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
    this.venue = extra.venue ?? null
    this.host = extra.host ?? null
  }
}

let cached = null

/** 读登记表（默认路径缓存一份；传自定义路径则每次重读，测试用）。 */
export function loadRegistry(path = REGISTRY_PATH) {
  if (path === REGISTRY_PATH && cached !== null) return cached
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new RegistryError(REGISTRY_ERROR.UNREADABLE, `登记表读不到：${path}（${error.message}）`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new RegistryError(REGISTRY_ERROR.UNREADABLE, `登记表不是合法 JSON：${path}（${error.message}）`)
  }
  if (path === REGISTRY_PATH) cached = parsed
  return parsed
}

/** 所有条目（形状不对就当空表，校验函数会把它报出来）。 */
export function registryEntries(registry = loadRegistry()) {
  return registry && Array.isArray(registry.entries) ? registry.entries : []
}

/** 某个场所的全部条目（含「无测试网」行）。 */
export function entriesFor(venue, registry = loadRegistry()) {
  return registryEntries(registry).filter((entry) => entry && entry.venue === venue)
}

/** 某个场所可连的主机（「无测试网」行不计入）。 */
export function hostsFor(venue, registry = loadRegistry()) {
  return entriesFor(venue, registry)
    .filter((entry) => entry.kind !== NO_TESTNET && typeof entry.host === 'string' && entry.host !== '')
    .map((entry) => entry.host)
}

/** 该场所有没有可连的测试网 / 模拟盘主机（HTX 为 false）。 */
export function hasTestnet(venue, registry = loadRegistry()) {
  return hostsFor(venue, registry).length > 0
}

/**
 * 按 venue + host 查条目；venue 省略（undefined / null）时只按 host 全表查。
 * @returns {object|null}
 */
export function lookupHost(venue, host, registry = loadRegistry()) {
  const target = String(host ?? '').toLowerCase()
  if (target === '') return null
  const rows = registryEntries(registry).filter((entry) => {
    if (!entry || typeof entry.host !== 'string') return false
    if (venue !== undefined && venue !== null && entry.venue !== venue) return false
    return entry.host.toLowerCase() === target
  })
  const usable = rows.filter((entry) => entry.kind !== NO_TESTNET)
  return usable[0] ?? null
}

/**
 * 主机必须在登记表内，否则抛 RegistryError：
 *   NO_TESTNET     —— 该场所被登记成「无测试网」（HTX）
 *   NOT_REGISTERED —— 表里没有这个主机（含各所实盘域名、来历不明的域名）
 * @returns {object} 命中的条目
 */
export function assertRegisteredHost(venue, host, registry = loadRegistry()) {
  const label = venue === undefined || venue === null ? '(未知场所)' : String(venue)
  const found = lookupHost(venue, host, registry)
  if (found) return found
  if (venue !== undefined && venue !== null && !hasTestnet(venue, registry)) {
    const rows = entriesFor(venue, registry)
    const reason = rows.length > 0 ? rows[0].note ?? '' : '登记表里没有这个场所'
    throw new RegistryError(
      REGISTRY_ERROR.NO_TESTNET,
      `${label} 没有测试网：登记表 venues-testnet.json 标记「${NO_TESTNET}」，${reason}`.trim(),
      { venue, host },
    )
  }
  const allowed = venue === undefined || venue === null ? [] : hostsFor(venue, registry)
  throw new RegistryError(
    REGISTRY_ERROR.NOT_REGISTERED,
    `${String(host ?? '')} 不在登记表 venues-testnet.json 里${allowed.length > 0 ? `（${label} 只有 ${allowed.join(' / ')}）` : ''}；测试网脚本不连表外主机`,
    { venue, host },
  )
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const VENUE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 结构校验（离线、纯函数）。返回 { ok, errors, checked }：
 *   - 根：verifiedAt 是 YYYY-MM-DD，entries 是非空数组；
 *   - 每条：venue 合法、kind ∈ KINDS、host 形状（无测试网必须为 null）、
 *           officialUrl 是 https 链接且其主机 ≠ 条目 host（文档页不能是 API 主机本身，防「拿主机冒充出处」）、
 *           officialMention 是布尔、verifiedAt 是 YYYY-MM-DD 且与根日期一致；
 *   - 全表：venue+host 不重复；同一场所只能有一行「无测试网」，且该场所不能再有可用主机。
 */
export function validateRegistry(registry = loadRegistry()) {
  const errors = []
  const checked = { entries: 0, venues: 0 }

  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return { ok: false, errors: ['登记表根节点必须是对象'], checked }
  }
  const rootVerifiedAt = registry.verifiedAt
  if (typeof rootVerifiedAt !== 'string' || !DATE_RE.test(rootVerifiedAt)) {
    errors.push(`root.verifiedAt 必须是 YYYY-MM-DD（当前 ${JSON.stringify(rootVerifiedAt)}）`)
  }
  const entries = registry.entries
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('root.entries 必须是非空数组')
    return { ok: false, errors, checked }
  }

  const seen = new Set()
  const venues = new Map()
  entries.forEach((entry, index) => {
    checked.entries += 1
    const at = `entries[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} 必须是对象`)
      return
    }
    const venue = entry.venue
    if (typeof venue !== 'string' || !VENUE_RE.test(venue)) {
      errors.push(`${at}.venue 不合法：${JSON.stringify(venue)}`)
    }
    const kind = entry.kind
    if (!KINDS.includes(kind)) {
      errors.push(`${at}.kind 必须是 ${KINDS.join(' / ')} 之一（当前 ${JSON.stringify(kind)}）`)
    }

    if (kind === NO_TESTNET) {
      if (entry.host !== null) errors.push(`${at}.host 在「无测试网」行必须是 null（当前 ${JSON.stringify(entry.host)}）`)
    } else if (typeof entry.host !== 'string' || !HOST_RE.test(entry.host.toLowerCase())) {
      errors.push(`${at}.host 不是合法主机名：${JSON.stringify(entry.host)}`)
    }

    const officialUrl = entry.officialUrl
    let urlHost = ''
    if (typeof officialUrl !== 'string' || officialUrl.trim() === '') {
      errors.push(`${at}.officialUrl 缺失`)
    } else {
      try {
        const url = new URL(officialUrl)
        if (url.protocol !== 'https:') errors.push(`${at}.officialUrl 必须是 https：${officialUrl}`)
        if (!url.hostname || url.hostname === '') errors.push(`${at}.officialUrl 缺少主机名：${officialUrl}`)
        urlHost = url.hostname.toLowerCase()
      } catch {
        errors.push(`${at}.officialUrl 不是合法 URL：${officialUrl}`)
      }
    }
    if (urlHost !== '' && typeof entry.host === 'string' && urlHost === entry.host.toLowerCase()) {
      // OKX 的文档就挂在交易主机 www.okx.com/docs-v5 下：同主机只允许带文档路径，指向 API 根路径的一律不认。
      let docsPath = ''
      try {
        docsPath = new URL(officialUrl).pathname
      } catch {
        docsPath = ''
      }
      if (!/(^|\/)(docs?|documentation|opendocs|api-docs?)[^/]*(\/|$)/i.test(docsPath)) {
        errors.push(`${at}.officialUrl 的主机与条目 host 相同（${entry.host}）且不是文档路径：出处必须是文档页，不是 API 主机本身`)
      }
    }

    if (typeof entry.officialMention !== 'boolean') {
      errors.push(`${at}.officialMention 必须是布尔（页面正文是否直接印出 host）`)
    }
    if (typeof entry.verifiedAt !== 'string' || !DATE_RE.test(entry.verifiedAt)) {
      errors.push(`${at}.verifiedAt 必须是 YYYY-MM-DD（当前 ${JSON.stringify(entry.verifiedAt)}）`)
    } else if (typeof rootVerifiedAt === 'string' && entry.verifiedAt !== rootVerifiedAt) {
      errors.push(`${at}.verifiedAt${entry.verifiedAt} 与 root.verifiedAt${rootVerifiedAt} 不一致`)
    }

    const key = `${venue}\u0000${entry.host}`
    if (typeof venue === 'string' && seen.has(key)) errors.push(`${at} 与前面的行重复：${venue} / ${String(entry.host)}`)
    seen.add(key)
    if (typeof venue === 'string') {
      const bucket = venues.get(venue) ?? { noTestnet: 0, usable: 0 }
      if (kind === NO_TESTNET) bucket.noTestnet += 1
      else bucket.usable += 1
      venues.set(venue, bucket)
    }
  })

  for (const [venue, bucket] of venues) {
    if (bucket.noTestnet > 1) errors.push(`${venue} 有 ${bucket.noTestnet} 行「无测试网」，只允许一行`)
    if (bucket.noTestnet > 0 && bucket.usable > 0) errors.push(`${venue} 同时登记了「无测试网」和可用主机，自相矛盾`)
  }
  checked.venues = venues.size

  return { ok: errors.length === 0, errors, checked }
}
