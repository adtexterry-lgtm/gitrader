# SPDX-License-Identifier: CPAL-1.0
"""Gitrader Python 引擎指标库（零第三方依赖，只用标准库）。

对齐 `packages/engine-core/src/strategy/ta/`：同名函数、同一套窗口口径、同样的
「输出与输入等长、预热期为 None、第 i 项只用 <= i 的数据」约定；两者对同一输入
逐值相等（容差 1e-9，见 tests/test_indicators.py）。

批 9 主题二起，本文件同时补齐 `packages/ta-plus/src/` 的导出（并集口径）：
下半部分「ta-plus 补充指标」逐函数与那边同名同口径，数值同样逐值相等（容差 1e-9，
夹具 tests/fixtures/ts-taplus.json，用例 tests/test_indicators_taplus.py）；
唯一行为差异是非本节函数的非法周期处理——ta-plus 那批一律抛 ValueError
（对应 RangeError），engine-core 那批沿用「非法周期返回全 None」的宽口径。

K 线用映射表示（键 ``o / h / l / c / v``），也接受带同名属性的对象，例如::

    bars = [{"o": 100.0, "h": 101.0, "l": 99.0, "c": 100.5, "v": 1200.0}, ...]
    atr(bars, 14)

出处：从 QuantDinger v5.6.5（Apache-2.0）移植或对齐的函数上方有一行
``# Ported from QuantDinger v5.6.5 (Apache-2.0): <路径>:<行号>; adapted.``；
其余函数与同名 TS 实现逐行对齐（同文件族注释里写明对应的 ts 文件）。
QD 的 `app/services/builtin_indicators.py` 只是「内置示例指标」的播种代码
（SQL 插入 + 示例源码字符串），不含指标数学，故数学口径取自
`app/utils/technical_indicators.py` 与 `app/services/factors/registry.py`。
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Dict, List, Optional

# 与 TS 的 `Series` 对应：与输入等长，不可算处为 None。
Series = List[Optional[float]]
Bar = Any

__all__ = [
    # trend
    "sma", "ema", "wma", "macd", "cross",
    # momentum
    "rsi", "stochastic", "roc", "momentum", "williams_r", "cci",
    # volatility
    "true_range", "atr", "rolling_std", "bollinger", "keltner", "donchian",
    "log_returns", "annualized_vol", "parkinson_vol", "garman_klass_vol",
    # volume
    "obv", "vwap", "mfi", "cmf", "ad_line", "turnover_proxy", "volume_zscore",
    # overlap
    "dema", "tema", "hma", "kama", "vwma", "alma", "zlema", "ichimoku",
    "parabolic_sar", "supertrend", "pivot_points", "linear_regression", "envelope",
    # oscillators
    "trix", "ultimate_oscillator", "awesome_oscillator", "ppo", "aroon", "dpo",
    "adx", "stoch_rsi", "chaikin_oscillator", "force_index", "ease_of_movement",
    "mass_index", "ulcer_index", "vortex", "choppiness", "kdj", "elder_ray",
    # alpha ops
    "rolling_sum", "rolling_corr", "rank_pct", "idx_max", "idx_min",
    "linear_residual",
    # ta-plus 补充指标（批 9：与 ta-plus 的导出逐名对齐）
    "simple_returns", "realized_volatility", "downside_volatility", "skewness", "kurtosis",
    "max_drawdown", "atr_percent", "amihud_illiquidity", "avg_dev", "variance", "bop", "adxr",
    "cmo", "tsi", "efficiency_ratio", "sma_distance", "ema_distance", "ema_slope", "z_score",
    "volume_ratio", "price_position",
    "avg_price", "med_price", "typ_price", "wcl_price",
    "rolling_max", "rolling_min", "max_index", "min_index", "mid_point", "mid_price",
    "trima", "t3", "plus_dm", "minus_dm", "plus_di", "minus_di", "dx", "aroon_osc", "stoch_f",
    "correl", "beta", "lin_reg_slope", "lin_reg_intercept", "lin_reg_angle", "tsf",
    "natr", "ad_osc", "levels",
    "earnings_yield", "book_to_price", "return_on_equity", "debt_to_equity",
    "free_cash_flow_yield", "revenue_growth",
    # 与 TS 导出一一对应的别名（Python 侧习惯用 snake_case，别名保留 TS 名）
    "williamsR", "trueRange", "rollingStd", "logReturns", "annualizedVol",
    "parkinsonVol", "garmanKlassVol", "adLine", "turnoverProxy", "volumeZscore",
    "parabolicSar", "pivotPoints", "linearRegression", "ultimateOscillator",
    "awesomeOscillator", "stochRsi", "chaikinOscillator", "forceIndex",
    "easeOfMovement", "massIndex", "ulcerIndex", "elderRay", "rollingSum",
    "rollingCorr", "rankPct", "idxMax", "idxMin", "linearResidual",
]


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------

def _nulls(length: int) -> Series:
    """与输入等长的全 None 序列（对应 TS 的 emptySeries / nullSeries）。"""
    return [None] * length


def _is_period(period: Any) -> bool:
    """周期是否可用：>= 1 的整数（等价 TS 的 Number.isInteger(p) && p >= 1）。"""
    if isinstance(period, bool):
        return False
    if isinstance(period, int):
        return period >= 1
    if isinstance(period, float):
        return period.is_integer() and period >= 1
    return False


def _assert_period(period: Any, name: str = "period") -> None:
    """周期非法时抛 ValueError（对应 TS 的 RangeError）。"""
    if not _is_period(period):
        raise ValueError("%s 必须是大于等于 1 的整数：%r" % (name, period))


def _field(bar: Bar, key: str) -> float:
    """取一根 K 线的字段：支持映射与属性两种形态。"""
    if isinstance(bar, Mapping):
        return bar[key]
    return getattr(bar, key)


def _hl(bars: Sequence[Bar], i: int, period: int) -> tuple[float, float]:
    """窗口 [i-period+1, i] 内的最高价与最低价（含当前 bar）。"""
    hh = -math.inf
    ll = math.inf
    for j in range(i - period + 1, i + 1):
        bar = bars[j]
        h = _field(bar, "h")
        l = _field(bar, "l")
        if h > hh:
            hh = h
        if l < ll:
            ll = l
    return hh, ll


def _round_half_up(value: float) -> int:
    """JS Math.round 语义（正数四舍五入 +0.5 向下取整）。"""
    return int(math.floor(value + 0.5))


# ---------------------------------------------------------------------------
# 趋势类（对应 ta/trend.ts）
# ---------------------------------------------------------------------------

def sma(values: Sequence[float], period: int) -> Series:
    """简单移动平均：前 period-1 项为 None。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    for i in range(period - 1, n):
        total = 0.0
        for j in range(i - period + 1, i + 1):
            total += values[j]
        out[i] = total / period
    return out


def ema(values: Sequence[float], period: int) -> Series:
    """指数移动平均：种子为前 period 项简单平均，k = 2/(period+1)。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    seed = 0.0
    for j in range(period):
        seed += values[j]
    prev = seed / period
    out[period - 1] = prev
    k = 2 / (period + 1)
    for i in range(period, n):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def wma(values: Sequence[float], period: int) -> Series:
    """加权移动平均：权重 1..period，分母为 period(period+1)/2。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    denominator = (period * (period + 1)) / 2
    for i in range(period - 1, n):
        total = 0.0
        for w in range(1, period + 1):
            total += values[i - period + w] * w
        out[i] = total / denominator
    return out


def macd(
    values: Sequence[float],
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> Dict[str, Series]:
    """MACD：快慢 EMA 之差、其信号线 EMA 与柱（macd - signal）。"""
    _assert_period(fast)
    _assert_period(slow)
    _assert_period(signal)
    if fast >= slow:
        raise ValueError("fast 必须小于 slow")
    n = len(values)
    fast_ema = ema(values, fast)
    slow_ema = ema(values, slow)
    macd_out = _nulls(n)
    compact: List[float] = []
    positions: List[int] = []
    for i in range(n):
        f = fast_ema[i]
        s = slow_ema[i]
        if f is None or s is None:
            continue
        value = f - s
        macd_out[i] = value
        compact.append(value)
        positions.append(i)

    compact_signal = ema(compact, signal)
    signal_out = _nulls(n)
    for j, position in enumerate(positions):
        signal_out[position] = compact_signal[j]

    hist_out = _nulls(n)
    for i in range(n):
        m = macd_out[i]
        s = signal_out[i]
        if m is None or s is None:
            continue
        hist_out[i] = m - s
    return {"macd": macd_out, "signal": signal_out, "hist": hist_out}


def cross(a: Sequence[Optional[float]], b: Sequence[Optional[float]]) -> Series:
    """交叉信号：1 上穿 / -1 下穿 / 0 无事件；任一端缺值为 None。"""
    if len(a) != len(b):
        raise ValueError("两条序列长度必须相等")
    out = _nulls(len(a))
    for i in range(1, len(a)):
        a_prev, b_prev = a[i - 1], b[i - 1]
        a_cur, b_cur = a[i], b[i]
        if a_prev is None or b_prev is None or a_cur is None or b_cur is None:
            continue
        if a_prev <= b_prev and a_cur > b_cur:
            out[i] = 1
        elif a_prev >= b_prev and a_cur < b_cur:
            out[i] = -1
        else:
            out[i] = 0
    return out


# ---------------------------------------------------------------------------
# 动量类（对应 ta/momentum.ts）
# ---------------------------------------------------------------------------

def _rsi_from(avg_gain: float, avg_loss: float) -> float:
    """由平均涨跌额换算 RSI（0-100）；全平盘取 50。"""
    if avg_loss == 0:
        return 50 if avg_gain == 0 else 100
    return 100 - 100 / (1 + avg_gain / avg_loss)


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/utils/technical_indicators.py:51; adapted.
def rsi(closes: Sequence[float], period: int = 14) -> Series:
    """Wilder 口径相对强弱指标（0-100）；首个有效点在索引 period，之前为 None。"""
    _assert_period(period)
    n = len(closes)
    out = _nulls(n)
    if n <= period:
        return out
    gain_sum = 0.0
    loss_sum = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d > 0:
            gain_sum += d
        else:
            loss_sum -= d
    avg_gain = gain_sum / period
    avg_loss = loss_sum / period
    out[period] = _rsi_from(avg_gain, avg_loss)
    for i in range(period + 1, n):
        d = closes[i] - closes[i - 1]
        gain = d if d > 0 else 0.0
        loss = -d if d < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = _rsi_from(avg_gain, avg_loss)
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:568; adapted.
def stochastic(bars: Sequence[Bar], k_period: int = 14, d_period: int = 3) -> Dict[str, Series]:
    """随机指标 K 与 D（0-100）；窗口最高价等于最低价时 K 取 50。"""
    _assert_period(k_period)
    _assert_period(d_period)
    n = len(bars)
    k = _nulls(n)
    d = _nulls(n)
    k_values: List[float] = []
    k_indexes: List[int] = []
    for i in range(k_period - 1, n):
        hh, ll = _hl(bars, i, k_period)
        value = 50.0 if hh == ll else (100 * (_field(bars[i], "c") - ll)) / (hh - ll)
        k[i] = value
        k_values.append(value)
        k_indexes.append(i)
    for p in range(d_period - 1, len(k_values)):
        total = 0.0
        for q in range(p - d_period + 1, p + 1):
            total += k_values[q]
        d[k_indexes[p]] = total / d_period
    return {"k": k, "d": d}


def roc(values: Sequence[float], period: int) -> Series:
    """变化率（分数）：v[i]/v[i-period] - 1；基数为 0 处为 None。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    for i in range(period, n):
        base = values[i - period]
        out[i] = None if base == 0 else values[i] / base - 1
    return out


def momentum(values: Sequence[float], period: int) -> Series:
    """动量：v[i] - v[i-period]。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    for i in range(period, n):
        out[i] = values[i] - values[i - period]
    return out


def williams_r(bars: Sequence[Bar], period: int = 14) -> Series:
    """威廉指标（-100..0）；窗口最高价等于最低价时为 -50。"""
    _assert_period(period)
    n = len(bars)
    out = _nulls(n)
    for i in range(period - 1, n):
        hh, ll = _hl(bars, i, period)
        out[i] = -50.0 if hh == ll else (-100 * (hh - _field(bars[i], "c"))) / (hh - ll)
    return out


def cci(bars: Sequence[Bar], period: int = 20) -> Series:
    """顺势指标：典型价均值的偏离除以 0.015 倍平均绝对偏差；偏差为 0 时取 0。"""
    _assert_period(period)
    n = len(bars)
    out = _nulls(n)
    tp = [(_field(bar, "h") + _field(bar, "l") + _field(bar, "c")) / 3 for bar in bars]
    for i in range(period - 1, n):
        total = 0.0
        for j in range(i - period + 1, i + 1):
            total += tp[j]
        average = total / period
        dev_sum = 0.0
        for j in range(i - period + 1, i + 1):
            dev_sum += abs(tp[j] - average)
        mean_dev = dev_sum / period
        out[i] = 0.0 if mean_dev == 0 else (tp[i] - average) / (0.015 * mean_dev)
    return out


# ---------------------------------------------------------------------------
# 波动类（对应 ta/volatility.ts）
# ---------------------------------------------------------------------------

def _vol_sma(values: Sequence[float], period: int) -> Series:
    """rolling 口径的简单移动平均（滑动求和，与 volatility.ts 的实现一致）。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    acc = 0.0
    for i in range(n):
        acc += values[i]
        if i >= period:
            acc -= values[i - period]
        if i >= period - 1:
            out[i] = acc / period
    return out


def _vol_ema(values: Sequence[float], period: int) -> Series:
    """volatility.ts 内部的 EMA（与 trend.ema 同式，仅校验名不同）。"""
    _assert_period(period, "emaPeriod")
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    seed = 0.0
    for i in range(period):
        seed += values[i]
    e = seed / period
    out[period - 1] = e
    k = 2 / (period + 1)
    for i in range(period, n):
        e = values[i] * k + e * (1 - k)
        out[i] = e
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:545; adapted.
def true_range(bars: Sequence[Bar]) -> Series:
    """真实波幅：第 0 项 h-l，之后 max(h-l, |h-prevC|, |l-prevC|)。"""
    n = len(bars)
    out = _nulls(n)
    for i in range(n):
        bar = bars[i]
        h = _field(bar, "h")
        l = _field(bar, "l")
        if i == 0:
            out[i] = h - l
            continue
        prev_close = _field(bars[i - 1], "c")
        out[i] = max(h - l, abs(h - prev_close), abs(l - prev_close))
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:556; adapted.
def atr(bars: Sequence[Bar], period: int = 14) -> Series:
    """Wilder ATR：第 period-1 项为前 period 个 TR 的简单平均，之后递推。"""
    _assert_period(period)
    n = len(bars)
    out = _nulls(n)
    if n < period:
        return out
    tr = true_range(bars)
    seed = 0.0
    for i in range(period):
        seed += tr[i]
    value = seed / period
    out[period - 1] = value
    for i in range(period, n):
        value = (value * (period - 1) + tr[i]) / period
        out[i] = value
    return out


def rolling_std(values: Sequence[float], period: int, ddof: int = 0) -> Series:
    """滚动标准差（窗口含当前项，ddof 可调）；period 必须大于 ddof。"""
    _assert_period(period)
    if period <= ddof:
        raise ValueError("period 必须大于 ddof，实际为 period=%r ddof=%r" % (period, ddof))
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    for i in range(period - 1, n):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        mean = total / period
        squares = 0.0
        for j in range(start, i + 1):
            d = values[j] - mean
            squares += d * d
        out[i] = math.sqrt(squares / (period - ddof))
    return out


def bollinger(values: Sequence[float], period: int = 20, k: float = 2) -> Dict[str, Series]:
    """布林带：中轨为 SMA，上下轨为 ± k 倍总体标准差，另给带宽与 %B。"""
    middle = _vol_sma(values, period)
    std = rolling_std(values, period, 0)
    n = len(values)
    upper = _nulls(n)
    lower = _nulls(n)
    bandwidth = _nulls(n)
    percent_b = _nulls(n)
    for i in range(n):
        mid = middle[i]
        sd = std[i]
        if mid is None or sd is None:
            continue
        up = mid + k * sd
        lo = mid - k * sd
        upper[i] = up
        lower[i] = lo
        bandwidth[i] = None if mid == 0 else (up - lo) / mid
        span = up - lo
        percent_b[i] = None if span == 0 else (values[i] - lo) / span
    return {
        "middle": middle,
        "upper": upper,
        "lower": lower,
        "bandwidth": bandwidth,
        "percentB": percent_b,
    }


def keltner(
    bars: Sequence[Bar],
    ema_period: int = 20,
    atr_period: int = 10,
    k: float = 2,
) -> Dict[str, Series]:
    """肯特纳通道：中轨为收盘价 EMA，上下轨为 ± k 倍 ATR。"""
    middle = _vol_ema([_field(bar, "c") for bar in bars], ema_period)
    width = atr(bars, atr_period)
    n = len(bars)
    upper = _nulls(n)
    lower = _nulls(n)
    for i in range(n):
        mid = middle[i]
        w = width[i]
        if mid is None or w is None:
            continue
        upper[i] = mid + k * w
        lower[i] = mid - k * w
    return {"middle": middle, "upper": upper, "lower": lower}


def donchian(bars: Sequence[Bar], period: int = 20) -> Dict[str, Series]:
    """唐奇安通道：含当前 bar 的最近 period 根最高 h / 最低 l，中轨为两者平均。"""
    _assert_period(period)
    n = len(bars)
    upper = _nulls(n)
    lower = _nulls(n)
    middle = _nulls(n)
    for i in range(period - 1, n):
        hi = -math.inf
        lo = math.inf
        for j in range(i - period + 1, i + 1):
            bar = bars[j]
            h = _field(bar, "h")
            l = _field(bar, "l")
            if h > hi:
                hi = h
            if l < lo:
                lo = l
        upper[i] = hi
        lower[i] = lo
        middle[i] = (hi + lo) / 2
    return {"upper": upper, "lower": lower, "middle": middle}


def log_returns(values: Sequence[float]) -> Series:
    """对数收益 ln(v[i]/v[i-1])：第 0 项 None，任一端值 <= 0 处为 None。"""
    n = len(values)
    out = _nulls(n)
    for i in range(1, n):
        cur = values[i]
        prev = values[i - 1]
        if not cur > 0 or not prev > 0:
            continue
        out[i] = math.log(cur / prev)
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1060; adapted.
def parkinson_vol(
    bars: Sequence[Bar],
    period: int,
    periods_per_year: float = 365,
) -> Series:
    """Parkinson 年化波动：sqrt(sum ln(h/l)^2 / (4 n ln2)) * sqrt(每年周期数)。"""
    n = len(bars)
    out = _nulls(n)
    if not _is_period(period):
        return out
    denominator = 4 * period * math.log(2)
    scale = math.sqrt(periods_per_year)
    for i in range(period - 1, n):
        total = 0.0
        ok = True
        for j in range(i - period + 1, i + 1):
            bar = bars[j]
            h = _field(bar, "h")
            l = _field(bar, "l")
            if not h > 0 or not l > 0:
                ok = False
                break
            ratio = math.log(h / l)
            total += ratio * ratio
        if not ok:
            continue
        out[i] = math.sqrt(total / denominator) * scale
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1068; adapted.
def garman_klass_vol(
    bars: Sequence[Bar],
    period: int,
    periods_per_year: float = 365,
) -> Series:
    """Garman-Klass 年化波动：均值 0.5 ln(h/l)^2 - (2ln2-1) ln(c/o)^2 开方后年化。"""
    n = len(bars)
    out = _nulls(n)
    if not _is_period(period):
        return out
    coefficient = 2 * math.log(2) - 1
    scale = math.sqrt(periods_per_year)
    for i in range(period - 1, n):
        total = 0.0
        ok = True
        for j in range(i - period + 1, i + 1):
            bar = bars[j]
            h = _field(bar, "h")
            l = _field(bar, "l")
            o = _field(bar, "o")
            c = _field(bar, "c")
            if not h > 0 or not l > 0 or not o > 0 or not c > 0:
                ok = False
                break
            span = math.log(h / l)
            gap = math.log(c / o)
            total += 0.5 * span * span - coefficient * gap * gap
        if not ok:
            continue
        variance = total / period
        if variance < 0:
            continue
        out[i] = math.sqrt(variance) * scale
    return out


def annualized_vol(
    values: Sequence[float],
    period: int,
    periods_per_year: float,
) -> Series:
    """年化波动率：对数收益的 rollingStd(period, ddof=1) 乘 sqrt(每年周期数)。"""
    n = len(values)
    out = _nulls(n)
    returns = log_returns(values)
    positions: List[int] = []
    compact: List[float] = []
    for i in range(n):
        r = returns[i]
        if r is None:
            continue
        positions.append(i)
        compact.append(r)
    std = rolling_std(compact, period, 1)
    scale = math.sqrt(periods_per_year)
    for j in range(len(compact)):
        s = std[j]
        if s is None:
            continue
        out[positions[j]] = s * scale
    return out


# ---------------------------------------------------------------------------
# 量价类（对应 ta/volume.ts）
# ---------------------------------------------------------------------------

def _typical_price(bar: Bar) -> float:
    return (_field(bar, "h") + _field(bar, "l") + _field(bar, "c")) / 3


def _money_flow_multiplier(bar: Bar) -> float:
    span = _field(bar, "h") - _field(bar, "l")
    if span == 0:
        return 0.0
    c = _field(bar, "c")
    l = _field(bar, "l")
    h = _field(bar, "h")
    return (c - l - (h - c)) / span


def _money_flow_volume(bar: Bar) -> float:
    return _money_flow_multiplier(bar) * _field(bar, "v")


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:811; adapted.
def obv(bars: Sequence[Bar]) -> Series:
    """能量潮：第 0 项为 0，之后按收盘价涨跌累加或累减成交量。"""
    n = len(bars)
    out = _nulls(n)
    if n == 0:
        return out
    acc = 0.0
    out[0] = acc
    for i in range(1, n):
        cur = bars[i]
        prev = bars[i - 1]
        c = _field(cur, "c")
        prev_c = _field(prev, "c")
        if c > prev_c:
            acc += _field(cur, "v")
        elif c < prev_c:
            acc -= _field(cur, "v")
        out[i] = acc
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:854; adapted.
def vwap(bars: Sequence[Bar], period: Optional[int] = None) -> Series:
    """成交量加权均价：不给 period 为累计口径，给 period 为含当前的滚动窗口。"""
    n = len(bars)
    out = _nulls(n)
    if period is not None:
        _assert_period(period)
    pv = 0.0
    vol = 0.0
    for i in range(n):
        bar = bars[i]
        pv += _typical_price(bar) * _field(bar, "v")
        vol += _field(bar, "v")
        if period is None:
            out[i] = None if vol == 0 else pv / vol
            continue
        if i >= period:
            dropped = bars[i - period]
            pv -= _typical_price(dropped) * _field(dropped, "v")
            vol -= _field(dropped, "v")
        out[i] = None if (i < period - 1 or vol == 0) else pv / vol
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:638; adapted.
def mfi(bars: Sequence[Bar], period: int = 14) -> Series:
    """资金流量指标（0-100）：按典型价涨跌划分正负资金流，取最近 period 个流。"""
    _assert_period(period)
    n = len(bars)
    out = _nulls(n)
    positive = [0.0] * n
    negative = [0.0] * n
    for i in range(1, n):
        bar = bars[i]
        tp = _typical_price(bar)
        tp_prev = _typical_price(bars[i - 1])
        flow = tp * _field(bar, "v")
        if tp > tp_prev:
            positive[i] = flow
        elif tp < tp_prev:
            negative[i] = flow
    for i in range(period, n):
        pos = 0.0
        neg = 0.0
        for j in range(i - period + 1, i + 1):
            pos += positive[j]
            neg += negative[j]
        out[i] = (50.0 if pos == 0 else 100.0) if neg == 0 else 100 - 100 / (1 + pos / neg)
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:869; adapted.
def cmf(bars: Sequence[Bar], period: int = 20) -> Series:
    """蔡金资金流量：窗口内资金流量之和除以成交量之和。"""
    _assert_period(period)
    n = len(bars)
    out = _nulls(n)
    flows = [_money_flow_volume(bar) for bar in bars]
    for i in range(period - 1, n):
        total = 0.0
        vol = 0.0
        for j in range(i - period + 1, i + 1):
            total += flows[j]
            vol += _field(bars[j], "v")
        out[i] = None if vol == 0 else total / vol
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:825; adapted.
def ad_line(bars: Sequence[Bar]) -> Series:
    """累积/派发线：从第 0 根起累加资金流量。"""
    n = len(bars)
    out = _nulls(n)
    acc = 0.0
    for i in range(n):
        acc += _money_flow_volume(bars[i])
        out[i] = acc
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:399; adapted.
def turnover_proxy(bars: Sequence[Bar], period: int) -> Series:
    """成交额代理：最近 period 根（含当前）close * volume 的算术平均。"""
    n = len(bars)
    out = _nulls(n)
    if not _is_period(period):
        return out
    for i in range(period - 1, n):
        total = 0.0
        for j in range(i - period + 1, i + 1):
            bar = bars[j]
            total += _field(bar, "c") * _field(bar, "v")
        out[i] = total / period
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:389; adapted.
def volume_zscore(bars: Sequence[Bar], period: int) -> Series:
    """成交量 z 分数：最新一根相对窗口均值，除以样本标准差（ddof=1）。"""
    n = len(bars)
    out = _nulls(n)
    if not _is_period(period) or period < 2:
        return out
    for i in range(period - 1, n):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += _field(bars[j], "v")
        mean = total / period
        squares = 0.0
        for j in range(start, i + 1):
            d = _field(bars[j], "v") - mean
            squares += d * d
        std = math.sqrt(squares / (period - 1))
        if std == 0:
            continue
        out[i] = (_field(bars[i], "v") - mean) / std
    return out


# ---------------------------------------------------------------------------
# 叠加类（对应 ta/overlap.ts；period 非法时返回全 None 且不抛错）
# ---------------------------------------------------------------------------

def _ema_of_series(source: Sequence[Optional[float]], period: int) -> Series:
    """对可能带前导 None 的序列取非 None 子序列做 EMA，再按原下标放回。"""
    positions: List[int] = []
    values: List[float] = []
    for i, value in enumerate(source):
        if value is None:
            continue
        positions.append(i)
        values.append(value)
    computed = ema(values, period)
    out = _nulls(len(source))
    for j, position in enumerate(positions):
        value = computed[j]
        if value is None:
            continue
        out[position] = value
    return out


def _wma_of_series(source: Sequence[Optional[float]], period: int) -> Series:
    """对可能带前导 None 的序列取非 None 子序列做 WMA，再按原下标放回。"""
    positions: List[int] = []
    values: List[float] = []
    for i, value in enumerate(source):
        if value is None:
            continue
        positions.append(i)
        values.append(value)
    computed = wma(values, period)
    out = _nulls(len(source))
    for j, position in enumerate(positions):
        value = computed[j]
        if value is None:
            continue
        out[position] = value
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:883; adapted.
def dema(values: Sequence[float], period: int) -> Series:
    """双指数移动平均：2*EMA - EMA(EMA)。"""
    if not _is_period(period):
        return _nulls(len(values))
    first = ema(values, period)
    second = _ema_of_series(first, period)
    out = _nulls(len(values))
    for i in range(len(values)):
        a = first[i]
        b = second[i]
        if a is None or b is None:
            continue
        out[i] = 2 * a - b
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:890; adapted.
def tema(values: Sequence[float], period: int) -> Series:
    """三指数移动平均：3*E1 - 3*E2 + E3。"""
    if not _is_period(period):
        return _nulls(len(values))
    e1 = ema(values, period)
    e2 = _ema_of_series(e1, period)
    e3 = _ema_of_series(e2, period)
    out = _nulls(len(values))
    for i in range(len(values)):
        a = e1[i]
        b = e2[i]
        c = e3[i]
        if a is None or b is None or c is None:
            continue
        out[i] = 3 * a - 3 * b + c
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:912; adapted.
def hma(values: Sequence[float], period: int) -> Series:
    """赫尔移动平均：WMA(2*WMA(period/2) - WMA(period), round(sqrt(period)))。"""
    if not _is_period(period):
        return _nulls(len(values))
    half = max(1, period // 2)
    root = max(1, _round_half_up(math.sqrt(period)))
    short_wma = wma(values, half)
    long_wma = wma(values, period)
    diff = _nulls(len(values))
    for i in range(len(values)):
        a = short_wma[i]
        b = long_wma[i]
        if a is None or b is None:
            continue
        diff[i] = 2 * a - b
    return _wma_of_series(diff, root)


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:923; adapted.
def kama(
    values: Sequence[float],
    period: int = 10,
    fast: int = 2,
    slow: int = 30,
) -> Series:
    """Kaufman 自适应移动平均：ER = 净变动 / 路径长度，SC 平滑后递推。"""
    if not _is_period(period):
        return _nulls(len(values))
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    fast_sc = 2 / (fast + 1)
    slow_sc = 2 / (slow + 1)
    prev = values[period - 1]
    out[period - 1] = prev
    for i in range(period, n):
        change = abs(values[i] - values[i - period])
        path = 0.0
        for j in range(i - period + 1, i + 1):
            path += abs(values[j] - values[j - 1])
        er = 0.0 if path == 0 else change / path
        sc = (er * (fast_sc - slow_sc) + slow_sc) ** 2
        prev = prev + sc * (values[i] - prev)
        out[i] = prev
    return out


def vwma(bars: Sequence[Bar], period: int) -> Series:
    """成交量加权移动平均：sum(c*v) / sum(v)；窗口成交量为 0 处为 None。"""
    if not _is_period(period):
        return _nulls(len(bars))
    n = len(bars)
    out = _nulls(n)
    for i in range(period - 1, n):
        sum_pv = 0.0
        sum_v = 0.0
        for j in range(i - period + 1, i + 1):
            bar = bars[j]
            sum_pv += _field(bar, "c") * _field(bar, "v")
            sum_v += _field(bar, "v")
        out[i] = None if sum_v == 0 else sum_pv / sum_v
    return out


def alma(
    values: Sequence[float],
    period: int = 9,
    offset: float = 0.85,
    sigma: float = 6,
) -> Series:
    """Arnaud Legoux 移动平均：高斯权重按 offset / sigma 归一化后对窗口加权。"""
    if not _is_period(period):
        return _nulls(len(values))
    n = len(values)
    out = _nulls(n)
    center = offset * (period - 1)
    scale = period / sigma
    normalizer = 2 * scale * scale
    weights: List[float] = []
    weight_sum = 0.0
    for k in range(period):
        d = k - center
        weight = (1.0 if d == 0 else 0.0) if normalizer == 0 else math.exp(-(d * d) / normalizer)
        weights.append(weight)
        weight_sum += weight
    if weight_sum == 0:
        return out
    for i in range(period - 1, n):
        total = 0.0
        for k in range(period):
            total += values[i - period + 1 + k] * weights[k]
        out[i] = total / weight_sum
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:898; adapted.
def zlema(values: Sequence[float], period: int) -> Series:
    """零滞后 EMA：先去滞后 2*c[i] - c[i-lag]，再取 EMA；lag = floor((period-1)/2)。"""
    if not _is_period(period):
        return _nulls(len(values))
    lag = (period - 1) // 2
    positions: List[int] = []
    adjusted: List[float] = []
    for i in range(lag, len(values)):
        positions.append(i)
        adjusted.append(2 * values[i] - values[i - lag])
    computed = ema(adjusted, period)
    out = _nulls(len(values))
    for j, position in enumerate(positions):
        value = computed[j]
        if value is None:
            continue
        out[position] = value
    return out


def ichimoku(
    bars: Sequence[Bar],
    tenkan: int = 9,
    kijun: int = 26,
    senkou: int = 52,
) -> Dict[str, Series]:
    """一目均衡表：各线均为截至当前 bar 的窗口值，不做前移 / 后移。"""
    n = len(bars)
    if not _is_period(tenkan) or not _is_period(kijun) or not _is_period(senkou):
        return {
            "tenkan": _nulls(n),
            "kijun": _nulls(n),
            "senkouA": _nulls(n),
            "senkouB": _nulls(n),
            "chikou": _nulls(n),
        }

    def midpoint(period: int) -> Series:
        out = _nulls(n)
        for i in range(period - 1, n):
            high = -math.inf
            low = math.inf
            for j in range(i - period + 1, i + 1):
                bar = bars[j]
                h = _field(bar, "h")
                l = _field(bar, "l")
                if h > high:
                    high = h
                if l < low:
                    low = l
            out[i] = (high + low) / 2
        return out

    tenkan_line = midpoint(tenkan)
    kijun_line = midpoint(kijun)
    senkou_b = midpoint(senkou)
    senkou_a = _nulls(n)
    for i in range(n):
        a = tenkan_line[i]
        b = kijun_line[i]
        if a is None or b is None:
            continue
        senkou_a[i] = (a + b) / 2
    chikou = _nulls(n)
    for i in range(n):
        chikou[i] = _field(bars[i], "c")
    return {
        "tenkan": tenkan_line,
        "kijun": kijun_line,
        "senkouA": senkou_a,
        "senkouB": senkou_b,
        "chikou": chikou,
    }


def parabolic_sar(
    bars: Sequence[Bar],
    step: float = 0.02,
    maximum: float = 0.2,
) -> Dict[str, Series]:
    """标准 Wilder 抛物线 SAR：初始趋势看第 2 根收盘相对第 1 根，反转时 SAR 取前趋势 EP。"""
    n = len(bars)
    sar = _nulls(n)
    trend = _nulls(n)
    if n < 2:
        return {"sar": sar, "trend": trend}

    b0 = bars[0]
    b1 = bars[1]
    up = _field(b1, "c") >= _field(b0, "c")
    af = step
    ep = (
        max(_field(b0, "h"), _field(b1, "h"))
        if up
        else min(_field(b0, "l"), _field(b1, "l"))
    )
    value = _field(b0, "l") if up else _field(b0, "h")
    sar[1] = value
    trend[1] = 1 if up else -1

    for i in range(2, n):
        bar = bars[i]
        prev1 = bars[i - 1]
        prev2 = bars[i - 2]
        bar_h = _field(bar, "h")
        bar_l = _field(bar, "l")
        candidate = value + af * (ep - value)
        if up:
            candidate = min(candidate, _field(prev1, "l"), _field(prev2, "l"))
            if bar_l < candidate:
                up = False
                candidate = ep
                ep = bar_l
                af = step
            elif bar_h > ep:
                ep = bar_h
                af = min(af + step, maximum)
        else:
            candidate = max(candidate, _field(prev1, "h"), _field(prev2, "h"))
            if bar_h > candidate:
                up = True
                candidate = ep
                ep = bar_h
                af = step
            elif bar_l < ep:
                ep = bar_l
                af = min(af + step, maximum)
        value = candidate
        sar[i] = value
        trend[i] = 1 if up else -1
    return {"sar": sar, "trend": trend}


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:717; adapted.
def supertrend(
    bars: Sequence[Bar],
    period: int = 10,
    multiplier: float = 3,
) -> Dict[str, Series]:
    """ATR 通道式 SuperTrend：最终上下轨单向收缩，收盘突破后翻转。"""
    n = len(bars)
    upper = _nulls(n)
    lower = _nulls(n)
    trend = _nulls(n)
    if not _is_period(period):
        return {"upper": upper, "lower": lower, "trend": trend}

    width = atr(bars, period)
    start = period - 1
    prev_upper = 0.0
    prev_lower = 0.0
    trend_up = False
    for i in range(start, n):
        bar = bars[i]
        width_i = width[i]
        if width_i is None:
            continue
        h = _field(bar, "h")
        l = _field(bar, "l")
        c = _field(bar, "c")
        mid = (h + l) / 2
        basic_upper = mid + multiplier * width_i
        basic_lower = mid - multiplier * width_i
        final_upper = basic_upper
        final_lower = basic_lower
        if i == start:
            up = c > basic_upper
        else:
            prev_close = _field(bars[i - 1], "c")
            final_upper = (
                basic_upper
                if (basic_upper < prev_upper or prev_close > prev_upper)
                else prev_upper
            )
            final_lower = (
                basic_lower
                if (basic_lower > prev_lower or prev_close < prev_lower)
                else prev_lower
            )
            up = (c >= final_lower) if trend_up else (c > final_upper)
        upper[i] = final_upper
        lower[i] = final_lower
        trend[i] = 1 if up else -1
        prev_upper = final_upper
        prev_lower = final_lower
        trend_up = up
    return {"upper": upper, "lower": lower, "trend": trend}


def pivot_points(bars: Sequence[Bar]) -> Dict[str, Series]:
    """枢轴点：第 i 项用第 i-1 根的 h/l/c，第 0 项为 None。"""
    n = len(bars)
    p = _nulls(n)
    r1 = _nulls(n)
    s1 = _nulls(n)
    r2 = _nulls(n)
    s2 = _nulls(n)
    for i in range(1, n):
        bar = bars[i - 1]
        h = _field(bar, "h")
        l = _field(bar, "l")
        c = _field(bar, "c")
        pivot = (h + l + c) / 3
        p[i] = pivot
        r1[i] = 2 * pivot - l
        s1[i] = 2 * pivot - h
        r2[i] = pivot + (h - l)
        s2[i] = pivot - (h - l)
    return {"p": p, "r1": r1, "s1": s1, "r2": r2, "s2": s2}


def linear_regression(values: Sequence[float], period: int) -> Dict[str, Series]:
    """窗口最小二乘回归：slope / intercept / 末点拟合值 / 决定系数 r2（方差为 0 时 None）。"""
    n = len(values)
    slope = _nulls(n)
    intercept = _nulls(n)
    value = _nulls(n)
    r2 = _nulls(n)
    if not _is_period(period):
        return {"slope": slope, "intercept": intercept, "value": value, "r2": r2}

    xbar = (period - 1) / 2
    for i in range(period - 1, n):
        start = i - period + 1
        ybar = 0.0
        for k in range(period):
            ybar += values[start + k]
        ybar /= period
        sxx = 0.0
        sxy = 0.0
        syy = 0.0
        for k in range(period):
            dx = k - xbar
            dy = values[start + k] - ybar
            sxx += dx * dx
            sxy += dx * dy
            syy += dy * dy
        b = 0.0 if sxx == 0 else sxy / sxx
        a = ybar - b * xbar
        slope[i] = b
        intercept[i] = a
        value[i] = b * (period - 1) + a
        r2[i] = None if syy == 0 else (b * sxy) / syy
    return {"slope": slope, "intercept": intercept, "value": value, "r2": r2}


def envelope(
    values: Sequence[float],
    period: int,
    pct: float = 0.025,
) -> Dict[str, Series]:
    """包络线：SMA 与其上下各 pct 比例的平行线。"""
    n = len(values)
    if not _is_period(period):
        return {"mid": _nulls(n), "upper": _nulls(n), "lower": _nulls(n)}
    mid = sma(values, period)
    upper = _nulls(n)
    lower = _nulls(n)
    for i in range(n):
        m = mid[i]
        if m is None:
            continue
        upper[i] = m * (1 + pct)
        lower[i] = m * (1 - pct)
    return {"mid": mid, "upper": upper, "lower": lower}


# ---------------------------------------------------------------------------
# 振荡类（对应 ta/oscillators.ts；period 非法时返回全 None 且不抛错）
# ---------------------------------------------------------------------------

def _remap(source: Sequence[Optional[float]], fn: Callable[[List[float]], Series]) -> Series:
    """取出非 None 子序列交给 fn，再按原下标放回。"""
    indexes: List[int] = []
    values: List[float] = []
    for i, value in enumerate(source):
        if value is None:
            continue
        indexes.append(i)
        values.append(value)
    mapped = fn(values)
    out = _nulls(len(source))
    for j, index in enumerate(indexes):
        value = mapped[j]
        if value is None:
            continue
        out[index] = value
    return out


def _compact(source: Sequence[Optional[float]]) -> tuple[List[int], List[float]]:
    """序列中的非 None 项（保序）。"""
    indexes: List[int] = []
    values: List[float] = []
    for i, value in enumerate(source):
        if value is None:
            continue
        indexes.append(i)
        values.append(value)
    return indexes, values


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:706; adapted.
def trix(values: Sequence[float], period: int = 15) -> Series:
    """TRIX：EMA 三次后再取 1 期变化率（*100）。"""
    out = _nulls(len(values))
    if not _is_period(period):
        return out
    e1 = ema(values, period)
    e2 = _remap(e1, lambda vs: ema(vs, period))
    e3 = _remap(e2, lambda vs: ema(vs, period))
    for i in range(1, len(e3)):
        cur = e3[i]
        prev = e3[i - 1]
        if cur is None or prev is None:
            continue
        if prev == 0:
            continue
        out[i] = (cur / prev - 1) * 100
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:971; adapted.
def ultimate_oscillator(
    bars: Sequence[Bar],
    short: int = 7,
    mid: int = 14,
    long: int = 28,
) -> Series:
    """终极振荡指标：按短中长三个窗口的买压 / 真实波幅占比加权。"""
    n = len(bars)
    out = _nulls(n)
    if not _is_period(short) or not _is_period(mid) or not _is_period(long):
        return out
    buying_pressure = [0.0] * n
    span = [0.0] * n
    for i in range(1, n):
        bar = bars[i]
        prev = bars[i - 1]
        lowest = min(_field(bar, "l"), _field(prev, "c"))
        buying_pressure[i] = _field(bar, "c") - lowest
        span[i] = max(_field(bar, "h"), _field(prev, "c")) - lowest

    def average(i: int, window: int) -> Optional[float]:
        if i - window + 1 < 1:
            return None
        bp_sum = 0.0
        tr_sum = 0.0
        for j in range(i - window + 1, i + 1):
            bp_sum += buying_pressure[j]
            tr_sum += span[j]
        return None if tr_sum == 0 else bp_sum / tr_sum

    for i in range(long, n):
        a1 = average(i, short)
        a2 = average(i, mid)
        a3 = average(i, long)
        if a1 is None or a2 is None or a3 is None:
            continue
        out[i] = (100 * (4 * a1 + 2 * a2 + a3)) / 7
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:961; adapted.
def awesome_oscillator(
    bars: Sequence[Bar],
    fast: int = 5,
    slow: int = 34,
) -> Series:
    """动量震荡（AO）：中价短均线与长均线之差。"""
    n = len(bars)
    out = _nulls(n)
    if not _is_period(fast) or not _is_period(slow):
        return out
    hl2 = [(_field(bar, "h") + _field(bar, "l")) / 2 for bar in bars]
    fast_sma = sma(hl2, fast)
    slow_sma = sma(hl2, slow)
    for i in range(n):
        a = fast_sma[i]
        b = slow_sma[i]
        if a is None or b is None:
            continue
        out[i] = a - b
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:942; adapted.
def ppo(
    values: Sequence[float],
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> Dict[str, Series]:
    """百分比价格振荡：EMA 快慢线差占慢线百分比，signal 为其 EMA。"""
    ppo_out = _nulls(len(values))
    if not _is_period(fast) or not _is_period(slow) or not _is_period(signal):
        return {"ppo": ppo_out, "signal": _nulls(len(values)), "hist": _nulls(len(values))}
    fast_ema = ema(values, fast)
    slow_ema = ema(values, slow)
    for i in range(len(values)):
        f = fast_ema[i]
        s = slow_ema[i]
        if f is None or s is None:
            continue
        if s == 0:
            continue
        ppo_out[i] = ((f - s) / s) * 100
    signal_out = _remap(ppo_out, lambda vs: ema(vs, signal))
    hist_out = _nulls(len(values))
    for i in range(len(values)):
        p = ppo_out[i]
        s = signal_out[i]
        if p is None or s is None:
            continue
        hist_out[i] = p - s
    return {"ppo": ppo_out, "signal": signal_out, "hist": hist_out}


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:694; adapted.
def aroon(bars: Sequence[Bar], period: int = 25) -> Dict[str, Series]:
    """Aroon：距最近 period+1 根内最高价 / 最低价根数的百分比，并列取最近的一根。"""
    n = len(bars)
    up = _nulls(n)
    down = _nulls(n)
    osc = _nulls(n)
    if not _is_period(period):
        return {"up": up, "down": down, "osc": osc}
    window = period
    for i in range(window, n):
        highest = -math.inf
        highest_index = i
        lowest = math.inf
        lowest_index = i
        for j in range(i, i - window - 1, -1):
            bar = bars[j]
            h = _field(bar, "h")
            l = _field(bar, "l")
            if h > highest:
                highest = h
                highest_index = j
            if l < lowest:
                lowest = l
                lowest_index = j
        u = (100 * (window - (i - highest_index))) / window
        d = (100 * (window - (i - lowest_index))) / window
        up[i] = u
        down[i] = d
        osc[i] = u - d
    return {"up": up, "down": down, "osc": osc}


def dpo(values: Sequence[float], period: int = 20) -> Series:
    """去趋势价格振荡：period/2+1 根之前的收盘价减去当前 period 期均值。"""
    out = _nulls(len(values))
    if not _is_period(period):
        return out
    average = sma(values, period)
    offset = period // 2 + 1
    for i in range(period, len(values)):
        base = values[i - offset]
        mean = average[i]
        if mean is None:
            continue
        out[i] = base - mean
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:652; adapted.
def adx(bars: Sequence[Bar], period: int = 14) -> Dict[str, Series]:
    """平均趋向指标：Wilder 平滑的方向运动、方向指标与 ADX。"""
    n = len(bars)
    plus_di = _nulls(n)
    minus_di = _nulls(n)
    adx_out = _nulls(n)
    if not _is_period(period):
        return {"plusDi": plus_di, "minusDi": minus_di, "adx": adx_out}
    window = period
    if n <= window:
        return {"plusDi": plus_di, "minusDi": minus_di, "adx": adx_out}

    rng = true_range(bars)
    plus_dm = [0.0] * n
    minus_dm = [0.0] * n
    for i in range(1, n):
        bar = bars[i]
        prev = bars[i - 1]
        up_move = _field(bar, "h") - _field(prev, "h")
        down_move = _field(prev, "l") - _field(bar, "l")
        if up_move > down_move and up_move > 0:
            plus_dm[i] = up_move
        elif down_move > up_move and down_move > 0:
            minus_dm[i] = down_move

    tr_sum = 0.0
    plus_sum = 0.0
    minus_sum = 0.0
    for i in range(1, window + 1):
        tr_sum += rng[i]
        plus_sum += plus_dm[i]
        minus_sum += minus_dm[i]

    dx_values: List[float] = []
    dx_indexes: List[int] = []

    def record(i: int) -> None:
        if tr_sum == 0:
            return
        p = (100 * plus_sum) / tr_sum
        m = (100 * minus_sum) / tr_sum
        plus_di[i] = p
        minus_di[i] = m
        total = p + m
        if total == 0:
            return
        dx_values.append((100 * abs(p - m)) / total)
        dx_indexes.append(i)

    record(window)
    for i in range(window + 1, n):
        tr_sum = tr_sum - tr_sum / window + rng[i]
        plus_sum = plus_sum - plus_sum / window + plus_dm[i]
        minus_sum = minus_sum - minus_sum / window + minus_dm[i]
        record(i)

    if len(dx_values) < window:
        return {"plusDi": plus_di, "minusDi": minus_di, "adx": adx_out}
    acc = 0.0
    for j in range(window):
        acc += dx_values[j]
    adx_value = acc / window
    adx_out[dx_indexes[window - 1]] = adx_value
    for j in range(window, len(dx_values)):
        adx_value = (adx_value * (window - 1) + dx_values[j]) / window
        adx_out[dx_indexes[j]] = adx_value
    return {"plusDi": plus_di, "minusDi": minus_di, "adx": adx_out}


def stoch_rsi(
    values: Sequence[float],
    rsi_period: int = 14,
    stoch_period: int = 14,
    k_period: int = 3,
    d_period: int = 3,
) -> Dict[str, Series]:
    """随机相对强弱：RSI 在自身窗口内的位置（0..1），再做 K、D 平滑。"""
    n = len(values)
    if (
        not _is_period(rsi_period)
        or not _is_period(stoch_period)
        or not _is_period(k_period)
        or not _is_period(d_period)
    ):
        return {"k": _nulls(n), "d": _nulls(n)}
    rsi_values = rsi(values, rsi_period)
    indexes, compact_rsi = _compact(rsi_values)
    raw = _nulls(n)
    for j in range(stoch_period - 1, len(compact_rsi)):
        lowest = math.inf
        highest = -math.inf
        for q in range(j - stoch_period + 1, j + 1):
            v = compact_rsi[q]
            if v < lowest:
                lowest = v
            if v > highest:
                highest = v
        if highest == lowest:
            continue
        raw[indexes[j]] = (compact_rsi[j] - lowest) / (highest - lowest)
    k_out = _remap(raw, lambda vs: sma(vs, k_period))
    d_out = _remap(k_out, lambda vs: sma(vs, d_period))
    return {"k": k_out, "d": d_out}


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:842; adapted.
def chaikin_oscillator(
    bars: Sequence[Bar],
    fast: int = 3,
    slow: int = 10,
) -> Series:
    """蔡金振荡：累积/派发线快慢 EMA 之差。"""
    out = _nulls(len(bars))
    if not _is_period(fast) or not _is_period(slow):
        return out
    ad = ad_line(bars)
    ad_values = [0.0 if v is None else v for v in ad]
    fast_ema = ema(ad_values, fast)
    slow_ema = ema(ad_values, slow)
    for i in range(len(bars)):
        f = fast_ema[i]
        s = slow_ema[i]
        if f is None or s is None:
            continue
        out[i] = f - s
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1045; adapted.
def force_index(bars: Sequence[Bar], period: int = 13) -> Series:
    """力度指标：收盘价变动乘成交量后的 EMA。"""
    out = _nulls(len(bars))
    if not _is_period(period):
        return out
    raw = _nulls(len(bars))
    for i in range(1, len(bars)):
        bar = bars[i]
        raw[i] = (_field(bar, "c") - _field(bars[i - 1], "c")) * _field(bar, "v")
    return _remap(raw, lambda vs: ema(vs, period))


def ease_of_movement(bars: Sequence[Bar], period: int = 14) -> Series:
    """简易波动：中价位移除以箱体比率，再取 period 期简单平均。"""
    out = _nulls(len(bars))
    if not _is_period(period):
        return out
    raw = _nulls(len(bars))
    for i in range(1, len(bars)):
        bar = bars[i]
        prev = bars[i - 1]
        rng = _field(bar, "h") - _field(bar, "l")
        if rng == 0:
            continue
        distance = (_field(bar, "h") + _field(bar, "l")) / 2 - (
            _field(prev, "h") + _field(prev, "l")
        ) / 2
        box_ratio = _field(bar, "v") / 1e8 / rng
        if box_ratio == 0:
            continue
        raw[i] = distance / box_ratio
    return _remap(raw, lambda vs: sma(vs, period))


def mass_index(
    bars: Sequence[Bar],
    ema_period: int = 9,
    sum_period: int = 25,
) -> Series:
    """Mass Index：高低价差单 EMA 与双 EMA 之比在 sum_period 期内的和。"""
    out = _nulls(len(bars))
    if not _is_period(ema_period) or not _is_period(sum_period):
        return out
    spread = [_field(bar, "h") - _field(bar, "l") for bar in bars]
    single = ema(spread, ema_period)
    double = _remap(single, lambda vs: ema(vs, ema_period))
    ratio = _nulls(len(bars))
    for i in range(len(bars)):
        s = single[i]
        d = double[i]
        if s is None or d is None:
            continue
        if d == 0:
            continue
        ratio[i] = s / d
    indexes, values = _compact(ratio)
    if len(values) < sum_period:
        return out
    acc = 0.0
    for j in range(len(values)):
        acc += values[j]
        if j >= sum_period:
            acc -= values[j - sum_period]
        if j >= sum_period - 1:
            out[indexes[j]] = acc
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1053; adapted.
def ulcer_index(values: Sequence[float], period: int = 14) -> Series:
    """溃疡指数：窗口内相对最高点的回撤百分比平方平均再开方。"""
    out = _nulls(len(values))
    if not _is_period(period):
        return out
    for i in range(period - 1, len(values)):
        squares = 0.0
        peak = -math.inf
        ok = True
        for j in range(i - period + 1, i + 1):
            v = values[j]
            if v > peak:
                peak = v
            if peak == 0:
                ok = False
                break
            drawdown = (100 * (v - peak)) / peak
            squares += drawdown * drawdown
        if not ok:
            continue
        out[i] = math.sqrt(squares / period)
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1001; adapted.
def vortex(bars: Sequence[Bar], period: int = 14) -> Dict[str, Series]:
    """涡旋指标：正负方向运动之和占真实波幅之和的比例。"""
    n = len(bars)
    plus = _nulls(n)
    minus = _nulls(n)
    if not _is_period(period):
        return {"plus": plus, "minus": minus}
    window = period
    rng = true_range(bars)
    for i in range(window, n):
        plus_sum = 0.0
        minus_sum = 0.0
        tr_sum = 0.0
        for j in range(i - window + 1, i + 1):
            bar = bars[j]
            prev = bars[j - 1]
            plus_sum += abs(_field(bar, "h") - _field(prev, "l"))
            minus_sum += abs(_field(bar, "l") - _field(prev, "h"))
            tr_sum += rng[j]
        if tr_sum == 0:
            continue
        plus[i] = plus_sum / tr_sum
        minus[i] = minus_sum / tr_sum
    return {"plus": plus, "minus": minus}


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1017; adapted.
def choppiness(bars: Sequence[Bar], period: int = 14) -> Series:
    """震荡度：真实波幅之和与价格区间之比的常用对数，按周期对数归一化。"""
    out = _nulls(len(bars))
    if not _is_period(period) or period < 2:
        return out
    rng = true_range(bars)
    denominator = math.log10(period)
    for i in range(period - 1, len(bars)):
        tr_sum = 0.0
        highest = -math.inf
        lowest = math.inf
        for j in range(i - period + 1, i + 1):
            tr_sum += rng[j]
            bar = bars[j]
            h = _field(bar, "h")
            l = _field(bar, "l")
            if h > highest:
                highest = h
            if l < lowest:
                lowest = l
        span = highest - lowest
        if span == 0 or tr_sum <= 0:
            continue
        out[i] = (100 * math.log10(tr_sum / span)) / denominator
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/utils/technical_indicators.py:14; adapted.
def kdj(
    bars: Sequence[Bar],
    n: int = 9,
    k: int = 3,
    d: int = 3,
) -> Dict[str, Series]:
    """KDJ：n 期 RSV 经 K、D 两重回溯平滑（种子 50），J = 3K - 2D；区间为 0 时 RSV 取 50。

    QD 的实现把结果四舍五入到 4 位小数（technical_indicators.py:44-46）；这里保留
    全精度，以便与 TS 版逐值相等。
    """
    n_bars = len(bars)
    k_out = _nulls(n_bars)
    d_out = _nulls(n_bars)
    j_out = _nulls(n_bars)
    if not _is_period(n) or not _is_period(k) or not _is_period(d):
        return {"k": k_out, "d": d_out, "j": j_out}
    k_prev = 50.0
    d_prev = 50.0
    for i in range(n - 1, n_bars):
        lowest = math.inf
        highest = -math.inf
        for q in range(i - n + 1, i + 1):
            bar = bars[q]
            l = _field(bar, "l")
            h = _field(bar, "h")
            if l < lowest:
                lowest = l
            if h > highest:
                highest = h
        span = highest - lowest
        rsv = 50.0 if span == 0 else ((_field(bars[i], "c") - lowest) / span) * 100
        k_prev = ((k - 1) * k_prev + rsv) / k
        d_prev = ((d - 1) * d_prev + k_prev) / d
        k_out[i] = k_prev
        d_out[i] = d_prev
        j_out[i] = 3 * k_prev - 2 * d_prev
    return {"k": k_out, "d": d_out, "j": j_out}


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/registry.py:1037; adapted.
def elder_ray(bars: Sequence[Bar], period: int = 13) -> Dict[str, Series]:
    """Elder Ray：最高价、最低价相对收盘价 EMA 的偏离。"""
    n = len(bars)
    bull = _nulls(n)
    bear = _nulls(n)
    if not _is_period(period):
        return {"bull": bull, "bear": bear}
    average = ema([_field(bar, "c") for bar in bars], period)
    for i in range(n):
        mid = average[i]
        if mid is None:
            continue
        bull[i] = _field(bars[i], "h") - mid
        bear[i] = _field(bars[i], "l") - mid
    return {"bull": bull, "bear": bear}


# ---------------------------------------------------------------------------
# Alpha158 批 A 算子（对应 ta/alpha-ops.ts；period 非法时抛 ValueError）
# ---------------------------------------------------------------------------

def _window_has_gap(
    values: Sequence[Optional[float]],
    start: int,
    end: int,
) -> bool:
    for j in range(start, end + 1):
        if values[j] is None:
            return True
    return False


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:277; adapted.
def rolling_sum(values: Sequence[Optional[float]], period: int) -> Series:
    """滚动求和（窗口含当前项）；窗口内含 None 时为 None。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    for i in range(period - 1, n):
        start = i - period + 1
        if _window_has_gap(values, start, i):
            continue
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        out[i] = total
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:287; adapted.
def rolling_corr(
    a: Sequence[Optional[float]],
    b: Sequence[Optional[float]],
    period: int,
) -> Series:
    """滚动 Pearson 相关系数；窗口内任一 None 或分母为 0 时为 None。"""
    _assert_period(period)
    n = len(a)
    out = _nulls(n)
    if n < period:
        return out
    for i in range(period - 1, n):
        start = i - period + 1
        if _window_has_gap(a, start, i) or _window_has_gap(b, start, i):
            continue
        mean_a = 0.0
        mean_b = 0.0
        for j in range(start, i + 1):
            mean_a += a[j]
            mean_b += b[j]
        mean_a /= period
        mean_b /= period
        sxy = 0.0
        sxx = 0.0
        syy = 0.0
        for j in range(start, i + 1):
            da = a[j] - mean_a
            db = b[j] - mean_b
            sxy += da * db
            sxx += da * da
            syy += db * db
        denom = math.sqrt(sxx * syy)
        out[i] = None if denom == 0 else sxy / denom
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:309; adapted.
def rank_pct(values: Sequence[Optional[float]], period: int) -> Series:
    """末值在窗口内的百分位：平均名次 / period（并列取平均名次，同 pandas rank(pct=True)）。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    for i in range(period - 1, n):
        start = i - period + 1
        if _window_has_gap(values, start, i):
            continue
        last = values[i]
        below = 0
        equal = 0
        for j in range(start, i + 1):
            value = values[j]
            if value < last:
                below += 1
            elif value == last:
                equal += 1
        out[i] = (below + (equal + 1) / 2) / period
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:269; adapted.
def idx_max(values: Sequence[Optional[float]], period: int) -> Series:
    """窗口内最大值距今根数（0 = 当前根）；并列取最早出现。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    for i in range(period - 1, n):
        start = i - period + 1
        if _window_has_gap(values, start, i):
            continue
        best = start
        for j in range(start + 1, i + 1):
            if values[j] > values[best]:
                best = j
        out[i] = i - best
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:269; adapted.
def idx_min(values: Sequence[Optional[float]], period: int) -> Series:
    """窗口内最小值距今根数（0 = 当前根）；并列取最早出现。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    for i in range(period - 1, n):
        start = i - period + 1
        if _window_has_gap(values, start, i):
            continue
        best = start
        for j in range(start + 1, i + 1):
            if values[j] < values[best]:
                best = j
        out[i] = i - best
    return out


# Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:240; adapted.
def linear_residual(values: Sequence[Optional[float]], period: int) -> Series:
    """窗口一次线性回归的末点残差：y[-1] - (slope*x[-1] + intercept)，x 取 0..period-1。"""
    _assert_period(period)
    n = len(values)
    out = _nulls(n)
    if n < period:
        return out
    xbar = (period - 1) / 2
    for i in range(period - 1, n):
        start = i - period + 1
        if _window_has_gap(values, start, i):
            continue
        ybar = 0.0
        for j in range(start, i + 1):
            ybar += values[j]
        ybar /= period
        sxx = 0.0
        sxy = 0.0
        for k in range(period):
            dx = k - xbar
            sxy += dx * (values[start + k] - ybar)
            sxx += dx * dx
        slope = 0.0 if sxx == 0 else sxy / sxx
        intercept = ybar - slope * xbar
        out[i] = values[i] - (slope * (period - 1) + intercept)
    return out


# ---------------------------------------------------------------------------
# @gitrader/ta-plus 补充指标（批 9 主题二：engine-core 现有 + ta-plus 的并集）
# ---------------------------------------------------------------------------
# 本节与 packages/ta-plus/src/*.ts 逐函数对齐：同名（snake_case）、同口径、同窗口、
# 同「输出与输入等长 / 预热期 None / 因果」约定；数值与 TS 逐值相等（容差 1e-9，
# 夹具 tests/fixtures/ts-taplus.json，用例 tests/test_indicators_taplus.py）。
# 与本节之外（engine-core 口径）唯一的行为差异：非法周期一律抛 ValueError
# （对应 ta-plus 的 RangeError），而不是返回全 None —— 与 ta-plus 一致。
#
# 口径出处（逐函数注释里也有）：TA-Lib 的 ta_*.c（AVGDEV / VAR / BOP / ADXR / CMO /
# TSI / STOCHF / AROONOSC / CORREL / BETA / LINEARREG_* / TSF / NATR / ADOSC /
# TRIMA / T3 / AVGPRICE / MEDPRICE / TYPPRICE / WCLPRICE / MAX / MIN / MAXINDEX /
# MININDEX / MIDPOINT / MIDPRICE），QuantDinger v5.6.5（Apache-2.0）的
# app/services/factors/registry.py 与 app/services/market/technical_indicators.py。


def _assert_finite(value: Any, name: str) -> None:
    """有限数校验：非有限值抛 ValueError（对应 ta-plus 的 assertFinite）。"""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError("%s 必须是有限数：%r" % (name, value))
    if not math.isfinite(value):
        raise ValueError("%s 必须是有限数：%r" % (name, value))


def _assert_all_finite(values: Sequence[Any], label: str) -> None:
    """整条序列的有限性校验（对应 ta-plus 的 assertAllFinite）。"""
    for i, value in enumerate(values):
        if not math.isfinite(value):
            raise ValueError("%s: 第 %d 项不是有限数" % (label, i))


def _assert_ddof(ddof: Any) -> None:
    """ddof 必须是 >= 0 的整数（对应 ta-plus 的 Number.isInteger(ddof) && ddof >= 0）。"""
    if isinstance(ddof, bool) or not isinstance(ddof, (int, float)):
        raise ValueError("ddof 必须是大于等于 0 的整数：%r" % (ddof,))
    if isinstance(ddof, float) and (not math.isfinite(ddof) or not ddof.is_integer()):
        raise ValueError("ddof 必须是大于等于 0 的整数：%r" % (ddof,))
    if ddof < 0:
        raise ValueError("ddof 必须是大于等于 0 的整数：%r" % (ddof,))


def _assert_same_length(a: Sequence[Any], b: Sequence[Any]) -> None:
    if len(a) != len(b):
        raise ValueError("两个序列必须等长，实际为 %d 与 %d" % (len(a), len(b)))


def _ema_dense(values: Sequence[float], period: int) -> tuple[List[float], List[int]]:
    """密集 EMA：返回（平滑值，相对输入的下标），便于把平滑链对齐回原时间轴。"""
    if len(values) < period:
        return [], []
    seed = 0.0
    for i in range(period):
        seed += values[i]
    value = seed / period
    out: List[float] = [value]
    positions: List[int] = [period - 1]
    k = 2 / (period + 1)
    for i in range(period, len(values)):
        value = values[i] * k + value * (1 - k)
        out.append(value)
        positions.append(i)
    return out, positions


def _dense(source: Sequence[Optional[float]]) -> tuple[List[float], List[int]]:
    """序列里的非 None 项与其原下标（对应 ta-plus 里的 `dense` 数组 + 偏移）。"""
    values: List[float] = []
    positions: List[int] = []
    for i, value in enumerate(source):
        if value is None:
            continue
        values.append(value)
        positions.append(i)
    return values, positions


def _wilder_sum(values: Sequence[float], period: int, start: int = 1) -> Series:
    """Wilder 累加（和，不是均值）：首值 = Σ values[start .. start+period-1]。"""
    out = _nulls(len(values))
    if len(values) <= start + period - 1:
        return out
    total = 0.0
    for i in range(start, start + period):
        total += values[i]
    first = start + period - 1
    out[first] = total
    for i in range(start + period, len(values)):
        total = total - total / period + values[i]
        out[i] = total
    return out


def _directional_movement(bars: Sequence[Bar]) -> tuple[List[float], List[float]]:
    """+DM / -DM 原始序列（Wilder 定义：两者只有较大且为正的一方计入）。"""
    n = len(bars)
    plus = [0.0] * n
    minus = [0.0] * n
    for i in range(1, n):
        up_move = _field(bars[i], "h") - _field(bars[i - 1], "h")
        down_move = _field(bars[i - 1], "l") - _field(bars[i], "l")
        if up_move > down_move and up_move > 0:
            plus[i] = up_move
        elif down_move > up_move and down_move > 0:
            minus[i] = down_move
    return plus, minus


# ---- 单根收益与风险 / 波动（对应 ta-plus/src/internal.ts、risk.ts） ----------

def simple_returns(values: Sequence[float]) -> Series:
    """简单收益率：第 0 项 None，之后 values[i]/values[i-1] - 1；基数为 0 处 None。"""
    out = _nulls(len(values))
    for i in range(1, len(values)):
        base = values[i - 1]
        out[i] = None if base == 0 else values[i] / base - 1
    return out


def realized_volatility(
    values: Sequence[float],
    period: int = 20,
    annualize: bool = True,
    periods_per_year: int = 252,
    ddof: int = 1,
) -> Series:
    """已实现波动率：窗口内收益率的样本标准差（ddof=1，pandas .std() 口径），可年化。

    TA-Lib 没有对应函数；口径同 QuantDinger `_realized_vol`（√252 年化）。
    """
    _assert_period(period)
    _assert_period(periods_per_year, "periodsPerYear")
    _assert_ddof(ddof)
    if period <= ddof:
        raise ValueError("period 必须大于 ddof，实际为 period=%r ddof=%r" % (period, ddof))
    _assert_all_finite(values, "realizedVolatility")
    out = _nulls(len(values))
    scale = math.sqrt(periods_per_year) if annualize else 1.0
    for i in range(period - 1, len(values)):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        mean = total / period
        squares = 0.0
        for j in range(start, i + 1):
            d = values[j] - mean
            squares += d * d
        out[i] = math.sqrt(squares / (period - ddof)) * scale
    return out


def downside_volatility(
    values: Sequence[float],
    period: int = 20,
    mar: float = 0.0,
    annualize: bool = True,
    periods_per_year: int = 252,
) -> Series:
    """下行波动率（Sortino 分母口径）：只累计低于 mar 的偏差平方，按整窗求均值后开方。

    与 QD `_downside_volatility` 一致：分母是 period，不是「下跌期数」。
    """
    _assert_period(period)
    _assert_period(periods_per_year, "periodsPerYear")
    _assert_all_finite(values, "downsideVolatility")
    out = _nulls(len(values))
    scale = math.sqrt(periods_per_year) if annualize else 1.0
    for i in range(period - 1, len(values)):
        squares = 0.0
        for j in range(i - period + 1, i + 1):
            shortfall = values[j] - mar
            if shortfall < 0:
                squares += shortfall * shortfall
        out[i] = math.sqrt(squares / period) * scale
    return out


def skewness(values: Sequence[float], period: int = 20, sample: bool = True) -> Series:
    """偏度：sample=True 用 pandas .skew() / Excel SKEW 的校正公式（n ≥ 3），

    sample=False 用总体矩 g1 = m3 / m2^1.5（n ≥ 2）；窗口标准差为 0 时取中性值 0。
    """
    _assert_period(period)
    _assert_all_finite(values, "skewness")
    out = _nulls(len(values))
    minimum = 3 if sample else 2
    if period < minimum:
        return out
    for i in range(period - 1, len(values)):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        mean = total / period
        m2 = 0.0
        m3 = 0.0
        for j in range(start, i + 1):
            d = values[j] - mean
            m2 += d * d
            m3 += d * d * d
        if sample:
            variance = m2 / (period - 1)
            if variance == 0:
                out[i] = 0.0
                continue
            s = math.sqrt(variance)
            acc = 0.0
            for j in range(start, i + 1):
                z = (values[j] - mean) / s
                acc += z * z * z
            out[i] = (period / ((period - 1) * (period - 2))) * acc
        else:
            pop_variance = m2 / period
            out[i] = 0.0 if pop_variance == 0 else m3 / period / math.pow(pop_variance, 1.5)
    return out


def kurtosis(values: Sequence[float], period: int = 20, sample: bool = True) -> Series:
    """超额峰度（正态为 0）：sample=True 用 pandas .kurt() / Excel KURT 的校正公式（n ≥ 4），

    sample=False 用总体超额峰度 m4/m2² - 3（n ≥ 2）；窗口标准差为 0 时取中性值 0。
    """
    _assert_period(period)
    _assert_all_finite(values, "kurtosis")
    out = _nulls(len(values))
    minimum = 4 if sample else 2
    if period < minimum:
        return out
    for i in range(period - 1, len(values)):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        mean = total / period
        m2 = 0.0
        m4 = 0.0
        for j in range(start, i + 1):
            d = values[j] - mean
            d2 = d * d
            m2 += d2
            m4 += d2 * d2
        if m2 == 0:
            out[i] = 0.0
            continue
        if sample:
            s = math.sqrt(m2 / (period - 1))
            acc = 0.0
            for j in range(start, i + 1):
                z = (values[j] - mean) / s
                acc += z * z * z * z
            n = period
            out[i] = (
                (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * acc
                - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3))
            )
        else:
            pop_variance = m2 / period
            out[i] = m4 / period / (pop_variance * pop_variance) - 3
    return out


def max_drawdown(values: Sequence[float], period: int = 20) -> Series:
    """窗口内最大回撤（负数或 0 的分数）：v/peak - 1 取窗口最小值。"""
    _assert_period(period)
    _assert_all_finite(values, "maxDrawdown")
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        peak = -math.inf
        worst = 0.0
        for j in range(i - period + 1, i + 1):
            v = values[j]
            if v > peak:
                peak = v
            if peak > 0:
                dd = v / peak - 1
                if dd < worst:
                    worst = dd
        out[i] = worst
    return out


def atr_percent(bars: Sequence[Bar], period: int = 14) -> Series:
    """ATR 占价格比（比率，不是百分数）：atr[i] / close[i]；收盘价 <= 0 处 None。"""
    _assert_period(period)
    average = atr(bars, period)
    out = _nulls(len(bars))
    for i in range(len(bars)):
        a = average[i]
        c = _field(bars[i], "c")
        if a is None or c <= 0:
            continue
        out[i] = a / c
    return out


def amihud_illiquidity(bars: Sequence[Bar], period: int = 20) -> Series:
    """Amihud 非流动性：窗口内 mean(|r_i| / (close_i · volume_i))。

    成交额 <= 0 的 bar 不计入；窗口内没有一个可计入项时为 None。
    """
    _assert_period(period)
    n = len(bars)
    out = _nulls(n)
    for i in range(period, n):
        total = 0.0
        count = 0
        for j in range(i - period + 1, i + 1):
            prev_close = _field(bars[j - 1], "c")
            if prev_close <= 0:
                continue
            traded = _field(bars[j], "c") * _field(bars[j], "v")
            if not traded > 0:
                continue
            total += abs(_field(bars[j], "c") / prev_close - 1) / traded
            count += 1
        out[i] = None if count == 0 else total / count
    return out


# ---- 统计与区间（对应 ta-plus/src/stat-ext.ts） ------------------------------

def avg_dev(values: Sequence[float], period: int = 20) -> Series:
    """平均绝对偏差：窗口内 mean(|x - SMA|)（TA-Lib TA_AVGDEV，总体口径）。"""
    _assert_period(period)
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        mean = total / period
        deviation = 0.0
        for j in range(start, i + 1):
            deviation += abs(values[j] - mean)
        out[i] = deviation / period
    return out


def variance(values: Sequence[float], period: int = 20, ddof: int = 0) -> Series:
    """滚动方差：TA-Lib TA_VAR 在 nbDev=1 时 = 总体方差（除以 period）；ddof 可调。"""
    _assert_period(period)
    _assert_ddof(ddof)
    if period <= ddof:
        raise ValueError("period 必须大于 ddof，实际为 period=%r ddof=%r" % (period, ddof))
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        mean = total / period
        squares = 0.0
        for j in range(start, i + 1):
            d = values[j] - mean
            squares += d * d
        out[i] = squares / (period - ddof)
    return out


def bop(bars: Sequence[Bar]) -> Series:
    """力量平衡 BOP：(close - open) / (high - low)，区间为 0 时输出 0（无预热期）。"""
    out = _nulls(len(bars))
    for i in range(len(bars)):
        bar = bars[i]
        span = _field(bar, "h") - _field(bar, "l")
        out[i] = 0.0 if span == 0 else (_field(bar, "c") - _field(bar, "o")) / span
    return out


def adxr(adx_values: Sequence[Optional[float]], period: int = 14) -> Series:
    """ADX 评级：(adx[i] + adx[i-(period-1)]) / 2；任一端为 None 时输出 None。"""
    _assert_period(period)
    lag = period - 1
    out = _nulls(len(adx_values))
    for i in range(lag, len(adx_values)):
        now = adx_values[i]
        before = adx_values[i - lag]
        if now is None or before is None:
            continue
        out[i] = (now + before) / 2
    return out


# ---- 动量与趋势强度（对应 ta-plus/src/momentum-ext.ts） ----------------------

def cmo(values: Sequence[float], period: int = 14) -> Series:
    """钱德动量摆动指标：Wilder 平滑的涨跌额，100·(gain-loss)/(gain+loss)。

    与 TA-Lib TA_CMO 同口径：种子为前 period 个涨跌额的平均，之后 Wilder 递推；
    涨跌和都为 0 时输出 0；首个可算位置为下标 period。
    """
    _assert_period(period)
    out = _nulls(len(values))
    if len(values) <= period:
        return out
    gain = 0.0
    loss = 0.0
    prev = values[0]
    for i in range(1, period + 1):
        delta = values[i] - prev
        prev = values[i]
        if delta > 0:
            gain += delta
        else:
            loss -= delta
    gain /= period
    loss /= period

    def emit(i: int) -> None:
        total = gain + loss
        out[i] = (100 * (gain - loss)) / total if total > 0 else 0.0

    emit(period)
    for i in range(period + 1, len(values)):
        delta = values[i] - prev
        prev = values[i]
        up = delta if delta > 0 else 0.0
        gain += up / period - gain / period
        loss += (up - delta) / period - loss / period
        emit(i)
    return out


def tsi(values: Sequence[float], slow: int = 25, fast: int = 13) -> Series:
    """真实强度指数（Blau）：动量的二级 EMA 与其绝对值二级 EMA 之比 ×100。"""
    _assert_period(slow, "slow")
    _assert_period(fast, "fast")
    out = _nulls(len(values))
    if len(values) < 2:
        return out
    momentum_values = [values[i] - values[i - 1] for i in range(1, len(values))]
    first_values, first_positions = _ema_dense(momentum_values, slow)
    if not first_values:
        return out
    second_values, second_positions = _ema_dense(first_values, fast)
    if not second_values:
        return out
    abs_values, _ = _ema_dense([abs(v) for v in momentum_values], slow)
    abs_second, _ = _ema_dense(abs_values, fast)
    for j in range(len(second_values)):
        denominator = abs_second[j]
        index = 1 + first_positions[second_positions[j]]
        out[index] = 0.0 if denominator == 0 else (100 * second_values[j]) / denominator
    return out


def efficiency_ratio(values: Sequence[float], period: int = 10) -> Series:
    """考夫曼效率系数：|v[i]-v[i-period]| / Σ|Δv|；路径长度为 0 时输出 0。"""
    _assert_period(period)
    out = _nulls(len(values))
    for i in range(period, len(values)):
        path = 0.0
        for j in range(i - period + 1, i + 1):
            path += abs(values[j] - values[j - 1])
        out[i] = 0.0 if path == 0 else abs(values[i] - values[i - period]) / path
    return out


def sma_distance(values: Sequence[float], period: int = 20) -> Series:
    """价格对 SMA 的偏离度（分数）：values[i] / sma[i] - 1；SMA 为 0 处 None。"""
    _assert_period(period)
    average = sma(values, period)
    out = _nulls(len(values))
    for i in range(len(values)):
        base = average[i]
        if base is None or base == 0:
            continue
        out[i] = values[i] / base - 1
    return out


def ema_distance(values: Sequence[float], period: int = 20) -> Series:
    """价格对 EMA 的偏离度（分数）：values[i] / ema[i] - 1；EMA 为 0 处 None。"""
    _assert_period(period)
    average = ema(values, period)
    out = _nulls(len(values))
    for i in range(len(values)):
        base = average[i]
        if base is None or base == 0:
            continue
        out[i] = values[i] / base - 1
    return out


def ema_slope(values: Sequence[float], period: int = 20, slope_period: int = 5) -> Series:
    """EMA 斜率（相对变化）：ema[i] / ema[i-slopePeriod] - 1；基准为 0 或未可算处 None。"""
    _assert_period(period)
    _assert_period(slope_period, "slopePeriod")
    average = ema(values, period)
    out = _nulls(len(values))
    for i in range(slope_period, len(values)):
        now = average[i]
        base = average[i - slope_period]
        if now is None or base is None or base == 0:
            continue
        out[i] = now / base - 1
    return out


def z_score(values: Sequence[float], period: int = 20, ddof: int = 1) -> Series:
    """均值回归 z 分数：(last - mean) / std，std 默认 ddof=1；标准差为 0 时输出 0。"""
    _assert_period(period)
    _assert_ddof(ddof)
    if period <= ddof:
        raise ValueError("period 必须大于 ddof，实际为 period=%r ddof=%r" % (period, ddof))
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        start = i - period + 1
        total = 0.0
        for j in range(start, i + 1):
            total += values[j]
        mean = total / period
        squares = 0.0
        for j in range(start, i + 1):
            d = values[j] - mean
            squares += d * d
        window_variance = squares / (period - ddof)
        out[i] = 0.0 if window_variance == 0 else (values[i] - mean) / math.sqrt(window_variance)
    return out


# ---- 流动性 / 区间位置（对应 ta-plus/src/liquidity.ts） ----------------------

def volume_ratio(volumes: Sequence[float], period: int = 20) -> Series:
    """量比：volume[i] / mean(volume[i-period .. i-1])，基线不含当根；基线为 0 处 None。"""
    _assert_period(period)
    out = _nulls(len(volumes))
    for i in range(period, len(volumes)):
        total = 0.0
        for j in range(i - period, i):
            total += volumes[j]
        average = total / period
        out[i] = None if average == 0 else volumes[i] / average
    return out


def price_position(bars: Sequence[Bar], period: int = 20) -> Series:
    """价格位置：(close - low) / (high - low) × 100；区间高度为 0 时输出 50。"""
    _assert_period(period)
    out = _nulls(len(bars))
    for i in range(period - 1, len(bars)):
        high = -math.inf
        low = math.inf
        for j in range(i - period + 1, i + 1):
            h = _field(bars[j], "h")
            l = _field(bars[j], "l")
            if h > high:
                high = h
            if l < low:
                low = l
        if high == low:
            out[i] = 50.0
            continue
        out[i] = ((_field(bars[i], "c") - low) / (high - low)) * 100
    return out


# ---- 价格变换（对应 ta-plus/src/price-transform.ts，TA-Lib lookback 0） ------

def avg_price(bars: Sequence[Bar]) -> Series:
    """均价：(open + high + low + close) / 4。"""
    return [
        (_field(b, "o") + _field(b, "h") + _field(b, "l") + _field(b, "c")) / 4 for b in bars
    ]


def med_price(bars: Sequence[Bar]) -> Series:
    """中价：(high + low) / 2。"""
    return [(_field(b, "h") + _field(b, "l")) / 2 for b in bars]


def typ_price(bars: Sequence[Bar]) -> Series:
    """典型价：(high + low + close) / 3。"""
    return [(_field(b, "h") + _field(b, "l") + _field(b, "c")) / 3 for b in bars]


def wcl_price(bars: Sequence[Bar]) -> Series:
    """加权收盘价：(high + low + 2 × close) / 4。"""
    return [(_field(b, "h") + _field(b, "l") + 2 * _field(b, "c")) / 4 for b in bars]


# ---- 窗口极值 / 中点（对应 ta-plus/src/window.ts） --------------------------

def rolling_max(values: Sequence[float], period: int) -> Series:
    """滚动最大值（窗口含当根）；前 period-1 项 None。"""
    _assert_period(period)
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        best = values[i - period + 1]
        for j in range(i - period + 2, i + 1):
            if values[j] > best:
                best = values[j]
        out[i] = best
    return out


def rolling_min(values: Sequence[float], period: int) -> Series:
    """滚动最小值（窗口含当根）；前 period-1 项 None。"""
    _assert_period(period)
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        best = values[i - period + 1]
        for j in range(i - period + 2, i + 1):
            if values[j] < best:
                best = values[j]
        out[i] = best
    return out


def max_index(values: Sequence[float], period: int) -> Series:
    """窗口最大值在【输入数组】里的下标；并列时取最新一根（TA-Lib MAXINDEX 语义）。"""
    _assert_period(period)
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        best = i - period + 1
        for j in range(i - period + 2, i + 1):
            if values[j] >= values[best]:
                best = j
        out[i] = best
    return out


def min_index(values: Sequence[float], period: int) -> Series:
    """窗口最小值在【输入数组】里的下标；并列时取最新一根（TA-Lib MININDEX 语义）。"""
    _assert_period(period)
    out = _nulls(len(values))
    for i in range(period - 1, len(values)):
        best = i - period + 1
        for j in range(i - period + 2, i + 1):
            if values[j] <= values[best]:
                best = j
        out[i] = best
    return out


def mid_point(values: Sequence[float], period: int) -> Series:
    """窗口中点：(滚动最大值 + 滚动最小值) / 2。"""
    _assert_period(period)
    high = rolling_max(values, period)
    low = rolling_min(values, period)
    out = _nulls(len(values))
    for i in range(len(values)):
        h = high[i]
        l = low[i]
        if h is None or l is None:
            continue
        out[i] = (h + l) / 2
    return out


def mid_price(bars: Sequence[Bar], period: int) -> Series:
    """价格中点：(窗口最高价 + 窗口最低价) / 2。"""
    _assert_period(period)
    out = _nulls(len(bars))
    for i in range(period - 1, len(bars)):
        highest = _field(bars[i - period + 1], "h")
        lowest = _field(bars[i - period + 1], "l")
        for j in range(i - period + 2, i + 1):
            h = _field(bars[j], "h")
            l = _field(bars[j], "l")
            if h > highest:
                highest = h
            if l < lowest:
                lowest = l
        out[i] = (highest + lowest) / 2
    return out


# ---- 均线扩展（对应 ta-plus/src/ma-ext.ts） --------------------------------

def trima(values: Sequence[float], period: int = 20) -> Series:
    """三角移动平均：两次简单平均的复合（TA-TRIMA.c：偶数/奇数期的两层窗宽不同）。"""
    _assert_period(period)
    odd = period % 2 == 1
    n1 = (period + 1) // 2 if odd else period // 2
    n2 = (period + 1) // 2 if odd else period // 2 + 1
    out = _nulls(len(values))
    first = sma(values, n1)
    dense_values, _ = _dense(first)
    if not dense_values:
        return out
    second = sma(dense_values, n2)
    offset = n1 - 1
    for j in range(len(second)):
        value = second[j]
        if value is None:
            continue
        out[offset + j] = value
    return out


def _ema_cascade(values: Sequence[float], period: int, stages: int) -> List[List[float]]:
    """六级 EMA 级联：每级用本级前 period 个值的简单平均作种子，返回各级稠密序列。"""
    out: List[List[float]] = []
    sequence: Sequence[float] = values
    k = 2 / (period + 1)
    for _ in range(stages):
        dense: List[float] = []
        if len(sequence) >= period:
            seed = 0.0
            for i in range(period):
                seed += sequence[i]
            value = seed / period
            dense.append(value)
            for i in range(period, len(sequence)):
                value = sequence[i] * k + value * (1 - k)
                dense.append(value)
        out.append(dense)
        sequence = dense
    return out


def t3(values: Sequence[float], period: int = 5, v_factor: float = 0.7) -> Series:
    """Tillson T3：c1·e6 + c2·e5 + c3·e4 + c4·e3，四个权重之和为 1（TA-T3.c）。

    首个非 None 位置为 6 × (period-1)。
    """
    _assert_period(period)
    _assert_finite(v_factor, "vFactor")
    out = _nulls(len(values))
    v = v_factor
    v2 = v * v
    v3 = v2 * v
    c1 = -v3
    c2 = 3 * (v2 + v3)
    c3 = -3 * (2 * v2 + v + v3)
    c4 = 1 + 3 * v + 3 * v2 + v3
    stages = _ema_cascade(values, period, 6)
    e3, e4, e5, e6 = stages[2], stages[3], stages[4], stages[5]
    step = period - 1
    for i in range(6 * step, len(values)):
        out[i] = (
            c1 * e6[i - 6 * step]
            + c2 * e5[i - 5 * step]
            + c3 * e4[i - 4 * step]
            + c4 * e3[i - 3 * step]
        )
    return out


# ---- 方向类（对应 ta-plus/src/directional.ts） ------------------------------

def plus_dm(bars: Sequence[Bar], period: int = 14) -> Series:
    """平滑后的上升方向运动 +DM（Wilder 累加和）；首个非 None 位置为 period。"""
    _assert_period(period)
    plus, _ = _directional_movement(bars)
    return _wilder_sum(plus, period)


def minus_dm(bars: Sequence[Bar], period: int = 14) -> Series:
    """平滑后的下降方向运动 -DM（Wilder 累加和）；首个非 None 位置为 period。"""
    _assert_period(period)
    _, minus = _directional_movement(bars)
    return _wilder_sum(minus, period)


def plus_di(bars: Sequence[Bar], period: int = 14) -> Series:
    """上升方向指标 +DI：与 本文件 `adx()` 的 plusDi 同口径同值（单一真相源）。"""
    _assert_period(period)
    return adx(bars, period)["plusDi"]


def minus_di(bars: Sequence[Bar], period: int = 14) -> Series:
    """下降方向指标 -DI：与 本文件 `adx()` 的 minusDi 同口径同值。"""
    _assert_period(period)
    return adx(bars, period)["minusDi"]


def dx(bars: Sequence[Bar], period: int = 14) -> Series:
    """动向指数 DX = 100 × |+DI - -DI| ÷ (+DI + -DI)；两者之和为 0 处 None。"""
    _assert_period(period)
    directions = adx(bars, period)
    plus_series = directions["plusDi"]
    minus_series = directions["minusDi"]
    out = _nulls(len(bars))
    for i in range(len(bars)):
        p = plus_series[i]
        m = minus_series[i]
        if p is None or m is None:
            continue
        total = p + m
        if total == 0:
            continue
        out[i] = (100 * abs(p - m)) / total
    return out


# ---- 振荡补充（对应 ta-plus/src/osc-ext.ts） -------------------------------

def aroon_osc(bars: Sequence[Bar], period: int = 25) -> Series:
    """Aroon 振荡：与 本文件 `aroon()` 的 osc 同口径同值（窗口 period+1 根）。"""
    _assert_period(period)
    return aroon(bars, period)["osc"]


def stoch_f(bars: Sequence[Bar], k_period: int = 5, d_period: int = 3) -> Dict[str, Series]:
    """快速随机指标：K = 100×(c - LL)/(HH - LL)，区间为 0 时 K = 0；D 是 K 的简单平均。

    与 engine-core 的 `stochastic()` 口径不同（区间为 0 时那边给 50、默认 kPeriod 14）。
    """
    _assert_period(k_period)
    _assert_period(d_period)
    n = len(bars)
    k = _nulls(n)
    for i in range(k_period - 1, n):
        highest = _field(bars[i - k_period + 1], "h")
        lowest = _field(bars[i - k_period + 1], "l")
        for j in range(i - k_period + 2, i + 1):
            h = _field(bars[j], "h")
            l = _field(bars[j], "l")
            if h > highest:
                highest = h
            if l < lowest:
                lowest = l
        span = highest - lowest
        k[i] = 0.0 if span == 0 else (100 * (_field(bars[i], "c") - lowest)) / span
    dense_values, _ = _dense(k)
    d = _nulls(n)
    if not dense_values:
        return {"k": k, "d": d}
    smoothed = sma(dense_values, d_period)
    offset = k_period - 1
    for j in range(len(smoothed)):
        value = smoothed[j]
        if value is None:
            continue
        d[offset + j] = value
    return {"k": k, "d": d}


# ---- 回归与相关（对应 ta-plus/src/regression.ts） --------------------------

def _window_sums(
    a: Sequence[float], b: Sequence[float], start: int, period: int
) -> tuple[float, float, float]:
    """窗口内的交叉项与两个离差平方和。"""
    mean_a = 0.0
    mean_b = 0.0
    for j in range(start, start + period):
        mean_a += a[j]
        mean_b += b[j]
    mean_a /= period
    mean_b /= period
    sxy = 0.0
    sxx = 0.0
    syy = 0.0
    for j in range(start, start + period):
        da = a[j] - mean_a
        db = b[j] - mean_b
        sxy += da * db
        sxx += da * da
        syy += db * db
    return sxy, sxx, syy


def correl(a: Sequence[float], b: Sequence[float], period: int = 20) -> Series:
    """滚动 Pearson 相关系数（-1..1）；任一窗口方差为 0 处 None（TA-CORREL 口径，退化处不用 0）。"""
    _assert_period(period)
    _assert_same_length(a, b)
    out = _nulls(len(a))
    for i in range(period - 1, len(a)):
        sxy, sxx, syy = _window_sums(a, b, i - period + 1, period)
        if sxx == 0 or syy == 0:
            continue
        out[i] = sxy / math.sqrt(sxx * syy)
    return out


def beta(a: Sequence[float], b: Sequence[float], period: int = 20) -> Series:
    """滚动 Beta：a 对基准 b 的回归斜率 = Σ(a-ā)(b-b̄) ÷ Σ(b-b̄)²；基准方差为 0 处 None。

    与 TA-Lib `ta_BETA` 的差异：那边接收两条价格、内部先转收益率；本函数直接对传入序列回归，
    常规 beta 需调用方先用 `simple_returns()` 把价格转成收益率。
    """
    _assert_period(period)
    _assert_same_length(a, b)
    out = _nulls(len(a))
    for i in range(period - 1, len(a)):
        sxy, _, syy = _window_sums(a, b, i - period + 1, period)
        if syy == 0:
            continue
        out[i] = sxy / syy
    return out


def _assert_regression_period(period: int) -> None:
    _assert_period(period)
    if period < 2:
        raise ValueError("period 必须大于等于 2（回归至少要两个点），实际为 %r" % (period,))


def lin_reg_slope(values: Sequence[float], period: int = 14) -> Series:
    """窗口线性回归的斜率（横轴为窗口内序号 0..period-1）：取本文件 `linear_regression()` 的 slope。"""
    _assert_regression_period(period)
    return linear_regression(values, period)["slope"]


def lin_reg_intercept(values: Sequence[float], period: int = 14) -> Series:
    """窗口线性回归的截距（横轴 0 处，即窗口最左边一根的拟合值）。"""
    _assert_regression_period(period)
    return linear_regression(values, period)["intercept"]


def lin_reg_angle(values: Sequence[float], period: int = 14) -> Series:
    """窗口线性回归的斜率角度：atan(slope) 转度（-90..90，TA-LINEARREG_ANGLE）。"""
    _assert_period(period)
    slope = lin_reg_slope(values, period)
    out = _nulls(len(values))
    for i in range(len(values)):
        b = slope[i]
        if b is None:
            continue
        out[i] = (math.atan(b) * 180) / math.pi
    return out


def tsf(values: Sequence[float], period: int = 14) -> Series:
    """时间序列预测：intercept + slope × period，即窗口后一格的回归值（TA-TSF）。"""
    _assert_period(period)
    slope = lin_reg_slope(values, period)
    intercept = lin_reg_intercept(values, period)
    out = _nulls(len(values))
    for i in range(len(values)):
        b = slope[i]
        a = intercept[i]
        if b is None or a is None:
            continue
        out[i] = a + b * period
    return out


# ---- 波动与量能补充（对应 ta-plus/src/volatility-ext.ts） -------------------

def natr(bars: Sequence[Bar], period: int = 14) -> Series:
    """归一化真实波幅：100 × ATR ÷ close（百分比单位）；close 为 0 处 None。

    ATR 用 engine-core / QD 口径（第 0 根 TR = h-l、首值在下标 period-1），
    与 TA-Lib ta_NATR.c（TR 从第 1 根算、首值在下标 period）在预热段数值不同。
    """
    _assert_period(period)
    n = len(bars)
    out = _nulls(n)
    if n < period:
        return out
    ranges = true_range(bars)
    seed = 0.0
    for i in range(period):
        seed += ranges[i]
    value = seed / period
    close = _field(bars[period - 1], "c")
    out[period - 1] = None if close == 0 else (100 * value) / close
    for i in range(period, n):
        value = (value * (period - 1) + ranges[i]) / period
        close = _field(bars[i], "c")
        out[i] = None if close == 0 else (100 * value) / close
    return out


def ad_osc(bars: Sequence[Bar], fast_period: int = 3, slow_period: int = 10) -> Series:
    """蔡金振荡：EMA(A/D, fast) - EMA(A/D, slow)，两条 EMA 都以第一个 A/D 值为种子。

    首个非 None 位置为 max(fastPeriod, slowPeriod) - 1（与 TA-ADOSC lookback 一致）。
    """
    _assert_period(fast_period, "fastPeriod")
    _assert_period(slow_period, "slowPeriod")
    out = _nulls(len(bars))
    if not bars:
        return out
    ad = ad_line(bars)
    fast_k = 2 / (fast_period + 1)
    slow_k = 2 / (slow_period + 1)
    fast = ad[0]
    slow = ad[0]
    start = max(fast_period, slow_period) - 1
    for i in range(1, len(ad)):
        fast = ad[i] * fast_k + fast * (1 - fast_k)
        slow = ad[i] * slow_k + slow * (1 - slow_k)
        if i >= start:
            out[i] = fast - slow
    if start == 0 and len(ad) > 0:
        out[0] = 0.0
    return out


# ---- 价位估计（对应 ta-plus/src/levels.ts） --------------------------------

def levels(
    bars: Sequence[Bar], period: int = 20, multiplier: float = 2
) -> Dict[str, Any]:
    """支撑 / 阻力合成：枢轴 S1/R1、近 period 根摆动高低点、布林上下轨三路取平均。

    这是**启发式估计**（`method` / `isEstimate` 明确标注），不是价格预测，也不构成交易建议。
    QD 那边样本不足时用兜底常量，这里抛 ValueError（与 ta-plus 一致）。
    """
    _assert_period(period)
    _assert_finite(multiplier, "multiplier")
    if multiplier <= 0:
        raise ValueError("multiplier 必须大于 0，实际为 %r" % (multiplier,))
    if len(bars) < period + 1:
        raise ValueError("levels 需要至少 period + 1 根 K 线，实际为 %d 根" % (len(bars),))
    prev = bars[len(bars) - 2]

    total = 0.0
    swing_high = -math.inf
    swing_low = math.inf
    for i in range(len(bars) - period, len(bars)):
        total += _field(bars[i], "c")
        h = _field(bars[i], "h")
        l = _field(bars[i], "l")
        if h > swing_high:
            swing_high = h
        if l < swing_low:
            swing_low = l
    middle = total / period
    squares = 0.0
    for i in range(len(bars) - period, len(bars)):
        d = _field(bars[i], "c") - middle
        squares += d * d
    deviation = math.sqrt(squares / period)
    bb_upper = middle + multiplier * deviation
    bb_lower = middle - multiplier * deviation

    prev_h = _field(prev, "h")
    prev_l = _field(prev, "l")
    prev_c = _field(prev, "c")
    pivot = (prev_h + prev_l + prev_c) / 3
    r1 = 2 * pivot - prev_l
    s1 = 2 * pivot - prev_h
    r2 = pivot + (prev_h - prev_l)
    s2 = pivot - (prev_h - prev_l)

    return {
        "support": (s1 + swing_low + bb_lower) / 3,
        "resistance": (r1 + swing_high + bb_upper) / 3,
        "pivot": pivot,
        "s1": s1,
        "s2": s2,
        "r1": r1,
        "r2": r2,
        "swingHigh": swing_high,
        "swingLow": swing_low,
        "bbUpper": bb_upper,
        "bbLower": bb_lower,
        "method": "pivot_swing_bb_avg",
        "isEstimate": True,
    }


# ---- 基本面比率（对应 ta-plus/src/fundamental.ts；**实验性**，标量进标量出） --

def _ratio(numerator: float, denominator: float, label: str) -> float:
    _assert_finite(numerator, "%s.numerator" % label)
    _assert_finite(denominator, "%s.denominator" % label)
    if denominator == 0:
        raise ValueError("%s: 分母不能为 0" % label)
    return numerator / denominator


def earnings_yield(net_income: float, market_cap: float) -> float:
    """盈利收益率 = 净利润 / 市值（QD earnings_yield；实验性接口）。"""
    return _ratio(net_income, market_cap, "earningsYield")


def book_to_price(shareholder_equity: float, market_cap: float) -> float:
    """账面市值比 = 股东权益 / 市值（QD book_to_price；实验性接口）。"""
    return _ratio(shareholder_equity, market_cap, "bookToPrice")


def return_on_equity(net_income: float, shareholder_equity: float) -> float:
    """净资产收益率 = 净利润 / 股东权益（QD return_on_equity；实验性接口）。"""
    return _ratio(net_income, shareholder_equity, "returnOnEquity")


def debt_to_equity(total_debt: float, shareholder_equity: float) -> float:
    """产权比率 = 总负债 / 股东权益（QD debt_to_equity；实验性接口）。"""
    return _ratio(total_debt, shareholder_equity, "debtToEquity")


def free_cash_flow_yield(free_cash_flow: float, market_cap: float) -> float:
    """自由现金流收益率 = 自由现金流 / 市值（QD free_cash_flow_yield；实验性接口）。"""
    return _ratio(free_cash_flow, market_cap, "freeCashFlowYield")


def revenue_growth(revenue: float, revenue_prior: float) -> float:
    """营业收入增长率 = 本期 / 上期 - 1；上期营收必须为正（否则增长率无定义）。"""
    _assert_finite(revenue, "revenueGrowth.revenue")
    _assert_finite(revenue_prior, "revenueGrowth.revenuePrior")
    if revenue_prior <= 0:
        raise ValueError("revenueGrowth: 上期营收必须为正，实际为 %r" % (revenue_prior,))
    return revenue / revenue_prior - 1


# ---------------------------------------------------------------------------
# TS 导出名别名（ta/index.ts 的函数名，便于从 TS 侧逐名对照）
# ---------------------------------------------------------------------------

williamsR = williams_r
trueRange = true_range
rollingStd = rolling_std
logReturns = log_returns
annualizedVol = annualized_vol
parkinsonVol = parkinson_vol
garmanKlassVol = garman_klass_vol
adLine = ad_line
turnoverProxy = turnover_proxy
volumeZscore = volume_zscore
parabolicSar = parabolic_sar
pivotPoints = pivot_points
linearRegression = linear_regression
ultimateOscillator = ultimate_oscillator
awesomeOscillator = awesome_oscillator
stochRsi = stoch_rsi
chaikinOscillator = chaikin_oscillator
forceIndex = force_index
easeOfMovement = ease_of_movement
massIndex = mass_index
ulcerIndex = ulcer_index
elderRay = elder_ray
rollingSum = rolling_sum
rollingCorr = rolling_corr
rankPct = rank_pct
idxMax = idx_max
idxMin = idx_min
linearResidual = linear_residual

# ---- @gitrader/ta-plus 导出名别名（packages/ta-plus/src/index.ts 的公开函数名） ----
simpleReturns = simple_returns
realizedVolatility = realized_volatility
downsideVolatility = downside_volatility
maxDrawdown = max_drawdown
atrPercent = atr_percent
amihudIlliquidity = amihud_illiquidity
avgDev = avg_dev
efficiencyRatio = efficiency_ratio
smaDistance = sma_distance
emaDistance = ema_distance
emaSlope = ema_slope
zScore = z_score
volumeRatio = volume_ratio
pricePosition = price_position
avgPrice = avg_price
medPrice = med_price
typPrice = typ_price
wclPrice = wcl_price
rollingMax = rolling_max
rollingMin = rolling_min
maxIndex = max_index
minIndex = min_index
midPoint = mid_point
midPrice = mid_price
plusDM = plus_dm
minusDM = minus_dm
plusDI = plus_di
minusDI = minus_di
aroonOsc = aroon_osc
stochF = stoch_f
linRegSlope = lin_reg_slope
linRegIntercept = lin_reg_intercept
linRegAngle = lin_reg_angle
adOsc = ad_osc
earningsYield = earnings_yield
bookToPrice = book_to_price
returnOnEquity = return_on_equity
debtToEquity = debt_to_equity
freeCashFlowYield = free_cash_flow_yield
revenueGrowth = revenue_growth
