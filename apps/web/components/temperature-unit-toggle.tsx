"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/useCurrentUser";

// Mirrors ThemeToggle's shape but persists server-side (per-user account
// preference, not a browser-local setting — see the field's comment in
// shared/types.ts). Display-only: metric values are always stored/evaluated
// in Celsius, this only affects how sensors/page.tsx renders them.
export function TemperatureUnitToggle() {
  const { user, setUser } = useCurrentUser();
  const [saving, setSaving] = React.useState(false);

  if (!user) return null;

  async function toggle() {
    if (!user) return;
    const next = user.temperatureUnit === "C" ? "F" : "C";
    setSaving(true);
    try {
      const res = await fetch("/api/account/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ temperatureUnit: next }),
      });
      if (res.ok) {
        const body = await res.json();
        setUser(body.user);
      }
    } catch (err) {
      console.error("[temperature-unit-toggle] failed to save preference:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" aria-label="Toggle temperature unit" onClick={toggle} disabled={saving}>
      °{user.temperatureUnit}
    </Button>
  );
}
