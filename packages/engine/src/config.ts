import { desc, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  Latch,
  LatchStateRecord,
  LatchTransitionRecord,
  ProtectConsole,
  Sensor,
  WebhookDelivery,
  WebhookTarget,
} from "@unifi-sensor-latch/shared";
import { getDb } from "./db";
import * as schema from "./schema";
import { latches, latchState, latchTransitions, protectConsoles, sensors, webhookDeliveries } from "./schema";

// Bounds webhook_deliveries growth per rule — pruned on every insert (see
// recordWebhookDelivery) rather than via a scheduled job, since pruning on
// write needs no scheduling at all (CLAUDE.md: no external scheduler for
// periodic tasks).
const MAX_DELIVERIES_PER_LATCH = 10;

// Thrown by ConfigStore.deleteProtectConsole when the console still has
// sensors attached — callers (the DELETE route) map this to a 409 rather
// than letting a raw SQLITE_CONSTRAINT error reach the client.
export class ConsoleHasSensorsError extends Error {
  constructor(public readonly consoleId: string) {
    super(`Console ${consoleId} still has sensors attached; remove them before deleting the console.`);
    this.name = "ConsoleHasSensorsError";
  }
}

// Typed read/write over the sensors / latches / latch_state /
// protect_consoles tables via Drizzle. Replaces the config.json read/write
// layer originally described in SPEC.md section 6.

function sensorFromRow(row: typeof schema.sensors.$inferSelect): Sensor {
  return { id: row.id, consoleId: row.consoleId, name: row.name, metrics: JSON.parse(row.discoveredMetrics) };
}

function consoleFromRow(row: typeof schema.protectConsoles.$inferSelect): ProtectConsole {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    apiKey: row.apiKey,
    apiBaseUrlOverride: row.apiBaseUrlOverride,
    defaultWebhookId: row.defaultWebhookId,
    downAlertEnabled: row.downAlertEnabled,
    downAlertDurationSeconds: row.downAlertDurationSeconds,
    downAlertWebhook: row.downAlertWebhookJson ? normalizeWebhookTarget(JSON.parse(row.downAlertWebhookJson)) : null,
    downAlertResolvedWebhook: row.downAlertResolvedWebhookJson
      ? normalizeWebhookTarget(JSON.parse(row.downAlertResolvedWebhookJson))
      : null,
    createdAt: row.createdAt,
  };
}

// WebhookTarget used to be a flat {url, method, headers?, bodyTemplate?}
// shape (pre-console-webhook redesign) with no `kind` discriminant. Any
// row written before that migration parses back with `kind` undefined —
// rather than crash on every downstream `target.kind === "..."` check,
// treat that shape as a legacy "custom" target (dropping the old
// free-form `headers`, which the new shape replaced with a single
// `bearerToken` — nothing ever used more than one header in practice).
function normalizeWebhookTarget(raw: unknown): WebhookTarget {
  const parsed = raw as Partial<WebhookTarget> & { url?: string; method?: "GET" | "POST" };
  if (parsed && (parsed as WebhookTarget).kind === undefined && typeof parsed.url === "string") {
    return { kind: "custom", url: parsed.url, method: parsed.method ?? "POST" };
  }
  return parsed as WebhookTarget;
}

function latchFromRow(row: typeof schema.latches.$inferSelect): Latch {
  return {
    id: row.id,
    name: row.name,
    sensorId: row.sensorId,
    metric: row.metric as Latch["metric"],
    condition: JSON.parse(row.conditionJson),
    durationSeconds: row.durationSeconds,
    webhook: normalizeWebhookTarget(JSON.parse(row.webhookJson)),
    resolvedWebhook: row.resolvedWebhookJson ? normalizeWebhookTarget(JSON.parse(row.resolvedWebhookJson)) : undefined,
    enabled: row.enabled,
  };
}

function deliveryFromRow(row: typeof schema.webhookDeliveries.$inferSelect): WebhookDelivery {
  return {
    id: row.id,
    latchId: row.latchId,
    kind: row.kind as WebhookDelivery["kind"],
    url: row.url,
    method: row.method as WebhookDelivery["method"],
    ok: row.ok,
    status: row.status,
    error: row.error,
    responseBodySnippet: row.responseBodySnippet,
    attempts: row.attempts,
    dispatchedAt: row.dispatchedAt,
  };
}

function stateFromRow(row: typeof schema.latchState.$inferSelect): LatchStateRecord {
  return {
    latchId: row.latchId,
    state: row.state as LatchStateRecord["state"],
    armedAt: row.armedAt,
    firedAt: row.firedAt,
    updatedAt: row.updatedAt,
  };
}

export class ConfigStore {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema> = getDb()) {}

  listSensors(): Sensor[] {
    return this.db.select().from(sensors).orderBy(sensors.name).all().map(sensorFromRow);
  }

  upsertSensor(sensor: Sensor): void {
    this.db
      .insert(sensors)
      .values({
        id: sensor.id,
        consoleId: sensor.consoleId,
        name: sensor.name,
        discoveredMetrics: JSON.stringify(sensor.metrics),
      })
      .onConflictDoUpdate({
        target: sensors.id,
        set: { consoleId: sensor.consoleId, name: sensor.name, discoveredMetrics: JSON.stringify(sensor.metrics) },
      })
      .run();
  }

  listProtectConsoles(): ProtectConsole[] {
    return this.db.select().from(protectConsoles).orderBy(protectConsoles.createdAt).all().map(consoleFromRow);
  }

  getProtectConsole(id: string): ProtectConsole | null {
    const row = this.db.select().from(protectConsoles).where(eq(protectConsoles.id, id)).get();
    return row ? consoleFromRow(row) : null;
  }

  upsertProtectConsole(console: ProtectConsole): void {
    this.db
      .insert(protectConsoles)
      .values({
        id: console.id,
        name: console.name,
        host: console.host,
        apiKey: console.apiKey,
        apiBaseUrlOverride: console.apiBaseUrlOverride,
        defaultWebhookId: console.defaultWebhookId,
        downAlertEnabled: console.downAlertEnabled,
        downAlertDurationSeconds: console.downAlertDurationSeconds,
        downAlertWebhookJson: console.downAlertWebhook ? JSON.stringify(console.downAlertWebhook) : null,
        downAlertResolvedWebhookJson: console.downAlertResolvedWebhook
          ? JSON.stringify(console.downAlertResolvedWebhook)
          : null,
        createdAt: console.createdAt,
      })
      .onConflictDoUpdate({
        target: protectConsoles.id,
        set: {
          name: console.name,
          host: console.host,
          apiKey: console.apiKey,
          apiBaseUrlOverride: console.apiBaseUrlOverride,
          defaultWebhookId: console.defaultWebhookId,
          downAlertEnabled: console.downAlertEnabled,
          downAlertDurationSeconds: console.downAlertDurationSeconds,
          downAlertWebhookJson: console.downAlertWebhook ? JSON.stringify(console.downAlertWebhook) : null,
          downAlertResolvedWebhookJson: console.downAlertResolvedWebhook
            ? JSON.stringify(console.downAlertResolvedWebhook)
            : null,
        },
      })
      .run();
  }

  // Consoles are never cascade-deleted (see schema.ts's sensors.consoleId
  // FK, onDelete: "restrict") — an operator has to remove a console's
  // sensors (and, transitively, any latches on them) explicitly first, so
  // deleting a console can never silently take latches/webhook history
  // with it. This check gives a clean, actionable error instead of
  // surfacing a raw SQLITE_CONSTRAINT failure to the caller.
  // Relies on the DB-level FK (sensors.consoleId, onDelete: "restrict" —
  // see schema.ts) as the actual gate, rather than a select-then-delete: a
  // pre-check has a TOCTOU gap (a sensor could be added between the check
  // and the delete), while the constraint is enforced atomically by SQLite
  // as part of the delete statement itself. We only catch the constraint
  // failure to turn it into ConsoleHasSensorsError for the route to map to
  // a clean 409.
  deleteProtectConsole(id: string): void {
    try {
      this.db.delete(protectConsoles).where(eq(protectConsoles.id, id)).run();
    } catch (err) {
      if (err instanceof Error && err.message.includes("FOREIGN KEY constraint failed")) {
        throw new ConsoleHasSensorsError(id);
      }
      throw err;
    }
  }

  listLatches(): Latch[] {
    return this.db.select().from(latches).all().map(latchFromRow);
  }

  upsertLatch(latch: Latch): void {
    this.db
      .insert(latches)
      .values({
        id: latch.id,
        name: latch.name,
        sensorId: latch.sensorId,
        metric: latch.metric,
        conditionJson: JSON.stringify(latch.condition),
        durationSeconds: latch.durationSeconds,
        webhookJson: JSON.stringify(latch.webhook),
        resolvedWebhookJson: latch.resolvedWebhook ? JSON.stringify(latch.resolvedWebhook) : null,
        enabled: latch.enabled,
      })
      .onConflictDoUpdate({
        target: latches.id,
        set: {
          name: latch.name,
          sensorId: latch.sensorId,
          metric: latch.metric,
          conditionJson: JSON.stringify(latch.condition),
          durationSeconds: latch.durationSeconds,
          webhookJson: JSON.stringify(latch.webhook),
          resolvedWebhookJson: latch.resolvedWebhook ? JSON.stringify(latch.resolvedWebhook) : null,
          enabled: latch.enabled,
        },
      })
      .run();
  }

  // latch_state and webhook_deliveries both reference latches.id with
  // onDelete: "cascade" (see schema.ts) — one statement is both simpler
  // and actually atomic, where three separate deletes were not (a crash
  // between them could leave latch_state/webhook_deliveries rows for a
  // latch that no longer exists).
  deleteLatch(id: string): void {
    this.db.delete(latches).where(eq(latches.id, id)).run();
  }

  // Called after every dispatchWebhook (fired/resolved/test — see
  // singleton.ts's ingest() and the Rules page's Test button) so "last
  // used" and "inspect the response" have something to read. Prunes to
  // the most recent MAX_DELIVERIES_PER_LATCH rows for this latch right
  // after inserting — bounded growth without a retention job.
  recordWebhookDelivery(delivery: WebhookDelivery): void {
    // Insert + prune-to-N as one transaction: without it, a crash between
    // the two leaves an extra row past MAX_DELIVERIES_PER_LATCH sitting in
    // the table until the next delivery for this latch prunes it — not
    // dangerous, but the whole point of pruning inline is to avoid needing
    // a separate cleanup pass, so it should actually be atomic.
    this.db.transaction((tx) => {
      tx.insert(webhookDeliveries)
        .values({
          id: delivery.id,
          latchId: delivery.latchId,
          kind: delivery.kind,
          url: delivery.url,
          method: delivery.method,
          ok: delivery.ok,
          status: delivery.status,
          error: delivery.error,
          responseBodySnippet: delivery.responseBodySnippet,
          attempts: delivery.attempts,
          dispatchedAt: delivery.dispatchedAt,
        })
        .run();

      const rows = tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.latchId, delivery.latchId))
        .orderBy(desc(webhookDeliveries.dispatchedAt))
        .all();
      const staleIds = rows.slice(MAX_DELIVERIES_PER_LATCH).map((r) => r.id);
      if (staleIds.length > 0) {
        tx.delete(webhookDeliveries).where(inArray(webhookDeliveries.id, staleIds)).run();
      }
    });
  }

  // Most recent first — the Rules page shows [0] as "last used" and lists
  // the rest for inspection.
  listWebhookDeliveries(latchId: string): WebhookDelivery[] {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.latchId, latchId))
      .orderBy(desc(webhookDeliveries.dispatchedAt))
      .all()
      .map(deliveryFromRow);
  }

  getLatchState(latchId: string): LatchStateRecord | null {
    const row = this.db.select().from(latchState).where(eq(latchState.latchId, latchId)).get();
    return row ? stateFromRow(row) : null;
  }

  listLatchStates(): LatchStateRecord[] {
    return this.db.select().from(latchState).all().map(stateFromRow);
  }

  saveLatchState(record: LatchStateRecord): void {
    this.db
      .insert(latchState)
      .values({
        latchId: record.latchId,
        state: record.state,
        armedAt: record.armedAt,
        firedAt: record.firedAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: latchState.latchId,
        set: { state: record.state, armedAt: record.armedAt, firedAt: record.firedAt, updatedAt: record.updatedAt },
      })
      .run();
  }

  recordLatchTransition(latchId: string, type: LatchTransitionRecord["type"], timestamp: number): void {
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
        type: row.type as LatchTransitionRecord["type"],
        timestamp: row.timestamp,
      }));
  }

  clearLatchTransitions(latchId: string): void {
    this.db.delete(latchTransitions).where(eq(latchTransitions.latchId, latchId)).run();
  }
}
