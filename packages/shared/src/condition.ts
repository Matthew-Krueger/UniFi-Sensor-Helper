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

export type RuleCondition =
  | { type: "above"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "below"; threshold: number; hysteresis: ManualHysteresis }
  | { type: "between"; low: number; high: number; hysteresis: RangeHysteresis };

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
  }
}

// "Has it moved back far enough to count as recovered" — the clear
// check. For `between`, the auto-hysteresis margin is a percent of the
// range's width, expanded outward on both sides (see the design doc's
// worked example: range 30-40, marginPercent 5 -> must drop below 29.5
// or rise above 40.5).
export function isConditionRecovered(condition: RuleCondition, value: number): boolean {
  switch (condition.type) {
    case "above":
      return value <= condition.hysteresis.clearThreshold;
    case "below":
      return value >= condition.hysteresis.clearThreshold;
    case "between": {
      const { clearLow, clearHigh } = resolveClearBounds(condition);
      return value < clearLow || value > clearHigh;
    }
  }
}

function resolveClearBounds(condition: Extract<RuleCondition, { type: "between" }>): {
  clearLow: number;
  clearHigh: number;
} {
  if (condition.hysteresis.mode === "manual") {
    return { clearLow: condition.hysteresis.clearLow, clearHigh: condition.hysteresis.clearHigh };
  }
  const width = condition.high - condition.low;
  const margin = width * (condition.hysteresis.marginPercent / 100);
  return { clearLow: condition.low - margin, clearHigh: condition.high + margin };
}

export interface ConditionValidationResult {
  valid: boolean;
  error?: string;
}

// Server-side gate (CLAUDE.md trust boundaries) — called from the
// /api/latches routes, not just the form. Scope is deliberately narrow,
// matching the approved design: `between` needs low < high, and auto
// hysteresis needs a positive margin. (Manual clear-bound sanity for
// above/below/between-manual is intentionally out of scope — no such
// check existed before this change either; see the design doc's
// Non-goals.)
export function validateCondition(condition: RuleCondition): ConditionValidationResult {
  if (condition.type === "between") {
    if (!(condition.low < condition.high)) {
      return { valid: false, error: "The low bound must be less than the high bound." };
    }
    if (condition.hysteresis.mode === "auto" && !(condition.hysteresis.marginPercent > 0)) {
      return { valid: false, error: "Auto hysteresis margin must be greater than 0%." };
    }
  }
  return { valid: true };
}

// Plain-language summary for the Rules table and Dashboard — unitSuffix
// lets a caller append e.g. "°F" without this module knowing about
// metric-specific formatting (that's the Sensors page's job already, see
// apps/web/app/sensors/page.tsx's formatValue).
export function conditionSummary(condition: RuleCondition, unitSuffix = ""): string {
  switch (condition.type) {
    case "above":
      return `above ${condition.threshold}${unitSuffix}`;
    case "below":
      return `below ${condition.threshold}${unitSuffix}`;
    case "between": {
      const hysteresisLabel =
        condition.hysteresis.mode === "auto" ? `, ±${condition.hysteresis.marginPercent}% auto` : "";
      return `between ${condition.low}${unitSuffix} and ${condition.high}${unitSuffix}${hysteresisLabel}`;
    }
  }
}

// Feeds the webhook body template's {{threshold}} variable (see
// webhookDispatcher.ts) — above/below has one natural number, between
// doesn't, so it renders as "low-high".
export function conditionThresholdTemplateValue(condition: RuleCondition): string {
  return condition.type === "between" ? `${condition.low}-${condition.high}` : String(condition.threshold);
}
