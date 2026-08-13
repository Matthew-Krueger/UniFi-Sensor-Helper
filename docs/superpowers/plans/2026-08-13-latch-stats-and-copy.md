# Latch Stats and Rule Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-latch arm/fire/idle counters and time-in-state durations (1d/7d/30d/365d/all-time windows) visible on the dashboard with a superadmin-only clear action, and add a "Copy" action on the Rules page that duplicates a latch as a disabled starting point.

**Architecture:** A new append-only `latch_transitions` event log table records every non-`"none"` state-machine transition, written in `LatchEngine.ingest()` alongside the existing `saveLatchState` call. A pure aggregation function computes windowed counts/durations from that log plus live state. A new `GET/POST` pair of routes exposes stats and the superadmin-gated clear action. Rule copy reuses the existing latch create path with a new `POST /api/latches/:id/copy` route; the UI wires a new button through the existing raw-`fetch` pattern used throughout `rules-client.tsx` — no new client abstraction.

**Tech Stack:** Next.js App Router route handlers, Drizzle ORM / `bun:sqlite`, Bun's built-in test runner, React (existing dashboard/rules client components), Tailwind + shadcn/ui.

## Global Constraints

- No dash/hyphen characters as punctuation in any user-facing text (UI copy, error messages, toasts, labels). Hyphens inside real hyphenated words are fine.
- Never open/read/inspect `.env` contents for any reason.
- Every Route Handler independently verifies authorization via `requireRole` — never rely on client-side checks.
- Validate on both server and client; server-side is the actual gate.
- Any credential-shaped value must be masked (`maskSecret`) everywhere it's logged or echoed back. (Not applicable to this plan's fields — no secrets are introduced.)
- No backfill: `latch_transitions` starts accumulating from when this ships; latches with no prior history simply show zero.
- Superadmin-only for stats clearing; `admin`/`superadmin` for rule copy (matches existing latch-authoring permission tier, not a new tier).
- Copy always creates the new latch with `enabled: false`, regardless of the source's enabled state.
- Never hand-edit generated Drizzle migration SQL — always `bun run db:generate` then `bun run db:migrate`.

---

## File Structure

- **Modify** `packages/engine/src/schema.ts` — add `latchTransitions` table.
- **Create** `packages/engine/drizzle/00XX_<generated>.sql` — via `db:generate`, not hand-written.
- **Modify** `packages/engine/src/config.ts` — add `recordLatchTransition`, `getLatchTransitions`, `clearLatchTransitions` to `ConfigStore`.
- **Create** `packages/engine/src/latchStats.ts` — pure `computeLatchStats` function.
- **Create** `packages/engine/test/latchStats.test.ts` — unit tests for the pure function.
- **Modify** `packages/engine/src/singleton.ts` — write a transition-log row in `ingest()`.
- **Modify** `packages/shared/src/types.ts` — add `LatchTransitionType`, `LatchStatsWindow`, `LatchStats` types.
- **Create** `apps/web/app/api/latches/[id]/stats/route.ts` — `GET` (all roles) and `POST` for `?action=clear` (superadmin only). (See Task 5 for why one file handles both.)
- **Create** `apps/web/app/api/latches/[id]/copy/route.ts` — `POST`, `admin`/`superadmin`.
- **Modify** `apps/web/app/dashboard-client.tsx` — render stats panel + Clear button per card.
- **Modify** `apps/web/app/rules/rules-client.tsx` — add Copy button + `copyRule` handler.
- **Create** `apps/web/app/api/latches/[id]/stats/route.test.ts` and `apps/web/app/api/latches/[id]/copy/route.test.ts` if the project has route-level tests already (see Task 7 for the check).

---

### Task 1: `latch_transitions` schema and migration

**Files:**
- Modify: `packages/engine/src/schema.ts`
- Create: generated migration under `packages/engine/drizzle/` (via CLI, not hand-written)

**Interfaces:**
- Produces: `latchTransitions` Drizzle table export, columns `id`, `latchId`, `type`, `timestamp`, used by Task 2 (`ConfigStore` methods) and Task 3 (`ingest()` write).

- [ ] **Step 1: Add the table to schema.ts**

Add this export to `packages/engine/src/schema.ts`, after the `webhookDeliveries` table (before `latchState`):

```ts
// Append-only event log of every latch state-machine transition (armed,
// fired, resolved, cleared-before-fire). Separate from latch_state (which
// only holds the *current* state) — this is what the dashboard's windowed
// arm/fire/idle counters and time-in-state durations read from. No
// backfill: rows only exist from when this table was introduced onward.
export const latchTransitions = sqliteTable(
  "latch_transitions",
  {
    id: text("id").primaryKey(),
    latchId: text("latch_id")
      .notNull()
      .references(() => latches.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "armed" | "fired" | "resolved" | "cleared-before-fire"
    timestamp: integer("timestamp").notNull(),
  },
  // Every read filters by latchId and needs chronological order (windowed
  // aggregation, clear-all-for-latch) — a plain latchId index wouldn't
  // cover the sort, so it's composite, matching the existing
  // webhook_deliveries_latch_id_dispatched_at_idx pattern.
  (table) => [index("latch_transitions_latch_id_timestamp_idx").on(table.latchId, table.timestamp)],
);
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new file appears under `packages/engine/drizzle/`, e.g. `0015_<name>.sql`, containing a `CREATE TABLE latch_transitions (...)` statement and the composite index. Do not hand-edit it.

- [ ] **Step 3: Apply the migration**

Run: `bun run db:migrate`
Expected: exits 0. Confirm the table exists:
Run: `bun -e "import { Database } from 'bun:sqlite'; const db = new Database('data/app.db'); console.log(db.query(\"SELECT name FROM sqlite_master WHERE type='table' AND name='latch_transitions'\").all())"`
Expected: prints one row with `name: "latch_transitions"`.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/schema.ts packages/engine/drizzle/
git commit -m "Add latch_transitions event log table"
```

---

### Task 2: `ConfigStore` methods for the transition log

**Files:**
- Modify: `packages/engine/src/config.ts`
- Test: `packages/engine/test/config.test.ts` (append to existing file — read it first to match its existing setup/teardown pattern, e.g. an in-memory or temp-file `getDb()` fixture already used by other `ConfigStore` tests in that file)

**Interfaces:**
- Consumes: `latchTransitions` table from Task 1.
- Produces:
  - `recordLatchTransition(latchId: string, type: "armed" | "fired" | "resolved" | "cleared-before-fire", timestamp: number): void`
  - `getLatchTransitions(latchId: string): LatchTransitionRecord[]` where `LatchTransitionRecord = { id: string; latchId: string; type: "armed" | "fired" | "resolved" | "cleared-before-fire"; timestamp: number }`, ordered by `timestamp` ascending.
  - `clearLatchTransitions(latchId: string): void`
  These three are consumed by Task 3 (write) and Task 5 (read/clear routes).

- [ ] **Step 1: Write the failing tests**

Read `packages/engine/test/config.test.ts` first to copy its exact `ConfigStore` construction pattern (e.g. how it gets a fresh `db`/`ConfigStore` per test — likely a `beforeEach` or a helper that builds an in-memory SQLite db). Then append:

```ts
describe("ConfigStore latch transitions", () => {
  test("recordLatchTransition then getLatchTransitions returns rows ordered by timestamp ascending", () => {
    const store = makeConfigStore(); // use whatever fixture helper the file already defines
    const latch = seedLatch(store); // use whatever latch-seeding helper the file already defines; if none exists, call store.upsertLatch with a minimal valid Latch object matching the shared Latch type

    store.recordLatchTransition(latch.id, "armed", 2000);
    store.recordLatchTransition(latch.id, "fired", 1000);

    const rows = store.getLatchTransitions(latch.id);
    expect(rows.map((r) => r.type)).toEqual(["fired", "armed"]);
    expect(rows.map((r) => r.timestamp)).toEqual([1000, 2000]);
  });

  test("getLatchTransitions only returns rows for the requested latch", () => {
    const store = makeConfigStore();
    const latchA = seedLatch(store, { id: "latch-a" });
    const latchB = seedLatch(store, { id: "latch-b" });

    store.recordLatchTransition(latchA.id, "armed", 1000);
    store.recordLatchTransition(latchB.id, "armed", 1000);

    expect(store.getLatchTransitions(latchA.id)).toHaveLength(1);
  });

  test("clearLatchTransitions deletes all rows for that latch only", () => {
    const store = makeConfigStore();
    const latchA = seedLatch(store, { id: "latch-a" });
    const latchB = seedLatch(store, { id: "latch-b" });

    store.recordLatchTransition(latchA.id, "armed", 1000);
    store.recordLatchTransition(latchA.id, "fired", 2000);
    store.recordLatchTransition(latchB.id, "armed", 1000);

    store.clearLatchTransitions(latchA.id);

    expect(store.getLatchTransitions(latchA.id)).toHaveLength(0);
    expect(store.getLatchTransitions(latchB.id)).toHaveLength(1);
  });
});
```

Adjust `makeConfigStore`/`seedLatch` to whatever the existing file's fixtures are actually named — read the file before writing this step for real.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/engine/test/config.test.ts -t "latch transitions"`
Expected: FAIL with `recordLatchTransition is not a function` (or similar).

- [ ] **Step 3: Implement the methods**

In `packages/engine/src/config.ts`:
1. Add `latchTransitions` to the schema import on line 6: `import { latches, latchState, latchTransitions, protectConsoles, sensors, webhookDeliveries } from "./schema";`
2. Add near `saveLatchState` (after it, for locality with other latch-state-adjacent methods):

```ts
recordLatchTransition(
  latchId: string,
  type: "armed" | "fired" | "resolved" | "cleared-before-fire",
  timestamp: number,
): void {
  this.db
    .insert(latchTransitions)
    .values({ id: crypto.randomUUID(), latchId, type, timestamp })
    .run();
}

getLatchTransitions(latchId: string): LatchTransitionRecord[] {
  return this.db
    .select()
    .from(latchTransitions)
    .where(eq(latchTransitions.latchId, latchId))
    .orderBy(latchTransitions.timestamp)
    .all()
    .map((row) => ({
      id: row.id,
      latchId: row.latchId,
      type: row.type as "armed" | "fired" | "resolved" | "cleared-before-fire",
      timestamp: row.timestamp,
    }));
}

clearLatchTransitions(latchId: string): void {
  this.db.delete(latchTransitions).where(eq(latchTransitions.latchId, latchId)).run();
}
```

3. Add the `LatchTransitionRecord` type. If `packages/shared/src/types.ts` is where other record types like `LatchStateRecord` live, add it there instead of locally (check that file — `LatchStateRecord` is at lines 127-133 per the existing codebase) and import it into `config.ts`:

```ts
export interface LatchTransitionRecord {
  id: string;
  latchId: string;
  type: "armed" | "fired" | "resolved" | "cleared-before-fire";
  timestamp: number;
}
```

Add `LatchTransitionRecord` to the `import type { ... } from "@unifi-sensor-latch/shared";` line at the top of `config.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/engine/test/config.test.ts -t "latch transitions"`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/config.ts packages/shared/src/types.ts packages/engine/test/config.test.ts
git commit -m "Add ConfigStore methods for the latch transition log"
```

---

### Task 3: Write transitions from `LatchEngine.ingest()`

**Files:**
- Modify: `packages/engine/src/singleton.ts`
- Test: `packages/engine/test/singleton.test.ts` if it exists (check first — if `ingest()` already has coverage there, extend it; otherwise add a focused test file `packages/engine/test/ingestTransitionLog.test.ts` that constructs a real `LatchEngine`/`ConfigStore` pair the same way existing singleton/engine tests do)

**Interfaces:**
- Consumes: `recordLatchTransition` from Task 2.
- Produces: nothing new consumed by later tasks — this closes the write path.

- [ ] **Step 1: Write the failing test**

First check whether `packages/engine/test/singleton.test.ts` exists and how it constructs an engine/config for testing `ingest()`. If it exists, add:

```ts
test("ingest records a latch_transitions row on a real transition, none on a same-state tick", () => {
  const engine = makeTestEngine(); // reuse whatever fixture the file's other ingest() tests already use
  const latch = seedEnabledLatch(engine, { durationSeconds: 600 }); // reuse existing fixture helpers

  engine.ingest({ sensorId: latch.sensorId, metric: latch.metric, value: 60, timestamp: 1000 });
  expect(engine.config.getLatchTransitions(latch.id).map((t) => t.type)).toEqual(["armed"]);

  // Still armed, condition still met, duration not yet elapsed — no new row.
  engine.ingest({ sensorId: latch.sensorId, metric: latch.metric, value: 60, timestamp: 2000 });
  expect(engine.config.getLatchTransitions(latch.id)).toHaveLength(1);

  // Duration elapses — fires.
  engine.ingest({
    sensorId: latch.sensorId,
    metric: latch.metric,
    value: 60,
    timestamp: 1000 + latch.durationSeconds * 1000,
  });
  expect(engine.config.getLatchTransitions(latch.id).map((t) => t.type)).toEqual(["armed", "fired"]);
});
```

If no such test file/fixtures exist yet for `ingest()`, write this as a new minimal file following the same real-`ConfigStore`-plus-in-memory-db pattern used by `config.test.ts` (read that file's fixture setup and reuse it), constructing `LatchEngine` directly rather than through `getEngine()`'s singleton/HTTP wiring.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test -t "ingest records a latch_transitions row"`
Expected: FAIL — `getLatchTransitions` returns `[]` instead of `["armed"]` (the write doesn't happen yet).

- [ ] **Step 3: Implement the write**

In `packages/engine/src/singleton.ts`, in `ingest()` (currently lines 462-494), immediately after the `saveLatchState` call and before the `sensorName`/dispatch block:

```ts
      const current = this.config.getLatchState(latch.id) ?? initialState(latch.id, reading.timestamp);
      const { next, transition } = applyReading(latch, current, reading);
      this.config.saveLatchState(next);
      if (transition.type !== "none") {
        this.config.recordLatchTransition(latch.id, transition.type, reading.timestamp);
      }

      const sensorName = sensor?.name ?? reading.sensorId;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test -t "ingest records a latch_transitions row"`
Expected: PASS.

- [ ] **Step 5: Run the full engine test suite to check for regressions**

Run: `bun test packages/engine/`
Expected: all pass, including the state-machine and webhook-dispatch tests already in the suite.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/singleton.ts packages/engine/test/
git commit -m "Record latch state transitions to the event log on ingest"
```

---

### Task 4: `computeLatchStats` pure aggregation function

**Files:**
- Create: `packages/engine/src/latchStats.ts`
- Test: `packages/engine/test/latchStats.test.ts`

**Interfaces:**
- Consumes: `LatchTransitionRecord` type from Task 2; `LatchStateRecord` type (existing, `{ latchId, state, armedAt, firedAt, updatedAt }`).
- Produces:
  ```ts
  export type LatchStatsWindowKey = "1d" | "7d" | "30d" | "365d" | "all";

  export interface LatchStatsWindow {
    armedCount: number;
    firedCount: number;
    idleCount: number;
    armedSeconds: number;
    firedSeconds: number;
  }

  export type LatchStats = Record<LatchStatsWindowKey, LatchStatsWindow>;

  export function computeLatchStats(
    events: LatchTransitionRecord[], // must be sorted ascending by timestamp; function does not re-sort
    liveState: LatchStateRecord | null,
    now: number,
  ): LatchStats
  ```
  Consumed by Task 5 (the stats route) and directly by its own unit tests.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/latchStats.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeLatchStats } from "../src/latchStats";
import type { LatchTransitionRecord } from "@unifi-sensor-latch/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

function ev(type: LatchTransitionRecord["type"], timestamp: number): LatchTransitionRecord {
  return { id: `ev-${timestamp}-${type}`, latchId: "latch-1", type, timestamp };
}

describe("computeLatchStats", () => {
  test("empty event list and idle live state returns all zeros for every window", () => {
    const now = 10 * DAY_MS;
    const stats = computeLatchStats([], { latchId: "latch-1", state: "idle", armedAt: null, firedAt: null, updatedAt: now }, now);

    for (const key of ["1d", "7d", "30d", "365d", "all"] as const) {
      expect(stats[key]).toEqual({ armedCount: 0, firedCount: 0, idleCount: 0, armedSeconds: 0, firedSeconds: 0 });
    }
  });

  test("counts armed, fired, and idle (lumping resolved and cleared-before-fire) within the all-time window", () => {
    const now = 10 * DAY_MS;
    const events = [
      ev("armed", 1 * DAY_MS),
      ev("cleared-before-fire", 1 * DAY_MS + 1000), // idle path 1
      ev("armed", 2 * DAY_MS),
      ev("fired", 2 * DAY_MS + 2000),
      ev("resolved", 2 * DAY_MS + 3000), // idle path 2
    ];
    const liveState = { latchId: "latch-1", state: "idle" as const, armedAt: null, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats.all.armedCount).toBe(2);
    expect(stats.all.firedCount).toBe(1);
    expect(stats.all.idleCount).toBe(2);
  });

  test("closed interval duration is summed and clipped to the window boundary", () => {
    const now = 10 * DAY_MS;
    // Armed for exactly 2 hours, entirely within the last 1 day.
    const armedAt = now - 3 * 60 * 60 * 1000;
    const firedAt = armedAt + 2 * 60 * 60 * 1000;
    const events = [ev("armed", armedAt), ev("fired", firedAt), ev("resolved", firedAt + 60_000)];
    const liveState = { latchId: "latch-1", state: "idle" as const, armedAt: null, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["1d"].armedSeconds).toBe(2 * 60 * 60);
  });

  test("an interval that starts before a window boundary is clipped to the boundary", () => {
    const now = 10 * DAY_MS;
    // Armed starting 2 days ago (outside the 1d window), fired 1 day ago (inside it).
    const armedAt = now - 2 * DAY_MS;
    const firedAt = now - 1 * DAY_MS;
    const events = [ev("armed", armedAt), ev("fired", firedAt)];
    const liveState = { latchId: "latch-1", state: "fired" as const, armedAt, firedAt, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    // Only the portion of the armed interval inside the last 1 day counts: from
    // (now - 1*DAY_MS) [the window start] to firedAt (now - 1*DAY_MS) = 0 seconds
    // armed inside the window, since the armed->fired transition happened right
    // at the window boundary in this fixture.
    expect(stats["1d"].armedSeconds).toBe(0);
  });

  test("a currently open interval (still armed) counts time up to now, clipped to the window", () => {
    const now = 10 * DAY_MS;
    const armedAt = now - 30 * 60 * 1000; // armed 30 minutes ago, still armed
    const events = [ev("armed", armedAt)];
    const liveState = { latchId: "latch-1", state: "armed" as const, armedAt, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["1d"].armedSeconds).toBe(30 * 60);
    expect(stats.all.armedSeconds).toBe(30 * 60);
  });

  test("a currently open fired interval counts separately from armed time", () => {
    const now = 10 * DAY_MS;
    const armedAt = now - 90 * 60 * 1000;
    const firedAt = now - 20 * 60 * 1000;
    const events = [ev("armed", armedAt), ev("fired", firedAt)];
    const liveState = { latchId: "latch-1", state: "fired" as const, armedAt, firedAt, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["1d"].armedSeconds).toBe(70 * 60); // armedAt -> firedAt
    expect(stats["1d"].firedSeconds).toBe(20 * 60); // firedAt -> now, still open
  });

  test("events outside the window are excluded from counts entirely", () => {
    const now = 400 * DAY_MS; // > 365 days of runway
    const events = [ev("armed", now - 400 * DAY_MS)]; // way outside every finite window
    const liveState = { latchId: "latch-1", state: "idle" as const, armedAt: null, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["365d"].armedCount).toBe(0);
    expect(stats.all.armedCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/engine/test/latchStats.test.ts`
Expected: FAIL — module `../src/latchStats` does not exist.

- [ ] **Step 3: Implement `computeLatchStats`**

Create `packages/engine/src/latchStats.ts`:

```ts
import type { LatchStateRecord, LatchTransitionRecord } from "@unifi-sensor-latch/shared";

export type LatchStatsWindowKey = "1d" | "7d" | "30d" | "365d" | "all";

export interface LatchStatsWindow {
  armedCount: number;
  firedCount: number;
  idleCount: number;
  armedSeconds: number;
  firedSeconds: number;
}

export type LatchStats = Record<LatchStatsWindowKey, LatchStatsWindow>;

const DAY_MS = 24 * 60 * 60 * 1000;

const WINDOW_MS: Record<Exclude<LatchStatsWindowKey, "all">, number> = {
  "1d": 1 * DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "365d": 365 * DAY_MS,
};

function emptyWindow(): LatchStatsWindow {
  return { armedCount: 0, firedCount: 0, idleCount: 0, armedSeconds: 0, firedSeconds: 0 };
}

// A "state span" is a closed-or-open interval the latch spent in "armed" or
// "fired", derived by walking consecutive transition events plus the
// current live state for any still-open trailing span.
interface StateSpan {
  state: "armed" | "fired";
  start: number;
  end: number; // may equal `now` for a still-open span
}

function buildSpans(events: LatchTransitionRecord[], liveState: LatchStateRecord | null, now: number): StateSpan[] {
  const spans: StateSpan[] = [];
  let openState: "armed" | "fired" | null = null;
  let openStart = 0;

  for (const event of events) {
    if (event.type === "armed") {
      openState = "armed";
      openStart = event.timestamp;
    } else if (event.type === "fired") {
      if (openState === "armed") {
        spans.push({ state: "armed", start: openStart, end: event.timestamp });
      }
      openState = "fired";
      openStart = event.timestamp;
    } else {
      // "resolved" or "cleared-before-fire" — closes whatever was open.
      if (openState) {
        spans.push({ state: openState, start: openStart, end: event.timestamp });
      }
      openState = null;
    }
  }

  // A still-open span at the end of the event log, per the live state.
  if (openState && liveState && liveState.state !== "idle") {
    spans.push({ state: openState, start: openStart, end: now });
  }

  return spans;
}

function clip(span: StateSpan, windowStart: number, now: number): number {
  const start = Math.max(span.start, windowStart);
  const end = Math.min(span.end, now);
  return Math.max(0, end - start) / 1000;
}

export function computeLatchStats(
  events: LatchTransitionRecord[],
  liveState: LatchStateRecord | null,
  now: number,
): LatchStats {
  const spans = buildSpans(events, liveState, now);

  const windows: LatchStats = {
    "1d": emptyWindow(),
    "7d": emptyWindow(),
    "30d": emptyWindow(),
    "365d": emptyWindow(),
    all: emptyWindow(),
  };

  for (const key of Object.keys(windows) as LatchStatsWindowKey[]) {
    const windowStart = key === "all" ? -Infinity : now - WINDOW_MS[key];
    const bucket = windows[key];

    for (const event of events) {
      if (event.timestamp < windowStart || event.timestamp > now) continue;
      if (event.type === "armed") bucket.armedCount += 1;
      else if (event.type === "fired") bucket.firedCount += 1;
      else bucket.idleCount += 1; // resolved | cleared-before-fire
    }

    for (const span of spans) {
      if (span.end < windowStart || span.start > now) continue;
      const seconds = clip(span, windowStart, now);
      if (span.state === "armed") bucket.armedSeconds += seconds;
      else bucket.firedSeconds += seconds;
    }
  }

  return windows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/engine/test/latchStats.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/latchStats.ts packages/engine/test/latchStats.test.ts
git commit -m "Add pure computeLatchStats windowed aggregation function"
```

---

### Task 5: `GET`/clear stats route

**Files:**
- Create: `apps/web/app/api/latches/[id]/stats/route.ts`
- Test: check whether `apps/web/app/api/latches/[id]/route.ts` (or any `apps/web/app/api/**` route) has a colocated `*.test.ts` today. If the project has no existing route-handler test pattern, skip automated route tests here and instead do the manual verification in Step 4 below — do not invent a test harness that doesn't match the codebase's actual conventions.

**Interfaces:**
- Consumes: `requireRole` from `apps/web/lib/auth.ts`; `getEngine` from `@unifi-sensor-latch/engine`; `computeLatchStats` from Task 4; `engine.config.getLatchTransitions`, `engine.config.getLatchState`, `engine.config.clearLatchTransitions` from Tasks 2 and existing code.
- Produces: `GET /api/latches/:id/stats` → `{ stats: LatchStats }`; `POST /api/latches/:id/stats?action=clear` → `{ ok: true }`. Consumed by Task 6 (dashboard UI).

- [ ] **Step 1: Confirm the existing single-latch-lookup pattern**

Read `apps/web/app/api/latches/[id]/route.ts` in full to copy its exact param-handling convention (Next.js App Router route param typing — e.g. whether `params` is a `Promise<{ id: string }>` that must be awaited, per the Next.js version in use) and its 404 response shape (`{ error: "not found" }`, 404).

- [ ] **Step 2: Implement the route**

Create `apps/web/app/api/latches/[id]/stats/route.ts`, matching the exact param-await convention found in Step 1 (shown here assuming the async-params convention seen in the existing `[id]/route.ts` — adjust if that file uses a different Next.js version's synchronous `params`):

```ts
import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { computeLatchStats } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("user");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const latch = engine.config.listLatches().find((l) => l.id === id);
  if (!latch) return NextResponse.json({ error: "not found" }, { status: 404 });

  const events = engine.config.getLatchTransitions(id);
  const liveState = engine.config.getLatchState(id);
  const stats = computeLatchStats(events, liveState, Date.now());

  return NextResponse.json({ stats });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("superadmin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const url = new URL(req.url);
  if (url.searchParams.get("action") !== "clear") {
    return NextResponse.json({ error: "unsupported action" }, { status: 400 });
  }

  const engine = getEngine();
  const latch = engine.config.listLatches().find((l) => l.id === id);
  if (!latch) return NextResponse.json({ error: "not found" }, { status: 404 });

  engine.config.clearLatchTransitions(id);
  return NextResponse.json({ ok: true });
}
```

Check `packages/engine/src/index.ts` (the package's public export surface) to confirm `computeLatchStats` needs adding there — if `packages/engine/src/index.ts` re-exports named functions/types from submodules, add `export { computeLatchStats } from "./latchStats"; export type { LatchStats, LatchStatsWindow, LatchStatsWindowKey } from "./latchStats";` to it so the two-line import above resolves. If the package re-exports everything via `export *`, no change is needed there.

- [ ] **Step 3: Add `LatchTransitionRecord` to shared exports if not already done in Task 2**

Confirm `packages/shared/src/index.ts` (or wherever `packages/shared/src/types.ts` types are re-exported) exports `LatchTransitionRecord` — needed by `config.ts`'s import and by the route's type inference.

- [ ] **Step 4: Manual verification**

Start the dev server: `bun run dev` (or the project's documented dev script — check `package.json`).
With a logged-in `user`-role session cookie, `curl` (or browser fetch) `GET /api/latches/<a-real-latch-id>/stats` — expect 200 with a `stats` object containing all five window keys, all zeros for a latch with no transitions yet.
With a `user`-role session, `POST /api/latches/<id>/stats?action=clear` — expect 401 (not superadmin, per `requireRole`'s existing 401-not-403 convention for role failures — confirm this matches `auth.ts`'s actual behavior, quoted in Task-0 research: `requireRole` returns 401 for `!hasRole`, not 403).
With a `superadmin`-role session, repeat the `POST` — expect `{ ok: true }`.
Manually ingest a reading that arms a test latch (or wait for a real one to arm), then re-`GET` the stats route and confirm `armedCount` increments.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/latches/\[id\]/stats/route.ts packages/engine/src/index.ts
git commit -m "Add GET/clear stats route for latch transition history"
```

---

### Task 6: Dashboard UI — stats panel and Clear button

**Files:**
- Modify: `apps/web/app/dashboard-client.tsx`

**Interfaces:**
- Consumes: `GET /api/latches/:id/stats` and `POST /api/latches/:id/stats?action=clear` from Task 5; `useCurrentUser`/`hasRole` from `apps/web/lib/useCurrentUser.tsx` (existing).
- Produces: nothing consumed by later tasks — this is the final UI surface for the stats feature.

- [ ] **Step 1: Read the current card rendering block**

Read `apps/web/app/dashboard-client.tsx` in full (140 lines) to get its exact current `rules.map(...)` JSX (around lines 98-136 per prior research) and its existing `useState`/`useEffect` data-loading pattern, so the new per-card fetch follows the same conventions (loading state handling, error handling, etc. — copy whatever pattern the file already uses elsewhere, e.g. for the `states`/`sensors` initial load).

- [ ] **Step 2: Add stats state and fetch-on-mount per card**

Add near the top of the `DashboardClient` component function:

```tsx
const [statsByLatchId, setStatsByLatchId] = useState<Record<string, LatchStats | null>>({});

useEffect(() => {
  let cancelled = false;
  async function loadStats() {
    const entries = await Promise.all(
      rules.map(async (rule) => {
        const res = await fetch(`/api/latches/${rule.id}/stats`);
        if (!res.ok) return [rule.id, null] as const;
        const data = await res.json();
        return [rule.id, data.stats as LatchStats] as const;
      }),
    );
    if (!cancelled) setStatsByLatchId(Object.fromEntries(entries));
  }
  loadStats();
  return () => {
    cancelled = true;
  };
}, [rules]);
```

Import `LatchStats` type: `import type { LatchStats } from "@unifi-sensor-latch/shared";` (add it to shared's export surface in Task 5 Step 3 if not already there, or re-export it from wherever the engine's `LatchStats` type should live for frontend consumption — since `apps/web` should not import from `@unifi-sensor-latch/engine` directly for types used in client components, move the `LatchStats`/`LatchStatsWindow`/`LatchStatsWindowKey` type definitions from `packages/engine/src/latchStats.ts` into `packages/shared/src/types.ts` instead, and have `latchStats.ts` import them from there. Update Task 4 and Task 5 accordingly: `latchStats.ts` becomes `import type { LatchStats, LatchStatsWindow, LatchStatsWindowKey, LatchTransitionRecord, LatchStateRecord } from "@unifi-sensor-latch/shared";` with only the `computeLatchStats` function and its internal `WINDOW_MS`/`buildSpans`/`clip` helpers remaining local, and `packages/shared/src/types.ts` gains the three type exports).

- [ ] **Step 3: Render the stats panel per card**

Inside each `<Card>`'s `<CardContent>` (or a new section before the closing `</Card>`), add:

```tsx
{statsByLatchId[rule.id] && (
  <div className="mt-2 text-xs text-muted-foreground">
    <div className="grid grid-cols-6 gap-1">
      <div></div>
      <div className="text-center font-medium">1d</div>
      <div className="text-center font-medium">7d</div>
      <div className="text-center font-medium">30d</div>
      <div className="text-center font-medium">365d</div>
      <div className="text-center font-medium">All</div>
      {(["armedCount", "firedCount", "idleCount"] as const).map((field) => (
        <FragmentRow key={field} label={statLabel(field)} stats={statsByLatchId[rule.id]!} field={field} format={(n) => String(n)} />
      ))}
      <FragmentRow label="Time armed" stats={statsByLatchId[rule.id]!} field="armedSeconds" format={formatDuration} />
      <FragmentRow label="Time fired" stats={statsByLatchId[rule.id]!} field="firedSeconds" format={formatDuration} />
    </div>
    {actor && hasRole(actor, "superadmin") && (
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => clearStats(rule.id, rule.name)}
      >
        Clear stats
      </Button>
    )}
  </div>
)}
```

Add the small helpers above the component (or in the same file, below it):

```tsx
function statLabel(field: "armedCount" | "firedCount" | "idleCount"): string {
  if (field === "armedCount") return "Armed";
  if (field === "firedCount") return "Fired";
  return "Idle";
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return "0m";
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function FragmentRow({
  label,
  stats,
  field,
  format,
}: {
  label: string;
  stats: LatchStats;
  field: keyof LatchStats["1d"];
  format: (n: number) => string;
}) {
  return (
    <>
      <div>{label}</div>
      <div className="text-center">{format(stats["1d"][field])}</div>
      <div className="text-center">{format(stats["7d"][field])}</div>
      <div className="text-center">{format(stats["30d"][field])}</div>
      <div className="text-center">{format(stats["365d"][field])}</div>
      <div className="text-center">{format(stats.all[field])}</div>
    </>
  );
}
```

- [ ] **Step 4: Implement `clearStats`**

```tsx
async function clearStats(latchId: string, latchName: string | null) {
  const label = latchName ?? "this rule";
  if (!window.confirm(`This permanently deletes history for ${label}. Cannot be undone.`)) return;
  await fetch(`/api/latches/${latchId}/stats?action=clear`, { method: "POST" });
  const res = await fetch(`/api/latches/${latchId}/stats`);
  if (res.ok) {
    const data = await res.json();
    setStatsByLatchId((prev) => ({ ...prev, [latchId]: data.stats }));
  }
}
```

Note: confirm the file already imports `hasRole` and has `actor` available (per prior research, `dashboard-client.tsx` uses `const { user: actor } = useCurrentUser();` at line 71) — if `hasRole` isn't already imported there, add `import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";` matching whatever the file's actual existing import line is (read it first, don't duplicate an existing import).

- [ ] **Step 5: Manual verification**

Run: `bun run dev`
Log in as a `user`-role account, view the dashboard: confirm stats panels render with zeros for latches with no history, and no Clear button is visible.
Log in as `superadmin`, confirm the Clear button appears; click it, confirm the browser confirm dialog text has no dash characters and reads correctly; confirm clicking OK zeroes out the panel.
Trigger a real or test arm/fire cycle on a latch (via the Rules page's existing "Test" button, or by adjusting a sensor value if using a real sensor) and confirm the dashboard's `armedCount`/`firedCount` increments after a refresh.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/dashboard-client.tsx packages/shared/src/types.ts packages/engine/src/latchStats.ts
git commit -m "Show latch stats panel and superadmin clear action on the dashboard"
```

---

### Task 7: Rule copy route

**Files:**
- Create: `apps/web/app/api/latches/[id]/copy/route.ts`

**Interfaces:**
- Consumes: `requireRole`, `getEngine`, existing latch validation helpers (`latchNameSchema`/`normalizeLatchName`, `validateCondition`, `validateWebhookTarget`, `isDurationValid` — reuse via `engine.config.upsertLatch`, which the create/update routes already validate before calling; this route performs no new validation of its own since it copies an already-valid latch verbatim).
- Produces: `POST /api/latches/:id/copy` → `{ latch: Latch }` (redacted per the existing `redactLatch` convention). Consumed by Task 8 (Rules page UI).

- [ ] **Step 1: Read the existing create route's exact validation and response shape**

Read `apps/web/app/api/latches/route.ts` in full again (already quoted in research) to copy its exact `redactLatch` import and usage, and its exact success response shape (`{ latch: redactLatch(latch, actor.role) }`, status 201).

- [ ] **Step 2: Implement the route**

Create `apps/web/app/api/latches/[id]/copy/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getEngine } from "@unifi-sensor-latch/engine";
import { requireRole } from "@/lib/auth";
import { redactLatch } from "@/lib/latchRedaction";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole("admin");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const engine = getEngine();
  const source = engine.config.listLatches().find((l) => l.id === id);
  if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });

  const copy = {
    ...source,
    id: crypto.randomUUID(),
    name: `${source.name ?? "Untitled"} (copy)`,
    enabled: false,
  };

  engine.config.upsertLatch(copy);

  return NextResponse.json({ latch: redactLatch(copy, actor.role) }, { status: 201 });
}
```

Note: `latchNameSchema` caps names at 100 characters (`packages/engine`'s `validation.ts:36`, re-exported from `@unifi-sensor-latch/shared`). A source name near that limit plus `" (copy)"` (7 chars) could exceed 100. Add a truncation guard so the copy route can't produce a latch that would fail re-validation on a later edit:

```ts
function buildCopyName(sourceName: string | null): string {
  const base = sourceName ?? "Untitled";
  const suffix = " (copy)";
  const maxBaseLength = 100 - suffix.length;
  const truncatedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength) : base;
  return `${truncatedBase}${suffix}`;
}
```

Use `buildCopyName(source.name)` in place of the inline template literal above.

- [ ] **Step 3: Manual verification**

Run: `bun run dev`
As `user` role: `POST /api/latches/<id>/copy` — expect 401.
As `admin` role: `POST /api/latches/<id>/copy` on a real latch — expect 201, `latch.enabled === false`, `latch.name` ends with `" (copy)"`, and every other field (`sensorId`, `metric`, `condition`, `durationSeconds`, `webhook`) matches the source. Confirm via `GET /api/latches` that both the original and the copy now exist as separate rows.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/latches/\[id\]/copy/route.ts
git commit -m "Add rule copy route, always creating the copy disabled"
```

---

### Task 8: Rules page UI — Copy button

**Files:**
- Modify: `apps/web/app/rules/rules-client.tsx`

**Interfaces:**
- Consumes: `POST /api/latches/:id/copy` from Task 7; existing `load()`, `canEdit`, `setDetailsRuleId` from the file.

- [ ] **Step 1: Read the exact current action-button block**

Read `apps/web/app/rules/rules-client.tsx` around lines 1304-1338 (the `canEdit && (...)` block with Edit/Test/Enable-Disable/Delete buttons) to confirm current exact JSX and any surrounding state (`testingId`, `detailsRule`) so the new button matches formatting and behavior conventions exactly.

- [ ] **Step 2: Add the `copyRule` handler**

Near `deleteRule` (lines 730-733 per prior research), add:

```tsx
async function copyRule(id: string) {
  setCopyingId(id);
  try {
    const res = await fetch(`/api/latches/${id}/copy`, { method: "POST" });
    if (res.ok) {
      await load();
    }
  } finally {
    setCopyingId(null);
  }
}
```

Add `const [copyingId, setCopyingId] = useState<string | null>(null);` alongside the existing `testingId` state declaration (find its exact line and add this next to it, matching the file's naming convention).

- [ ] **Step 3: Add the button**

In the action button block, add a Copy button between Edit and Test:

```tsx
<Button
  variant="outline"
  size="sm"
  disabled={copyingId === detailsRule.id}
  onClick={() => copyRule(detailsRule.id)}
>
  {copyingId === detailsRule.id ? "Copying…" : "Copy"}
</Button>
```

- [ ] **Step 4: Manual verification**

Run: `bun run dev`
Log in as `admin`, open a rule's details dialog on the Rules page, click Copy. Confirm: the button shows "Copying…" briefly, the list refreshes, and a new rule appears named `"<original> (copy)"` with a disabled badge/state, same sensor/condition/duration/webhook as the original.
Log in as `user`, confirm no Copy button is visible (gated by the same `canEdit` check as Edit/Delete).

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/rules/rules-client.tsx
git commit -m "Add Copy action to the Rules page, always landing disabled"
```

---

### Task 9: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all pass, including every test added in Tasks 2-4 and the pre-existing suite (state machine, config, engine, any route tests).

- [ ] **Step 2: Type check**

Run: `bun run typecheck` (or whatever the project's exact typecheck script is named — check `package.json` scripts; if none exists, run `bunx tsc --noEmit` from each affected package: `packages/shared`, `packages/engine`, `apps/web`).
Expected: no errors, particularly around the `LatchStats`/`LatchStatsWindow`/`LatchStatsWindowKey`/`LatchTransitionRecord` types now shared across `packages/shared`, `packages/engine`, and `apps/web`.

- [ ] **Step 3: Full manual walkthrough**

Run: `bun run dev`
Walk through, in order: create a test latch with a short duration, trigger it to arm and fire via the Rules page's Test action or a real sensor reading, confirm the dashboard stats panel shows the increment, clear the stats as superadmin and confirm it zeroes, copy the rule from the Rules page and confirm the copy lands disabled with identical config.

- [ ] **Step 4: Final commit if anything was fixed during the regression pass**

```bash
git add -A
git commit -m "Fix issues found during latch stats and rule copy regression pass"
```
(Only if fixes were needed — skip if Steps 1-3 were clean.)
