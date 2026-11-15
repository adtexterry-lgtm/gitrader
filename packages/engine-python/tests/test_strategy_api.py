# SPDX-License-Identifier: CPAL-1.0
"""strategy_api + sandbox + 十个示例策略的离线单测（标准库 unittest，无第三方依赖）。

跑法（仓库根或任意目录）：
    python -m unittest packages/engine-python/tests/test_strategy_api.py -v

覆盖：参数解析（min / max / options / 类型 / 未知键 / 夹取）、结构校验、信号构造（协议 signal.ts）、
输出形状与前视偏差校验、沙箱的每个禁用项、十个示例的加载与语义冒烟，以及一组来自 TS 参考实现的
行为签名（见 TS_SIGNATURES）。
"""

import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXAMPLES_DIR = os.path.join(ROOT, "examples")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:  # 正常路径：engine 是命名空间包
    from engine import sandbox as sb
    from engine import strategy_api as sa
except Exception:  # pragma: no cover - 兄弟蜂若加了 engine/__init__.py 且导入失败，按文件路径兜底
    def _load(name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    sb = _load("gitrader_engine_sandbox", os.path.join(ROOT, "engine", "sandbox.py"))
    sys.modules.setdefault("sandbox", sb)
    sa = _load("gitrader_engine_strategy_api", os.path.join(ROOT, "engine", "strategy_api.py"))

CANDLES = sa.synth_candles(600)
EXAMPLE_FILES = sorted(f for f in os.listdir(EXAMPLES_DIR) if f.endswith(".py") and not f.startswith("_"))


def load(name):
    """按文件名加载示例策略（'ema-cross' → examples/ema-cross.py）。"""
    return sa.load_strategy_file(os.path.join(EXAMPLES_DIR, name + ".py"))


#: 由 TS 参考实现（packages/engine-core/examples/strategies/*.ts）在**同一份** synth_candles(600) 上跑出来的
#: 行为签名：warmup / 非零根数 / target 之和（9 位小数）/ 变化次数 / 首次变化下标 / 末次变化下标 / 最大绝对值。
#: 一次性脚本：`node --experimental-strip-types` 导入 .ts 示例，读 candles.json，导出这些数。
#: 全字段相等 = 十个示例与 TS 版同语义（逐根 1e-9 的全量比对在 P1.3 的跨引擎一致性测试里做）。
TS_SIGNATURES = {
    "ema-cross": {"warmup": 26, "nonzero": 574, "sum": 118.0, "changes": 24, "first": 26, "last": 599, "maxabs": 1.0},
    "breakout": {"warmup": 20, "nonzero": 443, "sum": 157.0, "changes": 36, "first": 26, "last": 593, "maxabs": 1.0},
    "dca": {"warmup": 0, "nonzero": 600, "sum": 492.0, "changes": 10, "first": 0, "last": 216, "maxabs": 1.0},
    "grid": {"warmup": 0, "nonzero": 376, "sum": 178.375, "changes": 43, "first": 0, "last": 376, "maxabs": 0.75},
    "martingale": {"warmup": 1, "nonzero": 567, "sum": 66.4, "changes": 65, "first": 1, "last": 551, "maxabs": 0.2},
    "mean-reversion": {"warmup": 19, "nonzero": 314, "sum": -106.0, "changes": 41, "first": 45, "last": 599, "maxabs": 1.0},
    "momentum-roc": {"warmup": 20, "nonzero": 129, "sum": 69.0, "changes": 56, "first": 37, "last": 567, "maxabs": 1.0},
    "rsi-reversion": {"warmup": 14, "nonzero": 182, "sum": -114.0, "changes": 16, "first": 90, "last": 568, "maxabs": 1.0},
    "supertrend": {"warmup": 9, "nonzero": 591, "sum": 213.0, "changes": 22, "first": 9, "last": 599, "maxabs": 1.0},
    "trend-atr": {"warmup": 50, "nonzero": 294, "sum": 124.0, "changes": 20, "first": 50, "last": 569, "maxabs": 1.0},
}


def signature(series):
    prev = 0.0
    changes = []
    nonzero = 0
    for i, t in enumerate(series.target):
        if abs(t) > 1e-12:
            nonzero += 1
        if abs(t - prev) > 1e-9:
            changes.append(i)
        prev = t
    return {
        "warmup": series.warmup,
        "nonzero": nonzero,
        "sum": round(sum(series.target), 9),
        "changes": len(changes),
        "first": changes[0] if changes else None,
        "last": changes[-1] if changes else None,
        "maxabs": round(max((abs(t) for t in series.target), default=0.0), 9),
    }


# ───────────── 参数解析 ─────────────


class ParamParsingTests(unittest.TestCase):
    def test_defaults_are_derived_from_param_defs(self):
        st = load("ema-cross")
        self.assertEqual(st.defaults, {"fast": 12, "slow": 26, "allowShort": True})
        self.assertEqual(st.resolve(), st.defaults)
        self.assertEqual(st.resolve({}), st.defaults)

    def test_override_coerces_types(self):
        st = load("grid")
        resolved = st.resolve({"maxExposure": 1, "grids": 4.0, "gridMode": "geometric"})
        self.assertEqual(resolved["maxExposure"], 1.0)
        self.assertIsInstance(resolved["maxExposure"], float)   # int 输入 → float 参数
        self.assertEqual(resolved["grids"], 4)
        self.assertIsInstance(resolved["grids"], int)           # float 整数值 → integer 参数
        self.assertEqual(resolved["gridMode"], "geometric")

    def test_below_min_is_rejected(self):
        st = load("ema-cross")
        with self.assertRaises(sa.ParamError) as ctx:
            st.resolve({"fast": 1})
        self.assertEqual([i.rule for i in ctx.exception.issues], ["param-range"])
        self.assertIn("below min", ctx.exception.issues[0].message)

    def test_above_max_is_rejected(self):
        st = load("rsi-reversion")
        with self.assertRaises(sa.ParamError) as ctx:
            st.resolve({"period": 101})
        self.assertEqual(ctx.exception.issues[0].rule, "param-range")
        self.assertIn("above max", ctx.exception.issues[0].message)

    def test_integer_param_rejects_fraction(self):
        st = load("ema-cross")
        with self.assertRaises(sa.ParamError) as ctx:
            st.resolve({"fast": 12.5})
        self.assertEqual(ctx.exception.issues[0].rule, "param-type")

    def test_select_rejects_unknown_option(self):
        st = load("grid")
        with self.assertRaises(sa.ParamError) as ctx:
            st.resolve({"boundaryAction": "liquidate"})
        self.assertEqual(ctx.exception.issues[0].rule, "param-value")
        self.assertIn("stop_loss", ctx.exception.issues[0].message)

    def test_boolean_param_is_strict(self):
        st = load("ema-cross")
        with self.assertRaises(sa.ParamError):
            st.resolve({"allowShort": 1})

    def test_unknown_key_is_rejected(self):
        st = load("ema-cross")
        with self.assertRaises(sa.ParamError) as ctx:
            st.resolve({"fasst": 10})
        self.assertEqual(ctx.exception.issues[0].rule, "param-unknown")
        self.assertIn("fast", ctx.exception.issues[0].hint)

    def test_clamp_mode_keeps_values_inside_declared_bounds(self):
        st = load("grid")
        resolved = st.resolve({"grids": 99, "rangeRatio": 0.001, "boundaryAction": "nope"}, clamp=True)
        self.assertEqual(resolved["grids"], 50)      # max
        self.assertEqual(resolved["rangeRatio"], 0.01)  # min
        self.assertEqual(resolved["boundaryAction"], "pause")  # 回落到 default

    def test_param_def_check_flags_bad_defaults(self):
        cases = [
            ({"key": "period", "label": "周期", "type": "integer", "default": 1, "min": 5}, "param-range"),
            ({"key": "mode", "label": "模式", "type": "select", "default": "a"}, "param-options"),
            ({"key": "mode", "label": "模式", "type": "select", "default": "c", "options": ["a", "b"]}, "param-default"),
            ({"key": "size", "label": "仓位", "type": "number", "default": 1}, "param-key"),
            ({"key": "Bad Key", "label": "x", "type": "number", "default": 1}, "param-key"),
            ({"key": "flag", "label": "开关", "type": "boolean", "default": 0}, "param-default"),
            ({"key": "k", "label": "倍数", "type": "number", "default": 5, "min": 10, "max": 1}, "param-range"),
        ]
        for raw, rule in cases:
            with self.subTest(raw=raw):
                rules = [i.rule for i in sa.ParamDef.from_dict(raw).check()]
                self.assertIn(rule, rules)

    def test_duplicate_param_keys_are_reported(self):
        raw = {
            "id": "dup-params",
            "name": "Dup",
            "version": "0.1.0",
            "desc": "两个同名参数，只用于测试。",
            "tags": [],
            "params": [
                {"key": "period", "label": "周期", "type": "integer", "default": 5},
                {"key": "period", "label": "周期2", "type": "integer", "default": 6},
            ],
            "evaluate": lambda candles, p: sa.SignalSeries.empty(len(candles)),
        }
        rules = [i.rule for i in sa.check_structure(raw)]
        self.assertIn("param-key", rules)


# ───────────── 结构校验 ─────────────


class StructureTests(unittest.TestCase):
    def test_check_structure_accepts_every_example(self):
        self.assertEqual(len(EXAMPLE_FILES), 10)
        for filename in EXAMPLE_FILES:
            with self.subTest(example=filename):
                st = sa.load_strategy_file(os.path.join(EXAMPLES_DIR, filename))
                raw = {
                    "id": st.id,
                    "name": st.name,
                    "version": st.version,
                    "desc": st.desc,
                    "tags": st.tags,
                    "params": [d.to_dict() for d in st.params],
                    "evaluate": st.evaluate,
                }
                if st.name_zh:
                    raw["nameZh"] = st.name_zh
                if st.anchor is not None:
                    raw["anchor"] = st.anchor
                self.assertEqual(sa.check_structure(raw), [])
                self.assertTrue(1 <= len(st.params) <= sa.MAX_PARAMS)

    def test_check_structure_rejects_bad_id_and_version(self):
        raw = {
            "id": "Bad ID",
            "name": "",
            "version": "1",
            "desc": "d",
            "tags": "nope",
            "params": [],
            "evaluate": lambda candles, p: {},
        }
        rules = {i.rule for i in sa.check_structure(raw)}
        self.assertTrue({"id", "name", "version", "tags"} <= rules, rules)

    def test_check_structure_rejects_promise_language_in_desc(self):
        promise = "本策略" + "稳" + "赚"  # 词表在 PROMISE_WORDS 里；这里拼接，避免源码直接出现营销词
        raw = {
            "id": "promising",
            "name": "Promising",
            "version": "0.1.0",
            "desc": promise + "，回撤很小。",
            "tags": [],
            "params": [],
            "evaluate": lambda candles, p: {},
        }
        issues = sa.check_structure(raw)
        self.assertIn("no-promise", {i.rule for i in issues})

    def test_check_structure_rejects_unknown_fields_and_missing_evaluate(self):
        raw = {
            "id": "unknown-fields",
            "name": "Unknown",
            "version": "0.1.0",
            "desc": "只用于测试。",
            "tags": [],
            "params": [],
            "signal": "oops",
        }
        rules = {i.rule for i in sa.check_structure(raw)}
        self.assertIn("unknown-field", rules)
        self.assertIn("evaluate", rules)


# ───────────── 信号模型（协议 signal.ts）─────────────


def make_signal(**kwargs):
    base = dict(
        signal_id="sig-1",
        ts=1_760_000_000_000,
        instrument_id="BTC-PERP",
        kind="target",
        reason="测试",
        expires_at=1_760_000_060_000,
        target=1.0,
    )
    base.update(kwargs)
    return sa.Signal(**base)


class SignalTests(unittest.TestCase):
    def test_signal_target_roundtrip(self):
        signal = make_signal(target=0.5)
        self.assertEqual(signal.check(), [])
        payload = signal.to_dict()
        self.assertEqual(payload["kind"], "target")
        self.assertEqual(payload["target"], 0.5)
        self.assertEqual(payload["expiresAt"], 1_760_000_060_000)

    def test_signal_requires_target_for_kind_target(self):
        issues = make_signal(target=None).check()
        self.assertIn("signal-target", {i.rule for i in issues})

    def test_signal_rejects_out_of_range_target(self):
        issues = make_signal(target=1.5).check()
        self.assertIn("signal-target", {i.rule for i in issues})

    def test_signal_strength_requires_method(self):
        self.assertIn("signal-strength", {i.rule for i in make_signal(strength=0.7).check()})
        self.assertEqual(make_signal(strength=0.7, method="score-v1").check(), [])

    def test_signal_requires_expiry_after_ts(self):
        self.assertIn("signal-expiry", {i.rule for i in make_signal(expires_at=1_760_000_000_000).check()})

    def test_signals_from_series_emits_one_signal_per_change(self):
        series = sa.SignalSeries(
            target=[0.0, 1.0, 1.0, 0.0],
            reasons=["", "上穿 → 做多", "", "回落 → 平仓"],
            overlays={},
            warmup=0,
        )
        signals = sa.signals_from_series(
            series, CANDLES[:4], instrument_id="BTC-PERP", signal_id_prefix="ema-cross", ttl_ms=60_000
        )
        self.assertEqual(len(signals), 2)
        self.assertEqual([s.target for s in signals], [1.0, 0.0])
        self.assertEqual(signals[0].signal_id, "ema-cross-000001")
        self.assertEqual(signals[0].ts, int(CANDLES[1]["t"]))
        self.assertEqual(signals[0].expires_at, int(CANDLES[1]["t"]) + 60_000)
        self.assertEqual(signals[1].reason, "回落 → 平仓")
        self.assertTrue(all(s.check() == [] for s in signals))

    def test_signals_from_series_rejects_non_positive_ttl(self):
        series = sa.SignalSeries(target=[1.0], reasons=["做多"], overlays={}, warmup=0)
        with self.assertRaises(sa.StrategyError):
            sa.signals_from_series(series, CANDLES[:1], instrument_id="X", signal_id_prefix="s", ttl_ms=0)


# ───────────── 输出形状 / 前视偏差 ─────────────


class SeriesValidationTests(unittest.TestCase):
    def test_validate_series_accepts_good_output(self):
        out = {"target": [0.0, 1.0, 1.0], "reasons": ["", "做多", ""], "overlays": {"EMA12": [None, 1.0, 2.0]}, "warmup": 1}
        issues, series = sa.validate_series(out, 3)
        self.assertEqual(issues, [])
        self.assertIsNotNone(series)
        self.assertEqual(series.warmup, 1)

    def test_validate_series_reports_length_mismatch(self):
        issues, series = sa.validate_series({"target": [1.0, 1.0], "reasons": ["a", ""], "overlays": {}, "warmup": 0}, 3)
        self.assertIsNone(series)
        self.assertEqual(issues[0].rule, "output-length")

    def test_validate_series_reports_nan_and_out_of_range(self):
        nan_issues, _ = sa.validate_series(
            {"target": [0.0, float("nan"), 0.0], "reasons": ["", "x", ""], "overlays": {}, "warmup": 0}, 3
        )
        self.assertIn("output-target", {i.rule for i in nan_issues})
        range_issues, _ = sa.validate_series(
            {"target": [0.0, 1.5, 0.0], "reasons": ["", "x", ""], "overlays": {}, "warmup": 0}, 3
        )
        self.assertIn("output-target", {i.rule for i in range_issues})

    def test_validate_series_requires_reason_on_change(self):
        issues, _ = sa.validate_series(
            {"target": [0.0, 1.0, 0.0], "reasons": ["", "", ""], "overlays": {}, "warmup": 0}, 3
        )
        self.assertEqual([i.rule for i in issues], ["reason-missing"])
        self.assertIn("index 1", issues[0].message)

    def test_validate_series_checks_overlays_and_warmup(self):
        issues, _ = sa.validate_series(
            {"target": [0.0], "reasons": [""], "overlays": {"EMA": [1.0, 2.0]}, "warmup": -1}, 1
        )
        rules = {i.rule for i in issues}
        self.assertIn("output-overlays", rules)
        self.assertIn("output-warmup", rules)

    def test_validate_series_flags_overlay_count(self):
        overlays = {("line%d" % i): [0.0] for i in range(13)}
        issues, _ = sa.validate_series({"target": [0.0], "reasons": [""], "overlays": overlays, "warmup": 0}, 1)
        self.assertIn("output-overlays", {i.rule for i in issues})

    def test_validate_strategy_flags_lookahead(self):
        source = """
def evaluate(candles, p):
    n = len(candles)
    total = sum([c["c"] for c in candles]) / n if n else 0.0
    target = [1.0 if c["c"] > total else 0.0 for c in candles]
    reasons = ["高于全样本均价 → 做多" if t else "" for t in target]
    return {"target": target, "reasons": reasons, "overlays": {}, "warmup": 0}

STRATEGY = {
    "id": "peeker", "name": "Peeker", "version": "0.1.0",
    "desc": "有意读取全样本均价，只用于测试前视偏差检测。", "tags": [],
    "params": [], "evaluate": evaluate,
}
"""
        st = sa.load_strategy_source(source, file="peeker.py")
        report = sa.validate_strategy(st)
        self.assertIn("lookahead", {i.rule for i in report.errors})

    def test_validate_strategy_flags_non_determinism(self):
        source = """
_COUNTER = [0]

def evaluate(candles, p):
    _COUNTER[0] += 1
    n = len(candles)
    value = 1.0 if _COUNTER[0] % 2 else 0.0
    return {"target": [value] * n, "reasons": ["翻转" if value else ""] * n, "overlays": {}, "warmup": 0}

STRATEGY = {
    "id": "flaky", "name": "Flaky", "version": "0.1.0",
    "desc": "每次调用结果不同，只用于测试确定性检测。", "tags": [],
    "params": [], "evaluate": evaluate,
}
"""
        st = sa.load_strategy_source(source, file="flaky.py")
        report = sa.validate_strategy(st)
        self.assertIn("non-deterministic", {i.rule for i in report.errors})


# ───────────── 沙箱：模块白名单 ─────────────


class SandboxModuleTests(unittest.TestCase):
    def _rules(self, source, profile=sb.PROFILE_STRATEGY):
        return [i.rule for i in sb.check_source(source, profile=profile)]

    def test_rejects_import_os(self):
        self.assertIn("no-import", self._rules("import os\ndata = os.listdir('.')"))

    def test_rejects_import_sys(self):
        self.assertIn("no-import", self._rules("import sys\nx = sys.argv"))

    def test_rejects_import_subprocess(self):
        self.assertIn("no-import", self._rules("import subprocess\nsubprocess.run(['ls'])"))

    def test_rejects_import_socket(self):
        self.assertIn("no-import", self._rules("import socket\ns = socket.socket()"))

    def test_rejects_import_from_os(self):
        self.assertIn("no-import", self._rules("from os import path\np = path.join('a', 'b')"))

    def test_rejects_any_import_in_strategy_profile(self):
        for source in ("import math\nx = math.pi", "import statistics", "from collections import deque"):
            with self.subTest(source=source):
                self.assertIn("no-import", self._rules(source))

    def test_script_profile_allows_whitelisted_modules(self):
        for module in ("math", "statistics", "decimal", "collections"):
            with self.subTest(module=module):
                self.assertEqual(self._rules("import %s" % module, profile=sb.PROFILE_SCRIPT), [])

    def test_script_profile_rejects_modules_outside_whitelist(self):
        for module in ("os", "numpy", "requests", "pathlib"):
            with self.subTest(module=module):
                self.assertIn("forbidden-module", self._rules("import %s" % module, profile=sb.PROFILE_SCRIPT))

    def test_script_profile_rejects_star_import(self):
        self.assertIn("star-import", self._rules("from math import *", profile=sb.PROFILE_SCRIPT))

    def test_safe_import_raises_for_os(self):
        with self.assertRaises(ImportError):
            sb.safe_import("os")

    def test_script_profile_runs_whitelisted_module(self):
        namespace = sb.run("import math\nROOT = math.sqrt(9.0)", profile=sb.PROFILE_SCRIPT)
        self.assertEqual(namespace["ROOT"], 3.0)

    def test_module_proxy_hides_loader_attributes(self):
        # 静态校验先挡住源码里的 __loader__；这里直接验运行期的模块代理（绕过源码扫描的那条路）。
        proxy = sb.safe_import("math")
        with self.assertRaises(AttributeError):
            proxy.__loader__
        with self.assertRaises(AttributeError):
            proxy.__spec__
        self.assertEqual(proxy.sqrt(16.0), 4.0)


# ───────────── 沙箱：禁用内置 ─────────────


class SandboxBuiltinTests(unittest.TestCase):
    def _rules(self, source):
        return [i.rule for i in sb.check_source(source)]

    def test_rejects_open(self):
        self.assertIn("forbidden-name", self._rules("handle = open('secret.txt')"))

    def test_rejects_eval(self):
        self.assertIn("forbidden-name", self._rules("value = eval('1 + 1')"))

    def test_rejects_exec(self):
        self.assertIn("forbidden-name", self._rules("exec('x = 1')"))

    def test_rejects_dunder_import(self):
        self.assertIn("forbidden-name", self._rules("os = __import__('os')"))

    def test_rejects_compile(self):
        self.assertIn("forbidden-name", self._rules("code = compile('1', '<s>', 'eval')"))

    def test_rejects_getattr(self):
        self.assertIn("forbidden-name", self._rules("fn = getattr(object, 'x', None)"))

    def test_rejects_input(self):
        self.assertIn("forbidden-name", self._rules("answer = input('?')"))

    def test_rejects_dunder_escape(self):
        rules = self._rules("classes = ().__class__.__base__.__subclasses__()")
        self.assertIn("forbidden-attr", rules)

    def test_rejects_globals(self):
        self.assertIn("forbidden-name", self._rules("snapshot = globals()"))

    def test_rejects_generator_frame_accessors(self):
        rules = self._rules("X = (x for x in []).gi_frame")
        self.assertIn("forbidden-attr", rules)

    def test_rejects_frame_chain_attributes(self):
        rules = self._rules("def f():\n    return f.f_back\n")
        self.assertIn("forbidden-attr", rules)

    def test_rejects_frame_attributes_as_bare_names(self):
        self.assertIn("forbidden-name", self._rules("X = f_back"))

    def test_rejects_format_field_attribute_traversal(self):
        rules = self._rules('_X = "{0.__class__}".format(1)\n')
        self.assertIn("forbidden-attr", rules)
        self.assertIn("dunder-string", rules)

    def test_rejects_format_calls(self):
        self.assertIn("forbidden-attr", self._rules('_X = "{}".format(1)\n'))

    def test_rejects_format_map_calls(self):
        self.assertIn("forbidden-attr", self._rules('_X = "{a}".format_map({"a": 1})\n'))

    def test_plain_underscores_are_not_dunder_strings(self):
        self.assertEqual(self._rules('_X = "a__b"\n'), [])
        self.assertEqual(self._rules('_X = "__"\n'), [])

    def test_examples_have_no_dunder_string_false_positives(self):
        self.assertEqual(len(EXAMPLE_FILES), 10)
        for filename in EXAMPLE_FILES:
            with self.subTest(example=filename):
                with open(os.path.join(EXAMPLES_DIR, filename), encoding="utf-8") as handle:
                    self.assertEqual(sb.check_source(handle.read()), [])

    def test_print_is_not_available(self):
        self.assertNotIn("print", sb.build_safe_builtins())
        namespace = {"__builtins__": sb.build_safe_builtins()}
        with self.assertRaises(NameError):
            exec(compile("print('leaks into stdout')", "<sandbox>", "exec", dont_inherit=True), namespace)

    def test_forbidden_names_are_absent_from_runtime_builtins(self):
        builtins = sb.build_safe_builtins()
        for name in ("open", "eval", "exec", "compile", "globals", "locals", "getattr", "setattr", "input", "type"):
            with self.subTest(name=name):
                self.assertNotIn(name, builtins)
        self.assertIn("sum", builtins)
        self.assertIn("__import__", builtins)

    def test_runtime_builtins_cannot_open_files(self):
        # 静态校验会先报 open；这里绕过静态校验，直接证明运行期 builtins 里也没有 open。
        namespace = {"__builtins__": sb.build_safe_builtins()}
        with self.assertRaises(NameError):
            exec(compile("handle = open('nope.txt')", "<sandbox>", "exec", dont_inherit=True), namespace)

    # ── L4-05：class / 描述符 / 未放行的 builtins 在 AST 层点名 ──

    def test_rejects_class_definitions_with_the_class_rule(self):
        # 以前 class 过静态检查、运行期才 NameError: __build_class__ not found。
        issues = sb.check_source("class Grid:\n    step = 0.01\n")
        self.assertEqual([i.rule for i in issues], ["class"])
        self.assertEqual(issues[0].line, 1)
        self.assertIn("Grid", issues[0].message)

    def test_rejects_descriptor_names_with_unsupported_builtin(self):
        for source in ("X = staticmethod(sum)\n", "X = classmethod(sum)\n", "X = property(sum)\n"):
            with self.subTest(source=source):
                self.assertEqual([i.rule for i in sb.check_source(source)], ["unsupported-builtin"])

    def test_rejects_decorated_method_at_parse_time(self):
        issues = sb.check_source("class Grid:\n    @staticmethod\n    def f():\n        return 1\n")
        self.assertEqual({i.rule for i in issues}, {"class", "unsupported-builtin"})

    def test_rejects_names_that_are_not_in_the_sandbox_builtins(self):
        for name in ("chr", "format", "memoryview"):
            with self.subTest(name=name):
                self.assertEqual([i.rule for i in sb.check_source("X = %s(1)\n" % name)], ["unsupported-builtin"])
        builtins = sb.build_safe_builtins()
        for name in ("chr", "format", "memoryview", "staticmethod", "classmethod", "property"):
            with self.subTest(name=name):
                # 只让失败可读，不放宽：这些名字仍然不在运行期 builtins 里。
                self.assertNotIn(name, builtins)

    def test_plain_strategy_without_class_is_clean(self):
        # 反证：新规则不误伤普通策略（无 class、无这些名字）。
        source = ('def evaluate(candles, params):\n'
                  '    return {"target": [0.0] * len(candles), "reasons": [""] * len(candles),\n'
                  '            "overlays": {}, "warmup": 0}\n'
                  'STRATEGY = {"id": "clean", "name": "clean", "version": "0.1.0",\n'
                  '            "desc": "", "tags": [], "params": [], "evaluate": evaluate}\n')
        self.assertEqual(sb.check_source(source), [])


# ───────────── 沙箱：源码限制与加载 ─────────────


class SandboxSourceTests(unittest.TestCase):
    def test_syntax_error_is_reported(self):
        issues = sb.check_source("def broken(:\n    pass")
        self.assertEqual(issues[0].rule, "syntax")
        self.assertEqual(issues[0].line, 1)

    def test_oversized_source_is_rejected(self):
        issues = sb.check_source("# padding\n" * 60_000)
        self.assertEqual(issues[0].rule, "size")

    def test_run_rejects_before_executing(self):
        with self.assertRaises(sb.SandboxError) as ctx:
            sb.run("import os\nX = 1")
        self.assertEqual(ctx.exception.issues[0].rule, "no-import")

    def test_run_returns_namespace_for_clean_source(self):
        namespace = sb.run("VALUE = sum([1, 2, 3])")
        self.assertEqual(namespace["VALUE"], 6)

    def test_load_strategy_source_rejects_import(self):
        source = "import math\nSTRATEGY = {'id': 'x'}\n"
        with self.assertRaises(sa.StrategyError) as ctx:
            sa.load_strategy_source(source, file="bad.py")
        self.assertIn("no-import", {i.rule for i in ctx.exception.issues})

    def test_load_strategy_source_requires_strategy_object(self):
        with self.assertRaises(sa.StrategyError) as ctx:
            sa.load_strategy_source("VALUE = 1\n", file="empty.py")
        self.assertIn("load", {i.rule for i in ctx.exception.issues})

    def test_load_strategy_file_reports_read_error(self):
        with self.assertRaises(sa.StrategyError) as ctx:
            sa.load_strategy_file(os.path.join(EXAMPLES_DIR, "does-not-exist.py"))
        self.assertEqual(ctx.exception.issues[0].rule, "read")

    def test_evaluate_series_rejects_bad_shape(self):
        source = """
def evaluate(candles, p):
    n = len(candles)
    return {"target": [0.0] * n, "reasons": [], "overlays": {}, "warmup": 0}

STRATEGY = {
    "id": "short-reasons", "name": "Short reasons", "version": "0.1.0",
    "desc": "reasons 长度不对，只用于测试形状校验。", "tags": [],
    "params": [], "evaluate": evaluate,
}
"""
        st = sa.load_strategy_source(source, file="short.py")
        with self.assertRaises(sa.StrategyError) as ctx:
            st.evaluate_series(CANDLES[:10])
        self.assertIn("output-length", {i.rule for i in ctx.exception.issues})


# ───────────── 十个示例：加载 + 动态校验 ─────────────


class ExampleLoadTests(unittest.TestCase):
    def test_all_examples_load_and_pass_dynamic_validation(self):
        self.assertEqual(len(EXAMPLE_FILES), 10)
        for filename in EXAMPLE_FILES:
            with self.subTest(example=filename):
                st = sa.load_strategy_file(os.path.join(EXAMPLES_DIR, filename))
                report = sa.validate_strategy(st)
                self.assertEqual([str(e) for e in report.errors], [])
                self.assertEqual(report.warnings, [])
                series = st.evaluate_series(CANDLES)
                self.assertEqual(len(series.target), len(CANDLES))
                self.assertEqual(len(series.reasons), len(CANDLES))

    def test_examples_match_typescript_signature(self):
        for name, expected in TS_SIGNATURES.items():
            with self.subTest(example=name):
                got = signature(load(name).evaluate_series(CANDLES))
                self.assertEqual(got, expected)

    def test_examples_reject_out_of_range_params(self):
        st = load("ema-cross")
        with self.assertRaises(sa.ParamError):
            st.evaluate_series(CANDLES[:50], {"slow": 1})
        with self.assertRaises(sa.ParamError):
            st.evaluate_series(CANDLES[:50], {"nope": 1})


# ───────────── 十个示例：语义冒烟 ─────────────


class ExampleSemanticsTests(unittest.TestCase):
    def test_ema_cross_semantics(self):
        st = load("ema-cross")
        series = st.evaluate_series(CANDLES)
        self.assertEqual(series.warmup, 26)  # slow + 0：前 26 根预热
        self.assertTrue(all(t == 0 for t in series.target[:26]))
        self.assertTrue(set(series.target[26:]) <= {1.0, -1.0})
        self.assertTrue(any(r for r in series.reasons))
        no_short = st.evaluate_series(CANDLES, {"allowShort": False})
        self.assertNotIn(-1.0, no_short.target)
        self.assertIn(0.0, no_short.target[26:])
        self.assertIn("EMA12", no_short.overlays)
        self.assertEqual(len(no_short.overlays["EMA26"]), len(CANDLES))

    def test_breakout_semantics(self):
        st = load("breakout")
        series = st.evaluate_series(CANDLES)
        closes = [c["c"] for c in CANDLES]
        highs = [c["h"] for c in CANDLES]
        self.assertEqual(series.warmup, 20)
        self.assertTrue(set(series.target) <= {-1.0, 0.0, 1.0})
        for i in range(20, len(CANDLES)):
            if series.target[i] == 1.0 and series.target[i - 1] != 1.0:
                self.assertGreater(closes[i], max(highs[i - 20:i]))
        no_short = st.evaluate_series(CANDLES, {"allowShort": False})
        self.assertNotIn(-1.0, no_short.target)

    def test_dca_schedule_and_cap(self):
        st = load("dca")
        series = st.evaluate_series(CANDLES)
        self.assertEqual(series.target[0], 0.1)      # 第一根就买
        self.assertEqual(series.target[24], 0.2)     # everyBars=24
        self.assertEqual(max(series.target), 1.0)
        self.assertEqual(len(set(series.target)), 10)  # 0.1 … 1.0（第一根就买，0 不出现）
        for i in range(1, len(series.target)):
            self.assertGreaterEqual(series.target[i], series.target[i - 1])  # 只做多、只加不减
        self.assertIn("持仓均价", series.overlays)
        budget = st.evaluate_series(CANDLES, {"totalBudgetPct": 50})
        self.assertEqual(max(budget.target), 0.5)

    def test_grid_maps_price_to_target_monotonically(self):
        st = load("grid")
        series = st.evaluate_series(CANDLES)
        self.assertTrue(all(0.0 <= t <= 1.0 for t in series.target))
        sample = sorted(range(60), key=lambda i: CANDLES[i]["c"])
        for earlier, later in zip(sample, sample[1:]):
            self.assertGreaterEqual(series.target[earlier] + 1e-12, series.target[later])
        self.assertEqual(set(series.overlays), {"网格上沿", "网格下沿", "中心价"})
        stopped = st.evaluate_series(CANDLES, {"boundaryAction": "stop_loss", "rangeRatio": 0.02})
        self.assertIn(0.0, stopped.target)

    def test_grid_geometric_mode_stays_in_range(self):
        st = load("grid")
        series = st.evaluate_series(CANDLES, {"gridMode": "geometric", "grids": 11, "rangeRatio": 0.2})
        self.assertTrue(all(0.0 <= t <= 1.0 for t in series.target))
        self.assertGreater(len(set(series.target)), 2)

    def test_martingale_doubles_after_stop(self):
        st = load("martingale")
        series = st.evaluate_series(CANDLES)
        self.assertEqual(series.target[0], 0.0)  # 从第二根开始
        nonzero = {t for t in series.target if t != 0}
        self.assertTrue(nonzero <= {0.1, 0.2, 0.4, 0.8}, nonzero)
        self.assertGreaterEqual(len(nonzero), 2)  # 止损后确实加倍了
        self.assertEqual(set(series.overlays), {"入场价", "止盈价", "止损价"})

    def test_mean_reversion_entries_follow_bands(self):
        st = load("mean-reversion")
        series = st.evaluate_series(CANDLES)
        closes = [c["c"] for c in CANDLES]
        self.assertEqual(series.warmup, 19)
        self.assertTrue(set(series.target) <= {-1.0, 0.0, 1.0})
        period = 20
        for i in range(period - 1, len(CANDLES)):
            mean = sum(closes[i - period + 1:i + 1]) / period
            if series.target[i] == 1.0 and series.target[i - 1] != 1.0:
                self.assertLess(closes[i], mean)
            if series.target[i] == -1.0 and series.target[i - 1] != -1.0:
                self.assertGreater(closes[i], mean)

    def test_momentum_roc_threshold_invariant(self):
        st = load("momentum-roc")
        series = st.evaluate_series(CANDLES)
        closes = [c["c"] for c in CANDLES]
        lookback, threshold = 20, 0.02
        self.assertEqual(series.warmup, lookback)
        for i in range(lookback, len(CANDLES)):
            roc = closes[i] / closes[i - lookback] - 1.0
            if series.target[i] != 0.0:
                self.assertGreater(abs(roc), threshold)
            if abs(roc) < threshold * 0.999:
                self.assertEqual(series.target[i], 0.0)
        no_short = st.evaluate_series(CANDLES, {"allowShort": False})
        self.assertNotIn(-1.0, no_short.target)

    def test_rsi_reversion_warmup_and_direction(self):
        st = load("rsi-reversion")
        series = st.evaluate_series(CANDLES)
        closes = [c["c"] for c in CANDLES]
        self.assertEqual(series.warmup, 14)
        self.assertTrue(all(t == 0 for t in series.target[:14]))
        self.assertTrue(set(series.target) <= {-1.0, 0.0, 1.0})
        longs = [i for i in range(14, len(CANDLES)) if series.target[i] == 1.0 and series.target[i - 1] != 1.0]
        self.assertTrue(longs)
        for i in longs:
            mean = sum(closes[i - 13:i + 1]) / 14
            self.assertLess(closes[i], mean)
        no_short = st.evaluate_series(CANDLES, {"allowShort": False})
        self.assertNotIn(-1.0, no_short.target)

    def test_supertrend_always_in_market_after_warmup(self):
        st = load("supertrend")
        series = st.evaluate_series(CANDLES)
        self.assertEqual(series.warmup, 9)
        self.assertTrue(set(series.target[9:]) <= {1.0, -1.0})
        self.assertTrue(all(t == 0 for t in series.target[:9]))  # 预热期空仓
        no_short = st.evaluate_series(CANDLES, {"allowShort": False})
        self.assertNotIn(-1.0, no_short.target)

    def test_trend_atr_trailing_stop_overlay(self):
        st = load("trend-atr")
        series = st.evaluate_series(CANDLES)
        stop_line = series.overlays["止损线"]
        self.assertEqual(len(stop_line), len(CANDLES))
        self.assertEqual(series.warmup, 50)
        for i in range(len(CANDLES)):
            if series.target[i] == 0.0:
                self.assertIsNone(stop_line[i])
            else:
                self.assertIsNotNone(stop_line[i])
        self.assertTrue(set(series.target) <= {-1.0, 0.0, 1.0})

    def test_anchor_params_pin_center_and_start(self):
        window = CANDLES[:50]
        grid = load("grid")
        anchored = grid.anchor_params(window)
        self.assertEqual(anchored["center"], window[-1]["c"])
        dca = load("dca")
        start = dca.anchor_params(window)
        self.assertEqual(start["startTs"], window[-1]["t"])
        pinned = dca.anchor_params(window, {"startTs": 12345})
        self.assertEqual(pinned["startTs"], 12345)


if __name__ == "__main__":
    unittest.main(verbosity=2)
