# SPDX-License-Identifier: CPAL-1.0
"""教学示例：ATR 通道趋势跟随（Supertrend，Python 版）。

与 ``packages/engine-core/examples/strategies/supertrend.ts`` 同名、同参数、同语义：以 (最高价 + 最低价) / 2
为中线、ATR 的倍数做通道；收盘站上上轨视为上升趋势做多，跌破下轨视为下降趋势做空（可关闭）。
通道随趋势单向收缩，直到被收盘价突破才翻转。
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


def _fx(x):
    if abs(x) >= 1000:
        return _fixed(x, 1)
    if abs(x) >= 1:
        return _fixed(x, 2)
    return _fixed(x, 4)


def _empty(n, overlays, warmup):
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": overlays, "warmup": warmup}


def evaluate(candles, p):
    n = len(candles)
    period = int(_num(p, "period"))
    multiplier = _num(p, "multiplier")
    allow_short = _bool(p, "allowShort")
    upper = [None] * n
    lower = [None] * n
    s = _empty(n, {"上轨": upper, "下轨": lower}, period - 1)
    if n < period:
        return s

    # 真实波幅 TR：第一根用当根振幅，之后带上与前收盘的跳空。
    tr = [0.0] * n
    for i in range(n):
        if i == 0:
            tr[0] = candles[0]["h"] - candles[0]["l"]
            continue
        h = candles[i]["h"]
        low = candles[i]["l"]
        pc = candles[i - 1]["c"]
        tr[i] = max(h - low, abs(h - pc), abs(low - pc))

    # ATR：前 period 根取算术平均，之后用 Wilder 平滑。
    atr = [None] * n
    total = 0.0
    for j in range(period):
        total += tr[j]
    atr[period - 1] = total / period
    for i in range(period, n):
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period

    v = period - 1
    prev_upper = 0.0
    prev_lower = 0.0
    trend_up = False
    for i in range(v, n):
        c = candles[i]["c"]
        hl2 = (candles[i]["h"] + candles[i]["l"]) / 2
        at = atr[i]
        basic_upper = hl2 + multiplier * at
        basic_lower = hl2 - multiplier * at
        final_upper = basic_upper
        final_lower = basic_lower
        if i == v:
            up = c > basic_upper
        else:
            pc = candles[i - 1]["c"]
            final_upper = basic_upper if (basic_upper < prev_upper or pc > prev_upper) else prev_upper
            final_lower = basic_lower if (basic_lower > prev_lower or pc < prev_lower) else prev_lower
            up = (c >= final_lower) if trend_up else (c > final_upper)
        upper[i] = final_upper
        lower[i] = final_lower
        s["target"][i] = 1 if up else (-1 if allow_short else 0)
        if i == v:
            s["reasons"][i] = "初始趋势向上" if up else "初始趋势向下"
        elif up != trend_up:
            if up:
                s["reasons"][i] = "收盘 %s 上破上轨 %s → %s" % (_fx(c), _fx(final_upper), "反手做多" if allow_short else "做多")
            elif allow_short:
                s["reasons"][i] = "收盘 %s 下破下轨 %s → 反手做空" % (_fx(c), _fx(final_lower))
            else:
                s["reasons"][i] = "收盘 %s 下破下轨 %s → 平多" % (_fx(c), _fx(final_lower))
        prev_upper = final_upper
        prev_lower = final_lower
        trend_up = up
    return s


STRATEGY = {
    "id": "supertrend",
    "name": "Supertrend, ATR channel (teaching example)",
    "nameZh": "超级趋势·ATR 通道（教学示例）",
    "version": "0.1.0",
    "desc": "以 (最高价 + 最低价) / 2 为中线、ATR 的倍数做通道：收盘站上上轨视为上升趋势做多，跌破下轨视为下降趋势做空（可关闭）。通道随趋势单向收缩，直到被收盘价突破才翻转。失效场景：震荡市里价格反复穿越通道，会频繁翻转并累积手续费损耗。",
    "tags": ["趋势", "ATR", "通道"],
    "params": [
        {"key": "period", "label": "ATR 周期", "type": "integer", "default": 10, "min": 2, "max": 100, "step": 1},
        {"key": "multiplier", "label": "通道半宽（ATR 倍数）", "type": "number", "default": 3, "min": 0.5, "max": 10, "step": 0.5},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
