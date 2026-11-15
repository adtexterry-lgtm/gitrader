// SPDX-License-Identifier: CPAL-1.0
// 设置 · 通知：通道 / 规则 / 详情三张卡（块 notify 的 view = channels | rules | detail）。
// 数据全经桥：config.view（通道、规则、插件密钥句柄名与是否就位）、plugin.list（已装的通知插件）、写命令 config.notify.set、测试命令 notify.test。
// 界面永不收密钥值：通道密钥只显示句柄名与是否就位（内核没有写它的入口），参数里只放非密钥项。
import './notify.css'
import { Fragment, type ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import type { BlockBridge } from '@gitrader/blocks-sdk'
import type { ConfigView } from '@gitrader/protocol'
import { runCommand } from '../../../blocks-default/src/actions'
import { queryRetry } from '../../../blocks-default/src/hooks'
import { Menu } from '@gitrader/workbench/ui'
import { Card } from '../kit'
import {
  LEVELS, LEVEL_LABEL, channelHandles, channelKind, createStore, deletingLastEmergency, emergencyChannels, isHandle, patchChannelLevel, patchChannelParams,
  patchDeleteChannel, patchRuleLevel, testResultOf, type ChannelLogo, type Level, type NotifyChannelView, type NotifyRuleView, type Store, type TestResult,
} from '../model-config'
import { Head, Ico, Inp, OffNote, PageMsg, RestartFlag, Skel, cx, stateBody, useCfg, useStore, ArmedRow, type Arm, type PageState } from './venues'
import telegramSvg from '../logos/telegram.svg'
import discordSvg from '../logos/discord.svg'
import slackSvg from '../logos/slack.svg'
import { t as tr } from '@gitrader/workbench/i18n'

export const notifyState = createStore<PageState>({ config: null, restart: false, arm: null, selected: null, statusRev: 0 })
/** 最近一次测试（只在这个页面的内存里；刷新即清）与发送中的通道。 */
const testsStore = createStore<{ tests: Record<string, TestResult>; testing: string | null }>({ tests: {}, testing: null })

const RAW_LOGO: Partial<Record<ChannelLogo, string>> = { telegram: telegramSvg, discord: discordSvg, slack: slackSvg }
const GLYPH: Partial<Record<ChannelLogo, ComponentChildren>> = {
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4.5 7.5l7.5 5.5 7.5-5.5" /></>,
  hook: <><circle cx="12" cy="6.5" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="M10.8 8.7L7.3 14.8M8.5 17h7M13.2 8.7l3.5 6.1" /></>,
  chat: <><path d="M5.5 5.5h13a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H11l-4.5 3v-3h-1a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z" /><path d="M8.5 10.5h7M8.5 13.5h4" /></>,
}
export function ChanLogo({ plugin }: { plugin: string }) {
  const k = channelKind(plugin)
  const raw = RAW_LOGO[k.logo]
  if (raw) return <span className="g5-clogo" title={k.name} dangerouslySetInnerHTML={{ __html: raw }} />
  return <span className="g5-clogo" title={k.name}><svg className="g5-gl" viewBox="0 0 24 24" aria-hidden="true">{GLYPH[k.logo]}</svg></span>
}

const PARAM_LABEL: Record<string, string> = { host: tr('主机'), port: tr('端口'), user: tr('用户'), to: tr('收件人'), from: tr('发件人'), chatId: tr('聊天'), url: tr('地址'), secure: tr('加密'), topic: tr('主题') }

// ---- 写入 ------------------------------------------------------------------------------------------------------------------

type Patch = { channels?: NotifyChannelView[]; rules?: NotifyRuleView[] }
async function writeNotify(bridge: BlockBridge, store: Store<PageState>, patch: Patch): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await runCommand<{ notify?: ConfigView['notify']; restartRequired?: boolean }>(bridge, 'config.notify.set', patch)
  if (!r.ok) return { ok: false, message: r.message }
  const cur = store.get().config
  const n = r.value?.notify
  const valid = n && Array.isArray(n.channels)
  store.set({ ...(cur && valid ? { config: { ...cur, notify: n } } : {}), restart: store.get().restart || r.value?.restartRequired === true })
  return { ok: true }
}
interface Change { card: string; patch: Patch; what: string; confirm: string; danger?: boolean; after?: () => void }
function ask(bridge: BlockBridge, c: Change, setNote: (m: string) => void): void {
  const run: Arm['run'] = async () => {
    const r = await writeNotify(bridge, notifyState, c.patch)
    if (r.ok) { notifyState.set({ arm: null }); c.after?.(); return { ok: true } }
    return { ok: false, message: r.message }
  }
  if (c.danger) { notifyState.set({ arm: { card: c.card, what: c.what, confirm: c.confirm, loosen: false, danger: true, run } }); return }
  void run().then((r) => { if (!r.ok) setNote(r.message) })
}
const ArmSlot = ({ card }: { card: string }) => {
  const st = useStore(notifyState)
  return st.arm && st.arm.card === card ? <ArmedRow arm={st.arm} onCancel={() => notifyState.set({ arm: null })} /> : null
}
const Note = ({ text }: { text: string }) => (text ? <div className="g5-pmsg"><span className="g5-bad"><Ico name="block" small /></span><span className="g5-hdl g5-t3" data-act="notify-note">{text}</span></div> : null)

function LevelDD({ value, label, disabled, onPick }: { value: Level; label: string; disabled?: boolean; onPick(l: Level): void }) {
  return <Menu label={label} value={value} disabled={disabled} onValueChange={(v) => onPick(v as Level)} items={LEVELS.map((l) => ({ id: l, label: LEVEL_LABEL[l] }))}
    trigger={<button type="button" className="g5-dd" disabled={disabled} aria-label={label}>{LEVEL_LABEL[value]}<Ico name="chev" small /></button>} />
}

const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
/** 表里「最近测试」：送达给耗时；失败只给「失败 · 时刻」（上游原文在详情里完整给出）。 */
const testText = (r: TestResult | undefined) => r ? (r.ok ? <span className="g5-ok">{tr('已送达 · ')}{r.text}</span> : <span className="g5-bad"><Ico name="block" small />{tr('失败 · ')}{hhmm(r.at)}</span>) : <span className="g5-t3">{tr('未测试')}</span>

// ---- 通道 ------------------------------------------------------------------------------------------------------------------

export function ChannelsCard() {
  const bridge = useBridge()
  const cfg = useCfg(notifyState)
  const st = useStore(notifyState)
  const { tests } = useStore(testsStore)
  const [note, setNote] = useState('')
  const thead = <tr><th className="g5-al">{tr('通道')}</th><th>{tr('最低级别')}</th><th className="g5-fill">{tr('密钥句柄')}</th><th className="g5-e">{tr('最近测试')}</th></tr>
  const skel = <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{thead}</thead><tbody>{[0, 1, 2].map((i) => <tr key={i} className="g5-row g5-h40"><td><Skel w={120} /></td><td><Skel w={56} h={28} /></td><td><Skel w={160} /></td><td className="g5-e"><Skel w={72} /></td></tr>)}</tbody></table></div>
  const pending = stateBody(cfg, skel)
  if (!cfg.config) return <Card head={<Head title={tr('通道')} />} className="g5-pgcard" data-notify-view="channels" data-geo="chans">{pending}</Card>
  const config = cfg.config
  const channels = config.notify.channels
  const emerg = emergencyChannels(config.notify).length
  const sel = st.selected
  const right = cfg.offline ? <OffNote elapsed={cfg.elapsed} /> : <>
    <RestartFlag store={notifyState} />
    <span className={cx('g5-s12', emerg === 0 ? 'g5-flag' : 'g5-t2')} data-act="emergency-count">{emerg === 0 ? <><Ico name="warn" small />{tr('未设紧急通道')}</> : tr('紧急 {0}', emerg)}</span>
    {channels.length > 0 ? <button type="button" className="g5-btn g5-btn-ghost" data-act="channel-add" onClick={() => notifyState.set({ selected: 'new-channel' })}><Ico name="plus" />{tr('添加通道')}</button> : null}
  </>
  return (
    <Card head={<Head title={tr('通道')} count={channels.length} right={right} gh={!cfg.offline} />} className={cx('g5-pgcard', cfg.offline && 'g5-off')} data-notify-view="channels" data-geo="chans">
      {channels.length === 0 ? (
        <PageMsg><span className="g5-al">{tr('还没有通知通道')}</span><button type="button" className="g5-btn g5-btn-fill" disabled={cfg.offline} data-act="channel-add" onClick={() => notifyState.set({ selected: 'new-channel' })}><Ico name="plus" />{tr('添加通道')}</button></PageMsg>
      ) : (
        <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{thead}</thead><tbody>
          {channels.map((c) => {
            const hs = channelHandles(config, c.plugin)
            return (
              <tr key={c.id} className="g5-row g5-h40" data-channel={c.id} aria-selected={sel === `ch:${c.id}` ? 'true' : undefined} tabIndex={0}
                onClick={() => notifyState.set({ selected: `ch:${c.id}` })} onKeyDown={(e) => { if (e.key === 'Enter') notifyState.set({ selected: `ch:${c.id}` }) }}>
                <td><span className="g5-cell g5-al"><ChanLogo plugin={c.plugin} /><span className="g5-tb">{c.id}</span><span className="g5-s12 g5-t3">{channelKind(c.plugin).name}</span></span></td>
                <td onClick={(e) => e.stopPropagation()}><LevelDD value={c.minLevel} label={tr('{0} 最低级别', c.id)} disabled={cfg.offline} onPick={(l) => { setNote(''); ask(bridge, { card: 'chans', patch: patchChannelLevel(config.notify, c.id, l), what: '', confirm: '' }, setNote) }} /></td>
                <td className="g5-fill">{hs.length === 0 ? <span className="g5-t3">—</span> : <span className="g5-cell">{hs.map((h) => <Fragment key={h.key}><span className="g5-hdl">{h.handle}</span>{h.state === 'ready' ? <span className="g5-ok">{tr('已就位')}</span> : <span className="g5-miss"><Ico name="warn" small />{tr('缺失')}</span>}</Fragment>)}</span>}</td>
                <td className="g5-e">{testText(tests[c.id])}</td>
              </tr>
            )
          })}
        </tbody></table></div>
      )}
      <Note text={note} />
      <ArmSlot card="chans" />
    </Card>
  )
}

// ---- 规则 ------------------------------------------------------------------------------------------------------------------

export function RulesCard() {
  const bridge = useBridge()
  const cfg = useCfg(notifyState)
  const st = useStore(notifyState)
  const [note, setNote] = useState('')
  const thead = <tr><th className="g5-al">{tr('事件')}</th><th>{tr('级别')}</th><th className="g5-fill">{tr('通道')}</th><th className="g5-e" /></tr>
  const skel = <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{thead}</thead><tbody>{[0, 1, 2].map((i) => <tr key={i} className="g5-row g5-h40"><td><Skel w={120} /></td><td><Skel w={56} h={28} /></td><td><Skel w={160} /></td><td className="g5-e"><Skel w={40} /></td></tr>)}</tbody></table></div>
  const pending = stateBody(cfg, skel)
  if (!cfg.config) return <Card head={<Head title={tr('规则')} />} className="g5-pgcard g5-grow" data-notify-view="rules" data-geo="rules">{pending}</Card>
  const config = cfg.config
  const rules = config.notify.rules ?? []
  const rate = config.notify.rateLimit
  const right = cfg.offline ? <OffNote elapsed={cfg.elapsed} /> : rate ? <>
    <span className="g5-s12 g5-t3">{tr('限速')}</span><span className="g5-s12 g5-t2" data-act="rate-limit">{rate.perChannelPerMinute}{tr(' 条 / 分')}</span>
    <span className="g5-s12 g5-t3 g5-gapl">{tr('去重')}</span><span className="g5-s12 g5-t2" data-act="dedupe-window">{rate.dedupeWindowSec} s</span>
  </> : undefined
  const byId = new Map(config.notify.channels.map((c) => [c.id, c]))
  return (
    <Card head={<Head title={tr('规则')} count={rules.length} right={right} />} className={cx('g5-pgcard', 'g5-grow', cfg.offline && 'g5-off')} data-notify-view="rules" data-geo="rules">
      {rules.length === 0 ? <PageMsg><span className="g5-al">{tr('还没有规则')}</span></PageMsg> : (
        <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{thead}</thead><tbody>
          {rules.map((r, i) => (
            <tr key={`${r.match}:${i}`} className="g5-row g5-h40" data-rule={r.match} aria-selected={st.selected === `rule:${i}` ? 'true' : undefined}>
              <td><span className="g5-hdl g5-tb g5-al">{r.match}</span></td>
              <td><LevelDD value={r.level} label={tr('{0} 级别', r.match)} disabled={cfg.offline} onPick={(l) => { setNote(''); ask(bridge, { card: 'rules', patch: patchRuleLevel(config.notify, i, l), what: '', confirm: '' }, setNote) }} /></td>
              <td className="g5-fill"><span className="g5-chs">{r.channels.length === 0 ? <span className="g5-t3">{tr('无通道')}</span> : r.channels.map((id) => { const c = byId.get(id); return <span key={id} className="g5-cell">{c ? <ChanLogo plugin={c.plugin} /> : null}<span className="g5-tb">{id}</span></span> })}</span></td>
              <td className="g5-e"><span className="g5-acts"><button type="button" className="g5-btn g5-btn-ghost" disabled={cfg.offline} data-act="rule-edit" onClick={() => notifyState.set({ selected: `rule:${i}` })}>{tr('编辑')}</button></span></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      <Note text={note} />
      <ArmSlot card="rules" />
      <div className="g5-cfoot"><button type="button" className="g5-btn g5-btn-ghost" disabled={cfg.offline} data-act="rule-add" onClick={() => notifyState.set({ selected: 'new-rule' })}><Ico name="plus" />{tr('添加规则')}</button></div>
    </Card>
  )
}

// ---- 详情 ------------------------------------------------------------------------------------------------------------------

const Seg3 = ({ value, onPick, disabled, label }: { value: Level; onPick(l: Level): void; disabled?: boolean; label: string }) => (
  <div className="g5-seg g5-s3" role="group" aria-label={label}>{LEVELS.map((l) => <button key={l} type="button" aria-pressed={value === l} disabled={disabled} data-level={l} onClick={() => onPick(l)}>{LEVEL_LABEL[l]}</button>)}</div>
)
const MATCH_RE = /^(?:\*|[a-z_]+(?:\.[a-z_]+)*(?:\.\*)?)$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const show = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : String(v))
function parseParam(orig: unknown, text: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof orig === 'number') { const n = Number(text); return text.trim() !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false } }
  if (Array.isArray(orig)) return { ok: true, value: text.split(',').map((s) => s.trim()).filter(Boolean) }
  return { ok: true, value: text }
}

function ChannelDetail({ cfg, config, channel }: { cfg: ReturnType<typeof useCfg>; config: ConfigView; channel: NotifyChannelView }) {
  const bridge = useBridge()
  const { tests, testing } = useStore(testsStore)
  const [level, setLevel] = useState<Level>(channel.minLevel)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  useEffect(() => { setLevel(channel.minLevel); setDrafts({}) }, [config])
  const off = cfg.offline
  const kind = channelKind(channel.plugin)
  const handles = channelHandles(config, channel.plugin)
  const scalarKeys = Object.keys(channel.params).filter((k) => ['string', 'number'].includes(typeof channel.params[k]) || Array.isArray(channel.params[k]))
  const bad = scalarKeys.filter((k) => drafts[k] !== undefined && !parseParam(channel.params[k], drafts[k]!).ok)
  const dirty = level !== channel.minLevel || Object.keys(drafts).some((k) => drafts[k] !== show(channel.params[k]))
  const result = tests[channel.id]
  const send = async () => {
    testsStore.set({ testing: channel.id })
    const t0 = performance.now()
    const r = await runCommand(bridge, 'notify.test', { channelId: channel.id })
    const ms = performance.now() - t0
    testsStore.set({ testing: null, tests: { ...testsStore.get().tests, [channel.id]: r.ok ? testResultOf(r.value, channel.id, ms, Date.now()) : { at: Date.now(), ms, ok: false, text: r.message } } })
  }
  const save = () => {
    setNote('')
    let n = config.notify
    let patch: Patch = {}
    if (level !== channel.minLevel) { patch = patchChannelLevel(n, channel.id, level); n = { ...n, channels: patch.channels! } }
    const params: Record<string, unknown> = { ...channel.params }
    for (const [k, t] of Object.entries(drafts)) { const p = parseParam(channel.params[k], t); if (p.ok) params[k] = p.value }
    if (Object.keys(drafts).length) patch = patchChannelParams(n, channel.id, params)
    ask(bridge, { card: 'detail', patch, what: '', confirm: '' }, setNote)
  }
  const last = deletingLastEmergency(config.notify, channel.id)
  const del = () => ask(bridge, {
    card: 'detail', patch: patchDeleteChannel(config.notify, channel.id), danger: true, confirm: tr('确认删除'),
    what: last ? tr('删除 {0}：急停将不通知任何人', channel.id) : tr('删除通道 {0}：重启后生效', channel.id), after: () => notifyState.set({ selected: null }),
  }, setNote)
  return (
    <>
      <div className="g5-fg">
        <span className="g5-k g5-al">{tr('最低级别')}</span>
        <div className="g5-v"><Seg3 value={level} label={tr('最低级别')} disabled={off} onPick={setLevel} /></div>
        {scalarKeys.map((k) => (
          <Fragment key={k}>
            <span className="g5-k g5-al">{PARAM_LABEL[k] ?? k}</span>
            <div className="g5-v"><Inp value={drafts[k] ?? show(channel.params[k])} label={PARAM_LABEL[k] ?? k} disabled={off} wide={typeof channel.params[k] !== 'number'} bad={bad.includes(k)} onInput={(v) => setDrafts({ ...drafts, [k]: v })} /><span className="g5-stw" /></div>
          </Fragment>
        ))}
        {handles.map((h) => (
          <Fragment key={h.key}>
            <span className="g5-k g5-al">{PARAM_LABEL[h.key] ?? h.key}</span>
            <div className="g5-v"><div className="g5-inp g5-s g5-l"><input className="g5-mono" value={h.handle} readOnly aria-label={tr('{0} 句柄', h.key)} /></div>
              <span className="g5-stw">{h.state === 'ready' ? <span className="g5-ok">{tr('已就位')}</span> : <span className="g5-miss"><Ico name="warn" small />{tr('缺失')}</span>}</span></div>
          </Fragment>
        ))}
      </div>
      <div className="g5-sec"><span className="g5-tb g5-al">{tr('测试')}</span></div>
      <div className="g5-fg">
        <span className="g5-k" />
        <div className="g5-v"><button type="button" className="g5-btn g5-btn-fill" disabled={off || testing === channel.id} data-act="notify-test" onClick={() => { void send() }}><Ico name="send" />{testing === channel.id ? tr('发送中') : tr('发送测试通知')}</button>
          {result ? <span className="g5-s12 g5-t3">{new Date(result.at).toTimeString().slice(0, 8)}</span> : null}</div>
        {result ? <span className="g5-why g5-rcpt" data-act="notify-test-result">{result.ok ? <span className="g5-ok">{tr('已送达 · ')}{result.text}</span> : <><span className="g5-bad"><Ico name="block" small /></span><span className="g5-hdl g5-t3">{result.text}</span></>}</span> : null}
      </div>
      <Note text={note} />
      <ArmSlot card="detail" />
      <div className="g5-ffoot g5-pin-b">
        <button type="button" className="g5-btn g5-btn-ghost g5-danger g5-lead g5-neg" disabled={off} data-act="channel-delete" onClick={del}>{tr('删除通道')}</button>
        <button type="button" className="g5-btn g5-btn-primary" disabled={off || !dirty || bad.length > 0} data-act="detail-save" onClick={save}>{tr('保存')}</button>
      </div>
      <span hidden data-kind={kind.name} />
    </>
  )
}

function NewChannel({ cfg, config }: { cfg: ReturnType<typeof useCfg>; config: ConfigView }) {
  const bridge = useBridge()
  const [id, setId] = useState('')
  const [plugin, setPlugin] = useState('')
  const [level, setLevel] = useState<Level>('warn')
  const [pairs, setPairs] = useState<Array<[string, string]>>([])
  const [k, setK] = useState('')
  const [v, setV] = useState('')
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string }> | undefined>(undefined)
  const [note, setNote] = useState('')
  useEffect(() => {
    let dead = false
    queryRetry<unknown>(bridge, 'plugin.list', undefined, () => !dead).then((raw) => {
      if (dead) return
      const list = Array.isArray(raw) ? raw : []
      setPlugins(list.flatMap((p) => (typeof p === 'object' && p && typeof (p as { id?: unknown }).id === 'string' && (p as { id: string }).id.includes('notify-')
        ? [{ id: (p as { id: string }).id, name: String((p as { name?: unknown }).name ?? (p as { id: string }).id) }] : [])))
    }, () => { if (!dead) setPlugins([]) })
    return () => { dead = true }
  }, [bridge])
  const off = cfg.offline
  // 参数只收「内核回的句柄名清单」里的名字，值只收 env:VAR 句柄；填了别的东西 = 疑似密钥值：遮蔽、不发
  const names = channelHandles(config, plugin).map((h) => h.key).filter((n) => !pairs.some(([x]) => x === n))
  const vBad = v !== '' && !isHandle(v)
  const idBad = id !== '' && (!ID_RE.test(id) || config.notify.channels.some((c) => c.id === id))
  const ready = id !== '' && !idBad && plugin !== ''
  const create = () => {
    setNote('')
    const params = Object.fromEntries(pairs)
    const patch: Patch = { channels: [...config.notify.channels, { id, plugin, minLevel: level, params }] }
    ask(bridge, { card: 'detail', patch, what: '', confirm: '', after: () => notifyState.set({ selected: `ch:${id}` }) }, setNote)
  }
  return (
    <>
      <div className="g5-fg">
        <span className="g5-k g5-al">{tr('名称')}</span>
        <div className="g5-v"><Inp value={id} label={tr('名称')} disabled={off} bad={idBad} onInput={setId} /><span className="g5-stw">{idBad ? <span className="g5-bad"><Ico name="block" small />{tr('不可用')}</span> : null}</span></div>
        <span className="g5-k g5-al">{tr('插件')}</span>
        <div className="g5-v">{plugins === undefined ? <Skel w={160} /> : plugins.length === 0 ? <span className="g5-t3">{tr('没有已装的通知插件')}</span> : (
          <Menu label={tr('通知插件')} value={plugin} onValueChange={(x) => { setPlugin(x); setPairs([]); setK(''); setV('') }} items={plugins.map((p) => ({ id: p.id, label: p.name }))}
            trigger={<button type="button" className="g5-dd" disabled={off} data-act="plugin-pick">{plugins.find((p) => p.id === plugin)?.name ?? tr('选择插件')}<Ico name="chev" small /></button>} />)}</div>
        <span className="g5-k g5-al">{tr('最低级别')}</span>
        <div className="g5-v"><Seg3 value={level} label={tr('最低级别')} disabled={off} onPick={setLevel} /></div>
        {pairs.map(([pk, pv]) => <Fragment key={pk}><span className="g5-k g5-al">{PARAM_LABEL[pk] ?? pk}</span><div className="g5-v"><span className="g5-tb">{pv}</span><button type="button" className="g5-btn g5-btn-ghost g5-end" onClick={() => setPairs(pairs.filter(([x]) => x !== pk))}>{tr('移除')}</button></div></Fragment>)}
        <span className="g5-k g5-al">{tr('句柄')}</span>
        <div className="g5-v">{names.length === 0 ? <span className="g5-t3">{tr('没有可选的句柄名')}</span> : <>
          <Menu label={tr('句柄名')} value={k} onValueChange={setK} onSelect={setK} items={names.map((n) => ({ id: n, label: n }))}
            trigger={<button type="button" className="g5-dd" disabled={off} data-act="param-pick">{k || tr('选择句柄名')}<Ico name="chev" small /></button>} />
          <Inp value={v} label={tr('句柄值')} mono bad={vBad} wide placeholder="env:NAME" disabled={off} onInput={setV} />
          <button type="button" className="g5-btn g5-btn-ghost" disabled={off || k === '' || !isHandle(v)} data-act="param-add" onClick={() => { setPairs([...pairs, [k, v]]); setK(''); setV('') }}><Ico name="plus" /></button></>}</div>
        {vBad ? <span className="g5-why"><Ico name="block" small />{tr('不是句柄')}</span> : null}
      </div>
      <Note text={note} />
      <ArmSlot card="detail" />
      <div className="g5-ffoot g5-pin-b"><span className="g5-lead g5-s12 g5-t3">{tr('重启后生效')}</span>
        <button type="button" className="g5-btn g5-btn-primary" disabled={off || !ready} data-act="channel-create" onClick={create}>{tr('添加通道')}</button></div>
    </>
  )
}

function RuleDetail({ cfg, config, index }: { cfg: ReturnType<typeof useCfg>; config: ConfigView; index: number | null }) {
  const bridge = useBridge()
  const rules = config.notify.rules ?? []
  const orig = index === null ? undefined : rules[index]
  const [match, setMatch] = useState(orig?.match ?? '')
  const [level, setLevel] = useState<Level>(orig?.level ?? 'warn')
  const [chans, setChans] = useState<string[]>(orig?.channels ?? [])
  const [note, setNote] = useState('')
  useEffect(() => { setMatch(orig?.match ?? ''); setLevel(orig?.level ?? 'warn'); setChans(orig?.channels ?? []) }, [config])
  const off = cfg.offline
  const matchBad = match !== '' && !MATCH_RE.test(match)
  const ready = match !== '' && !matchBad
  const next: NotifyRuleView = { match, level, channels: config.notify.channels.map((c) => c.id).filter((id) => chans.includes(id)) }
  const save = () => {
    setNote('')
    const list = index === null ? [...rules, next] : rules.map((r, i) => (i === index ? next : r))
    ask(bridge, { card: 'detail', patch: { rules: list }, what: '', confirm: '', after: () => { if (index === null) notifyState.set({ selected: `rule:${list.length - 1}` }) } }, setNote)
  }
  const del = () => ask(bridge, { card: 'detail', patch: { rules: rules.filter((_, i) => i !== index) }, danger: true, confirm: tr('确认删除'), what: tr('删除规则 {0}：重启后生效', orig?.match ?? ''), after: () => notifyState.set({ selected: null }) }, setNote)
  return (
    <>
      <div className="g5-fg">
        <span className="g5-k g5-al">{tr('事件')}</span>
        <div className="g5-v"><Inp value={match} label={tr('事件')} mono disabled={off} bad={matchBad} placeholder="takeover.*" onInput={setMatch} /><span className="g5-stw">{matchBad ? <span className="g5-bad"><Ico name="block" small />{tr('格式不对')}</span> : null}</span></div>
        <span className="g5-k g5-al">{tr('级别')}</span>
        <div className="g5-v"><Seg3 value={level} label={tr('级别')} disabled={off} onPick={setLevel} /></div>
        <span className="g5-k g5-al">{tr('通道')}</span>
        <div className="g5-v g5-wrapv">{config.notify.channels.map((c) => (
          <button key={c.id} type="button" className="g5-dd g5-tog" aria-pressed={chans.includes(c.id)} disabled={off} data-chan={c.id} onClick={() => setChans(chans.includes(c.id) ? chans.filter((x) => x !== c.id) : [...chans, c.id])}><ChanLogo plugin={c.plugin} />{c.id}</button>
        ))}</div>
      </div>
      <Note text={note} />
      <ArmSlot card="detail" />
      <div className="g5-ffoot g5-pin-b">
        {index !== null ? <button type="button" className="g5-btn g5-btn-ghost g5-danger g5-lead g5-neg" disabled={off} data-act="rule-delete" onClick={del}>{tr('删除规则')}</button> : <span className="g5-lead g5-s12 g5-t3">{tr('重启后生效')}</span>}
        <button type="button" className="g5-btn g5-btn-primary" disabled={off || !ready} data-act="rule-save" onClick={save}>{index === null ? tr('添加规则') : tr('保存')}</button>
      </div>
    </>
  )
}

export function ChannelDetailCard() {
  const cfg = useCfg(notifyState)
  const st = useStore(notifyState)
  const skeleton = <div className="g5-fg g5-pn"><span className="g5-k"><Skel w={48} /></span><div className="g5-v"><Skel w={224} h={32} /></div><span className="g5-k"><Skel w={32} /></span><div className="g5-v"><Skel w={160} /></div></div>
  const pending = stateBody(cfg, skeleton)
  if (!cfg.config) return <Card head={cfg.loading ? <header className="g5-hd"><Skel w={96} h={20} /></header> : <Head title={tr('详情')} />} className="g5-pgcard" data-notify-view="detail" data-geo="cdetail">{pending}</Card>
  const config = cfg.config
  const sel = st.selected
  const channel = sel?.startsWith('ch:') ? config.notify.channels.find((c) => c.id === sel.slice(3)) : config.notify.channels[0]
  const ruleIndex = sel?.startsWith('rule:') ? Number(sel.slice(5)) : null
  const off = cfg.offline
  const cls = cx('g5-pgcard', off && 'g5-off')
  if (sel === 'new-channel') return <Card head={<Head title={tr('新通道')} />} className={cls} data-notify-view="detail" data-geo="cdetail"><NewChannel cfg={cfg} config={config} /></Card>
  if (sel === 'new-rule') return <Card head={<Head title={tr('新规则')} />} className={cls} data-notify-view="detail" data-geo="cdetail"><RuleDetail key="new" cfg={cfg} config={config} index={null} /></Card>
  if (ruleIndex !== null && (config.notify.rules ?? [])[ruleIndex]) return <Card head={<Head title={<span className="g5-hdl g5-tb">{config.notify.rules![ruleIndex]!.match}</span>} count={tr('规则')} />} className={cls} data-notify-view="detail" data-geo="cdetail"><RuleDetail key={`rule${ruleIndex}`} cfg={cfg} config={config} index={ruleIndex} /></Card>
  if (!channel) return <Card head={<Head title={tr('详情')} />} className={cls} data-notify-view="detail" data-geo="cdetail"><PageMsg><span className="g5-al g5-t3">{tr('选中通道后在这里编辑')}</span></PageMsg></Card>
  const head = <header className="g5-hd"><span className="g5-cell g5-al"><ChanLogo plugin={channel.plugin} /><h2>{channel.id}</h2><span className="g5-ct">{channelKind(channel.plugin).name}</span></span>{off ? <div className="g5-r"><OffNote elapsed={cfg.elapsed} /></div> : null}</header>
  return <Card head={head} className={cls} data-notify-view="detail" data-geo="cdetail"><ChannelDetail key={channel.id} cfg={cfg} config={config} channel={channel} /></Card>
}
