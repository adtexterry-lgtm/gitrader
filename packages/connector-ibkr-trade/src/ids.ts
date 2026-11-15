// SPDX-License-Identifier: CPAL-1.0
// IBKR 场所标识、端口 / 环境对应表、clientId 规则、回环限制的单一出处。
// 抄作业（只抄流程与校验，代码自写）：QD backend_api_python/app/services/ibkr_trading/
//   · 端口表：README.md:13-18 — TWS 实盘 7496 / 模拟 7497；IB Gateway 实盘 4001 / 模拟 4002。
//   · clientId：README.md:30-37 — 一个 clientId 只允许一条 API 连接，后连者踢掉先连者（表现为随机断线）；
//     手动操作固定 1，自动化 / 策略固定 7（client.py:60 的缺省 1 只给管理端自测用）。
//   · 合约归一：symbols.py:9-24 — normalize_symbol('AAPL','USStock') → ('AAPL','SMART','USD')；
//     format_display_symbol 原样返回 ticker（client.py:636）。
// 红线：只连回环地址（工单「主题二 · 形态」），非回环在构造时拒绝；不走 Client Portal Web API。
import type { Environment } from '@gitrader/protocol/connector'

export const VENUE = 'ibkr' as const

/** 用户配置的环境（工单用词）：paper = 模拟盘，live = 实盘。协议 Environment 只有 mainnet / testnet。 */
export type IbkrMode = 'paper' | 'live'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_CLIENT_ID = 7
/** 手动 / 管理端自测用（QD clientId=1）。自动化一律 7，两者不许共用。 */
export const MANUAL_CLIENT_ID = 1
export const AUTOMATION_CLIENT_ID = 7

export type IbkrGateway = 'tws' | 'gateway'

/** QD ibkr_trading/README.md:13-18 的端口表；模拟 / 实盘端口不重叠，混用能在构造时查出来。 */
export const IB_PORTS: Readonly<Record<IbkrGateway, Readonly<Record<IbkrMode, number>>>> = {
  tws: { paper: 7497, live: 7496 },
  gateway: { paper: 4002, live: 4001 },
}

/** 缺省只连模拟盘（工单「美股八条」第 7 条：默认只用模拟端口）。 */
export const DEFAULT_GATEWAY: IbkrGateway = 'tws'
export const DEFAULT_MODE: IbkrMode = 'paper'

/** paper → testnet，live → mainnet（协议 Environment 只有这两个值）。 */
export function environmentOf(mode: IbkrMode): Environment {
  return mode === 'live' ? 'mainnet' : 'testnet'
}

export function modeOf(environment: Environment): IbkrMode {
  return environment === 'mainnet' ? 'live' : 'paper'
}

/** 允许的回环写法：127.0.0.0/8、::1、localhost（大小写不敏感）。其余一律拒绝。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m === null) return false
  return m.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255)
}

/** 端口 ↔ 环境对应：给定端口能否出现在该环境的 TWS / Gateway 端口表里。 */
export function portMatchesMode(port: number, mode: IbkrMode): boolean {
  return IB_PORTS.tws[mode] === port || IB_PORTS.gateway[mode] === port
}

/** 端口属于哪个环境的哪类网关；不认识 → undefined（自定义端口，simulate / 假服务器用）。 */
export function gatewayOfPort(port: number): { gateway: IbkrGateway; mode: IbkrMode } | undefined {
  for (const gateway of ['tws', 'gateway'] as const) {
    for (const mode of ['paper', 'live'] as const) {
      if (IB_PORTS[gateway][mode] === port) return { gateway, mode }
    }
  }
  return undefined
}

/** 标的 id：`ibkr:AAPL`（与数据包 / 内核同一形状）。 */
export function instrumentIdOf(symbol: string): string {
  return `${VENUE}:${symbol.trim().toUpperCase()}`
}

/** 从 id 或裸 symbol 取 IB 原生 ticker（STK/SMART/USD）。 */
export function symbolOf(id: string): string {
  const s = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
  return s.trim().toUpperCase()
}

export function isInstrumentIdOfVenue(id: string): boolean {
  return id.startsWith(`${VENUE}:`)
}
