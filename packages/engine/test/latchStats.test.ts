import { describe, expect, test } from "bun:test";
import { computeLatchStats } from "../src/latchStats";
import type { LatchTransitionRecord } from "@unifi-sensor-latch/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

function ev(type: LatchTransitionRecord["type"], timestamp: number): LatchTransitionRecord {
  return { id: `ev-${timestamp}-${type}`, latchId: "latch-1", type, timestamp };
}

describe("computeLatchStats", () => {
  test("empty event list and idle live state returns all zeros for every window", () => {
    const now = 10 * DAY_MS;
    const stats = computeLatchStats([], { latchId: "latch-1", state: "idle", armedAt: null, firedAt: null, updatedAt: now }, now);

    for (const key of ["1d", "7d", "30d", "365d", "all"] as const) {
      expect(stats[key]).toEqual({ armedCount: 0, firedCount: 0, idleCount: 0, armedSeconds: 0, firedSeconds: 0 });
    }
  });

  test("counts armed, fired, and idle (lumping resolved and cleared-before-fire) within the all-time window", () => {
    const now = 10 * DAY_MS;
    const events = [
      ev("armed", 1 * DAY_MS),
      ev("cleared-before-fire", 1 * DAY_MS + 1000), // idle path 1
      ev("armed", 2 * DAY_MS),
      ev("fired", 2 * DAY_MS + 2000),
      ev("resolved", 2 * DAY_MS + 3000), // idle path 2
    ];
    const liveState = { latchId: "latch-1", state: "idle" as const, armedAt: null, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats.all.armedCount).toBe(2);
    expect(stats.all.firedCount).toBe(1);
    expect(stats.all.idleCount).toBe(2);
  });

  test("closed interval duration is summed and clipped to the window boundary", () => {
    const now = 10 * DAY_MS;
    // Armed for exactly 2 hours, entirely within the last 1 day.
    const armedAt = now - 3 * 60 * 60 * 1000;
    const firedAt = armedAt + 2 * 60 * 60 * 1000;
    const events = [ev("armed", armedAt), ev("fired", firedAt), ev("resolved", firedAt + 60_000)];
    const liveState = { latchId: "latch-1", state: "idle" as const, armedAt: null, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["1d"].armedSeconds).toBe(2 * 60 * 60);
  });

  test("an interval that starts before a window boundary is clipped to the boundary", () => {
    const now = 10 * DAY_MS;
    // Armed starting 2 days ago (outside the 1d window), fired 1 day ago (inside it).
    const armedAt = now - 2 * DAY_MS;
    const firedAt = now - 1 * DAY_MS;
    const events = [ev("armed", armedAt), ev("fired", firedAt)];
    const liveState = { latchId: "latch-1", state: "fired" as const, armedAt, firedAt, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    // Only the portion of the armed interval inside the last 1 day counts: from
    // (now - 1*DAY_MS) [the window start] to firedAt (now - 1*DAY_MS) = 0 seconds
    // armed inside the window, since the armed->fired transition happened right
    // at the window boundary in this fixture.
    expect(stats["1d"].armedSeconds).toBe(0);
  });

  test("a currently open interval (still armed) counts time up to now, clipped to the window", () => {
    const now = 10 * DAY_MS;
    const armedAt = now - 30 * 60 * 1000; // armed 30 minutes ago, still armed
    const events = [ev("armed", armedAt)];
    const liveState = { latchId: "latch-1", state: "armed" as const, armedAt, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["1d"].armedSeconds).toBe(30 * 60);
    expect(stats.all.armedSeconds).toBe(30 * 60);
  });

  test("a currently open fired interval counts separately from armed time", () => {
    const now = 10 * DAY_MS;
    const armedAt = now - 90 * 60 * 1000;
    const firedAt = now - 20 * 60 * 1000;
    const events = [ev("armed", armedAt), ev("fired", firedAt)];
    const liveState = { latchId: "latch-1", state: "fired" as const, armedAt, firedAt, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["1d"].armedSeconds).toBe(70 * 60); // armedAt -> firedAt
    expect(stats["1d"].firedSeconds).toBe(20 * 60); // firedAt -> now, still open
  });

  test("events outside the window are excluded from counts entirely", () => {
    const now = 400 * DAY_MS; // > 365 days of runway
    const events = [ev("armed", now - 400 * DAY_MS)]; // way outside every finite window
    const liveState = { latchId: "latch-1", state: "idle" as const, armedAt: null, firedAt: null, updatedAt: now };

    const stats = computeLatchStats(events, liveState, now);

    expect(stats["365d"].armedCount).toBe(0);
    expect(stats.all.armedCount).toBe(1);
  });
});
