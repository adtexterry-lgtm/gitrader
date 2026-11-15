<!-- SPDX-License-Identifier: CPAL-1.0 -->
# Kernel security boundaries

## Human and service requests

The local service credential permits read access and one authenticated risk-reducing exception: `kill`, which requests the existing org-wide cancel, HALT, and deadman path. It cannot place orders, flatten positions, resume trading, or mint startup links; adding a PIN does not grant session-only authority. `takeover.flatten_all` on an ACTIVE account requires a human session plus PIN. Internal deadman and kernel emergency-stop paths remain available and do not grant general service write access.

Authenticated HTTP operations and WebSocket queries, commands, and control frames share an in-memory operation budget per session, Agent key, or current service credential. The defaults are 200 operations with 60 tokens replenished per second; `server.operationRateLimit.capacity` and `server.operationRateLimit.refillPerSecond` can be set independently. Zero and an explicitly empty limit object are invalid. Risk-gated trading actions and the human emergency `kill` operation keep their existing safety path and do not consume this additional budget. WebSocket connections allow 64 active subscriptions by default; `server.maxWsSubscriptions` can set a limit from 1 to 1024. A connection can have one wildcard subscription, and unsubscribe or connection close releases its subscriptions.

The CLI keeps the exchanged human session in its private home cache and uses it for service-backed writes. Missing, expired, corrupt, or rejected sessions stop the write and direct the user to sign in again; the CLI never retries a write with the service credential. Offline `notify test` creates and revokes a temporary local human session for that command.

Historical paper replay is opt-in through `paperReplay.fixture` in the local configuration. It uses the local fixture and a paper account; it does not start realtime venue connectors. Complete the normal human `engines bind` flow with PIN before `paper replay start <strategy> --account <alias|id> --instrument <id> --interval <interval>`. Start and stop require the cached human session; `paper replay status` reads the current run. A run can be stopped with `paper replay stop <runId>`. Each configured home accepts one run, including a cancelled run; use a fresh isolated home for another attempt. The exported paper state and run summary carry replay provenance. Normal paper-state restore rejects a replay-tagged artifact, while the parity comparison tool may read it as historical input.

`session.link.unattended` requires a human session; a service credential cannot mint an unattended boot link. A human session may request it only when its declared host origin is configured in `embed.allowedOrigins`. The ordinary `session.link` accepts a human principal (session or the local service credential) only together with the correct PIN (ADR-5, fix-r1): the PIN is the presence proof, so reading `service.json` alone cannot mint a link.

The `s1-trust.test.ts` service-kill case is historical evidence migrated to a human session and remains valid for that contract. Current `b3-service-permissions.test.ts` separately verifies the authenticated service `kill` exception, while service flatten and resume remain denied. Do not treat the historical fixture as a claim that every service write is rejected.

## Current CLI implementation and historical fixture

In `packages/cli/src/index.ts`, ordinary `gitrader open` needs only the PIN (service credential plus PIN header; no `session login`). Unattended open omits the PIN and therefore requires a cached human session from `gitrader session login` plus a configured origin.

`packages/kernel/test/s1-trust.test.ts` is a completed historical migration fixture: its service-kill case uses a human session. Retain it as historical evidence. Current service-kill behavior is covered separately by `b3-service-permissions.test.ts`.

## Pending root script migrations

Only the root smoke journey and `scripts/verify/security*.mjs` migrations below remain pending. They were not edited, run, or validated in B3-R1. The CLI implementation and historical `s1-trust.test.ts` fixture above are not pending migrations.

| Source | Required migration |
|---|---|
| `tools/smoke/journey.mjs` step 4 | `open --print` stays PIN-only (ADR-5); add bootstrap session login before subsequent writes. |
| `scripts/verify/security.mjs` | Keep positive `session.link` on service + PIN (ADR-5). Move positive `takeover.halt_new`, resume, keystore unlock, and PIN-rate checks to a genuine human session. Service equivalents should assert `AUTH_FAILED` before PIN handling; keep service status and service kill as separate cases. |
| `scripts/verify/security-v2.mjs` | Keep the service + PIN link check positive (ADR-5). Move positive keystore unlock and `risk.relax` checks to a human session; keep their service-plus-PIN attempts forbidden. |
| `scripts/verify/security-v3.mjs` | Require a logged-in human session and configured origin for unattended-link success; keep the service-token attempt rejected. |
| Raw/API fixtures after service restart used by these root verification flows | Exchange a fresh one-time boot token for a human session in memory; never log tokens or PINs. Reauthenticate after restart instead of reusing a service credential as write authority. |

## File paths

`ledger.export` accepts a path relative to `GITRADER_HOME/exports`; an omitted path uses `ledger-<clock.now>`. Absolute paths, parent traversal, drive or stream syntax, reserved Windows names, and junction escapes are rejected. Existing linked output files are checked before any export artifact is written.

`lab.verify` accepts only an existing relative file beneath `GITRADER_HOME/lab`. The target must be a regular file no larger than 8 MiB. Directories, links, and paths outside that root produce the fixed `Invalid experiment export input` error without exposing the local path. Windows path syntax is checked on both slash styles.

`gitrader session login` creates its cache through an exclusively opened file beneath the selected home. It tightens the empty file before writing session bytes, verifies the open descriptor and confined path still identify the same single-link file, then flushes and renames it. A failed attempt removes only the staging entry it created and revokes the newly exchanged session.

## Static plugin assets

The plugin asset route serves files only from a valid block plugin, only for GET and HEAD, and rejects dot paths and unsafe relative paths. It retains `Access-Control-Allow-Origin: *` for the sandbox iframe's `Origin: null` module requests. These public static assets contain no session token or identity. This exception applies only to the plugin asset route and does not change API or WebSocket authentication.

## Security-state recovery

The unauthenticated `/api/health` route remains available when a local PIN, keystore, device-key, or install-key file is missing or corrupt. It reports `status: "degraded"`, a safe per-file state, and a fixed recovery warning without returning file contents, paths, key identity, or parser details. Authenticated status stays readable and marks PIN setup, keystore unlock, and live signing unavailable.

The kernel latches detected corruption for the lifetime of the process. Restoring the original bytes does not re-enable PIN changes or signing in that process; restore the original file and restart the kernel. A missing PIN beside an initialized keystore/device key is treated as corruption, and a missing or valid-but-replaced install key for an existing ledger identity never changes that identity. Live proposal approval checks aggregate security state before changing proposal or ledger state. Degraded startup keeps HTTP diagnostics available while skipping automatic plugin, engine, reconciliation, and live background work.
