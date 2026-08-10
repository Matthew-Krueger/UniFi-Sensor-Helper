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
  sensorId: text("sensor_id").notNull(),
  metric: text("metric").notNull(),
  direction: text("direction").notNull(), // "above" | "below"
  armThreshold: real("arm_threshold").notNull(),
  clearThreshold: real("clear_threshold").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  webhookJson: text("webhook_json").notNull(),
  resolvedWebhookJson: text("resolved_webhook_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
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
  createdAt: integer("created_at").notNull(),
});
