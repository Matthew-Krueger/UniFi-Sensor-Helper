import { describe, expect, test } from "bun:test";
import { MIN_DURATION_SECONDS, effectiveInterval, isDurationValid } from "@unifi-sensor-latch/shared";

// effectiveInterval is still used for display (Sensors/Rules page
// staleness badges) — see lib/reportingBadge.ts. isDurationValid used to
// gate against it too, but that was dropped (project decision,
// 2026-08-10): the "observed" number turned out to measure Protect's
// wireless bridge heartbeat cadence, not the sensor's real reporting
// rate (see API_NOTES.md's follow-up finding), so gating against it could
// be wrong in either direction. The only thing still actually
// enforceable is the flat floor below which nothing here can poll or
// confirm a change at all.

describe("effectiveInterval", () => {
  test("prefers observed over console default", () => {
    const result = effectiveInterval(120, 600);
    expect(result).toEqual({ seconds: 120, source: "observed" });
  });

  test("falls back to console default when no observed data yet", () => {
    const result = effectiveInterval(null, 600);
    expect(result).toEqual({ seconds: 600, source: "console-default" });
  });

  test("undefined is treated the same as null (no data)", () => {
    const result = effectiveInterval(undefined, 600);
    expect(result).toEqual({ seconds: 600, source: "console-default" });
  });
});

describe("isDurationValid", () => {
  test("rejects a duration shorter than the flat minimum", () => {
    expect(isDurationValid(MIN_DURATION_SECONDS - 1)).toBe(false);
  });

  test("accepts a duration equal to the flat minimum", () => {
    expect(isDurationValid(MIN_DURATION_SECONDS)).toBe(true);
  });

  test("accepts a duration longer than the flat minimum", () => {
    expect(isDurationValid(MIN_DURATION_SECONDS * 10)).toBe(true);
  });
});
