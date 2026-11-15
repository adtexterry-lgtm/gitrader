# SPDX-License-Identifier: CPAL-1.0
"""Python 策略 API：钩子、参数声明、信号构造、加载与校验。

与 TS 侧同一套语义（唯一标准）：
- 策略 = 纯函数 ``evaluate(candles, params) -> {target, reasons, overlays, warmup}``，逐根 K 线收盘时给出
  目标仓位 ``target ∈ [-1, 1]``；``target[i]`` 只能依赖 ``candles[0..i]``。
- 参数声明 ``params: [{key, type, default, min, max, options}]``，字段与 ``packages/engine-core/src/strategy/types.ts:9-20``
  的 ``ParamDef`` 一一对应；校验规则照 ``src/strategy/loader.ts:96-142``（结构 / key 形态 / 保留名 /
  default 落在 min..max 与 options 内）。
- 信号模型照 ``packages/protocol/src/model/signal.ts:9-30``：``kind ∈ target | entry | exit | alert``，
  ``kind=target`` 必带 ``target``；``strength`` 只在声明了 ``method`` 时允许；``expiresAt`` 必填。
- 策略文件自包含：不 import 任何模块（见 ``sandbox.PROFILE_STRATEGY``）。

移植出处：结构校验与动态校验照 loader.ts（:96-142 结构、:212-244 输出形状、:333-357 前视偏差），
语义改写为 Python；参数质量检查的来源注释同 ``ai-generation.ts:211``（QD
``backend_api_python/app/services/indicator_code_quality.py:146``）。
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

try:  # 包内导入（engine 是命名空间包）
    from . import sandbox as _sandbox
except ImportError:  # 直接按文件路径加载时为顶层模块
    import sandbox as _sandbox  # type: ignore[no-redef]

# ───────────── 常量（与 TS / 协议对齐）─────────────

PARAM_TYPES = ("number", "integer", "boolean", "select")
SIGNAL_KINDS = ("target", "entry", "exit", "alert")
EVIDENCE_TYPES = ("signal", "decision", "note", "backtest", "experiment")

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")  # loader.ts:38
KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,31}$")  # loader.ts:39
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")  # loader.ts:40
#: loader.ts:42 —— 策略参数里不许出现的名字（会被协议当秘密字段拒收；size 是引擎通用参数）。
RESERVED_PARAM_KEYS = frozenset({"privatekey", "secret", "apisecret", "mnemonic", "seed", "passphrase", "size"})
#: ai-generation.ts:104 —— desc 里读起来像业绩承诺的词。中文按字拼接，避免公开扫描命中词表本身。
PROMISE_WORDS = ("guaranteed", "100%", "保" + "守", "激" + "进", "稳" + "赚", "跑" + "赢", "稳定" + "盈利")
#: 与 loader.ts:43 一致：动态校验用的合成 K 线根数。
VALIDATION_BARS = 600
#: 与 loader.ts:44 一致：单次 evaluate 在 600 根上的时间上限（毫秒）。
CALL_BUDGET_MS = 2000
MAX_PARAMS = 40
RANGE_EPS = 1e-9


# ───────────── 问题与异常 ─────────────


@dataclass(frozen=True)
class Issue:
    """一条可读的校验问题：rule 机器可读，message 给人看，hint 说怎么改。"""

    rule: str
    message: str
    hint: str | None = None

    def __str__(self) -> str:  # pragma: no cover - 便于调试
        return f"{self.rule}: {self.message}" + (f" ({self.hint})" if self.hint else "")

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"rule": self.rule, "message": self.message}
        if self.hint:
            out["hint"] = self.hint
        return out


class StrategyError(ValueError):
    """策略定义 / 加载 / 求值不合法。issues 列出全部原因。"""

    def __init__(self, issues: Iterable[Issue], where: str = "strategy"):
        self.issues = list(issues)
        detail = "; ".join(str(i) for i in self.issues) or "invalid strategy"
        super().__init__(f"{where}: {detail}")


class ParamError(StrategyError):
    """参数取值不合法（类型 / min / max / options）。"""

    def __init__(self, issues: Iterable[Issue]):
        super().__init__(issues, where="params")


def _is_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")


def _is_int(value: Any) -> bool:
    return _is_num(value) and float(value).is_integer()


# ───────────── 参数声明 ─────────────


@dataclass(frozen=True)
class ParamDef:
    """一个参数声明；字段与 TS ``ParamDef`` 同义（``types.ts:9-20``）。"""

    key: str
    label: str
    type: str
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: tuple[str, ...] | None = None
    help: str | None = None
    hidden: bool = False

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ParamDef":
        options = raw.get("options")
        return cls(
            key=str(raw.get("key", "")),
            label=str(raw.get("label", "")),
            type=str(raw.get("type", "")),
            default=raw.get("default"),
            min=(float(raw["min"]) if raw.get("min") is not None else None),
            max=(float(raw["max"]) if raw.get("max") is not None else None),
            step=(float(raw["step"]) if raw.get("step") is not None else None),
            options=(tuple(str(o) for o in options) if options is not None else None),
            help=(str(raw["help"]) if raw.get("help") is not None else None),
            hidden=bool(raw.get("hidden", False)),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"key": self.key, "label": self.label, "type": self.type, "default": self.default}
        if self.min is not None:
            out["min"] = self.min
        if self.max is not None:
            out["max"] = self.max
        if self.step is not None:
            out["step"] = self.step
        if self.options is not None:
            out["options"] = list(self.options)
        if self.help is not None:
            out["help"] = self.help
        if self.hidden:
            out["hidden"] = True
        return out

    def check(self) -> list[Issue]:
        """结构校验（loader.ts:112-142 的 paramChecks）。"""
        issues: list[Issue] = []
        where = f'params ("{self.key}")'
        if not KEY_RE.match(self.key):
            issues.append(Issue("param-key", f"{where}.key must match {KEY_RE.pattern} (camelCase, starts with a letter)"))
            return issues
        if self.key.lower() in RESERVED_PARAM_KEYS:
            hint = (
                '"size" is the engine-wide per-order size cap; pick another name'
                if self.key.lower() == "size"
                else "names that look like secrets are rejected by the protocol"
            )
            issues.append(Issue("param-key", f'{where}: "{self.key}" is reserved', hint))
        if not self.label:
            issues.append(Issue("param-label", f"{where}.label must be a non-empty string"))
        if self.type not in PARAM_TYPES:
            issues.append(Issue("param-type", f"{where}.type must be one of {', '.join(PARAM_TYPES)}"))
            return issues
        if self.type == "boolean":
            if not isinstance(self.default, bool):
                issues.append(Issue("param-default", f"{where}.default must be a boolean"))
            return issues
        if self.type == "select":
            if not self.options:
                issues.append(Issue("param-options", f"{where}.options must be a non-empty list of strings"))
            elif self.default not in self.options:
                issues.append(Issue("param-default", f"{where}.default must be one of options"))
            return issues
        # number / integer
        if not _is_num(self.default):
            issues.append(Issue("param-default", f"{where}.default must be a finite number"))
        else:
            if self.type == "integer" and not _is_int(self.default):
                issues.append(Issue("param-default", f"{where}.default must be an integer"))
            if self.min is not None and self.default < self.min:
                issues.append(Issue("param-range", f"{where}.default is below min"))
            if self.max is not None and self.default > self.max:
                issues.append(Issue("param-range", f"{where}.default is above max"))
        if self.min is not None and self.max is not None and self.min > self.max:
            issues.append(Issue("param-range", f"{where}: min is greater than max"))
        return issues

    def clamp(self, value: Any) -> Any:
        """把越界值收进合法区间（界面上滑杆的行为）：数值夹到 min/max、整数四舍五入、select 不合法回落到 default。

        与 ``coerce`` 的分工：``coerce`` 是回测 / 实例的严格口径（越界即报错），``clamp`` 是界面的宽容口径。
        类型不对（布尔给了 1、数值给了字符串）仍然抛 ParamError——静默改类型比报错更危险。
        """
        if self.type == "boolean":
            if not isinstance(value, bool):
                raise ParamError([Issue("param-type", f'param "{self.key}" must be a boolean')])
            return value
        if self.type == "select":
            if not isinstance(value, str):
                raise ParamError([Issue("param-type", f'param "{self.key}" must be a string')])
            if self.options and value not in self.options:
                return self.default
            return value
        if not _is_num(value):
            raise ParamError([Issue("param-type", f'param "{self.key}" must be a finite number')])
        out = float(value)
        if self.min is not None:
            out = max(out, self.min)
        if self.max is not None:
            out = min(out, self.max)
        if self.type == "integer":
            # 一半远离 0（与 JS Math.round 的差异只在负数；滑杆不会给负数以外的怪值）
            return int(out + 0.5) if out >= 0 else -int(-out + 0.5)
        return out

    def coerce(self, value: Any) -> Any:
        """按声明类型转换；类型 / 区间 / options 不合规抛 ParamError。"""
        if self.type == "boolean":
            if not isinstance(value, bool):
                raise ParamError([Issue("param-type", f'param "{self.key}" must be a boolean')])
            return value
        if self.type == "select":
            if not isinstance(value, str) or (self.options and value not in self.options):
                opts = ", ".join(self.options or ())
                raise ParamError([Issue("param-value", f'param "{self.key}" must be one of {opts}')])
            return value
        if not _is_num(value):
            raise ParamError([Issue("param-type", f'param "{self.key}" must be a finite number')])
        out: Any = int(value) if self.type == "integer" else float(value)
        if self.type == "integer" and not _is_int(value):
            raise ParamError([Issue("param-type", f'param "{self.key}" must be an integer')])
        issues: list[Issue] = []
        if self.min is not None and out < self.min:
            issues.append(Issue("param-range", f'param "{self.key}" = {out} is below min {self.min}'))
        if self.max is not None and out > self.max:
            issues.append(Issue("param-range", f'param "{self.key}" = {out} is above max {self.max}'))
        if issues:
            raise ParamError(issues)
        return out


def param_defs(raw_params: Sequence[Any]) -> list[ParamDef]:
    """把 ``params`` 数组（dict / ParamDef 混合）规整成 ParamDef 列表；非对象项抛 StrategyError。"""
    defs: list[ParamDef] = []
    issues: list[Issue] = []
    for index, raw in enumerate(raw_params or []):
        if isinstance(raw, ParamDef):
            defs.append(raw)
        elif isinstance(raw, Mapping):
            defs.append(ParamDef.from_dict(raw))
        else:
            issues.append(Issue("param", f"params[{index}] must be an object"))
    if issues:
        raise StrategyError(issues)
    return defs


def defaults_of(defs: Sequence[ParamDef]) -> dict[str, Any]:
    """由参数声明派生默认参数（策略文件里不用写 defaults）。"""
    return {d.key: d.default for d in defs}


def resolve_params(
    defs: Sequence[ParamDef],
    given: Mapping[str, Any] | None = None,
    *,
    clamp: bool = False,
    strict_unknown: bool = True,
) -> dict[str, Any]:
    """默认值 + 用户给的值 → 可直接喂给 evaluate 的参数对象。

    ``clamp=False``（缺省）：越界 / 类型不对抛 ParamError（回测与实例都用这一档，宁可报错不改用户的数）；
    ``clamp=True``：数值型收进 [min, max]、整数取整、select 不合法回落到 default（界面滑杆用这一档）。
    未知 key 默认算错误（拼错参数名不该静默生效）。
    """
    by_key = {d.key: d for d in defs}
    params = defaults_of(defs)
    issues: list[Issue] = []
    for key, value in dict(given or {}).items():
        d = by_key.get(key)
        if d is None:
            if strict_unknown:
                issues.append(Issue("param-unknown", f'unknown parameter "{key}"', f"declared keys: {', '.join(sorted(by_key)) or '(none)'}"))
            continue
        if clamp:
            try:
                params[key] = d.clamp(value)
            except StrategyError as exc:
                params[key] = d.default
                issues.extend(exc.issues)
        else:
            try:
                params[key] = d.coerce(value)
            except StrategyError as exc:
                issues.extend(exc.issues)
    if issues and not clamp:
        raise ParamError(issues)
    return params


# ───────────── 信号序列 ─────────────


@dataclass
class SignalSeries:
    """策略输出，与 candles 等长（TS ``SignalSeries``，``types.ts:23-32``）。"""

    target: list[float]
    reasons: list[str]
    overlays: dict[str, list[float | None]] = field(default_factory=dict)
    warmup: int = 0

    @classmethod
    def empty(cls, n: int, overlays: Mapping[str, Sequence[float | None]] | None = None, warmup: int = 0) -> "SignalSeries":
        """n 根 K 线的空信号：target 全 0、reasons 全 ''。示例策略都用它开头。"""
        return cls(
            target=[0.0] * n,
            reasons=[""] * n,
            overlays={name: list(values) for name, values in (overlays or {}).items()},
            warmup=int(warmup),
        )

    @classmethod
    def from_any(cls, out: Any, n: int | None = None) -> "SignalSeries":
        """把 evaluate 的返回值（dict / SignalSeries）规整成 SignalSeries；形状不对抛 StrategyError。"""
        if isinstance(out, SignalSeries):
            return out
        if not isinstance(out, Mapping):
            raise StrategyError([Issue("output", "evaluate() must return an object {target, reasons, overlays, warmup}")])
        target = list(out.get("target") or [])
        reasons = [str(r) for r in (out.get("reasons") or [])]
        overlays_in = out.get("overlays") or {}
        if not isinstance(overlays_in, Mapping):
            raise StrategyError([Issue("output-overlays", "overlays must be an object of name -> list")])
        overlays = {str(name): list(values) for name, values in overlays_in.items()}
        warmup = out.get("warmup", 0)
        if n is not None and len(target) != n:
            raise StrategyError(
                [Issue("output-length", f"target has {len(target)} entries but there are {n} candles")]
            )
        # 非数值项原样保留，交给 validate_series 报 output-target（这里不能先崩在 float() 上）。
        return cls(
            target=[float(t) if _is_num(t) else t for t in target],
            reasons=reasons,
            overlays=overlays,
            warmup=int(warmup) if _is_int(warmup) else warmup,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": list(self.target),
            "reasons": list(self.reasons),
            "overlays": {name: list(values) for name, values in self.overlays.items()},
            "warmup": self.warmup,
        }

    def fingerprint(self) -> str:
        """确定性比较用（与 TS 侧 JSON.stringify 同口径：键序固定、浮点按 repr）。"""
        return json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)


# ───────────── 信号（协议 §1.4.11）─────────────


@dataclass(frozen=True)
class Signal:
    """协议 Signal（``packages/protocol/src/model/signal.ts:14-30``）。"""

    signal_id: str
    ts: int
    instrument_id: str
    kind: str
    reason: str
    expires_at: int
    target: float | None = None
    strength: float | None = None
    confidence: float | None = None
    method: str | None = None
    evidence: tuple[Mapping[str, Any], ...] = ()
    origin: Mapping[str, Any] | None = None

    def check(self) -> list[Issue]:
        issues: list[Issue] = []
        if not self.signal_id:
            issues.append(Issue("signal-id", "signalId must be a non-empty string"))
        if self.kind not in SIGNAL_KINDS:
            issues.append(Issue("signal-kind", f"kind must be one of {', '.join(SIGNAL_KINDS)}"))
        if self.kind == "target":
            if self.target is None:
                issues.append(Issue("signal-target", "kind=target requires target"))
            elif not _is_num(self.target) or not (-1 <= self.target <= 1):
                issues.append(Issue("signal-target", f"target {self.target!r} must be a finite number in [-1, 1]"))
        elif self.target is not None and (not _is_num(self.target) or not (-1 <= self.target <= 1)):
            issues.append(Issue("signal-target", f"target {self.target!r} must be a finite number in [-1, 1]"))
        if self.strength is not None:
            if not _is_num(self.strength) or not (0 <= self.strength <= 1):
                issues.append(Issue("signal-strength", "strength must be in [0, 1]"))
            if not self.method:
                issues.append(Issue("signal-strength", "strength is only allowed when a scoring method is declared"))
        if self.confidence is not None and (not _is_num(self.confidence) or not (0 <= self.confidence <= 1)):
            issues.append(Issue("signal-confidence", "confidence must be in [0, 1]"))
        if not _is_int(self.expires_at) or self.expires_at <= self.ts:
            issues.append(Issue("signal-expiry", "expiresAt must be an integer after ts: every signal needs an expiry window"))
        if not self.reason or not str(self.reason).strip():
            issues.append(Issue("signal-reason", "reason must be a non-empty string"))
        if not self.instrument_id:
            issues.append(Issue("signal-instrument", "instrumentId must be a non-empty string"))
        for ref in self.evidence:
            if not isinstance(ref, Mapping) or ref.get("type") not in EVIDENCE_TYPES or not ref.get("id"):
                issues.append(Issue("signal-evidence", f"evidence entry {ref!r} must be {{type, id}} with a known type"))
                break
        return issues

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "signalId": self.signal_id,
            "ts": int(self.ts),
            "instrumentId": self.instrument_id,
            "kind": self.kind,
            "expiresAt": int(self.expires_at),
            "reason": self.reason,
        }
        if self.target is not None:
            out["target"] = float(self.target)
        if self.strength is not None:
            out["strength"] = float(self.strength)
        if self.confidence is not None:
            out["confidence"] = float(self.confidence)
        if self.method is not None:
            out["method"] = self.method
        if self.evidence:
            out["evidence"] = [dict(e) for e in self.evidence]
        if self.origin is not None:
            out["origin"] = dict(self.origin)
        return out


def signals_from_series(
    series: SignalSeries,
    candles: Sequence[Mapping[str, Any]],
    *,
    instrument_id: str,
    signal_id_prefix: str,
    ttl_ms: int,
    min_delta: float = 1e-9,
    origin: Mapping[str, Any] | None = None,
) -> list[Signal]:
    """把「目标仓位序列」变成协议 Signal 列表：target 每变一次出一条 ``kind=target``。

    空仓离场同样是一条信号（target=0）——信号必须能被观测到，不能只发开仓。``min_delta``
    与 loader.ts 判定「变了」的口径一致（1e-9）。
    """
    if ttl_ms <= 0:
        raise StrategyError([Issue("signal-expiry", "ttl_ms must be positive so every signal has an expiry window")])
    if len(series.target) != len(candles):
        raise StrategyError([Issue("output-length", f"series has {len(series.target)} targets for {len(candles)} candles")])
    out: list[Signal] = []
    prev = 0.0
    for i, t in enumerate(series.target):
        if abs(t - prev) <= min_delta:
            prev = t
            continue
        ts = int(candles[i]["t"])
        reason = series.reasons[i] if i < len(series.reasons) else ""
        signal = Signal(
            signal_id=f"{signal_id_prefix}-{i:06d}",
            ts=ts,
            instrument_id=instrument_id,
            kind="target",
            reason=reason or f"target {prev:+.4f} → {t:+.4f}",
            expires_at=ts + int(ttl_ms),
            target=float(t),
            origin=origin,
        )
        problems = signal.check()
        if problems:
            raise StrategyError(problems, where=f"signal at bar {i}")
        out.append(signal)
        prev = t
    return out


# ───────────── K 线 ─────────────

CANDLE_FIELDS = ("t", "o", "h", "l", "c", "v")


def normalize_candles(candles: Sequence[Any]) -> list[dict[str, float]]:
    """K 线规整成 ``{t,o,h,l,c,v}`` 的 dict 列表（t 是开盘时间 ms，已收盘）。

    接受 dict 或带同名属性的对象；缺字段 / 非有限数抛 StrategyError。引擎各层都只认这一种形状。
    """
    rows: list[dict[str, float]] = []
    for index, candle in enumerate(candles or []):
        row: dict[str, float] = {}
        for name in CANDLE_FIELDS:
            if isinstance(candle, Mapping):
                value = candle.get(name)
            else:
                value = getattr(candle, name, None)
            if not _is_num(value):
                raise StrategyError([Issue("candle", f"candles[{index}].{name} must be a finite number")])
            row[name] = float(value)
        rows.append(row)
    return rows


def synth_candles(
    n: int = VALIDATION_BARS,
    *,
    seed: int = 7,
    interval_ms: int = 60_000,
    start_ts: int = 1_760_000_000_000,
    price: float = 100.0,
) -> list[dict[str, float]]:
    """确定性合成 K 线（线性同余，不联网、不用 random 模块）：校验与冒烟测试的固定夹具。"""
    state = seed & 0x7FFFFFFF
    out: list[dict[str, float]] = []
    last = float(price)
    for i in range(max(0, int(n))):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        r = state / 0x7FFFFFFF - 0.5
        open_ = last
        close = max(0.01, open_ * (1 + 0.012 * r))
        high = max(open_, close) * (1 + 0.004 * abs(r))
        low = min(open_, close) * (1 - 0.004 * abs(r))
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        volume = 10.0 + 90.0 * (state / 0x7FFFFFFF)
        out.append({"t": float(start_ts + i * interval_ms), "o": open_, "h": high, "l": low, "c": close, "v": volume})
        last = close
    return out


# ───────────── 结构校验（loader.ts:96-142）─────────────

ALLOWED_STRATEGY_FIELDS = frozenset(
    {"id", "name", "nameZh", "name_zh", "version", "desc", "tags", "params", "anchor", "evaluate"}
)


def check_structure(raw: Mapping[str, Any]) -> list[Issue]:
    """结构 / 静态规则。返回问题列表，空 = 通过。不执行代码。"""
    issues: list[Issue] = []
    if not isinstance(raw, Mapping):
        return [Issue("strategy", "the strategy must be an object (a module-level dict named STRATEGY)")]

    sid = raw.get("id")
    if not isinstance(sid, str) or not ID_RE.match(sid):
        issues.append(Issue("id", f"id must be a string matching {ID_RE.pattern} (lowercase letters, digits and dashes, 2-40 chars)", "Example: 'my-first-strategy'"))
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        issues.append(Issue("name", "name must be a non-empty string of at most 80 characters (English display name)"))
    name_zh = raw.get("nameZh", raw.get("name_zh"))
    if name_zh is not None and (not isinstance(name_zh, str) or len(name_zh) > 80):
        issues.append(Issue("nameZh", "nameZh, when present, must be a string of at most 80 characters"))
    version = raw.get("version")
    if not isinstance(version, str) or not SEMVER_RE.match(version):
        issues.append(Issue("version", 'version must be a semantic version string like "0.1.0"', "Bump it whenever the logic changes: backtests record it."))
    desc = raw.get("desc")
    if not isinstance(desc, str) or not desc.strip() or len(desc) > 2000:
        issues.append(Issue("desc", "desc must be a non-empty string of at most 2000 characters: say what the rule does and when it fails"))
    elif any(word.lower() in desc.lower() for word in PROMISE_WORDS):
        word = next(word for word in PROMISE_WORDS if word.lower() in desc.lower())
        issues.append(Issue("no-promise", f'desc contains "{word}": it reads as a performance promise; state the rule and when it fails instead'))
    tags = raw.get("tags")
    if not isinstance(tags, (list, tuple)) or not all(isinstance(t, str) for t in tags):
        issues.append(Issue("tags", "tags must be a list of strings (may be empty)"))
    if not callable(raw.get("evaluate")):
        issues.append(Issue("evaluate", "evaluate(candles, params) is missing or not a function", "Return {target, reasons, overlays, warmup}."))
    anchor = raw.get("anchor")
    if anchor is not None and not callable(anchor):
        issues.append(Issue("anchor", "anchor, when present, must be a function anchor(candles, params) -> params"))

    params = raw.get("params")
    if not isinstance(params, (list, tuple)):
        issues.append(Issue("params", "params must be a list of parameter definitions"))
    else:
        if len(params) > MAX_PARAMS:
            issues.append(Issue("params", f"at most {MAX_PARAMS} parameters"))
        seen: set[str] = set()
        for index, item in enumerate(params):
            if isinstance(item, ParamDef):
                d = item
            elif isinstance(item, Mapping):
                d = ParamDef.from_dict(item)
            else:
                issues.append(Issue("param", f"params[{index}] must be an object"))
                continue
            if d.key in seen:
                issues.append(Issue("param-key", f'params[{index}] ("{d.key}"): duplicate parameter key'))
            seen.add(d.key)
            issues.extend(d.check())

    unknown = [key for key in raw.keys() if key not in ALLOWED_STRATEGY_FIELDS]
    if unknown:
        issues.append(Issue("unknown-field", f"unknown fields on the strategy object: {', '.join(sorted(unknown))}", "Allowed: id, name, nameZh, version, desc, tags, params, anchor, evaluate."))
    return issues


def validate_series(out: Any, n: int) -> tuple[list[Issue], SignalSeries | None]:
    """输出形状校验（loader.ts:212-244 的 seriesChecks）。返回 (问题, 规整后的序列)。"""
    issues: list[Issue] = []
    label = f"evaluate({n} candles)"
    if not isinstance(out, (Mapping, SignalSeries)):
        return [Issue("output", f"{label}: evaluate() must return {{target, reasons, overlays, warmup}}")], None
    try:
        series = SignalSeries.from_any(out, n)
    except StrategyError as exc:
        return [Issue(i.rule, f"{label}: {i.message}") for i in exc.issues], None

    if len(series.target) != n:
        issues.append(Issue("output-length", f"{label}: target must have exactly one entry per candle (got {len(series.target)}, expected {n})"))
    bad = next((i for i, x in enumerate(series.target) if not _is_num(x)), None)
    if bad is not None:
        issues.append(Issue("output-target", f"{label}: target[{bad}] is not a finite number", "Use 0 while the indicator is warming up; never NaN."))
    outside = next((i for i, x in enumerate(series.target) if _is_num(x) and not (-1 <= x <= 1)), None)
    if outside is not None:
        issues.append(Issue("output-target", f"{label}: target[{outside}] = {series.target[outside]} is outside [-1, 1]", "+1 = fully long, -1 = fully short, 0 = flat, 0.5 = half long."))
    if len(series.reasons) != n:
        issues.append(Issue("output-length", f"{label}: reasons must have exactly one string per candle (got {len(series.reasons)}, expected {n}); use '' where the target did not change"))
    else:
        if len(series.target) == n:
            prev = 0.0
            for i, t in enumerate(series.target):
                if abs(t - prev) > 1e-9 and series.reasons[i] == "":
                    issues.append(Issue("reason-missing", f"{label}: the target changed at index {i} but reasons[{i}] is empty", "Every change of target needs a one-line human-readable reason."))
                    break
                prev = t
    if len(series.overlays) > 12:
        issues.append(Issue("output-overlays", f"{label}: at most 12 overlay lines"))
    for name, values in series.overlays.items():
        if len(values) != n or not all(v is None or _is_num(v) for v in values):
            issues.append(Issue("output-overlays", f'{label}: overlay "{name}" must be a list of {n} numbers or null'))
            break
    if not _is_int(series.warmup) or series.warmup < 0:
        issues.append(Issue("output-warmup", f"{label}: warmup must be a non-negative integer (the index of the first valid signal)"))
    return issues, series if not issues else None


# ───────────── 策略对象 ─────────────


@dataclass
class Strategy:
    """一个可执行的策略（TS ``StrategyDef`` 的 Python 版，补上 defaults 与来源文件）。"""

    id: str
    name: str
    version: str
    desc: str
    tags: list[str]
    params: list[ParamDef]
    evaluate: Callable[[list[dict[str, float]], dict[str, Any]], Any]
    anchor: Callable[[list[dict[str, float]], dict[str, Any]], Mapping[str, Any]] | None = None
    name_zh: str | None = None
    file: str | None = None

    @property
    def defaults(self) -> dict[str, Any]:
        return defaults_of(self.params)

    @property
    def param_map(self) -> dict[str, ParamDef]:
        return {d.key: d for d in self.params}

    def resolve(self, params: Mapping[str, Any] | None = None, *, clamp: bool = False) -> dict[str, Any]:
        return resolve_params(self.params, params, clamp=clamp)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "desc": self.desc,
            "tags": list(self.tags),
            "params": [d.to_dict() for d in self.params],
        }
        if self.name_zh is not None:
            out["nameZh"] = self.name_zh
        if self.file is not None:
            out["file"] = self.file
        return out

    def evaluate_series(
        self,
        candles: Sequence[Any],
        params: Mapping[str, Any] | None = None,
        *,
        validate: bool = True,
    ) -> SignalSeries:
        """按 (candles, params) 求信号序列；形状不合规则抛 StrategyError（errors 里带规则名）。"""
        rows = normalize_candles(candles)
        resolved = self.resolve(params)
        out = self.evaluate(rows, resolved)
        if not validate:
            return SignalSeries.from_any(out, len(rows))
        issues, series = validate_series(out, len(rows))
        if series is None or issues:
            raise StrategyError(issues, where=f"evaluate {self.id}")
        return series

    def anchor_params(self, candles: Sequence[Any], params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """把「锚点」参数（如网格中心价）固定下来；没有锚点的策略返回解析后的参数。"""
        resolved = self.resolve(params)
        if self.anchor is None:
            return resolved
        rows = normalize_candles(candles)
        out = dict(self.anchor(rows, resolved) or {})
        known = set(self.param_map)
        extra = [key for key in out if key not in known]
        if extra:
            raise StrategyError([Issue("anchor-output", f"anchor() returned keys that are not declared parameters: {', '.join(extra)}")])
        return resolve_params(self.params, out)


def strategy_from_mapping(raw: Mapping[str, Any], *, file: str | None = None) -> Strategy:
    """结构校验 + 转成 Strategy；不合法抛 StrategyError。"""
    issues = check_structure(raw)
    if issues:
        raise StrategyError(issues, where=file or "strategy")
    defs = param_defs(list(raw.get("params") or []))
    return Strategy(
        id=str(raw["id"]),
        name=str(raw["name"]),
        version=str(raw["version"]),
        desc=str(raw["desc"]),
        tags=[str(t) for t in (raw.get("tags") or [])],
        params=defs,
        evaluate=raw["evaluate"],
        anchor=raw.get("anchor"),
        name_zh=(raw.get("nameZh") or raw.get("name_zh")),
        file=file,
    )


def load_strategy_source(source: str, *, file: str | None = None) -> Strategy:
    """从源码加载策略：沙箱静态校验（策略档：禁止任何 import）→ 执行 → 取 STRATEGY / strategy 对象。"""
    try:
        namespace = _sandbox.run(source, profile=_sandbox.PROFILE_STRATEGY, filename=file or "<strategy>")
    except _sandbox.SandboxError as exc:
        raise StrategyError([Issue(i.rule, i.message) for i in exc.issues], where=file or "strategy") from None
    except SyntaxError as exc:  # 语法错误也在 compile 阶段暴露一次
        raise StrategyError([Issue("syntax", f"could not compile the file: {exc.msg}")], where=file or "strategy") from None
    raw = namespace.get("STRATEGY", namespace.get("strategy"))
    if raw is None:
        raise StrategyError(
            [Issue("load", "the file must define a module-level `STRATEGY` dict (Python version of `export default strategy`)")],
            where=file or "strategy",
        )
    if not isinstance(raw, Mapping):
        raise StrategyError([Issue("load", "STRATEGY must be a dict, not " + type(raw).__name__)], where=file or "strategy")
    return strategy_from_mapping(raw, file=file)


def load_strategy_file(path: str) -> Strategy:
    """从 .py 文件加载策略（UTF-8，去 BOM）。读不了抛 StrategyError；不是 UTF-8 也抛 StrategyError。"""
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            source = handle.read()
    except UnicodeDecodeError as exc:
        # UnicodeDecodeError 是 ValueError 而不是 OSError——以前会原样穿过只捕 StrategyError 的调用方，
        # 子进程里又被归成 runtime（审计 L4-09）。这里显式归到 encoding 规则。
        raise StrategyError(
            [Issue("encoding", f"策略文件必须是 UTF-8（去 BOM）：偏移 {exc.start} 处无法解码（{exc.reason}）")],
            where=path,
        ) from None
    except OSError as exc:
        raise StrategyError([Issue("read", f"cannot read the file: {exc}")], where=path) from None
    return load_strategy_source(source, file=os.path.basename(path))


# ───────────── 动态校验（loader.ts:208-357）─────────────


@dataclass
class ValidationReport:
    """动态校验结果：errors 挡住加载，warnings 只提示。"""

    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _extreme_params(defs: Sequence[ParamDef], which: str) -> dict[str, Any]:
    params = defaults_of(defs)
    for d in defs:
        if d.type in ("number", "integer"):
            bound = getattr(d, which)
            if bound is not None:
                params[d.key] = bound
    return params


def validate_strategy(
    strategy: Strategy,
    candles: Sequence[Any] | None = None,
    params: Mapping[str, Any] | None = None,
    *,
    prefix_points: Sequence[int] = (150, 300, 450, 599),
    call_budget_ms: int = CALL_BUDGET_MS,
) -> ValidationReport:
    """真跑一遍：形状、取值范围、确定性、空 / 短序列、极端参数、前视偏差、锚点输出。

    前视偏差的判定与 loader.ts:333-345 相同：截断后的 K 线上重算，已有 target 不得变化（1e-9）。
    """
    import time as _time

    report = ValidationReport()
    rows = normalize_candles(candles) if candles is not None else synth_candles(VALIDATION_BARS)
    n = len(rows)
    defaults = strategy.resolve(params)

    started = _time.monotonic()
    try:
        first = strategy.evaluate(rows, dict(defaults))
    except Exception as exc:  # noqa: BLE001 - 用户代码，任何异常都是校验结论
        report.errors.append(Issue("evaluate-throws", f"evaluate(candles, defaults) threw: {type(exc).__name__}: {exc}"))
        return report
    elapsed_ms = (_time.monotonic() - started) * 1000

    if elapsed_ms > call_budget_ms:
        report.errors.append(Issue("slow", f"evaluate() took {elapsed_ms:.0f} ms on {n} candles (limit {call_budget_ms} ms)", "Avoid O(n²) loops; compute indicators in one pass."))

    issues, series = validate_series(first, n)
    report.errors.extend(issues)

    again = strategy.evaluate(rows, dict(defaults))
    if SignalSeries.from_any(again, n).fingerprint() != SignalSeries.from_any(first, n).fingerprint():
        report.errors.append(Issue("non-deterministic", "calling evaluate() twice with the same input gave different output", "Remove hidden state that changes between calls."))

    empty_value = _safe_call(strategy, [], dict(defaults), report, "empty-input")
    if empty_value is not None:
        empty_issues, _ = validate_series(empty_value, 0)
        report.errors.extend(empty_issues)
    short_value = _safe_call(strategy, rows[:5], dict(defaults), report, "short-input")
    if short_value is not None:
        short_issues, _ = validate_series(short_value, 5)
        report.errors.extend(short_issues)

    for which in ("min", "max"):
        probe = _extreme_params(strategy.params, which)
        value = _safe_call(strategy, rows, probe, report, "extreme-params:" + which)
        if value is not None:
            extreme_issues, _ = validate_series(value, n)
            report.errors.extend(extreme_issues)

    if series is not None:
        for k in prefix_points:
            if k <= 0 or k >= n:
                continue
            part = _safe_call(strategy, rows[:k], dict(defaults), report, "prefix-throws")
            if part is None:
                continue
            part_series = SignalSeries.from_any(part, k)
            if len(part_series.target) != k:
                report.errors.append(Issue("output-length", f"evaluate(first {k} candles) returned {len(part_series.target)} targets"))
                continue
            hit = next(
                (i for i in range(k) if abs(part_series.target[i] - series.target[i]) > 1e-9),
                None,
            )
            if hit is not None:
                report.errors.append(
                    Issue(
                        "lookahead",
                        f"target[{hit}] was {series.target[hit]} with {n} candles but {part_series.target[hit]} with only the first {k}: the strategy looks at future candles",
                        "target[i] may only depend on candles[0..i]; do not use a statistic over the whole array.",
                    )
                )
                break
        if all(t == 0 for t in series.target):
            report.warnings.append(Issue("never-trades", f"the target stayed 0 on the {n}-candle validation fixture", "A real strategy should produce a non-zero target somewhere; check the entry conditions."))

    if strategy.anchor is not None:
        try:
            anchored = strategy.anchor_params(rows, dict(defaults))
        except StrategyError as exc:
            report.errors.extend(exc.issues)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(Issue("anchor-throws", f"anchor(candles, params) threw: {type(exc).__name__}: {exc}"))
        else:
            unknown = [key for key in anchored if key not in strategy.param_map]
            if unknown:
                report.errors.append(Issue("anchor-output", f"anchor() returned keys that are not declared parameters: {', '.join(unknown)}"))
    return report


def _safe_call(
    strategy: Strategy,
    candles: Sequence[Any],
    params: Mapping[str, Any],
    report: ValidationReport,
    rule: str,
) -> Any:
    try:
        return strategy.evaluate(list(candles), dict(params))
    except Exception as exc:  # noqa: BLE001
        report.errors.append(Issue(rule, f"evaluate() threw on {len(candles)} candles ({rule}): {type(exc).__name__}: {exc}"))
        return None
