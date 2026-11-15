# SPDX-License-Identifier: Apache-2.0
"""GSP stdio reference. Standard library only; no trading logic."""
import hmac
import json
import os
import re
import sys

VERSION = '0.1.0'
MAX_LINE = 1024 * 1024
PROBLEMS = {
    'PARSE_ERROR': -32700, 'INVALID_REQUEST': -32600,
    'METHOD_NOT_FOUND': -32601, 'INVALID_PARAMS': -32602,
    'INTERNAL_ERROR': -32603, 'VERSION_UNSUPPORTED': 5001,
    'AUTH_FAILED': 5003, 'SECRET_FIELD_REJECTED': 5006,
    'PAYLOAD_TOO_LARGE': 5007,
}
SECRET_FIELDS = {
    'privatekey', 'secret', 'apisecret', 'mnemonic',
    'seed', 'passphrase', 'pin', 'password',
}
MANIFEST = {
    'schema': 'gitrader-plugin/1', 'id': 'skill.gitrader.python-reference',
    'package': 'skill', 'kind': 'skill', 'name': 'Python GSP reference',
    'desc': 'Protocol example without trading logic', 'tags': ['utility'],
    'version': VERSION,
    'vendor': {'id': 'gitrader', 'name': 'Gitrader', 'kind': 'community', 'verified': False},
    'source': {'repo': 'local/python-plugin', 'commit': '0' * 40,
               'sha256': 'sha256:' + '0' * 64, 'fetchedAt': 1},
    'license': {'spdx': 'Apache-2.0', 'redistribute': 'bundle',
                'notice': 'Protocol reference', 'commercialUse': True},
    'runtime': {'type': 'python-sidecar', 'native': False, 'diskMB': 0},
    'entry': {'transport': 'stdio'},
    'x-launch': {'command': 'python', 'args': ['plugin.py'], 'cwd': '.', 'env': {}},
    'install': {'by': 'user-install', 'requireHashes': True},
    'permissions': [], 'privacy': {'hosted': False, 'sends': []},
    'provides': {'tools': ['echo']},
    'tools': [{'name': 'echo', 'desc': 'Return an object unchanged',
               'tags': ['utility'], 'input': {'type': 'object'},
               'output': {'type': 'object'}}],
    'fixtures': {'offline': [], 'smoke': []},
    'compat': {'gitrader': '*', 'pluginSchema': '1'},
}


def secret_fields(value):
    if isinstance(value, list):
        return any(secret_fields(item) for item in value)
    if isinstance(value, dict):
        return any(re.sub(r'[_-]', '', key.lower()) in SECRET_FIELDS
                   or secret_fields(item) for key, item in value.items())
    return False


def fault(msg_id, name):
    # Never include request values or exception text in errors or stderr.
    code = PROBLEMS[name]
    data = {'code': code, 'name': name, 'category': 'PROTOCOL',
            'message': 'request rejected', 'retryable': False}
    return {'jsonrpc': '2.0', 'id': msg_id,
            'error': {'code': code, 'message': data['message'], 'data': data}}


class Plugin:
    def __init__(self, token):
        self.token = token
        self.authed = False
        self.exit_code = None

    def dispatch(self, msg):
        if not isinstance(msg, dict):
            return fault(None, 'INVALID_REQUEST')
        msg_id = msg.get('id')
        if msg.get('jsonrpc') != '2.0' or not isinstance(msg.get('method'), str):
            return fault(msg_id, 'INVALID_REQUEST')
        if 'id' not in msg:
            return None
        params = msg.get('params', {})
        if not isinstance(params, dict):
            return fault(msg_id, 'INVALID_PARAMS')
        method = msg['method']
        if method == 'plugin.hello':
            offered = params.get('token')
            if not isinstance(offered, str) or not hmac.compare_digest(
                    offered.encode('utf-8'), self.token.encode('utf-8')):
                self.exit_code = 1
                return fault(msg_id, 'AUTH_FAILED')
            version = params.get('gsp')
            if not isinstance(version, str) or not re.fullmatch(r'0\.1\.\d+', version):
                return fault(msg_id, 'VERSION_UNSUPPORTED')
            self.authed = True
            result = {'gsp': VERSION}
        else:
            if not self.authed:
                return fault(msg_id, 'AUTH_FAILED')
            if secret_fields(params):
                return fault(msg_id, 'SECRET_FIELD_REJECTED')
            if method == 'plugin.describe':
                result = MANIFEST
            elif method == 'plugin.health':
                result = {'ok': True}
            elif method == 'plugin.shutdown':
                self.exit_code = 0
                result = {'ok': True}
            elif method == 'tool.call':
                if params.get('tool') != 'echo':
                    return fault(msg_id, 'METHOD_NOT_FOUND')
                if not isinstance(params.get('args'), dict):
                    return fault(msg_id, 'INVALID_PARAMS')
                result = params['args']
            else:
                return fault(msg_id, 'METHOD_NOT_FOUND')
        return {'jsonrpc': '2.0', 'id': msg_id, 'result': result}

    def frame(self, msg):
        if not isinstance(msg, list):
            return self.dispatch(msg)
        if not msg:
            return fault(None, 'INVALID_REQUEST')
        responses = []
        for item in msg:
            response = self.dispatch(item)
            if response is not None:
                responses.append(response)
            if self.exit_code is not None:
                break
        return responses or None


def send(response):
    if response is not None:
        sys.stdout.buffer.write((json.dumps(response, ensure_ascii=False) + '\n').encode('utf-8'))
        sys.stdout.buffer.flush()


def main():
    token = os.environ.get('GITRADER_GSP_TOKEN', '')
    if not token:
        sys.stderr.write('GSP channel token is required\n')
        return 2
    plugin = Plugin(token)
    while plugin.exit_code is None:
        raw = sys.stdin.buffer.readline(MAX_LINE + 2)
        if not raw:
            break
        if len(raw.rstrip(b'\r\n')) > MAX_LINE:
            send(fault(None, 'PAYLOAD_TOO_LARGE'))
            return 1
        if not raw.strip():
            continue
        try:
            msg = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError, RecursionError):
            send(fault(None, 'PARSE_ERROR'))
            continue
        try:
            send(plugin.frame(msg))
        except (TypeError, ValueError, RecursionError):
            send(fault(None, 'INTERNAL_ERROR'))
    return plugin.exit_code or 0


if __name__ == '__main__':
    sys.exit(main())
