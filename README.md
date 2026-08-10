# UnifiSensorLatch

A hysteresis "latch" layer between UniFi Protect sensor readings and
outbound webhooks. Protect's Alarm Manager fires the instant a threshold is
crossed; this service adds "stay over threshold for N minutes before I
care," with independent arm/clear thresholds per (sensor, metric) pair. See
`SPEC.md` for the full design.

**Status**: structural skeleton. The latch state machine, storage, and auth
are implemented and tested; live UniFi Protect API integration is not yet
built (see `API_NOTES.md`).

## Prerequisites

- [Bun](https://bun.sh) 1.3.x (`curl -fsSL https://bun.sh/install | bash`)
- Docker + Docker Compose, for the deploy path
- A UniFi Protect console reachable on your network, with a local API key
  (Settings → Control Plane → Integrations, on recent Protect firmware —
  exact path may vary; not yet confirmed against a specific firmware
  version, see `API_NOTES.md`)
- `openssl`, for generating a self-signed TLS cert

## First-run setup (local dev, macOS)

1. Install dependencies from the repo root:
   ```bash
   bun install
   ```
2. Copy `.env.example` to `.env` and fill in real values:
   ```bash
   cp .env.example .env
   ```
   At minimum set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET`
   (generate with `openssl rand -base64 48`). `.env` is gitignored — never
   commit it.
3. Generate a self-signed dev cert:
   ```bash
   mkdir -p certs
   openssl req -x509 -newkey rsa:4096 -nodes \
     -keyout certs/dev-key.pem -out certs/dev-cert.pem \
     -days 365 -subj "/CN=localhost"
   ```
   Point `TLS_CERT_PATH`/`TLS_KEY_PATH` in `.env` at these files.
4. Run the dev server:
   ```bash
   cd apps/web
   bun run server.ts
   ```
   Visit `https://localhost:8443` (your browser will warn about the
   self-signed cert — that's expected for local dev).
5. Log in with the `ADMIN_USERNAME`/`ADMIN_PASSWORD` you set in `.env`.
   This account is seeded into the database on first boot only; manage
   further accounts from the Users area once built out.

On first run, with no sensors or latches configured yet, the Dashboard,
Sensors, and Latches pages show an empty state rather than erroring — this
is expected until a Protect console is connected and sensors are
discovered.

## Running tests

```bash
bun test
```

Covers the latch state machine's arm/clear/fire/resolve transitions and the
SQLite persistence layer (`packages/engine/test/`).

## Deploying

See `DEPLOY.md` for the Docker + systemd production setup on Debian 13.

## Project layout

```
apps/web/          Next.js app — UI, Route Handlers, custom server entrypoint
packages/engine/    Latch state machine, SQLite storage, auth — no framework dependency
packages/shared/    Domain types and the shared secret-masking helper
```

## Configuration

Sensors, latches, and latch state live in a local SQLite database
(`data/app.db`, path set via `DATABASE_PATH`), not in a config file —
gitignored, created automatically on first boot. Nothing here is meant to
be hand-edited directly; use the UI or the `/api/*` Route Handlers.
Secrets (admin credentials, session signing key, Protect API key) live in
`.env` only.

## License

MPL 2.0 — see `LICENSE`.
