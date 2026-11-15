# SPDX-License-Identifier: CPAL-1.0
"""教学示例：变化率（ROC）动量（Python 版）。

与 ``packages/engine-core/examples/strategies/momentum-roc.ts`` 同名、同参数、同语义：收盘价相对 N 根之前
的变化率高于阈值做多、低于负阈值做空，回到阈值内平仓。
**无业绩含义**——只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
策略文件自包含：不 import 任何模块。
"""


def _num(p, key):
    return p[key]


def _bool(p, key):
    return bool(p[key])


def _fixed(x, digits):
    q = 10 ** digits
    n = int(abs(x) * q + 0.5)
    sign = "-" if x < 0 else ""
    if digits == 0:
        return sign + str(n)
    s = str(n).rjust(digits + 1, "0")
    return sign + s[:-digits] + "." + s[-digits:]


def _empty(n, overlays, warmup):
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": overlays, "warmup": warmup}


def evaluate(candles, p):
    n = len(candles)
    closes = [c["c"] for c in candles]
    lookback = int(_num(p, "lookback"))
    threshold = _num(p, "threshold")
    allow_short = _bool(p, "allowShort")
    roc = [None] * n
    for i in range(lookback, n):
        base = closes[i - lookback]
        if base <= 0:
            continue
        roc[i] = closes[i] / base - 1.0
    s = _empty(n, {"ROC": roc}, lookback)
    pos = 0
    for i in range(n):
        r = roc[i]
        nxt = 0
        why = ""
        if r is None:
            # 基准价 ≤ 0 时 ROC 不可用：目标回到 0，并给出理由（不能静默平仓）。
            if nxt != pos:
                why = "ROC%d 不可用（基准价 ≤ 0）→ 平仓" % lookback
        elif r > threshold:
            nxt = 1
            if nxt != pos:
                why = "ROC%d %s%% > %s%% → 做多" % (lookback, _fixed(r * 100, 2), _fixed(threshold * 100, 2))
        elif r < -threshold:
            if allow_short:
                nxt = -1
                if nxt != pos:
                    why = "ROC%d %s%% < -%s%% → 做空" % (lookback, _fixed(r * 100, 2), _fixed(threshold * 100, 2))
            else:
                nxt = 0
                if nxt != pos:
                    why = "ROC%d %s%% < -%s%% → 平仓（不允许做空）" % (lookback, _fixed(r * 100, 2), _fixed(threshold * 100, 2))
        elif nxt != pos:
            why = "ROC%d %s%%，|ROC| ≤ %s%% → 平仓" % (lookback, _fixed(r * 100, 2), _fixed(threshold * 100, 2))
        s["target"][i] = nxt
        if nxt != pos:
            s["reasons"][i] = why
        pos = nxt
    return s


STRATEGY = {
    "id": "momentum-roc",
    "name": "Momentum, rate of change (teaching example)",
    "nameZh": "动量·变化率（教学示例）",
    "version": "0.1.0",
    "desc": "收盘价相对 N 根之前的变化率高于阈值做多、低于负阈值做空，回到阈值内平仓。单边趋势里跟随方向；阈值附近来回波动时会反复开平、来回付出成本，横盘里尤其明显。",
    "tags": ["动量", "ROC"],
    "params": [
        {"key": "lookback", "label": "回看根数", "type": "integer", "default": 20, "min": 1, "max": 400, "step": 1},
        {"key": "threshold", "label": "触发阈值", "type": "number", "default": 0.02, "min": 0.001, "max": 1, "step": 0.001},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
