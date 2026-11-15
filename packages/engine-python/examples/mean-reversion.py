# SPDX-License-Identifier: CPAL-1.0
"""教学示例：布林带均值回归（Python 版）。

与 ``packages/engine-core/examples/strategies/mean-reversion.ts`` 同名、同参数、同语义：价格跌破布林带
下轨做多、突破上轨做空，回到中轨平仓。
**无业绩含义**——只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
策略文件自包含：不 import 任何模块（标准差用 ** 0.5，不用 math.sqrt）。
"""


def _rolling_mean_std(values, period):
    """滚动均值 / 总体标准差（除以 period，与 TS 版一致；样本口径会让带宽变宽）。"""
    mean = [None] * len(values)
    std = [None] * len(values)
    for i in range(period - 1, len(values)):
        total = 0.0
        for j in range(i - period + 1, i + 1):
            total += values[j]
        m = total / period
        var = 0.0
        for j in range(i - period + 1, i + 1):
            d = values[j] - m
            var += d * d
        mean[i] = m
        std[i] = (var / period) ** 0.5
    return mean, std


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


def _fx(x):
    if abs(x) >= 1000:
        return _fixed(x, 1)
    if abs(x) >= 1:
        return _fixed(x, 2)
    return _fixed(x, 4)


def _empty(n, overlays, warmup):
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": overlays, "warmup": warmup}


def evaluate(candles, p):
    closes = [c["c"] for c in candles]
    period = int(_num(p, "period"))
    k = _num(p, "k")
    mean, std = _rolling_mean_std(closes, period)
    upper = [None if m is None else m + k * std[i] for i, m in enumerate(mean)]
    lower = [None if m is None else m - k * std[i] for i, m in enumerate(mean)]
    s = _empty(len(candles), {"上轨": upper, "中轨": mean, "下轨": lower}, period - 1)
    pos = 0
    for i in range(len(candles)):
        m = mean[i]
        if m is None:
            continue
        c = closes[i]
        up = upper[i]
        lo = lower[i]
        nxt = pos
        why = ""
        if pos == 0:
            if c < lo:
                nxt = 1
                why = "价 %s 跌破下轨 %s → 做多（等回归中轨 %s）" % (_fx(c), _fx(lo), _fx(m))
            elif c > up and _bool(p, "allowShort"):
                nxt = -1
                why = "价 %s 突破上轨 %s → 做空（等回归中轨 %s）" % (_fx(c), _fx(up), _fx(m))
        elif pos > 0 and c >= m:
            nxt = 0
            why = "价 %s 回到中轨 %s → 平多" % (_fx(c), _fx(m))
        elif pos < 0 and c <= m:
            nxt = 0
            why = "价 %s 回到中轨 %s → 平空" % (_fx(c), _fx(m))
        s["target"][i] = nxt
        if nxt != pos:
            s["reasons"][i] = why
        pos = nxt
    return s


STRATEGY = {
    "id": "mean-reversion",
    "name": "Mean reversion, Bollinger (teaching example)",
    "nameZh": "均值回归·布林带（教学示例）",
    "version": "0.1.0",
    "desc": "价格跌破布林带下轨做多、突破上轨做空，回到中轨平仓。适合区间震荡，单边行情里会逆势亏损。",
    "tags": ["震荡", "反转", "布林带"],
    "params": [
        {"key": "period", "label": "布林周期", "type": "integer", "default": 20, "min": 5, "max": 200, "step": 1},
        {"key": "k", "label": "带宽（σ 倍数）", "type": "number", "default": 2, "min": 0.5, "max": 5, "step": 0.1},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
