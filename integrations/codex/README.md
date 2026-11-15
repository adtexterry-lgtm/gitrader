# Gitrader × Codex

1. 起服务：`gitrader serve`（默认纸面）。
2. 创建钥匙：`gitrader keys new agent "Codex" --host codex --preset starter --token-file <令牌文件>`（要输 PIN）。令牌写进这个文件，不显示在屏幕上；`starter` 是需确认档，每笔新开仓都要你批准。纸面直通档（`--tier paper`，纸面单直接成交、不等你批准）是另一回事，需要时再选。
3. `gitrader mcp snippet codex --token-file <令牌文件>`，把输出追加到 `~/.codex/config.toml`（片段只写令牌文件的路径，不含令牌）。
4. 验证：片段末尾的 `... --check`，或 `codex mcp list`。
5. 技能（可选）：把 `integrations/SKILL.md` 的要点放进项目 `AGENTS.md`。

## 首次上手

首次从零安装、接入、提第一单，见上手技能 `gitrader-onboarding`：`integrations/claude-code/SKILL.md`。技能按七步走，人只需要在浏览器输 PIN、在待批里点批准。

---

## English

1. Start the service: `gitrader serve` (paper by default).
2. Create a key: `gitrader keys new agent "Codex" --host codex --preset starter --token-file <token file>` (asks for your PIN). The token goes into that file and is never shown on screen; `starter` is the confirm tier, so every new position needs your approval. The paper pass-through tier (`--tier paper`, paper orders fill without waiting for you) is a different thing; pick it only when you want that.
3. `gitrader mcp snippet codex --token-file <token file>`, and append the output to `~/.codex/config.toml` (the snippet holds the token file path, never the token).
4. Verify: run the `... --check` line at the end of the snippet, or `codex mcp list`.
5. Skill (optional): put the key points of `integrations/SKILL.md` into your project's `AGENTS.md`.

### First time

For a first install, connection and first order, see the onboarding skill `gitrader-onboarding`: `integrations/claude-code/SKILL.md`. It runs in seven steps; you only type the PIN in the browser and click approve in the pending list.
