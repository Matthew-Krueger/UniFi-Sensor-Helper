import { redirect } from "next/navigation";
import { getEngine } from "@unifi-sensor-latch/engine";
import type { User } from "@unifi-sensor-latch/shared";
import { getSessionUser, hasRole } from "@/lib/auth";
import { UsersClient } from "./users-client";

// Server Component mirroring GET /api/users — only fetches the list for
// an admin+ session (same role floor requireRole("admin") enforces), same
// as the route. UsersClient itself decides admin-vs-not from the
// server-seeded session in useCurrentUser (see layout.tsx), so there's no
// flash either way: a "user"-role visitor sees the "not available" card
// immediately, no blank page or list flicker first.
export default async function UsersPage() {
  const actor = await getSessionUser();
  if (!actor) redirect("/login");

  const initialUsers: User[] = hasRole(actor, "admin") ? getEngine().auth.listUsers() : [];

  return <UsersClient initialUsers={initialUsers} />;
}
