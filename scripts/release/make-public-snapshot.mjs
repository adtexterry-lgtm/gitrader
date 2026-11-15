// SPDX-License-Identifier: CPAL-1.0
// 公开快照（首发用干净单根提交）：从当前 HEAD 的已跟踪文件导出一个本地 git 仓库。
//   node scripts/release/make-public-snapshot.mjs --output <目录> [--author "Name <email>"] [--message "Initial public release"]
// 行为：git archive HEAD -> 目标目录 -> git init -> 单次提交（作者用 --author）-> 在快照上跑 scripts/check-public.mjs。
// 只建本地目录：不建远端、不推送、不打 tag。私有禁词表沿用调用方的 GITRADER_PRIVATE_DENYLIST。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_AUTHOR = 'Gitrader Maintainers <noreply@users.noreply.github.com>'
const DEFAULT_MESSAGE = 'Initial public release'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--output') out.output = argv[++i]
    else if (a === '--author') out.author = argv[++i]
    else if (a === '--message') out.message = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.output) {
  console.error('usage: node scripts/release/make-public-snapshot.mjs --output <dir> [--author "Name <email>"] [--message "Initial public release"]')
  process.exit(args.help ? 0 : 2)
}

const output = resolve(args.output)
const author = args.author || DEFAULT_AUTHOR
const message = args.message || DEFAULT_MESSAGE
const m = /^(.*?)\s*<([^<>]+)>$/.exec(author)
if (!m) throw new Error('--author must look like "Name <email>"')
const authorName = m[1].trim()
const authorEmail = m[2].trim()

if (existsSync(output) && readdirSync(output).length > 0) {
  console.error(`output directory is not empty: ${output}`)
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'gitrader-snapshot-'))
const archive = join(tmp, 'head.tar')
try {
  // 1) 导出 HEAD 的已跟踪文件
  execFileSync('git', ['-C', root, 'archive', '--format=tar', `--output=${archive}`, 'HEAD'], { stdio: 'inherit' })
  mkdirSync(output, { recursive: true })
  // GNU tar 在 Git Bash 里会把 "C:\..." 当成远端主机名，需要 --force-local；bsdtar 没有这个选项。
  // GNU tar 在 Windows 上还要用正斜杠的盘符路径。
  const slash = (p) => p.replace(/\\/g, '/')
  const tarVersion = spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout || ''
  const tarArgs = /GNU tar/.test(tarVersion) ? ['--force-local', '-xf', slash(archive), '-C', slash(output)] : ['-xf', archive, '-C', output]
  execFileSync('tar', tarArgs, { stdio: 'inherit' })

  // 2) 单次提交，作者由 --author 决定（-f：导出物即权威清单，不受 .gitignore 影响）
  const git = (...a) => execFileSync('git', ['-C', output, ...a], { stdio: 'inherit', env: { ...process.env, GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail } })
  git('init', '-q', '-b', 'main')
  git('-c', 'core.autocrlf=false', 'add', '-A', '-f')
  git('commit', '-q', '-m', message)

  // 3) 在快照上跑公开卫生检查（带私有禁词表时同样生效）
  const check = spawnSync(process.execPath, [join(output, 'scripts', 'check-public.mjs')], { cwd: output, stdio: 'inherit', env: process.env })
  if (check.status !== 0) throw new Error(`check-public failed on the snapshot (exit ${check.status})`)

  console.log(`snapshot written: ${output}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
