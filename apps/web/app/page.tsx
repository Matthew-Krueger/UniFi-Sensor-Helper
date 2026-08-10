"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Latch, LatchStateRecord, Sensor } from "@unifi-sensor-latch/shared";

// Client Component polling /api/state every few seconds — SPEC.md section 5:
// latch state changes on the order of minutes, so polling is simpler than a
// websocket-to-browser layer and sufficient. The engine keeps running
// whether or not this page is open; this is only a window into its state.
const POLL_MS = 5000;

function useLiveState() {
  const [latches, setLatches] = React.useState<Latch[]>([]);
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [states, setStates] = React.useState<LatchStateRecord[]>([]);

  React.useEffect(() => {
    let cancelled = false;

    async function poll() {
      const [latchesRes, sensorsRes, stateRes] = await Promise.all([
        fetch("/api/latches"),
        fetch("/api/sensors"),
        fetch("/api/state"),
      ]);
      if (cancelled) return;
      if (latchesRes.ok) setLatches((await latchesRes.json()).latches);
      if (sensorsRes.ok) setSensors((await sensorsRes.json()).sensors);
      if (stateRes.ok) setStates((await stateRes.json()).states);
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { latches, sensors, states };
}

function sinceLabel(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function DashboardPage() {
  const { latches, sensors, states } = useLiveState();
  const sensorName = (id: string) => sensors.find((s) => s.id === id)?.name ?? id;
  const stateFor = (latchId: string) => states.find((s) => s.latchId === latchId);

  if (latches.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Card>
          <CardHeader>
            <CardTitle>No latches configured yet</CardTitle>
            <CardDescription>Add sensors and latches to see live state here.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The latch engine is running independently of this page — this is only a window into its state.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {latches.map((latch) => {
          const state = stateFor(latch.id);
          const label = state?.state ?? "idle";
          const since = sinceLabel(label === "armed" ? state?.armedAt ?? null : state?.firedAt ?? null);
          return (
            <Card key={latch.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{sensorName(latch.sensorId)}</CardTitle>
                  <Badge variant={label as "idle" | "armed" | "fired"}>{label}</Badge>
                </div>
                <CardDescription>
                  {latch.metric} {latch.direction} {latch.armThreshold}
                  {since ? ` · ${since}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Arms for {Math.round(latch.durationSeconds / 60)}m before firing.
                {!latch.enabled && <div className="mt-1 text-amber-600 dark:text-amber-400">Disabled</div>}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
