"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { canAssignRole, validateUsername } from "@unifi-sensor-latch/shared";
import type { Role, User } from "@unifi-sensor-latch/shared";
import { hasRole, useCurrentUser } from "@/lib/useCurrentUser";

// Account management — SPEC.md section 3a. Visible only to admin+
// (server-side enforced by every /api/users* route; this page just hides
// itself for a "user"-role viewer rather than showing a 401 wall).
//
// Note what's absent: there's no password field on the create form. An
// admin never chooses another account's password — one is generated
// server-side and shown exactly once in generatedPasswordFor's banner,
// with mustResetPassword forcing the new owner to pick their own before
// doing anything else.
const ASSIGNABLE_ROLES: Role[] = ["user", "admin", "superadmin"];

function GeneratedPasswordBanner({ username, password, onDismiss }: { username: string; password: string; onDismiss: () => void }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <p>
        Generated password for <strong>{username}</strong> — shown once, not recoverable after you leave this page.
        Relay it out-of-band; they'll be forced to set a new one on first login.
      </p>
      <div className="flex items-center gap-2">
        <code className="w-fit rounded bg-background px-2 py-1 font-mono text-base">{password}</code>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>
      <Button variant="outline" size="sm" className="w-fit" onClick={onDismiss}>
        I've saved it — dismiss
      </Button>
    </div>
  );
}

// Seeded from a server-side fetch (see page.tsx) — first paint already
// has the real user table (or the "not available" card, decided from the
// server-seeded session in useCurrentUser) instead of a blank page while
// role/data are still loading client-side.
export function UsersClient({ initialUsers }: { initialUsers: User[] }) {
  const { user: actor } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: users = initialUsers } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error("failed to load users");
      return (await res.json()).users as User[];
    },
    initialData: initialUsers,
  });
  const [open, setOpen] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [role, setRole] = React.useState<Role>("user");
  const [error, setError] = React.useState<string | null>(null);
  const [generated, setGenerated] = React.useState<{ username: string; password: string } | null>(null);

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const createUserMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create account");
      return body.generatedPassword as string;
    },
    onSuccess: (generatedPassword) => {
      setGenerated({ username, password: generatedPassword });
      setUsername("");
      setRole("user");
      setOpen(false);
      void invalidateUsers();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.valid) {
      setError(usernameCheck.error!);
      return;
    }

    createUserMutation.mutate();
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
    await invalidateUsers();
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
    await invalidateUsers();
  }

  async function invalidatePassword(u: User) {
    const res = await fetch(`/api/users/${u.id}/invalidate-password`, { method: "PATCH" });
    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "failed to invalidate password");
      return;
    }
    await invalidateUsers();
  }

  async function resetPassword(u: User) {
    const res = await fetch(`/api/users/${u.id}/reset-password`, { method: "PATCH" });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "failed to reset password");
      return;
    }
    setGenerated({ username: u.username, password: body.generatedPassword });
    await invalidateUsers();
  }

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Users</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">Add Account</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add an account</DialogTitle>
            </DialogHeader>
            <form className="flex flex-col gap-3" onSubmit={createUser}>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Username</label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
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
              <p className="text-xs text-muted-foreground">
                A random password is generated and shown once after creation — you relay it, they set their own on
                first login.
              </p>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" disabled={createUserMutation.isPending}>
                {createUserMutation.isPending ? "Adding…" : "Add account"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {generated && (
        <GeneratedPasswordBanner
          username={generated.username}
          password={generated.password}
          onDismiss={() => setGenerated(null)}
        />
      )}

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Password</TableHead>
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
                    {u.mustResetPassword && (
                      <Badge variant="armed">reset required</Badge>
                    )}
                  </TableCell>
                  <TableCell className="flex gap-1">
                    {u.id !== actor?.id && (actor?.role === "superadmin" || u.role === "user") && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => invalidatePassword(u)}
                          title="Their current password keeps working to sign in, but they're forced to set a new one immediately after — nothing changes until their next login."
                        >
                          Force Reset on Next Login
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => resetPassword(u)}
                          title="Generates a brand new password right now — their old one stops working immediately."
                        >
                          Generate New Password
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => deleteUser(u.id)}>
                          Remove
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
