"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Latch, LatchStateRecord, Sensor } from "@unifi-sensor-latch/shared";
import { absoluteTimeLabel, formatDuration, preciseAgoLabel } from "@/lib/format";
import { conditionSummary } from "@unifi-sensor-latch/shared";
import { metricUnitSuffix, toDisplayCondition } from "@/lib/units";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { sensorsResponseSchema } from "@/lib/apiSchemas";
import { LiveRelativeTime } from "@/components/live-relative-time";

// Client Component polling /api/state every few seconds — SPEC.md section 5:
// latch state changes on the order of minutes, so polling is simpler than a
// websocket-to-browser layer and sufficient. The engine keeps running
// whether or not this page is open; this is only a window into its state.
const POLL_MS = 5000;

export interface DashboardInitialData {
  rules: Latch[];
  sensors: Sensor[];
  states: LatchStateRecord[];
}

async function fetchJson<T>(url: string, key: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed`);
  return (await res.json())[key];
}

// Seeded from a server-side fetch (see page.tsx) via `initialData` — first
// paint already has real rule cards/state instead of the "No rules
// configured yet" empty state popping in a moment later once the client's
// own fetch resolves. refetchInterval keeps it live from there.
function useLiveState(initial: DashboardInitialData) {
  const rules = useQuery({
    queryKey: ["latches"],
    queryFn: () => fetchJson<Latch[]>("/api/latches", "latches"),
    initialData: initial.rules,
    refetchInterval: POLL_MS,
  });
  // The "sensors" query key is shared with the Sensors/Rules/Consoles
  // pages via the one app-wide QueryClient (see components/query-provider.tsx)
  // — they all fetch and cache the same full /api/sensors body so the
  // shape matches everywhere the key is used, rather than each page
  // caching a different narrowed slice under the same key and clobbering
  // each other's cache entry.
  const sensors = useQuery({
    queryKey: ["sensors"],
    queryFn: async () => {
      const res = await fetch("/api/sensors");
      if (!res.ok) throw new Error("failed to load sensors");
      return sensorsResponseSchema.parse(await res.json());
    },
    initialData: { sensors: initial.sensors, statuses: [] },
    refetchInterval: POLL_MS,
  });
  const states = useQuery({
    queryKey: ["state"],
    queryFn: () => fetchJson<LatchStateRecord[]>("/api/state", "states"),
    initialData: initial.states,
    refetchInterval: POLL_MS,
  });

  return { rules: rules.data, sensors: sensors.data.sensors, states: states.data };
}

export function DashboardClient({ initial }: { initial: DashboardInitialData }) {
  const { user: actor } = useCurrentUser();
  const temperatureUnit = actor?.temperatureUnit ?? "C";
  const { rules, sensors, states } = useLiveState(initial);
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
            The engine is running independently of this page. This is only a window into its state.
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
                {/* The "X ago" suffix is computed from a live clock (see
                    LiveRelativeTime/useNow) at render time, so the
                    server's render and the client's first-paint render a
                    moment later will almost always differ by a second or
                    two — that's expected, not a bug. */}
                <CardDescription title={sinceTimestamp ? absoluteTimeLabel(sinceTimestamp) : undefined}>
                  {rule.metric}{" "}
                  {rule.metric === "leak"
                    ? "detected"
                    : conditionSummary(
                        toDisplayCondition(rule.condition, rule.metric, temperatureUnit),
                        metricUnitSuffix(rule.metric, temperatureUnit)
                      )}
                  {sinceTimestamp && (
                    <>
                      {" · "}
                      <LiveRelativeTime timestamp={sinceTimestamp} format={preciseAgoLabel} />
                    </>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Arms for {formatDuration(rule.durationSeconds)} before firing.
                {!rule.enabled && <div className="mt-1 text-amber-600 dark:text-amber-400">Disabled</div>}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
