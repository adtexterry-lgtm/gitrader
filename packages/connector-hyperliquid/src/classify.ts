// SPDX-License-Identifier: CPAL-1.0
// 标的分类（搬自 早期 Demo 原型 src/market/catalog.ts 的 classify，去掉中文名与 UI 分组）。
// 默认 dex 全是 crypto（SPX 归 indices）；构建者 dex 靠显式映射表，其余大写代码默认 stocks。
// 来源是实测的 dex 清单，会过期：未命中时落到 stocks 是已知近似，分类只用于筛选，不影响交易。
import type { AssetClass } from '@gitrader/protocol'

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean))
const METALS = set('GOLD SILVER PLATINUM PALLADIUM COPPER GOLDJM SILVERJM')
const COMMODITIES = set('OIL USOIL WTI GAS WHEAT SOY CL BRENTOIL WTIOIL NATGAS HO CORN TTF URANIUM ALUMINIUM')
const FX = set('EUR JPY GBP KRW DXY')
const RATES = set('USBOND 10Y 30Y 2Y TLT')
const INDICES = set('US500 USA500 USTECH USA100 XYZ100 JPN225 SMALL2000 TOTAL2 OTHERS BTCD SPX SP500 KR200 JP225 EWY EWJ EWT EWZ KORU BVIV VIX')
const SECTORS = set('MAG7 SEMIS SEMI ROBOT INFOTECH NUCLEAR DEFENSE ENERGY BIOTECH USENERGY GLDMINE SMH XLE XBI SOXL MAGS URNM IGV DRAM GDX KWEB')
const PRIVATE = set('SPACEX OPENAI ANTHROPIC OAI ANTH UNITREE CAMBRICON CXMT SPCX OURA SHEIN')
const CRYPTO_ON_BUILDER_DEX = set('BTC ETH SOL HYPE XRP BNB DOGE LTC LINK ADA SUI XMR ZEC BCH ENA PUMP FARTCOIN LIT LIGHTER XPL IP 1000PEPE BASED USDE')

export function classify(dex: string, base: string): AssetClass {
  const b = base.toUpperCase()
  if (PRIVATE.has(b)) return 'private'
  if (dex === '') return b === 'SPX' ? 'indices' : 'crypto'
  if (METALS.has(b)) return 'metals'
  if (COMMODITIES.has(b)) return 'commodities'
  if (FX.has(b)) return 'fx'
  if (RATES.has(b)) return 'rates'
  if (INDICES.has(b)) return 'indices'
  if (SECTORS.has(b)) return 'sectors'
  if ((dex === 'hyna' || dex === 'cash') && CRYPTO_ON_BUILDER_DEX.has(b)) return 'crypto'
  return 'stocks'
}

/** `xyz:TSLA` → { dex:'xyz', base:'TSLA' }；`BTC` → { dex:'', base:'BTC' }。 */
export function splitSymbol(symbol: string): { dex: string; base: string } {
  const i = symbol.indexOf(':')
  return i > 0 ? { dex: symbol.slice(0, i), base: symbol.slice(i + 1) } : { dex: '', base: symbol }
}
