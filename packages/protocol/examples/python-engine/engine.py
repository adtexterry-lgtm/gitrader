# SPDX-License-Identifier: Apache-2.0
"""GEP reference engine (protocol example, Python standard library only).

This is a teaching implementation of the engine side of GEP over stdio NDJSON:
framing, handshake, the error model (Problem objects), secret-field rejection
and graceful shutdown. It has no trading logic at all and places no orders.

Wire format: one UTF-8 JSON value per line, no BOM. A line is either one
JSON-RPC message or an array (batch) of messages; a batch is answered with an
array whose ids correspond one to one.
"""

import json
import os
import re
import sys
import threading
import time

TOKEN_ENV = 'GITRADER_GEP_TOKEN'
ENGINE_ID = 'python-reference'
ENGINE_NAME = 'Python reference engine (protocol example)'
ENGINE_VERSION = '0.1.0'
SUPPORTED_VERSIONS = ('0.1',)
MAX_LINE_BYTES = 1024 * 1024
HOST_CALL_TIMEOUT_S = 5.0

TOKEN = ''

# Code table, see src/model/problem.ts.
PROBLEMS = {
    'PARSE_ERROR': (-32700, 'PROTOCOL', False),
    'INVALID_REQUEST': (-32600, 'PROTOCOL', False),
    'METHOD_NOT_FOUND': (-32601, 'PROTOCOL', False),
    'INVALID_PARAMS': (-32602, 'PROTOCOL', False),
    'INTERNAL_ERROR': (-32603, 'PROTOCOL', False),
    'ACCOUNT_NOT_BOUND': (1005, 'REJECTED', False),
    'INTERNAL': (4001, 'ENGINE', False),
    'BUSY': (4004, 'ENGINE', True),
    'VERSION_UNSUPPORTED': (5001, 'PROTOCOL', False),
    'CAPABILITY_UNSUPPORTED': (5002, 'PROTOCOL', False),
    'AUTH_FAILED': (5003, 'PROTOCOL', False),
    'SESSION_GAP': (5004, 'PROTOCOL', False),
    'SECRET_FIELD_REJECTED': (5006, 'PROTOCOL', False),
    'PAYLOAD_TOO_LARGE': (5007, 'PROTOCOL', False),
}

# Optional method groups this engine does not declare.
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

CAPABILITIES = {
    'execution.modeA': True,
    'execution.modeB': False,
    'market.useHost': True,
    'market.own': False,
    'strategy': False,
    'strategy.hotUpdate': False,
    'backtest': False,
    'replay': False,
    'events.resume': False,
    'risk.cooperative': False,
    'halt.levels': ['halt_new'],
    'builder.attach': False,
    'decision.log': False,
}

SECRET_FIELD_NAMES = {'privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase'}
VERSION_PATTERN = re.compile(r'^(\d+)\.(\d+)(?:\.\d+)?$')


class RpcFault(Exception):
    """A JSON-RPC level failure carrying a Problem name."""

    def __init__(self, name, message):
        Exception.__init__(self, message)
        self.name = name
        self.message = message


class Inbox(object):
    """Minimal blocking hand-off from the stdin reader to the worker thread."""

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


class Conn(object):
    """One stdio session: writes frames and tracks in-flight host.* calls."""

    def __init__(self):
        self.authed = False
        self.halt = None
        self.session_counter = 0
        self.session_id = ''
        self.exit_requested = False
        self.exit_code = 0
        self.exit_delay = 0.0
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending = {}
        self._host_seq = 0

    def send(self, obj):
        line = json.dumps(obj, separators=(',', ':'), ensure_ascii=False)
        with self._write_lock:
            sys.stdout.buffer.write(line.encode('utf-8') + b'\n')
            sys.stdout.buffer.flush()

    def call_host(self, method, params, timeout_s=HOST_CALL_TIMEOUT_S):
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
        """Reader side: hand a host.* response to the waiting worker."""
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


# ---- Problem / envelope --------------------------------------------------------------


def now_ms():
    return int(time.time() * 1000)


def make_problem(name, message):
    code, category, retryable = PROBLEMS[name]
    return {'code': code, 'name': name, 'category': category, 'message': message, 'retryable': retryable}


def error_response(msg_id, name, message):
    problem = make_problem(name, message)
    return {'jsonrpc': '2.0', 'id': msg_id, 'error': {'code': problem['code'], 'message': message, 'data': problem}}


# ---- Secret-field rejection ----------------------------------------------------------


def find_secret_fields(value, path='$'):
    """Return key paths only; secret values are never echoed or logged."""
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


# ---- Version negotiation -------------------------------------------------------------


def major_minor(version):
    if not isinstance(version, str):
        return None
    match = VERSION_PATTERN.match(version)
    if not match:
        return None
    return '%s.%s' % (match.group(1), match.group(2))


def negotiate_version(offered):
    if not isinstance(offered, list):
        return None
    common = []
    for version in offered:
        mm = major_minor(version)
        if mm is not None and mm in SUPPORTED_VERSIONS:
            common.append(mm)
    if not common:
        return None
    common.sort(key=lambda v: tuple(int(part) for part in v.split('.')))
    return common[-1]


# ---- Params validation ---------------------------------------------------------------


def is_text(value):
    return isinstance(value, str) and len(value) > 0


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
            if not is_text(account.get('accountId')):
                issues.append('%s.accountId must be a non-empty string' % prefix)
            if account.get('mode') not in ('A', 'B'):
                issues.append('%s.mode must be A or B' % prefix)
            if not is_text(account.get('mandateId')):
                issues.append('%s.mandateId must be a non-empty string' % prefix)
            if account.get('mode') == 'B':
                signer = account.get('signer')
                if not isinstance(signer, dict) or not (is_text(signer.get('address')) or is_text(signer.get('fingerprint'))):
                    issues.append('%s.signer is required in mode B' % prefix)
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


# ---- Methods -------------------------------------------------------------------------


def describe():
    return {
        'engine': {
            'id': ENGINE_ID,
            'name': ENGINE_NAME,
            'version': ENGINE_VERSION,
            'vendor': {'id': 'gitrader', 'name': 'Gitrader', 'kind': 'community', 'verified': False},
            'license': 'Apache-2.0',
            'runtime': 'python',
        },
        'protocol': {'version': SUPPORTED_VERSIONS[0], 'transports': ['stdio']},
        'capabilities': dict(CAPABILITIES),
        'venues': [],
        'data': {'intervals': ['1m', '5m'], 'maxHistoryBars': 5000},
        'limits': {'maxConcurrentBacktests': 0, 'maxStrategyInstances': 0},
    }


def method_describe(conn, params):
    return describe()


def method_health(conn, params):
    return {'status': 'ok', 'metrics': {'instances': 0, 'bufferedEvents': 0}, 'ts': now_ms()}


def method_snapshot(conn, params):
    return {'seq': 0, 'strategies': [], 'orders': []}


def method_bind(conn, params):
    issues = binding_issues(params)
    if issues:
        raise RpcFault('INVALID_PARAMS', 'invalid binding: %s' % '; '.join(issues))
    host = conn.call_host('host.describe', {})
    if not isinstance(host, dict) or not isinstance(host.get('result'), dict):
        raise RpcFault('INTERNAL', 'host.describe did not answer')
    accounts = host['result'].get('accounts')
    known = set()
    if isinstance(accounts, list):
        for account in accounts:
            if isinstance(account, dict) and isinstance(account.get('accountId'), str):
                known.add(account['accountId'])
    for account in params['accounts']:
        if account['accountId'] not in known:
            raise RpcFault('ACCOUNT_NOT_BOUND', 'account is not known to the host')
        if account['mode'] == 'B':
            raise RpcFault('CAPABILITY_UNSUPPORTED', 'execution.modeB is not declared')
    return {'bindingId': params['bindingId'], 'effective': params, 'warnings': []}


def method_halt(conn, params):
    p = params if isinstance(params, dict) else {}
    if not is_text(p.get('takeoverId')) or p.get('level') not in ('halt_new', 'cancel_all', 'flatten_all'):
        raise RpcFault('INVALID_PARAMS', 'takeoverId and level are required')
    conn.halt = {'takeoverId': p['takeoverId'], 'level': p['level']}
    return {'ack': True, 'appliedAt': now_ms()}


def method_resume(conn, params):
    p = params if isinstance(params, dict) else {}
    if conn.halt is None or p.get('takeoverId') != conn.halt['takeoverId']:
        raise RpcFault('INVALID_PARAMS', 'unknown takeoverId')
    conn.halt = None
    return {'resumedAt': now_ms()}


def method_shutdown(conn, params):
    p = params if isinstance(params, dict) else {}
    grace = p.get('graceMs', 0)
    if not isinstance(grace, (int, float)) or isinstance(grace, bool) or grace < 0:
        grace = 0
    conn.exit_after(0, min(float(grace), 200.0) / 1000.0)
    return {'ok': True}


def method_events_subscribe(conn, params):
    return {'subscriptionId': 'sub_python_ref', 'fromSeq': 1}


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
    return {'acceptedVersions': versions}


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
}


def hello(conn, msg_id, params):
    p = params if isinstance(params, dict) else {}
    auth = p.get('auth') if isinstance(p.get('auth'), dict) else {}
    if auth.get('token') != TOKEN:
        conn.exit_after(1, 0.05)
        return error_response(msg_id, 'AUTH_FAILED', 'authentication failed')
    version = negotiate_version(p.get('versions'))
    if version is None:
        return error_response(msg_id, 'VERSION_UNSUPPORTED',
                              'no common version in %s; supported: %s'
                              % (json.dumps(p.get('versions')), SUPPORTED_VERSIONS[0]))
    if isinstance(p.get('resume'), dict):
        # No event retention is declared, so a resume can never be completed.
        return error_response(msg_id, 'SESSION_GAP', 'this engine does not retain events for resume')
    conn.authed = True
    conn.session_counter += 1
    conn.session_id = 'ses_pyref%04d' % conn.session_counter
    return {
        'jsonrpc': '2.0',
        'id': msg_id,
        'result': {
            'version': version,
            'sessionId': conn.session_id,
            'resumed': False,
            'engine': {'id': ENGINE_ID, 'version': ENGINE_VERSION},
        },
    }


def on_notification(conn, msg):
    """Host -> engine notifications are acknowledged by reading; nothing to do."""
    return None


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
            return error_response(msg_id, 'SECRET_FIELD_REJECTED', 'secret-like field rejected: %s' % ', '.join(hits))
        capability = METHOD_CAPABILITY.get(method)
        if capability is not None and CAPABILITIES.get(capability) is not True:
            return error_response(msg_id, 'CAPABILITY_UNSUPPORTED', '%s is not declared in engine.describe' % method)
        handler = METHODS.get(method)
        if handler is None:
            return error_response(msg_id, 'METHOD_NOT_FOUND', 'method not found: %s' % method)
        return {'jsonrpc': '2.0', 'id': msg_id, 'result': handler(conn, msg.get('params') or {})}
    except RpcFault as fault:
        return error_response(msg_id, fault.name, fault.message)
    except Exception:
        return error_response(msg_id, 'INTERNAL', 'internal error')


# ---- stdio plumbing ------------------------------------------------------------------


def read_loop(conn, inbox):
    stdin = sys.stdin.buffer
    while True:
        try:
            raw = stdin.readline()
        except OSError:
            break
        if not raw:
            break
        line = raw.strip()
        if not line:
            continue
        try:
            if len(line) > MAX_LINE_BYTES:
                conn.send(error_response(None, 'PAYLOAD_TOO_LARGE', 'stdio line exceeds 1 MiB'))
                continue
            try:
                text = line.decode('utf-8')
            except UnicodeDecodeError:
                conn.send(error_response(None, 'PARSE_ERROR', 'invalid UTF-8'))
                continue
            if text.startswith('\ufeff'):
                text = text[1:]
            try:
                msg = json.loads(text)
            except ValueError:
                conn.send(error_response(None, 'PARSE_ERROR', 'parse error'))
                continue
            if conn.resolve_host_response(msg):
                continue
            inbox.put(msg)
        except OSError:
            # The host went away; stop reading instead of crashing.
            break
    inbox.close()


def work_loop(conn, inbox):
    while True:
        msg = inbox.get()
        if msg is None:
            return
        try:
            if isinstance(msg, list):
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
        except Exception:
            # Never let a bug take the process down silently.
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


def main():
    global TOKEN
    TOKEN = os.environ.get(TOKEN_ENV) or ''
    if not TOKEN:
        sys.stderr.write('python-engine: %s is not set; refusing to start\n' % TOKEN_ENV)
        return 2
    conn = Conn()
    inbox = Inbox()
    worker = threading.Thread(target=work_loop, args=(conn, inbox), name='gep-worker')
    worker.daemon = True
    worker.start()
    read_loop(conn, inbox)
    worker.join(2.0)
    return 0


if __name__ == '__main__':
    sys.exit(main())
