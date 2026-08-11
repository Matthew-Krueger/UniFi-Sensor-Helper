"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/useCurrentUser";

export function SignOutButton() {
  const router = useRouter();
  const { setUser } = useCurrentUser();

  async function signOut() {
    await fetch("/api/auth", { method: "DELETE" });
    // Update the shared session context immediately — otherwise the nav
    // (and anything else gated on useCurrentUser) keeps showing the
    // signed-in state for up to the 5s poll interval, even though
    // /login is already on screen.
    setUser(null);
    router.push("/login");
  }

  return (
    <Button variant="ghost" size="sm" onClick={signOut}>
      Sign out
    </Button>
  );
}
