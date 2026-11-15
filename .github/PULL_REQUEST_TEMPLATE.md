## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`, which adds `Signed-off-by: Name <email>`). The DCO check fails otherwise; see CONTRIBUTING.md.
- [ ] `npm test` and `npm run typecheck` pass locally.
- [ ] **零承诺语言**：新增 / 改动的产品文案没有承诺词（清单见 `scripts/check-public.mjs` 的禁词表与 `packages/protocol` 的 `findPromiseLanguage`；`node scripts/check-public.mjs` 会扫）。不写收益、不写「帮你赚钱」、不写未来承诺。
- [ ] **不改协议冻结字段**：`packages/protocol/schemas/*.json` 里已冻结的字段名、类型、枚举、错误码没有改名、改语义或删除；确需新增字段先在 `packages/protocol/CHANGELOG.md` 登记一条，且只追加。
- [ ] **测试只增不减**：没有删除、跳过（`.skip` / `.todo`）或弱化既有断言；行为变了就改期望值并在 PR 里说明。少一个用例要在下面写清原因。
- [ ] New fields / enums / error codes are registered in `packages/protocol/CHANGELOG.md` first (fields follow `packages/protocol`; no private per-package fields).
- [ ] No keys, tokens, local paths, e-mail addresses or internal notes in the diff (`node scripts/check-public.mjs`).
- [ ] If this touches money paths (orders, risk gate, ledger, signer): tests cover the denied and unknown-outcome cases, and nothing weakens the human-only actions.
- [ ] Docs updated if behaviour changed.

## Not covered / risks

<!-- What you did not test (real venue, real money, Windows, ...). -->
