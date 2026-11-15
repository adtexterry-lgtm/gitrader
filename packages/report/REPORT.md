# 标段 C · 回测报告导出 `packages/report`

**改了什么** 新建 `packages/report`（10 源文件 + 6 测试文件：5 个 `.test.ts` 加一个夹具）：`computeReportMetrics` / `renderMarkdown` / `renderHtml`（自包含单文件：内联 CSS、权益 + 回撤 + 月度热力三张内联 SVG、交易表 ≤200 行、参数表、假设表、sha256 数据摘要、证据摘要、固定免责声明一行）/ `run`（0 / 2，不 `process.exit`）。统计量复用 `@gitrader/stats`（Sharpe / PSR / DSR / 信息比率），报告层只补算术项。

**QD 结果字典键名（`strategy_v2/runtime.py:2054-2134` 结果字典 + `strategy_review.py:546-596` 指标字典），逐一标注**
- 我们有：totalReturn / total_return、total_return_pct、finalEquity、maxDrawdown、max_drawdown_pct、totalTrades、totalExecutions、winRate、win_rate、winningTrades、losingTrades、grossProfit、grossLoss、avgWin、avgLoss、profitFactor、profit_factor、profitLossRatio、bestTrade、worstTrade、avgTrade、averageProfit、sharpeRatio、annualizedReturn、annualizedVolatility、periodsPerYear、totalCommission、total_commission、equityCurve、trades、closedTrades、executions、sampleCount、positions、protectionEvents、liquidated、liquidationEvents、attribution、logs、manifest、engine、audit、expectancy、max_consecutive_losses、notional_total。
- 补了：max_consecutive_wins、exposure、turnover、turnover_ratio、calmar_ratio、psr、dsr、funding_paid、information_ratio（QD 的在 `backtest/metrics.py`，不在结果字典）。
- 不适用：accountRealizedProfit、gridMatchedProfit、gridMatchedTradeCount、tradeProfitBasis、instrumentRulesSnapshot、holdingSnapshots、rebalanceRecords、orderLedger、orderLedgerStats、rawTrades、liquidationAdjustment、annualizedReturnCapped、engine.preFillValuationPolicy（多资产 / 网格 / 账本压缩专用）。

**跑了什么** 9 文件 56 例全过（`vitest --root packages/report`，含 12 笔成交夹具的 profit factor 1.50 / expectancy 2.50 / 最大连续亏损 2 / exposure 50.00 / turnover 2,818.00 / calmar 2.00 精确断言）；`tsc -p packages/report --noEmit` 退出 0；hygiene 6 例全过。

**没做什么** 不做 PDF、不做 i18n、不引图表库、不拉基准数据（基准由调用方注入）、不接内核与 CLI、不跑 git。

**需要主会话决定** ① engine-core 包入口没有导出 `BacktestResult`（类型在 `protocol/src/gep/backtest.ts`，protocol 根入口也不导出 gep），本包用结构化声明 + 编译期断言兼容 `runBacktest` 返回值；若要 `import` 需在 engine-core 补 export。② QD `profit_factor` 在无亏损时返回 gross_profit 而非 null，已照抄；calmar / exposure / turnover 是 QD 没有的口径，本包自定并写进 README。
