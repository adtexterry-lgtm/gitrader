// SPDX-License-Identifier: CPAL-1.0
// 每个签名者（API 钱包地址）独立的 nonce：毫秒时间戳，单调递增、不重复（知识库「API钱包_代理钱包与nonce」）。
//   · HL 每个签名者地址保存最高 100 个 nonce，新 nonce 须大于集合最小值、从未用过、落在 (T−2 天, T+1 天) 内；
//   · nonce 按私钥记录：同一个 API 钱包给多个子账户签名会共享 nonce 集，并行场景应各用各的 API 钱包——本类按签名者地址分桶，
//     所以「一个交易进程一个 API 钱包」的建议在这里自然成立。
export class NonceManager {
  private readonly last = new Map<string, number>()
  constructor(private readonly clock: () => number = () => Date.now()) {}

  next(signerAddress: string): number {
    const k = signerAddress.toLowerCase()
    const n = Math.max(this.clock(), (this.last.get(k) ?? 0) + 1)
    this.last.set(k, n)
    return n
  }

  /** 诊断：该签名者发出的最大 nonce（0 = 还没发过）。 */
  highest(signerAddress: string): number {
    return this.last.get(signerAddress.toLowerCase()) ?? 0
  }
}
