// A Rule's durationSeconds ("armed for at least this long before firing")
// used to be validated against a per-sensor "effective interval" (observed
// checkin cadence, or the console default as a fallback). That gate was
// dropped (project decision, 2026-08-10): the "observed" number turned out
// to measure how often Protect's wireless bridge broadcasts a connectivity
// heartbeat for a sensor, not how often the sensor actually takes a new
// measurement (see API_NOTES.md's follow-up finding) — so gating against
// it could reject a duration that was actually fine, or accept one that
// wasn't, based on a number that was never really about the sensor's real
// reporting rate. The only thing actually true regardless of hardware:
// nothing here can poll or react faster than MIN_DURATION_SECONDS, so
// that's the one hard floor. Advising the operator on the *right* duration
// for their specific sensor is now the Rules page's job (checking the
// sensor's real "update frequency" in the Protect app itself), not a
// computed validation rule.
export const MIN_DURATION_SECONDS = 60;

// Mirrors UniFi Protect's own Alarm Manager "for at least" duration
// presets, so this feels consistent with what the operator already knows
// from the native app rather than an arbitrary free-number field. No
// preset below MIN_DURATION_SECONDS — see above.
export const DURATION_PRESETS: { label: string; seconds: number }[] = [
  { label: "1 minute", seconds: 60 },
  { label: "5 minutes", seconds: 300 },
  { label: "10 minutes", seconds: 600 },
  { label: "15 minutes", seconds: 900 },
  { label: "30 minutes", seconds: 1800 },
  { label: "1 hour", seconds: 3600 },
];

// Still used for display (Sensors page badges, Rules page's per-sensor
// status blurb — see lib/reportingBadge.ts) — "how stale does this sensor
// look right now" is still a useful, honest question even though it's no
// longer used to gate what duration is allowed.
export type IntervalSource = "observed" | "console-default";

export interface EffectiveInterval {
  seconds: number;
  source: IntervalSource;
}

export function effectiveInterval(
  observedSeconds: number | null | undefined,
  consoleDefaultSeconds: number
): EffectiveInterval {
  if (observedSeconds != null) return { seconds: observedSeconds, source: "observed" };
  return { seconds: consoleDefaultSeconds, source: "console-default" };
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function isDurationValid(durationSeconds: number): boolean {
  return durationSeconds >= MIN_DURATION_SECONDS;
}

export function intervalTooShortMessage(durationSeconds: number): string {
  return (
    `Duration (${formatSeconds(durationSeconds)}) is shorter than the ${formatSeconds(MIN_DURATION_SECONDS)} minimum ` +
    `— nothing here can poll or confirm a change faster than that.`
  );
}
