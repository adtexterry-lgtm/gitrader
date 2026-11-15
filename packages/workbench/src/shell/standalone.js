// SPDX-License-Identifier: CPAL-1.0
const CHANNEL = 'gitrader-shell'
const CHILD_NAME = 'gitrader-standalone'
const HELLO_MS = 100
const HELLO_LIMIT_MS = 3000
const PING_MS = 1000
const PONG_LIMIT_MS = 500
const PEER_STALE_MS = 3 * PING_MS
const RELOAD_GRACE_MS = 1500

const randomId = (win) => {
  try { return win.crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
}
const originOf = (win) => { try { return win.location.origin } catch { return '' } }
const isChildSource = (source, win) => {
  try { return !!source && source.name === CHILD_NAME && source.opener === win } catch { return false }
}
const tokenOf = (session) => (typeof session === 'string' ? session : session && typeof session.token === 'string' ? session.token : '')
const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const cleanPayload = (payload) => {
  if (!isPlainObject(payload)) return null
  const clean = {}
  if (typeof payload.route === 'string') clean.route = payload.route
  if (isPlainObject(payload.blockCfg)) clean.blockCfg = payload.blockCfg
  return Object.keys(clean).length ? clean : null
}
const mergeRecoveredPayload = (parentPayload, localPayload) => {
  const merged = parentPayload ? { ...parentPayload } : {}
  if (typeof localPayload?.route === 'string' && localPayload.route.startsWith('#/')) merged.route = localPayload.route
  const parentCfg = isPlainObject(parentPayload?.blockCfg) ? parentPayload.blockCfg : {}
  const localCfg = isPlainObject(localPayload?.blockCfg) ? localPayload.blockCfg : {}
  const blockCfg = { ...parentCfg }
  for (const [instanceId, localConfig] of Object.entries(localCfg)) {
    if (!isPlainObject(localConfig)) continue
    const parentConfig = isPlainObject(blockCfg[instanceId]) ? blockCfg[instanceId] : {}
    blockCfg[instanceId] = { ...parentConfig, ...localConfig }
  }
  if (Object.keys(blockCfg).length) merged.blockCfg = blockCfg
  return cleanPayload(merged)
}

function defaultChannelFactory(win) {
  return (name) => {
    const Factory = win.BroadcastChannel || globalThis.BroadcastChannel
    if (!Factory) throw new Error('BroadcastChannel unavailable')
    return new Factory(name)
  }
}

/** Creates the local, same-origin relationship between an embedded host and its detached child. */
export function createStandalone({ win = window, getSession = () => null, getPayload = () => null, onDock = () => {}, channelFactory } = {}) {
  const frame = (() => { try { return win.top !== win.self } catch { return false } })()
  const candidate = !frame && win.name === CHILD_NAME && !!win.opener
  const restoreChildPayload = (() => {
    if (!candidate) return false
    try {
      const entries = win.performance.getEntriesByType('navigation')
      const type = Array.isArray(entries) ? entries[0]?.type : undefined
      return type === 'reload' || type === 'back_forward'
    } catch { return false }
  })()
  const mode = candidate ? 'standalone' : 'docked'
  const id = randomId(win)
  let pairId = id
  let handlers = { getPayload, onDock }
  let childRef = null
  let currentRequestId = ''
  let recoveryNonce = ''
  let helloNonce = ''
  let savedToken = ''
  let initialPayload = null
  let messageCounter = 0
  const seenMessages = new Map()
  let docking = false
  let pendingSession = null
  let disposed = false
  let blocked = false
  let peer = false
  let hostAvailable = false
  let lastPongAt = 0
  let helloTimer = 0
  let helloTimeout = 0
  let pingTimer = 0
  let pongTimer = 0
  let lastAliveAt = 0
  let aliveTimer = 0
  let dockGraceTimer = 0
  const subs = new Set()
  let channel = null

  const snapshot = () => ({ mode, available: frame || candidate, peer, hostAvailable, blocked })
  const notify = () => { const value = snapshot(); for (const fn of subs) fn(value) }
  const sendChannel = (gr, fields = {}) => {
    if (disposed) return
    const data = { gr, pairId, from: mode, messageId: `${id}:${++messageCounter}`, ...fields }
    try { channel?.postMessage(data) } catch { /* peer channel is optional */ }
    const target = candidate ? win.opener : childRef
    sendWindow(target, data)
  }
  const sendWindow = (target, data) => {
    if (!target || disposed) return
    try { target.postMessage(data, originOf(win)) } catch { /* stale or closed peer */ }
  }
  const setPeer = (value) => {
    if (value) lastAliveAt = Date.now()
    if (peer !== value) { peer = value; notify() }
  }
  const cancelDockGrace = () => { if (dockGraceTimer) clearTimeout(dockGraceTimer); dockGraceTimer = 0 }
  // 独立窗被硬关 / 崩溃 / 刷新后没回来：内嵌页让位复位，不依赖对方的 dock 消息。
  const peerGone = (payload) => {
    cancelDockGrace()
    const wasPeer = peer
    setPeer(false)
    if (!wasPeer && payload === null) return
    try { handlers.onDock(payload) } catch { /* host owns its callback */ }
  }
  const childClosed = () => { try { return !childRef || childRef.closed === true } catch { return true } }
  const stopHello = () => {
    if (helloTimer) clearInterval(helloTimer)
    if (helloTimeout) clearTimeout(helloTimeout)
    helloTimer = 0; helloTimeout = 0
  }
  const stopPongTimer = () => { if (pongTimer) clearTimeout(pongTimer); pongTimer = 0 }
  const setHostAvailable = (value) => { if (hostAvailable !== value) { hostAvailable = value; notify() } }
  const receivedPayload = (payload) => {
    const parentPayload = cleanPayload(payload)
    if (!restoreChildPayload) return parentPayload
    let localPayload = null
    try { localPayload = cleanPayload(handlers.getPayload()) } catch { /* keep the authenticated parent payload */ }
    return mergeRecoveredPayload(parentPayload, localPayload)
  }
  const receiveControl = (data, source = null, viaWindow = false) => {
    if (!data || typeof data !== 'object' || typeof data.gr !== 'string' || !data.pairId || !data.from) return
    if (viaWindow && data.gr !== 'host-discover' && data.gr !== 'peer-offer' && source !== (candidate ? win.opener : childRef)) return
    if (typeof data.messageId === 'string') {
      const key = `${data.pairId}\0${data.from}\0${data.messageId}`
      if (seenMessages.has(key)) return
      seenMessages.set(key, true)
      if (seenMessages.size > 128) seenMessages.delete(seenMessages.keys().next().value)
    }
    if (candidate && data.gr === 'host-discover' && data.from === 'docked' && typeof data.requestId === 'string' && (!viaWindow || source === win.opener)) {
      sendWindow(win.opener, { gr: 'peer-offer', requestId: data.requestId, pairId, from: 'standalone' })
      return
    }
    if (frame && data.gr === 'peer-offer' && currentRequestId && data.from === 'standalone' && data.requestId === currentRequestId && data.pairId && isChildSource(source, win)) {
      childRef = source
      pairId = data.pairId
      recoveryNonce = randomId(win)
      sendWindow(childRef, { gr: 'standalone-recover', nonce: recoveryNonce, pairId, from: 'docked' })
      return
    }
    if (data.pairId !== pairId) return
    if (frame && data.from === 'standalone' && (data.gr === 'ready' || data.gr === 'ping') && childRef) {
      cancelDockGrace()
      setPeer(true)
      sendChannel('pong')
    } else if (frame && data.from === 'standalone' && data.gr === 'dock' && childRef) {
      const payload = cleanPayload(data.payload)
      // 页面隐藏（刷新或关窗）发来的 dock：先等一会儿，同一子窗重新上线就取消；点「回嵌」发来的立即生效。
      if (data.reason === 'pagehide' && !childClosed()) {
        cancelDockGrace()
        dockGraceTimer = setTimeout(() => { dockGraceTimer = 0; if (!disposed) peerGone(payload) }, RELOAD_GRACE_MS)
      } else peerGone(payload)
    } else if (candidate && data.from === 'docked' && data.gr === 'pong') {
      lastPongAt = Date.now()
      stopPongTimer()
      setHostAvailable(true)
    } else if (candidate && data.from === 'docked' && data.gr === 'dock-request') {
      dock()
    }
  }

  try { channel = (channelFactory || defaultChannelFactory(win))(CHANNEL) } catch { channel = null }
  if (channel) {
    channel.onmessage = (event) => receiveControl(event && event.data)
  }

  const receiveMessage = (event) => {
    const data = event && event.data
    if (!data || typeof data !== 'object' || originOf(win) !== event.origin) return
    if (frame && childRef && event.source === childRef && (data.gr === 'standalone-presence' || data.gr === 'standalone-hello')) cancelDockGrace()
    if (candidate && data.gr === 'host-discover' && event.source === win.opener) receiveControl(data, event.source, true)
    else if (frame && data.gr === 'standalone-presence' && !childRef && isChildSource(event.source, win)) {
      currentRequestId = randomId(win)
      sendWindow(event.source, { gr: 'host-discover', requestId: currentRequestId, pairId, from: 'docked', messageId: `${id}:${++messageCounter}` })
    } else if (data.gr === 'peer-offer') receiveControl(data, event.source, true)
    else if (['ready', 'ping', 'pong', 'dock', 'dock-request'].includes(data.gr)) receiveControl(data, event.source, true)
    if (frame && data.gr === 'standalone-hello' && event.source === childRef && typeof data.nonce === 'string' && data.nonce) {
      Promise.resolve().then(() => getSession()).then((session) => {
        const token = tokenOf(session)
        if (!token || disposed || event.source !== childRef) return
        const incomingPair = data.pairId
        if (incomingPair && incomingPair !== pairId && !peer) pairId = incomingPair
        sendWindow(childRef, { gr: 'standalone-session', nonce: data.nonce, token, pairId, payload: cleanPayload(handlers.getPayload()), from: 'docked' })
      }).catch(() => {})
    } else if (frame && data.gr === 'standalone-session' && event.source === childRef && recoveryNonce && data.nonce === recoveryNonce && typeof data.token === 'string' && data.token) {
      recoveryNonce = ''
      savedToken = data.token
      initialPayload = cleanPayload(data.payload)
      if (pendingSession) { pendingSession.resolve({ token: data.token }); pendingSession = null }
      setPeer(true)
    } else if (candidate && data.gr === 'standalone-session' && event.source === win.opener && helloNonce && data.nonce === helloNonce && typeof data.token === 'string' && data.token) {
      stopHello()
      helloNonce = ''
      savedToken = data.token
      initialPayload = receivedPayload(data.payload)
      if (typeof data.pairId === 'string' && data.pairId) pairId = data.pairId
      if (pendingSession) { pendingSession.resolve({ token: data.token }); pendingSession = null }
    } else if (candidate && data.gr === 'standalone-recover' && event.source === win.opener && typeof data.nonce === 'string' && data.nonce && data.pairId === pairId && savedToken) {
      sendWindow(win.opener, { gr: 'standalone-session', nonce: data.nonce, token: savedToken, pairId, payload: cleanPayload(handlers.getPayload()), from: 'standalone' })
    }
  }

  const pageHide = () => {
    // 不论宿主是否应答都发：没人听无害，有人听才不会卡在让位态。reason 让内嵌页区分「刷新」与「回嵌」。
    if (candidate && !docking) sendChannel('dock', { reason: 'pagehide', payload: cleanPayload(handlers.getPayload()) })
  }
  try { win.addEventListener('message', receiveMessage); win.addEventListener('pagehide', pageHide) } catch { /* test or restricted window */ }

  let presenceTimer = 0
  if (candidate) {
    const presence = () => sendWindow(win.opener, { gr: 'standalone-presence', pairId, from: 'standalone' })
    presence()
    presenceTimer = setInterval(presence, PING_MS)
  }

  if (frame) {
    aliveTimer = setInterval(() => {
      if (!peer || disposed) return
      if (childClosed() || Date.now() - lastAliveAt > PEER_STALE_MS) peerGone(null)
    }, PING_MS)
  }

  if (frame && channel) {
    currentRequestId = randomId(win)
    sendChannel('host-discover', { requestId: currentRequestId })
  }

  function dock() {
    if (disposed || !candidate || !hostAvailable) return false
    docking = true
    sendChannel('dock', { payload: cleanPayload(handlers.getPayload()) })
    try { win.close() } catch { /* browser may keep the child open */ }
    return true
  }

  function requestSession() {
    if (disposed) return Promise.resolve(null)
    if (candidate) {
      if (savedToken) return Promise.resolve({ token: savedToken })
      if (pendingSession) return pendingSession.promise
      helloNonce = randomId(win)
      let resolve
      const promise = new Promise((res) => { resolve = res })
      pendingSession = { promise, resolve }
      const hello = () => sendWindow(win.opener, { gr: 'standalone-hello', nonce: helloNonce, from: 'standalone' })
      hello()
      helloTimer = setInterval(hello, HELLO_MS)
      helloTimeout = setTimeout(() => {
        stopHello()
        helloNonce = ''
        if (pendingSession) { pendingSession.resolve(null); pendingSession = null }
      }, HELLO_LIMIT_MS)
      return promise
    }
    if (!frame) return Promise.resolve(null)
    if (savedToken) return Promise.resolve({ token: savedToken })
    if (pendingSession) return pendingSession.promise
    currentRequestId = randomId(win)
    let resolve
    const promise = new Promise((res) => { resolve = res })
    pendingSession = { promise, resolve }
    sendChannel('host-discover', { requestId: currentRequestId })
    helloTimeout = setTimeout(() => {
      helloTimeout = 0
      if (pendingSession) { pendingSession.resolve(null); pendingSession = null }
    }, HELLO_LIMIT_MS)
    return promise
  }

  function detach() {
    if (!frame || disposed || !snapshot().available) return null
    try {
      const child = win.open(`${originOf(win)}/?ui=r5${win.location.hash || ''}`, CHILD_NAME)
      if (!child) { blocked = true; notify(); return null }
      childRef = child
      blocked = false
      notify()
      return child
    } catch {
      blocked = true; notify(); return null
    }
  }

  function connected() {
    if (disposed || !snapshot().available) return
    if (candidate) {
      if (!savedToken) return
      clearInterval(pingTimer)
      stopPongTimer()
      pongTimer = setTimeout(() => setHostAvailable(false), PONG_LIMIT_MS)
      sendChannel('ready')
      pingTimer = setInterval(() => {
        stopPongTimer()
        pongTimer = setTimeout(() => setHostAvailable(false), PONG_LIMIT_MS)
        sendChannel('ping')
      }, PING_MS)
    } else if (frame && childRef) {
      setPeer(true)
      sendChannel('pong')
    }
  }

  function setHandlers(next = {}) {
    handlers = { ...handlers, ...next }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    stopHello(); stopPongTimer()
    clearInterval(pingTimer)
    clearInterval(presenceTimer)
    clearInterval(aliveTimer)
    cancelDockGrace()
    clearTimeout(helloTimeout)
    pingTimer = 0; helloTimeout = 0
    try { win.removeEventListener('message', receiveMessage); win.removeEventListener('pagehide', pageHide) } catch { /* restricted window */ }
    if (channel) { channel.onmessage = null; try { channel.close() } catch { /* already closed */ } }
    if (pendingSession) { pendingSession.resolve(null); pendingSession = null }
    subs.clear()
  }

  let controllerDock = dock
  if (frame) {
    // A host-side dock request is an instruction to the peer, not a request to close this page.
    const hostDock = () => {
      if (!peer || disposed) return false
      if (childClosed()) { peerGone(null); return false }
      sendChannel('dock-request')
      return true
    }
    controllerDock = hostDock
  }
  return {
    getSnapshot: snapshot,
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn) },
    requestSession,
    detach,
    dock: (...args) => controllerDock(...args),
    connected,
    dispose,
    setHandlers,
    takeInitialPayload() { const value = initialPayload; initialPayload = null; return value },
  }
}

export function readModeLabel(doc, standalone) {
  const property = standalone ? '--gr-mode-label-on' : '--gr-mode-label'
  let value = ''
  try { value = doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue(property).trim() } catch { return '' }
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1)
  let decoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]
    if (current !== '\\' || index + 1 >= value.length) {
      decoded += current
      continue
    }
    const next = value[index + 1]
    if (next === '\n' || next === '\f') {
      index += 1
      continue
    }
    if (next === '\r') {
      index += value[index + 2] === '\n' ? 2 : 1
      continue
    }
    if (/[0-9a-f]/i.test(next)) {
      let end = index + 1
      while (end < value.length && end <= index + 6 && /[0-9a-f]/i.test(value[end])) end += 1
      const codePoint = Number.parseInt(value.slice(index + 1, end), 16)
      decoded += codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? '\uFFFD'
        : String.fromCodePoint(codePoint)
      if (value[end] === '\r' && value[end + 1] === '\n') end += 2
      else if (/[\t\n\r\f ]/.test(value[end] ?? '')) end += 1
      index = end - 1
      continue
    }
    decoded += next
    index += 1
  }
  return decoded
}
