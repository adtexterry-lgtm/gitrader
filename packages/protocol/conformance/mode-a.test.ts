// SPDX-License-Identifier: Apache-2.0
// GEP 一致性套件 · 模式 A 必测（A1–A3），仅声明 execution.modeA 的引擎运行。
import { MODE_A_CASES } from './cases/mode-a'
import { fetchDescribe } from './cases/common'
import { registerCases, registerReport } from './run'
import { loadTarget } from './target'

const target = await loadTarget()
const describeResult = await fetchDescribe(target)
registerCases(`GEP 模式 A · ${target.label}`, MODE_A_CASES, target, describeResult.capabilities)
registerReport(target, describeResult)
