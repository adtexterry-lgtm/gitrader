# Tutorials (the type-along kind)

Three end-to-end tutorials where every command actually runs. Chinese and English versions correspond one to one:

| # | English | 中文 | What you get |
|---|---|---|---|
| 01 | [From candles to a factor report](01-data-to-factor-report.md) | [从 K 线到一个因子报告](../01-数据到因子报告.md) | canonical JSON + health check + a Markdown / HTML report over 157 factors |
| 02 | [Write a strategy, backtest it, export a report](02-strategy-and-backtest.md) | [写一个策略，回测它，出报告](../02-写策略跑回测.md) | a TS and a Python strategy, two result JSONs, two reports |
| 03 | [Paper mode and notifications](03-paper-mode-and-notifications.md) | [纸面模式与通知](../03-纸面模式与通知.md) | a running kernel, an installed channel plugin, a grant, a channel and one delivered notification |

## Shared prerequisites

- Node ≥ 22.18 (`node --version`); the `tools/` directory relies on Node's built-in TypeScript type stripping to run
  `.ts` sources.
- Run every command from the **repository root**; artefacts go to `./tutorial-lab/`. Tutorial 03 uses
  `./tutorial-lab/kernel` as the kernel home directory and never touches your real `~/.gitrader`.
- The Python side of tutorial 02 needs `python` ≥ 3.11 on `PATH` (no third-party dependencies).
- Everything is offline: no network, no keys, no orders. The tutorial 03 webhook points at a receiver on `127.0.0.1`.

> On a machine with Gitrader installed globally, use `gitrader` as written. In a source checkout without the global
> package: run `npm run build` once, then replace `gitrader` with `node packages/cli/dist/bin.js`.

## What else is in this directory

| File | Purpose |
|---|---|
| `../strategies/tutorial-sma-band.ts` / `.py` | both versions of the tutorial 02 strategy (the Chinese tutorial's code blocks are these exact files) |
| `../backtest.mjs` | tutorial 02's backtest entry: `--engine ts` calls `@gitrader/engine-core`, `--engine py` calls `packages/engine-python` |
| `../backtest_py.py` | the Python half of `--engine py` (runnable on its own too) |
| `../report.mjs` | calls `@gitrader/report`'s `run()` to render Markdown / HTML (`packages/report/src/cli.ts` does not self-execute, hence this layer) |
| `../ts-register.mjs` | lets plain `node` import this repo's TS workspace packages (reuses the resolver hook in `tools/data/lib/ts-shim.mjs`) |
| `../add-notify-channel.mjs` | tutorial 03's config helper: adds one webhook channel to `gitrader.json` |
| `../notify-sink.mjs` | tutorial 03's local notification receiver (binds `127.0.0.1` only) |

## Smoke test: the commands really ran

```bash
node --test docs/user/tutorials/test/tutorials.test.mjs
```

It executes **every ```bash block** in the six documents one command at a time and asserts the exit code, plus three
structural checks (tutorial code blocks match the files under `strategies/` byte for byte, sample CSV size / header /
provenance, samples readable by `tools/data` and `tools/research`). The conventions and the single exception are
documented at the top of the script: `gitrader status` was once allowed to exit 1 once the service is stopped (since the F1 contract it exits 0; the tolerance branch in the script is left as is), the PIN is supplied by the script (as a reader would type it), long-running commands start in the
background and are stopped at the documented "press Ctrl+C" step. Every artefact lands under a temporary `HOME` or
`./tutorial-lab/` and is removed afterwards.

Sample data lives in `assets/samples/`; provenance and licence are in `README.md` there.
