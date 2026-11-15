# SPDX-License-Identifier: CPAL-1.0
"""教学示例：马丁加倍（只做多，Python 版）。

与 ``packages/engine-core/examples/strategies/martingale.ts`` 同名、同参数、同语义（参数口径对照见
TS 文件头，对应 QD v5.6.5 的 multiplier / maxLayers / takeProfitPct / stopLossPct）。
行为要点：亏损 → 层数 +1、下一轮按 multiplier 加倍进场；盈利 → 层数归零；层数封顶 maxDoublings；
止盈止损都对「本轮入场价」算。连续亏损时仓位指数放大，回撤风险同样指数放大——这是教学用的
反面教材级风险示例，不构成任何收益承诺，请勿照此实盘。
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


def _empty(n, overlays, warmup):
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": overlays, "warmup": warmup}


def evaluate(candles, p):
    n = len(candles)
    base = _num(p, "baseSize")
    # multiplier 缺省按 QD 的默认值 2 处理（直接调 evaluate 传了半个参数对象时不至于算成 NaN）。
    mult_in = _num(p, "multiplier")
    mult = max(1.0, mult_in) if _finite(mult_in) else 2.0
    max_doublings = int(_num(p, "maxDoublings"))
    tp = _num(p, "takeProfitPct")
    sl = _num(p, "stopLossPct")
    entry_at = [None] * n
    tp_at = [None] * n
    sl_at = [None] * n
    s = _empty(n, {"入场价": entry_at, "止盈价": tp_at, "止损价": sl_at}, 1)
    level = 0        # 当前加倍层，从 0 起
    entry = 0.0      # 持仓参考价：入场那根的收盘价（教学简化，真实成交在下一根开盘）
    in_pos = False
    cur = 0.0        # 当前目标仓位
    # 与 QD 的差异（有意保留）：QD 的分层马丁在同一个持仓里按跌幅逐层加仓，整篮按均价整体止盈 /
    # 整体止损；本示例是「一层一进、离场后再加倍重进」，层数只在止损后前进。两者都以 multiplier
    # 指数放大仓位，风险结构相同，结算路径不同。
    for i in range(1, n):
        c = candles[i]["c"]
        nxt = cur
        why = ""
        if not in_pos:
            # 加仓数量随层数指数递增：baseSize × multiplier^level，封顶 1（满仓）。
            size = min(1.0, base * (mult ** level))
            nxt = size
            entry = c
            in_pos = True
            why = "第 %d 层进场 %s，参考价 %s" % (level, _fx(size), _fx(c))
        elif c >= entry * (1 + tp):
            nxt = 0.0
            in_pos = False
            why = "收盘 %s ≥ 止盈价 %s → 止盈，层数归零" % (_fx(c), _fx(entry * (1 + tp)))
            level = 0
        elif c <= entry * (1 - sl):
            nxt = 0.0
            in_pos = False
            why = "收盘 %s ≤ 止损价 %s → 止损，下一轮第 %d 层" % (_fx(c), _fx(entry * (1 - sl)), min(level + 1, max_doublings))
            level = min(level + 1, max_doublings)
        s["target"][i] = nxt
        if nxt != cur:
            s["reasons"][i] = why
        cur = nxt
        if in_pos:
            entry_at[i] = entry
            tp_at[i] = entry * (1 + tp)
            sl_at[i] = entry * (1 - sl)
    return s


STRATEGY = {
    "id": "martingale",
    "name": "Martingale, long only (teaching example)",
    "nameZh": "马丁加倍·只做多（教学示例）",
    "version": "0.2.0",
    "desc": "只做多的马丁加倍：每根 K 线空仓就按当前加倍层进场，持仓到止盈线则清仓并把层数归零，持仓到止损线则清仓并把层数加一，下一根按更重的仓位再进。连续亏损时仓位随层数指数放大，回撤与爆仓风险也随之指数放大；这是教学用的反面教材级风险示例，不构成任何收益承诺，请勿照此实盘。",
    "tags": ["马丁", "加倍", "高风险"],
    "params": [
        {"key": "baseSize", "label": "基础仓位（第 0 层）", "type": "number", "default": 0.1, "min": 0.01, "max": 1, "step": 0.01},
        {"key": "multiplier", "label": "加倍倍数（每层的加仓倍数）", "type": "number", "default": 2, "min": 1.1, "max": 3, "step": 0.1,
         "help": "对应 QD multiplier（strategy_bot_recommend.py:245，默认 2，范围 1.1–3）。"},
        {"key": "maxDoublings", "label": "最多加倍层数（封顶）", "type": "integer", "default": 3, "min": 0, "max": 6, "step": 1},
        {"key": "takeProfitPct", "label": "止盈线（相对本轮入场价的涨幅，0.01 = 1%）", "type": "number", "default": 0.01, "min": 0.001, "max": 0.5, "step": 0.001},
        {"key": "stopLossPct", "label": "止损线（相对本轮入场价的跌幅，0.02 = 2%）", "type": "number", "default": 0.02, "min": 0.001, "max": 0.5, "step": 0.001},
    ],
    "evaluate": evaluate,
}
