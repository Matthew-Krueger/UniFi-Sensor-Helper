import type { Database } from "bun:sqlite";
import type { Latch, LatchStateRecord, Sensor } from "@unifi-sensor-latch/shared";
import { getDb } from "./db";

// Typed read/write over the `sensors` / `latches` / `latch_state` tables.
// Replaces the config.json read/write layer originally described in
// SPEC.md section 6.

interface SensorRow {
  id: string;
  name: string;
  discovered_metrics: string;
}

interface LatchRow {
  id: string;
  sensor_id: string;
  metric: string;
  direction: string;
  arm_threshold: number;
  clear_threshold: number;
  duration_seconds: number;
  webhook_json: string;
  resolved_webhook_json: string | null;
  enabled: number;
}

interface LatchStateRow {
  latch_id: string;
  state: string;
  armed_at: number | null;
  fired_at: number | null;
  updated_at: number;
}

function sensorFromRow(row: SensorRow): Sensor {
  return { id: row.id, name: row.name, metrics: JSON.parse(row.discovered_metrics) };
}

function latchFromRow(row: LatchRow): Latch {
  return {
    id: row.id,
    sensorId: row.sensor_id,
    metric: row.metric as Latch["metric"],
    direction: row.direction as Latch["direction"],
    armThreshold: row.arm_threshold,
    clearThreshold: row.clear_threshold,
    durationSeconds: row.duration_seconds,
    webhook: JSON.parse(row.webhook_json),
    resolvedWebhook: row.resolved_webhook_json ? JSON.parse(row.resolved_webhook_json) : undefined,
    enabled: Boolean(row.enabled),
  };
}

function stateFromRow(row: LatchStateRow): LatchStateRecord {
  return {
    latchId: row.latch_id,
    state: row.state as LatchStateRecord["state"],
    armedAt: row.armed_at,
    firedAt: row.fired_at,
    updatedAt: row.updated_at,
  };
}

export class ConfigStore {
  constructor(private readonly db: Database = getDb()) {}

  listSensors(): Sensor[] {
    const rows = this.db.query("SELECT * FROM sensors ORDER BY name").all() as SensorRow[];
    return rows.map(sensorFromRow);
  }

  upsertSensor(sensor: Sensor): void {
    this.db
      .query(
        `INSERT INTO sensors (id, name, discovered_metrics) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, discovered_metrics = excluded.discovered_metrics`
      )
      .run(sensor.id, sensor.name, JSON.stringify(sensor.metrics));
  }

  listLatches(): Latch[] {
    const rows = this.db.query("SELECT * FROM latches").all() as LatchRow[];
    return rows.map(latchFromRow);
  }

  upsertLatch(latch: Latch): void {
    this.db
      .query(
        `INSERT INTO latches
           (id, sensor_id, metric, direction, arm_threshold, clear_threshold, duration_seconds, webhook_json, resolved_webhook_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sensor_id = excluded.sensor_id,
           metric = excluded.metric,
           direction = excluded.direction,
           arm_threshold = excluded.arm_threshold,
           clear_threshold = excluded.clear_threshold,
           duration_seconds = excluded.duration_seconds,
           webhook_json = excluded.webhook_json,
           resolved_webhook_json = excluded.resolved_webhook_json,
           enabled = excluded.enabled`
      )
      .run(
        latch.id,
        latch.sensorId,
        latch.metric,
        latch.direction,
        latch.armThreshold,
        latch.clearThreshold,
        latch.durationSeconds,
        JSON.stringify(latch.webhook),
        latch.resolvedWebhook ? JSON.stringify(latch.resolvedWebhook) : null,
        latch.enabled ? 1 : 0
      );
  }

  deleteLatch(id: string): void {
    this.db.query("DELETE FROM latches WHERE id = ?").run(id);
    this.db.query("DELETE FROM latch_state WHERE latch_id = ?").run(id);
  }

  getLatchState(latchId: string): LatchStateRecord | null {
    const row = this.db.query("SELECT * FROM latch_state WHERE latch_id = ?").get(latchId) as
      | LatchStateRow
      | null;
    return row ? stateFromRow(row) : null;
  }

  listLatchStates(): LatchStateRecord[] {
    const rows = this.db.query("SELECT * FROM latch_state").all() as LatchStateRow[];
    return rows.map(stateFromRow);
  }

  saveLatchState(record: LatchStateRecord): void {
    this.db
      .query(
        `INSERT INTO latch_state (latch_id, state, armed_at, fired_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(latch_id) DO UPDATE SET
           state = excluded.state,
           armed_at = excluded.armed_at,
           fired_at = excluded.fired_at,
           updated_at = excluded.updated_at`
      )
      .run(record.latchId, record.state, record.armedAt, record.firedAt, record.updatedAt);
  }
}
