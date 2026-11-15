# Gitrader Docker delivery

[中文](README.zh-CN.md)

A single container runs `gitrader serve`: kernel + workbench + reference engine, with data in a named volume. The observability stack (Prometheus / Alertmanager / Grafana) is an **optional second profile** and does not start by default.

This delivery is a containerised **runtime form** and does not change Gitrader's security model: the kernel remains a local service, all `/api` requests require a Bearer token (`/api/health` excepted), and keys live only in `<GITRADER_HOME>`, read and written by owner 10001.

## Prerequisites

- Docker 24+, Docker Compose v2 (`docker compose version`).
- The build context is the **repository root** (not this directory): the image runs `npm ci` for the full workspace and then `npm run build`.
- The first build needs network access to pull the base image and npm dependencies; at runtime, the container can start without network (market connection failures only affect market data).

## Start

### First run: automatic initialisation or manual PIN setup

On the first start, if the data directory is not yet initialised, the container automatically runs `init --no-pin` before starting `serve`. You can therefore start directly with:

```sh
cd docker
cp .env.example .env
docker compose build
docker compose up -d --build
```

The workbench prints a one-time link (valid for two minutes, single use) in the logs. Retrieve it with:

```sh
docker compose logs gitrader
```

Open that link in your browser, and set the PIN in the workbench interface.

**Alternative: manual init before first serve** (optional, the original approach still works)

If you prefer to set the PIN interactively in the terminal before starting the service:

```sh
docker compose run --rm --entrypoint node gitrader packages/cli/dist/bin.js init
```

The terminal prompts you to enter the PIN twice. `init` is idempotent: if the instance is already initialised, it only prints a message and does not overwrite.

After the instance is initialised and the PIN is set, `open --print` can retrieve a workbench link using that PIN:

```sh
docker compose exec gitrader node packages/cli/dist/bin.js open --print
```

To view status or ledger without opening the workbench:

```sh
docker compose exec gitrader node packages/cli/dist/bin.js status
docker compose exec gitrader node packages/cli/dist/bin.js ledger
```

### Host port must equal GITRADER_PORT

The service validates the `Host` header to prevent DNS rebinding attacks. It only accepts loopback addresses plus the service's own port: `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`.

The `docker-compose.yml` already publishes both sides on the same port. If you need to change the port, edit `GITRADER_PORT` in `.env` (both the container's listening port and the host's published port change together).

**Incorrect**: `docker run -p 127.0.0.1:48000:47900 ...` → the browser sends `Host: 127.0.0.1:48000`, but the service expects `Host: 127.0.0.1:47900` → `403 Host not allowed`.

**Correct**: `docker run -e GITRADER_PORT=48000 -p 127.0.0.1:48000:48000 ...`

## Stop

```sh
docker compose down          # stop containers, keep gitrader-data volume (ledger, config, keyring stay)
docker compose down -v       # remove the volume too: deletes the whole instance including the keyring; back up first
```

## Upgrade

```sh
cd docker
git -C .. pull --ff-only                # or swap in a different source tree
docker compose build --pull gitrader    # re-run npm ci + npm run build with the new code
docker compose up -d gitrader
```

Data stays in the named volume; the upgrade does not touch it. To roll back, check out the old tag and `build` + `up -d` again. If there is a volume format migration, it will fail loudly in `docker compose logs gitrader` and will not silently alter data.

## Back up and restore the volume

The volume name is `gitrader_gitrader-data` (compose project name + volume name):

```sh
# Back up (stop the service first to ensure the ledger is not half-written)
docker compose stop gitrader
docker run --rm -v gitrader_gitrader-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/gitrader-data-$(date +%Y%m%d).tgz -C /data .
docker compose start gitrader

# Restore (clear the volume first, then unpack)
docker compose stop gitrader
docker run --rm -v gitrader_gitrader-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/gitrader-data-YYYYMMDD.tgz -C /data'
docker compose start gitrader
```

The backup contains `service.json` (the service token), `keys/` (PIN and device key), the ledger and experiment artefacts. **Treat it as a cryptographic key**: do not send it via chat apps, do not commit it to repositories, and do not put it on shared drives. If it and the PIN are both leaked, the instance is compromised.

## How to pass secrets

The image and compose files **contain no secret values**. Three entry points:

1. **Runtime environment variables** (read by the kernel): secret fields in `gitrader.json` can be written as handles like `env:VARIABLE_NAME`, and `serve` resolves them from its own environment at startup. Supply these in compose via `environment:` or `env_file:`. Put the actual values in a file on the host, and do not write them into `.env.example` or commit them to the repository.

2. **File references (`*_file`)** (used by the observability stack): Prometheus's `authorization.credentials_file`, Alertmanager's `bot_token_file` / `credentials_file` / `auth_password_file`, and Grafana's `GF_SECURITY_ADMIN_PASSWORD__FILE`. These point to files under `docker/secrets/`, which compose mounts read-only into the containers:

   ```sh
   mkdir -p docker/secrets
   printf '%s\n' '<token>' > docker/secrets/gitrader-metrics-token
   chmod 600 docker/secrets/gitrader-metrics-token
   ```

   Only `README.md` and `.gitignore` in this directory are tracked; actual secret files are excluded by `docker/secrets/.gitignore`.

3. **CLI inside the container**: `docker compose exec gitrader node packages/cli/dist/bin.js keys import <name>` — the private key is read from the terminal, does not appear in argv, logs or image layers.

## Health check

The image includes a `HEALTHCHECK`: every 30 seconds it runs `GET /api/ready`, using the service token from `/data/service.json` inside the container with `Authorization: Bearer` (this route requires authentication; `/api/health` is the only unauthenticated data endpoint). The token does not appear in the command line, image layers or `docker inspect` output — the probe reads it from the file.

`/api/ready` returns 200 when "kernel is up + ledger is readable", otherwise 503. A `HALTED` trading state **does not** count as unhealthy (it is orthogonal to readiness). For details:

```sh
docker inspect --format '{{json .State.Health}}' gitrader | head -c 400
```

## Observability (optional profile)

```sh
# Write the admin password file first, or Grafana will not start
printf '%s\n' '<strong-password>' > docker/secrets/grafana-admin
docker compose --profile observability up -d
```

- Prometheus `127.0.0.1:9090`, configuration and rules mount `../ops/prometheus/{prometheus.yml,alerts.yml}` directly (does not modify the repository files).
- Alertmanager `127.0.0.1:9093`, configuration mounts `../ops/alertmanager/alertmanager.yml` (all receivers are placeholder templates).
- Grafana `127.0.0.1:3000`, pre-provisioned data source and `gitrader-overview` dashboard (`../ops/grafana/**`).
- Scrape targets are written in `ops/prometheus/prometheus.yml` (`127.0.0.1:47900`). **Prometheus inside a container cannot scrape another container's loopback interface** — see the next section. To make it work, change targets to `host.docker.internal:47900` and make the kernel accept this Host (subject to the same restrictions described in the next section).

## Network reachability (must read, stated plainly)

The container entrypoint explicitly binds with `serve --host` to a container interface, and compose's `ports:` can forward to that listening port. `GITRADER_BIND` still controls only the **host-side** publish address and defaults to loopback only. The kernel's Host authentication whitelist keeps its original rule and only accepts three Host formats: `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>` (to prevent DNS rebinding). Neither the container's listening address nor the host's published address relaxes this whitelist, so you cannot claim that arbitrary remote Hosts can access it.

Log format is chosen by `GITRADER_LOG_FORMAT`, default `text`, also accepts `json`; `GITRADER_LOG_LEVEL` is not yet a working level switch.

## Known limitations

- **What has been verified**: before the 0.1.0 release this image was built and started on a real Docker host with the port rule above, and `/api/health` returned 200. `node docker/verify-docker.mjs` additionally performs offline structural validation (COPY paths exist, files referenced by compose exist, `.env.example` has no secret patterns, this file has no forbidden words or local paths).
- The build context uses `docker/Dockerfile.dockerignore` (BuildKit's "same name as Dockerfile" ignore file, default in Docker 23+) to exclude `.git`, `node_modules`, each package's `dist`, `reports`, backup tgz files, `.env` and `docker/secrets`. With older Docker or BuildKit disabled, it does not take effect and the context will include these directories (still builds, just sends more slowly).
- Logs have no level switch; `GITRADER_LOG_LEVEL` is currently only passed through (already noted in `.env.example`).
- The base image uses `node:22-alpine` (follows the latest 22.x patch); for reproducible builds, pin it by digest yourself.
- The image does not include `git`, `curl`, or shell tooling, only node and `packages/cli/dist` (bin.js / gitrader-mcp.js / engine-core.mjs / workbench/). To invoke libraries, use `docker compose exec` + node.
