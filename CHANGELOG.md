# 变更记录

按提交日期分组，新在上。每行是一条提交标题（只陈述做了什么，不写评价）。

覆盖 2026-10-18 至 2026-10-21 的提交；更早的历史用 `git log --oneline` 看。协议字段与枚举的变更另记在 `packages/protocol/CHANGELOG.md`。

## 0.1.1

第一个公开发布版本，取代 0.1.0 预览构建，并含工作台英文界面（设置里可切换，默认跟随浏览器语言）和新手上手的几处改进。用户可见的新增与修复见 [docs/release-notes/0.1.1.md](docs/release-notes/0.1.1.md)；`packages/cli` 与内核版本统一为 0.1.1。

## 2026-10-30

- fix(engine-core): R1-PERF-04 backtest window caps follow the QD day table, no longer capped at the 5000-bar page limit
- perf(engine-core): R1-PERF-09 rollingStd back to ref speed (one pre-scan instead of a per-window finite/scale pass), bollinger works on Float64Array internally
- perf(engine-core): R1-PERF-09 indicator loops run on a Float64Array copy of the input
- perf(sim-book): R1-PERF-10 no default options object on the apply() hot path
- perf(mcp,cli): R1-PERF-06 local kernel calls reuse keep-alive connections with Nagle off (MCP KernelClient, CLI callOp/liveService)
- perf(kernel): R1-PERF-03 candle store: in-memory row index for range reads, writes dedupe against existing rows (restart / concurrent safe)
- feat(kernel,connector-hyperliquid): R1-PERF-01 host.market.history with from is local-first and only fills gaps; budget queueing no longer counts against the 10 s candle timeout
- feat(kernel,mcp): R1-PERF-02 agent backtest result is a summary by default; equity / trades / funding are paged (part + cursor + limit); MCP overflow keeps stats
- fix(kernel): R1-PERF-02 result summary always carries biasChecks (engines without them, e.g. python-engine, get an honest not_run)

## 2026-10-21

- docs(user): Chinese user guide (quick start, config reference, strategies, backtesting, live trading and risk, notifications, plugins, observability, security, FAQ) + offline verifier
- chore(ops): Prometheus scrape config, Alertmanager routing, Grafana overview dashboard and provisioning, offline verifier
- feat(engine-core): bot strategy templates aligned with QuantDinger parameters (grid / dca / martingale / trend-atr) + backtest smoke tests
- feat(report): backtest report export (Markdown + self-contained HTML)
- feat(notify): webhook library and three notification channel plugins (telegram, email, webhook)
- feat(protocol): Go reference engine sidecar example (GEP stdio, single binary) + root go.work
- feat(engine-core): backtest wiring for funding, liquidation and volume-share (S4 E-fund-3) + docs
- feat(protocol): 0.1.13 — backtest funding / liquidation / volume-share fields, host.market.fundingHistory, trailing params, ledger events, Candle.vwap (S4 P3)
- feat(kernel, protocol): S3-B generic plugin execution layer (exec sidecars), GSP mini conformance suite, Python example plugin
- feat(mcp, cli): experiment tools validated and forwarded; lab export / verify commands (S2 M)
- feat(engine-core): Alpha158 second batch — 6 rolling operators, 11 missing families, Qlib-aligned semantics, 157-entry catalog
- feat(kernel): local exit state machine and fill accumulator (execution breadth r1, pure modules)
- feat(kernel): experiment registry service (S2 K-lab)
- feat(data-files, notify-email): 本地历史数据文件工具包 + SMTP 邮件通知客户端库（Hermes 施工）
- chore(engine-core): AI 生成校验的承诺词表改字符拼接，公开扫描回到 26 条营销路径
- refactor(connector-okx-data): candle volume folds contracts by ctVal with volCcy fallback; linear-only filter and tests refined
- chore(lock): commit the npm-generated package-lock in full; earlier hunk-level staging had left an unparsable file at HEAD
- feat: eight read-only exchange market-data connectors and their CLI registry entries (QD parity: data breadth)

## 2026-10-20

- feat(cli): register the OKX read-only data connector in the connector table
- feat: Alpha-style factor library and Telegram notification client (QD parity batch 6)
- feat(connector-okx-data): read-only OKX USDT/USDC-margined swap market-data connector (QD parity: data breadth)
- chore(connector-binance-data): add LICENSE and the license line the protocol hygiene test requires
- refactor(cli): connector registry; venues are assembled from a factory table keyed by config venue id
- feat(connector-hyperliquid): info REST requests go through the circuit breaker (QD parity batch 5)
- feat(engine-core): wire position protection and lot normalisation into the simulator; backtest jobs validate window limits, audit the ledger and report progress stages (QD parity batch 4)
- feat: port QuantDinger v5.6.5 logic, batch 3 (param comments, AI strategy validation, lot and window limits, kernel cache and health endpoints, alert rules, MCP tool contract) and config-driven connector assembly
- feat: port QuantDinger v5.6.5 logic, batch 2 (indicators, position protection, ledger audit, statistics, walk-forward embargo, sampled grids, grid tools, cache compression, venue error handling, webhooks, JSON logs)
- feat(connector-binance-data): read-only Binance USDT-M public market-data connector (QD parity: data breadth)
- docs(engine-core): martingale and trend-ATR teaching-example strategies (strategies-r2)
- fix(engine-core): PPO signal line is an EMA, consistent with MACD
- feat(engine-core): 29 more technical indicators (overlap/trend and oscillator/volume families)
- feat(engine-core): factor library and evaluation, walk-forward runner, Monte Carlo trade resampling (QD parity: factor research and anti-overfitting)
- feat(engine-core): strategy byte hash, describe/list digests and backtest evidence draft with artifact delivery (S2 E package)
- docs(protocol): Python reference engine for the GEP stdio protocol (S3-A)
- feat(kernel): host.market.history validates params, records to the local candle store and falls back to it (S4 recorder, step 2)
- chore(lock): protocol 0.1.12, register @gitrader/stats, sync CPAL-1.0 license fields
- feat(protocol): 0.1.12 experiment registry contract (S2 P2)
- feat(kernel): local candle store with closed-candle recording from the event bus (S4 recorder, step 1)
- docs(engine-core): four more teaching-example strategies (strategies-r1)
- feat(engine-core): parameter sweep with CSCV PBO and deflated Sharpe (S4 anti-overfitting)
- feat(engine-core): backtest evidence summary via @gitrader/stats (S4)
- feat(engine-core): local candle cache for host history and kind-aware data files (S4)
- feat(engine-core): load funding-rate data for backtests (S4 E-fund-2)
- feat(engine-core): simulator funding, liquidation and volume-share cap (S4 E-fund-1)
- feat(kernel): GET /api/metrics in Prometheus text format (metrics-r1)
- feat(engine-core): technical-indicator library strategy/ta (ta-r1)
- feat(stats): add @gitrader/stats and Hyperliquid fundingHistory (S4 prep, stats-r1)
- S1 trust fixes: paper state persists across restarts, fill-id collisions surface, 1010 goes to PIN, merged WS backlog, D1/D3/D5 rulings, kill latches first, HALT file, risk CLI, docs aligned

## 2026-10-18

- kernel K-r4-2: live-account close/place/cancel/cancel_all go through unlockForLive and return ATTESTATION_REQUIRED when the keystore is locked
- license: product packages to CPAL-1.0 with attribution (Powered by Gitrader); protocol, blocks-sdk and plugin-template stay Apache-2.0
