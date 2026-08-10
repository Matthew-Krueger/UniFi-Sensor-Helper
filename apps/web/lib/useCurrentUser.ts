"use client";

import * as React from "react";
import type { Role, User } from "@unifi-sensor-latch/shared";

const ROLE_RANK: Record<Role, number> = { user: 0, admin: 1, superadmin: 2 };

// Client-side mirror of lib/auth.ts's hasRole — for showing/hiding UI
// affordances only. The API routes re-check role server-side on every
// request; this is never the actual security boundary, just avoids
// flashing controls a user can't use.
export function hasRole(user: User | null, minimum: Role): boolean {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

// Polls every few seconds rather than fetching once on mount — this is
// what makes account deletion/role changes feel close to instant instead
// of only taking effect on the next full navigation. The server already
// invalidates a deleted account's session on its very next request
// (getSessionUser looks the user up by id on every call, no server-side
// session cache to go stale) — this is just what makes the client notice
// promptly. See SessionGuard for the "force sign-out" reaction to a
// session that goes from valid to null.
const POLL_MS = 5000;

export function useCurrentUser() {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    function poll() {
      fetch("/api/auth")
        .then((res) => res.json())
        .then((body) => {
          if (!cancelled) setUser(body.user);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { user, loading };
}
