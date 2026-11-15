<!-- SPDX-License-Identifier: Apache-2.0 -->
# Python reference engine (GEP protocol example)

A reference implementation of the GEP **engine** side over stdio NDJSON, Python standard
library only. It demonstrates the frame format (one JSON value per line, batches answered
as arrays), `gep.hello` version negotiation, the Problem error model (`src/model/problem.ts`),
secret-field rejection, secret redaction and graceful shutdown.

It has **no trading logic**: no strategy, backtest, replay or own-market capability is
declared, no orders are placed and no event stream is emitted. It is an example, not part
of the product, and is not shipped with any installer. License: Apache-2.0.

## Run the conformance suite

From the repository root:

```
node packages/protocol/examples/python-engine/run-conformance.mjs
```

The script sets `GEP_LAUNCH` to this folder's `engine.py` and runs the GEP conformance
suite (vitest) against it. The suite injects the token via `GITRADER_GEP_TOKEN`.
## Try it from `gitrader.json`

Point an engine entry at this file, using the absolute path of `engine.py`:

```json
{ "engines": [ { "id": "python-reference", "launch": { "command": "python",
  "args": ["<repo>/packages/protocol/examples/python-engine/engine.py"] } } ] }
```

## Conformance coverage of a non-trading engine

Running the suite against this engine gives 10 required cases passed and 16 skipped, 0 failed.
The suite skips the order-behaviour cases for an engine that never places orders
(T07–T09, T16–T24, T26) and the resume cases that need the `events.resume` or `strategy`
capability (T10–T12). A trading sidecar must declare those capabilities and will then be
measured on all 26 required cases.
