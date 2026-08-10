"use client";

import * as React from "react";
import { Droplets, Sun, Thermometer, TriangleAlert, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConsoleStatus, ProtectConsole, Sensor, SensorStatus } from "@unifi-sensor-latch/shared";
import { DURATION_PRESETS, effectiveInterval } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { usePausedWhileSelectFocused } from "@/lib/usePausedWhileSelectFocused";
import { absoluteTimeLabel, preciseAgoLabel, useNowTick } from "@/lib/format";

// Discovery-driven — SPEC.md section 12: sensors are never hand-typed, only
// ever listed from what /api/sensors/discover found on a configured
// console. If no console is configured yet, this page points to Consoles.
//
// Grouped by console, one card per console containing its sensors —
// reporting status ("last contacted"/"reporting every"/good-delayed-
// overdue) is shown once per console, not once per sensor, because
// that's genuinely what it is: sensors are always fetched in one bulk
// GET /v1/sensors call per console, so every sensor on a console shares
// the exact same "when did we last hear anything" and "how often does
// that happen" answer. Showing it per-sensor was redundant and implied a
// per-sensor cadence that was never real.
const POLL_MS = 5000;
const INTERVAL_PRESETS = DURATION_PRESETS;

function formatInterval(seconds: number): string {
  const preset = INTERVAL_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// Color reflects staleness relative to the console's effective interval
// (observed > console-default — see interval.ts). useNowTick (called in
// the page component) re-renders this every second regardless of the 5s
// data-poll cadence, specifically so a client that hasn't checked in for
// a few seconds can never be the reason something looks stale — elapsed
// time is always computed against the real clock at render time, not
// against when data last arrived over the wire.
const GOOD_MULTIPLIER = 1.5; // within/close to the expected window
const WARN_MULTIPLIER = 3; // "delayed" — user's explicit 3x threshold

function reportingBadge(
  lastEventAt: number | null,
  observedSeconds: number | null,
  defaultIntervalSeconds: number
): { variant: "idle" | "good" | "armed" | "fired"; label: string } {
  if (!lastEventAt) return { variant: "idle", label: "no data yet" };

  const expectedSeconds = effectiveInterval(observedSeconds, defaultIntervalSeconds).seconds;
  const elapsedSeconds = (Date.now() - lastEventAt) / 1000;

  if (elapsedSeconds <= expectedSeconds * GOOD_MULTIPLIER) return { variant: "good", label: "reporting" };
  if (elapsedSeconds <= expectedSeconds * WARN_MULTIPLIER) return { variant: "armed", label: "delayed" };
  return { variant: "fired", label: "overdue" };
}

// Sensor values are always stored/evaluated in Celsius (SPEC.md) — unit is
// a display-only conversion, applied here only, driven by the signed-in
// user's saved preference (see temperature-unit-toggle.tsx).
function formatValue(metric: string, value: number, temperatureUnit: "C" | "F"): string {
  switch (metric) {
    case "temperature": {
      if (temperatureUnit === "F") return `${((value * 9) / 5 + 32).toFixed(1)}°F`;
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

export default function SensorsPage() {
  useNowTick(); // keeps "last contacted"/"refreshed" ticking live, second-by-second
  const { user: actor } = useCurrentUser();
  const temperatureUnit = actor?.temperatureUnit ?? "C";
  const canDiscover = hasRole(actor, "admin");
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [statuses, setStatuses] = React.useState<SensorStatus[]>([]);
  const [consoles, setConsoles] = React.useState<ProtectConsole[]>([]);
  const [consoleStatuses, setConsoleStatuses] = React.useState<ConsoleStatus[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    const [sensorsRes, consolesRes] = await Promise.all([fetch("/api/sensors"), fetch("/api/consoles")]);
    if (sensorsRes.ok) {
      const body = await sensorsRes.json();
      setSensors(body.sensors);
      setStatuses(body.statuses);
    }
    if (consolesRes.ok) {
      const body = await consolesRes.json();
      setConsoles(body.consoles);
      setConsoleStatuses(body.statuses);
    }
  }, []);

  // See usePausedWhileSelectFocused's doc comment — avoids a real Firefox
  // crash when a poll-driven re-render mutates a <select> while its
  // dropdown popup is open. Read via a ref so focus/blur doesn't tear
  // down and recreate the interval on every keystroke.
  const paused = usePausedWhileSelectFocused();
  const pausedRef = React.useRef(paused);
  React.useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  React.useEffect(() => {
    load();
    const id = setInterval(() => {
      if (!pausedRef.current) load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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
  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sensors/discover", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "discovery failed");
      if (body.errors?.length) setError(body.errors.join("; "));
      await load();
      setLastRefreshedAt(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[sensors] refresh failed:", err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sensors</h1>
        {canDiscover && (
          <div className="flex items-center gap-2">
            {lastRefreshedAt && !loading && (
              <span className="text-xs text-muted-foreground" title={absoluteTimeLabel(lastRefreshedAt)}>
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

            // Aggregate observed interval across this console's sensors —
            // they all update together in one bulk fetch, so per-sensor
            // observed values are redundant copies of the same signal;
            // the minimum is the most conservative (fastest-expected)
            // read for the staleness check below.
            const observedValues = consoleSensors.flatMap((s) => {
              const st = statuses.find((x) => x.sensorId === s.id);
              return st ? Object.values(st.observedIntervalSeconds).filter((v): v is number => v != null) : [];
            });
            const observedSeconds = observedValues.length > 0 ? Math.min(...observedValues) : null;
            const badge = reportingBadge(status?.lastEventAt ?? null, observedSeconds, console_.defaultIntervalSeconds);

            return (
              <Card key={console_.id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{console_.name}</CardTitle>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <CardDescription title={status?.lastEventAt ? absoluteTimeLabel(status.lastEventAt) : undefined}>
                    Last contacted: {preciseAgoLabel(status?.lastEventAt ?? null)}
                    {observedSeconds != null && ` · reporting every ~${formatInterval(observedSeconds)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {consoleSensors.map((sensor) => {
                      const sensorStatus = statuses.find((s) => s.sensorId === sensor.id);
                      return (
                        <div
                          key={sensor.id}
                          className="flex flex-col items-center gap-2 rounded-lg border border-purple-200/60 bg-purple-50/50 p-3 text-center backdrop-blur-sm dark:border-purple-800/40 dark:bg-purple-950/30"
                        >
                          <p className="text-sm font-medium">{sensor.name}</p>
                          {sensor.metrics.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No metrics enabled</span>
                          ) : (
                            <div className="flex flex-wrap justify-center gap-1">
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
