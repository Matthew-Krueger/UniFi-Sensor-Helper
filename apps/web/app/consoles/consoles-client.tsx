"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ConsoleStatus, ProtectConsole } from "@unifi-sensor-latch/shared";
import { DURATION_PRESETS, buildConsoleWebhookUrl } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";
import { usePausedWhileSelectFocused } from "@/lib/usePausedWhileSelectFocused";
import { absoluteTimeLabel, preciseAgoLabel, useNowTick } from "@/lib/format";

// Reuses the same Unifi-matched preset list Rules use for durations —
// "how often do we expect a sensor to report" and "how long must a rule
// stay armed" are the same kind of duration, so one dropdown vocabulary
// for both. 5 minutes is the column default (schema.ts).
const INTERVAL_PRESETS = DURATION_PRESETS;

// Protect console connections — never in .env, since a site can have more
// than one (see packages/engine/src/schema.ts). The API key field is
// always type="password" here and the API never echoes back anything but
// a masked value once saved (CLAUDE.md obfuscation) — this page never has
// access to a real key after the moment it's typed into the add form.
//
// Status fields shown here are only what's actually measurable: our own
// connection state, sensor/discovery counts, and a real round-trip
// latency sample. The Protect integration API has no CPU/memory/storage
// endpoint for the console itself (checked against the live OpenAPI spec)
// — nothing here is fabricated to look like a fuller health dashboard.
//
// POST /api/consoles returns immediately (connectConsole runs in the
// background — see singleton.ts) and records a step-by-step trace as it
// goes, so this page polls quickly while anything is mid-connect to
// surface that trace close to real-time, then backs off once everything's
// settled.
const POLL_MS_ACTIVE = 1000;
const POLL_MS_IDLE = 5000;

function badgeVariantFor(state: ConsoleStatus["connectionState"]): "idle" | "armed" | "fired" | "outline" {
  switch (state) {
    case "connected":
      return "outline";
    case "connecting":
      return "armed";
    case "error":
      return "fired";
    default:
      return "idle";
  }
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function StepTrace({ steps }: { steps: ConsoleStatus["steps"] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-2 font-mono text-xs">
      {steps.map((step, i) => (
        <li key={i} className={step.ok ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}>
          [{timeLabel(step.at)}] {step.ok ? "✓" : "✗"} {step.label}
        </li>
      ))}
    </ul>
  );
}

export interface ConsolesInitialData {
  consoles: ProtectConsole[];
  statuses: ConsoleStatus[];
}

// Seeded from a server-side fetch (see page.tsx) — first paint already
// has real console cards instead of the "No consoles configured yet"
// empty state popping in once the client's own fetch resolves.
export function ConsolesClient({ initial }: { initial: ConsolesInitialData }) {
  useNowTick(); // keeps "last contacted" ticking live, second-by-second
  const { user: actor } = useCurrentUser();
  const canManage = hasRole(actor, "admin");

  const [consoles, setConsoles] = React.useState<ProtectConsole[]>(initial.consoles);
  const [statuses, setStatuses] = React.useState<ConsoleStatus[]>(initial.statuses);
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [defaultIntervalSeconds, setDefaultIntervalSeconds] = React.useState(300);
  const [defaultWebhookId, setDefaultWebhookId] = React.useState("");
  const [apiBaseUrlOverride, setApiBaseUrlOverride] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [savingMessage, setSavingMessage] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/consoles");
    if (res.ok) {
      const body = await res.json();
      setConsoles(body.consoles);
      setStatuses(body.statuses);
    }
  }, []);

  const anyActive = statuses.some((s) => s.connectionState === "connecting");

  // See usePausedWhileSelectFocused's doc comment — avoids a real Firefox
  // crash when a poll-driven re-render mutates a <select> while its
  // dropdown popup is open (this page's per-console interval dropdown).
  const paused = usePausedWhileSelectFocused();
  const pausedRef = React.useRef(paused);
  React.useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  React.useEffect(() => {
    // Initial render already has server-fetched data — the interval below
    // just keeps it fresh going forward.
    const id = setInterval(
      () => {
        if (!pausedRef.current) load();
      },
      anyActive ? POLL_MS_ACTIVE : POLL_MS_IDLE
    );
    return () => clearInterval(id);
  }, [load, anyActive]);

  function resetForm() {
    setName("");
    setHost("");
    setApiKey("");
    setDefaultIntervalSeconds(300);
    setDefaultWebhookId("");
    setApiBaseUrlOverride("");
  }

  function openAddDialog() {
    resetForm();
    setEditingId(null);
    setError(null);
    setOpen(true);
  }

  function openEditDialog(c: ProtectConsole) {
    setName(c.name);
    setHost(c.host);
    setApiKey(""); // never round-tripped — see PATCH /api/consoles/[id]'s comment
    setDefaultIntervalSeconds(c.defaultIntervalSeconds);
    setDefaultWebhookId(c.defaultWebhookId ?? "");
    setApiBaseUrlOverride(c.apiBaseUrlOverride ?? "");
    setEditingId(c.id);
    setError(null);
    setOpen(true);
  }

  async function submitConsole(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSavingMessage(editingId ? `Saving "${name}"…` : `Attempting to add console "${name}"…`);
    setError(null);
    try {
      const res = editingId
        ? await fetch(`/api/consoles/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, host, apiKey, defaultIntervalSeconds, defaultWebhookId, apiBaseUrlOverride }),
          })
        : await fetch("/api/consoles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, host, apiKey, defaultIntervalSeconds, defaultWebhookId, apiBaseUrlOverride }),
          });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to save console");
      resetForm();
      setEditingId(null);
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      setSavingMessage(null);
    }
  }

  async function removeConsole(id: string) {
    await fetch(`/api/consoles/${id}`, { method: "DELETE" });
    await load();
  }

  async function updateDefaultInterval(id: string, seconds: number) {
    await fetch(`/api/consoles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultIntervalSeconds: seconds }),
    });
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Protect Consoles</h1>
        {canManage && (
          <Button size="sm" onClick={openAddDialog}>
            Add Console
          </Button>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            resetForm();
            setEditingId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit console" : "Add a console"}</DialogTitle>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={submitConsole}>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main site NVR" required />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Host / IP</label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.1" required />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">API key</label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={editingId ? "leave blank to keep the existing key" : "generated at unifi.ui.com"}
                required={!editingId}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Default expected interval</label>
              <select
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                value={defaultIntervalSeconds}
                onChange={(e) => setDefaultIntervalSeconds(Number(e.target.value))}
              >
                {INTERVAL_PRESETS.map((p) => (
                  <option key={p.seconds} value={p.seconds}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Default Alarm Manager webhook ID (optional)</label>
              <Input
                value={defaultWebhookId}
                onChange={(e) => setDefaultWebhookId(e.target.value)}
                placeholder="e.g. freezer-alerts"
              />
              <p className="text-xs text-muted-foreground">
                Matches the ID on a "trigger via webhook" Alarm Manager rule you create once in Protect's own UI
                (SPEC.md §7). Rules that deliver to this console default to this ID{host && defaultWebhookId ? ":" : "."}
              </p>
              {host && defaultWebhookId && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {buildConsoleWebhookUrl(host, defaultWebhookId, apiBaseUrlOverride || null)}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">API base override (optional)</label>
              <Input
                value={apiBaseUrlOverride}
                onChange={(e) => setApiBaseUrlOverride(e.target.value)}
                placeholder="e.g. https://unifi.ui.com/proxy/consoles/<id>/protect/integration"
              />
              <p className="text-xs text-muted-foreground">
                You almost certainly don't need this — by default the app talks to the console directly at{" "}
                <code className="font-mono">https://{host || "&lt;host&gt;"}/proxy/protect/integration</code>. Set
                this only if you need to reach the console through something else instead, e.g. UniFi's
                remote/cloud API base. Leave blank to use the default.
              </p>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Add console"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {savingMessage && (
        <div className="rounded-md border border-border bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
          {savingMessage} Saved immediately — connection status streams in below as each step completes.
        </div>
      )}

      {consoles.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No consoles configured yet</CardTitle>
            <CardDescription>
              {canManage ? "Add one to start discovering sensors." : "Ask an admin to add one."}
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {consoles.map((c) => {
            const status = statuses.find((s) => s.consoleId === c.id);
            return (
              <Card key={c.id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">{c.name}</CardTitle>
                    <Badge variant={badgeVariantFor(status?.connectionState ?? "disconnected")}>
                      {status?.connectionState ?? "disconnected"}
                    </Badge>
                  </div>
                  <CardDescription className="font-mono text-xs">{c.host}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
                  <div>API key: <span className="font-mono">{c.apiKey}</span></div>
                  {c.apiBaseUrlOverride && (
                    <div className="break-all">
                      API base override: <span className="font-mono text-xs">{c.apiBaseUrlOverride}</span>
                    </div>
                  )}
                  <div>{status?.sensorCount ?? 0} sensor{status?.sensorCount === 1 ? "" : "s"} discovered</div>
                  <div title={status?.lastEventAt ? absoluteTimeLabel(status.lastEventAt) : undefined}>
                    Last contacted: {preciseAgoLabel(status?.lastEventAt ?? null)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span>Default expected interval:</span>
                    {canManage ? (
                      <select
                        className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        value={c.defaultIntervalSeconds}
                        onChange={(e) => updateDefaultInterval(c.id, Number(e.target.value))}
                      >
                        {INTERVAL_PRESETS.map((p) => (
                          <option key={p.seconds} value={p.seconds}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{INTERVAL_PRESETS.find((p) => p.seconds === c.defaultIntervalSeconds)?.label ?? `${c.defaultIntervalSeconds}s`}</span>
                    )}
                  </div>
                  <div>
                    Default webhook ID: {c.defaultWebhookId ?? <span className="italic">not set</span>}
                  </div>
                  {status?.applicationVersion && <div>Firmware: {status.applicationVersion}</div>}
                  {status?.latencyMs != null && <div>API latency: {status.latencyMs}ms</div>}
                  {status?.error && <div className="text-red-600 dark:text-red-400">{status.error}</div>}
                  {status && <StepTrace steps={status.steps} />}
                  {canManage && (
                    <div className="mt-1 flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(c)}>
                        Edit
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => removeConsole(c.id)}>
                        Remove
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
