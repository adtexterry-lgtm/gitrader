// SPDX-License-Identifier: CPAL-1.0
import type { ComponentChildren, ComponentProps, ComponentType } from 'preact'
import { ErrText, InlineConfirm, Skeleton } from '@gitrader/workbench/ui'
import { defineBlock, type BlockDefinition, type BlockProps } from '@gitrader/blocks-sdk'
import hyperliquidSource from './logos/hyperliquid.png' with { type: 'bytes' }
import binanceSource from './logos/binance.svg'
import okxSource from './logos/okx.svg'
import bitgetSource from './logos/bitget-mark.png' with { type: 'bytes' }
import coinbaseSource from './logos/coinbase.svg'
import htxSource from './logos/htx.png' with { type: 'bytes' }
import dydxSource from './logos/dydx.png' with { type: 'bytes' }
import krakenSource from './logos/kraken.png' with { type: 'bytes' }
import kucoinSource from './logos/kucoin.svg'
import deribitSource from './logos/deribit.png' with { type: 'bytes' }
import alpacaSource from './logos/alpaca.svg'
import ibkrSource from './logos/ibkr.svg'
import twelvedataSource from './logos/twelvedata.svg'
import claudeSource from './logos/claude.svg'
import openaiSource from './logos/openai.svg'
import { t } from '@gitrader/workbench/i18n'

export { Skeleton }

export interface CardProps extends Record<string, unknown> {
  title?: ComponentChildren
  head?: ComponentChildren
  stale?: boolean
  children?: ComponentChildren
  className?: string
}
export function Card({ title, head, stale, children, className = '', ...data }: CardProps) {
  return <section className={['g5-card', className].filter(Boolean).join(' ')} {...data} data-g5="card">
    {head ?? <CardHead title={title} stale={stale} />}
    {stale && head ? <StaleSlot /> : null}
    {children}
  </section>
}

function StaleSlot() {
  return <span className="g5-stale" data-g5="stale" aria-label={t('数据过期')} />
}

export interface CardHeadProps {
  title?: ComponentChildren
  children?: ComponentChildren
  right?: ComponentChildren
  stale?: boolean
}
export function CardHead({ title, children, right, stale }: CardHeadProps) {
  return <header className="g5-hd">
    <h2>{title ?? children}</h2>
    {right != null ? <div className="g5-r">{right}</div> : null}
    {stale ? <StaleSlot /> : null}
  </header>
}

export interface VenueIconProps extends Record<string, unknown> {
  venue: string
  label?: string
  size?: 'sm' | 'md' | 'lg'
}

type VenueAssetSource = Uint8Array | string
type VenueVariant = 'hyperliquid' | 'okx' | 'htx' | 'light' | 'full' | 'dark'
type VenueAsset = { file: string | null; source: VenueAssetSource | null; variant: VenueVariant }

function toImageUrl(source: VenueAssetSource): string {
  if (source instanceof Uint8Array) {
    let binary = ''
    for (const byte of source) binary += String.fromCharCode(byte)
    return `data:image/png;base64,${btoa(binary)}`
  }
  return source.includes('<svg')
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
    : source
}

export const VENUE_ICON_MAP = {
  hyperliquid: { file: 'hyperliquid.png', source: hyperliquidSource, variant: 'hyperliquid' },
  binance: { file: 'binance.svg', source: binanceSource, variant: 'dark' },
  okx: { file: 'okx.svg', source: okxSource, variant: 'okx' },
  bitget: { file: 'bitget-mark.png', source: bitgetSource, variant: 'dark' },
  coinbase: { file: 'coinbase.svg', source: coinbaseSource, variant: 'light' },
  htx: { file: 'htx.png', source: htxSource, variant: 'htx' },
  dydx: { file: 'dydx.png', source: dydxSource, variant: 'full' },
  kraken: { file: 'kraken.png', source: krakenSource, variant: 'full' },
  kucoin: { file: 'kucoin.svg', source: kucoinSource, variant: 'full' },
  deribit: { file: 'deribit.png', source: deribitSource, variant: 'light' },
  alpaca: { file: 'alpaca.svg', source: alpacaSource, variant: 'full' },
  ibkr: { file: 'ibkr.svg', source: ibkrSource, variant: 'light' },
  twelvedata: { file: 'twelvedata.svg', source: twelvedataSource, variant: 'light' },
  bybit: { file: null, source: null, variant: 'dark' },
  gate: { file: null, source: null, variant: 'dark' },
  alphavantage: { file: null, source: null, variant: 'dark' },
  finnhub: { file: null, source: null, variant: 'dark' },
  polygon: { file: null, source: null, variant: 'dark' },
} satisfies Record<string, VenueAsset>

export function VenueIcon({ venue, label, size = 'sm', ...props }: VenueIconProps) {
  const normalizedVenue = venue.toLowerCase() as keyof typeof VENUE_ICON_MAP
  const asset = Object.hasOwn(VENUE_ICON_MAP, normalizedVenue) ? VENUE_ICON_MAP[normalizedVenue] : undefined
  const imageUrl = asset?.source == null ? null : toImageUrl(asset.source)
  const sizeClass = size === 'md' ? 'g5-m' : size === 'lg' ? 'g5-l' : ''
  const venueClass = imageUrl && asset ? `g5-v-${asset.variant}` : 'g5-v-init'
  const initial = venue.charAt(0).toUpperCase() || '?'
  const { className, ...forwardedProps } = props
  const attributes: ComponentProps<'span'> & { size: VenueIconProps['size'] } = {
    ...forwardedProps,
    className: ['g5-vchip', typeof className === 'string' ? className : ''].filter(Boolean).join(' '),
    size,
  }
  return <span {...attributes} data-g5="venue" data-size={size}>
    <span className={['g5-venue', sizeClass, venueClass].filter(Boolean).join(' ')} aria-hidden="true">
      {imageUrl ? <img src={imageUrl} alt="" /> : <b>{initial}</b>}
    </span>
    <span className="g5-vn">{label ?? venue}</span>
  </span>
}

export function wireState(err: unknown): 'off' | 'error' {
  if (typeof err !== 'object' || err === null || Array.isArray(err)) return 'error'
  const value = err as Record<string, unknown>
  // Shapes come from workbench/src/core/host-api.ts (isMethodMissing), src/model-config.ts (Normalized), and src/model-lab.ts (LabShapeError).
  if (value.code === -32601) return 'off'
  if (value.ok === false && typeof value.missing === 'string' && value.missing.length > 0) return 'off'
  if (value.name === 'LabShapeError' && typeof value.field === 'string' && value.field.length > 0) return 'off'
  return 'error'
}

/** 空态 = 一行事实 + 最多一个去处钮（DESIGN-SYSTEM 第 15 条；稿里的 `.msg`）。description 同行排在后面，12px 三级灰。 */
export function Empty({ message, description, children }: { message: string; description?: string; children?: ComponentChildren }) {
  return <div className="g5-emp" data-state="empty">
    <span>{message}</span>
    {description ? <span className="g5-src" title={description}>{description}</span> : null}
    {children}
  </div>
}

export function Offline({ children }: { children?: ComponentChildren }) {
  return <div className="g5-off" data-state="offline">{children}</div>
}

export interface ActorProps {
  kind: 'human' | 'engine' | 'system' | 'agent'
  name: string
  logo?: string
}
// Agent 档只认登记过的官方原件（src/logos/SOURCES.md）；名字匹配不到的走中性圆占位，不猜、不画。OpenAI 小标要反相裁切，所以带厂商类（见 components.css）。
const AGENT_LOGOS = [
  { match: /claude|anthropic/i, source: claudeSource, provider: 'g5-provider-b' },
  { match: /codex|openai|gpt/i, source: openaiSource, provider: 'g5-provider-a' },
] as const
export function Actor({ kind, name, logo }: ActorProps) {
  if (kind === 'agent') {
    const brand = AGENT_LOGOS.find((entry) => entry.match.test(name))
    const src = logo ?? (brand ? toImageUrl(brand.source) : null)
    return <span className="g5-actor" data-actor="agent">
      {src
        ? <span className={['g5-alogo', logo ? '' : brand?.provider].filter(Boolean).join(' ')}><img src={src} alt="" width={15} height={15} /></span>
        : <span className="g5-mk g5-agent" aria-hidden="true" />}{name}
    </span>
  }
  const markClass = kind === 'human' ? 'g5-human' : `g5-${kind}`
  const mark = kind === 'human'
    ? <svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="3.1" r="1.9" /><path d="M1.6 9.1c.35-2.05 1.7-3.25 3.4-3.25s3.05 1.2 3.4 3.25z" /></svg>
    : kind === 'engine'
      ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6L8.4 5 5 8.4 1.6 5z" /></svg>
      : <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.1l3.5 1.35v2.4c0 2.15-1.45 3.7-3.5 4.4-2.05-.7-3.5-2.25-3.5-4.4v-2.4z" /></svg>
  return <span className="g5-actor"><span className={`g5-mk ${markClass}`}>{mark}</span>{name}</span>
}

export function Unwired({ message = '' }: { message?: string }) {
  return <div data-wire="off"><span className="g5-t3">{t('未接通')}</span><span className="g5-msg">{message}</span></div>
}

/** 行内报错（ux-fix2 B2）：上游原文 / 错误码收进可展开、可复制的「详情」，中文界面正文不出英文原文。bare：前面已有「读取失败」标签时不再补通用人话。 */
export function ErrorText({ message, bare = false }: { message: string; bare?: boolean }) {
  return <span className="g5-msg"><ErrText text={message} bare={bare} /></span>
}

export function Amount({ value, tone = 'neutral' }: { value: string; tone?: 'up' | 'down' | 'neutral' }) {
  const className = tone === 'up' ? 'g5-up' : tone === 'down' ? 'g5-down' : 'g5-tb'
  return <span className={className}>{value}</span>
}

export function ArmRow(props: Record<string, unknown>) {
  return <div className="g5-armed"><InlineConfirm {...props as any} /></div>
}

export function StubBlockView({ page, title }: { page: string; title: string }) {
  return <div data-page={page} data-g5-page={page}><Card title={title} data-page={page} data-g5-page={page}><Unwired message={t('此页面尚未接通')} /></Card></div>
}

export function createStubBlock(id: string, page: string, title: string, render?: (props: BlockProps) => ComponentChildren): BlockDefinition {
  const slug = id.replace(/[^a-z0-9-]+/g, '-')
  const component: ComponentType<BlockProps> = render ?? (() => <StubBlockView page={page} title={title} />)
  return defineBlock({
    manifest: {
      schema: 'gitrader-block/1',
      id: `block.gitrader.${slug}`,
      name: title,
      version: '0.1.0',
      vendor: { name: 'gitrader' },
      license: 'CPAL-1.0',
      entry: { module: './index.js', element: `g5-${slug}` },
      isolation: 'inline',
      size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
      permissions: [],
      fixtures: [`./fixtures/${page}.ts`],
    },
    component,
  })
}
