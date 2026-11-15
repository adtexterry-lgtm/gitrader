# SPDX-License-Identifier: CPAL-1.0
"""Unit tests for the GEP frame / dispatch layer (Python standard library only).

Run from the repository root::

    python -m unittest packages/engine-python/tests/test_gep.py

or from ``packages/engine-python``::

    python -m unittest tests/test_gep.py

Everything is offline and in process: the engine talks to a fake host
(``host.describe`` / ``host.market.history``) and every frame the engine writes
is captured in a list, so framing, error codes and event envelopes are asserted
exactly.
"""

import io
import json
import math
import os
import re
import subprocess
import sys
import time
import unittest
from unittest import mock

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

from engine import gep  # noqa: E402

PAPER = 'acct_01JABAPAPER000000000000001'
LIVE = 'acct_01JAB0QZ8W3K5M7N9P1R3T5V7X'
MANDATE = 'mdt_01JABAENG01'
BINDING_ID = 'bind_01JABCCONF01'
TOKEN = 'conformance-token'
BTC = 'hyperliquid:BTC'
T0 = 1_790_000_000_000

# engine-side methods of packages/protocol/src/gep/methods.ts (non-notification)
ENGINE_METHODS = (
    'gep.hello', 'engine.describe', 'engine.bind', 'engine.health', 'engine.snapshot',
    'engine.halt', 'engine.resume', 'engine.shutdown', 'events.subscribe',
    'events.unsubscribe', 'risk.policy.push',
    'strategy.list', 'strategy.params', 'strategy.start', 'strategy.stop',
    'strategy.update', 'strategy.status',
    'backtest.run', 'backtest.status', 'backtest.result', 'backtest.cancel',
    'replay.start', 'replay.stop', 'replay.status',
    'order.place', 'order.amend', 'order.cancel', 'order.cancelAll', 'account.snapshot',
    'market.subscribe', 'market.snapshot', 'market.history',
)

# describe.ts GEP_CAPABILITY_KEYS
CAPABILITY_KEYS = (
    'execution.modeA', 'execution.modeB', 'market.useHost', 'market.own', 'strategy',
    'strategy.hotUpdate', 'backtest', 'backtest.fillModels', 'replay', 'events.resume',
    'events.retention', 'risk.cooperative', 'halt.levels', 'builder.attach', 'decision.log',
)

# methods.ts X_GITRADER_CAPABILITIES：厂商扩展能力位（协议 schema 允许 `x-` 前缀）
X_CAPABILITY_KEYS = (
    'x-gitrader.workflow', 'x-gitrader.strategy-folder',
)

SHA256_RE = re.compile(r'^sha256:[0-9a-f]{64}$')
INSTANCE_ID_RE = re.compile(r'^inst_[0-9A-Za-z]{3,26}$')


def synth_candles(count, start=T0, step=60_000, base=2400.0):
    """Deterministic synthetic bars (sine plus a slow drift); no recorded data."""
    out = []
    previous = base
    for i in range(count):
        close = round(base + 80.0 * math.sin(i / 25.0) + 0.01 * i, 4)
        out.append({'t': start + i * step, 'o': previous, 'h': max(previous, close) + 1.0,
                    'l': min(previous, close) - 1.0, 'c': close, 'v': 10.0})
        previous = close
    return out


def validate_against(schema, value, path='$'):
    """Tiny JSON Schema subset validator (type / required / min / max / pattern / enum)."""
    problems = []
    expected = schema.get('type')
    if expected == 'object':
        if not isinstance(value, dict):
            return ['%s must be an object' % path]
        for key in schema.get('required', ()):
            if key not in value:
                problems.append('%s.%s is required' % (path, key))
        properties = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            for key in value:
                if key not in properties:
                    problems.append('%s.%s is not allowed' % (path, key))
        for key, sub in properties.items():
            if key in value:
                problems.extend(validate_against(sub, value[key], '%s.%s' % (path, key)))
    elif expected == 'integer':
        if not isinstance(value, int) or isinstance(value, bool):
            return ['%s must be an integer' % path]
        if 'minimum' in schema and value < schema['minimum']:
            problems.append('%s below minimum' % path)
        if 'maximum' in schema and value > schema['maximum']:
            problems.append('%s above maximum' % path)
    elif expected == 'string':
        if not isinstance(value, str):
            return ['%s must be a string' % path]
        if 'pattern' in schema and not re.match(schema['pattern'], value):
            problems.append('%s does not match %s' % (path, schema['pattern']))
    if 'enum' in schema and value not in schema['enum']:
        problems.append('%s is not one of %s' % (path, schema['enum']))
    return problems


class FakeHost(object):
    """The host side of GEP, in process: only the two methods the engine calls."""

    def __init__(self, accounts=(PAPER, LIVE), bars=200, history_missing=False):
        self.accounts = list(accounts)
        self.bars = bars
        self.history_missing = history_missing
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, dict(params or {})))
        if method == 'host.describe':
            return {'result': {
                'host': {'name': 'unit-test-host', 'version': '0.1.0'},
                'venues': [],
                'accounts': [{'accountId': a, 'alias': 'paper', 'venue': 'hyperliquid',
                              'environment': 'mainnet', 'mode': 'paper'} for a in self.accounts],
            }}
        if method == 'host.market.history':
            if self.history_missing:
                return {'error': {'code': -32601, 'message': 'host keeps no history'}}
            start = params.get('from') or T0
            step = gep.INTERVAL_MS.get(params.get('interval') or '1m', 60_000)
            return {'result': {'candles': synth_candles(self.bars, start=start, step=step),
                               'source': 'unit-test-synthetic', 'complete': True}}
        return {'error': {'code': -32601, 'message': 'unknown host method'}}

    def methods(self):
        return [method for method, _ in self.calls]


class Harness(object):
    def __init__(self, host=None):
        self.frames = []
        self.host = host or FakeHost()
        self.conn = gep.Conn(write=self.frames.append, host_stub=self.host)
        self.conn.token = TOKEN
        self._id = 0

    # -- framing -----------------------------------------------------------
    def send_raw(self, text):
        before = len(self.frames)
        gep.process_line(self.conn, text)
        return self.frames[before:]

    def request(self, method, params=None):
        self._id += 1
        message = {'jsonrpc': '2.0', 'id': self._id, 'method': method}
        if params is not None:
            message['params'] = params
        frames = self.send_raw(json.dumps(message))
        for frame in frames:
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

    # -- handshake / setup -------------------------------------------------
    def hello(self, versions=('0.1',), token=TOKEN):
        return self.request('gep.hello', {
            'protocol': 'gep', 'versions': list(versions),
            'host': {'name': 'unit-test-host', 'version': '0.1.0'},
            'auth': {'token': token}})

    def bind(self, accounts=None, **overrides):
        params = {'bindingId': BINDING_ID,
                  'accounts': accounts or [{'accountId': PAPER, 'mode': 'A', 'mandateId': MANDATE}],
                  'data': {'source': 'host', 'instruments': [BTC]},
                  'policies': [], 'heartbeatMs': 5000}
        params.update(overrides)
        return self.call('engine.bind', params)

    def startup(self):
        self.hello()
        return self.bind()

    def start_instance(self, **overrides):
        body = {'strategyId': gep.STRATEGY_ID, 'accountId': PAPER, 'instruments': [BTC],
                'interval': '1m', 'params': {}, 'mandateId': MANDATE}
        body.update(overrides)
        return self.call('strategy.start', body)

    # -- events ------------------------------------------------------------
    def events(self):
        found = []
        for frame in self.frames:
            if isinstance(frame, dict) and frame.get('method') == 'events.push':
                found.extend((frame.get('params') or {}).get('events') or [])
        return found

    def feed(self, count, instrument=BTC, closed=True, prefix='evt_h'):
        events = []
        for i, candle in enumerate(synth_candles(count)):
            events.append({'seq': i + 1, 'eventId': '%s%08d' % (prefix, i + 1),
                           'stream': 'market', 'type': 'market.candle', 'ts': T0,
                           'instrumentId': instrument,
                           'data': {'interval': '1m', 'candle': candle, 'closed': closed}})
        before = len(self.frames)
        gep.process_line(self.conn, json.dumps({
            'jsonrpc': '2.0', 'method': 'events.push',
            'params': {'sessionId': self.conn.session_id, 'events': events}}))
        return self.frames[before:]

    # -- backtest ----------------------------------------------------------
    def spec(self, bars=200, params=None, source='host'):
        return {
            'subject': {'strategy': {'id': gep.STRATEGY_ID, 'version': gep.STRATEGY_VERSION,
                                     'params': params or {}}},
            'instruments': [BTC], 'interval': '1m', 'from': T0, 'to': T0 + bars * 60_000,
            'data': {'source': source},
            'account': {'initialBalance': '10000', 'ccy': 'USDC'},
            'assumptions': {'fees': 'venue', 'slippageBps': 2, 'fillModel': 'next-bar-open',
                            'funding': False, 'liquidation': False},
            'seed': 42,
        }

    def wait_job(self, job_id, timeout_s=10.0):
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            state = self.conn.jobs[job_id]['state']
            if state in ('done', 'failed', 'cancelled'):
                return state
            time.sleep(0.01)
        raise AssertionError('backtest job did not settle')


class FrameTests(unittest.TestCase):
    def test_single_request_frame(self):
        h = Harness()
        h.hello()
        frame = h.request('engine.health', {})
        self.assertEqual(frame['jsonrpc'], '2.0')
        self.assertEqual(frame['id'], 2)
        self.assertEqual(frame['result']['status'], 'ok')
        self.assertIsInstance(frame['result']['ts'], int)

    def test_batch_of_requests_answers_a_batch_in_order(self):
        h = Harness()
        h.hello()
        batch = [{'jsonrpc': '2.0', 'id': 91, 'method': 'engine.health'},
                 {'jsonrpc': '2.0', 'id': 92, 'method': 'engine.describe'},
                 {'jsonrpc': '2.0', 'id': 93, 'method': 'no.such.method'}]
        frames = h.send_raw(json.dumps(batch))
        self.assertEqual(len(frames), 1)
        answers = frames[0]
        self.assertIsInstance(answers, list)
        self.assertEqual([a['id'] for a in answers], [91, 92, 93])
        self.assertEqual(answers[2]['error']['code'], -32601)
        self.assertEqual(sum(1 for a in answers if 'result' in a), 2)

    def test_parse_error_frame_has_null_id(self):
        h = Harness()
        frames = h.send_raw('{"jsonrpc":"2.0",')
        self.assertEqual(len(frames), 1)
        self.assertIsNone(frames[0]['id'])
        self.assertEqual(frames[0]['error']['code'], -32700)
        self.assertEqual(frames[0]['error']['data']['category'], 'PROTOCOL')

    def test_payload_too_large_line_is_refused(self):
        h = Harness()
        huge = '{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"pad":"%s"}}' % (
            'x' * (gep.MAX_LINE_BYTES + 10))
        frames = h.send_raw(huge)
        self.assertEqual(frames[0]['error']['code'], 5007)
        self.assertEqual(frames[0]['error']['data']['name'], 'PAYLOAD_TOO_LARGE')

    def test_bom_is_stripped_and_blank_lines_ignored(self):
        h = Harness()
        h.hello()
        self.assertEqual(h.send_raw('\n   \n'), [])
        frames = h.send_raw('\ufeff' + json.dumps(
            {'jsonrpc': '2.0', 'id': 7, 'method': 'engine.health'}))
        self.assertEqual(frames[0]['id'], 7)
        self.assertIn('result', frames[0])

    def test_invalid_request_envelope(self):
        h = Harness()
        frames = h.send_raw(json.dumps({'id': 5, 'method': 'engine.health'}))
        self.assertEqual(frames[0]['error']['code'], -32600)


class HandshakeTests(unittest.TestCase):
    def test_hello_negotiates_highest_common_version(self):
        h = Harness()
        frame = h.hello(versions=['9.9', '0.1', '0.1.0'])
        self.assertEqual(frame['result']['version'], '0.1')
        self.assertEqual(frame['result']['engine']['id'], gep.ENGINE_ID)
        self.assertFalse(frame['result']['resumed'])
        self.assertRegex(frame['result']['sessionId'], r'^ses_')
        self.assertTrue(h.conn.authed)

    def test_hello_rejects_unsupported_version(self):
        h = Harness()
        frame = h.hello(versions=['9.9'])
        error = frame['error']
        self.assertEqual(error['code'], 5001)
        self.assertEqual(error['data']['name'], 'VERSION_UNSUPPORTED')
        self.assertEqual(error['data']['category'], 'PROTOCOL')
        self.assertFalse(h.conn.authed)

    def test_hello_rejects_wrong_token_and_asks_for_exit(self):
        h = Harness()
        frame = h.hello(token=TOKEN + '-wrong')
        error = frame['error']
        self.assertEqual(error['code'], 5003)
        self.assertEqual(error['data']['name'], 'AUTH_FAILED')
        self.assertTrue(h.conn.exit_requested)
        self.assertEqual(h.conn.exit_code, 1)
        self.assertFalse(h.conn.authed)

    def test_methods_require_hello_first(self):
        h = Harness()
        error = h.error_of('engine.describe')
        self.assertEqual(error['code'], 5003)
        self.assertFalse(h.conn.exit_requested)

    def test_resume_is_refused_because_retention_is_not_declared(self):
        h = Harness()
        frame = h.request('gep.hello', {'protocol': 'gep', 'versions': ['0.1'],
                                        'host': {'name': 'h', 'version': '0.1'},
                                        'auth': {'token': TOKEN},
                                        'resume': {'sessionId': 'ses_x', 'lastSeq': 3}})
        self.assertEqual(frame['error']['code'], 5004)


class ErrorModelTests(unittest.TestCase):
    def test_unknown_method_is_method_not_found(self):
        h = Harness()
        h.hello()
        error = h.error_of('no.such.method')
        self.assertEqual(error['code'], -32601)
        self.assertEqual(error['data']['category'], 'PROTOCOL')
        self.assertEqual(error['data']['code'], error['code'])

    def test_invalid_params_for_bind(self):
        h = Harness()
        h.hello()
        error = h.error_of('engine.bind', {})
        self.assertEqual(error['code'], -32602)
        self.assertEqual(error['data']['name'], 'INVALID_PARAMS')
        self.assertEqual(error['data']['category'], 'PROTOCOL')

    def test_unknown_account_is_rejected_with_1005(self):
        h = Harness()
        h.hello()
        error = h.error_of('engine.bind', {
            'bindingId': BINDING_ID,
            'accounts': [{'accountId': 'acct_01JABUNKNOWN00000000000001', 'mode': 'A',
                          'mandateId': MANDATE}],
            'data': {'source': 'host', 'instruments': [BTC]}, 'policies': [],
            'heartbeatMs': 5000})
        self.assertEqual(error['code'], 1005)

    def test_secret_fields_are_refused_and_never_echoed(self):
        h = Harness()
        h.hello()
        canary = 'CANARY-UNIT-7f3a9'
        for method, params in (
                ('strategy.list', {'nested': {'deep': {'apiSecret': canary}}}),
                ('risk.policy.push', {'policies': [], 'effectiveAt': 1, 'mnemonic': canary}),
                ('engine.bind', {'bindingId': BINDING_ID, 'privateKey': canary})):
            error = h.error_of(method, params)
            self.assertEqual(error['code'], 5006, method)
            self.assertEqual(error['data']['name'], 'SECRET_FIELD_REJECTED')
        self.assertNotIn(canary, json.dumps(h.frames))

    def test_problem_codes_match_the_protocol_table(self):
        expected = {'PARSE_ERROR': -32700, 'METHOD_NOT_FOUND': -32601, 'INVALID_PARAMS': -32602,
                    'ACCOUNT_NOT_BOUND': 1005, 'INTERNAL': 4001, 'BUSY': 4004,
                    'VERSION_UNSUPPORTED': 5001, 'CAPABILITY_UNSUPPORTED': 5002,
                    'AUTH_FAILED': 5003, 'SESSION_GAP': 5004,
                    'SECRET_FIELD_REJECTED': 5006, 'PAYLOAD_TOO_LARGE': 5007}
        for name, code in expected.items():
            self.assertEqual(gep.PROBLEMS[name][0], code, name)
        self.assertTrue(gep.PROBLEMS['BUSY'][2], 'BUSY is retryable')
        self.assertEqual(gep.PROBLEMS['INVALID_PARAMS'][1], 'PROTOCOL')


class CapabilityTests(unittest.TestCase):
    def test_describe_declares_the_strategy_and_backtest_groups(self):
        d = gep.engine_describe()
        caps = d['capabilities']
        self.assertTrue(caps['strategy'])
        self.assertTrue(caps['strategy.hotUpdate'])
        self.assertTrue(caps['backtest'])
        self.assertIn('next-bar-open', caps['backtest.fillModels'])
        self.assertIn(gep.STRATEGY_ID, [s['id'] for s in d['strategies']])
        self.assertEqual(d['protocol']['version'], '0.1')
        self.assertIn('stdio', d['protocol']['transports'])

    def test_declared_capabilities_are_known_keys(self):
        for key in gep.CAPABILITIES:
            # 协议键照 describe.ts 的 GEP_CAPABILITY_KEYS；厂商扩展用 `x-` 前缀，
            # schemas/gep.EngineDescribe.json 的 capabilities.propertyNames 允许 `^x-`。
            if key.startswith('x-'):
                self.assertTrue(key in X_CAPABILITY_KEYS, key)
                continue
            self.assertIn(key, CAPABILITY_KEYS, key)
        self.assertTrue(gep.CAPABILITIES['market.useHost'])
        self.assertIn('halt_new', gep.CAPABILITIES['halt.levels'])
        self.assertTrue(gep.CAPABILITIES['execution.modeA']
                        or gep.CAPABILITIES['execution.modeB'])

    def test_every_engine_method_is_handled_or_gated(self):
        covered = set(gep.METHODS) | set(gep.METHOD_CAPABILITY) | {'gep.hello'}
        for method in ENGINE_METHODS:
            self.assertIn(method, covered, method)
        for method, capability in gep.METHOD_CAPABILITY.items():
            if method in gep.METHODS:
                self.assertTrue(gep.CAPABILITIES[capability],
                                '%s handler needs %s declared' % (method, capability))
            else:
                self.assertFalse(gep.CAPABILITIES[capability],
                                 '%s has no handler so %s must stay undeclared'
                                 % (method, capability))

    def test_undeclared_groups_answer_5002(self):
        h = Harness()
        h.hello()
        for method in ('replay.start', 'order.place', 'order.cancel', 'account.snapshot',
                       'market.snapshot', 'market.history', 'market.subscribe'):
            error = h.error_of(method, {})
            self.assertEqual(error['code'], 5002, method)
            self.assertEqual(error['data']['name'], 'CAPABILITY_UNSUPPORTED')

    def test_declared_groups_are_reachable(self):
        h = Harness()
        h.startup()
        self.assertTrue(h.call('strategy.list')['strategies'])
        self.assertTrue(h.call('strategy.params', {'strategyId': gep.STRATEGY_ID})['schema'])
        self.assertIn('acceptedVersions',
                      h.call('risk.policy.push', {'policies': [], 'effectiveAt': 1}))


class StrategyTests(unittest.TestCase):
    def test_params_schema_and_defaults(self):
        h = Harness()
        h.startup()
        answer = h.call('strategy.params', {'strategyId': gep.STRATEGY_ID})
        self.assertEqual(validate_against(answer['schema'], answer['defaults']), [])
        self.assertEqual(answer['defaults']['fastPeriod'], 12)
        self.assertGreater(answer['defaults']['slowPeriod'], answer['defaults']['fastPeriod'])

    def test_start_status_update_stop_roundtrip(self):
        h = Harness()
        h.startup()
        started = h.start_instance()
        self.assertRegex(started['instanceId'], INSTANCE_ID_RE.pattern)
        self.assertEqual(started['status'], 'running')
        running = h.call('strategy.status', {})['instances'][0]
        self.assertEqual(running['status'], 'running')
        self.assertEqual(running['params']['size'], '0.05')
        self.assertIsInstance(running['startedAt'], int)
        started_at = running['startedAt']

        updated = h.call('strategy.update', {'instanceId': started['instanceId'],
                                            'params': {'size': '0.002'}})
        self.assertEqual(updated['status'], 'running')
        self.assertIsInstance(updated['appliedAt'], int)
        after = h.call('strategy.status', {'instanceId': started['instanceId']})['instances'][0]
        self.assertEqual(after['params']['size'], '0.002')
        self.assertEqual(after['startedAt'], started_at,
                         'a hot update must not restart the instance')

        stopped = h.call('strategy.stop', {'instanceId': started['instanceId']})
        self.assertEqual(stopped['status'], 'stopped')
        final = h.call('strategy.status', {'instanceId': started['instanceId']})['instances'][0]
        self.assertEqual(final['status'], 'stopped')

    def test_start_rejects_unknown_strategy_and_bad_params(self):
        h = Harness()
        h.startup()
        self.assertEqual(h.error_of('strategy.start', {
            'strategyId': 'nope', 'accountId': PAPER, 'instruments': [BTC],
            'params': {}, 'mandateId': MANDATE})['code'], -32602)
        self.assertEqual(h.error_of('strategy.start', {
            'strategyId': gep.STRATEGY_ID, 'accountId': PAPER, 'instruments': [BTC],
            'params': {'fastPeriod': 900}, 'mandateId': MANDATE})['code'], -32602)
        self.assertEqual(h.error_of('strategy.update',
                                    {'instanceId': 'inst_nope', 'params': {}})['code'], -32602)

    def test_strategy_events_are_well_formed(self):
        h = Harness()
        h.startup()
        instance = h.start_instance()
        h.call('strategy.stop', {'instanceId': instance['instanceId']})
        events = h.events()
        self.assertEqual([e['type'] for e in events], ['strategy.started', 'strategy.stopped'])
        for event in events:
            self.assertEqual(event['stream'], 'strategy')
            self.assertEqual(event['type'].split('.')[0], event['stream'])
            self.assertIsInstance(event['ts'], int)
        self.assertEqual([e['seq'] for e in events], [1, 2])

    def test_candle_feed_emits_events_with_increasing_seq(self):
        h = Harness()
        h.startup()
        h.start_instance()
        h.feed(600)
        events = h.events()
        self.assertTrue(events, 'a running instance should report progress')
        seqs = [e['seq'] for e in events]
        self.assertEqual(seqs, sorted(set(seqs)))
        ids = [e['eventId'] for e in events]
        self.assertEqual(len(ids), len(set(ids)))
        for event in events[1:]:
            self.assertEqual(event['stream'], 'strategy')
            self.assertIn('instanceId', event['data'])

    def test_unclosed_candles_do_not_advance_the_engine(self):
        h = Harness()
        h.startup()
        h.start_instance()
        h.feed(600, closed=False)
        evaluated = [e for e in h.events() if e['type'] == 'strategy.evaluated']
        self.assertEqual(evaluated, [], 'an unclosed bar must not advance the instance')

    def test_start_on_an_account_outside_the_binding_is_refused(self):
        h = Harness()
        h.startup()
        error = h.error_of('strategy.start', {
            'strategyId': gep.STRATEGY_ID, 'accountId': 'acct_01JABNOTBOUND000000000001',
            'instruments': [BTC], 'params': {}, 'mandateId': MANDATE})
        self.assertEqual(error['code'], 1005)


class BacktestTests(unittest.TestCase):
    def _run(self, h, spec):
        job_id = h.call('backtest.run', {'spec': spec})['jobId']
        self.assertEqual(h.wait_job(job_id), 'done',
                         json.dumps(h.conn.jobs[job_id].get('error')))
        return h.call('backtest.result', {'jobId': job_id})

    def test_run_status_result_shape(self):
        h = Harness(FakeHost(bars=200))
        h.startup()
        job_id = h.call('backtest.run', {'spec': h.spec(200)})['jobId']
        status = h.call('backtest.status', {'jobId': job_id})
        self.assertIn(status['state'], ('queued', 'running', 'done'))
        self.assertGreaterEqual(status['progress'], 0.0)
        self.assertLessEqual(status['progress'], 1.0)
        h.wait_job(job_id)
        result = h.call('backtest.result', {'jobId': job_id})

        for key in ('jobId', 'specDigest', 'assumptions', 'stats', 'equity', 'trades',
                    'openPosition', 'artifacts', 'warnings', 'engine', 'dataDigest'):
            self.assertIn(key, result)
        self.assertRegex(result['specDigest'], SHA256_RE.pattern)
        self.assertRegex(result['dataDigest'], SHA256_RE.pattern)
        for field in ('fees', 'slippageBps', 'fillModel', 'funding', 'liquidation'):
            self.assertIn(field, result['assumptions'])
        self.assertEqual(gep.missing_assumptions(result['assumptions']), [])
        for field in ('totalReturnRatio', 'annualizedRatio', 'maxDrawdownRatio', 'sharpe',
                      'winRatio', 'profitFactor', 'trades', 'fills', 'avgHoldBars',
                      'spanDays', 'finalEquity'):
            self.assertIn(field, result['stats'])
        self.assertIsInstance(result['stats']['trades'], int)
        # one equity point per candle: simulator.ts pushes on every onBar, bar 0 included
        self.assertEqual(len(result['equity']), 200)
        for point in result['equity'][:3]:
            self.assertIsInstance(point['t'], int)
            self.assertIsInstance(point['v'], float)
        self.assertTrue(result['warnings'], 'unmodelled assumptions must be stated')

    def test_same_spec_twice_is_byte_identical(self):
        h = Harness(FakeHost(bars=300))
        h.startup()
        first = self._run(h, h.spec(300))
        second = self._run(h, h.spec(300))
        self.assertNotEqual(first['jobId'], second['jobId'])
        first = dict(first)
        second = dict(second)
        first.pop('jobId')
        second.pop('jobId')
        self.assertEqual(gep.canonical_json(first), gep.canonical_json(second))

    def test_fills_happen_at_the_next_bar_open(self):
        h = Harness(FakeHost(bars=400))
        h.startup()
        result = self._run(h, h.spec(400))
        self.assertGreater(result['stats']['trades'], 0)
        bars = {bar['t']: bar for bar in synth_candles(400)}
        for trade in result['trades']:
            self.assertIn(trade['t'], bars)
            self.assertIn(trade['side'], ('buy', 'sell'))
            self.assertIn(trade['reason'], ('flip', 'flat', 'close'))
            reference = bars[trade['t']]['c'] if trade['reason'] == 'close' else bars[trade['t']]['o']
            self.assertAlmostEqual(trade['price'], reference, delta=reference * 0.001)

    def test_cancel_stops_a_job(self):
        h = Harness(FakeHost(bars=4000))
        h.startup()
        job_id = h.call('backtest.run', {'spec': h.spec(4000)})['jobId']
        cancelled = h.call('backtest.cancel', {'jobId': job_id})
        self.assertIn(cancelled['state'], ('cancelled', 'done'))
        state = h.wait_job(job_id)
        self.assertIn(state, ('cancelled', 'done'))
        if state == 'cancelled':
            self.assertEqual(h.error_of('backtest.result', {'jobId': job_id})['code'], 4003)

    def test_requested_funding_without_host_data_is_reported_as_false(self):
        # funding is modelled now, but this host has no host.market.fundingHistory:
        # the run says so and writes the value it actually used.
        h = Harness(FakeHost(bars=200))
        h.startup()
        spec = h.spec(200)
        spec['assumptions']['funding'] = True
        spec['assumptions']['liquidation'] = True
        result = self._run(h, spec)
        self.assertIs(result['assumptions']['funding'], False)
        self.assertIs(result['assumptions']['liquidation'], True)
        joined = '\n'.join(result['warnings'])
        self.assertIn('host.market.fundingHistory unavailable', joined)
        self.assertIn('liquidation is modelled on the worst intrabar price', joined)
        self.assertIn('liquidations', result['stats'])

    def test_fill_model_other_than_next_bar_open_is_refused(self):
        h = Harness()
        h.startup()
        spec = h.spec(100)
        spec['assumptions']['fillModel'] = 'close'
        error = h.error_of('backtest.run', {'spec': spec})
        self.assertEqual(error['code'], -32602)
        self.assertIn('fillModel', error['data']['message'])

    def test_window_over_the_bar_limit_is_stated_in_warnings(self):
        h = Harness(FakeHost(bars=6000))
        h.startup()
        spec = h.spec(6000)
        result = self._run(h, spec)
        self.assertLessEqual(len(result['equity']), gep.MAX_BACKTEST_BARS)
        joined = '\n'.join(result['warnings'])
        self.assertIn('engine limit', joined)
        self.assertIn(str(gep.MAX_BACKTEST_BARS), joined)
        self.assertIn('only the first', joined)
        self.assertNotIn('most recent', joined)
        self.assertTrue(result['equity'], 'the run produced no equity points')
        self.assertLessEqual(result['equity'][0]['t'] - spec['from'], 2 * 60_000)

    def test_slippage_out_of_range_is_refused(self):
        h = Harness(FakeHost(bars=200))
        h.startup()
        for value in (-50, 501):
            spec = h.spec(200)
            spec['assumptions']['slippageBps'] = value
            error = h.error_of('backtest.run', {'spec': spec})
            self.assertEqual(error['code'], -32602)
            self.assertIn('slippageBps', error['data']['message'])
            self.assertIn('must be in [0, 500]', error['data']['message'])
        for value in (0, 2):
            spec = h.spec(200)
            spec['assumptions']['slippageBps'] = value
            job_id = h.call('backtest.run', {'spec': spec})['jobId']
            self.assertEqual(h.wait_job(job_id), 'done',
                             json.dumps(h.conn.jobs[job_id].get('error')))
            result = h.call('backtest.result', {'jobId': job_id})
            self.assertEqual(result['assumptions']['slippageBps'], float(value))

    def test_failed_job_result_reports_its_own_problem(self):
        h = Harness(FakeHost(bars=100, history_missing=True))
        h.startup()
        job_id = h.call('backtest.run', {'spec': h.spec(100)})['jobId']
        self.assertEqual(h.wait_job(job_id), 'failed')
        job_error = h.conn.jobs[job_id]['error']
        self.assertEqual(job_error['code'], 4005)
        error = h.error_of('backtest.result', {'jobId': job_id})
        self.assertEqual(error['code'], job_error['code'])
        self.assertEqual(error['data']['name'], 'DATA_UNAVAILABLE')
        self.assertIs(error['data']['retryable'], False)

    def test_more_than_one_instrument_is_refused(self):
        h = Harness()
        h.startup()
        spec = h.spec(100)
        spec['instruments'] = [BTC, 'binance:ETHUSDT']
        error = h.error_of('backtest.run', {'spec': spec})
        self.assertEqual(error['code'], -32602)
        self.assertIn('instruments', error['data']['message'])

    def test_invalid_spec_is_refused(self):
        h = Harness()
        h.startup()
        spec = h.spec(100)
        spec['assumptions'].pop('liquidation')
        error = h.error_of('backtest.run', {'spec': spec})
        self.assertEqual(error['code'], -32602)
        self.assertIn('liquidation', error['data']['message'])
        self.assertEqual(h.error_of('backtest.status', {'jobId': 'job_nope'})['code'], -32602)

    def test_data_source_other_than_host_is_reported_as_unavailable(self):
        h = Harness()
        h.startup()
        job_id = h.call('backtest.run', {'spec': h.spec(100, source='engine')})['jobId']
        self.assertEqual(h.wait_job(job_id), 'failed')
        self.assertEqual(h.conn.jobs[job_id]['error']['name'], 'DATA_UNAVAILABLE')

    def test_missing_host_history_fails_the_job_not_the_session(self):
        h = Harness(FakeHost(bars=100, history_missing=True))
        h.startup()
        job_id = h.call('backtest.run', {'spec': h.spec(100)})['jobId']
        self.assertEqual(h.wait_job(job_id), 'failed')
        self.assertEqual(h.call('engine.health')['status'], 'ok')


class LifecycleTests(unittest.TestCase):
    def test_halt_and_resume(self):
        h = Harness()
        h.startup()
        ack = h.call('engine.halt', {'takeoverId': 'tko_01JABUNIT1', 'level': 'halt_new',
                                     'scope': {'accountIds': [PAPER]}, 'reason': 'unit test',
                                     'deadlineMs': 200})
        self.assertTrue(ack['ack'])
        self.assertIsInstance(ack['appliedAt'], int)
        self.assertEqual(h.error_of('engine.resume', {
            'takeoverId': 'tko_01JABOTHER', 'scope': {}, 'approvedBy': 'user:unit'})['code'],
            -32602)
        resumed = h.call('engine.resume', {'takeoverId': 'tko_01JABUNIT1', 'scope': {},
                                          'approvedBy': 'user:unit'})
        self.assertIsInstance(resumed['resumedAt'], int)

    def test_shutdown_requests_a_clean_exit(self):
        h = Harness()
        h.hello()
        answer = h.call('engine.shutdown', {'graceMs': 0})
        self.assertTrue(answer['ok'])
        self.assertTrue(h.conn.exit_requested)
        self.assertEqual(h.conn.exit_code, 0)

    def test_snapshot_reports_instances_and_seq(self):
        h = Harness()
        h.startup()
        instance = h.start_instance()
        snap = h.call('engine.snapshot', {})
        self.assertGreaterEqual(snap['seq'], 1)
        self.assertEqual([i['instanceId'] for i in snap['strategies']],
                         [instance['instanceId']])
        self.assertEqual(snap['orders'], [])

    def test_events_subscribe_and_unsubscribe(self):
        h = Harness()
        h.hello()
        sub = h.call('events.subscribe', {'streams': ['strategy', 'signal'],
                                          'accountIds': [PAPER]})
        self.assertTrue(sub['subscriptionId'])
        self.assertIsInstance(sub['fromSeq'], int)
        self.assertTrue(h.call('events.unsubscribe',
                               {'subscriptionId': sub['subscriptionId']})['ok'])


class FramingRobustnessTests(unittest.TestCase):
    """L4-01 / L4-03：一帧坏数据只能坏一帧，读循环绝不因单帧退出；batch 有成员上限。"""

    @staticmethod
    def _deep_line(depth=20000):
        return '{"jsonrpc":"2.0","id":2,"method":"engine.bind","params":' + '[' * depth + ']' * depth + '}'

    def _conn(self):
        frames = []
        conn = gep.Conn(write=frames.append)
        conn.token = TOKEN
        return conn, frames

    def test_deeply_nested_frame_is_an_error_not_an_exception(self):
        conn, _ = self._conn()
        msg, failure = gep.parse_frame(conn, self._deep_line())
        self.assertIsNone(msg)
        self.assertEqual(failure['error']['code'], -32700)
        self.assertEqual(failure['error']['data']['name'], 'PARSE_ERROR')
        self.assertIn('exceeds', failure['error']['message'])

    def test_brackets_inside_a_string_are_not_nesting(self):
        # 反证的另一半：深度预检不能误伤含大量 "[" 的合法字符串字段。
        conn, _ = self._conn()
        line = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'engine.health',
                           'params': {'pad': '[' * (gep.MAX_JSON_DEPTH * 4)}})
        msg, failure = gep.parse_frame(conn, line)
        self.assertIsNone(failure)
        self.assertEqual(msg['id'], 1)

    def test_nesting_at_the_limit_parses(self):
        conn, _ = self._conn()
        depth = gep.MAX_JSON_DEPTH - 2            # 对象自身 + params 各算一层
        line = ('{"jsonrpc":"2.0","id":1,"method":"engine.health","params":'
                + '[' * depth + ']' * depth + '}')
        msg, failure = gep.parse_frame(conn, line)
        self.assertIsNone(failure)
        self.assertEqual(msg['id'], 1)

    def test_read_loop_survives_a_deep_frame_and_keeps_reading(self):
        conn, frames = self._conn()
        inbox = gep.Inbox()
        good = json.dumps({'jsonrpc': '2.0', 'id': 9, 'method': 'engine.health'})
        stream = (self._deep_line() + '\n' + good + '\n').encode('utf-8')
        with mock.patch.object(sys, 'stdin', _FakeStdin(stream)):
            gep.read_loop(conn, inbox)
        self.assertEqual(len(frames), 1, 'the deep frame must answer one error frame')
        self.assertEqual(frames[0]['error']['data']['name'], 'PARSE_ERROR')
        queued = inbox.get()
        self.assertEqual(queued['id'], 9, 'the frame after the deep one must still be read')

    def test_read_loop_survives_a_frame_that_raises(self):
        # 反证：即使解析器本身抛了非 OSError（RecursionError / MemoryError 一类），
        # 读循环也只回一帧 INTERNAL 并继续。
        conn, frames = self._conn()
        inbox = gep.Inbox()
        real = gep.parse_frame
        state = {'n': 0}

        def flaky(conn_, raw):
            state['n'] += 1
            if state['n'] == 1:
                raise RecursionError('simulated parser blow-up')
            return real(conn_, raw)

        good = json.dumps({'jsonrpc': '2.0', 'id': 10, 'method': 'engine.health'})
        with mock.patch.object(sys, 'stdin', _FakeStdin(('{}\n' + good + '\n').encode('utf-8'))), \
                mock.patch.object(gep, 'parse_frame', flaky):
            gep.read_loop(conn, inbox)
        self.assertEqual([f['error']['data']['name'] for f in frames], ['INTERNAL'])
        self.assertEqual(inbox.get()['id'], 10)

    def test_deep_frame_does_not_kill_the_engine_process(self):
        """端到端（审计 probe_readloop 的断言化）：深嵌套帧之后引擎仍应答、退出码 0。"""
        script = os.path.join(PACKAGE_ROOT, 'engine', 'main.py')
        hello = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'gep.hello',
                            'params': {'protocol': 'gep', 'versions': ['0.1'],
                                       'host': {'name': 'unit-test-host', 'version': '0.1.0'},
                                       'auth': {'token': TOKEN}}})
        health = json.dumps({'jsonrpc': '2.0', 'id': 3, 'method': 'engine.health'})
        stdin = ('\n'.join([hello, self._deep_line(), health]) + '\n').encode('utf-8')
        env = dict(os.environ, GITRADER_GEP_TOKEN=TOKEN, PYTHONDONTWRITEBYTECODE='1')
        proc = subprocess.run([sys.executable, '-B', script], input=stdin, capture_output=True,
                              cwd=PACKAGE_ROOT, env=env, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace')[-400:])
        answers = [json.loads(line) for line in proc.stdout.decode('utf-8').splitlines() if line.strip()]
        self.assertTrue(any(isinstance(a, dict) and a.get('id') == 3 and 'result' in a for a in answers),
                        'engine.health after the deep frame must be answered')
        self.assertTrue(any(isinstance(a, dict) and a.get('error', {}).get('data', {}).get('name') == 'PARSE_ERROR'
                            for a in answers if isinstance(a, dict)))

    def test_batch_above_the_member_limit_is_refused_whole(self):
        h = Harness()
        batch = [{'jsonrpc': '2.0', 'id': i, 'method': 'no.such.method'}
                 for i in range(gep.MAX_BATCH_MEMBERS + 1)]
        frames = h.send_raw(json.dumps(batch))
        self.assertEqual(len(frames), 1)
        self.assertIsInstance(frames[0], dict, 'an oversized batch must answer one error frame, not a batch')
        self.assertIsNone(frames[0]['id'])
        self.assertEqual(frames[0]['error']['code'], -32600)
        self.assertEqual(frames[0]['error']['data']['name'], 'INVALID_REQUEST')
        self.assertIn(str(gep.MAX_BATCH_MEMBERS), frames[0]['error']['message'])

    def test_empty_batch_answers_one_invalid_request_frame(self):
        # 空 batch（L4-03 的另一半）：TS 侧 src/gep/peer.ts 对 [] 回一帧 INVALID_REQUEST / 'empty batch'，
        # Python 必须同形；以前这里是「一帧不回」的静默丢包。
        h = Harness()
        frames = h.send_raw(json.dumps([]))
        self.assertEqual(len(frames), 1, 'an empty batch must answer exactly one error frame')
        self.assertIsInstance(frames[0], dict, 'an empty batch must answer a single error frame, not a batch')
        self.assertIsNone(frames[0]['id'])
        self.assertEqual(frames[0]['jsonrpc'], '2.0')
        self.assertEqual(frames[0]['error']['code'], -32600)
        self.assertEqual(frames[0]['error']['data']['name'], 'INVALID_REQUEST')
        self.assertEqual(frames[0]['error']['message'], 'empty batch')

    def test_batch_at_the_member_limit_is_answered(self):
        # 边界反证：正好 100 条的批量照旧逐条应答（上限不是"批量一律拒"）。
        h = Harness()
        batch = [{'jsonrpc': '2.0', 'id': i, 'method': 'no.such.method'}
                 for i in range(gep.MAX_BATCH_MEMBERS)]
        frames = h.send_raw(json.dumps(batch))
        self.assertEqual(len(frames), 1)
        self.assertIsInstance(frames[0], list)
        self.assertEqual([a['id'] for a in frames[0]], list(range(gep.MAX_BATCH_MEMBERS)))


class _FakeStdin(io.BytesIO):
    """read_loop 只用 ``sys.stdin.buffer.readline()``：这个假 stdin 两者都给。"""

    @property
    def buffer(self):
        return self


if __name__ == '__main__':
    unittest.main()
