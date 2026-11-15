// SPDX-License-Identifier: CPAL-1.0
// 工具预算自检（契约 §5.7）：统计工具数、每条描述长度、入参 schema 字节数与估算 token，对照预算；超预算 = 测试失败。
// token 为协议包 estimateToolDefTokens 的估算（CJK 按 1.5、其余按 0.3）——发布门禁应换分词器实测；这里再给一个严格口径（UTF-8 字节 / 3）。
import { MCP_BUDGET, MCP_TOOLS, estimateTokens, mcpToolsForLevel } from '@gitrader/protocol'
import type { McpToolDef } from '@gitrader/protocol'
import { toolDescription } from './describe'

export interface ToolStat {
  name: string
  group: string
  descriptionChars: number
  schemaBytes: number
  tokens: number
  tokensStrict: number
  maxParamDescriptionChars: number
  nesting: number
}

export interface BudgetReport {
  toolCount: number
  tools: ToolStat[]
  defaultSets: { level: string; tools: number; tokens: number; tokensStrict: number }[]
  violations: string[]
}

const nestingOf = (v: unknown, depth = 0): number => {
  if (!v || typeof v !== 'object') return depth
  let m = depth
  for (const c of Object.values(v as Record<string, unknown>)) m = Math.max(m, nestingOf(c, depth + 1))
  return m
}
const paramDescMax = (props: Record<string, Record<string, unknown>>): number =>
  Math.max(0, ...Object.values(props).map((p) => (typeof p.description === 'string' ? [...p.description].length : 0)))

/** 入参 schema 的嵌套层数：属性（第 1 层）→ 嵌套对象的属性（第 2 层）…。工具里的对象参数一律是不展开的 `{type:'object'}`。 */
const schemaNesting = (t: McpToolDef): number => {
  let n = 1
  for (const p of Object.values(t.inputSchema.properties)) if (p.properties || p.items) n = Math.max(n, 2 + nestingOf(p.properties ?? p.items) - 1)
  return n
}

export function computeBudget(): BudgetReport {
  const tools: ToolStat[] = (MCP_TOOLS as readonly McpToolDef[]).map((t) => {
    const description = toolDescription(t)
    const def = JSON.stringify({ name: t.name, description, inputSchema: t.inputSchema })
    return {
      name: t.name, group: t.group, descriptionChars: [...description].length, schemaBytes: Buffer.byteLength(JSON.stringify(t.inputSchema)),
      tokens: estimateTokens(def), tokensStrict: Math.ceil(Buffer.byteLength(def) / 3),
      maxParamDescriptionChars: paramDescMax(t.inputSchema.properties), nesting: schemaNesting(t),
    }
  })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const defaultSets = (['L0', 'L1', 'L3'] as const).map((level) => {
    const set = mcpToolsForLevel(level).map((t) => byName.get(t.name)!)
    return { level, tools: set.length, tokens: set.reduce((s, t) => s + t.tokens, 0), tokensStrict: set.reduce((s, t) => s + t.tokensStrict, 0) }
  })
  const violations: string[] = []
  if (tools.length > MCP_BUDGET.maxTools) violations.push(`tool count ${tools.length} > ${MCP_BUDGET.maxTools}`)
  if (tools.length !== MCP_BUDGET.toolCount) violations.push(`tool count ${tools.length} != ${MCP_BUDGET.toolCount} (the manifest changed; update the budget on purpose)`)
  for (const t of tools) {
    if (t.descriptionChars > MCP_BUDGET.maxDescriptionChars) violations.push(`${t.name}: description ${t.descriptionChars} chars > ${MCP_BUDGET.maxDescriptionChars}`)
    if (t.tokens > MCP_BUDGET.maxToolDefTokens) violations.push(`${t.name}: definition ~${t.tokens} tokens > ${MCP_BUDGET.maxToolDefTokens}`)
    if (t.maxParamDescriptionChars > MCP_BUDGET.maxParamDescriptionChars) violations.push(`${t.name}: a parameter description is ${t.maxParamDescriptionChars} chars > ${MCP_BUDGET.maxParamDescriptionChars}`)
    if (t.nesting > MCP_BUDGET.maxSchemaNesting) violations.push(`${t.name}: schema nesting ${t.nesting} > ${MCP_BUDGET.maxSchemaNesting}`)
  }
  const l0 = defaultSets.find((s) => s.level === 'L0')!
  const l1 = defaultSets.find((s) => s.level === 'L1')!
  if (l0.tools !== MCP_BUDGET.defaultLoadL0) violations.push(`default set at L0 has ${l0.tools} tools, budget says ${MCP_BUDGET.defaultLoadL0}`)
  if (l1.tools !== MCP_BUDGET.defaultLoadL1Plus) violations.push(`default set at L1+ has ${l1.tools} tools, budget says ${MCP_BUDGET.defaultLoadL1Plus}`)
  for (const s of defaultSets) {
    if (s.tools > MCP_BUDGET.defaultLoadTarget) violations.push(`default set at ${s.level} has ${s.tools} tools > target ${MCP_BUDGET.defaultLoadTarget}`)
    if (s.tokens > MCP_BUDGET.maxDefaultSetTokens) violations.push(`default set at ${s.level} ~${s.tokens} tokens > ${MCP_BUDGET.maxDefaultSetTokens}`)
  }
  return { toolCount: tools.length, tools, defaultSets, violations }
}

export function checkBudget(): string[] { return computeBudget().violations }

export function renderBudgetMd(r: BudgetReport = computeBudget()): string {
  const B = MCP_BUDGET
  const lines: string[] = [
    '<!-- SPDX-License-Identifier: CPAL-1.0 -->',
    '<!-- 由 `npm run budget -w @gitrader/mcp` 生成；测试会核对它与协议包的工具清单一致，超预算即失败。别手改。 -->',
    '# MCP 工具预算（契约 §5.7）',
    '',
    `工具总数 **${r.toolCount}**（硬上限 ${B.maxTools}，设计值 ${B.toolCount}）。token 为协议包 \`estimateToolDefTokens\` 的估算（CJK 按 1.5、其余按 0.3）；"严格"列 = 定义 JSON 的 UTF-8 字节数 / 3。发布门禁应换分词器实测。`,
    '',
    '## 单个工具',
    '',
    `| 工具 | 组 | 描述字数（≤${B.maxDescriptionChars}） | schema 字节 | 估算 token（≤${B.maxToolDefTokens}） | 严格 token | 参数描述最长（≤${B.maxParamDescriptionChars}） | 嵌套（≤${B.maxSchemaNesting}） |`,
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...r.tools.map((t) => `| ${t.name} | ${t.group} | ${t.descriptionChars} | ${t.schemaBytes} | ${t.tokens} | ${t.tokensStrict} | ${t.maxParamDescriptionChars} | ${t.nesting} |`),
    '',
    '## 默认加载集合',
    '',
    `| 钥匙级别 | 工具数 | 估算 token（≤${B.maxDefaultSetTokens}） | 严格 token |`,
    '|---|---:|---:|---:|',
    ...r.defaultSets.map((s) => `| ${s.level}${s.level === 'L0' ? '（只读）' : s.level === 'L1' ? '（纸面）' : '（限额自动）'} | ${s.tools}（预算 ${s.level === 'L0' ? B.defaultLoadL0 : B.defaultLoadL1Plus}，目标 ≤${B.defaultLoadTarget}） | ${s.tokens} | ${s.tokensStrict} |`),
    '',
    '「工作区」工具（workspace）只在人于界面打开"允许 Agent 调整布局"后才加载，不计入上表。',
    '',
    `## 结论：${r.violations.length ? '超预算' : '全部在预算内'}`,
    '',
    ...(r.violations.length ? r.violations.map((v) => `- ${v}`) : ['- 无超预算项。']),
    '',
  ]
  return lines.join('\n')
}
