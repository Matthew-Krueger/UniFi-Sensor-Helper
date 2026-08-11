# UniFi Sensor Helper

A hysteresis "latch" layer between UniFi Protect sensor readings and
outbound webhooks. Protect's Alarm Manager fires the instant a threshold is
crossed; this service adds "stay over threshold for N minutes before I
care," with independent arm/clear thresholds per (sensor, metric) pair. See
`SPEC.md` for the full design.

**AI USE**: This code was completely AI generated.... Is it better than
human written code? Yup! Is Linus Torvalds right about AI? You bet!
Is it better than anything I can write! Yup! And was it written way faster?
Also yup! This paragraph was the only human written part of th eentire repo.
Not even the rest of the readme was human written. Claude gets a pat
on the back for that.

**Status**: functional. The latch state machine, storage, auth, and the
UniFi Protect integration (sensor discovery, realtime websocket ingest,
webhook dispatch) are implemented and tested — see `API_NOTES.md` for the
endpoints in use and how each was confirmed against a live console.

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
   At minimum set `SESSION_SECRET` (generate with `openssl rand -base64
   48`). `.env` is gitignored — never commit it. There's no admin
   credential to set here — see step 5.
3. Generate a self-signed dev cert:
   ```bash
   mkdir -p certs
   openssl req -x509 -newkey rsa:4096 -nodes \
     -keyout certs/dev-key.pem -out certs/dev-cert.pem \
     -days 365 -subj "/CN=localhost"
   ```
   Point `TLS_CERT_PATH`/`TLS_KEY_PATH` in `.env` at these files.
4. Run the dev server from the repo root:
   ```bash
   bun run dev
   ```
   Visit `https://localhost:8443` (your browser will warn about the
   self-signed cert — that's expected for local dev). `.env`,
   `data/app.db`, and `certs/` are all resolved relative to the repo
   root — this only works run from the root, not from inside `apps/web`.
5. Visit `/login` — with no accounts yet, it shows a **Create the first
   account** form instead of a sign-in form. This is only available while
   the users table is empty; the account you create here is always
   `superadmin`. From then on, further accounts are created from the
   Users page by a logged-in `admin` or `superadmin`.
6. On the **Consoles** page, add your Protect console: a friendly name,
   its LAN host/IP, and a local API key generated at unifi.ui.com. The
   engine connects immediately — no restart needed — and the API key is
   stored in SQLite (masked in the UI), not `.env`, since a site can add
   more than one console.
7. On the **Sensors** page, click **Refresh** to discover sensors from the
   console(s) you just added. Sensors are always discovery-driven; none are
   ever hardcoded.
8. On the **Rules** page, create a rule against a discovered sensor's
   metric: arm/clear thresholds, how long it must stay armed before firing,
   and the webhook to call. See `SPEC.md` section 4 for worked examples.
   ("Rule" is the UI name for what the domain model still calls a `Latch`
   internally — same thing, friendlier name.)

On first run, with no consoles, sensors, or rules configured yet, the
Dashboard, Sensors, and Rules pages show an empty state rather than
erroring.

## Running tests

```bash
bun test
```

Covers the latch state machine's arm/clear/fire/resolve transitions, the
restart-mid-armed-state persistence case, and the webhook dispatcher's
retry/masking behavior (`packages/engine/test/`).

## Deploying

See `DEPLOY.md` for the Docker + systemd production setup on Debian 13.

## Project layout

```
apps/web/          Next.js app — UI, Route Handlers, custom server entrypoint
packages/engine/    Latch state machine, Protect API client, SQLite storage (Drizzle), auth — no framework dependency
packages/shared/    Domain types and the shared secret-masking helper
scripts/            One-off manual API discovery scripts (not part of the app) — see API_NOTES.md
```

## Configuration

Sensors, latches, latch state, and Protect console connections (host +
API key) live in a local SQLite database (`data/app.db`, path set via
`DATABASE_PATH`), not in a config file — gitignored, created automatically
on first boot, schema managed by Drizzle (`packages/engine/src/schema.ts`,
migrations in `packages/engine/drizzle/`). Nothing here is meant to be
hand-edited directly; use the UI or the `/api/*` Route Handlers. A Protect
console's API key is stored there too (not `.env`) because, unlike the
admin login, it's meant to be user-editable — a site can connect more than
one console — but it's still masked everywhere it's read back (config
list, logs), same as webhook URLs. `.env` is reserved for the admin
bootstrap credentials, the session-signing secret, and TLS cert paths —
values with no reason to be edited through the UI.

## License

MPL 2.0 — see `LICENSE`.
