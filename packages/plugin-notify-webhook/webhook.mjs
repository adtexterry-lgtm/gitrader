// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/kernel/src/notify/webhook.ts（内核库为准；那份又是 QuantDinger v5.6.5 的移植），
// 再对照 QuantDinger 补齐企业微信方言与 Markdown / 纯文本两种消息形态，加上重试、退避、脱敏。
// 与 packages/notify-webhook/src 对齐于 2026-10-21。
// 纯 JS，只用 Node 标准库；插件进程只读自己目录，因此这里不 import 仓库里的任何包。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** 方言 → 平台主机。generic 的主机来自用户配置（params.url），不在清单 net.hosts 里。 */
export const DIALECT_HOSTS = {
  feishu: 'open.feishu.cn',
  dingtalk: 'oapi.dingtalk.com',
  wecom: 'qyapi.weixin.qq.com',
  slack: 'hooks.slack.com',
  discord: 'discord.com',
}

export const WEBHOOK_DIALECTS = ['feishu', 'dingtalk', 'wecom', 'slack', 'discord', 'generic']

/** 各平台单条消息的字符上限（超过就分块，不是截断）。 */
export const DIALECT_TEXT_LIMITS = {
  feishu: 12000,
  dingtalk: 18000,
  wecom: 3800,
  slack: 3900,
  discord: 1900,
  generic: 32000,
}

/** 去重键请求头（R2-REL-03）：同一条通知的所有重试、以及内核重启后的补发，值完全相同，接收端据此去重。 */
export const NOTICE_KEY_HEADER = 'X-Gitrader-Notice-Key'

/** 通知键 → 请求头值：可见 ASCII（无空格）且不超过 200 字符就原样用；否则用它的 sha256（同一个键永远得到同一个值）。 */
export function noticeKeyValue(key, chunkIndex = 0) {
  if (typeof key !== 'string' || key === '') return undefined
  const plain = key.length <= 200 && [...key].every((ch) => ch.charCodeAt(0) > 32 && ch.charCodeAt(0) < 127)
  const base = plain ? key : createHash('sha256').update(key, 'utf8').digest('hex')
  return chunkIndex > 0 ? `${base}#${chunkIndex}` : base
}

const MASK = '<redacted>'
/** 单次工具调用的总预算（重试 + 退避合计）：内核给插件的调用预算 10 s，这里留 2 s 余量。 */
export const DEFAULT_BUDGET_MS = 8000

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:12-31; adapted.
// 与 packages/notify-webhook/src/dialect.ts 同规则：主机名精确匹配 + 路径前缀，避免相似域名误判。
const DIALECT_RULES = [
  ['feishu', ['open.feishu.cn', 'open.larksuite.com', 'open.larkoffice.com', 'www.larksuite.com'], '/open-apis/bot/v2/hook/'],
  ['dingtalk', ['oapi.dingtalk.com'], '/robot/send'],
  ['wecom', ['qyapi.weixin.qq.com'], '/cgi-bin/webhook/send'],
  ['slack', ['hooks.slack.com'], '/services/'],
  ['discord', ['discord.com', 'discordapp.com'], '/api/webhooks'],
]

/** 照 QD 的域名规则识别 Webhook 方言；主机必须精确匹配且路径前缀对得上，否则 generic（自建端点）。 */
export function detectWebhookDialect(url) {
  const lowered = String(url ?? '').toLowerCase()
  let parsed
  try {
    parsed = new URL(lowered)
  } catch {
    return 'generic'
  }
  for (const [dialect, hosts, prefix] of DIALECT_RULES) {
    if (hosts.includes(parsed.hostname) && parsed.pathname.startsWith(prefix)) return dialect
  }
  return 'generic'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:123-127; adapted.
/** 飞书 / Lark 自定义机器人签名：HMAC-SHA256(key = `${timestamp}\n${secret}`, message = 空) → base64。 */
export function signFeishu(secret, timestampSec) {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:130-137; adapted.
/** 钉钉自定义机器人签名：HMAC-SHA256(secret, `${timestamp}\n${secret}`) → base64 → URL 编码。 */
export function signDingtalk(secret, timestampMs) {
  const digest = createHmac('sha256', secret).update(`${timestampMs}\n${secret}`).digest('base64')
  return encodeURIComponent(digest)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:34-36; adapted.
function shorten(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`
}

/** 按平台上限分块；块与块之间不切开转义序列，只按字符切。 */
export function chunkText(text, limit) {
  const source = String(text ?? '')
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4000
  if (source.length <= size) return source.length > 0 ? [source] : []
  const out = []
  for (let i = 0; i < source.length; i += size) out.push(source.slice(i, i + size))
  return out
}

// 飞书 lark_md / 企业微信 markdown 不认反斜杠转义，只认结构字符：
// 把 `[ ] ( )` 与标签样式的 `<`、行首 `#` / `>` 换成全角同形字符，正文里的
// `[点我领空投](https://evil.example)` 就渲染不成链接（L5-14）。
export function escapeMarkdownStructure(text) {
  if (typeof text !== 'string') return ''
  // 逐行处理：行首 # / > 会变成标题或引用，先换掉；再逐字符处理链接与 HTML 标签的开头。
  return text
    .split('\n')
    .map((line) => {
      let head = line
      head = head.replace(/^#+/, (run) => '＃'.repeat(run.length)).replace(/^>+/, (run) => '＞'.repeat(run.length))
      let out = ''
      for (let i = 0; i < head.length; i++) {
        const ch = head[i]
        if (ch === '[') out += '［'
        else if (ch === ']') out += '］'
        else if (ch === '(') out += '（'
        else if (ch === ')') out += '）'
        // 只有标签样式的 `<`（后接字母或 /）才换掉：`1200 > 1000` 这类比较符保持原样。
        else if (ch === '<' && /[A-Za-z/]/.test(head[i + 1] ?? '')) out += '＜'
        else out += ch
      }
      return out
    })
    .join('\n')
}

/** 这些方言的富文本形态需要结构字符转义。 */
const STRUCTURE_SENSITIVE = new Set(['wecom', 'feishu'])

/**
 * 通知 → 平台文本：标题一行 + 正文行；markdown 形态只加排版前缀。
 * 传了 `dialect` 且属于飞书 / 企微时，标题与正文行先做结构字符转义（插件自己的模板前缀不转义）。
 */
export function renderNotice(notice, markdown = false, dialect) {
  const rawTitle = typeof notice?.title === 'string' ? notice.title.trim() : ''
  const rawLines = Array.isArray(notice?.lines) ? notice.lines.map((line) => String(line)) : []
  const escape = markdown === true && STRUCTURE_SENSITIVE.has(dialect)
  const title = escape ? escapeMarkdownStructure(rawTitle) : rawTitle
  const lines = escape ? rawLines.map((line) => escapeMarkdownStructure(line)) : rawLines
  if (lines.length === 0) return title
  return markdown ? `### ${title}\n\n${lines.join('\n\n')}` : `${title}\n${lines.join('\n')}`
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:105-120; adapted.
/**
 * 按方言构造请求体（markdown 形态照 QD 的 markdown / text 两套）；密钥只参与签名，不出现在返回值里。
 * 给了 opts.noticeKey 就在所有方言的请求头里带上 X-Gitrader-Notice-Key（去重键）。
 */
export function buildWebhookRequest(dialect, url, text, opts = {}) {
  const request = buildRequest(dialect, url, text, opts)
  const key = noticeKeyValue(opts.noticeKey, opts.chunkIndex)
  if (key !== undefined) request.headers[NOTICE_KEY_HEADER] = key
  // GQ-52：内核给的幂等键；多块消息每块带块序号，避免端点把第 2 块当重复丢掉。
  if (typeof opts.idempotencyKey === 'string' && opts.idempotencyKey !== '') request.headers['Idempotency-Key'] = `${opts.idempotencyKey.slice(0, 128)}${opts.chunkIndex ? ':' + opts.chunkIndex : ''}`
  return request
}

function buildRequest(dialect, url, text, opts) {
  const headers = { 'Content-Type': 'application/json' }
  const secret = typeof opts.secret === 'string' ? opts.secret.trim() : ''
  const markdown = opts.markdown === true
  const title = typeof opts.title === 'string' && opts.title.trim() !== '' ? opts.title.trim() : 'Gitrader'
  const nowMs = () => {
    const value = (opts.now ?? Date.now)()
    return Number.isFinite(value) ? Math.floor(value) : Date.now()
  }

  if (dialect === 'feishu') {
    // 飞书自定义机器人没有独立 markdown 类型，用消息卡片里的 markdown 元素承载（与库一致：div + lark_md）。
    const body = markdown
      ? { msg_type: 'interactive', card: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] } }
      : { msg_type: 'text', content: { text } }
    if (secret) {
      const timestampSec = Math.floor(nowMs() / 1000)
      body.timestamp = String(timestampSec)
      body.sign = signFeishu(secret, timestampSec)
    }
    return { url, body, headers }
  }

  if (dialect === 'dingtalk') {
    const body = markdown
      ? { msgtype: 'markdown', markdown: { title: shorten(title, 64), text } }
      : { msgtype: 'text', text: { content: text } }
    let postUrl = url
    if (secret) {
      const timestampMs = nowMs()
      const sign = signDingtalk(secret, timestampMs)
      const separator = postUrl.includes('?') ? '&' : '?'
      postUrl = `${postUrl}${separator}timestamp=${timestampMs}&sign=${sign}`
    }
    return { url: postUrl, body, headers }
  }

  if (dialect === 'wecom') {
    const body = markdown ? { msgtype: 'markdown', markdown: { content: text } } : { msgtype: 'text', text: { content: text } }
    return { url, body, headers }
  }

  if (dialect === 'slack') return { url, body: markdown ? { text, mrkdwn: true } : { text }, headers }
  if (dialect === 'discord') return { url, body: { content: text }, headers }
  return { url, body: { text }, headers }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:140-163; adapted.
/** 按方言校验厂商响应；408 / 429 / 5xx 标 retryable，其余失败不重试（避免把同一条通知重发到群里）。 */
export function validateWebhookResponse(dialect, status, body) {
  if (status === 408 || status === 429 || status >= 500) return { ok: false, reason: `http_${status}`, retryable: true }
  if (!(status >= 200 && status < 300)) return { ok: false, reason: `http_${status}`, retryable: false }
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { /* 非 JSON 文本按原字符串处理 */ }
  }

  if (dialect === 'slack') {
    if (typeof body === 'string') {
      const text = body.trim()
      if (text.toLowerCase() === 'ok' || text.startsWith('{')) return { ok: true }
      return { ok: false, reason: `slack_unexpected:${shorten(text, 300)}`, retryable: false }
    }
    const obj = asRecord(body)
    if (obj && obj.ok === false) return { ok: false, reason: `slack_error:${shorten(String(obj.error ?? 'unknown'), 200)}`, retryable: false }
    if (body !== null && typeof body === 'object') return { ok: true }
    return { ok: false, reason: 'slack_unexpected', retryable: false }
  }

  if (dialect === 'feishu' || dialect === 'dingtalk' || dialect === 'wecom') {
    const obj = asRecord(body)
    if (!obj) return { ok: true }
    const code = dialect === 'feishu'
      ? firstDefined(obj.code, obj.StatusCode)
      : firstDefined(obj.errcode, obj.code)
    if (code === undefined || code === null) return { ok: true }
    if (code === 0 || code === '0') return { ok: true }
    const message = firstDefined(obj.msg, obj.errmsg, obj.StatusMessage)
    const suffix = message === undefined || message === null ? '' : `:${shorten(String(message), 200)}`
    return { ok: false, reason: `${dialect}_error:code=${String(code)}${suffix}`, retryable: false }
  }

  return { ok: true }
}

/** Webhook URL 对外只保留 origin + 路径第一段；解析失败返回空串。 */
export function safeUrl(url) {
  try {
    const parsed = new URL(String(url ?? ''))
    const first = parsed.pathname.split('/').find((segment) => segment !== '')
    return first === undefined ? parsed.origin : `${parsed.origin}/${first}`
  } catch {
    return ''
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/gi

/** 把文本里出现的 URL 都收成 origin + 路径第一段（query 与深层 path 本身是凭据，一律去掉）。 */
export function scrubUrls(text) {
  return String(text ?? '').replace(URL_IN_TEXT, (match) => {
    const trimmed = match.replace(/[).,;:!?]+$/, '')
    const suffix = match.slice(trimmed.length)
    const safe = safeUrl(trimmed)
    return safe === '' ? match : `${safe}${suffix}`
  })
}

/** 把每个 secret 原文（以及它的 base64 形态）替换成 `<redacted>`；空串跳过。 */
export function redactSecret(s, secrets) {
  const list = typeof secrets === 'string' ? [secrets] : Array.isArray(secrets) ? secrets : []
  let out = String(s ?? '')
  for (const secret of list) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    out = out.split(secret).join(MASK)
    const encoded = Buffer.from(secret, 'utf8').toString('base64')
    if (encoded.length >= 4) out = out.split(encoded).join(MASK)
  }
  return out
}

/** 平台消息 id（有就带回去，没有不算失败）。 */
function extractRef(body) {
  const obj = asRecord(body)
  if (!obj) return undefined
  const data = asRecord(obj.data)
  const candidate = firstDefined(obj.message_id, obj.msgId, obj.msg_id, data?.message_id, data?.messageId)
  if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate)
  return undefined
}

/**
 * 本机回环主机（照 plugin-notify-slack 的 LOOPBACK_HOSTS 口径）：明文 http 只放行发往这些字面主机。
 * 不做 DNS 解析，`localhost` 也不展开——只认 URL 里写的那串字面值。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 明文 http 是否发往字面回环主机（构造期闸用）。 */
function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 带超时、重试与脱敏的 Webhook 客户端。fetch / clock / sleep 全部可注入（测试离线跑）。
 * 成功：`{ ok: true, status, ref? }`；失败：`{ ok: false, reason, retryable }`，reason 已脱敏。
 */
export class WebhookClient {
  #url
  #secret
  #fetch
  #timeoutMs
  #maxRetries
  #clock
  #sleep
  #markdown
  #budgetMs

  constructor(opts = {}) {
    this.#url = String(opts.url ?? '')
    // 明文 http 只放行字面回环主机（纵深防御；index.mjs 已在入口拒绝其余明文并给出 insecure_url 理由）。
    if (!/^https:\/\//i.test(this.#url) && !isLoopbackHttpUrl(this.#url)) {
      throw new Error('WebhookClient: url must use https (plaintext http is allowed only for loopback hosts)')
    }
    this.#secret = typeof opts.secret === 'string' ? opts.secret : ''
    this.#fetch = typeof opts.fetch === 'function' ? opts.fetch : globalThis.fetch
    this.#timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000
    this.#maxRetries = Number.isFinite(opts.maxRetries) ? Math.max(0, opts.maxRetries) : 2
    this.#clock = typeof opts.clock === 'function' ? opts.clock : Date.now
    // 默认退避带抖动（只往后加 0–20%：首次重试不早于 250 ms，且每次间隔严格递增）；注入 sleep 的测试看到的是确定的基准值。
    this.#sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms * (1 + Math.random() * 0.2)))
    this.#markdown = opts.markdown === true
    this.#budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? Math.floor(opts.budgetMs) : DEFAULT_BUDGET_MS
  }

  get dialect() { return detectWebhookDialect(this.#url) }

  /** 发送一段文本；内部按平台上限分块，逐块发。 */
  async send(text, opts = {}) {
    const dialect = this.dialect
    const limit = DIALECT_TEXT_LIMITS[dialect] ?? DIALECT_TEXT_LIMITS.generic
    const pieces = chunkText(text, limit)
    if (pieces.length === 0) return { ok: true, status: 200 }
    let last = { ok: true, status: 200 }
    for (let index = 0; index < pieces.length; index++) {
      last = await this.#sendPiece(dialect, pieces[index], opts, index)
      if (!last.ok) return last
    }
    return last
  }

  async #sendPiece(dialect, text, opts, chunkIndex = 0) {
    // 总预算：重试次数 + 退避等待合计不超过 #budgetMs，超出就按 timeout 收手。
    const startedAt = this.#clock()
    const remaining = () => this.#budgetMs - (this.#clock() - startedAt)
    const title = typeof opts.title === 'string' ? opts.title : undefined
    let attempt = 0
    let lastFailure = { ok: false, reason: 'not_attempted', retryable: false }
    while (attempt <= this.#maxRetries) {
      if (remaining() <= 0) return { ok: false, reason: 'timeout', retryable: true }
      const request = buildWebhookRequest(dialect, this.#url, text, {
        secret: this.#secret,
        markdown: opts.markdown === true || this.#markdown,
        now: this.#clock,
        ...(title === undefined ? {} : { title }),
        ...(typeof opts.noticeKey === 'string' ? { noticeKey: opts.noticeKey, chunkIndex } : {}),
        ...(typeof opts.idempotencyKey === 'string' ? { idempotencyKey: opts.idempotencyKey, chunkIndex } : {}),
      })
      const outcome = await this.#attempt(request, remaining())
      if (outcome.ok) return outcome
      lastFailure = outcome
      if (!outcome.retryable || attempt === this.#maxRetries) break
      const backoff = Math.min(250 * 2 ** attempt, 2000)
      if (backoff >= remaining()) return { ok: false, reason: 'timeout', retryable: true }
      await this.#sleep(backoff)
      attempt += 1
    }
    return { ok: false, reason: redactSecret(lastFailure.reason, [this.#secret, this.#url]), retryable: lastFailure.retryable }
  }

  async #attempt(request, budgetMs = this.#timeoutMs) {
    const controller = new AbortController()
    const attemptTimeoutMs = Math.max(1, Math.min(this.#timeoutMs, budgetMs))
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const response = await this.#fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      })
      const status = Number(response?.status ?? 0)
      const raw = typeof response?.text === 'function' ? await response.text() : ''
      const verdict = validateWebhookResponse(detectWebhookDialect(request.url), status, raw)
      if (!verdict.ok) return { ok: false, reason: verdict.reason ?? `http_${status}`, retryable: verdict.retryable === true }
      let parsed = raw
      try { parsed = JSON.parse(raw) } catch { /* 非 JSON 响应就不带 ref */ }
      const ref = extractRef(parsed)
      return ref === undefined ? { ok: true, status } : { ok: true, status, ref }
    } catch (error) {
      const name = error && typeof error === 'object' ? String(error.name ?? '') : ''
      const reason = name === 'AbortError' ? 'timeout' : `network_error:${shorten(scrubUrls(errorText(error)), 200)}`
      return { ok: false, reason, retryable: true }
    } finally {
      clearTimeout(timer)
    }
  }
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined) return value
  return undefined
}

/** 常量时间比较两个字符串（令牌 / 签名场景）；长度不同直接失败。 */
export function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
