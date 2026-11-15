<!-- SPDX-License-Identifier: Apache-2.0 -->
# Go reference engine (GEP protocol example)

Reference implementation of the GEP **engine** side over stdio NDJSON: Go standard
library only, one static binary, no dependencies. It shows the frame format (one JSON
value per line, batches answered as arrays), `gep.hello` version negotiation, the Problem
error model (`packages/protocol/src/model/problem.ts`), secret-field rejection and
graceful shutdown. Behaviour is ported case for case from `../python-engine/engine.py`.

It has **no trading logic**: no strategy, backtest, replay or own-market capability is
declared, no orders are placed and no event stream is emitted. An example, not part of
the product, not shipped with any installer. License: Apache-2.0.

## Build and run

    go build -o go-engine .

The token comes from `GITRADER_GEP_TOKEN` (missing → one stderr line, exit 2). NDJSON on
stdin/stdout, one value per line, ≤ 1 MiB; `engine.shutdown` exits 0.

## Conformance suite

From the repository root: `node packages/protocol/examples/go-engine/run-conformance.mjs`
— it builds into a temp dir, sets `GEP_LAUNCH` to the binary and runs the vitest suite.
`go` must be on PATH; otherwise it prints one line and exits 3.

Required block T01–T26: 10 passed, 16 skipped, 0 failed (no order behaviour, no resume).

## `gitrader.json`: `{"engines":[{"id":"go-reference","launch":{"command":"<path to go-engine>","args":[]}}]}`
