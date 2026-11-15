# SPDX-License-Identifier: CPAL-1.0
"""``backtest.run`` 全参数接线（标准库 unittest，离线）。

这一份测的是「GEP 面 → 模拟器」这一段：``backtest.run`` 收到的 ``BacktestSpec`` 有没有
真的变成 ``backtest.py``（``simulator.ts`` 的 Python 版）的选项，结果里的 ``assumptions``
写的是不是实际采用值，以及策略目录里的 ``.py`` 策略能不能被回测。

参数路径逐条覆盖：费率（对象 / ``venue`` 问宿主 / 回落）、滑点、资金费（宿主点 / 无点 /
窗口外）、强平（开关 / 维持保证金比例 / 罚金）、单根成交量上限（含零成交量）、保护规则
（止损 / 时限）、手数归一（``lotStep`` / ``minLot``）。保护与手数在 ``BacktestSpec`` 里
没有协议字段，走厂商扩展对象 ``spec["x-simulation"]``（协议为 ``x-`` 键留的位置）。

跑法：
    python -m unittest packages/engine-python/tests/test_backtest_gep.py -v
"""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine import gep  # noqa: E402
from engine import limits as limit_mod  # noqa: E402

TOKEN = 'unit-test-token-not-a-secret'
BTC = 'hyperliquid:BTC-USD'
PAPER = 'acct_paper01'
MANDATE = 'mnd_01JAB0000000000000000000'
BINDING = 'bnd_01JAB0000000000000000000'
T0 = 1_760_000_000_000
MINUTE = 60_000


# ───────────── 合成输入 ─────────────


def flat(count, price=100.0, start=T0, step=MINUTE, volume=1_000.0):
    """平盘 K 线：开高低收都等于 ``price``。"""
    return [{'t': start + i * step, 'o': price, 'h': price, 'l': price, 'c': price, 'v': volume}
            for i in range(count)]


def ramp(count, first=100.0, last=120.0, start=T0, step=MINUTE, volume=1_000.0):
    """单调上行，让内置 SMA 交叉在预热后做多。"""
    out = []
    for i in range(count):
        price = first + (last - first) * i / float(max(1, count - 1))
        out.append({'t': start + i * step, 'o': price, 'h': price * 1.001,
                    'l': price * 0.999, 'c': price, 'v': volume})
    return out


def rising_then(count, crash_low_ratio, drop_close_ratio):
    """上行 70 根（做多）后接一根急跌，用于强平 / 保护规则。"""
    out = ramp(count - 1, 100.0, 130.0)
    previous = out[-1]['c']
    out.append({'t': out[-1]['t'] + MINUTE, 'o': previous,
                'h': previous, 'l': previous * crash_low_ratio,
                'c': previous * drop_close_ratio, 'v': 1_000.0})
    return out


class Venue(object):
    """宿主侧假实现：行情 / 资金费点 / 合约费率表，都可关掉以测降级。"""

    def __init__(self, candles, funding=(), fee_table=None, funding_error=False,
                 instruments_error=False, bars_override=None):
        self.candles = candles
        self.funding = list(funding)
        self.fee_table = fee_table
        self.funding_error = funding_error
        self.instruments_error = instruments_error
        self.bars_override = bars_override
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, dict(params or {})))
        if method == 'host.describe':
            return {'result': {'host': {'name': 'unit-test-host', 'version': '0.1.0'},
                               'venues': [],
                               'accounts': [{'accountId': PAPER, 'alias': 'paper',
                                             'venue': 'hyperliquid', 'environment': 'mainnet',
                                             'mode': 'paper'}]}}
        if method == 'host.instruments':
            if self.instruments_error or self.fee_table is None:
                return {'error': {'code': -32601, 'message': 'no instrument metadata'}}
            return {'result': {'instruments': [
                {'instrumentId': BTC, 'fees': dict(self.fee_table)}]}}
        if method == 'host.market.history':
            return {'result': {'candles': list(self.candles),
                               'source': 'unit-test-synthetic', 'complete': True}}
        if method == 'host.market.fundingHistory':
            if self.funding_error:
                return {'error': {'code': -32601, 'message': 'no funding history'}}
            return {'result': {'points': [dict(p) for p in self.funding], 'complete': True}}
        return {'error': {'code': -32601, 'message': 'unknown host method'}}

    def methods(self):
        return [name for name, _ in self.calls]


class Harness(object):
    """一个进程内的 GEP 会话（不 spawn 引擎，只驱动 ``gep.process_line``）。"""

    def __init__(self, venue=None, strategy_dir=None, limits=None):
        self.frames = []
        self.host = venue or Venue(ramp(140))
        self.conn = gep.Conn(write=self.frames.append, host_stub=self.host)
        self.conn.token = TOKEN
        if strategy_dir is not None:
            self.conn.strategy_dir = strategy_dir
            self.conn.library = None
        if limits is not None:
            self.conn.limits = limits
        self._id = 0

    def request(self, method, params=None):
        self._id += 1
        message = {'jsonrpc': '2.0', 'id': self._id, 'method': method}
        if params is not None:
            message['params'] = params
        before = len(self.frames)
        gep.process_line(self.conn, json.dumps(message))
        for frame in self.frames[before:]:
            if isinstance(frame, dict) and frame.get('id') == self._id:
                return frame
        raise AssertionError('%s produced no response frame' % method)

    def call(self, method, params=None):
        frame = self.request(method, params)
        if 'error' in frame:
            raise AssertionError('%s failed: %s' % (method, json.dumps(frame['error'])))
        return frame['result']

    def error_of(self, method, params=None):
        frame = self.request(method, params)
        if 'error' not in frame:
            raise AssertionError('%s unexpectedly succeeded' % method)
        return frame['error']

    def startup(self):
        self.request('gep.hello', {'protocol': 'gep', 'versions': ['0.1'],
                                   'host': {'name': 'unit-test-host', 'version': '0.1.0'},
                                   'auth': {'token': TOKEN}})
        self.call('engine.bind', {'bindingId': BINDING,
                                  'accounts': [{'accountId': PAPER, 'mode': 'A',
                                                'mandateId': MANDATE}],
                                  'data': {'source': 'host', 'instruments': [BTC]},
                                  'policies': [], 'heartbeatMs': 5000})
        return self

    def spec(self, candles, params=None, strategy_id=None, **overrides):
        first = candles[0]['t']
        last = candles[-1]['t']
        spec = {
            'subject': {'strategy': {'id': strategy_id or gep.STRATEGY_ID,
                                     'version': gep.STRATEGY_VERSION,
                                     'params': params or {}}},
            'instruments': [BTC], 'interval': '1m',
            'from': first, 'to': last + 1,
            'data': {'source': 'host'},
            'account': {'initialBalance': '10000', 'ccy': 'USDC'},
            'assumptions': {'fees': {'maker': '0.00015', 'taker': '0.00045'},
                            'slippageBps': 0, 'fillModel': 'next-bar-open',
                            'funding': False, 'liquidation': False},
            'seed': 42,
        }
        for key, value in overrides.items():
            if key in ('assumptions', 'account'):
                spec[key].update(value)
            else:
                spec[key] = value
        return spec

    def state_of(self, job_id):
        return self.conn.jobs[job_id]['state']

    def wait(self, job_id, timeout_s=30.0):
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            state = self.state_of(job_id)
            if state in ('done', 'failed', 'cancelled'):
                return state
            time.sleep(0.01)
        raise AssertionError('backtest job did not settle')

    def run(self, spec, timeout_s=30.0):
        job_id = self.call('backtest.run', {'spec': spec})['jobId']
        state = self.wait(job_id, timeout_s)
        if state != 'done':
            raise AssertionError('job %s: %s' % (state,
                                                 json.dumps(self.conn.jobs[job_id].get('error'))))
        return self.call('backtest.result', {'jobId': job_id})


def positions_by_bar(result):
    """从成交序列重建「每根 K 线的持仓」（成交当根即生效）。"""
    out = {}
    position = 0.0
    for trade in result['trades']:
        position += trade['size'] if trade['side'] == 'buy' else -trade['size']
        out[trade['t']] = position
    return out


def position_at(result, t):
    position = 0.0
    for trade in result['trades']:
        if trade['t'] > t:
            break
        position += trade['size'] if trade['side'] == 'buy' else -trade['size']
    return position


# ───────────── 费率 / 滑点 ─────────────


class FeeAndSlippageTests(unittest.TestCase):
    def test_fees_are_charged_on_every_fill_at_the_spec_rate(self):
        h = Harness(Venue(ramp(140))).startup()
        result = h.run(h.spec(ramp(140), assumptions={
            'fees': {'maker': '0.0001', 'taker': '0.001'}}))
        self.assertGreater(len(result['trades']), 0)
        total = sum(trade['fee'] for trade in result['trades'])
        self.assertAlmostEqual(result['stats']['feesPaid'], total, places=9)
        self.assertGreater(total, 0.0)
        for trade in result['trades']:
            self.assertAlmostEqual(trade['fee'], trade['size'] * trade['price'] * 0.001,
                                   delta=trade['price'] * 1e-12)

    def test_venue_fees_are_read_from_host_instruments(self):
        venue = Venue(ramp(140), fee_table={'maker': '0.0002', 'taker': '0.0006'})
        h = Harness(venue).startup()
        result = h.run(h.spec(ramp(140), assumptions={'fees': 'venue'}))
        self.assertIn('host.instruments', venue.methods())
        self.assertEqual(result['assumptions']['fees']['taker'], '0.0006')
        self.assertEqual(result['assumptions']['fees']['maker'], '0.0002')
        self.assertFalse(any('default taker' in w for w in result['warnings']))

    def test_venue_fees_fall_back_to_the_default_and_say_so(self):
        venue = Venue(ramp(140), fee_table=None)
        h = Harness(venue).startup()
        result = h.run(h.spec(ramp(140), assumptions={'fees': 'venue'}))
        self.assertEqual(result['assumptions']['fees']['taker'], gep.DEFAULT_TAKER)
        self.assertTrue(any('default taker' in w for w in result['warnings']))

    def test_slippage_moves_buys_up_and_sells_down(self):
        candles = ramp(140)
        h = Harness(Venue(candles)).startup()
        free = h.run(h.spec(candles, assumptions={'slippageBps': 0}))
        slipped = h.run(h.spec(candles, assumptions={'slippageBps': 100}))
        buys_free = [t['price'] for t in free['trades'] if t['side'] == 'buy']
        buys_slip = [t['price'] for t in slipped['trades'] if t['side'] == 'buy']
        self.assertEqual(len(buys_free), len(buys_slip))
        for plain, slipped_price in zip(buys_free, buys_slip):
            self.assertGreater(slipped_price, plain)
        self.assertLessEqual(slipped['stats']['finalEquity'], free['stats']['finalEquity'] + 1e-6)
        self.assertEqual(slipped['assumptions']['slippageBps'], 100.0)

    def test_zero_fee_and_zero_slippage_are_honoured(self):
        h = Harness(Venue(ramp(140))).startup()
        result = h.run(h.spec(ramp(140), assumptions={
            'fees': {'maker': '0', 'taker': '0'}, 'slippageBps': 0}))
        self.assertEqual(result['stats']['feesPaid'], 0.0)
        self.assertEqual(result['assumptions']['fees']['taker'], '0')


# ───────────── 资金费 ─────────────


class FundingTests(unittest.TestCase):
    def _points(self, candles, every=5, rate=0.0001):
        return [{'t': candles[i]['t'], 'rate': rate}
                for i in range(every, len(candles), every)]

    def test_funding_points_from_the_host_are_settled(self):
        candles = ramp(140)
        points = self._points(candles)
        h = Harness(Venue(candles, funding=points)).startup()
        result = h.run(h.spec(candles, assumptions={'funding': True}))
        self.assertIs(result['assumptions']['funding'], True)
        self.assertIn('host.market.fundingHistory', h.host.methods())
        self.assertIn('funding', result)
        # 只有持仓期间的资金费点才结算（空仓不产生 paid 记录）
        self.assertLessEqual(len(result['funding']), len(points))
        self.assertGreater(len(result['funding']), 0)
        closes = {bar['t']: bar['c'] for bar in candles}
        for entry in result['funding']:
            position = position_at(result, entry['t'])
            self.assertAlmostEqual(entry['paid'], position * closes[entry['t']] * 0.0001,
                                   delta=abs(entry['paid']) * 1e-9 + 1e-9)
            self.assertAlmostEqual(entry['notional'], abs(position) * closes[entry['t']],
                                   delta=1e-9)
        self.assertAlmostEqual(result['stats']['fundingPaid'],
                               sum(entry['paid'] for entry in result['funding']), places=6)

    def test_short_positions_receive_a_positive_rate(self):
        candles = ramp(140)
        points = self._points(candles)
        h = Harness(Venue(candles, funding=points)).startup()
        result = h.run(h.spec(candles, assumptions={'funding': True},
                              params={'fastPeriod': 2, 'slowPeriod': 3, 'warmupBars': 0}))
        shorts = [e for e in result.get('funding', []) if position_at(result, e['t']) < 0]
        if shorts:
            for entry in shorts:
                self.assertLess(entry['paid'], 0.0)

    def test_funding_without_host_data_is_false_and_warned(self):
        candles = ramp(140)
        h = Harness(Venue(candles, funding_error=True)).startup()
        result = h.run(h.spec(candles, assumptions={'funding': True}))
        self.assertIs(result['assumptions']['funding'], False)
        self.assertTrue(any('fundingHistory unavailable' in w for w in result['warnings']))
        self.assertNotIn('funding', result)

    def test_funding_points_outside_the_window_are_dropped(self):
        candles = ramp(140)
        outside = [{'t': candles[0]['t'] - 10 * MINUTE, 'rate': 0.001},
                   {'t': candles[-1]['t'] + 10 * MINUTE, 'rate': 0.001}]
        h = Harness(Venue(candles, funding=outside)).startup()
        result = h.run(h.spec(candles, assumptions={'funding': True}))
        self.assertIs(result['assumptions']['funding'], False)
        self.assertTrue(any('no funding points in range' in w for w in result['warnings']))

    def test_funding_is_off_unless_the_spec_asks(self):
        candles = ramp(140)
        h = Harness(Venue(candles, funding=self._points(candles))).startup()
        result = h.run(h.spec(candles, assumptions={'funding': False}))
        self.assertIs(result['assumptions']['funding'], False)
        self.assertNotIn('host.market.fundingHistory', h.host.methods())
        self.assertEqual(result['stats']['fundingPaid'], 0.0)


# ───────────── 强平 ─────────────


class LiquidationTests(unittest.TestCase):
    def test_liquidation_fires_on_a_crash(self):
        candles = rising_then(71, 0.75, 0.78)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles, assumptions={'liquidation': True},
                              account={'leverage': 10, 'maintenanceMarginRatio': 0.02,
                                       'initialBalance': '10000'}))
        self.assertIs(result['assumptions']['liquidation'], True)
        self.assertGreaterEqual(result['stats']['liquidations'], 1)
        self.assertEqual(result['trades'][-1]['reason'], 'liquidation')
        self.assertTrue(any('liquidation is modelled' in w for w in result['warnings']))

    def test_liquidation_is_off_by_default(self):
        candles = rising_then(71, 0.75, 0.78)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles, assumptions={'liquidation': False},
                              account={'leverage': 10}))
        self.assertIs(result['assumptions']['liquidation'], False)
        self.assertEqual(result['stats']['liquidations'], 0)
        self.assertFalse(any(t['reason'] == 'liquidation' for t in result['trades']))

    def test_maintenance_margin_ratio_moves_the_liquidation_point(self):
        candles = rising_then(71, 0.95, 0.96)
        h = Harness(Venue(candles)).startup()
        loose = h.run(h.spec(candles, assumptions={'liquidation': True},
                             account={'leverage': 2, 'maintenanceMarginRatio': 0.05}))
        tight = h.run(h.spec(candles, assumptions={'liquidation': True},
                             account={'leverage': 2, 'maintenanceMarginRatio': 0.5}))
        self.assertEqual(loose['stats']['liquidations'], 0)
        self.assertGreaterEqual(tight['stats']['liquidations'], 1)
        self.assertEqual(tight['assumptions']['x-maintenanceMarginRatio'], 0.5)

    def test_liquidation_penalty_is_deducted_and_echoed(self):
        # 8% 急跌 + 10 倍杠杆 + 5% 维持保证金：强平后现金仍为正（不破产），罚金才看得见
        candles = rising_then(71, 0.92, 0.93)
        h = Harness(Venue(candles)).startup()
        plain = h.run(h.spec(candles, assumptions={'liquidation': True},
                             account={'leverage': 10, 'maintenanceMarginRatio': 0.05}))
        fined = h.run(h.spec(candles, assumptions={'liquidation': True,
                                                   'liquidationPenaltyRatio': 0.5},
                             account={'leverage': 10, 'maintenanceMarginRatio': 0.05}))
        self.assertEqual(plain['stats']['liquidations'], 1)
        self.assertEqual(plain['assumptions']['liquidationPenaltyRatio'], 0.0)
        self.assertEqual(fined['assumptions']['liquidationPenaltyRatio'], 0.5)
        self.assertGreater(plain['stats']['finalEquity'], 0.0)
        self.assertLess(fined['stats']['finalEquity'], plain['stats']['finalEquity'])


# ───────────── 成交量上限 ─────────────


class VolumeCapTests(unittest.TestCase):
    def test_volume_cap_limits_the_fill_and_reports_unfilled_share(self):
        candles = ramp(140, volume=0.5)
        h = Harness(Venue(candles)).startup()
        uncapped = h.run(h.spec(candles))
        capped = h.run(h.spec(candles, assumptions={'maxVolumeShare': 0.01}))
        self.assertEqual(capped['assumptions']['maxVolumeShare'], 0.01)
        self.assertGreater(capped['stats']['unfilledShare'], 0.5)
        self.assertEqual(uncapped['stats']['unfilledShare'], 0.0)
        self.assertGreater(capped['stats']['finalEquity'], 0.0)

    def test_zero_volume_bars_do_not_fill(self):
        candles = ramp(140, volume=0.0)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles, assumptions={'maxVolumeShare': 0.5}))
        self.assertEqual(result['trades'], [])
        self.assertEqual(result['stats']['fills'], 0)


# ───────────── 保护规则 ─────────────


class ProtectionTests(unittest.TestCase):
    def test_stop_loss_exits_and_is_echoed(self):
        candles = rising_then(71, 0.95, 0.96)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles, **{'x-simulation': {
            'protection': {'stopLossPct': 0.02}}}))
        reasons = [t['reason'] for t in result['trades']]
        self.assertTrue(any(r.startswith('protection:') for r in reasons), reasons)
        self.assertGreaterEqual(result['stats']['protectionExits'], 1)
        self.assertEqual(result['assumptions']['x-protection']['stopLossPct'], 0.02)

    def test_time_limit_exits_at_the_close(self):
        candles = ramp(140)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles, **{'x-simulation': {
            'protection': {'maxHoldBars': 3}}}))
        self.assertTrue(any(t['reason'] == 'protection:time_limit' for t in result['trades']))
        self.assertGreaterEqual(result['stats']['protectionExits'], 1)

    def test_no_protection_block_means_no_protection_trades(self):
        candles = rising_then(71, 0.9, 0.91)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles))
        self.assertEqual(result['stats']['protectionExits'], 0)
        self.assertNotIn('x-protection', result['assumptions'])


# ───────────── 手数归一 ─────────────


class LotNormalizationTests(unittest.TestCase):
    def test_lot_step_rounds_every_fill(self):
        candles = ramp(140)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles, **{'x-simulation': {'lotStep': 0.1}}))
        self.assertGreater(len(result['trades']), 0)
        for trade in result['trades']:
            units = trade['size'] / 0.1
            self.assertLess(abs(units - round(units)), 1e-6, trade['size'])
        self.assertEqual(result['assumptions']['x-lotStep'], 0.1)

    def test_min_lot_blocks_a_fill(self):
        candles = ramp(140)
        h = Harness(Venue(candles)).startup()
        plain = h.run(h.spec(candles))
        blocked = h.run(h.spec(candles, **{'x-simulation': {'lotStep': 50, 'minLot': 500}}))
        self.assertGreater(len(plain['trades']), 0)
        self.assertEqual(blocked['trades'], [])
        self.assertEqual(blocked['stats']['fills'], 0)
        self.assertEqual(blocked['assumptions']['x-minLot'], 500.0)


# ───────────── 结果形状 / 确定性 ─────────────


class ResultShapeTests(unittest.TestCase):
    def test_all_simulator_stats_are_reported(self):
        h = Harness(Venue(ramp(140))).startup()
        result = h.run(h.spec(ramp(140)))
        for key in ('totalReturnRatio', 'annualizedRatio', 'maxDrawdownRatio', 'sharpe',
                    'sortino', 'winRatio', 'profitFactor', 'trades', 'fills',
                    'avgHoldBars', 'spanDays', 'finalEquity', 'fundingPaid', 'feesPaid',
                    'liquidations', 'protectionExits', 'unfilledShare'):
            self.assertIn(key, result['stats'])

    def test_one_equity_point_per_candle(self):
        candles = ramp(140)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles))
        self.assertEqual(len(result['equity']), len(candles))
        self.assertEqual([p['t'] for p in result['equity']], [bar['t'] for bar in candles])

    def test_open_position_is_reported_when_the_run_ends_holding(self):
        candles = ramp(140)
        h = Harness(Venue(candles)).startup()
        result = h.run(h.spec(candles))
        self.assertIsNotNone(result['openPosition'])
        self.assertEqual(result['openPosition']['side'], 'long')
        self.assertGreater(result['openPosition']['size'], 0.0)

    def test_assumptions_echo_every_applied_option(self):
        candles = ramp(140)
        points = [{'t': candles[i]['t'], 'rate': 0.0001} for i in range(5, len(candles), 7)]
        h = Harness(Venue(candles, funding=points)).startup()
        result = h.run(h.spec(candles, assumptions={
            'fees': {'maker': '0.0001', 'taker': '0.0007'}, 'slippageBps': 5,
            'funding': True, 'liquidation': True, 'maxVolumeShare': 0.5,
            'liquidationPenaltyRatio': 0.1}, account={'leverage': 3,
                                                      'maintenanceMarginRatio': 0.04},
            **{'x-simulation': {'protection': {'takeProfitPct': 0.5}, 'lotStep': 0.01}}))
        assumptions = result['assumptions']
        self.assertEqual(gep.missing_assumptions(assumptions), [])
        self.assertEqual(assumptions['fees'], {'maker': '0.0001', 'taker': '0.0007'})
        self.assertEqual(assumptions['slippageBps'], 5.0)
        self.assertEqual(assumptions['fillModel'], 'next-bar-open')
        self.assertIs(assumptions['funding'], True)
        self.assertIs(assumptions['liquidation'], True)
        self.assertEqual(assumptions['maxVolumeShare'], 0.5)
        self.assertEqual(assumptions['liquidationPenaltyRatio'], 0.1)
        self.assertEqual(assumptions['x-maintenanceMarginRatio'], 0.04)
        self.assertEqual(assumptions['x-lotStep'], 0.01)

    def test_a_spec_with_every_option_is_byte_identical_twice(self):
        candles = ramp(140)
        points = [{'t': candles[i]['t'], 'rate': 0.0001} for i in range(5, len(candles), 7)]
        h = Harness(Venue(candles, funding=points)).startup()
        spec = h.spec(candles, assumptions={'funding': True, 'liquidation': True,
                                            'maxVolumeShare': 0.8,
                                            'liquidationPenaltyRatio': 0.05},
                      account={'leverage': 4, 'maintenanceMarginRatio': 0.02},
                      **{'x-simulation': {'protection': {'stopLossPct': 0.2},
                                          'lotStep': 0.01, 'minLot': 0.01}})
        first = dict(h.run(spec))
        second = dict(h.run(spec))
        first.pop('jobId')
        second.pop('jobId')
        self.assertEqual(gep.canonical_json(first), gep.canonical_json(second))


# ───────────── 策略目录里的 .py 策略 ─────────────


FLAT_STRATEGY = '''
def evaluate(candles, params):
    n = len(candles)
    hold = int(params["longBars"])
    target = [1.0 if 5 <= i < 5 + hold else 0.0 for i in range(n)]
    reasons = [""] * n
    for i in range(1, n):
        if target[i] != target[i - 1]:
            reasons[i] = "step in" if target[i] else "step out"
    return {"target": target, "reasons": reasons, "overlays": {}, "warmup": 5}


STRATEGY = {
    "id": "stepper",
    "name": "Stepper",
    "version": "1.0.0",
    "desc": "long for a while, then flat: a deterministic series for wiring tests",
    "tags": ["test"],
    "params": [
        {"key": "longBars", "label": "Long bars", "type": "integer", "default": 10, "min": 1, "max": 100},
    ],
    "evaluate": evaluate,
}
'''

LOOPING_STRATEGY = '''
def evaluate(candles, params):
    while True:
        pass


STRATEGY = {
    "id": "spinner",
    "name": "Spinner",
    "version": "1.0.0",
    "desc": "evaluate never returns",
    "tags": ["test"],
    "params": [],
    "evaluate": evaluate,
}
'''


class FolderStrategyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix='gep-bt-')

    def tearDown(self):
        shutil.rmtree(self.folder, ignore_errors=True)

    def write(self, name, body):
        path = os.path.join(self.folder, name)
        with open(path, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(body)
        return path

    def test_a_folder_strategy_is_backtested_in_the_sandbox(self):
        path = self.write('stepper.py', FLAT_STRATEGY)
        candles = ramp(60)
        h = Harness(Venue(candles), strategy_dir=self.folder).startup()
        result = h.run(h.spec(candles, strategy_id='stepper', params={'longBars': 5}))
        self.assertEqual(len(result['trades']), 2)
        self.assertEqual([t['side'] for t in result['trades']], ['buy', 'sell'])
        self.assertEqual([t['reason'] for t in result['trades']], ['step in', 'step out'])
        with open(path, 'rb') as handle:
            import hashlib
            self.assertEqual(result['strategySha256'],
                             'sha256:' + hashlib.sha256(handle.read()).hexdigest())

    def test_folder_strategy_params_are_validated_against_its_declaration(self):
        self.write('stepper.py', FLAT_STRATEGY)
        candles = ramp(60)
        h = Harness(Venue(candles), strategy_dir=self.folder).startup()
        problem = h.error_of('backtest.run', {'spec': h.spec(
            candles, strategy_id='stepper', params={'nope': 1})})
        self.assertEqual(problem['code'], -32602)
        problem = h.error_of('backtest.run', {'spec': h.spec(
            candles, strategy_id='stepper', params={'longBars': 'x'})})
        self.assertEqual(problem['code'], -32602)

    def test_unknown_strategy_id_is_refused_with_the_loaded_list(self):
        h = Harness(Venue(ramp(60)), strategy_dir=self.folder).startup()
        problem = h.error_of('backtest.run', {'spec': h.spec(ramp(60), strategy_id='ghost')})
        self.assertEqual(problem['code'], -32602)
        self.assertIn('sma-cross', problem['data']['message'])

    def test_a_hanging_signal_pass_is_killed_and_the_engine_survives(self):
        self.write('spinner.py', LOOPING_STRATEGY)
        candles = ramp(60)
        harness = Harness(Venue(candles), strategy_dir=self.folder,
                          limits=limit_mod.Limits(hook_timeout_s=1.5,
                                                  backtest_timeout_s=3.0))
        harness.startup()
        job_id = harness.call('backtest.run', {'spec': harness.spec(
            candles, strategy_id='spinner')})['jobId']
        self.assertEqual(harness.wait(job_id, timeout_s=30.0), 'failed')
        job_error = harness.conn.jobs[job_id]['error']
        self.assertEqual(job_error['code'], 4002)
        self.assertIn('signal series', job_error['message'])
        self.assertEqual(harness.call('engine.health')['status'], 'ok')


# ───────────── 参数校验（扩展对象 / 账户） ─────────────


class SpecValidationTests(unittest.TestCase):
    def _problem(self, **overrides):
        h = Harness(Venue(ramp(60))).startup()
        return h.error_of('backtest.run', {'spec': h.spec(ramp(60), **overrides)})

    def test_x_simulation_bad_values_are_refused(self):
        for block in ({'lotStep': 0}, {'lotStep': -1}, {'minLot': -1}, {'protection': 5},
                      {'nonsense': 1}, 'not-an-object'):
            with self.subTest(block=block):
                self.assertEqual(self._problem(**{'x-simulation': block})['code'], -32602)

    def test_x_simulation_is_optional(self):
        h = Harness(Venue(ramp(60))).startup()
        result = h.run(h.spec(ramp(60)))
        self.assertNotIn('x-lotStep', result['assumptions'])

    def test_leverage_and_maintenance_margin_are_validated(self):
        for account in ({'leverage': 0}, {'leverage': 51}, {'leverage': 'x'},
                        {'maintenanceMarginRatio': -0.1},
                        {'maintenanceMarginRatio': 'x'}):
            with self.subTest(account=account):
                self.assertEqual(self._problem(account=account)['code'], -32602)

    def test_volume_share_and_penalty_are_validated(self):
        for assumptions in ({'maxVolumeShare': 1.5}, {'maxVolumeShare': -0.1},
                            {'liquidationPenaltyRatio': -1}):
            with self.subTest(assumptions=assumptions):
                self.assertEqual(self._problem(assumptions=assumptions)['code'], -32602)

    def test_funding_and_liquidation_must_be_booleans(self):
        for assumptions in ({'funding': 'yes'}, {'liquidation': 1}):
            with self.subTest(assumptions=assumptions):
                self.assertEqual(self._problem(assumptions=assumptions)['code'], -32602)


if __name__ == '__main__':
    unittest.main(verbosity=2)
