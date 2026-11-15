# SPDX-License-Identifier: CPAL-1.0
"""ta-plus 并集指标测试（批 9 主题二）：每个指标两道检验。

① **与 TS 实现数值一致**：夹具由一次性脚本从 `packages/ta-plus/src/index.ts` 真跑出来
   （`node packages/engine-python/tests/fixtures/export-ts-taplus-fixtures.mjs`），
   输入与 `packages/ta-plus/test/fixtures-t1b.ts` 同一组死值；逐值比对，容差 1e-9。

② **独立参照值**：不用 Python 实现的结果反证 TS，也不用自算自证。参照来自
   - TA-Lib 的 `ta_*.c` 定义式 + 手算分数（注释里写出推导，数值以精确分数给出）；
   - QuantDinger v5.6.5（Apache-2.0）`factors/registry.py` / `market/technical_indicators.py` 的定义式；
   - CPython 标准库 `statistics`（`correlation` / `linear_regression` / `variance`）——与他人实现
     独立，用来交叉核对 `correl` / `beta` / `variance` 三个统计量。
   参照值全部复用在 `packages/ta-plus/test/*.test.ts` 里已标明来源的那批数字（CMO 的 68 就是
   TA-Lib 的回归值，批 8 用自算 57.89 反证 TS 的错误不再犯）。

跑法：`cd packages/engine-python && python -m unittest discover -s tests`
"""

from __future__ import annotations

import json
import math
import statistics
import sys
import unittest
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))  # packages/engine-python

from engine import indicators as ind  # noqa: E402

FIXTURE_PATH = _HERE.parent / "fixtures" / "ts-taplus.json"
TOLERANCE = 1e-9

if not FIXTURE_PATH.exists():  # pragma: no cover - 只在夹具缺失时触发
    raise SystemExit(
        "缺夹具 %s；先在仓库根跑 node packages/engine-python/tests/fixtures/export-ts-taplus-fixtures.mjs"
        % FIXTURE_PATH
    )

with FIXTURE_PATH.open("r", encoding="utf-8") as _fh:
    _DATA = json.load(_fh)

INPUTS = _DATA["inputs"]
CASES = _DATA["cases"]

BARS = INPUTS["bars"]
CLOSES = INPUTS["closes"]
VOLUMES = INPUTS["volumes"]
LEVEL_BARS = INPUTS["levelBars"]
RETURNS = INPUTS["returns"]

N = len(CLOSES)


def bar(o: float, h: float, l: float, c: float, v: float = 1000.0) -> dict:
    return {"o": o, "h": h, "l": l, "c": c, "v": v}


def flat_bars(count: int, o: float, h: float, l: float, c: float, v: float = 1.0) -> list:
    return [bar(o, h, l, c, v) for _ in range(count)]


# ta-plus 的公开导出（packages/ta-plus/src/index.ts）→ Python 名 + 夹具 case 名
TA_PLUS_EXPORTS = {
    "simpleReturns": ("simple_returns", ["simpleReturns"]),
    "realizedVolatility": ("realized_volatility", ["realizedVolatility", "realizedVolatilityRaw"]),
    "downsideVolatility": ("downside_volatility", ["downsideVolatility", "downsideVolatilityMar"]),
    "skewness": ("skewness", ["skewness", "skewnessPop"]),
    "kurtosis": ("kurtosis", ["kurtosis", "kurtosisPop"]),
    "maxDrawdown": ("max_drawdown", ["maxDrawdown"]),
    "atrPercent": ("atr_percent", ["atrPercent"]),
    "amihudIlliquidity": ("amihud_illiquidity", ["amihudIlliquidity"]),
    "avgDev": ("avg_dev", ["avgDev"]),
    "variance": ("variance", ["variance", "varianceDdof1"]),
    "bop": ("bop", ["bop"]),
    "adxr": ("adxr", ["adxr"]),
    "cmo": ("cmo", ["cmo"]),
    "tsi": ("tsi", ["tsi"]),
    "efficiencyRatio": ("efficiency_ratio", ["efficiencyRatio"]),
    "smaDistance": ("sma_distance", ["smaDistance"]),
    "emaDistance": ("ema_distance", ["emaDistance"]),
    "emaSlope": ("ema_slope", ["emaSlope"]),
    "zScore": ("z_score", ["zScore", "zScoreDdof0"]),
    "volumeRatio": ("volume_ratio", ["volumeRatio"]),
    "pricePosition": ("price_position", ["pricePosition"]),
    "avgPrice": ("avg_price", ["avgPrice"]),
    "medPrice": ("med_price", ["medPrice"]),
    "typPrice": ("typ_price", ["typPrice"]),
    "wclPrice": ("wcl_price", ["wclPrice"]),
    "rollingMax": ("rolling_max", ["rollingMax"]),
    "rollingMin": ("rolling_min", ["rollingMin"]),
    "maxIndex": ("max_index", ["maxIndex"]),
    "minIndex": ("min_index", ["minIndex"]),
    "midPoint": ("mid_point", ["midPoint"]),
    "midPrice": ("mid_price", ["midPrice"]),
    "trima": ("trima", ["trima4", "trima5"]),
    "t3": ("t3", ["t3"]),
    "plusDM": ("plus_dm", ["plusDM"]),
    "minusDM": ("minus_dm", ["minusDM"]),
    "plusDI": ("plus_di", ["plusDI"]),
    "minusDI": ("minus_di", ["minusDI"]),
    "dx": ("dx", ["dx"]),
    "aroonOsc": ("aroon_osc", ["aroonOsc"]),
    "stochF": ("stoch_f", ["stochF"]),
    "correl": ("correl", ["correl"]),
    "beta": ("beta", ["beta"]),
    "linRegSlope": ("lin_reg_slope", ["linRegSlope"]),
    "linRegIntercept": ("lin_reg_intercept", ["linRegIntercept"]),
    "linRegAngle": ("lin_reg_angle", ["linRegAngle"]),
    "tsf": ("tsf", ["tsf"]),
    "natr": ("natr", ["natr"]),
    "adOsc": ("ad_osc", ["adOsc"]),
    "levels": ("levels", ["levels"]),
    "earningsYield": ("earnings_yield", ["earningsYield"]),
    "bookToPrice": ("book_to_price", ["bookToPrice"]),
    "returnOnEquity": ("return_on_equity", ["returnOnEquity"]),
    "debtToEquity": ("debt_to_equity", ["debtToEquity"]),
    "freeCashFlowYield": ("free_cash_flow_yield", ["freeCashFlowYield"]),
    "revenueGrowth": ("revenue_growth", ["revenueGrowth"]),
}


class CompareMixin:
    """夹具比对：与 tests/test_indicators.py 同一套语义（None/数值/列表/字典）。"""

    def assert_same(self, actual: Any, expected: Any, path: str) -> None:
        if expected is None:
            self.assertIsNone(actual, "%s 应为 None，实际 %r" % (path, actual))
            return
        if isinstance(expected, bool):
            self.assertEqual(actual, expected, path)
            return
        if isinstance(expected, str):
            self.assertEqual(actual, expected, path)
            return
        if isinstance(expected, (int, float)):
            self.assertIsInstance(actual, (int, float), "%s 类型不同：%r" % (path, actual))
            self.assertAlmostEqual(
                float(actual),
                float(expected),
                delta=TOLERANCE,
                msg="%s 数值不同：py=%r ts=%r" % (path, actual, expected),
            )
            return
        if isinstance(expected, list):
            self.assertIsInstance(actual, (list, tuple), "%s 类型不同" % path)
            self.assertEqual(len(actual), len(expected), "%s 长度不同（必须与输入等长）" % path)
            for i, (a, e) in enumerate(zip(actual, expected)):
                self.assert_same(a, e, "%s[%d]" % (path, i))
            return
        if isinstance(expected, dict):
            self.assertIsInstance(actual, dict, "%s 类型不同" % path)
            self.assertEqual(sorted(actual.keys()), sorted(expected.keys()), "%s 键集合不同" % path)
            for key in expected:
                self.assert_same(actual[key], expected[key], "%s.%s" % (path, key))
            return
        self.fail("未知夹具类型：%s %r" % (path, expected))

    def compare(self, name: str, actual: Any) -> None:
        self.assertIn(name, CASES, "夹具里没有 case：%s" % name)
        self.assert_same(actual, CASES[name], name)


# ---------------------------------------------------------------------------
# ① 与 TS 数值一致（容差 1e-9）
# ---------------------------------------------------------------------------

class TaPlusFixtureTest(CompareMixin, unittest.TestCase):
    maxDiff = None

    # -- 覆盖与自检 -------------------------------------------------------
    def test_fixture_covers_every_export(self) -> None:
        """55 个 ta-plus 导出，每个都至少有一个夹具 case，且 case 表没有多余的键。"""
        self.assertEqual(len(TA_PLUS_EXPORTS), 55)
        declared = set()
        for _, (py_name, case_names) in TA_PLUS_EXPORTS.items():
            self.assertTrue(callable(getattr(ind, py_name, None)), "缺函数：%s" % py_name)
            for case_name in case_names:
                self.assertIn(case_name, CASES)
                declared.add(case_name)
        self.assertEqual(sorted(declared), sorted(CASES.keys()))

    def test_ts_plus_aliases_exist(self) -> None:
        """TS 原名（camelCase）在 Python 侧也有别名，便于从 TS 侧逐名对照。"""
        for ts_name in TA_PLUS_EXPORTS:
            self.assertTrue(callable(getattr(ind, ts_name, None)), "缺别名：%s" % ts_name)

    def test_engine_core_exports_still_covered(self) -> None:
        """并集的另一半：engine-core 的 64 个函数名一个不少（旧 58 不回归的护栏）。"""
        engine_core = [
            "sma", "ema", "wma", "macd", "cross", "rsi", "stochastic", "roc", "momentum",
            "williamsR", "cci", "trueRange", "atr", "rollingStd", "bollinger", "keltner",
            "donchian", "logReturns", "annualizedVol", "parkinsonVol", "garmanKlassVol",
            "obv", "vwap", "mfi", "cmf", "adLine", "turnoverProxy", "volumeZscore",
            "dema", "tema", "hma", "kama", "vwma", "alma", "zlema", "ichimoku",
            "parabolicSar", "supertrend", "pivotPoints", "linearRegression", "envelope",
            "trix", "ultimateOscillator", "awesomeOscillator", "ppo", "aroon", "dpo", "adx",
            "stochRsi", "chaikinOscillator", "forceIndex", "easeOfMovement", "massIndex",
            "ulcerIndex", "vortex", "choppiness", "kdj", "elderRay", "rollingSum",
            "rollingCorr", "rankPct", "idxMax", "idxMin", "linearResidual",
        ]
        self.assertEqual(len(engine_core), 64)
        for name in engine_core:
            self.assertTrue(callable(getattr(ind, name, None)), "缺 engine-core 指标：%s" % name)

    # -- 收益 / 风险 ------------------------------------------------------
    def test_simple_returns(self) -> None:
        self.compare("simpleReturns", ind.simple_returns(CLOSES))

    def test_realized_volatility(self) -> None:
        self.compare("realizedVolatility", ind.realized_volatility(RETURNS, 3))
        self.compare("realizedVolatilityRaw", ind.realized_volatility(RETURNS, 3, annualize=False))

    def test_downside_volatility(self) -> None:
        self.compare("downsideVolatility", ind.downside_volatility(RETURNS, 3))
        self.compare(
            "downsideVolatilityMar",
            ind.downside_volatility(RETURNS, 3, mar=0.01, annualize=False),
        )

    def test_skewness(self) -> None:
        self.compare("skewness", ind.skewness(CLOSES, 5))
        self.compare("skewnessPop", ind.skewness(CLOSES, 5, sample=False))

    def test_kurtosis(self) -> None:
        self.compare("kurtosis", ind.kurtosis(CLOSES, 5))
        self.compare("kurtosisPop", ind.kurtosis(CLOSES, 5, sample=False))

    def test_max_drawdown(self) -> None:
        self.compare("maxDrawdown", ind.max_drawdown(CLOSES, 5))

    def test_atr_percent(self) -> None:
        self.compare("atrPercent", ind.atr_percent(BARS, 3))

    def test_amihud_illiquidity(self) -> None:
        self.compare("amihudIlliquidity", ind.amihud_illiquidity(BARS, 3))

    # -- 统计 / 区间 ------------------------------------------------------
    def test_avg_dev(self) -> None:
        self.compare("avgDev", ind.avg_dev(CLOSES, 4))

    def test_variance(self) -> None:
        self.compare("variance", ind.variance(CLOSES, 4))
        self.compare("varianceDdof1", ind.variance(CLOSES, 4, ddof=1))

    def test_bop(self) -> None:
        self.compare("bop", ind.bop(BARS))

    def test_adxr(self) -> None:
        self.compare("adxr", ind.adxr(ind.adx(BARS, 3)["adx"], 3))

    # -- 动量 -------------------------------------------------------------
    def test_cmo(self) -> None:
        self.compare("cmo", ind.cmo(CLOSES, 3))

    def test_tsi(self) -> None:
        self.compare("tsi", ind.tsi(CLOSES, slow=3, fast=2))

    def test_efficiency_ratio(self) -> None:
        self.compare("efficiencyRatio", ind.efficiency_ratio(CLOSES, 3))

    def test_sma_distance(self) -> None:
        self.compare("smaDistance", ind.sma_distance(CLOSES, 3))

    def test_ema_distance(self) -> None:
        self.compare("emaDistance", ind.ema_distance(CLOSES, 3))

    def test_ema_slope(self) -> None:
        self.compare("emaSlope", ind.ema_slope(CLOSES, 3, 2))

    def test_z_score(self) -> None:
        self.compare("zScore", ind.z_score(CLOSES, 5))
        self.compare("zScoreDdof0", ind.z_score(CLOSES, 5, 0))

    # -- 流动性 -----------------------------------------------------------
    def test_volume_ratio(self) -> None:
        self.compare("volumeRatio", ind.volume_ratio(VOLUMES, 3))

    def test_price_position(self) -> None:
        self.compare("pricePosition", ind.price_position(BARS, 4))

    # -- 价格变换 ---------------------------------------------------------
    def test_price_transforms(self) -> None:
        self.compare("avgPrice", ind.avg_price(BARS))
        self.compare("medPrice", ind.med_price(BARS))
        self.compare("typPrice", ind.typ_price(BARS))
        self.compare("wclPrice", ind.wcl_price(BARS))

    # -- 窗口 -------------------------------------------------------------
    def test_window_extremes(self) -> None:
        self.compare("rollingMax", ind.rolling_max(CLOSES, 4))
        self.compare("rollingMin", ind.rolling_min(CLOSES, 4))
        self.compare("maxIndex", ind.max_index(CLOSES, 4))
        self.compare("minIndex", ind.min_index(CLOSES, 4))
        self.compare("midPoint", ind.mid_point(CLOSES, 4))
        self.compare("midPrice", ind.mid_price(BARS, 4))

    # -- 均线扩展 ---------------------------------------------------------
    def test_trima(self) -> None:
        self.compare("trima4", ind.trima(CLOSES, 4))
        self.compare("trima5", ind.trima(CLOSES, 5))

    def test_t3(self) -> None:
        self.compare("t3", ind.t3(CLOSES, 2))

    # -- 方向 -------------------------------------------------------------
    def test_directional(self) -> None:
        self.compare("plusDM", ind.plus_dm(BARS, 3))
        self.compare("minusDM", ind.minus_dm(BARS, 3))
        self.compare("plusDI", ind.plus_di(BARS, 3))
        self.compare("minusDI", ind.minus_di(BARS, 3))
        self.compare("dx", ind.dx(BARS, 3))

    # -- 振荡 -------------------------------------------------------------
    def test_aroon_osc(self) -> None:
        self.compare("aroonOsc", ind.aroon_osc(BARS, 3))

    def test_stoch_f(self) -> None:
        self.compare("stochF", ind.stoch_f(BARS, 3, 2))

    # -- 回归 -------------------------------------------------------------
    def test_regression(self) -> None:
        self.compare("linRegSlope", ind.lin_reg_slope(CLOSES, 4))
        self.compare("linRegIntercept", ind.lin_reg_intercept(CLOSES, 4))
        self.compare("linRegAngle", ind.lin_reg_angle(CLOSES, 4))
        self.compare("tsf", ind.tsf(CLOSES, 4))

    def test_correl_beta(self) -> None:
        self.compare("correl", ind.correl(CLOSES, VOLUMES, 4))
        self.compare("beta", ind.beta(CLOSES, VOLUMES, 4))

    # -- 波动 / 量能 ------------------------------------------------------
    def test_natr(self) -> None:
        self.compare("natr", ind.natr(BARS, 3))

    def test_ad_osc(self) -> None:
        self.compare("adOsc", ind.ad_osc(BARS, 2, 4))

    # -- 价位 / 基本面 ----------------------------------------------------
    def test_levels(self) -> None:
        self.compare("levels", ind.levels(LEVEL_BARS))

    def test_fundamental(self) -> None:
        self.compare("earningsYield", ind.earnings_yield(100, 2500))
        self.compare("bookToPrice", ind.book_to_price(500, 2500))
        self.compare("returnOnEquity", ind.return_on_equity(100, 400))
        self.compare("debtToEquity", ind.debt_to_equity(300, 400))
        self.compare("freeCashFlowYield", ind.free_cash_flow_yield(60, 2500))
        self.compare("revenueGrowth", ind.revenue_growth(110, 100))


# ---------------------------------------------------------------------------
# ② 独立参照值（手算分数 / TA-Lib 定义式 / CPython statistics）
# ---------------------------------------------------------------------------

class TaPlusReferenceTest(unittest.TestCase):
    """参照值来源逐条写在用例注释里；不来自 engine/indicators.py 的输出。"""

    def close_to(self, actual: float, expected: float, msg: str, delta: float = 1e-9) -> None:
        self.assertIsNotNone(actual, msg)
        self.assertAlmostEqual(float(actual), float(expected), delta=delta, msg=msg)

    # -- CMO：TA-Lib ta_CMO.c 定义 + 手算（批 8 CMO 教训的回归用例） ---------
    def test_cmo_talib_hand_computed(self) -> None:
        """[10,11,10,12,12,13] period=3 → 50, 50, 68（TA-Lib 口径的回归值；自算 57.89 是错的）。"""
        # 种子 d1..d3 = +1,−1,+2：gain = 3/3 = 1，loss = 1/3
        #   → 100·(1−1/3)/(1+1/3) = 50
        # i=4，d=0：gain = (1·2+0)/3 = 2/3，loss = (1/3·2)/3 = 2/9 → 100·(4/9)/(8/9) = 50
        # i=5，d=+1：gain = (2/3·2+1)/3 = 7/9，loss = (2/9·2)/3 = 4/27
        #   → 100·(17/27)/(25/27) = 68
        out = ind.cmo([10, 11, 10, 12, 12, 13], 3)
        self.assertEqual(out[:3], [None, None, None])
        self.close_to(out[3], 50.0, "cmo[3]")
        self.close_to(out[4], 50.0, "cmo[4]")
        self.close_to(out[5], 68.0, "cmo[5]")

    def test_cmo_boundaries(self) -> None:
        """定义边界：连续涨 +100、连续跌 -100、完全无变动 0（TA-Lib 输出 0）。"""
        self.close_to(ind.cmo([1, 2, 3, 4, 5, 6], 3)[5], 100.0, "cmo 单调涨")
        self.close_to(ind.cmo([6, 5, 4, 3, 2, 1], 3)[5], -100.0, "cmo 单调跌")
        self.close_to(ind.cmo([8, 8, 8, 8, 8], 3)[4], 0.0, "cmo 无变动")

    # -- TSI：Blau 定义，手算分数 -----------------------------------------
    def test_tsi_hand_computed(self) -> None:
        """[10,11,12,11,10] slow=2 fast=2 → −1100/27（一级 EMA e1=[1,−1/3,−7/9]，二级 −11/27）。"""
        out = ind.tsi([10, 11, 12, 11, 10], slow=2, fast=2)
        self.close_to(out[4], -1100 / 27, "tsi[4]")
        monotonic = ind.tsi([10, 11, 12, 13, 14], slow=2, fast=2)
        self.close_to(monotonic[3], 100.0, "tsi 单调涨[3]")
        self.close_to(monotonic[4], 100.0, "tsi 单调涨[4]")

    # -- 波动 / 风险 ------------------------------------------------------
    def test_realized_volatility_hand_computed(self) -> None:
        """r = [+1%,−1%,+1%,−1%]：样本方差 = 4e−4/3 → s = 0.011547005383792516，×√252 = 0.18330302779823363。"""
        returns = [0.01, -0.01, 0.01, -0.01]
        self.close_to(
            ind.realized_volatility(returns, 4, annualize=False)[3],
            0.011547005383792516,
            "realizedVolatility raw",
        )
        self.close_to(
            ind.realized_volatility(returns, 4)[3], 0.18330302779823363, "realizedVolatility 年化"
        )
        # 交叉核对：CPython statistics.stdev（独立实现）同样是 ddof=1
        self.close_to(
            ind.realized_volatility(returns, 4, annualize=False)[3],
            statistics.stdev(returns),
            "realizedVolatility vs statistics.stdev",
        )

    def test_downside_volatility_hand_computed(self) -> None:
        """r = [+2%,−1%,+3%,−2%]：负偏差平方和 5e−4 ÷ 整窗 4 = 1.25e−4 → 0.011180339887498949。

        mar=1% 时偏差是 −2% 与 −3%：平方和 1.3e−3 ÷ 4 = 3.25e−4 → 0.018027756377319945。
        """
        returns = [0.02, -0.01, 0.03, -0.02]
        self.close_to(
            ind.downside_volatility(returns, 4, annualize=False)[3],
            0.011180339887498949,
            "downsideVolatility raw",
        )
        self.close_to(
            ind.downside_volatility(returns, 4)[3], 0.1774823934929885, "downsideVolatility 年化"
        )
        self.close_to(
            ind.downside_volatility(returns, 4, mar=0.01, annualize=False)[3],
            0.018027756377319945,
            "downsideVolatility mar=1%",
        )

    def test_skewness_hand_computed(self) -> None:
        """[1,2,3,4,10]：样本偏度 = 1.2√2 = 1.697056274847714；总体 g1 = 36/(10√10) = 1.1384199576606167。"""
        self.close_to(ind.skewness([1, 2, 3, 4, 5], 5)[4], 0.0, "偏度 对称样本")
        self.close_to(ind.skewness([1, 2, 3, 4, 10], 5)[4], 1.697056274847714, "样本偏度")
        self.close_to(
            ind.skewness([1, 2, 3, 4, 10], 5, sample=False)[4],
            1.1384199576606167,
            "总体偏度",
        )
        self.close_to(ind.skewness([7, 7, 7, 7], 4)[3], 0.0, "零方差中性值")

    def test_kurtosis_hand_computed(self) -> None:
        """[1..5]：总体 m4/m2²−3 = 6.8/4−3 = −1.3；样本（Excel KURT）= 1.25·5.44−8 = −1.2。"""
        self.close_to(ind.kurtosis([1, 2, 3, 4, 5], 5, sample=False)[4], -1.3, "总体超额峰度")
        self.close_to(ind.kurtosis([1, 2, 3, 4, 5], 5)[4], -1.2, "样本超额峰度")
        self.assertIsNone(ind.kurtosis([1, 2, 3], 3)[2], "样本口径需 n≥4")
        self.close_to(ind.kurtosis([5, 5, 5, 5], 4)[3], 0.0, "零方差中性值")

    def test_max_drawdown_hand_computed(self) -> None:
        """[100,120,90,110]：峰 120 → 谷 90 → 90/120−1 = −0.25。"""
        self.close_to(ind.max_drawdown([100, 120, 90, 110], 4)[3], -0.25, "最大回撤")
        self.close_to(ind.max_drawdown([10, 11, 12, 13], 4)[3], 0.0, "单调上升无回撤")

    def test_atr_percent_hand_computed(self) -> None:
        """全等 bar（TR=2、close=10）→ ATR(3)=2 → atr/close = 0.2；close=0 处 None。"""
        out = ind.atr_percent(flat_bars(5, 10, 11, 9, 10, 100), 3)
        self.close_to(out[2], 0.2, "atrPercent[2]")
        self.close_to(out[4], 0.2, "atrPercent[4]")
        self.assertIsNone(ind.atr_percent([bar(10, 11, 9, 10), bar(0, 1, -1, 0)], 2)[1])

    def test_amihud_hand_computed(self) -> None:
        """closes [100,110,99] v=1000：0.1/1.1e5 与 0.1/9.9e4 的均值 = 9.595959595959598e−7。"""
        bars = [bar(100, 101, 99, 100), bar(110, 111, 109, 110), bar(99, 100, 98, 99)]
        out = ind.amihud_illiquidity(bars, 2)
        self.assertIsNone(out[1], "首个可算位置是下标 period")
        self.close_to(out[2], 9.595959595959598e-07, "amihud[2]")
        zero = [bar(100, 101, 99, 100, 0), bar(101, 102, 100, 101, 0), bar(102, 103, 101, 102, 0)]
        self.assertIsNone(ind.amihud_illiquidity(zero, 2)[2], "成交额为 0 全不计入")

    # -- 统计 -------------------------------------------------------------
    def test_avg_dev_hand_computed(self) -> None:
        """[1..5] 均值 3，偏差 2,1,0,1,2 → 6/5 = 1.2（TA-Lib TA_AVGDEV 除以 period）。"""
        self.close_to(ind.avg_dev([1, 2, 3, 4, 5], 5)[4], 1.2, "avgDev")
        self.close_to(ind.avg_dev([2, 4], 2)[1], 1.0, "avgDev [2,4]")

    def test_variance_hand_computed(self) -> None:
        """[1..5]：总体 10/5 = 2、样本 10/4 = 2.5（教科书值），并与独立复算交叉核对。"""
        self.close_to(ind.variance([1, 2, 3, 4, 5], 5)[4], 2.0, "总体方差")
        self.close_to(ind.variance([1, 2, 3, 4, 5], 5, 1)[4], 2.5, "样本方差")
        # 独立复算：statistics.fmean 求均值，再手写离差平方和（不走 indicators 的循环）
        window = CLOSES[:4]
        mean = statistics.fmean(window)
        expected = sum((v - mean) ** 2 for v in window) / 4
        self.close_to(ind.variance(CLOSES, 4)[3], expected, "variance vs 独立均值/离差复算")

    def test_bop_hand_computed(self) -> None:
        """{o:10,h:12,l:8,c:11} → 1/4 = 0.25；区间为 0 → 0（TA-Lib ta_BOP.c）。"""
        self.close_to(ind.bop([bar(10, 12, 8, 11)])[0], 0.25, "bop")
        self.close_to(ind.bop([bar(8, 9, 9, 8)])[0], 0.0, "bop 零区间")
        out = ind.bop([bar(10, 12, 8, 11), bar(10, 12, 8, 8), bar(10, 12, 8, 10)])
        self.close_to(out[1], -0.5, "bop 收在最低")
        self.close_to(out[2], 0.0, "bop 收在中点")

    def test_adxr_hand_computed(self) -> None:
        """ADX 序列 [None,10,20,30,40] period=3：滞后 2 位 → out[3]=20、out[4]=30。"""
        out = ind.adxr([None, 10, 20, 30, 40], 3)
        self.assertIsNone(out[2])
        self.close_to(out[3], 20.0, "adxr[3]")
        self.close_to(out[4], 30.0, "adxr[4]")
        self.assertEqual(ind.adxr([1, 2, 3], 1), [1, 2, 3], "period=1 退化为原序列")

    # -- 动量 -------------------------------------------------------------
    def test_efficiency_ratio_hand_computed(self) -> None:
        """[10,13,11] period=2：净变动 1、路径 3+2=5 → 0.2；单调涨 → 1；回原点 → 0。"""
        self.close_to(ind.efficiency_ratio([10, 13, 11], 2)[2], 0.2, "ER")
        self.close_to(ind.efficiency_ratio([10, 11, 12], 2)[2], 1.0, "ER 单调")
        self.close_to(ind.efficiency_ratio([10, 11, 10], 2)[2], 0.0, "ER 回原点")

    def test_ma_distances_hand_computed(self) -> None:
        """SMA([1..5],3) = 4 → 5/4−1 = 0.25；EMA(3) 种子 2、k=0.5 → e4 = 4 → 0.25。"""
        self.close_to(ind.sma_distance([1, 2, 3, 4, 5], 3)[4], 0.25, "smaDistance")
        self.close_to(ind.ema_distance([1, 2, 3, 4, 5], 3)[4], 0.25, "emaDistance")
        self.close_to(ind.sma_distance([5, 5, 5], 2)[2], 0.0, "价格等于均值")

    def test_ema_slope_hand_computed(self) -> None:
        """EMA(3) on [10,12,14,16,18]：种子 12、k=0.5 → e3=14、e4=16 → 1/7 与 1/3。"""
        self.close_to(ind.ema_slope([10, 12, 14, 16, 18], 3, 1)[4], 1 / 7, "emaSlope 1 期")
        self.close_to(ind.ema_slope([10, 12, 14, 16, 18], 3, 2)[4], 1 / 3, "emaSlope 2 期")
        self.assertIsNone(ind.ema_slope([10, 12, 14, 16, 18], 3, 2)[3], "回看基准未可算")

    def test_z_score_hand_computed(self) -> None:
        """[1..5] period=5：样本方差 2.5 → 2/√2.5 = 1.2649110640673518；ddof=0 → 2/√2。"""
        self.close_to(ind.z_score([1, 2, 3, 4, 5], 5)[4], 1.2649110640673518, "zScore ddof=1")
        self.close_to(ind.z_score([1, 2, 3, 4, 5], 5, 0)[4], 1.4142135623730951, "zScore ddof=0")
        self.close_to(ind.z_score([9, 9, 9], 3)[2], 0.0, "零方差中性值")

    # -- 流动性 -----------------------------------------------------------
    def test_volume_ratio_hand_computed(self) -> None:
        """[10,10,20] period=2：基线 (10+10)/2 = 10 → 2.0；[5,15,15] → 15/10 = 1.5（基线不含当根）。"""
        out = ind.volume_ratio([10, 10, 20], 2)
        self.assertEqual(out[:2], [None, None])
        self.close_to(out[2], 2.0, "volumeRatio")
        self.close_to(ind.volume_ratio([5, 15, 15], 2)[2], 1.5, "基线不含当根")
        self.assertIsNone(ind.volume_ratio([0, 0, 5], 2)[2], "基线为 0")

    def test_price_position_hand_computed(self) -> None:
        """h=[10,12,14]、l=[8,9,10]、c=13 → (13−8)/(14−8)×100 = 83.333…。"""
        bars = [bar(9, 10, 8, 9), bar(11, 12, 9, 11), bar(13, 14, 10, 13)]
        self.close_to(ind.price_position(bars, 3)[2], 83.33333333333333, "pricePosition")
        self.close_to(ind.price_position(flat_bars(3, 7, 7, 7, 7), 3)[2], 50.0, "零区间 50")

    # -- 价格变换（TA-Lib 定义式手算） ------------------------------------
    def test_price_transforms_hand_computed(self) -> None:
        """BARS 第 0/4/9 根：avg/med = 100、103.5、106.5；typ i=9 = 320/3；wcl i=9 = 427/4。"""
        for fn in (ind.avg_price, ind.med_price):
            out = fn(BARS)
            self.close_to(out[0], 100.0, "%s[0]" % fn.__name__)
            self.close_to(out[4], 103.5, "%s[4]" % fn.__name__)
            self.close_to(out[9], 106.5, "%s[9]" % fn.__name__)
        self.close_to(ind.typ_price(BARS)[9], 320 / 3, "typPrice[9]")
        self.close_to(ind.wcl_price(BARS)[9], 427 / 4, "wclPrice[9]")
        self.close_to(ind.wcl_price(BARS)[4], 415 / 4, "wclPrice[4]")
        flat = flat_bars(6, 7, 9, 5, 8)
        self.assertEqual(ind.avg_price(flat), [7.25] * 6)
        self.assertEqual(ind.med_price(flat), [7.0] * 6)
        self.assertEqual(ind.wcl_price(flat), [7.5] * 6)
        for value in ind.typ_price(flat):
            self.close_to(value, 22 / 3, "typPrice 常数")

    # -- 窗口（TA-Lib MAX/MIN/MAXINDEX/MININDEX/MIDPOINT/MIDPRICE 手算） -----
    def test_window_hand_computed(self) -> None:
        """period=4：maxIdx[3]=2、minIdx[4]=3（并列取最新）、midPoint[3]=101.5、midPrice[3]=101.5。"""
        self.assertEqual(ind.rolling_max(CLOSES, 4)[:3], [None, None, None])
        self.close_to(ind.rolling_max(CLOSES, 4)[3], 103.0, "rollingMax[3]")
        self.close_to(ind.rolling_max(CLOSES, 4)[9], 107.0, "rollingMax[9]")
        self.close_to(ind.rolling_min(CLOSES, 4)[3], 100.0, "rollingMin[3]")
        self.close_to(ind.max_index(CLOSES, 4)[3], 2, "maxIndex[3] 返回下标")
        self.close_to(ind.min_index(CLOSES, 4)[4], 3, "minIndex[4] 并列取最新")
        self.close_to(ind.mid_point(CLOSES, 4)[3], 101.5, "midPoint[3]")
        self.close_to(ind.mid_price(BARS, 4)[4], 102.5, "midPrice[4]")
        self.assertEqual(ind.rolling_max([1, 2], 5), [None, None], "输入短于 period 全 None")

    # -- 均线扩展 ---------------------------------------------------------
    def test_trima_hand_computed(self) -> None:
        """trima(4)：SMA2 → [101,102.5,102.5]，再 SMA3 → 102（i=3）；常数序列还原常数。"""
        self.close_to(ind.trima(CLOSES, 4)[3], 102.0, "trima4[3]")
        self.assertEqual(ind.trima(CLOSES, 5)[:4], [None, None, None, None])
        for period in (3, 4):
            for value in ind.trima([5.0] * 8, period)[period - 1 :]:
                self.close_to(value, 5.0, "trima 权重和为 1")

    def test_t3_definition_boundaries(self) -> None:
        """T3：c1..c4 之和为 1（TA-T3.c 定义）→ 常数序列还原常数；period=1 时各级 EMA 退化为原值。"""
        for value in ind.t3([42.0] * 20, 2)[6:]:
            self.close_to(value, 42.0, "t3 常数", 1e-9)
        # period=1：k = 2/2 = 1 → EMA 等于输入，级联后 c1..c4 之和为 1 → 输出等于输入
        series = [3.0, 1.0, 4.0, 1.0, 5.0, 9.0]
        for i, value in enumerate(ind.t3(series, 1)):
            self.close_to(value, series[i], "t3 period=1[%d]" % i)
        self.assertEqual(ind.t3(series, 2)[:6], [None] * 6, "预热期 6×(period−1)")

    def test_t3_nonconstant_independent(self) -> None:
        """T3 非常数输入的下标 6..9 参照值（独立重算，不用本仓实现自证）。

        来源：ta_T3.c 定义（六级 EMA，种子为前 period 个值的简单平均，c1..c4 由 vFactor=0.7
        算出）独立重算：批 8 收口用 Python Fraction 重算、批 9 收口另写一份浮点实现复核，
        两者一致；不来自 engine/indicators.py 或 TS 的输出。
        """
        out = ind.t3(CLOSES, 2)
        self.assertEqual(out[:6], [None] * 6, "t3 period=2 预热期")
        expected = [
            104.284288777117,
            105.415011261833,
            104.837781413177,
            105.94914361519,
        ]
        for i, value in enumerate(expected):
            self.close_to(out[6 + i], value, "t3(2)[%d]" % (6 + i), delta=1e-9)

    # -- 方向 -------------------------------------------------------------
    def test_directional_wilder_hand_computed(self) -> None:
        """period=3：+DM 种子 3（+DM[1..3] = 2,1,0）、−DM 种子 1、TR 种子 9。

        → +DI[3] = 100×3/9 = 33.33…、−DI[3] = 100×1/9 = 11.11…、DX[3] = 50。
        （TA-Lib 的 +DI 种子口径不同：period=3 时 TA-Lib 给 200/7 = 28.571…，那边首值在下标 period−1；
          本包与 engine-core 一致，首值在下标 period。）
        """
        plus = ind.plus_dm(BARS, 3)
        minus = ind.minus_dm(BARS, 3)
        self.assertEqual(plus[:3], [None, None, None])
        self.close_to(plus[3], 3.0, "+DM 种子")
        self.close_to(plus[4], 3 - 1 + 2, "+DM 递推")
        self.close_to(minus[3], 1.0, "-DM 种子")
        self.close_to(ind.plus_di(BARS, 3)[3], 100 / 3, "+DI[3]")
        self.close_to(ind.minus_di(BARS, 3)[3], 100 / 9, "-DI[3]")
        self.close_to(ind.dx(BARS, 3)[3], 50.0, "DX[3]")
        # 单边行情：+DI = 100 / −DI = 0 / DX = 100
        rising = [bar(100 + i, 101 + i, 100 + i, 101 + i) for i in range(8)]
        self.close_to(ind.plus_di(rising, 3)[7], 100.0, "+DI 单边涨")
        self.close_to(ind.minus_di(rising, 3)[7], 0.0, "-DI 单边涨")
        self.close_to(ind.dx(rising, 3)[7], 100.0, "DX 单边涨")

    # -- 振荡 -------------------------------------------------------------
    def test_stoch_f_hand_computed(self) -> None:
        """kPeriod=3：i=2 窗 H 最大 104、L 最小 99、c=103 → 100×4/5 = 80；Fast-D(2) = (80+50)/2 = 65。"""
        out = ind.stoch_f(BARS, 3, 2)
        self.assertEqual(out["k"][:2], [None, None])
        self.close_to(out["k"][2], 80.0, "stochF.k[2]")
        self.close_to(out["k"][3], 50.0, "stochF.k[3]")
        self.close_to(out["d"][3], 65.0, "stochF.d[3]")
        flat = ind.stoch_f(flat_bars(5, 10, 10, 10, 10), 3, 2)
        self.assertEqual(flat["k"], [None, None, 0.0, 0.0, 0.0], "区间为 0 时 K=0（不产生 NaN）")

    def test_aroon_osc_hand_computed(self) -> None:
        """period=3：i=3 窗 H 最高 104@2（距 1 根 → Up=66.67）、L 最低 99@0（距 3 根 → Down=0）→ 200/3。"""
        out = ind.aroon_osc(BARS, 3)
        self.assertEqual(out[:3], [None, None, None])
        self.close_to(out[3], 200 / 3, "aroonOsc[3]")
        rising = [bar(10 + i, 11 + i, 10 + i, 10.5 + i) for i in range(6)]
        self.close_to(ind.aroon_osc(rising, 3)[5], 100.0, "aroonOsc 极值在当根")

    # -- 回归 -------------------------------------------------------------
    def test_regression_hand_computed(self) -> None:
        """窗 [100,102,103,102]：slope = 3.5/5 = 0.7、intercept = 100.7、angle = atan(0.7)、TSF = 103.5。"""
        self.close_to(ind.lin_reg_slope(CLOSES, 4)[3], 0.7, "linRegSlope")
        self.close_to(ind.lin_reg_intercept(CLOSES, 4)[3], 100.7, "linRegIntercept")
        self.close_to(
            ind.lin_reg_angle(CLOSES, 4)[3], math.degrees(math.atan(0.7)), "linRegAngle"
        )
        self.close_to(ind.tsf(CLOSES, 4)[3], 103.5, "tsf")
        # 线性序列 y = 2x + 3：斜率 2、截距 = 窗口左端值、TSF = 下一根值
        y = [2 * i + 3 for i in range(8)]
        self.close_to(ind.lin_reg_slope(y, 4)[7], 2.0, "线性序列斜率")
        self.close_to(ind.lin_reg_intercept(y, 4)[7], y[4], "截距是窗口左端")
        self.close_to(ind.tsf(y, 4)[7], 2 * 8 + 3, "TSF 是下一根")

    def test_correl_beta_hand_and_stdlib(self) -> None:
        """correl/beta 用 CPython `statistics.correlation` / `linear_regression` 独立交叉核对。"""
        window = CLOSES[:4]
        volume_window = VOLUMES[:4]
        self.close_to(
            ind.correl(CLOSES, VOLUMES, 4)[3],
            statistics.correlation(window, volume_window),
            "correl vs statistics.correlation",
        )
        self.close_to(
            ind.beta(CLOSES, VOLUMES, 4)[3],
            statistics.linear_regression(volume_window, window).slope,
            "beta vs statistics.linear_regression.slope",
        )
        # 定义边界：与自身相关 1、与取负相关 −1；基准方差为 0 → None
        negated = [-v for v in CLOSES]
        self.close_to(ind.correl(CLOSES, CLOSES, 4)[9], 1.0, "correl 自相关")
        self.close_to(ind.correl(CLOSES, negated, 4)[9], -1.0, "correl 取负")
        flat = [10.0] * 6
        self.assertEqual(ind.correl(flat, VOLUMES[:6], 4)[3:], [None, None, None])
        self.assertEqual(ind.beta(flat, flat, 4)[3:], [None, None, None])

    # -- 波动 / 量能 ------------------------------------------------------
    def test_natr_hand_computed(self) -> None:
        """period=3：TR = 2,3,3 → ATR = 8/3 → 100×(8/3)/103 = 2.588996763754（下标 2）。"""
        out = ind.natr(BARS, 3)
        self.assertEqual(out[:2], [None, None])
        self.close_to(out[2], (100 * (8 / 3)) / 103, "natr[2]")
        self.close_to(out[2], 2.588996763754, "natr[2] 参照小数", 1e-12)
        self.assertEqual(ind.natr(flat_bars(6, 5, 5, 5, 5), 3)[2:], [0.0, 0.0, 0.0, 0.0])
        self.assertEqual(
            ind.natr(flat_bars(6, 0, 1, 0, 0), 3)[2:], [None, None, None, None], "close=0 → None"
        )

    def test_ad_osc_hand_computed(self) -> None:
        """A/D = 0,400,700,1200…；fast=2/slow=4：i=3 → 985.19−705.6 = 279.585185185185。"""
        out = ind.ad_osc(BARS, 2, 4)
        self.assertEqual(out[:3], [None, None, None])
        self.close_to(out[3], 279.585185185185, "adOsc[3]", 1e-12)
        swapped = ind.ad_osc(BARS, 4, 2)
        for i in range(3, len(BARS)):
            self.close_to(swapped[i], -out[i], "adOsc fast/slow 互换取负")
        flat = ind.ad_osc(flat_bars(8, 3, 3, 3, 3, 900), 2, 4)
        self.assertEqual(flat[3:], [0.0] * 5, "区间为 0 的 bar 不计入 A/D")

    # -- 价位 / 基本面 ----------------------------------------------------
    def test_levels_hand_computed(self) -> None:
        """21 根夹具：pivot 105、r1 106、s1 104、r2 107、s2 103；swing 107/99；support 100.762884361579。"""
        out = ind.levels(LEVEL_BARS)
        self.close_to(out["pivot"], 105.0, "pivot")
        self.close_to(out["r1"], 106.0, "r1")
        self.close_to(out["s1"], 104.0, "s1")
        self.close_to(out["r2"], 107.0, "r2")
        self.close_to(out["s2"], 103.0, "s2")
        self.close_to(out["swingHigh"], 107.0, "swingHigh")
        self.close_to(out["swingLow"], 99.0, "swingLow")
        self.close_to(out["support"], 100.762884361579, "support", 1e-9)
        self.close_to(out["resistance"], 106.670448971754, "resistance", 1e-9)
        self.assertEqual(out["method"], "pivot_swing_bb_avg")
        self.assertIs(out["isEstimate"], True)

    def test_fundamental_hand_computed(self) -> None:
        """定义 + 可心算的整数：100/2500 = 0.04、500/2500 = 0.2、100/400 = 0.25、300/400 = 0.75。"""
        self.close_to(ind.earnings_yield(100, 2500), 0.04, "earningsYield", 1e-12)
        self.close_to(ind.book_to_price(500, 2500), 0.2, "bookToPrice", 1e-12)
        self.close_to(ind.return_on_equity(100, 400), 0.25, "returnOnEquity", 1e-12)
        self.close_to(ind.return_on_equity(-100, 400), -0.25, "ROE 负值仍按定义")
        self.close_to(ind.debt_to_equity(300, 400), 0.75, "debtToEquity", 1e-12)
        self.close_to(ind.free_cash_flow_yield(60, 2500), 0.024, "freeCashFlowYield", 1e-12)
        self.close_to(ind.revenue_growth(110, 100), 0.1, "revenueGrowth +10%", 1e-12)
        self.close_to(ind.revenue_growth(90, 100), -0.1, "revenueGrowth −10%", 1e-12)

    # -- 简单收益率 -------------------------------------------------------
    def test_simple_returns_hand_computed(self) -> None:
        """[100,110,99] → [None, 0.1, −0.1]；基数为 0 处 None。"""
        out = ind.simple_returns([100.0, 110.0, 99.0])
        self.assertIsNone(out[0])
        self.close_to(out[1], 0.1, "simpleReturns[1]")
        self.close_to(out[2], -0.1, "simpleReturns[2]")
        self.assertIsNone(ind.simple_returns([0.0, 1.0])[1], "基数为 0")


# ---------------------------------------------------------------------------
# 非法参数：与 ta-plus 一致（一律抛 ValueError，不返回全 None、不返回 NaN）
# ---------------------------------------------------------------------------

INVALID_PERIODS = [0, -1, 2.5, float("nan"), float("inf")]


class TaPlusPeriodErrorTest(unittest.TestCase):
    """ta-plus 的 period-errors.test.ts 的 Python 对应物，函数表逐项对齐。"""

    def test_period_functions_reject_invalid(self) -> None:
        cases = {
            "realized_volatility": lambda p: ind.realized_volatility(RETURNS, p),
            "downside_volatility": lambda p: ind.downside_volatility(RETURNS, p),
            "skewness": lambda p: ind.skewness(CLOSES, p),
            "kurtosis": lambda p: ind.kurtosis(CLOSES, p),
            "max_drawdown": lambda p: ind.max_drawdown(CLOSES, p),
            "atr_percent": lambda p: ind.atr_percent(BARS, p),
            "amihud_illiquidity": lambda p: ind.amihud_illiquidity(BARS, p),
            "avg_dev": lambda p: ind.avg_dev(CLOSES, p),
            "variance": lambda p: ind.variance(CLOSES, p),
            "adxr": lambda p: ind.adxr([1.0, 2.0, 3.0], p),
            "cmo": lambda p: ind.cmo(CLOSES, p),
            "efficiency_ratio": lambda p: ind.efficiency_ratio(CLOSES, p),
            "sma_distance": lambda p: ind.sma_distance(CLOSES, p),
            "ema_distance": lambda p: ind.ema_distance(CLOSES, p),
            "ema_slope": lambda p: ind.ema_slope(CLOSES, p),
            "z_score": lambda p: ind.z_score(CLOSES, p),
            "volume_ratio": lambda p: ind.volume_ratio(VOLUMES, p),
            "price_position": lambda p: ind.price_position(BARS, p),
            "rolling_max": lambda p: ind.rolling_max(CLOSES, p),
            "rolling_min": lambda p: ind.rolling_min(CLOSES, p),
            "max_index": lambda p: ind.max_index(CLOSES, p),
            "min_index": lambda p: ind.min_index(CLOSES, p),
            "mid_point": lambda p: ind.mid_point(CLOSES, p),
            "mid_price": lambda p: ind.mid_price(BARS, p),
            "trima": lambda p: ind.trima(CLOSES, p),
            "t3": lambda p: ind.t3(CLOSES, p),
            "plus_dm": lambda p: ind.plus_dm(BARS, p),
            "minus_dm": lambda p: ind.minus_dm(BARS, p),
            "plus_di": lambda p: ind.plus_di(BARS, p),
            "minus_di": lambda p: ind.minus_di(BARS, p),
            "dx": lambda p: ind.dx(BARS, p),
            "aroon_osc": lambda p: ind.aroon_osc(BARS, p),
            "correl": lambda p: ind.correl(CLOSES, VOLUMES, p),
            "beta": lambda p: ind.beta(CLOSES, VOLUMES, p),
            "lin_reg_slope": lambda p: ind.lin_reg_slope(CLOSES, p),
            "lin_reg_intercept": lambda p: ind.lin_reg_intercept(CLOSES, p),
            "lin_reg_angle": lambda p: ind.lin_reg_angle(CLOSES, p),
            "tsf": lambda p: ind.tsf(CLOSES, p),
            "natr": lambda p: ind.natr(BARS, p),
            "ad_osc": lambda p: ind.ad_osc(BARS, p, 4),
            "levels": lambda p: ind.levels(LEVEL_BARS, period=p),
        }
        for name, run in cases.items():
            for period in INVALID_PERIODS:
                with self.subTest(function=name, period=period):
                    with self.assertRaises(ValueError):
                        run(period)

    def test_multi_period_functions(self) -> None:
        """多周期参数：tsi(slow/fast)、t3(vFactor)、stoch_f(k/d)、ad_osc(fast/slow)。"""
        for period in INVALID_PERIODS:
            with self.assertRaises(ValueError):
                ind.tsi(CLOSES, slow=period, fast=2)
            with self.assertRaises(ValueError):
                ind.tsi(CLOSES, slow=3, fast=period)
            with self.assertRaises(ValueError):
                ind.stoch_f(BARS, period, 2)
            with self.assertRaises(ValueError):
                ind.stoch_f(BARS, 3, period)
            with self.assertRaises(ValueError):
                ind.ad_osc(BARS, period, 4)
            with self.assertRaises(ValueError):
                ind.ad_osc(BARS, 2, period)
            with self.assertRaises(ValueError):
                ind.ema_slope(CLOSES, 3, period)
        with self.assertRaises(ValueError):
            ind.t3(CLOSES, 2, float("nan"))
        with self.assertRaises(ValueError):
            ind.levels(LEVEL_BARS, multiplier=0)
        with self.assertRaises(ValueError):
            ind.levels(LEVEL_BARS, multiplier=-1)
        with self.assertRaises(ValueError):
            ind.levels(LEVEL_BARS[:20], period=20)

    def test_ddof_and_length_guards(self) -> None:
        """ddof 非法 / period <= ddof / 两序列不等长 / 回归 period < 2 一律抛错。"""
        with self.assertRaises(ValueError):
            ind.variance(CLOSES, 2, ddof=2)
        with self.assertRaises(ValueError):
            ind.variance(CLOSES, 4, ddof=-1)
        with self.assertRaises(ValueError):
            ind.z_score(CLOSES, 5, ddof=5)
        with self.assertRaises(ValueError):
            ind.realized_volatility(RETURNS, 3, ddof=3)
        with self.assertRaises(ValueError):
            ind.correl(CLOSES, VOLUMES[:5], 3)
        with self.assertRaises(ValueError):
            ind.beta(CLOSES, VOLUMES[:5], 3)
        with self.assertRaises(ValueError):
            ind.lin_reg_slope(CLOSES, 1)
        with self.assertRaises(ValueError):
            ind.tsf(CLOSES, 1)
        with self.assertRaises(ValueError):
            ind.earnings_yield(100, 0)
        with self.assertRaises(ValueError):
            ind.revenue_growth(100, -50)
        with self.assertRaises(ValueError):
            ind.earnings_yield(float("nan"), 2500)
        with self.assertRaises(ValueError):
            ind.book_to_price(500, float("inf"))

    def test_non_finite_series_rejected(self) -> None:
        """脏数据（NaN）静默扩散是 CMO 类错误的近亲：这里一律抛错。"""
        for fn in (
            lambda: ind.skewness([1.0, float("nan")], 2),
            lambda: ind.kurtosis([1.0, float("nan")], 2),
            lambda: ind.max_drawdown([1.0, float("nan")], 2),
            lambda: ind.realized_volatility([0.01, float("nan")], 2),
            lambda: ind.downside_volatility([0.01, float("nan")], 2),
        ):
            with self.assertRaises(ValueError):
                fn()


# ---------------------------------------------------------------------------
# 约定：输出等长、因果、不改输入、无 NaN
# ---------------------------------------------------------------------------

class TaPlusConventionTest(unittest.TestCase):
    """与 ta-plus 的 conventions 测试同四条约定，全部在 40 点输入上跑。"""

    def setUp(self) -> None:
        state = 4242
        values = []
        for _ in range(40):
            state = (state * 1103515245 + 12345) % 2147483648
            values.append(50 + state / 2147483648)
        self.values = values
        self.bars = [bar(v, v + 1, v - 1, v, 1000) for v in values]

    def series_cases(self):
        values, bars = self.values, self.bars
        return {
            "simpleReturns": lambda n: ind.simple_returns(values[:n]),
            "realizedVolatility": lambda n: ind.realized_volatility(values[:n], 5),
            "downsideVolatility": lambda n: ind.downside_volatility(values[:n], 5),
            "skewness": lambda n: ind.skewness(values[:n], 5),
            "kurtosis": lambda n: ind.kurtosis(values[:n], 5),
            "maxDrawdown": lambda n: ind.max_drawdown(values[:n], 5),
            "atrPercent": lambda n: ind.atr_percent(bars[:n], 5),
            "amihudIlliquidity": lambda n: ind.amihud_illiquidity(bars[:n], 5),
            "avgDev": lambda n: ind.avg_dev(values[:n], 5),
            "variance": lambda n: ind.variance(values[:n], 5),
            "bop": lambda n: ind.bop(bars[:n]),
            "adxr": lambda n: ind.adxr(ind.adx(bars[:n], 5)["adx"], 5),
            "cmo": lambda n: ind.cmo(values[:n], 5),
            "tsi": lambda n: ind.tsi(values[:n], slow=5, fast=3),
            "efficiencyRatio": lambda n: ind.efficiency_ratio(values[:n], 5),
            "smaDistance": lambda n: ind.sma_distance(values[:n], 5),
            "emaDistance": lambda n: ind.ema_distance(values[:n], 5),
            "emaSlope": lambda n: ind.ema_slope(values[:n], 5, 2),
            "zScore": lambda n: ind.z_score(values[:n], 5),
            "volumeRatio": lambda n: ind.volume_ratio([b["v"] for b in bars[:n]], 5),
            "pricePosition": lambda n: ind.price_position(bars[:n], 5),
            "avgPrice": lambda n: ind.avg_price(bars[:n]),
            "medPrice": lambda n: ind.med_price(bars[:n]),
            "typPrice": lambda n: ind.typ_price(bars[:n]),
            "wclPrice": lambda n: ind.wcl_price(bars[:n]),
            "rollingMax": lambda n: ind.rolling_max(values[:n], 5),
            "rollingMin": lambda n: ind.rolling_min(values[:n], 5),
            "maxIndex": lambda n: ind.max_index(values[:n], 5),
            "minIndex": lambda n: ind.min_index(values[:n], 5),
            "midPoint": lambda n: ind.mid_point(values[:n], 5),
            "midPrice": lambda n: ind.mid_price(bars[:n], 5),
            "trima": lambda n: ind.trima(values[:n], 5),
            "t3": lambda n: ind.t3(values[:n], 3),
            "plusDM": lambda n: ind.plus_dm(bars[:n], 5),
            "minusDM": lambda n: ind.minus_dm(bars[:n], 5),
            "plusDI": lambda n: ind.plus_di(bars[:n], 5),
            "minusDI": lambda n: ind.minus_di(bars[:n], 5),
            "dx": lambda n: ind.dx(bars[:n], 5),
            "aroonOsc": lambda n: ind.aroon_osc(bars[:n], 5),
            "natr": lambda n: ind.natr(bars[:n], 5),
            "adOsc": lambda n: ind.ad_osc(bars[:n], 3, 5),
            "linRegSlope": lambda n: ind.lin_reg_slope(values[:n], 5),
            "linRegIntercept": lambda n: ind.lin_reg_intercept(values[:n], 5),
            "linRegAngle": lambda n: ind.lin_reg_angle(values[:n], 5),
            "tsf": lambda n: ind.tsf(values[:n], 5),
        }

    def test_length_matches_input(self) -> None:
        for name, run in self.series_cases().items():
            with self.subTest(function=name):
                self.assertEqual(len(run(40)), 40, "%s 输出必须与输入等长" % name)

    def test_causality_prefix_invariance(self) -> None:
        """第 i 项只用 <= i 的数据：前缀输入的结果必须等于整段输入的同前缀。"""
        for name, run in self.series_cases().items():
            full = run(40)
            for n in (12, 17, 29):
                with self.subTest(function=name, prefix=n):
                    prefix = run(n)
                    self.assertEqual(len(prefix), n)
                    for i in range(n):
                        a, b = prefix[i], full[i]
                        if a is None or b is None:
                            self.assertEqual(a, b, "%s[%d] 缺值不一致" % (name, i))
                        else:
                            self.assertAlmostEqual(
                                a, b, delta=TOLERANCE, msg="%s[%d] 因果性被破坏" % (name, i)
                            )

    def test_input_not_mutated(self) -> None:
        before = json.dumps({"values": self.values, "bars": self.bars}, sort_keys=True)
        for run in self.series_cases().values():
            run(40)
        ind.stoch_f(self.bars, 5, 3)
        ind.correl(self.values, self.values, 5)
        ind.levels(self.bars, 10)
        after = json.dumps({"values": self.values, "bars": self.bars}, sort_keys=True)
        self.assertEqual(before, after, "指标函数不得修改输入")

    def test_no_nan_in_outputs(self) -> None:
        for name, run in self.series_cases().items():
            for value in run(40):
                if value is None:
                    continue
                with self.subTest(function=name, value=value):
                    self.assertTrue(math.isfinite(value), "%s 产出非有限数" % name)
        for part in ("k", "d"):
            for value in ind.stoch_f(self.bars, 5, 3)[part]:
                if value is not None:
                    self.assertTrue(math.isfinite(value))


if __name__ == "__main__":
    unittest.main()
