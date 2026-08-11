import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// Drizzle schema — source of truth for the SQLite tables described in
// SPEC.md section 6. Run `bun run db:generate` after changing this file to
// produce a migration under packages/engine/drizzle/, then `bun run
// db:migrate` (or just restart the app — migrate.ts runs on boot) to apply
// it. Never hand-edit generated migration SQL.

export const sensors = sqliteTable("sensors", {
  id: text("id").primaryKey(), // Protect device id
  consoleId: text("console_id").notNull(),
  name: text("name").notNull(),
  discoveredMetrics: text("discovered_metrics").notNull().default("[]"), // JSON array of Metric
});

export const latches = sqliteTable("latches", {
  id: text("id").primaryKey(),
  name: text("name"), // operator-chosen label, optional — see shared/src/types.ts's Latch.name
  sensorId: text("sensor_id").notNull(),
  metric: text("metric").notNull(),
  conditionJson: text("condition_json").notNull(), // RuleCondition JSON — see shared/src/condition.ts
  durationSeconds: integer("duration_seconds").notNull(),
  webhookJson: text("webhook_json").notNull(),
  resolvedWebhookJson: text("resolved_webhook_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

// A short history of webhook delivery attempts per rule — "last used" and
// "inspect the last response" (Rules page) read from here. Pruned to the
// most recent MAX_DELIVERIES_PER_LATCH rows per latch on insert (see
// ConfigStore.recordWebhookDelivery) rather than via a scheduled job —
// CLAUDE.md says no external scheduler for periodic tasks, and pruning
// inline on write needs no scheduling at all.
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  latchId: text("latch_id").notNull(),
  kind: text("kind").notNull(), // "fired" | "resolved" | "test"
  url: text("url").notNull(),
  method: text("method").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  status: integer("status"),
  error: text("error"),
  responseBodySnippet: text("response_body_snippet"),
  attempts: integer("attempts").notNull(),
  dispatchedAt: integer("dispatched_at").notNull(),
});

export const latchState = sqliteTable("latch_state", {
  latchId: text("latch_id").primaryKey(),
  state: text("state").notNull().default("idle"), // "idle" | "armed" | "fired"
  armedAt: integer("armed_at"),
  firedAt: integer("fired_at"),
  updatedAt: integer("updated_at").notNull(),
});

// Three-tier role model (SPEC.md section 3): "user" is read-only, "admin"
// has full operational access and can create user/admin accounts but not
// promote anyone, "superadmin" can additionally promote/demote roles. The
// very first account ever created is always superadmin (see AuthStore /
// POST /api/users) — after that, account creation requires being logged in.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"), // "user" | "admin" | "superadmin"
  // True for every admin-created account (its password was never
  // admin-chosen — see AuthStore.createUserWithGeneratedPassword) and for
  // any account an admin has invalidated/reset. Blocks everything except
  // PATCH /api/account/password until cleared by a successful self-service
  // password change. False for the self-service bootstrap account, which
  // chose its own password.
  mustResetPassword: integer("must_reset_password", { mode: "boolean" }).notNull().default(false),
  // Per-user display preference only — never affects storage or the
  // engine (metric values are always stored/evaluated in Celsius; this is
  // a UI-layer conversion at render time).
  temperatureUnit: text("temperature_unit").notNull().default("C"), // "C" | "F"
  createdAt: integer("created_at").notNull(),
});

// Protect console connections — user-editable in the UI (a site can have
// more than one console), so host/apiKey live here, not in .env. apiKey is
// secret-bearing: mask it everywhere it's read back (CLAUDE.md obfuscation).
export const protectConsoles = sqliteTable("protect_consoles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  apiKey: text("api_key").notNull(),
  // Optional override for the base URL normally derived from `host` as
  // `https://{host}/proxy/protect/integration` (see protect.ts's baseUrl).
  // Exists for the rare case of talking to a console through something
  // other than a direct LAN path — e.g. UniFi's remote/cloud API base —
  // where the request needs to go somewhere other than the console's own
  // host. Null (the default) means "derive it from host" like today; most
  // deployments never need to touch this.
  apiBaseUrlOverride: text("api_base_url_override"),
  // Expected reporting interval (seconds) for sensors on this console —
  // also the cadence of the periodic re-poll (see singleton.ts's
  // connectConsole; sensors are always fetched in one bulk GET
  // /v1/sensors call per console, so this is console-level, not
  // per-sensor). Used as the fallback for rule-duration validation until
  // a sensor's real interval has been observed from actual reading gaps.
  defaultIntervalSeconds: integer("default_interval_seconds").notNull().default(300),
  // Default Alarm Manager webhook ID (SPEC.md section 7) — see
  // shared/src/types.ts's ProtectConsole.defaultWebhookId doc comment.
  defaultWebhookId: text("default_webhook_id"),
  createdAt: integer("created_at").notNull(),
});
