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
  name: null,
  sensorId: "sensor-1",
  metric: "temperature",
  condition: { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } },
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

  test("stays fired on a subsequent reading without recovering — no re-fire", () => {
    const fired = {
      ...initialState(freezerLatch.id, 0),
      state: "fired" as const,
      armedAt: 1000,
      firedAt: 1000 + freezerLatch.durationSeconds * 1000,
    };
    const { next, transition } = applyReading(freezerLatch, fired, {
      sensorId: freezerLatch.sensorId,
      metric: freezerLatch.metric,
      value: 60, // still above armThreshold, still not recovered
      timestamp: fired.firedAt! + 1000,
    });

    expect(transition.type).toBe("none");
    expect(next.state).toBe("fired");
    expect(next.firedAt).toBe(fired.firedAt);
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

const rangeLatch: Latch = {
  id: "freezer-range",
  name: null,
  sensorId: "sensor-1",
  metric: "temperature",
  condition: {
    type: "between",
    low: 40,
    high: 55,
    hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
  },
  durationSeconds: 3600,
  webhook: { url: "https://example.invalid/webhook/fired", method: "POST" },
  resolvedWebhook: { url: "https://example.invalid/webhook/resolved", method: "POST" },
  enabled: true,
};

describe("latch state machine — between (range) condition", () => {
  test("arms when the value enters the range", () => {
    const start = initialState(rangeLatch.id, 0);
    const { next, transition } = applyReading(rangeLatch, start, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 45,
      timestamp: 1000,
    });

    expect(transition.type).toBe("armed");
    expect(next.state).toBe("armed");
  });

  test("clears before duration elapses if it exits the manual clear bounds — no webhook fires", () => {
    const armed = { ...initialState(rangeLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { next, transition } = applyReading(rangeLatch, armed, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 34, // below clearLow of 35
      timestamp: 1000 + 60_000, // well under the 3600s duration
    });

    expect(transition.type).toBe("cleared-before-fire");
    expect(next.state).toBe("idle");
  });

  test("stays armed while inside the manual clear bounds but outside [low, high] — no premature clear", () => {
    const armed = { ...initialState(rangeLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { transition } = applyReading(rangeLatch, armed, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 37, // outside [40,55] but inside the [35,60] clear bounds
      timestamp: 1000 + 60_000,
    });

    expect(transition.type).toBe("none");
  });

  test("fires after duration elapses without recovering", () => {
    const armed = { ...initialState(rangeLatch.id, 0), state: "armed" as const, armedAt: 1000 };
    const { next, transition } = applyReading(rangeLatch, armed, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 45, // still inside the range, never recovered
      timestamp: 1000 + rangeLatch.durationSeconds * 1000,
    });

    expect(transition.type).toBe("fired");
    expect(next.state).toBe("fired");
  });

  test("resolved webhook only fires after the fired webhook fired", () => {
    const fired = {
      ...initialState(rangeLatch.id, 0),
      state: "fired" as const,
      armedAt: 1000,
      firedAt: 1000 + rangeLatch.durationSeconds * 1000,
    };
    const { next, transition } = applyReading(rangeLatch, fired, {
      sensorId: rangeLatch.sensorId,
      metric: rangeLatch.metric,
      value: 34, // outside the clear bounds
      timestamp: fired.firedAt! + 1000,
    });

    expect(transition.type).toBe("resolved");
    expect(next.state).toBe("idle");
  });

  test("auto hysteresis: recovers only once outside the range plus its percent margin", () => {
    const autoLatch: Latch = {
      ...rangeLatch,
      id: "freezer-range-auto",
      condition: { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 10 } },
    };
    const armed = { ...initialState(autoLatch.id, 0), state: "armed" as const, armedAt: 1000 };

    const stillArmed = applyReading(autoLatch, armed, {
      sensorId: autoLatch.sensorId,
      metric: autoLatch.metric,
      value: 39, // outside [40,55] but within the 1.5-wide auto margin (>= 38.5)
      timestamp: 1000 + 60_000,
    });
    expect(stillArmed.transition.type).toBe("none");

    const cleared = applyReading(autoLatch, armed, {
      sensorId: autoLatch.sensorId,
      metric: autoLatch.metric,
      value: 38, // below 38.5, past the auto margin
      timestamp: 1000 + 60_000,
    });
    expect(cleared.transition.type).toBe("cleared-before-fire");
  });
});
