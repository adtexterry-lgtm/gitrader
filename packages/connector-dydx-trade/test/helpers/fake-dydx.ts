// SPDX-License-Identifier: CPAL-1.0
// 假的 dYdX 链节点 + Indexer。独立实现（教训 8）：
//   · 用 node:crypto 的 verify 独立验签、用 ripemd160(sha256(压缩公钥)) 自己算地址（不复用 src 的 keys / bech32 / keccak）；
//   · 用 test/helpers/tlv.ts 的独立 TLV 读取器解 TxRaw，按官方 proto 的字段表取字段；
//   · 复算「签名域」SignDoc，并要求 broadcaster 送来的 chain_id / account_number / sequence 与账本一致；
//   · 校验 quantums % stepBaseQuantums == 0、subticks % subticksPerTick == 0、client_metadata ≤ 127、
//     OrderId.owner 等于签名公钥派生的地址（不一致 → failures + code 4）、短单带块高、长单带 fixed32 时间戳；
//   · 只接受 POST /cosmos/tx/v1beta1/txs 上的 MsgPlaceOrder / MsgCancelOrder，方法不对回 405；
//   · 只支持 BROADCAST_MODE_SYNC / ASYNC，BLOCK 回 HTTP 500（cosmos-sdk v0.50 的行为）；
//   · 序列号：短单不消耗，长单 / 长单撤单在 code 0 时才 +1。
import { createHash, createPublicKey, verify } from 'node:crypto'
import type { FetchLike, FetchResponseLike } from '../../src/client'
import { hex, maybe, one, walk } from './tlv'

export interface FakeMarket {
  clobPairId: number
  atomicResolution: number
  quantumConversionExponent: number
  stepBaseQuantums: number
  subticksPerTick: number
  oraclePrice: string
  tickSize: string
  stepSize: string
  status?: string
}

export interface FakeOrderRecord {
  clientId: number
  clobPairId: number
  orderFlags: number
  side: string
  quantums: bigint
  subticks: bigint
  goodTilBlock?: bigint
  goodTilBlockTime?: bigint
  tif: number
  reduceOnly: boolean
  clientMetadata: number
  conditionType: number
  triggerSubticks: bigint
  owner: string
}

export interface FakeTx {
  txHash: string
  messages: Array<{ typeUrl: string; body: Uint8Array }>
  orders: FakeOrderRecord[]
  cancels: Array<{ clientId: number; clobPairId: number; orderFlags: number; goodTilBlock?: bigint; blockTime?: bigint }>
  chainId: string
  accountNumber: number
  sequence: number
  pubKey: Uint8Array
  signature: Uint8Array
  feeGas: number
  feeAmounts: Array<{ denom: string; amount: string }>
  authenticators: Uint8Array | undefined
}

export interface FakeOptions {
  chainId: string
  accountNumber: number
  height: number
  sequence: number
  markets?: Record<string, FakeMarket>
  subaccount?: Record<string, unknown>
  orders?: unknown[]
  fills?: unknown[]
  positions?: unknown[]
  /** 下一次广播回这个 ABCI code（默认 0）；用一次后清空。 */
  nextCode?: number
  nextRawLog?: string
  /** 广播直接抛网络错误（模拟断连）。 */
  failNetwork?: boolean
  /**
   * 下一次广播的 200 响应体**原样**回这个（不写 tx_response 里能读懂的字段）。
   * 用来复现「HTTP 200 但回执不可读」（缺 tx_response / 缺 txhash）。
   */
  nextTxResponse?: unknown
  /** 账户 JSON 形状：平铺 BaseAccount（缺省）或 vesting 多包一层。 */
  accountShape?: 'flat' | 'vesting'
}

export class FakeDydx {
  readonly requests: Array<{ method: string; url: string; body?: string }> = []
  readonly txs: FakeTx[] = []
  readonly failures: string[] = []
  opts: FakeOptions
  readonly fetchImpl: FetchLike

  constructor(opts: FakeOptions) {
    this.opts = opts
    this.fetchImpl = async (url, init) => this.#handle(url, init)
  }

  /** 最近一笔记账交易。 */
  get lastTx(): FakeTx | undefined {
    return this.txs[this.txs.length - 1]
  }

  #handle = async (url: string, init?: { method?: string; body?: string }): Promise<FetchResponseLike> => {
    const method = init?.method ?? 'GET'
    this.requests.push({ method, url, ...(init?.body === undefined ? {} : { body: init.body }) })
    const path = new URL(url).pathname
    const query = new URL(url).searchParams

    if (method === 'POST' && path === '/cosmos/tx/v1beta1/txs') {
      if (this.opts.failNetwork === true) throw new Error('socket hang up')
      const body = JSON.parse(init?.body ?? '{}') as { tx_bytes?: string; mode?: string }
      return this.#broadcast(body)
    }
    if (method === 'GET' && path.startsWith('/cosmos/base/tendermint/v1beta1/blocks/latest')) {
      return json(200, { block: { header: { height: String(this.opts.height) } } })
    }
    if (method === 'GET' && path.startsWith('/cosmos/auth/v1beta1/accounts/')) {
      const base = { account_number: String(this.opts.accountNumber), sequence: String(this.opts.sequence) }
      // 官方 BaseAccount 的 JSON 是平铺（account.account_number / account.sequence）；vesting 多包一层
      if (this.opts.accountShape === 'vesting') {
        return json(200, { account: { '@type': '/cosmos.vesting.v1beta1.ContinuousVestingAccount', base_vesting_account: { base_account: base } } })
      }
      return json(200, { account: { '@type': '/cosmos.auth.v1beta1.BaseAccount', ...base } })
    }
    if (method === 'GET' && path === '/v4/perpetualMarkets') {
      const markets: Record<string, unknown> = {}
      for (const [ticker, m] of Object.entries(this.opts.markets ?? {})) {
        markets[ticker] = { ...m, status: m.status ?? 'ACTIVE', tickSize: m.tickSize, stepSize: m.stepSize }
      }
      return json(200, { markets })
    }
    if (method === 'GET' && /^\/v4\/addresses\/[^/]+\/subaccountNumber\/\d+$/.test(path)) {
      if (this.opts.subaccount === undefined) return json(404, { errors: [{ msg: 'subaccount not found' }] })
      return json(200, { subaccount: this.opts.subaccount })
    }
    if (method === 'GET' && path === '/v4/orders') {
      const wanted = (query.get('status') ?? '').toUpperCase()
      const rows = (this.opts.orders ?? []).filter((o) => {
        if (wanted === '') return true
        return String((o as { status?: unknown }).status ?? '').toUpperCase() === wanted
      })
      // 官方 GET /v4/orders 返回裸数组
      return json(200, rows)
    }
    if (method === 'GET' && /^\/v4\/orders\/[^/]+$/.test(path)) {
      const id = path.slice('/v4/orders/'.length)
      const hit = (this.opts.orders ?? []).find((o) => (o as { id?: unknown }).id === id)
      if (hit === undefined) return json(404, { errors: [{ msg: 'order not found' }] })
      return json(200, hit)
    }
    if (method === 'GET' && path === '/v4/fills') return json(200, { fills: this.opts.fills ?? [] })
    if (method === 'GET' && path === '/v4/perpetualPositions') return json(200, { positions: this.opts.positions ?? [] })
    if (path === '/cosmos/tx/v1beta1/txs' && method !== 'POST') {
      this.failures.push(`wrong method ${method} on ${path}`)
      return json(405, { error: 'method not allowed' })
    }
    void query
    return json(404, { errors: [{ msg: `no fake route for ${path}` }] })
  }

  #broadcast(body: { tx_bytes?: string; mode?: string }): FetchResponseLike {
    if (body.mode === 'BROADCAST_MODE_BLOCK') {
      // cosmos-sdk v0.50 client/broadcast.go：只支持 sync / async
      this.failures.push('BROADCAST_MODE_BLOCK is not supported by cosmos-sdk v0.50')
      return json(500, { code: 2, message: 'unsupported return type unspecified; supported types: sync, async' })
    }
    const txBytes = new Uint8Array(Buffer.from(body.tx_bytes ?? '', 'base64'))
    if (txBytes.length === 0) {
      this.failures.push('empty tx_bytes')
      return json(400, { error: 'empty tx' })
    }
    const tx = walk(txBytes)
    const bodyBytes = one(tx, 1).data!
    const authInfoBytes = one(tx, 2).data!
    const signature = one(tx, 3).data!
    const bodyFields = walk(bodyBytes)
    const messages = bodyFields.filter((f) => f.field === 1).map((f) => {
      const any = walk(f.data!)
      return { typeUrl: one(any, 1).text!, body: one(any, 2).data! }
    })
    const auth = walk(authInfoBytes)
    const signerInfo = walk(one(auth, 1).data!)
    const pubKeyAny = walk(one(signerInfo, 1).data!)
    if (one(pubKeyAny, 1).text !== '/cosmos.crypto.secp256k1.PubKey') this.failures.push('pubkey type url mismatch')
    const pubKey = one(walk(one(pubKeyAny, 2).data!), 1).data!
    const sequence = Number(maybe(signerInfo, 3)?.num ?? 0n)
    const modeInfo = walk(one(signerInfo, 2).data!)
    const single = walk(one(modeInfo, 1).data!)
    if (Number(one(single, 1).num) !== 1) this.failures.push('sign mode is not DIRECT')
    const fee = walk(one(auth, 2).data!)
    const feeGas = Number(maybe(fee, 2)?.num ?? 0n)
    const feeAmounts = fee.filter((f) => f.field === 1).map((f) => {
      const coin = walk(f.data!)
      return { denom: one(coin, 1).text ?? '', amount: one(coin, 2).text ?? '' }
    })
    const ext = bodyFields.filter((f) => f.field === 2047).map((f) => {
      const any = walk(f.data!)
      return { url: one(any, 1).text!, value: one(any, 2).data! }
    })
    if (ext.length !== 1 || ext[0]!.url !== '/dydxprotocol.accountplus.TxExtension') this.failures.push('missing TxExtension')

    // 复算签名域（SignDoc）并独立验签
    const signDoc = signDocBytes(bodyBytes, authInfoBytes, this.opts.chainId, this.opts.accountNumber)
    const spki = Buffer.concat([Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex'), Buffer.from(pubKey)])
    const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    // 独立验签：节点也是「sha256(SignDoc) 再 ECDSA」，与 cosmsos 的 SIGN_MODE_DIRECT 一致
    const ok = verify('sha256', signDoc, { key: keyObj, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature))
    if (!ok) {
      this.failures.push('signature does not verify')
      return json(200, { tx_response: { code: 4, codespace: 'sdk', raw_log: 'unauthorized: signature verification failed', txhash: '' } })
    }
    // 地址自己算：bech32('dydx', ripemd160(sha256(压缩公钥 33 字节)))，与 src 的 keys / bech32 不共用代码
    const owner = bech32Encode('dydx', ripemd160(sha256(pubKey)))
    let ownerMismatch = false

    const orders: FakeOrderRecord[] = []
    const cancels: FakeTx['cancels'] = []
    for (const m of messages) {
      if (m.typeUrl === '/dydxprotocol.clob.MsgPlaceOrder') {
        const order = walk(one(walk(m.body), 1).data!)
        const orderId = walk(one(order, 1).data!)
        const sub = walk(one(orderId, 1).data!)
        const rec: FakeOrderRecord = {
          clientId: Number(one(orderId, 2).num),
          orderFlags: Number(maybe(orderId, 3)?.num ?? 0n),
          clobPairId: Number(maybe(orderId, 4)?.num ?? 0n),
          owner: one(sub, 1).text ?? '',
          side: String(Number(maybe(order, 2)?.num ?? 0n)),
          quantums: maybe(order, 3)?.num ?? 0n,
          subticks: maybe(order, 4)?.num ?? 0n,
          tif: Number(maybe(order, 7)?.num ?? 0n),
          reduceOnly: (maybe(order, 8)?.num ?? 0n) === 1n,
          clientMetadata: Number(maybe(order, 9)?.num ?? 0n),
          conditionType: Number(maybe(order, 10)?.num ?? 0n),
          triggerSubticks: maybe(order, 11)?.num ?? 0n,
        }
        if (rec.owner !== owner) ownerMismatch = true
        const block = order.find((f) => f.field === 5)
        const blockTime = order.find((f) => f.field === 6)
        if (block !== undefined) rec.goodTilBlock = block.num!
        if (blockTime !== undefined) {
          // good_til_block_time 是 fixed32（wire 5），读到 wire 2（旧的 Timestamp 子消息）就是错的
          if (blockTime.wire !== 5) this.failures.push('good_til_block_time is not fixed32 (wire 5)')
          else rec.goodTilBlockTime = blockTime.num!
        }
        orders.push(rec)
        this.#validateOrder(rec, order)
      } else if (m.typeUrl === '/dydxprotocol.clob.MsgCancelOrder') {
        const bodyFields2 = walk(m.body)
        const orderId = walk(one(bodyFields2, 1).data!)
        const cancelOwner = one(walk(one(orderId, 1).data!), 1).text ?? ''
        if (cancelOwner !== owner) ownerMismatch = true
        const block = bodyFields2.find((f) => f.field === 2)
        const blockTime = bodyFields2.find((f) => f.field === 3)
        if (blockTime !== undefined && blockTime.wire !== 5) {
          this.failures.push('cancel good_til_block_time is not fixed32 (wire 5)')
        }
        cancels.push({
          clientId: Number(one(orderId, 2).num),
          clobPairId: Number(maybe(orderId, 4)?.num ?? 0n),
          orderFlags: Number(maybe(orderId, 3)?.num ?? 0n),
          ...(block === undefined ? {} : { goodTilBlock: block.num! }),
          ...(blockTime === undefined || blockTime.wire !== 5 ? {} : { blockTime: blockTime.num! }),
        })
      } else {
        this.failures.push(`unexpected message type ${m.typeUrl}`)
      }
    }

    const txHash = toHex(new Uint8Array(createHash('sha256').update(txBytes).digest()))
    this.txs.push({
      txHash, messages, orders, cancels, chainId: this.opts.chainId, accountNumber: this.opts.accountNumber,
      sequence, pubKey, signature, feeGas, feeAmounts, authenticators: ext[0]?.value,
    })
    if (ownerMismatch) {
      this.failures.push('OrderId.owner does not match the signer address')
      return json(200, { tx_response: { code: 4, codespace: 'sdk', raw_log: 'pubKey does not match signer address', txhash: txHash } })
    }
    if (this.opts.nextCode !== undefined) {
      const code = this.opts.nextCode
      const raw = this.opts.nextRawLog ?? 'rejected by fake chain'
      this.opts.nextCode = undefined
      return json(200, { tx_response: { code, codespace: 'clob', raw_log: raw, txhash: txHash } })
    }
    if (sequence !== this.opts.sequence) {
      this.failures.push(`unexpected sequence ${sequence} (fake expects ${this.opts.sequence})`)
    }
    // 短单不消耗 sequence；长单 / 长单撤单在 code 0 时才 +1
    const stateful = orders.some((o) => o.orderFlags !== 0) || cancels.some((c) => c.blockTime !== undefined)
    if (stateful) this.opts.sequence += 1
    if (this.opts.nextTxResponse !== undefined) {
      const body = this.opts.nextTxResponse
      this.opts.nextTxResponse = undefined
      return json(200, body)
    }
    return json(200, { tx_response: { code: 0, codespace: '', raw_log: '', txhash: txHash, height: String(this.opts.height + 1) } })
  }

  #validateOrder(rec: FakeOrderRecord, order: ReturnType<typeof walk>): void {
    const ticker = Object.keys(this.opts.markets ?? {}).find((t) => (this.opts.markets ?? {})[t]!.clobPairId === rec.clobPairId)
    const market = ticker === undefined ? undefined : this.opts.markets![ticker]!
    if (market === undefined) {
      this.failures.push(`unknown clob pair ${rec.clobPairId}`)
      return
    }
    if (rec.quantums % BigInt(market.stepBaseQuantums) !== 0n) this.failures.push('quantums not a multiple of stepBaseQuantums')
    if (rec.subticks % BigInt(market.subticksPerTick) !== 0n) this.failures.push('subticks not a multiple of subticksPerTick')
    if (rec.clientMetadata > 127) this.failures.push('client_metadata > 127')
    if (rec.side !== '1' && rec.side !== '2') this.failures.push('invalid side')
    const isShort = rec.orderFlags === 0
    if (isShort && rec.goodTilBlock === undefined) this.failures.push('short-term order without good_til_block')
    if (!isShort && rec.goodTilBlockTime === undefined) this.failures.push('stateful order without good_til_block_time')
    if (isShort && rec.conditionType !== 0) this.failures.push('short-term order with a condition type')
    if (rec.conditionType !== 0 && rec.triggerSubticks === 0n) this.failures.push('conditional order without trigger subticks')
    if (order.find((f) => f.field === 14) !== undefined) this.failures.push('unexpected order_router_address')
  }
}

function sha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
}

function ripemd160(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('ripemd160').update(Buffer.from(b)).digest())
}

function toHex(b: Uint8Array): string {
  return hex(b)
}

/** 测试自带的 bech32 编码器（BIP-173，不 import src/bech32）。 */
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function bech32Polymod(values: readonly number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i += 1) if (((top >>> i) & 1) === 1) chk ^= BECH32_GENERATOR[i]!
  }
  return chk >>> 0
}

function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words: number[] = []
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      words.push((acc >>> bits) & 31)
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31)
  const expanded: number[] = []
  for (let i = 0; i < hrp.length; i += 1) expanded.push(hrp.charCodeAt(i) >> 5)
  expanded.push(0)
  for (let i = 0; i < hrp.length; i += 1) expanded.push(hrp.charCodeAt(i) & 31)
  const mod = bech32Polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  let out = `${hrp}1`
  for (const w of words) out += BECH32_CHARSET[w]!
  for (let p = 0; p < 6; p += 1) out += BECH32_CHARSET[(mod >>> (5 * (5 - p))) & 31]!
  return out
}

function fromHex(h: string): Uint8Array {
  const clean = h.startsWith('0x') ? h.slice(2) : h
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function signDocBytes(body: Uint8Array, auth: Uint8Array, chainId: string, accountNumber: number): Buffer {
  const w: number[] = []
  const len = (n: number) => { const out: number[] = []; let v = n; do { let b = v & 0x7f; v >>>= 7; if (v > 0) b |= 0x80; out.push(b) } while (v > 0); return out }
  w.push(0x0a, ...len(body.length), ...body)
  w.push(0x12, ...len(auth.length), ...auth)
  const cid = Buffer.from(chainId, 'utf8')
  w.push(0x1a, ...len(cid.length), ...cid)
  if (accountNumber > 0) {
    w.push(0x20)
    let v = accountNumber
    do { let b = v & 0x7f; v >>>= 7; if (v > 0) b |= 0x80; w.push(b) } while (v > 0)
  }
  return Buffer.from(w)
}

function json(status: number, body: unknown): FetchResponseLike {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: { get: () => null },
  }
}

export { hex, fromHex }