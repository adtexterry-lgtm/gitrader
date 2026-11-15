# Gitrader user documentation

For people who **use** Gitrader: install it, get a first strategy running, understand the configuration, connect notifications and plugins, and know where to look when something goes wrong.

- Field-level protocol specs and build rules live under the repository's `docs/` (for example `docs/config.md`, `docs/plugins.md`, `docs/risk-gate-protocol.md`, `docs/security.md`). Those are written for implementers; this directory only covers how you use the product.
- Source of truth: command-line branches are in `packages/cli/src/index.ts`; configuration fields and defaults are in `packages/kernel/src/config.ts`. **When documentation and code disagree, the code wins.** This directory ships its own offline checker — see the end of this page.

Language: [中文](../README.md) · English

## Contents

| Document | Question it answers | When to read it |
|---|---|---|
| [01-quickstart](01-快速开始.md) | From zero to "a sample strategy running on a paper account", including PIN, launch links and the workbench | First install |
| [02-configuration](02-配置参考.md) | Type, default and editability of every `gitrader.json` field | When changing ports / accounts / engines / risk |
| [03-strategy-development](03-策略开发.md) | What a strategy file looks like, `@param`, hooks, prohibitions, how to re-parameterise the four templates | Writing or editing a strategy |
| [04-backtest-and-research](04-回测与研究.md) | Backtests, walk-forward, holdout, evidence packs, experiment registry, export | Validating a strategy |
| [05-live-and-risk](05-实盘与风控.md) | The path from paper to live, PIN, mandates, risk-gate verdicts, takeover, protectors | **Read before touching real money** |
| [06-notifications](06-通知配置.md) | How to configure the six channel plugins (Telegram / email / webhook / Discord / Slack / WeCom) and how to supply secrets | When you want alerts |
| [07-plugins](07-插件.md) | Plugin layout, validation, version pinning, grants, permission boundaries | Installing or writing a plugin |
| [08-observability](08-可观测性.md) | `/api/metrics`, `/api/ready`, Prometheus scraping, alert rules | Wiring runtime state into monitoring |
| [09-security](09-安全.md) | Threat model, tokens, PIN, secret encryption, ledger, what is and is not covered | Assessing whether you can rely on it |
| [10-troubleshooting](10-常见问题.md) | Will not install, will not open, receives nothing, gets denied, stuck in `HALTED` | When something breaks |
| [11-book-level fills](11-盘口级成交模拟.md) | Matching against book and tick data: format, validation, three resting-order assumptions, latency and fees | Answering "can this order fill at that price" |
| [12-execution reconciliation](12-执行对账.md) | When ledger and venue disagree: 38 difference codes, inferred fills, time and dedupe, and what it cannot see | Reconciling, reviewing, checking after a restart |
| [13-indicator additions](13-指标库补充.md) | The ta-plus inventory and exactly where the nine overlapping names differ from engine-core | Choosing indicators or cross-checking numbers |
| [14-symbol search](14-标的搜索.md) | Search by code, name or alias, filtering, and the four selection checks behind "can this be traded" | Building a search box, watchlist or autocomplete |
| [15-market data sources](15-行情数据源.md) | The four keyed data sources: variable names, free-plan limits, and what the free plan cannot do | Wiring US and global equity data |
| [16-python engine](16-Python策略引擎.md) | Where the strategy folder is, what a strategy file looks like, the four sandbox limits and which are real | Writing strategies in Python |
| [17-parameter search](17-参数寻优.md) | Grid, random and evolution search plus mandatory PBO / DSR and out-of-sample validation | Tuning parameters and judging overfitting |
| [18-bot templates](18-机器人模板.md) | Parameters, safety caps and "which market loses" for grid, DCA, martingale and trend | Wanting a ready bot skeleton |
| [19-portfolio analysis](19-组合分析.md) | Cross-venue aggregation, exposure, PnL attribution with venue drift, concentration | The algorithm for building your own account-overview view (not used by the workbench yet) |
| [20-testnet accounts](20-测试网账户准备.md) | Hyperliquid and Binance testnet accounts, API keys and API wallets, import and journey scripts | Your first testnet connection |
| [21-known limitations](21-已知限制.md) | What 0.1.1 does not do yet, what is not validated, and what not to assume | Skim before you start |

## Three reading paths by audience

- **First time here**: all of 01 → only "Top-level fields" and `server` in 02 → the first half of 03.
- **Writing strategies and running backtests**: 03 → 04. Do not skip the section in 04 about assumptions (fees, slippage, funding, liquidation).
- **Preparing to touch real money**: all of 05 → "What is and is not covered" in 09 → `risk` and `accounts` in 02.

## Conventions

- Commands are written as `gitrader <subcommand>`. Without a global install this equals `npx gitrader <subcommand>`. The full list is always available: `gitrader help` (running it with no arguments prints the same help).
- The home directory defaults to `~/.gitrader`; change it with the environment variable `GITRADER_HOME` or the flag `--home DIR`. Every path in this documentation is relative to that home directory.
- All example accounts are **paper accounts**; numbers in examples are parameters, not return expectations.
- Every command here exists as a branch in this repository's CLI. This documentation does not describe commands that are not implemented.

## Documentation self-check

```text
node docs/user/en/verify-docs-en.mjs
```

The script runs offline and does five things: it compares every `gitrader <subcommand>` in the documents against the CLI's `case` set; it compares backticked configuration keys against the fields in `packages/kernel/src/config.ts`; it scans the documents for banned English product-copy words; it scans for host absolute paths; and it checks that all pages are translated and that English and Chinese files map one-to-one (long runs of Chinese text are reported as untranslated). It lists every mismatch and exits with code 1. Full pass exits 0.

## License

The Gitrader product itself is CPAL-1.0 (the UI must display Powered by Gitrader); the protocol packages, block SDK and plugin templates are Apache-2.0.
