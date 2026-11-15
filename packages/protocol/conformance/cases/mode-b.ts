// SPDX-License-Identifier: Apache-2.0
// 模式 B 必测（声明 execution.modeB）：B1–B5。
// 这五条需要"引擎自连一个确定性假场所"。契约没有规定套件如何把假场所的地址交给引擎（见 OPEN-QUESTIONS），
// 所以这里只登记用例与通过标准，作为 todo；声明了 execution.modeB 的引擎在这五条上会显示"未测"，不会显示"通过"。
export const MODE_B_CASES: { id: string; title: string; criteria: string }[] = [
  { id: 'B1', title: '上报完整', criteria: '假场所产生 50 笔成交：100% 上报，p95 ≤ 1 s，字段完整' },
  { id: 'B2', title: '预检关联', criteria: '100% 上报订单带 precheckId，且预检时间早于提交时间' },
  { id: 'B3', title: '遵守拒绝', criteria: '预检返回 deny 时假场所收到 0 单' },
  { id: 'B4', title: '签名者声明', criteria: '声明的签名者与宿主签名者不同，且与假场所实际签名者一致' },
  { id: 'B5', title: '快照一致', criteria: 'account.snapshot 与假场所状态逐字段一致' },
]
