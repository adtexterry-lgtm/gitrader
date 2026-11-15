// SPDX-License-Identifier: Apache-2.0
// GEP 一致性套件 · 模式 B 必测（B1–B5）：用例已登记，待契约规定假场所的接入方式（见 OPEN-QUESTIONS）。
import { MODE_B_CASES } from './cases/mode-b'
import { fetchDescribe } from './cases/common'
import { registerReport, registerTodos } from './run'
import { loadTarget } from './target'

const target = await loadTarget()
const describeResult = await fetchDescribe(target)
registerTodos(`GEP 模式 B · ${target.label}`, MODE_B_CASES, describeResult.capabilities['execution.modeB'] === true)
registerReport(target, describeResult)
