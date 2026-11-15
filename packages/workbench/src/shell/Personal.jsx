// SPDX-License-Identifier: CPAL-1.0
// 设置 · 个性化（r5 壳内件）：只两项——导航形态、涨跌配色。偏好不是交易数据、不经内核：切换只改 html[data-nav] / html[data-updown] 并写 prefs
// （字段 navForm: 'top'|'rail'、updown: 'intl'|'cn'，由 S1 在 core/prefs.ts 追加；没追加前 PrefsStore 会丢掉这两个未知键，页面当次照常生效）。
// 预览瓦片不随全站模式：每块瓦片自己把 --gr-up / --gr-down 钉死（样式在 personal.css），只引用语义令牌。
// 页面自带工作区外框（.g5-ws，单列），S1 在 Settings.jsx 里直接渲染 <Personal /> 即可。
import { useEffect, useState } from 'preact/hooks'
import { getPrefsStore } from '../ui/lib/layout.js'
import './personal.css'
import { t, getLang } from '../ui/lib/i18n.js'

const root = () => document.documentElement
const readNav = () => (root().getAttribute('data-nav') === 'rail' ? 'rail' : 'top')
const readUpdown = () => (root().getAttribute('data-updown') === 'cn' ? 'cn' : 'intl')

// [左 %, 影线顶 %, 影线底 %, 实体顶 %, 实体底 %, 方向]（取自设计稿 settings-personal）
const CANDLES = [
  [3.57, 54, 26, 58, 30, 'u'], [10.71, 53, 34, 58, 38, 'd'], [17.86, 44, 36, 48, 38, 'u'], [25, 42, 44, 48, 49, 'd'], [32.14, 36, 47, 39, 49, 'u'],
  [39.29, 34, 52, 39, 56, 'd'], [46.43, 41, 46, 44, 50, 'd'], [53.57, 32, 48, 36, 50, 'u'], [60.71, 24, 60, 28, 64, 'u'], [67.86, 25, 62, 28, 66, 'd'],
  [75, 26, 63, 30, 66, 'u'], [82.14, 14, 68, 18, 70, 'u'], [89.29, 12, 73, 18, 77, 'd'], [96.43, 10, 74, 16, 77, 'u'],
]
const px = (left, top, bottom) => ({ left: left + '%', top: top + '%', bottom: bottom + '%' })

const Check = () => (
  <svg className="g5-i g5-pck" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4 4 9-9" /></svg>
)

function Opt({ group, value, pressed, onPick, label, tag, first, children }) {
  return (
    <button type="button" className="g5-popt" aria-pressed={pressed} data-k={group} data-v={value} onClick={() => onPick(value)}>
      {children}
      <span className="g5-pol"><span className={first ? 'g5-pcks g5-al' : 'g5-pcks'}><Check /></span><span className="g5-t1">{label}</span>{tag ? <span className="g5-s12 g5-t3">{tag}</span> : null}</span>
    </button>
  )
}

const Panes = () => (
  <span className="g5-psws"><span><i data-c="1" /><i data-c="2" /></span><span><i data-c="3" /><i data-c="4" /></span></span>
)
const TopPreview = () => (
  <span className="g5-ppvw g5-pscr">
    <span className="g5-pbar"><i data-m="wm" /><i /><i /><i /><i /><i data-m="g2" /><i /><i /><i data-m="sp" /><i /></span>
    <i className="g5-psf" /><Panes />
  </span>
)
const RailPreview = () => (
  <span className="g5-ppvw g5-pscr g5-prailv">
    <span className="g5-prl"><i data-m="wm" /><i data-m="on" /><i /><i /><i /><b /><i /><i /><i data-m="ft" /><i /></span>
    <i className="g5-psf" /><Panes />
  </span>
)
const UpdownPreview = ({ mode }) => (
  <span className="g5-ppvw g5-pud" data-updown={mode}>
    <span className="g5-pcdl">
      {CANDLES.map(([l, wt, wb, bt, bb, d]) => (
        <span key={l}><b style={px(l, wt, wb)} /><i data-d={d} style={px(l, bt, bb)} /></span>
      ))}
    </span>
    <span className="g5-ppn"><span className="g5-up">+1.24%</span><span className="g5-down">−0.86%</span><span className="g5-up">+48.16</span><span className="g5-down">−90.00</span></span>
  </span>
)

// 语言：分段控件放在「导航」卡底部一行，选项用各自的语言标注（中文 / English），不翻译；切换 = 写偏好，boot.js 订阅到后重新加载页面。

/** 本机存储探一下：写不进去（隐私模式 / 被禁）就如实说「仅本次有效」。 */
function storageWorks() {
  try { const k = 'gitrader.prefs.probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true } catch { return false }
}

export function Personal() {
  const [nav, setNav] = useState(readNav)
  const [updown, setUpdown] = useState(readUpdown)
  const [unsaved, setUnsaved] = useState(false)
  // S1 / 命令面板也会改这两个属性：以 <html> 上的值为准
  useEffect(() => {
    const mo = new MutationObserver(() => { setNav(readNav()); setUpdown(readUpdown()) })
    mo.observe(root(), { attributes: true, attributeFilter: ['data-nav', 'data-updown'] })
    return () => mo.disconnect()
  }, [])
  const pick = (patch) => {
    if (patch.navForm) root().setAttribute('data-nav', patch.navForm)
    if (patch.updown) root().setAttribute('data-updown', patch.updown)
    getPrefsStore().set(patch)
    setUnsaved(!storageWorks())
  }
  return (
    <div className="g5-ws g5-pers">
      <div className="g5-col">
        <section className="g5-card g5-grow" data-g5="card" id="nav" data-geo="nav" aria-label={t('导航')}>
          <header className="g5-hd"><h2 className="g5-al">{t('导航')}</h2></header>
          <div className="g5-popts" role="group" aria-label={t('导航')}>
            <Opt group="nav" value="top" first pressed={nav === 'top'} onPick={(v) => pick({ navForm: v })} label={t('顶栏')} tag={t('缺省')}><TopPreview /></Opt>
            <Opt group="nav" value="rail" pressed={nav === 'rail'} onPick={(v) => pick({ navForm: v })} label={t('左侧图标栏')}><RailPreview /></Opt>
          </div>
          <div className="g5-plangrow" data-act="lang-row"><span className="g5-s12 g5-t3">{t('语言')}</span><div className="g5-seg" role="group" aria-label={t('语言')}>
            <button type="button" aria-pressed={getLang() === 'zh'} data-k="lang" data-v="zh" onClick={() => getPrefsStore().set({ lang: 'zh' })}>中文</button>
            <button type="button" aria-pressed={getLang() === 'en'} data-k="lang" data-v="en" onClick={() => getPrefsStore().set({ lang: 'en' })}>English</button>
          </div></div>
        </section>
        <section className="g5-card g5-grow" data-g5="card" id="updown" data-geo="updown" aria-label={t('涨跌配色')}>
          <header className="g5-hd"><h2 className="g5-al">{t('涨跌配色')}</h2></header>
          <div className="g5-popts" role="group" aria-label={t('涨跌配色')}>
            <Opt group="updown" value="intl" first pressed={updown === 'intl'} onPick={(v) => pick({ updown: v })} label={t('绿涨红跌')} tag={t('国际　缺省')}><UpdownPreview mode="intl" /></Opt>
            <Opt group="updown" value="cn" pressed={updown === 'cn'} onPick={(v) => pick({ updown: v })} label={t('红涨绿跌')} tag={t('中国')}><UpdownPreview mode="cn" /></Opt>
          </div>
          {unsaved ? (
            <div className="g5-psavewarn" data-act="unsaved"><svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5l8.5 15h-17L12 4.5z" /><path d="M12 10.5v4" /><path d="M12 17.25v.01" /></svg>{t('无法保存，仅本次有效')}</div>
          ) : null}
        </section>
      </div>
    </div>
  )
}
