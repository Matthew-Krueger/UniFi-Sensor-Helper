import { getSessionUser, hasRole } from "@/lib/auth";
import { NavDrawer } from "@/components/nav-drawer";

// Server Component — reads the session directly (no client-side flash of
// links a "user"-role viewer can't use). Route Handlers are still the real
// enforcement; this only decides what to show. Rendering itself (the
// drawer, its open/close state) is a client component — see nav-drawer.tsx.
export async function Nav() {
  const actor = await getSessionUser();

  const links = [
    { href: "/", label: "Dashboard" },
    { href: "/sensors", label: "Sensors" },
    { href: "/rules", label: "Rules" },
    { href: "/consoles", label: "Consoles" },
    { href: "/settings", label: "Settings" },
    ...(actor && hasRole(actor, "admin") ? [{ href: "/users", label: "Users" }] : []),
  ];

  return <NavDrawer links={links} username={actor?.username ?? null} role={actor?.role ?? null} />;
}
