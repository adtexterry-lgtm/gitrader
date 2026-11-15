// SPDX-License-Identifier: CPAL-1.0
// 启动：偏好 → 注册表 → 引导令牌换会话 → 内核客户端。
// 最小检阅版：布局是固定的（core/presets.ts 的 fixedWorkspace），不读写内核里的工作区。首屏不等内核。
// 留口（未实现）：WorkspaceController + HostApi.workspace*（多工作区、拖拽布局、Agent 改布局提示）在 core/ 里已有纯逻辑与测试，等总会话通知再接。
import { HostApi } from '../core/host-api'
import { PrefsStore } from '../core/prefs'
import { fixedWorkspace } from '../core/presets'
import { SessionError, clearSession, exchangeSession, loadSession, relinkSession, saveSession, takeBootstrap } from '../core/session'
import { KernelClient, LinkHub } from '@gitrader/blocks-sdk'
import { createRegistry } from './registry.jsx'
import { createStandalone } from './standalone.js'
import { setPrefsStore } from '../ui/lib/layout.js'
import { t, applyHtmlLang, getLang } from '../ui/lib/i18n.js'

export function wsUrlFor(loc) {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ui`
}

// 存储被禁用（嵌入在第三方 iframe、隐私模式）时读 localStorage 本身就会抛：退回无存储，偏好只在内存里生效
const safeStorage = () => { try { return localStorage } catch (_e) { return undefined } }

/** 创建壳的运行时。不 await 内核：返回 { ..., ready }，ready 在会话换票 + WS 握手完成（或失败）后 resolve。 */
export function createRuntime({ doc = document, loc = location, storage = safeStorage(), fetchFn = fetch.bind(globalThis), relink = false, win = doc.defaultView ?? window } = {}) {
  const ui = new URLSearchParams(loc.search).get('ui') === 'r4' ? 'r4' : 'r5'
  const prefs = new PrefsStore(storage, new URLSearchParams(loc.search))
  setPrefsStore(prefs)
  applyHtmlLang()
  // 语言偏好变了（用户在设置里切换，或内核里存的偏好和本机缓存不一致）：重新加载页面，所有文案按新语言生成
  prefs.subscribe((p) => { if (p.lang && p.lang !== getLang()) { try { win.location.reload() } catch (_e) { /* 无 location：下次打开生效 */ } } })
  const { registry, firstParty } = createRegistry(ui)
  const hub = new LinkHub({ A: { symbol: 'hyperliquid:BTC' } })
  // 会话跨刷新留在本标签页的 sessionStorage（关页即清）：存储被禁用的上下文里取不到就是 null，一切照旧走内存。
  const store = (() => { try { return win.sessionStorage } catch { return null } })()
  const bootstrap = takeBootstrap(doc)
  const state = { session: null, error: null }
  if (ui === 'r5' && new URLSearchParams(loc.search).has('launch')) {
    try {
      const url = new URL(loc.href, loc.origin)
      url.searchParams.delete('launch')
      win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    } catch { /* A non-browser test location has no replaceable URL. */ }
  }
  const standalone = ui === 'r5' ? createStandalone({ win, getSession: () => state.session, getPayload: () => ({ route: win.location.hash, blockCfg: prefs.get().blockCfg }) }) : null
  if (standalone) doc.documentElement.setAttribute('data-mode', standalone.getSnapshot().mode)

  // 命令的进出（PIN 弹层等「带证明重发」落定才关、接管在跑时三入口禁用）用 SDK 的 onCommand / onSettled 观察，不再子类化客户端
  const kernel = new KernelClient({
    url: wsUrlFor(loc),
    getToken: () => (state.session ? state.session.token : Promise.reject(new SessionError(state.error ? state.error.message : t('没有引导令牌：请从 gitrader 打开本页'), 0))),
    clientName: 'workbench',
    reconnect: { minMs: 300, maxMs: 4000 },
  })
  const api = new HostApi(kernel)

  // 会话获取：引导令牌 → 换票（存下会话）；没有令牌 / 令牌已用 → 本标签页的 sessionStorage 恢复；
  // 都没有 → 问内核 relink；都不行 → 「会话已失效」卡（不猜、不重试）。
  // kind：session = 会话问题（引导 / relink / WS 鉴权）；network = 连不上内核。
  const ready = (async () => {
    try {
      let session = null
      let bootstrapError = null
      let restored = false
      const mode = standalone?.getSnapshot().mode
      const embedded = (() => { try { return win.top !== win.self } catch { return false } })()
      if (ui === 'r5' && mode === 'standalone') {
        session = await standalone.requestSession()
      } else if (bootstrap) {
        try { session = await exchangeSession(fetchFn, loc.origin, bootstrap) }
        catch (e) {
          if (!(ui === 'r5' && embedded)) {
            if (!(e instanceof SessionError) || e.status >= 500) throw e
          } else bootstrapError = e
        }
        // 换到的新会话顺手存下（下次刷新直接从 sessionStorage 恢复）；存不下不影响本次启动。
        // 只在本机顶层标签页存：被嵌入（第三方宿主的 iframe）或独立弹窗时令牌一律只放内存（S1 ⑥ 安全门：两个窗口的存储里都不许有令牌）。
        if (session && !embedded && mode !== 'standalone') try { saveSession(store, session) } catch (_e) { /* 存储被禁用 / 超额：只损失刷新后不掉登录。 */ }
      }
      if (!session && ui === 'r5' && embedded) session = await standalone.requestSession()
      // 刷新（一次性引导令牌已作废）：本标签页上一次换到的会话还在 sessionStorage 里，先用它连。
      if (!session && !embedded && mode !== 'standalone') {
        session = loadSession(store)
        restored = session !== null
      }
      if (!session && bootstrapError && (!(bootstrapError instanceof SessionError) || bootstrapError.status >= 500)) throw bootstrapError
      // 集成修补（H，v2）：内核的 /api/session/relink 按设计固定 404（会话只能由带 PIN 的 gitrader open 重新签发），
      // 去问它只会在控制台留一条 404。只在显式打开 relink（嵌入方另有约定时）才问。
      if (!session && relink === true && !(ui === 'r5' && (embedded || mode === 'standalone'))) session = await relinkSession(fetchFn, fetchFn, loc.origin)
      if (!session) throw new SessionError(t('会话已失效'), 401, 'AUTH_FAILED')
      state.session = session
      const initialPayload = standalone?.takeInitialPayload?.()
      if (initialPayload && typeof initialPayload === 'object') {
        if (typeof initialPayload.route === 'string' && initialPayload.route.startsWith('#/')) {
          try {
            const url = new URL(loc.href, loc.origin)
            url.hash = initialPayload.route
            win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`)
            win.dispatchEvent(new Event('hashchange'))
          } catch { /* A non-browser test location has no replaceable URL. */ }
        }
        const blockCfg = initialPayload.blockCfg
        if (blockCfg && typeof blockCfg === 'object' && !Array.isArray(blockCfg) && (Object.getPrototypeOf(blockCfg) === Object.prototype || Object.getPrototypeOf(blockCfg) === null)) prefs.set({ blockCfg })
      }
      try {
        await kernel.connect()
      } catch (e) {
        // 恢复来的会话已被内核判死（过期 / 已吊销）：清掉存储里的，别让下次刷新再拿它试；错误照原样抛给外层按会话失效处理。
        if (restored && (e instanceof SessionError || (e && e.problemName === 'AUTH_FAILED'))) clearSession(store)
        throw e
      }
      // r4 只在刷新恢复（服务端注入了顶条）时收起顶条；r4 正常启动的既有行为不变
      if (ui === 'r5' || restored) {
        try { doc.getElementById?.('gitrader-relink-hint')?.remove?.() } catch (_e) { /* Missing or detached DOM must not invalidate a connected runtime. */ }
      }
      // P1-14：界面偏好以数据目录里的内核库为准（换端口不丢）；老内核没有该接口时静默退回本机缓存
      void prefs.attachKernel?.(api)?.catch?.(() => undefined)
      standalone?.connected()
      return { online: true }
    } catch (e) {
      // 壳自己会画「会话已失效」卡（中文、带复制命令）；内核给不带壳的页面注入的英文顶条在这里收起，避免两条提示叠在一起
      try { globalThis.document?.getElementById('gitrader-relink-hint')?.remove() } catch (_e) { /* 无 DOM */ }
      state.error = e
      const isSession = e instanceof SessionError || (e && e.problemName === 'AUTH_FAILED')
      return { online: false, error: e, kind: isSession ? 'session' : 'network' }
    }
  })()

  return { prefs, registry, firstParty, hub, kernel, api, workspace: fixedWorkspace(), state, ready, ui, standalone }
}
