# SPDX-License-Identifier: CPAL-1.0
"""Tests for the strategy folder and the execution limits (stdlib unittest only).

Run from the repository root::

    python -m unittest packages/engine-python/tests/test_strategy_loader.py

or from ``packages/engine-python``::

    python -m unittest tests/test_strategy_loader.py

Two kinds of test live here:

* **limits** - the supervisor is driven with a fake clock, a fake process and a
  fake RSS reader, so timeouts and memory ceilings are deterministic and fast;
* **loading** - real child processes, real sandbox, real example strategies, all
  offline in a temporary folder. The breach tests (module-level loop, hanging
  ``evaluate``, 200 MiB strategy) are the ones that used to take the engine down.

No network, no venue, no keys.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

from engine import gep  # noqa: E402
from engine import limits as limit_mod  # noqa: E402
from engine import strategy_api as sa  # noqa: E402
from engine import strategy_loader  # noqa: E402

EXAMPLES = os.path.join(PACKAGE_ROOT, 'examples')

PAPER = 'acct_01JABAPAPER000000000000001'
MANDATE = 'mdt_01JABAENG01'
BINDING_ID = 'bind_01JABCCONF01'
TOKEN = 'unit-test-token'
BTC = 'hyperliquid:BTC'
T0 = 1_790_000_000_000

GOOD_STRATEGY = '''# SPDX-License-Identifier: CPAL-1.0
"""Test fixture: flat all the way, contract-shaped."""

PARAMS = [
    {"key": "period", "label": "Period", "type": "integer", "default": 7, "min": 2, "max": 50},
    {"key": "allowShort", "label": "Allow short", "type": "boolean", "default": False},
]


def evaluate(candles, params):
    n = len(candles)
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": {}, "warmup": 0}


STRATEGY = {"id": "%s", "name": "Test fixture", "version": "0.1.0",
            "desc": "Flat target; used by the loader tests.", "tags": ["test"],
            "params": PARAMS, "evaluate": evaluate}
'''

MODULE_LOOP = '''# SPDX-License-Identifier: CPAL-1.0
while True:
    pass

STRATEGY = {"id": "module-loop", "name": "Module loop", "version": "0.1.0",
            "desc": "Never returns from module level.", "tags": [], "params": [],
            "evaluate": lambda candles, params: None}
'''

HOOK_LOOP = '''# SPDX-License-Identifier: CPAL-1.0
def evaluate(candles, params):
    while True:
        pass


STRATEGY = {"id": "hook-loop", "name": "Hook loop", "version": "0.1.0",
            "desc": "Never returns from evaluate.", "tags": [], "params": [],
            "evaluate": evaluate}
'''

MEMORY_HOG = '''# SPDX-License-Identifier: CPAL-1.0
def evaluate(candles, params):
    blob = bytearray(200 * 1024 * 1024)
    for i in range(0, len(blob), 4096):
        blob[i] = 1
    while True:
        blob[0] = blob[0]


STRATEGY = {"id": "memory-hog", "name": "Memory hog", "version": "0.1.0",
            "desc": "Allocates 200 MiB and stays there.", "tags": [], "params": [],
            "evaluate": evaluate}
'''

MEMORY_PEAK = '''# SPDX-License-Identifier: CPAL-1.0
def evaluate(candles, params):
    # 200 MiB of untouched (zero) pages: the working set barely moves, so this
    # strategy is caught by the tracemalloc peak rather than by the RSS sampler.
    blob = bytearray(200 * 1024 * 1024)
    n = len(candles)
    return {"target": [0.0] * n, "reasons": [""] * n, "overlays": {}, "warmup": 0}


STRATEGY = {"id": "memory-peak", "name": "Memory peak", "version": "0.1.0",
            "desc": "Allocates 200 MiB, then returns a valid series.", "tags": [],
            "params": [], "evaluate": evaluate}
'''

IMPORT_USER = '''# SPDX-License-Identifier: CPAL-1.0
import os

STRATEGY = {"id": "import-user", "name": "Import user", "version": "0.1.0",
            "desc": "Tries to import os.", "tags": [], "params": [],
            "evaluate": lambda candles, params: None}
'''

SYNTAX_ERROR = '''# SPDX-License-Identifier: CPAL-1.0
def evaluate(candles, params)
    return None
'''

# ---- fake process plumbing (deterministic timeouts / memory) ---------------------------


class FakeStream(object):
    def __init__(self, chunks=()):
        self._chunks = list(chunks)
        self.closed = False

    def read(self, size=-1):
        return self._chunks.pop(0) if self._chunks else b''

    def close(self):
        self.closed = True


class FakeProc(object):
    """Enough of ``subprocess.Popen`` for the supervisor loop."""

    def __init__(self, stdout=b'', exit_after_polls=1, returncode=0):
        self.pid = 4242
        self.stdin = io.BytesIO()
        self.stdout = FakeStream([stdout] if stdout else [])
        self.stderr = FakeStream([b'boom: child died\n'])
        self._exit_after = exit_after_polls
        self._polls = 0
        self._returncode = returncode
        self.killed = False
        self.returncode = None

    def poll(self):
        self._polls += 1
        if self.killed:
            self.returncode = -9
            return -9
        if self._exit_after is not None and self._polls > self._exit_after:
            self.returncode = self._returncode
            return self._returncode
        return None

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = self._returncode
        return self.returncode


class FakeClock(object):
    def __init__(self, start=0.0):
        self.now = float(start)

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += float(seconds)


def fake_supervisor(proc, *, rss=(None,), clock=None, limits=None):
    """A supervisor that never spawns anything: ``rss`` is a per-sample sequence."""
    clock = clock or FakeClock()
    samples = list(rss if isinstance(rss, (list, tuple)) else [rss])

    def reader(pid):
        return samples.pop(0) if len(samples) > 1 else samples[0]

    return limit_mod.Supervisor(limits=limits or limit_mod.Limits(hook_timeout_s=1.0),
                                spawn=lambda argv, cwd, env: proc,
                                rss=reader, clock=clock, sleep=clock.sleep)


# ---- helpers for the real-file tests ---------------------------------------------------


class FolderCase(unittest.TestCase):
    """A temporary strategy folder plus a library that uses the real child process."""

    limits = limit_mod.Limits()

    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix='gitrader-strategies-')
        self.addCleanup(shutil.rmtree, self.folder, True)

    def write(self, name, body):
        path = os.path.join(self.folder, name)
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(body)
        return path

    def copy_example(self, name='ema-cross.py'):
        source = os.path.join(EXAMPLES, name)
        target = os.path.join(self.folder, name)
        shutil.copyfile(source, target)
        return target

    def library(self, **overrides):
        limits = overrides.pop('limits', None) or self.limits
        return strategy_loader.StrategyLibrary(self.folder, limits=limits, env={})


# ---- Limits ----------------------------------------------------------------------------


class LimitsTests(unittest.TestCase):
    def test_defaults_are_the_documented_budgets(self):
        limits = limit_mod.Limits()
        self.assertEqual(limits.hook_timeout_s, 2.0)
        self.assertEqual(limits.backtest_timeout_s, 900.0)
        self.assertEqual(limits.memory_limit_bytes, 256 * 1024 * 1024)
        self.assertEqual(limits.hook_timeout_ms, 2000)
        self.assertEqual(limits.memory_limit_mb, 256.0)
        report = limits.to_dict()
        self.assertEqual(report['hookTimeoutMs'], 2000)
        self.assertEqual(report['backtestTimeoutMs'], 900_000)
        self.assertEqual(report['pollIntervalMs'], 20)

    def test_env_overrides_are_read(self):
        limits = limit_mod.Limits.from_env({
            limit_mod.ENV_HOOK_TIMEOUT: '0.75',
            limit_mod.ENV_BACKTEST_TIMEOUT: '12',
            limit_mod.ENV_MEMORY_MB: '64',
            limit_mod.ENV_POLL_INTERVAL: '0.05',
        })
        self.assertEqual(limits.hook_timeout_s, 0.75)
        self.assertEqual(limits.backtest_timeout_s, 12.0)
        self.assertEqual(limits.memory_limit_mb, 64.0)
        self.assertEqual(limits.poll_interval_s, 0.05)

    def test_env_ignores_unreadable_or_out_of_range_values(self):
        limits = limit_mod.Limits.from_env({
            limit_mod.ENV_HOOK_TIMEOUT: 'soon',
            limit_mod.ENV_BACKTEST_TIMEOUT: '-3',
            limit_mod.ENV_MEMORY_MB: '1',           # below the 16 MiB floor
            limit_mod.ENV_POLL_INTERVAL: '',
        })
        self.assertEqual(limits, limit_mod.Limits())

    def test_mapping_accepts_millisecond_keys(self):
        limits = limit_mod.Limits.from_mapping({'hookTimeoutMs': 500, 'memoryLimitMb': 64,
                                                'backtestTimeoutMs': 2500})
        self.assertEqual(limits.hook_timeout_s, 0.5)
        self.assertEqual(limits.memory_limit_bytes, 64 * 1024 * 1024)
        self.assertEqual(limits.backtest_timeout_s, 2.5)

    def test_rss_of_the_current_process_is_plausible(self):
        rss = limit_mod.process_rss_bytes(os.getpid())
        self.assertIsNotNone(rss, 'the RSS reader must work on this host')
        self.assertGreater(rss, 1024 * 1024)
        tree = limit_mod.process_tree_rss_bytes(os.getpid())
        self.assertIsNotNone(tree)
        self.assertGreaterEqual(tree, rss)

    def test_rss_of_a_bogus_pid_is_none(self):
        self.assertIsNone(limit_mod.process_rss_bytes(0))
        self.assertIsNone(limit_mod.process_rss_bytes(-1))
        self.assertIsNone(limit_mod.process_rss_bytes('not a pid'))
        self.assertIsNone(limit_mod.process_rss_bytes(999_999_999))
        self.assertEqual(limit_mod.process_tree(999_999_999), [])

    @unittest.skipUnless(os.name == 'nt', 'pid reuse is a Windows detail')
    def test_process_tree_drops_an_orphan_with_a_recycled_parent_pid(self):
        table = ({100: [200, 300]}, {100, 200, 300})
        births = {100: 50, 200: 10, 300: 60}
        with mock.patch.object(limit_mod, '_process_table', return_value=table), \
                mock.patch.object(limit_mod, '_creation_time', side_effect=births.__getitem__):
            self.assertEqual(limit_mod.process_tree(100), [100, 300])

    @unittest.skipUnless(os.name == 'nt', 'pid reuse is a Windows detail')
    def test_process_tree_drops_a_child_whose_creation_time_is_unreadable(self):
        table = ({100: [200, 300]}, {100, 200, 300})
        births = {100: 50, 200: 10, 300: None}
        with mock.patch.object(limit_mod, '_process_table', return_value=table), \
                mock.patch.object(limit_mod, '_creation_time', side_effect=births.__getitem__):
            self.assertEqual(limit_mod.process_tree(100), [100])

    def test_child_env_drops_every_secret(self):
        env = limit_mod.child_env({'PATH': '/usr/bin', 'GITRADER_GEP_TOKEN': 'tok',
                                   'OPENAI_API_KEY': 'sk-1', 'SystemRoot': 'C:/Windows',
                                   'MY_SECRET': 'x', 'LANG': 'C'})
        self.assertEqual(env['PATH'], '/usr/bin')
        self.assertEqual(env['SystemRoot'], 'C:/Windows')
        self.assertNotIn('GITRADER_GEP_TOKEN', env)
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('MY_SECRET', env)
        self.assertEqual(env['PYTHONDONTWRITEBYTECODE'], '1')

    @unittest.skipUnless(os.name == 'nt', 'SystemDrive is a Windows detail')
    def test_child_env_derives_system_drive_from_system_root(self):
        env = limit_mod.child_env({'PATH': 'x', 'SystemRoot': r'D:\Windows'})
        self.assertEqual(env['SystemDrive'], 'D:')

    def test_child_env_keeps_an_explicit_system_drive(self):
        env = limit_mod.child_env({'PATH': 'x', 'SystemRoot': r'C:\Windows',
                                   'SystemDrive': 'C:'})
        self.assertEqual(env['SystemDrive'], 'C:')

    def test_child_env_does_not_invent_a_system_drive(self):
        env = limit_mod.child_env({'PATH': 'x'})
        self.assertNotIn('SystemDrive', env)

    def test_supervisor_reports_a_hook_timeout(self):
        proc = FakeProc(stdout=b'', exit_after_polls=None)
        clock = FakeClock()
        supervisor = fake_supervisor(proc, clock=clock,
                                     limits=limit_mod.Limits(hook_timeout_s=1.0,
                                                             poll_interval_s=0.25))
        result = supervisor.run({'job': 'load', 'path': 'x.py'})
        self.assertEqual(result.status, 'timeout')
        self.assertEqual(result.limit, limit_mod.LIMIT_HOOK_TIMEOUT)
        self.assertIn('1000 ms', result.detail)
        self.assertTrue(proc.killed)
        self.assertGreaterEqual(clock.now, 1.0)

    def test_supervisor_reports_a_memory_breach(self):
        proc = FakeProc(stdout=b'', exit_after_polls=None)
        supervisor = fake_supervisor(proc, rss=(1 * 1024 * 1024, 40 * 1024 * 1024),
                                     limits=limit_mod.Limits(memory_limit_bytes=16 * 1024 * 1024))
        result = supervisor.run({'job': 'evaluate', 'path': 'x.py'})
        self.assertEqual(result.status, 'memory')
        self.assertEqual(result.limit, limit_mod.LIMIT_MEMORY)
        self.assertIn('16 MiB', result.detail)
        self.assertTrue(proc.killed)

    def test_supervisor_uses_the_childs_tracemalloc_peak(self):
        payload = json.dumps({'ok': True, 'peakTracemallocBytes': 200 * 1024 * 1024}).encode()
        proc = FakeProc(stdout=payload, exit_after_polls=1)
        supervisor = fake_supervisor(proc, rss=(4 * 1024 * 1024,),
                                     limits=limit_mod.Limits(memory_limit_bytes=64 * 1024 * 1024))
        result = supervisor.run({'job': 'evaluate', 'path': 'x.py'})
        self.assertEqual(result.status, 'memory')
        self.assertIn('Python heap', result.detail)
        self.assertGreaterEqual(result.peak_rss_bytes, 200 * 1024 * 1024)

    def test_supervisor_keeps_a_result_under_the_ceiling(self):
        payload = json.dumps({'ok': True, 'peakTracemallocBytes': 1024}).encode()
        proc = FakeProc(stdout=payload, exit_after_polls=1)
        supervisor = fake_supervisor(proc, rss=(4 * 1024 * 1024,),
                                     limits=limit_mod.Limits(memory_limit_bytes=64 * 1024 * 1024))
        result = supervisor.run({'job': 'load', 'path': 'x.py'})
        self.assertEqual(result.status, 'ok')
        self.assertTrue(result.payload['ok'])

    def test_supervisor_classifies_a_child_that_says_nothing(self):
        proc = FakeProc(stdout=b'', exit_after_polls=1, returncode=3)
        result = fake_supervisor(proc).run({'job': 'load', 'path': 'x.py'})
        self.assertEqual(result.status, 'crash')
        self.assertIn('boom', result.detail)

    def test_supervisor_classifies_output_that_is_not_json(self):
        proc = FakeProc(stdout=b'hello there\n', exit_after_polls=1)
        result = fake_supervisor(proc).run({'job': 'load', 'path': 'x.py'})
        self.assertEqual(result.status, 'bad-output')
        self.assertIn('JSON', result.detail)

    def test_supervisor_refuses_an_unserialisable_job(self):
        supervisor = fake_supervisor(FakeProc())
        result = supervisor.run({'job': 'load', 'path': object()})
        self.assertEqual(result.status, 'bad-output')
        self.assertIn('not JSON', result.detail)

    def test_supervisor_applies_a_per_call_budget_override(self):
        proc = FakeProc(stdout=b'', exit_after_polls=None)
        clock = FakeClock()
        supervisor = fake_supervisor(proc, clock=clock,
                                     limits=limit_mod.Limits(hook_timeout_s=30.0,
                                                             poll_interval_s=0.25))
        result = supervisor.run({'job': 'load', 'path': 'x.py'}, timeout_s=0.5)
        self.assertEqual(result.status, 'timeout')
        self.assertLess(clock.now, 5.0)

    def test_kill_tree_stops_a_grandchild(self):
        """The pid ``Popen`` returns is often a launcher; killing it must kill the worker."""
        workdir = tempfile.mkdtemp(prefix='gitrader-kill-')
        self.addCleanup(shutil.rmtree, workdir, True)
        marker = os.path.join(workdir, 'ticks.txt')
        writer = os.path.join(workdir, 'writer.py')
        launcher = os.path.join(workdir, 'launcher.py')
        with open(writer, 'w', encoding='utf-8') as handle:
            handle.write('import time\n'
                         'while True:\n'
                         '    open(%r, "a").write("x")\n'
                         '    time.sleep(0.05)\n' % marker)
        with open(launcher, 'w', encoding='utf-8') as handle:
            handle.write('import subprocess, sys, time\n'
                         'subprocess.Popen([sys.executable, %r])\n'
                         'time.sleep(30)\n' % writer)
        proc = subprocess.Popen([sys.executable, launcher])
        try:
            deadline = time.time() + 10
            while time.time() < deadline and not (os.path.exists(marker) and os.path.getsize(marker) > 4):
                time.sleep(0.05)
            self.assertTrue(os.path.exists(marker), 'the grandchild never started')
            limit_mod.kill_tree(proc.pid)
            time.sleep(0.35)
            size = os.path.getsize(marker)
            time.sleep(0.4)
            self.assertEqual(os.path.getsize(marker), size,
                             'the grandchild survived kill_tree (leftover process)')
        finally:
            limit_mod.kill_tree(proc.pid)          # never leave a writer behind
            try:
                proc.kill()
            except OSError:
                pass
            proc.wait(timeout=10)


# ---- loading ---------------------------------------------------------------------------


class FolderScanTests(FolderCase):
    def test_only_visible_py_files_are_candidates(self):
        self.write('visible.py', GOOD_STRATEGY % 'visible')
        self.write('_scratch.py', GOOD_STRATEGY % 'scratch')
        self.write('.hidden.py', GOOD_STRATEGY % 'hidden')
        self.write('notes.txt', 'not a strategy')
        library = self.library()
        self.assertEqual([os.path.basename(p) for p in library.files()], ['visible.py'])
        reports = library.scan()
        self.assertEqual([r['file'] for r in reports], ['visible.py'])
        self.assertEqual([r['id'] for r in reports], ['visible'])
        self.assertEqual(reports[0]['status'], 'loaded')
        self.assertEqual(library.ids(), ['visible'])

    def test_a_missing_folder_is_empty_not_fatal(self):
        library = strategy_loader.StrategyLibrary(os.path.join(self.folder, 'nope'),
                                                  limits=self.limits, env={})
        self.assertEqual(library.scan(), [])
        self.assertEqual(library.ids(), [])
        self.assertEqual(library.entries(), [])
        self.assertEqual(library.reports(), [])
        self.assertFalse(library.has_folder())

    def test_a_folder_is_taken_from_the_environment(self):
        directory = os.path.join(self.folder, 'from-env')
        os.makedirs(directory)
        with open(os.path.join(directory, 'x.py'), 'w', encoding='utf-8') as handle:
            handle.write(GOOD_STRATEGY % 'from-env')
        library = strategy_loader.StrategyLibrary(
            None, limits=self.limits,
            env={strategy_loader.STRATEGY_DIR_ENV: directory})
        self.assertEqual(library.directory, os.path.abspath(directory))
        self.assertEqual(library.ids(), ['from-env'])

    def test_too_many_files_are_reported_not_dropped(self):
        self.write('a.py', GOOD_STRATEGY % 'aaa')
        self.write('b.py', GOOD_STRATEGY % 'bbb')
        with mock.patch.object(strategy_loader, 'MAX_STRATEGY_FILES', 1):
            reports = self.library().scan()
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[0]['status'], 'loaded')
        self.assertEqual(reports[1]['status'], 'error')
        self.assertEqual(reports[1]['errors'][0]['rule'], 'too-many-files')

    def test_duplicate_ids_are_an_error_on_the_second_file(self):
        self.write('a.py', GOOD_STRATEGY % 'twin')
        self.write('b.py', GOOD_STRATEGY % 'twin')
        reports = self.library().scan()
        self.assertEqual([r['status'] for r in reports], ['loaded', 'error'])
        self.assertEqual(reports[1]['errors'][0]['rule'], 'duplicate-id')
        self.assertIn('a.py', reports[1]['errors'][0]['message'])

    def test_second_scan_uses_the_cache(self):
        self.write('cached.py', GOOD_STRATEGY % 'cached')
        library = self.library()
        first = library.scan()
        self.assertFalse(first[0]['cached'])
        spawns = library.spawns
        second = library.scan()
        self.assertTrue(second[0]['cached'])
        self.assertEqual(library.spawns, spawns, 'an unchanged folder must not spawn a child')

    def test_force_rescan_spawns_again(self):
        self.write('forced.py', GOOD_STRATEGY % 'forced')
        library = self.library()
        library.scan()
        spawns = library.spawns
        library.scan(force=True)
        self.assertGreater(library.spawns, spawns)


class FolderLoadTests(FolderCase):
    def test_loads_the_example_and_parses_its_params(self):
        self.copy_example('ema-cross.py')
        reports = self.library().scan()
        self.assertEqual(len(reports), 1)
        report = reports[0]
        self.assertEqual(report['status'], 'loaded')
        self.assertEqual(report['id'], 'ema-cross')
        self.assertEqual(report['version'], '0.1.0')
        self.assertIsNone(report['limit'])
        declaration = report['strategy']
        keys = [p['key'] for p in declaration['params']]
        self.assertEqual(keys, ['fast', 'slow', 'allowShort'])
        defaults = {p['key']: p['default'] for p in declaration['params']}
        self.assertEqual(defaults, {'fast': 12, 'slow': 26, 'allowShort': True})

    def test_entries_match_the_protocol_list_entry(self):
        self.write('entry.py', GOOD_STRATEGY % 'entry')
        entries = self.library().entries()
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry, {'id': 'entry', 'name': 'Test fixture', 'version': '0.1.0',
                                 'kind': 'target-position', 'paramsSchemaRef': 'strategy.params'})

    def test_describe_builds_a_schema_that_matches_the_params(self):
        self.write('described.py', GOOD_STRATEGY % 'described')
        described = self.library().describe('described')
        self.assertEqual(described['defaults'], {'period': 7, 'allowShort': False})
        schema = described['schema']
        self.assertEqual(sorted(schema['required']), ['allowShort', 'period'])
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(schema['properties']['period']['type'], 'integer')
        self.assertEqual(schema['properties']['period']['minimum'], 2)
        self.assertEqual(schema['properties']['period']['maximum'], 50)
        self.assertEqual(schema['properties']['allowShort']['type'], 'boolean')
        self.assertEqual(described['file'], 'described.py')

    def test_describe_of_an_unknown_id_raises_keyerror(self):
        with self.assertRaises(KeyError):
            self.library().describe('nope')

    def test_resolve_rejects_an_unknown_parameter(self):
        self.write('resolved.py', GOOD_STRATEGY % 'resolved')
        library = self.library()
        self.assertEqual(library.resolve('resolved', {'period': 9})['period'], 9)
        with self.assertRaises(sa.StrategyError):
            library.resolve('resolved', {'notDeclared': 1})
        with self.assertRaises(sa.StrategyError):
            library.resolve('resolved', {'period': 5000})

    def test_a_syntax_error_is_reported_with_its_rule(self):
        self.write('broken.py', SYNTAX_ERROR)
        report = self.library().scan()[0]
        self.assertEqual(report['status'], 'error')
        self.assertEqual(report['errors'][0]['rule'], 'syntax')

    def test_an_import_is_rejected_by_the_sandbox(self):
        self.write('imports.py', IMPORT_USER)
        report = self.library().scan()[0]
        self.assertEqual(report['status'], 'error')
        self.assertEqual(report['errors'][0]['rule'], 'no-import')

    def test_a_declaration_that_breaks_the_contract_is_an_error(self):
        self.write('broken-contract.py',
                   'STRATEGY = {"id": "Bad Id", "name": "", "version": "1", "desc": "",\n'
                   '            "tags": [], "params": [], "evaluate": lambda c, p: None}\n')
        report = self.library().scan()[0]
        self.assertEqual(report['status'], 'error')
        rules = {e['rule'] for e in report['errors']}
        self.assertIn('id', rules)
        self.assertIn('version', rules)

    def test_probe_returns_the_signal_summary(self):
        self.write('probed.py', GOOD_STRATEGY % 'probed')
        record = self.library().probe(os.path.join(self.folder, 'probed.py'))
        self.assertEqual(record['status'], 'loaded')
        self.assertEqual(record['signals']['bars'], strategy_loader.DEFAULT_PROBE_BARS)
        self.assertEqual(record['signals']['nonzero'], 0)
        self.assertEqual(len(record['signals']['seriesSha256']), 64)

    def test_probe_rejects_a_series_that_breaks_the_contract(self):
        self.write('short.py',
                   'def evaluate(candles, params):\n'
                   '    return {"target": [1.0], "reasons": [""], "overlays": {}, "warmup": 0}\n\n'
                   'STRATEGY = {"id": "short", "name": "Short", "version": "0.1.0",\n'
                   '            "desc": "target has one entry.", "tags": [], "params": [],\n'
                   '            "evaluate": evaluate}\n')
        record = self.library().probe(os.path.join(self.folder, 'short.py'))
        self.assertEqual(record['status'], 'error')
        self.assertEqual(record['errors'][0]['rule'], 'output-length')


class LimitBreachTests(FolderCase):
    """The three cases that used to hang or eat the engine process."""

    limits = limit_mod.Limits(hook_timeout_s=0.4, memory_limit_bytes=96 * 1024 * 1024,
                              poll_interval_s=0.01)
    # 内存用例给足钩子预算：0.4 s 在机器忙时连解释器启动都不够，超时会抢在内存上限前触发
    memory_limits = limit_mod.Limits(hook_timeout_s=5.0, memory_limit_bytes=96 * 1024 * 1024,
                                     poll_interval_s=0.01)

    def test_a_module_level_loop_hits_the_hook_timeout(self):
        self.write('module-loop.py', MODULE_LOOP)
        started = time.time()
        report = self.library().scan()[0]
        elapsed = time.time() - started
        self.assertEqual(report['status'], 'error')
        self.assertEqual(report['limit'], 'hook_timeout')
        self.assertEqual(report['errors'][0]['rule'], strategy_loader.RULE_TIMEOUT)
        self.assertIn(' 400 ms', report['errors'][0]['message'])
        self.assertLess(elapsed, 8.0, 'a module-level loop must not hang the caller')

    def test_a_hanging_evaluate_hits_the_hook_timeout(self):
        path = self.write('hook-loop.py', HOOK_LOOP)
        library = self.library()
        self.assertEqual(library.scan()[0]['status'], 'loaded')
        record = library.probe(path)
        self.assertEqual(record['status'], 'error')
        self.assertEqual(record['limit'], 'hook_timeout')
        self.assertEqual(record['errors'][0]['rule'], strategy_loader.RULE_TIMEOUT)

    def test_stderr_warning_flood_does_not_look_like_a_timeout(self):
        header = '\n'.join('_w%d = "\\d%d"' % (i, i) for i in range(400))
        self.write('warny.py', header + '\n' + GOOD_STRATEGY % 'warny')
        library = self.library(limits=limit_mod.Limits(hook_timeout_s=2.0, poll_interval_s=0.01))
        report = library.scan()[0]
        self.assertEqual(report['status'], 'loaded')
        self.assertIsNone(report['limit'])

    def test_a_resident_allocation_hits_the_memory_ceiling(self):
        path = self.write('memory-hog.py', MEMORY_HOG)
        record = self.library(limits=self.memory_limits).probe(path)
        self.assertEqual(record['status'], 'error')
        self.assertEqual(record['limit'], 'memory')
        self.assertIn('96 MiB', record['errors'][0]['message'])
        self.assertGreater(record['peakRssBytes'] or 0, 96 * 1024 * 1024)

    def test_a_large_allocation_is_rejected_whichever_detector_sees_it(self):
        """Zero pages may or may not show up in RSS; the tracemalloc peak covers the gap."""
        path = self.write('memory-peak.py', MEMORY_PEAK)
        record = self.library(limits=self.memory_limits).probe(path)
        self.assertEqual(record['status'], 'error')
        self.assertEqual(record['limit'], 'memory')
        self.assertIn('96 MiB', record['errors'][0]['message'])

    def test_the_engine_still_answers_after_a_breach(self):
        self.write('module-loop.py', MODULE_LOOP)
        library = self.library()
        library.scan()
        self.assertEqual(library.scan()[0]['status'], 'error')
        # 同一个 library（也就是同一个引擎进程）还能继续装载好策略
        self.write('good.py', GOOD_STRATEGY % 'good')
        reports = {r['file']: r for r in library.scan()}
        self.assertEqual(reports['good.py']['status'], 'loaded')


# ---- GEP face --------------------------------------------------------------------------


class FakeHost(object):
    def __init__(self, bars=60):
        self.bars = bars
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, dict(params or {})))
        if method == 'host.describe':
            return {'result': {'host': {'name': 'unit-test-host', 'version': '0.1.0'},
                               'venues': [],
                               'accounts': [{'accountId': PAPER, 'alias': 'paper',
                                             'venue': 'hyperliquid', 'environment': 'mainnet',
                                             'mode': 'paper'}]}}
        if method == 'host.market.history':
            step = gep.INTERVAL_MS.get(params.get('interval') or '1m', 60_000)
            start = params.get('from') or T0
            candles = [{'t': start + i * step, 'o': 100.0 + i * 0.1, 'h': 100.5 + i * 0.1,
                        'l': 99.5 + i * 0.1, 'c': 100.0 + i * 0.1, 'v': 10.0}
                       for i in range(self.bars)]
            return {'result': {'candles': candles, 'source': 'unit-test-synthetic', 'complete': True}}
        return {'error': {'code': -32601, 'message': 'unknown host method'}}


class GepHarness(object):
    def __init__(self, strategy_dir=None, limits=None):
        self.frames = []
        self.host = FakeHost()
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
        return frame['error']['data']

    def startup(self):
        self.call('gep.hello', {'protocol': 'gep', 'versions': ['0.1'],
                                'host': {'name': 'unit-test-host', 'version': '0.1.0'},
                                'auth': {'token': TOKEN}})
        return self.call('engine.bind', {
            'bindingId': BINDING_ID,
            'accounts': [{'accountId': PAPER, 'mode': 'A', 'mandateId': MANDATE}],
            'data': {'source': 'host', 'instruments': [BTC]},
            'policies': [], 'heartbeatMs': 5000})

    def start(self, strategy_id, params=None):
        return self.call('strategy.start', {'strategyId': strategy_id, 'accountId': PAPER,
                                           'instruments': [BTC], 'interval': '1m',
                                           'params': params or {}, 'mandateId': MANDATE})

    def spec(self, bars=60, strategy_id=None):
        return {'subject': {'strategy': {'id': strategy_id or gep.STRATEGY_ID,
                                         'version': gep.STRATEGY_VERSION, 'params': {}}},
                'instruments': [BTC], 'interval': '1m', 'from': T0, 'to': T0 + bars * 60_000,
                'data': {'source': 'host'},
                'account': {'initialBalance': '10000', 'ccy': 'USDC'},
                'assumptions': {'fees': 'venue', 'slippageBps': 2,
                                'fillModel': 'next-bar-open', 'funding': False,
                                'liquidation': False},
                'seed': 42}


class GepStrategyFolderTests(FolderCase):
    def test_strategy_list_puts_the_builtin_first_and_the_folder_after(self):
        self.write('listed.py', GOOD_STRATEGY % 'listed')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        listed = harness.call('strategy.list')['strategies']
        self.assertEqual(listed[0]['id'], gep.STRATEGY_ID)
        self.assertEqual([e['id'] for e in listed], [gep.STRATEGY_ID, 'listed'])

    def test_strategy_list_still_answers_when_a_file_is_broken(self):
        self.write('broken.py', SYNTAX_ERROR)
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        listed = harness.call('strategy.list')['strategies']
        self.assertEqual([e['id'] for e in listed], [gep.STRATEGY_ID])

    def test_strategy_params_answers_for_a_file_strategy(self):
        self.write('params.py', GOOD_STRATEGY % 'params')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        answer = harness.call('strategy.params', {'strategyId': 'params'})
        self.assertEqual(answer['defaults'], {'period': 7, 'allowShort': False})
        self.assertEqual(sorted(answer['schema']['properties']), ['allowShort', 'period'])

    def test_strategy_params_unknown_id_is_a_protocol_error(self):
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        problem = harness.error_of('strategy.params', {'strategyId': 'ghost'})
        self.assertEqual(problem['code'], -32602)
        self.assertEqual(problem['name'], 'INVALID_PARAMS')
        self.assertIn(gep.STRATEGY_ID, problem['message'])

    def test_strategy_params_requires_an_id(self):
        harness = GepHarness()
        harness.startup()
        self.assertEqual(harness.error_of('strategy.params', {})['code'], -32602)

    def test_starting_a_file_strategy_resolves_its_own_params(self):
        self.write('started.py', GOOD_STRATEGY % 'started')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        started = harness.start('started', {'period': 9})
        self.assertEqual(started['status'], 'running')
        status = harness.call('strategy.status', {'instanceId': started['instanceId']})
        self.assertEqual(status['instances'][0]['params'], {'period': 9, 'allowShort': False})

    def test_starting_a_file_strategy_rejects_an_undeclared_param(self):
        self.write('started.py', GOOD_STRATEGY % 'started')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        problem = harness.error_of('strategy.start', {
            'strategyId': 'started', 'accountId': PAPER, 'instruments': [BTC],
            'params': {'nope': 1}, 'mandateId': MANDATE})
        self.assertEqual(problem['code'], -32602)

    def test_starting_a_strategy_whose_hook_hangs_returns_4002(self):
        self.write('hook-loop.py', HOOK_LOOP)
        harness = GepHarness(strategy_dir=self.folder,
                             limits=limit_mod.Limits(hook_timeout_s=0.4, poll_interval_s=0.01))
        harness.startup()
        started = time.time()
        problem = harness.error_of('strategy.start', {
            'strategyId': 'hook-loop', 'accountId': PAPER, 'instruments': [BTC],
            'params': {}, 'mandateId': MANDATE})
        self.assertEqual(problem['code'], 4002)
        self.assertEqual(problem['name'], 'STRATEGY_ERROR')
        self.assertIn('hook-timeout', problem['message'])
        self.assertLess(time.time() - started, 8.0)
        # 引擎还活着：同一个会话里紧接着 start 内置策略
        self.assertEqual(harness.start(gep.STRATEGY_ID)['status'], 'running')

    def test_update_uses_the_file_strategys_declarations(self):
        self.write('updatable.py', GOOD_STRATEGY % 'updatable')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        instance = harness.start('updatable')
        applied = harness.call('strategy.update', {'instanceId': instance['instanceId'],
                                                   'params': {'period': 11}})
        self.assertEqual(applied['status'], 'running')
        self.assertEqual(harness.error_of('strategy.update', {
            'instanceId': instance['instanceId'], 'params': {'bogus': 2}})['code'], -32602)

    def test_describe_declares_the_strategy_folder_capability(self):
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        describe = harness.call('engine.describe')
        self.assertIs(describe['capabilities']['x-gitrader.strategy-folder'], True)
        self.assertEqual(describe['strategies'][0]['id'], gep.STRATEGY_ID)

    def test_describe_lists_the_folder_when_it_has_strategies(self):
        self.write('visible.py', GOOD_STRATEGY % 'visible')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        describe = harness.call('engine.describe')
        self.assertIn('visible', [s['id'] for s in describe['strategies']])

    def test_strategy_files_reports_the_folder_and_the_limits(self):
        self.write('reported.py', GOOD_STRATEGY % 'reported')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        answer = harness.call('x-gitrader.strategy.files', {})
        self.assertEqual(answer['dir'], self.folder)
        self.assertEqual(answer['loaded'], ['reported'])
        self.assertEqual([f['file'] for f in answer['files']], ['reported.py'])
        self.assertIn('limit', answer['files'][0])
        self.assertEqual(answer['limits']['hookTimeoutMs'], 2000)

    def test_strategy_files_can_probe_one_file(self):
        self.write('probed.py', GOOD_STRATEGY % 'probed')
        self.write('hook-loop.py', HOOK_LOOP)
        harness = GepHarness(strategy_dir=self.folder,
                             limits=limit_mod.Limits(hook_timeout_s=0.4, poll_interval_s=0.01))
        harness.startup()
        answer = harness.call('x-gitrader.strategy.files', {'file': 'probed.py'})
        self.assertEqual(answer['strategy']['status'], 'loaded')
        self.assertEqual(answer['strategy']['file'], 'probed.py')
        breached = harness.call('x-gitrader.strategy.files', {'file': 'hook-loop.py'})
        self.assertEqual(breached['strategy']['status'], 'error')
        self.assertEqual(breached['strategy']['limit'], 'hook_timeout')

    def test_strategy_files_rejects_a_path_instead_of_a_name(self):
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        problem = harness.error_of('x-gitrader.strategy.files', {'file': '../secrets.py'})
        self.assertEqual(problem['code'], -32602)

    def test_strategy_files_requires_its_capability(self):
        harness = GepHarness()
        harness.startup()
        harness.conn.library = None
        with mock.patch.dict(gep.CAPABILITIES, {'x-gitrader.strategy-folder': False}):
            problem = harness.error_of('x-gitrader.strategy.files', {})
        self.assertEqual(problem['code'], 5002)

    def test_backtest_runs_a_file_strategy(self):
        # P5.2: backtest.run is wired to the simulator and accepts folder strategies.
        self.write('backtestable.py', GOOD_STRATEGY % 'backtestable')
        harness = GepHarness(strategy_dir=self.folder)
        harness.startup()
        job_id = harness.call('backtest.run', {'spec': harness.spec(60, 'backtestable')})['jobId']
        deadline = time.time() + 30.0
        while time.time() < deadline and harness.conn.jobs[job_id]['state'] in ('queued', 'running'):
            time.sleep(0.01)
        self.assertEqual(harness.conn.jobs[job_id]['state'], 'done',
                         harness.conn.jobs[job_id].get('error'))
        result = harness.call('backtest.result', {'jobId': job_id})
        self.assertEqual(result['engine']['id'], gep.ENGINE_ID)
        self.assertGreater(len(result['equity']), 0)
        self.assertTrue(result['strategySha256'].startswith('sha256:'))


class GepBacktestBudgetTests(FolderCase):
    def test_the_deadline_helper_reads_the_clock(self):
        job = {'deadline': time.monotonic() - 1.0}
        self.assertTrue(gep._backtest_expired(None, job))
        job = {'deadline': time.monotonic() + 30.0}
        self.assertFalse(gep._backtest_expired(None, job))
        self.assertFalse(gep._backtest_expired(None, {}))

    def test_a_backtest_over_its_budget_fails_with_4002_and_the_engine_lives(self):
        harness = GepHarness(limits=limit_mod.Limits(backtest_timeout_s=0.000001))
        harness.startup()
        # 墙钟被冻结在同一个 tick 上时 1 µs 的预算不会过期，所以这里把「已经过期」
        # 这一事实直接注入，测的是过期之后的行为（回测循环协作退出 → 4002 → 引擎仍在）。
        with mock.patch.object(gep, '_backtest_expired', lambda conn, job: True):
            job = harness.call('backtest.run', {'spec': harness.spec(200)})
            deadline = time.time() + 10
            while time.time() < deadline and harness.conn.jobs[job['jobId']]['state'] not in ('done', 'failed'):
                time.sleep(0.01)
        self.assertEqual(harness.conn.jobs[job['jobId']]['state'], 'failed')
        problem = harness.error_of('backtest.result', {'jobId': job['jobId']})
        self.assertEqual(problem['code'], 4002)
        self.assertIn('configured limit', problem['message'])
        # 引擎本身没死：还能答 health 与 describe
        self.assertEqual(harness.call('engine.health')['status'], 'ok')
        self.assertEqual(harness.call('engine.describe')['engine']['id'], gep.ENGINE_ID)

    def test_the_default_budget_is_wide_enough_for_a_normal_run(self):
        harness = GepHarness()
        harness.startup()
        self.assertEqual(harness.conn.limits.backtest_timeout_s, 900.0)
        job = harness.call('backtest.run', {'spec': harness.spec(120)})
        deadline = time.time() + 20
        while time.time() < deadline and harness.conn.jobs[job['jobId']]['state'] not in ('done', 'failed'):
            time.sleep(0.01)
        self.assertEqual(harness.conn.jobs[job['jobId']]['state'], 'done')


if __name__ == '__main__':
    unittest.main()
