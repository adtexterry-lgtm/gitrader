// SPDX-License-Identifier: CPAL-1.0
import { useEffect, useRef, useState } from 'preact/hooks'

/** 订阅工作区控制器。 */
export function useWorkspace(controller) {
  const [ws, setWs] = useState(controller.get())
  useEffect(() => { setWs(controller.get()); return controller.subscribe(setWs) }, [controller])
  return ws
}

/** 内核连接状态（idle | connecting | open | reconnecting | closed）。 */
export function useKernelStatus(kernel) {
  const [s, setS] = useState(kernel.status)
  useEffect(() => { setS(kernel.status); return kernel.onStatus(setS) }, [kernel])
  return s
}

const OFFLINE_AFTER = 2000
const SYNC_MS = 1000

/**
 * 连接的界面态（IXD G5 / 流程 9）：offline = 断开时刻（曾经 open、现在不是 open 且持续 > 2 s 才算；首连中不算；closed 走会话失效卡），否则 0；
 * syncing = 刚从离线恢复的 1 s（块头小标「同步中」，订阅按 fromSeq 补发）。壳里只算一次，放进 ShellCtx。
 */
export function useConnection(kernel) {
  const status = useKernelStatus(kernel)
  const [offline, setOffline] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const c = useRef({ seen: false, down: 0, off: 0 }).current
  useEffect(() => {
    if (status === 'open') {
      c.seen = true
      c.down = 0
      if (!c.off) return undefined
      c.off = 0
      setOffline(0)
      setSyncing(true)
      const t = setTimeout(() => setSyncing(false), SYNC_MS)
      return () => { clearTimeout(t); setSyncing(false) }
    }
    if (!c.seen || status === 'closed') return undefined
    if (!c.down) c.down = Date.now()
    const t = setTimeout(() => { c.off = c.down; setOffline(c.down) }, Math.max(0, OFFLINE_AFTER - (Date.now() - c.down)))
    return () => clearTimeout(t)
  }, [status])
  return { status, offline, syncing }
}

/** 每 ms 毫秒刷新一次的当前时间（倒计时 / 计时小标用）；active=false 时不跑。 */
export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms, active])
  return now
}

/** 秒数 → mm:ss（等宽数字，计时 / 倒计时共用）。 */
export const mmss = (sec) => { const s = Math.max(0, Math.floor(sec)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') }

/**
 * 模态关闭后还焦点（IXD G6）：原元素还在且能聚焦就还给它；不在了落到它所在块的标题；再不行落到顶栏命令按钮——不让焦点掉到 body。
 * 原元素在别的对话框里（例如正在关的命令面板）不算数。
 */
export function restoreFocus(el, tile) {
  if (el && el.isConnected && el !== document.body && !el.closest('[role="dialog"]')) {
    el.focus()
    if (document.activeElement === el) return
  }
  const t = tile && tile.isConnected ? tile.querySelector('.gr-tile-p__sum, .gr-tile-p__title') : null
  const to = t || document.querySelector('[data-act="palette"]')
  if (to) to.focus()
}

/** hash 路由：#/ → workbench；支持 r5 页面、设置分组及弹出块。 */
export function parseRoute(hash, ui = 'r4') {
  if (ui === 'r4') {
    const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
    const id = parts[0] || 'workbench'
    return { id: ['workbench', 'settings', 'about', 'popout'].includes(id) ? id : 'workbench', param: parts[1] || '', parts }
  }
  let parts
  try { parts = String(hash || '').replace(/^#?\/?/, '').split('/').filter(Boolean).map(decodeURIComponent) }
  catch { return { id: 'workbench', param: '', parts: [] } }
  const raw = parts[0] || 'overview'
  const id = raw === 'overview' ? 'workbench' : raw
  if (raw === 'about') return { id: 'settings', param: 'about', parts: ['settings', 'about'], canonicalHash: '#/settings/about' }
  const allowed = ['workbench', 'chart', 'records', 'funds', 'plugins', 'strategies', 'lab', 'reconcile', 'settings', 'popout']
  if (!allowed.includes(id)) return { id: 'workbench', param: '', parts: [] }
  return { id, param: parts[1] || '', parts }
}

export function useRoute(ui = 'r4') {
  const read = () => {
    const route = parseRoute(location.hash, ui)
    if (route.canonicalHash && location.hash !== route.canonicalHash) history.replaceState(history.state, '', route.canonicalHash)
    return route
  }
  const [r, setR] = useState(read)
  useEffect(() => {
    const on = () => setR(read())
    window.addEventListener('hashchange', on)
    if (ui === 'r5') on()
    return () => window.removeEventListener('hashchange', on)
  }, [ui])
  return r
}

export const go = (id, param, ui = 'r4') => {
  if (ui === 'r5') {
    if (id === 'about') { location.hash = '#/settings/about'; return }
    location.hash = '#/' + (id === 'workbench' ? 'overview' : id) + (param !== undefined && param !== null && param !== '' ? '/' + encodeURIComponent(param) : '')
    return
  }
  location.hash = '#/' + (id === 'workbench' ? '' : id + (param ? '/' + encodeURIComponent(param) : ''))
}
