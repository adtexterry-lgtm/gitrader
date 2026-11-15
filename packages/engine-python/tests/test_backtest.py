# SPDX-License-Identifier: CPAL-1.0
"""回测循环与跨引擎一致性的离线单测（标准库 unittest，无第三方依赖）。

跑法（仓库根或任意目录）：
    python -m unittest packages/engine-python/tests/test_backtest.py -v

覆盖两部分：

1. **回测语义单测**（逐条对齐 ``packages/engine-core/src/strategy/simulator.ts``）：next-bar-open 成交、
   吃单费率、不利滑点、资金费点（含结算窗口）、强平（含罚金与破产）、单根成交量上限、手数归一、
   保护规则（止损 / 止盈 / 移动止损 / 时限）、统计口径、参数解析。
2. **跨引擎一致性**：读 ``tests/fixtures/ts-backtest.json``（由 ``fixtures/export-ts-backtest.mjs``
   用 engine-core 的 TS 模拟器在**同一份合成 K 线 + 同一批参数**上跑出来），Python 侧跑同样的策略，
   逐笔成交、逐根权益、统计与资金费明细全部对齐（容差见 ``TOL``）。十个示例策略各有一条默认参数用例
   （Python 侧传 ``{}``，因此默认值本身也在对账），另有费率 / 滑点 / 资金费 / 强平（含罚金与维持保证金）/
   单根成交量上限 / 保护规则（止损、止盈、移动止损、时限）/ 手数归一的参数路径用例，共 20 条。
"""

import importlib.util
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXAMPLES_DIR = os.path.join(ROOT, "examples")
FIXTURES = os.path.join(HERE, "fixtures")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:  # 正常路径：engine 是命名空间包
    from engine import backtest as bt
    from engine import strategy_api as sa
except Exception:  # pragma: no cover - 兄弟蜂若加了 engine/__init__.py 且导入失败，按文件路径兜底
    def _load(name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    sa = _load("gitrader_engine_strategy_api", os.path.join(ROOT, "engine", "strategy_api.py"))
    sys.modules.setdefault("strategy_api", sa)
    bt = _load("gitrader_engine_backtest", os.path.join(ROOT, "engine", "backtest.py"))

DAY = bt.DAY_MS
HOUR = 3_600_000
T0 = 1_760_000_000_000
TOL = 1e-9


# ───────────── 小工具 ─────────────


def bar(t, o, h=None, l=None, c=None, v=1e9):
    """一根 K 线（默认平盘：h = l = c = o）。"""
    return {"t": float(t), "o": float(o), "h": float(o if h is None else h),
            "l": float(o if l is None else l), "c": float(o if c is None else c), "v": float(v)}


def candles_of(*prices, start=T0, step=HOUR):
    return [bar(start + i * step, p) for i, p in enumerate(prices)]


def sim(**opts):
    return bt.Simulator(bt.sim_options_from(opts))


def feed(simulator, candles, targets, reasons=None):
    """按 simulateSeries 的门控逐根推进：第 i 根用 targets[i-1]（第 0 根永远没有信号）。"""
    for i, candle in enumerate(candles):
        want = targets[i - 1] if i > 0 and i - 1 < len(targets) else None
        why = reasons[i - 1] if reasons and i > 0 and i - 1 < len(reasons) else ""
        simulator.on_bar(i, candle, want, why or "")
    return simulator


def series(target, warmup=0):
    return sa.SignalSeries(target=[float(x) for x in target],
                           reasons=[""] * len(target), overlays={}, warmup=warmup)


# ───────────── 1. 回测语义 ─────────────


class FillSemanticsTest(unittest.TestCase):
    """成交价、手续费、滑点：next-bar-open 的算术逐项核对。"""

    def test_fee_is_charged_on_executed_notional(self):
        """10000 权益、1× 、价 100：开 100 币，手续费 = 100·100·0.001 = 10，现金 9990。"""
        simulator = sim(initial_cash=10_000, leverage=1, fee_rate=0.001, slippage_bps=0)
        candles = candles_of(100, 100, 110)
        feed(simulator, candles, [1, 1, 1])
        self.assertEqual(len(simulator.trades), 1)
        trade = simulator.trades[0]
        self.assertEqual(trade["side"], "buy")
        self.assertAlmostEqual(trade["price"], 100.0, places=12)
        self.assertAlmostEqual(trade["size"], 100.0, places=12)
        self.assertAlmostEqual(trade["fee"], 10.0, places=12)
        self.assertAlmostEqual(trade["pnl"], -10.0, places=12)  # 纯开仓：pnl = -手续费
        self.assertAlmostEqual(simulator.cash, 9_990.0, places=12)
        self.assertAlmostEqual(simulator.equity[-1]["v"], 9_990.0 + 100 * 10, places=9)

    def test_slippage_is_adverse_on_both_sides(self):
        """买价 = o·(1+bps/1e4)，卖价 = o·(1-bps/1e4)；仓位按含滑点的价折算。"""
        slip = 10 / 1e4
        simulator = sim(initial_cash=10_000, leverage=1, fee_rate=0, slippage_bps=10)
        candles = candles_of(100, 100, 120)
        feed(simulator, candles, [1, 0, 0])
        buy = simulator.trades[0]
        self.assertAlmostEqual(buy["price"], 100 * (1 + slip), places=12)
        self.assertAlmostEqual(buy["size"], 10_000 / (100 * (1 + slip)), places=9)
        sell = simulator.trades[1]
        self.assertEqual(sell["side"], "sell")
        self.assertAlmostEqual(sell["price"], 120 * (1 - slip), places=12)

    def test_signal_on_bar_i_fills_at_bar_i_plus_one_open(self):
        """信号出在第 i 根收盘，成交在第 i+1 根开盘价（不是第 i 根收盘价）。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0)
        candles = [bar(T0, 100, c=150), bar(T0 + HOUR, 130, c=130), bar(T0 + 2 * HOUR, 140, c=140)]
        feed(simulator, candles, [1, 1, 1])
        self.assertEqual(len(simulator.trades), 1)
        self.assertEqual(simulator.trades[0]["t"], T0 + HOUR)
        self.assertAlmostEqual(simulator.trades[0]["price"], 130.0, places=12)

    def test_warmup_bars_never_trade(self):
        """预热期（target 恒 0）不下单：warmup=5 时最早第 7 根才会成交。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0)
        candles = candles_of(*([100] * 10))
        out = bt.simulate_series(series([1] * 10, warmup=5), candles,
                                 {"initialCash": 1_000, "feeRate": 0, "slippageBps": 0})
        self.assertEqual(len(out["trades"]), 1)
        self.assertEqual(out["trades"][0]["t"], candles[6]["t"])

    def test_no_refill_when_target_is_unchanged(self):
        """目标仓位没变化就只成交一次（applied 门控），不逐根再平衡。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0)
        feed(simulator, candles_of(*([100] * 8)), [1] * 8)
        self.assertEqual(len(simulator.trades), 1)


class FundingTest(unittest.TestCase):
    """资金费：paid = pos·c·rate（多头 rate > 0 付钱），只结算 (lastT, c.t] 内的点。"""

    def test_long_pays_when_rate_positive(self):
        """BLUEPRINT §三.3 的已知答案：1 币多头、rate 0.0001、c = 100 → 付 0.01。"""
        simulator = sim(initial_cash=100, leverage=1, fee_rate=0, slippage_bps=0,
                        funding=[{"t": T0 + HOUR, "rate": 0.0001}])
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100)]
        feed(simulator, candles, [1, 1])
        self.assertAlmostEqual(simulator.pos, 1.0, places=12)
        self.assertAlmostEqual(simulator.funding_paid, 0.01, places=12)
        self.assertAlmostEqual(simulator.cash, 100 - 0.01, places=12)
        self.assertEqual(len(simulator.funding), 1)
        self.assertAlmostEqual(simulator.funding[0]["notional"], 100.0, places=12)

    def test_short_receives_when_rate_positive(self):
        """空头在 rate > 0 时收钱：paid 为负，现金增加。"""
        simulator = sim(initial_cash=100, leverage=1, fee_rate=0, slippage_bps=0,
                        funding=[{"t": T0 + HOUR, "rate": 0.0001}])
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100)]
        feed(simulator, candles, [-1, -1])
        self.assertAlmostEqual(simulator.pos, -1.0, places=12)
        self.assertAlmostEqual(simulator.funding_paid, -0.01, places=12)
        self.assertGreater(simulator.cash, 100)

    def test_points_outside_the_bar_window_are_not_settled(self):
        """落在 (上一根 t, 本根 t] 之外的点不结算；区间之后的点不推进。"""
        points = [
            {"t": T0, "rate": 0.001},               # 第 0 根：只推进指针，不结算
            {"t": T0 + HOUR // 2, "rate": 0.0001},  # 落在 (bar0, bar1] → 第 1 根结算
            {"t": T0 + HOUR, "rate": 0.0001},       # 边界：仍属第 1 根
            {"t": T0 + 9 * HOUR, "rate": 0.5},      # 回测区间之外
        ]
        simulator = sim(initial_cash=100, leverage=1, fee_rate=0, slippage_bps=0, funding=points)
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100), bar(T0 + 2 * HOUR, 100, c=100)]
        feed(simulator, candles, [1, 1, 1])
        self.assertEqual([p["t"] for p in simulator.funding], [T0 + HOUR // 2, T0 + HOUR])
        self.assertAlmostEqual(simulator.funding_paid, 0.02, places=12)


class LiquidationTest(unittest.TestCase):
    """强平：最不利价对维持保证金判定，成交后扣罚金，现金归零即破产。"""

    def test_seven_percent_drop_liquidates_ten_times_leverage(self):
        """BLUEPRINT §三 E-fund-1 ②：10× 、mmr 0.05，下一根 l 跌 7% → 强平一笔。"""
        simulator = sim(initial_cash=1_000, leverage=10, fee_rate=0, slippage_bps=0,
                        liquidation=True, maintenance_margin_ratio=0.05)
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, l=93, h=100, c=93)]
        feed(simulator, candles, [1, 1])
        self.assertEqual(simulator.liquidations, 1)
        self.assertEqual(simulator.trades[-1]["reason"], "liquidation")
        self.assertAlmostEqual(simulator.pos, 0.0, places=12)

    def test_three_percent_drop_does_not_liquidate(self):
        """同一组参数、只跌 3% → 不强平（维持保证金还没被吃掉）。"""
        simulator = sim(initial_cash=1_000, leverage=10, fee_rate=0, slippage_bps=0,
                        liquidation=True, maintenance_margin_ratio=0.05)
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, l=97, h=100, c=97)]
        feed(simulator, candles, [1, 1])
        self.assertEqual(simulator.liquidations, 0)
        self.assertGreater(simulator.pos, 0)

    def test_liquidation_penalty_and_bankruptcy_stop_trading(self):
        """罚金按 mm 的比例扣；平仓后现金 ≤ 0 → cash 归零、bankrupt，后续不再成交。"""
        simulator = sim(initial_cash=1_000, leverage=20, fee_rate=0, slippage_bps=0,
                        liquidation=True, maintenance_margin_ratio=0.01, liquidation_penalty_ratio=0.5)
        crash = [bar(T0, 100, c=100),
                 bar(T0 + HOUR, 100, l=60, h=100, c=60),
                 bar(T0 + 2 * HOUR, 60, c=60),
                 bar(T0 + 3 * HOUR, 60, c=60)]
        feed(simulator, crash, [1, 1, 1, 1])
        self.assertEqual(simulator.liquidations, 1)
        self.assertTrue(simulator.bankrupt)
        self.assertEqual(simulator.cash, 0.0)
        self.assertEqual(len(simulator.trades), 2)  # 开仓 + 强平，之后不再成交
        self.assertAlmostEqual(simulator.equity[-1]["v"], 0.0, places=12)

    def test_liquidation_disabled_by_default(self):
        """不给 liquidation 就完全不模拟强平（缺省 false，assumptions 里如实写 false）。"""
        simulator = sim(initial_cash=1_000, leverage=20, fee_rate=0, slippage_bps=0)
        feed(simulator, [bar(T0, 100, c=100), bar(T0 + HOUR, 100, l=10, h=100, c=10)], [1, 1])
        self.assertEqual(simulator.liquidations, 0)
        self.assertFalse(simulator.opts.to_dict()["liquidation"])


class VolumeCapTest(unittest.TestCase):
    """单根成交量上限：超出部分不成交，记入 unfilledNotional，applied 仍按目标更新。"""

    def test_half_volume_cap_fills_half(self):
        """BLUEPRINT §三 E-fund-1 ③：maxVolumeShare 0.5、bar v=1、目标需 2 币 → 只成交 0.5 币。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0, max_volume_share=0.5)
        candles = [bar(T0, 100, c=100, v=1), bar(T0 + HOUR, 100, c=100, v=1)]
        feed(simulator, candles, [0.2, 0.2])  # 目标 0.2 × 1000 / 100 = 2 币
        self.assertEqual(len(simulator.trades), 1)
        self.assertAlmostEqual(simulator.trades[0]["size"], 0.5, places=12)
        self.assertAlmostEqual(simulator.applied, 0.2, places=12)  # 目标仍按实际下达更新
        self.assertAlmostEqual(simulator.unfilled_notional, 150.0, places=9)
        stats = simulator.stats(candles, HOUR)
        self.assertAlmostEqual(stats["unfilledShare"], 0.75, places=9)

    def test_zero_volume_blocks_the_fill(self):
        """v = 0 → 上限 0，本根不成交但 applied 前移（下根不补）。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0, max_volume_share=0.5)
        candles = [bar(T0, 100, c=100, v=1), bar(T0 + HOUR, 100, c=100, v=0), bar(T0 + 2 * HOUR, 100, c=100, v=100)]
        feed(simulator, candles, [1, 1, 1])
        self.assertEqual(len(simulator.trades), 0)  # 第 1 根被 0 成交量挡住
        self.assertAlmostEqual(simulator.applied, 1.0, places=12)


class LotNormalizationTest(unittest.TestCase):
    """手数归一：按 step 向零取整（含 4 ulp 吸附），归一后为 0 视为不成交。"""

    def test_normalize_lot_truncates_towards_zero(self):
        self.assertAlmostEqual(bt.normalize_lot(2.37, 0.1), 2.3, places=12)
        self.assertAlmostEqual(bt.normalize_lot(-2.37, 0.1), -2.3, places=12)

    def test_normalize_lot_snaps_binary_noise(self):
        """0.30000000000000004 按 0.1 归一整手，不会被截掉一手。"""
        self.assertAlmostEqual(bt.normalize_lot(0.30000000000000004, 0.1), 0.3, places=15)
        self.assertAlmostEqual(bt.normalize_lot(0.7, 0.1), 0.7, places=15)

    def test_normalize_lot_min_qty_and_bad_step(self):
        self.assertEqual(bt.normalize_lot(0.05, 0.1, 0.2), 0.0)
        self.assertAlmostEqual(bt.normalize_lot(1.23, 0.01, 0.5), 1.23, places=12)
        self.assertAlmostEqual(bt.normalize_lot(2.5, 0), 2.5, places=12)  # step ≤ 0 → 原值

    def test_fill_below_min_lot_is_not_a_trade_but_counts_as_unfilled(self):
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0,
                        lot_step=1.0, min_lot=5.0)
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100)]
        feed(simulator, candles, [0.2, 0.2])  # 需要 2 币，但 minLot 5 → 归一后 0
        self.assertEqual(len(simulator.trades), 0)
        self.assertAlmostEqual(simulator.unfilled_notional, 200.0, places=9)

    def test_fill_is_normalized_to_the_lot_step(self):
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0, lot_step=0.5)
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100)]
        feed(simulator, candles, [0.2037, 0.2037])  # 2.037 币 → 2.0 币
        self.assertAlmostEqual(simulator.trades[0]["size"], 2.0, places=12)


class ProtectionTest(unittest.TestCase):
    """保护规则：先于策略、平掉全部仓位、同根按 stop_loss→trailing→time→take_profit 取一个。"""

    def test_stop_loss_exits_at_trigger_price(self):
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0,
                        protection={"stopLossPct": 0.05})
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100),
                   bar(T0 + 2 * HOUR, 100, h=100, l=94, c=94)]
        feed(simulator, candles, [1, 1, 1])
        self.assertEqual(simulator.protection_exits, 1)
        last = simulator.trades[-1]
        self.assertEqual(last["reason"], "protection:stop_loss")
        self.assertAlmostEqual(last["price"], 95.0, places=12)
        self.assertAlmostEqual(simulator.pos, 0.0, places=12)

    def test_time_limit_exits_at_close(self):
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0,
                        protection={"maxHoldBars": 2})
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100),
                   bar(T0 + 2 * HOUR, 100, c=105), bar(T0 + 3 * HOUR, 100, c=106)]
        feed(simulator, candles, [1, 1, 1, 1])
        self.assertEqual(simulator.protection_exits, 1)
        last = simulator.trades[-1]
        self.assertEqual(last["reason"], "protection:time_limit")
        self.assertAlmostEqual(last["price"], 106.0, places=12)  # 时限按本根收盘价成交

    def test_protection_beats_the_strategy_on_the_same_bar(self):
        """本根触发保护就忽略本根的策略目标（想再开仓得等下一根）。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0,
                        protection={"takeProfitPct": 0.1})
        candles = [bar(T0, 100, c=100), bar(T0 + HOUR, 100, c=100),
                   bar(T0 + 2 * HOUR, 100, h=115, c=112)]
        feed(simulator, candles, [1, 1, 1])
        self.assertEqual(len(simulator.trades), 2)
        self.assertEqual(simulator.trades[-1]["reason"], "protection:take_profit")
        self.assertAlmostEqual(simulator.trades[-1]["price"], 110.0, places=12)
        self.assertAlmostEqual(simulator.applied, 0.0, places=12)

    def test_protection_input_is_normalized(self):
        cfg = bt.normalize_protection({"stopLossPct": 5, "takeProfitPct": "20%", "maxHoldBars": 7.9,
                                       "trailingStopPct": 0.02})
        self.assertAlmostEqual(cfg["stopLossPct"], 0.05, places=12)
        self.assertAlmostEqual(cfg["takeProfitPct"], 0.20, places=12)
        self.assertEqual(cfg["maxHoldBars"], 7)
        self.assertEqual(cfg["trailing"]["activationPct"], 0.0)
        self.assertAlmostEqual(cfg["trailing"]["trailPct"], 0.02, places=12)
        with self.assertRaises(ValueError):
            bt.normalize_protection({"stopLossPct": 200})   # 2.0 > 上限 1
        with self.assertRaises(ValueError):
            bt.normalize_protection({"trailingActivationPct": 0.02})  # 只给激活不给距离


class StatsAndOptionsTest(unittest.TestCase):
    """统计口径、逐根权益、参数解析。"""

    def test_equity_series_and_stats_match_the_arithmetic(self):
        """1000 → 买 10 币 @100 → 1100 → 900：总收益 -10%、最大回撤 2/11、单笔未平仓。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0)
        candles = candles_of(100, 100, 110, 90)
        feed(simulator, candles, [1, 1, 1, 1])
        self.assertEqual(len(simulator.equity), 4)
        self.assertAlmostEqual(simulator.equity[0]["v"], 1_000.0, places=12)
        stats = simulator.stats(candles, HOUR)
        self.assertAlmostEqual(stats["finalEquity"], 900.0, places=12)
        self.assertAlmostEqual(stats["totalReturnRatio"], -0.1, places=9)
        self.assertAlmostEqual(stats["maxDrawdownRatio"], bt._round_to(200 / 1100, 6), places=12)
        self.assertAlmostEqual(stats["spanDays"], bt._round_to(4 * HOUR / DAY, 3), places=12)
        self.assertEqual(stats["fills"], 1)
        self.assertEqual(stats["trades"], 0)  # 没有平仓，往返统计为空
        self.assertIsNone(stats["profitFactor"])

    def test_closed_trip_counts_win_and_hold_bars(self):
        """开 → 平算一笔往返：盈利一笔时 winRatio 1、avgHoldBars = 持仓根数。"""
        simulator = sim(initial_cash=1_000, leverage=1, fee_rate=0, slippage_bps=0)
        candles = candles_of(100, 100, 120, 120, 120)
        feed(simulator, candles, [1, 0, 0, 0, 0])
        stats = simulator.stats(candles, HOUR)
        self.assertEqual(stats["trades"], 1)
        self.assertAlmostEqual(stats["winRatio"], 1.0, places=12)
        self.assertAlmostEqual(stats["avgHoldBars"], 1.0, places=12)
        self.assertIsNone(stats["profitFactor"])  # 没有亏损笔 → 盈亏比 null

    def test_rounding_uses_tofixed_semantics(self):
        """统计取整按 JS toFixed 的口径（一半远离 0），不是 Python 的银行家舍入。"""
        self.assertEqual(bt._round_to(0.125, 2), 0.13)     # JS "0.13"，Python round → 0.12
        self.assertEqual(bt._round_to(2.5, 0), 3.0)        # JS "3"，Python round → 2
        self.assertEqual(bt._round_to(-0.5, 0), -1.0)      # 负数也向远离 0 的一侧
        self.assertEqual(bt._round_to(2.675, 2), 2.67)     # 二进制真值 2.67499… 向下
        self.assertEqual(bt._round_to(1e30, 6), 1e30)      # 该量级 double 没有小数位可舍

    def test_infer_interval_ms_uses_the_median_gap(self):
        self.assertEqual(bt.infer_interval_ms([]), HOUR)
        self.assertEqual(bt.infer_interval_ms(candles_of(100)), HOUR)
        self.assertEqual(bt.infer_interval_ms(candles_of(*([100] * 24), step=60_000)), 60_000)
        uneven = [bar(T0, 100), bar(T0 + 60_000, 100), bar(T0 + 8 * 60_000, 100), bar(T0 + 9 * 60_000, 100),
                  bar(T0 + 20 * 60_000, 100)]
        gaps = sorted([60_000, 420_000, 60_000, 660_000])
        self.assertEqual(bt.infer_interval_ms(uneven), gaps[len(gaps) // 2])  # 上中位数
        self.assertEqual(bt.infer_interval_ms(uneven), 420_000)

    def test_resolve_defaults_and_funding_hygiene(self):
        resolved = bt.resolve_sim_options({})
        self.assertEqual(resolved.initial_cash, 10_000)
        self.assertEqual(resolved.leverage, 1)
        self.assertEqual(resolved.fee_rate, 0.00045)
        self.assertEqual(resolved.slippage_bps, 2)
        self.assertIsNone(resolved.funding)
        messy = bt.resolve_sim_options({"funding": [{"t": 2, "rate": 0.1}, {"t": 1, "rate": 0.2},
                                                    {"t": float("nan"), "rate": 0.1}]})
        self.assertEqual([p["t"] for p in messy.funding], [1.0, 2.0])  # 排序 + 丢非有限
        self.assertEqual(bt.resolve_sim_options({"initialCash": -5}).initial_cash, 10_000)

    def test_run_backtest_wires_strategy_to_simulator(self):
        strategy = sa.load_strategy_file(os.path.join(EXAMPLES_DIR, "ema-cross.py"))
        candles = sa.synth_candles(300)
        out = bt.run_backtest(strategy, candles, {"fast": 5, "slow": 12},
                              {"initialCash": 5_000, "feeRate": 0.0005})
        self.assertEqual(out["candlesUsed"], 300)
        self.assertEqual(len(out["equity"]), 300)
        self.assertGreater(out["stats"]["fills"], 0)
        self.assertEqual(out["options"].initial_cash, 5_000)
        self.assertAlmostEqual(out["stats"]["finalEquity"], out["equity"][-1]["v"], delta=0.01)


# ───────────── 2. 跨引擎一致性（TS 模拟器夹具）─────────────


def _load_fixture():
    with open(os.path.join(FIXTURES, "ts-backtest.json"), "r", encoding="utf-8") as handle:
        return json.load(handle)


FIXTURE = _load_fixture()
CANDLE_SETS = {"main": FIXTURE["candles"], "crash": FIXTURE["candlesCrash"]}
STRATEGY_CACHE = {}


def python_strategy(name):
    if name not in STRATEGY_CACHE:
        STRATEGY_CACHE[name] = sa.load_strategy_file(os.path.join(EXAMPLES_DIR, "%s.py" % name))
    return STRATEGY_CACHE[name]


class CrossEngineTest(unittest.TestCase):
    """同一份 K 线 + 同一策略 + 同一假设 → 成交序列、权益、统计、资金费明细全部一致。"""

    maxDiff = None

    def assert_close(self, actual, expected, label):
        if isinstance(expected, bool) or expected is None:
            self.assertEqual(actual, expected, label)
            return
        if isinstance(expected, (int, float)):
            self.assertIsInstance(actual, (int, float), "%s: not a number (%r)" % (label, actual))
            self.assertLessEqual(abs(float(actual) - float(expected)), TOL * max(1.0, abs(float(expected))),
                                 "%s: %r != %r" % (label, actual, expected))
            return
        self.assertEqual(actual, expected, label)

    def run_case(self, case):
        candles = CANDLE_SETS[case["candles"]]
        strategy = python_strategy(case["strategy"])
        return bt.run_backtest(strategy, candles, case["params"], case["simOptions"]), candles

    def compare(self, case):
        out, candles = self.run_case(case)
        label = case["id"]

        # ① 成交序列：笔数、时间、方向、价、量、盈亏、手续费逐笔比对
        expected_trades = case["trades"]
        self.assertEqual(len(out["trades"]), len(expected_trades), "%s: fill count" % label)
        for i, (actual, expected) in enumerate(zip(out["trades"], expected_trades)):
            self.assertEqual(actual["side"], expected["side"], "%s[%d]: side" % (label, i))
            self.assertEqual(actual["t"], expected["t"], "%s[%d]: t" % (label, i))
            for field in ("price", "size", "pnl", "fee"):
                self.assert_close(actual[field], expected[field], "%s[%d].%s" % (label, i, field))

        # ② 逐根权益
        expected_equity = case["equity"]
        self.assertEqual(len(out["equity"]), len(expected_equity), "%s: equity length" % label)
        for i, (actual, expected) in enumerate(zip(out["equity"], expected_equity)):
            self.assertEqual(actual["t"], expected["t"], "%s equity[%d].t" % (label, i))
            self.assert_close(actual["v"], expected["v"], "%s equity[%d].v" % (label, i))
        self.assertEqual(len(out["equity"]), len(candles), "%s: one equity point per candle" % label)

        # ③ 统计：TS SimStats 的每个键都在，值一致
        for key, expected in case["stats"].items():
            self.assertIn(key, out["stats"], "%s: missing stat %s" % (label, key))
            self.assert_close(out["stats"][key], expected, "%s stats.%s" % (label, key))

        # ④ 资金费明细
        expected_funding = case["funding"]
        self.assertEqual(len(out["funding"]), len(expected_funding), "%s: funding points" % label)
        for i, (actual, expected) in enumerate(zip(out["funding"], expected_funding)):
            for field in ("t", "rate", "notional", "paid"):
                self.assert_close(actual[field], expected[field], "%s funding[%d].%s" % (label, i, field))
        return out

    # ---- 三个必测策略（走 TS 的公开路径 runBacktest）----

    def test_fixture_is_complete(self):
        ids = [case["id"] for case in FIXTURE["cases"]]
        self.assertGreaterEqual(len(FIXTURE["cases"]), 20)
        for required in ("ema-cross", "grid", "dca"):
            self.assertTrue(any(case["strategy"] == required for case in FIXTURE["cases"]),
                            "no consistency case for %s" % required)
        self.assertIn("ema-cross-defaults", ids)
        self.assertIn("grid-centered", ids)
        self.assertIn("dca-take-profit", ids)
        self.assertEqual(len(FIXTURE["candles"]), FIXTURE["meta"]["bars"])

    def test_consistency_ema_cross(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "ema-cross-defaults")
        out = self.compare(case)
        self.assertGreater(len(out["trades"]), 0)
        self.assertEqual(out["stats"]["fills"], len(case["trades"]))

    def test_consistency_grid(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "grid-centered")
        out = self.compare(case)
        self.assertGreater(len(out["trades"]), 5)

    def test_consistency_dca(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "dca-take-profit")
        out = self.compare(case)
        self.assertGreater(out["stats"]["trades"], 0)

    # ---- 扩展场景（资金费 / 强平 / 手数归一 / 成交量上限 / 保护规则 / 破产）----

    def test_consistency_ema_cross_with_funding_liquidation_and_lots(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "ema-cross-leverage-funding-liquidation-lot")
        out = self.compare(case)
        self.assertGreater(out["stats"]["fundingPaid"], 0)
        self.assertGreater(len(out["funding"]), 0)

    def test_consistency_grid_with_volume_cap(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "grid-volume-cap")
        out = self.compare(case)
        self.assertGreater(out["stats"]["unfilledShare"], 0)

    def test_consistency_dca_with_protection(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "dca-protection")
        out = self.compare(case)
        self.assertGreater(out["stats"]["protectionExits"], 0)
        self.assertTrue(any(t["reason"].startswith("protection:") for t in out["trades"]))

    def test_consistency_crash_liquidation(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "emas-crash-liquidation")
        out = self.compare(case)
        self.assertEqual(out["stats"]["liquidations"], 1)
        self.assertEqual(out["trades"][-1]["reason"], "liquidation")
        self.assertEqual(out["stats"]["finalEquity"], 0.0)

    def test_all_cases_are_compared(self):
        """兜底：夹具里的每个用例都跑一遍（新增用例不会因为没写测试而被漏掉）。"""
        for case in FIXTURE["cases"]:
            with self.subTest(case=case["id"]):
                self.compare(case)

    # ---- 十个示例策略 + 其余参数路径（P5.2 扩全）----

    def test_fixture_covers_all_ten_example_strategies(self):
        strategies = {case["strategy"] for case in FIXTURE["cases"]}
        self.assertEqual(strategies, {"breakout", "dca", "ema-cross", "grid", "martingale",
                                      "mean-reversion", "momentum-roc", "rsi-reversion",
                                      "supertrend", "trend-atr"})
        for name in strategies:
            with self.subTest(strategy=name):
                cases = [c for c in FIXTURE["cases"] if c["strategy"] == name]
                self.assertTrue(cases, "no case for %s" % name)
                self.assertTrue(all(c["trades"] for c in cases), "%s: a case has no fills" % name)

    def test_every_default_parameter_case_matches_ts(self):
        defaults = [c for c in FIXTURE["cases"] if c["id"].endswith("-defaults")]
        self.assertGreaterEqual(len(defaults), 7)
        for case in defaults:
            with self.subTest(case=case["id"]):
                out = self.compare(case)
                self.assertGreater(len(out["trades"]), 0)

    def test_fixture_exercises_every_simulator_option(self):
        seen = set()
        for case in FIXTURE["cases"]:
            seen.update(case["simOptions"].keys())
        for option in ("leverage", "feeRate", "slippageBps", "funding", "liquidation",
                       "maintenanceMarginRatio", "liquidationPenaltyRatio", "maxVolumeShare",
                       "protection", "lotStep", "minLot"):
            self.assertIn(option, seen, "no fixture case exercises %s" % option)

    def test_consistency_breakout_with_fees_slippage_and_leverage(self):
        case = next(c for c in FIXTURE["cases"] if c["id"] == "breakout-fees-slippage-leverage")
        out = self.compare(case)
        self.assertGreater(out["stats"]["feesPaid"], 0)
        self.assertEqual(case["simOptions"]["slippageBps"], 25)

    def test_consistency_zero_fees_and_zero_slippage(self):
        case = next(c for c in FIXTURE["cases"]
                    if c["id"] == "mean-reversion-zero-fees-zero-slippage")
        out = self.compare(case)
        self.assertEqual(out["stats"]["feesPaid"], 0.0)

    def test_consistency_momentum_with_volume_cap_and_funding(self):
        case = next(c for c in FIXTURE["cases"]
                    if c["id"] == "momentum-roc-volume-cap-and-funding")
        out = self.compare(case)
        self.assertGreater(out["stats"]["fundingPaid"], 0)
        self.assertGreater(out["stats"]["unfilledShare"], 0)

    def test_consistency_rsi_with_trailing_stop_and_time_limit(self):
        case = next(c for c in FIXTURE["cases"]
                    if c["id"] == "rsi-reversion-trailing-and-time-limit")
        out = self.compare(case)
        self.assertGreater(out["stats"]["protectionExits"], 0)
        reasons = {t["reason"] for t in out["trades"]}
        self.assertTrue(any(r.startswith("protection:") for r in reasons), reasons)

    def test_consistency_supertrend_with_max_slippage_and_lot_step(self):
        case = next(c for c in FIXTURE["cases"]
                    if c["id"] == "supertrend-max-slippage-max-volume")
        out = self.compare(case)
        for trade in out["trades"]:
            units = trade["size"] / 0.05
            self.assertLess(abs(units - round(units)), 1e-6)

    def test_consistency_trend_atr_with_liquidation_penalty_and_funding(self):
        case = next(c for c in FIXTURE["cases"]
                    if c["id"] == "trend-atr-liquidation-penalty")
        out = self.compare(case)
        self.assertNotEqual(out["stats"]["fundingPaid"], 0)
        self.assertGreaterEqual(out["stats"]["liquidations"], 0)

    def test_trade_reason_text_matches_ts(self):
        """成交理由文案也对齐（策略理由来自 examples/ 的 Python 移植，量的是同一套格式化口径）。"""
        mismatched = []
        for case in FIXTURE["cases"]:
            out, _ = self.run_case(case)
            for i, (actual, expected) in enumerate(zip(out["trades"], case["trades"])):
                if actual["reason"] != expected["reason"]:
                    mismatched.append("%s[%d]: %r != %r" % (case["id"], i, actual["reason"], expected["reason"]))
        self.assertEqual(mismatched, [], "\n".join(mismatched[:5]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
