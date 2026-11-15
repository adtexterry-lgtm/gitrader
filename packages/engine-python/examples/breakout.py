# SPDX-License-Identifier: CPAL-1.0
"""教学示例：唐奇安通道突破（Python 版）。

与 ``packages/engine-core/examples/strategies/breakout.ts`` 同名、同参数、同语义：
收盘价突破前 N 根最高价做多、跌破前 N 根最低价做空，反向跌破较短通道离场。
**无业绩含义**——只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
策略文件自包含：不 import 任何模块。
"""


def _prior_extreme(values, period, kind):
    """第 i 根用「前 period 根」（不含当根）的极值；数据不够的位置为 None。"""
    out = [None] * len(values)
    for i in range(period, len(values)):
        x = values[i - period]
        for j in range(i - period + 1, i):
            x = max(x, values[j]) if kind == "max" else min(x, values[j])
        out[i] = x
    return out


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
    highs = [c["h"] for c in candles]
    lows = [c["l"] for c in candles]
    entry = int(_num(p, "entry"))
    exit_n = min(int(_num(p, "exit")), entry)
    hi_e = _prior_extreme(highs, entry, "max")
    lo_e = _prior_extreme(lows, entry, "min")
    hi_x = _prior_extreme(highs, exit_n, "max")
    lo_x = _prior_extreme(lows, exit_n, "min")
    s = _empty(len(candles), {"入场上轨": hi_e, "入场下轨": lo_e, "离场上轨": hi_x, "离场下轨": lo_x}, entry)
    pos = 0
    for i in range(len(candles)):
        if hi_e[i] is None or lo_e[i] is None or hi_x[i] is None or lo_x[i] is None:
            continue
        c = closes[i]
        nxt = pos
        why = ""
        if pos == 0:
            if c > hi_e[i]:
                nxt = 1
                why = "收盘 %s 突破前 %d 根最高 %s → 做多" % (_fx(c), entry, _fx(hi_e[i]))
            elif c < lo_e[i] and _bool(p, "allowShort"):
                nxt = -1
                why = "收盘 %s 跌破前 %d 根最低 %s → 做空" % (_fx(c), entry, _fx(lo_e[i]))
        elif pos > 0 and c < lo_x[i]:
            nxt = 0
            why = "收盘 %s 跌破前 %d 根最低 %s → 平多" % (_fx(c), exit_n, _fx(lo_x[i]))
        elif pos < 0 and c > hi_x[i]:
            nxt = 0
            why = "收盘 %s 突破前 %d 根最高 %s → 平空" % (_fx(c), exit_n, _fx(hi_x[i]))
        s["target"][i] = nxt
        if nxt != pos:
            s["reasons"][i] = why
        pos = nxt
    return s


STRATEGY = {
    "id": "breakout",
    "name": "Breakout, Donchian (teaching example)",
    "nameZh": "突破·唐奇安通道（教学示例）",
    "version": "0.1.0",
    "desc": "收盘价突破前 N 根最高价做多、跌破前 N 根最低价做空，反向跌破较短通道离场。经典海龟式趋势跟随。",
    "tags": ["趋势", "突破", "海龟"],
    "params": [
        {"key": "entry", "label": "入场通道（根）", "type": "integer", "default": 20, "min": 5, "max": 200, "step": 1},
        {"key": "exit", "label": "离场通道（根）", "type": "integer", "default": 10, "min": 2, "max": 100, "step": 1},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
