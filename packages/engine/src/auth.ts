import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Role, User } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";
import { getDb } from "./db";
import * as schema from "./schema";
import { users } from "./schema";

// Argon2id hashing via Bun's built-in Bun.password — no extra dependency.
// Plaintext passwords are never stored or logged; any log line that touches
// a credential goes through maskSecret first.
//
// No env-seeded bootstrap account: the first account is created through the
// normal signup endpoint while the users table is empty (see
// canSelfRegister/addUser's role handling below) — the caller (route
// handler) is responsible for the "only when zero accounts exist" check
// before allowing an unauthenticated call through.

export class RoleError extends Error {}

function toUser(row: typeof schema.users.$inferSelect): User {
  return { id: row.id, username: row.username, role: row.role as Role, createdAt: row.createdAt };
}

export class AuthStore {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema> = getDb()) {}

  count(): number {
    return this.db.select().from(users).all().length;
  }

  listUsers(): User[] {
    return this.db.select().from(users).orderBy(users.createdAt).all().map(toUser);
  }

  getUser(id: string): User | null {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? toUser(row) : null;
  }

  // role defaults to "user"; the very first account (count() === 0 at call
  // time) is always forced to "superadmin" regardless of what's passed, so
  // there's never a deployment with zero superadmins.
  async addUser(username: string, password: string, role: Role = "user"): Promise<User> {
    const isFirstAccount = this.count() === 0;
    const effectiveRole: Role = isFirstAccount ? "superadmin" : role;

    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const createdAt = Date.now();
    this.db.insert(users).values({ id, username, passwordHash, role: effectiveRole, createdAt }).run();
    console.log(`[auth] created user "${username}" as ${effectiveRole} (password ${maskSecret(password)})`);
    return { id, username, role: effectiveRole, createdAt };
  }

  removeUser(id: string): void {
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  async verify(username: string, password: string): Promise<User | null> {
    const row = this.db.select().from(users).where(eq(users.username, username)).get();
    if (!row) return null;
    const ok = await Bun.password.verify(password, row.passwordHash);
    return ok ? toUser(row) : null;
  }

  // Self-service password change — requires proving the current password,
  // not gated by role (every account, including "user", can change its
  // own password).
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return false;
    const ok = await Bun.password.verify(currentPassword, row.passwordHash);
    if (!ok) return false;

    const passwordHash = await Bun.password.hash(newPassword, { algorithm: "argon2id" });
    this.db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
    console.log(`[auth] password changed for user "${row.username}"`);
    return true;
  }

  // Promotes/demotes an account's role. Only a superadmin may call this
  // (enforced by the caller — see the /api/users/[id]/role route) but the
  // check is duplicated here defensively since it's the one action that can
  // create or remove a superadmin.
  async setRole(actorRole: Role, targetId: string, newRole: Role): Promise<User> {
    if (actorRole !== "superadmin") {
      throw new RoleError("only a superadmin can change roles");
    }
    this.db.update(users).set({ role: newRole }).where(eq(users.id, targetId)).run();
    const updated = this.getUser(targetId);
    if (!updated) throw new Error("user not found after role update");
    console.log(`[auth] role changed for user "${updated.username}" -> ${newRole}`);
    return updated;
  }
}
