// SPDX-License-Identifier: CPAL-1.0
import { readFileSync } from 'node:fs'
import { makeProblem } from '../proto'
import { KernelError } from './errors'

export type StateFileKind = 'pin' | 'keystore' | 'device-key' | 'install-key'
export type StateFileState = 'missing' | 'ok' | 'corrupt'
export interface StateFileStatus { kind: StateFileKind; state: StateFileState }

export const STATE_FILE_CORRUPT_MESSAGE = 'security state file is corrupt; restore the original file and restart'

export class StateFileReader<T> {
  private previouslyPresent = false
  private corrupted = false

  constructor(private readonly path: string, private readonly kind: StateFileKind, private readonly validate: (value: unknown) => value is T) {}

  private error(): KernelError {
    return new KernelError(makeProblem('STATE_FILE_CORRUPT', STATE_FILE_CORRUPT_MESSAGE))
  }

  latchCorruption(): void { this.corrupted = true }

  read(): T | null {
    if (this.corrupted) throw this.error()

    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
      this.previouslyPresent = true
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && !this.previouslyPresent) return null
      this.previouslyPresent = true
      this.corrupted = true
      throw this.error()
    }

    let value: unknown
    try { value = JSON.parse(raw) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      this.corrupted = true
      throw this.error()
    }
    if (!this.validate(value)) {
      this.corrupted = true
      throw this.error()
    }
    return value
  }

  status(): StateFileStatus {
    try {
      return { kind: this.kind, state: this.read() === null ? 'missing' : 'ok' }
    } catch (error) {
      if (error instanceof KernelError && error.problem.name === 'STATE_FILE_CORRUPT') return { kind: this.kind, state: 'corrupt' }
      throw error
    }
  }
}
