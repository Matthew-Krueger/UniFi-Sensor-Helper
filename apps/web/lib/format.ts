"use client";

import * as React from "react";

// Full elapsed-time breakdown down to the second, no matter how long ago
// — "5m ago"/"2h ago" bucketing loses exactly the precision that matters
// for a monitoring tool (was it 4:58 or 5:02 relative to a threshold?).
// Always includes seconds; larger units only appear once they're
// nonzero, so "17s ago" stays as short as it should while "3d 4h 12m 7s
// ago" still shows everything.
//
// `now` is an explicit argument rather than an internal Date.now() call
// on purpose: React Compiler assumes render is a pure function of its
// reactive inputs, and a hidden Date.now() read is exactly the kind of
// impurity that makes it safe (from the compiler's point of view) to
// memoize the output and never recompute it, freezing "X ago" text even
// though the calling component keeps re-rendering. Passing `now` in
// makes it a real tracked input instead. See useNow below.
export function preciseAgoLabel(timestamp: number | null, now: number): string {
  if (!timestamp) return "never";
  const totalSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return `${parts.join(" ")} ago`;
}

// Single-unit "5m ago"/"2h ago" bucketing — the deliberately imprecise
// counterpart to preciseAgoLabel, for table cells where the point is
// scanability at a glance (Rules page's "Last used" column) rather than
// precision; the exact to-the-second value still lives one click away
// (preciseAgoLabel + absoluteTimeLabel, e.g. in a details dialog).
export function coarseAgoLabel(timestamp: number | null, now: number): string {
  if (!timestamp) return "never";
  const totalSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (totalSeconds < 60) return "just now";
  const days = Math.floor(totalSeconds / 86400);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ago`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ago`;
}

// Compact "1d 2h 3m" style for a plain span of time (not "ago" from now)
// — skips zero units, so it matches the level of precision a custom
// DD:HH:MM:SS rule duration actually offers instead of collapsing
// everything down to whole minutes.
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const parts = [days > 0 && `${days}d`, hours > 0 && `${hours}h`, minutes > 0 && `${minutes}m`, seconds > 0 && `${seconds}s`].filter(
    Boolean
  );
  return parts.length > 0 ? parts.join(" ") : "0s";
}

// Exact wall-clock time for a title/tooltip alongside the relative label.
export function absoluteTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

// Returns the current time in ms and re-renders the calling component
// every intervalMs, so anything computed from it (preciseAgoLabel,
// reportingBadge) stays live between data polls instead of sitting frozen
// until the next one lands.
//
// Call this only from small leaf components (LiveRelativeTime,
// SensorReportingStatus, etc.), not from a whole page component — calling
// it there forces that component's entire render output, table and all,
// to be recomputed every tick. Pushing it down into the smallest
// component that actually needs a live clock keeps the tick from
// cascading into everything around it.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
