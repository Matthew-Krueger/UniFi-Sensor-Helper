import type { Latch, Metric } from "@unifi-sensor-latch/shared";
import { conditionSummary } from "@unifi-sensor-latch/shared";
import { metricUnitSuffix, toDisplayCondition } from "@/lib/units";
import { formatDuration } from "@/lib/format";

// Self-contained plain-English summary of what a rule does, e.g. "If
// Freezer sensor is above 55F for 10 minutes" — shared between the Rules
// table/details dialog and the dashboard cards so both surfaces describe a
// rule identically instead of maintaining two hand-written copies.
export function ruleDescription(
  rule: Pick<Latch, "metric" | "condition" | "durationSeconds">,
  sensorLabel: string,
  temperatureUnit: "C" | "F"
): string {
  if (rule.metric === "leak") {
    return `If ${sensorLabel} detects a leak for ${formatDuration(rule.durationSeconds)}`;
  }
  const summary = conditionSummary(
    toDisplayCondition(rule.condition, rule.metric as Metric, temperatureUnit),
    metricUnitSuffix(rule.metric as Metric, temperatureUnit)
  );
  return `If ${sensorLabel} is ${summary} for ${formatDuration(rule.durationSeconds)}`;
}
