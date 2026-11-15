// SPDX-License-Identifier: CPAL-1.0
import type { PluginManifest } from './proto'
import { makeProblem } from './proto'
import { KernelError } from './util/errors'

/** Only declared names are resolved. Resolver exceptions never cross the host boundary. */
export function pluginSecretEnv(
  manifest: PluginManifest,
  handles: Record<string, string> = {},
  resolveSecret?: (ref: string) => string | undefined,
  warn: (message: string) => void = () => {},
): Record<string, string> {
  const declared = new Set(manifest.secrets ?? [])
  const env: Record<string, string> = Object.create(null)
  for (const name of Object.keys(handles)) if (!declared.has(name)) warn(`plugin ${manifest.id}: ignored undeclared secret name ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '[invalid name]'}`)
  for (const name of declared) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === 'GITRADER_GSP_TOKEN' || name === '__proto__') {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'plugin secret name is invalid or reserved'))
    }
    const missing = (): never => { throw new KernelError(makeProblem('INVALID_PARAMS', `missing secret handle: ${name}`)) }
    const handle = Object.hasOwn(handles, name) ? handles[name] : undefined
    if (!handle || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(handle)) missing()
    let value: string | undefined
    try { value = resolveSecret?.(handle!) } catch { missing() }
    if (typeof value !== 'string' || !value) missing()
    env[name] = value!
    if (value!.length < 8) warn(`short secret excluded from frame scan: ${name}`)
  }
  return env
}

/** Check complete JSON frames, including escaped and commonly encoded values. */
export function containsPluginSecret(frame: unknown, values: readonly string[] = []): boolean {
  if (!values.length) return false
  const text = JSON.stringify(frame)
  return values.some(value => value.length >= 8 && [JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'), encodeURIComponent(value)]
    .some(form => form.length > 0 && text.includes(form)))
}
