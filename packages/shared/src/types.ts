import type { RuleCondition } from "./condition";

// Domain model — SPEC.md section 4. Exact Metric enum finalized during API
// discovery (SPEC.md section 8); this is a starting point, not final.
export type Metric = "lux" | "temperature" | "humidity" | "leak";

export interface Sensor {
  id: string; // Protect device id
  consoleId: string; // which ProtectConsole this sensor was discovered on
  name: string; // friendly name, editable in UI
  metrics: Metric[]; // discovered from the API
}

// A UniFi Protect console this deployment talks to. Stored in SQLite, not
// .env — unlike a single fixed operator credential, this is genuinely
// user-editable (a site can add/remove/repoint consoles through the UI,
// e.g. standing up a second deployment per SPEC.md section 12). apiKey is
// a real credential (unlike a webhook URL, which is only masked from the
// read-only "user" role — see CLAUDE.md's obfuscation rule): mask it
// everywhere it's read back, for every role.
export interface ProtectConsole {
  id: string;
  name: string; // friendly label, e.g. "Main site NVR"
  host: string; // LAN IP or hostname
  apiKey: string;
  // Default expected reporting interval (seconds) for sensors on this
  // console with no per-sensor override and no observed data yet. See
  // packages/shared/src/interval.ts.
  defaultIntervalSeconds: number;
  createdAt: number;
}

export interface WebhookTarget {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  bodyTemplate?: string; // {{sensorName}}, {{metric}}, {{value}}, {{threshold}}, {{durationMinutes}}
}

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

// A single webhook delivery attempt, recorded for the Rules page's "last
// used" / "inspect the response" UI (only admin/superadmin can view these
// — see CLAUDE.md's webhook-URL visibility rule). "test" is a manually
// triggered send (Rules page's Test button), not a real alarm — kept
// distinct so it's never confused with an actual fire/resolve event.
export interface WebhookDelivery {
  id: string;
  latchId: string;
  kind: "fired" | "resolved" | "test";
  url: string;
  method: "GET" | "POST";
  ok: boolean;
  status: number | null;
  error: string | null;
  responseBodySnippet: string | null; // capped length — see webhookDispatcher.ts
  attempts: number;
  dispatchedAt: number;
}

export type LatchState = "idle" | "armed" | "fired";

export interface LatchStateRecord {
  latchId: string;
  state: LatchState;
  armedAt: number | null;
  firedAt: number | null;
  updatedAt: number;
}

export interface Reading {
  sensorId: string;
  metric: Metric;
  value: number;
  timestamp: number;
}

// In-memory only (not persisted — resets on restart, which is fine for a
// "is it alive right now" indicator). The Protect integration API doesn't
// expose CPU/memory/storage for the console itself (checked against the
// live OpenAPI spec — GET /v1/nvrs has no such fields), so this sticks to
// what's actually measurable: our own connection state, a real round-trip
// latency sample, and counts/timestamps derived from ingest.
// One entry per phase of connectConsole (probe, discover, subscribe) —
// gives the UI an actual trace of what's happening rather than a single
// opaque "connecting" spinner. Capped to the most recent N (see
// singleton.ts) so repeated reconnect attempts don't grow this forever.
export interface ConsoleStatusStep {
  label: string;
  at: number;
  ok: boolean;
}

export interface ConsoleStatus {
  consoleId: string;
  connectionState: "connecting" | "connected" | "disconnected" | "error";
  applicationVersion: string | null; // Protect firmware version, from /v1/meta/info
  latencyMs: number | null; // round-trip time of the last connectivity check
  lastEventAt: number | null; // last time any sensor reading arrived from this console
  sensorCount: number;
  error: string | null;
  steps: ConsoleStatusStep[];
}

export interface SensorStatus {
  sensorId: string;
  lastSeenAt: number | null;
  values: Partial<Record<Metric, number>>;
  // Rolling-average gap (seconds) between successive readings of each
  // metric, measured from real timestamps — not configuration, ground
  // truth. Present once we've seen ≥2 readings for that metric. See
  // singleton.ts's ingest() for how it's computed and interval.ts for how
  // it's used (takes priority over the console default).
  observedIntervalSeconds: Partial<Record<Metric, number>>;
}

// Three-tier role model (SPEC.md section 3):
//   "user"       — read-only: dashboard/sensors/latches views, no writes.
//   "admin"      — full operational access (sensors, latches, consoles,
//                  webhooks) and can create "user"/"admin" accounts, but
//                  cannot promote/demote anyone or create a superadmin.
//   "superadmin" — everything admin can do, plus promoting/demoting any
//                  account's role. The very first account ever created is
//                  always superadmin.
export type Role = "user" | "admin" | "superadmin";

export interface User {
  id: string;
  username: string;
  role: Role;
  // True for admin-created accounts (their password was randomly
  // generated, never admin-typed) and any account an admin has
  // invalidated or reset. Blocks everything except changing your own
  // password until cleared by a successful self-service password change.
  mustResetPassword: boolean;
  // Display-only preference (Celsius storage/evaluation is unaffected) —
  // see CLAUDE.md config-vs-secrets: this is user-editable UI state, so it
  // lives on the account row rather than anywhere else.
  temperatureUnit: "C" | "F";
  createdAt: number;
}

// Whether `actor` is allowed to assign `targetRole` when creating or
// promoting an account. Shared between the API routes (source of truth)
// and the UI (so it can grey out options a role can't grant, rather than
// only rejecting after a failed request).
export function canAssignRole(actor: Role, targetRole: Role): boolean {
  if (actor === "superadmin") return true;
  if (actor === "admin") return targetRole !== "superadmin";
  return false;
}
