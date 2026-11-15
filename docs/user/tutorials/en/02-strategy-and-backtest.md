# Tutorial 02 · Write a strategy, backtest it, export a report

This tutorial writes **the same strategy in two languages** (TypeScript and Python — same hooks, same parameter
semantics), backtests each of them, and renders both results with `@gitrader/report`. You end up with two result
JSON files and two Markdown + HTML reports.

Prerequisites are the same as [tutorial 01](01-data-to-factor-report.md): commands run from the repository root and
artefacts go to `./tutorial-lab/`. The Python side needs `python` ≥ 3.11 on `PATH` (zero third-party dependencies;
if it is not on `PATH`, read `packages/engine-python/README.md` first).

## 0. Scratch directory

```bash
mkdir -p ./tutorial-lab
```

## 1. What a strategy is in Gitrader

A strategy is **one pure function**: give it candles and parameters, and it returns a **target position** per candle
(-1 to +1) plus one human sentence per change. It never places orders, never sizes orders and never talks to a venue
— the engine turns changes of that target into order intents.

| Output | Type | Requirement |
|---|---|---|
| `target` | number[n] | each in [-1, 1]; 0 during warm-up |
| `reasons` | string[n] | only where the target changed, `''` elsewhere |
| `overlays` | {name: (number\|null)[n]} | lines drawn on the price chart, may be empty |
| `warmup` | integer | index of the first bar with a valid signal |

Two hard rules: **no lookahead** (bar i may only see `candles[0..i]`) and **deterministic** (same input, same
output; no clock, no randomness).

## 2. The TypeScript version

A strategy is "one file in a folder": `~/.gitrader/engines/gitrader-core/strategies/` (the kernel's built-in
engine). So this tutorial does not touch your real home directory — the file already sits at
`docs/user/tutorials/strategies/tutorial-sma-band.ts`, and the code below *is* that file, so you can copy it into
your own folder:

See [`strategies/tutorial-sma-band.ts`](../strategies/tutorial-sma-band.ts) (kept in one place so the tutorial, the
smoke test and the backtest all run the same bytes).

How to read the rule: a close more than `band%` above the N-bar simple moving average targets -1 (fully short), more
than `band%` below it targets +1 (fully long), and back inside the band targets 0 (flat). That is a **mean-reversion**
skeleton: it collects reversion in ranging markets and fights the trend in one-way markets, so its backtest is likely
to look bad — that is the known shape of this kind of rule, not a bug.

## 3. The Python version

The same strategy in Python: a module-level `STRATEGY` (the Python equivalent of `export default`), with `params`
and `evaluate` mapped one-to-one. A strategy file **may not import anything** (the strategy sandbox profile): copy
whatever you need into the file.

See [`strategies/tutorial-sma-band.py`](../strategies/tutorial-sma-band.py). Both versions share the id
(`tutorial-sma-band`), the parameters (`period` / `band` / `allowShort`) and the semantics, so the two backtests
should line up trade by trade.

## 4. Backtest the TypeScript version

The command line has no backtest subcommand (backtests live on the engine side, see "Backtest entry points" in
`docs/user/04-回测与研究.md`). The tutorial uses a thin script that calls the very same backtest code inside the
engine: `loadStrategyFile` (validate + load) → `runBacktest` (signals → matching → statistics):

```bash
node docs/user/tutorials/backtest.mjs --engine ts \
  --strategy docs/user/tutorials/strategies/tutorial-sma-band.ts \
  --data assets/samples/btcusdt-1h.csv \
  --out ./tutorial-lab/result-ts.json \
  --params '{"period":24,"band":1,"allowShort":true}' \
  --balance 10000 --leverage 1 --fee-rate 0.0005 --slippage-bps 3
```

The output looks about like this:

```text
回测完成（gitrader-core · 策略 tutorial-sma-band）
  K 线 1500 根 · 成交 96 笔 · 期末权益 9367.86
  总收益 -6.32% · 最大回撤 10.25% · 夏普 -1.706
```

`--params` should only carry declared keys: unknown keys are dropped and values outside `min`/`max` are clamped to
the bound (for example `band: 20` runs as 10), without an error, so check the fill count after changing parameters.

## 5. Backtest the Python version

```bash
node docs/user/tutorials/backtest.mjs --engine py \
  --strategy docs/user/tutorials/strategies/tutorial-sma-band.py \
  --data assets/samples/btcusdt-1h.csv \
  --out ./tutorial-lab/result-py.json \
  --params '{"period":24,"band":1,"allowShort":true}' \
  --balance 10000 --leverage 1 --fee-rate 0.0005 --slippage-bps 3
```

Both simulators are aligned to one definition (next-bar-open fills, taker fee, adverse slippage, lot normalisation),
so the two runs should produce **identical** statistics: 96 trades, final equity 9367.86, Sharpe -1.706.

## 6. Export the report

`@gitrader/report` renders a result JSON into Markdown and a single-file HTML (inline CSS and SVG, no `<script>`,
no external assets):

```bash
node docs/user/tutorials/report.mjs ./tutorial-lab/result-ts.json \
  --md ./tutorial-lab/report-ts.md --html ./tutorial-lab/report-ts.html \
  --title "tutorial · SMA band reversion (TS)"
```

```bash
node docs/user/tutorials/report.mjs ./tutorial-lab/result-py.json \
  --md ./tutorial-lab/report-py.md --html ./tutorial-lab/report-py.html \
  --title "tutorial · SMA band reversion (Python)"
```

The sections are: summary → data quality and assumptions → metrics → curves and monthly returns → risk →
parameters → trade list → method → disclaimer. The three charts in the HTML (equity curve, drawdown curve, monthly
returns heat table) are inline SVG, so the file can be sent to someone as is.

## 7. What to read in the report

| What | Where | Why |
|---|---|---|
| `assumptions` | "data quality and assumptions" | fees, slippage, fill model, funding, liquidation; `funding` / `liquidation` being `false` means **not modelled**, not "costless" |
| `trades` / `fills` | metrics | trade count drives the fee total; this strategy has 96 trades and 919.72 in fees, a large part of the result |
| max drawdown and Sharpe | metrics | read them together with total return; return alone hides the volatility |
| `biasChecks` | the result JSON | lookahead check plus `trialCount` (how many parameter sets this strategy was tried on); trying many and liking one is mostly luck |
| `reason` in the trade list | last section | the sentence the strategy itself wrote; read it before the price when reviewing |

`trialCount` is 1 in this tutorial (one parameter set). In real research it is your honesty item: every parameter
set that `sweep-report.mjs` sweeps counts, see `tools/research/README.md`.

## 8. Done — you should be able to answer

- Why does `reasons` only carry text where the target changed?
- Set `band` to `2` in `--params`. Do you get more or fewer trades, and why?
- Both results have identical `stats`. What does that prove — and does it prove the simulator is trustworthy?
  (No: it only shows the two versions agree.)

Next: [03 · Paper mode and notifications](03-paper-mode-and-notifications.md).
