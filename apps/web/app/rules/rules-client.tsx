"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  MIN_DURATION_SECONDS,
  buildConsoleWebhookUrl,
  conditionSummary,
  isDurationValid,
  validateCondition,
  validateWebhookTarget,
} from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { metricUnitSuffix, toDisplayCondition, toStoredValue } from "@/lib/units";
import { absoluteTimeLabel, coarseAgoLabel, formatDuration, preciseAgoLabel, useNowTick } from "@/lib/format";
import { reportingBadge } from "@/lib/reportingBadge";

// CRUD over /api/latches — "Rule" is the user-facing name for what the
// domain model (SPEC.md section 4) and API still call a Latch internally;
// the mechanism (arm/clear hysteresis) is the same either way, "Rule" is
// just the friendlier name in the UI. Sensor + metric picker only offers
// metrics a discovered sensor actually exposes (SPEC.md section 12 —
// never hand-typed). Webhook URLs arrive from the API masked only for the
// read-only "user" role (CLAUDE.md's obfuscation exception) — admin sees
// the real value, since it can already create/edit/delete/test rules.
export type RuleRow = Omit<Latch, "webhook" | "resolvedWebhook"> & {
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
  bodyTemplate: string; // custom-only; unlike bearerToken this isn't a secret, so it IS prefilled on edit
}

function emptyWebhookFormValue(): WebhookFormValue {
  return { kind: "console", consoleId: "", webhookId: "", url: "", method: "POST", bearerToken: "", bodyTemplate: "" };
}

// bearerToken is deliberately left blank even when editing an existing
// custom webhook that has one — GET /api/latches always masks it (see
// latchRedaction.ts), so there's no real value to prefill; the field's
// placeholder explains that blank means "keep the existing token."
// bodyTemplate isn't credential-bearing (latchRedaction.ts passes it
// through unmasked), so it's safe to prefill from the real stored value.
function webhookFormValueFromTarget(target: WebhookTarget | undefined): WebhookFormValue {
  if (!target) return emptyWebhookFormValue();
  if (target.kind === "console") {
    return { kind: "console", consoleId: target.consoleId, webhookId: target.webhookId, url: "", method: "POST", bearerToken: "", bodyTemplate: "" };
  }
  return {
    kind: "custom",
    consoleId: "",
    webhookId: "",
    url: target.url,
    method: target.method,
    bearerToken: "",
    bodyTemplate: target.bodyTemplate ?? "",
  };
}

function buildWebhookTarget(v: WebhookFormValue): WebhookTarget {
  if (v.kind === "console") {
    return { kind: "console", consoleId: v.consoleId, webhookId: v.webhookId };
  }
  return {
    kind: "custom",
    url: v.url,
    method: v.method,
    bearerToken: v.bearerToken || undefined,
    bodyTemplate: v.bodyTemplate || undefined,
  };
}

// Duration can be picked from the Unifi-matched preset list or typed as
// an arbitrary DD:HH:MM — the server only ever validates the resulting
// total seconds against the flat MIN_DURATION_SECONDS floor (see
// /api/latches's route and shared/src/interval.ts), it was never actually
// restricted to the preset list, so this is a pure UI addition, no API
// change needed. Seconds isn't a user-facing field (nothing here can
// react faster than a minute anyway — see MIN_DURATION_SECONDS) but stays
// in FormState/round-trips through secondsToParts/partsToSeconds so
// editing a rule that was saved with a sub-minute seconds component (from
// before that floor existed) doesn't silently truncate it on save.
function secondsToParts(totalSeconds: number): { days: string; hours: string; minutes: string; seconds: string } {
  let s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  s -= minutes * 60;
  return { days: String(days), hours: String(hours), minutes: String(minutes), seconds: String(s) };
}

function partsToSeconds(days: string, hours: string, minutes: string, seconds: string): number {
  return (Number(days) || 0) * 86400 + (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60 + (Number(seconds) || 0);
}

function getDurationSeconds(form: FormState): number | null {
  if (form.durationMode === "preset") {
    return form.durationPreset === "" ? null : form.durationPreset;
  }
  const total = partsToSeconds(form.customDays, form.customHours, form.customMinutes, form.customSeconds);
  return total > 0 ? total : null;
}

const emptyForm = {
  name: "",
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
  durationMode: "preset" as "preset" | "custom",
  durationPreset: "" as number | "",
  customDays: "0",
  customHours: "0",
  customMinutes: "0",
  customSeconds: "0",
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

// Self-contained plain-English summary of what a rule does — the Rules
// table's declutter collapses Metric/Condition/Duration into this one
// sentence (see RulesClient's table below); the exact structured
// breakdown (condition type, thresholds, hysteresis, duration presets)
// is still fully editable in the create/edit dialog and viewable in the
// details dialog, this is just the at-a-glance version.
function ruleDescription(rule: RuleRow, sensorLabel: string, temperatureUnit: "C" | "F"): string {
  const summary = conditionSummary(
    toDisplayCondition(rule.condition, rule.metric, temperatureUnit),
    metricUnitSuffix(rule.metric, temperatureUnit)
  );
  return `If ${sensorLabel} is ${summary} for ${formatDuration(rule.durationSeconds)}`;
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
              {buildConsoleWebhookUrl(selectedConsole.host, value.webhookId, selectedConsole.apiBaseUrlOverride)}
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
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Body template (optional, POST only)</label>
            <Textarea
              value={value.bodyTemplate}
              onChange={(e) => onChange({ ...value, bodyTemplate: e.target.value })}
              placeholder={'{"sensor": "{{sensorName}}", "value": {{value}}, "threshold": "{{threshold}}"}'}
            />
            <p className="text-xs text-muted-foreground">
              Placeholders: <code className="font-mono">{"{{sensorName}}"}</code>{" "}
              <code className="font-mono">{"{{metric}}"}</code> <code className="font-mono">{"{{value}}"}</code>{" "}
              <code className="font-mono">{"{{threshold}}"}</code>{" "}
              <code className="font-mono">{"{{durationMinutes}}"}</code>. <code className="font-mono">value</code>{" "}
              and <code className="font-mono">threshold</code> are always in Celsius, independent of any account's
              display unit. Left blank, no body is sent. Only used when method is POST.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export interface RulesInitialData {
  rules: RuleRow[];
  sensors: Sensor[];
  sensorStatuses: SensorStatus[];
  consoles: ProtectConsole[];
  deliveries: Record<string, WebhookDelivery[]>;
}

// Seeded from a server-side fetch (see page.tsx) covering the same data
// this page's own load() re-fetches after any mutation — first paint
// already has real rules/sensors/deliveries instead of an empty table
// that pops in once the client's own fetch resolves.
export function RulesClient({ initial }: { initial: RulesInitialData }) {
  useNowTick(); // keeps "last used" ticking live, second-by-second
  const { user: actor } = useCurrentUser();
  const canEdit = hasRole(actor, "admin");
  const temperatureUnit = actor?.temperatureUnit ?? "C";
  const [rules, setRules] = React.useState<RuleRow[]>(initial.rules);
  const [sensors, setSensors] = React.useState<Sensor[]>(initial.sensors);
  const [sensorStatuses, setSensorStatuses] = React.useState<SensorStatus[]>(initial.sensorStatuses);
  const [consoles, setConsoles] = React.useState<ProtectConsole[]>(initial.consoles);
  const [deliveries, setDeliveries] = React.useState<Record<string, WebhookDelivery[]>>(initial.deliveries);
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [historyRuleId, setHistoryRuleId] = React.useState<string | null>(null);
  const [detailsRuleId, setDetailsRuleId] = React.useState<string | null>(null);
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

  const selectedSensor = sensors.find((s) => s.id === form.sensorId);
  const unitSuffix = form.metric ? metricUnitSuffix(form.metric as Metric, temperatureUnit) : "";

  function sensorName(id: string): string {
    return sensors.find((s) => s.id === id)?.name ?? id;
  }

  // Lets the create/edit form show whether the sensor being configured is
  // actually reporting right now, before the operator commits to a
  // duration against it — same badge/thresholds as the Sensors page (see
  // lib/reportingBadge.ts), sourced from the same per-sensor checkin data.
  function sensorReportingStatus(sensorId: string): { badge: ReturnType<typeof reportingBadge>; status?: SensorStatus } {
    const sensor = sensors.find((s) => s.id === sensorId);
    const status = sensorStatuses.find((s) => s.sensorId === sensorId);
    const console_ = sensor ? consoles.find((c) => c.id === sensor.consoleId) : undefined;
    const badge = reportingBadge(
      status?.lastSeenAt ?? null,
      status?.observedCheckinIntervalSeconds ?? null,
      console_?.defaultIntervalSeconds ?? 300
    );
    return { badge, status };
  }

  const customDurationTooShort =
    form.durationMode === "custom" &&
    partsToSeconds(form.customDays, form.customHours, form.customMinutes, form.customSeconds) < MIN_DURATION_SECONDS;

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
    const matchesPreset = DURATION_PRESETS.some((p) => p.seconds === rule.durationSeconds);
    const parts = secondsToParts(rule.durationSeconds);
    const durationFields = matchesPreset
      ? { durationMode: "preset" as const, durationPreset: rule.durationSeconds }
      : {
          durationMode: "custom" as const,
          durationPreset: "" as const,
          customDays: parts.days,
          customHours: parts.hours,
          customMinutes: parts.minutes,
          customSeconds: parts.seconds,
        };
    setForm({
      ...emptyForm,
      name: rule.name ?? "",
      sensorId: rule.sensorId,
      metric: rule.metric,
      ...durationFields,
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
      const durationSeconds = getDurationSeconds(form);
      if (durationSeconds == null) throw new Error("duration is required");

      const condition = buildCondition();
      const conditionCheck = validateCondition(condition);
      if (!conditionCheck.valid) throw new Error(conditionCheck.error);

      if (!isDurationValid(durationSeconds)) {
        throw new Error(`duration must be at least ${MIN_DURATION_SECONDS} seconds`);
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
        name: form.name.trim() || null,
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
  const detailsRule = rules.find((r) => r.id === detailsRuleId);
  const detailsLastDelivery = detailsRuleId ? deliveries[detailsRuleId]?.[0] : undefined;

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
              <label className="text-xs text-muted-foreground">Name (optional)</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Freezer too warm"
                maxLength={100}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Sensor</label>
              <select
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                value={form.sensorId}
                onChange={(e) => setForm({ ...form, sensorId: e.target.value, metric: "", durationPreset: "" })}
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
              {selectedSensor &&
                (() => {
                  const { badge, status } = sensorReportingStatus(selectedSensor.id);
                  return (
                    <div className="flex items-center gap-2">
                      <Badge variant={badge.variant} className="text-[10px]">
                        {badge.label}
                      </Badge>
                      {/* suppressHydrationWarning — "X ago" is derived from
                          Date.now() at render time; see dashboard-client.tsx's
                          note on the same pattern. */}
                      <span
                        className="text-xs text-muted-foreground"
                        title={status?.lastSeenAt ? absoluteTimeLabel(status.lastSeenAt) : undefined}
                        suppressHydrationWarning
                      >
                        last seen {preciseAgoLabel(status?.lastSeenAt ?? null)}
                      </span>
                    </div>
                  );
                })()}
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Metric</label>
              <select
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                value={form.metric}
                onChange={(e) =>
                  setForm({ ...form, metric: e.target.value as Sensor["metrics"][number], durationPreset: "" })
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

            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">
                  Duration (armed for at least this long before firing)
                </label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={form.durationMode === "preset" ? "default" : "outline"}
                    onClick={() => setForm({ ...form, durationMode: "preset" })}
                  >
                    Preset
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={form.durationMode === "custom" ? "default" : "outline"}
                    onClick={() => setForm({ ...form, durationMode: "custom" })}
                  >
                    Custom
                  </Button>
                </div>
              </div>

              {form.durationMode === "preset" ? (
                <select
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                  value={form.durationPreset}
                  onChange={(e) => setForm({ ...form, durationPreset: Number(e.target.value) })}
                  required
                >
                  <option value="" disabled>
                    Select a duration
                  </option>
                  {DURATION_PRESETS.map((p) => (
                    <option key={p.seconds} value={p.seconds}>
                      {p.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Days</label>
                    <Input
                      type="number"
                      min={0}
                      value={form.customDays}
                      onChange={(e) => setForm({ ...form, customDays: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Hours</label>
                    <Input
                      type="number"
                      min={0}
                      value={form.customHours}
                      onChange={(e) => setForm({ ...form, customHours: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Minutes</label>
                    <Input
                      type="number"
                      min={0}
                      value={form.customMinutes}
                      onChange={(e) => setForm({ ...form, customMinutes: e.target.value })}
                    />
                  </div>
                </div>
              )}

              {customDurationTooShort && (
                <p className="text-xs text-red-600">Duration must be at least {MIN_DURATION_SECONDS} seconds (1 minute).</p>
              )}
              <p className="text-xs text-muted-foreground">
                1 minute is the floor — nothing here can poll or confirm a change faster than that. Beyond it, base
                the duration on how often this sensor actually reports: check its real "update frequency" in the
                UniFi Protect app and set this to at least 2x that value, ideally 3x, so one missed or delayed
                report can't bounce the rule.
              </p>
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
                    {/* suppressHydrationWarning — see dashboard-client.tsx's note on this pattern */}
                    <span className="text-xs text-muted-foreground" title={absoluteTimeLabel(d.dispatchedAt)} suppressHydrationWarning>
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

      <Dialog open={detailsRuleId != null} onOpenChange={(next) => !next && setDetailsRuleId(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          {detailsRule && (
            <>
              <DialogHeader>
                <DialogTitle>{detailsRule.name || sensorName(detailsRule.sensorId)}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4 text-sm">
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Sensor</span>
                    <span>{sensorName(detailsRule.sensorId)}</span>
                  </div>
                  {(() => {
                    const { badge, status } = sensorReportingStatus(detailsRule.sensorId);
                    return (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">Sensor last seen</span>
                        <div className="flex items-center gap-2">
                          <Badge variant={badge.variant} className="text-[10px]">
                            {badge.label}
                          </Badge>
                          {/* suppressHydrationWarning — see the sensor-picker status blurb above */}
                          <span
                            className="text-xs text-muted-foreground"
                            title={status?.lastSeenAt ? absoluteTimeLabel(status.lastSeenAt) : undefined}
                            suppressHydrationWarning
                          >
                            {preciseAgoLabel(status?.lastSeenAt ?? null)}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                  <p className="text-muted-foreground">
                    {ruleDescription(detailsRule, sensorName(detailsRule.sensorId), temperatureUnit)}
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Status</span>
                    <Badge variant={detailsRule.enabled ? "outline" : "idle"}>
                      {detailsRule.enabled ? "enabled" : "disabled"}
                    </Badge>
                  </div>
                </div>

                {canEdit && (
                  <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <span className="text-xs text-muted-foreground">Last used</span>
                    {detailsLastDelivery ? (
                      <button
                        type="button"
                        className="flex w-fit items-center gap-2 underline decoration-dotted underline-offset-2 hover:text-foreground"
                        onClick={() => {
                          setHistoryRuleId(detailsRuleId);
                          setDetailsRuleId(null);
                        }}
                      >
                        {/* suppressHydrationWarning — see dashboard-client.tsx's note on this pattern */}
                        <Badge variant={deliveryBadgeVariant(detailsLastDelivery)} suppressHydrationWarning>
                          {preciseAgoLabel(detailsLastDelivery.dispatchedAt)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {absoluteTimeLabel(detailsLastDelivery.dispatchedAt)} · view history
                        </span>
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">never</span>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <span className="text-xs text-muted-foreground">Webhook (fired)</span>
                  {detailsRule.webhook.kind === "console" ? (
                    <span className="text-xs text-muted-foreground">
                      {consoleWebhookLabel(detailsRule.webhook, consoles)}
                    </span>
                  ) : (
                    <span className="break-all font-mono text-xs text-muted-foreground">{detailsRule.webhook.url}</span>
                  )}
                </div>

                {detailsRule.resolvedWebhook && (
                  <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <span className="text-xs text-muted-foreground">Webhook (resolved)</span>
                    {detailsRule.resolvedWebhook.kind === "console" ? (
                      <span className="text-xs text-muted-foreground">
                        {consoleWebhookLabel(detailsRule.resolvedWebhook, consoles)}
                      </span>
                    ) : (
                      <span className="break-all font-mono text-xs text-muted-foreground">
                        {detailsRule.resolvedWebhook.url}
                      </span>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        openEditDialog(detailsRule);
                        setDetailsRuleId(null);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={testingId === detailsRule.id}
                      onClick={() => runTest(detailsRule.id)}
                    >
                      {testingId === detailsRule.id ? "Testing…" : "Test"}
                    </Button>
                    <Button variant="warning" size="sm" onClick={() => toggleEnabled(detailsRule)}>
                      {detailsRule.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        deleteRule(detailsRule.id);
                        setDetailsRuleId(null);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </>
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
              <TableHead>Name</TableHead>
              <TableHead>Sensor</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Status</TableHead>
              {canEdit && <TableHead className="w-24">Last used</TableHead>}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => {
              const lastDelivery = deliveries[rule.id]?.[0];
              const label = sensorName(rule.sensorId);
              return (
                <TableRow key={rule.id}>
                  <TableCell className="font-medium">{rule.name || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{label}</TableCell>
                  <TableCell className="text-muted-foreground">{ruleDescription(rule, label, temperatureUnit)}</TableCell>
                  <TableCell>
                    <Badge variant={rule.enabled ? "outline" : "idle"}>{rule.enabled ? "enabled" : "disabled"}</Badge>
                  </TableCell>
                  {canEdit && (
                    // suppressHydrationWarning — see dashboard-client.tsx's note on this pattern
                    <TableCell
                      className="w-24 text-xs text-muted-foreground"
                      title={lastDelivery ? absoluteTimeLabel(lastDelivery.dispatchedAt) : undefined}
                      suppressHydrationWarning
                    >
                      {coarseAgoLabel(lastDelivery?.dispatchedAt ?? null)}
                    </TableCell>
                  )}
                  <TableCell>
                    <Button variant="outline" size="sm" onClick={() => setDetailsRuleId(rule.id)}>
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
