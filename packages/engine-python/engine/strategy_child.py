# SPDX-License-Identifier: CPAL-1.0
"""One supervised strategy job, in a throwaway child process.

Started by ``engine/limits.py`` (``Supervisor``) as::

    python -B engine/strategy_child.py

It reads exactly one JSON job from stdin, writes exactly one JSON line to
stdout and exits. ``engine/strategy_loader.py`` is the only caller; nothing here
is reachable over GEP, so a job name that is not understood is a bug in this
package, not user input.

Jobs
----
``{"job": "load", "path": "<file.py>"}``
    Sandbox-check and execute the file, then return its declaration
    (``id`` / ``name`` / ``version`` / ``desc`` / ``tags`` / ``params``).
``{"job": "evaluate", "path": "<file.py>", "params": {...}, "bars": 200, "seed": 7}``
    Load it the same way, then run one ``evaluate`` hook over deterministic
    synthetic candles and validate the shape of what came back.
``{"job": "signals", "path": "<file.py>", "params": {...}, "candles": [...]}``
    Load it and run one ``evaluate`` hook over the caller's own candles, then
    return the validated target series (the backtest loop then feeds it to the
    simulator in the engine process). Reasons are truncated so a chatty strategy
    cannot blow the 1 MiB pipe budget.

Why a child process
-------------------
Because this is where user code actually runs. The parent owns the clock and
the memory ceiling (see ``limits.py``); this process only reports what it did.
A strategy that loops forever or allocates without bound is killed from
outside, so the engine's own process never blocks.

``tracemalloc`` is started at the top so the peak Python heap of the job can be
reported back; the parent compares it with its own RSS samples and uses the
larger number.

Output is one line of JSON and nothing else. Strategies cannot write here: the
sandbox's restricted builtins do not include ``print`` and do not expose ``sys``.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import tracemalloc

_HERE = os.path.dirname(os.path.abspath(__file__))
_PACKAGE_ROOT = os.path.dirname(_HERE)
if _PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, _PACKAGE_ROOT)

from engine import strategy_api as sa  # noqa: E402  (path set up above)

MAX_ERRORS = 20
PROBE_BARS = 200
PROBE_SEED = 7


def _declaration(strategy: sa.Strategy) -> dict:
    """The part of a ``Strategy`` that crosses the process boundary as data."""
    return {
        'id': strategy.id,
        'name': strategy.name,
        'version': strategy.version,
        'desc': strategy.desc,
        'tags': list(strategy.tags),
        'params': [d.to_dict() for d in strategy.params],
    }


def _error_dicts(exc: BaseException) -> list:
    issues = getattr(exc, 'issues', None)
    if isinstance(issues, list) and issues:
        return [i.to_dict() for i in issues[:MAX_ERRORS]]
    if isinstance(exc, UnicodeDecodeError):
        # 文件不是 UTF-8：报 encoding 规则而不是笼统的 runtime（审计 L4-09）。
        return [{'rule': 'encoding',
                 'message': 'the strategy file is not UTF-8: cannot decode byte at offset %d (%s)'
                            % (exc.start, exc.reason)}]
    return [{'rule': 'runtime', 'message': '%s: %s' % (type(exc).__name__, str(exc)[:300])}]


def _load(path: str) -> sa.Strategy:
    return sa.load_strategy_file(path)


def _run_load(job: dict) -> dict:
    strategy = _load(job['path'])
    return {'strategy': _declaration(strategy), 'errors': [], 'warnings': []}


def _run_evaluate(job: dict) -> dict:
    strategy = _load(job['path'])
    bars = job.get('bars') or PROBE_BARS
    seed = job.get('seed') or PROBE_SEED
    bars = max(20, min(5000, int(bars)))
    candles = sa.synth_candles(bars, seed=int(seed))
    params = job.get('params') or None
    issues, series = sa.validate_series(strategy.evaluate(candles, strategy.resolve(params)), len(candles))
    if issues:
        # The probe is a load-time gate, like engine-core's validation: a series
        # that does not match the contract is a broken strategy, not a hint.
        raise sa.StrategyError(issues, where='evaluate probe')
    summary = {'bars': len(candles), 'warmup': int(series.warmup) if series is not None else None}
    if series is not None:
        targets = list(series.target or [])
        summary['nonzero'] = sum(1 for t in targets if t)
        summary['firstTarget'] = _num(targets[0]) if targets else None
        summary['lastTarget'] = _num(targets[-1]) if targets else None
        summary['overlays'] = sorted(series.overlays.keys()) if series.overlays else []
        # 孤立代理在这里就会让 encode('utf-8') 抛错（审计 L4-07 的同一条路径）。先按 Node 的口径
        # 把孤立代理换成 U+FFFD（Buffer.from(s,'utf8') 的行为）再算摘要，两侧摘要因此一致。
        counts = [0]
        fingerprint_text = _replace_lone_surrogates(series.fingerprint(), counts)
        if counts[0]:
            summary['sanitizedSurrogates'] = counts[0]
        summary['seriesSha256'] = hashlib.sha256(fingerprint_text.encode('utf-8')).hexdigest()
    return {'strategy': _declaration(strategy), 'signals': summary, 'errors': [], 'warnings': []}


SIGNAL_REASON_MAX = 120


def _run_signals(job: dict) -> dict:
    strategy = _load(job['path'])
    candles = job.get('candles')
    if not isinstance(candles, list) or len(candles) < 2:
        raise sa.StrategyError([sa.Issue('job', 'signals needs at least two candles')],
                               where='signals job')
    rows = sa.normalize_candles(candles)
    params = job.get('params') or None
    # 锚点参数（网格中心价等）按区间第一根固定下来，与 backtest-jobs.ts:335-337 同序
    resolved = strategy.anchor_params(rows[:1], params)
    issues, series = sa.validate_series(strategy.evaluate(rows, resolved), len(rows))
    if issues:
        raise sa.StrategyError(issues, where='evaluate')
    target = [round(float(t), 12) for t in series.target]
    reasons = [str(r)[:SIGNAL_REASON_MAX] for r in (series.reasons or [])]
    return {'strategy': _declaration(strategy), 'errors': [], 'warnings': [],
            'series': {'target': target, 'reasons': reasons,
                       'warmup': int(series.warmup or 0),
                       'overlays': sorted(series.overlays or {})}}


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


JOBS = {'load': _run_load, 'evaluate': _run_evaluate, 'signals': _run_signals}


def run_job(job: dict) -> dict:
    """Execute one job dict and return the payload written to stdout."""
    started = time.monotonic()
    tracemalloc.start()
    name = job.get('job')
    handler = JOBS.get(name)
    if handler is None:
        payload = {'ok': False, 'errors': [{'rule': 'job', 'message': 'unknown job %r' % name}]}
    elif not isinstance(job.get('path'), str) or not job['path']:
        payload = {'ok': False, 'errors': [{'rule': 'job', 'message': 'job.path is required'}]}
    else:
        try:
            payload = handler(job)
            payload['ok'] = not payload.get('errors')
        except sa.StrategyError as exc:
            payload = {'ok': False, 'errors': _error_dicts(exc)}
        except SyntaxError as exc:
            payload = {'ok': False, 'errors': [{'rule': 'syntax',
                                                'message': 'could not compile the file: %s' % exc.msg}]}
        except MemoryError:
            payload = {'ok': False, 'errors': [{'rule': 'memory',
                                                'message': 'the strategy ran out of memory while the job ran'}]}
        except BaseException as exc:                  # noqa: BLE001 - never leak a traceback into stdout
            payload = {'ok': False, 'errors': _error_dicts(exc)}
    try:
        peak = tracemalloc.get_traced_memory()[1]
    except Exception:                                 # pragma: no cover - tracemalloc is always on here
        peak = 0
    tracemalloc.stop()
    payload['peakTracemallocBytes'] = int(peak)
    payload['elapsedMs'] = int(round((time.monotonic() - started) * 1000))
    return payload


def _replace_lone_surrogates(value: Any, counts: list) -> Any:
    """把孤立代理字符换成 U+FFFD，合法代理对原样保留；替换次数累加到 counts[0]。

    ``json.dumps(..., ensure_ascii=False)`` 会把孤立代理（如 ``'\\ud800'``）原样留在文本里，
    而 stdout 是严格 UTF-8：编码时抛 UnicodeEncodeError，报告一行都写不出去（审计 L4-07）。
    """
    if isinstance(value, str):
        out = []
        replaced = 0
        i = 0
        n = len(value)
        while i < n:
            code = ord(value[i])
            if 0xD800 <= code <= 0xDBFF:
                low = ord(value[i + 1]) if i + 1 < n else -1
                if 0xDC00 <= low <= 0xDFFF:          # 合法代理对（U+10000..U+10FFFF）
                    out.append(value[i])
                    out.append(value[i + 1])
                    i += 2
                    continue
                out.append('\ufffd')
                replaced += 1
                i += 1
                continue
            if 0xDC00 <= code <= 0xDFFF:             # 落单的低代理
                out.append('\ufffd')
                replaced += 1
                i += 1
                continue
            out.append(value[i])
            i += 1
        if not replaced:
            return value
        counts[0] += replaced
        return ''.join(out)
    if isinstance(value, dict):
        return {_replace_lone_surrogates(k, counts): _replace_lone_surrogates(v, counts)
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_replace_lone_surrogates(v, counts) for v in value]
    return value


def _write_payload(payload: dict) -> None:
    """把报告写成一行 JSON（纯 UTF-8）。孤立代理先替换成 U+FFFD 并记进 sanitizedSurrogates。"""
    counts = [0]
    clean = _replace_lone_surrogates(payload, counts)
    if counts[0]:
        clean['sanitizedSurrogates'] = counts[0]
    line = json.dumps(clean, separators=(',', ':'), ensure_ascii=False) + '\n'
    sys.stdout.buffer.write(line.encode('utf-8'))
    sys.stdout.buffer.flush()


def main() -> int:
    raw = sys.stdin.read()
    try:
        job = json.loads(raw) if raw.strip() else {}
    except ValueError:
        job = {}
    payload = run_job(job if isinstance(job, dict) else {})
    try:
        _write_payload(payload)
    except Exception as exc:                          # noqa: BLE001 - 写不出报告也要留一行 JSON
        fallback = {'ok': False, 'errors': [{'rule': 'output',
                                             'message': 'could not write the report: %s: %s'
                                                        % (type(exc).__name__, str(exc)[:200])}]}
        sys.stdout.buffer.write((json.dumps(fallback) + '\n').encode('utf-8'))
        sys.stdout.buffer.flush()
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
