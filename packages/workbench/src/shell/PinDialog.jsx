// SPDX-License-Identifier: CPAL-1.0
// 人面动作统一的 PIN 弹层（在场证明，契约 §5.1；IXD 流程 2）。内核回 ATTESTATION_REQUIRED 时 KernelClient 调壳的 attestor 打开（壳开了 SDK 的重试回路）：
// 标题 = 动作 + 对象；错 PIN 不关、内核原文就地显示、输入清空、焦点留在输入框；锁定显示倒计时，接管类动作给免 PIN 出口「改为停止新开仓」；
// 带证明重发落定（成功或别的错误）才关。行为沿用 r1：首帧聚焦（布局效果）+ 捕获阶段 Esc（DialogShell 的 'pin' 层）。外观 = A 的 DialogShell + PinField。
// PIN 只在这个组件的状态里，提交即清空，不进日志、不进 localStorage。
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
// 只取文案表本身：协议根入口会连带初始化 Ajv（new Function），被工作台的 CSP 拒绝
import { humanizeProblem } from '../../../protocol/src/model/problem-text'
import { Button } from '../ui/components/core.jsx'
import { PinField } from '../ui/components/forms.jsx'
import { DialogShell } from '../ui/components/radix.jsx'
import { mmss, useNow } from './hooks.js'
import { t, tk } from '../ui/lib/i18n.js'

const TITLE = {
  'takeover.halt_new': t('停止新开仓'), 'takeover.cancel_all': t('撤销挂单'), 'takeover.flatten_all': t('全部平仓'), kill: t('全部平仓'),
  'trading_state.resume': t('恢复交易'), 'risk.resume': t('恢复交易'), 'keystore.unlock': t('解锁钥匙库'),
  'credential.import': t('导入钥匙'), 'credential.generate': t('生成钥匙'), 'pin.set': t('修改 PIN'),
  'position.close': t('平仓'), 'order.place': t('下单'), 'order.cancel': t('撤单'), 'order.cancel_all': t('撤销挂单'),
  'risk.relax': t('放宽限额'), 'paper.reset': t('重置纸面账户'), 'engine.bind': t('绑定策略'), 'lab.stage': t('晋级实验'),
  'config.venues.set': t('修改交易所配置'), 'plugin.grant': t('授予插件权限'), 'engine.call': t('调整策略'), 'strategy.update': t('更新策略'),
  'agentkey.create': t('创建 Agent 钥匙'), 'agentkey.revoke': t('撤销 Agent 钥匙'), 'risk.temporaryRelax': t('临时放宽限额'), 'mandate.update': t('修改 Agent 授权'), 'agentkey.request.approve': t('批准 Agent 接入'),
}

/** 中文（含「PIN 不对」这种中文夹拉丁字母的写法）。 */
const HAS_ZH = /[一-龥]/
/** 内核英文副标题 → 中文；认不出的英文一律按「需要 PIN 确认」说。 */
const REASON_TEXT = [
  [/presence proof|required for this action/i, t('这一步需要你输入 PIN 确认')],
  [/unlock the keystore/i, t('实盘下单需要钱包签名：输入 PIN 解锁钥匙库')],
]

/** 副标题（内核 ATTESTATION_REQUIRED 的原文）：中文照用，英文转中文。 */
export function pinReason(reason) {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text || HAS_ZH.test(text)) return tk(text)
  const hit = REASON_TEXT.find(([re]) => re.test(text))
  if (hit) return hit[1]
  return tk(humanizeProblem({ name: 'ATTESTATION_REQUIRED', message: text }, { surface: 'ui' }).zh)
}

/** 错误行（`invalid PIN` / `too many failed …`）：中文照用，英文查中文表。 */
export function pinErrorText(error, retryAfterMs) {
  const text = typeof error === 'string' ? error.trim() : error ? String(error) : ''
  if (!text || HAS_ZH.test(text)) return tk(text)
  return tk(humanizeProblem({ name: 'AUTH_FAILED', message: text, ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}) }, { surface: 'ui' }).zh)
}
const TIER = { L0: t('只读'), L1: t('纸面'), L2: t('需确认'), L3: t('限额自动'), L4: t('限额自动') }
/** 锁定期间可以改走「停止新开仓」的动作（收紧方向，永远不要 PIN：锁定时人仍能先把风险收住，IXD F2-2）。 */
const TAKEOVER = new Set(['takeover.cancel_all', 'takeover.flatten_all', 'kill'])

const listOf = (r, k) => (Array.isArray(r) ? r : r && Array.isArray(r[k]) ? r[k] : [])
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms, null))]).catch(() => null)

/** 标题 = 动作 + 对象（IXD F2-4）：「批准 T-…」「改档位 · Claude Code → 只读」「全部平仓」…；查不到对象只写动作，认不出的动作写动作名原文。 */
export async function pinTitle(kernel, req) {
  const p = (req.params && typeof req.params === 'object' ? req.params : {})
  if (req.action === 'proposal.approve' || req.action === 'proposal.reject') {
    const word = req.action === 'proposal.approve' ? t('批准') : t('拒绝')
    const hit = listOf(await within(kernel.query('proposal.list', { status: 'pending' }), 800), 'proposals').find((x) => x && x.proposalId === p.id)
    return hit && hit.ticket ? `${word} ${hit.ticket}` : t('{0}提案', word)
  }
  if (req.action === 'mandate.update') {
    const key = listOf(await within(kernel.query('agentkey.list'), 800), 'keys').find((x) => x && x.mandateId === p.mandateId)
    const to = TIER[p.input && p.input.level]
    return t('改档位{0}{1}', key && key.name ? ` · ${key.name}` : '', to ? ` → ${to}` : '')
  }
  if (req.action === 'risk.setLlmLiveEntries') return p.deny === false ? t('关闭大模型实盘开仓保护') : t('打开大模型实盘开仓保护')
  if (req.action === 'order.place' && p.intent?.reduceOnly && /^stop_/.test(p.intent.type)) return t('挂止损')
  return TITLE[req.action] || req.action
}

/**
 * item：壳排队的当前 PIN 请求 { id, req（SDK 的 AttestRequest，重试时带 error / retryAfterMs / remaining）, title, from, busy, round, lockUntil }；null = 关。
 * onSubmit(pin) / onCancel() / onHaltNew()（返回 promise，失败抛内核原文）/ onSettings() / onRestore()（关闭后还焦点）。
 */
export function PinDialog({ item, pinSet, offline, onSubmit, onCancel, onHaltNew, onSettings, onRestore }) {
  const last = useRef(item)
  if (item) last.current = item
  const it = item || last.current // 关闭动画期间仍显示刚才那一份
  return (
    <DialogShell open={!!item} onOpenChange={(v) => { if (!v) onCancel() }} title={(it && it.title) || t('输入 PIN')} level="pin" closeOnOverlay={false} placement="top"
      className="gr-pin" overlayClassName="gr-pin__mask" onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => { e.preventDefault(); onRestore(last.current) }}>
      {it ? <PinBody key={it.id} item={it} pinSet={pinSet} offline={offline} onSubmit={onSubmit} onCancel={onCancel} onHaltNew={onHaltNew} onSettings={onSettings} /> : null}
    </DialogShell>
  )
}

function PinBody({ item, pinSet, offline, onSubmit, onCancel, onHaltNew, onSettings }) {
  const [v, setV] = useState('')
  const [halt, setHalt] = useState({ busy: false, err: '' })
  const input = useRef(null)
  const now = useNow(1000, item.lockUntil > Date.now())
  const lockLeft = item.lockUntil ? item.lockUntil - now : 0
  const locked = lockLeft > 0
  // 首帧聚焦（布局效果：弹层一出现就能打字，r1 修过的竞态）；错 PIN 回来、锁定结束时焦点回输入框；锁定中输入框禁用，焦点放在弹层上（不掉到 body）
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    if (!locked) el.focus()
    else { const d = el.closest('[role="dialog"]'); if (d) d.focus() }
  }, [item.round, locked])
  // fix-r2 D2（R3-18）：锁定期间不显示上一次的「PIN 不对」；锁定结束后也不把那句旧话翻出来，直到下一次提交
  const [lockedRound, setLockedRound] = useState(-1)
  if (locked && lockedRound !== item.round) setLockedRound(item.round)
  const staleAfterLock = !locked && lockedRound === item.round
  const err = locked || staleAfterLock ? '' : pinErrorText(item.req.error, item.req.retryAfterMs)
  const reason = pinReason(item.req.reason)
  const canSubmit = v.length >= 6 && !locked && !item.busy && !offline
  const submit = () => {
    if (!canSubmit) return
    const pin = v
    setV('')
    onSubmit(pin)
  }
  const haltNew = async () => {
    setHalt({ busy: true, err: '' })
    try { await onHaltNew() } catch (e) { setHalt({ busy: false, err: String((e && e.message) || e) }) }
  }
  return (
    <div className="gr-pin__body">
      {item.from ? <div className="gr-pin__from">{item.from}</div> : null}
      {reason ? <div className="gr-pin__r">{reason}</div> : null}
      <PinField value={v} onChange={setV} onEnter={submit} disabled={locked} invalid={!!err} inputRef={input} label="PIN" shakeKey={err ? item.round : 0} describedBy="gr-pin-msg" />
      <div className="gr-pin__msg" id="gr-pin-msg">
        {err ? <div className="gr-pin__err" role="alert">{err}</div> : null}
        {locked ? <div className="gr-pin__lock" role="status" data-pin-lock="">{t('已锁定 · ')}<span className="gr-num">{mmss(Math.ceil(lockLeft / 1000))}</span>{t('。锁定期间输什么都不会被评估，正确的 PIN 也要等倒计时结束')}</div> : null}
        {offline ? <div className="gr-pin__off">{t('离线')}</div> : null}
        {halt.err ? <div className="gr-pin__err" role="alert">{halt.err}</div> : null}
      </div>
      <div className="gr-pin__act">
        {locked && TAKEOVER.has(item.req.action)
          ? <Button size="sm" busy={halt.busy} disabled={!!offline} onClick={haltNew} data-act="pin-halt-new">{t('改为停止新开仓')}</Button>
          : pinSet === false ? <Button variant="ghost" size="sm" onClick={onSettings} data-act="pin-setup">{t('去设置 PIN')}</Button> : <span />}
        <span className="gr-pin__btns">
          <Button size="sm" onClick={onCancel} data-act="pin-cancel">{t('取消')}</Button>
          <Button variant="primary" size="sm" busy={item.busy} disabled={!canSubmit} onClick={submit} data-act="pin-confirm">{item.busy ? t('验证中…') : t('确认')}</Button>
        </span>
      </div>
    </div>
  )
}
