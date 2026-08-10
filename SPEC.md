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

- Multi-user auth, RBAC, or account management. One operator account,
  credentials from `.env`.
- Historical time-series storage/graphing beyond a simple recent-events
  log (Protect already does this natively for raw sensor data).
- Reimplementing Protect's own Alarm Manager UI. We only need to create
  the small number of Protect-side rules described in section 7.

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
   |     - Auth — session cookie against ADMIN_USERNAME/ADMIN_PASSWORD from .env
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

## 6. Configuration file

Non-secret, human-editable, lives outside `.env`. JSON is the path of
least resistance here and needs no extra parsing dependency; document if
you land somewhere else instead.

```json
{
  "sensors": [
    { "id": "PROTECT-DEVICE-ID-1", "name": "Front Entry" },
    { "id": "PROTECT-DEVICE-ID-2", "name": "Walk-in Freezer" }
  ],
  "latches": [
    {
      "id": "front-lux",
      "sensorId": "PROTECT-DEVICE-ID-1",
      "metric": "lux",
      "direction": "above",
      "armThreshold": 500,
      "clearThreshold": 500,
      "durationSeconds": 300,
      "webhook": {
        "url": "https://PROTECT-IP/proxy/protect/integration/v1/alarm-manager/webhook/WEBHOOK-ID",
        "method": "POST",
        "bodyTemplate": "{{sensorName}} light has been elevated for {{durationMinutes}} minutes"
      },
      "enabled": true
    },
    {
      "id": "freezer-temp",
      "sensorId": "PROTECT-DEVICE-ID-2",
      "metric": "temperature",
      "direction": "above",
      "armThreshold": 55,
      "clearThreshold": 38,
      "durationSeconds": 600,
      "webhook": {
        "url": "https://PROTECT-IP/proxy/protect/integration/v1/alarm-manager/webhook/WEBHOOK-ID-2",
        "method": "POST",
        "bodyTemplate": "{{sensorName}} has been above {{threshold}}\u00b0F for {{durationMinutes}} minutes"
      },
      "resolvedWebhook": {
        "url": "https://PROTECT-IP/proxy/protect/integration/v1/alarm-manager/webhook/WEBHOOK-ID-2-RESOLVED",
        "method": "POST",
        "bodyTemplate": "{{sensorName}} back to normal"
      },
      "enabled": true
    }
  ]
}
```

If a webhook URL embeds a token or credential, treat that field as
secret-bearing for logging/display purposes even though it lives in this
file and not `.env` — see CLAUDE.md section on obfuscation.

`config.json` itself contains real site data (actual device IDs, real
webhook targets, a specific business's thresholds) and must not be
committed to the repo, even though none of it is technically a secret —
see section 12. The repo ships a `config.example.json` with placeholder
values instead; the real file is generated or hand-created per
deployment.

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
- Single operator account, username/password from `.env`, session-based
  auth for the UI and its backing Route Handlers.
- Runs as a dedicated non-root system user with no other privileges.
- See CLAUDE.md for the secret-handling rules that apply throughout.

## 10. Dev / deploy split

- **Dev machine**: macOS (MacBook Pro). `next dev` for iteration.
- **Deploy machine**: Debian 13, dedicated non-root system user, `systemd`
  service.
- Build with `output: 'standalone'` in `next.config` so the deployed
  artifact is minimal and self-contained rather than requiring a full
  `node_modules` copy on the server.
- The custom server entrypoint (section 5) is what actually runs in
  production — plain `next start` alone won't boot the latch engine or
  terminate HTTPS with the self-signed cert, so make sure the systemd
  `ExecStart` points at the compiled custom server, not at the Next.js CLI
  directly.
- Pin the Node version (e.g. an `.nvmrc` or `engines` field) and confirm
  it matches between the Mac dev environment and the Debian 13 deploy
  target — module-level singletons (the latch engine) can behave
  differently under Next.js's dev-mode hot reloading than they do in a
  production build; test the production build locally on the Mac
  (`next build && node dist/server.js` or equivalent) before assuming
  parity with `next dev`.
- Document the exact systemd unit and `useradd` steps in `DEPLOY.md`.

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
  specific to a deployment, it comes from `config.json` or `.env` — never
  from a constant in the codebase.
- **Sensor selection is discovery-driven, not typed in.** The "Sensors"
  page in the UI queries the Protect API and lists whatever it finds. The
  user assigns a friendly name and builds latches against discovered
  sensors — they never hand-type a device ID they copied from somewhere.
  This is the main thing that makes standing up a second deployment
  practical instead of archaeology.
- **`config.json` is gitignored, same as `.env`**, even though it isn't
  secret — it's still one specific business's private operational data
  (their sensor layout, their thresholds, arguably their webhook
  endpoints). Ship `config.example.json` with clearly fake placeholder
  values instead, and make sure the app has a sane first-run behavior
  when no real config exists yet (empty state in the UI, not a crash).
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
