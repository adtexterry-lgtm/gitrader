// SPDX-License-Identifier: Apache-2.0
export function generateSchemas(): Promise<Map<string, string>>
export function renderRegistry(fileNames: Iterable<string>): string
export function loadConstants(): Promise<Record<string, unknown>>
