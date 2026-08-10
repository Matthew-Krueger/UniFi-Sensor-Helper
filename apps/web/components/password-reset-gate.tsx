"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser } from "@/lib/useCurrentUser";

// UX-only redirect — the real enforcement is server-side (requireRole in
// lib/auth.ts blocks every write/read route except /api/account/password
// while mustResetPassword is set). This just gets a flagged account off
// pages it can't use anything on and onto the reset form instead of
// leaving it stuck looking at 403s.
const EXEMPT_PATHS = ["/login", "/reset-password"];

export function PasswordResetGate() {
  const { user } = useCurrentUser();
  const pathname = usePathname();
  const router = useRouter();

  React.useEffect(() => {
    if (user?.mustResetPassword && !EXEMPT_PATHS.includes(pathname)) {
      router.replace("/reset-password");
    }
  }, [user, pathname, router]);

  return null;
}
