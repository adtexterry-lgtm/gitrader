<!-- SPDX-License-Identifier: Apache-2.0 -->
# Experiment conformance fixtures

These JSON fixtures are schema-checked contract data for the Experiment protocol. `test/experiment-p.test.ts` executes every protocol-side fixture against the real helpers and compares the declared expectations.

`loadExperimentCases()` reads 47 transition, readonly, append-only, schema, candle-digest and future kernel-contract examples from `cases/`. A transition's optional `then` steps use the state resulting from each accepted preceding transition. `loadForwardCases()` reads five hand-calculated `ForwardStatsInput` examples from `forward/`. Both loaders sort file names, validate every document against its schema, reject duplicate IDs, and report only a basename and schema paths on errors.

The kernel-contract fixtures state future expectations as JSON `given` and `expect` steps. In particular, the 33rd case describes lifecycle/export behavior; it is not a report that the behavior has run or passed. The `r1.2` `live_small` to `live` transition remains deferred and its case records refusal.

The five kernel-contract cases (21–24, 33) remain declarative: no kernel behavior is simulated in the protocol tests. Schema validation and pure-function execution do not establish kernel, UI or service behavior.

## Transition and write boundaries

`retired` is outside the mainline ordering. Any stage may retire; retirement permits only staying retired or reopening to hypothesis. Review returns use the mainline `reviewFrom`, never retired as a high rank. Cases 34–37 cover bypass and recovery; case 14's exact `reviewFrom` refusal is authoritative under the design's review ceiling, without a second `stage.skip`.

For holdout to shadow, the kernel supplies `evidence.backtestEnteredAt` from the current cycle's stage history. Both linked packs must be from that cycle, the holdout must be no earlier than its matching lab pack, and neither may be in the future. Run-table linkage, frozen window, subject, seed, assumptions, PIT and lookahead checks remain. Case 06 continues to shadow at 2000; 09 uses a lab pack at 200, holdout pack at 300 and entry into holdout at 1000. Cases 45–46 reject reversed or stale evidence.

Both LLM exits consider the same linked, current backtest packs. Historical contamination does not veto a current clean pair (42); that same pair does not qualify for the contaminated direct route (43).

Problem mapping for callers: `missing = ['owner']` maps only to 1016. Other transition/evidence failures map to 1013; `stage.closed` and `stage.same` retain the 1015 terminal/append-only mapping. `stage.retired` and `reviewFrom` map to 1013. Ownership is checked first and never mixed with evidence failures.

`runs` is readonly to update and is appended through attach. `ExperimentPackInput` accepts only `{ runId, note? }`; all evidence values are derived from recorded runs by the kernel. `EvidencePackDraft` is separate engine output and omits identity and kernel-sealed fields. Notes and conclusions receive their origin/time stamps in the kernel; these fixtures do not claim that later kernel work has run.

## Candle digest vectors

New packs use `data.candlesDigests: { instrumentId, digest }[]`, including a single instrument. The old optional scalar `data.candlesDigest` is deprecated and is not a multi-instrument aggregate. At collection, the kernel must reject duplicate or missing instrument IDs and require the same set as `spec.instruments`; the interval is `spec.interval`.

For each instrument independently, take rows `[t,o,h,l,c,v]`, sort by ascending `t`, reject duplicate timestamps, and serialize with RFC 8785 JCS. Hash the UTF-8 bytes of `gitrader-candles/1`, one LF byte, then the serialized array, with no trailing LF. Object key order, numeric notation and input row order do not affect the digest. This does not change the existing digest algorithm.

Case 44 contains two independent literal vectors and permutations. The first hashes `[[0,100,110,90,105,0],[60000,105,120,100,115,2]]`; the second hashes `[[0,50,60,40,55,3]]`. The expected hashes were produced from those literal bytes, without calling `candlesDigest`.

## Forward hand calculations

Forward/01 starts at 100 and applies five pairs of +20%, −10%. Final equity is 146.93280768; TWR is 0.4693280768 and maximum drawdown is 0.1. The ten returns have mean 0.05, squared deviations summing to 0.225, sample variance 0.025 (ddof=1), and downside squared mean 0.005 (all ten observations). Thus Sharpe = √36.5 and Sortino = √182.5, both nonzero; the fixture stores numerical expectations with tolerance 1e-9.

Forward/05 inserts a foreign-origin slice between the first opening and closing slices of forward/04. Its PnL and fee do not count; the interrupted round trip does not count either. The remaining two completed cycles have zero and negative net PnL, so roundTrips=2 and winRatio=0. Accepted-slice totals remain realizedPnl="6" and fees="7". Later attributable cycles resume normally.

Case 22 keeps the executor's windowDays=30 distinct from its seven completed trials; minimumTrials=7 is a count, not a duration.
