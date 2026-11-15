// SPDX-License-Identifier: CPAL-1.0
// /api/health（免令牌存活探针）里界面要用的两项：产品版本（关于页，跨包契约 K2）与启动器名（K1）。读不到的字段为 undefined。
export interface Health { version?: string; launcher?: string }

export async function readHealth(fetchImpl: typeof fetch = fetch): Promise<Health> {
  const res = await fetchImpl('/api/health', { cache: 'no-store' })
  if (!res.ok) return {}
  const body = (await res.json()) as { version?: unknown; launcher?: unknown }
  return {
    ...(typeof body.version === 'string' && body.version ? { version: body.version } : {}),
    ...(typeof body.launcher === 'string' && body.launcher ? { launcher: body.launcher } : {}),
  }
}
