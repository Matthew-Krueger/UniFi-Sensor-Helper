import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { getSessionUser, hasRole } from "@/lib/auth";
import { SignOutButton } from "@/components/sign-out-button";

// Server Component — reads the session directly (no client-side flash of
// links a "user"-role viewer can't use). Route Handlers are still the real
// enforcement; this only decides what to show.
export async function Nav() {
  const actor = await getSessionUser();

  const links = [
    { href: "/", label: "Dashboard" },
    { href: "/sensors", label: "Sensors" },
    { href: "/latches", label: "Latches" },
    { href: "/settings", label: "Settings" },
    ...(actor && hasRole(actor, "admin") ? [{ href: "/users", label: "Users" }] : []),
  ];

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <nav className="flex items-center gap-6">
          <span className="font-semibold">UnifiSensorLatch</span>
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm text-muted-foreground hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          {actor && (
            <span className="text-sm text-muted-foreground">
              {actor.username} <span className="text-xs">({actor.role})</span>
            </span>
          )}
          <ThemeToggle />
          {actor && <SignOutButton />}
        </div>
      </div>
    </header>
  );
}
