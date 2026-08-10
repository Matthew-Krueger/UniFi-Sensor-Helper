import type { Latch, LatchState, LatchStateRecord, Reading } from "@unifi-sensor-latch/shared";

// The correctness-critical piece per CLAUDE.md — a missed alert has real
// consequences. This module is pure: no I/O, no network, no clock access
// beyond the timestamps it's handed. Ingest (where readings come from) and
// webhook dispatch (what happens on a transition) are injected by callers
// in server.ts / the future Protect ingest layer — TODO once section 8's
// API discovery lands.

export type Transition =
  | { type: "armed" }
  | { type: "cleared-before-fire" }
  | { type: "fired" }
  | { type: "resolved" }
  | { type: "none" };

function isBad(latch: Latch, value: number): boolean {
  return latch.direction === "above" ? value > latch.armThreshold : value < latch.armThreshold;
}

function isRecovered(latch: Latch, value: number): boolean {
  return latch.direction === "above" ? value <= latch.clearThreshold : value >= latch.clearThreshold;
}

// Applies one reading to one latch's current state record. Returns the next
// state record and which transition (if any) occurred, so the caller can
// decide whether to dispatch a webhook.
export function applyReading(
  latch: Latch,
  current: LatchStateRecord,
  reading: Reading
): { next: LatchStateRecord; transition: Transition } {
  const { value, timestamp } = reading;

  switch (current.state) {
    case "idle": {
      if (isBad(latch, value)) {
        return {
          next: { ...current, state: "armed", armedAt: timestamp, updatedAt: timestamp },
          transition: { type: "armed" },
        };
      }
      return { next: { ...current, updatedAt: timestamp }, transition: { type: "none" } };
    }

    case "armed": {
      if (isRecovered(latch, value)) {
        return {
          next: { ...current, state: "idle", armedAt: null, updatedAt: timestamp },
          transition: { type: "cleared-before-fire" },
        };
      }

      const armedAt = current.armedAt ?? timestamp;
      const elapsed = (timestamp - armedAt) / 1000;
      if (elapsed >= latch.durationSeconds) {
        return {
          next: { ...current, state: "fired", firedAt: timestamp, updatedAt: timestamp },
          transition: { type: "fired" },
        };
      }
      return { next: { ...current, updatedAt: timestamp }, transition: { type: "none" } };
    }

    case "fired": {
      if (isRecovered(latch, value)) {
        return {
          next: { ...current, state: "idle", armedAt: null, firedAt: null, updatedAt: timestamp },
          transition: { type: "resolved" },
        };
      }
      return { next: { ...current, updatedAt: timestamp }, transition: { type: "none" } };
    }

    default: {
      const exhaustive: never = current.state;
      throw new Error(`Unhandled latch state: ${exhaustive}`);
    }
  }
}

export function initialState(latchId: string, timestamp: number): LatchStateRecord {
  return { latchId, state: "idle" as LatchState, armedAt: null, firedAt: null, updatedAt: timestamp };
}
