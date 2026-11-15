// SPDX-License-Identifier: CPAL-1.0
// notify.send 处理函数：读 TELEGRAM_BOT_TOKEN（内核注入的环境变量）→ 渲染 MarkdownV2 → 4096 分块 →
// 逐块 sendMessage → 返回 B0 契约形状 {ok:true,ref} 或 {ok:false,reason,retryable}。
// 密钥只允许从 process.env 进：不打印、不回传、不进错误消息（错误先过 redactSecrets）。
import { chunkMessage, renderNotice } from './format.mjs'
import { DEFAULT_TIMEOUT_MS, TelegramClient, TelegramError, redactSecrets } from './telegram.mjs'

/** 内核按清单 secrets[] 注入的环境变量名。 */
export const TOKEN_ENV = 'TELEGRAM_BOT_TOKEN'
/** 离线冒烟 / 协议一致性套件用：置 1 时用内置假 fetch，不发任何网络请求。 */
export const FAKE_FETCH_ENV = 'GITRADER_PLUGIN_FAKE_FETCH'
/** 内置假 fetch 固定的 message_id（确定性，测试与套件都断言它）。 */
export const FAKE_MESSAGE_ID = 4242

/** 内置假响应：形状与 Telegram sendMessage 成功响应一致，不联网。 */
export function fakeFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: FAKE_MESSAGE_ID } }),
  })
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

function failure(reason, retryable, token) {
  return { ok: false, reason: redactSecrets(reason, token), retryable }
}

/** level 只接受 info / warn / critical；其它值按 info 处理（不改写正文）。 */
function normalizeLevel(level) {
  return level === 'warn' || level === 'critical' ? level : 'info'
}

/** Notice → MarkdownV2 文本。renderNotice 内部已转义，这里不再二次转义。 */
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
 * tool.call notify.send 的处理函数。
 * @param {{notice?: object, params?: object}} args 内核传入的 input
 * @param {{token?: string, fetchImpl?: Function, clock?: () => number, timeoutMs?: number}} [deps] 测试用注入
 */
export async function handleNotifySend(args, deps = {}) {
  const token = deps.token !== undefined ? deps.token : (process.env[TOKEN_ENV] ?? '')
  if (token === '') return failure(`环境变量 ${TOKEN_ENV} 未设置：Telegram 通道没有令牌，未发送`, false, '')

  const notice = args && typeof args === 'object' ? args.notice : undefined
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return failure('notice 缺失：通知内容由内核给出，插件不改写', false, token)

  const params = args && typeof args.params === 'object' && args.params !== null ? args.params : {}
  const chatId = params.chatId
  if (chatId === undefined || chatId === null || String(chatId).trim() === '') {
    return failure('params.chatId 必填：没有聊天 id 无法发送', false, token)
  }
  if (typeof chatId !== 'string' && typeof chatId !== 'number') return failure('params.chatId 必须是字符串或数字', false, token)

  let baseUrl
  if (params.apiBase !== undefined) {
    const r = resolveApiBase(params.apiBase, deps.allowInsecureLoopback === true)
    if (r.error) return failure(r.error, false, token)
    baseUrl = r.origin
  }

  let text
  try {
    text = buildNoticeText(notice)
  } catch {
    return failure('notice 无法渲染', false, token)
  }
  if (chunkMessage(text, 4096).length === 0) return failure('notice 没有可发送的文本', false, token)

  const client = new TelegramClient({
    token,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(idemOf(args) === undefined ? {} : { idempotencyKey: idemOf(args) }),
    fetchImpl: deps.fetchImpl ?? pickFetch(),
    clock: deps.clock,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    minIntervalMs: 0,
    maxRetries: 2,
  })

  try {
    const { messageIds } = await client.sendMessage(chatId, text)
    const first = messageIds.find((id) => typeof id === 'number')
    return first === undefined ? { ok: true } : { ok: true, ref: String(first) }
  } catch (e) {
    if (e instanceof TelegramError) return failure(e.message, e.retryable, token)
    return failure(e && e.message ? e.message : '发送失败', true, token)
  }
}
