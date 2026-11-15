// SPDX-License-Identifier: CPAL-1.0
import type { FeedState } from '@gitrader/workbench'
import { useFeedState, useNow } from './hooks'
import { t } from '@gitrader/workbench/i18n'

export function feedAge(ts: number | undefined, now: number): string {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return t('时间未知')
  const seconds = Math.max(0, Math.floor((now - ts) / 1000))
  return t('{0}:{1} 前', String(Math.floor(seconds / 60)).padStart(2, '0'), String(seconds % 60).padStart(2, '0'))
}

export function FeedNotice({ markTs, feed, now }: { markTs?: number; feed: FeedState; now: number }) {
  const old = markTs !== undefined && now - markTs > 5000
  if (feed === 'live' && !old) return null
  return <span className="gb-feed-age" data-feed-stale="" role="status">{feed !== 'live' ? t('行情中断 · {0}', feedAge(markTs, now)) : t('陈旧')}</span>
}

/** Also works in the legacy table without requiring a shell-specific row shape. */
export function MarkFreshness({ markTs }: { markTs?: number }) {
  return <FeedNotice markTs={markTs} feed={useFeedState()} now={useNow()} />
}
