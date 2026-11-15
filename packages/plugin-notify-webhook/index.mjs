// SPDX-License-Identifier: CPAL-1.0
// notify.send 处理函数：读 params.url（必填）与密钥（params.secret 或环境变量），
// 按方言渲染一或多条请求；返回 B0 约定形状 `{ ok: true, ref? }` / `{ ok: false, reason, retryable }`。
// 密钥只从构造参数（deps.env）或环境变量进来，不进日志、不进返回值的 reason。
import { WebhookClient, detectWebhookDialect, redactSecret, renderNotice, scrubUrls } from './webhook.mjs'

/** 冒烟 / conformance 用的假响应：GITRADER_PLUGIN_FAKE_FETCH=1 时不出网。 */
export const FAKE_REF = 'fake-webhook-1'

const ENV_HANDLE = 'env:'
/** 清单 secrets[] 里声明的名字；`env:` 句柄只允许指向这些名字。 */
const DECLARED_SECRETS = new Set(['WEBHOOK_SECRET'])

/**
 * 解析密钥：params.secret 原样值、`env:<变量名>` 句柄，或清单声明的 WEBHOOK_SECRET。
 * 句柄名必须是清单里声明过的（目前只有 WEBHOOK_SECRET）；未声明的名字直接拒绝，
 * 不读也不打印变量值（尤其不能借句柄读到 GITRADER_GSP_TOKEN）。
 */
export function resolveSecret(params, env) {
  const raw = typeof params?.secret === 'string' ? params.secret.trim() : ''
  if (raw.startsWith(ENV_HANDLE)) {
    const name = raw.slice(ENV_HANDLE.length).trim()
    if (!DECLARED_SECRETS.has(name)) return { error: 'secret handle not declared' }
    const value = env?.[name]
    if (typeof value !== 'string' || value.trim() === '') return { error: `missing_env:${name}` }
    return { secret: value.trim() }
  }
  if (raw !== '') return { secret: raw }
  const fromEnv = env?.WEBHOOK_SECRET
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { secret: fromEnv.trim() }
  return {}
}

/** 通道文本：标题 + 正文行；markdown 只改排版，飞书 / 企微的富文本形态另做结构字符转义。 */
export function composeText(notice, markdown, dialect) {
  return renderNotice(notice, markdown === true, dialect)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 本机回环主机（照 plugin-notify-slack 的 LOOPBACK_HOSTS 口径）：明文 http 只放行发往这些字面主机。
 * 不做 DNS 解析，`localhost` 也不展开——只认 URL 里写的那串字面值。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * URL 分类：https，以及「明文 http 发往字面回环主机」（loopback，用户教程的 127.0.0.1 自测端点走这条）。
 * 其余明文 http 一律拒（L5-02）：正文与签名密钥会躺在链路上，钉钉方言的签名还会拼进 query。
 */
export function webhookUrlKind(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'invalid'
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol === 'https:') return parsed.hostname === '' ? 'invalid' : 'https'
    if (parsed.protocol === 'http:') return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ? 'loopback' : 'insecure'
    return 'invalid'
  } catch {
    return 'invalid'
  }
}

/** 是否是可用的 Webhook 目标（https，或明文 http 发往字面回环主机）。 */
export function isSecureWebhookUrl(value) {
  const kind = webhookUrlKind(value)
  return kind === 'https' || kind === 'loopback'
}

/**
 * 处理一条通知。deps 全部可注入：`{ fetch, env, now, sleep, timeoutMs, maxRetries }`，默认取进程环境。
 * 不抛异常：所有失败都返回 `{ ok: false, retryable }`，reason 短句、已脱敏。
 */
export async function notifySend(input, deps = {}) {
  const env = deps.env ?? process.env
  const notice = isRecord(input) ? input.notice : undefined
  const params = isRecord(input) && isRecord(input.params) ? input.params : {}

  if (!isRecord(notice) || typeof notice.title !== 'string' || !Array.isArray(notice.lines)) {
    return { ok: false, reason: 'invalid_notice', retryable: false }
  }
  const urlKind = webhookUrlKind(params.url)
  if (urlKind === 'insecure') return { ok: false, reason: 'insecure_url', retryable: false }
  if (urlKind === 'invalid') return { ok: false, reason: 'invalid_url', retryable: false }

  const resolved = resolveSecret(params, env)
  if (resolved.error !== undefined) return { ok: false, reason: resolved.error, retryable: false }
  const secret = resolved.secret

  if (String(env.GITRADER_PLUGIN_FAKE_FETCH ?? '') === '1') return { ok: true, ref: FAKE_REF }

  const markdown = params.markdown === true
  const text = composeText(notice, markdown, detectWebhookDialect(params.url.trim()))
  if (text.trim() === '') return { ok: false, reason: 'empty_notice', retryable: false }

  const client = new WebhookClient({
    url: params.url.trim(),
    ...(secret === undefined ? {} : { secret }),
    ...(typeof deps.fetch === 'function' ? { fetch: deps.fetch } : {}),
    ...(typeof deps.now === 'function' ? { clock: deps.now } : {}),
    ...(typeof deps.sleep === 'function' ? { sleep: deps.sleep } : {}),
    ...(Number.isFinite(deps.timeoutMs) ? { timeoutMs: deps.timeoutMs } : {}),
    ...(Number.isFinite(deps.maxRetries) ? { maxRetries: deps.maxRetries } : {}),
    markdown,
  })

  const result = await client.send(text, { markdown, title: notice.title, noticeKey: notice.key, ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}) })
  if (result.ok) return result.ref === undefined ? { ok: true } : { ok: true, ref: result.ref }
  // URL 的 query / 深层 path 本身是凭据：reason 里只留 origin + 路径第一段，整条 URL 也当密钥脱敏。
  const secrets = [params.url.trim(), ...(secret === undefined ? [] : [secret])]
  return {
    ok: false,
    reason: redactSecret(scrubUrls(result.reason), secrets),
    retryable: result.retryable === true,
  }
}

/** 方便调试：不发送，只看会发到哪个方言、正文长什么样（测试与 README 用）。 */
export function describeTarget(params) {
  const url = typeof params?.url === 'string' ? params.url.trim() : ''
  return { dialect: isSecureWebhookUrl(url) ? detectWebhookDialect(url) : 'invalid', valid: isSecureWebhookUrl(url) }
}
