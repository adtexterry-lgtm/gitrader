# SPDX-License-Identifier: CPAL-1.0
"""教学示例：双均线交叉（Python 版）。

与 ``packages/engine-core/examples/strategies/ema-cross.ts`` 同名、同参数、同语义：
快线 EMA 上穿慢线做多、下穿做空（可关），交叉即反手。
**无业绩含义**——这里只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
策略文件自包含：不 import 任何模块（沙箱 PROFILE_STRATEGY 档）。
"""


def _ema_series(values, period):
    """EMA：ema[0] = values[0]，ema[i] = values[i]·k + ema[i-1]·(1-k)，k = 2/(period+1)。

    画线只在 i >= period-1 的位置给值，前面填 None（均线还没「长」够 period 根）。
    """
    out = [None] * len(values)
    if not values:
        return out
    k = 2.0 / (period + 1)
    e = values[0]
    for i, v in enumerate(values):
        if i > 0:
            e = v * k + e * (1 - k)
        if i >= period - 1:
            out[i] = e
    return out


def _num(p, key):
    return p[key]


def _bool(p, key):
    return bool(p[key])


def _fixed(x, digits):
    """JS toFixed 的口径（一半远离 0）。只用于理由文案。"""
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


def _reason_at(fast_n, slow_n, f, s, prev, nxt):
    """一次目标变化的说明：交叉方向由两线当前高低决定，动作由「从哪来、到哪去」决定。"""
    cross = "上穿" if f > s else "下穿"
    if nxt == 0:
        act = "平多" if prev > 0 else "平空"
    elif nxt == 1:
        act = "反手做多" if prev == -1 else "做多"
    else:
        act = "反手做空" if prev == 1 else "做空"
    return "EMA%d %s %s EMA%d %s → %s" % (fast_n, _fx(f), cross, slow_n, _fx(s), act)


def evaluate(candles, p):
    closes = [c["c"] for c in candles]
    fast_n = int(_num(p, "fast"))
    slow_n = max(int(_num(p, "slow")), fast_n + 1)
    allow_short = _bool(p, "allowShort")
    fast_line = _ema_series(closes, fast_n)
    slow_line = _ema_series(closes, slow_n)
    s = _empty(len(candles), {"EMA%d" % fast_n: fast_line, "EMA%d" % slow_n: slow_line}, slow_n)
    pos = 0
    for i in range(slow_n, len(candles)):
        f = fast_line[i]
        sl = slow_line[i]
        if f is None or sl is None:
            continue
        if f > sl:
            nxt = 1
        elif f < sl:
            nxt = -1 if allow_short else 0
        else:
            nxt = pos
        s["target"][i] = nxt
        if nxt != pos:
            s["reasons"][i] = _reason_at(fast_n, slow_n, f, sl, pos, nxt)
        pos = nxt
    return s


STRATEGY = {
    "id": "ema-cross",
    "name": "EMA cross (teaching example)",
    "nameZh": "双均线交叉（教学示例）",
    "version": "0.1.0",
    "desc": "快线 EMA 上穿慢线 EMA 做多、下穿慢线做空（可关），交叉即反手。趋势行情里跟着均线持仓；横盘时两线反复交叉，会频繁进出。",
    "tags": ["趋势", "均线"],
    "params": [
        {"key": "fast", "label": "快线周期", "type": "integer", "default": 12, "min": 2, "max": 100, "step": 1},
        {"key": "slow", "label": "慢线周期", "type": "integer", "default": 26, "min": 3, "max": 400, "step": 1},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
