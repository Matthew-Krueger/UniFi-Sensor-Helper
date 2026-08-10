import { getEngine } from "@unifi-sensor-latch/engine";
import type { Role, User } from "@unifi-sensor-latch/shared";
import { getSessionUserId } from "./session";

// Looks up the full User (including role) behind the session cookie.
// Route handlers use this instead of getSessionUserId directly whenever
// they need to authorize by role, not just check "is someone logged in".
export async function getSessionUser(): Promise<User | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  return getEngine().auth.getUser(userId);
}

const ROLE_RANK: Record<Role, number> = { user: 0, admin: 1, superadmin: 2 };

// True if `user`'s role is at least `minimum` — "admin" satisfies a
// "user"-level check, "user" does not satisfy an "admin"-level check.
export function hasRole(user: User, minimum: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}
