// SPDX-License-Identifier: CPAL-1.0
import { mkdirSync, openSync, closeSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Sha256Digest } from '../proto'
import { Docs } from '../db'
import { fail } from '../util/errors'
import { sha256Digest, sha256Hex } from '../util/hash'

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const ARTIFACT_KINDS = new Set(['tearsheet', 'trades', 'equity'])
const COLL = 'lab-artifact'

export interface StoredArtifact {
  artifactId: string
  sha256: Sha256Digest
  kind: string
  sizeBytes: number
  mediaType: string
  engineId: string
  storedPath: string
}

type ArtifactInput = { path: string; sha256: Sha256Digest; mediaType: string; sizeBytes: number; kind: string }

function validComponent(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..'
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function invalid(): never {
  return fail('INVALID_PARAMS', 'Invalid artifact metadata or path')
}

function incomplete(): never {
  return fail('EXPERIMENT_EVIDENCE_INCOMPLETE', 'Artifact evidence is missing or does not match its digest')
}

function realHome(home: string): string {
  try { return realpathSync(home) } catch { return invalid() }
}

function ensureDirectory(path: string, root: string): string {
  try {
    mkdirSync(path, { recursive: true })
    const real = realpathSync(path)
    if (!contained(root, real)) return invalid()
    return real
  } catch {
    return invalid()
  }
}

function sameMetadata(a: StoredArtifact, b: StoredArtifact): boolean {
  return a.artifactId === b.artifactId && a.sha256 === b.sha256 && a.kind === b.kind &&
    a.sizeBytes === b.sizeBytes && a.mediaType === b.mediaType && a.engineId === b.engineId &&
    a.storedPath === b.storedPath
}

export class LabArtifacts {
  private readonly home: string

  constructor(home: string, private readonly docs: Docs) {
    this.home = resolve(home)
  }

  put(engineId: string, input: ArtifactInput): { artifactId: string } {
    if (!validComponent(engineId) || !input || typeof input !== 'object' ||
      typeof input.path !== 'string' ||
      typeof input.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.sha256) ||
      typeof input.mediaType !== 'string' || input.mediaType.length === 0 || input.mediaType.length > 128 ||
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_ARTIFACT_BYTES ||
      typeof input.kind !== 'string' || !ARTIFACT_KINDS.has(input.kind)) return invalid()

    const artifactRootPath = join(this.home, 'lab', 'artifacts')
    let sourceRoot: string
    let artifactRoot: string
    let sourcePath: string
    let homeRoot: string
    let withinRoot: boolean
    let regularFile = false
    let declaredSizeMatches = false
    let bytes: Buffer | undefined
    try {
      homeRoot = realpathSync(this.home)
      artifactRoot = realpathSync(artifactRootPath)
      sourceRoot = realpathSync(join(artifactRootPath, engineId))
      sourcePath = realpathSync(resolve(sourceRoot, input.path))
      withinRoot = contained(homeRoot, artifactRoot) && contained(artifactRoot, sourceRoot) && contained(sourceRoot, sourcePath)
      if (withinRoot) {
        const sourceStat = statSync(sourcePath)
        regularFile = sourceStat.isFile()
        declaredSizeMatches = sourceStat.size === input.sizeBytes && sourceStat.size <= MAX_ARTIFACT_BYTES
        if (regularFile && declaredSizeMatches) bytes = readFileSync(sourcePath)
      }
    } catch {
      return incomplete()
    }
    if (!withinRoot || !regularFile) return invalid()
    if (!declaredSizeMatches || !bytes) return incomplete()
    if (bytes.byteLength !== input.sizeBytes || bytes.byteLength > MAX_ARTIFACT_BYTES || sha256Digest(bytes) !== input.sha256) return incomplete()

    const artifactId = `art_${sha256Hex(`${engineId}\n${input.sha256}`)}`
    const storedPath = join('lab', 'artifacts', '_stored', artifactId)
    const artifact: StoredArtifact = {
      artifactId,
      sha256: input.sha256,
      kind: input.kind,
      sizeBytes: bytes.byteLength,
      mediaType: input.mediaType,
      engineId,
      storedPath,
    }
    const previous = this.docs.get<StoredArtifact>(COLL, artifactId)
    if (previous && !sameMetadata(previous, artifact)) return invalid()

    const root = ensureDirectory(artifactRootPath, realHome(this.home))
    const storedDir = ensureDirectory(join(root, '_stored'), root)
    const destination = join(storedDir, artifactId)
    if (previous) {
      const existing = this.read(artifactId)
      if (!existing.equals(bytes)) return incomplete()
      return { artifactId }
    }
    try {
      const fd = openSync(destination, 'wx', 0o600)
      try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return invalid()
      let existing: Buffer | undefined
      let real: string
      let withinRoot = false
      let regularFile = false
      let expectedSize = false
      try {
        real = realpathSync(destination)
        withinRoot = contained(root, real)
        if (withinRoot) {
          const existingStat = statSync(real)
          regularFile = existingStat.isFile()
          expectedSize = existingStat.size === bytes.byteLength && existingStat.size <= MAX_ARTIFACT_BYTES
          if (regularFile && expectedSize) existing = readFileSync(real)
        }
      } catch { return incomplete() }
      if (!withinRoot || !regularFile) return invalid()
      if (!expectedSize || !existing) return incomplete()
      if (!existing.equals(bytes)) return incomplete()
    }
    this.docs.put(COLL, artifactId, artifact)
    return { artifactId }
  }

  get(artifactId: string): StoredArtifact | undefined {
    if (!validComponent(artifactId)) return invalid()
    const artifact = this.docs.get<StoredArtifact>(COLL, artifactId)
    if (!artifact) return undefined
    if (artifact.artifactId !== artifactId || !validComponent(artifact.engineId) ||
      typeof artifact.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256) ||
      !ARTIFACT_KINDS.has(artifact.kind) || !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes < 0 || artifact.sizeBytes > MAX_ARTIFACT_BYTES ||
      typeof artifact.mediaType !== 'string' || artifact.mediaType.length === 0 || artifact.mediaType.length > 128 ||
      artifact.storedPath !== join('lab', 'artifacts', '_stored', artifactId)) return invalid()
    return artifact
  }

  read(artifactId: string): Buffer {
    const artifact = this.get(artifactId)
    if (!artifact) return incomplete()
    const target = resolve(this.home, artifact.storedPath)
    if (!contained(this.home, target)) return invalid()
    let real: string
    let root: string
    let homeRoot: string
    let withinRoot = false
    let regularFile = false
    let expectedSize = false
    let bytes: Buffer | undefined
    try {
      real = realpathSync(target)
      root = realpathSync(join(this.home, 'lab', 'artifacts'))
      homeRoot = realpathSync(this.home)
      withinRoot = contained(homeRoot, root) && contained(root, real)
      if (withinRoot) {
        const storedStat = statSync(real)
        regularFile = storedStat.isFile()
        expectedSize = storedStat.size === artifact.sizeBytes && storedStat.size <= MAX_ARTIFACT_BYTES
        if (regularFile && expectedSize) bytes = readFileSync(real)
      }
    } catch {
      return incomplete()
    }
    if (!withinRoot || !regularFile) return invalid()
    if (!expectedSize) return incomplete()
    if (!bytes) return incomplete()
    if (bytes.byteLength !== artifact.sizeBytes || sha256Digest(bytes) !== artifact.sha256) return incomplete()
    return bytes
  }

  link(experimentId: string, packId: string, artifactIds: string[]): void {
    if (!validComponent(experimentId) || !validComponent(packId) || !Array.isArray(artifactIds) ||
      artifactIds.some((id) => !validComponent(id))) return invalid()
    const uniqueIds = [...new Set(artifactIds)]
    const items = uniqueIds.map((id) => ({ artifact: this.get(id), bytes: this.read(id) }))
    let total = 0
    for (const item of items) {
      if (!item.artifact) return incomplete()
      total += item.artifact.sizeBytes
      if (total > MAX_ARTIFACT_BYTES) return invalid()
    }

    const artifactRootPath = join(this.home, 'lab', 'artifacts')
    const root = ensureDirectory(artifactRootPath, realHome(this.home))
    const experimentDir = ensureDirectory(join(root, experimentId), root)
    const packDir = ensureDirectory(join(experimentDir, packId), root)
    for (const { artifact, bytes } of items) {
      if (!artifact) return incomplete()
      const destination = join(packDir, artifact.artifactId)
      try {
        const fd = openSync(destination, 'wx', 0o600)
        try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return invalid()
        let existing: Buffer | undefined
        let real: string
        let withinRoot = false
        let regularFile = false
        let expectedSize = false
        try {
          real = realpathSync(destination)
          withinRoot = contained(root, real)
          if (withinRoot) {
            const existingStat = statSync(real)
            regularFile = existingStat.isFile()
            expectedSize = existingStat.size === bytes.byteLength && existingStat.size <= MAX_ARTIFACT_BYTES
            if (regularFile && expectedSize) existing = readFileSync(real)
          }
        } catch { return incomplete() }
        if (!withinRoot || !regularFile) return invalid()
        if (!expectedSize || !existing) return incomplete()
        if (!existing.equals(bytes)) return incomplete()
      }
    }
  }
}
