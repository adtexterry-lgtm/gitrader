// SPDX-License-Identifier: CPAL-1.0
import type { EvidencePack, Experiment, ForwardEvidencePack, LabRun } from '../proto'
import { computeEntryHash, computeForwardStats, computePayloadHash, validateBySchemaId, validateExperiment, canonicalize } from '../proto'
import type { LabService } from '../lab'
import { fail } from '../util/errors'
import { digestOf, sha256Digest, sha256Hex } from '../util/hash'
import { InstallKey } from '../install-key'
import * as d from '../util/dec'

type Plain = Record<string, any>
type RunDetail = { runId: string; engineId: string; spec: Plain; origin: Plain; executor: Plain; jobId?: string; replayId?: string; result?: Plain; strategySha256?: string }
type ForwardEndpoint = { at: number; requestedAt: number; sealSeq: number; sourceSeqs: number[] }
type ExportBundle = {
  schema: 'gitrader-lab-export/1'
  disclaimer: string
  experiment: Experiment
  versions: Experiment[]
  runs: LabRun[]
  runDetails: RunDetail[]
  packs: EvidencePack[]
  forwardInputs: { packId: string; input: Plain; endpoint?: ForwardEndpoint }[]
  ledger: Plain[]
  artifacts: { artifactId: string; sha256: string; kind: string; sizeBytes: number; mediaType: string; dataBase64: string }[]
  parallel: Plain[]
  warnings: string[]
  installKey: { keyId: string; publicKey: string }
  exportedAt: number
  attestation?: { digest: string; sig: string }
}

const DISCLAIMER = 'Backtest results are hypothetical. Forward observations do not promise future returns.'
const DETAILS = 'lab-run-detail'
const FORWARD_INPUTS = 'lab-forward-input'

function incomplete(message = 'Experiment export evidence is incomplete'): never { return fail('EXPERIMENT_EVIDENCE_INCOMPLETE', message) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function unsigned(bundle: ExportBundle): Omit<ExportBundle, 'attestation'> {
  const { attestation: _attestation, ...body } = bundle as ExportBundle & { attestation?: unknown }
  return body
}

export class LabExport {
  constructor(readonly lab: LabService) {}

  async export(id: string): Promise<Record<string, unknown>> {
    const experiment = this.lab.load(id)
    const versions = this.lab.k.docs.versions<Experiment>('experiment', id)
    const runs = this.lab.runTable.all()
    const runDetails = runs.map((run) => {
      const detail = this.lab.k.docs.get<RunDetail>(DETAILS, run.runId)
      if (!detail) return incomplete('An exported run is missing its local detail record')
      return {
        runId: run.runId,
        engineId: detail.engineId,
        spec: clone(detail.spec),
        origin: clone(detail.origin),
        executor: clone(detail.executor),
        ...(detail.jobId !== undefined ? { jobId: detail.jobId } : {}),
        ...(detail.replayId !== undefined ? { replayId: detail.replayId } : {}),
        ...(detail.result ? { result: clone(detail.result) } : {}),
        ...(detail.strategySha256 ? { strategySha256: detail.strategySha256 } : {}),
      }
    })
    const packs = this.lab.runTable.packs(experiment)
    const forwardInputs = packs.filter((pack): pack is ForwardEvidencePack => pack.kind === 'forward').map((pack) => {
      const input = this.lab.k.docs.get<Plain>(FORWARD_INPUTS, pack.packId)
      if (!input) return incomplete('A forward pack is missing its recorded input')
      const endpoint = this.lab.k.docs.get<ForwardEndpoint>('lab-forward-endpoint', pack.packId)
      return { packId: pack.packId, input: clone(input), ...(endpoint ? { endpoint: clone(endpoint) } : {}) }
    })
    const accountIds = new Set((experiment.runs ?? []).flatMap((run) => run.accountId ? [run.accountId] : []))
    const ledgerAll = Array.from(this.lab.k.ledger.iterate())
    const forwardedSeqs = new Set<number>(forwardInputs.flatMap(({ input, endpoint }) => [
      ...(Array.isArray(input.fills) ? input.fills.map((fill: Plain) => fill?.seq) : []),
      ...(Array.isArray(input.snapshots) ? input.snapshots.map((snapshot: Plain) => snapshot?.seq) : []),
      ...(endpoint ? [endpoint.sealSeq, ...endpoint.sourceSeqs] : []),
    ]).filter((seq): seq is number => Number.isSafeInteger(seq)))
    const includedRuns = new Set(runs.filter((run) => run.experimentId === id).map((run) => run.runId))
    const ledger = ledgerAll.filter((entry) => {
      if (forwardedSeqs.has(entry.seq)) return true
      if (entry.subject.experimentId === id && ['experiment.created', 'experiment.updated', 'experiment.stage_changed'].includes(entry.type)) return true
      return (entry.type === 'backtest.completed' && typeof entry.payload?.runId === 'string' && includedRuns.has(entry.payload.runId)) ||
        ((entry.type === 'fill' || entry.type === 'position.snapshot' || entry.type === 'order.intent') && !!entry.subject.accountId && accountIds.has(entry.subject.accountId))
    })
    const artifactIds = new Set<string>()
    for (const pack of packs) if (pack.kind !== 'forward') {
      for (const item of pack.artifacts) artifactIds.add(item.artifactId)
      if (pack.returnsArtifact) artifactIds.add(pack.returnsArtifact.artifactId)
    }
    const artifacts = [...artifactIds].sort().map((artifactId) => {
      const item = this.lab.artifacts.get(artifactId)
      if (!item) return incomplete('A referenced artifact is missing')
      const bytes = this.lab.artifacts.read(artifactId)
      return { artifactId, sha256: item.sha256, kind: item.kind, sizeBytes: item.sizeBytes, mediaType: item.mediaType, dataBase64: bytes.toString('base64') }
    })
    const warnings = new Set<string>()
    for (const pack of packs) if (pack.kind !== 'forward') {
      if (pack.data.pointInTime !== true) warnings.add('pointInTimeUnproved')
      if (pack.llm.involved && (pack.llm.contaminated !== 'no' || pack.llm.leakFreeFrom === null)) warnings.add('llmKnowledgeWindow')
    }
    const unsignedBundle: ExportBundle = {
      schema: 'gitrader-lab-export/1',
      disclaimer: DISCLAIMER,
      experiment: clone(experiment),
      versions: clone(versions),
      runs: clone(runs),
      runDetails,
      packs: clone(packs),
      forwardInputs,
      ledger: clone(ledger),
      artifacts,
      parallel: this.lab.stages.parallel(experiment).map((item) => ({ experimentId: item.experimentId, stage: item.stage, forward: item.forward ?? null })),
      warnings: [...warnings].sort(),
      installKey: { keyId: this.lab.k.installKey.keyId, publicKey: this.lab.k.installKey.publicKey },
      exportedAt: this.lab.k.clock.now(),
    }
    const digest = digestOf(unsignedBundle)
    return { ...unsignedBundle, attestation: { digest, sig: this.lab.k.installKey.sign(digest) } }
  }

  async verify(input: unknown): Promise<{ status: 'identical' | 'diff'; differences: string[] }> {
    const differences = new Set<string>()
    const add = (path: string): void => { differences.add(path) }
    const asRecord = (value: unknown): value is Plain => value !== null && typeof value === 'object' && !Array.isArray(value)
    const equal = (a: unknown, b: unknown): boolean => {
      try { return canonicalize(a) === canonicalize(b) } catch { return false }
    }
    try {
      if (!asRecord(input)) return { status: 'diff', differences: ['bundle'] }
      const bundle = input as unknown as ExportBundle
      if (bundle.schema !== 'gitrader-lab-export/1') add('schema')
      if (bundle.disclaimer !== DISCLAIMER) add('disclaimer')
      if (!Number.isSafeInteger(bundle.exportedAt) || !asRecord(bundle.installKey) || typeof bundle.installKey.keyId !== 'string' || typeof bundle.installKey.publicKey !== 'string') add('installKey')
      if (!asRecord(bundle.attestation) || typeof bundle.attestation.digest !== 'string' || typeof bundle.attestation.sig !== 'string') add('attestation')
      if (differences.size) return { status: 'diff', differences: [...differences].sort() }

      const body = unsigned(bundle)
      const bodyDigest = digestOf(body)
      if (bundle.attestation!.digest !== bodyDigest) add('attestation.digest')
      if (!InstallKey.verify(bundle.installKey.publicKey, bundle.attestation!.digest, bundle.attestation!.sig)) add('attestation.sig')

      if (!validateExperiment(bundle.experiment).ok) add('experiment')
      if (!Array.isArray(bundle.versions) || !bundle.versions.length) add('versions')
      else {
        bundle.versions.forEach((version, index) => {
          if (!validateExperiment(version).ok) add(`versions[${index}]`)
          if (version.experimentId !== bundle.experiment.experimentId || version.version !== index + 1) add(`versions[${index}].version`)
        })
        if (!equal(bundle.versions.at(-1), bundle.experiment)) add('experiment')
      }
      if (!Array.isArray(bundle.runs) || !Array.isArray(bundle.runDetails) || !Array.isArray(bundle.packs) || !Array.isArray(bundle.forwardInputs) || !Array.isArray(bundle.ledger) || !Array.isArray(bundle.artifacts) || !Array.isArray(bundle.parallel) || !Array.isArray(bundle.warnings)) {
        add('shape')
        return { status: 'diff', differences: [...differences].sort() }
      }

      const runById = new Map<string, LabRun>()
      bundle.runs.forEach((run, index) => {
        if (!asRecord(run) || typeof run.runId !== 'string') { add(`runs[${index}]`); return }
        runById.set(run.runId, run)
      })
      const detailById = new Map<string, RunDetail>()
      bundle.runDetails.forEach((detail, index) => {
        if (!asRecord(detail) || typeof (detail as any).runId !== 'string') { add(`runDetails[${index}]`); return }
        const id = (detail as any).runId as string
        detailById.set(id, detail)
        const run = runById.get(id)
        if (!run) { add(`runDetails[${index}].runId`); return }
        if (digestOf(detail.spec) !== run.specDigest) add(`runDetails[${index}].spec`)
        if (detail.result !== undefined && digestOf(detail.result) !== run.resultDigest) add(`runDetails[${index}].result`)
      })
      for (const run of runById.values()) if (!detailById.has(run.runId)) add(`runs.${run.runId}.detail`)

      const packById = new Map<string, EvidencePack>()
      bundle.packs.forEach((pack, index) => {
        if (!asRecord(pack) || typeof pack.packId !== 'string') { add(`packs[${index}]`); return }
        packById.set(pack.packId, pack)
        if (!validateBySchemaId('urn:gitrader:schema:model:0.1:EvidencePack', pack).ok) add(`packs[${index}]`)
        const { attestation, ...unsignedPack } = pack
        if (!attestation || digestOf(unsignedPack) !== attestation.digest) add(`packs[${index}].attestation.digest`)
        else {
          if (attestation.keyId !== bundle.installKey.keyId) add(`packs[${index}].attestation.keyId`)
          if (!InstallKey.verify(bundle.installKey.publicKey, attestation.digest, attestation.sig)) add(`packs[${index}].attestation.sig`)
        }
        if (pack.kind !== 'forward') {
          const run = runById.get(pack.runId)
          if (!run || run.kind !== 'backtest' || run.status !== 'done' || run.packId !== pack.packId || run.specDigest !== pack.specDigest) add(`packs[${index}].runId`)
          const detail = detailById.get(pack.runId)
          if (!detail || !equal(detail.spec, pack.spec)) add(`packs[${index}].spec`)
          if (run && detail) {
            const resultStrategySha256 = typeof detail.result?.strategySha256 === 'string' ? detail.result.strategySha256 : undefined
            const strategySha256 = resultStrategySha256 ?? detail.strategySha256
            if (pack.subjectKey !== run.subjectKey || run.subjectKey !== strategySha256) add(`packs[${index}].subjectKey`)
            if (detail.result && detail.result.specDigest !== run.specDigest) add(`packs[${index}].specDigest`)
            if (detail.result && detail.jobId !== detail.result.jobId) add(`packs[${index}].jobId`)
          }
        }
      })
      const refs = bundle.experiment.packs ?? []
      if (refs.length !== bundle.packs.length) add('experiment.packs')
      for (const ref of refs) {
        const pack = packById.get(ref.packId)
        if (!pack || ref.kind !== pack.kind || ref.tier !== pack.tier || ref.at !== pack.at || ref.digest !== pack.attestation.digest || (ref.runId !== undefined && ref.runId !== pack.runId)) add(`experiment.packs.${ref.packId}`)
      }
      for (const pack of bundle.packs) if (!refs.some((ref) => ref.packId === pack.packId)) add(`packs.${pack.packId}`)

      const expectedRefs = new Map<string, { sha256: string; kind?: string; sizeBytes?: number; mediaType?: string; packId: string }[]>()
      for (const pack of bundle.packs) if (pack.kind !== 'forward') {
        for (const ref of pack.artifacts) {
          expectedRefs.set(ref.artifactId, [...(expectedRefs.get(ref.artifactId) ?? []), {
            sha256: ref.sha256,
            kind: ref.kind,
            sizeBytes: ref.sizeBytes,
            mediaType: ref.mediaType,
            packId: pack.packId,
          }])
        }
        if (pack.returnsArtifact) {
          const ref = pack.returnsArtifact
          expectedRefs.set(ref.artifactId, [...(expectedRefs.get(ref.artifactId) ?? []), {
            sha256: ref.sha256,
            packId: pack.packId,
          }])
        }
      }
      const actualArtifacts = new Map<string, (typeof bundle.artifacts)[number]>()
      bundle.artifacts.forEach((artifact, index) => {
        if (!asRecord(artifact) || typeof artifact.artifactId !== 'string' || typeof artifact.dataBase64 !== 'string') { add(`artifacts[${index}]`); return }
        actualArtifacts.set(artifact.artifactId, artifact)
        try {
          const bytes = Buffer.from(artifact.dataBase64, 'base64')
          if (bytes.toString('base64') !== artifact.dataBase64) add(`artifacts[${index}].dataBase64`)
          if (bytes.byteLength !== artifact.sizeBytes) add(`artifacts[${index}].sizeBytes`)
          if (sha256Digest(bytes) !== artifact.sha256) add(`artifacts[${index}].sha256`)
        } catch { add(`artifacts[${index}].dataBase64`) }
      })
      for (const [artifactId, refs] of expectedRefs) {
        const artifact = actualArtifacts.get(artifactId)
        if (!artifact) { add(`artifacts.${artifactId}`); continue }
        if (refs.some((ref) => ref.sha256 !== artifact.sha256)) add(`artifacts.${artifactId}.sha256`)
        if (refs.some((ref) => ref.kind !== undefined && (ref.kind !== artifact.kind || ref.sizeBytes !== artifact.sizeBytes || ref.mediaType !== artifact.mediaType))) add(`artifacts.${artifactId}.metadata`)
      }
      for (const artifactId of actualArtifacts.keys()) if (!expectedRefs.has(artifactId)) add(`artifacts.${artifactId}`)

      const ledgerBySeq = new Map<number, Plain>()
      bundle.ledger.forEach((entry, index) => {
        if (!asRecord(entry) || !Number.isSafeInteger(entry.seq)) { add(`ledger[${index}]`); return }
        ledgerBySeq.set(entry.seq, entry)
        try {
          if (computePayloadHash(entry.payload, sha256Hex) !== entry.payloadHash) add(`ledger[${index}].payloadHash`)
          if (computeEntryHash(entry as never, sha256Hex) !== entry.hash) add(`ledger[${index}].hash`)
        } catch { add(`ledger[${index}].hash`) }
      })
      const expId = bundle.experiment.experimentId
      const versionEvents = bundle.ledger.filter((entry) => entry.subject?.experimentId === expId && (entry.type === 'experiment.created' || entry.type === 'experiment.updated')).sort((a, b) => a.seq - b.seq)
      let replayed: Experiment | undefined
      const replayVersions: Experiment[] = []
      const versionAtSeq: { seq: number; doc: Experiment }[] = []
      for (const [index, entry] of versionEvents.entries()) {
        const payload = entry.payload
        const doc = entry.type === 'experiment.created' ? payload?.doc : payload?.doc
        if (!asRecord(doc) || doc.experimentId !== expId || !validateExperiment(doc).ok || digestOf(doc) !== payload?.docDigest) { add(`ledger.experimentVersions[${index}]`); continue }
        if (entry.type === 'experiment.created') {
          if (replayed || doc.version !== 1 || index !== 0) add(`ledger.experimentVersions[${index}]`)
          replayed = doc as Experiment
        } else {
          const fromVersion = payload?.fromVersion
          const toVersion = payload?.toVersion
          if (!replayed || fromVersion !== replayed.version || toVersion !== (replayed.version ?? 0) + 1 || doc.version !== toVersion) add(`ledger.experimentVersions[${index}]`)
          replayed = doc as Experiment
        }
        replayVersions.push(doc as Experiment)
        versionAtSeq.push({ seq: entry.seq, doc: doc as Experiment })
      }
      if (!replayed || !equal(replayed, bundle.experiment)) add('ledger.experiment.final')
      if (!equal(replayVersions, bundle.versions)) add('versions')

      const forwardInputByPack = new Map<string, Plain>()
      const endpointByPack = new Map<string, unknown>()
      bundle.forwardInputs.forEach((item, index) => {
        if (!asRecord(item) || typeof item.packId !== 'string' || !asRecord(item.input)) { add(`forwardInputs[${index}]`); return }
        forwardInputByPack.set(item.packId, item.input)
        if (Object.prototype.hasOwnProperty.call(item, 'endpoint')) endpointByPack.set(item.packId, item.endpoint)
      })
      for (const pack of bundle.packs) if (pack.kind === 'forward') {
        const inputValue = forwardInputByPack.get(pack.packId)
        if (!inputValue) { add(`forwardInputs.${pack.packId}`); continue }
        try {
          const stats = await computeForwardStats(inputValue as never)
          if (!equal(stats, pack.forward)) add(`packs.${pack.packId}.forward`)
          const rawEndpoint = endpointByPack.get(pack.packId)
          let endpoint: ForwardEndpoint | undefined
          let endpointSourceSeqs = new Set<number>()
          if (rawEndpoint !== undefined) {
            const endpointPath = `forwardInputs.${pack.packId}.endpoint`
            if (!asRecord(rawEndpoint)) add(endpointPath)
            else {
              endpoint = rawEndpoint as unknown as ForwardEndpoint
              const sourceSeqs = endpoint.sourceSeqs
              if (!Number.isSafeInteger(endpoint.at) || !Number.isSafeInteger(endpoint.requestedAt) || !Number.isSafeInteger(endpoint.sealSeq)) add(endpointPath)
              if (!Array.isArray(sourceSeqs) || !sourceSeqs.length || sourceSeqs.some((seq: unknown) => !Number.isSafeInteger(seq)) || new Set(sourceSeqs).size !== sourceSeqs.length) add(`${endpointPath}.sourceSeqs`)
              else endpointSourceSeqs = new Set(sourceSeqs)
              if (inputValue.window?.to !== endpoint.at || inputValue.computedAt !== endpoint.at) add(`${endpointPath}.window`)
              const seal = Number.isSafeInteger(endpoint.sealSeq) ? ledgerBySeq.get(endpoint.sealSeq) : undefined
              if (!seal || seal.type !== 'annotation' || seal.subject?.experimentId !== expId || seal.attestation !== 'kernel-observed' || seal.payload?.kind !== 'lab.snapshot.batch' || seal.payload?.requestedAt !== endpoint.requestedAt || !equal(seal.payload?.sourceSeqs, endpoint.sourceSeqs) || seal.recordedAt !== endpoint.at) add(`${endpointPath}.seal`)
              const sourceAccounts = new Set<string>()
              for (const sourceSeq of endpointSourceSeqs) {
                const source = ledgerBySeq.get(sourceSeq)
                if (!source || source.type !== 'position.snapshot' || source.subject?.experimentId !== expId || source.attestation !== 'kernel-observed' || source.payload?.kind !== 'stage' || source.payload?.at !== endpoint.requestedAt || !Number.isSafeInteger(source.recordedAt) || source.recordedAt > endpoint.at || typeof source.subject?.accountId !== 'string') {
                  add(`${endpointPath}.sourceSeqs`)
                  continue
                }
                if (sourceAccounts.has(source.subject.accountId)) add(`${endpointPath}.sourceSeqs`)
                sourceAccounts.add(source.subject.accountId)
                const references = (Array.isArray(inputValue.snapshots) ? inputValue.snapshots : []).filter((snapshot: Plain) => snapshot?.seq === sourceSeq)
                if (references.length !== 1) add(`${endpointPath}.sourceSeqs`)
              }
              const runAccounts = new Set<string>((Array.isArray(inputValue.runs) ? inputValue.runs : []).flatMap((run: Plain) => typeof run?.accountId === 'string' ? [run.accountId] : []))
              if (sourceAccounts.size !== runAccounts.size || [...sourceAccounts].some((accountId) => !runAccounts.has(accountId))) add(`${endpointPath}.accounts`)
            }
          }
          const firstVersionIndex = versionAtSeq.findIndex(({ doc }) => (doc.packs ?? []).some((ref) => ref.packId === pack.packId))
          const sourceVersion = firstVersionIndex > 0 ? versionAtSeq[firstVersionIndex - 1]?.doc : undefined
          if (firstVersionIndex < 0 || !sourceVersion) add(`forwardInputs.${pack.packId}.sourceVersion`)
          else {
            const to = inputValue.window?.to
            const expectedRuns = (sourceVersion.runs ?? []).filter((run) => run.accountId && (run.to === null || (typeof to === 'number' && run.to >= to)))
            const actualRuns = Array.isArray(inputValue.runs) ? inputValue.runs : []
            if (inputValue.stageEnteredAt !== sourceVersion.stageEnteredAt) add(`forwardInputs.${pack.packId}.stageEnteredAt`)
            if (actualRuns.length !== expectedRuns.length) add(`forwardInputs.${pack.packId}.runs`)
            for (const expected of expectedRuns) {
              const actual = actualRuns.find((run: Plain) => run.runId === expected.runId)
              if (!actual || actual.accountId !== expected.accountId || actual.attachedAt !== expected.attachedAt || actual.to !== expected.to || !equal(actual.executor, expected.executor)) add(`forwardInputs.${pack.packId}.runs.${expected.runId}`)
            }
          }
          const slicesBySeq = new Map<number, Plain[]>()
          for (const fill of inputValue.fills ?? []) {
            const entry = ledgerBySeq.get(fill.seq)
            const path = `forwardInputs.${pack.packId}.fills.${fill.seq}`
            if (!entry || entry.type !== 'fill') { add(path); continue }
            if (entry.subject?.fillId !== fill.fillId || entry.subject?.orderId !== fill.orderId || entry.subject?.accountId !== fill.accountId || entry.subject?.instrumentId !== fill.instrumentId) add(`${path}.source`)
            if (entry.payload?.venueTs !== fill.ts || entry.recordedAt !== fill.recordedAt || entry.attestation !== fill.attestation || fill.valuationCcy !== inputValue.valuationCcy) add(`${path}.timestampsOrCurrency`)
            if (entry.payload?.feeCcy !== undefined && entry.payload.feeCcy !== inputValue.valuationCcy) add(`${path}.feeCcy`)
            const intent = bundle.ledger.find((candidate) => candidate.type === 'order.intent' && candidate.subject?.orderId === entry.subject?.orderId)
            let expectedOrigin: Plain
            if (intent) {
              expectedOrigin = clone(intent.origin)
              if (expectedOrigin.actorType === 'llm-agent' && typeof intent.subject?.mandateId === 'string') {
                expectedOrigin.causation = { ...(expectedOrigin.causation ?? {}), mandateId: intent.subject.mandateId }
              }
            } else {
              expectedOrigin = { actor: 'venue:unmatched', actorType: 'system', tool: 'lab:unmatched-fill', requestId: entry.origin?.requestId, via: 'internal' }
              if (expectedOrigin.requestId === undefined) delete expectedOrigin.requestId
            }
            if (!equal(fill.origin, expectedOrigin)) add(`${path}.origin`)
            slicesBySeq.set(fill.seq, [...(slicesBySeq.get(fill.seq) ?? []), fill])
          }
          for (const snapshot of inputValue.snapshots ?? []) {
            const entry = ledgerBySeq.get(snapshot.seq)
            const path = `forwardInputs.${pack.packId}.snapshots.${snapshot.seq}`
            if (!entry || entry.type !== 'position.snapshot') { add(path); continue }
            const isEndpointSource = endpointSourceSeqs.has(snapshot.seq)
            if (entry.subject?.accountId !== snapshot.accountId || snapshot.at !== (isEndpointSource ? endpoint?.at : entry.payload?.at) || (isEndpointSource && entry.payload?.at !== endpoint?.requestedAt) || entry.payload?.kind !== snapshot.kind || entry.payload?.equity !== snapshot.equity || entry.payload?.unrealizedPnl !== snapshot.unrealizedPnl || entry.payload?.valuationCcy !== snapshot.valuationCcy || entry.recordedAt !== snapshot.recordedAt || entry.attestation !== snapshot.attestation) add(`${path}.source`)
          }
          const priorPosition = new Map<string, string>()
          for (const [seq, slices] of slicesBySeq) {
            const entry = ledgerBySeq.get(seq)
            if (!entry) continue
            const path = `forwardInputs.${pack.packId}.fills.${seq}`
            try {
              const size = d.D(entry.payload?.size)
              const fee = d.D(entry.payload?.fee)
              const pnl = d.D(entry.payload?.realizedPnl)
              const side = entry.payload?.side
              const expectedDelta = side === 'buy' ? size : side === 'sell' ? d.neg(size) : undefined
              if (!expectedDelta || slices.some((slice) => slice.fillId !== entry.subject?.fillId || slice.orderId !== entry.subject?.orderId || slice.accountId !== entry.subject?.accountId || slice.instrumentId !== entry.subject?.instrumentId || slice.positionKey !== `${entry.subject?.accountId}:${entry.subject?.instrumentId}`)) add(`${path}.identity`)
              const totalDelta = slices.reduce<d.Dec>((sum, slice) => d.add(sum, d.sub(d.D(slice.positionAfter), d.D(slice.positionBefore))), d.ZERO)
              const totalFee = slices.reduce<d.Dec>((sum, slice) => d.add(sum, d.D(slice.fee)), d.ZERO)
              const totalPnl = slices.reduce<d.Dec>((sum, slice) => d.add(sum, d.D(slice.realizedPnl)), d.ZERO)
              if (!expectedDelta || !d.eq(totalDelta, expectedDelta)) add(`${path}.size`)
              if (!d.eq(totalFee, fee)) add(`${path}.fee`)
              if (!d.eq(totalPnl, pnl)) add(`${path}.realizedPnl`)
              if (slices.length === 1) {
                const only = slices[0]!
                if (!d.eq(d.D(only.fee), fee) || !d.eq(d.D(only.realizedPnl), pnl)) add(`${path}.slice`)
              } else if (slices.length === 2) {
                const close = slices[0]!, open = slices[1]!
                if (close.sliceId !== `${entry.subject?.fillId}:close` || open.sliceId !== `${entry.subject?.fillId}:open` || !d.isZero(d.D(close.positionAfter)) || !d.isZero(d.D(open.positionBefore)) || !d.eq(d.D(close.realizedPnl), pnl) || !d.isZero(d.D(open.realizedPnl))) add(`${path}.reversal`)
              } else add(`${path}.slices`)
              for (const slice of slices) {
                const previous = priorPosition.get(slice.positionKey)
                if (previous !== undefined && !d.eq(d.D(previous), d.D(slice.positionBefore))) add(`${path}.positionContinuity`)
                priorPosition.set(slice.positionKey, slice.positionAfter)
              }
            } catch { add(path) }
          }
        } catch { add(`forwardInputs.${pack.packId}`) }
      }

      for (const entry of bundle.ledger) if (entry.type === 'experiment.stage_changed' && entry.subject?.experimentId === expId) {
        const historical = versionAtSeq.filter((version) => version.seq < entry.seq).at(-1)?.doc
        if (!historical) add(`ledger.${entry.seq}.stage_changed.version`)
        const historicalPacks = (historical?.packs ?? []).flatMap((ref) => {
          const pack = packById.get(ref.packId)
          return pack?.kind === 'backtest' ? [pack] : []
        })
        const latestBacktest = historicalPacks.sort((a, b) => b.at - a.at)[0]
        const runPins = historical?.runs ?? []
        const comparisons = runPins.map((run) => {
          const executor = run.executor
          if (!executor || executor.kind !== 'engine' || !executor.codeDigest || !latestBacktest?.subjectKey) return undefined
          return executor.codeDigest === latestBacktest.subjectKey
        })
        const expectedPinMismatch: boolean | 'unknown' = comparisons.some((value) => value === false)
          ? true : !comparisons.length || comparisons.some((value) => value === undefined) ? 'unknown' : false
        if (entry.payload?.pinMismatch !== expectedPinMismatch) add(`ledger.${entry.seq}.stage_changed.pinMismatch`)
        const seal = entry.payload?.attestation
        if (!seal) continue
        const claim = seal.payload
        if (!asRecord(claim) || typeof seal.digest !== 'string' || typeof seal.sig !== 'string' || seal.keyId !== bundle.installKey.keyId || digestOf(claim) !== seal.digest || !InstallKey.verify(bundle.installKey.publicKey, seal.digest, seal.sig)) {
          add(`ledger.${entry.seq}.stage_changed.attestation`)
          continue
        }
        const expectedParallel = entry.payload?.parallelExperimentIds
        const parallelIsUnique = Array.isArray(claim.parallelExperimentIds) && claim.parallelExperimentIds.every((id: unknown) => typeof id === 'string') && new Set(claim.parallelExperimentIds).size === claim.parallelExperimentIds.length
        const referencedForward = packById.get((entry.payload?.evidencePackIds ?? []).find((packId: string) => packById.get(packId)?.attestation.digest === claim.forwardPackDigest))
        const actor = typeof entry.origin?.actor === 'string' ? entry.origin.actor.replace(/^user:/, '') : undefined
        if (claim.experimentId !== expId || claim.from !== entry.payload?.from || claim.to !== entry.payload?.to || claim.by !== entry.payload?.by || claim.by !== actor || claim.at !== entry.ts || claim.method !== 'pin' || entry.origin?.actorType !== 'human' || entry.origin?.via !== 'ui' || referencedForward?.kind !== 'forward' || claim.forwardPackDigest !== referencedForward?.attestation.digest || !equal(claim.parallelExperimentIds, expectedParallel) || !parallelIsUnique || !claim.parallelExperimentIds.includes(expId)) add(`ledger.${entry.seq}.stage_changed.attestation.payload`)
      }

      return { status: differences.size ? 'diff' : 'identical', differences: [...differences].sort() }
    } catch {
      return { status: 'diff', differences: [...differences, 'bundle.structure'].sort() }
    }
  }
}
