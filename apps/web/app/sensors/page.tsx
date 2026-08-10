"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProtectConsole, Sensor } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";

// Discovery-driven — SPEC.md section 12: sensors are never hand-typed, only
// ever listed from what /api/sensors/discover found on a configured
// console. If no console is configured yet, this page points to Settings.

export default function SensorsPage() {
  const { user: actor } = useCurrentUser();
  const canDiscover = hasRole(actor, "admin");
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [consoles, setConsoles] = React.useState<ProtectConsole[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [sensorsRes, consolesRes] = await Promise.all([fetch("/api/sensors"), fetch("/api/consoles")]);
    if (sensorsRes.ok) setSensors((await sensorsRes.json()).sensors);
    if (consolesRes.ok) setConsoles((await consolesRes.json()).consoles);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sensors/discover", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "discovery failed");
      setSensors(body.sensors);
      if (body.errors?.length) setError(body.errors.join("; "));
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
            <CardDescription>Add one on the Settings page before discovering sensors.</CardDescription>
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
          {sensors.map((sensor) => (
            <Card key={sensor.id}>
              <CardHeader>
                <CardTitle className="text-base">{sensor.name}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1">
                {sensor.metrics.length === 0 ? (
                  <span className="text-sm text-muted-foreground">No metrics enabled on this device</span>
                ) : (
                  sensor.metrics.map((m) => (
                    <Badge key={m} variant="outline">
                      {m}
                    </Badge>
                  ))
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
