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

interface CurrentUserState {
  user: User | null;
  loading: boolean;
  // Lets a component that just changed its own account (e.g. the
  // temperature-unit toggle) reflect that immediately instead of waiting
  // up to POLL_MS for the next background poll to catch up.
  setUser: (user: User | null) => void;
}

// Single shared poll for the whole app — every page/component that needs
// the session (role-gating buttons, SessionGuard's kickout logic, etc.)
// reads from this one context instead of each running its own 5s
// setInterval against /api/auth. Before this, SessionGuard *and* whatever
// page you were on each polled independently, doubling every /api/auth
// request (visible as back-to-back GET /api/auth pairs in the server log).
const CurrentUserContext = React.createContext<CurrentUserState | null>(null);

const POLL_MS = 5000;

// initialUser comes from a server-side session lookup done in
// app/layout.tsx (a Server Component) before any HTML is sent — so the
// very first paint already has the right role-gated UI, instead of
// starting from `null` and popping in buttons/badges a moment later once
// the first poll resolves. It's already the ground truth (same session
// cookie, same lookup requireRole uses), not a guess, so loading starts
// false rather than waiting on a redundant first poll.
export function CurrentUserProvider({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser: User | null;
}) {
  const [user, setUser] = React.useState<User | null>(initialUser);
  const [loading, setLoading] = React.useState(false);

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

    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const value = React.useMemo(() => ({ user, loading, setUser }), [user, loading]);
  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserState {
  const ctx = React.useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error("useCurrentUser must be used within a CurrentUserProvider (see app/layout.tsx)");
  }
  return ctx;
}
