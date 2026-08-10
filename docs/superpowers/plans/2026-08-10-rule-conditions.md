# Rule Conditions Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Rules/Latch domain's flat `direction`/`armThreshold`/`clearThreshold` condition with a `RuleCondition` union supporting `above`, `below`, and a new `between` (range) mode, each with manual hysteresis, plus an `between`-only "auto" hysteresis (percent-of-range-width margin).

**Architecture:** A new pure module (`packages/shared/src/condition.ts`) owns all condition evaluation, hysteresis-bound resolution, validation, and display-label logic — the state machine, webhook dispatcher, API routes, and both UI pages (Rules, Dashboard) all consume it rather than re-implementing threshold comparisons locally. Storage moves from three flat SQLite columns to one `condition_json` TEXT column (mirroring the existing `webhook_json` pattern), applied as two non-interactive Drizzle migrations (add-nullable-column, then drop-old-columns-and-make-not-null) since the table currently has zero rows.

**Tech Stack:** TypeScript, Drizzle ORM (`bun:sqlite`), Bun test runner, Next.js App Router, Zod (validation only where already used — this feature adds no new Zod schemas, condition validation is plain functions per the design doc).

## Global Constraints

- Never read/inspect `.env` (CLAUDE.md) — not touched by this feature anyway.
- Server-side validation is the actual gate; client-side is a convenience only (CLAUDE.md trust boundaries) — `validateCondition` must be called from the API routes, not just the form.
- Webhook URLs stay masked everywhere they're read back (CLAUDE.md secret obfuscation) — unaffected by this change, but don't regress it while touching `apps/web/app/api/latches/**`.
- The latch state machine is the correctness-critical piece (CLAUDE.md) — every state-machine change needs the five required test cases (arms, clears-before-fire, fires, resolved-only-after-fired, restart-mid-armed persistence) for `between` mode, not just above/below.
- No existing rules are configured on the real deployment — this migration does NOT need to preserve/transform old rows, per the user's explicit go-ahead.
- Follow the approved design: `docs/superpowers/specs/2026-08-10-rule-conditions-design.md` and `SPEC.md` §4/§4a (already updated to match).

---

## File Structure

- **Create** `packages/shared/src/condition.ts` — `RuleCondition`-related pure logic (evaluation, hysteresis bounds, validation, display labels). New file because this logic is genuinely shared across the engine (state machine), the webhook dispatcher, two API routes, and two UI pages — it doesn't belong to any one of them.
- **Create** `packages/engine/test/condition.test.ts` — tests for the above, living in `packages/engine/test/` alongside `interval.test.ts` (an existing precedent: shared-package pure logic is tested from the engine package's test dir since that's where `bun test` is already wired up for this repo).
- **Modify** `packages/shared/src/types.ts` — replace `Direction`/`Latch.direction`/`armThreshold`/`clearThreshold` with `Latch.condition: RuleCondition`.
- **Modify** `packages/shared/src/index.ts` — export the new `condition.ts` module.
- **Modify** `packages/engine/src/schema.ts` — replace the three flat columns with `condition_json`.
- **Modify** `packages/engine/src/config.ts` — `latchFromRow`/`upsertLatch` read/write `condition_json` via `JSON.parse`/`JSON.stringify`.
- **Modify** `packages/engine/test/config.test.ts` — fixture update only (new `Latch` shape).
- **Modify** `packages/engine/src/stateMachine.ts` — arm/clear checks delegate to `condition.ts` instead of local `isBad`/`isRecovered`.
- **Modify** `packages/engine/test/stateMachine.test.ts` — fixture update + new `between`-mode test cases.
- **Modify** `packages/engine/src/webhookDispatcher.ts` — `{{threshold}}` template substitution uses `conditionThresholdTemplateValue`.
- **Modify** `packages/engine/test/webhookDispatcher.test.ts` — fixture update only.
- **Modify** `apps/web/app/api/latches/route.ts` and `apps/web/app/api/latches/[id]/route.ts` — call `validateCondition` server-side.
- **Modify** `apps/web/app/rules/page.tsx` — condition-driven form (mode-specific fields) + plain-language table column.
- **Modify** `apps/web/app/page.tsx` (Dashboard) — one-line swap from `{rule.direction} {rule.armThreshold}` to `conditionSummary(rule.condition)`.

---

## Task 1: Shared condition module

**Files:**
- Create: `packages/shared/src/condition.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/engine/test/condition.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  - `type RuleCondition = { type: "above"; threshold: number; hysteresis: ManualHysteresis } | { type: "below"; threshold: number; hysteresis: ManualHysteresis } | { type: "between"; low: number; high: number; hysteresis: RangeHysteresis }`
  - `interface ManualHysteresis { mode: "manual"; clearThreshold: number }`
  - `type RangeHysteresis = { mode: "manual"; clearLow: number; clearHigh: number } | { mode: "auto"; marginPercent: number }`
  - `function isConditionMet(condition: RuleCondition, value: number): boolean`
  - `function isConditionRecovered(condition: RuleCondition, value: number): boolean`
  - `function validateCondition(condition: RuleCondition): { valid: boolean; error?: string }`
  - `function conditionSummary(condition: RuleCondition, unitSuffix?: string): string`
  - `function conditionThresholdTemplateValue(condition: RuleCondition): string`
  - `interface Latch { id: string; sensorId: string; metric: Metric; condition: RuleCondition; durationSeconds: number; webhook: WebhookTarget; resolvedWebhook?: WebhookTarget; enabled: boolean }` (in `types.ts` — `Direction` type is deleted)

- [ ] **Step 1: Write the failing test file**

Create `packages/engine/test/condition.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  isConditionMet,
  isConditionRecovered,
  validateCondition,
  conditionSummary,
  conditionThresholdTemplateValue,
} from "@unifi-sensor-latch/shared";
import type { RuleCondition } from "@unifi-sensor-latch/shared";

describe("isConditionMet", () => {
  test("above: true when value exceeds threshold", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(isConditionMet(c, 60)).toBe(true);
    expect(isConditionMet(c, 55)).toBe(false);
    expect(isConditionMet(c, 50)).toBe(false);
  });

  test("below: true when value is under threshold", () => {
    const c: RuleCondition = { type: "below", threshold: 32, hysteresis: { mode: "manual", clearThreshold: 40 } };
    expect(isConditionMet(c, 20)).toBe(true);
    expect(isConditionMet(c, 32)).toBe(false);
    expect(isConditionMet(c, 40)).toBe(false);
  });

  test("between: true when value is within [low, high] inclusive", () => {
    const c: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    expect(isConditionMet(c, 40)).toBe(true);
    expect(isConditionMet(c, 55)).toBe(true);
    expect(isConditionMet(c, 47)).toBe(true);
    expect(isConditionMet(c, 39)).toBe(false);
    expect(isConditionMet(c, 56)).toBe(false);
  });
});

describe("isConditionRecovered", () => {
  test("above: recovered at or below the manual clear threshold", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(isConditionRecovered(c, 38)).toBe(true);
    expect(isConditionRecovered(c, 39)).toBe(false);
  });

  test("below: recovered at or above the manual clear threshold", () => {
    const c: RuleCondition = { type: "below", threshold: 32, hysteresis: { mode: "manual", clearThreshold: 40 } };
    expect(isConditionRecovered(c, 40)).toBe(true);
    expect(isConditionRecovered(c, 39)).toBe(false);
  });

  test("between manual: recovered strictly outside the manual clear bounds", () => {
    const c: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    expect(isConditionRecovered(c, 34)).toBe(true);
    expect(isConditionRecovered(c, 35)).toBe(false); // still within clear bounds, not recovered yet
    expect(isConditionRecovered(c, 61)).toBe(true);
    expect(isConditionRecovered(c, 47)).toBe(false);
  });

  test("between auto: recovered strictly outside range expanded by marginPercent of its width", () => {
    // range width 15 (40-55), marginPercent 10 -> margin 1.5
    const c: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "auto", marginPercent: 10 },
    };
    expect(isConditionRecovered(c, 38.6)).toBe(true); // < 38.5? no: 38.6 > 38.5, not recovered
    expect(isConditionRecovered(c, 38.4)).toBe(true); // < 38.5, recovered
    expect(isConditionRecovered(c, 56.4)).toBe(false); // <= 56.5, not recovered
    expect(isConditionRecovered(c, 56.6)).toBe(true); // > 56.5, recovered
  });
});

describe("validateCondition", () => {
  test("between requires low < high", () => {
    const c: RuleCondition = {
      type: "between",
      low: 55,
      high: 40,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    const result = validateCondition(c);
    expect(result.valid).toBe(false);
  });

  test("between auto requires marginPercent > 0", () => {
    const c: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 0 } };
    const result = validateCondition(c);
    expect(result.valid).toBe(false);
  });

  test("valid above condition passes", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(validateCondition(c).valid).toBe(true);
  });

  test("valid between condition (manual and auto) passes", () => {
    const manual: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    const auto: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 5 } };
    expect(validateCondition(manual).valid).toBe(true);
    expect(validateCondition(auto).valid).toBe(true);
  });
});

describe("conditionSummary", () => {
  test("above/below render as plain language", () => {
    const above: RuleCondition = { type: "above", threshold: 500, hysteresis: { mode: "manual", clearThreshold: 500 } };
    expect(conditionSummary(above)).toBe("above 500");
  });

  test("between renders both bounds, with auto margin noted", () => {
    const auto: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 5 } };
    expect(conditionSummary(auto)).toBe("between 40 and 55, ±5% auto");
    const manual: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    expect(conditionSummary(manual)).toBe("between 40 and 55");
  });
});

describe("conditionThresholdTemplateValue", () => {
  test("above/below returns the single threshold", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(conditionThresholdTemplateValue(c)).toBe("55");
  });

  test("between returns 'low-high'", () => {
    const c: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 5 } };
    expect(conditionThresholdTemplateValue(c)).toBe("40-55");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/engine/test/condition.test.ts`
Expected: FAIL — `@unifi-sensor-latch/shared` has no export `isConditionMet` (module doesn't exist yet).

- [ ] **Step 3: Update `packages/shared/src/types.ts`**

Remove the `Direction` type and the `direction`/`armThreshold`/`clearThreshold` fields from `Latch`. Replace with:

```ts
export interface Latch {
  id: string;
  sensorId: string;
  metric: Metric;
  condition: RuleCondition;
  durationSeconds: number;
  webhook: WebhookTarget;
  resolvedWebhook?: WebhookTarget;
  enabled: boolean;
}
```

Note: `RuleCondition` itself is defined in the new `condition.ts` (Step 4), not here — `types.ts` imports it: add `import type { RuleCondition } from "./condition";` near the top, alongside the existing type-only imports.

Also delete the old `export type Direction = "above" | "below";` line entirely (searched: only `types.ts` and `apps/web/app/rules/page.tsx` reference `Direction`, and the Rules page is rewritten in Task 6).

- [ ] **Step 4: Implement `packages/shared/src/condition.ts`**

```ts
// Rule condition evaluation, hysteresis, validation, and display logic —
// see docs/superpowers/specs/2026-08-10-rule-conditions-design.md. This is
// the one place that knows what "armed"/"recovered" means for a
// condition; the state machine (packages/engine/src/stateMachine.ts),
// webhook template substitution, the API routes' server-side validation,
// and both UI pages (Rules, Dashboard) all consume it rather than
// re-implementing threshold comparisons.

export interface ManualHysteresis {
  mode: "manual";
  clearThreshold: number;
}

export type RangeHysteresis =
  | { mode: "manual"; clearLow: number; clearHigh: number }
  | { mode: "auto"; marginPercent: number };

export type RuleCondition =
  | { type: "above"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "below"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "between"; low: number; high: number; hysteresis: RangeHysteresis };

// "Is the raw reading currently bad" — the arm check. Duration timing
// (how long it has to stay this way before firing) lives in the state
// machine, not here; this is purely "true/false right now."
export function isConditionMet(condition: RuleCondition, value: number): boolean {
  switch (condition.type) {
    case "above":
      return value > condition.threshold;
    case "below":
      return value < condition.threshold;
    case "between":
      return value >= condition.low && value <= condition.high;
  }
}

// "Has it moved back far enough to count as recovered" — the clear
// check. For `between`, the auto-hysteresis margin is a percent of the
// range's width, expanded outward on both sides (see the design doc's
// worked example: range 30-40, marginPercent 5 -> must drop below 29.5
// or rise above 40.5).
export function isConditionRecovered(condition: RuleCondition, value: number): boolean {
  switch (condition.type) {
    case "above":
      return value <= condition.hysteresis.clearThreshold;
    case "below":
      return value >= condition.hysteresis.clearThreshold;
    case "between": {
      const { clearLow, clearHigh } = resolveClearBounds(condition);
      return value < clearLow || value > clearHigh;
    }
  }
}

function resolveClearBounds(condition: Extract<RuleCondition, { type: "between" }>): {
  clearLow: number;
  clearHigh: number;
} {
  if (condition.hysteresis.mode === "manual") {
    return { clearLow: condition.hysteresis.clearLow, clearHigh: condition.hysteresis.clearHigh };
  }
  const width = condition.high - condition.low;
  const margin = width * (condition.hysteresis.marginPercent / 100);
  return { clearLow: condition.low - margin, clearHigh: condition.high + margin };
}

export interface ConditionValidationResult {
  valid: boolean;
  error?: string;
}

// Server-side gate (CLAUDE.md trust boundaries) — called from the
// /api/latches routes, not just the form. Scope is deliberately narrow,
// matching the approved design: `between` needs low < high, and auto
// hysteresis needs a positive margin. (Manual clear-bound sanity for
// above/below/between-manual is intentionally out of scope — no such
// check existed before this change either; see the design doc's
// Non-goals.)
export function validateCondition(condition: RuleCondition): ConditionValidationResult {
  if (condition.type === "between") {
    if (!(condition.low < condition.high)) {
      return { valid: false, error: "The low bound must be less than the high bound." };
    }
    if (condition.hysteresis.mode === "auto" && !(condition.hysteresis.marginPercent > 0)) {
      return { valid: false, error: "Auto hysteresis margin must be greater than 0%." };
    }
  }
  return { valid: true };
}

// Plain-language summary for the Rules table and Dashboard — unitSuffix
// lets a caller append e.g. "°F" without this module knowing about
// metric-specific formatting (that's the Sensors page's job already, see
// apps/web/app/sensors/page.tsx's formatValue).
export function conditionSummary(condition: RuleCondition, unitSuffix = ""): string {
  switch (condition.type) {
    case "above":
      return `above ${condition.threshold}${unitSuffix}`;
    case "below":
      return `below ${condition.threshold}${unitSuffix}`;
    case "between": {
      const hysteresisLabel =
        condition.hysteresis.mode === "auto" ? `, ±${condition.hysteresis.marginPercent}% auto` : "";
      return `between ${condition.low}${unitSuffix} and ${condition.high}${unitSuffix}${hysteresisLabel}`;
    }
  }
}

// Feeds the webhook body template's {{threshold}} variable (see
// webhookDispatcher.ts) — above/below has one natural number, between
// doesn't, so it renders as "low-high".
export function conditionThresholdTemplateValue(condition: RuleCondition): string {
  return condition.type === "between" ? `${condition.low}-${condition.high}` : String(condition.threshold);
}
```

- [ ] **Step 5: Export the new module from `packages/shared/src/index.ts`**

```ts
export * from "./types";
export * from "./maskSecret";
export * from "./validation";
export * from "./interval";
export * from "./condition";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/engine/test/condition.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 7: Full typecheck (will show downstream breakage — expected)**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: FAILS in `packages/engine/src/config.ts`, `stateMachine.ts`, `webhookDispatcher.ts`, `apps/web/app/rules/page.tsx`, `apps/web/app/page.tsx`, `apps/web/app/api/latches/**` — every remaining reference to `latch.direction`/`armThreshold`/`clearThreshold`. This is expected and fixed by the remaining tasks; don't try to fix them here.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/condition.ts packages/shared/src/types.ts packages/shared/src/index.ts packages/engine/test/condition.test.ts
git commit -m "$(cat <<'EOF'
Add shared RuleCondition module (above/below/between + hysteresis)

Pure evaluation/validation/display logic for the new condition model —
consumed by the state machine, webhook dispatcher, API routes, and UI in
the following tasks. Latch.direction/armThreshold/clearThreshold are
replaced by Latch.condition: RuleCondition (downstream call sites break
until the following tasks land — expected, tracked in the plan).
EOF
)"
```

---

## Task 2: Schema + config store

**Files:**
- Modify: `packages/engine/src/schema.ts`
- Modify: `packages/engine/src/config.ts`
- Modify: `packages/engine/test/config.test.ts`
- Create: two migrations under `packages/engine/drizzle/` (via `drizzle-kit generate`, not hand-authored)

**Interfaces:**
- Consumes: `RuleCondition` from Task 1 (`@unifi-sensor-latch/shared`).
- Produces: `ConfigStore.upsertLatch(latch: Latch): void` and `ConfigStore.listLatches(): Latch[]` continue to exist with the same signatures — later tasks (state machine, API routes) call them unchanged.

- [ ] **Step 1: Edit `packages/engine/src/schema.ts` — add the new column only, alongside the old ones**

```ts
export const latches = sqliteTable("latches", {
  id: text("id").primaryKey(),
  sensorId: text("sensor_id").notNull(),
  metric: text("metric").notNull(),
  direction: text("direction").notNull(), // "above" | "below"
  armThreshold: real("arm_threshold").notNull(),
  clearThreshold: real("clear_threshold").notNull(),
  conditionJson: text("condition_json"), // nullable in this intermediate step — see Task 2 Step 3
  durationSeconds: integer("duration_seconds").notNull(),
  webhookJson: text("webhook_json").notNull(),
  resolvedWebhookJson: text("resolved_webhook_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});
```

This intermediate (nullable, alongside the old columns) step exists specifically so `drizzle-kit generate` treats it as a pure column addition rather than an ambiguous rename — verified during planning: generating the final state (drop 3 columns + add 1 NOT NULL column) in one shot triggers an interactive "did you rename X to Y" prompt that hangs in a non-interactive shell. Splitting into two generates (add-nullable, then drop-old-and-tighten) avoids the prompt entirely.

- [ ] **Step 2: Generate migration 1 (add-only)**

Run: `cd packages/engine && bunx drizzle-kit generate`
Expected: Succeeds non-interactively, printing `Your SQL migration file ➜ drizzle/00XX_<name>.sql`. Verify the generated SQL is exactly `ALTER TABLE `latches` ADD `condition_json` text;` (no other changes).

- [ ] **Step 3: Edit `packages/engine/src/schema.ts` again — drop the old columns, make `condition_json` required**

```ts
export const latches = sqliteTable("latches", {
  id: text("id").primaryKey(),
  sensorId: text("sensor_id").notNull(),
  metric: text("metric").notNull(),
  conditionJson: text("condition_json").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  webhookJson: text("webhook_json").notNull(),
  resolvedWebhookJson: text("resolved_webhook_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});
```

- [ ] **Step 4: Generate migration 2 (drop + tighten)**

Run: `cd packages/engine && bunx drizzle-kit generate`
Expected: Succeeds non-interactively (verified during planning — this specific two-step split does not trigger the rename prompt). Produces a migration that rebuilds the `latches` table (SQLite's standard pattern for dropping columns: create `__new_latches`, copy rows, drop old, rename) — safe here since the table has zero rows on this deployment.

- [ ] **Step 5: Update `packages/engine/src/config.ts`**

In `latchFromRow`, replace:

```ts
    direction: row.direction as Latch["direction"],
    armThreshold: row.armThreshold,
    clearThreshold: row.clearThreshold,
```

with:

```ts
    condition: JSON.parse(row.conditionJson),
```

In `upsertLatch`, both the `.values({...})` and `.onConflictDoUpdate({ set: {...} })` blocks replace:

```ts
        direction: latch.direction,
        armThreshold: latch.armThreshold,
        clearThreshold: latch.clearThreshold,
```

with:

```ts
        conditionJson: JSON.stringify(latch.condition),
```

(in both places — the `.values()` insert block and the `.onConflictDoUpdate().set()` update block).

- [ ] **Step 6: Update the fixture in `packages/engine/test/config.test.ts`**

In the `"latches and sensors round-trip through upsert"` test, replace:

```ts
    store.upsertLatch({
      id: "freezer-temp",
      sensorId: "sensor-1",
      metric: "temperature",
      direction: "above",
      armThreshold: 55,
      clearThreshold: 38,
      durationSeconds: 600,
      webhook: { url: "https://example.invalid/webhook", method: "POST" },
      enabled: true,
    });
```

with:

```ts
    store.upsertLatch({
      id: "freezer-temp",
      sensorId: "sensor-1",
      metric: "temperature",
      condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
      durationSeconds: 600,
      webhook: { url: "https://example.invalid/webhook", method: "POST" },
      enabled: true,
    });
```

And the existing assertion `expect(store.listLatches()[0]?.clearThreshold).toBe(38);` becomes:

```ts
    const condition = store.listLatches()[0]?.condition;
    expect(condition?.type).toBe("above");
    expect(condition?.type === "above" && condition.hysteresis.clearThreshold).toBe(38);
```

- [ ] **Step 7: Run the config tests**

Run: `bun test packages/engine/test/config.test.ts`
Expected: PASS (2 tests). Note: `ConfigStore`'s test helper (`createTestDb`) builds an in-memory db and runs migrations on it (confirm by reading `packages/engine/src/db.ts`'s `createTestDb` before this step — if it doesn't auto-apply migrations, this step will fail with "no such column: condition_json" and you'll need to check how the existing tests already handle schema application before proceeding).

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/schema.ts packages/engine/src/config.ts packages/engine/test/config.test.ts packages/engine/drizzle
git commit -m "$(cat <<'EOF'
Store rule conditions as one JSON column instead of three flat ones

latches.direction/arm_threshold/clear_threshold -> condition_json,
mirroring how webhook_json is already stored. Two-step migration (add
nullable column, then drop old + tighten) to avoid drizzle-kit's
interactive rename prompt — no existing rows to migrate on this
deployment.
EOF
)"
```

---

## Task 3: State machine

**Files:**
- Modify: `packages/engine/src/stateMachine.ts`
- Modify: `packages/engine/test/stateMachine.test.ts`

**Interfaces:**
- Consumes: `isConditionMet`, `isConditionRecovered` from Task 1; `Latch.condition` shape from Task 1/2.
- Produces: `applyReading`/`initialState` signatures unchanged — `packages/engine/src/singleton.ts` (`ingest()`) calls these already and needs no changes.

- [ ] **Step 1: Update `packages/engine/test/stateMachine.test.ts` fixture**

Replace the `freezerLatch` fixture:

```ts
const freezerLatch: Latch = {
  id: "freezer-temp",
  sensorId: "sensor-1",
  metric: "temperature",
  direction: "above",
  armThreshold: 55,
  clearThreshold: 38,
  durationSeconds: 600,
  webhook: { url: "https://example.invalid/webhook/fired", method: "POST" },
  resolvedWebhook: { url: "https://example.invalid/webhook/resolved", method: "POST" },
  enabled: true,
};
```

with:

```ts
const freezerLatch: Latch = {
  id: "freezer-temp",
  sensorId: "sensor-1",
  metric: "temperature",
  condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
  durationSeconds: 600,
  webhook: { url: "https://example.invalid/webhook/fired", method: "POST" },
  resolvedWebhook: { url: "https://example.invalid/webhook/resolved", method: "POST" },
  enabled: true,
};
```

The five existing tests (arms/clears/fires/resolved/never-resolves) need no other changes — they only ever read `transition.type`/`next.state`, never `latch.armThreshold` directly.

- [ ] **Step 2: Append `between`-mode test cases to the same file**

Add before the closing of the `describe("latch state machine", ...)` block:

```ts
const rangeLatch: Latch = {
  id: "freezer-range",
  sensorId: "sensor-1",
  metric: "temperature",
  condition: {
    type: "between",
    low: 40,
    high: 55,
    hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
  },
  durationSeconds: 3600,
  webhook: { url: "https://example.invalid/webhook/fired", method: "POST" },
  resolvedWebhook: { url: "https://example.invalid/webhook/resolved", method: "POST" },
  enabled: true,
};

describe("latch state machine — between (range) condition", () => {
  test("arms when the value enters the range", () => {
    const start = initialState(rangeLatch.id, 0);
    const { next, transition } = applyReading(rangeLatch, start, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 45,
      timestamp: 1000,
    });

    expect(transition.type).toBe("armed");
    expect(next.state).toBe("armed");
  });

  test("clears before duration elapses if it exits the manual clear bounds — no webhook fires", () => {
    const armed = { ...initialState(rangeLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { next, transition } = applyReading(rangeLatch, armed, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 34, // below clearLow of 35
      timestamp: 1000 + 60_000, // well under the 3600s duration
    });

    expect(transition.type).toBe("cleared-before-fire");
    expect(next.state).toBe("idle");
  });

  test("stays armed while inside the manual clear bounds but outside [low, high] — no premature clear", () => {
    const armed = { ...initialState(rangeLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { transition } = applyReading(rangeLatch, armed, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 37, // outside [40,55] but inside the [35,60] clear bounds
      timestamp: 1000 + 60_000,
    });

    expect(transition.type).toBe("none");
  });

  test("fires after duration elapses without recovering", () => {
    const armed = { ...initialState(rangeLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { next, transition } = applyReading(rangeLatch, armed, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 45, // still inside the range, never recovered
      timestamp: 1000 + rangeLatch.durationSeconds * 1000,
    });

    expect(transition.type).toBe("fired");
    expect(next.state).toBe("fired");
  });

  test("resolved webhook only fires after the fired webhook fired", () => {
    const fired = {
      ...initialState(rangeLatch.id, 0),
      state: "fired" as const,
      armedAt: 1000,
      firedAt: 1000 + rangeLatch.durationSeconds * 1000,
    };
    const { next, transition } = applyReading(rangeLatch, fired, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 34, // outside the clear bounds
      timestamp: fired.firedAt! + 1000,
    });

    expect(transition.type).toBe("resolved");
    expect(next.state).toBe("idle");
  });

  test("auto hysteresis: recovers only once outside the range plus its percent margin", () => {
    const autoLatch: Latch = {
      ...rangeLatch,
      id: "freezer-range-auto",
      condition: { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 10 } },
    };
    const armed = { ...initialState(autoLatch.id, 0), state: "armed" as const, armedAt: 1000 };

    const stillArmed = applyReading(autoLatch, armed, {
      sensorId: autoLatch.sensorId,
      metric: autoLatch.metric,
      value: 39, // outside [40,55] but within the 1.5-wide auto margin (>= 38.5)
      timestamp: 1000 + 60_000,
    });
    expect(stillArmed.transition.type).toBe("none");

    const cleared = applyReading(autoLatch, armed, {
      sensorId: autoLatch.sensorId,
      metric: autoLatch.metric,
      value: 38, // below 38.5, past the auto margin
      timestamp: 1000 + 60_000,
    });
    expect(cleared.transition.type).toBe("cleared-before-fire");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/engine/test/stateMachine.test.ts`
Expected: FAIL — `stateMachine.ts` still reads `latch.direction`/`armThreshold`/`clearThreshold`, which no longer exist on `Latch` (TypeScript compile error surfaced via Bun's transpiler, or a runtime `undefined` comparison failure).

- [ ] **Step 4: Update `packages/engine/src/stateMachine.ts`**

Replace the local `isBad`/`isRecovered` functions and their two call sites:

```ts
import type { Latch, LatchState, LatchStateRecord, Reading } from "@unifi-sensor-latch/shared";
import { isConditionMet, isConditionRecovered } from "@unifi-sensor-latch/shared";
```

Delete:

```ts
function isBad(latch: Latch, value: number): boolean {
  return latch.direction === "above" ? value > latch.armThreshold : value < latch.armThreshold;
}

function isRecovered(latch: Latch, value: number): boolean {
  return latch.direction === "above" ? value <= latch.clearThreshold : value >= latch.clearThreshold;
}
```

Then replace the two call sites:
- `if (isBad(latch, value)) {` → `if (isConditionMet(latch.condition, value)) {`
- both `if (isRecovered(latch, value)) {` occurrences (in the `"armed"` and `"fired"` cases) → `if (isConditionRecovered(latch.condition, value)) {`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/engine/test/stateMachine.test.ts`
Expected: PASS, all 11 tests (5 existing + 6 new).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/stateMachine.ts packages/engine/test/stateMachine.test.ts
git commit -m "$(cat <<'EOF'
State machine: delegate arm/clear checks to the shared condition module

Adds the required "between" (range) coverage per CLAUDE.md's correctness
priorities: arms on entry, clears before firing (manual and auto
hysteresis), fires after sustained duration, resolved only after fired.
EOF
)"
```

---

## Task 4: Webhook dispatcher template

**Files:**
- Modify: `packages/engine/src/webhookDispatcher.ts`
- Modify: `packages/engine/test/webhookDispatcher.test.ts`

**Interfaces:**
- Consumes: `conditionThresholdTemplateValue` from Task 1.
- Produces: `dispatchWebhook` signature unchanged — `singleton.ts`'s two call sites need no changes.

- [ ] **Step 1: Update the fixture in `packages/engine/test/webhookDispatcher.test.ts`**

Replace:

```ts
const latch: Latch = {
  id: "freezer-temp",
  sensorId: "sensor-1",
  metric: "temperature",
  direction: "above",
  armThreshold: 55,
  clearThreshold: 38,
  durationSeconds: 600,
  webhook: { url: "https://example.invalid/webhook/fired?token=supersecret123", method: "POST" },
  enabled: true,
};
```

with:

```ts
const latch: Latch = {
  id: "freezer-temp",
  sensorId: "sensor-1",
  metric: "temperature",
  condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
  durationSeconds: 600,
  webhook: { url: "https://example.invalid/webhook/fired?token=supersecret123", method: "POST" },
  enabled: true,
};
```

No other changes needed in this file — the `"substitutes template variables into the POST body"` test's expected string (`"...threshold 55, armed 10m)"`) stays correct since `conditionThresholdTemplateValue` on an `above` condition returns the plain threshold number, same as before.

- [ ] **Step 2: Run the tests to verify the fixture-only change currently fails on the source side**

Run: `bun test packages/engine/test/webhookDispatcher.test.ts`
Expected: FAIL — `webhookDispatcher.ts`'s `renderTemplate` still reads `ctx.latch.armThreshold`, which doesn't exist.

- [ ] **Step 3: Update `packages/engine/src/webhookDispatcher.ts`**

```ts
import type { Latch, WebhookTarget } from "@unifi-sensor-latch/shared";
import { maskSecret, conditionThresholdTemplateValue } from "@unifi-sensor-latch/shared";
```

In `renderTemplate`, replace:

```ts
    .replaceAll("{{threshold}}", String(ctx.latch.armThreshold))
```

with:

```ts
    .replaceAll("{{threshold}}", conditionThresholdTemplateValue(ctx.latch.condition))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/engine/test/webhookDispatcher.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/webhookDispatcher.ts packages/engine/test/webhookDispatcher.test.ts
git commit -m "feat: webhook {{threshold}} template var uses the shared condition module"
```

---

## Task 5: API route validation

**Files:**
- Modify: `apps/web/app/api/latches/route.ts`
- Modify: `apps/web/app/api/latches/[id]/route.ts`

**Interfaces:**
- Consumes: `validateCondition` from Task 1.
- Produces: no new exports — this task only changes request-handling behavior (400 responses).

- [ ] **Step 1: Update `apps/web/app/api/latches/route.ts`**

Add the import:

```ts
import { intervalTooShortMessage, isDurationValid, maskSecret, validateCondition } from "@unifi-sensor-latch/shared";
```

In `POST`, replace the existing TODO comment and add the validation call right after parsing the body, before the duration check:

```ts
  const latch = (await req.json()) as Latch;

  const conditionCheck = validateCondition(latch.condition);
  if (!conditionCheck.valid) {
    return NextResponse.json({ error: conditionCheck.error }, { status: 400 });
  }

  const engine = getEngine();
```

(This replaces the old `// TODO: validate shape...` comment line and the `const engine = getEngine();` line that followed it — same net position, condition validation now sits where the TODO used to be.)

- [ ] **Step 2: Update `apps/web/app/api/latches/[id]/route.ts`**

Add the same import:

```ts
import { intervalTooShortMessage, isDurationValid, maskSecret, validateCondition } from "@unifi-sensor-latch/shared";
```

In `PATCH`, after `const updated: Latch = { ...existing, ...patch, id };`, add — mirroring the existing "only re-check what changed" pattern used for the duration/interval check just below it:

```ts
  if (patch.condition !== undefined) {
    const conditionCheck = validateCondition(updated.condition);
    if (!conditionCheck.valid) {
      return NextResponse.json({ error: conditionCheck.error }, { status: 400 });
    }
  }
```

- [ ] **Step 3: Manual verification (no route-level test suite exists in this repo — routes are exercised via the UI in Task 6)**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: these two files no longer error (though other files, e.g. `rules/page.tsx`, still do until Task 6).

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/latches/route.ts apps/web/app/api/latches/\[id\]/route.ts
git commit -m "$(cat <<'EOF'
Validate rule conditions server-side (CLAUDE.md trust boundaries)

POST/PATCH /api/latches now reject invalid conditions (between low>=high,
non-positive auto margin) via the shared validateCondition — closes the
route's pre-existing "TODO: validate shape" gap for the condition field
specifically.
EOF
)"
```

---

## Task 6: Rules page + Dashboard UI

**Files:**
- Modify: `apps/web/app/rules/page.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `RuleCondition`, `conditionSummary`, `validateCondition` from Task 1; `Latch` shape from Task 1/2; existing `DURATION_PRESETS`, `effectiveInterval`, `isDurationValid` (unchanged, from `interval.ts`).
- Produces: nothing consumed elsewhere — this is the leaf of the dependency chain.

- [ ] **Step 1: Update `apps/web/app/page.tsx` (Dashboard) — one-line swap**

Add the import:

```ts
import { conditionSummary } from "@unifi-sensor-latch/shared";
```

Replace:

```tsx
                  {rule.metric} {rule.direction} {rule.armThreshold}
```

with:

```tsx
                  {rule.metric} {conditionSummary(rule.condition)}
```

- [ ] **Step 2: Rewrite the form state and submit logic in `apps/web/app/rules/page.tsx`**

Replace the `emptyForm` object and its type annotations:

```ts
type ConditionType = "above" | "below" | "between";
type HysteresisMode = "manual" | "auto";

const emptyForm = {
  sensorId: "",
  metric: "" as Sensor["metrics"][number] | "",
  conditionType: "above" as ConditionType,
  threshold: "", // above/below
  low: "", // between
  high: "", // between
  hysteresisMode: "manual" as HysteresisMode, // between only — above/below is always manual
  clearThreshold: "", // above/below manual clear (optional, defaults to threshold)
  clearLow: "", // between manual
  clearHigh: "", // between manual
  marginPercent: "", // between auto
  durationSeconds: "" as number | "",
  webhookUrl: "",
  webhookMethod: "POST" as Latch["webhook"]["method"],
  resolvedWebhookUrl: "",
};
```

Replace the `createRule` function's condition-building logic — everything from `const armThreshold = ...` through `const rule: Latch = {...}` — with:

```ts
  function buildCondition(): RuleCondition {
    if (form.conditionType === "between") {
      const low = Number(form.low);
      const high = Number(form.high);
      if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error("low and high bounds must be numbers");

      const hysteresis: RangeHysteresis =
        form.hysteresisMode === "auto"
          ? { mode: "auto", marginPercent: Number(form.marginPercent) }
          : {
              mode: "manual",
              clearLow: form.clearLow ? Number(form.clearLow) : low,
              clearHigh: form.clearHigh ? Number(form.clearHigh) : high,
            };
      return { type: "between", low, high, hysteresis };
    }

    const threshold = Number(form.threshold);
    if (!Number.isFinite(threshold)) throw new Error("threshold must be a number");
    const clearThreshold = form.clearThreshold ? Number(form.clearThreshold) : threshold;
    return { type: form.conditionType, threshold, hysteresis: { mode: "manual", clearThreshold } };
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (!form.sensorId || !form.metric) throw new Error("sensor and metric are required");
      if (form.durationSeconds === "") throw new Error("duration is required");
      const durationSeconds = form.durationSeconds;

      const condition = buildCondition();
      const conditionCheck = validateCondition(condition);
      if (!conditionCheck.valid) throw new Error(conditionCheck.error);

      if (selectedInterval && !isDurationValid(durationSeconds, selectedInterval)) {
        throw new Error("selected duration is too short for this sensor's reporting interval");
      }

      const rule: Latch = {
        id: crypto.randomUUID(),
        sensorId: form.sensorId,
        metric: form.metric as Sensor["metrics"][number],
        condition,
        durationSeconds,
        webhook: { url: form.webhookUrl, method: form.webhookMethod },
        resolvedWebhook: form.resolvedWebhookUrl
          ? { url: form.resolvedWebhookUrl, method: form.webhookMethod }
          : undefined,
        enabled: true,
      };

      const res = await fetch("/api/latches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create rule");

      setForm(emptyForm);
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }
```

Add the needed imports at the top of the file:

```ts
import type { Latch, ProtectConsole, RangeHysteresis, RuleCondition, Sensor, SensorStatus } from "@unifi-sensor-latch/shared";
import { DURATION_PRESETS, conditionSummary, effectiveInterval, isDurationValid, validateCondition } from "@unifi-sensor-latch/shared";
```

(replacing the existing two `import type`/`import` lines for these two modules).

- [ ] **Step 3: Replace the "Direction"/threshold form fields with condition-driven fields**

Replace the entire block from `<div className="grid grid-cols-2 gap-3">` (the Direction/Duration/Arm threshold/Clear threshold grid) through its closing `</div>` with:

```tsx
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Condition</label>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    value={form.conditionType}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        conditionType: e.target.value as ConditionType,
                        hysteresisMode: "manual",
                      })
                    }
                  >
                    <option value="above">is above</option>
                    <option value="below">is below</option>
                    <option value="between">is between</option>
                  </select>
                </div>

                {form.conditionType === "between" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-muted-foreground">Low bound</label>
                      <Input
                        type="number"
                        value={form.low}
                        onChange={(e) => setForm({ ...form, low: e.target.value })}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-muted-foreground">High bound</label>
                      <Input
                        type="number"
                        value={form.high}
                        onChange={(e) => setForm({ ...form, high: e.target.value })}
                        required
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Threshold</label>
                    <Input
                      type="number"
                      value={form.threshold}
                      onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                      required
                    />
                  </div>
                )}

                {form.conditionType === "between" ? (
                  <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <label className="text-xs text-muted-foreground">
                      Hysteresis (how far it must move back inside/outside before this can re-arm)
                    </label>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={form.hysteresisMode === "manual" ? "default" : "outline"}
                        onClick={() => setForm({ ...form, hysteresisMode: "manual" })}
                      >
                        Manual
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={form.hysteresisMode === "auto" ? "default" : "outline"}
                        onClick={() => setForm({ ...form, hysteresisMode: "auto" })}
                      >
                        Auto
                      </Button>
                    </div>
                    {form.hysteresisMode === "manual" ? (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-muted-foreground">Clear below</label>
                          <Input
                            type="number"
                            value={form.clearLow}
                            onChange={(e) => setForm({ ...form, clearLow: e.target.value })}
                            placeholder="defaults to low bound"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-muted-foreground">Clear above</label>
                          <Input
                            type="number"
                            value={form.clearHigh}
                            onChange={(e) => setForm({ ...form, clearHigh: e.target.value })}
                            placeholder="defaults to high bound"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">
                          Margin — percent of the range's width added outside both bounds before it counts as
                          cleared
                        </label>
                        <Input
                          type="number"
                          value={form.marginPercent}
                          onChange={(e) => setForm({ ...form, marginPercent: e.target.value })}
                          placeholder="e.g. 5"
                          required
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Clear threshold (optional)</label>
                    <Input
                      type="number"
                      value={form.clearThreshold}
                      onChange={(e) => setForm({ ...form, clearThreshold: e.target.value })}
                      placeholder="defaults to threshold — set this to add hysteresis"
                    />
                  </div>
                )}

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">
                    Duration (armed for at least this long before firing)
                  </label>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    value={form.durationSeconds}
                    onChange={(e) => setForm({ ...form, durationSeconds: Number(e.target.value) })}
                    required
                  >
                    <option value="" disabled>
                      Select a duration
                    </option>
                    {DURATION_PRESETS.map((p) => {
                      const tooShort = selectedInterval ? p.seconds < selectedInterval.seconds : false;
                      return (
                        <option key={p.seconds} value={p.seconds} disabled={tooShort}>
                          {p.label}
                          {tooShort ? " (too short for this sensor)" : ""}
                        </option>
                      );
                    })}
                  </select>
                  {selectedInterval && (
                    <p className="text-xs text-muted-foreground">
                      This sensor's effective reporting interval is ~{selectedInterval.seconds}s (
                      {selectedInterval.source.replace("-", " ")}) — durations shorter than that are disabled
                      above.
                    </p>
                  )}
                </div>
```

Note: `Button` is already imported at the top of this file (used for the dialog trigger and table row actions) — no new import needed for the Manual/Auto toggle.

- [ ] **Step 4: Update the rules table's "Threshold" column**

Replace the table header:

```tsx
              <TableHead>Threshold</TableHead>
```

with:

```tsx
              <TableHead>Condition</TableHead>
```

Replace the table cell:

```tsx
                <TableCell>
                  {rule.direction} {rule.armThreshold}
                </TableCell>
```

with:

```tsx
                <TableCell>{conditionSummary(rule.condition)}</TableCell>
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: clean (no output) — this is the last file with lingering references to the old shape, so this should now be the point where the whole `apps/web` package typechecks.

- [ ] **Step 6: Manual smoke test**

The user's own dev server is already running against this codebase and will hot-reload — ask the user to verify in-browser rather than starting a second dev server instance (per this project's established practice — running a second `bun run dev` in the same directory has previously corrupted the shared `.next` cache). Specifically confirm:
- Creating an "above" rule (e.g. lux above 500) still works and shows correctly in the table/dashboard.
- Creating a "between" rule with manual hysteresis (e.g. temp between 40–55, clear below 35 / clear above 60) works.
- Creating a "between" rule with auto hysteresis (e.g. temp between 40–55, margin 5%) works.
- Switching the Condition dropdown swaps the value field(s) and the hysteresis section correctly without stale values leaking through (e.g. switching from "between" back to "above" doesn't submit a leftover `low`/`high`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/rules/page.tsx apps/web/app/page.tsx
git commit -m "$(cat <<'EOF'
Rules page: condition-driven form (above/below/between + hysteresis)

Replaces the "Direction" dropdown + arm/clear threshold pair with a
Condition dropdown whose value field(s) and hysteresis controls adapt to
the selected type — a plain-language "when X is above/below/between Y
for at least Z" instead of unexplained threshold pairs. Dashboard and the
Rules table both render the new plain-language conditionSummary.
EOF
)"
```

---

## Task 7: Full-repo verification

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: clean, no output.

- [ ] **Step 2: Full test suite**

Run: `cd /Users/mckrueg/Programming/UnifiSensorLatch && bun test`
Expected: all tests pass (37 previously + ~17 new from Tasks 1 and 3 — condition.test.ts's ~13 cases and stateMachine.test.ts's 6 new `between` cases, exact count will be visible in the run output).

- [ ] **Step 3: Grep for any remaining stale references**

Run: `grep -rln "\.direction\b\|armThreshold\|clearThreshold" apps/web/app packages --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | grep -v .next`

Expected: no output. `clearThreshold`/`clearLow`/`clearHigh` as *object field names inside* `ManualHysteresis`/`RangeHysteresis` are fine and expected to still appear (e.g. in `condition.ts` itself, the Rules page form) — this grep is checking for the old flat `Latch.armThreshold`/`Latch.clearThreshold`/`Latch.direction` access pattern specifically, so skim any hits rather than treating a nonzero result as automatically wrong.

- [ ] **Step 4: No commit needed** — this task is verification only; if any step fails, fix the specific file and amend the relevant earlier task's commit is NOT appropriate (CLAUDE.md/global git guidance: prefer new commits) — instead make a new small fix commit describing what was missed.
