# Rule conditions redesign

**Date:** 2026-08-10
**Status:** Approved

## Problem

The Rules page's condition model — `direction: "above" | "below"` plus an
`armThreshold`/`clearThreshold` pair labeled just "Direction" — doesn't
express what people actually want to alert on, and doesn't say it
clearly even for what it does express:

- No way to say "alarm if the value stays *inside* a range for a
  sustained period" (e.g. temperature between 40–55°F — the range where
  food safety is actually at risk, as opposed to a single one-sided
  threshold).
- "Clear threshold (optional)" gives no indication of what it means or
  why you'd set it away from the arm threshold (hysteresis, to avoid
  re-arming right at the edge from sensor noise / a door that's opened
  and closed within a minute).

Real examples this needs to express cleanly:
- Fridge door open for 1 minute → temp briefly spikes to 55°F → not an
  alarm (transient, recovers before duration elapses).
- Fridge temp above 40°F for more than an hour → alarm, fire webhook.
- A light on for more than 10 minutes → alarm, fire webhook.

## Condition model

Each rule's `direction`/`armThreshold`/`clearThreshold` triplet is
replaced by:

- `conditionType: "above" | "below" | "between"`
- `above` / `below`: single `threshold` (same behavior as today, just
  renamed/clarified)
- `between`: `low` and `high` — arms when the value is inside
  `[low, high]` continuously for the full duration

## Hysteresis

A per-rule choice of how far the value has to move back before a fresh
arm/fire cycle is possible again:

- **Manual** — the exact clear point(s), typed directly:
  - above/below: one `clearThreshold`
  - between: `clearLow` / `clearHigh` (must fall outside these to clear)
- **Auto** (`between` only) — a `marginPercent` of the range width,
  applied outward on both sides. Range `30–40` with `marginPercent: 5` →
  must drop below `29.5` or rise above `40.5` to clear. Always
  well-defined since a range always has positive width.
  - **Not offered for above/below.** Percent-of-threshold is undefined
    at threshold `0` and behaves inconsistently in sign near zero — and
    a freezer alert crossing 0°C is exactly the scenario this app
    exists for. above/below stay manual-only; it's already a single
    number, so auto-margin wouldn't save much typing there anyway.

## Storage

`latches.direction` / `armThreshold` / `clearThreshold` columns are
replaced by a single `condition_json` TEXT column, mirroring how
`webhook`/`resolvedWebhook` are already stored as JSON — avoids a pile
of columns that are null for whichever mode isn't in use. No existing
rules are configured on this deployment yet, so this is a clean column
swap, not a data migration.

Shape (exact TS types finalized in the implementation plan):

```ts
type RuleCondition =
  | { type: "above"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "below"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "between"; low: number; high: number; hysteresis: RangeHysteresis };

type ManualHysteresis = { mode: "manual"; clearThreshold: number };

type RangeHysteresis =
  | { mode: "manual"; clearLow: number; clearHigh: number }
  | { mode: "auto"; marginPercent: number };
```

## Engine

`stateMachine.ts`'s arm/clear predicates grow a `between` branch
alongside the existing above/below checks; duration timing and webhook
dispatch are unchanged — they only consume "is the condition currently
true," not which condition shape produced that boolean. Unit tests
(CLAUDE.md's required state-machine coverage) get `between`-mode cases
added alongside the existing above/below ones, covering: arms on
entering the range, clears before duration elapses (no webhook), fires
after duration elapses, and both manual and auto hysteresis clear
behavior.

## Validation

Same server-side hard-block rule as today (SPEC.md §4a) — duration must
be ≥ the sensor's effective interval — now checked regardless of
`conditionType`. New validation: `between` requires `low < high`; auto
hysteresis requires `0 < marginPercent`.

## UI

The Rules dialog becomes condition-driven: "when `[metric]` is
`[above/below/between]` `[value(s)]` for at least `[duration]`," with
the value field(s) swapping based on `conditionType` (one number for
above/below, two for between), and — for `between` only — a
[Manual/Auto] hysteresis toggle revealing either the clear-bounds fields
or the margin-percent field. The rules table's "Threshold" column
becomes a plain-language condition summary (e.g. "between 40°F and
55°F, ±5% auto" / "above 500 lux") instead of "direction + number."

## Non-goals

- No change to webhook dispatch, resolved-webhook semantics, or the
  duration-preset validation mechanism itself — only what feeds into
  the arm/clear check changes.
- No auto-hysteresis for above/below (see above) — revisit only if a
  concrete need for it comes up (e.g. an absolute-step auto mode).
