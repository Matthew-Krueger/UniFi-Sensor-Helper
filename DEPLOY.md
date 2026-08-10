# Deploy

## Overview

Ships as a Docker image (Bun runtime, pinned in `Dockerfile` and
`.bun-version`) run under `systemd` on a dedicated, unprivileged Debian 13
user. The image contains the compiled Next.js app plus the custom
`server.ts` entrypoint, which boots the latch engine and terminates HTTPS
itself before Next ever handles a request. `next start` is never used.

## One-time Debian 13 setup

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin latch
sudo usermod -aG docker latch   # or run rootless docker under this user
sudo mkdir -p /opt/unifi-sensor-latch/{data,certs}
sudo chown -R latch:latch /opt/unifi-sensor-latch
```

Place `.env` and the TLS cert/key under `/opt/unifi-sensor-latch/`, owned by
`latch:latch`, mode `600`. Nothing in this repo's source or `config`
generates these for you automatically — see below.

## TLS cert (self-signed)

```bash
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 825 -subj "/CN=unifi-sensor-latch"
```

Regenerate before the 825-day expiry. Never commit `certs/`.

## Build

Mac dev build vs. deploy build differ only in what's targeted:

- **Mac dev**: `bun install && cd apps/web && bun run server.ts` (runs
  against `next dev`-equivalent via `NODE_ENV` unset) for iteration, no
  Docker required.
- **Deploy**: `docker build -t unifi-sensor-helper .` for the host
  machine's own architecture. For a different target architecture (e.g.
  building on an Apple Silicon Mac for an x86 machine with no shared
  registry), use `docker buildx` with `--load` to pull the result back
  into local Docker instead of `docker push`:

  ```bash
  # Native (fast) — arm64 image, usable directly on this Mac
  docker buildx build --platform linux/arm64 -t unifi-sensor-helper:arm64 --load .

  # Cross-build (slow — next build runs under QEMU emulation, several
  # minutes) — amd64 image for the x86 machine
  docker buildx build --platform linux/amd64 -t unifi-sensor-helper:amd64 --load .

  # Transfer without a registry: save to a tarball, copy it over, load it there
  docker save unifi-sensor-helper:amd64 -o unifi-sensor-helper-amd64.tar
  # on the x86 machine:
  docker load -i unifi-sensor-helper-amd64.tar
  ```

  If a registry is available, `docker buildx build --platform
  linux/amd64,linux/arm64 -t <registry>/unifi-sensor-helper:<tag> --push .`
  builds and pushes a single multi-arch manifest instead — simpler when
  it's an option.

**Not `output: 'standalone'`.** Tried it; reverted after live testing
against this repo's actual monorepo + custom-server setup. Next's
standalone output only preserves what Next's *own* bundled route code
needs — it does not keep workspace packages (`@unifi-sensor-latch/engine`)
resolvable for `server.ts`'s own top-level imports, since `server.ts` is
a separate Bun entrypoint that sits outside Next's webpack trace
entirely. Confirmed by two live failures (`Cannot find module
'@unifi-sensor-latch/engine'`, and separately `next` itself unresolvable
from a mismatched double-nested standalone directory layout) before
switching the runtime stage to ship the full, real `node_modules` built by
the `build` stage instead — the same tree `next build` itself already
proved works. Costs image size (~2GB vs. what standalone's pruning would
give), not correctness; revisit if size becomes a real problem.

A `.dockerignore` is required — without one, the build stage's `COPY . .`
pulls in the *host* machine's own `node_modules` (built for the host's
OS/arch) and silently overwrites what the `deps` stage just installed
inside the container, which is exactly the "works on my machine" failure
mode this whole multi-arch setup exists to avoid. Confirmed live: this
produced a working-looking image that failed at container startup with
`Cannot find package 'next'` — a broken symlink from the host's Bun
package store, copied byte-for-byte into a Linux container.

Bun's install also hoists dependencies inconsistently per workspace on
this repo's graph — `packages/engine/node_modules` (drizzle-orm) and
`packages/shared/node_modules` (zod) each end up with their own
`node_modules`, not just the repo root and `apps/web`. The Dockerfile
copies the whole `deps` stage output (`COPY --from=deps /repo ./`) rather
than cherry-picking paths, to avoid needing to track that by hand.

## systemd unit

`/etc/systemd/system/unifi-sensor-latch.service`:

```ini
[Unit]
Description=UniFi Sensor Helper
After=docker.service
Requires=docker.service

[Service]
User=latch
Group=latch
WorkingDirectory=/opt/unifi-sensor-latch
EnvironmentFile=/opt/unifi-sensor-latch/.env
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now unifi-sensor-latch
```

## Data & volumes

`data/app.db` (SQLite — sensors, latches, latch state, users) and
`certs/` are bind-mounted into the container per `docker-compose.yml`, not
baked into the image, so they survive image rebuilds/redeploys.

## Node/Bun version parity

The Dockerfile floats on Bun's `1` major tag (`oven/bun:1-alpine`) rather
than an exact patch pin — project preference: rebuilding the image picks
up Bun patch releases automatically instead of needing a manual Dockerfile
bump for every release. `.bun-version` at the repo root still records the
version last used for local dev (useful for version-manager tooling), but
it's informational only now — the Docker build doesn't read it. If the
latch engine singleton's HMR/lifecycle behavior is ever seen to regress
across a Bun update (observed elsewhere in the Next.js ecosystem — see
CLAUDE.md), that's the trade-off to revisit first.
