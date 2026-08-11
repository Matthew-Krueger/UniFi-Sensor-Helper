"use client";

import * as React from "react";
import { useNow } from "@/lib/format";

// Owns its own re-render tick (see useNow) so a live "X ago" label
// doesn't force the table/card/page around it to re-render every second
// too. Use intervalMs to match the label's actual precision: a
// second-granularity label (preciseAgoLabel) wants ~1000ms, a
// minute-granularity one (coarseAgoLabel) can tick much slower.
export function LiveRelativeTime({
  timestamp,
  format,
  intervalMs = 1000,
  className,
  title,
}: {
  timestamp: number | null;
  format: (timestamp: number | null, now: number) => string;
  intervalMs?: number;
  className?: string;
  title?: string;
}) {
  const now = useNow(intervalMs);
  return (
    <span className={className} title={title} suppressHydrationWarning>
      {format(timestamp, now)}
    </span>
  );
}
