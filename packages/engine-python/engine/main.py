# SPDX-License-Identifier: CPAL-1.0
"""Entry point of the Python strategy engine (GEP over stdio/NDJSON).

Run it as ``python engine/main.py`` from this package directory; the kernel
launches it through ``gitrader.json`` -> ``engines[].launch`` (see launch.json).
The one-time channel token arrives in ``GITRADER_GEP_TOKEN``; without it the
process refuses to start (exit code 2) instead of running unauthenticated.

Exit codes: 0 normal shutdown (engine.shutdown or EOF), 1 authentication
failed, 2 no token. Python >= 3.11, standard library only.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PACKAGE_ROOT = os.path.dirname(_HERE)
if _PACKAGE_ROOT not in sys.path:                 # works for both
    sys.path.insert(0, _PACKAGE_ROOT)             # `python engine/main.py` and `-m engine.main`

from engine import gep  # noqa: E402  (path set up above)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if '--version' in args or '-V' in args:
        sys.stdout.write('%s %s (GEP %s)\n' % (gep.ENGINE_ID, gep.ENGINE_VERSION,
                                               gep.SUPPORTED_VERSIONS[0]))
        return 0
    if '--help' in args or '-h' in args:
        sys.stdout.write('usage: python engine/main.py [--gep stdio]\n'
                         'Speaks GEP JSON-RPC 2.0, one JSON value per line, on stdin/stdout.\n'
                         'The token comes from the %s environment variable.\n' % gep.TOKEN_ENV)
        return 0
    return gep.serve(os.environ.get(gep.TOKEN_ENV) or '')


if __name__ == '__main__':
    sys.exit(main())
