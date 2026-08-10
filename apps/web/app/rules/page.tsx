"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type {
  Latch,
  Metric,
  ProtectConsole,
  RangeHysteresis,
  RuleCondition,
  Sensor,
  SensorStatus,
  WebhookDelivery,
  WebhookTarget,
} from "@unifi-sensor-latch/shared";
import {
  DURATION_PRESETS,
  buildConsoleWebhookUrl,
  conditionSummary,
  effectiveInterval,
  isDurationValid,
  validateCondition,
  validateWebhookTarget,
} from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { metricUnitSuffix, toDisplayCondition, toStoredValue } from "@/lib/units";
import { absoluteTimeLabel, preciseAgoLabel, useNowTick } from "@/lib/format";

// CRUD over /api/latches — "Rule" is the user-facing name for what the
// domain model (SPEC.md section 4) and API still call a Latch internally;
// the mechanism (arm/clear hysteresis) is the same either way, "Rule" is
// just the friendlier name in the UI. Sensor + metric picker only offers
// metrics a discovered sensor actually exposes (SPEC.md section 12 —
// never hand-typed). Webhook URLs arrive from the API masked only for the
// read-only "user" role (CLAUDE.md's obfuscation exception) — admin sees
// the real value, since it can already create/edit/delete/test rules.
type RuleRow = Omit<Latch, "webhook" | "resolvedWebhook"> & {
  webhook: Latch["webhook"];
  resolvedWebhook?: Latch["resolvedWebhook"];
};

type ConditionType = "above" | "below" | "between";
type HysteresisMode = "manual" | "auto";

// Form-local shape for one webhook (fired or resolved) — flat so every
// field has a plain string/select-friendly value regardless of which
// WebhookTarget kind is selected; buildWebhookTarget below narrows it
// back down to the real union on submit. "console" is the default kind:
// it's this app's primary intended path (SPEC.md section 7 — Protect's
// own Alarm Manager does the actual notification delivery), not just one
// option among equals.
interface WebhookFormValue {
  kind: "console" | "custom";
  consoleId: string;
  webhookId: string;
  url: string;
  method: "GET" | "POST";
  bearerToken: string; // never prefilled on edit — see openEditDialog
}

function emptyWebhookFormValue(): WebhookFormValue {
  return { kind: "console", consoleId: "", webhookId: "", url: "", method: "POST", bearerToken: "" };
}

// bearerToken is deliberately left blank even when editing an existing
// custom webhook that has one — GET /api/latches always masks it (see
// latchRedaction.ts), so there's no real value to prefill; the field's
// placeholder explains that blank means "keep the existing token."
function webhookFormValueFromTarget(target: WebhookTarget | undefined): WebhookFormValue {
  if (!target) return emptyWebhookFormValue();
  if (target.kind === "console") {
    return { kind: "console", consoleId: target.consoleId, webhookId: target.webhookId, url: "", method: "POST", bearerToken: "" };
  }
  return { kind: "custom", consoleId: "", webhookId: "", url: target.url, method: target.method, bearerToken: "" };
}

function buildWebhookTarget(v: WebhookFormValue): WebhookTarget {
  if (v.kind === "console") {
    return { kind: "console", consoleId: v.consoleId, webhookId: v.webhookId };
  }
  return { kind: "custom", url: v.url, method: v.method, bearerToken: v.bearerToken || undefined };
}

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
  webhook: emptyWebhookFormValue(),
  resolvedWebhookEnabled: false,
  resolvedWebhook: emptyWebhookFormValue(),
  enabled: true,
};

type FormState = typeof emptyForm;

// Reverse of buildCondition — populates the edit form's fields (in the
// user's display unit) from an existing rule's stored (always-Celsius)
// condition.
function conditionToFormFields(condition: RuleCondition): Partial<FormState> {
  if (condition.type === "between") {
    return {
      conditionType: "between",
      low: String(condition.low),
      high: String(condition.high),
      threshold: "",
      clearThreshold: "",
      hysteresisMode: condition.hysteresis.mode,
      clearLow: condition.hysteresis.mode === "manual" ? String(condition.hysteresis.clearLow) : "",
      clearHigh: condition.hysteresis.mode === "manual" ? String(condition.hysteresis.clearHigh) : "",
      marginPercent: condition.hysteresis.mode === "auto" ? String(condition.hysteresis.marginPercent) : "",
    };
  }
  return {
    conditionType: condition.type,
    threshold: String(condition.threshold),
    low: "",
    high: "",
    hysteresisMode: "manual",
    clearLow: "",
    clearHigh: "",
    marginPercent: "",
    clearThreshold: String(condition.hysteresis.clearThreshold),
  };
}

function deliveryBadgeVariant(delivery: WebhookDelivery): "good" | "fired" {
  return delivery.ok ? "good" : "fired";
}

function consoleWebhookLabel(target: Extract<WebhookTarget, { kind: "console" }>, consoles: ProtectConsole[]): string {
  const name = consoles.find((c) => c.id === target.consoleId)?.name ?? "unknown console";
  return `Console: ${name} / ${target.webhookId}`;
}

// Shared by the fired and resolved webhook sections of the rule form —
// same kind/console/URL/token fields either way, just a different label
// prefix and value/onChange pair.
function WebhookFieldsEditor({
  label,
  value,
  onChange,
  consoles,
  editing,
}: {
  label: string;
  value: WebhookFormValue;
  onChange: (next: WebhookFormValue) => void;
  consoles: ProtectConsole[];
  editing: boolean;
}) {
  const selectedConsole = consoles.find((c) => c.id === value.consoleId);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={value.kind === "console" ? "default" : "outline"}
            onClick={() => onChange({ ...value, kind: "console" })}
          >
            Console
          </Button>
          <Button
            type="button"
            size="sm"
            variant={value.kind === "custom" ? "default" : "outline"}
            onClick={() => onChange({ ...value, kind: "custom" })}
          >
            Custom
          </Button>
        </div>
      </div>

      {value.kind === "console" ? (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Console</label>
            <select
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              value={value.consoleId}
              onChange={(e) => {
                const console_ = consoles.find((c) => c.id === e.target.value);
                onChange({
                  ...value,
                  consoleId: e.target.value,
                  // Prefill from the console's default, but only if the
                  // operator hasn't already typed something of their own
                  // — lets fired/resolved use different webhook IDs on
                  // the same console (SPEC.md section 7).
                  webhookId: value.webhookId || console_?.defaultWebhookId || "",
                });
              }}
              required
            >
              <option value="" disabled>
                Select a console
              </option>
              {consoles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Webhook ID</label>
            <Input
              value={value.webhookId}
              onChange={(e) => onChange({ ...value, webhookId: e.target.value })}
              placeholder="matches an Alarm Manager rule's webhook trigger"
              required
            />
          </div>
          {selectedConsole && value.webhookId && (
            <p className="break-all font-mono text-xs text-muted-foreground">
              {buildConsoleWebhookUrl(selectedConsole.host, value.webhookId)}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">URL</label>
            <Input
              value={value.url}
              onChange={(e) => onChange({ ...value, url: e.target.value })}
              placeholder="https://..."
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Bearer token (optional)</label>
            <Input
              type="password"
              value={value.bearerToken}
              onChange={(e) => onChange({ ...value, bearerToken: e.target.value })}
              placeholder={editing ? "leave blank to keep the existing token" : "sent as Authorization: Bearer …"}
            />
          </div>
        </>
      )}
    </div>
  );
}

export default function RulesPage() {
  useNowTick(); // keeps "last used" ticking live, second-by-second
  const { user: actor } = useCurrentUser();
  const canEdit = hasRole(actor, "admin");
  const temperatureUnit = actor?.temperatureUnit ?? "C";
  const [rules, setRules] = React.useState<RuleRow[]>([]);
  const [sensors, setSensors] = React.useState<Sensor[]>([]);
  const [sensorStatuses, setSensorStatuses] = React.useState<SensorStatus[]>([]);
  const [consoles, setConsoles] = React.useState<ProtectConsole[]>([]);
  const [deliveries, setDeliveries] = React.useState<Record<string, WebhookDelivery[]>>({});
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [historyRuleId, setHistoryRuleId] = React.useState<string | null>(null);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const [rulesRes, sensorsRes, consolesRes] = await Promise.all([
      fetch("/api/latches"),
      fetch("/api/sensors"),
      fetch("/api/consoles"),
    ]);
    let loadedRules: RuleRow[] = [];
    if (rulesRes.ok) {
      loadedRules = (await rulesRes.json()).latches;
      setRules(loadedRules);
    }
    if (sensorsRes.ok) {
      const body = await sensorsRes.json();
      setSensors(body.sensors);
      setSensorStatuses(body.statuses);
    }
    if (consolesRes.ok) setConsoles((await consolesRes.json()).consoles);

    // Delivery history is admin-only server-side (CLAUDE.md) — don't even
    // attempt the fetch for a read-only "user" session.
    if (canEdit && loadedRules.length > 0) {
      const results = await Promise.all(
        loadedRules.map(async (rule) => {
          const res = await fetch(`/api/latches/${rule.id}/deliveries`);
          if (!res.ok) return [rule.id, []] as const;
          const body = await res.json();
          return [rule.id, body.deliveries as WebhookDelivery[]] as const;
        })
      );
      setDeliveries(Object.fromEntries(results));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

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

  function openCreateDialog() {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
    setOpen(true);
  }

  function openEditDialog(rule: RuleRow) {
    const displayCondition = toDisplayCondition(rule.condition, rule.metric, temperatureUnit);
    setForm({
      ...emptyForm,
      sensorId: rule.sensorId,
      metric: rule.metric,
      durationSeconds: rule.durationSeconds,
      webhook: webhookFormValueFromTarget(rule.webhook),
      resolvedWebhookEnabled: rule.resolvedWebhook != null,
      resolvedWebhook: webhookFormValueFromTarget(rule.resolvedWebhook),
      enabled: rule.enabled,
      ...conditionToFormFields(displayCondition),
    });
    setEditingId(rule.id);
    setError(null);
    setOpen(true);
  }

  async function submitRule(e: React.FormEvent) {
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

      const webhook = buildWebhookTarget(form.webhook);
      const webhookCheck = validateWebhookTarget(webhook);
      if (!webhookCheck.valid) throw new Error(webhookCheck.error);

      let resolvedWebhook: WebhookTarget | undefined;
      if (form.resolvedWebhookEnabled) {
        resolvedWebhook = buildWebhookTarget(form.resolvedWebhook);
        const resolvedCheck = validateWebhookTarget(resolvedWebhook);
        if (!resolvedCheck.valid) throw new Error(resolvedCheck.error);
      }

      const payload = {
        sensorId: form.sensorId,
        metric: form.metric as Sensor["metrics"][number],
        condition,
        durationSeconds,
        webhook,
        resolvedWebhook,
        enabled: form.enabled,
      };

      const res = editingId
        ? await fetch(`/api/latches/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/latches", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: crypto.randomUUID(), ...payload }),
          });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to save rule");

      setForm(emptyForm);
      setEditingId(null);
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(rule: RuleRow) {
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

  async function runTest(id: string) {
    setTestingId(id);
    try {
      await fetch(`/api/latches/${id}/test`, { method: "POST" });
      await load();
      setHistoryRuleId(id);
    } finally {
      setTestingId(null);
    }
  }

  const historyRule = rules.find((r) => r.id === historyRuleId);
  const historyDeliveries = historyRuleId ? deliveries[historyRuleId] ?? [] : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Rules</h1>
        {canEdit && (
          <Button size="sm" disabled={sensors.length === 0} onClick={openCreateDialog}>
            New Rule
          </Button>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setForm(emptyForm);
            setEditingId(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit rule" : "New rule"}</DialogTitle>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={submitRule}>
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
                  This is the point at which the alarm releases once fired. If left blank, it releases as soon as
                  the reading crosses back over the threshold itself.
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
                  {selectedInterval.source.replace("-", " ")}) — durations shorter than that are disabled above.
                </p>
              )}
            </div>

            <WebhookFieldsEditor
              label="Webhook (fired)"
              value={form.webhook}
              onChange={(webhook) => setForm({ ...form, webhook })}
              consoles={consoles}
              editing={editingId != null}
            />

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="resolvedWebhookEnabled"
                checked={form.resolvedWebhookEnabled}
                onChange={(e) => setForm({ ...form, resolvedWebhookEnabled: e.target.checked })}
              />
              <label htmlFor="resolvedWebhookEnabled" className="text-xs text-muted-foreground">
                Also send a webhook when the alarm resolves
              </label>
            </div>
            {form.resolvedWebhookEnabled && (
              <WebhookFieldsEditor
                label="Webhook (resolved)"
                value={form.resolvedWebhook}
                onChange={(resolvedWebhook) => setForm({ ...form, resolvedWebhook })}
                consoles={consoles}
                editing={editingId != null}
              />
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Create rule"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={historyRuleId != null} onOpenChange={(next) => !next && setHistoryRuleId(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Webhook history{historyRule ? ` — ${sensorName(historyRule.sensorId)}` : ""}</DialogTitle>
          </DialogHeader>
          {historyDeliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries recorded yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {historyDeliveries.map((d) => (
                <div key={d.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{d.kind}</Badge>
                      <Badge variant={deliveryBadgeVariant(d)}>{d.ok ? "ok" : "failed"}</Badge>
                      {d.status != null && <span className="text-xs text-muted-foreground">HTTP {d.status}</span>}
                    </div>
                    <span className="text-xs text-muted-foreground" title={absoluteTimeLabel(d.dispatchedAt)}>
                      {preciseAgoLabel(d.dispatchedAt)}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={d.url}>
                    {d.method} {d.url}
                  </p>
                  {d.error && <p className="mt-1 text-xs text-red-600">{d.error}</p>}
                  {d.responseBodySnippet && (
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                      {d.responseBodySnippet}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

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
              <TableHead>Status</TableHead>
              {canEdit && <TableHead>Last used</TableHead>}
              <TableHead>Webhook</TableHead>
              {canEdit && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => {
              const lastDelivery = deliveries[rule.id]?.[0];
              return (
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
                  <TableCell>
                    <Badge variant={rule.enabled ? "outline" : "idle"}>{rule.enabled ? "enabled" : "disabled"}</Badge>
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      {lastDelivery ? (
                        <button
                          type="button"
                          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                          onClick={() => setHistoryRuleId(rule.id)}
                          title={absoluteTimeLabel(lastDelivery.dispatchedAt)}
                        >
                          <Badge variant={deliveryBadgeVariant(lastDelivery)}>
                            {preciseAgoLabel(lastDelivery.dispatchedAt)}
                          </Badge>
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">never</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    {rule.webhook.kind === "console" ? (
                      <span className="text-xs text-muted-foreground">{consoleWebhookLabel(rule.webhook, consoles)}</span>
                    ) : (
                      <span
                        className="block max-w-[220px] truncate font-mono text-xs text-muted-foreground"
                        title={rule.webhook.url}
                      >
                        {rule.webhook.url}
                      </span>
                    )}
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <div className="flex flex-nowrap justify-end gap-1">
                        <Button variant="outline" size="sm" onClick={() => openEditDialog(rule)}>
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={testingId === rule.id}
                          onClick={() => runTest(rule.id)}
                        >
                          {testingId === rule.id ? "Testing…" : "Test"}
                        </Button>
                        <Button variant="warning" size="sm" onClick={() => toggleEnabled(rule)}>
                          {rule.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => deleteRule(rule.id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
