// SPDX-License-Identifier: Apache-2.0

export type SecurityStateFile = 'pin' | 'keystore' | 'device-key' | 'install-key' | 'paper-state'

export interface SecurityStateFileStatus {
  kind: SecurityStateFile
  state: 'missing' | 'ok' | 'corrupt'
}

export interface SecurityStateHealth {
  ok: boolean
  files: SecurityStateFileStatus[]
  recoveryRequired: boolean
}
