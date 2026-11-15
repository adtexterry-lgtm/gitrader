# Third-party notices

Gitrader ports selected logic from open-source projects. Ported code carries a comment of the form
`// Ported from <project> <version> (<license>): <path>:<line>; adapted.` at the function it was derived from.
This file lists the projects, their licenses, and where the ported logic lives.

## QuantDinger

- Project: QuantDinger (https://github.com/quantdinger/quantdinger), version v5.6.5
- License: Apache License 2.0. The original license text is available at https://www.apache.org/licenses/LICENSE-2.0 and in the upstream repository's `LICENSE` file.
- What was ported (adapted to TypeScript and to Gitrader's types; no code was copied verbatim): see the `Ported from QuantDinger` comments. Areas: technical indicators (KDJ, Parkinson and Garman-Klass volatility, turnover proxy, volume z-score), position protection rules (stop loss, take profit, trailing stop, time limit), backtest ledger audit, information ratio and factor-evaluation helpers, walk-forward planning (embargo and blind holdout), reservoir-sampled parameter grids, grid-trading level helpers and template defaults, cache compression, limit-price safety clamp, venue error classification, circuit breaker, order-status normalization, webhook dialects and signatures, JSON log formatting.
- Changes: interfaces, data types, null handling and some semantics were changed to fit Gitrader (for example rolling walk-forward windows instead of a fixed training start, and no soft risk limits).

Gitrader itself is licensed under CPAL-1.0 (product packages) and Apache-2.0 (protocol and SDK packages); see each package's `LICENSE`.
