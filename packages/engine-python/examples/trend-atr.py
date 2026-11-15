# SPDX-License-Identifier: CPAL-1.0
"""教学示例：均线趋势过滤 + ATR 移动止损（Python 版）。

与 ``packages/engine-core/examples/strategies/trend-atr.ts`` 同名、同参数、同语义（参数口径对照见 TS 文件头，
对应 QD v5.6.5 的 maPeriod / trailingTpCallbackPct / adaptiveAtrPeriod 等）。行为要点：快慢 EMA 交叉定
方向；开仓时按 收盘 ∓ ATR×倍数 设初始止损，之后止损线单向移动（只朝有利方向走）；收盘触及止损线即
离场；离场后要等快慢线方向翻转才允许再进（避免同一段趋势里反复被扫）。
**无业绩含义**——只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
策略文件自包含：不 import 任何模块。
"""


def _ema(values, period):
    """EMA：k = 2 / (n + 1)，首根直接取值；长度与输入相同。"""
    out = []
    k = 2.0 / (period + 1)
    for i, v in enumerate(values):
        out.append(v if i == 0 else out[i - 1] + k * (v - out[i - 1]))
    return out


def _true_ranges(candles):
    """真实波幅：首根为 h − l，之后取 h − l 与相对前收的两个跳空幅度的最大值。"""
    out = []
    for i, c in enumerate(candles):
        if i == 0:
            out.append(c["h"] - c["l"])
        else:
            prev_c = candles[i - 1]["c"]
            out.append(max(c["h"] - c["l"], abs(c["h"] - prev_c), abs(c["l"] - prev_c)))
    return out


def _atr(tr, period):
    """ATR：第 period − 1 根取前 period 个 TR 的均值，之后 Wilder 平滑；更早的为 None。"""
    out = [None] * len(tr)
    if len(tr) < period:
        return out
    total = 0.0
    for i in range(period):
        total += tr[i]
    out[period - 1] = total / period
    for i in range(period, len(tr)):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
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
    fast = int(_num(p, "emaFast"))
    slow_n = max(int(_num(p, "emaSlow")), fast + 1)
    period = int(_num(p, "atrPeriod"))
    mult = _num(p, "atrMultiple")
    allow_short = _bool(p, "allowShort")
    ema_fast = _ema(closes, fast)
    ema_slow = _ema(closes, slow_n)
    atr_series = _atr(_true_ranges(candles), period)
    stop_line = [None] * len(candles)
    warmup = max(slow_n, period)
    s = _empty(len(candles), {"EMA快": ema_fast, "EMA慢": ema_slow, "止损线": stop_line}, warmup)
    pos = 0        # 0 = 空仓，+1 = 持多，−1 = 持空
    stop = 0.0     # 移动止损价
    armed = True   # 趋势是否「新鲜」：止损出场后要等快慢线翻转才重新置 True
    rearm = 0      # 需要看到的方向：+1 = 快线回到慢线上方，−1 = 快线回到慢线下方，0 = 无需翻转
    for i in range(warmup, len(candles)):
        c = closes[i]
        atr_now = atr_series[i]
        if atr_now is None:
            continue
        # 追踪距离 = atrMultiple × 当前 ATR（用波动率尺度，而不是固定百分比回撤）。
        dist = mult * atr_now
        up = ema_fast[i] > ema_slow[i]
        down = ema_fast[i] < ema_slow[i]
        nxt = pos
        why = ""
        if pos > 0:
            # 移动止损只朝有利方向走：多头取 max(旧止损, 收盘 − dist)。
            stop = max(stop, c - dist)
            if c < stop:
                nxt = 0
                why = "收盘 %s 跌破移动止损 %s → 平多" % (_fx(c), _fx(stop))
                armed = False
                rearm = -1
        elif pos < 0:
            stop = min(stop, c + dist)
            if c > stop:
                nxt = 0
                why = "收盘 %s 突破移动止损 %s → 平空" % (_fx(c), _fx(stop))
                armed = False
                rearm = 1
        else:
            if not armed and ((rearm > 0 and up) or (rearm < 0 and down)):
                armed = True
                rearm = 0
            if armed and up:
                nxt = 1
                stop = c - dist  # 开仓即带初始止损
                why = "EMA%d > EMA%d，进多，止损 %s" % (fast, slow_n, _fx(stop))
            elif armed and down and allow_short:
                nxt = -1
                stop = c + dist
                why = "EMA%d < EMA%d，进空，止损 %s" % (fast, slow_n, _fx(stop))
        s["target"][i] = nxt
        if nxt != pos:
            s["reasons"][i] = why
        pos = nxt
        stop_line[i] = None if pos == 0 else stop
    return s


STRATEGY = {
    "id": "trend-atr",
    "name": "Trend filter with ATR trailing stop (teaching example)",
    "nameZh": "均线趋势 + ATR 移动止损（教学示例）",
    "version": "0.2.0",
    "desc": "快慢 EMA 定方向，顺方向开仓；持仓后按 收盘 ∓ ATR×倍数 单向移动止损，收盘触及止损线即离场，之后要等快慢线方向翻转才允许再进。横盘里快慢线来回交叉、价格反复扫过止损线，会被连续小亏打掉；ATR 变大时止损距离变宽，单笔亏损也随之放大。",
    "tags": ["趋势", "ATR", "移动止损"],
    "params": [
        {"key": "emaFast", "label": "快线周期（根）", "type": "integer", "default": 20, "min": 2, "max": 200, "step": 1},
        {"key": "emaSlow", "label": "慢线周期（根）", "type": "integer", "default": 50, "min": 3, "max": 400, "step": 1},
        {"key": "atrPeriod", "label": "ATR 周期（根）", "type": "integer", "default": 14, "min": 2, "max": 100, "step": 1},
        {"key": "atrMultiple", "label": "ATR 止损倍数", "type": "number", "default": 3, "min": 0.5, "max": 10, "step": 0.5},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
