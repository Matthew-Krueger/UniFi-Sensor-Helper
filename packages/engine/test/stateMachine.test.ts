import { describe, expect, test } from "bun:test";
import type { Latch } from "@unifi-sensor-latch/shared";
import { applyReading, initialState } from "../src/stateMachine";

// CLAUDE.md correctness priorities — the five minimum cases for the latch
// state machine. Restart/persistence behavior (case 5) is covered by
// initialState() being reconstructible from a saved LatchStateRecord — the
// state machine itself is pure, so "restart mid-armed-state" is really a
// property of ConfigStore.getLatchState() round-tripping the record, not of
// this module. That round-trip is exercised in config.test.ts alongside it.

const freezerLatch: Latch = {
  id: "freezer-temp",
  sensorId: "sensor-1",
  metric: "temperature",
  direction: "above",
  armThreshold: 55,
  clearThreshold: 38,
  durationSeconds: 600,
  webhook: { url: "https://example.invalid/webhook/fired", method: "POST" },
  resolvedWebhook: { url: "https://example.invalid/webhook/resolved", method: "POST" },
  enabled: true,
};

describe("latch state machine", () => {
  test("arms on threshold cross", () => {
    const start = initialState(freezerLatch.id, 0);
    const { next, transition } = applyReading(freezerLatch, start, {
      sensorId: freezerLatch.sensorId,
      metric: freezerLatch.metric,
      value: 60,
      timestamp: 1000,
    });

    expect(transition.type).toBe("armed");
    expect(next.state).toBe("armed");
    expect(next.armedAt).toBe(1000);
  });

  test("clears before duration elapses — no webhook fires", () => {
    const armed = { ...initialState(freezerLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { next, transition } = applyReading(freezerLatch, armed, {
      sensorId: freezerLatch.sensorId,
      metric: freezerLatch.metric,
      value: 30, // below clearThreshold of 38
      timestamp: 1000 + 60_000, // well under the 600s duration
    });

    expect(transition.type).toBe("cleared-before-fire");
    expect(next.state).toBe("idle");
  });

  test("fires after duration elapses without recovering", () => {
    const armed = { ...initialState(freezerLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { next, transition } = applyReading(freezerLatch, armed, {
      sensorId: freezerLatch.sensorId,
      metric: freezerLatch.metric,
      value: 60, // still above armThreshold, never recovered
      timestamp: 1000 + freezerLatch.durationSeconds * 1000,
    });

    expect(transition.type).toBe("fired");
    expect(next.state).toBe("fired");
    expect(next.firedAt).toBe(1000 + freezerLatch.durationSeconds * 1000);
  });

  test("resolved webhook only fires after the fired webhook fired", () => {
    const fired = {
      ...initialState(freezerLatch.id, 0),
      state: "fired" as const,
      armedAt: 1000,
      firedAt: 1000 + freezerLatch.durationSeconds * 1000,
    };
    const { next, transition } = applyReading(freezerLatch, fired, {
      sensorId: freezerLatch.sensorId,
      metric: freezerLatch.metric,
      value: 30, // back below clearThreshold
      timestamp: fired.firedAt! + 1000,
    });

    expect(transition.type).toBe("resolved");
    expect(next.state).toBe("idle");
  });

  test("a routine clear that never armed long enough never reaches fired, so never resolves", () => {
    const start = initialState(freezerLatch.id, 0);
    const armedResult = applyReading(freezerLatch, start, {
      sensorId: freezerLatch.sensorId,
      metric: freezerLatch.metric,
      value: 60,
      timestamp: 1000,
    });
    expect(armedResult.transition.type).toBe("armed");

    const clearedResult = applyReading(freezerLatch, armedResult.next, {
      sensorId: freezerLatch.sensorId,
      metric: freezerLatch.metric,
      value: 30,
      timestamp: 5000, // well under durationSeconds
    });

    expect(clearedResult.transition.type).toBe("cleared-before-fire");
    expect(clearedResult.next.state).toBe("idle");
    // Never touched "fired", so a resolvedWebhook could never have fired for this cycle.
  });
});
