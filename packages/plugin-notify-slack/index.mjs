// SPDX-License-Identifier: CPAL-1.0
// notify_send 处理函数：读 SLACK_WEBHOOK_URL（内核按清单 secrets[] 注入的环境变量）→ 渲染 mrkdwn 文本 →
// 一条 POST 发到 webhook → 返回 B0 契约形状 {ok:true} 或 {ok:false,reason,retryable}。
// 密钥（即 webhook URL）只允许从 process.env 进：不打印、不回传、不进错误消息（错误先过 redactWebhookUrl）。
// Slack 的频道由 webhook 决定，params 不参与发送；插件不改写通知正文（白名单由内核把关）。
import { renderNotice } from './format.mjs'
import { DEFAULT_TIMEOUT_MS, SlackClient, SlackError, redactWebhookUrl } from './slack.mjs'

/** 内核按清单 secrets[] 注入的环境变量名。 */
export const TOKEN_ENV = 'SLACK_WEBHOOK_URL'
/** 离线冒烟 / 协议一致性套件用：置 1 时用内置假 fetch，不发任何网络请求。 */
export const FAKE_FETCH_ENV = 'GITRADER_PLUGIN_FAKE_FETCH'
/** 内置假 fetch 的固定响应体（Slack 成功响应就是纯文本 ok）。 */
export const FAKE_RESPONSE_BODY = 'ok'

/** 内置假响应：形状与 Slack webhook 成功响应一致，不联网。 */
export function fakeFetch() {
  const headers = { get: () => null }
  return Promise.resolve({ ok: true, status: 200, headers, text: async () => FAKE_RESPONSE_BODY })
}


/** GQ-54：params.apiBase（自托管 / 离线测试）：https 任意主机；明文 http 只允许字面回环且仅在测试开关（deps.allowInsecureLoopback）下。只取 origin。 */
export function resolveApiBase(raw, allowInsecureLoopback = false) {
  let u
  try { u = new URL(typeof raw === 'string' ? raw.trim() : '') } catch { return { error: 'apiBase 不是合法 URL' } }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || u.pathname !== '/') return { error: 'apiBase 只能是 origin（不带路径、查询串、凭据）' }
  const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(loopback && allowInsecureLoopback === true)) return { error: 'apiBase 必须是 https（明文 http 回环仅测试开关下允许）' }
  return { origin: u.origin }
}

/** 内核通知出口把幂等键放在 params.idempotencyKey（B0 契约的入参形状不变，第三方插件不受影响）。 */
function idemOf(args) { const k = args?.params?.idempotencyKey; return typeof k === 'string' && k !== '' ? k.slice(0, 128) : undefined }

function pickFetch() {
  if (process.env[FAKE_FETCH_ENV] === '1') return fakeFetch
  return (...args) => fetch(...args)
}

function failure(reason, retryable, webhookUrl) {
  return { ok: false, reason: redactWebhookUrl(reason, webhookUrl), retryable }
}

/** Notice → Slack 文本。renderNotice 内部已转义，这里不再二次转义。 */
export function buildNoticeText(notice) {
  const fields = {
    title: typeof notice.title === 'string' ? notice.title : '',
    lines: Array.isArray(notice.lines) ? notice.lines.filter((line) => typeof line === 'string') : [],
    level: notice.level === 'warn' || notice.level === 'critical' ? notice.level : 'info',
  }
  if (typeof notice.ts === 'number' && Number.isFinite(notice.ts)) fields.ts = notice.ts
  return renderNotice(fields)
}

/**
 * tool.call notify_send 的处理函数。
 * @param {{notice?: object, params?: object}} args 内核传入的 input
 * @param {{webhookUrl?: string, fetchImpl?: Function, clock?: () => number, sleepImpl?: Function, timeoutMs?: number, allowInsecureLoopback?: boolean}} [deps] 测试用注入
 */
export async function handleNotifySend(args, deps = {}) {
  const webhookUrl = deps.webhookUrl !== undefined ? deps.webhookUrl : (process.env[TOKEN_ENV] ?? '')
  if (typeof webhookUrl !== 'string' || webhookUrl.trim() === '') {
    return failure(`环境变量 ${TOKEN_ENV} 未设置：Slack 通道没有 webhook，未发送`, false, '')
  }

  const notice = args && typeof args === 'object' ? args.notice : undefined
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return failure('notice 缺失：通知内容由内核给出，插件不改写', false, webhookUrl)

  // params 由内核原样传入；Slack 的目标（频道）在 webhook 里，params 不参与请求。
  // 只拒绝形状不对的 params，内容一律忽略——绝不把 params 里的自由文本拼进正文。
  const params = args.params
  if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
    return failure('params 必须是对象', false, webhookUrl)
  }

  // GQ-54：apiBase 只替换 webhook URL 的 origin（路径里的 T/B/X 仍来自环境变量），主机白名单收成这一个。
  let sendUrl = webhookUrl
  let allowedHosts
  if (params && params.apiBase !== undefined) {
    const r = resolveApiBase(params.apiBase, deps.allowInsecureLoopback === true)
    if (r.error) return failure(r.error, false, webhookUrl)
    try { sendUrl = `${r.origin}${new URL(webhookUrl.trim()).pathname}`; allowedHosts = [new URL(r.origin).hostname] } catch { return failure('webhook URL 不是合法 URL', false, webhookUrl) }
  }

  let text
  try {
    text = buildNoticeText(notice)
  } catch {
    return failure('notice 无法渲染', false, webhookUrl)
  }

  let client
  try {
    client = new SlackClient({
      webhookUrl: sendUrl,
      ...(allowedHosts === undefined ? {} : { allowedHosts }),
      ...(idemOf(args) === undefined ? {} : { idempotencyKey: idemOf(args) }),
      fetchImpl: deps.fetchImpl ?? pickFetch(),
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.sleepImpl === undefined ? {} : { sleepImpl: deps.sleepImpl }),
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      minIntervalMs: 0,
      maxRetries: 2,
      allowInsecureLoopback: deps.allowInsecureLoopback === true,
    })
  } catch (e) {
    const message = e instanceof SlackError ? e.message : 'webhook URL 不可用'
    return failure(message, false, webhookUrl)
  }

  try {
    await client.send(text)
    return { ok: true }
  } catch (e) {
    if (e instanceof SlackError) return failure(e.message, e.retryable, webhookUrl)
    return failure(e instanceof Error && e.message ? e.message : '发送失败', true, webhookUrl)
  }
}
