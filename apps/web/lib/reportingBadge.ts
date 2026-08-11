import { effectiveInterval } from "@unifi-sensor-latch/shared";

// Shared by the Sensors page (per-console and per-sensor) and the Rules
// page (selected-sensor status in the create/edit form, and the details
// dialog) — one badge/threshold definition, not hand-maintained copies
// that could silently drift apart.
export const GOOD_MULTIPLIER = 1.5; // within/close to the expected window
export const WARN_MULTIPLIER = 3; // "delayed" — user's explicit 3x threshold

// Fallback expected interval before real per-sensor data exists yet (a
// freshly discovered sensor, or one still under MIN_CHECKIN_SAMPLES — see
// singleton.ts). Used to be a per-console operator-configurable setting;
// removed once observedCheckinIntervalSeconds made a real per-sensor
// number available almost immediately in practice, leaving the console
// default meaningful only for this brief bootstrap window — not worth a
// whole settings field for. 5 minutes matches the old column default.
const FALLBACK_EXPECTED_SECONDS = 300;

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
export function reportingBadge(lastEventAt: number | null, observedSeconds: number | null): ReportingBadgeResult {
  if (!lastEventAt) return { variant: "idle", label: "no data yet" };

  const expectedSeconds = effectiveInterval(observedSeconds, FALLBACK_EXPECTED_SECONDS).seconds;
  const elapsedSeconds = (Date.now() - lastEventAt) / 1000;

  if (elapsedSeconds <= expectedSeconds * GOOD_MULTIPLIER) return { variant: "good", label: "reporting" };
  if (elapsedSeconds <= expectedSeconds * WARN_MULTIPLIER) return { variant: "armed", label: "delayed" };
  return { variant: "fired", label: "overdue" };
}
