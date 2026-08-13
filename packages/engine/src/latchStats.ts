import type { LatchStateRecord, LatchTransitionRecord } from "@unifi-sensor-latch/shared";

export type LatchStatsWindowKey = "1d" | "7d" | "30d" | "365d" | "all";

export interface LatchStatsWindow {
  armedCount: number;
  firedCount: number;
  idleCount: number;
  armedSeconds: number;
  firedSeconds: number;
}

export type LatchStats = Record<LatchStatsWindowKey, LatchStatsWindow>;

const DAY_MS = 24 * 60 * 60 * 1000;

const WINDOW_MS: Record<Exclude<LatchStatsWindowKey, "all">, number> = {
  "1d": 1 * DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "365d": 365 * DAY_MS,
};

function emptyWindow(): LatchStatsWindow {
  return { armedCount: 0, firedCount: 0, idleCount: 0, armedSeconds: 0, firedSeconds: 0 };
}

// A "state span" is a closed-or-open interval the latch spent in "armed" or
// "fired", derived by walking consecutive transition events plus the
// current live state for any still-open trailing span.
interface StateSpan {
  state: "armed" | "fired";
  start: number;
  end: number; // may equal `now` for a still-open span
}

function buildSpans(events: LatchTransitionRecord[], liveState: LatchStateRecord | null, now: number): StateSpan[] {
  const spans: StateSpan[] = [];
  let openState: "armed" | "fired" | null = null;
  let openStart = 0;

  for (const event of events) {
    if (event.type === "armed") {
      openState = "armed";
      openStart = event.timestamp;
    } else if (event.type === "fired") {
      if (openState === "armed") {
        spans.push({ state: "armed", start: openStart, end: event.timestamp });
      }
      openState = "fired";
      openStart = event.timestamp;
    } else {
      // "resolved" or "cleared-before-fire" — closes whatever was open.
      if (openState) {
        spans.push({ state: openState, start: openStart, end: event.timestamp });
      }
      openState = null;
    }
  }

  // A still-open span at the end of the event log, per the live state.
  if (openState && liveState && liveState.state !== "idle") {
    spans.push({ state: openState, start: openStart, end: now });
  }

  return spans;
}

function clip(span: StateSpan, windowStart: number, now: number): number {
  const start = Math.max(span.start, windowStart);
  const end = Math.min(span.end, now);
  return Math.max(0, end - start) / 1000;
}

export function computeLatchStats(
  events: LatchTransitionRecord[],
  liveState: LatchStateRecord | null,
  now: number,
): LatchStats {
  const spans = buildSpans(events, liveState, now);

  const windows: LatchStats = {
    "1d": emptyWindow(),
    "7d": emptyWindow(),
    "30d": emptyWindow(),
    "365d": emptyWindow(),
    all: emptyWindow(),
  };

  for (const key of Object.keys(windows) as LatchStatsWindowKey[]) {
    const windowStart = key === "all" ? -Infinity : now - WINDOW_MS[key];
    const bucket = windows[key];

    for (const event of events) {
      if (event.timestamp < windowStart || event.timestamp > now) continue;
      if (event.type === "armed") bucket.armedCount += 1;
      else if (event.type === "fired") bucket.firedCount += 1;
      else bucket.idleCount += 1; // resolved | cleared-before-fire
    }

    for (const span of spans) {
      if (span.end < windowStart || span.start > now) continue;
      const seconds = clip(span, windowStart, now);
      if (span.state === "armed") bucket.armedSeconds += seconds;
      else bucket.firedSeconds += seconds;
    }
  }

  return windows;
}
