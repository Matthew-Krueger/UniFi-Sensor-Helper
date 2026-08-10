"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Latch, Metric, ProtectConsole, RangeHysteresis, RuleCondition, Sensor, SensorStatus } from "@unifi-sensor-latch/shared";
import {
  DURATION_PRESETS,
  conditionSummary,
  effectiveInterval,
  isDurationValid,
  validateCondition,
} from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { metricUnitSuffix, toDisplayCondition, toStoredValue } from "@/lib/units";

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

type ConditionType = "above" | "below" | "between";
type HysteresisMode = "manual" | "auto";

const emptyForm = {
  sensorId: "",
  metric: "" as Sensor["metrics"][number] | "",
  conditionType: "above" as ConditionType,
  threshold: "", // above/below
  low: "", // between
  high: "", // between
  hysteresisMode: "manual" as HysteresisMode, // between only — above/below is always manual
  clearThreshold: "", // above/below manual clear (optional, defaults to threshold)
  clearLow: "", // between manual
  clearHigh: "", // between manual
  marginPercent: "", // between auto
  durationSeconds: "" as number | "",
  webhookUrl: "",
  webhookMethod: "POST" as Latch["webhook"]["method"],
  resolvedWebhookUrl: "",
};

export default function RulesPage() {
  const { user: actor } = useCurrentUser();
  const canEdit = hasRole(actor, "admin");
  const temperatureUnit = actor?.temperatureUnit ?? "C";
  const [rules, setRules] = React.useState<MaskedLatch[]>([]);
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [sensorStatuses, setSensorStatuses] = React.useState<SensorStatus[]>([]);
  const [consoles, setConsoles] = React.useState<ProtectConsole[]>([]);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const [rulesRes, sensorsRes, consolesRes] = await Promise.all([
      fetch("/api/latches"),
      fetch("/api/sensors"),
      fetch("/api/consoles"),
    ]);
    if (rulesRes.ok) setRules((await rulesRes.json()).latches);
    if (sensorsRes.ok) {
      const body = await sensorsRes.json();
      setSensors(body.sensors);
      setSensorStatuses(body.statuses);
    }
    if (consolesRes.ok) setConsoles((await consolesRes.json()).consoles);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const selectedSensor = sensors.find((s) => s.id === form.sensorId);
  const unitSuffix = form.metric ? metricUnitSuffix(form.metric as Metric, temperatureUnit) : "";

  function sensorName(id: string): string {
    return sensors.find((s) => s.id === id)?.name ?? id;
  }

  // Same priority as the server-side check (see /api/latches's route) —
  // observed interval (real measured gap) beats the owning console's
  // default. Used only to grey out too-short duration presets before
  // submit; the server-side check in /api/latches is the actual gate
  // (CLAUDE.md trust boundaries).
  const selectedInterval = React.useMemo(() => {
    if (!selectedSensor || !form.metric) return null;
    const console_ = consoles.find((c) => c.id === selectedSensor.consoleId);
    if (!console_) return null;
    const observed = sensorStatuses.find((s) => s.sensorId === selectedSensor.id)?.observedIntervalSeconds[
      form.metric
    ];
    return effectiveInterval(observed, console_.defaultIntervalSeconds);
  }, [selectedSensor, form.metric, consoles, sensorStatuses]);

  // Fields are typed in the user's display unit (e.g. Fahrenheit) — convert
  // to the storage/evaluation unit (always Celsius for temperature) before
  // building the condition that gets sent to the API.
  function buildCondition(): RuleCondition {
    const metric = form.metric as Metric;
    const toStored = (v: number) => toStoredValue(metric, v, temperatureUnit);

    if (form.conditionType === "between") {
      const low = toStored(Number(form.low));
      const high = toStored(Number(form.high));
      if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error("low and high bounds must be numbers");

      const hysteresis: RangeHysteresis =
        form.hysteresisMode === "auto"
          ? { mode: "auto", marginPercent: Number(form.marginPercent) }
          : {
              mode: "manual",
              clearLow: form.clearLow ? toStored(Number(form.clearLow)) : low,
              clearHigh: form.clearHigh ? toStored(Number(form.clearHigh)) : high,
            };
      return { type: "between", low, high, hysteresis };
    }

    const threshold = toStored(Number(form.threshold));
    if (!Number.isFinite(threshold)) throw new Error("threshold must be a number");
    const clearThreshold = form.clearThreshold ? toStored(Number(form.clearThreshold)) : threshold;
    return { type: form.conditionType, threshold, hysteresis: { mode: "manual", clearThreshold } };
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (!form.sensorId || !form.metric) throw new Error("sensor and metric are required");
      if (form.durationSeconds === "") throw new Error("duration is required");
      const durationSeconds = form.durationSeconds;

      const condition = buildCondition();
      const conditionCheck = validateCondition(condition);
      if (!conditionCheck.valid) throw new Error(conditionCheck.error);

      if (selectedInterval && !isDurationValid(durationSeconds, selectedInterval)) {
        throw new Error("selected duration is too short for this sensor's reporting interval");
      }

      const rule: Latch = {
        id: crypto.randomUUID(),
        sensorId: form.sensorId,
        metric: form.metric as Sensor["metrics"][number],
        condition,
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
                    onChange={(e) => setForm({ ...form, sensorId: e.target.value, metric: "", durationSeconds: "" })}
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
                    onChange={(e) =>
                      setForm({ ...form, metric: e.target.value as Sensor["metrics"][number], durationSeconds: "" })
                    }
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

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Condition</label>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    value={form.conditionType}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        conditionType: e.target.value as ConditionType,
                        hysteresisMode: "manual",
                      })
                    }
                  >
                    <option value="above">is above</option>
                    <option value="below">is below</option>
                    <option value="between">is between</option>
                  </select>
                </div>

                {form.conditionType === "between" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-muted-foreground">Low bound{unitSuffix && ` (${unitSuffix})`}</label>
                      <Input
                        type="number"
                        value={form.low}
                        onChange={(e) => setForm({ ...form, low: e.target.value })}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-muted-foreground">High bound{unitSuffix && ` (${unitSuffix})`}</label>
                      <Input
                        type="number"
                        value={form.high}
                        onChange={(e) => setForm({ ...form, high: e.target.value })}
                        required
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Threshold{unitSuffix && ` (${unitSuffix})`}</label>
                    <Input
                      type="number"
                      value={form.threshold}
                      onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                      required
                    />
                  </div>
                )}

                {form.conditionType === "between" ? (
                  <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      The alarm releases once the reading moves back outside this range by enough to count as
                      recovered — set that recovery point manually, or let it expand automatically by a percentage.
                    </p>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={form.hysteresisMode === "manual" ? "default" : "outline"}
                        onClick={() => setForm({ ...form, hysteresisMode: "manual" })}
                      >
                        Manual
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={form.hysteresisMode === "auto" ? "default" : "outline"}
                        onClick={() => setForm({ ...form, hysteresisMode: "auto" })}
                      >
                        Auto
                      </Button>
                    </div>
                    {form.hysteresisMode === "manual" ? (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-muted-foreground">
                            Releases below{unitSuffix && ` (${unitSuffix})`}
                          </label>
                          <Input
                            type="number"
                            value={form.clearLow}
                            onChange={(e) => setForm({ ...form, clearLow: e.target.value })}
                            placeholder="defaults to low bound"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-muted-foreground">
                            Releases above{unitSuffix && ` (${unitSuffix})`}
                          </label>
                          <Input
                            type="number"
                            value={form.clearHigh}
                            onChange={(e) => setForm({ ...form, clearHigh: e.target.value })}
                            placeholder="defaults to high bound"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">Release margin (%)</label>
                        <Input
                          type="number"
                          value={form.marginPercent}
                          onChange={(e) => setForm({ ...form, marginPercent: e.target.value })}
                          placeholder="e.g. 5"
                          required
                        />
                        <p className="text-xs text-muted-foreground">
                          Expands the range outward by this percent of its width on both sides before it counts as
                          released.
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">
                      Alarm releases at{unitSuffix && ` (${unitSuffix})`} (optional)
                    </label>
                    <Input
                      type="number"
                      value={form.clearThreshold}
                      onChange={(e) => setForm({ ...form, clearThreshold: e.target.value })}
                      placeholder="defaults to the threshold above"
                    />
                    <p className="text-xs text-muted-foreground">
                      This is the point at which the alarm releases once fired. If left blank, it releases as soon
                      as the reading crosses back over the threshold itself.
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">
                    Duration (armed for at least this long before firing)
                  </label>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    value={form.durationSeconds}
                    onChange={(e) => setForm({ ...form, durationSeconds: Number(e.target.value) })}
                    required
                  >
                    <option value="" disabled>
                      Select a duration
                    </option>
                    {DURATION_PRESETS.map((p) => {
                      const tooShort = selectedInterval ? p.seconds < selectedInterval.seconds : false;
                      return (
                        <option key={p.seconds} value={p.seconds} disabled={tooShort}>
                          {p.label}
                          {tooShort ? " (too short for this sensor)" : ""}
                        </option>
                      );
                    })}
                  </select>
                  {selectedInterval && (
                    <p className="text-xs text-muted-foreground">
                      This sensor's effective reporting interval is ~{selectedInterval.seconds}s (
                      {selectedInterval.source.replace("-", " ")}) — durations shorter than that are disabled
                      above.
                    </p>
                  )}
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
              <TableHead>Condition</TableHead>
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
                  {conditionSummary(
                    toDisplayCondition(rule.condition, rule.metric, temperatureUnit),
                    metricUnitSuffix(rule.metric, temperatureUnit)
                  )}
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
