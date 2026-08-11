"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { absoluteTimeLabel, preciseAgoLabel, useNow } from "@/lib/format";
import { reportingBadge } from "@/lib/reportingBadge";
import type { SensorStatus } from "@unifi-sensor-latch/shared";

// Badge + "last seen" pair for one sensor, ticking on its own interval
// (see useNow) so opening/editing a rule elsewhere on the page doesn't
// force this to re-render, and vice versa.
export function SensorReportingStatus({
  status,
  label,
  intervalMs = 1000,
}: {
  status: SensorStatus | undefined;
  label?: string;
  intervalMs?: number;
}) {
  const now = useNow(intervalMs);
  const badge = reportingBadge(status?.lastSeenAt ?? null, status?.observedCheckinIntervalSeconds ?? null, now);
  return (
    <div className="flex items-center gap-2">
      <Badge variant={badge.variant} className="text-[10px]">
        {badge.label}
      </Badge>
      <span
        className="text-xs text-muted-foreground"
        title={status?.lastSeenAt ? absoluteTimeLabel(status.lastSeenAt) : undefined}
        suppressHydrationWarning
      >
        {label ? `${label} ` : ""}
        {preciseAgoLabel(status?.lastSeenAt ?? null, now)}
      </span>
    </div>
  );
}
