import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Role, User } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";
import { getDb } from "./db";
import * as schema from "./schema";
import { users } from "./schema";

// Argon2id hashing via Bun's built-in Bun.password — no extra dependency.
// Plaintext passwords are never stored or logged; any log line that touches
// a credential goes through maskSecret first. Generated passwords are the
// one deliberate exception: they're returned in full, once, from
// createUserWithGeneratedPassword/resetPasswordToRandom, because an admin
// has to relay them to the account's owner out-of-band — never logged,
// never persisted anywhere but the argon2 hash.
//
// No env-seeded bootstrap account: the first account is created through the
// normal signup endpoint while the users table is empty — the caller (route
// handler) is responsible for the "only when zero accounts exist" check
// before allowing an unauthenticated call through.

export class RoleError extends Error {}

const GENERATED_PASSWORD_LENGTH = 16;
const GENERATED_PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Uniform over the alphabet via rejection sampling (a plain `% alphabet
// length` on a random byte is very slightly biased toward low indices —
// not worth the shortcut for something used as a credential).
function generatePassword(): string {
  const alphabetSize = GENERATED_PASSWORD_ALPHABET.length; // 62
  const maxUnbiased = 256 - (256 % alphabetSize); // 248 — reject bytes >= this
  let out = "";
  while (out.length < GENERATED_PASSWORD_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_PASSWORD_LENGTH - out.length));
    for (const byte of bytes) {
      if (byte >= maxUnbiased) continue;
      out += GENERATED_PASSWORD_ALPHABET[byte % alphabetSize];
    }
  }
  return out;
}

function toUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role as Role,
    mustResetPassword: row.mustResetPassword,
    temperatureUnit: row.temperatureUnit as "C" | "F",
    createdAt: row.createdAt,
  };
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

  // Self-service path only (bootstrap signup, where the account owner
  // chooses and already knows their own password) — mustResetPassword is
  // always false here. Admin-created accounts go through
  // createUserWithGeneratedPassword instead, never this.
  //
  // role defaults to "user"; the very first account (count() === 0 at call
  // time) is always forced to "superadmin" regardless of what's passed, so
  // there's never a deployment with zero superadmins.
  async addUser(username: string, password: string, role: Role = "user"): Promise<User> {
    const isFirstAccount = this.count() === 0;
    const effectiveRole: Role = isFirstAccount ? "superadmin" : role;

    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const createdAt = Date.now();
    this.db
      .insert(users)
      .values({ id, username, passwordHash, role: effectiveRole, mustResetPassword: false, createdAt })
      .run();
    console.log(`[auth] created user "${username}" as ${effectiveRole} (password ${maskSecret(password)})`);
    return { id, username, role: effectiveRole, mustResetPassword: false, temperatureUnit: "C", createdAt };
  }

  // Admin-created accounts: the admin never types a password for someone
  // else. Generates a random one, forces a reset before the account can do
  // anything else, and returns the plaintext once so the admin can relay
  // it out-of-band — it's never stored or logged anywhere but the hash.
  async createUserWithGeneratedPassword(username: string, role: Role): Promise<{ user: User; password: string }> {
    const password = generatePassword();
    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const createdAt = Date.now();
    this.db.insert(users).values({ id, username, passwordHash, role, mustResetPassword: true, createdAt }).run();
    console.log(`[auth] created user "${username}" as ${role} with a generated password (reset required)`);
    return { user: { id, username, role, mustResetPassword: true, temperatureUnit: "C", createdAt }, password };
  }

  // Self-service display preference — not gated by role, every account
  // sets its own. Purely a UI concern (see the field's comment in
  // shared/types.ts), so no validation beyond the string union at the
  // type/route layer.
  setTemperatureUnit(userId: string, unit: "C" | "F"): User | null {
    this.db.update(users).set({ temperatureUnit: unit }).where(eq(users.id, userId)).run();
    return this.getUser(userId);
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
  // own password). Always clears mustResetPassword, whether or not it was
  // set — this is the only way that flag ever gets cleared.
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return false;
    const ok = await Bun.password.verify(currentPassword, row.passwordHash);
    if (!ok) return false;

    const passwordHash = await Bun.password.hash(newPassword, { algorithm: "argon2id" });
    this.db.update(users).set({ passwordHash, mustResetPassword: false }).where(eq(users.id, userId)).run();
    console.log(`[auth] password changed for user "${row.username}"`);
    return true;
  }

  // Admin action: marks the account's *current* password as no longer
  // sufficient on its own — it still authenticates (proving identity), but
  // the account is locked out of everything except changing its password
  // until it does. Doesn't touch the hash, so the owner doesn't need a new
  // credential relayed to them if they still remember their old one.
  invalidatePassword(userId: string): User | null {
    this.db.update(users).set({ mustResetPassword: true }).where(eq(users.id, userId)).run();
    const updated = this.getUser(userId);
    if (updated) console.log(`[auth] password invalidated for user "${updated.username}" — reset required`);
    return updated;
  }

  // Admin action: generates a brand new random password (the owner's old
  // one no longer works at all) and forces a reset. Returns the plaintext
  // once, same handoff contract as createUserWithGeneratedPassword.
  async resetPasswordToRandom(userId: string): Promise<{ user: User; password: string } | null> {
    const existing = this.getUser(userId);
    if (!existing) return null;

    const password = generatePassword();
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.db.update(users).set({ passwordHash, mustResetPassword: true }).where(eq(users.id, userId)).run();
    console.log(`[auth] password reset to a generated value for user "${existing.username}" — reset required`);
    return { user: { ...existing, mustResetPassword: true }, password };
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
