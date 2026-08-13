"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Latch, LatchStateRecord, LatchStats, LatchStatsWindowKey, Sensor } from "@unifi-sensor-latch/shared";
import { absoluteTimeLabel, formatDuration, preciseAgoLabel } from "@/lib/format";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { sensorsResponseSchema } from "@/lib/apiSchemas";
import { LiveRelativeTime } from "@/components/live-relative-time";
import { ruleDescription } from "@/lib/ruleDescription";

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

  const [statsByLatchId, setStatsByLatchId] = React.useState<Record<string, LatchStats | null>>({});

  React.useEffect(() => {
    let cancelled = false;
    async function loadStats() {
      const entries = await Promise.all(
        rules.map(async (rule) => {
          const res = await fetch(`/api/latches/${rule.id}/stats`);
          if (!res.ok) return [rule.id, null] as const;
          const data = await res.json();
          return [rule.id, data.stats as LatchStats] as const;
        })
      );
      if (!cancelled) setStatsByLatchId(Object.fromEntries(entries));
    }
    loadStats();
    return () => {
      cancelled = true;
    };
  }, [rules]);

  async function clearStats(latchId: string, latchName: string | null) {
    const label = latchName ?? "this rule";
    if (!window.confirm(`This permanently deletes history for ${label}. This cannot be undone.`)) return;
    await fetch(`/api/latches/${latchId}/stats?action=clear`, { method: "POST" });
    const res = await fetch(`/api/latches/${latchId}/stats`);
    if (res.ok) {
      const data = await res.json();
      setStatsByLatchId((prev) => ({ ...prev, [latchId]: data.stats }));
    }
  }

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
                  <CardTitle className="text-base">{rule.name || "Unnamed"}</CardTitle>
                  <Badge variant={label as "idle" | "armed" | "fired"}>{label}</Badge>
                </div>
                {/* The "X ago" suffix is computed from a live clock (see
                    LiveRelativeTime/useNow) at render time, so the
                    server's render and the client's first-paint render a
                    moment later will almost always differ by a second or
                    two — that's expected, not a bug. */}
                <CardDescription title={sinceTimestamp ? absoluteTimeLabel(sinceTimestamp) : undefined}>
                  {ruleDescription(rule, sensorName(rule.sensorId), temperatureUnit)}
                  {sinceTimestamp && (
                    <>
                      {" · "}
                      <LiveRelativeTime timestamp={sinceTimestamp} format={preciseAgoLabel} />
                    </>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {!rule.enabled && <div className="text-amber-600 dark:text-amber-400">Disabled</div>}
                {statsByLatchId[rule.id] && (
                  <LatchStatsPanel
                    stats={statsByLatchId[rule.id]!}
                    canClear={!!actor && hasRole(actor, "superadmin")}
                    onClear={() => clearStats(rule.id, rule.name)}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// Windows shown in the table. "All time" is dropped from the table itself
// to cut a column — it's still available via the underlying LatchStats
// object if it's ever needed elsewhere, it just doesn't need to sit next
// to the three shorter, more actionable windows every time.
const TABLE_WINDOWS: LatchStatsWindowKey[] = ["1d", "7d", "30d", "365d"];

// Collapsed by default: the counters/durations are useful but secondary to
// current status, and showing all of it inline on every card at once was
// what made the dashboard feel cluttered. One click reveals the full
// breakdown per rule.
function LatchStatsPanel({
  stats,
  canClear,
  onClear,
}: {
  stats: LatchStats;
  canClear: boolean;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        className="text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide stats" : "Show stats"}
      </button>
      {expanded && (
        <div className="mt-2 text-muted-foreground">
          <div className="grid grid-cols-5 gap-x-2 gap-y-1.5">
            <div />
            {TABLE_WINDOWS.map((window) => (
              <div key={window} className="text-center font-medium">
                {window}
              </div>
            ))}
            <StatsRow label="Armed" stats={stats} field="armedCount" format={(n) => String(n)} />
            <StatsRow label="Fired" stats={stats} field="firedCount" format={(n) => String(n)} />
            <StatsRow label="Idle" stats={stats} field="idleCount" format={(n) => String(n)} />
            <StatsRow label="Time armed" stats={stats} field="armedSeconds" format={formatDuration} />
            <StatsRow label="Time fired" stats={stats} field="firedSeconds" format={formatDuration} />
          </div>
          {canClear && (
            <Button variant="outline" size="sm" className="mt-2" onClick={onClear}>
              Clear stats
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function StatsRow({
  label,
  stats,
  field,
  format,
}: {
  label: string;
  stats: LatchStats;
  field: keyof LatchStats["1d"];
  format: (n: number) => string;
}) {
  return (
    <>
      <div>{label}</div>
      {TABLE_WINDOWS.map((window) => (
        <div key={window} className="text-center">
          {format(stats[window][field])}
        </div>
      ))}
    </>
  );
}
