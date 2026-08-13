import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// LatchEngine's `config` field is a fixed ConfigStore() using the real
// getDb() (see singleton.ts) rather than an injectable test db, so exercising
// ingest() end to end means pointing DATABASE_PATH at a throwaway file for
// the duration of this test file, then constructing a real LatchEngine.
// This mirrors config.test.ts's seedLatch setup for the console/sensor/latch
// foreign key chain, just via the real (file-backed) ConfigStore instead of
// createTestDb()'s in-memory one.
const dbPath = join(tmpdir(), `latch-engine-ingest-test-${Date.now()}.db`);
process.env.DATABASE_PATH = dbPath;

const { LatchEngine } = await import("../src/singleton");

function seedEnabledLatch(engine: InstanceType<typeof LatchEngine>, id: string, durationSeconds: number) {
  engine.config.upsertProtectConsole({
    id: "console-1",
    name: "Main site NVR",
    host: "10.0.0.1",
    apiKey: "test-key",
    apiBaseUrlOverride: null,
    defaultWebhookId: null,
    downAlertEnabled: false,
    downAlertDurationSeconds: null,
    downAlertWebhook: null,
    downAlertResolvedWebhook: null,
    createdAt: 0,
  });
  engine.config.upsertSensor({ id: "sensor-1", consoleId: "console-1", name: "Walk-in Freezer", metrics: ["temperature"] });
  engine.config.upsertLatch({
    id,
    name: null,
    sensorId: "sensor-1",
    metric: "temperature",
    condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
    durationSeconds,
    webhook: { kind: "custom", url: "https://example.invalid/webhook", method: "POST" },
    enabled: true,
  });
  return { id, sensorId: "sensor-1", metric: "temperature" as const, durationSeconds };
}

describe("LatchEngine.ingest transition log", () => {
  test("ingest records a latch_transitions row on a real transition, none on a same-state tick", () => {
    const engine = new LatchEngine();
    const latch = seedEnabledLatch(engine, "freezer-temp", 600);

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

  afterAll(() => {
    delete process.env.DATABASE_PATH;
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // best-effort cleanup
      }
    }
  });
});
