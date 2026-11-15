<!-- SPDX-License-Identifier: Apache-2.0 -->
# Risk gate conformance cases

This directory contains 21 standalone JSON cases. Each file repeats its complete resolved `GateInput`; cases do not depend on shared templates. The `expect` object contains `decision`, `verdict`, `codes`, `applied`, and `allowedActions`.

Load and validate the checked-in cases with:

```ts
import { loadGateConformanceCases } from '@gitrader/protocol/conformance/risk-gate/load.ts'

const cases = loadGateConformanceCases()
```

The optional directory argument supports isolated fixture-loader checks. The loader sorts JSON basenames, validates each complete case, and reports malformed or invalid files without echoing their contents or absolute paths.

These cases state expected inputs and outputs for a future `decide()` implementation. They validate protocol structure and fixed expectations only; they do not claim runtime execution, performance, or venue behavior. `decide()` implementation and comparison belong to K1.

All identifiers and market values are synthetic. Most cases use a paper account; cases 18 and 19 are a live-mode origin comparison. Amounts and quantities use decimal strings, timestamps and counts use JSON integers. Every case has a distinct `name` and `precheckId`; only order or cancel targets that use `clientOrderId` include it, and all such values are unique.

## Expected action tables

`allowedActions` is derived only from states, `killSwitch`, mandate level, and `actorClass`; stale data, numeric limit hits, and a missing protector result do not independently change this capability table. `amend` always follows `reduce`.

| Table | `open` | `reduce` | `cancel` | `cancel_protective` | `amend` | `leverage` | `deadman_arm` | `deadman_disarm` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A: healthy agent | true | true | true | false | true | true | true | false |
| H: healthy human or system | true | true | true | true | true | true | true | true |
| R: kill switch or reducing state cases | false | true | true | false | true | false | true | false |

Case 04 is a separate HALTED human case: `open=false`, while `reduce`, `cancel`, `cancel_protective`, `amend`, `deadman_arm`, and `deadman_disarm` are true. Its leverage value is false: HALTED, KILL, and REDUCING block leverage changes for all actors; a human must resume before changing leverage. Cases 09 and 16 retain table A even though their decisions are blocked. Capabilities describe action availability; they do not turn a target-specific numeric rejection into a universal denial.

## Freshness and buying power

`asOf` records the last account update. If `confirmedAt` is absent, an old `asOf` alone does not reject a snapshot; the `stale` flag controls freshness. Cases 09 and 12 have no `confirmedAt` and are stale, so they include `ACCOUNT_UNKNOWN`. Case 20 uses the same old `asOf` with `stale=false` and is allowed. Case 21 has `confirmedAt=900000`, `now=1000000`, and a 30000 ms threshold, so it is blocked with `ACCOUNT_UNKNOWN`. Case 01 covers a current `confirmedAt` with the same older `asOf`.

Cases 13 and 14 clarify reserved buying power. Both use available funds `100` and `reserved.account.margin="40"`; the remaining `60` covers the order's required margin of `50`. In case 13, `availableDeductsOpenOrders=true` means available funds already deduct the venue's open-order margin; the reserved `40` represents still-in-flight margin. In case 14, `availableDeductsOpenOrders=false`, and the reservation ledger combines `20` of in-flight margin with `20` of open-order margin into `reserved.account.margin="40"`. Both cases therefore use `100−40≥50` and are allowed; `decide()` does not subtract another `20` for open orders based on the flag. A second subtraction would leave `40`, incorrectly below the required `50`.

## Cases

`expect.codes` represents every `ruleHits` code, including `warn` hits, in stage order with stable de-duplication; it excludes `monitorHits`. K1 should compare `Array.from(new Set(actual.ruleHits.map(hit => hit.code)))` with `expect.codes`.

The fixed expectation counts are 13 ALLOW, 7 BLOCK, and 1 LIMIT.

| File | Input focus | Expected decision / verdict / codes | Actions |
|---|---|---|---|
| `01-open-agent.json` | Healthy paper agent order | ALLOW / allow / none | A |
| `02-reduce-agent.json` | Sell-only reduction against a long position | ALLOW / allow / none | A |
| `03-cancel-system.json` | System cancellation | ALLOW / allow / none | H |
| `04-cancel-protective-human.json` | HALTED account; human cancels a listed stop-loss order | ALLOW / allow / `TRADING_STATE` (warn) | 04 special |
| `05-amend-human.json` | Human amends an open-category order | ALLOW / allow / none | H |
| `06-leverage-human.json` | Human leverage change | ALLOW / allow / none | H |
| `07-deadman-arm-system.json` | System arms a deadman | ALLOW / allow / none | H |
| `08-deadman-disarm-system.json` | System disarms a deadman | ALLOW / allow / none | H |
| `09-open-stale.json` | Stale snapshot without `confirmedAt` | BLOCK / deny / `ACCOUNT_UNKNOWN` | A |
| `10-open-kill.json` | File kill switch is tripped | BLOCK / deny / `KILL_SWITCH` | R |
| `11-open-reducing.json` | Account state is REDUCING | BLOCK / deny / `TRADING_STATE` | R |
| `12-reduce-three-states.json` | Reduction with stale view, kill switch, and REDUCING state | ALLOW / allow / `ACCOUNT_UNKNOWN`, `KILL_SWITCH`, `TRADING_STATE` (warn) | R |
| `13-buying-power-deducted.json` | Open-order margin already deducted from available funds | ALLOW / allow / none | A |
| `14-buying-power-not-deducted.json` | Open-order margin not deducted from available funds | ALLOW / allow / none | A |
| `15-protector-skipped.json` | Enforcing plugin configured while kill switch blocks the order | BLOCK / deny / `KILL_SWITCH` | R |
| `16-protector-unavailable.json` | Enforcing plugin has no result | BLOCK / deny / `PROTECTOR_UNAVAILABLE` | A |
| `17-limit-size.json` | Size adjustment is permitted for an order above the policy cap | LIMIT / allow / `ORDER_NOTIONAL` | A |
| `18-open-live-llm.json` | Live open with `actorClass=agent`, `originActorType=llm-agent`, and deny flag enabled | BLOCK / deny / `LLM_LIVE_ENTRY` | A |
| `19-open-live-engine.json` | Same live agent class and policy as 18, with `originActorType=engine` | ALLOW / allow / none | A |
| `20-open-legacy-fresh.json` | Old `asOf`, missing `confirmedAt`, `stale=false` | ALLOW / allow / none | A |
| `21-open-confirmed-stale.json` | `confirmedAt` exceeds the configured threshold while `stale=false` | BLOCK / deny / `ACCOUNT_UNKNOWN` | A |

Only `originActorType` distinguishes LLM-originated from engine-originated actions; `actorClass` alone does not. Case 15 must include `PROTECTOR:skipped` in resulting stages and must not add `PROTECTOR_UNAVAILABLE`. Case 17's `applied` entry reduces size from `20` to `10` with unit `ASSET`.

## Sources and scope

- `docs/risk-gate-protocol.md` §§3, 4, and 8 define the GateInput, actor, state, action, and reservation semantics represented here.

The protocol package validates case structure and fixed mappings. K1 must call `decide()` for each input and compare its documented output projection with `expect`.
