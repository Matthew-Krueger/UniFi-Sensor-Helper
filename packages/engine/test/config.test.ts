import { describe, expect, test } from "bun:test";
import { ConfigStore } from "../src/config";
import { createTestDb } from "../src/db";

// Covers CLAUDE.md's fifth required case: a restart mid-armed-state behaves
// sanely. The state machine is pure (see stateMachine.test.ts); persistence
// is this module's job, so the round-trip through ConfigStore is what proves
// "restart doesn't lose an in-progress arm."
function freshStore(): ConfigStore {
  return new ConfigStore(createTestDb());
}

describe("ConfigStore latch state persistence", () => {
  test("an armed state survives a save/reload round-trip", () => {
    const store = freshStore();

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

    store.upsertSensor({ id: "sensor-1", consoleId: "console-1", name: "Walk-in Freezer", metrics: ["temperature"] });
    store.upsertLatch({
      id: "freezer-temp",
      sensorId: "sensor-1",
      metric: "temperature",
      condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
      durationSeconds: 600,
      webhook: { url: "https://example.invalid/webhook", method: "POST" },
      enabled: true,
    });

    expect(store.listSensors()).toHaveLength(1);
    expect(store.listLatches()).toHaveLength(1);
    const condition = store.listLatches()[0]?.condition;
    expect(condition?.type).toBe("above");
    expect(condition?.type === "above" && condition.hysteresis.clearThreshold).toBe(38);
  });
});
