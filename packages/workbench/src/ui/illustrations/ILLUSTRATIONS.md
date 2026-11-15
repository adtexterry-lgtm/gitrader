# Gitrader 空态插画 v3

> 视觉总监 Opus 5.5 · 2026-10-09。6 幅（规范要求 5 幅 + 钱包页新增 1 幅）。对照板：`contact-sheet-illustrations.png`。
> 唯一真源：`app/ui/design/tools/build-illustrations.mjs`；改完运行它重新生成本目录。

## 清单

| id | 中文 | 用在哪 |
|---|---|---|
| `no-positions` | 无持仓 | 持仓表、总览持仓、钱包持仓 |
| `no-signals` | 无信号 | 信号流、交易页「Agent 的动作」 |
| `no-proposals` | 无提案 | 编排页提案列表、总览「现在」里的待确认 |
| `no-data` | 无数据 | 曲线 / 图表 / 决策回放还没有样本 |
| `offline` | 断网 | 服务未连接、行情中断（整块区域） |
| `no-wallet` | 未连接钱包 | 钱包页主钱包、观察地址空列表 |

## 语言

- 等轴测（30°）单线；结构线灰、**只有一处橙色「光」**（悬浮物 / 信号 / 断口火花）。这就是「3D 立体 + Web3」在轻薄界面里的落点：用线画出体积，不用渐变与阴影。
- 160 × 120 视窗；常用尺寸 120 × 90（面板内居中）与 72 × 54（紧凑：插画左置 + 一句话 + 右侧一个次要动作，见对照板下排）。
- 空态 = 插画 + 一句话（≤ 12 字）+ 至多一个次要动作；不写解释句，不放图标。

## 接线（施工员 F）

`EmptyState` 增加 `art` 属性：有 `art` 时渲染插画、不再渲染 `icon`：
```jsx
import { illustrationSvg } from '../illustrations/index.js'
<span class="gr-empty__art" dangerouslySetInnerHTML={{ __html: illustrationSvg(art, compact ? 72 : 120) }} />
```
`components.css` 加（颜色只走令牌，`--gr-il-*` 在 `design/tokens-v3.css`）：
```css
.gr-il .b { stroke: var(--gr-il-base); stroke-width: 1.25; }
.gr-il .b2 { stroke: var(--gr-il-base); stroke-width: 1.25; opacity: .55; }
.gr-il .b3 { stroke: var(--gr-il-base); stroke-width: 1.25; opacity: .35; }
.gr-il .k { stroke: var(--gr-il-key); stroke-width: 1.5; }
.gr-il .k2 { stroke: var(--gr-il-key); stroke-width: 1.5; opacity: .45; }
.gr-il .kf { fill: var(--gr-il-key); stroke: none; }
.gr-il .kf2 { fill: var(--gr-il-key); stroke: none; opacity: .55; }
.gr-il .tf { fill: var(--gr-il-face); stroke: none; }
```
动效：首次出现时橙色那一笔做一次 `drawPath`（600 ms），之后静止；不再用 6 s 上下漂浮（`.float` 删除）。独立的 `.svg` 文件内置了命名色兜底（`dimgray` / `darkorange`），只用于单独打开预览；打包进应用一律用 `index.js` 的无样式版本，不会触发色值扫描。
