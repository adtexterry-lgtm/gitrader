# The Python engine: strategy folder and sandbox

An engine in Gitrader can be a subprocess in any language. The Python engine (`packages/engine-python/`) is one of them: **drop `.py` files into the strategy folder and it lists them, starts instances from them, and backtests them**. This page covers three things: where the folder is, what a strategy file looks like, and what constrains your code.

Python >= 3.11, **no third-party dependencies** (no numpy, no pandas), no network, no key files, and **no order path at all**.

> **Data source limit**: a Python-engine backtest only supports `spec.data.source = "host"` (bars come from the kernel). The `files` source (your own csv / json) is not available on this engine — `files` or `engine` return `4005 DATA_UNAVAILABLE` rather than fabricating a result. To backtest your own historical files, use the TypeScript engine (`@gitrader/engine-core`; formats are documented in [04-backtest-and-research](04-回测与研究.md)).

## 1. Install and register

The Python engine already ships with the installed package: the default config has a `python-engine` entry whose `enabled` is false. The simplest way to turn it on is to change that entry in `gitrader.json` to the following and restart the service:

```json
{ "engines": [ { "id": "python-engine", "enabled": true, "builtin": true } ] }
```

Once `gitrader engines list` shows it as `ready`, it is connected. The form below with `launch` is for running an engine you changed yourself from a source folder:

```json
{
  "engines": [
    { "id": "python-engine", "enabled": true,
      "launch": { "command": "python",
                  "args": ["engine/main.py"],
                  "env": {},
                  "cwd": "<path to packages/engine-python on your machine>" } }
  ]
}
```

- `cwd` must be the package directory: `engine/main.py` is resolved relative to `cwd`.
- `command` is your local interpreter; on Windows, use an absolute path when `python` is not on PATH.
- **Do not put the token in `env`**: the kernel injects a one-shot `GITRADER_GEP_TOKEN` into every local engine. Without a token the process prints one line to stderr and exits with code 2.
- The kernel also injects the strategy folder `GITRADER_STRATEGIES_DIR` and the artifact folder `GITRADER_ENGINE_ARTIFACT_DIR`; your own directories are used only when you set them explicitly in `launch.env`.
- The subprocess **does not inherit your environment**: it gets PATH / SystemRoot, those two directory variables, the keys in `env`, and the token. So limits such as `GITRADER_ENGINE_*` apply only when the kernel launches it if you put them in `launch.env`.

Once registered, check in this order:

```sh
gitrader engines list                    # status ready means it is connected
gitrader engines bind python-engine      # binds a paper account, needs your PIN; binding grants nothing by itself
node packages/engine-python/run-conformance.mjs   # run after changing the package
```

`run-conformance.mjs` looks for the interpreter through `GEP_PYTHON` (default `python`) and exits with code 3 when it cannot find one; it exits with code 4 when the suite runs but any of O1–O4 fails.

**Starting a strategy on a live account is rejected by the kernel.**

## 2. The strategy folder: a file is the installation

- Only `*.py` files in the **first level** of the folder are read; subdirectories are ignored.
- Files whose names start with `_` or `.` are skipped (`_helpers.py` is a draft, not a strategy).
- One file is one strategy: a module-level `STRATEGY` dict with `id` / `name` / `version` / `desc` / `tags` / `params` / `evaluate`.
- Each entry in `params` is `{key, label, type, default, min, max, step, options, help}`, meaning the same as `export default strategy` on the TypeScript side.
- Two files declaring the same `id`: the later one in filename order is reported as `duplicate-id`.
- A scan reads at most 200 files and **reports an error** for the rest rather than dropping them silently.
- Load results are cached by `(mtime_ns, size)`: while the folder is unchanged, `strategy.list` only issues a few `stat` calls and starts no subprocess.

Strategies in the folder can be listed (`strategy.list`), described (`strategy.params`), started (`strategy.start`) and backtested (`backtest.run` with `subject.strategy.id` set to their id; evaluation happens in the subprocess, and the whole target-position series is computed once before it goes to the simulator).

Running it locally without the kernel:

```sh
GITRADER_STRATEGIES_DIR=packages/engine-python/examples GITRADER_GEP_TOKEN=<token> python engine/main.py
```

## 3. Sandbox: your code runs in a subprocess, bounded by four lines

Strategy files **never execute inside the engine process**: loading and evaluation both happen in a separate subprocess (`engine/strategy_child.py`).

| Limit | Default | Environment variable | When exceeded |
|---|---|---|---|
| Wall clock for one hook (one load / one `evaluate`) | 2 s | `GITRADER_ENGINE_HOOK_TIMEOUT_S` | Subprocess killed, `strategy.start` returns `4002 STRATEGY_ERROR`, the load report records `limit: "hook_timeout"` |
| One whole-series call inside a backtest | `max(2 s, 15 x hook limit)` (30 s by default), further capped by the whole-backtest limit | the same plus `GITRADER_ENGINE_BACKTEST_TIMEOUT_S` | Subprocess killed, job `failed`, `backtest.result` returns `4002` |
| Wall clock for a whole backtest | 900 s | `GITRADER_ENGINE_BACKTEST_TIMEOUT_S` | The loop exits cooperatively, job `failed` (no invented result) |
| Memory (whole subprocess, interpreter included) | 256 MiB | `GITRADER_ENGINE_MEMORY_MB` | Parent kills it once it observes the limit, report records `limit: "memory"` |
| RSS sampling interval | 20 ms | `GITRADER_ENGINE_POLL_INTERVAL_S` | — |

**Static checks** (`engine/sandbox.py`) run first, inside the subprocess: any `import` is forbidden (the whitelist is `math` / `statistics` / `decimal`; `collections` is allowed for scripts only), as are `os` / `sys` / `subprocess` / `socket` / `open` / `eval` / `exec` / `__import__`, dunders, frame and closure accessors, `str.format` / `format_map`, and string literals that spell out dunder names for escape tricks. The restricted builtins **have no `print`**, so a strategy cannot write into the GEP stdout protocol stream. Batch 10 adds three rejection rules, named exactly as the error reports them: `class` (a strategy file may not define classes, put state in `evaluate()`), `unsupported-builtin` (`staticmethod` / `classmethod` / `property` / `chr` / `format` / `memoryview` are not in the sandbox builtins), and `encoding` (a strategy file must be UTF-8).

Exceeding a limit is not a crash: the subprocess dies, the engine keeps answering `engine.health` / `engine.describe`, and the same session can start another strategy.

## 4. Which of these limits are real, told plainly

- **Windows has no `resource.setrlimit`**: the memory limit is not a kernel quota but "subprocess plus parent polling". Sampling **observes, it does not block**, so a peak allocated and freed between two samples can be missed; the subprocess therefore also reports its `tracemalloc` Python heap peak and the larger of the two wins. Sampling covers the **whole process tree**, because a venv or uv `python.exe` is often just a launcher.
- **The backtest limit is cooperative**: "runs at most that long", not "always returns within that long". Only the hook path can be killed hard.
- Real isolation needs the operating system (Job objects / cgroups) and is out of scope here.

So: **do not treat the sandbox as a security boundary for untrusted code**. It is a guardrail that keeps a strategy from damaging the protocol stream or the engine, not a container.

## 5. What it does not do

- No orders, no venues, no paper or live trading: `order.*` and `market.*` all return 5002.
- `events.resume` is not implemented; the host aligns through `engine.snapshot`.
- No CSV or parquet reading: backtest data comes from the host only (`spec.data.source = "host"`), and `engine` / `files` return 4005 `DATA_UNAVAILABLE` rather than fabricating a result.
- Backtests are single-instrument, single-strategy; workflow backtests are out. Liquidation is judged on a single bar: no cross-bar margin path, no partial liquidation.
- The indicators in `indicators.py` are not exposed through the protocol yet (a strategy can still compute with the `math` whitelist inside its own file, but the library's indicators are not reachable from the engine surface).
