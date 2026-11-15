// SPDX-License-Identifier: CPAL-1.0
// IB 错误码语义表 + 分类 + Problem 映射 + hint（工单「主题二 · 错误码映射」）。
// 每个码的语义出处写在条目上：`src: 'IB message_codes.html <码>'` 表示 IB 官方错误码表；
// `src: 'ib_async wrapper.py:1609'` 表示参照实现的兜底映射（只写出处，不复制代码）。
// 铁律：
//   · 信息类 / 警告类消息（isNonError）不让挂起请求失败；
//   · 每条 Problem 都带 hint（处理建议），由 IbError.hint 暴露，并同时拼进 Problem.message；
//   · 「结果未知」只在**下单后连接中断且没收到任何回执**时给 3006（不可重试）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'
import { VENUE } from './ids'

export type IbErrorClass = 'info' | 'warning' | 'reject' | 'contract' | 'auth' | 'rate_limit' | 'data' | 'connectivity'

export interface IbErrorInfo {
  code: number
  /** 语义（不翻译上游原文，这里只是分类依据）。 */
  meaning: string
  /** 语义出处：IB 官方码表条目或参照源码行号。 */
  src: string
  cls: IbErrorClass
  problem: ProblemName
}

const E = (code: number, meaning: string, src: string, cls: IbErrorClass, problem: ProblemName): IbErrorInfo =>
  ({ code, meaning, src, cls, problem })

/**
 * 只收录本包会遇到的码；未收录的码一律按 reject（3001）处理并在 message 里保留原文与码号（不猜语义）。
 */
export const IB_ERRORS: Readonly<Record<number, IbErrorInfo>> = {
  // ---- 合约 / 标的 ----
  200: E(200, 'no security definition has been found for the request', 'IB message_codes.html 200', 'contract', 'INSTRUMENT_UNKNOWN'),
  321: E(321, 'error validating request (malformed request)', 'IB message_codes.html 321', 'reject', 'INVALID_PARAMS'),
  // ---- 订单 ----
  201: E(201, 'order rejected - reason: <text>', 'IB message_codes.html 201', 'reject', 'VENUE_REJECTED'),
  202: E(202, 'order cancelled - reason: <text>', 'IB message_codes.html 202', 'reject', 'VENUE_REJECTED'),
  103: E(103, 'duplicate order id', 'IB message_codes.html 103', 'reject', 'VENUE_REJECTED'),
  110: E(110, 'price does not conform to the minimum price variation for this contract', 'IB message_codes.html 110', 'reject', 'PRECISION'),
  111: E(111, 'the TIF and the order type are incompatible', 'IB message_codes.html 111', 'reject', 'INVALID_PARAMS'),
  135: E(135, "can't find order with ID", 'IB message_codes.html 135', 'reject', 'VENUE_REJECTED'),
  161: E(161, 'cancel attempted when order is not in a cancellable state', 'IB message_codes.html 161', 'reject', 'VENUE_REJECTED'),
  399: E(399, 'order message error', 'IB message_codes.html 399', 'warning', 'VENUE_REJECTED'),
  10148: E(10148, 'orderId that needs to be cancelled cannot be cancelled, state: <state>', 'IB message_codes.html 10148', 'reject', 'VENUE_REJECTED'),
  // ---- 连接 / 鉴权 ----
  326: E(326, 'unable to connect as the client id is already in use; retry with a unique client id', 'IB message_codes.html 326', 'auth', 'VENUE_AUTH'),
  502: E(502, "couldn't connect to TWS; confirm that 'Enable ActiveX and Socket Clients' is checked", 'IB message_codes.html 502', 'connectivity', 'VENUE_UNAVAILABLE'),
  504: E(504, 'not connected (TWS / gateway is not reachable or the API is disabled)', 'IB message_codes.html 504', 'connectivity', 'VENUE_UNAVAILABLE'),
  1100: E(1100, 'connectivity between IB and TWS has been lost', 'IB message_codes.html 1100', 'connectivity', 'VENUE_UNAVAILABLE'),
  1300: E(1300, 'TWS socket port has been reset and this connection is being dropped', 'IB message_codes.html 1300', 'connectivity', 'VENUE_UNAVAILABLE'),
  // 1101 / 1102 是恢复通知：1101 数据丢失要重同步，1102 数据保持；两者都不是错误。
  1101: E(1101, 'connectivity restored - data lost（恢复但数据丢失，必须重同步）', 'IB message_codes.html 1101', 'info', 'VENUE_UNAVAILABLE'),
  1102: E(1102, 'connectivity restored - data maintained（恢复且数据保持）', 'IB message_codes.html 1102', 'info', 'VENUE_UNAVAILABLE'),
  // ---- 限流 ----
  100: E(100, 'max rate of messages per second has been exceeded', 'IB message_codes.html 100', 'rate_limit', 'VENUE_RATE_LIMITED'),
  101: E(101, 'max number of tickers has been exceeded', 'IB message_codes.html 101', 'rate_limit', 'VENUE_RATE_LIMITED'),
  // ---- 行情权限 ----
  354: E(354, 'requested market data is not subscribed (no market data permission)', 'IB message_codes.html 354', 'data', 'VENUE_UNAVAILABLE'),
  10197: E(10197, 'no market data during competing live session', 'IB message_codes.html 10197', 'data', 'VENUE_UNAVAILABLE'),
  10167: E(10167, 'requested market data is not subscribed; displaying delayed market data', 'ib_async wrapper.py:1602', 'info', 'VENUE_UNAVAILABLE'),
  // ---- 警告 / 信息类（isNonError；不让挂起请求失败）----
  105: E(105, 'order being modified does not match original order', 'IB message_codes.html 105', 'warning', 'VENUE_REJECTED'),
  165: E(165, 'historical market data service query message', 'IB message_codes.html 165', 'warning', 'VENUE_UNAVAILABLE'),
  329: E(329, 'order modify failed; cannot change to the new order type', 'ib_async wrapper.py:1597', 'warning', 'VENUE_REJECTED'),
  404: E(404, 'shares for this order are not immediately available for short sale; the order is held while IB attempts to locate shares', 'IB message_codes.html 404', 'warning', 'VENUE_REJECTED'),
  434: E(434, 'the order size cannot be zero', 'IB message_codes.html 434', 'warning', 'VENUE_REJECTED'),
  492: E(492, 'not listed in the IB message code table; treated as a warning by ib_async', 'ib_async wrapper.py:1601', 'warning', 'VENUE_REJECTED'),
  2103: E(2103, 'a market data farm is disconnected', 'IB message_codes.html 2103', 'warning', 'VENUE_UNAVAILABLE'),
  2104: E(2104, 'market data farm connection is OK', 'IB message_codes.html 2104', 'info', 'VENUE_UNAVAILABLE'),
  2106: E(2106, 'a historical data farm is connected', 'IB message_codes.html 2106', 'info', 'VENUE_UNAVAILABLE'),
  2107: E(2107, 'a historical data farm connection has become inactive but should be available upon demand', 'IB message_codes.html 2107', 'info', 'VENUE_UNAVAILABLE'),
  2108: E(2108, 'market data farm connection is inactive but should be available upon demand', 'IB message_codes.html 2108', 'info', 'VENUE_UNAVAILABLE'),
  2109: E(2109, 'order event warning: attribute "Outside Regular Trading Hours" is ignored based on the order type and destination; PlaceOrder is now processed', 'IB message_codes.html 2109', 'warning', 'VENUE_UNAVAILABLE'),
  2137: E(2137, 'cross side warning: the order would change the position from long to short or from short to long', 'IB message_codes.html 2137', 'warning', 'VENUE_REJECTED'),
  2158: E(2158, 'sec-def data farm connection is OK', 'IB message_codes.html 2158', 'info', 'VENUE_UNAVAILABLE'),
}

const INFO_CODES = new Set([2104, 2106, 2107, 2108, 2158, 1101, 1102, 10167])
const WARNING_CODES = new Set([105, 165, 329, 399, 404, 434, 492])

/** 信息 / 警告类：不让挂起请求失败，IbErrorEvent.info = true。 */
export function isNonError(code: number): boolean {
  if (INFO_CODES.has(code) || WARNING_CODES.has(code)) return true
  if (code >= 2100 && code <= 2199) return true
  return false
}

/** 信息类 / 提示类码（保留旧名字；只判 cls === 'info'）。 */
export function isInformational(code: number): boolean {
  const info = IB_ERRORS[code]
  return info !== undefined && info.cls === 'info'
}

export function errorInfoOf(code: number): IbErrorInfo | undefined {
  return IB_ERRORS[code]
}

/** 连接是否已被 TWS 视为断开（1100 / 1300 / 504 / 502 一类）。 */
export function isConnectionLost(code: number): boolean {
  return code === 1100 || code === 1300 || code === 504 || code === 502
}

export interface HintedProblem {
  problem: Problem
  hint: string
  cls: IbErrorClass
}

function hintFor(code: number): string {
  switch (code) {
    case 326:
      return 'clientId 冲突：IB 官方码表 326 表示已有连接占用该 id，新连接被拒；换一个未被占用的 id 再连（自动化 7、手动 1），本包不抢连'
    case 502:
      return 'TWS / IB Gateway 没在监听：确认它已启动并登录，API 设置里勾选 Enable ActiveX and Socket Clients，端口与模式对应（模拟 TWS 7497 / Gateway 4002）'
    case 504:
      return '当前连接未建立：先 connect()；若刚才断过线，恢复后按 orderRef 查挂单与成交对账，不要重发订单'
    case 1100:
      return 'TWS 与 IB 后台断开：等 1101/1102 恢复通知后重同步挂单与持仓；这段时间内已发出但无回执的订单按 3006 处理'
    case 1300:
      return 'TWS / IB Gateway 的 socket 端口被重置（进程重启）：重连后按 orderRef 对账，不要重发订单'
    case 100:
      return '达到 IB 每秒消息上限（50 条/秒）：退避 1 秒后重发只读请求，订单不要自动重发'
    case 354:
      return '无该标的的行情权限：市价意图需要参考价，缺参考价一律拒单；订阅行情或改用限价单'
    case 200:
      return '合约不存在或写法不对：美股用裸 ticker（AAPL），交易所 SMART、币种 USD'
    case 110:
      return '价格不符合该合约的最小变动单位：按 contractDetails 的 minTick 规整后再发'
    case 111:
      return 'TIF 与单型不兼容：换一个可组合的 TIF / 单型（例：IOC 只能配限价类单）'
    case 135:
      return '撤单目标在场所不存在（可能已成交 / 已撤）：先按 orderRef 查挂单与成交，再决定是否重试'
    case 161:
      return '订单不处于可撤状态：先查订单状态；已终结的单不需要再撤'
    case 201:
    case 202:
      return '场所拒单 / 撤单：看 venue.message 原文（常见为资金不足、账户限制、时段限制），本包不做任何绕开限制的处理'
    default:
      return '未收录的 IB 错误码：按拒单处理，venue.message 保留 IB 原文与码号供人工判断'
  }
}

/** IB 码 → 协议 Problem（带 hint）。code 未收录 → 3001 VENUE_REJECTED，原文照抄。 */
export function problemForIbError(code: number, upstreamMessage: string, reqId = -1): HintedProblem {
  const info = IB_ERRORS[code]
  const cls: IbErrorClass = info?.cls ?? 'reject'
  const name: ProblemName = info?.problem ?? 'VENUE_REJECTED'
  const hint = hintFor(code)
  const summary = `IBKR ${code}: ${info?.meaning ?? 'unclassified error'}${reqId >= 0 ? ` (reqId ${String(reqId)})` : ''}. 处理：${hint}`
  return {
    problem: makeProblem(name, summary, { venue: { id: VENUE, code, message: upstreamMessage } }),
    hint,
    cls,
  }
}

/** 连接器自己抛的错：Problem + hint + IB 码（代码里 catch 到它按 problem 处理）。 */
export class IbError extends Error {
  constructor(
    readonly problem: Problem,
    readonly hint: string,
    readonly ibCode?: number,
  ) {
    super(problem.message)
    this.name = 'IbError'
  }

  static of(name: ProblemName, message: string, hint: string, extra: Partial<Problem> = {}): IbError {
    return new IbError(makeProblem(name, `${message}. 处理：${hint}`, extra), hint)
  }
}

/** 未收录码的兜底也走这里（与 problemForIbError 一致，便于测试断言）。 */
export function unknownIbError(code: number, message: string): HintedProblem {
  return problemForIbError(code, message)
}
