// SPDX-License-Identifier: Apache-2.0
// GEP 一致性套件 · 必测（T01–T27）。对象由环境变量决定，见 target.ts；没设环境变量时对内存假引擎自测。
import { REQUIRED_CASES } from './cases/required'
import { fetchDescribe } from './cases/common'
import { registerCases, registerReport } from './run'
import { loadTarget } from './target'

const target = await loadTarget()
const describeResult = await fetchDescribe(target)
registerCases(`GEP 必测 · ${target.label}`, REQUIRED_CASES, target, describeResult.capabilities)
registerReport(target, describeResult)
