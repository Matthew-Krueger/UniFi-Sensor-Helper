// Rule condition evaluation, hysteresis, validation, and display logic —
// see docs/superpowers/specs/2026-08-10-rule-conditions-design.md. This is
// the one place that knows what "armed"/"recovered" means for a
// condition; the state machine (packages/engine/src/stateMachine.ts),
// webhook template substitution, the API routes' server-side validation,
// and both UI pages (Rules, Dashboard) all consume it rather than
// re-implementing threshold comparisons.

export interface ManualHysteresis {
  mode: "manual";
  clearThreshold: number;
}

export type RangeHysteresis =
  | { mode: "manual"; clearLow: number; clearHigh: number }
  | { mode: "auto"; marginPercent: number };

// "between" arms *inside* [low, high] (e.g. humidity 40-60% is mold
// risk) — the deadband expands outward from there (clearLow <= low,
// clearHigh >= high), so it takes a bigger move to recover than it took
// to arm. "outside" is the mirror: arms when the reading leaves [low,
// high] (e.g. freezer temp above 80 or below 20 — the far more common
// sensor-alert shape), and its deadband shrinks *inward* from the bounds
// (clearLow >= low, clearHigh <= high) — it has to come back well inside
// the safe range before disarming, not just barely cross back over the
// edge. Same {low, high, hysteresis} shape either way; only the
// direction of "armed" and which way the deadband points differ — see
// isConditionMet/isConditionRecovered below.
export type RuleCondition =
  | { type: "above"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "below"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "between"; low: number; high: number; hysteresis: RangeHysteresis }
  | { type: "outside"; low: number; high: number; hysteresis: RangeHysteresis };

// "Is the raw reading currently bad" — the arm check. Duration timing
// (how long it has to stay this way before firing) lives in the state
// machine, not here; this is purely "true/false right now."
export function isConditionMet(condition: RuleCondition, value: number): boolean {
  switch (condition.type) {
    case "above":
      return value > condition.threshold;
    case "below":
      return value < condition.threshold;
    case "between":
      return value >= condition.low && value <= condition.high;
    case "outside":
      return value < condition.low || value > condition.high;
  }
}

// "Has it moved back far enough to count as recovered" — the clear
// check. For `between`, the auto-hysteresis margin is a percent of the
// range's width, expanded outward on both sides (see the design doc's
// worked example: range 30-40, marginPercent 5 -> must drop below 29.5
// or rise above 40.5). For `outside`, the same percent instead shrinks
// the range inward on both sides before it counts as recovered.
export function isConditionRecovered(condition: RuleCondition, value: number): boolean {
  switch (condition.type) {
    case "above":
      return value <= condition.hysteresis.clearThreshold;
    case "below":
      return value >= condition.hysteresis.clearThreshold;
    case "between": {
      const { clearLow, clearHigh } = resolveClearBounds(condition, "outward");
      return value < clearLow || value > clearHigh;
    }
    case "outside": {
      const { clearLow, clearHigh } = resolveClearBounds(condition, "inward");
      return value >= clearLow && value <= clearHigh;
    }
  }
}

function resolveClearBounds(
  condition: Extract<RuleCondition, { type: "between" | "outside" }>,
  direction: "outward" | "inward"
): {
  clearLow: number;
  clearHigh: number;
} {
  if (condition.hysteresis.mode === "manual") {
    return { clearLow: condition.hysteresis.clearLow, clearHigh: condition.hysteresis.clearHigh };
  }
  const width = condition.high - condition.low;
  const margin = width * (condition.hysteresis.marginPercent / 100);
  return direction === "outward"
    ? { clearLow: condition.low - margin, clearHigh: condition.high + margin }
    : { clearLow: condition.low + margin, clearHigh: condition.high - margin };
}

export interface ConditionValidationResult {
  valid: boolean;
  error?: string;
}

// Server-side gate (CLAUDE.md trust boundaries) — called from the
// /api/latches routes, not just the form. `between` needs low < high, and
// auto hysteresis needs a positive margin. Manual clear bounds must sit
// on the recovered side of (or exactly at) the armed bound they clear,
// never inside it — that's what makes the gap between arm and clear a
// real deadband. A clear bound on the wrong side would let a reading
// count as "recovered" while still meeting the arm condition, which
// defeats the whole point of hysteresis and can produce arm/clear flap.
export function validateCondition(condition: RuleCondition): ConditionValidationResult {
  if (condition.type === "above") {
    if (!Number.isFinite(condition.threshold) || !Number.isFinite(condition.hysteresis.clearThreshold)) {
      return { valid: false, error: "Threshold and release point must both be numbers." };
    }
    if (!(condition.hysteresis.clearThreshold <= condition.threshold)) {
      return { valid: false, error: "The release point must be at or below the arm threshold." };
    }
  }

  if (condition.type === "below") {
    if (!Number.isFinite(condition.threshold) || !Number.isFinite(condition.hysteresis.clearThreshold)) {
      return { valid: false, error: "Threshold and release point must both be numbers." };
    }
    if (!(condition.hysteresis.clearThreshold >= condition.threshold)) {
      return { valid: false, error: "The release point must be at or above the arm threshold." };
    }
  }

  if (condition.type === "between" || condition.type === "outside") {
    if (!Number.isFinite(condition.low) || !Number.isFinite(condition.high)) {
      return { valid: false, error: "Both bounds must be numbers." };
    }
    if (!(condition.low < condition.high)) {
      return { valid: false, error: "The low bound must be less than the high bound." };
    }

    if (condition.hysteresis.mode === "auto") {
      if (!(condition.hysteresis.marginPercent > 0)) {
        return { valid: false, error: "Auto hysteresis margin must be greater than 0%." };
      }
      // "outside" shrinks the range inward by the margin on each side —
      // at 50% the two edges meet in the middle and the range collapses
      // to nothing, so nothing could ever count as recovered.
      if (condition.type === "outside" && !(condition.hysteresis.marginPercent < 50)) {
        return { valid: false, error: "Auto hysteresis margin must be less than 50% for an outside condition." };
      }
    } else {
      const { clearLow, clearHigh } = condition.hysteresis;
      if (!Number.isFinite(clearLow) || !Number.isFinite(clearHigh)) {
        return { valid: false, error: "Both release bounds must be numbers." };
      }
      if (condition.type === "between") {
        if (!(clearLow <= condition.low)) {
          return { valid: false, error: "The lower release point must be at or below the low bound." };
        }
        if (!(clearHigh >= condition.high)) {
          return { valid: false, error: "The upper release point must be at or above the high bound." };
        }
      } else {
        if (!(clearLow >= condition.low)) {
          return { valid: false, error: "The lower release point must be at or above the low bound." };
        }
        if (!(clearHigh <= condition.high)) {
          return { valid: false, error: "The upper release point must be at or below the high bound." };
        }
        if (!(clearLow < clearHigh)) {
          return { valid: false, error: "The lower release point must be less than the upper release point." };
        }
      }
    }
  }

  return { valid: true };
}

// Rounds to at most 2 decimals and drops a trailing ".00"/".50" back to a
// plain integer or short decimal — a defensive display-layer pass on top
// of whatever precision the value already carries (e.g. apps/web/lib/
// units.ts's C<->F conversion), so a value that somehow still has float
// noise (93.33333333333333) never reaches the screen.
function formatNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// Plain-language summary for the Rules table and Dashboard — unitSuffix
// lets a caller append e.g. "°F" without this module knowing about
// metric-specific formatting (that's the Sensors page's job already, see
// apps/web/app/sensors/page.tsx's formatValue).
export function conditionSummary(condition: RuleCondition, unitSuffix = ""): string {
  switch (condition.type) {
    case "above":
      return `above ${formatNumber(condition.threshold)}${unitSuffix}`;
    case "below":
      return `below ${formatNumber(condition.threshold)}${unitSuffix}`;
    case "between": {
      const hysteresisLabel =
        condition.hysteresis.mode === "auto" ? `, ±${condition.hysteresis.marginPercent}% auto` : "";
      return `between ${formatNumber(condition.low)}${unitSuffix} and ${formatNumber(condition.high)}${unitSuffix}${hysteresisLabel}`;
    }
    case "outside": {
      const hysteresisLabel =
        condition.hysteresis.mode === "auto" ? `, ±${condition.hysteresis.marginPercent}% auto` : "";
      return `outside ${formatNumber(condition.low)}${unitSuffix}-${formatNumber(condition.high)}${unitSuffix}${hysteresisLabel}`;
    }
  }
}

// Feeds the webhook body template's {{threshold}} variable (see
// webhookDispatcher.ts) — above/below has one natural number, between/
// outside doesn't, so both render as "low-high".
export function conditionThresholdTemplateValue(condition: RuleCondition): string {
  return condition.type === "between" || condition.type === "outside"
    ? `${condition.low}-${condition.high}`
    : String(condition.threshold);
}
