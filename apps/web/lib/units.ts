import type { Metric, RangeHysteresis, RuleCondition } from "@unifi-sensor-latch/shared";

// Sensor values (and therefore rule thresholds) are always stored and
// evaluated in Celsius (SPEC.md, CLAUDE.md config-vs-secrets) — these
// helpers are the one place that boundary gets crossed, converting to/from
// the signed-in user's saved display preference (see
// temperature-unit-toggle.tsx) purely for what's shown/typed in the UI.

export function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}

export function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9;
}

// Suffix shown next to a metric's numeric value — temperature depends on
// the user's preference, everything else has one fixed unit.
export function metricUnitSuffix(metric: Metric, temperatureUnit: "C" | "F"): string {
  switch (metric) {
    case "temperature":
      return `°${temperatureUnit}`;
    case "humidity":
      return "%";
    case "lux":
      return " lux";
    case "leak":
      return "";
  }
}

// Stored (always-Celsius for temperature) -> what should be displayed.
// Rounded to 1 decimal for temperature regardless of unit — not just for
// the C->F conversion (which introduces float noise, e.g. 21°C ->
// 69.80000000000001°F), but also for the plain Celsius passthrough, since
// a value that was originally *entered* in Fahrenheit and converted to
// Celsius for storage (see toStoredValue) can itself carry the same float
// noise (e.g. 200°F -> 93.33333333333333°C stored, then displayed as-is).
export function toDisplayValue(metric: Metric, storedValue: number, temperatureUnit: "C" | "F"): number {
  if (metric !== "temperature") return storedValue;
  const value = temperatureUnit === "F" ? celsiusToFahrenheit(storedValue) : storedValue;
  return Math.round(value * 10) / 10;
}

// What the user typed (in their display unit) -> what gets stored/evaluated.
// Rounded to 2 decimals so a Fahrenheit entry doesn't persist as an
// endless Celsius float (200°F would otherwise store as
// 93.33333333333333, not 93.33) — 2 decimals keeps sub-degree precision
// without carrying the full float tail forever.
export function toStoredValue(metric: Metric, displayValue: number, temperatureUnit: "C" | "F"): number {
  if (metric === "temperature" && temperatureUnit === "F") {
    return Math.round(fahrenheitToCelsius(displayValue) * 100) / 100;
  }
  return displayValue;
}

// Converts a stored (always-Celsius-for-temperature) condition into one
// with display-unit values — for rendering only, never for anything sent
// back to the API. Auto hysteresis's marginPercent is unitless (a percent
// of the range's own width — see condition.ts), so it's left untouched.
export function toDisplayCondition(condition: RuleCondition, metric: Metric, temperatureUnit: "C" | "F"): RuleCondition {
  const conv = (v: number) => toDisplayValue(metric, v, temperatureUnit);
  if (condition.type === "between") {
    const hysteresis: RangeHysteresis =
      condition.hysteresis.mode === "auto"
        ? condition.hysteresis
        : {
            mode: "manual",
            clearLow: conv(condition.hysteresis.clearLow),
            clearHigh: conv(condition.hysteresis.clearHigh),
          };
    return { type: "between", low: conv(condition.low), high: conv(condition.high), hysteresis };
  }
  return {
    type: condition.type,
    threshold: conv(condition.threshold),
    hysteresis: { mode: "manual", clearThreshold: conv(condition.hysteresis.clearThreshold) },
  };
}
