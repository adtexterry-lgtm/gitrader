// SPDX-License-Identifier: CPAL-1.0
// 壳对内核的全部调用集中在这一个文件（壳是特权宿主，不受块清单约束，但同样只经 KernelClient）。
// TODO(protocol): 契约 §4.5 只定义了 Agent 可调的布局 API 与 §5.1 的人面动作名，没有给出壳用的完整查询 / 命令名。
// 凡标 [约定] 的方法名是本包的约定，等 B / E 的 api/ 落地后在这一个文件里改名即可，调用方不受影响。
import type { Workspace, WorkspaceMeta } from '@gitrader/blocks-sdk'
import type { KernelClient } from '@gitrader/blocks-sdk'

export type Network = 'mainnet' | 'testnet'
export type TakeoverLevelName = 'halt_new' | 'cancel_all' | 'flatten_all'
export type ResumeScope = { type: 'org' } | { type: 'account' | 'mandate' | 'group' | 'instrument'; id: string }

/** 钥匙只有元数据，永远没有私钥（内核也不会回传）。 */
export interface KeyInfo {
  id: string
  label: string
  /** API 钱包地址（公开信息）。 */
  address: string
  venue: string
  network: Network
  createdAt: number
  expiresAt?: number
}

/** Agent 钥匙（agentkey.list 的一行；只列壳用到的字段）。 */
export interface AgentKeyInfo {
  keyId: string
  name?: string
  host?: string
  status?: string
  revokedAt?: number
  expiresAt?: number
}

export interface SettingsSnapshot {
  network: Network
  pinSet: boolean
  /** 「允许 Agent 调整布局」：打开后 MCP 才加载 workspace 工具（契约 §5.7）。 */
  agentLayout: boolean
  keys: KeyInfo[]
}

export interface WorkspaceState { workspace: Workspace; revision: number }

export interface InstrumentHit { id: string; name: string; venue?: string }

/** 工作区读写（控制器依赖这个接口，测试用内存实现）。 */
export interface WorkspaceApi {
  current(): Promise<WorkspaceState | null>
  update(ws: Workspace): Promise<WorkspaceState>
  list(): Promise<WorkspaceMeta[]>
  save(name: string, ws: Workspace): Promise<WorkspaceMeta>
  load(name: string): Promise<Workspace>
  /** 一键还原到人最后保存的布局（人面专属）。 */
  revert(): Promise<WorkspaceState>
}

export class HostApi implements WorkspaceApi {
  constructor(readonly kernel: KernelClient) {}

  // ---- 工作区（[约定]：workspace.current / list 为查询，update / save / load / revert 为命令） ----
  async current(): Promise<WorkspaceState | null> {
    return (await this.kernel.query<WorkspaceState | null>('workspace.current')) ?? null
  }
  update(ws: Workspace): Promise<WorkspaceState> {
    return this.kernel.command<WorkspaceState>('workspace.update', { workspace: ws }, { tool: 'ui:workspace.update' })
  }
  async list(): Promise<WorkspaceMeta[]> {
    return (await this.kernel.query<{ workspaces: WorkspaceMeta[] }>('workspace.list')).workspaces
  }
  async save(name: string, ws: Workspace): Promise<WorkspaceMeta> {
    return (await this.kernel.command<{ meta: WorkspaceMeta }>('workspace.save', { name, workspace: ws }, { tool: 'ui:workspace.save' })).meta
  }
  async load(name: string): Promise<Workspace> {
    return (await this.kernel.command<{ workspace: Workspace }>('workspace.load', { name }, { tool: 'ui:workspace.load' })).workspace
  }
  revert(): Promise<WorkspaceState> {
    return this.kernel.command<WorkspaceState>('workspace.revert', {}, { tool: 'ui:workspace.revert' })
  }

  // ---- 界面偏好 [约定]：按数据目录存在内核里（换端口不丢），只同步界面偏好本身 ----
  async getUiPrefs(): Promise<Record<string, unknown>> {
    return (await this.kernel.query<Record<string, unknown> | undefined>('ui.prefs.get')) ?? {}
  }
  setUiPrefs(prefs: Record<string, unknown>): Promise<void> {
    return this.kernel.command('ui.prefs.set', { prefs }, { tool: 'ui:ui.prefs.set' }).then(() => undefined)
  }

  // ---- 设置 / 钥匙 [约定] ----
  settings(): Promise<SettingsSnapshot> {
    return this.kernel.query<SettingsSnapshot>('settings.get')
  }
  /** 切网络：内核只改配置，回 `restartRequired: true`——重启前连接器仍连着旧网络（IXD F7-2：界面要说「重启后生效」，不能说「已切到」）。 */
  setNetwork(network: Network): Promise<{ network?: Network; restartRequired?: boolean } | undefined> {
    return this.kernel.command<{ network?: Network; restartRequired?: boolean } | undefined>('settings.network.set', { network }, { tool: 'ui:settings.network.set' })
  }
  setAgentLayout(enabled: boolean): Promise<void> {
    return this.kernel.command('settings.agent_layout.set', { enabled }, { tool: 'ui:settings.agent_layout.set' }).then(() => undefined)
  }
  /** 设置 / 修改 PIN。修改时 current 为旧 PIN（同时作为在场证明）。PIN 只经本机回环发给内核，不落盘不进日志。内核可能回 `hint`（原文，界面照原文提示）。 */
  setPin(pin: string, current?: string, confirmWeak?: boolean): Promise<{ changed?: boolean; hint?: string } | undefined> {
    return this.kernel.command<{ changed?: boolean; hint?: string } | undefined>('pin.set', confirmWeak ? { pin, confirmWeak: true } : { pin }, current ? { tool: 'ui:pin.set', attestation: { method: 'pin', pin: current } } : { tool: 'ui:pin.set' })
  }
  /** 导入 API 钱包私钥（契约 §5.1 `credential.import`，会话即可）。调用后调用方立刻清空输入。 */
  importKey(secret: string, label: string, network: Network): Promise<KeyInfo> {
    return this.kernel.command<{ key: KeyInfo }>('credential.import', { secret, label, network }, { tool: 'ui:credential.import' }).then((r) => r.key)
  }
  /** 内核生成一把新的 API 钱包钥匙：私钥不出内核，只回地址。 */
  generateKey(label: string, network: Network): Promise<KeyInfo> {
    return this.kernel.command<{ key: KeyInfo }>('credential.generate', { label, network }, { tool: 'ui:credential.generate' }).then((r) => r.key)
  }
  revokeKey(id: string): Promise<void> {
    return this.kernel.command('credential.revoke', { id }, { tool: 'ui:credential.revoke' }).then(() => undefined)
  }
  /** Agent 钥匙列表（与 API 钱包不同：这是接入的 AI）。 */
  async agentKeys(): Promise<AgentKeyInfo[]> {
    const r = await this.kernel.query<AgentKeyInfo[] | { keys: AgentKeyInfo[] }>('agentkey.list')
    return Array.isArray(r) ? r : r?.keys ?? []
  }
  /** 撤销 Agent 钥匙：内核要 PIN（回 ATTESTATION_REQUIRED → KernelClient 的 attestor 弹 PinDialog 后重发）。 */
  revokeAgentKey(keyId: string): Promise<{ withdrawn?: number; openPositions?: number; openOrders?: number } | undefined> {
    return this.kernel.command('agentkey.revoke', { keyId }, { tool: 'ui:agentkey.revoke' })
  }

  // ---- 接管 / 恢复（契约 §5.6） ----
  takeover(level: TakeoverLevelName, reason: string): Promise<unknown> {
    return this.kernel.command(`takeover.${level}`, { reason, scope: { type: 'org' } }, { tool: `ui:takeover.${level}` })
  }
  /** 从 REDUCING / HALTED 恢复 ACTIVE：只有人，要在场证明（内核回 ATTESTATION_REQUIRED → PIN 弹层）；scope 缺省 = 全局。 */
  resume(scope: ResumeScope = { type: 'org' }): Promise<unknown> {
    return this.kernel.command('trading_state.resume', { scope }, { tool: 'ui:trading_state.resume' })
  }

  // ---- 标的搜索（⌘K 切标的）[约定] ----
  async searchInstruments(q: string): Promise<InstrumentHit[]> {
    return (await this.kernel.query<{ hits: InstrumentHit[] }>('instruments.search', { q, limit: 20 })).hits
  }
}

/** 内核没有提供某个接口（METHOD_NOT_FOUND）。 */
export const isMethodMissing = (e: unknown): boolean => (e as { code?: number })?.code === -32601
