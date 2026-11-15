// SPDX-License-Identifier: Apache-2.0
import { loadTarget } from './target'
import { registerCases } from './run'

registerCases(await loadTarget())
