// SPDX-License-Identifier: CPAL-1.0
// notify.send 处理函数：读 DISCORD_WEBHOOK_URL（内核注入的环境变量）→ 渲染通知 → 2000 字符分块 →
// 逐块 POST /webhooks/{id}/{token}?wait=true → 返回 B0 契约形状 {ok:true,ref} 或 {ok:false,reason,retryable}。
// 密钥只允许从 process.env 进：不打印、不回传、不进错误消息（错误先过 redactSecrets）。
import { MAX_CONTENT, chunkContent, renderNotice } from './format.mjs'
import { DEFAULT_TIMEOUT_MS, DiscordWebhookClient, parseWebhookUrl, redactSecrets } from './discord.mjs'

/** 内核按清单 secrets[] 注入的环境变量名。 */
export const URL_ENV = 'DISCORD_WEBHOOK_URL'
/** 离线冒烟 / 协议一致性套件用：置 1 时用内置假 fetch，不发任何网络请求。 */
export const FAKE_FETCH_ENV = 'GITRADER_PLUGIN_FAKE_FETCH'
/** 内置假 fetch 固定的 message id（确定性，测试与套件都断言它）。 */
export const FAKE_MESSAGE_ID = '4242'

/** 内置假响应：形状与官方 200 + message 对象一致，不联网。 */
export function fakeFetch() {
  return Promise.resolve(
    new Response(JSON.stringify({ id: FAKE_MESSAGE_ID, channel_id: '1', content: 'offline fixture', type: 0, webhook_id: '1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
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

function failure(reason, retryable, secret = '') {
  return { ok: false, reason: redactSecrets(reason, [secret]), retryable }
}

/** level 只接受 info / warn / critical；其它值按 info 处理（不改写正文）。 */
function normalizeLevel(level) {
  return level === 'warn' || level === 'critical' ? level : 'info'
}

/** Notice → Discord 文本。renderNotice 内部已转义，这里不再二次转义。 */
export function buildNoticeText(notice) {
  const fields = {
    title: typeof notice.title === 'string' ? notice.title : '',
    lines: Array.isArray(notice.lines) ? notice.lines.filter((line) => typeof line === 'string') : [],
    level: normalizeLevel(notice.level),
  }
  if (typeof notice.ts === 'number' && Number.isFinite(notice.ts)) fields.ts = notice.ts
  return renderNotice(fields)
}

/**
 * tool.call notify_send 的处理函数。
 * @param {{notice?: object, params?: object}} args 内核传入的 input
 * @param {{webhookUrl?: string, fetchImpl?: Function, clock?: () => number, sleep?: Function, timeoutMs?: number}} [deps] 测试用注入
 */
export async function handleNotifySend(args, deps = {}) {
  const url = deps.webhookUrl !== undefined ? deps.webhookUrl : (process.env[URL_ENV] ?? '')
  if (url === '') return { ok: false, retryable: false, reason: `环境变量 ${URL_ENV} 未设置：Discord 通道没有 webhook URL，未发送` }

  const rawParams = args && typeof args.params === 'object' && args.params !== null ? args.params : {}
  let apiOrigin
  if (rawParams.apiBase !== undefined) {
    const r = resolveApiBase(rawParams.apiBase, deps.allowInsecureLoopback === true)
    if (r.error) return failure(r.error, false, url)
    apiOrigin = r.origin
  }
  let target
  try {
    target = parseWebhookUrl(url, apiOrigin)
  } catch (error) {
    return failure(`webhook URL 不可用：${error && error.message ? error.message : '解析失败'}（未发送）`, false, url)
  }

  const notice = args && typeof args === 'object' ? args.notice : undefined
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return failure('notice 缺失：通知内容由内核给出，插件不改写', false, url)

  const params = args && typeof args.params === 'object' && args.params !== null ? args.params : {}
  const threadId = params.threadId
  if (threadId !== undefined && (typeof threadId !== 'string' || !/^\d{5,25}$/.test(threadId))) {
    return failure('params.threadId 必须是 snowflake 字符串（未发送）', false, url)
  }

  let text
  try {
    text = buildNoticeText(notice)
  } catch {
    return failure('notice 无法渲染', false, url)
  }
  if (chunkContent(text, MAX_CONTENT).length === 0) return failure('notice 没有可发送的文本', false, url)

  const client = new DiscordWebhookClient({
    url: target.url,
    apiOrigin,
    ...(idemOf(args) === undefined ? {} : { idempotencyKey: idemOf(args) }),
    fetchImpl: deps.fetchImpl ?? pickFetch(),
    clock: deps.clock,
    sleep: deps.sleep,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: 1,
  })

  const result = threadId === undefined ? await client.sendText(text) : await client.sendText(text, { threadId })
  if (result.ok) return result.ref === undefined ? { ok: true } : { ok: true, ref: result.ref }
  return { ok: false, retryable: result.retryable, reason: result.reason }
}
