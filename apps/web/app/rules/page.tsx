"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Latch, Sensor } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";

// CRUD over /api/latches — "Rule" is the user-facing name for what the
// domain model (SPEC.md section 4) and API still call a Latch internally;
// the mechanism (arm/clear hysteresis) is the same either way, "Rule" is
// just the friendlier name in the UI. Sensor + metric picker only offers
// metrics a discovered sensor actually exposes (SPEC.md section 12 —
// never hand-typed). Webhook URLs always arrive from the API pre-masked
// (CLAUDE.md obfuscation); this page never has the real value once a rule
// is saved.

type MaskedLatch = Omit<Latch, "webhook" | "resolvedWebhook"> & {
  webhook: Latch["webhook"];
  resolvedWebhook?: Latch["resolvedWebhook"];
};

const emptyForm = {
  sensorId: "",
  metric: "" as Sensor["metrics"][number] | "",
  direction: "above" as Latch["direction"],
  armThreshold: "",
  clearThreshold: "",
  durationSeconds: "",
  webhookUrl: "",
  webhookMethod: "POST" as Latch["webhook"]["method"],
  resolvedWebhookUrl: "",
};

export default function RulesPage() {
  const { user: actor } = useCurrentUser();
  const canEdit = hasRole(actor, "admin");
  const [rules, setRules] = React.useState<MaskedLatch[]>([]);
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const [rulesRes, sensorsRes] = await Promise.all([fetch("/api/latches"), fetch("/api/sensors")]);
    if (rulesRes.ok) setRules((await rulesRes.json()).latches);
    if (sensorsRes.ok) setSensors((await sensorsRes.json()).sensors);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const selectedSensor = sensors.find((s) => s.id === form.sensorId);

  function sensorName(id: string): string {
    return sensors.find((s) => s.id === id)?.name ?? id;
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const armThreshold = Number(form.armThreshold);
      const clearThreshold = form.clearThreshold ? Number(form.clearThreshold) : armThreshold;
      const durationSeconds = Number(form.durationSeconds);
      if (!form.sensorId || !form.metric) throw new Error("sensor and metric are required");
      if (!Number.isFinite(armThreshold) || !Number.isFinite(durationSeconds)) {
        throw new Error("thresholds and duration must be numbers");
      }

      const rule: Latch = {
        id: crypto.randomUUID(),
        sensorId: form.sensorId,
        metric: form.metric as Sensor["metrics"][number],
        direction: form.direction,
        armThreshold,
        clearThreshold,
        durationSeconds,
        webhook: { url: form.webhookUrl, method: form.webhookMethod },
        resolvedWebhook: form.resolvedWebhookUrl
          ? { url: form.resolvedWebhookUrl, method: form.webhookMethod }
          : undefined,
        enabled: true,
      };

      const res = await fetch("/api/latches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create rule");

      setForm(emptyForm);
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(rule: MaskedLatch) {
    await fetch(`/api/latches/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    await load();
  }

  async function deleteRule(id: string) {
    await fetch(`/api/latches/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Rules</h1>
        {canEdit && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" disabled={sensors.length === 0}>
                New Rule
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New rule</DialogTitle>
              </DialogHeader>
              <form className="flex flex-col gap-3" onSubmit={createRule}>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Sensor</label>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    value={form.sensorId}
                    onChange={(e) => setForm({ ...form, sensorId: e.target.value, metric: "" })}
                    required
                  >
                    <option value="" disabled>
                      Select a sensor
                    </option>
                    {sensors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Metric</label>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    value={form.metric}
                    onChange={(e) => setForm({ ...form, metric: e.target.value as Sensor["metrics"][number] })}
                    disabled={!selectedSensor}
                    required
                  >
                    <option value="" disabled>
                      Select a metric
                    </option>
                    {selectedSensor?.metrics.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Direction</label>
                    <select
                      className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                      value={form.direction}
                      onChange={(e) => setForm({ ...form, direction: e.target.value as Latch["direction"] })}
                    >
                      <option value="above">above</option>
                      <option value="below">below</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Duration (seconds)</label>
                    <Input
                      type="number"
                      value={form.durationSeconds}
                      onChange={(e) => setForm({ ...form, durationSeconds: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Arm threshold</label>
                    <Input
                      type="number"
                      value={form.armThreshold}
                      onChange={(e) => setForm({ ...form, armThreshold: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Clear threshold (optional)</label>
                    <Input
                      type="number"
                      value={form.clearThreshold}
                      onChange={(e) => setForm({ ...form, clearThreshold: e.target.value })}
                      placeholder="defaults to arm threshold"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Webhook URL (fired)</label>
                  <Input
                    value={form.webhookUrl}
                    onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
                    placeholder="https://..."
                    required
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Webhook URL (resolved, optional)</label>
                  <Input
                    value={form.resolvedWebhookUrl}
                    onChange={(e) => setForm({ ...form, resolvedWebhookUrl: e.target.value })}
                    placeholder="https://..."
                  />
                </div>

                {error && <p className="text-sm text-red-600">{error}</p>}

                <Button type="submit" disabled={saving}>
                  {saving ? "Creating…" : "Create rule"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {sensors.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No sensors discovered yet</CardTitle>
            <CardDescription>Discover sensors first, then create a rule against one of its metrics.</CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      ) : rules.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No rules yet</CardTitle>
            <CardDescription>Add a sensor first, then create a rule against one of its metrics.</CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sensor</TableHead>
              <TableHead>Metric</TableHead>
              <TableHead>Threshold</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Webhook</TableHead>
              <TableHead>Status</TableHead>
              {canEdit && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell>{sensorName(rule.sensorId)}</TableCell>
                <TableCell>{rule.metric}</TableCell>
                <TableCell>
                  {rule.direction} {rule.armThreshold}
                </TableCell>
                <TableCell>{Math.round(rule.durationSeconds / 60)}m</TableCell>
                <TableCell className="font-mono text-xs">{rule.webhook.url}</TableCell>
                <TableCell>
                  <Badge variant={rule.enabled ? "outline" : "idle"}>{rule.enabled ? "enabled" : "disabled"}</Badge>
                </TableCell>
                {canEdit && (
                  <TableCell className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => toggleEnabled(rule)}>
                      {rule.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                      Delete
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
