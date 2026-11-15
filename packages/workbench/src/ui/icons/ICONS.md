# Gitrader 图标集 v3 · 清单与使用规范

> 视觉总监 Opus 5.5 · 2026-10-09。74 个：导航 17 · 功能 24 · 派生 5 · 业务补充 28。对照板：`contact-sheet-icons.png`。
> 唯一真源：`app/ui/design/tools/build-icons.mjs`（改图标只改那里，再运行 `node app/ui/design/tools/build-icons.mjs` 重新生成本目录的 SVG 与 `index.js`）。

## 1. 规格

| 项 | 值 |
|---|---|
| 网格 | 24 × 24，活动区 2–22（四周留 2） |
| 描边 | 1.5（16 px 显示时约 1 px）；`stroke-linecap: round; stroke-linejoin: round`；不填充 |
| 圆 | 外径 17–18（`r` 8.5 左右）；小点用 `r .6` 的圆（描边后成 2.7 实点） |
| 方形 | 17 × 15 或 17 × 13，圆角 2–2.5；小块 5–7，圆角 1.25–2 |
| 角度 | 0° / 45° / 90° 为主；曲线用三次贝塞尔，起止切线水平或垂直 |
| 结构 | 一个图标 = 一个 `path d`（与现有 `Icon` 组件的 `ICON_PATHS` 完全兼容） |
| 颜色 | 只用 `currentColor`；不写色值 |

## 2. 尺寸与颜色

| 场景 | 尺寸 | 颜色 |
|---|---|---|
| 侧栏导航 | 16 | 默认 `--gr-text-3`；悬停 `--gr-text-2`；**选中 `--gr-accent`（橙）**，文字白（选中态体系 §6） |
| 按钮内 | md 14 · sm 14 · xs 12 · lg 16 | 跟随按钮文字色；实心橙 / 红按钮上为白色 + 凹刻（见 §4） |
| 行内（表格、列表、元信息） | 12 / 14 | `--gr-text-3`，悬停该行时 `--gr-text-2` |
| 节点画布、卡片头 | 14 / 16 / 18 | 默认 `--gr-text-2`；选中 / 当前项 `--gr-accent` |
| 空态 | **不用图标**，用 `src/illustrations/` 的插画 | — |

橙色图标只表示两件事：**当前位置**（导航选中、画布选中节点）与**正在运行**（运行中的单元、流水线活跃节点）。其余一律中性灰。

## 3. 橙色玻璃铬球（`.icon-orb`）的使用上限

圆球是材质英雄位，**全站最多 4 处、每页最多 1 颗**：

1. 插卡台主控「启动操盘」（44 px，运行中换成中性 L3 + 停止字形）；
2. 商店精选位（40 px，一次只 1 个）；
3. 编排页「运行中」总开关旁（40 px，可选）；
4. 品牌应用图标 / 关于页（H 定稿后）。

其余所有卡片、列表行、节点、状态卡**一律改用中性图标块**：28 px 方块、`--gr-raised` 底、圆角 7、内高光 `inset 0 1px 0 rgba(255,255,255,.04)`、图标 16 `--gr-text-2`。现有页面上的 44 颗球（实测）按逐页清单移除。

## 4. 橙底上的字形：白色 + 轻微凹刻（维护者 10-09 硬规则）

橙色圆球 / 实心橙按钮 / 实心橙徽标上的字形与文字**一律白色**，**禁止橙底黑字形**。凹刻两种实现：

**A. CSS（16 / 24 px：按钮、徽标、标签里的小图标与文字）**
```css
.gr-btn--primary { color: #FFFFFF; text-shadow: 0 -0.5px 0 rgba(0,0,0,.30), 0 0.5px 0 rgba(255,255,255,.16); }
.gr-btn--primary .gr-icon { filter: drop-shadow(0 -0.5px 0 rgba(0,0,0,.32)) drop-shadow(0 0.5px 0 rgba(255,255,255,.18)); }
```
令牌：`--gr-deboss-text`、`--gr-deboss-icon`（见 `design/tokens-v3.css`）。

**B. SVG 内阴影（40 px 圆球里的 18–22 px 字形）**：壳里放一次 `<defs>`，字形 `path` 加 `filter="url(#gr-deboss)"`：
```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <filter id="gr-deboss" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
    <feOffset in="SourceAlpha" dy="0.7" result="down"/>
    <feComposite in="SourceAlpha" in2="down" operator="out" result="topEdge"/>
    <feGaussianBlur in="topEdge" stdDeviation="0.25" result="topEdgeBlur"/>
    <feFlood flood-color="black" flood-opacity="0.34"/>
    <feComposite in2="topEdgeBlur" operator="in" result="innerShadow"/>
    <feComposite in="down" in2="SourceAlpha" operator="out" result="bottomRim"/>
    <feFlood flood-color="white" flood-opacity="0.22"/>
    <feComposite in2="bottomRim" operator="in" result="rimLight"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="innerShadow"/><feMergeNode in="rimLight"/></feMerge>
  </filter>
</defs></svg>
```
参数随 viewBox 缩放（24 单位制）：顶内阴影偏移 0.7、模糊 0.25、黑 .34；底缘亮边白 .22。16 / 24 / 40 三档对比见 `design/spec-sheet-v3.png`「橙底字形」一格。实心橙面白字对比约 2.6–3.4:1，所以**橙底只承载 2–4 个字的按钮 / 徽标 / 图标，不承载句子**；字重用 600。

## 5. 接线（施工员 F）

`components/Icon.jsx` 只改取数，不改调用点：
```js
import { resolveIcon } from '../icons/index.js'
// <path d={resolveIcon(name) || ICON_PATHS[name] || ICON_PATHS.system} />
```
`resolveIcon` 先查新名，再查 `GR_ICON_ALIASES`（旧名 → 新名，见 §7），现有页面的 `icon="sparkle"`、`name="cube"` 等全部自动映射。G 的 `pages/deck/shared/ico.jsx` 删掉 `EXTRA`，改为直接用 `Icon`。非 Preact 场景用 `iconSvg(name, size)` 取整段 SVG 字符串。

## 6. 不要

- 不用 emoji、不下载图标库、不混用旧图标（旧 `ICON_PATHS` 只作兜底，接线后一周内删）。
- 不给图标加辉光、不加渐变、不用两种描边粗细。
- 不在同一个按钮里同时放图标和橙色圆底。
- 不用图标替代空态插画；不用「火箭 = 启动」「盾牌 = 风控」这种俗套（风控是限速表，策略是战术板，插卡台是卡带插座）。

## 7. 清单

### 导航（17）

| 名称 | 中文 | 用途组 |
|---|---|---|
| `overview` | 总览 | 导航 |
| `markets` | 市场 | 导航 |
| `trade` | 交易 | 导航 |
| `orchestration` | 编排 | 导航 |
| `signals` | 信号 | 导航 |
| `opportunities` | 机会 | 导航 |
| `research` | 研究 | 导航 |
| `pipeline` | 流水线 | 导航 |
| `deck` | 插卡台 | 导航 |
| `strategies` | 策略 | 导航 |
| `wallet` | 钱包 | 导航 |
| `accounts` | 账户 | 导航 |
| `risk` | 风控 | 导航 |
| `journal` | 复盘 | 导航 |
| `lessons` | 经验 | 导航 |
| `store` | 商店 | 导航 |
| `settings` | 设置 | 导航 |

### 功能（24）

| 名称 | 中文 | 用途组 |
|---|---|---|
| `search` | 搜索 | 功能 |
| `spark` | 模型产出 / 决策模型 | 功能 |
| `trace` | 溯源 | 功能 |
| `check` | 确认 / 已完成 | 功能 |
| `close` | 关闭 / 取消 | 功能 |
| `plus` | 新增 | 功能 |
| `play` | 启动 | 功能 |
| `stop` | 停止 | 功能 |
| `refresh` | 刷新 | 功能 |
| `download` | 导出 | 功能 |
| `edit` | 编辑 | 功能 |
| `trash` | 删除 | 功能 |
| `star` | 自选 | 功能 |
| `filter` | 筛选 | 功能 |
| `clock` | 时间 / 延迟 | 功能 |
| `lock` | 锁定 / 不可用 | 功能 |
| `external` | 跳转 / 外链 | 功能 |
| `chevron-down` | 展开 | 功能 |
| `chevron-right` | 进入 | 功能 |
| `more` | 更多 | 功能 |
| `copy` | 复制 | 功能 |
| `eye` | 显示 | 功能 |
| `alert` | 警示 | 功能 |
| `info` | 说明（ⓘ 悬停） | 功能 |

### 派生（5）

| 名称 | 中文 | 用途组 |
|---|---|---|
| `chevron-left` | 收起 | 派生 |
| `chevron-up` | 收起（纵向） | 派生 |
| `minus` | 减少 | 派生 |
| `arrow-right` | 下一步 / 流向 | 派生 |
| `arrow-down` | 下落 / 装入方向 | 派生 |

### 业务补充（28）

| 名称 | 中文 | 用途组 |
|---|---|---|
| `order` | 订单 / 下单 | 活动 |
| `fill` | 成交 | 活动 |
| `block` | 拦截 | 活动 |
| `note` | 手记 | 活动 |
| `system` | 系统 | 活动 |
| `liquidation` | 强平 | 活动 |
| `venue` | 场所 | 卡槽 |
| `model` | 研究模型 | 卡槽 |
| `decision` | 决策单元 / 快速决策模型 | 卡槽 |
| `data` | 数据 | 卡槽 |
| `execution` | 执行 | 卡槽 |
| `custom` | 自定义单元 | 卡槽 |
| `trader` | 交易单元 | 单元 |
| `reviewer` | 复盘单元 | 单元 |
| `key` | 密钥 / 签名 | 钱包 |
| `qr` | 收款地址 | 钱包 |
| `deposit` | 充值 | 钱包 |
| `withdraw` | 提现 | 钱包 |
| `link` | 连接钱包 | 钱包 |
| `shield` | 安全 | 钱包 |
| `verified` | 已验证（供应商） | 标识 |
| `insert` | 装入 | 插卡 |
| `eject` | 拔出 | 插卡 |
| `override` | 手动干预 | 监督 |
| `layout` | 布局 | 壳 |
| `popout` | 独立窗口 | 壳 |
| `help` | 快捷键 / 帮助 | 壳 |
| `offline` | 断开 | 状态 |


## 8. 旧名映射（`GR_ICON_ALIASES`）

现有调用点里出现过的旧名都在这里，接线后无需改页面代码。
| 旧名 | 新名 |
|---|---|
| `agents` | `orchestration` |
| `sparkle` | `spark` |
| `send` | `arrow-right` |
| `reject` | `block` |
| `strategy` | `strategies` |
| `signal` | `signals` |
| `chart` | `trade` |
| `inbox` | `note` |
| `arrow-up-right` | `external` |
| `pencil` | `edit` |
| `bolt` | `execution` |
| `cube` | `venue` |
| `chip` | `model` |
| `wave` | `strategies` |
| `target` | `research` |
| `swap` | `trader` |
| `loop` | `reviewer` |
| `grid` | `deck` |
| `flask` | `custom` |
| `layers` | `accounts` |
| `gauge` | `risk` |
| `pulse` | `signals` |
| `book` | `journal` |
| `menu` | `more` |
| `play` | `play` |
