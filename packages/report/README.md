> 许可证：CPAL-1.0。

# @gitrader/report

回测报告导出：把一份回测结果渲染成 Markdown 或**单文件** HTML。指标键名与口径对齐 QuantDinger，
统计量复用 `@gitrader/stats`（Sharpe / PSR / DSR / 信息比率），报告层只补 QD 结果字典里有、我们统计包里没有的算术项。

不接内核、不发网络请求、不读配置与密钥；纯函数 + 一个 CLI 入口。

## 用法

本包没有自执行入口：`src/cli.ts` 只导出 `run(argv, io)`，模块被 import 时不执行任何东西，包里也没有 `bin`（`package.json` 是 `private: true`，未发布到 npm）。
源码树里现成的包装脚本是 `docs/user/tutorials/report.mjs`（它先注册 TS 解析钩子，再把参数交给 `run()`）：

```bash
# 打印 Markdown 到 stdout
node docs/user/tutorials/report.mjs result.json

# 落盘两种格式
node docs/user/tutorials/report.mjs result.json --md out.md --html out.html --title "我的回测"
```

- `node --experimental-strip-types packages/report/src/cli.ts` **跑不起来**：`src/*.ts` 之间是无扩展名 import（Node 的 ESM 不解析），而且模块本身不执行 `run()`。要自己接，就把它打成 ESM 再调 `run()`（仓库里的 `tools/smoke/journey.mjs` 与教程包装脚本都是这么做的）。
- 在源码树外（独立项目）暂时用不了本包：`@gitrader/report` 没有发布到 npm，只有 monorepo workspace 能 import。

`result.json` 是 `BacktestResult`（GEP `backtest.result` 的形状）：`stats` 对象 + `equity` 数组必需，
`trades`、`params`、`assumptions`、`engine`、`warnings`、`trialCount` 可选。返回码 0（成功）/ 2（读不了、不是 JSON、形状不对、写盘失败）。

## API

```ts
import { computeReportMetrics, renderMarkdown, renderHtml, run } from '@gitrader/report'

const metrics = computeReportMetrics({ result, evidence, benchmark, title, generatedAt })
renderMarkdown({ result }, metrics)
renderHtml({ result }, metrics)
await run(['report', 'result.json', '--md', 'out.md'])
```

- `ReportMetrics.rows`：扁平指标表，每行 `{ key, label, value, raw, unit?, source }`，`source` 是 `'stats'`（统计函数 / 结果统计块）或 `'computed'`（本包算术）。
- `ReportMetrics.monthly`：UTC 自然月收益分桶（热力表数据）。
- `ReportMetrics.informationRatio`：给了 `benchmark` 才有；口径照 QD `metrics.calculate_information_ratio`（共同时间戳上的主动收益 + 年化跟踪误差）。

## 指标键名（对齐 QD 结果字典）

QD 有两套键名：`strategy_v2/runtime.py` 的 camelCase 结果字典与 `strategy_review.py` 的 snake_case 指标字典。
本包统一用 snake_case，括号里是 QD 原名。

| 我们的 key | QD 原名 | 来源 |
|---|---|---|
| total_return | totalReturn / total_return | 结果统计块 |
| annualized_return | annualizedReturn | 结果统计块 |
| max_drawdown | maxDrawdown / max_drawdown_pct | 结果统计块 |
| sharpe_ratio | sharpeRatio / sharpe_ratio | 结果统计块 |
| sortino_ratio | （QD 结果字典无） | 结果统计块 |
| calmar_ratio | （QD 无） | 本包：年化收益 / 最大回撤 |
| win_rate | winRate / win_rate | 平仓成交算术 |
| profit_factor | profitFactor / profit_factor | 平仓成交算术 |
| profit_loss_ratio | profitLossRatio | 平仓成交算术 |
| expectancy | expectancy | 平仓成交算术 |
| avg_win / avg_loss | avgWin / avgLoss / avg_win / avg_loss | 平仓成交算术 |
| max_consecutive_losses | max_consecutive_losses | 平仓成交算术 |
| max_consecutive_wins | （QD 无） | 平仓成交算术 |
| total_trades | totalTrades / total_trades | 结果统计块 |
| closed_trades | closedTrades（列表，取长度） | 仓位重建 |
| total_commission | totalCommission / total_commission | 结果统计块 |
| funding_paid | （QD 结果字典无资金费合计） | 结果统计块 |
| exposure | （QD 无） | 仓位重建：持仓时长 / 权益跨度 |
| turnover / turnover_ratio | rebalanceRecords[].turnover（单次调仓） | 本包：Σ 价格 × 数量，/ 起算权益 |
| final_equity | finalEquity | 结果统计块 |
| psr / dsr | （QD 无） | `@gitrader/stats` |
| information_ratio | informationRatio（metrics.py） | `@gitrader/stats` + 基准对齐 |

## 报告结构（章节顺序照 QD `ai_report_pdf.py` 的专业报告）

摘要 → 数据质量与假设 → 指标 → 曲线与月度收益 → 风险 → 参数 → 交易明细（≤200 行）→ 证据摘要 → 方法 → 免责声明。

图表是三张内联 SVG（权益曲线、回撤曲线、月度收益热力表），降采样规则照 QD `strategy_v2/curve_sampling.py`：
保留首尾、最高点、最低点、最大回撤的峰谷两点、首次资不抵债点，其余等间距补齐。
HTML 不含 `<script>`、不含外链字体与任何外链资源，6000 点 / 500 笔的结果仍在 300 KB 以内（有测试守着）。

固定免责声明一行：**本报告为历史数据回测结果，不构成任何预测或建议。**
