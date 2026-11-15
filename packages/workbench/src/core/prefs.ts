// SPDX-License-Identifier: CPAL-1.0
// 界面偏好：主题 / 密度 / 导航左右。只存本机浏览器（不是交易数据）；URL 参数（宿主指定）只在加载时生效、不写入记忆。
export type Theme = 'deep' | 'graphite'
export type Density = 'comfortable' | 'compact'
export type NavSide = 'left' | 'right'

export type NavForm = 'top' | 'rail'
export type Updown = 'intl' | 'cn'
/** 界面语言：只在用户选过之后才有这个键；没设过就按 navigator.language 判定（见 ui/lib/i18n.js）。 */
export type Lang = 'zh' | 'en'
export type BlockConfig = Record<string, object>
export interface Prefs { theme: Theme; density: Density; nav: NavSide; navForm: NavForm; updown: Updown; blockCfg: BlockConfig; lang?: Lang }
export const DEFAULT_PREFS: Prefs = { theme: 'deep', density: 'comfortable', nav: 'left', navForm: 'top', updown: 'intl', blockCfg: {} }

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** 内核侧的界面偏好通道（HostApi 的 getUiPrefs / setUiPrefs）。 */
export interface UiPrefsApi {
  getUiPrefs(): Promise<Record<string, unknown>>
  setUiPrefs(prefs: Record<string, unknown>): Promise<void>
}

const KEY = 'gitrader.prefs'
const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => ((ok as readonly unknown[]).includes(v) ? (v as T) : d)
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

function validBlockCfg(v: unknown): BlockConfig {
  if (!isPlainObject(v)) return {}
  return Object.fromEntries(Object.entries(v).filter(([, value]) => isPlainObject(value))) as BlockConfig
}

export function normalizePrefs(raw: unknown): Prefs {
  const o = isPlainObject(raw) ? raw : {}
  return {
    theme: pick(o.theme, ['deep', 'graphite'], DEFAULT_PREFS.theme),
    density: pick(o.density, ['comfortable', 'compact'], DEFAULT_PREFS.density),
    nav: pick(o.nav, ['left', 'right'], DEFAULT_PREFS.nav),
    navForm: pick(o.navForm, ['top', 'rail'], DEFAULT_PREFS.navForm),
    updown: pick(o.updown, ['intl', 'cn'], DEFAULT_PREFS.updown),
    blockCfg: validBlockCfg(o.blockCfg),
    ...(o.lang === 'zh' || o.lang === 'en' ? { lang: o.lang } : {}),
  }
}

/** 视口高 < 760 自动按紧凑密度（视觉规范 §3.2.4）。 */
export const effectiveDensity = (pref: Density, viewportH: number): Density => (pref === 'compact' || viewportH < 760 ? 'compact' : 'comfortable')

export class PrefsStore {
  private saved: Prefs
  private url: Partial<Prefs> = {}
  private state: Prefs
  private subs = new Set<(p: Prefs) => void>()
  private kernel?: UiPrefsApi
  constructor(private storage?: StorageLike, urlParams?: URLSearchParams) {
    let stored: unknown = {}
    try { stored = JSON.parse(storage?.getItem(KEY) ?? '{}') } catch { /* 无存储或坏数据：用默认 */ }
    this.saved = normalizePrefs(stored)
    if (urlParams?.has('nav')) this.url.nav = pick<NavSide>(urlParams.get('nav'), ['left', 'right'], this.saved.nav)
    if (urlParams?.has('density')) this.url.density = pick<Density>(urlParams.get('density'), ['compact', 'comfortable'], this.saved.density)
    this.state = { ...this.saved, ...this.url }
  }

  /** 当前生效值（URL 覆盖在上）。 */
  get(): Prefs { return this.state }

  /**
   * 连上内核后由调用方调用（boot.js）：先读内核偏好，内核值覆盖本机 localStorage 的值；此后每次 set 写穿到内核。
   * 内核不可用（老内核没有 ui.prefs.* → METHOD_NOT_FOUND）时退回只用 localStorage，不报错。
   */
  async attachKernel(api: UiPrefsApi): Promise<void> {
    let remote: unknown
    try { remote = await api.getUiPrefs() } catch { this.kernel = undefined; return }
    this.kernel = api
    // 内核里还没存过偏好（{}）：保留本机缓存，等用户下次 set 再写穿。
    if (!isPlainObject(remote) || Object.keys(remote).length === 0) return
    this.saved = normalizePrefs({ ...this.saved, ...remote })
    this.state = { ...this.saved, ...this.url }
    try { this.storage?.setItem(KEY, JSON.stringify(this.saved)) } catch { /* 无存储：只在内存里生效 */ }
    for (const f of this.subs) f(this.state)
  }

  /** 用户在界面里改：写入记忆，并且这一项不再被 URL 覆盖。 */
  set(patch: Partial<Prefs>): void {
    this.saved = normalizePrefs({ ...this.saved, ...patch })
    for (const k of Object.keys(patch) as Array<keyof Prefs>) delete this.url[k]
    this.state = { ...this.saved, ...this.url }
    try { this.storage?.setItem(KEY, JSON.stringify(this.saved)) } catch { /* 无存储：只在内存里生效 */ }
    void this.writeKernel()
    for (const f of this.subs) f(this.state)
  }

  /** 写穿到内核；失败静默（下次 set 再试）。没接内核（老内核 / 没连上）就只用 localStorage。 */
  private async writeKernel(): Promise<void> {
    const api = this.kernel
    if (!api) return
    try { await api.setUiPrefs({ ...this.saved } as Record<string, unknown>) } catch { /* 失败静默：下次 set 再试 */ }
  }

  /** 合并某个块实例的局部配置，并只写入一次偏好存储。 */
  setBlockConfig(instanceId: string, patch: object): void {
    if (!instanceId || !isPlainObject(patch)) return
    const current = this.saved.blockCfg[instanceId]
    const next = { ...(isPlainObject(current) ? current : {}), ...patch }
    this.set({ blockCfg: { ...this.saved.blockCfg, [instanceId]: next } })
  }

  subscribe(fn: (p: Prefs) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn) } }
}
