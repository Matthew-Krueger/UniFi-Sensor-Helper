// Diagnostic: dumps every individual armed/fired span for a latch, plus the
// running per-window totals, so an "abnormally high" stats number can be
// traced back to the actual events producing it instead of trusted blind.
//
// Usage: bun scripts/debug-latch-spans.ts <latchId> [databasePath]

import { Database } from "bun:sqlite";
import { computeLatchStats } from "../packages/engine/src/latchStats";
import type { LatchTransitionRecord, LatchStateRecord } from "@unifi-sensor-latch/shared";

const [latchId, dbPathArg] = process.argv.slice(2);
if (!latchId) {
  console.error("Usage: bun scripts/debug-latch-spans.ts <latchId> [databasePath]");
  process.exit(1);
}

const dbPath = dbPathArg ?? process.env.DATABASE_PATH ?? "./data/app.db";
const db = new Database(dbPath, { readonly: true });

const events = db
  .query("SELECT id, latch_id as latchId, type, timestamp FROM latch_transitions WHERE latch_id = ? ORDER BY timestamp")
  .all(latchId) as LatchTransitionRecord[];

const stateRow = db
  .query("SELECT latch_id as latchId, state, armed_at as armedAt, fired_at as firedAt, updated_at as updatedAt FROM latch_state WHERE latch_id = ?")
  .get(latchId) as LatchStateRecord | null;

console.log(`Loaded ${events.length} transition events for latch ${latchId}`);
console.log("Live state:", stateRow);
console.log("");

console.log("Raw event log:");
for (const e of events) {
  console.log(`  ${new Date(e.timestamp).toISOString()}  ${e.type}`);
}
console.log("");

// Re-derive the same spans buildSpans() would, but print each one instead of
// just summing, so flapping (many short spans) is visible vs one long one.
let openState: "armed" | "fired" | null = null;
let openStart = 0;
const now = Date.now();
const spans: { state: string; start: number; end: number; seconds: number }[] = [];

for (const event of events) {
  if (event.type === "armed") {
    openState = "armed";
    openStart = event.timestamp;
  } else if (event.type === "fired") {
    if (openState === "armed") {
      spans.push({ state: "armed", start: openStart, end: event.timestamp, seconds: (event.timestamp - openStart) / 1000 });
    }
    openState = "fired";
    openStart = event.timestamp;
  } else {
    if (openState) {
      spans.push({ state: openState, start: openStart, end: event.timestamp, seconds: (event.timestamp - openStart) / 1000 });
    }
    openState = null;
  }
}
if (openState && stateRow && stateRow.state !== "idle") {
  spans.push({ state: openState, start: openStart, end: now, seconds: (now - openStart) / 1000 });
}

console.log(`Derived ${spans.length} span(s):`);
for (const s of spans) {
  console.log(
    `  [${s.state.padEnd(5)}] ${new Date(s.start).toISOString()} -> ${new Date(s.end).toISOString()}  (${(s.seconds / 60).toFixed(1)} min)`
  );
}
console.log("");

const stats = computeLatchStats(events, stateRow, now);
console.log("computeLatchStats output:", JSON.stringify(stats, null, 2));
