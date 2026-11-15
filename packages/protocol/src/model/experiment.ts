// SPDX-License-Identifier: Apache-2.0
import type { Decimal, Ms } from './decimal'
import type { AccountId, ExperimentId, InstanceId, InstrumentId, MandateId, Sha256Digest } from './ids'
import type { Instrument } from './instrument'
import type { LedgerAttestation } from '../ledger/entry'
import type { Origin, OriginActorType, OriginVia } from './origin'
import type { BacktestAssumptions, BiasCheckResult } from './signal'
import type { BacktestSpec, BacktestState, BacktestStats } from '../gep/backtest'

export interface Window { from: Ms; to: Ms }

export type ExperimentExecutor =
  | { kind: 'engine'; engineId: string; instanceId: InstanceId; codeDigest: Sha256Digest | null }
  | { kind: 'agent'; mandateId: MandateId }

export interface ExperimentOwner { actorType: OriginActorType; mandateId?: MandateId; userId?: string }

export interface ExperimentLlm {
  involved: boolean
  derivedFrom: 'creator' | 'workflow' | 'declared'
  models: { id: string; trainingCutoff?: Ms; source: 'kernel-table' | 'declared' }[]
}

export const EXPERIMENT_STAGE_ORDER = ['hypothesis', 'backtest', 'holdout', 'shadow', 'live_small', 'live'] as const
export const EXPERIMENT_STAGE_ALIASES = { draft: 'hypothesis', paper: 'shadow' } as const
export const TRIAL_WINDOW_DAYS = 30
export const CANDLES_DIGEST_METHOD = 'gitrader-candles/1'
export const LLM_LEAK_MARGIN_DAYS = 90
export const KNOWN_MODEL_TRAINING_CUTOFFS: Readonly<Record<string, Ms>> = {}
export const EXPERIMENT_READONLY_FIELDS = ['stage', 'metrics', 'forward', 'baseline', 'packs', 'subjectKey', 'executorKind', 'stageEnteredAt', 'reviewFrom', 'owner', 'version', 'holdoutRunId', 'runs'] as const
export const EXPERIMENT_APPEND_ONLY_FIELDS = ['runs', 'data', 'packs', 'conclusions', 'notes'] as const

export interface BaselineRef {
  baselineId: string
  kind: 'buy_and_hold' | 'cash'
  instruments: { instrumentId: InstrumentId; weight: number }[]
  window: Window
  prices: { instrumentId: InstrumentId; startMark: Decimal; endMark: Decimal }[]
}

export interface ForwardStats {
  tier: 'forward_paper' | 'forward_live'
  runIds: string[]
  accountIds: AccountId[]
  window: Window
  ledgerRange: { fromSeq: number; toSeq: number }
  sample: { trades: number; fills: number; roundTrips: number; spanDays: number; activeDays: number; snapshotDays: number }
  valuationCcy: string
  realizedPnl: Decimal
  unrealizedPnlEnd: Decimal
  fees: Decimal
  funding: Decimal
  returnRatio: number
  maxDrawdownRatio: number
  sharpe: number | null
  sortino: number | null
  winRatio: number | null
  periodsPerYear: number
  includesUnrealized: true
  vsBaseline?: { baselineId: string; excessReturnRatio: number }
  provisional: boolean
  computedAt: Ms
  computedBy: 'kernel'
  digest: Sha256Digest
}

export interface PackArtifact { artifactId: string; sha256: Sha256Digest; kind: 'trades' | 'equity'; sizeBytes: number; mediaType: string }
export interface ReturnsArtifactRef { artifactId: string; sha256: Sha256Digest }

export const EVIDENCE_PACK_KINDS = ['backtest', 'holdout', 'forward'] as const
export const EVIDENCE_TIERS = ['hypothetical', 'forward_paper', 'forward_live'] as const
export const LLM_CONTAMINATION_STATES = ['no', 'possible', 'unknown'] as const

export interface EvidencePackRef {
  packId: string
  kind: (typeof EVIDENCE_PACK_KINDS)[number]
  tier: (typeof EVIDENCE_TIERS)[number]
  digest: Sha256Digest
  at: Ms
  runId?: string
}

export interface EvidencePackBase {
  schema: 'gitrader-experiment/1'
  packId: string
  experimentId: ExperimentId
  runId: string
  subjectKey: Sha256Digest | null
  window: Window
  at: Ms
  trialCount: number
  trialStats: { runId: string; specDigest: Sha256Digest; sharpe: number | null; nObs: number }[]
  provenance: { kernelVersion: string; protocolVersion: string }
  attestation: { alg: 'ed25519'; keyId: string; digest: Sha256Digest; sig: string }
}

export interface BacktestEvidencePack extends EvidencePackBase {
  kind: 'backtest' | 'holdout'
  tier: 'hypothetical'
  spec: BacktestSpec
  specDigest: Sha256Digest
  assumptions: BacktestAssumptions
  seed: number
  data: {
    source: 'host' | 'engine' | 'files'
    pointInTime: boolean | 'unknown'
    /** @deprecated Read legacy single-stream metadata only; new packs use candlesDigests. */
    candlesDigest?: Sha256Digest
    candlesDigests: { instrumentId: InstrumentId; digest: Sha256Digest }[]
    candlesDigestMethod: typeof CANDLES_DIGEST_METHOD
    timezone: 'UTC'
    alignment: 'open-time'
  }
  instrumentMeta: Instrument[]
  stats: BacktestStats
  biasChecks: { lookahead: BiasCheckResult; recursive: BiasCheckResult }
  partitions?: { kind: 'train' | 'validation' | 'holdout'; window: Window; embargoMs?: Ms; purgeMs?: Ms }[]
  artifacts: PackArtifact[]
  returnsArtifact?: ReturnsArtifactRef
  llm: ExperimentLlm & { contaminated: (typeof LLM_CONTAMINATION_STATES)[number]; leakFreeFrom: Ms | null }
}

export interface ForwardEvidencePack extends EvidencePackBase {
  kind: 'forward'
  tier: 'forward_paper' | 'forward_live'
  forward: ForwardStats
}

export type EvidencePack = BacktestEvidencePack | ForwardEvidencePack
/** Engine output; the kernel supplies identity, run linkage and attestation at attach. */
export type EvidencePackDraft = Omit<BacktestEvidencePack, 'packId' | 'experimentId' | 'runId' | 'attestation' | 'trialCount' | 'trialStats' | 'provenance' | 'at'>

/** MCP input references an existing run; all evidence values are derived by the kernel. */
export interface ExperimentPackInput { runId: string; note?: string }

export interface LabRun {
  runId: string
  kind: 'backtest' | 'replay'
  experimentId?: ExperimentId
  executor: ExperimentExecutor
  subjectKey: Sha256Digest | null
  specDigest: Sha256Digest
  instruments: InstrumentId[]
  window: Window
  partitions?: BacktestEvidencePack['partitions']
  startedAt: Ms
  status: BacktestState
  resultDigest?: Sha256Digest
  stats?: { sharpe: number | null; nObs: number }
  returnsArtifact?: ReturnsArtifactRef
  packId?: string
}

export interface ExperimentTransitionEvidence {
  actor: ExperimentOwner & { via: OriginVia }
  packs: EvidencePack[]
  labRuns: LabRun[]
  accounts: { accountId: AccountId; mode: 'paper' | 'shadow' | 'live' }[]
  /** Kernel stage history: start of the current backtest cycle, required from holdout. */
  backtestEnteredAt?: Ms
  authorizationValid?: boolean
  riskPolicyValid?: boolean
  parallelExperimentsDisclosed?: boolean
  presence?: { verified: boolean; forwardPackDigest: Sha256Digest }
}

export interface ForwardRunInput {
  runId: string
  accountId: AccountId
  executor: ExperimentExecutor
  attachedAt: Ms
  to: Ms | null
}

export interface ForwardFillSlice {
  sliceId: string
  fillId: string
  orderId: string
  runId: string
  accountId: AccountId
  instrumentId: InstrumentId
  positionKey: string
  seq: number
  ts: Ms
  recordedAt: Ms
  attestation: LedgerAttestation
  origin: Origin
  positionBefore: Decimal
  positionAfter: Decimal
  realizedPnl: Decimal
  fee: Decimal
  valuationCcy: string
}

export interface ForwardSnapshot {
  seq: number
  accountId: AccountId
  at: Ms
  recordedAt: Ms
  attestation: LedgerAttestation
  kind: 'daily' | 'stage'
  equity: Decimal
  unrealizedPnl: Decimal
  valuationCcy: string
}

export interface ForwardStatsInput {
  tier: 'forward_paper'
  window: Window
  stageEnteredAt: Ms
  runs: ForwardRunInput[]
  initialEquity: { accountId: AccountId; at: Ms; equity: Decimal; unrealizedPnl: Decimal }[]
  fills: ForwardFillSlice[]
  snapshots: ForwardSnapshot[]
  valuationCcy: string
  periodsPerYear: number
  finalized: boolean
  computedAt: Ms
  baseline?: { baselineId: string; window: Window; returnRatio: number }
}

