"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProtectConsole, Sensor, SensorStatus } from "@unifi-sensor-latch/shared";
import { DURATION_PRESETS } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { usePausedWhileSelectFocused } from "@/lib/usePausedWhileSelectFocused";

// Discovery-driven — SPEC.md section 12: sensors are never hand-typed, only
// ever listed from what /api/sensors/discover found on a configured
// console. If no console is configured yet, this page points to Consoles.
const POLL_MS = 5000;
const INTERVAL_PRESETS = DURATION_PRESETS;

function agoLabel(timestamp: number | null): string {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function formatInterval(seconds: number): string {
  const preset = INTERVAL_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function formatValue(metric: string, value: number): string {
  switch (metric) {
    case "temperature":
      return `${value.toFixed(1)}°C`;
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

export default function SensorsPage() {
  const { user: actor } = useCurrentUser();
  const canDiscover = hasRole(actor, "admin");
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [statuses, setStatuses] = React.useState<SensorStatus[]>([]);
  const [consoles, setConsoles] = React.useState<ProtectConsole[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [sensorsRes, consolesRes] = await Promise.all([fetch("/api/sensors"), fetch("/api/consoles")]);
    if (sensorsRes.ok) {
      const body = await sensorsRes.json();
      setSensors(body.sensors);
      setStatuses(body.statuses);
    }
    if (consolesRes.ok) setConsoles((await consolesRes.json()).consoles);
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

  async function setExpectedInterval(sensorId: string, seconds: number | null) {
    await fetch(`/api/sensors/${sensorId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedIntervalSeconds: seconds }),
    });
    await load();
  }

  // "Refresh" is a manual, on-demand refetch: it re-runs discovery
  // (picks up any newly added/removed physical sensors — see
  // SPEC.md section 12) and then reloads the full page state (sensor
  // list + live status/values), same data the 5s poll would eventually
  // bring in, just immediately. It only reads and writes sensor metadata
  // — it never touches latch_state or evaluates any rule.
  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sensors/discover", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "discovery failed");
      if (body.errors?.length) setError(body.errors.join("; "));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sensors</h1>
        {canDiscover && (
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading || consoles.length === 0}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sensors.map((sensor) => {
            const status = statuses.find((s) => s.sensorId === sensor.id);
            return (
              <Card key={sensor.id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">{sensor.name}</CardTitle>
                    <Badge variant={status?.lastSeenAt ? "outline" : "idle"}>
                      {status?.lastSeenAt ? "reporting" : "no data yet"}
                    </Badge>
                  </div>
                  <CardDescription>Last contacted: {agoLabel(status?.lastSeenAt ?? null)}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {sensor.metrics.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No metrics enabled on this device</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {sensor.metrics.map((m) => {
                        const value = status?.values[m];
                        const observed = status?.observedIntervalSeconds[m];
                        return (
                          <div key={m} className="flex flex-wrap items-center gap-1">
                            <Badge variant="outline">
                              {m}
                              {value != null ? `: ${formatValue(m, value)}` : ""}
                            </Badge>
                            {observed != null && (
                              <span className="text-xs text-muted-foreground">
                                reporting every ~{formatInterval(observed)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {canDiscover && (
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Expected interval override:</span>
                      <select
                        className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        value={sensor.expectedIntervalSeconds ?? ""}
                        onChange={(e) =>
                          setExpectedInterval(sensor.id, e.target.value === "" ? null : Number(e.target.value))
                        }
                      >
                        <option value="">Use console default</option>
                        {INTERVAL_PRESETS.map((p) => (
                          <option key={p.seconds} value={p.seconds}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
