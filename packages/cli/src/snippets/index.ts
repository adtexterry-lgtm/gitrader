// SPDX-License-Identifier: CPAL-1.0
// `gitrader mcp snippet <宿主>`：生成可直接粘贴的 MCP 接入配置（只做文本生成，不碰内核、不碰密钥）。
//
// 规矩
//   - 路径一律绝对路径（node 可执行文件 + MCP 入口 + 数据目录）；
//   - 令牌明文永远不进片段：Claude Code / Codex / Hermes 用环境变量引用 GITRADER_AGENT_TOKEN，UNIGIT 用令牌文件（GITRADER_AGENT_TOKEN_FILE，
//     内容由用户在创建钥匙后自己写入）。端口不写死：MCP 服务器每次调用时读 <GITRADER_HOME>/service.json 的端口（内核后起、换端口都能连上）；
//   - 每份片段末尾给一行"验证连接"的命令（`<node> <mcp> --check`，所有宿主通用）。
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SNIPPET_HOSTS = ['claude-code', 'codex', 'hermes', 'unigit'] as const
/** R3-02：Cursor 与通用 mcpServers 写法（只认令牌文件，不走环境变量里的令牌）。 */
export const MCP_SERVERS_HOSTS = ['cursor', 'generic'] as const
export const ALL_SNIPPET_HOSTS = [...SNIPPET_HOSTS, ...MCP_SERVERS_HOSTS] as const
export type SnippetHostName = (typeof ALL_SNIPPET_HOSTS)[number]

export interface SnippetInput {
  host: SnippetHostName
  /** node 可执行文件的绝对路径（随包 Node 或当前运行的 Node）。 */
  node: string
  /** gitrader-mcp 入口（打包产物）的绝对路径。 */
  mcpEntry: string
  /** 数据目录（GITRADER_HOME）的绝对路径。 */
  home: string
  /** 入口文件是否真的存在（不存在就在片段前面提示先构建）。 */
  mcpBuilt?: boolean
  /** 令牌文件路径。给了就只引用 GITRADER_AGENT_TOKEN_FILE，不写 GITRADER_AGENT_TOKEN 明文。 */
  tokenFile?: string
  /** 旧写法：把令牌放在 GITRADER_AGENT_TOKEN 环境变量里（只用于兼容 / 旧测试）。 */
  inlineToken?: boolean
}

export const TOKEN_ENV = 'GITRADER_AGENT_TOKEN'
export const TOKEN_FILE_ENV = 'GITRADER_AGENT_TOKEN_FILE'

/** UNIGIT 用的令牌文件位置（数据目录里；用户创建钥匙后自己写入）。 */
export const unigitTokenFile = (home: string): string => join(home, 'agent-unigit.token')

/** 未指定令牌文件时的提示路径：创建钥匙后把 <名字> 换成实际钥匙名。 */
export const defaultAgentTokenFile = (home: string): string => join(home, 'agent-tokens', '<请替换为你的钥匙名>.token')

/** 在候选位置里找 MCP 入口：打包产物与 CLI 同目录、产品布局的兄弟目录、仓库布局（packages/mcp/dist）。 */
export function locateMcpEntry(here: string, exists: (p: string) => boolean = existsSync): { path: string; built: boolean } {
  const candidates = [
    join(here, 'gitrader-mcp.js'), join(here, 'gitrader-mcp.mjs'),
    join(here, '..', 'mcp', 'gitrader-mcp.js'), join(here, '..', 'mcp', 'gitrader-mcp.mjs'),
    join(here, '..', '..', 'mcp', 'dist', 'gitrader-mcp.js'),
  ].map((p) => resolve(p))
  const hit = candidates.find((p) => exists(p))
  return hit ? { path: hit, built: true } : { path: candidates[candidates.length - 1] as string, built: false }
}

const yq = (s: string): string => `'${s.replace(/'/g, "''")}'` // YAML 单引号：反斜杠不转义，单引号写两个
const tq = (s: string): string => (s.includes("'") ? JSON.stringify(s) : `'${s}'`) // TOML 字面量字符串

/** 验证连接的命令行（Windows 路径带空格要加引号；所有宿主通用）。 */
export const checkCommand = (i: Pick<SnippetInput, 'node' | 'mcpEntry'> & { tokenFile?: string | undefined }): string => {
  const base = `"${i.node}" "${i.mcpEntry}" --check`
  if (!i.tokenFile) return base
  // UX-33：知道令牌文件就带上环境变量，有多把钥匙时 --check 才不会“找到 2 个令牌文件”而失败
  return /^[A-Za-z]:|\\/.test(i.node) ? `set "${TOKEN_FILE_ENV}=${i.tokenFile}" && ${base}` : `${TOKEN_FILE_ENV}='${i.tokenFile.replace(/'/g, `'\\''`)}' ${base}`
}

const TOKEN_NOTE = [
  `令牌不会写进配置：先用 \`gitrader keys new agent <名字> --host <宿主> --preset starter --token-file\` 创建钥匙（令牌写进文件，AI 每笔开仓都等你批准），`,
  `再把文件里的令牌设成用户级环境变量 ${TOKEN_ENV}（Windows：系统属性 → 环境变量；macOS / Linux：写进 shell 配置），新开一个终端 / 重启宿主后生效。更省事的做法：加 --token-file <路径> 重新生成本片段，直接引用令牌文件。`,
]

const TOKEN_FILE_NOTE = (path: string, given = false): string[] => given
  ? [
      `已用令牌文件：${path}（里面只放令牌一行，令牌不会写进配置）。`,
      `配置里已让宿主通过环境变量 ${TOKEN_FILE_ENV} 指向这个文件；重启宿主后生效。还没有钥匙的话：gitrader keys new agent <名字> --host <宿主> --preset starter --token-file`,
    ]
  : [
      `令牌不会写进配置：先运行 \`gitrader keys new agent <名字> --host <宿主> --preset starter --token-file\` 创建钥匙，令牌会写入 ${path}（只放令牌一行）。`,
      `然后让宿主通过环境变量 ${TOKEN_FILE_ENV} 指向这个文件；重启宿主后生效。`,
    ]

export function renderSnippet(i: SnippetInput): string {
  const pre = i.mcpBuilt === false ? [`# 提示：${i.mcpEntry} 还不存在。先构建：node scripts/build.mjs mcp`, ''] : []
  // 令牌文件模式：给了 tokenFile 且没有要求旧的内联写法。没给 tokenFile 的旧调用保持原样（snippetText 未改）。
  const tokenFile = i.inlineToken ? undefined : i.tokenFile
  const tokenNote = tokenFile ? TOKEN_FILE_NOTE(tokenFile, true) : TOKEN_NOTE
  const check = (extraEnv = true): string[] => [
    '',
    '# 验证连接（所有宿主通用；成功会打印钥匙、级别和工具数）：',
    `${tokenFile ? '# 命令里已带上令牌文件（环境变量 ' + TOKEN_FILE_ENV + '），直接运行：\n' : extraEnv ? `# 先在当前终端设好 ${TOKEN_ENV}，再运行：\n` : `# --check 会自动用 <GITRADER_HOME>/agent-tokens/ 里唯一的令牌文件；令牌文件放在别处时，先在当前终端设好 ${TOKEN_FILE_ENV} 再运行：\n`}${checkCommand({ ...i, tokenFile })}`,
  ]
  switch (i.host) {
    case 'cursor':
    case 'generic': {
      // 两者同一个 JSON 形状：{ mcpServers: { gitrader: { command, args, env } } }；令牌只以文件路径出现，没给就用提示路径
      const file = i.tokenFile ?? defaultAgentTokenFile(i.home)
      const json = JSON.stringify({ mcpServers: { gitrader: { command: i.node, args: [i.mcpEntry], env: { GITRADER_HOME: i.home, [TOKEN_FILE_ENV]: file } } } }, null, 2)
      const where = i.host === 'cursor'
        ? '# Cursor：存成项目根目录的 .cursor/mcp.json（只在这个项目里用），或用户目录下的 ~/.cursor/mcp.json（所有项目共用）；Settings → MCP 里能看到 gitrader 亮绿灯'
        : '# 通用写法：任何认 mcpServers 的宿主（Cursor、Cline、Windsurf、Claude Desktop 等）都能用；并进宿主配置里的 mcpServers，不要整个覆盖'
      return [...pre, where, ...TOKEN_FILE_NOTE(file, i.tokenFile !== undefined).map((l) => `# ${l}`), json, ...check(false), i.host === 'cursor' ? '# 宿主侧确认：Cursor → Settings → MCP' : '', ''].join('\n')
    }
    case 'claude-code': {
      const env = { GITRADER_HOME: i.home, ...(tokenFile ? { [TOKEN_FILE_ENV]: tokenFile } : { [TOKEN_ENV]: `\${${TOKEN_ENV}}` }) }
      const json = JSON.stringify({ mcpServers: { gitrader: { type: 'stdio', command: i.node, args: [i.mcpEntry], env } } }, null, 2)
      return [...pre, '# Claude Code：存成项目根目录的 .mcp.json（${VAR} 由 Claude Code 展开成环境变量的值）', ...tokenNote.map((l) => `# ${l}`), json, ...check(!tokenFile), '# 宿主侧确认：claude mcp list', ''].join('\n')
    }
    case 'codex': {
      const toml = tokenFile
        ? [
            '[mcp_servers.gitrader]',
            `command = ${tq(i.node)}`,
            `args = [${tq(i.mcpEntry)}]`,
            '',
            '[mcp_servers.gitrader.env]',
            `GITRADER_HOME = ${tq(i.home)}`,
            `${TOKEN_FILE_ENV} = ${tq(tokenFile)}`,
          ].join('\n')
        : [
            '[mcp_servers.gitrader]',
            `command = ${tq(i.node)}`,
            `args = [${tq(i.mcpEntry)}]`,
            `env_vars = ["${TOKEN_ENV}"]`,
            '',
            '[mcp_servers.gitrader.env]',
            `GITRADER_HOME = ${tq(i.home)}`,
          ].join('\n')
      return [...pre, '# Codex：追加到 ~/.codex/config.toml（env_vars 把同名环境变量转给 MCP 子进程）', ...tokenNote.map((l) => `# ${l}`), toml, ...check(!tokenFile), '# 宿主侧确认：codex mcp list', ''].join('\n')
    }
    case 'hermes': {
      const yaml = tokenFile
        ? ['mcp_servers:', '  gitrader:', `    command: ${yq(i.node)}`, `    args: [${yq(i.mcpEntry)}]`, '    env:', `      GITRADER_HOME: ${yq(i.home)}`, `      ${TOKEN_FILE_ENV}: ${yq(tokenFile)}`].join('\n')
        : ['mcp_servers:', '  gitrader:', `    command: ${yq(i.node)}`, `    args: [${yq(i.mcpEntry)}]`, '    env:', `      GITRADER_HOME: ${yq(i.home)}`, `      ${TOKEN_ENV}: '\${${TOKEN_ENV}}'`].join('\n')
      return [...pre, '# Hermes Agent：并入 ~/.hermes/config.yaml 的 mcp_servers 段（令牌变量也可以放进 ~/.hermes/.env）', ...tokenNote.map((l) => `# ${l}`), yaml, ...check(!tokenFile), ''].join('\n')
    }
    case 'unigit': {
      const chosenTokenFile = i.tokenFile ?? unigitTokenFile(i.home)
      const yaml = [
        '- insert:',
        '    - id: unigit-gitrader-mcp',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: gitrader',
        '        transport: stdio',
        "        command: !!js 'process.execPath'",
        `        args: [${yq(i.mcpEntry)}]`,
        `        env: { ELECTRON_RUN_AS_NODE: '1', GITRADER_HOME: ${yq(i.home)}, ${TOKEN_FILE_ENV}: ${yq(chosenTokenFile)} }`,
        '        toolCallTimeoutMs: 120000',
        '        failOnStartupError: false',
      ].join('\n')
      return [
        ...pre,
        '# UNIGIT：二选一。',
        '#   A. 能力商店安装配方 official.gitrader（智能应用）与 official.gitrader-mcp（工具）——配方里已带同样的启动参数；',
        '#   B. 不走商店：把下面这段追加进目标 home 的 profiles/desktop/cordis.patch.yml，重启 UNIGIT。',
        '# UNIGIT 自带 Node（command 用它自己的 process.execPath），用户机不需要另装。',
        ...(i.tokenFile
          ? [`# 令牌文件：${chosenTokenFile}（已由 keys new agent --token-file 写入，无需再粘贴）`]
          : [
            `# 令牌不写进配置：创建钥匙（gitrader keys new agent <名字> --host unigit --preset starter）后，把令牌存进文件 ${chosenTokenFile}（只放令牌一行）：`,
            `#   PowerShell：Set-Content -NoNewline -Path '${chosenTokenFile}' -Value '<粘贴令牌>'`,
          ]),
        yaml,
        '',
        '# 验证连接（先把令牌放进上面的文件，或在当前终端设好 ' + TOKEN_ENV + '）：',
        `${checkCommand(i)}`,
        '',
      ].join('\n')
    }
  }
}

export interface SnippetForOptions {
  tokenFile?: string
  inlineToken?: boolean
}

/**
 * 给维护者接线的入口：默认走令牌文件（路径可指定；没指定就给 <home>/agent-tokens/<钥匙名>.token 的提示路径）。
 * 只有显式 inlineToken 才退回旧的 GITRADER_AGENT_TOKEN 环境变量写法。
 */
export function snippetFor(host: SnippetHostName, home: string, over: SnippetForOptions = {}): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const found = locateMcpEntry(here)
  const absoluteHome = resolve(home)
  const tokenFile = over.inlineToken ? undefined : over.tokenFile ?? defaultAgentTokenFile(absoluteHome)
  return renderSnippet({
    host,
    node: process.execPath,
    mcpEntry: found.path,
    home: absoluteHome,
    mcpBuilt: found.built,
    ...(tokenFile ? { tokenFile } : {}),
    ...(over.inlineToken ? { inlineToken: true } : {}),
  })
}
