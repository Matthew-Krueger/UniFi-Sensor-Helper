# Protect Sensor Latch Service — Specification

## 1. Problem

UniFi Protect's Alarm Manager fires the instant a sensor reading crosses a
configured threshold. It has no concept of "stay over threshold for N
minutes before I care." A freezer door opening for ten seconds and a
freezer whose compressor has actually failed both look identical to Protect
in the first moment — the only thing that distinguishes them is how long
the bad reading persists.

This service sits between UniFi Protect and a notification channel. It
watches sensor readings, applies a per-metric "armed for N minutes without
recovering" rule, and only then fires a webhook.

## 2. Goals

- Support multiple physical sensors, each of which may expose multiple
  metrics (a USL-Environmental exposes lux, temperature, humidity, leak).
- Each (sensor, metric) pair gets its own independently configured latch.
  A single physical sensor can have a lux latch and a temperature latch
  running at once, with different thresholds and durations.
- Support asymmetric arm/clear thresholds (hysteresis), not just a single
  threshold used for both directions. Example: freezer temp arms at 55°F,
  but doesn't clear until it's back down to 38°F — "briefly over 55" from
  a door opening is expected and fine; "over 55 and not recovering" is not.
- Latch state, thresholds, durations, sensor list, and webhook targets are
  all user-configurable without touching code or redeploying.
- A Next.js web UI, dark and light mode, for configuring all of the above
  and observing current latch state (idle / armed / fired) live.
- The latch engine runs continuously, independent of whether anyone has a
  browser open to the UI. The UI is a window into the engine's state, not
  the thing driving it.
- Runs as its own unprivileged OS user, served over HTTPS with a
  self-signed cert, with a single hardcoded operator account.
- Secrets never touched by the coding agent, never logged in the clear,
  never present in the non-secret config file. See CLAUDE.md.
- **Publishable as a generic, open-source project.** No site-specific
  information — device IDs, IPs, sensor names, webhook targets,
  thresholds — hardcoded anywhere in source. Anyone should be able to
  clone the repo, follow the README, connect it to their own Protect
  console, and have it discover their own sensors. This is also how a
  second deployment (for a different site/client) gets stood up — it's
  the same mechanism, not a separate concern.

## 3. Non-goals

- Historical time-series storage/graphing beyond a simple recent-events
  log (Protect already does this natively for raw sensor data).
- Reimplementing Protect's own Alarm Manager UI. We only need to create
  the small number of Protect-side rules described in section 7.

## 3a. Auth and roles

*(Originally scoped as a non-goal here — "no roles, every account
identical" — revised by project decision: a three-tier role model,
described below, is in scope. Kept as its own section rather than folded
silently back into "non-goals" so the reversal is visible, not just
implied by the code.)*

Three roles, username + argon2-hashed password stored in SQLite (`users`
table, see `packages/engine/src/schema.ts`):

- **`user`** — read-only. Can view the Dashboard, Sensors, and Latches
  pages, but cannot create/edit/delete sensors, latches, consoles, or
  webhooks, and cannot manage other accounts.
- **`admin`** — full operational access: everything a `user` can view,
  plus creating/editing/deleting sensors, latches, Protect consoles, and
  webhook config. Can create new `user` or `admin` accounts. Cannot
  promote/demote anyone's role, and cannot create a `superadmin` account.
- **`superadmin`** — everything an `admin` can do, plus promoting or
  demoting any account's role (including creating additional
  superadmins). There is always at least one superadmin — the last
  remaining superadmin cannot be demoted or deleted.

Every account, regardless of role, can change its own password
(`PATCH /api/account/password`, requires the current password).

**No env-seeded bootstrap credential.** The first account is created
through the app itself: account sign-up (`POST /api/users`) is open,
without a session, **only** while the `users` table is empty — the check
is explicit and unconditional (`AuthStore.count() === 0`), not inferred
from any other state. That first account is always forced to
`superadmin` regardless of what role is requested. The instant one
account exists, the open door closes: every subsequent `POST /api/users`
requires a logged-in `admin`-or-above session. This was a deliberate
call, not an oversight — see CLAUDE.md's auth section for the reasoning
(an admin present at first boot to create their own account is not
considered a materially different risk than an env-seeded password they'd
have to go set anyway).

## 4. Domain model

```
Sensor {
  id: string            // Protect device id
  name: string           // friendly name, editable in UI
  metrics: Metric[]      // discovered from the API, see section 8
}

Metric = "lux" | "temperature" | "humidity" | "leak" | ...
  // exact enum finalized during API discovery (section 8)

Latch {
  id: string
  sensorId: string
  metric: Metric
  direction: "above" | "below"   // which side of the threshold is "bad"
  armThreshold: number            // crossing this (in `direction`) starts the timer
  clearThreshold: number          // crossing back past this cancels/resolves
                                   // (defaults to armThreshold if omitted —
                                   // most latches, e.g. lux, don't need hysteresis)
  durationSeconds: number         // how long armed before firing
  webhook: {
    url: string
    method: "GET" | "POST"
    headers?: Record<string, string>
    bodyTemplate?: string          // supports {{sensorName}}, {{metric}},
                                    // {{value}}, {{threshold}}, {{durationMinutes}}
  }
  resolvedWebhook?: {              // optional, only fires if this latch
    url: string                    // actually fired first — never on a
    method: "GET" | "POST"         // routine clear that never armed long enough
    headers?: Record<string, string>
    bodyTemplate?: string
  }
  enabled: boolean
}

LatchState = "idle" | "armed" | "fired"
```

Worked examples (see section 6 for the actual config file shape):

- **Front lux sensor**: `direction: "above"`, `armThreshold: 500`,
  `clearThreshold: 500` (no hysteresis needed), `durationSeconds: 300`.
  Light on briefly (someone walks by with a flashlight) never arms it for
  long enough to fire. Sustained light for 5 minutes — door propped open —
  fires.
- **Walk-in freezer temp**: `direction: "above"`, `armThreshold: 55`,
  `clearThreshold: 38`, `durationSeconds: 600`. Door open for a delivery
  spikes it briefly; as long as it's back to 38 within 10 minutes, nothing
  fires. A failing compressor that never recovers does fire.

## 5. Architecture

**Stack: Next.js (App Router), TypeScript, throughout — one project, one
deployable, no separate frontend/backend repos.**

This is a real client-server app, not a static frontend calling a
stateless API. The reason that matters here specifically: the latch
engine has to hold state (armed timers, current sensor readings, a live
connection to Protect) continuously, and it has to be able to fire an
outbound webhook and, depending on what API discovery finds (section 8),
potentially receive an inbound one — none of that can depend on a browser
tab being open, and none of it can be reinstantiated per-request the way
a naive serverless API route would.

```
UniFi Protect Console
   |  (realtime sensor updates — method TBD, see section 8)
   v
Next.js server process (long-running, NOT deployed serverless)
   |
   |-- Custom server entrypoint (server.ts)
   |     Boots the latch engine singleton ONCE at process start, before
   |     the HTTP(S) listener comes up. Wraps the Next.js request handler
   |     in Node's `https` module using the self-signed cert. This is
   |     what makes "the engine doesn't need the UI open" true — it's
   |     alive because the process is alive, not because a request came in.
   |
   |-- Latch engine (plain TS module, no framework dependency)
   |     - Ingest: normalizes readings from Protect into
   |       (sensorId, metric, value, timestamp)
   |     - State machine: one instance per configured Latch
   |         idle --[reading crosses armThreshold]--> armed
   |         armed --[crosses clearThreshold before duration elapses]--> idle
   |         armed --[duration elapses without clearing]--> fired (webhook called)
   |         fired --[crosses clearThreshold]--> idle (resolvedWebhook called, if configured)
   |     - Webhook dispatcher: fires configured webhook, retries on failure, logs outcome
   |     - Persists state snapshots so a restart doesn't lose "already fired, waiting to resolve"
   |
   |-- Route Handlers (app/api/**/route.ts)
   |     - Config CRUD (sensors, latches) — reads/writes the config file, backs the UI
   |     - Latch state — current state + recent history, polled by the dashboard
   |     - Auth — session cookie backed by SQLite accounts + roles (section 3a)
   |     - Inbound webhook receiver — kept generic/available regardless of whether
   |       the chosen ingest strategy ends up being push-from-Protect or
   |       poll/subscribe-from-us (see section 8); Route Handlers call directly
   |       into the same engine singleton, they don't run it themselves
   |
   v
React (App Router pages, Server + Client Components)
   |-- Dashboard: current state of every latch, recent fired/resolved events
   |     (Client Component polling the state Route Handler every few seconds —
   |     latch state changes on the order of minutes, so polling is simpler
   |     and sufficient; no need for a websocket-to-browser layer)
   |-- Sensors: discovered sensors and their metrics (read-only, refresh button)
   |-- Latches: create/edit/delete latch configs
   |-- Theme toggle (next-themes): dark/light, respects system preference, persisted
```

## 6. Configuration storage

Non-secret, user-editable settings (sensors, latches, latch state) live in
a local SQLite database (`data/app.db`, gitignored, path set via
`DATABASE_PATH`), managed entirely through the UI/`/api/*` Route Handlers —
not a hand-edited file. This supersedes the original `config.json` design:
SQLite gives atomic writes for the state-machine-critical `latch_state`
table, at the cost of the file no longer being hand-diffable. There's no
`config.example.json` to ship; a fresh deploy starts from an empty
database and the app must render a sane empty state (SPEC.md section 12)
rather than crashing.

Tables (see `packages/engine/src/db.ts` for the authoritative schema):

- `sensors` — `id` (Protect device id), `name`, `discovered_metrics` (JSON
  array).
- `latches` — one row per (sensor, metric) latch: `sensor_id`, `metric`,
  `direction`, `arm_threshold`, `clear_threshold`, `duration_seconds`,
  `webhook_json`, `resolved_webhook_json`, `enabled`. Mirrors the `Latch`
  domain type in section 4.
- `latch_state` — one row per latch: `state` (idle/armed/fired),
  `armed_at`, `fired_at`, `updated_at`. This is the restart-survival
  mechanism referenced in section 11 — no separate JSON snapshot file.
- `users` — operator accounts (see section 3): `username`,
  `password_hash` (argon2id), `created_at`.

If a webhook URL embeds a token or credential, treat that field as
secret-bearing for logging/display purposes even though it's stored
alongside non-secret config — see CLAUDE.md's obfuscation section. The
`/api/latches` Route Handler masks webhook URLs before returning them.

## 7. Protect-side setup (manual, one-time, per resolved latch)

For each latch that should actually notify:

1. One Alarm Manager rule in Protect: trigger type = Webhook, action =
   Notify. This is the `webhook.url` target for the "fired" event.
2. If using `resolvedWebhook`, a second rule of the same shape for the
   resolved event.

Nothing else in Protect's Alarm Manager should reference these sensors —
no separate raw-threshold rules, no Notify actions anywhere else for them.
The latch engine is the only thing deciding when to fire; Protect is only
the delivery mechanism for the final push.

## 8. API discovery (required, ongoing)

There is no finalized Node/TypeScript client for the Protect Integration
API being assumed here. Before building the ingest layer:

- Confirm local API key generation path and header (`X-API-KEY` is the
  documented pattern for UniFi's public APIs, but verify against this
  console's actual firmware version).
- Determine whether sensor readings are available as a push (websocket/
  realtime events, meaning we'd subscribe as a client) or require polling,
  and at what practical resolution — the USL-Environmental is
  battery-powered and reports on its own interval regardless of how fast
  we ask, so there's likely no benefit to polling faster than that.
- Check for an existing, actively maintained npm package before hand-
  rolling a client (the Python ecosystem has `uiprotect`; check for a TS/
  Node equivalent, and note maturity/last-updated date if using one).
- Confirm the request shape for `POST /v1/alarm-manager/webhook/{id}`
  (auth requirements, whether it needs the API key or is reachable
  unauthenticated on the LAN) against this specific console.
- If it turns out Protect-side webhooks (pushed to us on threshold
  crossing) end up being the more practical ingest path after all, the
  inbound Route Handler mentioned in section 5 exists for exactly that —
  it's a fallback, not the assumed default.

**Deliverable**: write findings to `API_NOTES.md` as you go — endpoint,
method, auth, request/response shape, firmware version tested against,
and confidence level (confirmed by testing vs. inferred from docs).

## 9. Security requirements

- HTTPS only, self-signed cert. Document the generation command used and
  where the cert/key live (outside version control).
- One or more operator accounts (username + argon2-hashed password, three
  roles — see section 3a), session-based auth for the UI and its backing
  Route Handlers. The first account is created through the app itself
  while the users table is empty, not seeded from env vars (section 3a).
- Runs as a dedicated non-root system user with no other privileges. Under
  the Docker deploy model (section 10), this is the user that owns the
  systemd unit driving the container, not a user inside the container image
  itself (which also runs non-root — see `Dockerfile`).
- See CLAUDE.md for the secret-handling rules that apply throughout.

## 10. Dev / deploy split

- **Runtime**: Bun, not Node — see CLAUDE.md's Stack section. Deployed as a
  Docker image so the exact runtime version is pinned identically on both
  the dev machine and the deploy target, rather than relying on whatever
  Bun/Node happens to be installed on each (this is what section 9's
  original Node-version-parity concern is resolved by).
- **Dev machine**: macOS. `bun run server.ts` for iteration (no Docker
  required for local dev).
- **Deploy machine**: Debian 13, dedicated non-root system user, `systemd`
  unit that runs `docker compose up` for this image (see `DEPLOY.md`) — the
  container itself also runs as a non-root user internally.
- Build with `output: 'standalone'` in `next.config.ts` so the deployed
  image is minimal and self-contained.
- The custom server entrypoint (section 5) is what actually runs in
  production — plain `next start` alone won't boot the latch engine or
  terminate HTTPS with the self-signed cert. The Docker image's `CMD` runs
  the compiled `server.ts` directly, never the Next.js CLI.
- Pin the exact Bun version in both `.bun-version` (repo root) and the
  `Dockerfile`'s base image tag, and keep them in sync when bumping —
  module-level singletons (the latch engine) can behave differently across
  runtime versions or under Next.js's dev-mode hot reloading than in a
  production build; test the production build locally on the Mac (`docker
  build . && docker run ...`) before assuming parity with `bun run
  server.ts` in dev mode.
- Document the exact `Dockerfile`, systemd unit, and `useradd` steps in
  `DEPLOY.md`.

## 11. Open questions for the implementer to resolve and document

- Exact metric enum and units returned by the API for each sensor type.
- Whether latch state (idle/armed/fired) needs to survive a process
  restart — yes, via a small state snapshot written on every transition.
  A JSON snapshot is almost certainly sufficient; don't reach for a
  database for this.
- Final call on websocket-subscribe vs. inbound-webhook-from-Protect for
  ingest, once section 8's discovery is done.

## 12. Publishability

This should be a project someone else can pick up cold — including
future-you, standing it up for a client's site with an entirely different
set of sensors and thresholds. That means:

- **No hardcoded site data in source, ever.** No literal IPs, device IDs,
  sensor names, thresholds, or webhook URLs in `.ts`/`.tsx` files. If it's
  specific to a deployment, it comes from the SQLite config database
  (section 6) or `.env` — never from a constant in the codebase.
- **Sensor selection is discovery-driven, not typed in.** The "Sensors"
  page in the UI queries the Protect API and lists whatever it finds. The
  user assigns a friendly name and builds latches against discovered
  sensors — they never hand-type a device ID they copied from somewhere.
  This is the main thing that makes standing up a second deployment
  practical instead of archaeology.
- **`data/app.db` is gitignored, same as `.env`**, even though it isn't
  secret — it's still one specific business's private operational data
  (their sensor layout, their thresholds, arguably their webhook
  endpoints). There's no example file to ship for a database; the app
  creates an empty one on first boot and must render a sane first-run
  state (empty state in the UI, not a crash) until sensors/latches exist.
- **README.md must assume zero prior context** — written for someone who
  has never seen this project before: prerequisites, how to get a Protect
  API key, first-run setup, how to generate the self-signed cert, how to
  deploy the systemd service. Test it by literally following it, not by
  describing what you remember doing.
- **Pick and include a LICENSE.** MIT is a reasonable default for a tool
  like this if there's no strong reason to pick something else — flag it
  rather than silently deciding, since it's the project owner's call.
- Anything you're tempted to write as "well it's just for the drive-in
  so..." — don't. That instinct is exactly what this section exists to
  override.
