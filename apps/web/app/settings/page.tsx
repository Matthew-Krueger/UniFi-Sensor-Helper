"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProtectConsole } from "@unifi-sensor-latch/shared";

// Protect console connections. Host/apiKey live in SQLite, not .env — a
// site can have more than one console (see packages/engine/src/schema.ts).
// apiKey always arrives from the API already masked (CLAUDE.md
// obfuscation); this page never has access to the real value once saved.

export default function SettingsPage() {
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

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

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
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {consoles.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="font-mono text-xs">{c.host}</TableCell>
                    <TableCell className="font-mono text-xs">{c.apiKey}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => removeConsole(c.id)}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

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

          {error && <p className="text-sm text-red-600">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
