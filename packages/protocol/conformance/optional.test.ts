// SPDX-License-Identifier: Apache-2.0
// GEP 一致性套件 · 可选（O1–O8），按能力位运行；未声明的能力位对应用例显示为跳过。
import { OPTIONAL_CASES } from './cases/optional'
import { fetchDescribe } from './cases/common'
import { registerCases, registerReport } from './run'
import { loadTarget } from './target'

const target = await loadTarget()
const describeResult = await fetchDescribe(target)
registerCases(`GEP 可选 · ${target.label}`, OPTIONAL_CASES, target, describeResult.capabilities)
registerReport(target, describeResult)
