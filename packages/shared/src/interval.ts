// A Rule's durationSeconds ("armed for at least this long before firing")
// is only meaningful if the sensor actually reports often enough for a
// non-recovering reading to land inside that window. This module is the
// one place that logic lives — used both server-side (the actual gate, in
// the /api/latches routes) and client-side (greying out too-short preset
// options before the user can even submit them). Per project decision:
// too-short durations are a hard block, not a warning.

// Mirrors UniFi Protect's own Alarm Manager "for at least" duration
// presets, so this feels consistent with what the operator already knows
// from the native app rather than an arbitrary free-number field.
export const DURATION_PRESETS: { label: string; seconds: number }[] = [
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "5 minutes", seconds: 300 },
  { label: "10 minutes", seconds: 600 },
  { label: "15 minutes", seconds: 900 },
  { label: "30 minutes", seconds: 1800 },
  { label: "1 hour", seconds: 3600 },
];

export type IntervalSource = "observed" | "console-default";

export interface EffectiveInterval {
  seconds: number;
  source: IntervalSource;
}

// Priority: a real observed interval (measured from actual reading gaps —
// see SensorStatus) beats the console default, because it's ground truth
// rather than a guess. There used to be a middle "per-sensor override"
// tier here, removed by project decision: sensors are always fetched in
// one bulk GET /v1/sensors call per console (confirmed live — there's no
// way to poll one sensor faster than another, and no API-exposed
// "reporting interval" field to sync a per-sensor override to even if
// there were), so a per-sensor interval knob didn't correspond to
// anything the app could actually act on — it only ever affected rule
// validation math, not real polling behavior, which was confusing more
// than useful.
export function effectiveInterval(
  observedSeconds: number | null | undefined,
  consoleDefaultSeconds: number
): EffectiveInterval {
  if (observedSeconds != null) return { seconds: observedSeconds, source: "observed" };
  return { seconds: consoleDefaultSeconds, source: "console-default" };
}

export function isDurationValid(durationSeconds: number, interval: EffectiveInterval): boolean {
  return durationSeconds >= interval.seconds;
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

const SOURCE_LABEL: Record<IntervalSource, string> = {
  observed: "the interval observed from this sensor's real readings",
  "console-default": "the console's default expected interval",
};

export function intervalTooShortMessage(durationSeconds: number, interval: EffectiveInterval): string {
  return (
    `Duration (${formatSeconds(durationSeconds)}) is shorter than ${SOURCE_LABEL[interval.source]} ` +
    `(${formatSeconds(interval.seconds)}) — a reading might never land inside the armed window, so this rule ` +
    `could never reliably fire. Choose a longer duration or adjust the expected interval.`
  );
}
