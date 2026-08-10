import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Latch, LatchStateRecord, ProtectConsole, Sensor } from "@unifi-sensor-latch/shared";
import { getDb } from "./db";
import * as schema from "./schema";
import { latches, latchState, protectConsoles, sensors } from "./schema";

// Typed read/write over the sensors / latches / latch_state /
// protect_consoles tables via Drizzle. Replaces the config.json read/write
// layer originally described in SPEC.md section 6.

function sensorFromRow(row: typeof schema.sensors.$inferSelect): Sensor {
  return { id: row.id, consoleId: row.consoleId, name: row.name, metrics: JSON.parse(row.discoveredMetrics) };
}

function consoleFromRow(row: typeof schema.protectConsoles.$inferSelect): ProtectConsole {
  return { id: row.id, name: row.name, host: row.host, apiKey: row.apiKey, createdAt: row.createdAt };
}

function latchFromRow(row: typeof schema.latches.$inferSelect): Latch {
  return {
    id: row.id,
    sensorId: row.sensorId,
    metric: row.metric as Latch["metric"],
    direction: row.direction as Latch["direction"],
    armThreshold: row.armThreshold,
    clearThreshold: row.clearThreshold,
    durationSeconds: row.durationSeconds,
    webhook: JSON.parse(row.webhookJson),
    resolvedWebhook: row.resolvedWebhookJson ? JSON.parse(row.resolvedWebhookJson) : undefined,
    enabled: row.enabled,
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
        createdAt: console.createdAt,
      })
      .onConflictDoUpdate({
        target: protectConsoles.id,
        set: { name: console.name, host: console.host, apiKey: console.apiKey },
      })
      .run();
  }

  deleteProtectConsole(id: string): void {
    this.db.delete(protectConsoles).where(eq(protectConsoles.id, id)).run();
  }

  listLatches(): Latch[] {
    return this.db.select().from(latches).all().map(latchFromRow);
  }

  upsertLatch(latch: Latch): void {
    this.db
      .insert(latches)
      .values({
        id: latch.id,
        sensorId: latch.sensorId,
        metric: latch.metric,
        direction: latch.direction,
        armThreshold: latch.armThreshold,
        clearThreshold: latch.clearThreshold,
        durationSeconds: latch.durationSeconds,
        webhookJson: JSON.stringify(latch.webhook),
        resolvedWebhookJson: latch.resolvedWebhook ? JSON.stringify(latch.resolvedWebhook) : null,
        enabled: latch.enabled,
      })
      .onConflictDoUpdate({
        target: latches.id,
        set: {
          sensorId: latch.sensorId,
          metric: latch.metric,
          direction: latch.direction,
          armThreshold: latch.armThreshold,
          clearThreshold: latch.clearThreshold,
          durationSeconds: latch.durationSeconds,
          webhookJson: JSON.stringify(latch.webhook),
          resolvedWebhookJson: latch.resolvedWebhook ? JSON.stringify(latch.resolvedWebhook) : null,
          enabled: latch.enabled,
        },
      })
      .run();
  }

  deleteLatch(id: string): void {
    this.db.delete(latches).where(eq(latches.id, id)).run();
    this.db.delete(latchState).where(eq(latchState.latchId, id)).run();
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
}
