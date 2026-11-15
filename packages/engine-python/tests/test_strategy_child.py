# SPDX-License-Identifier: CPAL-1.0
"""审计 L4-07 / L4-09 的回归：策略子进程的报告写出与编码错误归类。

两个缺陷都只在子进程边界上出现，所以这里的用例是**真子进程**：把 job 从 stdin 喂进去，
断言 stdout 上一定有且只有一行可解析的 JSON（以前是一条都没有、退出码 1，父进程只能报
"no JSON result"）。

跑法（仓库根或 packages/engine-python）：
    python -m unittest tests.test_strategy_child -v
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_ROOT = os.path.dirname(HERE)
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

from engine import strategy_api as sa  # noqa: E402

CHILD = os.path.join(PACKAGE_ROOT, 'engine', 'strategy_child.py')

#: 源码以 ASCII 字节落盘，运行期由 Python 解析成**真**的孤立代理（和审计 probe_surrogate.py 同法）。
SURROGATE_SOURCE = (
    'def evaluate(candles, params):\n'
    '    reasons = [' + repr('\ud800') + ' for _ in candles]\n'
    '    return {"target": [0.0 for _ in candles], "reasons": reasons, "overlays": {}, "warmup": 0}\n'
    'STRATEGY = {"id": "surrogate", "name": "s", "version": "0.1.0",\n'
    '            "desc": "HITS:" + ' + repr('\ud800') + ',\n'
    '            "tags": [], "params": [], "evaluate": evaluate}\n'
)

CLEAN_SOURCE = (
    'def evaluate(candles, params):\n'
    '    return {"target": [0.0 for _ in candles], "reasons": [""] * len(candles),\n'
    '            "overlays": {}, "warmup": 0}\n'
    'STRATEGY = {"id": "clean", "name": "clean", "version": "0.1.0", "desc": "ok",\n'
    '            "tags": [], "params": [], "evaluate": evaluate}\n'
)


def child_env():
    keep = ('PATH', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'SYSTEMDRIVE', 'WINDIR',
            'TEMP', 'TMP', 'PATHEXT', 'COMSPEC')
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PYTHONIOENCODING'] = 'utf-8'
    return env


def run_child(job):
    """跑一次子进程，返回 (returncode, stdout 文本, 解析出的 payload 或 None)。"""
    proc = subprocess.run([sys.executable, '-B', CHILD], input=json.dumps(job).encode('utf-8'),
                          cwd=PACKAGE_ROOT, env=child_env(), capture_output=True, timeout=120)
    text = proc.stdout.decode('utf-8', 'replace')
    lines = [line for line in text.splitlines() if line.strip()]
    payload = None
    if len(lines) == 1:
        try:
            payload = json.loads(lines[0])
        except ValueError:
            payload = None
    return proc.returncode, lines, payload


class ReportWriteTests(unittest.TestCase):
    """L4-07：报告里的孤立代理不能让子进程一行都写不出来。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='l4-child-')

    def _write(self, name, source, encoding='ascii'):
        path = os.path.join(self.dir, name)
        with open(path, 'wb') as handle:
            handle.write(source.encode(encoding))
        return path

    def test_load_report_with_a_lone_surrogate_is_written(self):
        path = self._write('surrogate.py', SURROGATE_SOURCE)
        code, lines, payload = run_child({'job': 'load', 'path': path})
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1, 'exactly one JSON line is the child contract')
        self.assertIsNotNone(payload)
        self.assertTrue(payload['ok'])
        self.assertEqual(payload['strategy']['id'], 'surrogate')
        self.assertEqual(payload['sanitizedSurrogates'], 1)
        self.assertIn('\ufffd', payload['strategy']['desc'], 'the lone surrogate becomes U+FFFD')

    def test_evaluate_report_with_lone_surrogates_is_written(self):
        path = self._write('surrogate.py', SURROGATE_SOURCE)
        code, lines, payload = run_child({'job': 'evaluate', 'path': path, 'bars': 20, 'seed': 7})
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1)
        self.assertIsNotNone(payload)
        self.assertTrue(payload['ok'], payload)
        self.assertEqual(payload['signals']['sanitizedSurrogates'], 20)
        self.assertEqual(len(payload['signals']['seriesSha256']), 64)

    def test_signals_report_with_lone_surrogates_is_written(self):
        # 回测取信号的路径：以前这里同样写不出一行（BACKTEST_FAILED 且无诊断）。
        path = self._write('surrogate.py', SURROGATE_SOURCE)
        candles = sa.synth_candles(5)
        code, lines, payload = run_child({'job': 'signals', 'path': path, 'params': {}, 'candles': candles})
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1)
        self.assertIsNotNone(payload)
        self.assertTrue(payload['ok'], payload)
        # 5 条 reasons + 1 条 desc：报告里每个字符串都被过滤过，计数如实回报。
        self.assertEqual(payload['sanitizedSurrogates'], 6)
        self.assertEqual(len(payload['series']['target']), 5)

    def test_clean_report_is_byte_identical_to_before(self):
        # 反证：没有孤立代理时不多加字段、不改编码行为（sanitizedSurrogates 不该出现）。
        path = self._write('clean.py', CLEAN_SOURCE)
        code, lines, payload = run_child({'job': 'load', 'path': path})
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1)
        self.assertNotIn('sanitizedSurrogates', payload)


class EncodingRuleTests(unittest.TestCase):
    """L4-09：非 UTF-8 策略文件报 encoding 规则，不是笼统的 runtime。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='l4-enc-')

    def test_in_process_load_raises_strategy_error_with_encoding_rule(self):
        path = os.path.join(self.dir, 'latin1.py')
        with open(path, 'wb') as handle:
            handle.write(b'# caf\xe9\nSTRATEGY = {}\n')
        with self.assertRaises(sa.StrategyError) as caught:
            sa.load_strategy_file(path)
        self.assertEqual([i.rule for i in caught.exception.issues], ['encoding'])

    def test_child_reports_encoding_rule(self):
        path = os.path.join(self.dir, 'latin1.py')
        with open(path, 'wb') as handle:
            handle.write(b'# caf\xe9\nSTRATEGY = {}\n')
        code, lines, payload = run_child({'job': 'load', 'path': path})
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1)
        self.assertFalse(payload['ok'])
        self.assertEqual([e['rule'] for e in payload['errors']], ['encoding'])
        self.assertIn('UTF-8', payload['errors'][0]['message'])

    def test_utf8_bom_file_still_loads(self):
        # 反证：utf-8-sig 的既有语义不变（带 BOM 的合法文件照旧能加载）。
        path = os.path.join(self.dir, 'bom.py')
        with open(path, 'wb') as handle:
            handle.write(b'\xef\xbb\xbf' + CLEAN_SOURCE.encode('ascii'))
        code, lines, payload = run_child({'job': 'load', 'path': path})
        self.assertEqual(code, 0)
        self.assertTrue(payload['ok'], payload)


if __name__ == '__main__':
    unittest.main()
