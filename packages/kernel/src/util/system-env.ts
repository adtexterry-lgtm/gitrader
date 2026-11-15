// SPDX-License-Identifier: CPAL-1.0
/** The minimal operating-system environment needed by local child processes. */
export function minimalSystemEnv(): Record<string, string> {
  if (process.platform !== 'win32') return {}

  const { SystemRoot, SystemDrive } = process.env
  const inferredDrive = SystemRoot?.match(/^([A-Za-z]:)(?:[\\/]|$)/)?.[1]
  return {
    ...(SystemRoot ? { SystemRoot } : {}),
    ...(SystemDrive ? { SystemDrive } : inferredDrive ? { SystemDrive: inferredDrive } : {}),
  }
}
