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

export function useCurrentUser() {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/auth")
      .then((res) => res.json())
      .then((body) => setUser(body.user))
      .finally(() => setLoading(false));
  }, []);

  return { user, loading };
}
