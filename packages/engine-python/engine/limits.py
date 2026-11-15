# SPDX-License-Identifier: CPAL-1.0
"""Limits around user strategy code: wall-clock budgets and a memory ceiling.

Why this module exists
----------------------
A strategy is Python written by a user. One ``while True`` or one
``bytearray(512 * 1024 * 1024)`` running inside the engine process takes the
whole engine down with it (``reports/hermes/REVIEW-4P1-OPUS.md`` S-B). This
module turns "run user code" into a *supervised child process call*:

* **every hook call** (loading one strategy file, running one ``evaluate``)
  has a wall-clock budget, default ``2 s`` (``Limits.hook_timeout_s``);
* **a whole backtest** has a wall-clock budget, default ``900 s``
  (``Limits.backtest_timeout_s``; the backtest loop exits cooperatively);
* **a memory ceiling**, default ``256 MiB``: the parent samples the RSS of the
  child *process tree* every ``poll_interval_s`` and kills it the moment it goes
  over. The child also reports its ``tracemalloc`` peak, so the two numbers are
  compared and the larger one wins.

Trade-off on Windows (written down because it is a real limitation)
-------------------------------------------------------------------
``resource.setrlimit`` does not exist on Windows, so this module does not use
it. Instead: child process + parent sampling.

* RSS on Windows comes from ``GetProcessMemoryInfo`` through ``ctypes``
  (standard library only, no psutil); on POSIX it is read from
  ``/proc/<pid>/statm``. It is summed over the whole process tree, because the
  ``python.exe`` of a virtualenv / uv install is often a launcher that re-executes
  the interpreter: the pid ``Popen`` returns is then a small shim and the process
  doing the work is its child (measured on this repo's own dev machine).
* Sampling is *observation*, not enforcement: a short-lived allocation that
  is freed between two samples can be missed, and the ``tracemalloc`` peak is
  a post-hoc reading that cannot prevent an allocation either. So the memory
  ceiling is a guardrail that kills what it can see, not an OS quota; a hard
  bound needs the operating system (a Windows Job object or a cgroup), which
  is outside this package.
* The ceiling counts the whole child process (interpreter included, roughly
  15-25 MiB before any user code runs), not just strategy allocations.

A breach is not an exception that reaches the engine: the child is killed and
the call returns a ``Problem``. The engine process itself stays up.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Mapping

# ---- Defaults (overridable through the environment, see Limits.from_env) ---------------

DEFAULT_HOOK_TIMEOUT_S = 2.0
DEFAULT_BACKTEST_TIMEOUT_S = 900.0
DEFAULT_MEMORY_LIMIT_MB = 256
DEFAULT_POLL_INTERVAL_S = 0.02

ENV_HOOK_TIMEOUT = 'GITRADER_ENGINE_HOOK_TIMEOUT_S'
ENV_BACKTEST_TIMEOUT = 'GITRADER_ENGINE_BACKTEST_TIMEOUT_S'
ENV_MEMORY_MB = 'GITRADER_ENGINE_MEMORY_MB'
ENV_POLL_INTERVAL = 'GITRADER_ENGINE_POLL_INTERVAL_S'

# Bounds on the accepted configuration: a "0 s hook timeout" would reject every
# honest strategy, and a 1 TiB ceiling is not a limit at all.
HOOK_TIMEOUT_RANGE = (0.05, 600.0)
BACKTEST_TIMEOUT_RANGE = (0.1, 86_400.0)
MEMORY_MB_RANGE = (16, 65_536)
POLL_INTERVAL_RANGE = (0.005, 5.0)

# A job payload larger than this is refused instead of written to a pipe the
# child may never read (candles for a probe are ~200 bars, so this is generous).
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
# Anything the child writes above this is treated as "bad output": a child that
# floods stdout is not answering a job, it is misbehaving.
MAX_OUTPUT_BYTES = 1 * 1024 * 1024
MAX_DETAIL_CHARS = 400

# Names never handed to a child process: the strategy sandbox forbids `os` /
# `sys`, but defence in depth costs nothing here.
SECRET_ENV_MARKERS = ('TOKEN', 'SECRET', 'PASS', 'KEY', 'CREDENTIAL')
ENV_ALLOWLIST = ('PATH', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT',
                 'COMSPEC', 'HOME', 'LANG', 'LC_ALL')

CHILD_SCRIPT = os.path.join('engine', 'strategy_child.py')

LIMIT_HOOK_TIMEOUT = 'hook_timeout'
LIMIT_MEMORY = 'memory'

# ---- Configuration --------------------------------------------------------------------


@dataclass(frozen=True)
class Limits:
    """The three budgets plus the sampling interval. Frozen: pass a copy to change it."""

    hook_timeout_s: float = DEFAULT_HOOK_TIMEOUT_S
    backtest_timeout_s: float = DEFAULT_BACKTEST_TIMEOUT_S
    memory_limit_bytes: int = DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024
    poll_interval_s: float = DEFAULT_POLL_INTERVAL_S

    # -- derived views (wire-ready: milliseconds / mebibytes) -----------------
    @property
    def hook_timeout_ms(self) -> int:
        return int(round(self.hook_timeout_s * 1000))

    @property
    def backtest_timeout_ms(self) -> int:
        return int(round(self.backtest_timeout_s * 1000))

    @property
    def memory_limit_mb(self) -> float:
        return round(self.memory_limit_bytes / (1024.0 * 1024.0), 3)

    def to_dict(self) -> dict:
        """What the engine reports about its own limits (``engine.describe`` / reports)."""
        return {'hookTimeoutMs': self.hook_timeout_ms,
                'backtestTimeoutMs': self.backtest_timeout_ms,
                'memoryLimitMb': self.memory_limit_mb,
                'pollIntervalMs': int(round(self.poll_interval_s * 1000))}

    def with_hook_timeout(self, seconds: float) -> 'Limits':
        return replace(self, hook_timeout_s=_clamp(seconds, *HOOK_TIMEOUT_RANGE))

    # -- construction ---------------------------------------------------------
    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any] | None, base: 'Limits | None' = None) -> 'Limits':
        """Build from a config mapping (``hookTimeoutMs`` / ``memoryLimitMb`` ...)."""
        out = base or cls()
        if not isinstance(raw, Mapping):
            return out
        hook = _first(raw, 'hookTimeoutMs', 'hookTimeoutSeconds')
        if hook is not None:
            seconds = hook / 1000.0 if _looks_ms(raw, 'hookTimeoutMs') else float(hook)
            out = replace(out, hook_timeout_s=_clamp(seconds, *HOOK_TIMEOUT_RANGE))
        backtest = _first(raw, 'backtestTimeoutMs', 'backtestTimeoutSeconds')
        if backtest is not None:
            seconds = backtest / 1000.0 if _looks_ms(raw, 'backtestTimeoutMs') else float(backtest)
            out = replace(out, backtest_timeout_s=_clamp(seconds, *BACKTEST_TIMEOUT_RANGE))
        memory = _first(raw, 'memoryLimitMb')
        if memory is not None:
            out = replace(out, memory_limit_bytes=int(_clamp(float(memory), *MEMORY_MB_RANGE) * 1024 * 1024))
        poll = _first(raw, 'pollIntervalMs')
        if poll is not None:
            out = replace(out, poll_interval_s=_clamp(float(poll) / 1000.0, *POLL_INTERVAL_RANGE))
        return out

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> 'Limits':
        """Read the four environment overrides; an unreadable value keeps the default.

        Invalid input is ignored rather than fatal: a typo in an optional env var
        must not stop the engine from starting, and silently clamping would hide
        the typo anyway.
        """
        source = os.environ if env is None else env
        out = cls()
        hook = _read_float(source, ENV_HOOK_TIMEOUT, HOOK_TIMEOUT_RANGE)
        if hook is not None:
            out = replace(out, hook_timeout_s=hook)
        backtest = _read_float(source, ENV_BACKTEST_TIMEOUT, BACKTEST_TIMEOUT_RANGE)
        if backtest is not None:
            out = replace(out, backtest_timeout_s=backtest)
        memory = _read_float(source, ENV_MEMORY_MB, MEMORY_MB_RANGE)
        if memory is not None:
            out = replace(out, memory_limit_bytes=int(memory * 1024 * 1024))
        poll = _read_float(source, ENV_POLL_INTERVAL, POLL_INTERVAL_RANGE)
        if poll is not None:
            out = replace(out, poll_interval_s=poll)
        return out


def _clamp(value: float, low: float, high: float) -> float:
    if value != value:                    # NaN
        return low
    return max(low, min(high, float(value)))


def _read_float(env: Mapping[str, str], key: str, bounds: tuple[float, float]) -> float | None:
    raw = env.get(key)
    if raw is None or str(raw).strip() == '':
        return None
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if value != value or value < bounds[0] or value > bounds[1]:
        return None
    return value


def _first(raw: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = raw.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def _looks_ms(raw: Mapping[str, Any], key: str) -> bool:
    return key in raw


# ---- Memory sampling -------------------------------------------------------------------


def process_rss_bytes(pid: int) -> int | None:
    """Resident set size of ``pid`` in bytes, or ``None`` when it cannot be read.

    Windows: ``psapi.GetProcessMemoryInfo`` (``WorkingSetSize``), standard library only.
    POSIX: ``/proc/<pid>/statm``. A dead or foreign pid returns ``None``; this
    function never raises - a sampling miss must not become an engine error.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    if os.name == 'nt':
        return _windows_rss_bytes(pid)
    return _proc_rss_bytes(pid)


_WIN_API = {}


def _windows_api():
    """Bind the three Windows calls once, with real 64-bit prototypes.

    Without ``argtypes`` / ``restype`` the handle comes back as a C ``int`` and is
    truncated on 64-bit Windows: the query then "succeeds" against a bogus handle
    and reports a few megabytes for every process. That is not a theoretical
    concern - it is what the first version of this function did.
    """
    if _WIN_API:
        return _WIN_API
    import ctypes
    from ctypes import wintypes

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD),
                    ('PageFaultCount', wintypes.DWORD),
                    ('PeakWorkingSetSize', ctypes.c_size_t),
                    ('WorkingSetSize', ctypes.c_size_t),
                    ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t),
                    ('PeakPagefileUsage', ctypes.c_size_t)]

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    # K32GetProcessMemoryInfo lives in kernel32 on Windows 7+; psapi.dll only forwards.
    query = getattr(kernel32, 'K32GetProcessMemoryInfo', None)
    if query is None:                                  # pragma: no cover - pre-Windows 7
        query = ctypes.WinDLL('psapi', use_last_error=True).GetProcessMemoryInfo
    query.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD]
    query.restype = wintypes.BOOL
    _WIN_API.update({'ctypes': ctypes, 'kernel32': kernel32, 'query': query,
                     'counters': PROCESS_MEMORY_COUNTERS,
                     'access': 0x0400 | 0x0010})        # PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
    return _WIN_API


def _windows_rss_bytes(pid: int) -> int | None:
    try:
        api = _windows_api()
    except Exception:                                  # pragma: no cover - never on a normal host
        return None
    ctypes = api['ctypes']
    kernel32 = api['kernel32']
    try:
        handle = kernel32.OpenProcess(api['access'], False, pid)
        if not handle:
            return None
        try:
            counters = api['counters']()
            counters.cb = ctypes.sizeof(api['counters'])
            if not api['query'](handle, ctypes.byref(counters), counters.cb):
                return None
            return int(counters.WorkingSetSize)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return None


_WIN_TIMES = {}


def _windows_times_api():
    """Bind ``OpenProcess`` / ``GetProcessTimes`` once, with 64-bit prototypes.

    Same reason as :func:`_windows_api`: a handle returned as a C ``int`` is
    truncated on 64-bit Windows and every query then fails against a bogus one.
    """
    if _WIN_TIMES:
        return _WIN_TIMES
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE,
                                         ctypes.POINTER(wintypes.FILETIME),
                                         ctypes.POINTER(wintypes.FILETIME),
                                         ctypes.POINTER(wintypes.FILETIME),
                                         ctypes.POINTER(wintypes.FILETIME)]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    _WIN_TIMES.update({'ctypes': ctypes, 'kernel32': kernel32,
                       'filetime': wintypes.FILETIME,
                       'access': 0x1000})       # PROCESS_QUERY_LIMITED_INFORMATION
    return _WIN_TIMES


def _windows_creation_time(pid: int) -> int | None:
    """Creation time of ``pid`` as a 64-bit ``FILETIME`` integer; ``None`` on any failure.

    Used to verify a parent/child link from the process table: Windows recycles
    pids, and a live orphan keeps the old pid in ``th32ParentProcessID``.
    """
    try:
        api = _windows_times_api()
    except Exception:                                  # pragma: no cover - never on a normal host
        return None
    ctypes = api['ctypes']
    kernel32 = api['kernel32']
    try:
        handle = kernel32.OpenProcess(api['access'], False, int(pid))
        if not handle:
            return None
        try:
            created = api['filetime']()
            exited = api['filetime']()
            kernel = api['filetime']()
            user = api['filetime']()
            if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                            ctypes.byref(kernel), ctypes.byref(user)):
                return None
            return (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return None


# Replaceable name: tests swap this to exercise the pid-reuse path on any host.
_creation_time = _windows_creation_time if os.name == 'nt' else (lambda pid: None)


def process_tree(pid: int) -> list[int]:
    """``pid`` plus every verified descendant, best effort. Empty when the pid is gone.

    Needed because ``python.exe`` from a virtualenv / uv install is often a
    launcher that re-executes the real interpreter: the pid handed back by
    ``Popen`` is then a ~6 MiB shim and the process doing the work is its child.
    Measuring only the pid would make every memory ceiling pass.

    On Windows a process table entry is not proof of kinship: pids are recycled
    and an orphan keeps a dead parent's pid, so a child is accepted only when
    both creation times are readable and the child is not older than its parent.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return []
    if pid <= 0:
        return []
    children, live = _process_table()
    if pid not in live:
        return []
    out = [pid]
    queue = [pid]
    seen = {pid}
    check_times = os.name == 'nt'
    while queue:
        parent = queue.pop()
        parent_created = _creation_time(parent) if check_times else None
        for child in children.get(parent, ()):
            if child in seen:
                continue
            if check_times:
                child_created = _creation_time(child)
                if parent_created is None or child_created is None:
                    continue
                if child_created < parent_created:
                    continue
            seen.add(child)
            out.append(child)
            queue.append(child)
    return out


def process_tree_rss_bytes(pid: int) -> int | None:
    """Sum of the RSS of ``pid`` and its descendants; ``None`` if nothing readable."""
    tree = process_tree(pid)
    if not tree:
        return None
    total = 0
    seen = False
    for member in tree:
        value = process_rss_bytes(member)
        if value is not None:
            total += int(value)
            seen = True
    return total if seen else None


def _process_table() -> tuple:
    """``({parent_pid: [child_pids]}, {every_pid})``; empty when it cannot be read."""
    if os.name == 'nt':
        return _windows_process_table()
    return _posix_process_table()


def _windows_process_table() -> tuple:
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:                                  # pragma: no cover
        return {}, set()
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [('dwSize', wintypes.DWORD),
                        ('cntUsage', wintypes.DWORD),
                        ('th32ProcessID', wintypes.DWORD),
                        ('th32DefaultHeapID', ctypes.c_void_p),
                        ('th32ModuleID', wintypes.DWORD),
                        ('cntThreads', wintypes.DWORD),
                        ('th32ParentProcessID', wintypes.DWORD),
                        ('pcPriClassBase', ctypes.c_long),
                        ('dwFlags', wintypes.DWORD),
                        ('szExeFile', wintypes.WCHAR * 260)]

        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        kernel32.Process32FirstW.restype = wintypes.BOOL
        kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        kernel32.Process32NextW.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

        TH32CS_SNAPPROCESS = 0x00000002
        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        invalid = ctypes.c_void_p(-1).value
        if not snapshot or int(snapshot) == int(invalid or 0):
            return {}, set()
        children = {}
        live = set()
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
            while more:
                parent = int(entry.th32ParentProcessID)
                pid = int(entry.th32ProcessID)
                live.add(pid)
                children.setdefault(parent, []).append(pid)
                more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel32.CloseHandle(snapshot)
        return children, live
    except Exception:
        return {}, set()


def _posix_process_table() -> tuple:
    out = {}
    live = set()
    base = '/proc'
    try:
        names = os.listdir(base)
    except OSError:
        return out, live
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open(os.path.join(base, name, 'stat'), 'r', encoding='utf-8', errors='replace') as handle:
                fields = handle.read().rsplit(')', 1)[1].split()
        except (OSError, IndexError):
            continue
        if len(fields) < 2:
            continue
        try:
            parent = int(fields[1])
        except ValueError:
            continue
        live.add(int(name))
        out.setdefault(parent, []).append(int(name))
    return out, live


def kill_tree(pid: int) -> None:                    # pragma: no cover - exercised on a real breach
    """Kill ``pid`` and its verified descendants, children first and the root last.

    Only members of :func:`process_tree` are killed, on every platform: on
    Windows ``os.kill(pid, 9)`` is ``TerminateProcess``, so there is no
    ``taskkill /T`` (which would trust a recycled parent pid) and no shell.
    """
    tree = process_tree(pid)
    for member in reversed(tree):
        try:
            os.kill(member, 9)
        except Exception:
            continue


def _proc_rss_bytes(pid: int) -> int | None:
    try:
        with open('/proc/%d/statm' % pid, 'r', encoding='ascii') as handle:
            fields = handle.read().split()
        pages = int(fields[1])
        return pages * os.sysconf('SC_PAGE_SIZE')
    except Exception:
        return None


# ---- Child process supervision ---------------------------------------------------------


@dataclass
class ChildResult:
    """Outcome of one supervised child call.

    ``status`` is one of ``ok`` / ``timeout`` / ``memory`` / ``crash`` /
    ``bad-output`` / ``unavailable``. A non-``ok`` status always carries the
    limit that fired (``limit``) and a short ``detail`` for the Problem message.
    """

    status: str
    payload: dict | None = None
    detail: str = ''
    elapsed_s: float = 0.0
    peak_rss_bytes: int | None = None
    exit_code: int | None = None
    limit: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == 'ok'

    def to_dict(self) -> dict:
        out = {'status': self.status, 'detail': self.detail,
               'elapsedMs': int(round(self.elapsed_s * 1000))}
        if self.peak_rss_bytes is not None:
            out['peakRssBytes'] = int(self.peak_rss_bytes)
        if self.limit is not None:
            out['limit'] = self.limit
        return out


def child_env(base: Mapping[str, str] | None = None) -> dict:
    """A minimal environment for the child: no token, no secret-looking variable.

    ``GITRADER_*`` variables are deliberately not forwarded: the child loads and
    evaluates user code, and user code has no business reading the GEP token or
    the engine's own configuration.
    """
    source = os.environ if base is None else base
    out = {}
    for key, value in source.items():
        upper = str(key).upper()
        if 'GITRADER' in upper:
            continue
        if any(marker in upper for marker in SECRET_ENV_MARKERS):
            continue
        if upper in ENV_ALLOWLIST:
            out[key] = value
    if os.name == 'nt':
        has_drive = any(str(key).lower() == 'systemdrive' for key in out)
        if not has_drive:
            root = next((value for key, value in out.items()
                         if str(key).lower() == 'systemroot'), None)
            if root:
                drive = os.path.splitdrive(str(root))[0]
                if drive:
                    out['SystemDrive'] = drive
    out['PYTHONDONTWRITEBYTECODE'] = '1'
    out['PYTHONIOENCODING'] = 'utf-8'
    return out


def _default_spawn(argv, cwd, env):
    return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=cwd, env=env)


class Supervisor(object):
    """Runs one child job with a wall-clock budget and a memory ceiling.

    ``spawn`` / ``rss`` / ``clock`` / ``sleep`` are injectable so the tests can
    drive time and memory deterministically without spawning anything.
    """

    def __init__(self, limits: Limits | None = None, *, python: str | None = None,
                 package_root: str | None = None, spawn=None, rss=None,
                 clock=None, sleep=None, env=None):
        self.limits = limits or Limits.from_env()
        self.python = python or sys.executable
        self.package_root = package_root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self._spawn = spawn or _default_spawn
        self._rss = rss or process_tree_rss_bytes
        self._clock = clock or time.monotonic
        self._sleep = sleep or time.sleep
        self._env = env

    def script_path(self) -> str:
        return os.path.join(self.package_root, CHILD_SCRIPT)

    def argv(self) -> list:
        return [self.python, '-B', self.script_path()]

    def run(self, job: Mapping[str, Any], *, timeout_s: float | None = None,
            label: str = 'job') -> ChildResult:
        """Run ``job`` in a child; kill it on a breach and report which one fired."""
        budget = float(self.limits.hook_timeout_s if timeout_s is None else timeout_s)
        try:
            payload = json.dumps(dict(job), separators=(',', ':')).encode('utf-8')
        except (TypeError, ValueError) as exc:
            return ChildResult('bad-output', detail='job payload is not JSON: %s' % type(exc).__name__)
        if len(payload) > MAX_PAYLOAD_BYTES:
            return ChildResult('bad-output',
                               detail='job payload is %d bytes, over the %d byte pipe limit'
                                      % (len(payload), MAX_PAYLOAD_BYTES))
        started = self._clock()
        try:
            proc = self._spawn(self.argv(), self.package_root, child_env(self._env))
        except OSError as exc:
            return ChildResult('unavailable',
                               detail='could not start the strategy sandbox process: %s'
                                      % type(exc).__name__)
        collector = _OutputCollector(getattr(proc, 'stdout', None))
        err_collector = _OutputCollector(getattr(proc, 'stderr', None))
        peak = 0
        status = 'exit'
        try:
            try:
                if getattr(proc, 'stdin', None) is not None:
                    proc.stdin.write(payload)
                    proc.stdin.flush()
                    proc.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                pass                            # the child died early; poll() reports it
            while True:
                rss = self._rss(getattr(proc, 'pid', 0))
                if rss:
                    peak = max(peak, int(rss))
                ceiling = self.limits.memory_limit_bytes
                if ceiling and rss is not None and int(rss) > ceiling:
                    status = 'memory'
                    break
                if proc.poll() is not None:
                    status = 'exit'
                    break
                if self._clock() - started > budget:
                    status = 'timeout'
                    break
                self._sleep(self.limits.poll_interval_s)
        finally:
            killed = status in ('timeout', 'memory')
            if killed:
                _terminate(proc)
            else:
                try:
                    proc.wait(timeout=max(1.0, budget))
                except Exception:
                    pass
        elapsed = max(0.0, self._clock() - started)
        code = getattr(proc, 'returncode', None)
        _close(proc)
        if status == 'memory':
            return ChildResult('memory', detail='%s exceeded the memory ceiling of %s MiB (peak sampled %s MiB)'
                                                 % (label, _fmt_mb(self.limits.memory_limit_bytes),
                                                    _fmt_mb(peak)), elapsed_s=elapsed,
                               peak_rss_bytes=peak, exit_code=code, limit=LIMIT_MEMORY)
        if status == 'timeout':
            return ChildResult('timeout', detail='%s exceeded the %d ms hook budget'
                                                 % (label, int(round(budget * 1000))),
                               elapsed_s=elapsed, peak_rss_bytes=peak, exit_code=code,
                               limit=LIMIT_HOOK_TIMEOUT)
        text = collector.text()
        if len(text) > MAX_OUTPUT_BYTES:
            return ChildResult('bad-output', detail='%s wrote more than %d bytes to stdout'
                                                    % (label, MAX_OUTPUT_BYTES),
                               elapsed_s=elapsed, peak_rss_bytes=peak, exit_code=code)
        parsed = _last_json_line(text)
        if parsed is None:
            stderr = _tail(err_collector.text())
            said_something = bool((text or '').strip())
            return ChildResult('bad-output' if said_something else 'crash',
                               detail='%s produced %s%s'
                                      % (label, 'output that is not JSON' if said_something
                                         else 'no JSON result',
                                         (': ' + stderr) if stderr else ''),
                               elapsed_s=elapsed, peak_rss_bytes=peak, exit_code=code)
        child_peak = parsed.get('peakTracemallocBytes')
        if isinstance(child_peak, int) and child_peak > peak:
            peak = child_peak
            ceiling = self.limits.memory_limit_bytes
            if ceiling and child_peak > ceiling:
                return ChildResult('memory', payload=parsed,
                                   detail='%s peaked at %s MiB of Python heap, over the ceiling of %s MiB'
                                          % (label, _fmt_mb(child_peak), _fmt_mb(ceiling)),
                                   elapsed_s=elapsed, peak_rss_bytes=peak, exit_code=code,
                                   limit=LIMIT_MEMORY)
        return ChildResult('ok', payload=parsed, elapsed_s=elapsed, peak_rss_bytes=peak,
                           exit_code=code)


class _OutputCollector(object):
    """Drain the child's stdout on a thread so a chatty child cannot fill the pipe."""

    def __init__(self, stream):
        self._chunks = []
        self._lock = threading.Lock()
        self._thread = None
        if stream is None:
            return
        self._thread = threading.Thread(target=self._pump, args=(stream,), name='strategy-child-stdout')
        self._thread.daemon = True
        self._thread.start()

    def _pump(self, stream):
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                with self._lock:
                    self._chunks.append(chunk)
                    size = sum(len(c) for c in self._chunks)
                if size > MAX_OUTPUT_BYTES * 2:
                    return
        except (OSError, ValueError):
            return

    def text(self) -> str:
        if self._thread is not None:
            self._thread.join(2.0)
        with self._lock:
            data = b''.join(self._chunks)
        return data.decode('utf-8', 'replace')


def _terminate(proc):
    """Kill the child *and its descendants*: the pid we hold may be a launcher shim."""
    pid = getattr(proc, 'pid', None)
    if isinstance(proc, subprocess.Popen) and pid:
        kill_tree(int(pid))
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=2.0)
    except Exception:
        pass


def _close(proc):
    for name in ('stdin', 'stdout', 'stderr'):
        stream = getattr(proc, name, None)
        try:
            if stream is not None:
                stream.close()
        except Exception:
            pass


def _last_json_line(text: str) -> dict | None:
    for line in reversed([l for l in (text or '').splitlines() if l.strip()]):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _tail(text) -> str:
    lines = [l.strip() for l in (text or '').splitlines() if l.strip()]
    return lines[-1][:MAX_DETAIL_CHARS] if lines else ''


def _fmt_mb(value) -> str:
    try:
        return '%.0f' % (float(value) / (1024.0 * 1024.0))
    except (TypeError, ValueError):
        return '?'
