# SPDX-License-Identifier: CPAL-1.0
"""Strategy folder: discover ``.py`` strategy files, load them under limits, describe them.

What "loading" means here
-------------------------
A Python strategy is one file that defines a module-level ``STRATEGY`` dict
(id / name / version / desc / tags / params / evaluate), the Python twin of
``export default strategy`` in ``packages/engine-core/examples/strategies/``.
Loading it means: sandbox-check the source, execute the module, validate the
declaration, and (when asked) run one ``evaluate`` hook over deterministic
candles. All three steps are user code, so all three run in the supervised child
process from ``limits.py`` - never in the engine's own process.

The folder
----------
``StrategyLibrary`` reads the directory the kernel hands every local engine
(``GITRADER_STRATEGIES_DIR``, ``packages/kernel/src/engines.ts:167-174``) or an
explicit directory passed by the caller:

* only ``*.py`` files directly inside the folder are read (no subdirectories, no
  symlink chasing);
* files whose name starts with ``_`` or ``.`` are skipped, so ``_helpers.py``
  style scratch files are not strategies;
* at most ``MAX_STRATEGY_FILES`` files are loaded per scan, the rest are reported
  as errors instead of silently disappearing;
* two files declaring the same ``id`` is an error on the second file (the order
  is the sorted file name, so the report is deterministic).

Results are cached per file on ``(mtime_ns, size)``: re-listing a folder that has
not changed costs a few ``stat`` calls and spawns nothing, which is what makes it
safe to call ``scan()`` on every ``strategy.list``.

Reporting
---------
One report per file, shaped like engine-core's ``FileReport``
(``packages/engine-core/src/strategy/loader.ts:26-34``) plus the evidence the
limits produced::

    {"file": "ema-cross.py", "status": "loaded" | "error",
     "id": "ema-cross", "version": "0.1.0",
     "errors": [{"rule": "...", "message": "..."}], "warnings": [],
     "at": 1790000000000,
     "ms": 180, "peakRssBytes": 21458944, "limit": null | "hook_timeout" | "memory"}

``limit`` says which budget fired when ``status`` is ``error``. A limit breach
is data, not an exception: the engine keeps serving.
"""

from __future__ import annotations

import os
import time

try:  # 正常路径：engine 是命名空间包
    from . import limits as limit_mod
    from . import sandbox as sandbox_mod
    from . import strategy_api as sa
except ImportError:  # pragma: no cover - 被按文件路径单独加载时（没有包上下文）
    import limits as limit_mod
    import sandbox as sandbox_mod
    import strategy_api as sa

STRATEGY_DIR_ENV = 'GITRADER_STRATEGIES_DIR'
STRATEGY_EXTENSIONS = ('.py',)
MAX_STRATEGY_FILES = 200
MAX_SOURCE_BYTES = sandbox_mod.MAX_SOURCE_BYTES      # 512 KiB, enforced by the sandbox too
STRATEGY_KIND = 'target-position'          # engine-core/src/runtime/engine.ts:490
PARAMS_SCHEMA_REF = 'strategy.params'

DEFAULT_PROBE_BARS = 200
DEFAULT_PROBE_SEED = 7

STATUS_LOADED = 'loaded'
STATUS_ERROR = 'error'

RULE_TIMEOUT = 'hook-timeout'
RULE_MEMORY = 'memory-limit'


def params_schema(defs, title='strategy params'):
    """JSON Schema (draft 2020-12 subset) for a strategy's params.

    Same shape as the built-in strategy's schema in ``gep.param_schema`` and as
    engine-core's ``instanceParamsSchema``: every declared key is required, no
    extra keys, numeric bounds carried through, ``select`` becomes ``enum``.
    """
    props = {}
    required = []
    for d in defs:
        required.append(d.key)
        if d.type == 'boolean':
            props[d.key] = {'type': 'boolean', 'default': d.default}
        elif d.type == 'select':
            props[d.key] = {'type': 'string', 'enum': list(d.options or ()), 'default': d.default}
        elif d.type == 'integer':
            entry = {'type': 'integer', 'default': d.default}
            if d.min is not None:
                entry['minimum'] = int(d.min) if float(d.min).is_integer() else d.min
            if d.max is not None:
                entry['maximum'] = int(d.max) if float(d.max).is_integer() else d.max
            props[d.key] = entry
        else:
            entry = {'type': 'number', 'default': d.default}
            if d.min is not None:
                entry['minimum'] = d.min
            if d.max is not None:
                entry['maximum'] = d.max
            props[d.key] = entry
        if d.help:
            props[d.key]['description'] = d.help
    return {'$schema': 'https://json-schema.org/draft/2020-12/schema',
            'title': title, 'type': 'object', 'properties': props,
            'required': required, 'additionalProperties': False}


def _now_ms():
    return int(time.time() * 1000)


class StrategyLibrary(object):
    """The strategy folder: files in, reports and declarations out."""

    def __init__(self, directory=None, *, limits=None, supervisor=None, env=None):
        source = os.environ if env is None else env
        self.limits = limits or limit_mod.Limits.from_env(source)
        self.directory = _resolve_directory(directory, source)
        self.supervisor = supervisor or limit_mod.Supervisor(self.limits, env=source)
        self.spawns = 0                     # children started (tests assert the cache)
        self._cache = {}                    # abs path -> (mtime_ns, size, record)
        self._by_id = {}                    # id -> record
        self._reports = []

    # -- folder ---------------------------------------------------------------
    def files(self):
        """Absolute paths of the candidate strategy files, sorted, one level deep."""
        if not self.directory or not os.path.isdir(self.directory):
            return []
        out = []
        try:
            entries = sorted(os.listdir(self.directory))
        except OSError:
            return []
        for name in entries:
            if name.startswith('_') or name.startswith('.'):
                continue
            if os.path.splitext(name)[1] not in STRATEGY_EXTENSIONS:
                continue
            path = os.path.join(self.directory, name)
            if os.path.isfile(path):
                out.append(path)
        return out

    def has_folder(self):
        return bool(self.directory) and os.path.isdir(self.directory)

    # -- loading --------------------------------------------------------------
    def scan(self, *, force=False):
        """Load every candidate file (cached) and return one report per file."""
        paths = self.files()
        reports = []
        by_id = {}
        for index, path in enumerate(paths):
            if index >= MAX_STRATEGY_FILES and not force:
                reports.append(_error_report(
                    os.path.basename(path), 'too-many-files',
                    'the folder holds more than %d strategy files; this one was not loaded'
                    % MAX_STRATEGY_FILES))
                continue
            record = self.load(path, force=force)
            if record['status'] == STATUS_LOADED:
                taken = by_id.get(record['id'])
                if taken is not None:
                    record = dict(record)
                    record['status'] = STATUS_ERROR
                    record['errors'] = [{'rule': 'duplicate-id',
                                         'message': 'id "%s" is already declared by %s'
                                                    % (record['id'], taken['file'])}]
                    record['warnings'] = []
                    record['id'] = None
                    record['version'] = None
                else:
                    by_id[record['id']] = record
            reports.append(record)
        self._reports = reports
        self._by_id = by_id
        return reports

    def load(self, path, *, force=False):
        """Load one file (no ``evaluate`` probe). Cached on ``(mtime_ns, size)``."""
        try:
            stat = os.stat(path)
        except OSError as exc:
            return _error_report(os.path.basename(path), 'read',
                                 'cannot read the file: %s' % type(exc).__name__)
        key = (getattr(stat, 'st_mtime_ns', int(stat.st_mtime * 1e9)), stat.st_size)
        cached = self._cache.get(path)
        if cached is not None and not force and cached[0] == key[0] and cached[1] == key[1]:
            record = dict(cached[2])
            record['cached'] = True
            return record
        record = self._load_uncached(path, size=stat.st_size)
        record['cached'] = False
        self._cache[path] = (key[0], key[1], dict(record))
        return record

    def _load_uncached(self, path, *, size=None):
        name = os.path.basename(path)
        if size is not None and size > MAX_SOURCE_BYTES:
            return _error_report(name, 'too-large',
                                 'the file is %d bytes, over the %d byte source limit'
                                 % (size, MAX_SOURCE_BYTES))
        self.spawns += 1
        result = self.supervisor.run({'job': 'load', 'path': path},
                                     timeout_s=self.limits.hook_timeout_s,
                                     label='loading %s' % name)
        return self._record_from(name, result)

    def probe(self, path, params=None, *, bars=None, seed=None):
        """Load and run one ``evaluate`` hook in a child. Hook budget applies."""
        name = os.path.basename(path)
        self.spawns += 1
        job = {'job': 'evaluate', 'path': path,
               'bars': int(bars or DEFAULT_PROBE_BARS), 'seed': int(seed or DEFAULT_PROBE_SEED)}
        if params:
            job['params'] = dict(params)
        result = self.supervisor.run(job, timeout_s=self.limits.hook_timeout_s,
                                     label='evaluate hook of %s' % name)
        record = self._record_from(name, result)
        record['signals'] = (result.payload or {}).get('signals') if result.ok else None
        return record

    def _record_from(self, name, result):
        base = {'file': name, 'status': STATUS_LOADED, 'id': None, 'version': None,
                'errors': [], 'warnings': [], 'at': _now_ms(), 'cached': False,
                'ms': int(round(result.elapsed_s * 1000)),
                'peakRssBytes': result.peak_rss_bytes, 'limit': result.limit,
                'strategy': None}
        if result.ok and isinstance(result.payload, dict):
            payload = result.payload
            if payload.get('ok'):
                declaration = payload.get('strategy') or {}
                base['strategy'] = declaration
                base['id'] = declaration.get('id')
                base['version'] = declaration.get('version')
                base['warnings'] = list(payload.get('warnings') or [])
                return base
            base['status'] = STATUS_ERROR
            base['errors'] = list(payload.get('errors') or [{'rule': 'load', 'message': 'load failed'}])
            return base
        base['status'] = STATUS_ERROR
        rule = {limit_mod.LIMIT_HOOK_TIMEOUT: RULE_TIMEOUT,
                limit_mod.LIMIT_MEMORY: RULE_MEMORY}.get(result.limit or '', 'sandbox')
        base['errors'] = [{'rule': rule, 'message': result.detail or 'the sandbox process failed (%s)'
                                                                % result.status}]
        return base

    # -- catalogue ------------------------------------------------------------
    def ids(self):
        self.scan()
        return sorted(self._by_id)

    def reports(self):
        """Wire-safe per-file reports (the declaration itself is not sent)."""
        self.scan()
        out = []
        for record in self._reports:
            item = {k: record[k] for k in ('file', 'status', 'errors', 'warnings', 'at', 'ms',
                                           'peakRssBytes', 'limit', 'cached')}
            if record.get('id'):
                item['id'] = record['id']
            if record.get('version'):
                item['version'] = record['version']
            out.append(item)
        return out

    def entries(self):
        """``strategy.list`` entries for the loaded files (engine-core shape)."""
        self.scan()
        out = []
        for record in sorted(self._by_id.values(), key=lambda r: str(r.get('id'))):
            declaration = record.get('strategy') or {}
            out.append({'id': declaration.get('id'), 'name': declaration.get('name'),
                        'version': declaration.get('version'), 'kind': STRATEGY_KIND,
                        'paramsSchemaRef': PARAMS_SCHEMA_REF})
        return out

    def get(self, strategy_id):
        """The cached record for ``strategy_id`` (scans if needed) or ``None``."""
        self.scan()
        record = self._by_id.get(strategy_id)
        return dict(record) if record is not None else None

    def describe(self, strategy_id):
        """Declaration + params schema + defaults. Raises ``KeyError`` if unknown."""
        record = self.get(strategy_id)
        if record is None:
            raise KeyError(strategy_id)
        declaration = record.get('strategy') or {}
        defs = [sa.ParamDef.from_dict(raw) for raw in (declaration.get('params') or [])]
        return {'id': declaration.get('id'), 'name': declaration.get('name'),
                'version': declaration.get('version'), 'desc': declaration.get('desc'),
                'tags': list(declaration.get('tags') or []), 'file': record['file'],
                'kind': STRATEGY_KIND,
                'params': [d.to_dict() for d in defs], 'paramDefs': defs,
                'schema': params_schema(defs, declaration.get('id') or 'strategy params'),
                'defaults': sa.defaults_of(defs)}

    def resolve(self, strategy_id, params=None, *, clamp=False):
        """Defaults + user params, validated against the file's own declarations."""
        described = self.describe(strategy_id)
        return sa.resolve_params(described['paramDefs'], params, clamp=clamp)

    def path_of(self, strategy_id):
        record = self.get(strategy_id)
        if record is None:
            raise KeyError(strategy_id)
        return os.path.join(self.directory or '', record['file'])


def _resolve_directory(directory, env):
    if isinstance(directory, str) and directory.strip():
        return os.path.abspath(directory.strip())
    raw = env.get(STRATEGY_DIR_ENV) if isinstance(env, dict) or hasattr(env, 'get') else None
    if isinstance(raw, str) and raw.strip():
        return os.path.abspath(raw.strip())
    return None


def _error_report(name, rule, message):
    return {'file': name, 'status': STATUS_ERROR, 'id': None, 'version': None,
            'errors': [{'rule': rule, 'message': message}], 'warnings': [],
            'at': _now_ms(), 'cached': False, 'ms': 0, 'peakRssBytes': None,
            'limit': None, 'strategy': None}
