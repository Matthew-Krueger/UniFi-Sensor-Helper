import { describe, expect, test } from "bun:test";
import {
  isConditionMet,
  isConditionRecovered,
  validateCondition,
  conditionSummary,
  conditionThresholdTemplateValue,
} from "@unifi-sensor-latch/shared";
import type { RuleCondition } from "@unifi-sensor-latch/shared";

describe("isConditionMet", () => {
  test("above: true when value exceeds threshold", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(isConditionMet(c, 60)).toBe(true);
    expect(isConditionMet(c, 55)).toBe(false);
    expect(isConditionMet(c, 50)).toBe(false);
  });

  test("below: true when value is under threshold", () => {
    const c: RuleCondition = { type: "below", threshold: 32, hysteresis: { mode: "manual", clearThreshold: 40 } };
    expect(isConditionMet(c, 20)).toBe(true);
    expect(isConditionMet(c, 32)).toBe(false);
    expect(isConditionMet(c, 40)).toBe(false);
  });

  test("between: true when value is within [low, high] inclusive", () => {
    const c: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    expect(isConditionMet(c, 40)).toBe(true);
    expect(isConditionMet(c, 55)).toBe(true);
    expect(isConditionMet(c, 47)).toBe(true);
    expect(isConditionMet(c, 39)).toBe(false);
    expect(isConditionMet(c, 56)).toBe(false);
  });

  test("outside: true when value is outside [low, high] — the mirror of between", () => {
    const c: RuleCondition = {
      type: "outside",
      low: 20,
      high: 80,
      hysteresis: { mode: "manual", clearLow: 30, clearHigh: 70 },
    };
    expect(isConditionMet(c, 10)).toBe(true); // below low
    expect(isConditionMet(c, 90)).toBe(true); // above high
    expect(isConditionMet(c, 20)).toBe(false); // exactly at low — inside, not armed
    expect(isConditionMet(c, 80)).toBe(false); // exactly at high — inside, not armed
    expect(isConditionMet(c, 50)).toBe(false);
  });
});

describe("isConditionRecovered", () => {
  test("above: recovered at or below the manual clear threshold", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(isConditionRecovered(c, 38)).toBe(true);
    expect(isConditionRecovered(c, 39)).toBe(false);
  });

  test("below: recovered at or above the manual clear threshold", () => {
    const c: RuleCondition = { type: "below", threshold: 32, hysteresis: { mode: "manual", clearThreshold: 40 } };
    expect(isConditionRecovered(c, 40)).toBe(true);
    expect(isConditionRecovered(c, 39)).toBe(false);
  });

  test("between manual: recovered strictly outside the manual clear bounds", () => {
    const c: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    expect(isConditionRecovered(c, 34)).toBe(true);
    expect(isConditionRecovered(c, 35)).toBe(false); // still within clear bounds, not recovered yet
    expect(isConditionRecovered(c, 61)).toBe(true);
    expect(isConditionRecovered(c, 47)).toBe(false);
  });

  test("between auto: recovered strictly outside range expanded by marginPercent of its width", () => {
    // range width 15 (40-55), marginPercent 10 -> margin 1.5
    const c: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "auto", marginPercent: 10 },
    };
    expect(isConditionRecovered(c, 38.6)).toBe(false); // 38.6 > 38.5, still inside the clear bounds
    expect(isConditionRecovered(c, 38.4)).toBe(true); // < 38.5, recovered
    expect(isConditionRecovered(c, 56.4)).toBe(false); // <= 56.5, not recovered
    expect(isConditionRecovered(c, 56.6)).toBe(true); // > 56.5, recovered
  });

  test("outside manual: recovered inside the manual clear bounds (deadband points inward)", () => {
    const c: RuleCondition = {
      type: "outside",
      low: 20,
      high: 80,
      hysteresis: { mode: "manual", clearLow: 30, clearHigh: 70 },
    };
    expect(isConditionRecovered(c, 30)).toBe(true); // at clearLow — recovered
    expect(isConditionRecovered(c, 29)).toBe(false); // still armed side of the deadband
    expect(isConditionRecovered(c, 70)).toBe(true); // at clearHigh — recovered
    expect(isConditionRecovered(c, 71)).toBe(false);
    expect(isConditionRecovered(c, 50)).toBe(true); // well inside the safe zone
  });

  test("outside auto: recovered inside the range shrunk inward by marginPercent of its width", () => {
    // range width 60 (20-80), marginPercent 10 -> margin 6 -> clear bounds 26/74
    const c: RuleCondition = {
      type: "outside",
      low: 20,
      high: 80,
      hysteresis: { mode: "auto", marginPercent: 10 },
    };
    expect(isConditionRecovered(c, 26)).toBe(true);
    expect(isConditionRecovered(c, 25.9)).toBe(false);
    expect(isConditionRecovered(c, 74)).toBe(true);
    expect(isConditionRecovered(c, 74.1)).toBe(false);
  });
});

describe("validateCondition", () => {
  test("between requires low < high", () => {
    const c: RuleCondition = {
      type: "between",
      low: 55,
      high: 40,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    const result = validateCondition(c);
    expect(result.valid).toBe(false);
  });

  test("between auto requires marginPercent > 0", () => {
    const c: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 0 } };
    const result = validateCondition(c);
    expect(result.valid).toBe(false);
  });

  test("valid above condition passes", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(validateCondition(c).valid).toBe(true);
  });

  test("valid between condition (manual and auto) passes", () => {
    const manual: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    const auto: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 5 } };
    expect(validateCondition(manual).valid).toBe(true);
    expect(validateCondition(auto).valid).toBe(true);
  });

  test("above rejects a clear threshold set above the arm threshold (would recover while still armed)", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 60 } };
    expect(validateCondition(c).valid).toBe(false);
  });

  test("above allows a clear threshold equal to the arm threshold (zero deadband is still valid)", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 55 } };
    expect(validateCondition(c).valid).toBe(true);
  });

  test("below rejects a clear threshold set below the arm threshold (would recover while still armed)", () => {
    const c: RuleCondition = { type: "below", threshold: 32, hysteresis: { mode: "manual", clearThreshold: 20 } };
    expect(validateCondition(c).valid).toBe(false);
  });

  test("between manual rejects clear bounds that sit inside the armed range", () => {
    const insideLow: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 45, clearHigh: 60 },
    };
    const insideHigh: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 50 },
    };
    expect(validateCondition(insideLow).valid).toBe(false);
    expect(validateCondition(insideHigh).valid).toBe(false);
  });

  test("rejects non-finite thresholds", () => {
    const c: RuleCondition = { type: "above", threshold: NaN, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(validateCondition(c).valid).toBe(false);
  });

  test("outside manual valid: clear bounds inside the armed range", () => {
    const c: RuleCondition = {
      type: "outside",
      low: 20,
      high: 80,
      hysteresis: { mode: "manual", clearLow: 30, clearHigh: 70 },
    };
    expect(validateCondition(c).valid).toBe(true);
  });

  test("outside manual rejects clear bounds outside the armed range (wrong direction from between)", () => {
    const c: RuleCondition = {
      type: "outside",
      low: 20,
      high: 80,
      hysteresis: { mode: "manual", clearLow: 10, clearHigh: 90 },
    };
    expect(validateCondition(c).valid).toBe(false);
  });

  test("outside manual rejects clearLow >= clearHigh", () => {
    const c: RuleCondition = {
      type: "outside",
      low: 20,
      high: 80,
      hysteresis: { mode: "manual", clearLow: 60, clearHigh: 40 },
    };
    expect(validateCondition(c).valid).toBe(false);
  });

  test("outside auto rejects a margin of 50% or more (bounds would collapse or invert)", () => {
    const c: RuleCondition = { type: "outside", low: 20, high: 80, hysteresis: { mode: "auto", marginPercent: 50 } };
    expect(validateCondition(c).valid).toBe(false);
  });

  test("outside auto accepts a margin under 50%", () => {
    const c: RuleCondition = { type: "outside", low: 20, high: 80, hysteresis: { mode: "auto", marginPercent: 49 } };
    expect(validateCondition(c).valid).toBe(true);
  });
});

describe("conditionSummary", () => {
  test("above/below render as plain language", () => {
    const above: RuleCondition = { type: "above", threshold: 500, hysteresis: { mode: "manual", clearThreshold: 500 } };
    expect(conditionSummary(above)).toBe("above 500");
  });

  test("between renders both bounds, with auto margin noted", () => {
    const auto: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 5 } };
    expect(conditionSummary(auto)).toBe("between 40 and 55, ±5% auto");
    const manual: RuleCondition = {
      type: "between",
      low: 40,
      high: 55,
      hysteresis: { mode: "manual", clearLow: 35, clearHigh: 60 },
    };
    expect(conditionSummary(manual)).toBe("between 40 and 55");
  });

  test("outside renders as low-high with auto margin noted", () => {
    const c: RuleCondition = { type: "outside", low: 20, high: 80, hysteresis: { mode: "auto", marginPercent: 10 } };
    expect(conditionSummary(c)).toBe("outside 20-80, ±10% auto");
  });
});

describe("conditionThresholdTemplateValue", () => {
  test("above/below returns the single threshold", () => {
    const c: RuleCondition = { type: "above", threshold: 55, hysteresis: { mode: "manual", clearThreshold: 38 } };
    expect(conditionThresholdTemplateValue(c)).toBe("55");
  });

  test("between returns 'low-high'", () => {
    const c: RuleCondition = { type: "between", low: 40, high: 55, hysteresis: { mode: "auto", marginPercent: 5 } };
    expect(conditionThresholdTemplateValue(c)).toBe("40-55");
  });

  test("outside returns 'low-high'", () => {
    const c: RuleCondition = { type: "outside", low: 20, high: 80, hysteresis: { mode: "auto", marginPercent: 5 } };
    expect(conditionThresholdTemplateValue(c)).toBe("20-80");
  });
});
