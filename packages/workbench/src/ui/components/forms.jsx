// SPDX-License-Identifier: CPAL-1.0
// 表单组件：Field 外壳 + 输入 / 数字 / 密码 / PIN 点阵 / 滑条 / 开关 / 下拉。全部受控；控件高 32（sm 28），圆角 8。
import { useEffect, useRef, useState } from 'preact/hooks'
import * as F from '../lib/format.js'
import { useMedia } from '../lib/hooks.js'
import { shake } from '../motion.js'
import { Icon } from './Icon.jsx'
import { InfoTip } from './Tooltip.jsx'
import { t as tr } from '../lib/i18n.js'

const cx = (...a) => a.filter(Boolean).join(' ')
let uid = 0
const nextId = () => 'gr-f' + (uid += 1)

/** 字段外壳：label（上）+ 控件 + hint/error（下）。inline=true 时 label 在左、控件在右（设置行）。 */
export function Field({ label, hint, error, inline = false, right, children, className = '' }) {
  return (
    <div className={cx('gr-field', inline && 'gr-field--inline', error && 'is-invalid', className)}>
      {label != null ? <div className="gr-field__label"><span className="gr-field__lt">{label}{hint ? <InfoTip text={hint} /> : null}</span>{right ? <span className="gr-field__right">{right}</span> : null}</div> : null}
      <div className="gr-field__ctl">{children}</div>
      {error ? <div className="gr-field__err" role="alert">{error}</div> : null}
    </div>
  )
}

/** 文本输入。prefix/suffix 是控件内的静态文字（如 USDC、×）。onChange(value:string)。size: md（32，默认）| sm（r4 新增：28 高、字 12）。 */
export function TextInput({ value, onChange, placeholder, type = 'text', prefix, suffix, invalid, disabled, maxLength, onEnter, className = '', inputRef, size = 'md', ...rest }) {
  return (
    <label className={cx('gr-input', size === 'sm' && 'gr-input--sm', invalid && 'is-invalid', disabled && 'is-disabled', className)}>
      {prefix ? <span className="gr-input__fix">{prefix}</span> : null}
      <input ref={inputRef} type={type} value={value ?? ''} placeholder={placeholder} disabled={disabled} maxLength={maxLength} autocomplete="off" spellcheck={false}
        onInput={(e) => onChange && onChange(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter(e) }} {...rest} />
      {suffix ? <span className="gr-input__fix">{suffix}</span> : null}
    </label>
  )
}

/**
 * 数字输入。value 为 number|null；onChange(number|null)。输入过程保留原始文本（不吞「0.」），失焦时规整。
 * decimals 限制小数位；min/max 仅在失焦时钳制。size: md | sm（r4 新增，28 高）。
 * 其余属性（aria-label、data-*、name…，r4 新增）原样落到原生 input 上；输入 / 焦点 / 按键处理以组件自己的为准，不被覆盖。
 */
export function NumberInput({ value, onChange, min, max, step = 1, decimals, placeholder, prefix, suffix, invalid, disabled, className = '', onEnter, size = 'md', ...rest }) {
  const [text, setText] = useState(value == null ? '' : String(value))
  const focus = useRef(false)
  useEffect(() => { if (!focus.current) setText(value == null || Number.isNaN(value) ? '' : String(value)) }, [value])
  const clamp = (n) => {
    let v = n
    if (F.isNum(min) && v < min) v = min
    if (F.isNum(max) && v > max) v = max
    if (Number.isInteger(decimals)) v = Number(v.toFixed(decimals))
    return v
  }
  const commit = (raw) => {
    const t = raw.replace(/,/g, '').trim()
    if (t === '' || t === '-' || t === '.') { onChange(null); return }
    const n = Number(t)
    if (Number.isFinite(n)) onChange(n)
  }
  const bump = (dir) => {
    const base = F.isNum(value) ? value : (F.isNum(min) ? min : 0)
    const v = clamp(base + dir * step)
    setText(String(v)); onChange(v)
  }
  return (
    <label className={cx('gr-input gr-input--num', size === 'sm' && 'gr-input--sm', invalid && 'is-invalid', disabled && 'is-disabled', className)}>
      {prefix ? <span className="gr-input__fix">{prefix}</span> : null}
      <input {...rest} type="text" inputMode="decimal" value={text} placeholder={placeholder} disabled={disabled} autocomplete="off" spellcheck={false}
        onFocus={() => { focus.current = true }}
        onInput={(e) => {
          const raw = e.currentTarget.value
          if (!/^-?[\d,]*\.?\d*$/.test(raw)) return
          if (Number.isInteger(decimals) && raw.includes('.') && raw.split('.')[1].length > decimals) return
          setText(raw); commit(raw)
        }}
        onBlur={() => { focus.current = false; const n = text === '' ? null : Number(text.replace(/,/g, '')); if (n !== null && Number.isFinite(n)) { const v = clamp(n); setText(String(v)); if (v !== n) onChange(v) } else setText('') }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); bump(1) } else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1) } else if (e.key === 'Enter' && onEnter) onEnter(e)
        }} />
      {suffix ? <span className="gr-input__fix">{suffix}</span> : null}
    </label>
  )
}

/** 密码框：已保存时显示 ••••尾4位（savedTail），输入新值覆盖；onChange(string)。reveal=false 时没有「显示」按钮（私钥、PIN 永远不明文显示）。 */
export function PasswordInput({ value, onChange, savedTail, placeholder = tr('输入密钥'), disabled, className = '', reveal = true, ...rest }) {
  const [show, setShow] = useState(false)
  const ph = savedTail ? '••••••••' + savedTail : placeholder
  return (
    <label className={cx('gr-input', disabled && 'is-disabled', className)}>
      <input type={show && reveal ? 'text' : 'password'} value={value ?? ''} placeholder={ph} disabled={disabled} autocomplete="new-password" spellcheck={false} onInput={(e) => onChange(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && rest.onEnter) rest.onEnter(e) }} inputMode={rest.inputMode} maxLength={rest.maxLength} aria-label={rest['aria-label']} />
      {reveal ? <button type="button" className="gr-input__btn" aria-label={show ? tr('隐藏') : tr('显示')} onClick={() => setShow(!show)}><Icon name={show ? 'lock' : 'eye'} size={14} /></button> : null}
    </label>
  )
}

/**
 * PIN / 口令输入（IXD F2-1：不是 PinDots）。接受任意字符、上限 maxLength（64）、不剥字符；内核规则见 kernel/src/pin.ts（6–12 位数字或 8–64 位口令）。
 * 纯数字且 ≤ 12 位时画点阵（至少 6 个点，已输位实心）；超过 12 位或含非数字时换成「已输入 N 位」。透明的原生 <input type=password> 盖在点阵上
 * （选择器 `.gr-pinfield input`），inputmode 缺省 text；粗指针设备（手机）多一个「123 / Abc」切换钮。onEnter 只在长度 ≥ minLength（6）时触发。
 * shakeKey 变了就抖一下（减少动效时不抖，调用方另给红字原文）。关闭自动填充，并带常见密码管理器的忽略属性（PIN 是在场证明）。
 */
export function PinField({ value, onChange, onEnter, minLength = 6, maxLength = 64, disabled, invalid, autoFocus, inputRef, label = 'PIN', shakeKey, describedBy, className = '' }) {
  const box = useRef(null)
  const own = useRef(null)
  const ref = inputRef || own
  const coarse = useMedia('(pointer: coarse)')
  const [numeric, setNumeric] = useState(false)
  const v = value ?? ''
  const n = v.length // 与内核 pin.ts 同一口径（UTF-16 长度）
  const dotted = /^[0-9]*$/.test(v) && n <= 12
  useEffect(() => { if (shakeKey && box.current) shake(box.current) }, [shakeKey])
  return (
    <div ref={box} className={cx('gr-pinfield', invalid && 'is-invalid', disabled && 'is-disabled', className)} data-pin-count={n}>
      <span className="gr-pinfield__box">
        {dotted
          ? <span className="gr-pinfield__dots" aria-hidden="true">{Array.from({ length: Math.max(6, n) }, (_, i) => <i key={i} className={cx('gr-pinfield__dot', i < n && 'is-on')} />)}</span>
          : <span className="gr-pinfield__count gr-num" aria-hidden="true">{tr('已输入 {0} 位', n)}</span>}
        <input ref={ref} type="password" value={v} disabled={disabled} autoFocus={autoFocus} aria-label={label} aria-invalid={invalid ? 'true' : undefined} aria-describedby={describedBy}
          inputMode={numeric ? 'numeric' : 'text'} maxLength={maxLength} autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
          data-1p-ignore="" data-lpignore="true" data-bwignore="" data-form-type="other"
          onInput={(e) => onChange && onChange(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && onEnter && n >= minLength) onEnter(e) }} />
      </span>
      {coarse ? <button type="button" className="gr-pinfield__mode" aria-label={numeric ? tr('换成文本键盘') : tr('换成数字键盘')} onClick={() => { setNumeric(!numeric); if (ref.current) ref.current.focus() }}>{numeric ? 'Abc' : '123'}</button> : null}
    </div>
  )
}

/** 滑条。marks: [{value,label}]（刻度文字）；format(v) 控制右侧读数；readout=false 关掉读数。 */
export function Slider({ value, min = 0, max = 100, step = 1, onChange, marks, format, readout = true, disabled, label, className = '' }) {
  const v = F.isNum(value) ? value : min
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0
  return (
    <div className={cx('gr-slider', disabled && 'is-disabled', className)}>
      <div className="gr-slider__row">
        <div className="gr-slider__track" style={{ '--gr-pct': pct + '%' }}>
          <input type="range" min={min} max={max} step={step} value={v} disabled={disabled} aria-label={label} onInput={(e) => onChange(Number(e.currentTarget.value))} />
        </div>
        {readout ? <span className="gr-slider__val gr-num">{format ? format(v) : v}</span> : null}
      </div>
      {marks ? (
        <div className="gr-slider__marks" aria-hidden="true">
          {marks.map((m) => <span key={m.value} style={{ left: (max > min ? ((m.value - min) / (max - min)) * 100 : 0) + '%' }}>{m.label}</span>)}
        </div>
      ) : null}
    </div>
  )
}

/** 开关。tone: accent(默认) | danger（熔断类）。label 显示在右侧。 */
export function Switch({ checked, onChange, label, tone = 'accent', disabled, title, className = '' }) {
  const id = useRef(nextId()).current
  return (
    <span className={cx('gr-switchwrap', className)} title={title}>
      <button type="button" role="switch" id={id} className={cx('gr-switch', tone === 'danger' && 'gr-switch--danger')} aria-checked={!!checked} aria-label={typeof label === 'string' ? label : undefined} disabled={disabled} onClick={() => onChange(!checked)} />
      {label ? <label htmlFor={id} className="gr-switchwrap__l">{label}</label> : null}
    </span>
  )
}

/** 下拉（原生 select，统一外观）。options: [{id,label,disabled?}]；onChange(id)。 */
export function Select({ value, options, onChange, placeholder, disabled, invalid, className = '', label }) {
  return (
    <label className={cx('gr-input gr-input--select', invalid && 'is-invalid', disabled && 'is-disabled', className)}>
      <select value={value ?? ''} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.currentTarget.value)}>
        {placeholder ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((o) => <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}</option>)}
      </select>
      <Icon name="chevron-down" size={14} className="gr-input__chev" />
    </label>
  )
}
