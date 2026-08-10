"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { canAssignRole } from "@unifi-sensor-latch/shared";
import type { Role, User } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";

// Account management — SPEC.md section 3a. Visible only to admin+
// (server-side enforced by every /api/users* route; this page just hides
// itself for a "user"-role viewer rather than showing a 401 wall).
const ASSIGNABLE_ROLES: Role[] = ["user", "admin", "superadmin"];

export default function UsersPage() {
  const { user: actor, loading: actorLoading } = useCurrentUser();
  const [users, setUsers] = React.useState<User[]>([]);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<Role>("user");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/users");
    if (res.ok) setUsers((await res.json()).users);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create account");
      setUsername("");
      setPassword("");
      setRole("user");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteUser(id: string) {
    const res = await fetch("/api/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "failed to delete account");
      return;
    }
    await load();
  }

  async function changeRole(id: string, newRole: Role) {
    const res = await fetch(`/api/users/${id}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "failed to change role");
      return;
    }
    await load();
  }

  if (actorLoading) return null;

  if (!hasRole(actor, "admin")) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Not available</CardTitle>
          <CardDescription>Only admin and superadmin accounts can manage users.</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    );
  }

  const isSuperadmin = hasRole(actor, "superadmin");
  const grantableRoles = ASSIGNABLE_ROLES.filter((r) => actor && canAssignRole(actor.role, r));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Users</h1>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.username}</TableCell>
                  <TableCell>
                    {isSuperadmin ? (
                      <select
                        className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                        value={u.role}
                        onChange={(e) => changeRole(u.id, e.target.value as Role)}
                        disabled={u.id === actor?.id}
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant="outline">{u.role}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {u.id !== actor?.id && (actor?.role === "superadmin" || u.role === "user") && (
                      <Button variant="ghost" size="sm" onClick={() => deleteUser(u.id)}>
                        Remove
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <form className="grid gap-3 sm:grid-cols-4 sm:items-end" onSubmit={createUser}>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Username</label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Password</label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Role</label>
              <select
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {grantableRoles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add account"}
            </Button>
          </form>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
