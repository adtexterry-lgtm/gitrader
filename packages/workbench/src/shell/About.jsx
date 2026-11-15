// SPDX-License-Identifier: CPAL-1.0
// 关于（PLAN ㉖ / IXD 流程 11）：居中 520 一列——字标原件（图高 28）→ 版本 → 分组卡（许可证 / 安全边界 / 图表 / 第三方声明 ›）→ 署名徽标。
// 第三方声明是右侧抽屉（A 的 DialogShell：焦点陷阱、Esc、关闭后焦点回到触发行）；地址是可选中的等宽文本，不做链接（全页只有署名一个外链入口）。
import { useEffect, useRef, useState } from 'preact/hooks'
import { readHealth } from '../core/health'
import { Page } from '../ui/components/core.jsx'
import { Icon } from '../ui/components/Icon.jsx'
import { DialogShell } from '../ui/components/radix.jsx'
import { Wordmark } from './brand.jsx'
import { restoreFocus } from './hooks.js'
import { t } from '../ui/lib/i18n.js'

/** 壳打进包里的第三方组件与改写来源（完整许可证文本见仓库根的 THIRD-PARTY-NOTICES.md；不经 npm 的几项列在 scripts/notices-manual.json）。 */
export const NOTICES = [
  { name: 'KLineChart', license: 'Apache-2.0', url: 'https://github.com/klinecharts/KLineChart', note: t('版权所有 © 2019 lihu；含 TradingView, Inc. 版权声明（© 2019）。K 线图表由 KLineChart 提供（含 TradingView 署名）。') },
  { name: 'Preact', license: 'MIT', url: 'https://preactjs.com/', note: t('版权所有 © Jason Miller 与 Preact 贡献者。') },
  { name: 'Radix Primitives', license: 'MIT', url: 'https://github.com/radix-ui/primitives', note: t('版权所有 © 2022 WorkOS。对话框、下拉菜单、弹出卡。') },
  { name: 'Tailwind CSS', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss', note: t('版权所有 © Tailwind Labs, Inc.。构建期生成的样式。') },
  { name: 'Geist / Geist Mono', license: 'OFL-1.1', url: 'https://github.com/vercel/geist-font', note: t('版权所有 © 2024 The Geist Project Authors。界面字体。') },
  { name: 'shadcn/ui', license: 'MIT', url: 'https://github.com/shadcn-ui/ui', note: t('版权所有 © 2023 shadcn。组件配方改写。') },
  { name: 'Beautiful UI', license: 'MIT', url: 'beautifului.dev/license', note: t('版权所有 © 2026 Shane Levine。组件结构与交互改写。') },
  { name: 'beUI', license: 'MIT', url: 'https://github.com/starc007/ui-components', note: t('版权所有 © 2026 Saurabh Chauhan。组件状态机与结构改写。') },
]

/** 许可证署名位的链接（CTO 裁决 7：先指 GitHub 仓库，域名定了再换）。整枚「Powered by Gitrader」徽标是链接，新窗口打开。 */
export const POWERED_BY_HREF = 'https://github.com/adtexterry-lgtm/gitrader'

/** 署名徽标：文字 + 字标原件 + 链接位。徽标底色 = 字标底色，原件的深色矩形与徽标融为一体。 */
function PoweredBy() {
  const body = <><span className="gr-attr__t">Powered by</span><Wordmark height={16} /></>
  return POWERED_BY_HREF
    ? <a className="gr-attr" data-slot="powered-by" href={POWERED_BY_HREF} target="_blank" rel="noopener noreferrer">{body}</a>
    : <span className="gr-attr" data-slot="powered-by">{body}</span>
}

export function About() {
  const [open, setOpen] = useState(false)
  // 版本取自内核健康快照（跨包契约 K2）：以前读工作台包自己的 package.json，发版时忘了改就会写成上一个版本
  const [version, setVersion] = useState('')
  useEffect(() => { let on = true; readHealth().then((h) => { if (on && h.version) setVersion(h.version) }, () => {}); return () => { on = false } }, [])
  const opener = useRef(null) // DialogShell 没有 Radix Trigger：Radix 关闭时只会把焦点还给（不存在的）trigger，这里自己还给打开它的那一行
  return (
    <Page fill>
      <div className="gr-about">
        <h1 className="gr-sr">{t('关于')}</h1>
        <Wordmark height={28} className="gr-about__mark" />
        <div className="gr-about__ver gr-num" data-slot="version">{version || '—'}</div>
        <div className="gr-about__card">
          <div className="gr-about__row"><span className="gr-about__k">{t('许可证')}</span><span className="gr-about__v">{t('CPAL-1.0 开源')}</span></div>
          <div className="gr-about__row"><span className="gr-about__k">{t('安全边界')}</span><span className="gr-about__v">{t('同一系统用户下的恶意代码不在保证范围')}</span></div>
          <div className="gr-about__row"><span className="gr-about__k">{t('图表')}</span><span className="gr-about__v">{t('K 线图表由 KLineChart 提供（含 TradingView 署名，')}<span className="gr-nowrap">Apache-2.0</span>{t('）')}</span></div>
          <button type="button" className="gr-about__row gr-about__more" data-act="notices" onClick={(e) => { opener.current = e.currentTarget; setOpen(true) }}>
            <span className="gr-about__k">{t('第三方声明')}</span><Icon name="chevron-right" size={14} />
          </button>
        </div>
        <PoweredBy />
      </div>
      <DialogShell open={open} onOpenChange={setOpen} title={t('第三方声明')} level="drawer" placement="right" className="gr-notices" onCloseAutoFocus={(e) => { e.preventDefault(); restoreFocus(opener.current) }}>
        <button type="button" className="gr-notices__x" aria-label={t('关闭')} data-act="notices-close" onClick={() => setOpen(false)}><Icon name="close" size={16} /></button>
        <ul className="gr-notices__list">
          {NOTICES.map((n) => (
            <li key={n.name} className="gr-notices__i">
              <div className="gr-notices__t">{n.name}<span className="gr-notices__l gr-num">{n.license}</span></div>
              <div className="gr-notices__d">{n.note}</div>
              <div className="gr-notices__u gr-mono">{n.url}</div>
            </li>
          ))}
        </ul>
      </DialogShell>
    </Page>
  )
}
