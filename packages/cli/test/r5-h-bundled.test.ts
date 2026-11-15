// SPDX-License-Identifier: CPAL-1.0
// GQ-10 随包通知插件与示例策略安装测试
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledHashManifest, initHome, inspectPluginDir, KERNEL_VERSION } from '@gitrader/kernel'
import { cmdPluginsInstall, cmdExamples } from '../src/bundled'
import type { Args } from '../src/index'

const REPO = join(__dirname, '..', '..', '..')

function args(cmd: string[]): Args {
  return { cmd, flags: {} }
}

/** 最小 CliIo：只给被测命令用到的三个方法 + 测试用的 getOutput；其余字段按接口补空实现（不落盘、不读真终端）。 */
function io() {
  const lines: string[] = []
  return {
    out: (s: string) => { lines.push(s) },
    err: (s: string) => { lines.push(s) },
    env: {} as Record<string, string | undefined>,
    readSecret: async (): Promise<string> => '',
    interactive: false,
    getOutput: () => lines.join(''),
  }
}

describe('GQ-10 bundled plugins & examples', () => {
  let tempDir: string
  let home: string
  let bundledPluginsRoot: string
  let bundledExamplesRoot: string

  beforeEach(() => {
    tempDir = join(__dirname, '..', 'test-tmp', `r5-h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(tempDir, { recursive: true })
    home = join(tempDir, 'home')
    initHome(home)

    // 从真实仓库构建一个最小的 bundled 目录用于测试
    bundledPluginsRoot = join(tempDir, 'plugins-bundled')
    mkdirSync(bundledPluginsRoot, { recursive: true })
    
    const webhookSrc = join(REPO, 'packages', 'plugin-notify-webhook')
    const webhookDest = join(bundledPluginsRoot, 'notify-webhook')
    mkdirSync(webhookDest, { recursive: true })
    
    // 复制必要文件（按 GQ-10 规则：gitrader-plugin.json, LICENSE, README.md, *.mjs 除 run-conformance.mjs）
    const files = readdirSync(webhookSrc)
    for (const f of files) {
      const srcFile = join(webhookSrc, f)
      const stat = existsSync(srcFile) ? statSync(srcFile) : null
      if (stat && stat.isFile()) {
        const keep = ['gitrader-plugin.json', 'LICENSE', 'README.md'].includes(f) || 
                     (f.endsWith('.mjs') && f !== 'run-conformance.mjs')
        if (keep) {
          writeFileSync(join(webhookDest, f), readFileSync(srcFile))
        }
      }
    }

    // 示例目录
    bundledExamplesRoot = join(tempDir, 'examples')
    const strategiesDir = join(bundledExamplesRoot, 'strategies')
    mkdirSync(strategiesDir, { recursive: true })
    
    const gridSrc = join(REPO, 'packages', 'engine-core', 'examples', 'strategies', 'grid.ts')
    writeFileSync(join(strategiesDir, 'grid.ts'), readFileSync(gridSrc))
    
    const templateSrc = join(REPO, 'packages', 'engine-core', 'strategy-template', 'strategy.ts')
    writeFileSync(join(bundledExamplesRoot, 'strategy-template.ts'), readFileSync(templateSrc))
    
    writeFileSync(join(bundledExamplesRoot, 'README.txt'), '示例说明')
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('plugins install：拷到 <home>/plugins/notify-webhook，现场钉版本（不再是全 0），不联网、不启用', async () => {
    const output = io()
    const code = await cmdPluginsInstall(home, args(['plugins', 'install', 'notify-webhook']), output, bundledPluginsRoot)
    
    expect(code).toBe(0)
    
    const dest = join(home, 'plugins', 'notify-webhook')
    expect(existsSync(dest)).toBe(true)
    
    const manifest = JSON.parse(readFileSync(join(dest, 'gitrader-plugin.json'), 'utf8'))
    expect(manifest.source.sha256).not.toMatch(/^sha256:0+$/)
    
    // run-conformance.mjs 不应被拷贝
    expect(existsSync(join(dest, 'run-conformance.mjs'))).toBe(false)
    
    // 随包原件没被改
    const originalManifest = JSON.parse(readFileSync(join(bundledPluginsRoot, 'notify-webhook', 'gitrader-plugin.json'), 'utf8'))
    expect(originalManifest.source.sha256).toMatch(/^sha256:0+$/)
    
    const out = output.getOutput()
    expect(out).toContain('已装到')
    expect(out).toContain('钉版本')
  })

  it('plugins install：随包插件靠产品哈希清单内置信任，不再要求 developerMode；没有清单时报 UNSIGNED_NOT_ALLOWED 但不再叫用户打开 developerMode', async () => {
    const output = io()
    await cmdPluginsInstall(home, args(['plugins', 'install', 'notify-webhook']), output, bundledPluginsRoot)

    const dest = join(home, 'plugins', 'notify-webhook')

    // 没有产品清单、developerMode=false 时应该有问题
    const inspection = inspectPluginDir(dest, { developerMode: false, trustRoots: [], kernelVersion: KERNEL_VERSION })
    expect(inspection.ok).toBe(false)
    expect(inspection.problems.map(p => p.code)).toContain('UNSIGNED_NOT_ALLOWED')

    // developerMode=true 时应该通过
    const inspectionDev = inspectPluginDir(dest, { developerMode: true, trustRoots: [], kernelVersion: KERNEL_VERSION })
    expect(inspectionDev.ok).toBe(true)

    // R2-REL-10：缺清单时的提示不再叫用户“把 developerMode 设为 true”，而是指向重装 / 开发者文档
    const out = output.getOutput()
    expect(out).not.toMatch(/developerMode/)
    expect(out).toMatch(/BUNDLED-HASHES/)
    expect(out).toMatch(/docs\/user\/07/)

    // 随包目录里有构建时生成的清单：装完直接内置信任，developerMode 保持关闭
    writeFileSync(join(bundledPluginsRoot, 'BUNDLED-HASHES.json'), JSON.stringify(bundledHashManifest(bundledPluginsRoot)))
    const second = io()
    expect(await cmdPluginsInstall(home, { cmd: ['plugins', 'install', 'notify-webhook'], flags: { force: true } }, second, bundledPluginsRoot)).toBe(0)
    expect(second.getOutput()).toContain('随包内置信任')
    expect(second.getOutput()).not.toMatch(/developerMode/)
    const trusted = inspectPluginDir(dest, { developerMode: false, trustRoots: [], kernelVersion: KERNEL_VERSION, bundledHashes: bundledHashManifest(bundledPluginsRoot).plugins })
    expect(trusted.ok).toBe(true)
    expect(trusted.trusted).toBe(true)
  })

  it('反例：不存在的名字退出 1，且不写任何东西', async () => {
    const output = io()
    const code = await cmdPluginsInstall(home, args(['plugins', 'install', 'nope']), output, bundledPluginsRoot)
    
    expect(code).toBe(1)
    expect(existsSync(join(home, 'plugins', 'nope'))).toBe(false)
    expect(output.getOutput()).toContain('不存在')
  })

  it('反例：穿越路径被拦截', async () => {
    const output = io()
    const code = await cmdPluginsInstall(home, args(['plugins', 'install', '../evil']), output, bundledPluginsRoot)
    
    expect(code).toBe(1)
    expect(output.getOutput()).toContain('不存在')
  })

  it('反例：已存在且无 --force 退出 1', async () => {
    const output1 = io()
    await cmdPluginsInstall(home, args(['plugins', 'install', 'notify-webhook']), output1, bundledPluginsRoot)
    
    const output2 = io()
    const code = await cmdPluginsInstall(home, args(['plugins', 'install', 'notify-webhook']), output2, bundledPluginsRoot)
    
    expect(code).toBe(1)
    expect(output2.getOutput()).toMatch(/已存在|--force/)
  })

  it('--force 覆盖已存在的插件', async () => {
    const output1 = io()
    await cmdPluginsInstall(home, args(['plugins', 'install', 'notify-webhook']), output1, bundledPluginsRoot)
    
    const dest = join(home, 'plugins', 'notify-webhook')
    const marker = join(dest, 'test-marker.txt')
    writeFileSync(marker, 'old')
    
    const output2 = io()
    const argsWithForce: Args = { cmd: ['plugins', 'install', 'notify-webhook'], flags: { force: true } }
    const code = await cmdPluginsInstall(home, argsWithForce, output2, bundledPluginsRoot)
    
    expect(code).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('plugins install 无参数：列出可用插件', async () => {
    const output = io()
    const code = await cmdPluginsInstall(home, args(['plugins', 'install']), output, bundledPluginsRoot)
    
    expect(code).toBe(0)
    const out = output.getOutput()
    expect(out).toContain('notify-webhook')
    expect(out).toContain('使用：')
  })

  it('examples copy grid：拷进 engines/gitrader-core/strategies', async () => {
    const output = io()
    const code = await cmdExamples(home, args(['examples', 'copy', 'grid']), output, bundledExamplesRoot)
    
    expect(code).toBe(0)
    
    const dest = join(home, 'engines', 'gitrader-core', 'strategies', 'grid.ts')
    expect(existsSync(dest)).toBe(true)
    
    const content = readFileSync(dest, 'utf8')
    expect(content).toContain('grid')
    
    const out = output.getOutput()
    expect(out).toContain('已拷到')
    expect(out).toMatch(/改.*id.*name/)
  })

  it('examples copy template：拷贝空白模板', async () => {
    const output = io()
    const code = await cmdExamples(home, args(['examples', 'copy', 'template']), output, bundledExamplesRoot)
    
    expect(code).toBe(0)
    
    const dest = join(home, 'engines', 'gitrader-core', 'strategies', 'template.ts')
    expect(existsSync(dest)).toBe(true)
  })

  it('examples list：列出十个示例 + template', async () => {
    // 添加更多示例文件
    const strategiesDir = join(bundledExamplesRoot, 'strategies')
    for (const name of ['dca', 'ema-cross', 'momentum-roc']) {
      writeFileSync(join(strategiesDir, `${name}.ts`), `// ${name}`)
    }
    
    const output = io()
    const code = await cmdExamples(home, args(['examples', 'list']), output, bundledExamplesRoot)
    
    expect(code).toBe(0)
    const out = output.getOutput()
    expect(out).toContain('grid')
    expect(out).toContain('dca')
    expect(out).toContain('template')
  })

  it('反例：examples 不存在的名字退出 1', async () => {
    const output = io()
    const code = await cmdExamples(home, args(['examples', 'copy', 'nope']), output, bundledExamplesRoot)
    
    expect(code).toBe(1)
    expect(output.getOutput()).toContain('不存在')
  })

  it('反例：examples 已存在且无 --force 退出 1', async () => {
    const output1 = io()
    await cmdExamples(home, args(['examples', 'copy', 'grid']), output1, bundledExamplesRoot)
    
    const output2 = io()
    const code = await cmdExamples(home, args(['examples', 'copy', 'grid']), output2, bundledExamplesRoot)
    
    expect(code).toBe(1)
    expect(output2.getOutput()).toMatch(/已存在|--force/)
  })
})
