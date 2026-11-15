# SPDX-License-Identifier: CPAL-1.0
"""Fuzz tests for the Python engine's GEP frame parser (batch 10 item F1).

Entry points (both are what the stdio server's read loop goes through, see
engine/gep.py read_loop / process_line):

    A. parse_frame(conn, raw)   engine/gep.py  -- one line of bytes -> (message, None) or (None, error_frame)
    B. process_line(conn, raw)  engine/gep.py  -- frame + dispatch (what a real session does)

Properties asserted (each is a hard failure):

    1. parse_frame never raises. A bad frame is one error frame, never an exception
       handed to the read loop (this is the L4-01 rule: 一帧坏数据只回一帧错误).
    2. parse_frame returns exactly one of (message, None) / (None, error_frame);
       an error frame carries a JSON-RPC error with a numeric code and a Problem in
       error.data, so a caller can always tell what happened.
    3. No NaN reaches a decoded message: Python's json accepts the `NaN` literal, so a
       frame can smuggle float('nan') into params; downstream decimal maths silently
       poisons on it. Frames the parser accepts must be NaN-free.
    4. process_line also never raises, and every frame it writes is valid JSON-RPC.
    5. Reproducible: the same seed (42) produces byte-identical frames on every run.

Deterministic by construction: random.Random(42), no time, no network, no files.
Run from packages/engine-python:  python -m unittest tests/test_fuzz_gep.py -v
"""

import json
import math
import os
import random
import sys
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

from engine import gep  # noqa: E402

SEED = 42
SAMPLES = 10_000
TOKEN = 'fuzz-token-0000'

HELLO = {
    'jsonrpc': '2.0', 'id': 1, 'method': 'gep.hello',
    'params': {'protocol': 'gep', 'versions': ['0.1'],
               'host': {'id': 'fuzz', 'name': 'fuzz', 'version': '0.0.0'},
               'auth': {'token': TOKEN}},
}

SEED_FRAMES = (
    json.dumps(HELLO, separators=(',', ':')),
    '{"jsonrpc":"2.0","id":2,"method":"engine.health"}',
    '{"jsonrpc":"2.0","id":3,"method":"engine.describe"}',
    '{"jsonrpc":"2.0","id":4,"method":"engine.bind","params":{"bindingId":"b1","accounts":[],'
    '"data":{"source":"host","instruments":[]},"policies":[]}}',
    '{"jsonrpc":"2.0","id":5,"method":"events.subscribe","params":{"streams":["order"],"subscriptionId":"s1"}}',
    '{"jsonrpc":"2.0","method":"gep.heartbeat","params":{"ts":1,"seq":1}}',
    '{"jsonrpc":"2.0","method":"events.push","params":{"sessionId":"x","events":'
    '[{"seq":1,"stream":"market","type":"market.candle","ts":1,"data":{}}]}}',
    '{"jsonrpc":"2.0","method":"gep.heartbeat","params":{"ts":1,"seq":2}}',
    '[{"jsonrpc":"2.0","id":9,"method":"engine.health"},'
    '{"jsonrpc":"2.0","id":10,"method":"engine.describe"}]',
)

OPS = (
    'truncate', 'drop-byte', 'insert-byte', 'flip-byte', 'length-lies', 'wrong-types',
    'duplicate-keys', 'deep-nesting', 'nan-literal', 'oversize', 'batch-amplify',
    'raw-garbage', 'frame-shape', 'proto-pollution', 'events-malformed', 'invalid-utf8',
)

ALPHABET = '{}[]",:0123456789.eE+-\\/ \t\n'


def mutate(rng, base, op):
    """One destructive edit of a valid frame; op is an index into OPS."""
    name = OPS[op]
    if name == 'truncate':
        return base[:rng.randrange(0, len(base) + 1)]
    if name == 'drop-byte':
        i = rng.randrange(0, len(base))
        return base[:i] + base[i + 1:]
    if name == 'insert-byte':
        i = rng.randrange(0, len(base) + 1)
        return base[:i] + rng.choice(ALPHABET) + base[i:]
    if name == 'flip-byte':
        i = rng.randrange(0, len(base))
        return base[:i] + chr(ord(base[i]) ^ (1 << rng.randrange(0, 8))) + base[i + 1:]
    if name == 'length-lies':
        out = base
        for token in ('"id":1', '"seq":1', '"ts":1'):
            if token in out and rng.random() < 0.5:
                out = out.replace(token, token.split(':')[0] + ':' + rng.choice(
                    ['-1', '0', '1e999', '999999999999999999999999999999', '0.1', '-1e999']), 1)
        return out
    if name == 'wrong-types':
        for key in ('"id":', '"method":', '"params":', '"ts":', '"seq":', '"streams":', '"events":'):
            if key in base and rng.random() < 0.4:
                base = base.replace(key, key + rng.choice(
                    ['null', '[]', '{}', 'false', '-1', '1e308', '"\\ud800"', '[[[]]]', '{"a":{"b":[1]}}']), 1)
        return base
    if name == 'duplicate-keys':
        return base.replace('{', '{"id":1,"id":2,"method":"x","method":"engine.health",', 1)
    if name == 'deep-nesting':
        depth = rng.choice([2, 10, 100, 1000, 5000])
        return '{"jsonrpc":"2.0","id":1,"method":"engine.bind","params":' + '[' * depth + ']' * depth + '}'
    if name == 'nan-literal':
        # json.loads accepts NaN / Infinity as float('nan') / float('inf')
        return base.replace('"id":', '"params":{"x":NaN,"y":Infinity},' + '"id":', 1)
    if name == 'oversize':
        return base.replace('}', ',"pad":"' + 'x' * 200_000 + '"}', 1)
    if name == 'batch-amplify':
        n = rng.choice([2, 10, 50])
        return '[' + ','.join(rng.choice(SEED_FRAMES) for _ in range(n)) + ']'
    if name == 'raw-garbage':
        return ''.join(rng.choice(ALPHABET) for _ in range(rng.randrange(0, 64)))
    if name == 'frame-shape':
        return json.dumps({
            'jsonrpc': rng.choice(['2.0', '1.0', 2, None, [], {}]),
            'id': rng.choice([None, True, [], {}, 1.5, 'x', -0]),
            'method': rng.choice(['engine.health', '', '__proto__', 'constructor', 'host.events.ack', 1, None]),
        })
    if name == 'proto-pollution':
        return json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'engine.health',
                           'params': {'__proto__': {'polluted': True},
                                      'constructor': {'prototype': {'polluted': True}}}})
    if name == 'events-malformed':
        return json.dumps({
            'jsonrpc': '2.0', 'method': 'events.push',
            'params': {'sessionId': 's', 'events': [
                {'seq': rng.choice([0, -1, 1, 10 ** 18, 'x', None]),
                 'stream': rng.choice(['order', 'nope', None]),
                 'type': rng.choice(['order.filled', 'x', None]),
                 'ts': rng.choice([0, -1, 1e300]),
                 'data': rng.choice([None, [], {}, 'x'])}
                for _ in range(rng.choice([1, 3, 50]))]},
        })
    # invalid-utf8: raw bytes that cannot be decoded as UTF-8
    return b'\xff\xfe{"jsonrpc":"2.0","id":1' + bytes([rng.randrange(0x80, 0x100)])


def frame_stream(rng, count):
    """(op name, frame) pairs: the first len(OPS) samples cover every operator once."""
    out = []
    for i in range(count):
        op = i if i < len(OPS) else rng.randrange(0, len(OPS))
        base = rng.choice(SEED_FRAMES)
        payload = mutate(rng, base, op)
        if isinstance(payload, str):
            payload = payload.encode('utf-8', 'surrogatepass')
        out.append((OPS[op], payload))
    return out


def find_nan(value, path='$', depth=0):
    """Path of the first float('nan') inside a decoded JSON value, or None."""
    if depth > 40:
        return None
    if isinstance(value, float) and math.isnan(value):
        return path
    if isinstance(value, dict):
        for key, item in list(value.items())[:200]:
            hit = find_nan(item, '%s.%s' % (path, key), depth + 1)
            if hit:
                return hit
    elif isinstance(value, list):
        for index, item in enumerate(value[:200]):
            hit = find_nan(item, '%s[%d]' % (path, index), depth + 1)
            if hit:
                return hit
    return None


def valid_error_frame(frame):
    """An error frame must be JSON-RPC with a numeric code and a Problem in error.data."""
    if not isinstance(frame, dict):
        return 'error frame is not an object: %r' % (frame,)
    error = frame.get('error')
    if not isinstance(error, dict):
        return 'error frame has no error object: %r' % (frame,)
    if not isinstance(error.get('code'), int):
        return 'error frame has no numeric code: %r' % (error,)
    data = error.get('data')
    if not isinstance(data, dict) or 'code' not in data or 'name' not in data:
        return 'error frame carries no Problem: %r' % (error,)
    return None


def valid_jsonrpc_frame(frame):
    if isinstance(frame, list):
        # 批量请求的响应本身就是一个数组（§2.1），逐个成员检查
        if not frame:
            return 'empty batch response'
        for member in frame:
            problem = valid_jsonrpc_frame(member)
            if problem is not None:
                return 'batch member: %s' % problem
        return None
    if not isinstance(frame, dict):
        return 'frame is not an object'
    if frame.get('jsonrpc') != '2.0':
        return 'frame is not jsonrpc 2.0'
    if 'result' not in frame and 'error' not in frame:
        return 'frame has neither result nor error'
    return None


class FrameParserFuzz(unittest.TestCase):
    """10 000 seeded frames per entry, seed hard-coded to 42."""

    def setUp(self):
        self.frames = []
        self.conn = gep.Conn(write=self.frames.append)

    def test_parse_frame_never_raises(self):
        rng = random.Random(SEED)
        failures = []
        accepted = 0
        rejected = 0
        for index, (op, payload) in enumerate(frame_stream(rng, SAMPLES)):
            try:
                message, failure = gep.parse_frame(self.conn, payload)
            except BaseException as error:  # noqa: BLE001 - 任何异常都算发现
                if len(failures) < 5:
                    failures.append('#%d %s: parse_frame raised %s: %s | op=%s frame=%r'
                                    % (index, 'RAISED', type(error).__name__, error, op, payload[:120]))
                continue
            if message is None and failure is None:
                rejected += 1          # 空行 / 纯空白：约定是静默忽略
                continue
            if message is not None and failure is not None:
                failures.append('#%d BOTH: parse_frame returned message and error | op=%s' % (index, op))
                continue
            if failure is not None:
                rejected += 1
                problem = valid_error_frame(failure)
                if problem is not None and len(failures) < 5:
                    failures.append('#%d %s | op=%s frame=%r' % (index, problem, op, payload[:120]))
                continue
            accepted += 1
            # 被接受的帧里不许夹带 NaN
            hit = find_nan(message)
            if hit is not None and len(failures) < 5:
                failures.append('#%d NaN accepted into the message at %s | op=%s frame=%r'
                                % (index, hit, op, payload[:120]))
        self.assertEqual(failures, [])
        self.assertGreater(accepted, 0, 'no frame was accepted at all')
        self.assertGreater(rejected, 0, 'no frame was rejected at all')

    def test_process_line_never_raises_and_writes_valid_frames(self):
        rng = random.Random(SEED)
        failures = []
        frames_written = 0
        for index, (op, payload) in enumerate(frame_stream(rng, SAMPLES)):
            del self.frames[:]
            try:
                gep.process_line(self.conn, payload)
            except BaseException as error:  # noqa: BLE001
                if len(failures) < 5:
                    failures.append('#%d process_line raised %s: %s | op=%s frame=%r'
                                    % (index, type(error).__name__, error, op, payload[:120]))
                continue
            for frame in self.frames:
                frames_written += 1
                problem = valid_jsonrpc_frame(frame)
                if problem is not None and len(failures) < 5:
                    failures.append('#%d %s | op=%s frame=%r' % (index, problem, op, payload[:120]))
            # 写出去的帧必须能被重新序列化（否则线上的是一段坏 JSON）
            for frame in self.frames:
                try:
                    json.dumps(frame)
                except (TypeError, ValueError) as error:
                    if len(failures) < 5:
                        failures.append('#%d unwritable frame: %s' % (index, error))
        self.assertEqual(failures, [])
        self.assertGreater(frames_written, 0, 'process_line never wrote a frame')

    def test_frame_stream_is_reproducible(self):
        first = frame_stream(random.Random(SEED), 512)
        second = frame_stream(random.Random(SEED), 512)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 512)
        # 每个算子都在种子流里出现过（不然「随机挑算子」会漏掉某几类）
        seen = {op for op, _ in first[:len(OPS)]}
        self.assertEqual(seen, set(OPS))

    def test_oversize_and_深嵌套被拒(self):
        """两条具体的拒绝路径：超 1 MiB 的行、括号嵌套超限的帧。"""
        huge = b'{"jsonrpc":"2.0","id":1,"method":"engine.health","pad":"' + b'x' * (gep.MAX_LINE_BYTES + 1) + b'"}'
        message, failure = gep.parse_frame(self.conn, huge)
        self.assertIsNone(message)
        self.assertIsNotNone(failure)
        self.assertEqual(failure['error']['data']['name'], 'PAYLOAD_TOO_LARGE')

        deep = b'{"jsonrpc":"2.0","id":1,"method":"engine.bind","params":' + b'[' * (gep.MAX_JSON_DEPTH + 1) + b']' * (gep.MAX_JSON_DEPTH + 1) + b'}'
        message, failure = gep.parse_frame(self.conn, deep)
        self.assertIsNone(message)
        self.assertIsNotNone(failure)
        self.assertEqual(failure['error']['data']['name'], 'PARSE_ERROR')


if __name__ == '__main__':
    unittest.main()
