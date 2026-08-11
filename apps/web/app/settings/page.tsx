"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { validatePassword } from "@unifi-sensor-latch/shared";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { PasswordRequirements } from "@/components/password-requirements";

// Full-size counterpart to ThemeToggle (components/theme-toggle.tsx) —
// that one stays in the nav as a one-click shortcut, this is the same
// underlying next-themes state, just presented as a labeled segmented
// control for the settings page instead of a single icon button.
function AppearanceCard() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Applies to this browser, not saved to your account.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="inline-flex gap-1 rounded-md border border-border p-1">
          <Button
            type="button"
            size="sm"
            variant={mounted && resolvedTheme === "light" ? "default" : "ghost"}
            disabled={!mounted}
            onClick={() => setTheme("light")}
          >
            <Sun className="h-4 w-4" />
            Light
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mounted && resolvedTheme === "dark" ? "default" : "ghost"}
            disabled={!mounted}
            onClick={() => setTheme("dark")}
          >
            <Moon className="h-4 w-4" />
            Dark
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Full-size counterpart to TemperatureUnitToggle (components/
// temperature-unit-toggle.tsx) — same PATCH /api/account/preferences
// call, just presented as a labeled segmented control here instead of a
// single °C/°F button in the nav.
function UnitsCard() {
  const { user, setUser } = useCurrentUser();
  const [saving, setSaving] = React.useState(false);

  async function setUnit(next: "C" | "F") {
    if (!user || user.temperatureUnit === next) return;
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
      console.error("[settings] failed to save temperature unit:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Units</CardTitle>
        <CardDescription>Display only. Sensor values are always stored and evaluated in Celsius.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="inline-flex gap-1 rounded-md border border-border p-1">
          <Button
            type="button"
            size="sm"
            variant={user?.temperatureUnit === "C" ? "default" : "ghost"}
            disabled={!user || saving}
            onClick={() => setUnit("C")}
          >
            °C Celsius
          </Button>
          <Button
            type="button"
            size="sm"
            variant={user?.temperatureUnit === "F" ? "default" : "ghost"}
            disabled={!user || saving}
            onClick={() => setUnit("F")}
          >
            °F Fahrenheit
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.valid) {
      setError(passwordCheck.error!);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to change password");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <AppearanceCard />
      <UnitsCard />

      <Card>
        <CardHeader>
          <CardTitle>Change your password</CardTitle>
          <CardDescription>Available to every account, regardless of role.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid max-w-sm gap-3" onSubmit={submit}>
            <Input
              type="password"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
            <Input
              type="password"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <div className="flex flex-col gap-1">
              <Input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              <PasswordRequirements password={newPassword} confirmPassword={confirmPassword} />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {success && <p className="text-sm text-green-600">Password changed.</p>}
            <Button type="submit" disabled={saving} className="w-fit">
              {saving ? "Saving…" : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
