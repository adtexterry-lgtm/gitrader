# SPDX-License-Identifier: CPAL-1.0
"""教程 02 的 Python 策略：均线偏离回归（与 strategies/tutorial-sma-band.ts 同名、同参数、同语义）。

规则：收盘价高出 N 根简单均线 band% 以上 → 目标 -1（满仓空）；低于 band% 以下 → 目标 +1（满仓多）；
回到带内 → 目标 0（空仓）。每根只用当前及更早的 K 线（无前视），无状态、无随机。
策略文件自包含：不 import 任何模块（沙箱策略档禁止 import），需要什么就写在文件里。
"""


def sma_at(closes, i, period):
    """只看 closes[i-period+1 .. i] 的简单均值；数据不够返回 None。"""
    if i + 1 < period:
        return None
    total = 0.0
    for j in range(i + 1 - period, i + 1):
        total += closes[j]
    return total / period


def evaluate(candles, p):
    n = len(candles)
    period = max(2, int(p["period"]))
    band = float(p["band"])
    allow_short = bool(p["allowShort"])
    closes = [c["c"] for c in candles]
    target = [0.0] * n
    reasons = [""] * n
    line = [None] * n
    prev = 0
    for i in range(n):
        ma = sma_at(closes, i, period)
        line[i] = ma
        if ma is None:
            continue
        upper = ma * (1 + band / 100)
        lower = ma * (1 - band / 100)
        px = closes[i]
        if px > upper:
            nxt = -1 if allow_short else 0
        elif px < lower:
            nxt = 1
        else:
            nxt = 0
        target[i] = float(nxt)
        if nxt != prev:
            if px > upper:
                where = "收盘 %.2f 高于上带 %.2f" % (px, upper)
            elif px < lower:
                where = "收盘 %.2f 低于下带 %.2f" % (px, lower)
            else:
                where = "收盘 %.2f 回到带内" % px
            side = "做多" if nxt == 1 else ("做空" if nxt == -1 else "空仓")
            reasons[i] = "%s（均线 %.2f，±%s%%）→ %s" % (where, ma, band, side)
            prev = nxt
    return {"target": target, "reasons": reasons, "overlays": {"SMA": line}, "warmup": period - 1}


STRATEGY = {
    "id": "tutorial-sma-band",
    "name": "SMA band reversion (tutorial)",
    "nameZh": "均线偏离回归（教程）",
    "version": "0.1.0",
    "desc": "收盘高出 N 根均线 band% 做空、低出 band% 做多，回到带内空仓。震荡行情里吃回归，单边趋势里会反复逆势。",
    "tags": ["教程", "均值回归"],
    "params": [
        {"key": "period", "label": "均线周期（根）", "type": "integer", "default": 24, "min": 5, "max": 200, "step": 1},
        {"key": "band", "label": "偏离带（%）", "type": "number", "default": 1, "min": 0.1, "max": 10, "step": 0.1},
        {"key": "allowShort", "label": "允许做空", "type": "boolean", "default": True},
    ],
    "evaluate": evaluate,
}
