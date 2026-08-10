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

Mac dev build vs. Debian deploy build differ only in what's targeted:

- **Mac dev**: `bun install && cd apps/web && bun run server.ts` (runs
  against `next dev`-equivalent via `NODE_ENV` unset) for iteration, no
  Docker required.
- **Debian deploy**: `docker build -t unifi-sensor-latch .` — the
  multi-stage `Dockerfile` runs `next build` with `output: 'standalone'`
  and produces a minimal runtime image; no `node_modules` copy step beyond
  what standalone output needs.

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

The Dockerfile pins the exact Bun version (`oven/bun:1.3.14-slim`), matching
`.bun-version` at the repo root. Update both together when bumping Bun —
this is what keeps the Mac dev environment and the Debian deploy image
behaviorally identical, since the latch engine singleton's HMR/lifecycle
behavior has been observed to differ across runtime versions elsewhere in
the Next.js ecosystem (see CLAUDE.md).
