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
  MIN_DURATION_SECONDS,
  conditionSummary,
  isDurationValid,
  validateCondition,
  validateWebhookTarget,
} from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { metricUnitSuffix, toDisplayCondition, toStoredValue } from "@/lib/units";
import { absoluteTimeLabel, coarseAgoLabel, formatDuration, preciseAgoLabel, useNowTick } from "@/lib/format";
import { reportingBadge } from "@/lib/reportingBadge";
import {
  WebhookFieldsEditor,
  buildWebhookTarget,
  emptyWebhookFormValue,
  webhookFormValueFromTarget,
  type WebhookFormValue,
} from "@/components/webhook-fields-editor";

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

type ConditionType = "above" | "below" | "between" | "outside";
type HysteresisMode = "manual" | "auto";

// Form-local shape for one webhook (fired or resolved) — flat so every
// field has a plain string/select-friendly value regardless of which
// WebhookTarget kind is selected; buildWebhookTarget below narrows it
// back down to the real union on submit. "console" is the default kind:
// it's this app's primary intended path (SPEC.md section 7 — Protect's
// own Alarm Manager does the actual notification delivery), not just one
// option among equals.
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
  const part = (v: string) => Math.max(0, Number(v) || 0);
  return part(days) * 86400 + part(hours) * 3600 + part(minutes) * 60 + part(seconds);
}

// type="number" inputs still accept "-", "e", and stray characters from
// the keyboard even with min={0} set — the browser only enforces min/max
// on the spinner arrows, not on typed input, and a bare Number(str) on a
// value like "" or "-" silently becomes NaN/0 downstream. These sanitize
// on every keystroke so what's in state is always something Number() can
// parse cleanly, rather than deferring the problem to submit time.
function sanitizeNonNegativeIntegerInput(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

function sanitizeSignedDecimalInput(raw: string): string {
  let s = raw.replace(/[^0-9.-]/g, "");
  const negative = s.startsWith("-");
  s = s.replace(/-/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  return (negative ? "-" : "") + s;
}

function sanitizeNonNegativeDecimalInput(raw: string): string {
  let s = raw.replace(/[^0-9.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  return s;
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
  if (condition.type === "between" || condition.type === "outside") {
    return {
      conditionType: condition.type,
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
  if (rule.metric === "leak") {
    return `If ${sensorLabel} detects a leak for ${formatDuration(rule.durationSeconds)}`;
  }
  const summary = conditionSummary(
    toDisplayCondition(rule.condition, rule.metric, temperatureUnit),
    metricUnitSuffix(rule.metric, temperatureUnit)
  );
  return `If ${sensorLabel} is ${summary} for ${formatDuration(rule.durationSeconds)}`;
}

function formatTick(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

// Visual answer to "which side triggers, and when does it release" — the
// two condition types (between/outside) are mirror images of each other
// (armed inside vs. armed outside the same low/high bounds, deadband
// pointing outward vs. inward), which reads fine as prose right up until
// someone's mental model defaults to the other one (see the conversation
// that led to this component: "between" was read as "the value is OK
// when it's between this," which is actually what "outside" means).
// Renders live off whatever the operator has currently typed, including
// mid-entry incomplete values (nulls just collapse that segment away
// rather than crashing on a NaN layout).
function RangeNumberLine({
  mode,
  low,
  high,
  clearLow,
  clearHigh,
  marginPercent,
  unitSuffix,
}: {
  mode: "between" | "outside";
  low: number | null;
  high: number | null;
  clearLow: number | null;
  clearHigh: number | null;
  marginPercent: number | null;
  unitSuffix: string;
}) {
  if (low == null || high == null || !(low < high)) return null;

  const width = high - low;
  const margin = marginPercent != null && marginPercent > 0 ? (width * marginPercent) / 100 : 0;
  const effectiveClearLow = clearLow ?? (mode === "between" ? low - margin : low + margin);
  const effectiveClearHigh = clearHigh ?? (mode === "between" ? high + margin : high - margin);

  // Pad the visible range a bit past whichever bound is furthest out, so
  // the outward-expanding "between" deadband has room to actually show.
  const pad = Math.max(width * 0.3, (Math.abs(effectiveClearLow - low) + Math.abs(effectiveClearHigh - high)) * 0.6, 1);
  const min = Math.min(low, effectiveClearLow) - pad;
  const max = Math.max(high, effectiveClearHigh) + pad;
  const span = max - min;
  const pct = (v: number) => `${((v - min) / span) * 100}%`;

  const armedColor = "bg-red-500/70 dark:bg-red-500/60";
  const safeColor = "bg-emerald-500/60 dark:bg-emerald-500/50";
  const deadbandColor = "bg-muted-foreground/25";

  // Three fixed-shape segment lists — one per zone kind — rather than one
  // combined "figure out the color per pixel" pass: between/outside only
  // ever differ in which of these three shapes is armed vs. safe, so it's
  // clearer to name the shapes once and swap which color each gets.
  const outerLeft = { from: min, to: Math.min(low, effectiveClearLow) };
  const deadbandLeft = { from: Math.min(low, effectiveClearLow), to: Math.max(low, effectiveClearLow) };
  const middle = { from: Math.max(low, effectiveClearLow), to: Math.min(high, effectiveClearHigh) };
  const deadbandRight = { from: Math.min(high, effectiveClearHigh), to: Math.max(high, effectiveClearHigh) };
  const outerRight = { from: Math.max(high, effectiveClearHigh), to: max };

  const segments =
    mode === "between"
      ? [
          { ...outerLeft, color: safeColor },
          { ...deadbandLeft, color: deadbandColor },
          { ...middle, color: armedColor },
          { ...deadbandRight, color: deadbandColor },
          { ...outerRight, color: safeColor },
        ]
      : [
          { ...outerLeft, color: armedColor },
          { ...deadbandLeft, color: deadbandColor },
          { ...middle, color: safeColor },
          { ...deadbandRight, color: deadbandColor },
          { ...outerRight, color: armedColor },
        ];

  const rawMarkers = [
    { value: low, label: "low" },
    { value: high, label: "high" },
    ...(Math.abs(effectiveClearLow - low) > span * 0.001 ? [{ value: effectiveClearLow, label: "release" }] : []),
    ...(Math.abs(effectiveClearHigh - high) > span * 0.001 ? [{ value: effectiveClearHigh, label: "release" }] : []),
  ];

  // Two markers whose percent positions land close together render their
  // label text on top of each other — alternate close ones onto a second
  // row instead of just hoping labels never collide (four markers can
  // easily bunch up: low/release pairs get closer together the smaller
  // the deadband gap is).
  const MIN_GAP_PCT = 14;
  let lastPct = -Infinity;
  let nextRow: 0 | 1 = 0;
  const markers = [...rawMarkers]
    .sort((a, b) => a.value - b.value)
    .map((m) => {
      const p = ((m.value - min) / span) * 100;
      const row = p - lastPct < MIN_GAP_PCT ? nextRow : 0;
      nextRow = row === 0 ? 1 : 0;
      lastPct = p;
      return { ...m, row };
    });

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="relative h-3 w-full overflow-hidden rounded-full border border-border/80">
        {segments.map((seg, i) =>
          seg.to <= seg.from ? null : (
            <div
              key={i}
              className={`absolute inset-y-0 ${seg.color}`}
              style={{ left: pct(seg.from), width: `${((seg.to - seg.from) / span) * 100}%` }}
            />
          )
        )}
      </div>
      <div className="relative h-14 w-full text-[10px] text-muted-foreground">
        {markers.map((m, i) => (
          <div
            key={i}
            className="absolute flex -translate-x-1/2 flex-col items-center"
            style={{ left: pct(m.value), top: m.row === 1 ? "1.5rem" : 0 }}
          >
            <div className="h-1.5 w-px bg-border" />
            <span className="whitespace-nowrap">
              {formatTick(m.value)}
              {unitSuffix}
            </span>
            <span className="italic">{m.label}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className={`inline-block h-2 w-2 rounded-full ${armedColor}`} /> armed
        </span>
        <span className="flex items-center gap-1">
          <span className={`inline-block h-2 w-2 rounded-full ${deadbandColor}`} /> deadband
        </span>
        <span className="flex items-center gap-1">
          <span className={`inline-block h-2 w-2 rounded-full ${safeColor}`} /> safe
        </span>
      </div>
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

  // Sensor statuses only otherwise refresh after a rule mutation (see
  // load()) — the Details dialog's "last seen" was reading whatever
  // statuses happened to be in state from the last such mutation, which
  // could be stale by the time someone actually opens it to check. This
  // is the lightweight fix: pull fresh statuses the moment the dialog
  // opens, without the heavier full load() (which also re-fetches every
  // rule's delivery history).
  const refreshSensorStatuses = React.useCallback(async () => {
    const res = await fetch("/api/sensors");
    if (res.ok) {
      const body = await res.json();
      setSensors(body.sensors);
      setSensorStatuses(body.statuses);
    }
  }, []);

  function openDetailsDialog(ruleId: string) {
    setDetailsRuleId(ruleId);
    void refreshSensorStatuses();
  }

  const selectedSensor = sensors.find((s) => s.id === form.sensorId);
  const unitSuffix = form.metric ? metricUnitSuffix(form.metric as Metric, temperatureUnit) : "";
  // leak reports 0 (dry) or 1 (detected) — see packages/engine/src/protect.ts's
  // leakValue — there's no continuous range to be above/below/between, so
  // the form hides the numeric condition UI entirely and buildCondition
  // below always emits a fixed "above 0.5" condition for it.
  const isLeakMetric = form.metric === "leak";

  // Live (pre-submit) mirror of the deadband rules validateCondition
  // enforces server-side — same directions, just read straight off the
  // in-progress form strings so the dialog can show a red error and block
  // saving before the operator ever hits submit, not after. Values are
  // compared in the display unit the operator is typing in (Fahrenheit or
  // Celsius) rather than converted first — for temperature the C<->F
  // conversion is monotonic, so "is X past Y" comes out the same either
  // way.
  const parseNum = (s: string): number | null => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  const thresholdNum = parseNum(form.threshold);
  const clearThresholdNum = parseNum(form.clearThreshold);
  const lowNum = parseNum(form.low);
  const highNum = parseNum(form.high);
  const clearLowNum = parseNum(form.clearLow);
  const clearHighNum = parseNum(form.clearHigh);

  let hysteresisError: string | null = null;
  if (!isLeakMetric) {
    if (form.conditionType === "above" && thresholdNum != null && clearThresholdNum != null && clearThresholdNum > thresholdNum) {
      hysteresisError = "The disarm point can't be above the arm threshold — it would disarm the rule while the reading is still past the point that armed it.";
    } else if (
      form.conditionType === "below" &&
      thresholdNum != null &&
      clearThresholdNum != null &&
      clearThresholdNum < thresholdNum
    ) {
      hysteresisError = "The disarm point can't be below the arm threshold — it would disarm the rule while the reading is still past the point that armed it.";
    } else if (form.conditionType === "between") {
      if (lowNum != null && highNum != null && !(lowNum < highNum)) {
        hysteresisError = "The low bound must be less than the high bound.";
      } else if (form.hysteresisMode === "manual") {
        if (lowNum != null && clearLowNum != null && clearLowNum > lowNum) {
          hysteresisError = "The lower disarm point must be at or below the low bound, not inside the armed range.";
        } else if (highNum != null && clearHighNum != null && clearHighNum < highNum) {
          hysteresisError = "The upper disarm point must be at or above the high bound, not inside the armed range.";
        }
      } else if (form.hysteresisMode === "auto" && form.marginPercent !== "" && !(Number(form.marginPercent) > 0)) {
        hysteresisError = "Auto hysteresis margin must be greater than 0%.";
      }
    } else if (form.conditionType === "outside") {
      if (lowNum != null && highNum != null && !(lowNum < highNum)) {
        hysteresisError = "The low bound must be less than the high bound.";
      } else if (form.hysteresisMode === "manual") {
        if (lowNum != null && clearLowNum != null && clearLowNum < lowNum) {
          hysteresisError = "The lower disarm point must be at or above the low bound — it's the edge of the safe zone, not the armed zone.";
        } else if (highNum != null && clearHighNum != null && clearHighNum > highNum) {
          hysteresisError = "The upper disarm point must be at or below the high bound — it's the edge of the safe zone, not the armed zone.";
        } else if (clearLowNum != null && clearHighNum != null && !(clearLowNum < clearHighNum)) {
          hysteresisError = "The lower disarm point must be less than the upper disarm point.";
        }
      } else if (form.hysteresisMode === "auto") {
        const margin = form.marginPercent === "" ? null : Number(form.marginPercent);
        if (margin != null && !(margin > 0)) {
          hysteresisError = "Auto hysteresis margin must be greater than 0%.";
        } else if (margin != null && !(margin < 50)) {
          hysteresisError = "Auto hysteresis margin must be less than 50% for an outside condition.";
        }
      }
    }
  }

  // Sanitizing onChange (see sanitizeSignedDecimalInput et al.) blocks
  // letters and stray symbols outright, but a value like "-" or "." is
  // still a legal set of characters that isn't a complete number yet —
  // flag that live too, rather than only discovering it at submit when
  // toStored(Number("-")) silently becomes NaN.
  const numberFieldError = "Enter a valid number.";
  const isIncompleteNumber = (s: string) => s.trim() !== "" && !Number.isFinite(Number(s));
  const hasIncompleteNumber =
    !isLeakMetric &&
    (isIncompleteNumber(form.threshold) ||
      isIncompleteNumber(form.low) ||
      isIncompleteNumber(form.high) ||
      isIncompleteNumber(form.clearThreshold) ||
      isIncompleteNumber(form.clearLow) ||
      isIncompleteNumber(form.clearHigh) ||
      isIncompleteNumber(form.marginPercent));

  function sensorName(id: string): string {
    return sensors.find((s) => s.id === id)?.name ?? id;
  }

  // Lets the create/edit form show whether the sensor being configured is
  // actually reporting right now, before the operator commits to a
  // duration against it — same badge/thresholds as the Sensors page (see
  // lib/reportingBadge.ts), sourced from the same per-sensor checkin data.
  function sensorReportingStatus(sensorId: string): { badge: ReturnType<typeof reportingBadge>; status?: SensorStatus } {
    const status = sensorStatuses.find((s) => s.sensorId === sensorId);
    const badge = reportingBadge(status?.lastSeenAt ?? null, status?.observedCheckinIntervalSeconds ?? null);
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

    if (isLeakMetric) {
      return { type: "above", threshold: 0.5, hysteresis: { mode: "manual", clearThreshold: 0.5 } };
    }

    if (form.conditionType === "between" || form.conditionType === "outside") {
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
      return { type: form.conditionType, low, high, hysteresis };
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
      if (hysteresisError) throw new Error(hysteresisError);
      if (hasIncompleteNumber) throw new Error(numberFieldError);
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
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
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
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                value={form.metric}
                onChange={(e) => {
                  const metric = e.target.value as Sensor["metrics"][number];
                  setForm({
                    ...form,
                    metric,
                    durationPreset: "",
                    // leak only ever has one meaningful condition — "is
                    // detected" — there's no numeric threshold to be
                    // above/below/between, so reset away from whatever
                    // was picked for a previous, non-boolean metric.
                    conditionType: metric === "leak" ? "above" : form.conditionType,
                    hysteresisMode: "manual",
                  });
                }}
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

            {isLeakMetric ? (
              <p className="text-xs text-muted-foreground">
                Leak is a yes/no sensor — this rule arms as soon as a leak is detected and releases once the
                sensor reports dry again.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Condition</label>
                <select
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
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
                  <option value="between">is between (armed inside the range)</option>
                  <option value="outside">is outside (armed outside the range)</option>
                </select>
              </div>
            )}

            {isLeakMetric ? null : form.conditionType === "between" || form.conditionType === "outside" ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">
                  {form.conditionType === "between"
                    ? "Arms once the reading is between these two bounds:"
                    : "Arms once the reading is below the low bound or above the high bound:"}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Low bound{unitSuffix && ` (${unitSuffix})`}</label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={form.low}
                      onChange={(e) => setForm({ ...form, low: sanitizeSignedDecimalInput(e.target.value) })}
                      required
                    />
                    {isIncompleteNumber(form.low) && <p className="text-xs text-red-600">{numberFieldError}</p>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">High bound{unitSuffix && ` (${unitSuffix})`}</label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={form.high}
                      onChange={(e) => setForm({ ...form, high: sanitizeSignedDecimalInput(e.target.value) })}
                      required
                    />
                    {isIncompleteNumber(form.high) && <p className="text-xs text-red-600">{numberFieldError}</p>}
                  </div>
                </div>
                {hysteresisError && lowNum != null && highNum != null && !(lowNum < highNum) && (
                  <p className="text-xs text-red-600">{hysteresisError}</p>
                )}
              </div>
            ) : isLeakMetric ? null : (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">
                  Arms once the reading goes {form.conditionType === "above" ? "above" : "below"} this value
                  {unitSuffix && ` (${unitSuffix})`}
                </label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={form.threshold}
                  onChange={(e) => {
                    const threshold = sanitizeSignedDecimalInput(e.target.value);
                    setForm({ ...form, threshold });
                  }}
                  onBlur={() => {
                    // Keep the disarm point on the correct side automatically
                    // when the arm threshold moves past it, instead of just
                    // flagging the mismatch after the fact.
                    if (thresholdNum == null || clearThresholdNum == null) return;
                    if (form.conditionType === "above" && clearThresholdNum > thresholdNum) {
                      setForm((f) => ({ ...f, clearThreshold: String(thresholdNum) }));
                    } else if (form.conditionType === "below" && clearThresholdNum < thresholdNum) {
                      setForm((f) => ({ ...f, clearThreshold: String(thresholdNum) }));
                    }
                  }}
                  required
                />
                {isIncompleteNumber(form.threshold) && <p className="text-xs text-red-600">{numberFieldError}</p>}
              </div>
            )}

            {isLeakMetric ? null : form.conditionType === "between" || form.conditionType === "outside" ? (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  {form.conditionType === "between"
                    ? "Optional gap past each bound the reading must cross before disarming — blank means no gap."
                    : "Optional gap inside each bound the reading must cross back before disarming — blank means no gap."}
                </p>
                <RangeNumberLine
                  mode={form.conditionType}
                  low={lowNum}
                  high={highNum}
                  clearLow={form.hysteresisMode === "manual" ? clearLowNum ?? lowNum : null}
                  clearHigh={form.hysteresisMode === "manual" ? clearHighNum ?? highNum : null}
                  marginPercent={form.hysteresisMode === "auto" ? Number(form.marginPercent) || 0 : null}
                  unitSuffix={unitSuffix}
                />
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
                        Low release point{unitSuffix && ` (${unitSuffix})`}
                      </label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={form.clearLow}
                        onChange={(e) => setForm({ ...form, clearLow: sanitizeSignedDecimalInput(e.target.value) })}
                        onBlur={() => {
                          if (lowNum == null || clearLowNum == null) return;
                          if (form.conditionType === "between" && clearLowNum > lowNum) {
                            setForm((f) => ({ ...f, clearLow: String(lowNum) }));
                          } else if (form.conditionType === "outside" && clearLowNum < lowNum) {
                            setForm((f) => ({ ...f, clearLow: String(lowNum) }));
                          }
                        }}
                        placeholder="blank = low bound"
                      />
                      {isIncompleteNumber(form.clearLow) && <p className="text-xs text-red-600">{numberFieldError}</p>}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-muted-foreground">
                        High release point{unitSuffix && ` (${unitSuffix})`}
                      </label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={form.clearHigh}
                        onChange={(e) => setForm({ ...form, clearHigh: sanitizeSignedDecimalInput(e.target.value) })}
                        onBlur={() => {
                          if (highNum == null || clearHighNum == null) return;
                          if (form.conditionType === "between" && clearHighNum < highNum) {
                            setForm((f) => ({ ...f, clearHigh: String(highNum) }));
                          } else if (form.conditionType === "outside" && clearHighNum > highNum) {
                            setForm((f) => ({ ...f, clearHigh: String(highNum) }));
                          }
                        }}
                        placeholder="blank = high bound"
                      />
                      {isIncompleteNumber(form.clearHigh) && <p className="text-xs text-red-600">{numberFieldError}</p>}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Recovery margin (%)</label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={form.marginPercent}
                      onChange={(e) => setForm({ ...form, marginPercent: sanitizeNonNegativeDecimalInput(e.target.value) })}
                      placeholder="e.g. 5"
                      required
                    />
                    {isIncompleteNumber(form.marginPercent) && <p className="text-xs text-red-600">{numberFieldError}</p>}
                    <p className="text-xs text-muted-foreground">
                      {form.conditionType === "between"
                        ? "Expands both bounds outward by this % before disarming."
                        : "Shrinks both bounds inward by this % before disarming (must be under 50%)."}
                    </p>
                  </div>
                )}
                {hysteresisError && <p className="text-xs text-red-600">{hysteresisError}</p>}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">
                  Release point{unitSuffix && ` (${unitSuffix})`} (optional)
                </label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={form.clearThreshold}
                  onChange={(e) => setForm({ ...form, clearThreshold: sanitizeSignedDecimalInput(e.target.value) })}
                  onBlur={() => {
                    if (thresholdNum == null || clearThresholdNum == null) return;
                    if (form.conditionType === "above" && clearThresholdNum > thresholdNum) {
                      setForm((f) => ({ ...f, clearThreshold: String(thresholdNum) }));
                    } else if (form.conditionType === "below" && clearThresholdNum < thresholdNum) {
                      setForm((f) => ({ ...f, clearThreshold: String(thresholdNum) }));
                    }
                  }}
                  placeholder="blank = arm value"
                />
                {isIncompleteNumber(form.clearThreshold) && <p className="text-xs text-red-600">{numberFieldError}</p>}
                <p className="text-xs text-muted-foreground">
                  Gap the reading must cross back past before disarming — blank means no gap.
                </p>
                {hysteresisError && <p className="text-xs text-red-600">{hysteresisError}</p>}
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
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
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
                      type="text"
                      inputMode="numeric"
                      value={form.customDays}
                      onChange={(e) => setForm({ ...form, customDays: sanitizeNonNegativeIntegerInput(e.target.value) })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Hours</label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={form.customHours}
                      onChange={(e) => setForm({ ...form, customHours: sanitizeNonNegativeIntegerInput(e.target.value) })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Minutes</label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={form.customMinutes}
                      onChange={(e) => setForm({ ...form, customMinutes: sanitizeNonNegativeIntegerInput(e.target.value) })}
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
              bodyTemplateNote="value and threshold are always in Celsius, independent of any account's display unit."
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
                bodyTemplateNote="value and threshold are always in Celsius, independent of any account's display unit."
              />
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" disabled={saving || !!hysteresisError || hasIncompleteNumber}>
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
                    <Button variant="outline" size="sm" onClick={() => openDetailsDialog(rule.id)}>
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
