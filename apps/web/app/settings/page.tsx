"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProtectConsole } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";

// Protect console connections. Host/apiKey live in SQLite, not .env — a
// site can have more than one console (see packages/engine/src/schema.ts).
// apiKey always arrives from the API already masked (CLAUDE.md
// obfuscation); this page never has access to the real value once saved.

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to change password");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change your password</CardTitle>
        <CardDescription>Available to every account, regardless of role.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid max-w-sm gap-3" onSubmit={submit}>
          <Input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <Input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <Input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          {success && <p className="text-sm text-green-600">Password changed.</p>}
          <Button type="submit" disabled={saving} className="w-fit">
            {saving ? "Saving…" : "Change password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { user: actor, loading: actorLoading } = useCurrentUser();
  const [consoles, setConsoles] = React.useState<ProtectConsole[]>([]);
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/consoles");
    if (res.ok) setConsoles((await res.json()).consoles);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function addConsole(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/consoles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, host, apiKey }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to save console");
      setName("");
      setHost("");
      setApiKey("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function removeConsole(id: string) {
    await fetch(`/api/consoles/${id}`, { method: "DELETE" });
    await load();
  }

  const canManageConsoles = hasRole(actor, "admin");

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {!actorLoading && <ChangePasswordCard />}

      <Card>
        <CardHeader>
          <CardTitle>Protect consoles</CardTitle>
          <CardDescription>
            The engine connects to each console over its local API (see API_NOTES.md) to discover sensors and
            receive realtime readings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {consoles.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>API key</TableHead>
                  {canManageConsoles && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {consoles.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="font-mono text-xs">{c.host}</TableCell>
                    <TableCell className="font-mono text-xs">{c.apiKey}</TableCell>
                    {canManageConsoles && (
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => removeConsole(c.id)}>
                          Remove
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {canManageConsoles && (
            <form className="grid gap-3 sm:grid-cols-4 sm:items-end" onSubmit={addConsole}>
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
                  placeholder="generated at unifi.ui.com"
                  required
                />
              </div>
              <Button type="submit" disabled={saving}>
                {saving ? "Adding…" : "Add console"}
              </Button>
            </form>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
