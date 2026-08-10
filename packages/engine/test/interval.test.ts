import { describe, expect, test } from "bun:test";
import { effectiveInterval, isDurationValid } from "@unifi-sensor-latch/shared";

// Covers the priority order (observed > sensor override > console
// default) and the hard-block validation rule this project explicitly
// asked for: a rule's duration must be at least the effective interval,
// or it can never reliably fire.

describe("effectiveInterval", () => {
  test("prefers observed over sensor override and console default", () => {
    const result = effectiveInterval(120, 300, 600);
    expect(result).toEqual({ seconds: 120, source: "observed" });
  });

  test("falls back to sensor override when no observed data yet", () => {
    const result = effectiveInterval(null, 300, 600);
    expect(result).toEqual({ seconds: 300, source: "sensor-override" });
  });

  test("falls back to console default when neither observed nor override exist", () => {
    const result = effectiveInterval(null, null, 600);
    expect(result).toEqual({ seconds: 600, source: "console-default" });
  });

  test("undefined is treated the same as null (no data)", () => {
    const result = effectiveInterval(undefined, undefined, 600);
    expect(result).toEqual({ seconds: 600, source: "console-default" });
  });
});

describe("isDurationValid", () => {
  test("rejects the exact scenario from the project brief: 10min duration vs. 1hr interval", () => {
    const interval = effectiveInterval(null, null, 3600); // sampling every hour
    expect(isDurationValid(600, interval)).toBe(false); // "over 50 for 10 minutes"
  });

  test("accepts a duration equal to the interval", () => {
    const interval = effectiveInterval(300, null, 3600);
    expect(isDurationValid(300, interval)).toBe(true);
  });

  test("accepts a duration longer than the interval", () => {
    const interval = effectiveInterval(300, null, 3600);
    expect(isDurationValid(600, interval)).toBe(true);
  });
});
