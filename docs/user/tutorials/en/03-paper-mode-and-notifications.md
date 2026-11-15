# Tutorial 03 · Paper mode, a notification channel, and one delivered notification

This tutorial takes "kernel up → install a notification channel plugin → configure the channel → actually deliver a
notification" from start to finish. Everything runs in **paper mode** (the `paper` account) with `--offline`: no real
venue, no orders.

Two habits the tutorial keeps throughout:

- **Use the tutorial's own home directory** (`./tutorial-lab/kernel` under the repository root) so your real
  `~/.gitrader` is never touched; if you break it, delete the directory and start over.
- **Secrets live in the environment only**: the configuration stores handles such as `env:WEBHOOK_SECRET`, and the
  value sits in the environment of the process that starts the kernel.

## 1. Create the home directory and initialise it

```bash
gitrader init --home ./tutorial-lab/kernel
```

It creates the home directory plus six subdirectories and writes a default `gitrader.json` (one testnet venue, one
paper account, one built-in engine). On an interactive terminal it then asks for a PIN (6–12 digits, or an 8–64
character passphrase); the PIN never reaches logs or the ledger and cannot be passed as a command-line argument.

## 2. Start the kernel in paper mode

```bash
gitrader serve --offline --home ./tutorial-lab/kernel --port 48950
```

Expected output:

```text
Gitrader 0.1.1 is running on 127.0.0.1:48950
Open the workbench (link valid for 2 minutes, one use):
  http://127.0.0.1:48950/?launch=boot_...
Press Enter in this terminal for a fresh link. Press Ctrl+C to stop.
```

The service binds `127.0.0.1` only; `--offline` means no market data (accounts, ledger, plugins and strategy files
work as usual). This command holds the terminal — do not close it yet.

## 3. Check the state from a second terminal

```bash
gitrader status --home ./tutorial-lab/kernel
```

It prints version and pid, trading state (`ACTIVE` / `REDUCING` / `HALTED`), risk policy version, ledger sequence and
entry count, accounts (with `mode: paper`), venue connection state, connector / engine / plugin counts, and whether a
PIN is set. Add `--json` for machine-readable output.

## 4. Stop the service (the grant step wants it stopped)

Go back to the terminal from step 2 and press Ctrl+C — that is what this step does:

```bash
# press Ctrl+C in the serve terminal
```

The grant entry point (`plugins grant`, next steps) needs a local PIN and requires that no service is running, so
two processes never write permissions at the same time.

## 5. Install the channel plugin

In Gitrader a notification channel is not built in — it is a **plugin**: any plugin declaring the `notify_send` tool
is a channel. The bundled Webhook plugin lives in `packages/plugin-notify-webhook/`; copy it into the home
directory's `plugins/`:

```bash
cp -r packages/plugin-notify-webhook ./tutorial-lab/kernel/plugins/notify-webhook
```

```bash
rm -rf ./tutorial-lab/kernel/plugins/notify-webhook/node_modules
```

(`node_modules/` is only the local development dependency folder; the plugin needs just its `.mjs` files and the
manifest at run time.)

Changing files means re-pinning the version (which writes `source.sha256`), then checking the manifest:

```bash
gitrader plugins pin ./tutorial-lab/kernel/plugins/notify-webhook
```

```bash
gitrader plugins check ./tutorial-lab/kernel/plugins/notify-webhook
```

A passing check prints `ok connector.gitrader.notify-webhook@0.1.0` and exits 0; otherwise it exits 2 and lists every
problem.

## 6. Configure a channel (and turn on developer mode)

The configuration lives in the `notify` section of `./tutorial-lab/kernel/gitrader.json`. Each `notify.channels[]` entry
is `{ id, plugin, minLevel, params }`, where `params` only carries **non-secret** target parameters (`url` / `chatId`
/ `to`…); secrets always go through `env:` handles in `plugins.secrets`.

```bash
node docs/user/tutorials/add-notify-channel.mjs \
  --home ./tutorial-lab/kernel \
  --id main \
  --url http://127.0.0.1:8787/hook \
  --min-level warn
```

It touches three places and leaves every other key alone: `plugins.developerMode`,
`plugins.secrets["connector.gitrader.notify-webhook"].WEBHOOK_SECRET = "env:WEBHOOK_SECRET"`, and a `main` entry in
`notify.channels`.

**Why developer mode first**: the bundled channel plugin is unsigned, and the kernel loads unsigned plugins only when
`plugins.developerMode: true`; without it the next step's grant is rejected (`UNSIGNED_NOT_ALLOWED`). Developer mode
is a local-development trade-off — it relaxes "must be signed" but **cannot** request permissions such as
`trade.live` or `venue.credentials`. For third-party plugins go back to signatures and trust roots.

The resulting configuration looks like this (excerpt):

```json
{
  "plugins": {
    "developerMode": true,
    "secrets": { "connector.gitrader.notify-webhook": { "WEBHOOK_SECRET": "env:WEBHOOK_SECRET" } }
  },
  "notify": {
    "channels": [
      { "id": "main", "plugin": "connector.gitrader.notify-webhook", "minLevel": "warn",
        "params": { "url": "http://127.0.0.1:8787/hook" } }
    ],
    "rules": [ { "match": "*", "level": "warn", "channels": ["main"] } ]
  }
}
```

`minLevel` is the channel's minimum level (`info` / `warn` / `critical`): notifications below it skip this channel.
`rules` route by `topic` prefix (`risk.*`, `takeover.*`…); `match: "*"` sends everything to `main`.

## 7. Grant the permission (needs your PIN)

The plugin declares the `net.fetch` permission, and a human has to grant it once — this needs the PIN and a stopped
service:

```bash
gitrader plugins grant connector.gitrader.notify-webhook net.fetch --home ./tutorial-lab/kernel
```

On success it prints `granted connector.gitrader.notify-webhook: [net.fetch]`. Take a look at the list:

```bash
gitrader plugins list --home ./tutorial-lab/kernel
```

The row has the shape `ok  <id>  <version>  connector  granted:[net.fetch]  pending:[]  enabled:yes`.

## 8. Start a local receiver

You do not need Feishu / DingTalk / Slack to verify the path: this little service, bound to the loopback address
only, acts as the webhook endpoint.

```bash
node docs/user/tutorials/notify-sink.mjs --port 8787
```

It prints `通知接收器已起：http://127.0.0.1:8787/hook（Ctrl+C 停止）` and, for every request, the method, path and body.
This one holds a terminal too — **open another terminal** for the next step.

## 9. Send a test notification

The secret handle has to resolve in the **environment of the process that starts the kernel**. For a real channel put
the signing secret your platform gave you here; the local receiver does not verify signatures, so a placeholder is
fine:

```bash
export WEBHOOK_SECRET='local-lab-placeholder'
```

```bash
gitrader notify test main --home ./tutorial-lab/kernel
```

`notify test` sends one fixed info diagnostic message (title "通知通道测试", body carries the channel id) through the
real path: kernel notification outlet → plugin → your endpoint. Success exits 0:

```text
{
  "results": [
    {
      "channelId": "main",
      "ok": true
    }
  ]
}
```

Back in the terminal from step 8 you should see the delivered body:

```text
#1 2026-10-21T08:40:11.000Z POST /hook
  {"text":"通知通道测试\nchannelId: main"}
```

## 10. Clean up

Press Ctrl+C in both terminals that were held:

```bash
# press Ctrl+C in the notify-sink terminal
```

With no service running, `gitrader status` states the state and the next command and still exits 0; in scripts
branch on the `running` field of `--json`:

```bash
gitrader status --home ./tutorial-lab/kernel
```

## 11. Switching to a real channel

Just replace the `--url` from step 6 with your platform's webhook address; nothing else changes (`params.url`
determines the dialect):

| Platform | `url` shape | Signing secret |
|---|---|---|
| Feishu | `https://open.feishu.cn/open-apis/bot/v2/hook/<token>` | optional, `WEBHOOK_SECRET` |
| DingTalk | `https://oapi.dingtalk.com/robot/send?access_token=<token>` | optional, `WEBHOOK_SECRET` |
| WeCom | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>` | none (the key is in the URL) |
| Slack | `https://hooks.slack.com/services/<...>` | none |
| Discord | `https://discord.com/api/webhooks/<...>` | none |
| self-hosted | your own `http(s)://` endpoint | up to your service |

Telegram and SMTP are two other plugins (`plugin-notify-telegram` / `plugin-notify-email`) with different
parameters, see `docs/user/06-通知配置.md`.

## 12. Three behaviours worth knowing

1. **The body carries structured facts only.** Free text such as proposal reasons, takeover reasons, notes or
   strategy descriptions never enters a notification body — a notification tells you *what happened*, it does not
   forward what a model said.
2. **One takeover produces one message.** Takeovers are correlated by `takeoverId`; stage updates inside the dedupe
   window are not re-sent, and a failure stage sends one separate `critical` message.
3. **Short secret values are not printed either.** Secret values in results and logs (including their base64 form)
   are replaced with `<redacted>`; when a URL appears in an error only `origin + first path segment` is kept and the
   query string is dropped.

## 13. Troubleshooting

| Symptom / return | Cause | Fix |
|---|---|---|
| `MANDATE_LIMIT ... not enabled` | the plugin was never granted | go back to step 7 and run `plugins grant` |
| `missing secret handle: WEBHOOK_SECRET` | the config has the handle but the process environment has no such variable | `export WEBHOOK_SECRET=...` and rerun |
| `reason: "network_error:fetch failed"` | nothing is listening / wrong address | make sure the receiver runs and the `url` port and path match |
| `REJECTED 1 problem(s)  UNSIGNED_NOT_ALLOWED` | developer mode is off | the step 6 script turns it on; do not forget it when editing by hand |
| `unknown channel` | no such id in `notify.channels` | `--id` and `notify test <id>` must match |

## 14. Done — you should be able to answer

- Why does `plugins grant` require the service to be stopped?
- Why is the strategy's reason text absent from the notification body?
- Set `--min-level` to `critical` and send the test again. What happens? (Hint: `notify test` is a diagnostic that bypasses routing, dedupe, rate limits and the level filter, so it is still delivered; `critical` filters the `info` / `warn` notices of real events.)

Back to the index: [Tutorials](README.md).
