// SPDX-License-Identifier: CPAL-1.0
// 跨包契约 K1：界面里显示的 CLI 命令一律用内核告知的启动器名（便携包里没有全局 gitrader 命令，是 bin\gitrader.cmd），拿不到就写 gitrader。
// 内核在 /api/health 与 status 里带 `launcher` 字段；壳启动时读到就 setLauncher，块与壳的命令文案经 cli() 拼出。
let launcher = ''

export function setLauncher(value: unknown): void {
  launcher = typeof value === 'string' && value.trim() ? value.trim() : ''
}

export const getLauncher = (): string => launcher || 'gitrader'

/** 'gitrader open' → '<启动器> open'；不以 gitrader 开头的原样返回。 */
export function cli(command: string): string {
  return command.replace(/^gitrader(?=\s|$)/, () => getLauncher())
}

/** 启动器是 Windows 批处理 / 带盘符路径（便携包的 gitrader.cmd）：复制进 cmd 的命令要用双引号，单引号 cmd 不认。 */
export const launcherIsWindows = (): boolean => /^"?[a-z]:[\\/]|\.(?:cmd|bat)"?$/i.test(launcher)
