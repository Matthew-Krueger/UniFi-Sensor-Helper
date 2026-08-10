"use client";

import * as React from "react";

// Full elapsed-time breakdown down to the second, no matter how long ago
// — "5m ago"/"2h ago" bucketing loses exactly the precision that matters
// for a monitoring tool (was it 4:58 or 5:02 relative to a threshold?).
// Always includes seconds; larger units only appear once they're
// nonzero, so "17s ago" stays as short as it should while "3d 4h 12m 7s
// ago" still shows everything.
export function preciseAgoLabel(timestamp: number | null): string {
  if (!timestamp) return "never";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
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

// Forces a re-render every second so preciseAgoLabel's output keeps
// advancing between data polls (which run every few seconds) — without
// this, "12s ago" would sit frozen until the next poll landed instead of
// actually counting up live.
export function useNowTick(intervalMs = 1000): void {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
