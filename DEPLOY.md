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
sudo mkdir -p /opt/unifi-sensor-helper/{data,certs}
sudo chown -R latch:latch /opt/unifi-sensor-helper
```

Place `.env` and the TLS cert/key under `/opt/unifi-sensor-helper/`, owned by
`latch:latch`, mode `600`. Nothing in this repo's source or `config`
generates these for you automatically — see below.

## TLS cert (self-signed)

```bash
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 825 -subj "/CN=unifi-sensor-helper"
```

Regenerate before the 825-day expiry. Never commit `certs/`.

## Build

Mac dev build vs. deploy build differ only in what's targeted:

- **Mac dev**: `bun install && cd apps/web && bun run server.ts` (runs
  against `next dev`-equivalent via `NODE_ENV` unset) for iteration, no
  Docker required.
- **Deploy, single architecture**: `docker build -t unifi-sensor-helper .`
  builds for the host machine's own architecture — nothing else needed.
- **Deploy, cross-architecture** (e.g. building on an Apple Silicon Mac
  for an x86 machine with no shared registry): `./scripts/docker-build.sh`
  builds both `linux/arm64` (native) and `linux/amd64` (cross-built via
  Docker Desktop's bundled QEMU — no separate setup, just slow: `next
  build` runs several minutes under emulation), loads the arm64 image into
  local Docker, and saves the amd64 image to
  `dist/unifi-sensor-helper-amd64.tar` for `docker load` on the target
  machine. Pass `--push <registry/image:tag>` instead to build and push a
  proper multi-arch manifest if a registry is available — simpler when
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

## Data & volumes

`data/app.db` (SQLite — sensors, latches, latch state, users) and
`certs/` are bind-mounted into the container per `docker-compose.yml`, not
baked into the image, so they survive image rebuilds/redeploys.

**If `data/` lives on a network drive** (NFS/CIFS — not required, but
supported): put a proper entry in `/etc/fstab` with the `_netdev` mount
option, which tells systemd this is a network filesystem so it gets
ordered correctly relative to networking and gets its own auto-generated
mount unit that other units can depend on. Do **not** add `nofail` — that
makes the mount optional at boot, which is the opposite of what you want
here (silently starting with an empty *local* directory instead of the
real data volume would be a much worse failure mode than the service
simply not starting).

```fstab
# NFS example
nas.local:/export/unifi-sensor-helper  /opt/unifi-sensor-helper/data  nfs   _netdev,x-systemd.mount-timeout=30  0  0

# CIFS/SMB example
//nas.local/unifi-sensor-helper  /opt/unifi-sensor-helper/data  cifs  credentials=/etc/unifi-sensor-helper-cifs,_netdev,x-systemd.mount-timeout=30  0  0
```

```bash
sudo mkdir -p /opt/unifi-sensor-helper/data
sudo systemctl daemon-reload   # picks up the new fstab entry as a .mount unit
sudo mount /opt/unifi-sensor-helper/data   # verify it mounts cleanly before moving on
```

## systemd unit

`/etc/systemd/system/unifi-sensor-helper.service`:

```ini
[Unit]
Description=UniFi Sensor Helper
# network-online.target: the app itself needs real network access (to
# reach the Protect console), not just the loopback interface being up.
# remote-fs.target: the standard systemd target that's reached once every
# _netdev filesystem in /etc/fstab (NFS/CIFS/etc.) has finished mounting —
# belt-and-suspenders alongside RequiresMountsFor below, which ties this
# unit to the *specific* mount backing the data directory rather than
# "all network filesystems, whatever they are."
After=network-online.target remote-fs.target docker.service
Wants=network-online.target
Requires=docker.service
# Ties this unit's start ordering AND a hard dependency to whatever mount
# unit covers this exact path — systemd resolves that automatically from
# /etc/fstab (or a StorageOnDemand-style local disk, if data/ isn't on a
# network drive; this line is harmless either way). If the mount fails,
# this service fails to start instead of silently writing to an empty
# local directory.
RequiresMountsFor=/opt/unifi-sensor-helper/data

[Service]
User=latch
Group=latch
WorkingDirectory=/opt/unifi-sensor-helper
EnvironmentFile=/opt/unifi-sensor-helper/.env
# Defense in depth on top of RequiresMountsFor above — if this directory
# is supposed to be a mount point and isn't actually mounted (e.g. an
# operator error in fstab that RequiresMountsFor's dependency resolution
# didn't catch), fail loudly here rather than let the container start and
# write app.db to a local path that looks right but isn't.
ExecStartPre=/usr/bin/mountpoint -q /opt/unifi-sensor-helper/data
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If `data/` is a plain local directory (not a network mount), drop the
`ExecStartPre` line — `mountpoint -q` only succeeds for an actual mount
point, and a local directory that's just a directory will fail it.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now unifi-sensor-helper
sudo systemctl status unifi-sensor-helper   # confirm it actually came up
journalctl -u unifi-sensor-helper -f        # tail logs
```

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
