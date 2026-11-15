# Tutorial 01 · From candles to a factor report

This tutorial walks the path "data in → factor statistics out": look at the shape of a candle file, then turn every
Alpha158 factor into a Markdown + HTML report with `tools/research`. It works **without a network** — the repository
ships three synthetic sample files under `assets/samples/`.

Before you start: all commands run from the **repository root** and write into `./tutorial-lab/` (the tutorial's own
scratch directory; delete that one directory and you are clean again).

> On a machine with Gitrader installed globally, use `gitrader` as written. In a source checkout without the global
> package, run `npm run build` once and replace `gitrader` with `node packages/cli/dist/bin.js`.

## 1. Create the scratch directory

```bash
mkdir -p ./tutorial-lab
```

## 2. The shape of a candle file

The samples are `t,o,h,l,c,v` CSV, one candle per line, `t` is the open time in Unix milliseconds:

```text
t,o,h,l,c,v
1735689600000,62000,62279.25,61903.03,62152.59,1419
```

| Field | Meaning |
|---|---|
| `t` | open time (milliseconds) |
| `o` / `h` / `l` / `c` | open / high / low / close |
| `v` | volume (a made-up magnitude in synthetic data, not any exchange's real volume) |

Three samples (source and licence in `assets/samples/README.md`): `btcusdt-1h.csv` (1500 bars of 1h),
`ethusdt-1h.csv` (1200 bars of 1h), `solusdt-4h.csv` (900 bars of 4h). All three are **synthetic**: the price path is
a random walk and carries no market meaning.

## 3. Normalise it and check its health

`tools/data/inspect.mjs` is a thin wrapper around `@gitrader/data-files`: `normalize` turns raw CSV into canonical
JSON, `inspect` reports rows / interval / gaps / duplicates / OHLC violations, `manifest` prints a file digest.

```bash
node tools/data/inspect.mjs normalize assets/samples/btcusdt-1h.csv ./tutorial-lab/btcusdt-1h.json
```

```bash
node tools/data/inspect.mjs inspect ./tutorial-lab/btcusdt-1h.json
```

The output contains lines like these (numbers from this sample):

```text
rows: 1500
parsed: 1500
skipped: 0
duplicates: 0
interval: 1h (1h, confidence 1.000)
gaps: none
ohlc violations: 0
```

`manifest` prints the absolute path plus `sha256`, format and kind — that digest is how a backtest or a research
report proves *which* data it used:

```bash
node tools/data/inspect.mjs manifest ./tutorial-lab/btcusdt-1h.json
```

## 4. Produce the factor report

`tools/research/factor-report.mjs` reads CSV or JSON and computes **157 factors** (Alpha158: KBAR 9 + price 3 +
rolling 29 families × 5 windows), then measures IC / rolling IR / quantile returns against the return over the next
n bars:

```bash
node tools/research/factor-report.mjs assets/samples/btcusdt-1h.csv \
  --horizon 11 --window 60 --quantiles 5 --top 30 \
  --title "sample · BTC 1h" \
  --md ./tutorial-lab/factors.md --html ./tutorial-lab/factors.html
```

| Flag | Default | Meaning |
|---|---|---|
| `--horizon n` | 5 | forward return measured at the close n bars ahead |
| `--window w` | 60 | rolling IC window (bars) |
| `--quantiles q` | 5 | number of quantile buckets |
| `--top k` | 20 | how many factors the report lists |
| `--md` / `--html` | next to the input | output paths |

## 5. What to read in the report

Open `./tutorial-lab/factors.md`. Three things are worth reading first:

1. **Data summary**: file, `sha256`, bar count, time range — the link between report and data is pinned.
2. **Factor table**: sorted by |IC|, with IC, rolling IR, t value, share of IC>0, Q1/Q5 bucket returns, monotonicity
   and the number of valid points.
3. **Definitions and limits**: a zero denominator counts as 0, insufficient data counts as null, and the quantile
   returns are equal-weighted forward returns without costs.

**Do not read those numbers as performance**: the sample is synthetic, so IC only reflects the rank correlation
between a factor and forward returns *inside this random series* and changes with the data. On real data the same
factor flips sign across periods — check whether the rolling IR and the IC>0 share are stable first, then whether the
buckets are monotone. The disclaimer at the end of the report is not decoration.

## 6. Use your own data

**Option A: the bundled fetch script (needs a network).** `tools/data/fetch-candles.mjs` pulls public market data
from an exchange and writes the same canonical JSON plus a manifest. It talks to the exchange's market-data host,
sends `GET` only and carries no keys:

```text
node tools/data/fetch-candles.mjs --venue binance --instrument BTCUSDT --interval 1h \
  --from 2025-01-01 --to 2025-03-01 --out ./tutorial-lab/binance-btcusdt-1h.json
```

That one **needs a network**, so the tutorial's smoke test skips it (everything else runs). Flags and exit codes are
in `tools/data/README.md`.

**Option B: your own file.** Put a CSV or JSON anywhere and replace `assets/samples/btcusdt-1h.csv` in the commands
above. The only format rules: `t` ascending, `t,o,h,l,c[,v]` (JSON: `{"candles":[…]}`、`[{…}]` or `[[…]]`); broken
rows are skipped.

## 7. Done — you should be able to answer

- What is the `sha256` of this data, and which line of the report carries it?
- Switch `--horizon 5` to `--horizon 11`. How much does the factor order change, and why does the forward window move IC?
- Which factors have a negative Q5−Q1? Is a negative spread the same thing as negative monotonicity?

Next: [02 · Write a strategy and backtest it](02-strategy-and-backtest.md).
