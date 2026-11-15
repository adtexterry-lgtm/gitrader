# SPDX-License-Identifier: CPAL-1.0
"""教学示例：RSI 均值回归（Python 版）。

与 ``packages/engine-core/examples/strategies/rsi-reversion.ts`` 同名、同参数、同语义：Wilder RSI 跌破
下阈值做多、升破上阈值做空，回到离场线平仓。
**无业绩含义**——只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
策略文件自包含：不 import 任何模块。
"""


def _rsi_of(avg_gain, avg_loss):
    """RSI 值：平均跌幅为 0 记 100，平均涨幅为 0 记 0，否则用标准公式。"""
    if avg_loss == 0:
        return 100.0
    if avg_gain == 0:
        return 0.0
    return 100.0 - 100.0 / (1 + avg_gain / avg_loss)


def _wilder_rsi(closes, period):
    """Wilder RSI：首个均值取前 period 根涨跌的算术平均，之后用递推平滑；index < period 为 None。"""
    out = [None] * len(closes)
    if len(closes) <= period:
        return out
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, period + 1):
        change = closes[i] - closes[i - 1]
        avg_gain += max(change, 0.0)
        avg_loss += max(-change, 0.0)
    avg_gain /= period
    avg_loss /= period
    out[period] = _rsi_of(avg_gain, avg_loss)
    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
        out[i] = _rsi_of(avg_gain, avg_loss)
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


def _plain(x):
    """数字的文本：与 TS 模板串 ``${x}`` 一致（整数不带小数点，其余用最短表示）。"""
    value = float(x)
    if value.is_integer():
        return str(int(value))
    return repr(value)


def _empty(n, overlays, warmup):
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": overlays, "warmup": warmup}


def evaluate(candles, p):
    closes = [c["c"] for c in candles]
    period = int(_num(p, "period"))
    lower = _num(p, "lower")
    upper = _num(p, "upper")
    exit_level = _num(p, "exitLevel")
    rsi = _wilder_rsi(closes, period)
    s = _empty(len(candles), {"RSI": rsi}, period)
    pos = 0
    for i in range(len(candles)):
        r = rsi[i]
        if i < period or r is None:
            continue
        nxt = pos
        why = ""
        if pos == 0:
            if r < lower:
                nxt = 1
                why = "RSI%d %s < %s → 做多" % (period, _fixed(r, 1), _plain(lower))
            elif r > upper and _bool(p, "allowShort"):
                nxt = -1
                why = "RSI%d %s > %s → 做空" % (period, _fixed(r, 1), _plain(upper))
        elif pos > 0 and r >= exit_level:
            nxt = 0
            why = "RSI%d %s ≥ %s → 平多" % (period, _fixed(r, 1), _plain(exit_level))
        elif pos < 0 and r <= exit_level:
            nxt = 0
            why = "RSI%d %s ≤ %s → 平空" % (period, _fixed(r, 1), _plain(exit_level))
        s["target"][i] = nxt
        if nxt != pos:
            s["reasons"][i] = why
        pos = nxt
    return s


STRATEGY = {
    "id": "rsi-reversion",
    "name": "RSI mean reversion (teaching example)",
    "nameZh": "RSI 均值回归（教学示例）",
    "version": "0.1.0",
    "desc": "Wilder RSI 跌破下阈值做多、升破上阈值做空，回到离场线平仓。适合区间震荡；单边趋势里超卖会持续更久，逆势入场容易连续失手。",
    "tags": ["均值回归", "RSI"],
    "params": [
        {"key": "period", "label": "RSI 周期", "type": "integer", "default": 14, "min": 2, "max": 100, "step": 1},
        {"key": "lower", "label": "做多阈值", "type": "number", "default": 30, "min": 1, "max": 49, "step": 1},
        {"key": "upper", "label": "做空阈值", "type": "number", "default": 70, "min": 51, "max": 99, "step": 1},
        {"key": "exitLevel", "label": "离场线", "type": "number", "default": 50, "min": 1, "max": 99, "step": 1},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
