// SPDX-License-Identifier: CPAL-1.0
// 「谁做的」（视觉 r4 §4）：7px 小形状 + 名字，不加胶囊。LLM Agent ◆ 实心菱形｜引擎 □ 空心方｜人 ● 实心圆｜系统 ○ 空心圆；全部中性 text-2 / text-3，不着橙。
// 用法：<ActorMark origin={entry.origin} name="Claude Code" />（origin 带 actorType / actor，内核盖章）；或 <ActorMark actor="agent:ak_1" />、<ActorMark kind="host" />。nameless 只画形状。
import { actorKind, actorWord } from '../../core/actor'
import { Segmented } from './core.jsx'
import { ACTOR_FILTERS } from '../../core/actor'
import { t } from '../lib/i18n.js'

/** llm=true：名字后面带「LLM」小字（r4：Geist 11、+.04em、text-3、无框；PLAN ⑧——大模型来源永远带标记）。 */
export function ActorMark({ origin, actor, kind, name, nameless = false, llm = false, className = '' }) {
  const k = kind || actorKind(origin || actor)
  const text = name || actorWord(k)
  return (
    <span className={['gr-actor', 'gr-actor--' + k, className].filter(Boolean).join(' ')} title={nameless ? text : undefined}>
      <i aria-hidden="true" />{nameless ? <span className="gr-sr">{text}</span> : text}{llm ? <b className="gr-actor__llm">LLM</b> : null}
    </span>
  )
}

/** 来源筛选器（检阅块的固定件）：全部 / 人 / 引擎 / LLM Agent / 系统。value 是 ACTOR_FILTERS 的 id；配合 matchesActorFilter(origin, value)。 */
export function ActorFilter({ value, onChange, size = 'sm', className = '' }) {
  return <Segmented value={value} options={ACTOR_FILTERS} onChange={onChange} size={size} label={t('来源')} className={className} />
}
