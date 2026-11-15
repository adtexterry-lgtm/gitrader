// SPDX-License-Identifier: CPAL-1.0
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('attribution', () => {
  it('attribution has wordmark, text and project link', () => {
    const src = source('../src/shell/Attribution.jsx')
    expect(src).toContain('Wordmark')
    expect(src).toContain('Powered by')
    expect(src).toContain('href={ATTRIBUTION_HREF}')
    expect(src).toContain('target="_blank"')
    expect(src).toContain('rel="noopener"')
  })

  it('shell mounts attribution on startup and dead card', () => {
    const src = source('../src/shell/Shell.jsx')
    expect(src).toContain("from './Attribution.jsx'")
    expect(src.match(/<Attribution\s*\/>/g)?.length ?? 0).toBe(2)
  })
})
