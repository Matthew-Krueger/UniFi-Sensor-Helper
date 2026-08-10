"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Latch, LatchStateRecord, Sensor } from "@unifi-sensor-latch/shared";
import { absoluteTimeLabel, preciseAgoLabel, useNowTick } from "@/lib/format";
import { conditionSummary } from "@unifi-sensor-latch/shared";

// Client Component polling /api/state every few seconds — SPEC.md section 5:
// latch state changes on the order of minutes, so polling is simpler than a
// websocket-to-browser layer and sufficient. The engine keeps running
// whether or not this page is open; this is only a window into its state.
const POLL_MS = 5000;

function useLiveState() {
  const [rules, setRules] = React.useState<Latch[]>([]);
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [states, setStates] = React.useState<LatchStateRecord[]>([]);

  React.useEffect(() => {
    let cancelled = false;

    async function poll() {
      const [rulesRes, sensorsRes, stateRes] = await Promise.all([
        fetch("/api/latches"),
        fetch("/api/sensors"),
        fetch("/api/state"),
      ]);
      if (cancelled) return;
      if (rulesRes.ok) setRules((await rulesRes.json()).latches);
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

  return { rules, sensors, states };
}

export default function DashboardPage() {
  useNowTick(); // keeps armed/fired "since" timing ticking live, second-by-second
  const { rules, sensors, states } = useLiveState();
  const sensorName = (id: string) => sensors.find((s) => s.id === id)?.name ?? id;
  const stateFor = (ruleId: string) => states.find((s) => s.latchId === ruleId);

  if (rules.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Card>
          <CardHeader>
            <CardTitle>No rules configured yet</CardTitle>
            <CardDescription>Add sensors and rules to see live state here.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The engine is running independently of this page — this is only a window into its state.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rules.map((rule) => {
          const state = stateFor(rule.id);
          const label = state?.state ?? "idle";
          const sinceTimestamp = label === "armed" ? state?.armedAt ?? null : state?.firedAt ?? null;
          return (
            <Card key={rule.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{sensorName(rule.sensorId)}</CardTitle>
                  <Badge variant={label as "idle" | "armed" | "fired"}>{label}</Badge>
                </div>
                <CardDescription title={sinceTimestamp ? absoluteTimeLabel(sinceTimestamp) : undefined}>
                  {rule.metric} {conditionSummary(rule.condition)}
                  {sinceTimestamp ? ` · ${preciseAgoLabel(sinceTimestamp)}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Arms for {Math.round(rule.durationSeconds / 60)}m before firing.
                {!rule.enabled && <div className="mt-1 text-amber-600 dark:text-amber-400">Disabled</div>}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
