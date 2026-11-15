# SPDX-License-Identifier: CPAL-1.0
"""教程 02 的 Python 回测入口：加载一个 .py 策略 → 跑一遍回测 → 把结果写成 JSON。

    python docs/user/tutorials/backtest_py.py --strategy <文件.py> --data <K线.csv> --out <结果.json>

由 backtest.mjs（--engine py）调用，也可以自己单独跑。用的是 packages/engine-python 里那份与 TS 模拟器
逐条对齐的回测库（engine/backtest.py）：next-bar-open 成交、吃单费率、不利滑点、手数归一。
不联网、不读密钥、不下单；只读 --strategy / --data，只写 --out。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "packages", "engine-python"))

from engine import backtest as bt  # noqa: E402
from engine import strategy_api as sa  # noqa: E402


def read_candles(path: str) -> list[dict[str, float]]:
    """`t,o,h,l,c[,v]` 的 CSV（可有表头）或 `{"candles":[…]}` / `[{…}]` 的 JSON → K 线列表。"""
    with open(path, "r", encoding="utf-8-sig") as handle:
        text = handle.read().strip()
    rows: list[list[float]] = []
    if text.startswith("{") or text.startswith("["):
        data = json.loads(text)
        items = data if isinstance(data, list) else data.get("candles", [])
        for c in items:
            if isinstance(c, dict):
                rows.append([c["t"], c["o"], c["h"], c["l"], c["c"], c.get("v", 0.0)])
            else:
                rows.append([float(x) for x in c])
    else:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            cells = line.split(",")
            try:
                float(cells[0])
            except ValueError:
                continue  # 表头 / 注释
            rows.append([float(x) for x in cells])
    candles = [
        {"t": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4], "v": r[5] if len(r) > 5 else 0.0}
        for r in rows
    ]
    for k in candles:
        if k["h"] < max(k["o"], k["c"]) or k["l"] > min(k["o"], k["c"]):
            raise SystemExit("K 线 OHLC 不合规（h/l 包不住 o/c）：t=%s" % k["t"])
    candles.sort(key=lambda k: k["t"])
    return candles


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="教程用：跑一个 .py 策略的回测，结果写成 JSON")
    ap.add_argument("--strategy", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--params", default="{}")
    ap.add_argument("--balance", type=float, default=10000.0)
    ap.add_argument("--leverage", type=float, default=1.0)
    ap.add_argument("--fee-rate", type=float, default=0.0005)
    ap.add_argument("--slippage-bps", type=float, default=3.0)
    a = ap.parse_args(argv)

    candles = read_candles(a.data)
    if len(candles) < 2:
        raise SystemExit("K 线不足两根")
    try:
        strategy = sa.load_strategy_file(a.strategy)
    except sa.StrategyError as exc:
        print("策略没加载成功：", exc, file=sys.stderr)
        return 1

    opts = bt.sim_options_from(
        {
            "initialBalance": a.balance,
            "leverage": a.leverage,
            "feeRate": a.fee_rate,
            "slippageBps": a.slippage_bps,
        }
    )
    params = json.loads(a.params)
    sim = bt.run_backtest(strategy, candles, params, opts)
    # series / simulator / options 是内部对象，不写进结果文件
    for key in ("series", "simulator", "options"):
        sim.pop(key, None)
    with open(a.out, "w", encoding="utf-8") as handle:
        json.dump({"strategyId": strategy.id, "sim": sim}, handle, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
