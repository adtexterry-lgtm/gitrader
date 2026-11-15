# SPDX-License-Identifier: CPAL-1.0
"""批 11 收口回归：非有限 JSON 数字不许进帧。

`NaN` / `Infinity` / `-Infinity` 字面量由 parse_constant 拒；`1e999` / `-1e999` 这类
溢出数字走 parse_float，修前会变成 float('inf') 混进 params。五帧都必须是一帧
PARSE_ERROR，对照的三帧正常接受。

Run from packages/engine-python:  python -m unittest tests/test_b11_nonfinite.py -v
"""

import os
import sys
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

from engine import gep  # noqa: E402

REJECTED = (
    '{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":1e999}}',
    '{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":-1e999}}',
    '{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":NaN}}',
    '{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":Infinity}}',
    '{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":-Infinity}}',
)

ACCEPTED = (
    ('{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":1.5}}', 1.5),
    ('{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":1e10}}', 1e10),
    ('{"jsonrpc":"2.0","id":1,"method":"engine.health","params":{"x":-0.0}}', -0.0),
)


class NonFiniteNumberFrames(unittest.TestCase):
    def setUp(self):
        self.frames = []
        self.conn = gep.Conn(write=self.frames.append)

    def test_non_finite_frames_are_rejected(self):
        for raw in REJECTED:
            with self.subTest(frame=raw):
                message, failure = gep.parse_frame(self.conn, raw)
                self.assertIsNone(message)
                self.assertIsNotNone(failure)
                self.assertEqual(failure['error']['code'], -32700)
                self.assertEqual(failure['error']['data']['name'], 'PARSE_ERROR')
                self.assertEqual(failure['error']['message'], 'parse error')

    def test_finite_frames_are_accepted(self):
        for raw, expected in ACCEPTED:
            with self.subTest(frame=raw):
                message, failure = gep.parse_frame(self.conn, raw)
                self.assertIsNone(failure)
                self.assertIsNotNone(message)
                self.assertEqual(message['params']['x'], expected)


if __name__ == '__main__':
    unittest.main()
