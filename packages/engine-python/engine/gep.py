# SPDX-License-Identifier: CPAL-1.0
"""GEP engine side, Python standard library only.

This module is the protocol face of the Python strategy engine:

* framing: one UTF-8 JSON value per line (no BOM), a line is either one JSON-RPC
  message or an array (batch) answered with an array whose ids correspond;
* handshake: ``gep.hello`` token check and MAJOR.MINOR version negotiation;
* the error model: every failure is a Problem object (code / name / category /
  message / retryable), never a bare string;
* method dispatch: ``engine.*``, ``events.*``, ``risk.policy.push``,
  ``strategy.*`` and ``backtest.*``; optional groups are gated by the
  capabilities this engine declares in ``engine.describe``;
* engine -> host events: one ``events.push`` notification per <=500 events with
  a per-session, strictly increasing ``seq``.

Protocol is the only standard: method names, parameter shapes, error codes and
capability keys follow ``packages/protocol/src/gep/{methods,backtest,version}.ts``
and ``packages/protocol/schemas/``. The framing / handshake / Problem table is
taken from the reference engine ``packages/protocol/examples/python-engine/engine.py``
(same repository, CPAL-1.0) and extended with the strategy and backtest groups.

There is no trading path in this module: the engine never calls
``host.order.place``, and nothing here talks to a venue.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import threading
import time

try:                                       # 正常路径：engine 是命名空间包
    from . import backtest as bt_mod
    from . import limits as limit_mod
    from . import strategy_api as sa
    from . import strategy_loader
except ImportError:                        # pragma: no cover - 被按文件路径单独加载时
    import backtest as bt_mod
    import limits as limit_mod
    import strategy_api as sa
    import strategy_loader

# ---- Wire constants (version.ts) -------------------------------------------------------

TOKEN_ENV = 'GITRADER_GEP_TOKEN'
ENGINE_ID = 'python-engine'
ENGINE_NAME = 'Python strategy engine (stdlib only)'
ENGINE_VERSION = '0.1.0'
SUPPORTED_VERSIONS = ('0.1',)
MAX_LINE_BYTES = 1024 * 1024          # GEP_LIMITS.maxStdioLineBytes
#: 单帧 batch 的最大成员数。响应体积随成员数线性放大（实测 20 000 成员 → 请求 100 KB / 响应 3.92 MB，
#: 39.2×），而帧上限只管入站，所以出站侧必须有成员上限：超出整帧 INVALID_REQUEST。
MAX_BATCH_MEMBERS = 100
#: 单帧 JSON 的最大括号嵌套深度。json.loads 对深嵌套抛 RecursionError（不是 ValueError），
#: 解析前先数深度既能省栈也能把畸形帧变成一帧 PARSE_ERROR。正常帧不超过 ~10 层。
MAX_JSON_DEPTH = 512
MAX_EVENTS_PER_FRAME = 500
HOST_CALL_TIMEOUT_S = 5.0
MAX_BACKTEST_BARS = 5000              # GEP_LIMITS.maxHistoryLimit
#: 名义心跳周期（GEP_LIMITS.heartbeatIntervalMs）：hello 之后到 engine.bind 之前用它。
HEARTBEAT_DEFAULT_S = 5.0
#: bind 给的 heartbeatMs 的夹取范围，与 engine-core/src/runtime/engine.ts 一致。
HEARTBEAT_MIN_MS, HEARTBEAT_MAX_MS = 250, 5000

# ---- Problem table (model/problem.ts §2.8) ---------------------------------------------

# name -> (code, category, retryable)
PROBLEMS = {
    'PARSE_ERROR': (-32700, 'PROTOCOL', False),
    'INVALID_REQUEST': (-32600, 'PROTOCOL', False),
    'METHOD_NOT_FOUND': (-32601, 'PROTOCOL', False),
    'INVALID_PARAMS': (-32602, 'PROTOCOL', False),
    'INTERNAL_ERROR': (-32603, 'PROTOCOL', False),
    'ACCOUNT_NOT_BOUND': (1005, 'REJECTED', False),
    'INTERNAL': (4001, 'ENGINE', False),
    'STRATEGY_ERROR': (4002, 'ENGINE', False),
    'BACKTEST_FAILED': (4003, 'ENGINE', False),
    'BUSY': (4004, 'ENGINE', True),
    'DATA_UNAVAILABLE': (4005, 'ENGINE', False),
    'VERSION_UNSUPPORTED': (5001, 'PROTOCOL', False),
    'CAPABILITY_UNSUPPORTED': (5002, 'PROTOCOL', False),
    'AUTH_FAILED': (5003, 'PROTOCOL', False),
    'SESSION_GAP': (5004, 'PROTOCOL', False),
    'SECRET_FIELD_REJECTED': (5006, 'PROTOCOL', False),
    'PAYLOAD_TOO_LARGE': (5007, 'PROTOCOL', False),
}

# ---- Capabilities this engine declares (describe.ts GEP_CAPABILITY_KEYS) ---------------

CAPABILITIES = {
    'execution.modeA': True,          # orders go through the host (no venue keys here)
    'execution.modeB': False,
    'market.useHost': True,
    'market.own': False,
    'strategy': True,
    'strategy.hotUpdate': True,
    'backtest': True,
    'backtest.fillModels': ['next-bar-open'],
    'replay': False,
    'events.resume': False,
    'risk.cooperative': False,
    'halt.levels': ['halt_new', 'cancel_all', 'flatten_all'],
    'builder.attach': False,
    'decision.log': False,
    # 厂商扩展（methods.ts:371 `x-gitrader.strategy.files`，X_GITRADER_CAPABILITIES）：
    # 策略文件夹「文件即安装」的加载报告。协议 schema 允许 `^x-` 前缀的键
    # （schemas/gep.EngineDescribe.json capabilities.propertyNames）。
    'x-gitrader.strategy-folder': True,
}

# Optional / mode-specific methods and the capability bit that gates each one
# (methods.ts GEP_METHODS). Undeclared -> 5002, never a silent success.
METHOD_CAPABILITY = {
    'strategy.list': 'strategy',
    'strategy.params': 'strategy',
    'strategy.start': 'strategy',
    'strategy.stop': 'strategy',
    'strategy.status': 'strategy',
    'strategy.update': 'strategy.hotUpdate',
    'backtest.run': 'backtest',
    'backtest.status': 'backtest',
    'backtest.result': 'backtest',
    'backtest.cancel': 'backtest',
    'x-gitrader.strategy.files': 'x-gitrader.strategy-folder',
    'replay.start': 'replay',
    'replay.stop': 'replay',
    'replay.status': 'replay',
    'order.place': 'execution.modeB',
    'order.amend': 'execution.modeB',
    'order.cancel': 'execution.modeB',
    'order.cancelAll': 'execution.modeB',
    'account.snapshot': 'execution.modeB',
    'market.subscribe': 'market.own',
    'market.snapshot': 'market.own',
    'market.history': 'market.own',
}

# ---- Strategy catalogue (single built-in strategy) -------------------------------------

STRATEGY_ID = 'sma-cross'
STRATEGY_NAME = 'SMA cross (moving-average target position)'
STRATEGY_VERSION = '0.1.0'
STRATEGY_KIND = 'target-position'

# Declared parameters: key -> (type, default, min, max, pattern).
# ``decimal-string`` means a canonical decimal string (contract §1.3: string on
# the wire, never a float), which is why ``size`` is a string here too.
PARAM_DEFS = (
    {'key': 'size', 'type': 'decimal-string', 'default': '0.05',
     'pattern': r'^[0-9]+(\.[0-9]+)?$'},
    {'key': 'fastPeriod', 'type': 'integer', 'default': 12, 'min': 2, 'max': 500},
    {'key': 'slowPeriod', 'type': 'integer', 'default': 48, 'min': 3, 'max': 1000},
    {'key': 'warmupBars', 'type': 'integer', 'default': 60, 'min': 0, 'max': 500},
)
PARAM_KEYS = tuple(d['key'] for d in PARAM_DEFS)


def param_schema():
    """JSON Schema for the built-in strategy's parameters (draft 2020-12 subset)."""
    props = {}
    required = []
    for d in PARAM_DEFS:
        required.append(d['key'])
        if d['type'] == 'integer':
            props[d['key']] = {'type': 'integer', 'minimum': d['min'], 'maximum': d['max'],
                               'default': d['default']}
        else:
            props[d['key']] = {'type': 'string', 'pattern': d['pattern'], 'default': d['default']}
    return {'$schema': 'https://json-schema.org/draft/2020-12/schema',
            'title': 'sma-cross params', 'type': 'object', 'properties': props,
            'required': required, 'additionalProperties': False}


def param_defaults():
    return {d['key']: d['default'] for d in PARAM_DEFS}


def resolve_params(raw):
    """Merge declared defaults with raw params and validate. Raises RpcFault."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise RpcFault('INVALID_PARAMS', 'params must be an object')
    unknown = [k for k in raw if k not in PARAM_KEYS]
    if unknown:
        raise RpcFault('INVALID_PARAMS', 'unknown parameter(s): %s' % ', '.join(sorted(unknown)))
    out = param_defaults()
    for d in PARAM_DEFS:
        key = d['key']
        if key not in raw:
            continue
        value = raw[key]
        if d['type'] == 'integer':
            if not isinstance(value, int) or isinstance(value, bool):
                raise RpcFault('INVALID_PARAMS', '%s must be an integer' % key)
            if value < d['min'] or value > d['max']:
                raise RpcFault('INVALID_PARAMS', '%s must be within %d..%d' % (key, d['min'], d['max']))
        else:
            if not isinstance(value, str) or not re.match(d['pattern'], value):
                raise RpcFault('INVALID_PARAMS', '%s must be a decimal string' % key)
        out[key] = value
    if out['fastPeriod'] >= out['slowPeriod']:
        raise RpcFault('INVALID_PARAMS', 'fastPeriod must be smaller than slowPeriod')
    return out


def strategy_entries():
    return [{'id': STRATEGY_ID, 'name': STRATEGY_NAME, 'version': STRATEGY_VERSION,
             'kind': STRATEGY_KIND, 'paramsSchemaRef': 'strategy.params'}]


# ---- Small helpers ---------------------------------------------------------------------


def now_ms():
    return int(time.time() * 1000)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_digest(value):
    return 'sha256:' + hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def make_problem(name, message, extra=None):
    code, category, retryable = PROBLEMS[name]
    problem = {'code': code, 'name': name, 'category': category,
               'message': message, 'retryable': retryable}
    if extra:
        problem.update(extra)
    return problem


def error_response(msg_id, name, message):
    problem = make_problem(name, message)
    return {'jsonrpc': '2.0', 'id': msg_id,
            'error': {'code': problem['code'], 'message': message, 'data': problem}}


class RpcFault(Exception):
    """A JSON-RPC level failure carrying a Problem name."""

    def __init__(self, name, message):
        Exception.__init__(self, message)
        self.name = name
        self.message = message


# ---- Secret-field rejection (contract: never echo the value) ----------------------------

SECRET_FIELD_NAMES = {'privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase'}


def find_secret_fields(value, path='$'):
    hits = []
    if isinstance(value, list):
        for i, item in enumerate(value):
            hits.extend(find_secret_fields(item, '%s[%d]' % (path, i)))
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                continue
            normalized = key.lower().replace('_', '').replace('-', '')
            is_rng_seed = (normalized == 'seed'
                           and isinstance(item, (int, float))
                           and not isinstance(item, bool)
                           and (path == '$.spec' or path.endswith('.spec')))
            if normalized in SECRET_FIELD_NAMES and not is_rng_seed:
                hits.append('%s.%s' % (path, key))
            hits.extend(find_secret_fields(item, '%s.%s' % (path, key)))
    return hits


# ---- Version negotiation (version.ts negotiateVersion) ---------------------------------

VERSION_PATTERN = re.compile(r'^(\d+)\.(\d+)(?:\.\d+)?$')


def major_minor(version):
    if not isinstance(version, str):
        return None
    match = VERSION_PATTERN.match(version)
    if not match:
        return None
    return '%s.%s' % (match.group(1), match.group(2))


def negotiate_version(offered, supported=SUPPORTED_VERSIONS):
    if not isinstance(offered, list):
        return None
    common = []
    for version in offered:
        mm = major_minor(version)
        if mm is not None and mm in supported:
            common.append(mm)
    if not common:
        return None
    common.sort(key=lambda v: tuple(int(part) for part in v.split('.')))
    return common[-1]


# ---- Param shape helpers ---------------------------------------------------------------


def is_text(value):
    return isinstance(value, str) and len(value) > 0


INSTANCE_ID_RE = re.compile(r'^inst_[0-9A-Za-z]{3,26}$')
ACCOUNT_ID_RE = re.compile(r'^acct_[0-9A-Za-z]{3,26}$')


def require_string(params, key):
    value = params.get(key)
    if not is_text(value):
        raise RpcFault('INVALID_PARAMS', '%s must be a non-empty string' % key)
    return value


def binding_issues(params):
    if not isinstance(params, dict):
        return ['$ must be an object']
    issues = []
    if not is_text(params.get('bindingId')):
        issues.append('$.bindingId must be a non-empty string')
    accounts = params.get('accounts')
    if not isinstance(accounts, list) or len(accounts) == 0:
        issues.append('$.accounts must be a non-empty array')
    else:
        for i, account in enumerate(accounts):
            prefix = '$.accounts[%d]' % i
            if not isinstance(account, dict):
                issues.append('%s must be an object' % prefix)
                continue
            if not is_text(account.get('accountId')) or not ACCOUNT_ID_RE.match(account['accountId']):
                issues.append('%s.accountId must look like acct_<id>' % prefix)
            if account.get('mode') not in ('A', 'B'):
                issues.append('%s.mode must be A or B' % prefix)
            if not is_text(account.get('mandateId')):
                issues.append('%s.mandateId must be a non-empty string' % prefix)
    data = params.get('data')
    if not isinstance(data, dict):
        issues.append('$.data must be an object')
    else:
        if data.get('source') not in ('host', 'engine'):
            issues.append('$.data.source must be host or engine')
        instruments = data.get('instruments')
        if not isinstance(instruments, list) or not all(isinstance(x, str) for x in instruments):
            issues.append('$.data.instruments must be an array of strings')
        if data.get('source') == 'engine':
            issues.append('$.data.source engine requires market.own')
    policies = params.get('policies')
    if not isinstance(policies, list):
        issues.append('$.policies must be an array')
    else:
        for i, policy in enumerate(policies):
            prefix = '$.policies[%d]' % i
            if not isinstance(policy, dict):
                issues.append('%s must be an object' % prefix)
                continue
            if not is_text(policy.get('policyId')):
                issues.append('%s.policyId must be a non-empty string' % prefix)
            version = policy.get('version')
            if not isinstance(version, int) or isinstance(version, bool) or version < 1:
                issues.append('%s.version must be an integer >= 1' % prefix)
            if not is_text(policy.get('digest')):
                issues.append('%s.digest must be a non-empty string' % prefix)
    heartbeat = params.get('heartbeatMs')
    if not isinstance(heartbeat, int) or isinstance(heartbeat, bool) or heartbeat < 100:
        issues.append('$.heartbeatMs must be an integer >= 100')
    return issues


INTERVAL_MS = {'1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
               '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000}


def _to_float(value, what):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise RpcFault('INVALID_PARAMS', '%s must be a number or a decimal string' % what)


# ---- Backtest spec validation (backtest.ts) --------------------------------------------

ASSUMPTION_FIELDS = ('fees', 'slippageBps', 'fillModel', 'funding', 'liquidation')


def missing_assumptions(assumptions):
    if not isinstance(assumptions, dict):
        return list(ASSUMPTION_FIELDS)
    return [f for f in ASSUMPTION_FIELDS if assumptions.get(f) is None]


def _number(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(float(value)))


SIMULATION_EXTENSION_KEYS = ('protection', 'lotStep', 'minLot')


def _simulation_extension_issues(raw):
    """Validate ``spec["x-simulation"]`` (protection / lotStep / minLot)."""
    if raw is None:
        return []
    if not isinstance(raw, dict):
        return ['$.x-simulation must be an object {protection?, lotStep?, minLot?}']
    issues = []
    unknown = [key for key in raw if key not in SIMULATION_EXTENSION_KEYS]
    if unknown:
        issues.append('$.x-simulation has unknown key(s): %s' % ', '.join(sorted(unknown)))
    protection = raw.get('protection')
    if protection is not None and not isinstance(protection, dict):
        issues.append('$.x-simulation.protection must be an object')
    step = raw.get('lotStep')
    if step is not None and (not _number(step) or float(step) <= 0):
        issues.append('$.x-simulation.lotStep must be a positive number')
    min_lot = raw.get('minLot')
    if min_lot is not None and (not _number(min_lot) or float(min_lot) < 0):
        issues.append('$.x-simulation.minLot must be >= 0')
    return issues


def backtest_spec_issues(spec):
    if not isinstance(spec, dict):
        return ['spec must be an object']
    issues = []
    for key in ('subject', 'instruments', 'interval', 'from', 'to', 'data', 'account', 'assumptions', 'seed'):
        if key not in spec:
            issues.append('$.%s is required' % key)
    if issues:
        return issues
    if not isinstance(spec.get('subject'), dict):
        issues.append('$.subject must be an object')
    instruments = spec.get('instruments')
    if not isinstance(instruments, list) or not instruments or not all(isinstance(x, str) for x in instruments):
        issues.append('$.instruments must be a non-empty array of instrument ids')
    elif len(instruments) != 1:
        issues.append('spec.instruments must contain exactly one instrumentId')
    interval = spec.get('interval')
    if not isinstance(interval, str) or interval not in INTERVAL_MS:
        issues.append('$.interval must be one of %s' % ', '.join(sorted(INTERVAL_MS)))
    start, end = spec.get('from'), spec.get('to')
    if not isinstance(start, int) or isinstance(start, bool) or start < 0:
        issues.append('$.from must be milliseconds')
    if not isinstance(end, int) or isinstance(end, bool) or end < 0:
        issues.append('$.to must be milliseconds')
    if isinstance(start, int) and isinstance(end, int) and end <= start:
        issues.append('$.to must be greater than $.from')
    data = spec.get('data')
    if not isinstance(data, dict) or data.get('source') not in ('host', 'engine', 'files'):
        issues.append('$.data.source must be host, engine or files')
    account = spec.get('account')
    if not isinstance(account, dict):
        issues.append('$.account must be an object')
    else:
        if account.get('initialBalance') is None:
            issues.append('$.account.initialBalance is required')
        else:
            try:
                if float(account['initialBalance']) <= 0:
                    issues.append('$.account.initialBalance must be > 0')
            except (TypeError, ValueError):
                issues.append('$.account.initialBalance must be a decimal string')
        if not is_text(account.get('ccy')):
            issues.append('$.account.ccy is required')
    missing = missing_assumptions(spec.get('assumptions'))
    for field in missing:
        issues.append('$.assumptions.%s is required (all five backtest assumptions)' % field)
    assumptions = spec.get('assumptions')
    if isinstance(assumptions, dict) and assumptions.get('fillModel') is not None:
        if assumptions.get('fillModel') != 'next-bar-open':
            # The engine only fills at the next bar open; describe says so too.
            issues.append('spec.assumptions.fillModel must be one of next-bar-open '
                          '(declared in engine.describe)')
    if isinstance(assumptions, dict) and assumptions.get('slippageBps') is not None:
        slippage = assumptions.get('slippageBps')
        if (not isinstance(slippage, (int, float)) or isinstance(slippage, bool)
                or not math.isfinite(float(slippage))
                or not 0 <= float(slippage) <= 500):
            issues.append('spec.assumptions.slippageBps must be in [0, 500]')
    if isinstance(assumptions, dict):
        for key in ('funding', 'liquidation'):
            value = assumptions.get(key)
            if value is not None and not isinstance(value, bool):
                issues.append('$.assumptions.%s must be a boolean' % key)
        share = assumptions.get('maxVolumeShare')
        if share is not None and (not _number(share) or not 0 <= float(share) <= 1):
            issues.append('$.assumptions.maxVolumeShare must be in [0, 1]')
        penalty = assumptions.get('liquidationPenaltyRatio')
        if penalty is not None and (not _number(penalty) or float(penalty) < 0):
            issues.append('$.assumptions.liquidationPenaltyRatio must be >= 0')
    if isinstance(account, dict):
        leverage = account.get('leverage')
        if leverage is not None and (not _number(leverage) or not 1 <= float(leverage) <= 50):
            issues.append('$.account.leverage must be in [1, 50]')
        mmr = account.get('maintenanceMarginRatio')
        if mmr is not None and (not _number(mmr) or float(mmr) < 0):
            issues.append('$.account.maintenanceMarginRatio must be >= 0 (a fraction)')
    issues.extend(_simulation_extension_issues(spec.get(SIMULATION_EXTENSION)))
    seed = spec.get('seed')
    if not isinstance(seed, int) or isinstance(seed, bool):
        issues.append('$.seed must be an integer')
    return issues


# ---- Backtest core: signal series -> TS-aligned simulator -------------------------------
#
# The accounting itself is ``engine/backtest.py``, a line-by-line port of
# ``packages/engine-core/src/strategy/simulator.ts`` (the cross-engine fixtures in
# ``tests/fixtures/ts-backtest.json`` show 0 deviation). This module only builds the
# signal series and feeds the simulator bar by bar in the same order as engine-core's
# ``runtime/backtest-jobs.ts``: the target of bar i-1 fills at the open of bar i, and
# the strategy's own warmup gates the first signal.

DEFAULT_TAKER = '0.00045'          # spec.ts:44 DEFAULT_TAKER (used when fees = "venue")
DEFAULT_MAKER = '0.00015'          # spec.ts:45 DEFAULT_MAKER


def _sma(prefix, index, period):
    if period <= 0 or index + 1 < period:
        return None
    return (prefix[index + 1] - prefix[index + 1 - period]) / period


def builtin_series(candles, params):
    """The built-in SMA-cross strategy as a target-position signal series.

    The decision for bar ``i`` uses only bars ``<= i-1`` (no lookahead) and the
    target is held until the fast/slow relation flips. ``size`` stays a paper /
    live parameter: in a backtest the position comes from target x equity x
    leverage, the same sizing rule every TS strategy gets from the simulator.
    """
    rows = sa.normalize_candles(candles)
    n = len(rows)
    fast = int(params['fastPeriod'])
    slow = int(params['slowPeriod'])
    warmup = max(int(params['warmupBars']), slow)
    prefix = [0.0]
    for row in rows:
        prefix.append(prefix[-1] + float(row['c']))
    target = [0.0] * n
    reasons = [''] * n
    position = 0.0
    for i in range(1, n):
        previous = i - 1
        if previous < warmup:
            continue
        fast_avg = _sma(prefix, previous, fast)
        slow_avg = _sma(prefix, previous, slow)
        if fast_avg is None or slow_avg is None:
            continue
        want = 1.0 if fast_avg > slow_avg else -1.0
        if want != position:
            reasons[i] = 'flip'
            position = want
        target[i] = position          # held, not just on the bar the target changed
    return sa.SignalSeries(target=target, reasons=reasons, warmup=warmup)


def run_simulator(rows, series, options, *, step_ms=None, progress=None, is_cancelled=None):
    """Feed one signal series through the simulator; ``None`` when cancelled.

    One ``on_bar`` per candle, in ``simulator.ts`` order, with the previous
    bar's target and nothing before warmup (``backtest-jobs.ts:239-248``).
    """
    sim = bt_mod.Simulator(bt_mod.resolve_sim_options(options))
    n = len(rows)
    warmup = int(series.warmup or 0)
    target = list(series.target)
    reasons = list(series.reasons)
    for i, candle in enumerate(rows):
        if i % 64 == 0:
            if progress is not None:
                progress(float(i) / float(max(1, n)))
            if is_cancelled is not None and is_cancelled():
                return None
        has_signal = i > 0 and i - 1 >= warmup
        want = target[i - 1] if has_signal and i - 1 < len(target) else None
        why = reasons[i - 1] if has_signal and i - 1 < len(reasons) else ''
        sim.on_bar(i, candle, want, why or '')
    if progress is not None:
        progress(1.0)
    return {'stats': sim.stats(rows, step_ms or bt_mod.infer_interval_ms(rows)),
            'equity': sim.equity, 'trades': sim.trades, 'funding': sim.funding,
            'simulator': sim,
            'openPosition': sim.open_position(rows[-1] if rows else None)}


# ---- Session ---------------------------------------------------------------------------


class Inbox(object):
    """Blocking hand-off from the stdin reader to the worker thread."""

    def __init__(self):
        self._items = []
        self._closed = False
        self._cv = threading.Condition()

    def put(self, item):
        with self._cv:
            self._items.append(item)
            self._cv.notify()

    def close(self):
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    def get(self):
        with self._cv:
            while not self._items and not self._closed:
                self._cv.wait()
            if not self._items:
                return None
            return self._items.pop(0)


def stdout_writer():
    def write(obj):
        line = json.dumps(obj, separators=(',', ':'), ensure_ascii=False)
        sys.stdout.buffer.write(line.encode('utf-8') + b'\n')
        sys.stdout.buffer.flush()
    return write


class Conn(object):
    """One stdio session: writes frames, tracks instances / jobs and host calls."""

    def __init__(self, write=None, host_stub=None):
        self.write = write or stdout_writer()
        self.host_stub = host_stub
        self.token = ''
        self.out = []                      # every frame written (tests / diagnostics)
        self.authed = False
        self.session_counter = 0
        self.session_id = ''
        self.on_authed = None              # serve() 挂心跳启动回调；单测里保持 None
        self.binding = None
        self.halt = None
        self.instances = {}
        self.jobs = {}
        self.instance_counter = 0
        self.job_counter = 0
        self.policy_versions = []
        self.seq = 0
        self.pending_events = []
        self.seen_host_events = set()
        self.bars_seen = 0
        self.exit_requested = False
        self.exit_code = 0
        self.exit_delay = 0.0
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending = {}
        self._host_seq = 0
        self.limits = limit_mod.Limits.from_env()
        self.strategy_dir = os.environ.get(strategy_loader.STRATEGY_DIR_ENV) or None
        self.library = None                # built lazily: strategy folder of this session

    # -- framing --------------------------------------------------------------
    def send(self, obj):
        with self._write_lock:
            self.out.append(obj)
            self.write(obj)

    def send_untracked(self, obj):
        """写一帧但不进 self.out。

        心跳是高频噪声：进 out 会让诊断列表无限增长，也会打乱按序断言帧的测试。
        """
        with self._write_lock:
            self.write(obj)

    # -- events ---------------------------------------------------------------
    def emit(self, stream, event_type, data):
        self.seq += 1
        suffix = self.session_id[-4:] if self.session_id else '0000'
        event = {'seq': self.seq,
                 'eventId': 'evt_%s%08d' % (suffix, self.seq),
                 'stream': stream,
                 'type': event_type,
                 'ts': now_ms(),
                 'data': data}
        self.pending_events.append(event)
        return event

    def flush_events(self):
        if not self.pending_events:
            return
        events = self.pending_events
        self.pending_events = []
        for start in range(0, len(events), MAX_EVENTS_PER_FRAME):
            chunk = events[start:start + MAX_EVENTS_PER_FRAME]
            self.send({'jsonrpc': '2.0', 'method': 'events.push',
                       'params': {'sessionId': self.session_id, 'events': chunk}})

    # -- host calls -----------------------------------------------------------
    def call_host(self, method, params, timeout_s=HOST_CALL_TIMEOUT_S):
        if self.host_stub is not None:
            return self.host_stub(method, params)
        with self._pending_lock:
            self._host_seq += 1
            host_id = 'e%d' % self._host_seq
            slot = {'event': threading.Event(), 'msg': None}
            self._pending[host_id] = slot
        self.send({'jsonrpc': '2.0', 'id': host_id, 'method': method, 'params': params})
        answered = slot['event'].wait(timeout_s)
        with self._pending_lock:
            self._pending.pop(host_id, None)
        return slot['msg'] if answered else None

    def resolve_host_response(self, msg):
        if not isinstance(msg, dict) or 'method' in msg or 'id' not in msg:
            return False
        if 'result' not in msg and 'error' not in msg:
            return False
        with self._pending_lock:
            slot = self._pending.get(msg['id'])
        if slot is None:
            return False
        slot['msg'] = msg
        slot['event'].set()
        return True

    def exit_after(self, code, delay_s):
        self.exit_requested = True
        self.exit_code = code
        self.exit_delay = delay_s

    # -- market events from the host -----------------------------------------
    def on_market_event(self, event):
        event_id = event.get('eventId')
        if isinstance(event_id, str):
            if event_id in self.seen_host_events:
                return
            self.seen_host_events.add(event_id)
        data = event.get('data') if isinstance(event.get('data'), dict) else {}
        candles = []
        if event.get('type') == 'market.candle' and isinstance(data.get('candle'), dict):
            candles = [data['candle']]
        elif event.get('type') == 'market.candles' and isinstance(data.get('candles'), list):
            candles = [c for c in data['candles'] if isinstance(c, dict)]
        if not candles or data.get('closed') is False:
            return
        running = [i for i in self.instances.values() if i['status'] == 'running']
        if not running:
            return
        self.bars_seen += len(candles)
        if self.bars_seen % 250 != 0:
            return
        for instance in running:
            self.emit('strategy', 'strategy.evaluated',
                      {'instanceId': instance['instanceId'], 'bars': self.bars_seen})

    # -- views ---------------------------------------------------------------
    def instance_view(self, instance):
        view = {'instanceId': instance['instanceId'],
                'strategyId': instance['strategyId'],
                'status': instance['status'],
                'accountId': instance['accountId'],
                'instruments': list(instance['instruments']),
                'params': dict(instance['params']),
                'mandateId': instance['mandateId']}
        if instance.get('interval'):
            view['interval'] = instance['interval']
        if instance.get('startedAt') is not None:
            view['startedAt'] = instance['startedAt']
        if instance.get('error'):
            view['error'] = instance['error']
        return view


# ---- engine.* methods ------------------------------------------------------------------


class Heartbeat(object):
    """每 interval 秒向宿主发一条 gep.heartbeat 通知；独立线程，不被回测 / 策略计算阻塞（GIL 每 5 ms 切换）。

    协议上它只证明「引擎活着」：engine.halt、策略忙、回测长跑都不影响发帧。
    """

    def __init__(self, conn, interval_s=HEARTBEAT_DEFAULT_S):
        self._conn = conn
        self._interval = interval_s
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name='gep-heartbeat', daemon=True)
        self._thread.start()

    def set_interval_ms(self, ms):
        ms = min(HEARTBEAT_MAX_MS, max(HEARTBEAT_MIN_MS, int(ms)))
        self._interval = ms / 1000.0
        self._wake.set()                       # 叫醒线程，按新周期重新计时

    def stop(self):
        self._stop.set()
        self._wake.set()

    def _run(self):
        deadline = time.monotonic() + self._interval
        while not self._stop.is_set():
            woke = self._wake.wait(max(0.0, deadline - time.monotonic()))
            if self._stop.is_set():
                return
            if woke:                           # 周期被改：重新计时，不发
                self._wake.clear()
                deadline = time.monotonic() + self._interval
                continue
            try:
                self._conn.send_untracked({'jsonrpc': '2.0', 'method': 'gep.heartbeat',
                                           'params': {'ts': now_ms(), 'seq': self._conn.seq}})
            except Exception:                  # stdout 关了 = 宿主没了，线程退出
                return
            deadline = time.monotonic() + self._interval


def engine_describe(conn=None):
    """``engine.describe``. With a session, ``strategies`` also lists the folder."""
    return {
        'engine': {
            'id': ENGINE_ID,
            'name': ENGINE_NAME,
            'version': ENGINE_VERSION,
            'vendor': {'id': 'gitrader', 'name': 'Gitrader', 'kind': 'community', 'verified': False},
            'license': 'CPAL-1.0',
            'runtime': 'python',
        },
        'protocol': {'version': SUPPORTED_VERSIONS[0], 'transports': ['stdio']},
        'capabilities': dict(CAPABILITIES),
        'venues': [],
        'data': {'intervals': ['1m', '5m', '15m', '30m', '1h', '4h', '1d'],
                 'maxHistoryBars': MAX_BACKTEST_BARS},
        'strategies': strategy_entries() if conn is None else strategy_entries_for(conn),
        'limits': {'maxConcurrentBacktests': 2, 'maxStrategyInstances': 8},
        'assumptions': {'backtest': {
            'fill': 'next-bar-open',
            'slippageBps': 0,
            'fees': 'spec (venue schedules are not available to the engine)',
            'funding': False,
            'liquidation': False,
            'maxBars': MAX_BACKTEST_BARS,
        }},
    }


def method_describe(conn, params):
    return engine_describe(conn)


def method_health(conn, params):
    return {'status': 'ok',
            'metrics': {'instances': len(conn.instances),
                        'bufferedEvents': len(conn.pending_events),
                        'backtestJobs': len(conn.jobs)},
            'ts': now_ms()}


def method_snapshot(conn, params):
    return {'seq': conn.seq,
            'strategies': [conn.instance_view(i) for i in conn.instances.values()],
            'orders': []}


def method_bind(conn, params):
    issues = binding_issues(params)
    if issues:
        raise RpcFault('INVALID_PARAMS', 'invalid binding: %s' % '; '.join(issues))
    response = conn.call_host('host.describe', {})
    result = response.get('result') if isinstance(response, dict) else None
    if not isinstance(result, dict):
        raise RpcFault('INTERNAL', 'host.describe did not answer')
    known = set()
    accounts = result.get('accounts')
    if isinstance(accounts, list):
        for account in accounts:
            if isinstance(account, dict) and isinstance(account.get('accountId'), str):
                known.add(account['accountId'])
    for account in params['accounts']:
        if account['accountId'] not in known:
            raise RpcFault('ACCOUNT_NOT_BOUND', 'account is not known to the host')
        if account['mode'] == 'B':
            raise RpcFault('CAPABILITY_UNSUPPORTED', 'execution.modeB is not declared')
    conn.binding = params
    heartbeat = getattr(conn, 'heartbeat', None)      # 只有 serve() 挂了心跳线程
    if heartbeat is not None:
        heartbeat.set_interval_ms(params['heartbeatMs'])   # binding_issues 保证是 >=100 的整数
    for instance in conn.instances.values():
        if instance['accountId'] not in known:
            instance['status'] = 'error'
    return {'bindingId': params['bindingId'], 'effective': params, 'warnings': []}


def method_halt(conn, params):
    p = params if isinstance(params, dict) else {}
    if not is_text(p.get('takeoverId')) or p.get('level') not in ('halt_new', 'cancel_all', 'flatten_all'):
        raise RpcFault('INVALID_PARAMS', 'takeoverId and level are required')
    conn.halt = {'takeoverId': p['takeoverId'], 'level': p['level']}
    for instance in conn.instances.values():
        if instance['status'] == 'running':
            instance['restricted'] = True
    return {'ack': True, 'appliedAt': now_ms()}


def method_resume(conn, params):
    p = params if isinstance(params, dict) else {}
    if conn.halt is None or p.get('takeoverId') != conn.halt['takeoverId']:
        raise RpcFault('INVALID_PARAMS', 'unknown takeoverId')
    conn.halt = None
    for instance in conn.instances.values():
        instance.pop('restricted', None)
    return {'resumedAt': now_ms()}


def method_shutdown(conn, params):
    p = params if isinstance(params, dict) else {}
    grace = p.get('graceMs', 0)
    if not isinstance(grace, (int, float)) or isinstance(grace, bool) or grace < 0:
        grace = 0
    conn.exit_after(0, min(float(grace), 200.0) / 1000.0)
    return {'ok': True}


def method_events_subscribe(conn, params):
    return {'subscriptionId': 'sub_%s' % (conn.session_id or 'ses_py'), 'fromSeq': conn.seq + 1}


def method_events_unsubscribe(conn, params):
    return {'ok': True}


def method_risk_policy_push(conn, params):
    p = params if isinstance(params, dict) else {}
    policies = p.get('policies')
    if not isinstance(policies, list):
        raise RpcFault('INVALID_PARAMS', 'policies must be an array')
    versions = []
    for policy in policies:
        if not isinstance(policy, dict):
            raise RpcFault('INVALID_PARAMS', 'policies must be objects')
        version = policy.get('version')
        if not isinstance(version, int) or isinstance(version, bool):
            raise RpcFault('INVALID_PARAMS', 'policy version must be an integer')
        versions.append(version)
    conn.policy_versions.extend(versions)
    return {'acceptedVersions': versions}


# ---- strategy.* methods ----------------------------------------------------------------


def library(conn):
    """The strategy folder for this session (built on first use, then shared)."""
    if getattr(conn, 'library', None) is None:
        conn.library = strategy_loader.StrategyLibrary(
            directory=getattr(conn, 'strategy_dir', None),
            limits=getattr(conn, 'limits', None))
    return conn.library


def strategy_entries_for(conn):
    """Built-in first, then every loaded ``.py`` strategy in the folder.

    The built-in stays first on purpose: ``strategy.params`` must answer for
    whatever ``strategy.list`` returns first, and the conformance host boots the
    first entry.
    """
    entries = strategy_entries()
    try:
        entries = entries + library(conn).entries()
    except Exception:          # a broken folder must not take strategy.list down
        pass
    return entries


def loaded_ids(conn):
    try:
        return sorted(library(conn).ids())
    except Exception:
        return []


def unknown_strategy_fault(conn, strategy_id):
    known = [STRATEGY_ID] + loaded_ids(conn)
    return RpcFault('INVALID_PARAMS', 'unknown strategyId%s (loaded: %s)'
                    % ('' if strategy_id is None else ' %r' % (strategy_id,), ', '.join(known)))


def strategy_defs(conn, strategy_id):
    """``(schema, defaults)`` for a strategy id; raises INVALID_PARAMS when unknown."""
    if strategy_id == STRATEGY_ID:
        return param_schema(), param_defaults()
    try:
        described = library(conn).describe(strategy_id)
    except KeyError:
        raise unknown_strategy_fault(conn, strategy_id) from None
    except Exception as exc:
        raise RpcFault('STRATEGY_ERROR', 'the strategy folder could not be read: %s'
                       % type(exc).__name__) from None
    return described['schema'], described['defaults']


def resolve_instance_params(conn, strategy_id, raw):
    """Defaults + given params, validated against that strategy's own declarations."""
    if strategy_id == STRATEGY_ID:
        return resolve_params(raw)
    try:
        return library(conn).resolve(strategy_id, raw or {})
    except KeyError:
        raise unknown_strategy_fault(conn, strategy_id) from None
    except sa.StrategyError as exc:
        raise RpcFault('INVALID_PARAMS', '; '.join(str(i) for i in exc.issues)) from None


def probe_strategy_hooks(conn, strategy_id):
    """Run one ``evaluate`` hook in the sandbox before an instance claims 'running'.

    This is where the per-hook budget (``Limits.hook_timeout_s``) actually
    protects the engine: a hook that hangs or allocates without bound is killed
    in the child process and the caller gets ``STRATEGY_ERROR`` back, while the
    engine keeps serving.
    """
    if strategy_id == STRATEGY_ID:
        return
    folder = library(conn)
    try:
        path = folder.path_of(strategy_id)
    except KeyError:
        raise unknown_strategy_fault(conn, strategy_id) from None
    record = folder.probe(path)
    if record['status'] == strategy_loader.STATUS_LOADED:
        return
    rules = ', '.join(sorted({e.get('rule', 'load') for e in record.get('errors') or []}))
    detail = '; '.join(e.get('message', '') for e in (record.get('errors') or [])[:2])
    raise RpcFault('STRATEGY_ERROR', '%s could not be started (%s): %s'
                   % (strategy_id, rules or 'load', detail))


def method_strategy_list(conn, params):
    return {'strategies': strategy_entries_for(conn)}


def method_strategy_params(conn, params):
    p = params if isinstance(params, dict) else {}
    strategy_id = p.get('strategyId')
    if not is_text(strategy_id):
        raise RpcFault('INVALID_PARAMS', 'strategyId is required')
    schema, defaults = strategy_defs(conn, strategy_id)
    return {'schema': schema, 'defaults': defaults}


def method_strategy_start(conn, params):
    p = params if isinstance(params, dict) else {}
    strategy_id = require_string(p, 'strategyId')
    if strategy_id != STRATEGY_ID and library(conn).get(strategy_id) is None:
        raise unknown_strategy_fault(conn, strategy_id)
    account_id = require_string(p, 'accountId')
    if not ACCOUNT_ID_RE.match(account_id):
        raise RpcFault('INVALID_PARAMS', 'accountId must look like acct_<id>')
    if conn.binding is not None:
        bound = {a['accountId'] for a in conn.binding['accounts']}
        if account_id not in bound:
            raise RpcFault('ACCOUNT_NOT_BOUND', 'account is not part of the current binding')
    instruments = p.get('instruments')
    if not isinstance(instruments, list) or not instruments or not all(isinstance(x, str) for x in instruments):
        raise RpcFault('INVALID_PARAMS', 'instruments must be a non-empty array of instrument ids')
    mandate_id = require_string(p, 'mandateId')
    resolved = resolve_instance_params(conn, strategy_id, p.get('params'))
    if strategy_id != STRATEGY_ID:
        # 用户代码只有在能跑通一次钩子之后才算「已装载」；超限在这里变成 4002。
        probe_strategy_hooks(conn, strategy_id)
    instance_id = p.get('instanceId')
    if instance_id is None:
        conn.instance_counter += 1
        instance_id = 'inst_py%06d' % conn.instance_counter
    elif not isinstance(instance_id, str) or not INSTANCE_ID_RE.match(instance_id):
        raise RpcFault('INVALID_PARAMS', 'instanceId must look like inst_<id>')
    if instance_id in conn.instances:
        raise RpcFault('INVALID_PARAMS', 'instance already exists')
    interval = p.get('interval')
    instance = {'instanceId': instance_id, 'strategyId': strategy_id, 'status': 'running',
                'accountId': account_id, 'instruments': list(instruments),
                'params': resolved, 'mandateId': mandate_id, 'startedAt': now_ms()}
    if isinstance(interval, str) and interval:
        instance['interval'] = interval
    conn.instances[instance_id] = instance
    conn.emit('strategy', 'strategy.started',
              {'instanceId': instance_id, 'strategyId': strategy_id})
    return {'instanceId': instance_id, 'status': 'running'}


def _instance_or_fault(conn, instance_id):
    instance = conn.instances.get(instance_id)
    if instance is None:
        raise RpcFault('INVALID_PARAMS', 'unknown instanceId')
    return instance


def method_strategy_stop(conn, params):
    p = params if isinstance(params, dict) else {}
    instance_id = require_string(p, 'instanceId')
    instance = _instance_or_fault(conn, instance_id)
    if p.get('flatten') not in (None, False):
        raise RpcFault('INVALID_PARAMS', 'flatten is not supported by this engine')
    instance['status'] = 'stopped'
    conn.emit('strategy', 'strategy.stopped', {'instanceId': instance_id})
    return {'status': 'stopped'}


def method_strategy_update(conn, params):
    p = params if isinstance(params, dict) else {}
    instance_id = require_string(p, 'instanceId')
    instance = _instance_or_fault(conn, instance_id)
    merged = dict(instance['params'])
    merged.update(p.get('params') or {})
    instance['params'] = resolve_instance_params(conn, instance['strategyId'], merged)
    return {'status': instance['status'], 'appliedAt': now_ms()}


def method_strategy_status(conn, params):
    p = params if isinstance(params, dict) else {}
    wanted = p.get('instanceId')
    if wanted is not None and not is_text(wanted):
        raise RpcFault('INVALID_PARAMS', 'instanceId must be a string')
    instances = [conn.instance_view(i) for i in conn.instances.values()
                 if wanted is None or i['instanceId'] == wanted]
    return {'instances': instances}


def method_strategy_files(conn, params):
    """``x-gitrader.strategy.files`` (methods.ts:371): the folder's load report.

    Shape follows engine-core (``runtime/engine.ts:499``): ``dir`` / ``files`` /
    ``loaded``. Two optional parameters make the report usable without a restart:

    * ``rescan`` — ignore the ``(mtime, size)`` cache and reload every file;
    * ``file`` — load (and probe, one ``evaluate`` hook) just that one file and
      return its report as ``strategy``.

    A limit breach is written into the report (``status: "error"``,
    ``limit: "hook_timeout" | "memory"``) and never takes the engine down.
    """
    p = params if isinstance(params, dict) else {}
    folder = library(conn)
    rescan = p.get('rescan') is True
    wanted = p.get('file')
    if wanted is not None and not is_text(wanted):
        raise RpcFault('INVALID_PARAMS', 'file must be a file name')
    if is_text(wanted):
        name = os.path.basename(wanted)
        if name != wanted or name.startswith('_') or os.path.splitext(name)[1] not in strategy_loader.STRATEGY_EXTENSIONS:
            raise RpcFault('INVALID_PARAMS', 'file must be a plain .py file name')
        path = os.path.join(folder.directory or '', name)
        if not folder.directory or not os.path.isfile(path):
            raise RpcFault('INVALID_PARAMS', 'no such strategy file: %s' % name)
        record = folder.probe(path) if p.get('probe', True) is not False else folder.load(path, force=True)
        return {'dir': folder.directory, 'files': folder.reports(), 'loaded': folder.ids(),
                'strategy': {k: record.get(k) for k in ('file', 'status', 'id', 'version', 'errors',
                                                        'warnings', 'ms', 'peakRssBytes', 'limit',
                                                        'signals')},
                'limits': conn.limits.to_dict()}
    folder.scan(force=rescan)
    return {'dir': folder.directory, 'files': folder.reports(), 'loaded': folder.ids(),
            'limits': conn.limits.to_dict()}


# ---- backtest.* methods ----------------------------------------------------------------


def _fetch_candles(conn, spec):
    data = spec['data']
    source = data.get('source')
    if source != 'host':
        raise RpcFault('DATA_UNAVAILABLE',
                       'data.source=%s is not supported yet: this engine reads bars from the host only'
                       % source)
    interval = spec['interval']
    step = INTERVAL_MS[interval]
    bars = int((spec['to'] - spec['from']) // step) + 1
    bars = max(2, min(MAX_BACKTEST_BARS, bars))
    response = conn.call_host('host.market.history', {
        'instrumentId': spec['instruments'][0], 'interval': interval,
        'from': spec['from'], 'to': spec['to'], 'limit': bars})
    if not isinstance(response, dict):
        raise RpcFault('DATA_UNAVAILABLE', 'host.market.history did not answer')
    if 'error' in response:
        raise RpcFault('DATA_UNAVAILABLE', 'host.market.history failed: %s'
                       % (response['error'].get('message') if isinstance(response['error'], dict) else 'unknown'))
    result = response.get('result')
    candles = result.get('candles') if isinstance(result, dict) else None
    if not isinstance(candles, list) or len(candles) < 2:
        raise RpcFault('DATA_UNAVAILABLE', 'host.market.history returned fewer than two bars')
    clean = []
    for bar in candles:
        if not isinstance(bar, dict):
            raise RpcFault('DATA_UNAVAILABLE', 'host.market.history returned a non-object bar')
        for key in ('t', 'o', 'h', 'l', 'c'):
            if key not in bar:
                raise RpcFault('DATA_UNAVAILABLE', 'host.market.history bar is missing %s' % key)
        volume = bar.get('v')
        clean.append({'t': int(bar['t']), 'o': float(bar['o']), 'h': float(bar['h']),
                      'l': float(bar['l']), 'c': float(bar['c']),
                      'v': float(volume) if isinstance(volume, (int, float)) and not isinstance(volume, bool) else 0.0})
    if len(clean) > bars:
        clean = clean[:bars]
    return clean


# ---- Backtest job: spec -> signals -> simulator -> result -------------------------------


def _decimal_str(value):
    """Canonical decimal string: plain fraction, no exponent, no trailing zeros."""
    text = ('%.17f' % float(value)).rstrip('0').rstrip('.')
    return text or '0'


def _finite_number(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(float(value)))


def _resolve_fee_rate(conn, spec, warnings):
    """``(maker, taker)`` fractions actually charged. "venue" asks the host first."""
    fees = spec['assumptions'].get('fees')
    if fees != 'venue':
        maker = _to_float(fees.get('maker', DEFAULT_MAKER), 'assumptions.fees.maker')
        taker = _to_float(fees.get('taker', DEFAULT_TAKER), 'assumptions.fees.taker')
        return maker, taker
    instrument = spec['instruments'][0]
    maker = taker = None
    try:
        response = conn.call_host('host.instruments', {'ids': [instrument]})
    except Exception:                     # a host without the method is not a job failure
        response = None
    if isinstance(response, dict) and isinstance(response.get('result'), dict):
        for item in response['result'].get('instruments') or []:
            if not isinstance(item, dict) or item.get('instrumentId') != instrument:
                continue
            table = item.get('fees')
            if isinstance(table, dict):
                try:                      # protocol decimal strings, or plain numbers
                    taker = float(table['taker'])
                    maker = (float(table['maker']) if table.get('maker') is not None
                             else float(DEFAULT_MAKER))
                except (KeyError, TypeError, ValueError):
                    taker = maker = None
                if taker is not None and math.isfinite(taker):
                    break
                taker = maker = None
    if taker is None:
        taker, maker = float(DEFAULT_TAKER), float(DEFAULT_MAKER)
        warnings.append('fees "venue": the host gave no fee schedule; default taker %s used '
                        '(see assumptions.fees)' % DEFAULT_TAKER)
    return maker, taker


def _funding_points(conn, spec, warnings):
    """Funding points inside ``[from, to)``; empty + warning when unavailable."""
    if spec['assumptions'].get('funding') is not True:
        return []
    instrument = spec['instruments'][0]
    try:
        response = conn.call_host('host.market.fundingHistory',
                                  {'instrumentId': instrument, 'from': spec['from'],
                                   'to': spec['to']})
    except Exception as exc:
        response = {'error': {'message': type(exc).__name__}}
    if not isinstance(response, dict) or not isinstance(response.get('result'), dict):
        message = 'no answer'
        if isinstance(response, dict) and isinstance(response.get('error'), dict):
            message = str(response['error'].get('message') or 'error')[:200]
        warnings.append('host.market.fundingHistory unavailable (%s); funding is not settled '
                        '(assumptions.funding = false)' % message)
        return []
    points = []
    for item in response['result'].get('points') or []:
        if isinstance(item, dict) and _finite_number(item.get('t')) and _finite_number(item.get('rate')):
            points.append({'t': float(item['t']), 'rate': float(item['rate'])})
    points = [point for point in points if spec['from'] <= point['t'] < spec['to']]
    points.sort(key=lambda point: point['t'])
    unique = []
    for point in points:
        if unique and unique[-1]['t'] == point['t']:
            continue
        unique.append(point)
    if not unique:
        warnings.append('no funding points in range; funding is not settled '
                        '(assumptions.funding = false)')
    return unique


SIMULATION_EXTENSION = 'x-simulation'


def _simulation_extras(spec):
    """``spec["x-simulation"]``: protection rules + lot normalization.

    These three knobs exist in the TS simulator (``SimOptions.protection`` /
    ``lotStep`` / ``minLot``) but have no field in ``BacktestSpec``, so they
    travel in a vendor extension object; the protocol reserves ``x-`` keys for
    exactly this (model.BacktestAssumptions declares ``[x-${string}]``).
    """
    raw = spec.get(SIMULATION_EXTENSION)
    if not isinstance(raw, dict):
        return None, None, None
    protection = raw.get('protection')
    protection = bt_mod.normalize_protection(protection) if isinstance(protection, dict) else None
    step = raw.get('lotStep')
    step = float(step) if _finite_number(step) and float(step) > 0 else None
    min_lot = raw.get('minLot')
    min_lot = float(min_lot) if _finite_number(min_lot) and float(min_lot) >= 0 else None
    if step is None:
        return protection, None, None
    return protection, step, (min_lot if min_lot is not None else 0.0)


def _simulation(conn, spec, warnings):
    """Simulator options + the assumptions actually applied (``result.assumptions``)."""
    account = spec['account']
    initial = _to_float(account.get('initialBalance'), 'account.initialBalance')
    leverage = float(account.get('leverage') or 1.0)
    maker, taker = _resolve_fee_rate(conn, spec, warnings)
    given = spec['assumptions']
    slippage = _to_float(given.get('slippageBps') or 0.0, 'assumptions.slippageBps')
    raw_mmr = account.get('maintenanceMarginRatio')
    maintenance = (float(raw_mmr) if _finite_number(raw_mmr) and float(raw_mmr) >= 0
                   else 0.5 / leverage)
    share = given.get('maxVolumeShare')
    share = float(share) if _finite_number(share) else None
    penalty = given.get('liquidationPenaltyRatio')
    penalty = float(penalty) if _finite_number(penalty) and float(penalty) >= 0 else 0.0
    liquidation = given.get('liquidation') is True
    funding_points = _funding_points(conn, spec, warnings)
    protection, lot_step, min_lot = _simulation_extras(spec)

    options = {'initialCash': initial, 'leverage': leverage, 'feeRate': taker,
               'slippageBps': slippage, 'funding': funding_points,
               'liquidation': liquidation, 'maintenanceMarginRatio': maintenance,
               'liquidationPenaltyRatio': penalty}
    if share is not None:
        options['maxVolumeShare'] = share
    if protection is not None:
        options['protection'] = protection
    if lot_step is not None:
        options['lotStep'] = lot_step
        options['minLot'] = min_lot

    effective = {
        'fees': {'maker': _decimal_str(maker), 'taker': _decimal_str(taker)},
        'slippageBps': slippage,
        'fillModel': 'next-bar-open',
        'funding': bool(funding_points),
        'liquidation': liquidation,
        'liquidationPenaltyRatio': penalty,
        'latencyMs': 0,
        'x-intraBar': ('not modelled: the signal is taken at bar close, the fill happens '
                       'at the next bar open'),
        'x-feesApplied': 'taker fee on every fill (every simulated order is a market order)',
        'x-maintenanceMarginRatio': maintenance,
    }
    if share is not None:
        effective['maxVolumeShare'] = share
    if protection is not None:
        effective['x-protection'] = protection
    if lot_step is not None:
        effective['x-lotStep'] = lot_step
        effective['x-minLot'] = min_lot
    return options, effective


def _strategy_digest(conn, strategy_id):
    """``strategySha256``: the folder file's bytes, or the built-in's declaration."""
    if strategy_id == STRATEGY_ID:
        return sha256_digest({'strategyId': STRATEGY_ID, 'version': STRATEGY_VERSION})
    try:
        with open(library(conn).path_of(strategy_id), 'rb') as handle:
            return 'sha256:' + hashlib.sha256(handle.read()).hexdigest()
    except (OSError, KeyError):
        return sha256_digest({'strategyId': strategy_id})


SIGNAL_BUDGET_FACTOR = 15       # one signal pass may take this many hook budgets
SIGNAL_BUDGET_FLOOR_S = 2.0


def _signal_budget(conn, job):
    """Wall clock for one signal pass: min(remaining job budget, 15 hook budgets).

    Computing the whole series is one ``evaluate`` call, so the per-hook budget
    (2 s default) is too tight; the pass still gets hard-killed by the supervisor
    and reported as ``STRATEGY_ERROR``, so a hanging strategy cannot hold a job
    open until the (900 s) backtest budget runs out.
    """
    remaining = job['deadline'] - time.monotonic()
    cap = max(SIGNAL_BUDGET_FLOOR_S, float(conn.limits.hook_timeout_s) * SIGNAL_BUDGET_FACTOR)
    return max(0.1, min(remaining, float(conn.limits.backtest_timeout_s), cap))


def _strategy_signals(conn, job, rows):
    """Signal series for the job's strategy: built-in in process, files in the sandbox."""
    if job['strategyId'] == STRATEGY_ID:
        return builtin_series(rows, job['params'])
    folder = library(conn)
    try:
        path = folder.path_of(job['strategyId'])
    except KeyError:
        raise unknown_strategy_fault(conn, job['strategyId']) from None
    budget = _signal_budget(conn, job)
    result = folder.supervisor.run({'job': 'signals', 'path': path, 'params': job['params'],
                                    'candles': rows},
                                   timeout_s=budget,
                                   label='signals of %s' % job['strategyId'])
    if not result.ok:
        detail = result.detail or result.status
        if result.limit == limit_mod.LIMIT_HOOK_TIMEOUT or result.status == 'timeout':
            raise RpcFault('STRATEGY_ERROR',
                           '%s did not finish its signal series within %.0f s '
                           '(15 x the hook budget, capped by the backtest budget; set %s / %s): %s'
                           % (job['strategyId'], budget, limit_mod.ENV_HOOK_TIMEOUT,
                              limit_mod.ENV_BACKTEST_TIMEOUT, detail))
        raise RpcFault('STRATEGY_ERROR', '%s failed while computing its signal series (%s): %s'
                       % (job['strategyId'], result.status, detail))
    series = (result.payload or {}).get('series') or {}
    target = series.get('target')
    if not isinstance(target, list) or len(target) != len(rows):
        raise RpcFault('STRATEGY_ERROR', '%s returned a signal series of the wrong length'
                       % job['strategyId'])
    reasons = series.get('reasons') if isinstance(series.get('reasons'), list) else []
    return sa.SignalSeries(target=[float(t) for t in target],
                           reasons=[str(r) for r in reasons],
                           warmup=int(series.get('warmup') or 0))


def _backtest_expired(conn, job):
    deadline = job.get('deadline')
    return deadline is not None and time.monotonic() > deadline


def _run_job(conn, job):
    job['state'] = 'running'
    spec = job['spec']
    try:
        candles = _fetch_candles(conn, spec)
        if job.get('cancel'):
            return
        warnings = []
        step = INTERVAL_MS[spec['interval']]
        requested_bars = int((spec['to'] - spec['from']) // step) + 1
        if requested_bars > MAX_BACKTEST_BARS:
            warnings.append('the requested window has %d bars, more than the engine limit of %d; '
                            'only the first %d bars from spec.from are backtested'
                            % (requested_bars, MAX_BACKTEST_BARS, MAX_BACKTEST_BARS))
        options, effective = _simulation(conn, spec, warnings)
        if effective['liquidation']:
            warnings.append('liquidation is modelled on the worst intrabar price of each bar; '
                            'there is no cross-bar margin path')
        rows = sa.normalize_candles(candles)
        series = _strategy_signals(conn, job, rows)

        def progress(value):
            job['progress'] = max(job['progress'], min(1.0, float(value)))

        # 两道上限：协作式的整次回测预算（这里，每 64 根问一次）+ 每个钩子的硬上限
        # （strategy_loader 的子进程）。所以预算是「最多这么久的墙钟」，不是「一定在
        # 这么久内返回」——真正能硬杀的只有子进程那条路。
        run = run_simulator(rows, series, options, step_ms=step, progress=progress,
                            is_cancelled=lambda: (bool(job.get('cancel'))
                                                  or _backtest_expired(conn, job)))
        if job.get('cancel'):
            return
        if run is None:
            if _backtest_expired(conn, job):
                raise RpcFault('STRATEGY_ERROR',
                               'the backtest exceeded the configured limit of %d ms; '
                               'no result is reported (set %s to raise it)'
                               % (conn.limits.backtest_timeout_ms, limit_mod.ENV_BACKTEST_TIMEOUT))
            return
        sim = run['simulator']
        if getattr(sim, 'annualized_unavailable', False):
            warnings.append('annualizedRatio is reported as 0: annualising a window shorter '
                            'than a day does not give a finite number (stats.spanDays is the '
                            'window actually simulated)')
        if sim.bankrupt:
            warnings.append('account bankrupt: cash reached 0 while the position was open; '
                            'no fills are simulated after that bar')
        result = {
            'jobId': job['jobId'],
            'specDigest': sha256_digest(spec),
            'assumptions': effective,
            'stats': run['stats'],
            'equity': [{'t': int(point['t']), 'v': float(point['v'])} for point in run['equity']],
            'trades': [{'t': int(trade['t']), 'side': trade['side'],
                        'price': float(trade['price']), 'size': float(trade['size']),
                        'pnl': float(trade['pnl']), 'fee': float(trade['fee']),
                        'reason': trade['reason']} for trade in run['trades']],
            'openPosition': run['openPosition'],
            'artifacts': [],
            'warnings': warnings,
            'engine': {'id': ENGINE_ID, 'version': ENGINE_VERSION},
            'dataDigest': sha256_digest(candles),
            'strategySha256': job['sha256'],
        }
        if run['funding']:
            result['funding'] = [{'t': int(point['t']), 'rate': float(point['rate']),
                                  'notional': float(point['notional']),
                                  'paid': float(point['paid'])} for point in run['funding']]
        if job.get('cancel'):
            return
        job['result'] = result
        job['progress'] = 1.0
        job['state'] = 'done'
    except RpcFault as fault:
        job['state'] = 'failed'
        job['error'] = make_problem(fault.name, fault.message)
        job['progress'] = 1.0
    except Exception as exc:                      # never let a job kill the session
        job['state'] = 'failed'
        job['error'] = make_problem('BACKTEST_FAILED', 'backtest failed: %s' % type(exc).__name__)
        job['progress'] = 1.0


def method_backtest_run(conn, params):
    p = params if isinstance(params, dict) else {}
    spec = p.get('spec')
    issues = backtest_spec_issues(spec)
    if issues:
        raise RpcFault('INVALID_PARAMS', 'invalid spec: %s' % '; '.join(issues))
    subject = spec['subject'].get('strategy') if isinstance(spec['subject'], dict) else None
    subject = subject if isinstance(subject, dict) else {}
    strategy_id = subject.get('id') if is_text(subject.get('id')) else STRATEGY_ID
    if strategy_id != STRATEGY_ID and library(conn).get(strategy_id) is None:
        raise unknown_strategy_fault(conn, strategy_id)
    strategy_params = resolve_instance_params(conn, strategy_id, subject.get('params') or {})
    running = [j for j in conn.jobs.values() if j['state'] in ('queued', 'running')]
    if len(running) >= 2:
        raise RpcFault('BUSY', 'too many concurrent backtests')
    conn.job_counter += 1
    digest = sha256_digest(spec).split(':', 1)[1][:8]
    job_id = 'job_py%04d_%s' % (conn.job_counter, digest)
    job = {'jobId': job_id, 'state': 'queued', 'progress': 0.0, 'spec': spec,
           'params': strategy_params, 'strategyId': strategy_id,
           'sha256': _strategy_digest(conn, strategy_id),
           'deadline': time.monotonic() + float(conn.limits.backtest_timeout_s),
           'result': None, 'error': None, 'cancel': False}
    conn.jobs[job_id] = job
    worker = threading.Thread(target=_run_job, args=(conn, job), name='backtest-%s' % job_id)
    worker.daemon = True
    worker.start()
    return {'jobId': job_id}


def _job_or_fault(conn, params):
    p = params if isinstance(params, dict) else {}
    job_id = require_string(p, 'jobId')
    job = conn.jobs.get(job_id)
    if job is None:
        raise RpcFault('INVALID_PARAMS', 'unknown jobId')
    return job


def method_backtest_status(conn, params):
    job = _job_or_fault(conn, params)
    return {'state': job['state'], 'progress': round(float(job['progress']), 6)}


def method_backtest_result(conn, params):
    job = _job_or_fault(conn, params)
    if job['state'] == 'done' and job['result'] is not None:
        return job['result']
    if job['state'] == 'failed':
        error = job['error'] or make_problem('BACKTEST_FAILED', 'backtest failed')
        raise RpcFault(error['name'], error['message'])
    if job['state'] == 'cancelled':
        raise RpcFault('BACKTEST_FAILED', 'job was cancelled')
    raise RpcFault('BUSY', 'job is %s' % job['state'])


def method_backtest_cancel(conn, params):
    job = _job_or_fault(conn, params)
    if job['state'] in ('queued', 'running'):
        job['cancel'] = True
        job['state'] = 'cancelled'
    return {'state': job['state']}


# ---- Dispatch --------------------------------------------------------------------------

METHODS = {
    'engine.describe': method_describe,
    'engine.bind': method_bind,
    'engine.health': method_health,
    'engine.snapshot': method_snapshot,
    'engine.halt': method_halt,
    'engine.resume': method_resume,
    'engine.shutdown': method_shutdown,
    'events.subscribe': method_events_subscribe,
    'events.unsubscribe': method_events_unsubscribe,
    'risk.policy.push': method_risk_policy_push,
    'strategy.list': method_strategy_list,
    'strategy.params': method_strategy_params,
    'strategy.start': method_strategy_start,
    'strategy.stop': method_strategy_stop,
    'strategy.update': method_strategy_update,
    'strategy.status': method_strategy_status,
    'backtest.run': method_backtest_run,
    'backtest.status': method_backtest_status,
    'backtest.result': method_backtest_result,
    'backtest.cancel': method_backtest_cancel,
    'x-gitrader.strategy.files': method_strategy_files,
}


def hello(conn, msg_id, params):
    p = params if isinstance(params, dict) else {}
    auth = p.get('auth') if isinstance(p.get('auth'), dict) else {}
    if auth.get('token') != conn.token:
        conn.exit_after(1, 0.05)
        return error_response(msg_id, 'AUTH_FAILED', 'authentication failed')
    version = negotiate_version(p.get('versions'))
    if version is None:
        return error_response(msg_id, 'VERSION_UNSUPPORTED',
                              'no common version; this engine supports %s' % SUPPORTED_VERSIONS[0])
    if isinstance(p.get('resume'), dict):
        # events.resume is not declared: retention is not implemented, so a resume
        # can never be completed (5004, then the host realigns via engine.snapshot).
        return error_response(msg_id, 'SESSION_GAP', 'this engine does not retain events for resume')
    conn.authed = True
    conn.session_counter += 1
    conn.session_id = 'ses_py%04d' % conn.session_counter
    if conn.on_authed:                     # serve() 里 = 起心跳线程；单测里为 None
        conn.on_authed()
    return {'jsonrpc': '2.0', 'id': msg_id,
            'result': {'version': version, 'sessionId': conn.session_id, 'resumed': False,
                       'engine': {'id': ENGINE_ID, 'version': ENGINE_VERSION}}}


def dispatch(conn, msg):
    if not isinstance(msg, dict) or msg.get('jsonrpc') != '2.0' or not isinstance(msg.get('method'), str):
        msg_id = msg.get('id') if isinstance(msg, dict) else None
        return error_response(msg_id, 'INVALID_REQUEST', 'invalid request')
    if 'id' not in msg:
        on_notification(conn, msg)
        return None
    msg_id = msg['id']
    method = msg['method']
    try:
        if method == 'gep.hello':
            return hello(conn, msg_id, msg.get('params'))
        if not conn.authed:
            return error_response(msg_id, 'AUTH_FAILED', 'hello required')
        hits = find_secret_fields(msg.get('params'))
        if hits:
            return error_response(msg_id, 'SECRET_FIELD_REJECTED',
                                  'secret-like field rejected: %s' % ', '.join(hits))
        capability = METHOD_CAPABILITY.get(method)
        if capability is not None and CAPABILITIES.get(capability) is not True:
            return error_response(msg_id, 'CAPABILITY_UNSUPPORTED',
                                  '%s is not declared in engine.describe' % method)
        handler = METHODS.get(method)
        if handler is None:
            return error_response(msg_id, 'METHOD_NOT_FOUND', 'method not found: %s' % method)
        params = msg.get('params')
        return {'jsonrpc': '2.0', 'id': msg_id, 'result': handler(conn, params or {})}
    except RpcFault as fault:
        return error_response(msg_id, fault.name, fault.message)
    except Exception:
        return error_response(msg_id, 'INTERNAL', 'internal error')


def on_notification(conn, msg):
    method = msg.get('method')
    params = msg.get('params') if isinstance(msg.get('params'), dict) else {}
    if method == 'events.push':
        events = params.get('events')
        if isinstance(events, list):
            for event in events:
                if isinstance(event, dict):
                    conn.on_market_event(event)
    # gep.heartbeat / host.events.ack / events.ack need no answer
    return None


def process_message(conn, msg):
    if isinstance(msg, list):
        if len(msg) == 0:
            # 空 batch：JSON-RPC 2.0 要求回一帧 Invalid Request（TS 侧 src/gep/peer.ts 同口径）。
            conn.send(error_response(None, 'INVALID_REQUEST', 'empty batch'))
            conn.flush_events()
            return
        if len(msg) > MAX_BATCH_MEMBERS:
            # 整帧拒绝：一批 20 000 条会把响应放大约 39×，单帧可到 ~160 MB（审计 L4-03）。
            conn.send(error_response(None, 'INVALID_REQUEST',
                                     'batch has %d members; the limit is %d' % (len(msg), MAX_BATCH_MEMBERS)))
            conn.flush_events()
            return
        out = []
        for item in msg:
            response = dispatch(conn, item)
            if response is not None:
                out.append(response)
        if out:
            conn.send(out)
    else:
        response = dispatch(conn, msg)
        if response is not None:
            conn.send(response)
    conn.flush_events()


def _nesting_exceeds(text, limit):
    """这段 JSON 文本的括号嵌套深度是否超过 limit（字符串字面量里的括号不计）。超了立刻返回。

    深度不可能超过开括号的个数，所以调用方先用 `line.count(b'[')+line.count(b'{')` 做一次 O(n) 的
    C 级短路：正常帧（开括号 < limit）根本不进这个 Python 级扫描。
    """
    depth = 0
    in_string = False
    escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == '[' or ch == '{':
            depth += 1
            if depth > limit:
                return True
        elif ch == ']' or ch == '}':
            if depth > 0:
                depth -= 1
    return False


def _reject_constant(name):
    """`NaN` / `Infinity` / `-Infinity` 不是合法 JSON（RFC 8259）；Python 的 json 默认放行，
    放进来就是 float('nan') 一路穿透十进制算术。这里直接拒，让整帧走 PARSE_ERROR。"""
    raise ValueError('non-finite JSON literal: %s' % name)


def _finite_float(text):
    """溢出的数字字面量（如 1e999）在 Python 里会变成 inf；与 NaN / Infinity 同样拒收。"""
    value = float(text)
    if not math.isfinite(value):
        raise ValueError('non-finite JSON number: %s' % text[:32])
    return value


def parse_frame(conn, raw):
    """Decode one line. Returns (message, None) or (None, error_frame).

    Never raises: 一帧坏数据只回一帧错误，绝不把异常交给读循环（L4-01）。
    """
    if isinstance(raw, str):
        raw = raw.encode('utf-8')
    line = raw.strip()
    if not line:
        return None, None
    if len(line) > MAX_LINE_BYTES:
        return None, error_response(None, 'PAYLOAD_TOO_LARGE', 'stdio line exceeds 1 MiB')
    try:
        text = line.decode('utf-8')
    except UnicodeDecodeError:
        return None, error_response(None, 'PARSE_ERROR', 'invalid UTF-8')
    if text.startswith('\ufeff'):
        text = text[1:]
    if (line.count(b'[') + line.count(b'{')) > MAX_JSON_DEPTH and _nesting_exceeds(text, MAX_JSON_DEPTH):
        return None, error_response(None, 'PARSE_ERROR',
                                    'frame nesting exceeds %d levels' % MAX_JSON_DEPTH)
    try:
        return json.loads(text, parse_constant=_reject_constant, parse_float=_finite_float), None
    except RecursionError:
        # 理论上深度预检已挡住；留给预检算不到的构造（例如超长数字串的解析器递归）。
        return None, error_response(None, 'PARSE_ERROR', 'frame nesting is too deep to decode')
    except Exception:            # noqa: BLE001 - ValueError / UnicodeError / MemoryError / 任何解码失败
        return None, error_response(None, 'PARSE_ERROR', 'parse error')


def process_line(conn, raw):
    """Frame one line (bytes or str) and handle it. Returns the response, if any.

    Used by the tests and by any single-threaded embedder; the stdio server keeps
    reading and dispatching on separate threads (see ``read_loop``/``work_loop``)
    so that ``host.*`` calls can be answered while a method is running.
    """
    msg, failure = parse_frame(conn, raw)
    if failure is not None:
        conn.send(failure)
        return None
    if msg is None:
        return None
    if conn.resolve_host_response(msg):
        return None
    before = len(conn.out)
    process_message(conn, msg)
    return conn.out[before] if len(conn.out) > before else None


# ---- stdio plumbing --------------------------------------------------------------------


def read_loop(conn, inbox):
    """Read frames, answer host responses immediately, queue everything else.

    一帧的失败绝不结束主循环（L4-01）：深嵌套帧曾经抛 RecursionError 穿过 serve()，
    让整个引擎以退出码 1 结束。SystemExit / KeyboardInterrupt 照旧放行。
    """
    stdin = sys.stdin.buffer
    while True:
        try:
            raw = stdin.readline()
        except (OSError, ValueError):
            break
        if not raw:
            break
        try:
            msg, failure = parse_frame(conn, raw)
            if failure is not None:
                conn.send(failure)
                continue
            if msg is None:
                continue
            if conn.resolve_host_response(msg):
                continue
            inbox.put(msg)
        except (SystemExit, KeyboardInterrupt):
            raise
        except BaseException:              # noqa: BLE001 - 任何单帧失败都只丢这一帧
            try:
                sys.stderr.write('python-engine: frame dropped after an internal failure\n')
                conn.send(error_response(None, 'INTERNAL', 'internal error while framing the request'))
            except Exception:
                pass
            continue
    inbox.close()


def work_loop(conn, inbox):
    while True:
        msg = inbox.get()
        if msg is None:
            return
        try:
            process_message(conn, msg)
        except Exception:
            try:
                sys.stderr.write('python-engine: internal dispatch failure\n')
                conn.send(error_response(None, 'INTERNAL', 'internal error'))
            except Exception:
                pass
        if conn.exit_requested:
            time.sleep(conn.exit_delay)
            try:
                sys.stdout.buffer.flush()
            except Exception:
                pass
            os._exit(conn.exit_code)


def serve(token=None):
    """Run the engine over stdio until EOF or engine.shutdown. Returns an exit code."""
    conn = Conn()
    conn.token = token if token is not None else (os.environ.get(TOKEN_ENV) or '')
    if not conn.token:
        sys.stderr.write('python-engine: %s is not set; refusing to start\n' % TOKEN_ENV)
        return 2
    # 心跳只在真实 stdio 会话里挂线程：单测靠 process_line + conn.out 的顺序断言帧，
    # 线程插帧会打乱它们（见 tests/test_gep.py）。
    conn.heartbeat = Heartbeat(conn)
    conn.on_authed = conn.heartbeat.start
    inbox = Inbox()
    worker = threading.Thread(target=work_loop, args=(conn, inbox), name='gep-worker')
    worker.daemon = True
    worker.start()
    read_loop(conn, inbox)
    conn.heartbeat.stop()                  # EOF：宿主没了，别在关 stdout 之后还去写
    worker.join(2.0)
    return 0
