> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/blocks-default

默认块（M1 最小检阅版）：**持仓与盈亏**、**Agent 活动与待批**、**风险状态** 三块，加上底部的 **状态条**。壳（`@gitrader/workbench`）按同 id 加载 `defaultBlocks`，覆盖自带的占位块。

块只经块桥收发：数据用查询取快照、订阅收增量；命令经桥发出，需要在场证明时由壳的 PIN 层接手。块不直连内核、不持有凭据。

| 块 | 看什么 | 能做什么 |
|---|---|---|
| 持仓与盈亏 `block.gitrader.positions` | 权益、今日盈亏、跨账户持仓表（标的 / 方向 / 数量 / 开仓价 / 标记价 / 未实现 / 强平价 / 执行方）；点一行展开事件链（持仓 → 成交 → 提案 → 来源） | 没有命令（检阅大于操作） |
| Agent 活动与待批 `block.gitrader.agent-activity`（钉住） | 事件流（谁 · 做了什么 · 为什么 · 结果 · 撞了哪条规则）、来源筛选（人 / 引擎 / LLM Agent / 系统）、待批提案卡片（票号、倒计时、强平价 / 滑点 / 保证金、理由）、Agent 权限四档 | 批准 / 拒绝提案（批准走 PIN）、改档位（走 PIN） |
| 风险状态 `block.gitrader.risk`（钉住） | 三态、限额使用率（单笔 / 日亏 / 总敞口 / 杠杆 / 日笔数）、保护器与触发记录、大模型实盘开仓保护开关 | 接管三档、恢复交易（PIN）、开关保护（关闭要 PIN） |
| 状态条 `block.gitrader.statusbar`（钉住） | 网络（主网 / 测试网）、延迟、WS、速率预算剩余、风控三态缩略；点网络项出小卡（连接方式 / 延迟 / 预算 / 各场所健康 / 重连） | 接管入口（三档） |

大模型来源的动作永远可见、可筛：事件流里每条带来源小标，LLM 来源一律写「LLM · 钥匙名」；筛选器是壳的固定件（`ActorFilter`）。

## 目录

```
src/index.ts          defaultBlocks（壳读这个名字）
src/positions.tsx  agent-activity.tsx  risk.tsx  statusbar.tsx    四个块（清单 + 组件）
src/hooks.ts          数据钩子（查询 + 订阅，连接没建好时退避重试）
src/model-*.ts        纯逻辑：把内核载荷规整成视图数据（无 DOM，单测直接跑）
src/actions.ts        块发出的人面命令（PIN 取消 / 错误原文原样给用户）
src/api.ts            查询 / 主题 / 命令名集中一处（改名只改这里和清单）
src/blocks.css        样式（只引用令牌，不写颜色字面量）
fixtures/             各块清单引用的离线回放 *.json；scenarios.ts / install.ts 是测试与截图用的假内核场景
verify/               无头验证：shots.mjs（截图 + 旅程 + 视觉体检）、stage.mjs（构建壳 + 夹具内核 + 无头 Edge）
```

## 验证

```
npm test -w @gitrader/blocks-default       # 纯逻辑 / 清单 / 夹具合法性 / PIN 流程（假内核）/ 无头浏览器渲染（含夹具预览与三档视口）
npm run typecheck -w @gitrader/blocks-default
npm run verify -w @gitrader/blocks-default # 五个场景 × 1440 / 1200 / 900 截图到 reports/G-shots/，走批准 / 接管 / 改档位 PIN 旅程，再跑壳的视觉体检
node verify/gen-fixtures.mjs               # 由 fixtures/scenarios.ts 重新生成回放文件
```

无头浏览器用本机 Edge 与 playwright-core（`GITRADER_EDGE` / `GITRADER_PLAYWRIGHT` 指路径）；找不到时浏览器测试**失败**，确实没有就设 `GITRADER_SKIP_BROWSER=1`，并在回报里写明没验。

## 对内核与协议的约定（未定的都标了 `TODO(protocol)`）

- 查询：`account.list` / `account.summary` / `account.positions` / `account.fills` / `account.orders`、`risk.state`、`proposal.list`、`agentkey.list`、`mandate.list`、`ledger.query`、`venue.status`。主题：`account.*`、`proposal.*`、`risk.state`、`ledger.entry`、`venue.status`、`mandate.changed`。
- 今日盈亏：`account.summary` 带 `dayStartEquity`（与日亏上限同口径的当日基线）或 `dayPnl` 才是精确值；没有就退到今日已实现并在界面上标注。
- 限额使用率：`risk.state` 的 `usage`（`orderNotional` / `dailyLossRatio` / `totalNotionalRatio` / `leverage` / `ordersToday`）；没给就用账户快照现算，仍缺的行只显示上限不画条。「日笔数」需要 `limits.maxOrdersPerDay`（协议的 RiskLimits 还没有）。
- 命令：`proposal.approve` / `proposal.reject`（参数 `{id}`）、`mandate.update`（`{mandateId, input}`，改档位 = 用新级别重签）、`takeover.<档>`、`trading_state.resume`、`risk.setLlmLiveEntries`（`{deny}`）、`venue.reconnect`（内核还没有）。
