# SPDX-License-Identifier: CPAL-1.0
"""指标库数值测试：Python 实现与 TS 实现（packages/engine-core 的 ta/）逐值相等。

夹具不是手写的期望值，而是用一次性脚本从 TS 侧真跑出来的数值：

    node packages/engine-python/tests/fixtures/export-ts-fixtures.mjs

脚本把「同一份确定性合成输入 + 每个指标的 TS 输出」写进 fixtures/ts-indicators.json；
本文件读同一份输入、跑 engine/indicators.py、逐值比对（容差 1e-9），
同时校验长度对齐与「预热期为 None」的契约。

跑法：python -m unittest packages/engine-python/tests/test_indicators.py
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any, Optional

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))  # packages/engine-python

from engine import indicators as ind  # noqa: E402

FIXTURE_PATH = _HERE.parent / "fixtures" / "ts-indicators.json"
TOLERANCE = 1e-9

if not FIXTURE_PATH.exists():  # pragma: no cover - 只在夹具缺失时触发
    raise SystemExit(
        "缺夹具 %s；先在仓库根跑 node packages/engine-python/tests/fixtures/export-ts-fixtures.mjs"
        % FIXTURE_PATH
    )

with FIXTURE_PATH.open("r", encoding="utf-8") as _fh:
    _DATA = json.load(_fh)

INPUTS = _DATA["inputs"]
CASES = _DATA["cases"]
BARS = INPUTS["bars"]
BARS_FLAT = INPUTS["barsFlat"]
GAP_SERIES = INPUTS["gapSeries"]
B_SERIES = INPUTS["bSeries"]
CLOSES = [bar["c"] for bar in BARS]

# fixtures/ts-indicators.json 里应出现的 case 名（与 export-ts-fixtures.mjs 一一对应）
EXPECTED_CASES = [
    "sma", "ema", "wma", "macd", "cross",
    "rsi", "stochastic", "roc", "momentum", "williamsR", "cci",
    "trueRange", "atr", "rollingStd", "rollingStdDdof1", "bollinger", "keltner",
    "donchian", "logReturns", "parkinsonVol", "garmanKlassVol", "annualizedVol",
    "obv", "vwap", "vwapWindow", "mfi", "cmf", "adLine", "turnoverProxy",
    "volumeZscore",
    "dema", "tema", "hma", "kama", "vwma", "alma", "zlema", "ichimoku",
    "parabolicSar", "supertrend", "pivotPoints", "linearRegression", "envelope",
    "trix", "ultimateOscillator", "awesomeOscillator", "ppo", "aroon", "dpo",
    "adx", "stochRsi", "chaikinOscillator", "forceIndex", "easeOfMovement",
    "massIndex", "ulcerIndex", "vortex", "choppiness", "kdj", "elderRay",
    "rollingSum", "rollingCorr", "rankPct", "idxMax", "idxMin", "linearResidual",
    "stochasticFlat", "kdjFlat", "williamsRFlat", "cciFlat", "choppinessFlat",
    "cmfFlat", "vwapFlat", "volumeZscoreFlat", "mfiFlat",
]

# packages/engine-core/src/strategy/ta/index.ts 的导出清单（函数名 → Python 名）
TS_EXPORTS = {
    # trend
    "sma": "sma", "ema": "ema", "wma": "wma", "macd": "macd", "cross": "cross",
    # momentum
    "rsi": "rsi", "stochastic": "stochastic", "roc": "roc", "momentum": "momentum",
    "williamsR": "williams_r", "cci": "cci",
    # volatility
    "trueRange": "true_range", "atr": "atr", "rollingStd": "rolling_std",
    "bollinger": "bollinger", "keltner": "keltner", "donchian": "donchian",
    "logReturns": "log_returns", "annualizedVol": "annualized_vol",
    # 这两个在 volatility.ts 里 export，但 index.ts 没再导出（夹具脚本单独取）
    "parkinsonVol": "parkinson_vol", "garmanKlassVol": "garman_klass_vol",
    # volume
    "obv": "obv", "vwap": "vwap", "mfi": "mfi", "cmf": "cmf", "adLine": "ad_line",
    # 这两个同样只在 volume.ts 里 export
    "turnoverProxy": "turnover_proxy", "volumeZscore": "volume_zscore",
    # overlap
    "dema": "dema", "tema": "tema", "hma": "hma", "kama": "kama", "vwma": "vwma",
    "alma": "alma", "zlema": "zlema", "ichimoku": "ichimoku",
    "parabolicSar": "parabolic_sar", "supertrend": "supertrend",
    "pivotPoints": "pivot_points", "linearRegression": "linear_regression",
    "envelope": "envelope",
    # oscillators
    "trix": "trix", "ultimateOscillator": "ultimate_oscillator",
    "awesomeOscillator": "awesome_oscillator", "ppo": "ppo", "aroon": "aroon",
    "dpo": "dpo", "adx": "adx", "stochRsi": "stoch_rsi",
    "chaikinOscillator": "chaikin_oscillator", "forceIndex": "force_index",
    "easeOfMovement": "ease_of_movement", "massIndex": "mass_index",
    "ulcerIndex": "ulcer_index", "vortex": "vortex", "choppiness": "choppiness",
    "kdj": "kdj", "elderRay": "elder_ray",
    # alpha ops
    "rollingSum": "rolling_sum", "rollingCorr": "rolling_corr",
    "rankPct": "rank_pct", "idxMax": "idx_max", "idxMin": "idx_min",
    "linearResidual": "linear_residual",
}


class IndicatorFixtureTest(unittest.TestCase):
    """同一输入下，Python 与 TS 的每个指标逐值相等（容差 1e-9）。"""

    maxDiff = None

    # -- 比对工具 ---------------------------------------------------------
    def _compare(self, name: str, actual: Any) -> None:
        self.assertIn(name, CASES, "夹具里没有 case：%s" % name)
        expected = CASES[name]["value"]
        self._assert_same(actual, expected, name)

    def _assert_same(self, actual: Any, expected: Any, path: str) -> None:
        if expected is None:
            self.assertIsNone(actual, "%s 应为 None，实际 %r" % (path, actual))
            return
        if isinstance(expected, bool):
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
                self._assert_same(a, e, "%s[%d]" % (path, i))
            return
        if isinstance(expected, dict):
            self.assertIsInstance(actual, dict, "%s 类型不同" % path)
            self.assertEqual(
                sorted(actual.keys()), sorted(expected.keys()), "%s 键集合不同" % path
            )
            for key in expected:
                self._assert_same(actual[key], expected[key], "%s.%s" % (path, key))
            return
        self.fail("未知夹具类型：%s %r" % (path, expected))

    # -- 夹具与导出清单自检 ------------------------------------------------
    def test_zz_fixture_covers_expected_cases(self) -> None:
        self.assertEqual(sorted(CASES.keys()), sorted(EXPECTED_CASES))

    def test_ts_export_list_is_covered(self) -> None:
        """ta/index.ts 的每个导出在 Python 侧都有同名（或 snake_case 同名）函数。

        TS_EXPORTS 共 60 条：index.ts 再导出的 60 个名字，加上 volatility.ts /
        volume.ts 里 export 了但 index.ts 没再导出的 4 个（parkinsonVol、
        garmanKlassVol、turnoverProxy、volumeZscore）→ 64 个函数名。
        """
        self.assertEqual(len(TS_EXPORTS), 64)
        for ts_name, py_name in TS_EXPORTS.items():
            self.assertTrue(callable(getattr(ind, py_name, None)), "缺函数：%s" % py_name)
            self.assertTrue(callable(getattr(ind, ts_name, None)), "缺别名：%s" % ts_name)

    # -- 趋势 -------------------------------------------------------------
    def test_sma(self) -> None:
        self._compare("sma", ind.sma(CLOSES, 5))

    def test_ema(self) -> None:
        self._compare("ema", ind.ema(CLOSES, 12))

    def test_wma(self) -> None:
        self._compare("wma", ind.wma(CLOSES, 9))

    def test_macd(self) -> None:
        self._compare("macd", ind.macd(CLOSES, 12, 26, 9))

    def test_cross(self) -> None:
        self._compare("cross", ind.cross(ind.ema(CLOSES, 5), ind.ema(CLOSES, 20)))

    # -- 动量 -------------------------------------------------------------
    def test_rsi(self) -> None:
        self._compare("rsi", ind.rsi(CLOSES, 14))

    def test_stochastic(self) -> None:
        self._compare("stochastic", ind.stochastic(BARS, 14, 3))

    def test_roc(self) -> None:
        self._compare("roc", ind.roc(CLOSES, 10))

    def test_momentum(self) -> None:
        self._compare("momentum", ind.momentum(CLOSES, 10))

    def test_williams_r(self) -> None:
        self._compare("williamsR", ind.williams_r(BARS, 14))

    def test_cci(self) -> None:
        self._compare("cci", ind.cci(BARS, 20))

    # -- 波动 -------------------------------------------------------------
    def test_true_range(self) -> None:
        self._compare("trueRange", ind.true_range(BARS))

    def test_atr(self) -> None:
        self._compare("atr", ind.atr(BARS, 14))

    def test_rolling_std(self) -> None:
        self._compare("rollingStd", ind.rolling_std(CLOSES, 20, 0))

    def test_rolling_std_ddof1(self) -> None:
        self._compare("rollingStdDdof1", ind.rolling_std(CLOSES, 20, 1))

    def test_bollinger(self) -> None:
        self._compare("bollinger", ind.bollinger(CLOSES, 20, 2))

    def test_keltner(self) -> None:
        self._compare("keltner", ind.keltner(BARS, 20, 10, 2))

    def test_donchian(self) -> None:
        self._compare("donchian", ind.donchian(BARS, 20))

    def test_log_returns(self) -> None:
        self._compare("logReturns", ind.log_returns(CLOSES))

    def test_parkinson_vol(self) -> None:
        self._compare("parkinsonVol", ind.parkinson_vol(BARS, 20, 365))

    def test_garman_klass_vol(self) -> None:
        self._compare("garmanKlassVol", ind.garman_klass_vol(BARS, 20, 365))

    def test_annualized_vol(self) -> None:
        self._compare("annualizedVol", ind.annualized_vol(CLOSES, 20, 365))

    # -- 量价 -------------------------------------------------------------
    def test_obv(self) -> None:
        self._compare("obv", ind.obv(BARS))

    def test_vwap_cumulative(self) -> None:
        self._compare("vwap", ind.vwap(BARS))

    def test_vwap_window(self) -> None:
        self._compare("vwapWindow", ind.vwap(BARS, 20))

    def test_mfi(self) -> None:
        self._compare("mfi", ind.mfi(BARS, 14))

    def test_cmf(self) -> None:
        self._compare("cmf", ind.cmf(BARS, 20))

    def test_ad_line(self) -> None:
        self._compare("adLine", ind.ad_line(BARS))

    def test_turnover_proxy(self) -> None:
        self._compare("turnoverProxy", ind.turnover_proxy(BARS, 20))

    def test_volume_zscore(self) -> None:
        self._compare("volumeZscore", ind.volume_zscore(BARS, 20))

    # -- 叠加 -------------------------------------------------------------
    def test_dema(self) -> None:
        self._compare("dema", ind.dema(CLOSES, 10))

    def test_tema(self) -> None:
        self._compare("tema", ind.tema(CLOSES, 10))

    def test_hma(self) -> None:
        self._compare("hma", ind.hma(CLOSES, 16))

    def test_kama(self) -> None:
        self._compare("kama", ind.kama(CLOSES, 10, 2, 30))

    def test_vwma(self) -> None:
        self._compare("vwma", ind.vwma(BARS, 20))

    def test_alma(self) -> None:
        self._compare("alma", ind.alma(CLOSES, 9, 0.85, 6))

    def test_zlema(self) -> None:
        self._compare("zlema", ind.zlema(CLOSES, 21))

    def test_ichimoku(self) -> None:
        self._compare("ichimoku", ind.ichimoku(BARS))

    def test_parabolic_sar(self) -> None:
        self._compare("parabolicSar", ind.parabolic_sar(BARS))

    def test_supertrend(self) -> None:
        self._compare("supertrend", ind.supertrend(BARS, 10, 3))

    def test_pivot_points(self) -> None:
        self._compare("pivotPoints", ind.pivot_points(BARS))

    def test_linear_regression(self) -> None:
        self._compare("linearRegression", ind.linear_regression(CLOSES, 20))

    def test_envelope(self) -> None:
        self._compare("envelope", ind.envelope(CLOSES, 20, 0.025))

    # -- 振荡 -------------------------------------------------------------
    def test_trix(self) -> None:
        self._compare("trix", ind.trix(CLOSES, 15))

    def test_ultimate_oscillator(self) -> None:
        self._compare("ultimateOscillator", ind.ultimate_oscillator(BARS))

    def test_awesome_oscillator(self) -> None:
        self._compare("awesomeOscillator", ind.awesome_oscillator(BARS))

    def test_ppo(self) -> None:
        self._compare("ppo", ind.ppo(CLOSES))

    def test_aroon(self) -> None:
        self._compare("aroon", ind.aroon(BARS, 25))

    def test_dpo(self) -> None:
        self._compare("dpo", ind.dpo(CLOSES, 20))

    def test_adx(self) -> None:
        self._compare("adx", ind.adx(BARS, 14))

    def test_stoch_rsi(self) -> None:
        self._compare("stochRsi", ind.stoch_rsi(CLOSES))

    def test_chaikin_oscillator(self) -> None:
        self._compare("chaikinOscillator", ind.chaikin_oscillator(BARS))

    def test_force_index(self) -> None:
        self._compare("forceIndex", ind.force_index(BARS, 13))

    def test_ease_of_movement(self) -> None:
        self._compare("easeOfMovement", ind.ease_of_movement(BARS, 14))

    def test_mass_index(self) -> None:
        self._compare("massIndex", ind.mass_index(BARS))

    def test_ulcer_index(self) -> None:
        self._compare("ulcerIndex", ind.ulcer_index(CLOSES, 14))

    def test_vortex(self) -> None:
        self._compare("vortex", ind.vortex(BARS, 14))

    def test_choppiness(self) -> None:
        self._compare("choppiness", ind.choppiness(BARS, 14))

    def test_kdj(self) -> None:
        self._compare("kdj", ind.kdj(BARS))

    def test_elder_ray(self) -> None:
        self._compare("elderRay", ind.elder_ray(BARS, 13))

    # -- Alpha158 批 A 算子（带缺口的序列） --------------------------------
    def test_rolling_sum(self) -> None:
        self._compare("rollingSum", ind.rolling_sum(GAP_SERIES, 5))

    def test_rolling_corr(self) -> None:
        self._compare("rollingCorr", ind.rolling_corr(GAP_SERIES, B_SERIES, 10))

    def test_rank_pct(self) -> None:
        self._compare("rankPct", ind.rank_pct(GAP_SERIES, 10))

    def test_idx_max(self) -> None:
        self._compare("idxMax", ind.idx_max(GAP_SERIES, 10))

    def test_idx_min(self) -> None:
        self._compare("idxMin", ind.idx_min(GAP_SERIES, 10))

    def test_linear_residual(self) -> None:
        self._compare("linearResidual", ind.linear_residual(GAP_SERIES, 10))

    # -- 全平盘（区间为 0 / 成交量为 0）的分支 ------------------------------
    def test_stochastic_flat_range(self) -> None:
        self._compare("stochasticFlat", ind.stochastic(BARS_FLAT, 14, 3))

    def test_kdj_flat_range(self) -> None:
        self._compare("kdjFlat", ind.kdj(BARS_FLAT))

    def test_williams_r_flat_range(self) -> None:
        self._compare("williamsRFlat", ind.williams_r(BARS_FLAT, 14))

    def test_cci_flat_range(self) -> None:
        self._compare("cciFlat", ind.cci(BARS_FLAT, 20))

    def test_choppiness_flat_range(self) -> None:
        self._compare("choppinessFlat", ind.choppiness(BARS_FLAT, 14))

    def test_cmf_zero_volume(self) -> None:
        self._compare("cmfFlat", ind.cmf(BARS_FLAT, 20))

    def test_vwap_zero_volume(self) -> None:
        self._compare("vwapFlat", ind.vwap(BARS_FLAT))

    def test_volume_zscore_flat(self) -> None:
        self._compare("volumeZscoreFlat", ind.volume_zscore(BARS_FLAT, 20))

    def test_mfi_flat_range(self) -> None:
        self._compare("mfiFlat", ind.mfi(BARS_FLAT, 14))

    # -- 契约：长度对齐与预热期 --------------------------------------------
    def test_output_length_matches_input(self) -> None:
        series_cases = [
            ("sma", ind.sma(CLOSES, 5), len(CLOSES)),
            ("ema", ind.ema(CLOSES, 12), len(CLOSES)),
            ("rsi", ind.rsi(CLOSES, 14), len(CLOSES)),
            ("atr", ind.atr(BARS, 14), len(BARS)),
            ("obv", ind.obv(BARS), len(BARS)),
            ("trix", ind.trix(CLOSES, 15), len(CLOSES)),
            ("kdj.k", ind.kdj(BARS)["k"], len(BARS)),
            ("bollinger.middle", ind.bollinger(CLOSES, 20)["middle"], len(CLOSES)),
            ("adx.adx", ind.adx(BARS, 14)["adx"], len(BARS)),
            ("rollingSum", ind.rolling_sum(GAP_SERIES, 5), len(GAP_SERIES)),
        ]
        for label, series, expected_len in series_cases:
            self.assertEqual(len(series), expected_len, "%s 长度不等于输入" % label)

    def test_warmup_is_none(self) -> None:
        sma5 = ind.sma(CLOSES, 5)
        self.assertEqual(sma5[:4], [None, None, None, None])
        self.assertIsNotNone(sma5[4])
        ema12 = ind.ema(CLOSES, 12)
        self.assertTrue(all(v is None for v in ema12[:11]))
        self.assertIsNotNone(ema12[11])
        atr14 = ind.atr(BARS, 14)
        self.assertTrue(all(v is None for v in atr14[:13]))
        self.assertIsNotNone(atr14[13])
        rsi14 = ind.rsi(CLOSES, 14)
        self.assertTrue(all(v is None for v in rsi14[:14]))
        self.assertIsNotNone(rsi14[14])

    # -- 参数校验（与 TS 的 RangeError 对应） -------------------------------
    def test_invalid_period_raises(self) -> None:
        for bad in (0, -3, 2.5, True, None):
            with self.assertRaises(ValueError, msg="period=%r 应抛 ValueError" % (bad,)):
                ind.sma(CLOSES, bad)
        with self.assertRaises(ValueError):
            ind.rsi(CLOSES, 0)
        with self.assertRaises(ValueError):
            ind.atr(BARS, 0)

    def test_macd_requires_fast_lt_slow(self) -> None:
        with self.assertRaises(ValueError):
            ind.macd(CLOSES, 26, 12, 9)

    def test_rolling_std_requires_period_gt_ddof(self) -> None:
        with self.assertRaises(ValueError):
            ind.rolling_std(CLOSES, 5, 5)

    def test_cross_requires_equal_length(self) -> None:
        with self.assertRaises(ValueError):
            ind.cross([1.0, 2.0], [1.0])

    def test_overlap_and_oscillator_invalid_period_returns_all_none(self) -> None:
        """overlap / oscillators 族在 period 非法时不抛错，整条输出为 None。"""
        for series in (
            ind.dema(CLOSES, 0),
            ind.tema(CLOSES, -1),
            ind.hma(CLOSES, 0),
            ind.zlema(CLOSES, 0),
            ind.trix(CLOSES, 0),
            ind.dpo(CLOSES, 0),
            ind.turnover_proxy(BARS, 0),
            ind.volume_zscore(BARS, 0),
        ):
            self.assertTrue(all(v is None for v in series))

    def test_alias_matches_snake_case(self) -> None:
        for ts_name, py_name in TS_EXPORTS.items():
            self.assertIs(getattr(ind, ts_name), getattr(ind, py_name), ts_name)

    def test_empty_input_does_not_crash(self) -> None:
        self.assertEqual(ind.sma([], 5), [])
        self.assertEqual(ind.obv([]), [])
        self.assertEqual(ind.atr([], 14), [])
        self.assertEqual(ind.parabolic_sar([])["sar"], [])
        self.assertEqual(ind.cross([], []), [])


if __name__ == "__main__":
    unittest.main()
