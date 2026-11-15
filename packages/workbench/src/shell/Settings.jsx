// SPDX-License-Identifier: CPAL-1.0
// 设置（PLAN ㉕ / IXD 流程 7）：200 导航 + 640 主列，靠左对齐到工作台的 16 px 边线；每组 = 组名 + 一张块面分组卡（行高 52、行间细线）。
// 连接：内核状态；网络分段手动激活（← → 只移焦点，Enter / Space 才选），确认前仍显示当前已配置的网络；切主网走行内确认，没有主网钥匙时主钮是
// 「导入主网钥匙」（跳到钥匙组、导入表单预选主网，F7-1）；内核只改配置并回 restartRequired → 网络行常驻「待重启」+ 复制重启命令（F7-2）。
// 钥匙：PIN 表单（不剥字符；「两次输入不一致」在第二栏输够长度或失焦后才出；错误原文挂在对应栏、焦点回栏；锁定倒计时；内核 hint 原文提示，F7-5）、
// 导入钥匙（网络可选；失败原文挂私钥栏、焦点回栏，F7-6）。私钥永远不显示：无「显示」按钮的密码框，提交时先清空再发请求。离线时一切提交禁用（G5）。
// Agent 钥匙表（fix-r4 C6）：名称 / 宿主 / 状态 / 到期 / 撤销；撤销先出行内确认，再调 agentkey.revoke（内核要 PIN，KernelClient 自动弹 PIN 层）。弱 PIN 二次确认（C5）。
// 留口（未实现）：API 钱包生成 / 撤销（HostApi.generateKey / revokeKey 已有）、主题 / 密度 / 导航左右、「允许 Agent 调整布局」。
import { useEffect, useRef, useState } from 'preact/hooks'
import { ATTESTATION_REQUIRED } from '@gitrader/blocks-sdk'
import { Button, Dot, EmptyState, Page, Segmented, Skeleton, Tag } from '../ui/components/core.jsx'
import { Field, TextInput } from '../ui/components/forms.jsx'
import { Icon } from '../ui/components/Icon.jsx'
import { Table } from '../ui/components/Table.jsx'
import { InfoTip } from '../ui/components/Tooltip.jsx'
import { toast } from '../ui/components/overlay.jsx'
import { copyText } from '../ui/lib/clip.js'
import * as F from '../ui/lib/format.js'
import { PAGE_COLUMNS, PAGE_LAYOUT } from '../core/presets'
import { cli } from '../core/launcher'
import { useShell } from './ctx.js'
import { pinErrorText } from './PinDialog.jsx'
import { R5Tile } from './Workbench.jsx'
import { Personal } from './Personal.jsx'
import { About } from './About.jsx'
import { mmss, useNow } from './hooks.js'
import { t as tr, tk } from '../ui/lib/i18n.js'

const GROUPS = [{ id: 'connect', label: tr('连接'), icon: 'link' }, { id: 'keys', label: tr('钥匙'), icon: 'key' }]
const R5_GROUPS = [
  { id: 'connect', label: tr('连接') }, { id: 'keys', label: tr('钥匙') }, { id: 'venues', label: tr('交易所') },
  { id: 'notify', label: tr('通知') }, { id: 'personal', label: tr('个性化') }, { id: 'about', label: tr('关于') },
]
const NET = [{ id: 'testnet', label: tr('测试网') }, { id: 'mainnet', label: tr('主网') }]
const STATUS = { open: ['ok', tr('已连接')], connecting: ['pending', tr('连接中')], reconnecting: ['pending', tr('重连中')], idle: ['idle', tr('未连接')], closed: ['err', tr('未连接')] }
const RESTART_CMD = 'gitrader serve'
// 跨分组的两件小事（模块级，刷新页面即清）：切了网络、还没重启的目标网络；「导入主网钥匙」要预选的网络
let restartTo = null
let importNet = null

const msg = (e) => (e && e.message ? e.message : String(e))
// 与内核 isAcceptablePin 同口径：6–12 位数字，或 8–64 位口令（UX-07：以前只看 ≥ 6，13 位数字也亮着「保存」、点了才被内核拒）
const pinShapeOk = (pin) => /^[0-9]{6,12}$/.test(pin) || (pin.length >= 8 && pin.length <= 64)

function Row({ label, className = '', children }) {
  return (
    <div className={'gr-set__row' + (className ? ' ' + className : '')}>
      <div className="gr-set__k">{label}</div>
      <div className="gr-set__v">{children}</div>
    </div>
  )
}

function Group({ title, info, children }) {
  return (
    <section className="gr-set__grp" aria-label={title}>
      <h2 className="gr-set__gt">{title}{info ? <InfoTip text={info} placement="right" /> : null}</h2>
      <div className="gr-set__card">{children}</div>
    </section>
  )
}

function ConnectGroup({ snap, reload }) {
  const sh = useShell()
  const [tone, word] = STATUS[sh.status] || STATUS.idle
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [restart, setRestart] = useState(restartTo)
  const hasMain = !!snap && snap.keys.some((k) => k.network === 'mainnet' && !(k.expiresAt && k.expiresAt < Date.now()))
  const set = async (network) => {
    setBusy(true)
    setErr('')
    try {
      const r = await sh.api.setNetwork(network)
      setAsk(false)
      if (r && r.restartRequired) { restartTo = network; setRestart(network); toast.ok(tr('已保存 · 重启内核后生效')) } else toast.ok(tr('已保存'))
      reload()
    } catch (e) { setErr(msg(e)) } finally { setBusy(false) }
  }
  // 选「主网」只展开确认条（分段仍显示当前网络，F7-3）；切回测试网是收紧方向，直接保存
  const pick = (id) => {
    setErr('')
    if (!snap || id === snap.network) { setAsk(false); return }
    if (id === 'mainnet') setAsk(true)
    else { setAsk(false); void set(id) }
  }
  const copy = async () => { if (await copyText(cli(RESTART_CMD))) toast.ok(tr('已复制重启命令')); else toast.err(tr('复制失败：请手动输入 {0}', cli(RESTART_CMD))) }
  return (
    <Group title={tr('连接')}>
      <Row label={tr('内核')}>
        <span className="gr-row-flex"><Dot tone={tone} />{word}</span>
        {sh.state.error && sh.status !== 'open' ? <span className="gr-set__err">{sh.state.error.message}</span> : null}
      </Row>
      <Row label={tr('网络')} className="gr-set__row--stack">
        {snap ? (
          <>
            <div className="gr-row-flex gr-set__line">
              <Segmented manual value={snap.network} options={NET} label={tr('网络')} disabled={busy || !!sh.offline} onChange={pick} />
              {restart ? <Tag tone="warn" className="gr-set__restart">{tr('待重启')}</Tag> : null}
              {restart ? <Button variant="ghost" size="sm" icon="copy" data-act="copy-restart" onClick={copy}>{tr('复制重启命令')}</Button> : null}
              {sh.offline ? <span className="gr-set__off">{tr('离线')}</span> : null}
            </div>
            {ask ? (
              <div className="gr-set__ask" data-ask="mainnet">
                <span className="gr-set__askt">{tr('主网用真实资金下单')}</span>
                <span className="gr-set__btns">
                  <Button size="sm" onClick={() => { setAsk(false); setErr('') }}>{tr('取消')}</Button>
                  {hasMain
                    ? <Button variant="primary" size="sm" busy={busy} disabled={!!sh.offline} data-act="net-confirm" onClick={() => set('mainnet')}>{busy ? tr('切换中…') : tr('切到主网')}</Button>
                    : <Button variant="primary" size="sm" data-act="net-import" onClick={() => { importNet = 'mainnet'; sh.go('settings', 'keys') }}>{tr('导入主网钥匙')}</Button>}
                </span>
              </div>
            ) : null}
            {err ? <span className="gr-set__err" role="alert">{err}</span> : null}
          </>
        ) : <Skeleton w={160} h={28} />}
      </Row>
    </Group>
  )
}

// 密码框：不剥字符（PIN 可以是 8–64 位口令，F2-1）、无「显示」钮、关闭自动填充
const Secret = ({ inputRef, ...rest }) => <TextInput type="password" inputRef={inputRef} maxLength={64} autocomplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" {...rest} />

function PinForm({ snap, reload }) {
  const sh = useShell()
  const [open, setOpen] = useState(false)
  const [cur, setCur] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [bLeft, setBLeft] = useState(false) // 第二栏失焦过
  const [errs, setErrs] = useState({})
  const [busy, setBusy] = useState(false)
  const [weak, setWeak] = useState(false) // 内核回 WEAK_PIN：输入保留，等人点「仍然使用」
  const [lockUntil, setLockUntil] = useState(0)
  const now = useNow(1000, lockUntil > Date.now())
  const locked = lockUntil > now
  const refs = { cur: useRef(null), a: useRef(null), b: useRef(null) }
  const focusField = (k) => setTimeout(() => { if (refs[k].current) refs[k].current.focus() }, 0)
  const mismatch = b && a !== b && (b.length >= a.length || bLeft) ? tr('两次输入不一致') : ''
  const ok = pinShapeOk(a) && a === b && (!snap.pinSet || cur.length >= 6) && !busy && !locked && !sh.offline
  const reset = () => { setOpen(false); setCur(''); setA(''); setB(''); setBLeft(false); setErrs({}); setWeak(false) }
  const save = async (confirmWeak) => {
    if (!ok) return
    const [pin, current] = [a, cur]
    setCur(''); setA(''); setB(''); setBLeft(false); setErrs({}); setWeak(false) // 先清空三栏，再发请求
    setBusy(true)
    try {
      const r = await sh.api.setPin(pin, snap.pinSet ? current : undefined, confirmWeak === true)
      sh.setPinSet(true)
      toast.ok(snap.pinSet ? tr('PIN 已修改') : tr('PIN 已设置'))
      // 内核的建议是英文原文（测试按它断言）；界面给中文同义句
      if (r && r.hint) toast.info(/longer PIN/i.test(r.hint) ? tr('更长的 PIN 更安全：建议 10 位以上数字或 8–64 位口令') : r.hint)
      reset()
      reload()
    } catch (e) {
      if (/^WEAK_PIN/.test(msg(e))) { setCur(current); setA(pin); setB(pin); setWeak(true); return } // 弱 PIN：原样放回输入，出确认行
      const wait = e && e.problem && e.problem.retryAfterMs
      if (typeof wait === 'number') setLockUntil(Date.now() + wait)
      const k = snap.pinSet && (e.problemName === 'AUTH_FAILED' || e.problemName === 'ATTESTATION_REQUIRED') ? 'cur' : 'a'
      // 内核的英文原文（invalid PIN / PIN must be …）换成中文；认不出的英文走通用说法
      setErrs({ [k]: k === 'cur' ? pinErrorText(msg(e), wait) : /[一-龥]/.test(msg(e)) ? tk(msg(e)) : tr('PIN 要 6–12 位数字，或 8–64 位口令') })
      focusField(k)
    } finally { setBusy(false) }
  }
  const edit = (k, set) => (v) => { set(v); if (errs[k]) setErrs({}); if (weak) setWeak(false) }
  if (!open) {
    return (
      <span className="gr-row-flex">
        <Tag>{snap.pinSet ? tr('已设置') : tr('未设置')}</Tag>
        <Button size="sm" variant={snap.pinSet ? undefined : 'primary'} data-act="pin-open" onClick={() => { setOpen(true); focusField(snap.pinSet ? 'cur' : 'a') }}>{snap.pinSet ? tr('修改 PIN') : tr('设置 PIN')}</Button>
        {snap.pinSet ? null : <span className="gr-set__rule" data-pin-why>{tr('批准下单、恢复交易都要用它')}</span>}
      </span>
    )
  }
  return (
    <div className="gr-set__form" data-form="pin">
      {snap.pinSet ? <Field label={tr('当前 PIN')} error={errs.cur}><Secret inputRef={refs.cur} value={cur} onChange={edit('cur', setCur)} aria-label={tr('当前 PIN')} disabled={busy} /></Field> : null}
      <Field label={tr('新 PIN')} error={errs.a}>
        <Secret inputRef={refs.a} value={a} onChange={edit('a', setA)} aria-label={tr('新 PIN')} disabled={busy} />
        <span className="gr-set__rule" data-pin-rule data-bad={a && !pinShapeOk(a) ? '' : undefined}>{tr('6–12 位数字，或 8–64 位口令')}</span>
      </Field>
      <Field label={tr('再输一次')} error={mismatch}><Secret inputRef={refs.b} value={b} onChange={edit('b', setB)} onBlur={() => setBLeft(true)} onEnter={() => save()} aria-label={tr('再输一次 PIN')} disabled={busy} /></Field>
      {weak ? (
        <div className="gr-set__ask" data-ask="weak-pin">
          <span className="gr-set__askt">{tr('这个 PIN 容易被猜到（连号或全相同），仍要使用吗？')}</span>
          <Button size="sm" disabled={busy} data-act="pin-weak-confirm" onClick={() => save(true)}>{tr('仍然使用')}</Button>
        </div>
      ) : null}
      {locked ? <div className="gr-set__lock" role="status" data-pin-lock="">{tr('试错次数过多，已暂时锁定 · ')}<span className="gr-num">{mmss(Math.ceil((lockUntil - now) / 1000))}</span></div> : null}
      <div className="gr-set__btns">
        <Button size="sm" onClick={reset}>{tr('取消')}</Button>
        <Button variant="primary" size="sm" busy={busy} disabled={!ok} data-act="pin-save" onClick={() => save()}>{busy ? tr('保存中…') : tr('保存')}</Button>
      </div>
    </div>
  )
}

function KeyImport({ snap, reload, onDone }) {
  const sh = useShell()
  const [open, setOpen] = useState(importNet != null)
  const [net, setNet] = useState(importNet || snap.network)
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const name = useRef(null)
  const sec = useRef(null)
  useEffect(() => { if (importNet != null) { importNet = null; if (name.current) name.current.focus() } }, [])
  const ok = label.trim().length > 0 && secret.trim().length >= 32 && !busy && !sh.offline
  const submit = async () => {
    if (!ok) return
    const [l, s] = [label.trim(), secret.trim()]
    setSecret('') // 先清空输入，再发请求：私钥不在界面里停留
    setErr('')
    setBusy(true)
    try {
      const key = await sh.api.importKey(s, l, net)
      toast.ok(tr('钥匙已导入'))
      setLabel('')
      setOpen(false)
      if (key && key.id) onDone(key.id)
      reload()
    } catch (e) {
      if (e && e.problemName === ATTESTATION_REQUIRED) return // 钥匙库锁着弹了 PIN、在 PIN 层点了取消 = 命令没有发生，不挂错（IXD 2-5）
      setErr(msg(e))
      setTimeout(() => { if (sec.current) sec.current.focus() }, 0)
    } finally { setBusy(false) }
  }
  if (!open) return <Button size="sm" icon="plus" data-act="key-open" onClick={() => { setOpen(true); setTimeout(() => { if (name.current) name.current.focus() }, 0) }}>{tr('导入钥匙')}</Button>
  return (
    <div className="gr-set__form" data-form="key">
      <Field label={tr('名称')}><TextInput inputRef={name} value={label} onChange={setLabel} maxLength={40} aria-label={tr('钥匙名称')} disabled={busy} /></Field>
      <Field label={tr('网络')}><Segmented value={net} options={NET} onChange={setNet} label={tr('钥匙网络')} disabled={busy} /></Field>
      <Field label={tr('API 钱包私钥')} error={err}><Secret inputRef={sec} value={secret} onChange={(v) => { setSecret(v); if (err) setErr('') }} onEnter={submit} aria-label={tr('API 钱包私钥')} maxLength={256} disabled={busy} /></Field>
      <div className="gr-set__btns">
        <Button size="sm" onClick={() => { setSecret(''); setErr(''); setOpen(false) }}>{tr('取消')}</Button>
        <Button variant="primary" size="sm" busy={busy} disabled={!ok} data-act="key-save" onClick={submit}>{busy ? tr('导入中…') : tr('导入')}</Button>
      </div>
    </div>
  )
}

const HOST_NAME = { 'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes', unigit: 'UNIGIT', other: tr('其它') }
const KEY_STATUS = { active: tr('有效'), suspended: tr('暂停'), revoked: tr('已吊销') }

/** Agent 钥匙表：每行「撤销」→ 行内确认 → agentkey.revoke（内核要 PIN，壳自动弹）。已吊销行灰显、无按钮。 */
function AgentKeys() {
  const sh = useShell()
  const [keys, setKeys] = useState(null)
  const [err, setErr] = useState('')
  const [ask, setAsk] = useState(null)
  const [busy, setBusy] = useState(false)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (sh.status !== 'open') return undefined
    let stop = false
    sh.api.agentKeys().then((r) => { if (!stop) { setKeys(r); setErr('') } }, (e) => { if (!stop) setErr(msg(e)) })
    return () => { stop = true }
  }, [sh.status, n])
  const revoke = async () => {
    const k = ask
    setBusy(true)
    setErr('')
    try {
      const r = await sh.api.revokeAgentKey(k.keyId)
      const [pos, ord] = [Number(r && r.openPositions) || 0, Number(r && r.openOrders) || 0]
      setAsk(null)
      toast.ok(tr('已撤销 Agent 钥匙「{0}」{1}', k.name || k.keyId, pos || ord ? tr('。它名下还有 {0} 笔持仓、{1} 张挂单，系统不会自动处理，请到总览查看。', pos, ord) : ''), pos || ord ? 8000 : undefined)
      setN((x) => x + 1)
    } catch (e) {
      if (e && e.problemName === ATTESTATION_REQUIRED) return // 在 PIN 层点了取消 = 没有撤销，保留确认条
      setErr(msg(e))
    } finally { setBusy(false) }
  }
  if (!keys) return err ? <span className="gr-set__err" role="alert">{err}</span> : <Skeleton w={240} h={28} />
  return (
    <>
      {keys.length === 0 ? <EmptyState compact icon="key" title={tr('还没有 Agent 接入')} className="gr-set__empty" /> : (
        <Table rowKey="keyId" dense rows={keys} rowClass={(r) => (r.status === 'revoked' ? 'is-revoked' : '')} columns={[
          { key: 'name', title: tr('名称'), align: 'l' },
          { key: 'host', title: tr('宿主'), align: 'l', render: (r) => HOST_NAME[r.host] || r.host || '—' },
          { key: 'status', title: tr('状态'), align: 'l', render: (r) => KEY_STATUS[r.status] || r.status },
          { key: 'expiresAt', title: tr('到期'), align: 'right', render: (r) => (r.expiresAt ? F.mdhm(r.expiresAt) : '—') },
          { key: 'act', title: tr('操作'), align: 'right', render: (r) => (r.status === 'revoked' ? null : <Button size="sm" disabled={!!sh.offline || busy} data-act="revoke-agent-key" data-key={r.keyId} onClick={() => { setErr(''); setAsk(r) }}>{tr('撤销')}</Button>) },
        ]} />
      )}
      {ask ? (
        <div className="gr-set__ask" data-ask="revoke-agent-key">
          <span className="gr-set__askt">{tr('撤销「{0}」：它立刻不能再下单，它的待批提案作废；已有持仓和挂单不会自动处理。', ask.name || ask.keyId)}</span>
          <span className="gr-set__btns">
            <Button size="sm" disabled={busy} data-act="revoke-agent-key-cancel" onClick={() => { setAsk(null); setErr('') }}>{tr('取消')}</Button>
            <Button variant="danger" size="sm" busy={busy} disabled={!!sh.offline} data-act="revoke-agent-key-confirm" onClick={revoke}>{busy ? tr('撤销中…') : tr('撤销')}</Button>
          </span>
        </div>
      ) : null}
      {err ? <span className="gr-set__err" role="alert">{err}</span> : null}
    </>
  )
}

function KeysGroup({ snap, reload }) {
  const [fresh, setFresh] = useState(null) // 刚导入的那一行高亮 2 s
  useEffect(() => { if (!fresh) return undefined; const t = setTimeout(() => setFresh(null), 2000); return () => clearTimeout(t) }, [fresh])
  return (
    <Group title={tr('钥匙')} info={tr('同一系统用户下的恶意代码不在保证范围')}>
      <Row label="PIN">{snap ? <PinForm snap={snap} reload={reload} /> : <Skeleton w={160} h={28} />}</Row>
      <Row label={tr('API 钱包')} className="gr-set__row--stack">
        {!snap ? <Skeleton w={240} h={28} /> : (
          <>
            {snap.keys.length === 0 ? <EmptyState compact icon="key" title={tr('还没有导入交易所 API 钱包')} className="gr-set__empty" /> : (
              <Table rowKey="id" dense rows={snap.keys} rowClass={(r) => (r.id === fresh ? 'is-new' : '')} columns={[
                { key: 'label', title: tr('名称') },
                { key: 'address', title: tr('地址'), render: (r) => <span className="gr-mono gr-ellipsis" title={r.address}>{r.address.slice(0, 8)}…{r.address.slice(-6)}</span> },
                { key: 'network', title: tr('网络'), render: (r) => (r.network === 'mainnet' ? tr('主网') : tr('测试网')) },
                { key: 'expiresAt', title: tr('到期'), align: 'right', render: (r) => (r.expiresAt ? F.mdhm(r.expiresAt) : '—') },
              ]} />
            )}
            <KeyImport snap={snap} reload={reload} onDone={setFresh} />
          </>
        )}
      </Row>
      <Row label={tr('Agent 钥匙')} className="gr-set__row--stack"><AgentKeys /></Row>
    </Group>
  )
}

export function Settings({ group }) {
  const sh = useShell()
  const isR5 = sh.ui === 'r5'
  const g = (isR5 ? R5_GROUPS : GROUPS).some((x) => x.id === group) ? group : 'connect'
  const loadSettings = !isR5 || g === 'connect' || g === 'keys'
  const [snap, setSnap] = useState(null)
  const [err, setErr] = useState(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!loadSettings) { setSnap(null); setErr(null); return undefined }
    if (sh.status !== 'open') return undefined
    let stop = false
    sh.api.settings().then((s) => { if (!stop) { setSnap(s); setErr(null); sh.setPinSet(!!s.pinSet) } }, (e) => { if (!stop) setErr(e) })
    return () => { stop = true }
  }, [sh.status, n, loadSettings])
  const reload = () => setN((x) => x + 1)
  if (isR5) {
    const page = g === 'venues' || g === 'notify' ? g : null
    const workspace = page ? sh.workspace : null
    const byId = workspace ? new Map(workspace.items.map((item) => [item.instanceId, item])) : null
    const render = (ids) => ids.map((id) => {
      const item = byId?.get(id)
      return item ? <R5Tile key={item.instanceId} item={item} page={page} /> : null
    })
    return (
      <Page fill className="g5-settings">
        <h1 className="gr-sr">{tr('设置')}</h1>
        <nav className="g5-snav" aria-label={tr('设置分组')}>
          {R5_GROUPS.map((x) => <a key={x.id} className="g5-tab" href={'#/settings/' + x.id} aria-current={x.id === g ? 'page' : undefined} data-group={x.id}>{x.label}</a>)}
        </nav>
        {page ? (
          PAGE_LAYOUT[page] === 'single'
            ? <div className="g5-ws g5-one" data-g5-page={page}><div className="g5-col" data-col="full">{render(PAGE_COLUMNS[page].full)}</div></div>
            : <div className="g5-ws" data-g5-page={page}><div className="g5-col" data-col="left">{render(PAGE_COLUMNS[page].left)}</div><div className="g5-col" data-col="right">{render(PAGE_COLUMNS[page].right)}</div></div>
        ) : g === 'personal' ? <Personal /> : g === 'about' ? <About /> : (
          <div className="g5-settings__main">
            {err ? <div className="gr-set__err" role="alert">{err.message}</div> : null}
            {g === 'connect' ? <ConnectGroup snap={snap} reload={reload} /> : <KeysGroup snap={snap} reload={reload} />}
          </div>
        )}
      </Page>
    )
  }
  return (
    <Page fill className="gr-setpage">
      <h1 className="gr-sr">{tr('设置')}</h1>
      <div className="gr-set">
        <nav className="gr-set__nav" aria-label={tr('设置分组')}>
          {GROUPS.map((x) => (
            <a key={x.id} className={'gr-set__navi' + (x.id === g ? ' is-active' : '')} href={'#/settings/' + x.id} aria-current={x.id === g ? 'page' : undefined} data-group={x.id}><Icon name={x.icon} size={16} />{x.label}</a>
          ))}
        </nav>
        <div className="gr-set__main">
          {err ? <div className="gr-set__err" role="alert">{err.message}</div> : null}
          {g === 'connect' ? <ConnectGroup snap={snap} reload={reload} /> : <KeysGroup snap={snap} reload={reload} />}
        </div>
      </div>
    </Page>
  )
}
