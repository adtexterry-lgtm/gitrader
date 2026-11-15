// SPDX-License-Identifier: CPAL-1.0
// fix-r5 GQ-07：配置整份不见时，从账本 / 纸面状态 / 授权书三处找回已有的纸面账户 id（只读，不写库、不写账本）。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { sqlitePath } from './db'
import { KernelError } from './util/errors'
import { makeProblem } from './proto'

/** 库文件存在却读不出来：重建必须拒绝（fail-closed），否则会拿新 accountId 配旧账本。 */
function corruptLedger(dbPath: string, cause: unknown): KernelError {
  return new KernelError(makeProblem('STATE_FILE_CORRUPT',
    `ledger database exists but cannot be read: ${dbPath} (${cause instanceof Error ? cause.message : String(cause)}); restore it from a backup, or repair the file before rebuilding the config. ` +
    `账本数据库存在但读不出来：先还原 / 修复这个文件，再重建配置（拒绝在旧账本上用新账户 id 重建）`))
}

/** 从账本 / 纸面状态 / 授权书三处读回已知的账户 id（只读，不写库、不写账本）。
 *  paper-state.json 读得出时，只留出现在它里面的 id（实盘账户永远不在纸面状态里，避免把实盘账户 id 套到纸面账户上）。 */
export function knownAccountIds(dbPath: string, paperStatePath: string): { ids: string[]; ledgerCounts: Record<string, number> } {
  const ledgerCounts: Record<string, number> = {}
  const fromLedger = new Set<string>()
  const fromMandates = new Set<string>()
  let paperAccountIds: string[] | undefined

  // 1. 账本
  if (existsSync(dbPath)) {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(sqlitePath(dbPath), { readOnly: true })
    } catch (e) {
      throw corruptLedger(dbPath, e)
    }
    try {
      const rows = db.prepare('SELECT account_id a, COUNT(*) c FROM ledger WHERE account_id IS NOT NULL GROUP BY account_id').all() as Array<{ a: string; c: number }>
      for (const r of rows) {
        fromLedger.add(r.a)
        ledgerCounts[r.a] = r.c
      }
      // 2. 授权书（在同一个库里）
      const docs = db.prepare('SELECT doc FROM docs WHERE coll=?').all('mandate') as Array<{ doc: string }>
      for (const { doc } of docs) {
        try {
          const parsed = JSON.parse(doc) as { accounts?: unknown }
          if (Array.isArray(parsed.accounts)) {
            for (const id of parsed.accounts) if (typeof id === 'string' && id.startsWith('acct_')) fromMandates.add(id)
          }
        } catch { /* 坏文档跳过 */ }
      }
    } catch (e) {
      throw corruptLedger(dbPath, e)
    } finally {
      db.close()
    }
  }

  // 3. paper-state.json
  if (existsSync(paperStatePath)) {
    try {
      const raw = readFileSync(paperStatePath, 'utf8')
      const state = JSON.parse(raw) as { accounts?: Array<{ id?: unknown }> }
      if (Array.isArray(state.accounts)) {
        paperAccountIds = state.accounts.map((a) => a.id).filter((id): id is string => typeof id === 'string' && id.startsWith('acct_'))
      }
    } catch { /* 读不出就当没有这一来源 */ }
  }

  // 合并：如果 paper-state.json 读得出，只留出现在它里面的 id（实盘账户不在纸面状态里）
  // paper-state 里的 id 全部收进候选（即使不在账本里）
  const all = new Set([...fromLedger, ...fromMandates])
  if (paperAccountIds !== undefined) {
    // paper-state 存在：只返回在 paper-state 里的 id（包括仅在 paper-state 里、不在账本里的）
    for (const id of paperAccountIds) all.add(id)
    return { ids: paperAccountIds, ledgerCounts }
  }
  
  return { ids: Array.from(all), ledgerCounts }
}
