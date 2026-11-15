# Gitrader × Hermes Agent

1. 起服务：`gitrader serve`（默认纸面）。
2. 创建钥匙：`gitrader keys new agent "Hermes" --host hermes --preset starter --token-file <令牌文件>`（要输 PIN）。令牌写进这个文件，不显示在屏幕上；`starter` 是需确认档，每笔新开仓都要你批准。纸面直通档（`--tier paper`，纸面单直接成交、不等你批准）是另一回事，需要时再选。
3. `gitrader mcp snippet hermes --token-file <令牌文件>`，把输出并入 `~/.hermes/config.yaml` 的 `mcp_servers` 段，重启 Hermes。
4. 验证：片段末尾的 `... --check`。
5. 技能（可选）：把 `integrations/SKILL.md` 复制到 `~/.hermes/skills/gitrader/SKILL.md`。
6. 如果 Hermes 没认到令牌，检查它是否把配置里的环境变量传给了 MCP 子进程；按 stdio MCP 的惯例写的片段，以 Hermes 自己的文档为准。

## 首次上手

首次从零安装、接入、提第一单，见上手技能 `gitrader-onboarding`：`integrations/claude-code/SKILL.md`。技能按七步走，人只需要在浏览器输 PIN、在待批里点批准。

---

## English

1. Start the service: `gitrader serve` (paper by default).
2. Create a key: `gitrader keys new agent "Hermes" --host hermes --preset starter --token-file <token file>` (asks for your PIN). The token goes into that file and is never shown on screen; `starter` is the confirm tier, so every new position needs your approval. The paper pass-through tier (`--tier paper`, paper orders fill without waiting for you) is a different thing; pick it only when you want that.
3. `gitrader mcp snippet hermes --token-file <token file>`, merge the output into the `mcp_servers` section of `~/.hermes/config.yaml`, and restart Hermes.
4. Verify: run the `... --check` line at the end of the snippet.
5. Skill (optional): copy `integrations/SKILL.md` to `~/.hermes/skills/gitrader/SKILL.md`.
6. If Hermes does not pick up the token, check that it passes the configured environment variables to the MCP child process. The snippet follows the usual stdio MCP convention; Hermes's own documentation is authoritative.

### First time

For a first install, connection and first order, see the onboarding skill `gitrader-onboarding`: `integrations/claude-code/SKILL.md`. It runs in seven steps; you only type the PIN in the browser and click approve in the pending list.
