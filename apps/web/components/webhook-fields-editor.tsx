"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProtectConsole, WebhookTarget } from "@unifi-sensor-latch/shared";
import { buildConsoleWebhookUrl } from "@unifi-sensor-latch/shared";

// Form-local shape for one webhook — flat so every field has a plain
// string/select-friendly value regardless of which WebhookTarget kind is
// selected; buildWebhookTarget below narrows it back down to the real
// union on submit. "console" is the default kind: it's this app's primary
// intended path (SPEC.md section 7 — Protect's own Alarm Manager does the
// actual notification delivery), not just one option among equals.
// Shared by the Rules page (fired/resolved webhook per rule) and the
// Consoles page (down-alert webhook per console) — one webhook-picker UI,
// not two hand-maintained copies of it.
export interface WebhookFormValue {
  kind: "console" | "custom";
  consoleId: string;
  webhookId: string;
  url: string;
  method: "GET" | "POST";
  bearerToken: string; // never prefilled on edit — see webhookFormValueFromTarget
  bodyTemplate: string; // custom-only; unlike bearerToken this isn't a secret, so it IS prefilled on edit
}

export function emptyWebhookFormValue(): WebhookFormValue {
  return { kind: "console", consoleId: "", webhookId: "", url: "", method: "POST", bearerToken: "", bodyTemplate: "" };
}

// bearerToken is deliberately left blank even when editing an existing
// custom webhook that has one — GET responses always mask it (see
// latchRedaction.ts/consoleRedaction.ts), so there's no real value to
// prefill; the field's placeholder explains that blank means "keep the
// existing token." bodyTemplate isn't credential-bearing, so it's safe to
// prefill from the real stored value.
export function webhookFormValueFromTarget(target: WebhookTarget | null | undefined): WebhookFormValue {
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

export function buildWebhookTarget(v: WebhookFormValue): WebhookTarget {
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

// Shared by every place a WebhookTarget is configured (a rule's fired/
// resolved webhook, a console's down-alert webhook) — same kind/console/
// URL/token fields either way, just a different label prefix and
// value/onChange pair. bodyTemplatePlaceholders lets each caller show the
// placeholders that actually apply to its own dispatch context (a rule
// has {{sensorName}}/{{threshold}}/etc, the console down-alert has
// {{consoleName}}/{{status}}/{{silentForMinutes}}) instead of a fixed,
// sometimes-wrong list.
export function WebhookFieldsEditor({
  label,
  value,
  onChange,
  consoles,
  editing,
  bodyTemplatePlaceholders,
  bodyTemplateNote,
}: {
  label: string;
  value: WebhookFormValue;
  onChange: (next: WebhookFormValue) => void;
  consoles: ProtectConsole[];
  editing: boolean;
  bodyTemplatePlaceholders?: string[];
  bodyTemplateNote?: string;
}) {
  const selectedConsole = consoles.find((c) => c.id === value.consoleId);
  const placeholders = bodyTemplatePlaceholders ?? [
    "{{sensorName}}",
    "{{metric}}",
    "{{value}}",
    "{{threshold}}",
    "{{durationMinutes}}",
  ];

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
                  // operator hasn't already typed something of their own.
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
              placeholder={`{${placeholders.map((p) => `"${p.replace(/[{}]/g, "")}": "${p}"`).join(", ")}}`}
            />
            <p className="text-xs text-muted-foreground">
              Placeholders:{" "}
              {placeholders.map((p) => (
                <code key={p} className="mr-1 font-mono">
                  {p}
                </code>
              ))}
              Left blank, no body is sent. Only used when method is POST.
              {bodyTemplateNote && ` ${bodyTemplateNote}`}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
