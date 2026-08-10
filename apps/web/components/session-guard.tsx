"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser } from "@/lib/useCurrentUser";

// Two jobs, both UX-only — the real enforcement is server-side in both
// cases (requireRole in lib/auth.ts). This just reacts to what the server
// already decided, promptly, since useCurrentUser now polls:
//
//  1. mustResetPassword set → redirect to /reset-password (unchanged
//     behavior from the original PasswordResetGate).
//  2. Session goes from valid to invalid — the account was deleted (or
//     its role changed in a way that matters, though role changes don't
//     invalidate a session, only deletion does) — force a sign-out and
//     redirect to /login instead of leaving the UI showing stale data
//     for whatever's left of the poll cycle.
const EXEMPT_PATHS = ["/login", "/reset-password"];

export function SessionGuard() {
  const { user, loading } = useCurrentUser();
  const pathname = usePathname();
  const router = useRouter();
  const hadUser = React.useRef(false);

  React.useEffect(() => {
    if (loading) return;

    if (user?.mustResetPassword && !EXEMPT_PATHS.includes(pathname)) {
      router.replace("/reset-password");
      return;
    }

    if (user) {
      hadUser.current = true;
      return;
    }

    // user is null. Only react if we previously had a session — a fresh
    // page load with no session at all is just "not logged in yet," not
    // a kickout, and /login has its own bootstrap-vs-sign-in flow that
    // shouldn't be redirected away from.
    if (hadUser.current && pathname !== "/login") {
      hadUser.current = false;
      fetch("/api/auth", { method: "DELETE" }).finally(() => {
        router.replace("/login");
      });
    }
  }, [user, loading, pathname, router]);

  return null;
}
