// SPDX-License-Identifier: CPAL-1.0
// notify_send 处理函数：读 WECOM_WEBHOOK_URL（内核按清单 secrets[] 注入的环境变量）→ 校验地址 →
// 按 notice 的事实字段渲染企业微信消息（不掺任何自由文本）→ 按 4096 / 2048 字节分块 → 逐条发送 →
// 返回 B0 契约形状 {ok:true} 或 {ok:false, reason, retryable}。
// 密钥只从 process.env 进：不打印、不回传、不进错误消息（错误先过 redactSecrets）。
import { renderNoticeMarkdown, renderNoticeText } from './format.mjs'
import { DEFAULT_TIMEOUT_MS, WeComClient, WeComConfigError, WeComError, parseWebhookUrl, redactSecrets } from './wecom.mjs'

/** 内核按清单 secrets[] 注入的环境变量名（群机器人 webhook 完整地址，含 key）。 */
export const WEBHOOK_ENV = 'WECOM_WEBHOOK_URL'
/** 离线冒烟 / 协议一致性套件用：置 1 时用内置假 fetch，不发任何网络请求。 */
export const FAKE_FETCH_ENV = 'GITRADER_PLUGIN_FAKE_FETCH'
/** 内置假响应的固定 errcode（官方成功码）。 */
export const FAKE_ERRCODE = 0

/**
 * 自由文本参数名：这些名字一旦出现在 params 里就是「想往通知正文塞文字」，一律拒绝而不是悄悄忽略，
 * 免得调用方以为塞进去了。通道只渲染内核给的 notice 事实字段。
 */
export const FREE_TEXT_PARAMS = ['content', 'text', 'body', 'footer', 'prefix', 'suffix', 'template', 'title', 'lines']

const FORBIDDEN = new Set(FREE_TEXT_PARAMS)

/** 内置假响应：形状与企业微信 webhook 成功响应一致（{"errcode":0,"errmsg":"ok"}），不联网。 */
export function fakeFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ errcode: FAKE_ERRCODE, errmsg: 'ok' }),
  })
}

function pickFetch() {
  if (process.env[FAKE_FETCH_ENV] === '1') return fakeFetch
  return (...args) => fetch(...args)
}

function failure(reason, retryable, secret) {
  return { ok: false, reason: redactSecrets(reason, secret), retryable }
}

/** notice → 渲染字段；只取白名单字段，其余（提案理由、备注、说明等）不读。 */
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

export function noticeFields(notice) {
  const fields = {
    title: typeof notice.title === 'string' ? notice.title : '',
    lines: Array.isArray(notice.lines) ? notice.lines.filter((line) => typeof line === 'string') : [],
    level: notice.level === 'warn' || notice.level === 'critical' ? notice.level : 'info',
  }
  if (typeof notice.ts === 'number' && Number.isFinite(notice.ts)) fields.ts = notice.ts
  return fields
}

/**
 * tool.call notify_send 的处理函数。
 * @param {{notice?: object, params?: object}} args 内核传入的 input
 * @param {{webhookUrl?: string, fetchImpl?: Function, clock?: () => number, timeoutMs?: number}} [deps] 测试注入
 */
export async function handleNotifySend(args, deps = {}) {
  const webhookUrl = deps.webhookUrl !== undefined ? deps.webhookUrl : (process.env[WEBHOOK_ENV] ?? '')
  if (typeof webhookUrl !== 'string' || webhookUrl.trim() === '') {
    return failure(`环境变量 ${WEBHOOK_ENV} 未设置：企业微信通道没有 webhook 地址，未发送`, false, '')
  }

  const rawParams = args && typeof args.params === 'object' && args.params !== null && !Array.isArray(args.params) ? args.params : {}
  let apiOrigin
  if (rawParams.apiBase !== undefined) {
    const r = resolveApiBase(rawParams.apiBase, deps.allowInsecureLoopback === true)
    if (r.error) return failure(r.error, false, '')
    apiOrigin = r.origin
  }
  let key
  try {
    key = parseWebhookUrl(webhookUrl, apiOrigin).key
  } catch {
    // 地址本身可能与 key 同体，错误消息只描述形状，不回显地址
    return failure(
      `环境变量 ${WEBHOOK_ENV} 不是合法的企业微信群机器人 webhook 地址（只接受 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）`,
      false,
      '',
    )
  }

  const notice = args && typeof args === 'object' ? args.notice : undefined
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) {
    return failure('notice 缺失：通知内容由内核给出，插件不改写', false, key)
  }

  const params = args && typeof args.params === 'object' && args.params !== null && !Array.isArray(args.params) ? args.params : {}
  for (const name of Object.keys(params)) {
    if (FORBIDDEN.has(name)) {
      return failure(`params.${name} 不收：通知正文只由内核给的 notice 事实字段渲染，通道不接收自由文本`, false, key)
    }
  }

  const fields = noticeFields(notice)
  const markdown = params.markdown !== false
  const text = markdown ? renderNoticeMarkdown(fields) : renderNoticeText(fields)
  if (text.trim() === '') return failure('notice 没有可发送的文本', false, key)

  const client = new WeComClient({
    webhookUrl,
    apiOrigin,
    ...(idemOf(args) === undefined ? {} : { idempotencyKey: idemOf(args) }),
    fetchImpl: deps.fetchImpl ?? pickFetch(),
    clock: deps.clock,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryDelayMs: deps.retryDelayMs,
    minIntervalMs: 0,
    maxRetries: 1,
  })

  try {
    await client.sendNotice(fields, { markdown })
    // 企业微信成功响应没有消息 id，B0 的 ref 是可选字段，这里不给
    return { ok: true }
  } catch (e) {
    if (e instanceof WeComError) return failure(e.message, e.retryable, key)
    if (e instanceof WeComConfigError) return failure(e.message, false, key)
    return failure(e && e.message ? e.message : '发送失败', true, key)
  }
}
