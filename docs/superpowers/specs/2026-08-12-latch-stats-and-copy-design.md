# Latch arm/fire/resolve stats and rule copy

Date: 2026-08-12

## 1. Latch transition history and dashboard counters

### Motivation

Operators want to see, per latch, how many times it has armed, fired, and
returned to idle, and how much cumulative time it has spent armed and fired,
over rolling windows (1 day, 7 days, 30 days, 365 days) and all-time. This is
visibility, not alerting: it helps spot a flapping sensor or a rule that's
firing far more than expected.

### Data model

New table, `latch_transitions` (packages/engine/src/schema.ts):

```
id: text primary key
latchId: text, not null, references latches.id, onDelete cascade
type: text, not null — "armed" | "fired" | "resolved" | "cleared-before-fire"
timestamp: integer, not null (ms epoch)
```

Indexed on `(latchId, timestamp)` — every read filters by latch and needs
chronological order.

This is an append-only event log, separate from the existing `latch_state`
table (which only ever holds the *current* state for a latch). No existing
table can answer "how many times has this happened" or "how long was it in
that state," so a new log is required.

No backfill: history starts accumulating from when this feature ships.
Latches that existed before this change simply show zero counts / zero
duration until new transitions occur.

### Write path

In `LatchEngine.ingest()` (packages/engine/src/singleton.ts), immediately
after the existing `this.config.saveLatchState(next)` call, write one
`latch_transitions` row whenever `transition.type !== "none"`. This reuses
the already-edge-triggered dispatch path (confirmed while verifying webhook
idempotency: `applyReading` only emits a transition on an actual state
change, never on a tick that holds the same state), so the event log cannot
accumulate duplicate rows from repeated polling.

`ConfigStore` gets a new method, `recordLatchTransition(latchId, type,
timestamp)`, a straightforward insert.

### Aggregation

A pure function, `computeLatchStats(events, liveState, now)`, in a new
module `packages/engine/src/latchStats.ts`. Inputs:

- `events`: the latch's `latch_transitions` rows, ordered by timestamp
  ascending.
- `liveState`: the current `latch_state` row (state + armedAt/firedAt), to
  account for a still-open armed/fired interval that hasn't closed yet.
- `now`: current time in ms.

For each of the five windows (1d, 7d, 30d, 365d, all-time), returns:

- `armedCount`, `firedCount`, `idleCount` — counts of events of that type
  within the window. `idleCount` covers both `resolved` and
  `cleared-before-fire` events (both mean "returned to idle"; the counter
  doesn't distinguish which path).
- `armedSeconds`, `firedSeconds` — total time spent in each state within the
  window. Computed by walking consecutive event pairs to find closed
  intervals (e.g. an `armed` event followed by the next `fired` or
  `cleared-before-fire` event), clipping each interval to the window's
  `[now - windowLength, now]` range before summing. If the latch is
  currently armed or fired (per `liveState`), the still-open interval from
  its start time up to `now` is included too, also clipped to the window.

Being a pure function with no DB or engine dependency, this is directly unit
testable with synthetic event lists.

`ConfigStore` gets `getLatchTransitions(latchId, sinceTimestamp?)` to fetch
events for the aggregation call.

### API

- `GET /api/latches/:id/stats` — returns the five-window breakdown
  (counts + durations for all three counters / two durations). Visible to
  all roles (`user`, `admin`, `superadmin`) — this is operational status
  info, not secret-bearing, same visibility tier as the rest of the
  dashboard.
- `POST /api/latches/:id/stats/clear` — deletes all `latch_transitions` rows
  for that latch (full history wipe; every window, including all-time,
  reads zero afterward). Gated with `requireRole("superadmin")` in
  `apps/web/lib/auth.ts`, checked server-side regardless of what the client
  shows — per CLAUDE.md's trust-boundary rule, never inferred from the UI.
  This is intentionally a higher bar than normal latch editing (which
  `admin` can already do), because clearing destroys history a
  `superadmin` can't get back; the request explicitly reserved this to
  avoid "anyone willy-nilly" clearing it, e.g. after a sensor swap made the
  old numbers meaningless.

### UI

Each latch card on the dashboard gains a stats panel: a 5-column table (1d /
7d / 30d / 365d / all-time) with rows for armed count, fired count, idle
count, time armed, time fired. Durations render in a human-readable form
(e.g. "3h 12m") rather than raw seconds.

Superadmins additionally see a "Clear stats" button on each card, gated by
role client-side (UX only — the real gate is the route handler) with a
confirm dialog: "This permanently deletes history for {latch name}. Cannot
be undone."

### Testing

- `latchStats.test.ts`: synthetic event sequences covering:
  - basic count/duration math within a window
  - clipping an interval that spans a window boundary
  - the open-interval-to-now case for a currently armed/fired latch
  - idleCount correctly lumping both `resolved` and `cleared-before-fire`
  - an empty event list (new/never-triggered latch) returning all zeros
- Route tests: `GET .../stats` returns correct data for a seeded latch;
  `POST .../stats/clear` returns 403 for `user`/`admin` and succeeds for
  `superadmin`, and confirms rows are actually gone afterward.

## 2. Copy a rule

### Motivation

Operators managing many similar latches (e.g. one per freezer) want to
duplicate an existing rule as a starting point instead of re-entering every
field by hand.

### Behavior

`POST /api/latches/:id/copy` — the server loads the source latch, builds a
new record with:

- a freshly generated `id`
- `name`: `"{source.name ?? 'Untitled'} (copy)"`
- `enabled: false`, always, regardless of the source's enabled state — this
  prevents a moment where two identical rules are both live and could
  double-fire the same webhook before the operator has pointed the copy at
  a different sensor or threshold.
- every other field (`sensorId`, `metric`, `conditionJson`,
  `durationSeconds`, `webhookJson`, `resolvedWebhookJson`) copied verbatim.

Inserted through the existing latch-create path in `ConfigStore` so it goes
through the same validation as manual creation (shared validation logic per
CLAUDE.md's trust-boundary rule — no separate hand-rolled insert).

Permission: same as latch creation today, `admin`/`superadmin` (not
`user`) — an authoring action, matching the existing Rules-page permission
model. No new role tier introduced.

No schema changes — reuses the `latches` table as-is.

### UI

A "Copy" action on each rule row on the Rules page, alongside the existing
Edit/Delete actions. On click: calls the copy endpoint, then navigates to
the new rule's edit view (or shows a toast and refreshes the list) so the
operator immediately sees it landed disabled and can adjust it before
enabling.

### Testing

- Route test: copying preserves every field except `id`/`name`/`enabled`;
  the copy is always `enabled: false` regardless of the source's state; the
  copied `name` has the `" (copy)"` suffix.
- Permission test: `user`-role copy requests are rejected (403); `admin` and
  `superadmin` succeed.
