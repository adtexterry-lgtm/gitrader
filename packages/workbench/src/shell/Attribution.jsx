// SPDX-License-Identifier: CPAL-1.0
// CPAL-1.0（Exhibit B）署名页脚（ADR-11）：启动 / 连接中与会话失效卡底部各挂一次。
// 三件套照关于页：字标原件 + 「Powered by」文字 + 项目链接；新窗口打开，且不可由配置关闭（不读任何开关）。
import { Wordmark } from './brand.jsx'

/** 项目链接（与关于页署名位一致：先指仓库，域名定了再换）。 */
export const ATTRIBUTION_HREF = 'https://github.com/adtexterry-lgtm/gitrader'

/** 一行小字页脚：字标 + 文字 + 链接，只用关于页现成的 gr-attr 令牌类。 */
export function Attribution() {
  return (
    <a className="gr-attr" data-slot="attribution" href={ATTRIBUTION_HREF} target="_blank" rel="noopener" style={{ alignSelf: 'center', marginTop: 'var(--gr-s5)' }}>
      <span className="gr-attr__t">Powered by</span>
      <Wordmark height={16} />
    </a>
  )
}
