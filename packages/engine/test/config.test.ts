import { describe, expect, test } from "bun:test";
import { ConfigStore } from "../src/config";
import { createTestDb } from "../src/db";
import { latches } from "../src/schema";

// Covers CLAUDE.md's fifth required case: a restart mid-armed-state behaves
// sanely. The state machine is pure (see stateMachine.test.ts); persistence
// is this module's job, so the round-trip through ConfigStore is what proves
// "restart doesn't lose an in-progress arm."
function freshStore(): ConfigStore {
  return new ConfigStore(createTestDb());
}

// Foreign keys are enforced (PRAGMA foreign_keys = ON — see db.ts), so a
// latch_state/latches row needs its parent chain (console -> sensor ->
// latch) inserted first.
function seedLatch(store: ConfigStore, id: string): void {
  store.upsertProtectConsole({
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
  store.upsertSensor({ id: "sensor-1", consoleId: "console-1", name: "Walk-in Freezer", metrics: ["temperature"] });
  store.upsertLatch({
    id,
    name: null,
    sensorId: "sensor-1",
    metric: "temperature",
    condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
    durationSeconds: 600,
    webhook: { kind: "custom", url: "https://example.invalid/webhook", method: "POST" },
    enabled: true,
  });
}

describe("ConfigStore latch state persistence", () => {
  test("an armed state survives a save/reload round-trip", () => {
    const store = freshStore();
    seedLatch(store, "freezer-temp");

    store.saveLatchState({
      latchId: "freezer-temp",
      state: "armed",
      armedAt: 1_000,
      firedAt: null,
      updatedAt: 1_000,
    });

    // Simulate a process restart: a new ConfigStore reading the same db file
    // (here, the same in-memory handle) has no in-memory state of its own.
    const reloaded = store.getLatchState("freezer-temp");

    expect(reloaded).not.toBeNull();
    expect(reloaded?.state).toBe("armed");
    expect(reloaded?.armedAt).toBe(1_000);
  });

  test("latches and sensors round-trip through upsert", () => {
    const store = freshStore();

    store.upsertProtectConsole({
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
    store.upsertSensor({ id: "sensor-1", consoleId: "console-1", name: "Walk-in Freezer", metrics: ["temperature"] });
    store.upsertLatch({
      id: "freezer-temp",
      name: null,
      sensorId: "sensor-1",
      metric: "temperature",
      condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
      durationSeconds: 600,
      webhook: { kind: "custom", url: "https://example.invalid/webhook", method: "POST" },
      enabled: true,
    });

    expect(store.listSensors()).toHaveLength(1);
    expect(store.listLatches()).toHaveLength(1);
    const condition = store.listLatches()[0]?.condition;
    expect(condition?.type).toBe("above");
    expect(condition?.type === "above" && condition.hysteresis.clearThreshold).toBe(38);
  });

  test("a legacy flat webhook row (pre-console-webhook, no `kind`) normalizes to a custom target", () => {
    const db = createTestDb();
    const store = new ConfigStore(db);

    store.upsertProtectConsole({
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
    store.upsertSensor({ id: "sensor-1", consoleId: "console-1", name: "Walk-in Freezer", metrics: ["temperature"] });

    // Simulates a row written before the console-webhook redesign — back
    // when WebhookTarget was just {url, method, headers?, bodyTemplate?}
    // with no discriminant. See config.ts's normalizeWebhookTarget.
    db.insert(latches)
      .values({
        id: "legacy-rule",
        sensorId: "sensor-1",
        metric: "temperature",
        conditionJson: JSON.stringify({
          type: "above",
          threshold: 55,
          hysteresis: { mode: "manual", clearThreshold: 38 },
        }),
        durationSeconds: 600,
        webhookJson: JSON.stringify({ url: "https://example.invalid/legacy", method: "POST" }),
        resolvedWebhookJson: null,
        enabled: true,
      })
      .run();

    const latch = store.listLatches().find((l) => l.id === "legacy-rule");
    expect(latch?.webhook).toEqual({ kind: "custom", url: "https://example.invalid/legacy", method: "POST" });
  });
});

describe("ConfigStore latch transitions", () => {
  test("recordLatchTransition then getLatchTransitions returns rows ordered by timestamp ascending", () => {
    const store = freshStore();
    seedLatch(store, "freezer-temp");

    store.recordLatchTransition("freezer-temp", "armed", 2000);
    store.recordLatchTransition("freezer-temp", "fired", 1000);

    const rows = store.getLatchTransitions("freezer-temp");
    expect(rows.map((r) => r.type)).toEqual(["fired", "armed"]);
    expect(rows.map((r) => r.timestamp)).toEqual([1000, 2000]);
  });

  test("getLatchTransitions only returns rows for the requested latch", () => {
    const store = freshStore();
    seedLatch(store, "latch-a");
    seedLatchWithSensor(store, "latch-b", "sensor-2", "console-2");

    store.recordLatchTransition("latch-a", "armed", 1000);
    store.recordLatchTransition("latch-b", "armed", 1000);

    expect(store.getLatchTransitions("latch-a")).toHaveLength(1);
  });

  test("clearLatchTransitions deletes all rows for that latch only", () => {
    const store = freshStore();
    seedLatch(store, "latch-a");
    seedLatchWithSensor(store, "latch-b", "sensor-2", "console-2");

    store.recordLatchTransition("latch-a", "armed", 1000);
    store.recordLatchTransition("latch-a", "fired", 2000);
    store.recordLatchTransition("latch-b", "armed", 1000);

    store.clearLatchTransitions("latch-a");

    expect(store.getLatchTransitions("latch-a")).toHaveLength(0);
    expect(store.getLatchTransitions("latch-b")).toHaveLength(1);
  });
});

// A second independent console/sensor/latch chain, for tests that need two
// distinct latches (seedLatch alone always reuses console-1/sensor-1).
function seedLatchWithSensor(store: ConfigStore, latchId: string, sensorId: string, consoleId: string): void {
  store.upsertProtectConsole({
    id: consoleId,
    name: "Second site NVR",
    host: "10.0.0.2",
    apiKey: "test-key-2",
    apiBaseUrlOverride: null,
    defaultWebhookId: null,
    downAlertEnabled: false,
    downAlertDurationSeconds: null,
    downAlertWebhook: null,
    downAlertResolvedWebhook: null,
    createdAt: 0,
  });
  store.upsertSensor({ id: sensorId, consoleId, name: "Second Sensor", metrics: ["temperature"] });
  store.upsertLatch({
    id: latchId,
    name: null,
    sensorId,
    metric: "temperature",
    condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
    durationSeconds: 600,
    webhook: { kind: "custom", url: "https://example.invalid/webhook", method: "POST" },
    enabled: true,
  });
}
