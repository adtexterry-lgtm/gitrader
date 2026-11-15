# SPDX-License-Identifier: CPAL-1.0
"""教学示例：定投（Python 版）。

与 ``packages/engine-core/examples/strategies/dca.ts`` 同名、同参数、同语义（参数口径对照见 TS 文件头，
逐条对应 QD v5.6.5 的 dca_* 参数）。行为要点：固定周期 + 固定金额（每份 = 总预算 / 份数）；
份数上限 = 总额上限；只做多、不择时；设了止盈线就到价整笔卖出并把计数归零，重新开始。
**无业绩含义**——只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
策略文件自包含：不 import 任何模块。
"""


def _num(p, key):
    return p[key]


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and x not in (float("inf"), float("-inf"))


def _fixed(x, digits):
    q = 10 ** digits
    n = int(abs(x) * q + 0.5)
    sign = "-" if x < 0 else ""
    if digits == 0:
        return sign + str(n)
    s = str(n).rjust(digits + 1, "0")
    return sign + s[:-digits] + "." + s[-digits:]


def _fx(x):
    if abs(x) >= 1000:
        return _fixed(x, 1)
    if abs(x) >= 1:
        return _fixed(x, 2)
    return _fixed(x, 4)


def _round6(x):
    """Number(x.toFixed(6)) 的口径（一半远离 0）；目标仓位只保留 6 位，避免 0.30000000000000004 一类的漂移。"""
    return int(abs(x) * 1e6 + 0.5) / 1e6 * (1 if x >= 0 else -1)


def _empty(n, overlays, warmup):
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": overlays, "warmup": warmup}


def anchor(candles, p):
    """把起始时间钉在最近一根：实例启动之前的 K 线不参与（重启不补历史单）。"""
    if _num(p, "startTs") > 0 or len(candles) == 0:
        return p
    out = dict(p)
    out["startTs"] = candles[-1]["t"]
    return out


def evaluate(candles, p):
    n = len(candles)
    every = int(_num(p, "everyBars"))
    orders = int(_num(p, "orders"))
    # 总预算（UI 百分比 → 0–1）。QD 的总额上限就是这样约束的：份数 × 每份 ≤ 总预算。
    budget_in = _num(p, "totalBudgetPct")
    budget = min(1.0, max(0.0, budget_in / 100.0)) if _finite(budget_in) else 1.0
    tp = _num(p, "takeProfitRatio")
    s = _empty(n, {}, 0)
    bought = 0            # 已买份数
    inv_sum = 0.0         # Σ 1/价格
    since_buy = every     # 第一根就买
    prev = 0.0
    avg = [None] * n
    start_ts = _num(p, "startTs")
    for i in range(n):
        c = candles[i]["c"]
        why = ""
        if candles[i]["t"] < start_ts:
            continue  # 实例启动之前的 K 线不参与（target 保持 0）
        if bought > 0 and tp > 0 and c >= (bought / inv_sum) * (1 + tp):
            why = "价 %s 达到止盈线（均价 %s × %s）→ 全部卖出，重新开始" % (_fx(c), _fx(bought / inv_sum), _fixed(1 + tp, 3))
            bought = 0
            inv_sum = 0.0
            since_buy = every
        elif bought < orders and since_buy >= every:
            bought += 1
            inv_sum += 1.0 / c
            since_buy = 0
            why = "第 %d/%d 次定投，价 %s，每份占总预算的 %s%%" % (bought, orders, _fx(c), _fixed(100.0 / orders, 1))
        since_buy += 1
        # 目标仓位 = 已买份数 / 总份数 × 总预算：固定周期、固定金额，份数买满即停在总额上限。
        t = _round6((bought / orders) * budget)
        s["target"][i] = t
        avg[i] = (bought / inv_sum) if bought > 0 else None
        if abs(t - prev) > 1e-9:
            s["reasons"][i] = why
        prev = t
    s["overlays"]["持仓均价"] = avg
    return s


STRATEGY = {
    "id": "dca",
    "name": "DCA (teaching example)",
    "nameZh": "定投（教学示例）",
    "version": "0.2.0",
    "desc": "每隔固定根数买入一份，最多买满若干份；可设置止盈线，到价整笔卖出后重新开始。只做多，不择时。",
    "tags": ["长期", "只做多", "定投"],
    "params": [
        {"key": "everyBars", "label": "每隔多少根买一次", "type": "integer", "default": 24, "min": 1, "max": 1000, "step": 1},
        {"key": "orders", "label": "最多买几次", "type": "integer", "default": 10, "min": 1, "max": 100, "step": 1},
        {"key": "totalBudgetPct", "label": "总预算（占资金比例，100 = 全部）", "type": "number", "default": 100, "min": 1, "max": 100, "step": 1,
         "help": "每份 = 总预算 / 最多买几次；对应 QD dca_total_budget_pct。"},
        {"key": "takeProfitRatio", "label": "止盈线（相对持仓均价的涨幅，0.2 = 20%，0 = 不止盈）", "type": "number", "default": 0, "min": 0, "max": 2, "step": 0.005},
        {"key": "startTs", "label": "起始时间（内部，实例启动时自动填，0 = 从第一根开始）", "type": "number", "default": 0, "min": 0, "hidden": True},
    ],
    "anchor": anchor,
    "evaluate": evaluate,
}
