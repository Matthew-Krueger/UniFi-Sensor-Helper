"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { validatePassword, validateUsername } from "@unifi-sensor-latch/shared";
import { useCurrentUser } from "@/lib/useCurrentUser";

// Two modes, decided by GET /api/auth's needsBootstrap flag (true only
// while the users table is empty — SPEC.md section 3a). Sign-up is only
// ever shown in that state; the instant an account exists, this always
// shows the sign-in form, matching the server-side check in POST /api/users.
export default function LoginPage() {
  const router = useRouter();
  const { setUser } = useCurrentUser();
  const [needsBootstrap, setNeedsBootstrap] = React.useState<boolean | null>(null);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/auth")
      .then((res) => res.json())
      .then((body) => setNeedsBootstrap(body.needsBootstrap));
  }, []);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const body = await res.json();
        // See sign-out-button.tsx's comment — otherwise the nav keeps
        // showing "signed out" for up to the 5s poll interval even
        // though the redirect already landed on an authenticated page.
        setUser(body.user);
        router.push(body.user?.mustResetPassword ? "/reset-password" : "/");
      } else {
        setError("Invalid username or password");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.valid) {
      setError(usernameCheck.error!);
      return;
    }
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      setError(passwordCheck.error!);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "failed to create account");
        return;
      }
      // Account created — now sign in with the same credentials.
      const loginRes = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (loginRes.ok) {
        setUser((await loginRes.json()).user);
        router.push("/");
      } else {
        setError("Account created. Please sign in.");
        setNeedsBootstrap(false);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (needsBootstrap === null) {
    return null;
  }

  if (needsBootstrap) {
    return (
      <div className="flex justify-center pt-16">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Create the first account</CardTitle>
            <CardDescription>
              No accounts exist yet. This account will be a superadmin, with full access including managing other
              accounts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={handleBootstrap}>
              <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
              <div className="flex flex-col gap-1">
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  8-128 characters, at least 2 of: lowercase, uppercase, numbers, symbols.
                </p>
              </div>
              <Input
                type="password"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create account"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex justify-center pt-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSignIn}>
            <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
