> License: CPAL-1.0 (open source; end-user UIs must display "Powered by Gitrader", see LICENSE).

# gitrader

**Gitrader is an open-source AI quant trading base: embed it in any agent, and combine it with any functional trading plugin.** It is a resident local kernel (paper trading, backtests and research, exposed as MCP and CLI tools) plus a workbench you review in the browser. The kernel holds the keys, enforces risk limits and writes the ledger.

No custody, no strategies for sale. Orders executed through the workbench cannot bypass the risk gate. Malicious code running as the same OS user is outside the security guarantee.

License: CPAL-1.0, open source (attribution required: "Powered by Gitrader"; see LICENSE, Exhibit B).

## Install and run

Requires Node.js >= 22.13. Nothing else (no Git, no Python, no Java).

```
npx gitrader init
npx gitrader serve
```

`init` creates `~/.gitrader/` (`gitrader.json`, `plugins/ engines/ workspaces/ lab/`) and asks you to choose a PIN. `serve` starts the local kernel and the workbench and prints a one-time link. `serve --offline` starts without market data connections.

Connect your Agent over MCP (up to 17 tools; the exact number depends on the key and is printed with the snippet). Create a key, with the token written to a file instead of the screen, then print the host snippet:

```
npx gitrader keys new agent my-agent --host claude-code --preset starter --token-file <token file>
npx gitrader mcp snippet claude-code --token-file <token file>   # or codex | hermes | cursor | generic | unigit
```

`--preset starter` is the confirm tier: it asks for your PIN and every new position needs your approval. The paper pass-through tier (`--tier paper`) fills paper orders without asking you.

Options worth knowing:

- `--lang zh|en` (or `GITRADER_LANG`) picks the output language for the first-run commands (`--help`, `init`, `serve`, `open`, `status`, `doctor`). Without it the system locale decides: `zh*` gives Chinese, anything else English.
- `serve --detach --open` starts the service in the background, prints a two-minute login link and opens the browser. `--open` only works together with `--detach`.
- `GITRADER_LAUNCHER` is set by the portable bundle to its launcher name (for example `start.cmd`); when set, commands in the CLI output are written with that name instead of `gitrader <subcommand>`. JSON output is unchanged.

Other commands: `status`, `keys`, `plugins`, `engines`, `ledger verify`, `ledger export`. Run `npx gitrader --help` for the full list.

## What is inside the package

| File | What |
|---|---|
| `dist/bin.js` | command line + kernel (single file) |
| `dist/gitrader-mcp.js` | MCP server (`gitrader-mcp`) |
| `dist/engine-core.mjs` | reference engine (GEP over stdio), started by the kernel |
| `dist/workbench/` | the workbench (static files served by the kernel on 127.0.0.1) |

Third-party notices: `THIRD-PARTY-NOTICES.md`.
