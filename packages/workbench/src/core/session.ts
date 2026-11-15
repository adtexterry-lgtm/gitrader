// SPDX-License-Identifier: CPAL-1.0
// 鉴权引导：页面由内核服务时，服务端往 index.html 注入一枚一次性引导令牌（<meta name="gitrader-bootstrap">）；
// 页面加载时用它换会话令牌，会话令牌放内存 + 本标签页的 sessionStorage（关页即清；不进 localStorage / cookie / URL），弹出窗经 opener 取桥，不另换。
// TODO(protocol): 端点形状待 B 的 api/ 对齐。本客户端约定  POST /api/session {bootstrap} → {sessionToken, user, ws?}  失败 401 {error:{name:'AUTH_FAILED',message}}。

import { t } from '../ui/lib/i18n.js'
export interface Session { token: string; user: string; wsUrl: string }

export const SESSION_STORE_KEY = 'gitrader.session.v1'

// 存取的形参形状：只用到这三个方法。名字不对外导出——core/prefs.ts 也有一个 StorageLike，两边同名会让 src/index.ts 的 `export *` 报重名。
interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export class SessionError extends Error {
  constructor(message: string, readonly status: number, readonly problemName?: string) { super(message); this.name = 'SessionError' }
}

/** 从文档里读引导令牌，读完立刻从 DOM 抹掉（不让页面脚本 / 块再看到）。 */
export function takeBootstrap(doc: { querySelector(sel: string): { getAttribute(n: string): string | null; remove(): void } | null }): string | null {
  const el = doc.querySelector('meta[name="gitrader-bootstrap"]')
  if (!el) return null
  const v = el.getAttribute('content')
  el.remove()
  return v && v.trim() ? v.trim() : null
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export async function exchangeSession(fetchFn: FetchLike, origin: string, bootstrap: string): Promise<Session> {
  const res = await fetchFn(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap }) })
  const body = (await res.json().catch(() => ({}))) as { sessionToken?: string; user?: string; ws?: string; error?: { name?: string; message?: string } }
  if (!res.ok || !body.sessionToken) throw new SessionError(body.error?.message ?? t('会话换票失败（{0}）', res.status), res.status, body.error?.name)
  return { token: body.sessionToken, user: body.user ?? 'usr_local', wsUrl: wsUrlOf(origin, body.ws) }
}

type GetFetch = (url: string, init: { method: string; headers: Record<string, string>; cache?: 'no-store' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/**
 * 重连会话：引导令牌已作废 / 缺失时（刷新页面、直接打开地址）问内核要不要给新会话。
 * TODO(protocol)：`GET /api/session/relink` 由 B 在加，形状未定；这里接受两种回包：{sessionToken, user, ws?} 直接用；{bootstrap}（或 {launch}）再去换票。
 * 内核没有这个接口（404）、拒绝（401 / 403）、回包认不出，一律返回 null——调用方显示「会话已失效」卡，不猜。
 */
export async function relinkSession(fetchFn: GetFetch, postFetch: Parameters<typeof exchangeSession>[0], origin: string): Promise<Session | null> {
  let res: Awaited<ReturnType<GetFetch>>
  try { res = await fetchFn(`${origin}/api/session/relink`, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' }) } catch { return null }
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as { sessionToken?: string; user?: string; ws?: string; bootstrap?: string; launch?: string } | null
  if (!body) return null
  if (body.sessionToken) return { token: body.sessionToken, user: body.user ?? 'usr_local', wsUrl: wsUrlOf(origin, body.ws) }
  const b = body.bootstrap ?? body.launch
  if (!b) return null
  try { return await exchangeSession(postFetch, origin, b) } catch { return null }
}

/** 会话留在本标签页的 sessionStorage 里：刷新页面不掉登录，关页即清。store 为空或抛错时静默（会话仍在内存里）。 */
export function saveSession(store: StorageLike | null | undefined, s: Session): void {
  if (!store) return
  try { store.setItem(SESSION_STORE_KEY, JSON.stringify({ token: s.token, user: s.user, wsUrl: s.wsUrl })) } catch { /* 存储被禁用 / 超额：不写就不写，内存里的会话照常可用。 */ }
}

/** 读回上一次的会话；JSON 坏 / 字段不全就清掉并返回 null（不猜、不修）。 */
export function loadSession(store: StorageLike | null | undefined): Session | null {
  if (!store) return null
  let raw: string | null = null
  try { raw = store.getItem(SESSION_STORE_KEY) } catch { return null }
  if (!raw) return null
  let body: unknown = null
  try { body = JSON.parse(raw) } catch { clearSession(store); return null }
  if (!body || typeof body !== 'object') { clearSession(store); return null }
  const o = body as { token?: unknown; user?: unknown; wsUrl?: unknown }
  if (typeof o.token !== 'string' || !o.token || typeof o.user !== 'string' || typeof o.wsUrl !== 'string' || !o.wsUrl) { clearSession(store); return null }
  return { token: o.token, user: o.user, wsUrl: o.wsUrl }
}

export function clearSession(store: StorageLike | null | undefined): void {
  if (!store) return
  try { store.removeItem(SESSION_STORE_KEY) } catch { /* 存储被禁用：没有可清的。 */ }
}

function wsUrlOf(origin: string, path?: string): string {
  const u = new URL(origin)
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}${path ?? '/ui'}`
}
