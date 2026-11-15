# SPDX-License-Identifier: CPAL-1.0
"""教学示例：只做多的简化网格（Python 版）。

与 ``packages/engine-core/examples/strategies/grid.ts`` 同名、同参数、同语义（参数口径对照见 TS 文件头：
QD v5.6.5 的 upperPrice / lowerPrice / gridCount / gridMode / boundaryAction … 逐条对应）。
行为要点：等差 / 等比两种格子；跌出下沿、涨出上沿按 boundaryAction 处理；每一格独立止盈
（目标仓位每跨上一条网格线就减一格）。

与 TS 的唯一差异：策略文件不许 import，所以自然对数用自带的 ``_ln``（归一化到 [1,2) 后用
atanh 级数，与 C 的 log 在整个价格区间上差 < 1e-12 相对误差）。

**无业绩含义**——只演示策略文件怎么写，不是推荐、不是卖点；默认不加载。
"""

LN2 = 0.6931471805599453


def _ln(x):
    """自然对数（自包含实现，策略文件不允许 import math）。"""
    if x <= 0:
        raise ValueError("log domain error: %r" % (x,))
    n = 0
    while x >= 2.0:
        x /= 2.0
        n += 1
    while x < 1.0:
        x *= 2.0
        n -= 1
    t = (x - 1.0) / (x + 1.0)
    t2 = t * t
    term = t
    total = 0.0
    for k in range(1, 60, 2):
        total += term / k
        term *= t2
    return 2.0 * total + n * LN2


def _floor(x):
    i = int(x)
    return i - 1 if i > x else i


def _js_round(x):
    """JS Math.round：一半朝 +∞（Python 的 round 是银行家舍入，口径不同）。"""
    return _floor(x + 0.5)


def _num(p, key):
    return p[key]


def _str(p, key):
    return str(p[key])


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
    return int(abs(x) * 1e6 + 0.5) / 1e6 * (1 if x >= 0 else -1)


def _empty(n, overlays, warmup):
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": overlays, "warmup": warmup}


def anchor(candles, p):
    """中心价 0 = 取最近一根收盘价（实例启动时钉死，之后不再跟着价格跑）。"""
    if _num(p, "center") > 0 or len(candles) == 0:
        return p
    out = dict(p)
    out["center"] = candles[-1]["c"]
    return out


def evaluate(candles, p):
    n = len(candles)
    center_in = _num(p, "center") if _num(p, "center") > 0 else (candles[0]["c"] if candles else 0.0)
    half = _num(p, "rangeRatio") * center_in
    # 上下限：QD 要求显式给；这里允许省略，省略时按「中心价 ± rangeRatio」推导（旧示例的行为，逐笔不变）。
    ex_lower = _num(p, "lowerPrice")
    ex_upper = _num(p, "upperPrice")
    explicit = ex_lower > 0 and ex_upper > ex_lower
    lower = ex_lower if explicit else center_in - half
    upper = ex_upper if explicit else center_in + half
    center = (lower + upper) / 2 if explicit else center_in
    grids = max(2, _js_round(_num(p, "grids")))
    exposure = _num(p, "maxExposure")
    # gridMode=geometric 需要正的下限（QD levels.py 同样要求 lo > 0，否则退回等差）。
    geometric = _str(p, "gridMode") == "geometric" and lower > 0 and upper > lower
    action = _str(p, "boundaryAction")
    lines = []
    for g in range(grids + 1):
        if geometric:
            lines.append(lower * (upper / lower) ** (g / grids))
        else:
            lines.append(lower + ((upper - lower) * g) / grids)
    overlays = {
        "网格上沿": [upper] * n,
        "网格下沿": [lower] * n,
        "中心价": [center] * n,
    }
    s = _empty(n, overlays, 0)
    if not (center > 0) or not (upper > lower):
        return s
    prev = 0.0
    for i in range(n):
        c = candles[i]["c"]
        # 价格在「格索引空间」里的位置：等差是线性刻度，等比是对数刻度（对数下相邻格等距）。
        if geometric:
            pos = _ln(c / lower) / _ln(upper / lower)
        else:
            pos = (c - lower) / (upper - lower)
        # 落在第几格：把 0…1 的位置换成 0…grids 的整数格号（与 QD「当前价在第几个格子」同一含义）。
        step = min(grids, max(0, _js_round((1 - pos) * grids)))
        # 每格独立止盈：持仓 = 已成交格数 × 每格权重。价格每向上跨过一条网格线就少持一格，
        # 向下跨线则多买一格；各格的盈亏不互相抵消。
        t = _round6((step / grids) * exposure)
        outside = c < lower or c > upper
        why = "价 %s 落在第 %d/%d 格（区间 %s–%s）→ 目标仓位 %s%%" % (_fx(c), step, grids, _fx(lower), _fx(upper), _fixed(t * 100, 0))
        if outside and action == "stop_loss":
            t = 0.0
            why = "价 %s 越出区间 %s–%s → boundaryAction=stop_loss：清仓" % (_fx(c), _fx(lower), _fx(upper))
        elif outside and action == "hold":
            t = prev
            why = "价 %s 越出区间 %s–%s → boundaryAction=hold：保持仓位 %s%%" % (_fx(c), _fx(lower), _fx(upper), _fixed(prev * 100, 0))
        s["target"][i] = t
        if abs(t - prev) > 1e-9:
            s["reasons"][i] = why
        prev = t
    return s


STRATEGY = {
    "id": "grid",
    "name": "Grid, long-only (teaching example)",
    "nameZh": "网格·只做多（教学示例）",
    "version": "0.2.0",
    "desc": "在「中心价 ± 区间」内等分成若干格：价格越低持仓越多、越高持仓越少，跌出区间满仓、涨出区间清仓。震荡里一格一格买卖，单边下跌时越买越亏。",
    "tags": ["震荡", "网格", "只做多"],
    "params": [
        {"key": "center", "label": "中心价（0 = 取第一根收盘价）", "type": "number", "default": 0, "min": 0, "step": 0.01},
        {"key": "rangeRatio", "label": "区间半宽（占中心价的比例，0.1 = 10%）", "type": "number", "default": 0.1, "min": 0.01, "max": 0.5, "step": 0.005},
        {"key": "grids", "label": "格数", "type": "integer", "default": 8, "min": 2, "max": 50, "step": 1},
        {"key": "maxExposure", "label": "满格时占用资金比例", "type": "number", "default": 1, "min": 0.1, "max": 1, "step": 0.1},
        {"key": "lowerPrice", "label": "下限价（0 = 用中心价与区间半宽推导）", "type": "number", "default": 0, "min": 0, "step": 0.01,
         "help": "与 upperPrice 同时 > 0 才生效；对应 QD lowerPrice（grid/config.py:100）。"},
        {"key": "upperPrice", "label": "上限价（0 = 用中心价与区间半宽推导）", "type": "number", "default": 0, "min": 0, "step": 0.01,
         "help": "与 lowerPrice 同时 > 0 才生效；对应 QD upperPrice（grid/config.py:99）。"},
        {"key": "gridMode", "label": "格子间距", "type": "select", "default": "arithmetic", "options": ["arithmetic", "geometric"],
         "help": "arithmetic = 等差，geometric = 等比（QD gridMode，grid/config.py:107）。"},
        {"key": "boundaryAction", "label": "越界处理", "type": "select", "default": "pause", "options": ["pause", "stop_loss", "hold"],
         "help": "pause = 停在边界格；stop_loss = 越界清仓；hold = 越界保持越界前的仓位（QD boundaryAction）。"},
    ],
    "anchor": anchor,
    "evaluate": evaluate,
}
