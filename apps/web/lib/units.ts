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
// Rounded to 1 decimal for Fahrenheit since the conversion introduces
// float noise (e.g. 21°C -> 69.80000000000001°F).
export function toDisplayValue(metric: Metric, storedValue: number, temperatureUnit: "C" | "F"): number {
  if (metric === "temperature" && temperatureUnit === "F") {
    return Math.round(celsiusToFahrenheit(storedValue) * 10) / 10;
  }
  return storedValue;
}

// What the user typed (in their display unit) -> what gets stored/evaluated.
export function toStoredValue(metric: Metric, displayValue: number, temperatureUnit: "C" | "F"): number {
  if (metric === "temperature" && temperatureUnit === "F") {
    return fahrenheitToCelsius(displayValue);
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
