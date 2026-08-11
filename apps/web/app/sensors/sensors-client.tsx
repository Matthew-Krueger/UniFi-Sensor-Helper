"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Battery, BatteryWarning, Droplets, Sun, Thermometer, TriangleAlert, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConsoleStatus, ProtectConsole, Sensor, SensorStatus } from "@unifi-sensor-latch/shared";
import { DURATION_PRESETS } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { usePausedWhileSelectFocused } from "@/lib/usePausedWhileSelectFocused";
import { absoluteTimeLabel, preciseAgoLabel, useNowTick } from "@/lib/format";
import { reportingBadge } from "@/lib/reportingBadge";
import { celsiusToFahrenheit } from "@/lib/units";

// Discovery-driven — SPEC.md section 12: sensors are never hand-typed, only
// ever listed from what /api/sensors/discover found on a configured
// console. If no console is configured yet, this page points to Consoles.
//
// Grouped by console, one card per console containing its sensors. The
// console-level header still shows its own "last contacted"/"reporting
// every" summary (connection-level: is the console itself reachable —
// see ConsoleStatus.lastEventAt, bumped by any successful pull regardless
// of which sensor triggered it). Each sensor card additionally shows its
// *own* reporting badge and last-seen time — now genuinely independent
// per sensor, derived from that specific sensor's real websocket touches
// (see singleton.ts's recordSensorCheckin), not a shared poll signal the
// way it used to be.
const POLL_MS = 5000;
const INTERVAL_PRESETS = DURATION_PRESETS;

function formatInterval(seconds: number): string {
  const preset = INTERVAL_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// Sensor values are always stored/evaluated in Celsius (SPEC.md) — unit is
// a display-only conversion, applied here only, driven by the signed-in
// user's saved preference (see temperature-unit-toggle.tsx).
function formatValue(metric: string, value: number, temperatureUnit: "C" | "F"): string {
  switch (metric) {
    case "temperature": {
      if (temperatureUnit === "F") return `${celsiusToFahrenheit(value).toFixed(1)}°F`;
      return `${value.toFixed(1)}°C`;
    }
    case "humidity":
      return `${value.toFixed(0)}%`;
    case "lux":
      return `${value.toFixed(0)} lux`;
    case "leak":
      return value > 0 ? "leak detected" : "dry";
    default:
      return String(value);
  }
}

const METRIC_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  temperature: Thermometer,
  humidity: Droplets,
  lux: Sun,
  leak: TriangleAlert,
};

function MetricIcon({ metric }: { metric: string }) {
  const Icon = METRIC_ICONS[metric] ?? Gauge;
  return <Icon className="h-4 w-4 text-purple-600 dark:text-purple-400" />;
}

const BATTERY_RED_THRESHOLD = 10;
const BATTERY_YELLOW_THRESHOLD = 20;

// Wired/mains sensors have no batteryStatus at all (rawSensorBattery
// returns null) — nothing renders for those rather than a fake "0%". Same
// Badge component/variant palette as the reporting badge right next to
// it (good/armed/fired), so the two read as one consistent status row
// rather than two different visual languages.
function BatteryIndicator({ battery }: { battery: SensorStatus["battery"] }) {
  if (!battery || battery.percentage == null) return null;
  const pct = battery.percentage;
  const low = pct < BATTERY_RED_THRESHOLD;
  const warn = pct < BATTERY_YELLOW_THRESHOLD;
  const variant = low ? "fired" : warn ? "armed" : "good";
  const Icon = warn ? BatteryWarning : Battery;
  return (
    <Badge variant={variant} className="gap-1 text-[10px]" title={`Battery ${pct}%`}>
      <Icon className="h-3 w-3" />
      {pct}%
    </Badge>
  );
}

// Picks a column count explicitly by item count rather than leaving it to
// a fixed breakpoint-driven grid — a fixed `sm:grid-cols-2 lg:grid-cols-3`
// wraps 4 items as 3-then-1, which reads as a mistake rather than a
// layout. 4 items get an explicit 2x2; small counts get exactly as many
// columns as items (never an empty gap); larger counts fall back to a
// normal responsive flow since there's no single "neat" arrangement once
// a wrap is unavoidable.
function gridColsForCount(count: number): string {
  switch (count) {
    case 0:
    case 1:
      return "grid-cols-1";
    case 2:
      return "grid-cols-1 sm:grid-cols-2";
    case 3:
      return "grid-cols-1 sm:grid-cols-3";
    case 4:
      return "grid-cols-1 sm:grid-cols-2"; // 2x2, not 3-then-1
    default:
      return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  }
}

export interface SensorsInitialData {
  sensors: Sensor[];
  statuses: SensorStatus[];
  consoles: ProtectConsole[];
  consoleStatuses: ConsoleStatus[];
}

// Seeded with data already fetched server-side (see page.tsx) — first
// paint already shows real sensors/values instead of an empty "No sensors
// discovered yet" flash that then pops into the real table a moment
// later. The 5s poll below still runs exactly as before to keep values
// live; it just no longer owns the *first* render.
export function SensorsClient({ initial }: { initial: SensorsInitialData }) {
  useNowTick(); // keeps "last contacted"/"refreshed" ticking live, second-by-second
  const { user: actor } = useCurrentUser();
  const queryClient = useQueryClient();
  const temperatureUnit = actor?.temperatureUnit ?? "C";
  const canDiscover = hasRole(actor, "admin");
  const [error, setError] = React.useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<number | null>(null);

  // See usePausedWhileSelectFocused's doc comment — avoids a real Firefox
  // crash when a poll-driven re-render mutates a <select> while its
  // dropdown popup is open.
  const paused = usePausedWhileSelectFocused();

  const sensorsQuery = useQuery({
    queryKey: ["sensors"],
    queryFn: async () => {
      const res = await fetch("/api/sensors");
      if (!res.ok) throw new Error("failed to load sensors");
      return (await res.json()) as { sensors: Sensor[]; statuses: SensorStatus[] };
    },
    initialData: { sensors: initial.sensors, statuses: initial.statuses },
    refetchInterval: paused ? false : POLL_MS,
  });
  const consolesQuery = useQuery({
    queryKey: ["consoles"],
    queryFn: async () => {
      const res = await fetch("/api/consoles");
      if (!res.ok) throw new Error("failed to load consoles");
      return (await res.json()) as { consoles: ProtectConsole[]; statuses: ConsoleStatus[] };
    },
    initialData: { consoles: initial.consoles, statuses: initial.consoleStatuses },
    refetchInterval: paused ? false : POLL_MS,
  });

  const sensors = sensorsQuery.data.sensors;
  const statuses = sensorsQuery.data.statuses;
  const consoles = consolesQuery.data.consoles;
  const consoleStatuses = consolesQuery.data.statuses;

  // "Refresh" is a manual, on-demand refetch: it re-runs discovery
  // (picks up any newly added/removed physical sensors — see
  // SPEC.md section 12) and then reloads the full page state (sensor
  // list + live status/values), same data the 5s poll would eventually
  // bring in, just immediately. It only reads and writes sensor metadata
  // — it never touches latch_state or evaluates any rule.
  //
  // lastRefreshedAt exists so a successful refresh is visible even when
  // nothing actually changed (same sensors, same values) — otherwise a
  // no-op-looking success is indistinguishable from the button silently
  // doing nothing.
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sensors/discover", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "discovery failed");
      return body.errors as string[] | undefined;
    },
    onSuccess: async (discoverErrors) => {
      setError(discoverErrors?.length ? discoverErrors.join("; ") : null);
      await queryClient.invalidateQueries({ queryKey: ["sensors"] });
      setLastRefreshedAt(Date.now());
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[sensors] refresh failed:", err);
      setError(message);
    },
  });

  function refresh() {
    setError(null);
    refreshMutation.mutate();
  }

  const loading = refreshMutation.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sensors</h1>
        {canDiscover && (
          <div className="flex items-center gap-2">
            {/* suppressHydrationWarning below — "X ago" text is derived from
                Date.now() at render time, so the server's render and the
                client's first-paint render a moment later will almost
                always differ by a second or two; this is the officially
                recommended way to silence that expected mismatch without
                discarding the subtree (see Next.js hydration-error docs).
                useNowTick re-renders with the live value every second
                after mount regardless. */}
            {lastRefreshedAt && !loading && (
              <span className="text-xs text-muted-foreground" title={absoluteTimeLabel(lastRefreshedAt)} suppressHydrationWarning>
                Refreshed {preciseAgoLabel(lastRefreshedAt)}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading || consoles.length === 0}
              title={consoles.length === 0 ? "Add a console first" : undefined}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        "Last contacted" and "last seen" show when we last heard from Protect about a sensor, not when the sensor
        itself last checked in — Protect doesn't tell us that directly, so this is the closest signal available.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {consoles.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No Protect console configured</CardTitle>
            <CardDescription>Add one on the Consoles page before discovering sensors.</CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      ) : sensors.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No sensors discovered yet</CardTitle>
            <CardDescription>Click Refresh to discover sensors from your configured console(s).</CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {consoles.map((console_) => {
            const consoleSensors = sensors.filter((s) => s.consoleId === console_.id);
            if (consoleSensors.length === 0) return null;

            const status = consoleStatuses.find((s) => s.consoleId === console_.id);

            // Aggregate observed checkin interval across this console's
            // sensors — each sensor's own interval is now genuinely
            // independent (derived from that specific sensor's real
            // websocket touches, not our shared poll cadence — see
            // singleton.ts's recordSensorCheckin), so the minimum is the
            // most conservative (fastest-expected) read for the
            // console-level staleness check below.
            const observedValues = consoleSensors
              .map((s) => statuses.find((x) => x.sensorId === s.id)?.observedCheckinIntervalSeconds)
              .filter((v): v is number => v != null);
            const observedSeconds = observedValues.length > 0 ? Math.min(...observedValues) : null;
            const badge = reportingBadge(status?.lastEventAt ?? null, observedSeconds);

            return (
              <Card key={console_.id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{console_.name}</CardTitle>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  {/* suppressHydrationWarning — see the Refreshed span above */}
                  <CardDescription
                    title={status?.lastEventAt ? absoluteTimeLabel(status.lastEventAt) : undefined}
                    suppressHydrationWarning
                  >
                    Last contacted: {preciseAgoLabel(status?.lastEventAt ?? null)}
                    {observedSeconds != null && ` · reporting every ~${formatInterval(observedSeconds)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className={`grid gap-3 ${gridColsForCount(consoleSensors.length)}`}>
                    {consoleSensors.map((sensor) => {
                      const sensorStatus = statuses.find((s) => s.sensorId === sensor.id);
                      const sensorBadge = reportingBadge(
                        sensorStatus?.lastSeenAt ?? null,
                        sensorStatus?.observedCheckinIntervalSeconds ?? null
                      );
                      return (
                        <div
                          key={sensor.id}
                          className="flex flex-col items-center gap-1 rounded-lg border border-purple-200/60 bg-purple-50/50 p-3 text-center backdrop-blur-sm dark:border-purple-800/40 dark:bg-purple-950/30"
                        >
                          <p className="text-sm font-medium">{sensor.name}</p>
                          <div className="flex items-center gap-1.5">
                            <BatteryIndicator battery={sensorStatus?.battery ?? null} />
                            <Badge variant={sensorBadge.variant} className="text-[10px]">
                              {sensorBadge.label}
                            </Badge>
                            {/* suppressHydrationWarning — see the Refreshed span above */}
                            <span
                              className="text-[10px] text-muted-foreground"
                              title={sensorStatus?.lastSeenAt ? absoluteTimeLabel(sensorStatus.lastSeenAt) : undefined}
                              suppressHydrationWarning
                            >
                              {preciseAgoLabel(sensorStatus?.lastSeenAt ?? null)}
                              {sensorStatus?.observedCheckinIntervalSeconds != null &&
                                ` · ~${formatInterval(sensorStatus.observedCheckinIntervalSeconds)}`}
                            </span>
                          </div>
                          {sensor.metrics.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No metrics enabled</span>
                          ) : (
                            <div className={`grid justify-items-center gap-1 ${gridColsForCount(sensor.metrics.length)}`}>
                              {sensor.metrics.map((m) => {
                                const value = sensorStatus?.values[m];
                                return (
                                  <Badge key={m} variant="outline" className="gap-1">
                                    <MetricIcon metric={m} />
                                    {value != null ? formatValue(m, value, temperatureUnit) : m}
                                  </Badge>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
