# UniFi Protect API Notes

Living document — updated as API discovery happens (SPEC.md section 8).

**Firmware tested against**: Protect application version `7.1.87`
(`GET /v1/meta/info`), confirmed live via a local console at a
site-specific LAN IP (never hardcoded — see `scripts/discover.ts`, run
with `PROTECT_HOST=<ip> bun run scripts/discover.ts`).

Official machine-readable docs used for this pass:
`https://developer.ui.com/protect/v7.1.87/llms.txt` (endpoint index) and
`https://developer.ui.com/protect/v7.1.87/openapi.json` (schemas). Note:
`https://developer.ui.com/protect/v7.1.87/ai-gettingstarted.md` returns
plain-text instructions addressed to an AI assistant (an "llms.txt"-style
onboarding doc, not a prompt injection) — it just isn't renderable through
a generic webpage-summarizer tool, so it was fetched with `curl` instead.

## Library evaluation

| Library | Ecosystem | Last release checked | Notes |
|---|---|---|---|
| _none used_ | — | 2026-08-10 | The official OpenAPI surface is small enough (REST + one websocket endpoint) that a ~100-line hand-rolled client (`packages/engine/src/protect.ts`) is simpler than adopting a dependency. No actively maintained Node/TS client was found; Python's `uiprotect` has no direct TS port. Revisit if the API surface grows. |

## Auth

- **Header**: `X-API-KEY: <key>` — confirmed live against the console
  above (not just doc-inferred).
- **Key generation**: unifi.ui.com (per official docs); this project reads
  the generated key from `.env` as `PROTECT_API_KEY`, never in `config.json`
  or SQLite (see CLAUDE.md's config-vs-secrets rule).
- **Base URL, local console**: `https://{consoleIP}/proxy/protect/integration`
  — confirmed live. `consoleIP` comes from `.env` as `PROTECT_HOST`, never
  hardcoded in source.
- Self-signed cert on the console itself means TLS verification must be
  disabled for the outbound client connection to the console (separate
  from this app's own inbound HTTPS cert — see CLAUDE.md's process
  isolation section). Confirmed necessary: the discovery script fails
  without `tls: { rejectUnauthorized: false }` (Bun-specific fetch/WebSocket
  option).

## Endpoints

### `GET /v1/sensors`

- **Auth**: `X-API-KEY` header. **Confidence**: confirmed live.
- **Response**: JSON array of sensor objects. Relevant fields per sensor:
  - `id`, `name`, `state` ("CONNECTED" observed)
  - `stats.light.value` (Lux, nullable), `stats.humidity.value` (%,
    nullable), `stats.temperature.value` (°C, nullable) — each paired with
    a `status` ("neutral"/"high"/etc., informational only, not used by
    this app's own threshold logic)
  - `isOpened` (bool | null — door/window contact sensors only; null on
    the USL-Environmental units tested, which have no contact switch)
  - `leakDetectedAt` / `externalLeakDetectedAt` (timestamp | null — leak is
    event-based, not a continuous value like the other three metrics)
  - Per-metric `*Settings.isEnabled` flags — used to determine which
    metrics a given sensor actually exposes (drives `Sensor.metrics` in
    the domain model, SPEC.md section 4), rather than assuming every
    sensor has every metric.
- **Discrepancy vs. SPEC.md's assumed metric list**: temperature is
  reported in **Celsius**, not Fahrenheit as SPEC.md's worked example
  (`armThreshold: 55` for a freezer) implies. The UI must label units
  explicitly and this app should not silently assume °F. `leak` is not a
  continuous numeric value like the others — it's a timestamp-or-null
  ("currently detected" vs. not), so it's modeled as a synthetic
  0/1 reading (`0` = no leak, `1` = leak detected) so the same
  above/below-threshold latch state machine still applies to it
  (`armThreshold: 0.5, direction: "above"` == "fires the moment
  `leakDetectedAt` is non-null").

### `GET /v1/subscribe/devices` (WebSocket)

- **Auth**: `X-API-KEY` header on the WS upgrade request. **Confidence**:
  confirmed live (`scripts/discover-ws.ts`) — received real delta events
  from a live console within seconds of connecting, no manual sensor
  interaction needed (wireless signal-strength updates arrive on their
  own periodically).
- **Message shape observed**: `{"item": {"id": "...", "modelKey":
  "sensor", ...changedFields}, "type": "update"}`. `item` contains only
  the fields that changed, not the full sensor object — the ingest layer
  merges deltas into last-known sensor state rather than expecting a full
  snapshot on every message. `type` can be `"add"` / `"update"` /
  `"remove"` per the OpenAPI schema (`deviceAdd`/`deviceUpdate`/
  `deviceRemove`), though only `"update"` was observed in this session.
- **Decision, revised**: push (websocket) *plus* a conservative periodic
  re-poll, not push alone. Originally decided push-only (below, kept for
  history) based on an 8-30s test window that only observed wireless
  signal-strength deltas. Longer live observation (multiple 90s+ capture
  sessions, and two separate ~5+ minute waits with an app instance
  actually running against a real console with sensors independently
  confirmed reporting every 30s in the Protect app itself) never once
  produced a delta containing a `stats` value change — only
  connectivity/signal events. Whatever Protect's console does internally
  to keep its own UI's displayed values current for these sensors, it
  is not reflected as `stats`-bearing messages on this websocket, at
  least not within any window tested. The app now also periodically
  re-runs `GET /v1/sensors` (the same bulk snapshot call used at connect
  time) on a timer — see `singleton.ts`'s `connectConsole` — at the
  console's configured `defaultIntervalSeconds` (user-editable, default
  5 minutes), specifically *not* faster than that per CLAUDE.md's "don't
  poll faster than the sensor's own reporting interval" rule. The
  websocket subscription is kept regardless — it's still confirmed live
  for connectivity/wireless-signal events and is the intended mechanism
  per the API's design even if this specific hardware class isn't
  exercising the value-push path we expected.
- **Bulk delta shape**: `item.id` can be a **string or an array of
  strings** per `deviceBulkPartialWithReference` in the OpenAPI spec —
  when multiple devices change the same field(s) at once, Protect can
  coalesce them into one message sharing a single delta payload. Not
  observed directly in this session's captures (only single-id messages
  seen), but the schema allows it and the original ingest code assumed
  single-id only; fixed defensively (see `readingsFromDeviceEventItem`
  in `protect.ts`) since an unhandled bulk id would silently drop the
  reading with no error.

*(Original push-only reasoning, superseded above but kept for context:
push-only would satisfy SPEC.md section 8's polling-frequency question
with no interval to choose at all, since Protect would push changes as
they happen — that held for connectivity events but not, as far as
this session could observe, for sensor value changes.)*

### `POST /v1/alarm-manager/webhook/{id}`

- **Method**: POST. **Auth**: `X-API-Key` header (consistent with every
  other endpoint on this API — no unauthenticated path was found).
  **Confidence**: request shape (method, header name, path) confirmed
  against UniFi's own published documentation:
  ```
  curl -L -g -X POST "https://{host}/proxy/protect/integration/v1/alarm-manager/webhook/{id}" \
    -H "Accept: application/json" \
    -H "X-API-Key: <X-API-Key>"
  ```
  Still not fired live against a real console in this session (requires a
  configured Alarm Manager rule first — see SPEC.md section 7, a manual
  one-time step per site) — implemented in
  `packages/engine/src/resolveWebhookTarget.ts` per this documented
  shape, including an `Accept: application/json` header. Uses the same
  self-signed-cert tolerance (`insecureTls`) as every other call to a
  console, since this hits the console directly.
- **Path param `id`**: user-defined string; the Alarm Manager rule must be
  configured with the same ID to be triggered by this call.
- **Response**: `204` on success, `400` (`idRequiredError`) if `id` is
  missing/malformed.

### `GET /v1/meta/info`

- **Auth**: `X-API-KEY`. **Confidence**: confirmed live. Returns
  `{"applicationVersion": "7.1.87"}` — used only for a startup sanity
  check (confirms the API key + console IP are valid before booting the
  ingest websocket).

## Open questions (from SPEC.md section 11) — resolved

- Exact metric enum and units: **lux (unitless), temperature (°C, not
  °F), humidity (%), leak (synthetic 0/1 from a nullable timestamp)** —
  see discrepancy note above.
- Push vs. poll: **both** — push via `/v1/subscribe/devices` for
  connectivity/signal events, plus a conservative periodic re-poll (at
  the console's configured interval, never faster) since sensor value
  changes were never observed arriving as websocket deltas in this
  session's testing. See the revised decision note above.
- Auth header: confirmed `X-API-KEY`, confirmed reachable only with a
  valid key (not open on LAN).

## Discrepancies vs. documentation

- Temperature unit is Celsius; SPEC.md's worked freezer example uses a
  Fahrenheit-shaped threshold (55/38) — that example needs unit
  conversion or relabeling in the actual per-site config, not in source.
- `leak` has no `value`/`status` pair like the other three stats — it's
  two nullable timestamps (`leakDetectedAt`, `externalLeakDetectedAt`).
  Handled by treating "either non-null" as a synthetic reading of `1`,
  `null`/both-null as `0`, so it fits the existing above/below-threshold
  latch model without a special-cased state machine branch.
