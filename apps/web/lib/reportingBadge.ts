import { effectiveInterval } from "@unifi-sensor-latch/shared";

// Shared by the Sensors page (per-console and per-sensor) and the Rules
// page (selected-sensor status in the create/edit form, and the details
// dialog) — one badge/threshold definition, not hand-maintained copies
// that could silently drift apart.
export const GOOD_MULTIPLIER = 1.5; // within/close to the expected window
export const WARN_MULTIPLIER = 3; // "delayed" — user's explicit 3x threshold

export interface ReportingBadgeResult {
  variant: "idle" | "good" | "armed" | "fired";
  label: string;
}

// lastEventAt/observedSeconds are deliberately generic (not tied to
// "sensor" vs "console") — callers pass either a console's aggregate
// lastEventAt or one specific sensor's own lastSeenAt/
// observedCheckinIntervalSeconds. Elapsed time is always computed against
// the real clock at call time (callers re-render on a tick — see
// useNowTick) so a client that hasn't polled in a few seconds is never
// itself the reason something looks stale.
export function reportingBadge(
  lastEventAt: number | null,
  observedSeconds: number | null,
  defaultIntervalSeconds: number
): ReportingBadgeResult {
  if (!lastEventAt) return { variant: "idle", label: "no data yet" };

  const expectedSeconds = effectiveInterval(observedSeconds, defaultIntervalSeconds).seconds;
  const elapsedSeconds = (Date.now() - lastEventAt) / 1000;

  if (elapsedSeconds <= expectedSeconds * GOOD_MULTIPLIER) return { variant: "good", label: "reporting" };
  if (elapsedSeconds <= expectedSeconds * WARN_MULTIPLIER) return { variant: "armed", label: "delayed" };
  return { variant: "fired", label: "overdue" };
}
