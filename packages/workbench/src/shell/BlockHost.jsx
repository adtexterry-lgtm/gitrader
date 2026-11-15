// SPDX-License-Identifier: CPAL-1.0
// 块宿主：把一个工作区条目渲染成块。
//  - 一方 inline 块：Preact 组件，BridgeContext 提供宿主桥（清单约束在 createHostBridge 里强制）。
//  - 自定义元素块（清单 entry.element 已注册、没有组件）：创建元素并赋 bridge / config 属性。
//  - 第三方 iframe 块：sandbox="allow-scripts"（不给 allow-same-origin），postMessage 桥（attachWindowBridge）。
import { Component } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { attachWindowBridge, createHostBridge } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { Button } from '../ui/components/core.jsx'
import { EmptyState } from '../ui/components/core.jsx'
import { Icon } from '../ui/components/Icon.jsx'
import { useShell } from './ctx.js'
import { mmss, useNow } from './hooks.js'
import { t as tr, getLang } from '../ui/lib/i18n.js'

class Boundary extends Component {
  state = { err: null }
  componentDidCatch(err) { this.setState({ err }) }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }) }
  render() {
    if (this.state.err) {
      return (
        <EmptyState compact art="offline" title={tr('{0} 出错了', this.props.name)} desc={String(this.state.err && this.state.err.message ? this.state.err.message : this.state.err)}>
          <Button size="sm" onClick={() => this.setState({ err: null })}>{tr('重新加载')}</Button>
        </EmptyState>
      )
    }
    return this.props.children
  }
}

function ElementBlock({ def, props }) {
  const host = useRef(null)
  useEffect(() => {
    const el = document.createElement(def.manifest.entry.element)
    el.bridge = props.bridge
    el.instanceId = props.instanceId
    el.config = props.config
    el.setConfig = props.setConfig
    el.style.cssText = 'display:block;width:100%;height:100%'
    host.current.appendChild(el)
    return () => el.remove()
  }, [def, props.bridge, props.instanceId])
  return <div className="gr-blockhost__el" ref={host} />
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * srcdoc：极简页面 + 外链脚本，没有内联脚本（壳页面的 CSP 是 script-src 'self'，srcdoc 继承它）。
 * 块标识经 iframe 的 name 传入（gr-block:{json}），由同源的 /block-boot.js 在入口模块之前写成 window.__GITRADER_BLOCK__。
 * 第三方块不继承壳的 CSS（隔离），只拿到透明底 + 壳令牌里的字色与字体（--gr-text / --gr-font，块用 currentColor 跟随）。入口模块由内核的插件文件路由提供，必须带 CORS（sandbox 里源是 null）。
 */
function iframeDoc(def) {
  const base = location.origin
  const mod = new URL(def.remote.moduleUrl, base).href
  const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().replace(/[<>{}]/g, '')
  return `<!doctype html><html lang="${getLang() === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><style>html,body{margin:0;height:100%;background:transparent;color:${tok('--gr-text')};font:13px/1.3 ${tok('--gr-font')}}</style></head><body><div id="root"></div><script src="${esc(base)}/block-boot.js"></script><script type="module" src="${esc(mod)}"></script></body></html>`
}

/** 插件 5 s 内没发块桥握手（{gr:'ready'}）就判「没有响应」（IXD F10-2）：iframe 里的报错壳的错误边界接不到，只能看握手。 */
const HANDSHAKE_MS = 5000

function IframeBlock({ def, bridge, instanceId }) {
  const ref = useRef(null)
  const [gen, setGen] = useState(0) // 重新加载 = 换 key 重建 iframe
  const [late, setLate] = useState(false)
  const doc = useMemo(() => iframeDoc(def), [def])
  const name = useMemo(() => 'gr-block:' + JSON.stringify({ blockId: def.manifest.id, instanceId }), [def, instanceId])
  useEffect(() => {
    const win = ref.current && ref.current.contentWindow
    if (!win) return undefined
    const off = attachWindowBridge(win, bridge)
    let ok = false
    const onMsg = (e) => { if (e.source === win && e.data && e.data.gr === 'ready') { ok = true; setLate(false) } }
    window.addEventListener('message', onMsg)
    const t = setTimeout(() => { if (!ok) setLate(true) }, HANDSHAKE_MS)
    return () => { off(); window.removeEventListener('message', onMsg); clearTimeout(t) }
  }, [bridge, doc, gen])
  return (
    <>
      <iframe key={gen} ref={ref} className="gr-blockhost__frame" title={def.manifest.name} name={name} sandbox="allow-scripts" srcdoc={doc} />
      {late ? (
        <div className="gr-blockhost__late">
          <EmptyState compact art="offline" title={tr('插件没有响应')}>
            <Button size="sm" icon="refresh" data-act="plugin-reload" onClick={() => { setLate(false); setGen((n) => n + 1) }}>{tr('重新加载')}</Button>
          </EmptyState>
        </div>
      ) : null}
    </>
  )
}

/** 块头的陈旧小标（IXD 流程 9 · F9-2）：曾连上、断开 > 2 s 出「已暂停更新 · mm:ss」（从断开那一刻计时）；重连后「同步中」约 1 s 后消失。首连中不出。 */
export function StaleTag() {
  const sh = useShell()
  const now = useNow(1000, !!sh.offline)
  if (sh.offline) {
    return (
      <span className="gr-stale" data-stale="paused" title={tr('最后更新 {0}', new Date(sh.offline).toLocaleTimeString('zh-CN', { hour12: false }))}>
        <Icon name="clock" size={12} />{tr('已暂停更新 · ')}<span className="gr-num">{mmss((now - sh.offline) / 1000)}</span>
      </span>
    )
  }
  return sh.syncing ? <span className="gr-stale is-sync" data-stale="sync">{tr('同步中')}</span> : null
}

/**
 * item: 工作区条目；def: 注册表里的块定义（可能未安装）；grid: {w,h}；mode: tile | popout。
 * bridge 缺省按条目创建宿主桥；弹出窗页面传入自己的远程桥。
 */
export function BlockHost({ item, def, grid, mode = 'tile', bridge: given }) {
  const sh = useShell()
  const bridge = useMemo(() => {
    if (given) return given
    if (!def) return null
    return createHostBridge({ manifest: def.manifest, instanceId: item.instanceId, kernel: sh.kernel, hub: sh.hub, channel: item.channel || 'A', trusted: sh.firstParty.has(def.manifest.id) })
  }, [given, def, item.instanceId, item.channel, sh.kernel, sh.hub])

  const props = useMemo(() => bridge && ({
    bridge, instanceId: item.instanceId, config: item.config || {}, channel: item.channel || 'A', grid, mode,
    setConfig: (patch) => sh.setConfig(item.instanceId, patch),
  }), [bridge, item.instanceId, item.config, item.channel, grid && grid.w, grid && grid.h, mode])

  useEffect(() => {
    if (!def || !def.setup || !props) return undefined
    const off = def.setup(props)
    return typeof off === 'function' ? off : undefined
  }, [def, bridge, item.instanceId])

  if (!def) return <EmptyState compact art="no-data" title={tr('这个块没有安装')} desc={item.block} />
  const name = def.manifest.name
  let body
  if (def.manifest.isolation === 'iframe' || def.remote) body = def.remote ? <IframeBlock def={def} bridge={bridge} instanceId={item.instanceId} /> : <EmptyState compact art="offline" title={tr('{0} 缺少入口', name)} />
  else if (def.component) { const C = def.component; body = <C {...props} /> }
  else if (typeof customElements !== 'undefined' && customElements.get(def.manifest.entry.element)) body = <ElementBlock def={def} props={props} />
  else body = <EmptyState compact art="offline" title={tr('{0} 缺少入口', name)} />
  return (
    <BridgeContext.Provider value={bridge}>
      <Boundary name={name} resetKey={bridge}>{body}</Boundary>
    </BridgeContext.Provider>
  )
}
